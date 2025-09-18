// User state management for navigation and settings
import { appendTrade } from "./tradeStore.js";
import { recordTradeEvent } from "./analytics/behaviorProfiling.js";
import { getUserPublicKey } from "./userWallets.js";
const userStates = new Map();

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
      // Analytics toggles
      enableBehaviorProfiling: false,
      enableMultiHopCorrelation: false,
      enableFundingPathAnalysis: false,
      // Wallet/positions/trades
      positions: [],
      limitOrders: [],
      watchedWallets: [],
      trades: [],
      menuHistory: ["main"],
      // Defaults for quick actions
      defaultBuySol: 0.05,
      defaultSnipeSol: 0.05,
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
      liqDeltaEnabled: (String(process.env.LIQ_DELTA_ENABLED || "true").toLowerCase() !== "false"),
      // Per-chat overrides for Liquidity Delta heuristic (null => use ENV defaults)
      liqDeltaProbeSol: null,           // e.g., 0.1 SOL probe size
      liqDeltaMinImprovPct: null,       // e.g., require >= X% improvement between probes
      deltaMaxPriceImpactPct: null,     // e.g., cap entry if price impact > X%
      deltaMinRouteAgeMs: null,         // e.g., require route age >= X ms before entry
      // Scaling: wallet tiering and spend caps
      tier: "basic",
      tierCaps: { basic: 1, plus: 3, pro: 10 }, // daily SOL cap per tier
      dailySpend: {}, // { YYYY-MM-DD: number }
      // For text input flows
      pendingInput: null, // e.g., { type: 'IMPORT_WALLET', data: {...} }
    });
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
