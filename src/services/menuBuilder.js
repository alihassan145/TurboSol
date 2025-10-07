import { getWalletInfo } from "./walletInfo.js";
import { getRpcStatus } from "./rpcMonitor.js";
import { getUserState } from "./userState.js";
import { getUserWalletKeypairById } from "./userWallets.js";
import { listUserWallets } from "./userWallets.js";
import { getCopyTradeState } from "./userState.js";
import {
  getRelayVendor,
  getPriorityFeeLamports,
  getDynamicPriorityFeeLamports,
  getUseJitoBundle,
} from "./config.js";

export async function buildWalletStatusHeader(chatId) {
  const info = await getWalletInfo(chatId);
  const balance = info?.sol?.toFixed?.(4) ?? info?.sol ?? "?";
  const status = await getRpcStatus();
  const rpc = status?.best || status?.primary || "RPC";
  return `Wallet: ${info?.address || "?"}\nSOL: ${balance}\nRPC: ${rpc}`;
}

export function buildAutomationMenu(chatId) {
  const state = getUserState(chatId);
  const autoSnipeText = state.autoSnipeMode
    ? "🤖 Auto Snipe (ON)"
    : "🤖 Auto Snipe (OFF)";
  const afkText = state.afkMode ? "😴 AFK Mode (ON)" : "😴 AFK Mode (OFF)";
  const pumpText = state.pumpFunAlerts
    ? "🧪 Pump.fun Alerts (ON)"
    : "🧪 Pump.fun Alerts (OFF)";
  const prelpText = state.preLPWatchEnabled
    ? "🔬 Pre-LP Scanner (ON)"
    : "🔬 Pre-LP Scanner (OFF)";
  const deltaText = state.liqDeltaEnabled
    ? "📈 Delta Heuristic (ON)"
    : "📈 Delta Heuristic (OFF)";

  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: autoSnipeText, callback_data: "AUTO_SNIPE_TOGGLE" }],
        [{ text: afkText, callback_data: "AFK_MODE_TOGGLE" }],
        [{ text: pumpText, callback_data: "PUMPFUN_TOGGLE" }],
        [{ text: prelpText, callback_data: "PRELP_TOGGLE" }],
        [{ text: deltaText, callback_data: "DELTA_TOGGLE" }],
        [{ text: "⚙ Auto Snipe Config", callback_data: "AUTO_SNIPE_CONFIG" }],
        [{ text: "📊 Delta Settings", callback_data: "DELTA_SETTINGS" }],
        [{ text: "🔙 Back to Main", callback_data: "MAIN_MENU" }],
      ],
    },
  };
}

export function buildDeltaSettingsMenu(chatId) {
  const state = getUserState(chatId);
  const probe =
    state.liqDeltaProbeSol ?? Number(process.env.LIQ_DELTA_PROBE_SOL ?? 0.1);
  const minImprov =
    state.liqDeltaMinImprovPct ??
    Number(process.env.LIQ_DELTA_MIN_IMPROV_PCT ?? 0);
  const maxImpact =
    state.deltaMaxPriceImpactPct ??
    Number(process.env.DELTA_MAX_PRICE_IMPACT_PCT ?? 8);
  const minAgeMs =
    state.deltaMinRouteAgeMs ?? Number(process.env.DELTA_MIN_ROUTE_AGE_MS ?? 0);
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: `🔍 Probe Size: ${probe} SOL`,
            callback_data: "SET_DELTA_PROBE",
          },
        ],
        [
          {
            text: `📈 Min Improvement: ${minImprov}%`,
            callback_data: "SET_DELTA_IMPROV",
          },
        ],
        [
          {
            text: `🛑 Max Impact: ${maxImpact}%`,
            callback_data: "SET_DELTA_IMPACT",
          },
        ],
        [
          {
            text: `⏱ Min Route Age: ${minAgeMs} ms`,
            callback_data: "SET_DELTA_AGE",
          },
        ],
        [{ text: "🔙 Back", callback_data: "AUTOMATION" }],
      ],
    },
  };
}

