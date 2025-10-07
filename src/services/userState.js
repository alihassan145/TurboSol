// User state management for navigation and settings
import { appendTrade } from "./tradeStore.js";
import { recordTradeEvent } from "./analytics/behaviorProfiling.js";
import { getUserPublicKey } from "./userWallets.js";
import { MongoClient } from "mongodb";

const userStates = new Map();

// Whitelist of keys we persist to DB per user (focus on automation/settings)
const PERSISTED_KEYS = new Set([
  // Core automation toggles
  "autoSnipeMode",
  "afkMode",
  "preLPWatchEnabled",
  "liqDeltaEnabled",
  "pumpFunAlerts",
  // Snipe defaults/config
  "autoSnipeOnPaste",
  "snipeSlippage",
  "maxSnipeGasPrice",
  "snipePollInterval",
  "enableJitoForSnipes",
  "snipeRetryCount",
  // Risk/alerts
  "lpUnlockAlerts",
  // General settings
  "degenMode",
  "buyProtection",
  "expertMode",
  "privatePnl",
  "enablePrivateRelay",
  "rpcStrategy",
  "dynamicPriorityFee",
  // Multi-wallet selection
  "multiWalletMode",
  "selectedWalletIds",
  // Analytics toggles
  "enableBehaviorProfiling",
  "enableMultiHopCorrelation",
  "enableFundingPathAnalysis",
  // Liquidity Delta per-chat overrides
  "liqDeltaProbeSol",
  "liqDeltaMinImprovPct",
  "deltaMaxPriceImpactPct",
  "deltaMinRouteAgeMs",
  // Launch discovery filters
  "launchFilter",
  // Tier (optional)
  "tier"
]);

// Optional: lazy Mongo connection for storing user settings
let mongoClient;
let settingsCol;
let connectingPromise;

async function ensureSettingsCol() {
  if (settingsCol) return settingsCol;
  const uri = process.env.MONGODB_URI;
  if (!uri) return null; // allow app to run without DB
  if (!connectingPromise) {
    connectingPromise = (async () => {
      const client = new MongoClient(uri, { ignoreUndefined: true });
      await client.connect();
      const db = client.db(process.env.MONGODB_DB || "turbosol");
      const col = db.collection("user_settings");
      try {
        await col.createIndex({ chatId: 1 }, { unique: true });
      } catch {}
      mongoClient = client;
      settingsCol = col;
      return col;
    })();
  }
  try {
    await connectingPromise;
  } catch (e) {
    // swallow DB init errors to avoid impacting runtime
  }
  return settingsCol || null;
}

async function persistUserSetting(chatId, key, value) {
  try {
    const col = await ensureSettingsCol();
    if (!col) return; // DB not configured
    const now = new Date();
    await col.updateOne(
      { chatId: String(chatId) },
      {
        $set: { [key]: value, updatedAt: now },
        $setOnInsert: { chatId: String(chatId), createdAt: now }
      },
      { upsert: true }
    );
  } catch {
    // ignore persistence errors
  }
}

async function loadSettingsFor(chatId) {
  try {
    const col = await ensureSettingsCol();
    if (!col) return null;
    const doc = await col.findOne({ chatId: String(chatId) });
    if (doc) {
      const state = userStates.get(chatId) || getUserState(chatId);
      for (const [k, v] of Object.entries(doc)) {
        if (PERSISTED_KEYS.has(k) && v !== undefined) {
          state[k] = v;
        }
      }
    }
    return doc;
  } catch {
    return null;
  }
}

