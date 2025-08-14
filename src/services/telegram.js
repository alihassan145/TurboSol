import TelegramBot from "node-telegram-bot-api";
import { getPublicKey } from "./wallet.js";
import { getTokenQuote, performSwap } from "./trading/jupiter.js";
import {
  startLiquidityWatch,
  stopLiquidityWatch,
} from "./watchers/liquidityWatcher.js";
import {
  listRpcEndpoints,
  addRpcEndpoint,
  rotateRpc,
  setGrpcEndpoint,
} from "./rpc.js";
import {
  setPriorityFeeLamports,
  setUseJitoBundle,
  getPriorityFeeLamports,
  getUseJitoBundle,
} from "./config.js";
import { hasUserWallet, createUserWallet, importUserWallet, getUserPublicKey as getUserPk } from "./userWallets.js";
import { getWalletInfo, shortenAddress } from "./walletInfo.js";
import { buildTurboSolMainMenu, buildTurboSolSettingsMenu } from "./menuBuilder.js";
import { getUserState, updateUserSetting } from "./userState.js";

function parseFlags(parts) {
  const flags = {};
  for (const p of parts) {
    const [k, v] = p.split("=");
    if (!v) continue;
    if (k === "fee") flags.priorityFeeLamports = Number(v);
    if (k === "jito") flags.useJitoBundle = v === "1" || v === "true";
  }
  return flags;
}

let bot;

function buildMainMenu(chatId) {
  return {
    chat_id: chatId,
    text: "TurboSol Sniper — choose an action:",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Wallet", callback_data: "WALLET" },
          { text: "Quick Buy", callback_data: "QUICK_BUY" },
        ],
        [
          { text: "Snipe LP Add", callback_data: "SNIPE_LP" },
          { text: "Stop Snipe", callback_data: "STOP_SNIPE" },
        ],
        [
          { text: "Quote", callback_data: "QUOTE" },
          { text: "Help", callback_data: "HELP" },
        ],
      ],
    },
  };
}

async function buildBloomWelcomeMessage(chatId) {
  if (hasUserWallet(chatId)) {
    const info = await getWalletInfo(chatId);
    const timestamp = new Date().toLocaleTimeString('en-GB', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3
    });

    const balanceStatus = parseFloat(info.solBalance) === 0
      ? "🔴 You currently have no SOL in your wallet.\nTo start trading, please deposit SOL to your address."
      : "🟢 Your wallet is funded and ready for trading!";

    return `🌸 Welcome to Bloom!\n\nLet your trading journey blossom with us!\n\n🌸 Your Solana Wallet Address:\n\n→ W1: ${info.address}\nBalance: ${info.solBalance} SOL (USD $${info.usdBalance})\n\n${balanceStatus}\n\n📚 Resources:\n\n• 📖 Bloom Guides\n• 🔔 Bloom X  \n• 🌍 Bloom Website\n• 🤝 Bloom Portal\n• 🤖 Bloom Discord\n\n🇩🇪 EU1 • 🇺🇸 US1\n\n🕒 Last updated: ${timestamp}`;
  }
  return `🌸 Welcome to Bloom!\n\nLet your trading journey blossom with us!\n\n🔴 No wallet linked to your account.\n\nUse /setup to generate a new wallet or /import <privateKeyBase58> to import an existing one.\n\n📚 Resources:\n\n• 📖 Bloom Guides\n• 🔔 Bloom X  \n• 🌍 Bloom Website\n• 🤝 Bloom Portal\n• 🤖 Bloom Discord\n\n🇩🇪 EU1 • 🇺🇸 US1`;
}