export function buildSettingsMenu(chatId) {
  const state = getUserState(chatId);
  const stealthText = state.stealthMode
    ? "🥷 Stealth Mode (ON)"
    : "🥷 Stealth Mode (OFF)";

  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "💰 Priority Fee Config",
            callback_data: "PRIORITY_FEE_CONFIG",
          },
          { text: "🌐 RPC Configuration", callback_data: "RPC_CONFIG" },
        ],
        [
          { text: stealthText, callback_data: "STEALTH_MODE_TOGGLE" },
          { text: "⚡ Jito Settings", callback_data: "JITO_SETTINGS" },
        ],
        [{ text: "🎯 Slippage Settings", callback_data: "SLIPPAGE_CONFIG" }],
        [{ text: "🎯 Snipe Defaults", callback_data: "SNIPE_DEFAULTS" }],
        [{ text: "🔙 Back to Main", callback_data: "MAIN_MENU" }],
      ],
    },
  };
}

export function buildLPSniperMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🎯 New LP Snipe", callback_data: "NEW_LP_SNIPE" }],
        [{ text: "🔙 Back to Main", callback_data: "MAIN_MENU" }],
      ],
    },
  };
}

export function buildTradingToolsMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📊 Performance Stats", callback_data: "PERFORMANCE_STATS" }],
        [{ text: "🔙 Back to Main", callback_data: "MAIN_MENU" }],
      ],
    },
  };
}

export function buildPositionsMenu(chatId) {
  const state = getUserState(chatId);
  const hasPositions = state.positions.length > 0;

  const keyboard = [
    [{ text: "📈 View All Positions", callback_data: "VIEW_ALL_POSITIONS" }],
  ];

  if (hasPositions) {
    keyboard.push([
      { text: "💰 Quick Sell 25%", callback_data: "QUICK_SELL_25" },
      { text: "💰 Quick Sell 50%", callback_data: "QUICK_SELL_50" },
    ]);
    keyboard.push([
      { text: "💰 Quick Sell 100%", callback_data: "QUICK_SELL_100" },
    ]);
  }

  keyboard.push([{ text: "🔙 Back to Main", callback_data: "MAIN_MENU" }]);

  return { reply_markup: { inline_keyboard: keyboard } };
}

// Updated settings submenu
export function buildTurboSolSettingsMenu(chatId) {
  const state = getUserState(chatId);
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: `🎰 Degen Mode ${state.degenMode ? "ON" : "OFF"}`,
            callback_data: "TOGGLE_DEGEN",
          },
          {
            text: `🛡 Buy Protection ${state.buyProtection ? "ON" : "OFF"}`,
            callback_data: "TOGGLE_BUY_PROTECTION",
          },
        ],
        [
          {
            text: `🧠 Expert Mode ${state.expertMode ? "ON" : "OFF"}`,
            callback_data: "TOGGLE_EXPERT",
          },
          {
            text: `🕶 Private PNL ${state.privatePnl ? "ON" : "OFF"}`,
            callback_data: "TOGGLE_PNL",
          },
        ],
        [
          { text: "💼 Wallets", callback_data: "WALLETS_MENU" },
          { text: "⚙ Fee Settings", callback_data: "FEE_SETTINGS" },
        ],
        [{ text: "🌐 RPC Settings", callback_data: "RPC_SETTINGS" }],
        [{ text: "🎯 Snipe Defaults", callback_data: "SNIPE_DEFAULTS" }],
        [
          {
            text: `🔒 Private Relay ${state.enablePrivateRelay ? "ON" : "OFF"}`,
            callback_data: "TOGGLE_RELAY",
          },
        ],
        [
          {
            text: `📈 Behavior Profiling ${
              state.enableBehaviorProfiling ? "ON" : "OFF"
            }`,
            callback_data: "TOGGLE_BEHAVIOR",
          },
        ],
        [
          {
            text: `🕸 Multi-hop Correlation ${
              state.enableMultiHopCorrelation ? "ON" : "OFF"
            }`,
            callback_data: "TOGGLE_MULTIHOP",
          },
        ],
        [
          {
            text: `💰 Funding Path Analysis ${
              state.enableFundingPathAnalysis ? "ON" : "OFF"
            }`,
            callback_data: "TOGGLE_FUNDING",
          },
        ],
        [
          { text: "🔙 Back to Main", callback_data: "MAIN_MENU" },
          { text: "❌ Close", callback_data: "CLOSE_MENU" },
        ],
      ],
    },
  };
}