export function getUserState(chatId) {
  if (!userStates.has(chatId)) {
    userStates.set(chatId, {
      currentMenu: "main",
      lastSnipeSettings: null,
      antiRugMode: false,
      autoSnipeMode: false,
      afkMode: false,
      stealthMode: false,
      pumpFunAlerts: false,
      // New: LP unlock alert toggle (used by risk.js -> lpLockEvents wiring)
      lpUnlockAlerts: true,
      // New settings toggles
      degenMode: false,
      buyProtection: false,
      expertMode: false,
      privatePnl: false,
      // Execution preferences
      enablePrivateRelay: false, // use private relay for tx submission instead of public RPC when possible
      // Add RPC strategy selector (affects micro-batch racing behavior)
      rpcStrategy: "balanced", // one of: "conservative" | "balanced" | "aggressive"
      dynamicPriorityFee: false, // Dynamic tip adjustment based on network conditions
      // Analytics toggles
      enableBehaviorProfiling: false,
      enableMultiHopCorrelation: false,
      enableFundingPathAnalysis: false,
      // Wallet/positions/trades
      // Multi-wallet selection and mode
      multiWalletMode: false,
      selectedWalletIds: [],
      positions: [],
      limitOrders: [],
      watchedWallets: [],
      trades: [],
      menuHistory: ["main"],
      // Defaults for quick actions
      defaultBuySol: 0.05,
      defaultSnipeSol: 0.05,
      // Discovery filters for new launches
      launchFilter: {
        maxAgeSec: 300, // alert only within first 5 minutes
        minMarketCapUsd: 0, // minimum market cap for alerts (0 disables)
        minLiquidityUsd: 0, // minimum liquidity if available via providers
        minHolders: 0, // minimum holder count (best-effort, may be unavailable)
        requireAntiRug: true, // run risk checks and require pass
        requireLpLock: false, // require verified LP lock
        maxBuyTaxBps: 1500 // block if buy tax exceeds threshold
      },
      // Track last used amounts by mint for quick reuse in Re-Buy/Re-Quote
      lastAmounts: {},
      // Snipe-specific configuration
      autoSnipeOnPaste: false, // Auto-start snipe without confirmation on address paste
      snipeSlippage: 100, // Custom slippage for snipe operations (in BPS)
      maxSnipeGasPrice: 200000, // Max priority fee for snipe operations (lamports)
      snipePollInterval: 300, // Polling interval for liquidity checks (ms)
      enableJitoForSnipes: true, // Use Jito bundling for snipes by default
      snipeRetryCount: 3, // Number of retry attempts on failed snipe
      // New automation toggles
      preLPWatchEnabled: false,
      liqDeltaEnabled:
        String(process.env.LIQ_DELTA_ENABLED || "true").toLowerCase() !==
        "false",
      // Per-chat overrides for Liquidity Delta heuristic (null => use ENV defaults)
      liqDeltaProbeSol: null, // e.g., 0.1 SOL probe size
      liqDeltaMinImprovPct: null, // e.g., require >= X% improvement between probes
      deltaMaxPriceImpactPct: null, // e.g., cap entry if price impact > X%
      deltaMinRouteAgeMs: null, // e.g., require route age >= X ms before entry
      // Scaling: wallet tiering and spend caps
      tier: "basic",
      tierCaps: { basic: 1, plus: 3, pro: 10 }, // daily SOL cap per tier
      dailySpend: {}, // { YYYY-MM-DD: number }
      // For text input flows
      pendingInput: null, // e.g., { type: 'IMPORT_WALLET', data: {...} }
      // Copy Trade state
      copyTrade: {
        enabled: false,
        followedWallets: [], // [{ address, name?, enabled, copyBuy?, copySell?, mode?, amountSOL?, percent?, perTradeCapSOL?, dailyCapSOL?, slippageBps?, maxConcurrent? }]
      }
    });

    // Lazily hydrate from DB (best-effort, non-blocking)
    loadSettingsFor(chatId).catch(() => {});
  }
  return userStates.get(chatId);
}

export function setUserMenu(chatId, menu) {
  const state = getUserState(chatId);
  if (state.currentMenu !== menu) {
    state.menuHistory.push(menu);
    if (state.menuHistory.length > 10) {
      state.menuHistory = state.menuHistory.slice(-10);
    }
  }
  state.currentMenu = menu;
}

export function goBack(chatId) {
  const state = getUserState(chatId);
  if (state.menuHistory.length > 1) {
    state.menuHistory.pop(); // Remove current
    const previousMenu = state.menuHistory[state.menuHistory.length - 1];
    state.currentMenu = previousMenu;
    return previousMenu;
  }
  return "main";
}

export function updateUserSetting(chatId, key, value) {
  const state = getUserState(chatId);
  state[key] = value;
  if (PERSISTED_KEYS.has(key)) {
    // Best-effort persistence
    persistUserSetting(chatId, key, value).catch(() => {});
  }
  // If updating nested launchFilter object, persist whole object under the key
  if (key === "launchFilter") {
    persistUserSetting(chatId, key, value).catch(() => {});
  }
}

