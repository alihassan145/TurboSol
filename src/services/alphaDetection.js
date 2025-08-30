import axios from 'axios';
import { Connection, PublicKey } from '@solana/web3.js';
import EventEmitter from 'events';
import { readFileSync } from 'fs';
import { appendTrade } from './tradeStore.js';

const PUMP_FUN_API = 'https://frontend-api.pump.fun';
const DEV_WALLET_DB_FILE = './data/dev_wallets.json';

class AlphaDetection extends EventEmitter {
  constructor(connection) {
    super();
    this.connection = connection;
    this.isRunning = false;
    this.devWallets = new Set();
    this.monitoredAddresses = new Map();
    this.pumpInterval = null;
    this.mempoolInterval = null;
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    
    await this.loadDevWallets();
    this.startPumpListener();
    this.startDevWalletMonitor();
    this.startMempoolScanner();
    
    console.log('🎯 Alpha detection layer started');
  }

  async stop() {
    this.isRunning = false;
    if (this.pumpInterval) clearInterval(this.pumpInterval);
    if (this.mempoolInterval) clearInterval(this.mempoolInterval);
    console.log('🎯 Alpha detection layer stopped');
  }

  async loadDevWallets() {
    try {
      const data = readFileSync(DEV_WALLET_DB_FILE, 'utf8');
      const wallets = JSON.parse(data);
      this.devWallets = new Set(wallets);
      console.log(`📊 Loaded ${wallets.length} dev wallets for monitoring`);
    } catch (error) {
      console.log('📊 No dev wallet database found, creating new one');
      this.devWallets = new Set();
    }
  }

  saveDevWallet(wallet) {
    this.devWallets.add(wallet);
    // In production, save to file
  }

  // 1. Pump.fun listener (1-second polling)
  startPumpListener() {
    this.pumpInterval = setInterval(async () => {
      try {
        const response = await axios.get(`${PUMP_FUN_API}/coins/recent`);
        const newCoins = response.data.slice(0, 10);
        
        for (const coin of newCoins) {
          if (this.isNewLaunch(coin)) {
            this.emit('pump_launch', {
              mint: coin.mint,
              name: coin.name,
              symbol: coin.symbol,
              timestamp: Date.now(),
              marketCap: coin.usd_market_cap,
              creator: coin.creator
            });
            
            // Check if creator is known dev
            if (this.devWallets.has(coin.creator)) {
              this.emit('known_dev_launch', {
                mint: coin.mint,
                creator: coin.creator,
                type: 'pump_fun'
              });
            }
          }
        }
      } catch (error) {
        console.error('❌ Pump.fun listener error:', error.message);
      }
    }, 1000);
  }

  // 2. Dev wallet monitor
  startDevWalletMonitor() {
    for (const wallet of this.devWallets) {
      this.monitorAddress(wallet);
    }
  }

  monitorAddress(address) {
    const publicKey = new PublicKey(address);
    
    // Monitor for new token creation
    this.connection.onAccountChange(publicKey, (accountInfo) => {
      // Check for token creation signatures
      this.checkForTokenActivity(publicKey);
    });
    
    this.monitoredAddresses.set(address, {
      lastChecked: Date.now(),
      activity: []
    });
  }

  async checkForTokenActivity(address) {
    try {
      const signatures = await this.connection.getConfirmedSignaturesForAddress2(
        new PublicKey(address),
        { limit: 10 }
      );
      
      for (const sig of signatures) {
        const tx = await this.connection.getTransaction(sig.signature);
        if (tx && this.isTokenCreation(tx)) {
          const mint = this.extractMintFromTx(tx);
          if (mint) {
            this.emit('dev_wallet_activity', {
              address: address,
              mint: mint,
              type: 'token_creation',
              timestamp: Date.now()
            });
          }
        }
      }
    } catch (error) {
      console.error('❌ Dev wallet monitor error:', error.message);
    }
  }

