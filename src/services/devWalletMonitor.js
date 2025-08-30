import { Connection, PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

const DEV_WALLETS_FILE = './data/dev_wallets.json';

class DevWalletMonitor extends EventEmitter {
  constructor(connection) {
    super();
    this.connection = connection;
    this.monitoredWallets = new Map();
    this.isRunning = false;
    this.checkInterval = null;
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    
    await this.loadWallets();
    this.startMonitoring();
    
    console.log('👁️ Dev wallet monitor started');
  }

  stop() {
    this.isRunning = false;
    if (this.checkInterval) clearInterval(this.checkInterval);
    console.log('👁️ Dev wallet monitor stopped');
  }

  async loadWallets() {
    try {
      if (!fs.existsSync(DEV_WALLETS_FILE)) {
        this.saveWallets([]);
      }
      
      const data = fs.readFileSync(DEV_WALLETS_FILE, 'utf8');
      const wallets = JSON.parse(data);
      
      for (const wallet of wallets) {
        this.monitoredWallets.set(wallet.address, {
          ...wallet,
          lastActivity: 0,
          activity: []
        });
      }
      
      console.log(`📊 Loaded ${wallets.length} dev wallets`);
    } catch (error) {
      console.error('❌ Failed to load dev wallets:', error.message);
    }
  }

  saveWallets(wallets) {
    try {
      const dir = path.dirname(DEV_WALLETS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(DEV_WALLETS_FILE, JSON.stringify(wallets, null, 2));
    } catch (error) {
      console.error('❌ Failed to save dev wallets:', error.message);
    }
  }

  addWallet(address, label = '', tags = []) {
    if (!this.isValidSolanaAddress(address)) {
      console.error('❌ Invalid Solana address:', address);
      return false;
    }

    const wallet = {
      address,
      label,
      tags,
      addedAt: Date.now(),
      successRate: 0,
      totalLaunches: 0
    };

    this.monitoredWallets.set(address, {
      ...wallet,
      lastActivity: 0,
      activity: []
    });

    this.saveWallets(Array.from(this.monitoredWallets.values()).map(w => ({
      address: w.address,
      label: w.label,
      tags: w.tags,
      addedAt: w.addedAt,
      successRate: w.successRate,
      totalLaunches: w.totalLaunches
    })));

    console.log(`✅ Added dev wallet: ${address} (${label})`);
    this.emit('wallet_added', wallet);
    return true;
  }

  removeWallet(address) {
    if (this.monitoredWallets.delete(address)) {
      this.saveWallets(Array.from(this.monitoredWallets.values()));
      console.log(`❌ Removed dev wallet: ${address}`);
      this.emit('wallet_removed', address);
      return true;
    }
    return false;
  }

  startMonitoring() {
    this.checkInterval = setInterval(async () => {
      if (!this.isRunning) return;
      
      for (const [address, wallet] of this.monitoredWallets) {
        try {
          await this.checkWalletActivity(address);
        } catch (error) {
          console.error(`❌ Error checking ${address}:`, error.message);
        }
      }
    }, 5000); // Check every 5 seconds
  }

  async checkWalletActivity(address) {
    try {
      const signatures = await this.connection.getConfirmedSignaturesForAddress2(
        new PublicKey(address),
        { limit: 10 }
      );

      const wallet = this.monitoredWallets.get(address);
      const newActivity = [];

      for (const sig of signatures) {
        if (sig.blockTime <= wallet.lastActivity) continue;

        const tx = await this.connection.getTransaction(sig.signature, {
          commitment: 'confirmed'
        });

        if (!tx) continue;

        const activity = this.analyzeTransaction(tx, address);
        if (activity) {
          newActivity.push(activity);
          
          if (activity.type === 'token_creation') {
            this.emit('token_creation', {
              address,
              mint: activity.mint,
              timestamp: activity.timestamp,
              details: activity
            });
          }
          
          if (activity.type === 'lp_setup') {
            this.emit('lp_setup', {
              address,
              mint: activity.mint,
              timestamp: activity.timestamp,
              details: activity
            });
          }
        }
      }

      if (newActivity.length > 0) {
        wallet.activity.unshift(...newActivity);
        wallet.lastActivity = Math.max(...newActivity.map(a => a.timestamp));
        
        // Keep only last 100 activities
        if (wallet.activity.length > 100) {
          wallet.activity = wallet.activity.slice(0, 100);
        }
        
        console.log(`📈 ${address}: ${newActivity.length} new activities`);
      }

    } catch (error) {
      console.error(`❌ Failed to check ${address}:`, error.message);
    }
  }

  analyzeTransaction(tx, walletAddress) {
    const logs = tx.meta?.logMessages || [];
    const instructions = tx.transaction.message.instructions;
    
    // Check for token creation
    const hasInitializeMint = logs.some(log => log.includes('InitializeMint'));
    const hasCreateAccount = logs.some(log => log.includes('CreateAccount'));
    
    if (hasInitializeMint || hasCreateAccount) {
      const mint = this.extractMintFromInstructions(instructions);
      if (mint) {
        return {
          type: 'token_creation',
          mint,
          timestamp: tx.blockTime || Date.now(),
          signature: tx.transaction.signatures[0],
          fee: tx.meta?.fee || 0
        };
      }
    }

    // Check for LP setup (Raydium/Amm)
    const hasLPSetup = logs.some(log => 
      log.includes('Amm') || 
      log.includes('initialize') ||
      log.includes('create_pool')
    );

    if (hasLPSetup) {
      const mint = this.extractMintFromInstructions(instructions);
      return {
        type: 'lp_setup',
        mint,
        timestamp: tx.blockTime || Date.now(),
        signature: tx.transaction.signatures[0],
        fee: tx.meta?.fee || 0
      };
    }

    // Check for funding activity
    const hasSOLTransfer = logs.some(log => log.includes('transfer') && log.includes('111111111'));
    if (hasSOLTransfer) {
      return {
        type: 'funding',
        timestamp: tx.blockTime || Date.now(),
        signature: tx.transaction.signatures[0],
        fee: tx.meta?.fee || 0
      };
    }

    return null;
  }

  extractMintFromInstructions(instructions) {
    for (const ix of instructions) {
      if (ix.programId.toString() === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
        // Simplified extraction - would need proper parsing
        const keys = ix.keys;
        if (keys && keys.length > 0) {
          return keys[0].pubkey.toString();
        }
      }
    }
    return null;
  }

  isValidSolanaAddress(address) {
    try {
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }

  getWallets() {
    return Array.from(this.monitoredWallets.values());
  }

  getWallet(address) {
    return this.monitoredWallets.get(address);
  }

  getActiveWallets() {
    return Array.from(this.monitoredWallets.values()).filter(w => 
      w.activity && w.activity.length > 0
    );
  }

  // Multi-hop correlation
  async correlateWallets(address) {
    if (!this.isValidSolanaAddress(address)) return null;

    const correlation = {
      address,
      fundingPaths: [],
      sharedGasWallets: [],
      connectedWallets: [],
      patterns: []
    };

    try {
      const signatures = await this.connection.getConfirmedSignaturesForAddress2(
        new PublicKey(address),
        { limit: 100 }
      );

      for (const sig of signatures) {
        const tx = await this.connection.getTransaction(sig.signature);
        if (!tx) continue;

        // Analyze funding sources
        const funding = this.analyzeFunding(tx);
        if (funding) {
          correlation.fundingPaths.push(funding);
        }

        // Identify gas wallet relationships
        const gasWallet = tx.transaction.message.accountKeys[0].toString();
        if (gasWallet !== address && !correlation.sharedGasWallets.includes(gasWallet)) {
          correlation.sharedGasWallets.push(gasWallet);
        }

        // Look for shared transaction patterns
        const pattern = this.identifyPattern(tx);
        if (pattern) {
          correlation.patterns.push(pattern);
        }
      }

      return correlation;
    } catch (error) {
      console.error('❌ Correlation error:', error.message);
      return correlation;
    }
  }

  analyzeFunding(tx) {
    const instructions = tx.transaction.message.instructions;
    const funding = [];

    for (const ix of instructions) {
      if (ix.programId.toString() === '11111111111111111111111111111111') {
        const keys = ix.keys;
        if (keys && keys.length >= 2) {
          funding.push({
            from: keys[0].pubkey.toString(),
            to: keys[1].pubkey.toString(),
            amount: 0, // Would need to parse instruction data
            timestamp: tx.blockTime || Date.now(),
            signature: tx.transaction.signatures[0]
          });
        }
      }
    }

    return funding;
  }

  identifyPattern(tx) {
    const logs = tx.meta?.logMessages || [];
    
    const patterns = [];
    if (logs.some(log => log.includes('InitializeMint'))) {
      patterns.push('token_creation');
    }
    if (logs.some(log => log.includes('Amm'))) {
      patterns.push('lp_creation');
    }
    
    return patterns.length > 0 ? {
      type: patterns,
      timestamp: tx.blockTime || Date.now(),
      signature: tx.transaction.signatures[0]
    } : null;
  }
}

export default DevWalletMonitor;