// New: Wallets management menu
export async function buildWalletsMenu(chatId) {
  const wallets = await listUserWallets(chatId);
  const state = getUserState(chatId);
  const multi = !!state.multiWalletMode;
  const selected = new Set(state.selectedWalletIds || []);

  const keyboard = [
    [
      { text: "➕ Create Wallet", callback_data: "CREATE_WALLET" },
      { text: "📥 Import Wallet", callback_data: "IMPORT_WALLET" },
    ],
  ];

  // Add existing wallets
  for (const wallet of wallets.slice(0, 8)) {
    // Limit to 8 wallets for UI
    const activeIndicator = wallet.active ? "✅ " : "";
    const selectIndicator = multi && selected.has(wallet.id) ? "☑️ " : "";
    const shortAddress =
      wallet.publicKey.slice(0, 6) + "..." + wallet.publicKey.slice(-4);
    keyboard.push([
      {
        text: `${selectIndicator}${activeIndicator}${wallet.name || shortAddress}`,
        callback_data: `WALLET_${wallet.id}`,
      },
    ]);
  }

  // Controls for multi-wallet selection
  keyboard.push([
    {
      text: multi ? "🟢 Multi-Wallet Mode: ON" : "⚪ Multi-Wallet Mode: OFF",
      callback_data: "MULTI_WALLET_TOGGLE",
    },
    { text: "🧹 Clear Selection", callback_data: "WALLET_CLEAR_SELECTION" },
  ]);

  keyboard.push([{ text: "🔙 Back to Main", callback_data: "MAIN_MENU" }]);

  return { reply_markup: { inline_keyboard: keyboard } };
}

export async function buildWalletDetailsMenu(chatId, walletId) {
  const wallets = await listUserWallets(chatId);
  const wallet = wallets.find((w) => w.id === walletId);
  if (!wallet) {
    return {
      reply_markup: {
        inline_keyboard: [[{ text: "🔙 Back", callback_data: "MAIN_MENU" }]],
      },
    };
  }

  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: wallet.active ? "✅ Active" : "⚪ Set Active",
            callback_data: `SET_ACTIVE_${wallet.id}`,
          },
          { text: "✏️ Rename", callback_data: `RENAME_${wallet.id}` },
        ],
        [{ text: "❌ Delete", callback_data: `DELETE_${wallet.id}` }],
        [{ text: "🔙 Back", callback_data: "MAIN_MENU" }],
      ],
    },
  };
}

export function buildSupportMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📨 Contact Support", callback_data: "CONTACT_SUPPORT" }],
        [{ text: "🔙 Back", callback_data: "MAIN_MENU" }],
      ],
    },
  };
}

export function buildSnipeDefaultsMenu(chatId) {
  const state = getUserState(chatId);
  const fee = state.maxSnipeGasPrice ?? 0;
  const defaultBuy = state.defaultBuySol ?? 0.05;
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: `⛽ Max Priority Fee: ${fee || "Auto"}`,
            callback_data: "SET_SNIPE_FEE",
          },
        ],
        [
          {
            text: `💵 Default Quick Buy: ${defaultBuy} SOL`,
            callback_data: "SET_DEFAULT_BUY",
          },
        ],
        [{ text: "🔙 Back to Main", callback_data: "MAIN_MENU" }],
      ],
    },
  };
}

