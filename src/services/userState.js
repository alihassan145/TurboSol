// User state management for navigation and settings
import { appendTrade } from "./tradeStore.js";
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
      // New settings toggles
      degenMode: false,
      buyProtection: false,
      expertMode: false,
      privatePnl: false,
      // Execution preferences
      enablePrivateRelay: false, // use private relay for tx submission instead of public RPC when possible
      // Add RPC strategy selector (affects micro-batch racing behavior)
      rpcStrategy: "balanced", // one of: "conservative" | "balanced" | "aggressive"
      // Wallet/positions/trades
      positions: [],
      limitOrders: [],
      watchedWallets: [],
      trades: [],
      menuHistory: ["main"],
      // Defaults for quick actions
      defaultBuySol: 0.05,
      defaultSnipeSol: 0.05,
      // Snipe-specific configuration
      autoSnipeOnPaste: false, // Auto-start snipe without confirmation on address paste
      snipeSlippage: 100, // Custom slippage for snipe operations (in BPS)
      maxSnipeGasPrice: 200000, // Max priority fee for snipe operations (lamports)
      snipePollInterval: 300, // Polling interval for liquidity checks (ms)
      enableJitoForSnipes: true, // Use Jito bundling for snipes by default
      snipeRetryCount: 3, // Number of retry attempts on failed snipe
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

export function addTradeLog(chatId, trade) {
  const state = getUserState(chatId);
  const entry = { ...trade, timestamp: Date.now(), id: Date.now().toString() };
  state.trades.push(entry);
  // Persist trades to disk for analytics dashboard
  appendTrade(chatId, entry);
  if (state.trades.length > 200) state.trades = state.trades.slice(-200);

  // Track daily spend for buys
  if (entry.kind === "buy" && typeof entry.sol === "number") {
    const key = getDateKey(entry.timestamp);
    state.dailySpend[key] = (state.dailySpend[key] || 0) + Number(entry.sol);
  }

  // Lightweight adaptive tuning every 20 trades (uses latency heuristic)
  const N = 20;
  if (state.trades.length % N === 0) {
    const lastN = state.trades.slice(-N);
    const latencies = lastN
      .map((t) => Number(t.latencyMs || 0))
      .filter((x) => Number.isFinite(x) && x > 0);
    const avgLat = latencies.length
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length
      : null;
    // Adjust snipe slippage based on observed send/confirm latency proxy
    if (avgLat != null) {
      if (avgLat > 900) {
        state.snipeSlippage = clamp(
          (state.snipeSlippage || 100) + 50,
          50,
          1000
        );
      } else if (avgLat < 350) {
        state.snipeSlippage = clamp(
          (state.snipeSlippage || 100) - 25,
          50,
          1000
        );
      }
      // Adjust gas price ceiling
      const curMax = Number(state.maxSnipeGasPrice || 200000);
      if (avgLat > 900) {
        state.maxSnipeGasPrice = Math.floor(curMax * 1.2);
      } else if (avgLat < 350) {
        state.maxSnipeGasPrice = Math.max(50000, Math.floor(curMax * 0.9));
      }
    }
  }
}

export function addLimitOrder(chatId, order) {
  const state = getUserState(chatId);
  state.limitOrders.push({
    ...order,
    timestamp: Date.now(),
    id: Date.now().toString(),
    status: "active",
  });
}

export function addWatchedWallet(chatId, walletAddress, label = "") {
  const state = getUserState(chatId);
  state.watchedWallets.push({
    address: walletAddress,
    label,
    timestamp: Date.now(),
    id: Date.now().toString(),
  });
}

export function setPendingInput(chatId, pending) {
  const state = getUserState(chatId);
  state.pendingInput = pending; // or null to clear
}

export function getAllUserStates() {
  return Array.from(userStates.entries()); // [ [chatId, state], ... ]
}
