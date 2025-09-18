import axios from "axios";
import { Connection, PublicKey } from "@solana/web3.js";
import EventEmitter from "events";
import { readFileSync } from "fs";
import { appendTrade } from "./tradeStore.js";
import https from "https";
import PumpPortalListener from "./pumpPortalListener.js";

const PUMP_FUN_API = "https://frontend-api.pump.fun";
const DEV_WALLET_DB_FILE = "./data/dev_wallets.json";

// Central lightweight bus for cross-service alpha signals
export const alphaBus = new EventEmitter();

class AlphaDetection extends EventEmitter {
  constructor(connection) {
    super();
    this.connection = connection;
    this.isRunning = false;
    this.devWallets = new Set();
    this.monitoredAddresses = new Map();
    this.pumpInterval = null;
    this.mempoolInterval = null;
    // Backoff control for Pump.fun listener and seen signatures for mempool
    this.pumpBackoffMs = 0;
    this.pumpBackoffUntil = 0;
    this.seenTokenProgramSigs = new Set();
    // Pump.fun HTTP circuit breaker + fallback via on-chain logs
    this.pumpErrorCount = 0;
    this.pumpHttpDisabledUntil = 0;
    this.pumpFallbackActive = false;
    this.pumpLogSubs = [];
    // Reuse HTTPS keep-alive agent to reduce connection setup overhead
    this.httpAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 10000,
      maxSockets: 20,
    });
    // PumpPortal WS listener instance
    this.pumpPortal = null;
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    await this.loadDevWallets();
    this.startPumpListener();
    this.startDevWalletMonitor();
    this.startMempoolScanner();

    console.log("🎯 Alpha detection layer started");
  }

  async stop() {
    this.isRunning = false;
    if (this.pumpInterval) clearInterval(this.pumpInterval);
    if (this.mempoolInterval) clearInterval(this.mempoolInterval);
    // Stop PumpPortal WS if running
    try { this.pumpPortal?.stop?.(); } catch {}
    this.pumpPortal = null;
    console.log("🎯 Alpha detection layer stopped");
  }

  async loadDevWallets() {
    try {
      const data = readFileSync(DEV_WALLET_DB_FILE, "utf8");
      const wallets = JSON.parse(data);
      this.devWallets = new Set(wallets);
      console.log(`📊 Loaded ${wallets.length} dev wallets for monitoring`);
    } catch (error) {
      console.log("📊 No dev wallet database found, creating new one");
      this.devWallets = new Set();
    }
  }

  saveDevWallet(wallet) {
    this.devWallets.add(wallet);
    // In production, save to file
  }

  // 1. Pump.fun listener now uses PumpPortal WebSocket feed
  startPumpListener() {
    try {
      if (this.pumpPortal) {
        try { this.pumpPortal.stop(); } catch {}
        this.pumpPortal = null;
      }
      this.pumpPortal = new PumpPortalListener({ apiKey: process.env.PUMPPORTAL_API_KEY });
      this.pumpPortal.on("new_launch", (coin) => {
        try {
          const payload = {
            mint: coin?.mint,
            name: coin?.name || "",
            symbol: coin?.symbol || "",
            timestamp: Date.now(),
            marketCap: typeof coin?.marketCap === "number" ? coin.marketCap : 0,
            creator: coin?.creator || "",
          };
          if (!payload.mint) return;
          this.emit("pump_launch", payload);
          try { alphaBus.emit("pump_launch", payload); } catch {}
          if (payload.creator && this.devWallets.has(payload.creator)) {
            const knownPayload = { mint: payload.mint, creator: payload.creator, type: "pump_fun" };
            this.emit("known_dev_launch", knownPayload);
            try { alphaBus.emit("known_dev_launch", knownPayload); } catch {}
          }
        } catch {}
      });
      this.pumpPortal.start();
      console.log("🔌 PumpPortal WebSocket listener started for Pump.fun launches");
    } catch (e) {
      console.error("❌ Failed to start PumpPortal listener:", e?.message || e);
      // Optional: fallback to previous HTTP polling (disabled by default)
    }
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
      activity: [],
    });
  }

  async checkForTokenActivity(address) {
    try {
      const signatures = await this.connection.getSignaturesForAddress(
        new PublicKey(address),
        { limit: 10 }
      );

      for (const sig of signatures) {
        const tx = await this.connection.getTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
        });
        if (tx && this.isTokenCreation(tx)) {
          const mint = this.extractMintFromTx(tx);
          if (mint) {
            const payload = {
              address: address,
              mint: mint,
              type: "token_creation",
              timestamp: Date.now(),
            };
            this.emit("dev_wallet_activity", payload);
            try {
              alphaBus.emit("dev_wallet_activity", payload);
            } catch {}
          }
        }
      }
    } catch (error) {
      console.error("❌ Dev wallet monitor error:", error.message);
    }
  }

  // 3. Pre-LP mempool scanner
  startMempoolScanner() {
    this.mempoolInterval = setInterval(async () => {
      try {
        const signatures = await this.connection.getSignaturesForAddress(
          new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
          { limit: 100 }
        );

        for (const sig of signatures) {
          if (this.seenTokenProgramSigs.has(sig.signature)) continue;

          try {
            const tx = await this.connection.getTransaction(sig.signature, {
              commitment: "confirmed",
              maxSupportedTransactionVersion: 0,
            });

            if (tx && this.isPreLPActivity(tx)) {
              const details = this.extractPreLPDetails(tx);
              if (details) {
                this.emit("pre_lp_detected", details);
                try {
                  alphaBus.emit("pre_lp_detected", details);
                } catch {}
              }
            }
          } catch (txError) {
            // Log individual transaction errors but continue processing
            if (txError.message.includes("Transaction version")) {
              console.warn(
                `⚠️ Transaction version error for ${sig.signature}: ${txError.message}`
              );
            } else if (txError.message.includes("not found")) {
              // Transaction not found is common for recent signatures, skip silently
            } else {
              console.warn(
                `⚠️ Failed to fetch transaction ${sig.signature}: ${txError.message}`
              );
            }
          }

          // Mark as seen to avoid reprocessing
          this.seenTokenProgramSigs.add(sig.signature);
        }
      } catch (error) {
        console.error("❌ Mempool scanner error:", error.message);
      }
    }, 1500);
  }

  // Helper methods
  isNewLaunch(coin) {
    const launchTime = new Date(coin.created_timestamp).getTime();
    return Date.now() - launchTime < 30000; // Within 30 seconds
  }

  isTokenCreation(tx) {
    const logs = tx.meta?.logMessages || [];
    return logs.some(
      (log) =>
        log.includes("InitializeMint") ||
        log.includes("CreateAccount") ||
        log.includes("InitializeAccount")
    );
  }

  isPreLPActivity(tx) {
    const logs = tx.meta?.logMessages || [];
    return logs.some(
      (log) => log.includes("InitializeAccount") && log.includes("Amm")
    );
  }

  extractMintFromTx(tx) {
    const instructions = tx.transaction.message.instructions;
    for (const ix of instructions) {
      if (
        ix.programId.toString() ===
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
      ) {
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
      if (ix.programId.toString().includes("Amm")) {
        return {
          signature: tx.transaction.signatures[0],
          timestamp: Date.now(),
          type: "pre_lp_setup",
          details: ix.data,
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
      connectedWallets: [],
    };

    try {
      // Check funding sources
      const signatures = await this.connection.getSignaturesForAddress(
        new PublicKey(address),
        { limit: 50 }
      );

      for (const sig of signatures) {
        const tx = await this.connection.getTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
        });
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
      console.error("❌ Wallet correlation error:", error.message);
      return correlation;
    }
  }

  analyzeFunding(tx) {
    // Simplified funding analysis
    const instructions = tx.transaction.message.instructions;
    for (const ix of instructions) {
      if (ix.programId.toString() === "11111111111111111111111111111111") {
        // System program
        // Look for SOL transfers
        return {
          from: ix.keys[0]?.pubkey?.toString(),
          amount: ix.data ? parseInt(ix.data) : 0,
          type: "sol_transfer",
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
  addDevWallet(address, label = "") {
    if (!this.devWallets.has(address)) {
      this.devWallets.add(address);
      this.monitorAddress(address);
      this.saveDevWallet(address);

      this.emit("wallet_added", {
        address,
        label,
        timestamp: Date.now(),
      });
    }
  }

  // Get current alpha signals
  getAlphaSignals() {
    return {
      pumpFunRecent: this.getRecentPumpLaunches(),
      devActivity: this.getRecentDevActivity(),
      preLPAlerts: this.getPreLPAlerts(),
      monitoredWallets: Array.from(this.devWallets),
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

  // Start on-chain log fallback for Pump.fun launches (uses env PUMPFUN_PROGRAM_IDS)
  startPumpOnChainFallback() {
    try {
      const ids = (process.env.PUMPFUN_PROGRAM_IDS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length === 0) {
        console.warn(
          "ℹ️ No PUMPFUN_PROGRAM_IDS configured; cannot start on-chain fallback."
        );
        return;
      }
      if (this.pumpFallbackActive) return;
      this.pumpFallbackActive = true;
      this.pumpLogSubs = [];
      console.log("🔁 Starting Pump.fun on-chain log fallback");
      for (const pid of ids) {
        let programKey;
        try {
          programKey = new PublicKey(pid);
        } catch {
          console.warn(`⚠️ Invalid program id for on-chain fallback: ${pid}`);
          continue;
        }
        const subId = this.connection
          .onLogs(
            { mentions: [programKey.toBase58()] },
            (logs) => {
              try {
                const joined = logs?.logs?.join("\n") || "";
                const m = joined.match(/mint\s*:\s*([A-Za-z0-9]{32,44})/i);
                if (m && m[1]) {
                  const mint = m[1];
                  const payload = {
                    mint,
                    timestamp: Date.now(),
                    source: "onchain_logs",
                  };
                  this.emit("pump_launch", payload);
                  try {
                    alphaBus.emit("pump_launch", payload);
                  } catch {}
                }
              } catch {}
            },
            "confirmed"
          )
          .then((subId) => {
            this.pumpLogSubs.push({ programId: pid, subId });
          })
          .catch(() => {});
      }
    } catch (e) {
      console.warn("Pump.fun on-chain fallback start error:", e?.message || e);
    }
  }

  stopPumpOnChainFallback() {
    if (!this.pumpFallbackActive) return;
    console.log("🔁 Stopping Pump.fun on-chain log fallback (HTTP healthy)");
    for (const { subId } of this.pumpLogSubs) {
      try {
        this.connection.removeOnLogsListener(subId);
      } catch {}
    }
    this.pumpLogSubs = [];
    this.pumpFallbackActive = false;
    this.pumpErrorCount = 0;
    this.pumpHttpDisabledUntil = 0;
  }
}

export default AlphaDetection;