export function buildRpcSettingsMenu(chatId) {
  const state = getUserState(chatId);
  const endpoints = state.rpcEndpoints || [];
  const current = state.currentRpcIndex ?? 0;
  const tip = state.priorityFeeLamports ?? "Auto";
  const vendor = state.relayVendor || getRelayVendor();
  const dyn = getDynamicPriorityFeeLamports();
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: `Current RPC: #${current + 1}`, callback_data: "RPC_NEXT" },
          { text: "🔁 Rotate", callback_data: "RPC_ROTATE" },
        ],
        [
          {
            text: `⛽ Global Priority Fee: ${tip}`,
            callback_data: "SET_PRIORITY_FEE",
          },
        ],
        [
          {
            text: `Jito Bundle: ${getUseJitoBundle() ? "ON" : "OFF"}`,
            callback_data: "JITO_SETTINGS",
          },
        ],
        [
          { text: `Relay: ${vendor}`, callback_data: "SET_RELAY_VENDOR" },
          {
            text: `Dynamic Tip: ${dyn ? "ON" : "OFF"}`,
            callback_data: "TOGGLE_DYNAMIC_TIP",
          },
        ],
        [{ text: "🔙 Back to Main", callback_data: "MAIN_MENU" }],
      ],
    },
  };
}

export function buildFeeSettingsMenu(chatId) {
  const state = getUserState(chatId);
  const tip = state.priorityFeeLamports ?? getPriorityFeeLamports();
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: `⛽ Global Priority Fee: ${tip}`,
            callback_data: "SET_PRIORITY_FEE",
          },
        ],
        [
          {
            text: `Use Jito Bundle: ${getUseJitoBundle() ? "ON" : "OFF"}`,
            callback_data: "JITO_SETTINGS",
          },
        ],
        [{ text: "🔙 Back to Main", callback_data: "MAIN_MENU" }],
      ],
    },
  };
}

// Copy Trade Menus
export function buildCopyTradeMenu(chatId) {
  const ct = getCopyTradeState(chatId);
  const enabled = ct?.enabled ? "ON" : "OFF";
  const wallets = Array.isArray(ct?.followedWallets) ? ct.followedWallets : [];
  const keyboard = [];

  keyboard.push([
    { text: `📡 Copy Trade: ${enabled}`, callback_data: "CT_ENABLE_TOGGLE" },
  ]);

  keyboard.push([{ text: "➕ Add Wallet", callback_data: "CT_ADD_WALLET" }]);

  // List wallets (limit to 8 for UI)
  for (const w of wallets.slice(0, 8)) {
    const label = (w.name && w.name.trim()) || shortenAddress(w.address);
    const status = w.enabled === false ? "⛔" : "✅";
    keyboard.push([
      { text: `${status} ${label}`, callback_data: `CT_W_${w.address}` },
      { text: "🗑", callback_data: `CT_RM_${w.address}` },
    ]);
  }

  keyboard.push([{ text: "🔙 Back to Main", callback_data: "MAIN_MENU" }]);

  return { reply_markup: { inline_keyboard: keyboard } };
}

export function buildCopyTradeWalletMenu(chatId, address) {
  const ct = getCopyTradeState(chatId);
  const w = (ct.followedWallets || []).find((x) => x.address === address);
  const isEnabled = w?.enabled !== false;
  const buyOn = w?.copyBuy !== false;
  const sellOn = w?.copySell !== false;

  const keyboard = [
    [
      {
        text: `${isEnabled ? "✅" : "⛔"} Wallet ${isEnabled ? "ON" : "OFF"}`,
        callback_data: `CT_W_ENABLE_TOGGLE_${address}`,
      },
    ],
    [
      {
        text: `🟢 Buy ${buyOn ? "ON" : "OFF"}`,
        callback_data: `CT_W_BUY_TOGGLE_${address}`,
      },
      {
        text: `🔴 Sell ${sellOn ? "ON" : "OFF"}`,
        callback_data: `CT_W_SELL_TOGGLE_${address}`,
      },
    ],
    [{ text: "🗑 Remove", callback_data: `CT_RM_${address}` }],
    [
      { text: "🔙 Back", callback_data: "CT_BACK" },
      { text: "🏠 Main", callback_data: "MAIN_MENU" },
    ],
  ];

  return { reply_markup: { inline_keyboard: keyboard } };
}
