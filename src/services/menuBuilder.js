import { getWalletInfo } from "./walletInfo.js";
import { getRpcStatus } from "./rpcMonitor.js";
import { getUserState } from "./userState.js";
import { listUserWallets } from "./userWallets.js";
import {
  getRelayVendor,
  getPriorityFeeLamports,
  getDynamicPriorityFeeLamports,
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
        [{ text: "🔙 Back to Trading Tools", callback_data: "TRADING_TOOLS" }],
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
          { text: "🔙 Back", callback_data: "MAIN_MENU" },
          { text: "❌ Close", callback_data: "CLOSE_MENU" },
        ],
      ],
    },
  };
}

// New: Wallets management menu
export async function buildWalletsMenu(chatId) {
  const wallets = await listUserWallets(chatId);

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
    const shortAddress =
      wallet.publicKey.slice(0, 6) + "..." + wallet.publicKey.slice(-4);
    keyboard.push([
      {
        text: `${activeIndicator}${wallet.name} (${shortAddress})`,
        callback_data: `WALLET_DETAILS_${wallet.id}`,
      },
    ]);
  }

  keyboard.push([{ text: "🔙 Back to Main", callback_data: "MAIN_MENU" }]);

  return {
    reply_markup: {
      inline_keyboard: keyboard,
    },
  };
}

// New: Individual wallet details menu
export async function buildWalletDetailsMenu(chatId, walletId) {
  const wallets = await listUserWallets(chatId);
  const wallet = wallets.find((w) => w.id === walletId);

  if (!wallet) {
    return {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Back to Wallets", callback_data: "WALLETS_MENU" }],
        ],
      },
    };
  }

  const keyboard = [];

  if (!wallet.active) {
    keyboard.push([
      { text: "✅ Set as Active", callback_data: `SET_ACTIVE_${walletId}` },
    ]);
  }

  keyboard.push([
    { text: "✏️ Rename", callback_data: `RENAME_WALLET_${walletId}` },
    { text: "📋 Copy Address", callback_data: `COPY_ADDRESS_${walletId}` },
  ]);

  keyboard.push([
    { text: "🗑 Delete", callback_data: `DELETE_WALLET_${walletId}` },
  ]);

  keyboard.push([
    { text: "🔙 Back to Wallets", callback_data: "WALLETS_MENU" },
  ]);

  return {
    reply_markup: {
      inline_keyboard: keyboard,
    },
  };
}

export function buildSupportMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📚 Guides & Docs", callback_data: "GUIDES_DOCS" },
          { text: "💬 Discord Support", callback_data: "DISCORD_SUPPORT" },
        ],
        [
          { text: "💡 Send Feedback", callback_data: "SEND_FEEDBACK" },
          { text: "🆘 Help", callback_data: "HELP" },
        ],
        [{ text: "🔙 Back to Main", callback_data: "MAIN_MENU" }],
      ],
    },
  };
}

// New: Build Snipe Defaults menu
export function buildSnipeDefaultsMenu(chatId) {
  const state = getUserState(chatId);
  const autoSnipeText = state.autoSnipeOnPaste
    ? "Auto-Snipe on Paste: ON"
    : "Auto-Snipe on Paste: OFF";
  const jitoText = state.enableJitoForSnipes
    ? "Jito for Snipes: ON"
    : "Jito for Snipes: OFF";
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: `Default Buy: ${state.defaultBuySol} SOL`,
            callback_data: "SET_DEFAULT_BUY",
          },
          {
            text: `Default Snipe: ${state.defaultSnipeSol} SOL`,
            callback_data: "SET_DEFAULT_SNIPE",
          },
        ],
        [
          {
            text: `Snipe Slippage: ${state.snipeSlippage} bps`,
            callback_data: "SET_SNIPE_SLIPPAGE",
          },
          {
            text: `Max Priority Fee: ${state.maxSnipeGasPrice || "auto"}`,
            callback_data: "SET_SNIPE_FEE",
          },
        ],
        [
          { text: autoSnipeText, callback_data: "TOGGLE_AUTO_SNIPE_PASTE" },
          { text: jitoText, callback_data: "TOGGLE_SNIPE_JITO" },
        ],
        [
          {
            text: `Poll Interval: ${state.snipePollInterval}ms`,
            callback_data: "SET_SNIPE_INTERVAL",
          },
          {
            text: `Retry Count: ${state.snipeRetryCount}`,
            callback_data: "SET_SNIPE_RETRY",
          },
        ],
        [{ text: "🔙 Back to Settings", callback_data: "SETTINGS" }],
      ],
    },
  };
}

export function buildRpcSettingsMenu(chatId) {
  const s = getUserState(chatId);
  const relayOn = s.enablePrivateRelay ? "ON" : "OFF";
  const strategy = (s.rpcStrategy || "balanced").toLowerCase();
  const vendor = (getRelayVendor?.() || "auto").toLowerCase();
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🔁 Rotate RPC", callback_data: "ROTATE_RPC" },
          { text: "➕ Add RPC", callback_data: "ADD_RPC" },
        ],
        [
          { text: "🔌 Set gRPC", callback_data: "SET_GRPC" },
          { text: "📋 List Endpoints", callback_data: "LIST_RPCS" },
        ],
        [
          {
            text: `Private Relay: ${relayOn}`.trim(),
            callback_data: "TOGGLE_RELAY",
          },
          {
            text: `Strategy: ${strategy}`,
            callback_data: "CYCLE_RPC_STRATEGY",
          },
        ],
        [
          {
            text: `Relay Vendor: ${vendor}`.trim(),
            callback_data: "CYCLE_RELAY_VENDOR",
          },
          { text: "🔐 Set Relay API Key", callback_data: "SET_RELAY_API_KEY" },
        ],
        [
          {
            text: "🌐 Set Relay Endpoint",
            callback_data: "SET_RELAY_ENDPOINT_URL",
          },
        ],
        [
          { text: "⬅️ Back", callback_data: "SETTINGS" },
          { text: "🏠 Main", callback_data: "MAIN_MENU" },
        ],
      ],
    },
  };
}

export function buildFeeSettingsMenu(chatId) {
  // chatId reserved for future per-chat fee scope; currently global
  const globalFee = getPriorityFeeLamports();
  const dynamic = getDynamicPriorityFeeLamports();
  const feeLabel = dynamic != null ? `${globalFee} (dynamic)` : `${globalFee}`;
  const rows = [
    [
      {
        text: `Global Priority Fee: ${feeLabel}`,
        callback_data: "SET_PRIORITY_FEE",
      },
    ],
  ];
  if (dynamic != null) {
    rows.push([
      { text: "Reset Tip Override", callback_data: "RESET_DYNAMIC_FEE" },
    ]);
  }
  rows.push([{ text: "🔙 Back to Settings", callback_data: "SETTINGS" }]);
  return {
    reply_markup: {
      inline_keyboard: rows,
    },
  };
}