export function addPosition(chatId, position) {
  const state = getUserState(chatId);
  state.positions.push({
    ...position,
    timestamp: Date.now(),
    id: Date.now().toString(),
  });
}

function getDateKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// Provide helpers for daily spend caps by tier
export function getDailyCap(chatId) {
  const state = getUserState(chatId);
  const tier = state.tier || "basic";
  const caps = state.tierCaps || {};
  const cap = caps[tier];
  return Number.isFinite(cap) ? cap : Infinity;
}

export function getDailySpent(chatId, ts = Date.now()) {
  const state = getUserState(chatId);
  const key = getDateKey(ts);
  const spent = state.dailySpend?.[key] || 0;
  return Number(spent) || 0;
}

export function getRemainingDailyCap(chatId) {
  const cap = getDailyCap(chatId);
  const spent = getDailySpent(chatId);
  return Math.max(0, cap - spent);
}

export function addTradeLog(chatId, trade) {
  const state = getUserState(chatId);
  const ts = Date.now();
  try {
    state.trades.push({ ...trade, timestamp: ts });
  } catch {}
  try {
    appendTrade(String(chatId), { ...trade, timestamp: ts });
  } catch {}
  try {
    const pub = getUserPublicKey(chatId);
    recordTradeEvent({ chatId, pub, ...trade, timestamp: ts });
  } catch {}
}

export function addLimitOrder(chatId, order) {
  const state = getUserState(chatId);
  state.limitOrders.push({ ...order, createdAt: Date.now() });
}

export function addWatchedWallet(chatId, walletAddress, label = "") {
  const state = getUserState(chatId);
  state.watchedWallets.push({ walletAddress, label, addedAt: Date.now() });
}

export function setPendingInput(chatId, pending) {
  const state = getUserState(chatId);
  state.pendingInput = pending;
}

export function getAllUserStates() {
  return userStates;
}

// Copy Trade helpers
export function getCopyTradeState(chatId) {
  const state = getUserState(chatId);
  if (!state.copyTrade) {
    state.copyTrade = { enabled: false, followedWallets: [] };
  }
  return state.copyTrade;
}

export function setCopyTradeEnabled(chatId, enabled) {
  const ct = getCopyTradeState(chatId);
  ct.enabled = !!enabled;
}

export function addCopyTradeWallet(chatId, wallet) {
  const ct = getCopyTradeState(chatId);
  const address = String(wallet?.address || "").trim();
  if (!address) return;
  const exists = (ct.followedWallets || []).some((w) => w.address === address);
  if (exists) return;
  const entry = {
    address,
    name: wallet?.name || "",
    enabled: wallet?.enabled !== false,
    copyBuy: wallet?.copyBuy !== false,
    copySell: wallet?.copySell !== false,
    mode: wallet?.mode || "fixed", // fixed | percent
    amountSOL: Number.isFinite(Number(wallet?.amountSOL))
      ? Number(wallet.amountSOL)
      : 0.05,
    percent: Number.isFinite(Number(wallet?.percent))
      ? Number(wallet.percent)
      : 10,
    perTradeCapSOL: Number.isFinite(Number(wallet?.perTradeCapSOL))
      ? Number(wallet.perTradeCapSOL)
      : null,
    dailyCapSOL: Number.isFinite(Number(wallet?.dailyCapSOL))
      ? Number(wallet.dailyCapSOL)
      : null,
    slippageBps: Number.isFinite(Number(wallet?.slippageBps))
      ? Number(wallet.slippageBps)
      : null,
    maxConcurrent: Number.isFinite(Number(wallet?.maxConcurrent))
      ? Number(wallet.maxConcurrent)
      : null,
    addedAt: Date.now(),
  };
  ct.followedWallets.push(entry);
}

export function removeCopyTradeWallet(chatId, address) {
  const ct = getCopyTradeState(chatId);
  ct.followedWallets = (ct.followedWallets || []).filter(
    (w) => w.address !== address
  );
}

export function updateCopyTradeWallet(chatId, address, patch = {}) {
  const ct = getCopyTradeState(chatId);
  const w = (ct.followedWallets || []).find((x) => x.address === address);
  if (w) Object.assign(w, patch);
}
