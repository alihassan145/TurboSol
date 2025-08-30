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
  getAllRpcEndpoints,
} from "./rpc.js";
import {
  setPriorityFeeLamports,
  setUseJitoBundle,
  getPriorityFeeLamports,
  getUseJitoBundle,
} from "./config.js";
import {
  hasUserWallet,
  createUserWallet,
  importUserWallet,
  getUserPublicKey as getUserPk,
  listUserWallets,
  setActiveWallet,
  renameUserWallet,
} from "./userWallets.js";
import { getWalletInfo, shortenAddress } from "./walletInfo.js";
import {
  buildTurboSolMainMenu,
  buildTurboSolSettingsMenu,
  buildPositionsMenu,
  buildWalletsMenu,
  buildWalletDetailsMenu,
  buildSnipeDefaultsMenu,
  buildTradingToolsMenu,
} from "./menuBuilder.js";
import {
  getUserState,
  updateUserSetting,
  setPendingInput,
} from "./userState.js";
import { PublicKey } from "@solana/web3.js";
import { riskCheckToken } from "./risk.js";
import { startStopLoss, stopStopLoss } from "./watchers/stopLossWatcher.js";
import {
  startPumpFunListener,
  stopPumpFunListener,
} from "./watchers/pumpfunWatcher.js";
import {
  addDevWalletToMonitor,
  startDevWalletMonitor,
  stopDevWalletMonitor,
} from "./watchers/devWalletMonitor.js";
import {
  startMempoolWatch,
  stopMempoolWatch,
} from "./watchers/mempoolWatcher.js";
import { measureEndpointsLatency } from "./rpcMonitor.js";

function parseFlags(parts) {
  const flags = {};
  for (const p of parts) {
    const [k, v] = p.split("=");
    if (!v) continue;
    if (k === "fee") flags.priorityFeeLamports = Number(v);
    if (k === "jito") flags.useJitoBundle = v === "1" || v === "true";
    if (k === "relay") flags.usePrivateRelay = v === "1" || v === "true";
    if (k === "split") flags.splitAcrossWallets = v === "1" || v === "true";
    if (k === "wallets") flags.walletsCount = Math.max(1, Number(v));
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
          { text: "Wallet", callback_data: "WALLETS_MENU" },
          { text: "Quick Buy", callback_data: "QUICK_BUY" },
        ],
        [
          { text: "Snipe LP Add", callback_data: "SNIPE_LP" },
          { text: "Stop Snipe", callback_data: "STOP_SNIPE" },
        ],
        [
          { text: "Quote", callback_data: "QUOTE" },
          { text: "⚙️ Settings", callback_data: "SETTINGS" },
        ],
        [{ text: "Help", callback_data: "HELP" }],
      ],
    },
  };
}