  // 3. Pre-LP mempool scanner
  startMempoolScanner() {
    this.mempoolInterval = setInterval(async () => {
      try {
        const recentSlots = await this.connection.getSlot();
        const signatures = await this.connection.getConfirmedSignaturesForAddress2(
          new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), // Token program
          { limit: 100, before: recentSlots }
        );
        
        for (const sig of signatures) {
          const tx = await this.connection.getTransaction(sig.signature, {
            commitment: 'confirmed'
          });
          
          if (tx && this.isPreLPActivity(tx)) {
            const details = this.extractPreLPDetails(tx);
            if (details) {
              this.emit('pre_lp_detected', details);
            }
          }
        }
      } catch (error) {
        console.error('❌ Mempool scanner error:', error.message);
      }
    }, 2000);
  }

  // Helper methods
  isNewLaunch(coin) {
    const launchTime = new Date(coin.created_timestamp).getTime();
    return Date.now() - launchTime < 30000; // Within 30 seconds
  }

  isTokenCreation(tx) {
    const logs = tx.meta?.logMessages || [];
    return logs.some(log => 
      log.includes('InitializeMint') || 
      log.includes('CreateAccount') ||
      log.includes('InitializeAccount')
    );
  }

  isPreLPActivity(tx) {
    const logs = tx.meta?.logMessages || [];
    return logs.some(log => 
      log.includes('InitializeAccount') && 
      log.includes('Amm')
    );
  }

  extractMintFromTx(tx) {
    const instructions = tx.transaction.message.instructions;
    for (const ix of instructions) {
      if (ix.programId.toString() === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
        // Look for mint in instruction data
        const data = ix.data;
        if (data && data.length > 0) {
          // This is a simplified extraction - would need proper parsing
          return null; // Placeholder
        }
      }
    }
    return null;
  }

  extractPreLPDetails(tx) {
    const instructions = tx.transaction.message.instructions;
    for (const ix of instructions) {
      if (ix.programId.toString().includes('Amm')) {
        return {
          signature: tx.transaction.signatures[0],
          timestamp: Date.now(),
          type: 'pre_lp_setup',
          details: ix.data
        };
      }
    }
    return null;
  }

  // Multi-hop wallet correlation
  async correlateWallets(address) {
    const correlation = {
      address,
      fundingPaths: [],
      sharedGasWallets: [],
      connectedWallets: []
    };

    try {
      // Check funding sources
      const signatures = await this.connection.getConfirmedSignaturesForAddress2(
        new PublicKey(address),
        { limit: 50 }
      );
      
      for (const sig of signatures) {
        const tx = await this.connection.getTransaction(sig.signature);
        if (tx) {
          // Look for funding patterns
          const funding = this.analyzeFunding(tx);
          if (funding) {
            correlation.fundingPaths.push(funding);
          }
          
          // Check for shared gas wallets
          const gasWallet = this.identifyGasWallet(tx);
          if (gasWallet && !correlation.sharedGasWallets.includes(gasWallet)) {
            correlation.sharedGasWallets.push(gasWallet);
          }
        }
      }
      
      return correlation;
    } catch (error) {
      console.error('❌ Wallet correlation error:', error.message);
      return correlation;
    }
  }

  analyzeFunding(tx) {
    // Simplified funding analysis
    const instructions = tx.transaction.message.instructions;
    for (const ix of instructions) {
      if (ix.programId.toString() === '11111111111111111111111111111111') { // System program
        // Look for SOL transfers
        return {
          from: ix.keys[0]?.pubkey?.toString(),
          amount: ix.data ? parseInt(ix.data) : 0,
          type: 'sol_transfer'
        };
      }
    }
    return null;
  }

  identifyGasWallet(tx) {
    // Identify wallets that paid for gas
    const feePayer = tx.transaction.message.accountKeys[0];
    return feePayer.toString();
  }

  // Add new dev wallet for monitoring
  addDevWallet(address, label = '') {
    if (!this.devWallets.has(address)) {
      this.devWallets.add(address);
      this.monitorAddress(address);
      this.saveDevWallet(address);
      
      this.emit('wallet_added', {
        address,
        label,
        timestamp: Date.now()
      });
    }
  }

  // Get current alpha signals
  getAlphaSignals() {
    return {
      pumpFunRecent: this.getRecentPumpLaunches(),
      devActivity: this.getRecentDevActivity(),
      preLPAlerts: this.getPreLPAlerts(),
      monitoredWallets: Array.from(this.devWallets)
    };
  }

  getRecentPumpLaunches() {
    // Return last 10 Pump.fun launches
    return [];
  }

  getRecentDevActivity() {
    // Return recent activity from monitored wallets
    return [];
  }

  getPreLPAlerts() {
    // Return pre-LP setup alerts
    return [];
  }
}

export default AlphaDetection;