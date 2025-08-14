import { getWalletInfo } from "./walletInfo.js";
import { getRpcStatus } from "./rpcMonitor.js";
import { getUserState } from "./userState.js";

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
          { text: "⚙ Settings", callback_data: "SETTINGS" },
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

  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: autoSnipeText, callback_data: "AUTO_SNIPE_TOGGLE" }],
        [{ text: afkText, callback_data: "AFK_MODE_TOGGLE" }],
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
          { text: `🎰 Degen Mode ${state.degenMode ? 'ON' : 'OFF'}`, callback_data: 'TOGGLE_DEGEN' },
          { text: `🛡 Buy Protection ${state.buyProtection ? 'ON' : 'OFF'}`, callback_data: 'TOGGLE_BUY_PROTECTION' }
        ],
        [
          { text: `🧠 Expert Mode ${state.expertMode ? 'ON' : 'OFF'}`, callback_data: 'TOGGLE_EXPERT' },
          { text: `🕶 Private PNL ${state.privatePnl ? 'ON' : 'OFF'}`, callback_data: 'TOGGLE_PNL' }
        ],
        [
          { text: '⚙ Fee Settings', callback_data: 'FEE_SETTINGS' },
          { text: '🌐 RPC Settings', callback_data: 'RPC_SETTINGS' }
        ],
        [
          { text: '🔙 Back', callback_data: 'MAIN_MENU' },
          { text: '❌ Close', callback_data: 'CLOSE_MENU' }
        ]
      ]
    }
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