async function buildTurboSolWelcomeMessage(chatId) {
  if (await hasUserWallet(chatId)) {
    const info = await getWalletInfo(chatId);
    const timestamp = new Date().toLocaleTimeString("en-GB", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
    });

    const balanceStatus =
      parseFloat(info.solBalance) === 0
        ? "🔴 You currently have no SOL in your wallet.\nTo start trading, please deposit SOL to your address."
        : "🟢 Your wallet is funded and ready for trading!";

    return `🚀 Welcome to TurboSol!\n\nYour Solana Wallet:\n\n→ W1: ${info.address}\nBalance: ${info.solBalance} SOL (USD $${info.usdBalance})\n\n${balanceStatus}\n\n🕒 Last updated: ${timestamp}`;
  }
  return `🚀 Welcome to TurboSol!\n\n🔴 No wallet linked to your account.\n\nUse /setup to generate a new wallet or /import <privateKeyBase58> to import an existing one.`;
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
      { command: "address", description: "Show wallet address" },
    ]);
    console.log("Bot commands registered successfully");
  } catch (e) {
    console.error("Failed to set bot commands:", e);
  }

  bot.onText(/\/[sS]tart/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const welcomeMessage = await buildTurboSolWelcomeMessage(chatId);
      await bot.sendMessage(chatId, welcomeMessage);
      await bot.sendMessage(chatId, "Choose an option:", {
        reply_markup: buildMainMenu(chatId).reply_markup,
      });
    } catch (e) {
      await bot.sendMessage(
        chatId,
        `🚀 Welcome to TurboSol!\n\nUse /setup to create a wallet or /import <privateKeyBase58>.`
      );
    }
  });

  // Setup a new wallet for this chat/user
  bot.onText(/\/setup/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      if (await hasUserWallet(chatId)) {
        const pub = await getUserPk(chatId);
        return bot.sendMessage(
          chatId,
          `Wallet already exists: ${shortenAddress(pub)}\nUse /address to view.`
        );
      }
      const res = await createUserWallet(chatId);
      await bot.sendMessage(
        chatId,
        `New wallet created. Address: ${res.publicKey}\nFund with SOL to start trading. Keep your private key safe.`
      );
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
      if (!(await hasUserWallet(chatId)))
        return bot.sendMessage(
          chatId,
          `No wallet linked. Use /setup or /import`
        );
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
        const welcome = await buildTurboSolWelcomeMessage(chatId);
        await bot.sendMessage(chatId, welcome);
        return bot.sendMessage(chatId, "Choose an option:", {
          reply_markup: buildTurboSolMainMenu(),
        });
      }
      if (data === "CLOSE_MENU") {
        try {
          await bot.deleteMessage(chatId, messageId);
        } catch {}
        return;
      }

      if (data === "STOP_SNIPE") {
        stopLiquidityWatch(chatId);
        await bot.answerCallbackQuery(query.id, { text: "Stopped sniping" });
        await bot.sendMessage(
          chatId,
          "Stopped all active liquidity watches for this chat."
        );
        return;
      }

      if (data === "QUICK_BUY") {
        try {
          await bot.answerCallbackQuery(query.id, { text: "Quick Buy" });
          if (!(await hasUserWallet(chatId))) {
            await bot.sendMessage(
              chatId,
              "❌ No wallet linked. Use /setup to create or /import <privateKeyBase58> to import an existing wallet."
            );
            return;
          }
          setPendingInput(chatId, { type: "QUICK_BUY_TOKEN" });
          await bot.sendMessage(
            chatId,
            "💰 Quick Buy\n\nPlease send the token address (mint) you want to buy:"
          );
        } catch (e) {
          await bot.sendMessage(chatId, `Quick Buy failed: ${e?.message || e}`);
        }
        return;
      }

      if (data === "SNIPE_LP") {
        try {
          await bot.answerCallbackQuery(query.id, { text: "Snipe LP Add" });
          if (!(await hasUserWallet(chatId))) {
            await bot.sendMessage(
              chatId,
              "❌ No wallet linked. Use /setup to create or /import <privateKeyBase58> to import an existing wallet."
            );
            return;
          }
          setPendingInput(chatId, { type: "SNIPE_LP_TOKEN" });
          await bot.sendMessage(
            chatId,
            "🎯 Snipe LP Add\n\nPlease send the token address (mint) you want to snipe:"
          );
        } catch (e) {
          await bot.sendMessage(
            chatId,
            `Snipe LP Add failed: ${e?.message || e}`
          );
        }
        return;
      }

      if (data === "QUOTE") {
        try {
          await bot.answerCallbackQuery(query.id, { text: "Quote" });
          if (!(await hasUserWallet(chatId))) {
            await bot.sendMessage(
              chatId,
              "❌ No wallet linked. Use /setup to create or /import <privateKeyBase58> to import an existing wallet."
            );
            return;
          }
          setPendingInput(chatId, { type: "QUOTE_TOKEN" });
          await bot.sendMessage(
            chatId,
            "💰 Quote Token\n\nPlease send the token address (mint) you want to quote:"
          );
        } catch (e) {
          await bot.sendMessage(chatId, `Quote failed: ${e?.message || e}`);
        }
        return;
      }

      if (data === "HELP") {
        try {
          await bot.answerCallbackQuery(query.id, { text: "Help" });
          const helpText = `🚀 **TurboSol Help**\n\n**Main Commands:**\n• /start - Initialize the bot\n• /setup - Create new wallet\n• /import <privateKey> - Import existing wallet\n• /address - Show wallet address\n\n**Quick Actions:**\n• **Wallet** - Manage your wallets\n• **Quick Buy** - Buy tokens with default settings\n• **Snipe LP Add** - Snipe tokens when liquidity is added\n• **Quote** - Get token price quotes\n\n**Text Commands:**\n• Send token address to get buy/snipe options\n• \`quote <mint> <sol_amount>\` - Get price quote\n• \`buy <mint> <sol_amount>\` - Buy tokens\n• \`snipe <mint> <sol_amount>\` - Start sniping\n\n**Settings:**\n• \`fee <lamports>\` - Set priority fee\n• \`jito on/off\` - Toggle Jito bundling\n• \`tier\` - View current tier and limits\n\nFor more help, contact support.`;
          await bot.sendMessage(chatId, helpText, { parse_mode: "Markdown" });
        } catch (e) {
          await bot.sendMessage(chatId, `Help failed: ${e?.message || e}`);
        }
        return;
      }

      // Handle auto-detected token actions
      if (data.startsWith("AUTO_QUOTE_")) {
        const rest = data.slice("AUTO_QUOTE_".length);
        const [mint, amtStr] = rest.split("_");
        const amountSol = parseFloat(amtStr);
        const res = await getTokenQuote({
          inputMint: "So11111111111111111111111111111111111111112",
          outputMint: mint,
          amountSol,
        });
        if (!res || !res.outAmountFormatted)
          return bot.answerCallbackQuery(query.id, { text: "Quote failed" });
        await bot.sendMessage(
          chatId,
          `Quote for ${amountSol} SOL -> ${mint}: ${res.outAmountFormatted} tokens (impact ${res.priceImpactPct}%)`
        );
        return;
      }

      if (data.startsWith("AUTO_BUY_")) {
        const rest = data.slice("AUTO_BUY_".length);
        const [mint, amtStr] = rest.split("_");
        const amountSol = parseFloat(amtStr);
        if (!(await hasUserWallet(chatId))) {
          await bot.answerCallbackQuery(query.id, { text: "No wallet linked" });
          await bot.sendMessage(
            chatId,
            `No wallet linked. Use /setup to create or /import <privateKeyBase58>.`
          );
          return;
        }
        // Optional risk check gate
        try {
          const requireLpLock =
            String(process.env.REQUIRE_LP_LOCK || "").toLowerCase() ===
              "true" || process.env.REQUIRE_LP_LOCK === "1";
          const maxBuyTaxBps = Number(process.env.MAX_BUY_TAX_BPS || 1500);
          const risk = await riskCheckToken(mint, {
            requireLpLock,
            maxBuyTaxBps,
          });
          if (!risk.ok) {
            await bot.answerCallbackQuery(query.id, {
              text: "Blocked by risk checks",
            });
            await bot.sendMessage(
              chatId,
              `🚫 Trade blocked: ${risk.reasons?.join("; ")}`
            );
            return;
          }
        } catch {}
        const { txid } = await performSwap({
          inputMint: "So11111111111111111111111111111111111111112",
          outputMint: mint,
          amountSol,
          chatId,
        });
        await bot.sendMessage(chatId, `Buy sent. Tx: ${txid}`);
        return;
      }

      if (data.startsWith("AUTO_SNIPE_")) {
        const rest = data.slice("AUTO_SNIPE_".length);
        const [mint, amtStr] = rest.split("_");
        const amountSol = parseFloat(amtStr);
        if (!(await hasUserWallet(chatId))) {
          await bot.answerCallbackQuery(query.id, { text: "No wallet linked" });
          await bot.sendMessage(
            chatId,
            `No wallet linked. Use /setup to create or /import <privateKeyBase58>.`
          );
          return;
        }
        const s = getUserState(chatId);
        const priorityFeeLamports =
          s.maxSnipeGasPrice ?? getPriorityFeeLamports();
        const useJitoBundle = s.enableJitoForSnipes ?? getUseJitoBundle();
        const pollInterval = s.snipePollInterval;
        const slippageBps = s.snipeSlippage;
        const retryCount = s.snipeRetryCount;
        startLiquidityWatch(chatId, {
          mint,
          amountSol,
          priorityFeeLamports,
          useJitoBundle,
          pollInterval,
          slippageBps,
          retryCount,
          onEvent: (m) => bot.sendMessage(chatId, m),
        });
        await bot.sendMessage(
          chatId,
          `Watching for LP on ${mint}. Will buy ${amountSol} SOL when detected.`
        );
        return;
      }

      if (data.startsWith("DISMISS_")) {
        try {
          await bot.deleteMessage(chatId, messageId);
        } catch {}
        return;
      }

      // Settings submenu handling via callback
      if (data === "SETTINGS") {
        await bot.editMessageText("⚙️ TurboSol Settings", {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: buildTurboSolSettingsMenu(chatId).reply_markup,
        });
        return;
      }

      if (data === "TRADING_TOOLS") {
        await bot.editMessageText("🛠 Trading Tools", {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: buildTradingToolsMenu().reply_markup,
        });
        return;
      }

      if (data === "MAIN_MENU") {
        await bot.editMessageText("🏠 Main Menu", {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: buildTurboSolMainMenu(),
        });
        return;
      }

      if (data === "SNIPE_DEFAULTS") {
        await bot.editMessageText("🎯 Snipe Defaults", {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: buildSnipeDefaultsMenu(chatId).reply_markup,
        });
        return;
      }

      if (data === "WALLETS_MENU") {
        console.log(
          `[DEBUG] WALLETS_MENU callback received for chatId: ${chatId}`
        );
        try {
          await bot.answerCallbackQuery(query.id, {
            text: "Opening Wallets...",
          });
        } catch {}
        try {
          console.log(`[DEBUG] Building wallets menu for chatId: ${chatId}`);
          const menu = await buildWalletsMenu(chatId);
          console.log(
            `[DEBUG] Menu built successfully:`,
            JSON.stringify(menu, null, 2)
          );
          await bot.editMessageText("💼 Wallets — manage your wallets", {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: menu.reply_markup,
          });
          console.log(`[DEBUG] Message edited successfully`);
        } catch (e) {
          console.log(
            `[DEBUG] Edit failed, trying sendMessage. Error:`,
            e.message
          );
          try {
            const menu = await buildWalletsMenu(chatId);
            await bot.sendMessage(chatId, "💼 Wallets — manage your wallets", {
              reply_markup: menu.reply_markup,
            });
            console.log(`[DEBUG] New message sent successfully`);
          } catch (fallbackError) {
            console.log(`[DEBUG] Fallback also failed:`, fallbackError.message);
            await bot.sendMessage(
              chatId,
              `Failed to open Wallets: ${(e?.message || e)
                .toString()
                .slice(0, 200)}`
            );
          }
        }
        return;
      }

      if (data === "CREATE_WALLET") {
        try {
          const res = await createUserWallet(chatId);
          await bot.answerCallbackQuery(query.id, { text: "Wallet created" });
        } catch (e) {
          const msg = e?.message || String(e);
          await bot.answerCallbackQuery(query.id, { text: msg.slice(0, 200) });
          await bot.sendMessage(chatId, `Create wallet failed: ${msg}`);
        }
        const menu = await buildWalletsMenu(chatId);
        await bot.editMessageReplyMarkup(menu.reply_markup, {
          chat_id: chatId,
          message_id: messageId,
        });
        return;
      }

      if (data === "IMPORT_WALLET") {
        setPendingInput(chatId, { type: "IMPORT_WALLET" });
        try {
          await bot.answerCallbackQuery(query.id, {
            text: "Awaiting private key…",
          });
        } catch {}
        await bot.sendMessage(
          chatId,
          "Send your private key in Base58 to import your wallet.\nWarning: Only share with trusted bots. You can revoke access anytime."
        );
        return;
      }

      if (data.startsWith("WALLET_DETAILS_")) {
        try {
          await bot.answerCallbackQuery(query.id, { text: "Wallet details" });
        } catch {}
        const walletId = data.replace("WALLET_DETAILS_", "");
        try {
          const details = await buildWalletDetailsMenu(chatId, walletId);
          await bot.editMessageText("💼 Wallet Details", {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: details.reply_markup,
          });
        } catch (e) {
          try {
            const details = await buildWalletDetailsMenu(chatId, walletId);
            await bot.sendMessage(chatId, "💼 Wallet Details", {
              reply_markup: details.reply_markup,
            });
          } catch (_) {
            await bot.sendMessage(
              chatId,
              `Failed to open wallet details: ${(e?.message || e)
                .toString()
                .slice(0, 200)}`
            );
          }
        }
        return;
      }

      if (data.startsWith("SET_ACTIVE_")) {
        const walletId = data.replace("SET_ACTIVE_", "");
        try {
          await setActiveWallet(chatId, walletId);
          try {
            await bot.answerCallbackQuery(query.id, {
              text: "Active wallet set",
            });
          } catch {}
          const details = await buildWalletDetailsMenu(chatId, walletId);
          await bot.editMessageReplyMarkup(details.reply_markup, {
            chat_id: chatId,
            message_id: messageId,
          });
        } catch (e) {
          await bot.sendMessage(
            chatId,
            `Failed to set active wallet: ${e?.message || e}`
          );
        }
        return;
      }

      if (data.startsWith("RENAME_WALLET_")) {
        const walletId = data.replace("RENAME_WALLET_", "");
        setPendingInput(chatId, { type: "RENAME_WALLET", walletId });
        try {
          await bot.answerCallbackQuery(query.id, { text: "Send a new name…" });
        } catch {}
        await bot.sendMessage(chatId, "Enter a new name for this wallet:");
        return;
      }

      if (data.startsWith("COPY_ADDRESS_")) {
        const walletId = data.replace("COPY_ADDRESS_", "");
        const wallets = await listUserWallets(chatId);
        const w = wallets.find((x) => x.id === walletId);
        if (w) {
          try {
            await bot.answerCallbackQuery(query.id, { text: "Address sent" });
          } catch {}
          await bot.sendMessage(chatId, `Address: ${w.publicKey}`);
        }
        return;
      }

      if (data.startsWith("DELETE_WALLET_")) {
        // For safety, we will not permanently delete yet; could implement soft delete
        await bot.answerCallbackQuery(query.id, {
          text: "Delete not implemented yet",
        });
        return;
      }

      // TurboSol Positions view
      if (data === "POSITIONS") {
        const state = getUserState(chatId);
        const hasPositions = (state.positions || []).length > 0;
        const body = hasPositions
          ? "You have open positions. Tap 'View All Positions' to see details."
          : "No open positions yet!\nStart your trading journey by pasting a contract address in chat.";
        await bot.editMessageText(`🚀 TurboSol Positions\n\n${body}`, {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: buildPositionsMenu(chatId).reply_markup,
        });
        return;
      }

      if (data === "VIEW_ALL_POSITIONS") {
        const state = getUserState(chatId);
        const list = state.positions || [];
        if (!list.length) {
          await bot.answerCallbackQuery(query.id, { text: "No positions" });
          return;
        }
        const lines = list
          .map((p, i) => {
            const t = new Date(p.timestamp).toLocaleString();
            const mintShort = shortenAddress ? shortenAddress(p.mint) : p.mint;
            const tokOut =
              typeof p.tokensOut === "number"
                ? Number(p.tokensOut).toFixed(4)
                : "?";
            const txShort = p.txid
              ? p.txid.slice(0, 8) + "…" + p.txid.slice(-8)
              : "";
            return `${i + 1}. ${p.symbol || "TOKEN"} (${mintShort}) — ${
              p.solIn
            } SOL -> ~${tokOut}  [${t}] ${txShort}`;
          })
          .join("\n");
        await bot.editMessageText(`📈 Open Positions\n\n${lines}`, {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔙 Back", callback_data: "POSITIONS" }],
              [{ text: "🏠 Main", callback_data: "MAIN_MENU" }],
            ],
          },
        });
        return;
      }

      // Performance stats view
      if (data === "PERFORMANCE_STATS") {
        const state = getUserState(chatId);
        const trades = state.trades || [];
        if (!trades.length) {
          await bot.answerCallbackQuery(query.id, { text: "No trades yet" });
          await bot.sendMessage(
            chatId,
            "No trades logged yet. Start trading to build performance history."
          );
          return;
        }
        let buySol = 0,
          sellSol = 0;
        const byMint = new Map();
        for (const t of trades) {
          if (t.kind === "buy") {
            const s = Number(t.sol || 0);
            buySol += s;
            const m = byMint.get(t.mint) || { buy: 0, sell: 0 };
            m.buy += s;
            byMint.set(t.mint, m);
          } else if (t.kind === "sell") {
            const sOut = Number(t.solOut || t.sol || 0);
            sellSol += sOut;
            const m = byMint.get(t.mint) || { buy: 0, sell: 0 };
            m.sell += sOut;
            byMint.set(t.mint, m);
          }
        }
        const pnl = sellSol - buySol;
        let wins = 0,
          losses = 0;
        for (const [, v] of byMint) {
          if (v.sell > 0) {
            if (v.sell > v.buy) wins++;
            else losses++;
          }
        }
        const total = wins + losses;
        const winRate = total ? Math.round((wins / total) * 100) : 0;
        const sign = pnl >= 0 ? "🟢" : "🔴";
        const msg = [
          `📊 Performance Stats — All Time`,
          `Trades: ${trades.length}`,
          `Buys: ${buySol.toFixed(4)} SOL`,
          `Sells: ${sellSol.toFixed(4)} SOL`,
          `${sign} P&L: ${pnl.toFixed(4)} SOL`,
          `Win-rate: ${winRate}% (${wins}/${total})`,
        ].join("\n");
        await bot.sendMessage(chatId, msg);
        await bot.answerCallbackQuery(query.id, { text: "Stats sent" });
        return;
      }

      // Toggle handlers for settings
      if (
        [
          "TOGGLE_DEGEN",
          "TOGGLE_BUY_PROTECTION",
          "TOGGLE_EXPERT",
          "TOGGLE_PNL",
          "TOGGLE_RELAY",
          "TOGGLE_TIER",
        ].includes(data)
      ) {
        if (data === "TOGGLE_TIER") {
          const order = ["basic", "plus", "pro"];
          const cur = (getUserState(chatId).tier || "basic").toLowerCase();
          const idx = order.indexOf(cur);
          const next = order[(idx + 1) % order.length];
          updateUserSetting(chatId, "tier", next);
          await bot.editMessageReplyMarkup(
            buildTurboSolSettingsMenu(chatId).reply_markup,
            {
              chat_id: chatId,
              message_id: messageId,
            }
          );
          return;
        }
        const keyMap = {
          TOGGLE_DEGEN: "degenMode",
          TOGGLE_BUY_PROTECTION: "buyProtection",
          TOGGLE_EXPERT: "expertMode",
          TOGGLE_PNL: "privatePnl",
          TOGGLE_RELAY: "enablePrivateRelay",
        };
        const key = keyMap[data];
        const current = getUserState(chatId)[key];
        updateUserSetting(chatId, key, !current);
        await bot.editMessageReplyMarkup(
          buildTurboSolSettingsMenu(chatId).reply_markup,
          {
            chat_id: chatId,
            message_id: messageId,
          }
        );
        return;
      }

      // Snipe Defaults toggles
      if (["TOGGLE_AUTO_SNIPE_PASTE", "TOGGLE_SNIPE_JITO"].includes(data)) {
        const keyMap = {
          TOGGLE_AUTO_SNIPE_PASTE: "autoSnipeOnPaste",
          TOGGLE_SNIPE_JITO: "enableJitoForSnipes",
        };
        const key = keyMap[data];
        const current = getUserState(chatId)[key];
        updateUserSetting(chatId, key, !current);
        await bot.editMessageReplyMarkup(
          buildSnipeDefaultsMenu(chatId).reply_markup,
          {
            chat_id: chatId,
            message_id: messageId,
          }
        );
        return;
      }

      // Snipe Defaults numeric inputs
      if (
        [
          "SET_DEFAULT_BUY",
          "SET_DEFAULT_SNIPE",
          "SET_SNIPE_SLIPPAGE",
          "SET_SNIPE_FEE",
          "SET_SNIPE_INTERVAL",
          "SET_SNIPE_RETRY",
        ].includes(data)
      ) {
        const promptMap = {
          SET_DEFAULT_BUY: "Send new default Buy amount in SOL (e.g., 0.05)",
          SET_DEFAULT_SNIPE:
            "Send new default Snipe amount in SOL (e.g., 0.05)",
          SET_SNIPE_SLIPPAGE: "Send snipe slippage in bps (e.g., 100 for 1%)",
          SET_SNIPE_FEE:
            "Send max priority fee lamports for snipes (or 0 for auto)",
          SET_SNIPE_INTERVAL: "Send snipe poll interval in ms (e.g., 2000)",
          SET_SNIPE_RETRY: "Send retry count for snipe failures (e.g., 3)",
        };
        const type = data;
        setPendingInput(chatId, { type, data: { messageId } });
        await bot.sendMessage(chatId, promptMap[type]);
        return;
      }
    } catch (e) {
      console.error("Callback query error:", e);
      await bot.answerCallbackQuery(query.id, { text: "Error occurred" });
    }
  });

  // Handle text messages
  bot.on("message", async (msg) => {
    const text = msg.text;
    const chatId = msg.chat.id;

    if (!text || text.startsWith("/")) return; // Skip commands and non-text

    try {
      const state = getUserState(chatId);

      // Handle pending inputs first
      if (state.pendingInput?.type === "IMPORT_WALLET") {
        try {
          const pub = await importUserWallet(chatId, text.trim());
          await bot.sendMessage(
            chatId,
            `Wallet imported: ${shortenAddress(pub)}`
          );
        } catch (e) {
          await bot.sendMessage(chatId, `Import failed: ${e.message || e}`);
        }
        setPendingInput(chatId, null);
        return;
      }

      if (state.pendingInput?.type === "RENAME_WALLET") {
        try {
          const { walletId } = state.pendingInput;
          await renameUserWallet(chatId, walletId, text.slice(0, 24));
          await bot.sendMessage(
            chatId,
            `Wallet renamed to: ${text.slice(0, 24)}`
          );
        } catch (e) {
          await bot.sendMessage(chatId, `Rename failed: ${e.message || e}`);
        }
        setPendingInput(chatId, null);
        return;
      }

      // Handle Quick Buy token input
      if (state.pendingInput?.type === "QUICK_BUY_TOKEN") {
        try {
          const normalizedMint = new PublicKey(text.trim()).toBase58();
          setPendingInput(chatId, {
            type: "QUICK_BUY_AMOUNT",
            tokenAddress: normalizedMint,
          });
          const defaultBuy = state.defaultBuySol ?? 0.05;
          await bot.sendMessage(
            chatId,
            `💰 Quick Buy - ${normalizedMint}\n\nPlease enter the amount in SOL you want to buy (default: ${defaultBuy} SOL):`
          );
        } catch (e) {
          await bot.sendMessage(
            chatId,
            "❌ Invalid token address. Please send a valid Solana token address."
          );
        }
        return;
      }

      // Handle Quick Buy amount input
      if (state.pendingInput?.type === "QUICK_BUY_AMOUNT") {
        try {
          const { tokenAddress } = state.pendingInput;
          const amountSol =
            parseFloat(text.trim()) || (state.defaultBuySol ?? 0.05);
          if (amountSol <= 0) {
            await bot.sendMessage(
              chatId,
              "❌ Invalid amount. Please enter a positive number."
            );
            return;
          }
          // Risk check
          try {
            const requireLpLock =
              String(process.env.REQUIRE_LP_LOCK || "").toLowerCase() ===
                "true" || process.env.REQUIRE_LP_LOCK === "1";
            const maxBuyTaxBps = Number(process.env.MAX_BUY_TAX_BPS || 1500);
            const risk = await riskCheckToken(tokenAddress, {
              requireLpLock,
              maxBuyTaxBps,
            });
            if (!risk.ok) {
              await bot.sendMessage(
                chatId,
                `🚫 Trade blocked: ${risk.reasons?.join("; ")}`
              );
              setPendingInput(chatId, null);
              return;
            }
          } catch {}
          const { txid } = await performSwap({
            inputMint: "So11111111111111111111111111111111111111112",
            outputMint: tokenAddress,
            amountSol,
            chatId,
          });
          await bot.sendMessage(
            chatId,
            `✅ Quick Buy executed!\nAmount: ${amountSol} SOL\nToken: ${tokenAddress}\nTx: ${txid}`
          );
        } catch (e) {
          await bot.sendMessage(
            chatId,
            `❌ Quick Buy failed: ${e?.message || e}`
          );
        }
        setPendingInput(chatId, null);
        return;
      }

      // Handle Snipe LP token input
      if (state.pendingInput?.type === "SNIPE_LP_TOKEN") {
        try {
          const normalizedMint = new PublicKey(text.trim()).toBase58();
          setPendingInput(chatId, {
            type: "SNIPE_LP_AMOUNT",
            tokenAddress: normalizedMint,
          });
          const defaultSnipe = state.defaultSnipeSol ?? 0.05;
          await bot.sendMessage(
            chatId,
            `🎯 Snipe LP - ${normalizedMint}\n\nPlease enter the amount in SOL you want to snipe (default: ${defaultSnipe} SOL):`
          );
        } catch (e) {
          await bot.sendMessage(
            chatId,
            "❌ Invalid token address. Please send a valid Solana token address."
          );
        }
        return;
      }

      // Handle Snipe LP amount input
      if (state.pendingInput?.type === "SNIPE_LP_AMOUNT") {
        try {
          const { tokenAddress } = state.pendingInput;
          const amountSol =
            parseFloat(text.trim()) || (state.defaultSnipeSol ?? 0.05);
          if (amountSol <= 0) {
            await bot.sendMessage(
              chatId,
              "❌ Invalid amount. Please enter a positive number."
            );
            return;
          }
          const s = getUserState(chatId);
          const priorityFeeLamports =
            s.maxSnipeGasPrice ?? getPriorityFeeLamports();
          const useJitoBundle = s.enableJitoForSnipes ?? getUseJitoBundle();
          const pollInterval = s.snipePollInterval;
          const slippageBps = s.snipeSlippage;
          const retryCount = s.snipeRetryCount;
          startLiquidityWatch(chatId, {
            mint: tokenAddress,
            amountSol,
            priorityFeeLamports,
            useJitoBundle,
            pollInterval,
            slippageBps,
            retryCount,
            onEvent: (m) => bot.sendMessage(chatId, m),
          });
          await bot.sendMessage(
            chatId,
            `🎯 Snipe started!\nToken: ${tokenAddress}\nAmount: ${amountSol} SOL\nWatching for liquidity addition...`
          );
        } catch (e) {
          await bot.sendMessage(
            chatId,
            `❌ Snipe setup failed: ${e?.message || e}`
          );
        }
        setPendingInput(chatId, null);
        return;
      }

      // Handle Quote token input
      if (state.pendingInput?.type === "QUOTE_TOKEN") {
        try {
          const normalizedMint = new PublicKey(text.trim()).toBase58();
          setPendingInput(chatId, {
            type: "QUOTE_AMOUNT",
            tokenAddress: normalizedMint,
          });
          const defaultBuy = state.defaultBuySol ?? 0.05;
          await bot.sendMessage(
            chatId,
            `💰 Quote - ${normalizedMint}\n\nPlease enter the amount in SOL for the quote (default: ${defaultBuy} SOL):`
          );
        } catch (e) {
          await bot.sendMessage(
            chatId,
            "❌ Invalid token address. Please send a valid Solana token address."
          );
        }
        return;
      }

      // Handle Quote amount input
      if (state.pendingInput?.type === "QUOTE_AMOUNT") {
        try {
          const { tokenAddress } = state.pendingInput;
          const amountSol =
            parseFloat(text.trim()) || (state.defaultBuySol ?? 0.05);
          if (amountSol <= 0) {
            await bot.sendMessage(
              chatId,
              "❌ Invalid amount. Please enter a positive number."
            );
            return;
          }
          const res = await getTokenQuote({
            inputMint: "So11111111111111111111111111111111111111112",
            outputMint: tokenAddress,
            amountSol,
          });
          if (!res || !res.outAmountFormatted) {
            await bot.sendMessage(chatId, "❌ Failed to fetch quote.");
          } else {
            await bot.sendMessage(
              chatId,
              `💰 Quote Result\n\nToken: ${tokenAddress}\nInput: ${amountSol} SOL\nOutput: ${res.outAmountFormatted} tokens\nPrice Impact: ${res.priceImpactPct}%`
            );
          }
        } catch (e) {
          await bot.sendMessage(chatId, `❌ Quote failed: ${e?.message || e}`);
        }
        setPendingInput(chatId, null);
        return;
      }

      // Handle pending Snipe Defaults numeric inputs
      if (
        [
          "SET_DEFAULT_BUY",
          "SET_DEFAULT_SNIPE",
          "SET_SNIPE_SLIPPAGE",
          "SET_SNIPE_FEE",
          "SET_SNIPE_INTERVAL",
          "SET_SNIPE_RETRY",
        ].includes(state.pendingInput?.type)
      ) {
        const pending = state.pendingInput;
        const t = pending.type;
        const vNum = Number(text);
        if (Number.isNaN(vNum) || vNum < 0) {
          await bot.sendMessage(chatId, "Invalid number. Please try again.");
          return;
        }
        const keyMap = {
          SET_DEFAULT_BUY: "defaultBuySol",
          SET_DEFAULT_SNIPE: "defaultSnipeSol",
          SET_SNIPE_SLIPPAGE: "snipeSlippage",
          SET_SNIPE_FEE: "maxSnipeGasPrice",
          SET_SNIPE_INTERVAL: "snipePollInterval",
          SET_SNIPE_RETRY: "snipeRetryCount",
        };
        const key = keyMap[t];
        const val =
          t === "SET_SNIPE_FEE" && vNum === 0
            ? undefined
            : t === "SET_DEFAULT_BUY" || t === "SET_DEFAULT_SNIPE"
            ? Number(vNum.toFixed(6))
            : Math.floor(vNum);
        updateUserSetting(chatId, key, val);
        setPendingInput(chatId, null);
        await bot.sendMessage(chatId, "Updated.");
        const mid = pending?.data?.messageId;
        if (mid) {
          try {
            await bot.editMessageReplyMarkup(
              buildSnipeDefaultsMenu(chatId).reply_markup,
              { chat_id: chatId, message_id: mid }
            );
          } catch {}
        }
        return;
      }

      // Text-based commands
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
      if (text === "rpc bench") {
        try {
          const urls = getAllRpcEndpoints();
          if (!urls.length)
            return bot.sendMessage(chatId, "No RPC endpoints configured");
          const ranked = await measureEndpointsLatency(urls);
          const lines = ranked.map(
            (r, i) =>
              `${i + 1}. ${r.url} — ${
                r.latency === Number.MAX_SAFE_INTEGER
                  ? "fail"
                  : r.latency + "ms"
              }`
          );
          return bot.sendMessage(
            chatId,
            `RPC Benchmark (fastest first):\n${lines.join("\n")}`
          );
        } catch (e) {
          return bot.sendMessage(chatId, `Benchmark error: ${e.message || e}`);
        }
      }
      if (text === "trades") {
        const state = getUserState(chatId);
        const trades = (state.trades || []).slice(-10).reverse();
        if (!trades.length)
          return bot.sendMessage(chatId, "No trades logged yet.");
        const fmt = (t) => {
          const ts = new Date(t.timestamp).toLocaleTimeString();
          const shortMint = t.mint
            ? t.mint.slice(0, 6) + "…" + t.mint.slice(-4)
            : "?";
          if (t.kind === "buy")
            return `${ts} BUY ${shortMint} — ${t.sol} SOL  [${
              t.latencyMs || "?"
            }ms${t.slot ? ", slot " + t.slot : ""}]`;
          if (t.kind === "sell")
            return `${ts} SELL ${shortMint} — amtRaw=${t.amountRaw}  [${
              t.latencyMs || "?"
            }ms${t.slot ? ", slot " + t.slot : ""}]`;
          return `${ts} ${t.kind || "trade"} ${shortMint}`;
        };
        return bot.sendMessage(
          chatId,
          `Last trades:\n${trades.map(fmt).join("\n")}`
        );
      }

      // Tier management commands
      if (text === "tier") {
        const s = getUserState(chatId);
        const tier = (s.tier || "basic").toLowerCase();
        const caps = s.tierCaps || {};
        const todayKey = new Date().toISOString().slice(0, 10);
        const spent = Number(s.dailySpend?.[todayKey] || 0);
        const capVal = caps[tier] != null ? Number(caps[tier]) : Infinity;
        const remaining =
          capVal === Infinity ? "∞" : Math.max(0, capVal - spent).toFixed(6);
        const capsLine = `basic=${caps.basic ?? "-"} SOL, plus=${
          caps.plus ?? "-"
        } SOL, pro=${caps.pro ?? "-"} SOL`;
        return bot.sendMessage(
          chatId,
          `Current tier: ${tier.toUpperCase()}\nCaps: ${capsLine}\nToday spent: ${spent.toFixed(
            6
          )} SOL\nRemaining: ${remaining} SOL`
        );
      }
      if (text.startsWith("tier set ")) {
        const target = text.split(/\s+/)[2]?.toLowerCase();
        if (!["basic", "plus", "pro"].includes(target)) {
          return bot.sendMessage(chatId, "Usage: tier set <basic|plus|pro>");
        }
        updateUserSetting(chatId, "tier", target);
        return bot.sendMessage(chatId, `Tier set to ${target.toUpperCase()}`);
      }
      if (text.startsWith("tier caps")) {
        const parts = text.split(/\s+/);
        const s = getUserState(chatId);
        const caps = { ...(s.tierCaps || {}) };
        if (parts.length >= 4) {
          const t = parts[2]?.toLowerCase();
          const val = Number(parts[3]);
          if (
            !["basic", "plus", "pro"].includes(t) ||
            !Number.isFinite(val) ||
            val < 0
          ) {
            return bot.sendMessage(
              chatId,
              "Usage: tier caps <basic|plus|pro> <SOL cap>"
            );
          }
          caps[t] = val;
          updateUserSetting(chatId, "tierCaps", caps);
          return bot.sendMessage(
            chatId,
            `Updated ${t.toUpperCase()} cap to ${val} SOL`
          );
        } else {
          const capsLine = `basic=${caps.basic ?? "-"} SOL, plus=${
            caps.plus ?? "-"
          } SOL, pro=${caps.pro ?? "-"} SOL`;
          return bot.sendMessage(chatId, `Current caps: ${capsLine}`);
        }
      }
      if (text === "daily spend") {
        const s = getUserState(chatId);
        const tier = (s.tier || "basic").toLowerCase();
        const caps = s.tierCaps || {};
        const todayKey = new Date().toISOString().slice(0, 10);
        const spent = Number(s.dailySpend?.[todayKey] || 0);
        const capVal = caps[tier] != null ? Number(caps[tier]) : Infinity;
        const remaining =
          capVal === Infinity ? "∞" : Math.max(0, capVal - spent).toFixed(6);
        return bot.sendMessage(
          chatId,
          `Today spent: ${spent.toFixed(
            6
          )} SOL\nTier: ${tier.toUpperCase()} cap: ${
            capVal === Infinity ? "∞" : capVal
          } SOL\nRemaining: ${remaining} SOL`
        );
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
        return bot.sendMessage(chatId, "Jito bundling: ON");
      }
      if (text === "jito off") {
        setUseJitoBundle(false);
        return bot.sendMessage(chatId, "Jito bundling: OFF");
      }

      if (text.startsWith("stoploss ")) {
        const parts = text.split(/\s+/);
        if (parts[1] === "off") {
          const mint = parts[2];
          stopStopLoss(chatId, mint);
          return bot.sendMessage(chatId, `Stop-loss disabled for ${mint}`);
        }
        const mint = parts[1];
        const pct = Number(parts[2] || 20);
        startStopLoss(chatId, {
          mint,
          thresholdPct: pct,
          onEvent: (m) => bot.sendMessage(chatId, m),
        });
        return bot.sendMessage(chatId, `Stop-loss set at -${pct}% for ${mint}`);
      }

      if (text === "pump listen on") {
        await startPumpFunListener(chatId, {
          onMint: async (mint) => {
            try {
              const state = getUserState(chatId);
              const defaultSnipe = state.defaultSnipeSol ?? 0.05;
              const priorityFeeLamports =
                state.maxSnipeGasPrice ?? getPriorityFeeLamports();
              const useJitoBundle =
                state.enableJitoForSnipes ?? getUseJitoBundle();
              const pollInterval = state.snipePollInterval;
              const slippageBps = state.snipeSlippage;
              const retryCount = state.snipeRetryCount;

              if (state.autoSnipeOnPaste && (await hasUserWallet(chatId))) {
                startLiquidityWatch(chatId, {
                  mint,
                  amountSol: defaultSnipe,
                  priorityFeeLamports,
                  useJitoBundle,
                  pollInterval,
                  slippageBps,
                  retryCount,
                  onEvent: (m) => bot.sendMessage(chatId, m),
                });
                await bot.sendMessage(
                  chatId,
                  `Pump.fun mint detected: ${mint}\nAuto-snipe started for ${defaultSnipe} SOL`
                );
              } else {
                const kb = {
                  inline_keyboard: [
                    [
                      {
                        text: `📈 Quote ${defaultSnipe} SOL`,
                        callback_data: `AUTO_QUOTE_${mint}_${defaultSnipe}`,
                      },
                      {
                        text: `⚡ Buy ${defaultSnipe} SOL`,
                        callback_data: `AUTO_BUY_${mint}_${defaultSnipe}`,
                      },
                    ],
                    [
                      {
                        text: `🎯 Snipe on LP ${defaultSnipe} SOL`,
                        callback_data: `AUTO_SNIPE_${mint}_${defaultSnipe}`,
                      },
                      {
                        text: "❌ Dismiss",
                        callback_data: `DISMISS_${Date.now()}`,
                      },
                    ],
                  ],
                };
                await bot.sendMessage(
                  chatId,
                  `Pump.fun mint detected: ${mint}\nChoose an action:`,
                  { reply_markup: kb }
                );
              }
            } catch (e) {
              await bot.sendMessage(chatId, `Pump.fun mint detected: ${mint}`);
            }
          },
        });
        return bot.sendMessage(chatId, "Pump.fun listener ON");
      }
      if (text === "pump listen off") {
        stopPumpFunListener(chatId);
        return bot.sendMessage(chatId, "Pump.fun listener OFF");
      }

      if (text.startsWith("devwatch add ")) {
        const addr = text.split(/\s+/)[2];
        await addDevWalletToMonitor(chatId, addr);
        return bot.sendMessage(chatId, `Added dev wallet: ${addr}`);
      }
      if (text === "devwatch start") {
        await startDevWalletMonitor(chatId, {
          onTx: (addr, s) =>
            bot.sendMessage(chatId, `Dev tx from ${addr}: ${s.signature}`),
        });
        return bot.sendMessage(chatId, "Dev wallet monitor started");
      }
      if (text === "devwatch stop") {
        stopDevWalletMonitor(chatId);
        return bot.sendMessage(chatId, "Dev wallet monitor stopped");
      }

      if (text.startsWith("mempool watch ")) {
        const ids = text.split(/\s+/).slice(2);
        await startMempoolWatch(chatId, {
          programIds: ids,
          onEvent: (e) =>
            bot.sendMessage(
              chatId,
              `Logs from ${e.programId} at slot ${e.logs.slot}`
            ),
        });
        return bot.sendMessage(
          chatId,
          `Mempool watch on ${ids.length} programs`
        );
      }
      if (text === "mempool stop") {
        stopMempoolWatch(chatId);
        return bot.sendMessage(chatId, "Mempool watch stopped");
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
        if (!res || !res.outAmountFormatted)
          return bot.sendMessage(chatId, "Failed to fetch quote.");
        await bot.sendMessage(
          chatId,
          `Out amount: ${res.outAmountFormatted} tokens at ${res.priceImpactPct}% impact`
        );
        return;
      }

      if (text.startsWith("buy ")) {
        const [, mint, solStr, ...flagParts] = text.split(/\s+/);
        const amountSol = parseFloat(solStr);
        if (!mint || !amountSol)
          return bot.sendMessage(chatId, "Usage: buy <MINT> <amount SOL>");
        // Optional risk check gate
        try {
          const requireLpLock =
            String(process.env.REQUIRE_LP_LOCK || "").toLowerCase() ===
              "true" || process.env.REQUIRE_LP_LOCK === "1";
          const maxBuyTaxBps = Number(process.env.MAX_BUY_TAX_BPS || 1500);
          const risk = await riskCheckToken(mint, {
            requireLpLock,
            maxBuyTaxBps,
          });
          if (!risk.ok) {
            return bot.sendMessage(
              chatId,
              `🚫 Trade blocked: ${risk.reasons?.join("; ")}`
            );
          }
        } catch {}
        const flags = parseFlags(flagParts);
        const result = await performSwap({
          inputMint: "So11111111111111111111111111111111111111112",
          outputMint: mint,
          amountSol,
          chatId,
          ...flags,
        });
        if (result?.txids && result.txids.length) {
          return bot.sendMessage(
            chatId,
            `Swap submitted across ${
              result.txids.length
            } wallet(s). Tx(s):\n${result.txids.join("\n")}`
          );
        }
        if (result?.txid) {
          return bot.sendMessage(chatId, `Swap submitted. Tx: ${result.txid}`);
        }
        return bot.sendMessage(chatId, "Swap failed.");
      }

      if (text.startsWith("snipe ")) {
        const [, mint, solStr] = text.split(/\s+/);
        const amountSol = parseFloat(solStr);
        if (!mint || !amountSol)
          return bot.sendMessage(chatId, "Usage: snipe <MINT> <amount SOL>");
        const priorityFeeLamports = getPriorityFeeLamports();
        const useJitoBundle = getUseJitoBundle();
        startLiquidityWatch(chatId, {
          mint,
          amountSol,
          priorityFeeLamports,
          useJitoBundle,
          onEvent: (m) => bot.sendMessage(chatId, m),
        });
        return bot.sendMessage(
          chatId,
          `Sniping will start when liquidity is added for ${mint}`
        );
      }

      // Auto-detect Solana mint or account addresses and propose actions
      // Basic heuristic: Base58 32-44 chars and not starting with a slash command
      const base58Re = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
      if (!text.startsWith("/") && base58Re.test(text)) {
        let normalizedMint = null;
        try {
          normalizedMint = new PublicKey(text).toBase58();
        } catch {}
        if (normalizedMint) {
          const mint = normalizedMint;
          const defaultBuy = state.defaultBuySol ?? 0.05;
          const defaultSnipe = state.defaultSnipeSol ?? 0.05;
          if (state.autoSnipeOnPaste && (await hasUserWallet(chatId))) {
            const s = getUserState(chatId);
            const priorityFeeLamports =
              s.maxSnipeGasPrice ?? getPriorityFeeLamports();
            const useJitoBundle = s.enableJitoForSnipes ?? getUseJitoBundle();
            const pollInterval = s.snipePollInterval;
            const slippageBps = s.snipeSlippage;
            const retryCount = s.snipeRetryCount;
            startLiquidityWatch(chatId, {
              mint,
              amountSol: defaultSnipe,
              priorityFeeLamports,
              useJitoBundle,
              pollInterval,
              slippageBps,
              retryCount,
              onEvent: (m) => bot.sendMessage(chatId, m),
            });
            await bot.sendMessage(
              chatId,
              `Auto-snipe started for ${mint} — amount ${defaultSnipe} SOL`
            );
            return;
          }
          const kb = {
            inline_keyboard: [
              [
                {
                  text: `📈 Quote ${defaultBuy} SOL`,
                  callback_data: `AUTO_QUOTE_${mint}_${defaultBuy}`,
                },
                {
                  text: `⚡ Buy ${defaultBuy} SOL`,
                  callback_data: `AUTO_BUY_${mint}_${defaultBuy}`,
                },
              ],
              [
                {
                  text: `🎯 Snipe on LP ${defaultSnipe} SOL`,
                  callback_data: `AUTO_SNIPE_${mint}_${defaultSnipe}`,
                },
                { text: "❌ Dismiss", callback_data: `DISMISS_${Date.now()}` },
              ],
            ],
          };
          await bot.sendMessage(
            chatId,
            `Detected token/mint: ${mint}\nChoose an action:`,
            { reply_markup: kb }
          );
          return;
        }
      }
    } catch (e) {
      await bot.sendMessage(chatId, `Error: ${e.message || e}`);
    }
  });

  console.log("Telegram bot started");
}

export function getBotInstance() {
  return bot;
}
