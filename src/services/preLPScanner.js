import { Connection, PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import bs58 from 'bs58';
import { getSignaturesForAddressRaced, getTransactionRaced } from './rpc.js';

const RAYDIUM_AMM_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6Q';

class PreLPScanner extends EventEmitter {
  constructor(connection) {
    super();
    this.connection = connection;
    this.isRunning = false;
    this.monitoredTokens = new Set();
    this.scanInterval = null;
    this.mempoolCache = new Map();
    this.seenPumpSigs = new Set();
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    
    this.startMempoolScan();
    console.log('🔍 Pre-LP mempool scanner started');
  }

  stop() {
    this.isRunning = false;
    if (this.scanInterval) clearInterval(this.scanInterval);
    console.log('🔍 Pre-LP mempool scanner stopped');
  }

  async startMempoolScan() {
    this.scanInterval = setInterval(async () => {
      if (!this.isRunning) return;
      
      try {
        await this.scanMempool();
      } catch (error) {
        console.error('❌ Mempool scan error:', error.message);
      }
    }, 500); // Scan every 500ms for speed
  }

  async scanMempool() {
    try {
      // Get recent signatures from network
      const signatures = await getSignaturesForAddressRaced(
        new PublicKey(PUMP_FUN_PROGRAM),
        { options: { limit: 100 } }
      );

      for (const sig of signatures) {
        if (this.mempoolCache.has(sig.signature) || this.seenPumpSigs.has(sig.signature)) continue;
        
        try {
          const tx = await getTransactionRaced(sig.signature, {
            maxSupportedTransactionVersion: 0
          });

          if (!tx) continue;

          this.mempoolCache.set(sig.signature, {
            signature: sig.signature,
            timestamp: Date.now(),
            transaction: tx
          });
          this.seenPumpSigs.add(sig.signature);
          if (this.seenPumpSigs.size > 5000) {
            const keep = Array.from(this.seenPumpSigs).slice(-2500);
            this.seenPumpSigs = new Set(keep);
          }

          // Clean old cache entries
          this.cleanCache();

          // Analyze transaction for pre-LP signals
          const analysis = await this.analyzeTransaction(tx);
          if (analysis && analysis.isPreLP) {
            this.emit('pre_lp_detected', {
              signature: sig.signature,
              timestamp: Date.now(),
              ...analysis
            });
          }

        } catch (error) {
          // Skip failed transactions
        }
      }

    } catch (error) {
      console.error('❌ Failed to scan mempool:', error.message);
    }
  }

  async analyzeTransaction(tx) {
    const logs = tx.meta?.logMessages || [];
    const instructions = tx.transaction.message.instructions;
    
    let analysis = {
      isPreLP: false,
      token: null,
      lpType: null,
      confidence: 0,
      signals: []
    };

    // Check for token creation signals
    const hasTokenCreation = logs.some(log => 
      log.includes('InitializeMint') ||
      log.includes('create') ||
      log.includes('mint')
    );

    if (hasTokenCreation) {
      analysis.signals.push('token_creation');
      analysis.confidence += 30;
    }

    // Check for LP setup signals
    const hasLPSetup = logs.some(log => 
      log.includes('Amm') ||
      log.includes('pool') ||
      log.includes('liquidity') ||
      log.includes('initialize')
    );

    if (hasLPSetup) {
      analysis.signals.push('lp_setup');
      analysis.confidence += 40;
      analysis.lpType = 'raydium';
    }

    // Check for Pump.fun specific signals
    const hasPumpFunSignals = logs.some(log => 
      log.includes('pump') ||
      log.includes('bonding')
    );

    if (hasPumpFunSignals) {
      analysis.signals.push('pump_fun');
      analysis.confidence += 25;
      analysis.lpType = 'pump_fun';
    }

    // Extract token information
    const tokenInfo = this.extractTokenInfo(tx);
    if (tokenInfo) {
      analysis.token = tokenInfo;
      analysis.confidence += 20;
    }

    // Check transaction patterns
    const patterns = this.analyzePatterns(tx);
    if (patterns.length > 0) {
      analysis.signals.push(...patterns);
      analysis.confidence += patterns.length * 10;
    }

    // Determine if this is pre-LP
    analysis.isPreLP = analysis.confidence >= 50;

    return analysis;
  }

  extractTokenInfo(tx) {
    const instructions = tx.transaction.message.instructions;
    
    for (const ix of instructions) {
      // Look for token program instructions
      if (ix.programId.toString() === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
        const keys = ix.keys || [];
        for (const key of keys) {
          const pubkey = key.pubkey.toString();
          if (pubkey.length === 44 && pubkey !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
            return {
              mint: pubkey,
              program: ix.programId.toString()
            };
          }
        }
      }
    }

    return null;
  }

  analyzePatterns(tx) {
    const patterns = [];
    const logs = tx.meta?.logMessages || [];
    
    // Check for multi-signature patterns
    const signatures = tx.transaction.signatures;
    if (signatures.length > 1) {
      patterns.push('multi_sig');
    }

    // Check for high fee patterns
    const fee = tx.meta?.fee || 0;
    if (fee > 10000) { // > 0.00001 SOL
      patterns.push('high_fee');
    }

    // Check for compute budget patterns
    const hasComputeBudget = logs.some(log => 
      log.includes('ComputeBudget111111111111111111111111111111')
    );
    if (hasComputeBudget) {
      patterns.push('compute_budget');
    }

    // Check for associated token account creation
    const hasATA = logs.some(log => 
      log.includes('AssociatedTokenAccount') ||
      log.includes('create_associated_token_account')
    );
    if (hasATA) {
      patterns.push('ata_creation');
    }

    return patterns;
  }

  cleanCache() {
    const maxAge = 5 * 60 * 1000; // 5 minutes
    const now = Date.now();
    
    for (const [sig, data] of this.mempoolCache) {
      if (now - data.timestamp > maxAge) {
        this.mempoolCache.delete(sig);
      }
    }
  }

  async getRecentPreLPSignals(limit = 10) {
    const signals = [];
    
    for (const [sig, data] of this.mempoolCache) {
      if (signals.length >= limit) break;
      
      try {
        const analysis = await this.analyzeTransaction(data.transaction);
        if (analysis.isPreLP) {
          signals.push({
            signature: sig,
            ...analysis,
            timestamp: data.timestamp
          });
        }
      } catch (error) {
        // Skip invalid transactions
      }
    }

    return signals.sort((a, b) => b.timestamp - a.timestamp);
  }

  async monitorToken(mint) {
    if (this.monitoredTokens.has(mint)) return;
    
    this.monitoredTokens.add(mint);
    console.log(`👀 Monitoring token: ${mint}`);
    
    // Set up specific monitoring for this token
    this.emit('token_monitored', { mint });
  }

  stopMonitoringToken(mint) {
    this.monitoredTokens.delete(mint);
    console.log(`❌ Stopped monitoring token: ${mint}`);
  }

  getMonitoredTokens() {
    return Array.from(this.monitoredTokens);
  }

  getStats() {
    return {
      isRunning: this.isRunning,
      monitoredTokens: this.monitoredTokens.size,
      cacheSize: this.mempoolCache.size,
      recentSignals: this.mempoolCache.size
    };
  }

  // Advanced signal detection
  async detectAdvancedSignals(tx) {
    const signals = [];
    
    // Detect flash LP additions
    const flashLP = await this.detectFlashLP(tx);
    if (flashLP) {
      signals.push({
        type: 'flash_lp',
        confidence: 85,
        ...flashLP
      });
    }

    // Detect sandwich attack preparations
    const sandwichPrep = await this.detectSandwichPrep(tx);
    if (sandwichPrep) {
      signals.push({
        type: 'sandwich_prep',
        confidence: 70,
        ...sandwichPrep
      });
    }

    // Detect whale movements
    const whaleMove = await this.detectWhaleMovement(tx);
    if (whaleMove) {
      signals.push({
        type: 'whale_movement',
        confidence: 60,
        ...whaleMove
      });
    }

    return signals;
  }

  async detectFlashLP(tx) {
    const logs = tx.meta?.logMessages || [];
    
    // Look for rapid LP setup patterns
    const hasLPSetup = logs.some(log => 
      log.includes('add_liquidity') ||
      log.includes('create_pool')
    );

    if (hasLPSetup) {
      const timeSinceCreation = Date.now() - (tx.blockTime * 1000 || 0);
      if (timeSinceCreation < 60000) { // Within 1 minute
        return {
          timestamp: tx.blockTime || Date.now(),
          timeSinceCreation,
          signature: tx.transaction.signatures[0]
        };
      }
    }

    return null;
  }

  async detectSandwichPrep(tx) {
    // Simplified sandwich detection
    const instructions = tx.transaction.message.instructions;
    
    const hasSwap = instructions.some(ix => 
      ix.programId.toString() === RAYDIUM_AMM_PROGRAM
    );

    if (hasSwap) {
      return {
        timestamp: tx.blockTime || Date.now(),
        signature: tx.transaction.signatures[0],
        program: 'raydium'
      };
    }

    return null;
  }

  async detectWhaleMovement(tx) {
    const preBalances = tx.meta?.preBalances || [];
    const postBalances = tx.meta?.postBalances || [];
    
    const balanceChanges = preBalances.map((pre, i) => 
      Math.abs(postBalances[i] - pre)
    );

    const maxChange = Math.max(...balanceChanges);
    const solChange = maxChange / 1e9; // Convert to SOL

    if (solChange > 100) { // > 100 SOL movement
      return {
        timestamp: tx.blockTime || Date.now(),
        amount: solChange,
        signature: tx.transaction.signatures[0]
      };
    }

    return null;
  }
}

export default PreLPScanner;

// Helper wiring for early snipe on pre-LP signals
import { getUserConnectionInstance } from './wallet.js';
import { getUserState, addTradeLog } from './userState.js';
import { hasUserWallet } from './userWallets.js';
import { startLiquidityWatch } from './watchers/liquidityWatcher.js';

// Cooldown tracking to avoid duplicate triggers per mint
const _preLPCool = new Map(); // mint -> lastTriggerMs
const _preLPInstances = new Map(); // chatId -> scanner instance

async function _shouldTriggerAutoSnipe(chatId) {
  const state = getUserState(chatId);
  return state.autoSnipeOnPaste && (await hasUserWallet(chatId));
}

export async function startPreLPWatch(chatId, { onEvent, onSnipeEvent, autoSnipeOnPreLP = true } = {}) {
  if (_preLPInstances.has(chatId)) return _preLPInstances.get(chatId);
  const conn = await getUserConnectionInstance(chatId);
  const scanner = new PreLPScanner(conn);

  // Configurable guardrails via ENV
  const CONF_MIN = Number(process.env.PRELP_CONFIDENCE_MIN ?? 50);
  const COOL_MS = Number(process.env.PRELP_COOL_MS ?? 10000);

  scanner.on('pre_lp_detected', async (details) => {
    try {
      onEvent?.({ type: 'pre_lp_detected', details });
      if (!autoSnipeOnPreLP) return;
      if (!(await _shouldTriggerAutoSnipe(chatId))) return;

      const mint = details?.token?.mint || details?.mint;
      const confidence = Number(details?.confidence ?? 0);
      if (!mint) return;
      if (confidence < CONF_MIN) return; // guardrail: low-confidence ignore

      const last = _preLPCool.get(mint) || 0;
      if (Date.now() - last < COOL_MS) return; // cooldown

      _preLPCool.set(mint, Date.now());

      // Pull snipe defaults from user state (same as mempool auto-snipe)
      const state = getUserState(chatId);
      const amountSol = state.defaultSnipeSol ?? 0.05;
      const priorityFeeLamports = state.maxSnipeGasPrice;
      const useJitoBundle = state.enableJitoForSnipes;
      const pollInterval = state.snipePollInterval;
      const slippageBps = state.snipeSlippage;
      const retryCount = state.snipeRetryCount;

      try {
        // Persist telemetry for orchestrator decision
        addTradeLog(chatId, { kind: 'telemetry', stage: 'auto_snipe_trigger', source: 'watch:prelp', signalType: 'pre_lp_detected', mint, params: { amountSol: amountSol, pollInterval, slippageBps, retryCount, useJitoBundle } });
      } catch {}

      startLiquidityWatch(chatId, {
        mint,
        amountSol,
        priorityFeeLamports,
        useJitoBundle,
        pollInterval,
        slippageBps,
        retryCount,
        source: 'watch:prelp',
        signalType: 'pre_lp_detected',
        lpSignature: details?.signature,
        onEvent: (m) => { try { onSnipeEvent?.(mint, m); } catch {} },
      });
    } catch {}
  });

  await scanner.start();
  _preLPInstances.set(chatId, scanner);
  return scanner;
}

export function stopPreLPWatch(chatId) {
  const inst = _preLPInstances.get(chatId);
  if (inst) {
    try { inst.stop(); } catch {}
    _preLPInstances.delete(chatId);
  }
}