export async function startTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

  bot = new TelegramBot(token, { polling: true });

  try {
    await bot.setMyCommands([
      { command: "start", description: "Initialize the bot" },
      { command: "setup", description: "Create new wallet" },
      { command: "import", description: "Import existing wallet" },
      { command: "address", description: "Show wallet address" }
    ]);
    console.log('Bot commands registered successfully');
  } catch (e) {
    console.error('Failed to set bot commands:', e);
  }

  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const welcomeMessage = await buildBloomWelcomeMessage(chatId);
      await bot.sendMessage(chatId, welcomeMessage);
      await bot.sendMessage(chatId, "Choose an option:", {
        reply_markup: buildTurboSolMainMenu(),
      });
    } catch (e) {
      await bot.sendMessage(chatId, `🌸 Welcome to Bloom!\n\nUse /setup to create a wallet or /import <privateKeyBase58>.`);
    }
  });

  // Setup a new wallet for this chat/user
  bot.onText(/\/setup/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      if (hasUserWallet(chatId)) {
        const pub = await getUserPk(chatId);
        return bot.sendMessage(chatId, `Wallet already exists: ${shortenAddress(pub)}\nUse /address to view.`);
      }
      const res = await createUserWallet(chatId);
      await bot.sendMessage(chatId, `New wallet created. Address: ${res.publicKey}\nFund with SOL to start trading. Keep your private key safe.`);
    } catch (e) {
      await bot.sendMessage(chatId, `Setup failed: ${e.message || e}`);
    }
  });

  // Import an existing wallet
  bot.onText(/\/import\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const key = (match?.[1] || "").trim();
    try {
      const pub = await importUserWallet(chatId, key);
      await bot.sendMessage(chatId, `Wallet imported: ${shortenAddress(pub)}`);
    } catch (e) {
      await bot.sendMessage(chatId, `Import failed: ${e.message || e}`);
    }
  });

  // Show wallet address
  bot.onText(/\/address/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      if (!hasUserWallet(chatId)) return bot.sendMessage(chatId, `No wallet linked. Use /setup or /import`);
      const pub = await getUserPk(chatId);
      await bot.sendMessage(chatId, `Wallet: ${pub}\nTap and hold to copy.`);
    } catch (e) {
      await bot.sendMessage(chatId, `Error: ${e.message || e}`);
    }
  });

  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;
    try {
      if (data === "REFRESH") {
        const welcome = await buildBloomWelcomeMessage(chatId);
        await bot.sendMessage(chatId, welcome);
        return bot.sendMessage(chatId, "Choose an option:", { reply_markup: buildTurboSolMainMenu() });
      }
      if (data === "CLOSE_MENU") {
        try { await bot.deleteMessage(chatId, messageId); } catch {}
        return; 
      }

      // Legacy handlers for existing features
      if (data === "WALLET") {
        if (hasUserWallet(chatId)) {
          const pub = await getUserPk(chatId);
          await bot.sendMessage(chatId, `Wallet: ${shortenAddress(pub)}\nUse /address to copy.`);
        } else {
          await bot.sendMessage(chatId, `No wallet linked. Use /setup to create or /import <privateKeyBase58>.`);
        }
      }
      if (data === "HELP") {
        await bot.sendMessage(
          chatId,
          "Use Quote to preview, Quick Buy to market buy via Jupiter, Snipe LP to auto-buy on first liquidity."
        );
      }
      if (data === "QUOTE") {
        await bot.sendMessage(
          chatId,
          "Send: quote <MINT> <amount SOL> (e.g., quote So11111111111111111111111111111111111111112 0.1)"
        );
      }
      if (data === "QUICK_BUY") {
        await bot.sendMessage(
          chatId,
          "Send: buy <MINT> <amount SOL> (e.g., buy 9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E 0.05)"
        );
      }
      if (data === "SNIPE_LP" || data === "LP_SNIPER") {
        await bot.sendMessage(chatId, "Send: snipe <MINT> <amount SOL>");
      }
      if (data === "STOP_SNIPE") {
        stopLiquidityWatch(chatId);
        await bot.sendMessage(chatId, "Stopped all snipes for this chat.");
      }

      // Remove SETTINGS from placeholders
      const placeholders = {
        POSITIONS: "📈 Positions dashboard coming soon.",
        COPY_TRADE: "🤖 Copy Trade setup coming soon.",
        TWITTER: "👥 Twitter integration coming soon.",
        AFK_MODE: "😴 AFK Mode toggle coming soon.",
        LIMIT_ORDERS: "📝 Limit Orders coming soon.",
        REFERRALS: "👥 Referrals coming soon.",
        WITHDRAW: "💸 Withdraw flow coming soon.",
        BRIDGE: "✈️ Bridge coming soon.",
        SUGGESTIONS: "💡 Send your suggestions here.",
      };
      if (placeholders[data]) {
        await bot.sendMessage(chatId, placeholders[data]);
      }
    } catch (e) {
      await bot.sendMessage(chatId, `Error: ${e.message || e}`);
    }
  });

  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = (msg.text || "").trim();
    try {
      if (text === "rpc list") {
        const list = listRpcEndpoints()
          .map((r) => `${r.active ? "*" : "-"} ${r.url}`)
          .join("\n");
        return bot.sendMessage(chatId, `RPCs:\n${list}`);
      }
      if (text.startsWith("rpc add ")) {
        const url = text.split(/\s+/)[2];
        addRpcEndpoint(url);
        const list = listRpcEndpoints()
          .map((r) => `${r.active ? "*" : "-"} ${r.url}`)
          .join("\n");
        return bot.sendMessage(chatId, `Added. RPCs:\n${list}`);
      }
      if (text === "rpc rotate") {
        rotateRpc("manual");
        const list = listRpcEndpoints()
          .map((r) => `${r.active ? "*" : "-"} ${r.url}`)
          .join("\n");
        return bot.sendMessage(chatId, `Rotated. RPCs:\n${list}`);
      }
      if (text.startsWith("grpc set ")) {
        const addr = text.split(/\s+/)[2];
        setGrpcEndpoint(addr);
        return bot.sendMessage(chatId, `gRPC endpoint set: ${addr}`);
      }
      if (text.startsWith("fee ")) {
        const lamports = Number(text.split(/\s+/)[1]);
        setPriorityFeeLamports(lamports);
        return bot.sendMessage(
          chatId,
          `Priority fee set: ${lamports || "auto"}`
        );
      }
      if (text === "jito on") {
        setUseJitoBundle(true);
        return bot.sendMessage(chatId, `Jito bundling: ON`);
      }
      if (text === "jito off") {
        setUseJitoBundle(false);
        return bot.sendMessage(chatId, `Jito bundling: OFF`);
      }
      if (text === "SETTINGS") {
        await bot.editMessageText("⚙️ Bloom Settings", {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: buildTurboSolSettingsMenu(chatId)
        });
      }
      if (text.startsWith("quote ")) {
        const [, mint, solStr] = text.split(/\s+/);
        const amountSol = parseFloat(solStr);
        if (!mint || !amountSol)
          return bot.sendMessage(chatId, "Usage: quote <MINT> <amount SOL>");
        const res = await getTokenQuote({
          inputMint: "So11111111111111111111111111111111111111112",
          outputMint: mint,
          amountSol,
        });
        if (!res) return bot.sendMessage(chatId, "No route");
        await bot.sendMessage(
          chatId,
          `Quote: out=${res.outAmountFormatted} ${res.outputSymbol} via ${res.routeName}, priceImpact=${res.priceImpactPct}%`
        );
      }
      if (text.startsWith("buy ")) {
        if (!hasUserWallet(chatId)) {
          return bot.sendMessage(chatId, `No wallet linked. Use /setup or /import to enable trading.`);
        }
        const parts = text.split(/\s+/);
        const [, mint, solStr, ...rest] = parts;
        const flags = parseFlags(rest);
        const amountSol = parseFloat(solStr);
        if (!mint || !amountSol)
          return bot.sendMessage(chatId, "Usage: buy <MINT> <amount SOL>");
        const { txid } = await performSwap({
          inputMint: "So11111111111111111111111111111111111111112",
          outputMint: mint,
          amountSol,
          chatId,
          ...flags,
        });
        await bot.sendMessage(chatId, `Swap sent: ${txid}`);
      }
      if (text.startsWith("snipe ")) {
        if (!hasUserWallet(chatId)) {
          return bot.sendMessage(chatId, `No wallet linked. Use /setup or /import to enable sniping.`);
        }
        const parts = text.split(/\s+/);
        const [, mint, solStr, ...rest] = parts;
        const flags = parseFlags(rest);
        const amountSol = parseFloat(solStr);
        if (!mint || !amountSol)
          return bot.sendMessage(chatId, "Usage: snipe <MINT> <amount SOL>");
        startLiquidityWatch(chatId, {
          mint,
          amountSol,
          ...flags,
          onEvent: async (evt) => {
            await bot.sendMessage(chatId, evt);
          },
        });
        await bot.sendMessage(chatId, `Watching LP/liquidity for ${mint}...`);
      }
      if (data === 'TOGGLE_DEGEN' || data === 'TOGGLE_BUY_PROTECTION' || data === 'TOGGLE_EXPERT' || data === 'TOGGLE_PNL') {
        updateUserSetting(chatId, data.toLowerCase(), !getUserState(chatId)[data.toLowerCase()]);
        await bot.editMessageReplyMarkup(buildBloomSettingsMenu(chatId).reply_markup, {
          chat_id: chatId,
          message_id: messageId
        });
      }
    } catch (e) {
      await bot.sendMessage(chatId, `Error: ${e.message || e}`);
    }
  });
}

export function getBotInstance() {
  return bot;
}
