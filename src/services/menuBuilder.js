import { getWalletInfo } from "./walletInfo.js";
import { getRpcStatus } from "./rpcMonitor.js";
import { getUserState } from "./userState.js";
import { listUserWallets } from "./userWallets.js";

export async function buildWalletStatusHeader(chatId) {
  const walletInfo = await getWalletInfo();
  const rpcStatus = await getRpcStatus();

  return `💼 **Wallet**: \`${walletInfo.shortAddress}\` 📋
💰 **Balance**: ${walletInfo.solBalance} SOL ($${walletInfo.usdBalance})
🌐 **RPC**: ${rpcStatus.display}

━━━━━━━━━━━━━━━━━━━━━`;
}

export function buildMainMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "💼 Wallet Info", callback_data: "WALLET_INFO" },
          { text: "🔄 Refresh", callback_data: "REFRESH_DATA" },
        ],
        [
          { text: "🎯 LP Sniper", callback_data: "LP_SNIPER" },
          { text: "🪝 Pre-LP Sniper", callback_data: "PRE_LP_SNIPER" },
        ],
        [
          { text: "🚀 Quick Snipe", callback_data: "QUICK_SNIPE" },
          { text: "📡 Mempool Monitor", callback_data: "MEMPOOL_MONITOR" },
        ],
        [
          { text: "🧠 AI Predict", callback_data: "AI_PREDICT" },
          { text: "🔍 Wallet Tracker", callback_data: "WALLET_TRACKER" },
        ],
        [
          { text: "🛡 Anti-Rug Mode", callback_data: "ANTI_RUG_TOGGLE" },
          { text: "📈 Positions", callback_data: "POSITIONS" },
        ],
        [
          { text: "🛠 Trading Tools", callback_data: "TRADING_TOOLS" },
          { text: "🤖 Automation", callback_data: "AUTOMATION" },
        ],
        [
          {
            text: "📚 Support & Resources",
            callback_data: "SUPPORT_RESOURCES",
          },
        ],
      ],
    },
  };
}

export function buildTradingToolsMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📝 Limit Orders", callback_data: "LIMIT_ORDERS" },
          { text: "🗂 Bundle Trades", callback_data: "BUNDLE_TRADES" },
        ],
        [
          { text: "📊 Performance Stats", callback_data: "PERFORMANCE_STATS" },
          { text: "⚙ ", callback_data: "SETTINGS" },
        ],
        [{ text: "🔙 Back to Main", callback_data: "MAIN_MENU" }],
      ],
    },
  };
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

  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: autoSnipeText, callback_data: "AUTO_SNIPE_TOGGLE" }],
        [{ text: afkText, callback_data: "AFK_MODE_TOGGLE" }],
        [{ text: pumpText, callback_data: "PUMPFUN_TOGGLE" }],
        [{ text: "⚙ Auto Snipe Config", callback_data: "AUTO_SNIPE_CONFIG" }],
        [{ text: "🔙 Back to Main", callback_data: "MAIN_MENU" }],
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
        [
          { text: "🎯 New LP Snipe", callback_data: "NEW_LP_SNIPE" },
          { text: "📋 Active Snipes", callback_data: "ACTIVE_SNIPES" },
        ],
        [
          { text: "⚙ Snipe Settings", callback_data: "SNIPE_SETTINGS" },
          { text: "📊 Snipe History", callback_data: "SNIPE_HISTORY" },
        ],
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

// New: Bloom-style main menu matching the provided design
export function buildTurboSolMainMenu() {
  return {
    inline_keyboard: [
      [
        { text: "💼 Positions", callback_data: "POSITIONS" },
        { text: "🎯 LP Sniper", callback_data: "LP_SNIPER" },
      ],
      [
        { text: "🤖 Copy Trade", callback_data: "COPY_TRADE" },
        { text: "💸 Withdraw", callback_data: "WITHDRAW" },
      ],
      [
        { text: "📝 Limit Orders", callback_data: "LIMIT_ORDERS" },
        { text: "⚙️ Settings", callback_data: "SETTINGS" },
      ],
      [
        { text: "💡 Suggestions", callback_data: "SUGGESTIONS" },
        { text: "🔄 Refresh", callback_data: "REFRESH" },
      ],
    ],
  };
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
  const autoPasteText = state.autoSnipeOnPaste
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
          { text: autoPasteText, callback_data: "TOGGLE_AUTO_SNIPE_PASTE" },
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
  const state = getUserState(chatId);
  const relayText = `🔒 Private Relay ${
    state.enablePrivateRelay ? "ON" : "OFF"
  }`;
  const strategyLabel = (state.rpcStrategy || "balanced").toUpperCase();
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🔄 Rotate RPC", callback_data: "ROTATE_RPC" },
          { text: "➕ Add RPC", callback_data: "ADD_RPC" },
        ],
        [
          { text: "📡 Set gRPC", callback_data: "SET_GRPC" },
          { text: "📃 List Endpoints", callback_data: "LIST_RPCS" },
        ],
        [
          { text: relayText, callback_data: "TOGGLE_RELAY" },
          {
            text: `⚙️ Strategy: ${strategyLabel}`,
            callback_data: "CYCLE_RPC_STRATEGY",
          },
        ],
        [
          { text: "🔙 Back", callback_data: "SETTINGS" },
          { text: "🏠 Main", callback_data: "MAIN_MENU" },
        ],
      ],
    },
  };
}
