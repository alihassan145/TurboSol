import TelegramBot from "node-telegram-bot-api";
import { getPublicKey } from "./wallet.js";
import { getTokenQuote, performSwap, quickSell } from "./trading/jupiter.js";
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
  getRpcConnection,
  getRpcStatus as getRpcCoreStatus,
} from "./rpc.js";
import {
  setPriorityFeeLamports,
  setUseJitoBundle,
  getPriorityFeeLamports,
  getUseJitoBundle,
  setPrivateRelayEndpoint,
  setPrivateRelayApiKey,
  getRelayVendor,
  setRelayVendor,
  setDynamicPriorityFeeLamports,
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
import {
  getWalletInfo,
  shortenAddress,
  getWalletSellTokens,
} from "./walletInfo.js";
import {
  buildTurboSolMainMenu,
  buildTurboSolSettingsMenu,
  buildPositionsMenu,
  buildWalletsMenu,
  buildWalletDetailsMenu,
  buildSnipeDefaultsMenu,
  buildTradingToolsMenu,
  buildAutomationMenu,
  buildRpcSettingsMenu,
  buildDeltaSettingsMenu,
  buildFeeSettingsMenu,
} from "./menuBuilder.js";
import {
  getUserState,
  updateUserSetting,
  setPendingInput,
  addTradeLog,
  getRemainingDailyCap,
  getDailyCap,
  getDailySpent,
} from "./userState.js";
import { readTrades } from "./tradeStore.js";
import { PublicKey } from "@solana/web3.js";
import { riskCheckToken } from "./risk.js";
import { startStopLoss, stopStopLoss } from "./watchers/stopLossWatcher.js";
import { stopPumpFunListener } from "./watchers/pumpfunWatcher.js";
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
import { loadActiveSnipesByChat, markSnipeCancelled } from "./snipeStore.js";
// import PumpListener from "./pumpListener.js";
import PumpPortalListener from "./pumpPortalListener.js";
import { startPreLPWatch, stopPreLPWatch } from "./preLPScanner.js";

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
export function getBotInstance() {
  return bot;
}

// Per-chat action debounce to reduce bursty API calls that can cause 429s
const lastActionAt = new Map();
// Pump.fun pollers per chat (1s polling)
const pumpPollers = new Map();
function canProceed(chatId, key, minIntervalMs = 800) {
  const now = Date.now();
  const k = `${chatId}:${key}`;
  const prev = lastActionAt.get(k) || 0;
  if (now - prev < minIntervalMs) return false;
  lastActionAt.set(k, now);
  return true;
}

// Local timeout wrapper used by buy/sell flows
function promiseWithTimeout(promise, ms, tag = "timeout") {
  let to;
  return Promise.race([
    promise.finally(() => clearTimeout(to)),
    new Promise((_, rej) => {
      to = setTimeout(() => rej(new Error(tag)), ms);
    }),
  ]);
}

function buildMainMenu(chatId) {
  return {
    chat_id: chatId,
    text: "TurboSol Sniper — choose an action:",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Wallet", callback_data: "WALLETS_MENU" },
          { text: "Quick Buy", callback_data: "QUICK_BUY" },
          { text: "Quick Sell", callback_data: "QUICK_SELL" },
        ],
        [
          { text: "Snipe LP Add", callback_data: "SNIPE_LP" },
          { text: "Stop Snipe", callback_data: "STOP_SNIPE" },
        ],
        [{ text: "📋 Active Snipes", callback_data: "ACTIVE_SNIPES" }],
        [
          { text: "Quote", callback_data: "QUOTE" },
          { text: "⚙️ Settings", callback_data: "SETTINGS" },
        ],
        [{ text: "🤖 Automation", callback_data: "AUTOMATION" }],
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
      { command: "prelp", description: "Toggle Pre-LP scanner" },
      { command: "delta", description: "Toggle Liquidity Delta heuristic" },
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

  // Show last transaction(s)
  bot.onText(/\/lasttx(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    try {
      const n = Math.min(Math.max(parseInt(match?.[1] || "1", 10) || 1, 1), 5);
      const trades = readTrades(String(chatId), 100) || [];
      if (!trades.length) {
        return bot.sendMessage(chatId, "No recent transactions found.");
      }
      const last = trades.slice(-n).reverse();
      const lines = last.map((t, i) => {
        const ts = t.timestamp ? new Date(t.timestamp).toLocaleString() : "";
        const kind = (t.kind || "trade").toUpperCase();
        const mint = t.mint ? (t.mint.slice(0, 6) + "…" + t.mint.slice(-4)) : "?";
        const amount =
          t.kind === "buy"
            ? `${Number(t.sol || 0)} SOL`
            : t.kind === "sell"
            ? `${Number(t.solOut != null ? t.solOut : t.sol || 0)} SOL`
            : "";
        const txid = t.txid ? (t.txid.slice(0, 8) + "…" + t.txid.slice(-8)) : "";
        const via = t.via ? ` via ${t.via}` : "";
        const lat = Number.isFinite(Number(t.latencyMs)) ? `, ${t.latencyMs}ms` : "";
        const status = t.status ? ` [${t.status}]` : "";
        return `${i + 1}. ${kind}${status} — ${mint} — ${amount}${via}${lat} ${ts} ${txid}`.trim();
      });
      const header = n === 1 ? "Last transaction:" : `Last ${n} transactions:`;
      await bot.sendMessage(chatId, `${header}\n\n${lines.join("\n")}`);
    } catch (e) {
      await bot.sendMessage(chatId, `Failed to load last transactions: ${e?.message || e}`);
    }
  });

  // Toggle Pre-LP scanner via command
  bot.onText(/\/prelp/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const current = !!getUserState(chatId).preLPWatchEnabled;
      const next = !current;
      updateUserSetting(chatId, "preLPWatchEnabled", next);
      if (next) {
        await startPreLPWatch(chatId, {
          onEvent: (ev) => { try { bot.sendMessage(chatId, typeof ev === 'string' ? ev : ev?.type || 'prelp'); } catch {} },
          onSnipeEvent: (mint, m) => { try { bot.sendMessage(chatId, `[PreLP ${mint}] ${m}`); } catch {} },
          autoSnipeOnPreLP: true,
        });
      } else {
        try { stopPreLPWatch(chatId); } catch {}
      }
      await bot.sendMessage(chatId, next ? "🔬 Pre-LP scanner enabled" : "🔬 Pre-LP scanner disabled");
    } catch (e) {
      await bot.sendMessage(chatId, `Pre-LP toggle failed: ${e?.message || e}`);
    }
  });

  // Toggle Liquidity Delta heuristic via command
  bot.onText(/\/delta/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const cur = !!getUserState(chatId).liqDeltaEnabled;
      const next = !cur;
      updateUserSetting(chatId, "liqDeltaEnabled", next);
      await bot.sendMessage(chatId, next ? "📈 Delta heuristic enabled" : "📈 Delta heuristic disabled");
    } catch (e) {
      await bot.sendMessage(chatId, `Delta toggle failed: ${e?.message || e}`);
    }
  });

  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;
      if (data === "REFRESH") {
        const welcome = await buildTurboSolWelcomeMessage(chatId);
        await bot.sendMessage(chatId, welcome);
        return bot.sendMessage(chatId, "Choose an option:", {
          reply_markup: buildMainMenu(chatId).reply_markup,
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

      if (data === "ACTIVE_SNIPES") {
        try {
          const items = await loadActiveSnipesByChat(chatId);
          const lines = (items || []).map((i) => {
            const shortMint = i.mint
              ? i.mint.slice(0, 6) + "…" + i.mint.slice(-4)
              : "?";
            const started = i.startedAt
              ? new Date(i.startedAt).toLocaleTimeString()
              : "?";
            return `• ${shortMint} — ${i.amountSol} SOL (since ${started})`;
          });
          const keyboard = [
            ...(items || []).map((i) => [
              {
                text: `🛑 Stop ${i.mint.slice(0, 6)}…${i.mint.slice(-4)}`,
                callback_data: `STOP_SNIPE_BY_${i.mint}`,
              },
            ]),
            [{ text: "⛔ Stop All", callback_data: "STOP_SNIPE" }],
            [{ text: "🔙 Back", callback_data: "MAIN_MENU" }],
          ];
          const body = lines.length
            ? `📋 Active Snipes (${lines.length})\n\n${lines.join("\n")}`
            : "No active snipes for this chat.";
          try {
            await bot.editMessageText(body, {
              chat_id: chatId,
              message_id: messageId,
              reply_markup: { inline_keyboard: keyboard },
            });
          } catch (e) {
            await bot.sendMessage(chatId, body, {
              reply_markup: { inline_keyboard: keyboard },
            });
          }
        } catch (e) {
          await bot.answerCallbackQuery(query.id, { text: "Failed to load" });
        }
        return;
      }

      if (data.startsWith("STOP_SNIPE_BY_")) {
        const mint = data.replace("STOP_SNIPE_BY_", "");
        try {
          stopLiquidityWatch(chatId, mint);
          try {
            await markSnipeCancelled(chatId, mint, "stopped_by_user");
          } catch {}
          await bot.answerCallbackQuery(query.id, {
            text: `Stopped ${mint.slice(0, 6)}…${mint.slice(-4)}`,
          });
        } catch (e) {
          await bot.answerCallbackQuery(query.id, { text: "Failed to stop" });
        }
        // Refresh the active snipes view
        try {
          const items = await loadActiveSnipesByChat(chatId);
          const lines = (items || []).map((i) => {
            const shortMint = i.mint
              ? i.mint.slice(0, 6) + "…" + i.mint.slice(-4)
              : "?";
            const started = i.startedAt
              ? new Date(i.startedAt).toLocaleTimeString()
              : "?";
            return `• ${shortMint} — ${i.amountSol} SOL (since ${started})`;
          });
          const keyboard = [
            ...(items || []).map((i) => [
              {
                text: `🛑 Stop ${i.mint.slice(0, 6)}…${i.mint.slice(-4)}`,
                callback_data: `STOP_SNIPE_BY_${i.mint}`,
              },
            ]),
            [{ text: "⛔ Stop All", callback_data: "STOP_SNIPE" }],
            [{ text: "🔙 Back", callback_data: "MAIN_MENU" }],
          ];
          const body = lines.length
            ? `📋 Active Snipes (${lines.length})\n\n${lines.join("\n")}`
            : "No active snipes for this chat.";
          try {
            await bot.editMessageText(body, {
              chat_id: chatId,
              message_id: messageId,
              reply_markup: { inline_keyboard: keyboard },
            });
          } catch (e) {
            await bot.sendMessage(chatId, body, {
              reply_markup: { inline_keyboard: keyboard },
            });
          }
        } catch {}
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

      if (data === "QUICK_SELL") {
        try {
          await bot.answerCallbackQuery(query.id, { text: "Quick Sell" });
          if (!(await hasUserWallet(chatId))) {
            await bot.sendMessage(
              chatId,
              "❌ No wallet linked. Use /setup to create or /import <privateKeyBase58> to import an existing wallet."
            );
            return;
          }
          // Fetch user's SPL tokens with balances (cached)
          const items = await getWalletSellTokens(chatId);
          if (!items.length) {
            const keyboard = [
              [
                { text: "🔄 Refresh", callback_data: "QUICK_SELL" },
                { text: "🏠 Main", callback_data: "MAIN_MENU" },
              ],
            ];
            await bot.sendMessage(
              chatId,
              "😕 No SPL tokens with balance found in your wallet. If you recently received tokens, tap Refresh (RPC may be slightly delayed).",
              { reply_markup: { inline_keyboard: keyboard } }
            );
            return;
          }
          // Build selection keyboard (top 10 by balance)
          const top = items.slice(0, 10);
          const keyboard = top.map((t) => {
            const mint = t.mint;
            const sym = (t.symbol || "").toString().slice(0, 12);
            const bal = Number(t.uiAmount || 0).toFixed(4);
            const label = sym
              ? `${sym} • ${bal}`
              : `${mint.slice(0, 4)}…${mint.slice(-4)} • ${bal}`;
            return [{ text: label, callback_data: `SELL_PICK_${mint}` }];
          });
          keyboard.push([
            { text: "🔄 Refresh", callback_data: "QUICK_SELL" },
            { text: "🏠 Main", callback_data: "MAIN_MENU" },
          ]);
          await bot.sendMessage(
            chatId,
            "💸 Quick Sell — Select a token to sell:",
            {
              reply_markup: { inline_keyboard: keyboard },
            }
          );
        } catch (e) {
          await bot.sendMessage(
            chatId,
            `Quick Sell failed: ${e?.message || e}`
          );
        }
        return;
      }

      if (data.startsWith("SELL_PICK_")) {
        try {
          const mint = data.slice("SELL_PICK_".length);
          // Set pending percent input for chosen token
          setPendingInput(chatId, {
            type: "QUICK_SELL_PERCENT",
            tokenAddress: mint,
          });
          // Try to enrich with cached token info
          let title = mint;
          try {
            const list = await getWalletSellTokens(chatId);
            const found = list.find((x) => x.mint === mint);
            if (found) {
              const sym = (found.symbol || "TOKEN").toString().slice(0, 12);
              const bal = Number(found.uiAmount || 0).toFixed(4);
              title = `${sym} (${mint.slice(0, 4)}…${mint.slice(
                -4
              )}) — bal ${bal}`;
            }
          } catch {}
          const keyboard = [
            [
              { text: "25%", callback_data: `SELL_PCT_25_${mint}` },
              { text: "50%", callback_data: `SELL_PCT_50_${mint}` },
              { text: "100%", callback_data: `SELL_PCT_100_${mint}` },
            ],
            [
              { text: "🔙 Back", callback_data: "QUICK_SELL" },
              { text: "🏠 Main", callback_data: "MAIN_MENU" },
            ],
          ];
          await bot.sendMessage(
            chatId,
            `✅ Selected: ${title}\n\nSend a number 1-100 for custom percent, or tap a quick option below:`,
            { reply_markup: { inline_keyboard: keyboard } }
          );
        } catch (e) {
          await bot.sendMessage(
            chatId,
            `❌ Could not prepare sell: ${e?.message || e}`
          );
        }
        return;
      }

      if (data.startsWith("SELL_PCT_")) {
        try {
          const rest = data.slice("SELL_PCT_".length); // <pct>_<mint>
          const [pctStr, mint] = rest.split("_");
          const percent = Math.max(
            1,
            Math.min(100, parseInt(pctStr, 10) || 100)
          );
          if (!canProceed(chatId, "QUICK_SELL_EXECUTE", 1600)) {
            await bot.answerCallbackQuery(query.id, { text: "Please wait…" });
            return;
          }
          if (!(await hasUserWallet(chatId))) {
            await bot.answerCallbackQuery(query.id, {
              text: "No wallet linked",
            });
            await bot.sendMessage(
              chatId,
              "No wallet linked. Use /setup to create or /import <privateKeyBase58> to link your wallet."
            );
            return;
          }
          await bot.answerCallbackQuery(query.id, {
            text: `Selling ${percent}%`,
          });
          const priorityFeeLamports = getPriorityFeeLamports();
          const useJitoBundle = getUseJitoBundle();
          await bot.sendMessage(
            chatId,
            `⏳ Placing quick sell of ${percent}% for token ${mint}...`
          );
          const sellRes = await quickSell({
            tokenMint: mint,
            percent,
            priorityFeeLamports,
            useJitoBundle,
            chatId,
          });
          setPendingInput(chatId, null);
          const txid =
            sellRes?.txid ||
            (Array.isArray(sellRes?.txids) ? sellRes.txids[0] : null);
          const solscan = `https://solscan.io/tx/${txid}`;
          const solOut =
            typeof sellRes?.output?.tokensOut === "number"
              ? sellRes.output.tokensOut.toFixed(6)
              : "?";
          const impact =
            typeof sellRes?.route?.priceImpactPct === "number"
              ? `${(sellRes.route.priceImpactPct * 100).toFixed(2)}%`
              : "?";
          await bot.sendMessage(
            chatId,
            `✅ Sell sent\n• Token: ${mint}\n• Percent: ${percent}%\n• Est. SOL Out: ${solOut}\n• Route: ${
              sellRes?.route?.labels || "route"
            }\n• Price impact: ${impact}\n• Slippage: ${
              sellRes?.slippageBps
            } bps\n• Priority fee: ${sellRes?.priorityFeeLamports}\n• Via: ${
              sellRes?.via
            }\n• Latency: ${
              sellRes?.latencyMs
            } ms\n• Tx: ${txid}\n🔗 ${solscan}`
          );
          // Record sell trade log with racing telemetry
          addTradeLog(chatId, {
            kind: "sell",
            mint,
            percent,
            sol: Number(sellRes?.output?.tokensOut ?? NaN),
            route: sellRes?.route?.labels,
            priceImpactPct: sellRes?.route?.priceImpactPct ?? null,
            slippageBps: sellRes?.slippageBps,
            priorityFeeLamports: sellRes?.priorityFeeLamports,
            via: sellRes?.via,
            latencyMs: sellRes?.latencyMs,
            txid,
            lastSendRaceWinner: sellRes?.lastSendRaceWinner ?? null,
            lastSendRaceAttempts: sellRes?.lastSendRaceAttempts ?? 0,
            lastSendRaceLatencyMs: sellRes?.lastSendRaceLatencyMs ?? null,
          });
          // Follow-up: notify on confirmation or failure
          notifyTxStatus(chatId, txid, { kind: "Sell" }).catch(() => {});
        } catch (e) {
          await bot.sendMessage(
            chatId,
            `❌ Quick Sell failed: ${e?.message || e}`
          );
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
          const helpText = `🚀 **TurboSol Help**\n\n**Main Commands:**\n• /start - Initialize the bot\n• /setup - Create new wallet\n• /import <privateKey> - Import existing wallet\n• /address - Show wallet address
• /lasttx [n] - Show last n transactions (max 5)

**Quick Actions:**\n• **Wallet** - Manage your wallets\n• **Quick Buy** - Buy tokens with default settings\n• **Snipe LP Add** - Snipe tokens when liquidity is added\n• **Quote** - Get token price quotes\n\n**Text Commands:**\n• Send token address to get buy/snipe options\n• \`quote <mint> <sol_amount>\` - Get price quote\n• \`buy <mint> <sol_amount>\` - Buy tokens\n• \`snipe <mint> <sol_amount>\` - Start sniping\n\n**Settings:**\n• \`fee <lamports>\` - Set priority fee\n• \`jito on/off\` - Toggle Jito bundling\n• \`tier\` - View current tier and limits\n\n**Automation:**\n• Open the Automation menu to toggle Pump.fun launch alerts and more.\n\nFor more help, contact support.`;
          await bot.sendMessage(chatId, helpText, { parse_mode: "Markdown" });
        } catch (e) {
          await bot.sendMessage(chatId, `Help failed: ${e?.message || e}`);
        }
        return;
      }

      // Start Buy/Quote flows from detected mint by asking for amount first
      if (data.startsWith("START_BUY_")) {
        const mint = data.slice("START_BUY_".length);
        try {
          await bot.answerCallbackQuery(query.id, { text: "Buy" });
          const state = getUserState(chatId);
          const defaultBuy = state.defaultBuySol ?? 0.05;
          if (!(await hasUserWallet(chatId))) {
            await bot.sendMessage(
              chatId,
              "❌ No wallet linked. Use /setup to create or /import <privateKeyBase58> to import an existing wallet."
            );
            return;
          }
          setPendingInput(chatId, {
            type: "QUICK_BUY_AMOUNT",
            tokenAddress: mint,
          });
          await bot.sendMessage(
            chatId,
            `💰 Quick Buy - ${mint}\n\nPlease enter the amount in SOL you want to buy (default: ${defaultBuy} SOL):`
          );
        } catch (e) {
          await bot.sendMessage(chatId, `Buy start failed: ${e?.message || e}`);
        }
        return;
      }

      if (data.startsWith("START_QUOTE_")) {
        const mint = data.slice("START_QUOTE_".length);
        try {
          await bot.answerCallbackQuery(query.id, { text: "Quote" });
          const state = getUserState(chatId);
          const defaultBuy = state.defaultBuySol ?? 0.05;
          setPendingInput(chatId, { type: "QUOTE_AMOUNT", tokenAddress: mint });
          await bot.sendMessage(
            chatId,
            `💰 Quote - ${mint}\n\nEnter amount in SOL to quote (default: ${defaultBuy} SOL):`
          );
        } catch (e) {
          await bot.sendMessage(
            chatId,
            `Quote start failed: ${e?.message || e}`
          );
        }
        return;
      }
      if (data.startsWith("AUTO_QUOTE_")) {
        try {
          if (!canProceed(chatId, "AUTO_QUOTE", 700)) {
            await bot.answerCallbackQuery(query.id, { text: "Please wait…" });
            return;
          }
          const rest = data.slice("AUTO_QUOTE_".length);
          const [mint, amtStr] = rest.split("_");
          const amountSol = parseFloat(amtStr);
          try { const s = getUserState(chatId); s.lastAmounts = s.lastAmounts || {}; s.lastAmounts[mint] = amountSol; } catch {}
          const res = await getTokenQuote({
            inputMint: "So11111111111111111111111111111111111111112",
            outputMint: mint,
            amountSol,
          });
          console.log("[DEBUG] Quote Result:", res);
          console.log("[TELEGRAM] Quote Validation:", {
            outAmount: res?.route?.outAmount,
            outAmountFormatted: res?.outAmountFormatted,
          });

          if (!res || res.outAmountFormatted == null) {
            await bot.answerCallbackQuery(query.id, { text: "Quote failed" });
            return;
          }

          await bot.sendMessage(
            chatId,
            `Quote for ${amountSol} SOL -> ${mint}: ${res.outAmountFormatted} tokens (impact ${res.priceImpactPct}%)`,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "Buy",
                      callback_data: `AUTO_BUY_${mint}_${amountSol}`,
                    },
                    {
                      text: "Re-Quote",
                      callback_data: `AUTO_QUOTE_${mint}_${amountSol}`,
                    },
                  ],
                  [
                    { text: "Re-Buy (edit amount)", callback_data: `REBUY_${mint}` },
                    { text: "Re-Quote (edit amount)", callback_data: `REQUOTE_${mint}` },
                  ],
                ],
              },
            }
          );
        } catch (e) {
          console.error("Auto quote failed:", e);
          await bot.answerCallbackQuery(query.id, { text: "Quote error" });
          await bot.sendMessage(chatId, `❌ Quote failed: ${e?.message || e}`);
        }
        return;
      }

      if (data.startsWith("AUTO_BUY_")) {
        const rest = data.slice("AUTO_BUY_".length);
        const [mint, amtStr] = rest.split("_");
        const amountSol = parseFloat(amtStr);
        try { const s = getUserState(chatId); s.lastAmounts = s.lastAmounts || {}; s.lastAmounts[mint] = amountSol; } catch {}
        if (!(await hasUserWallet(chatId))) {
          await bot.answerCallbackQuery(query.id, { text: "No wallet linked" });
          await bot.sendMessage(
            chatId,
            `No wallet linked. Use /setup to create or /import <privateKeyBase58>.`
          );
          return;
        }
        // Enforce daily spend cap for AUTO_BUY
        try {
          const cap = getDailyCap(chatId);
          const spent = getDailySpent(chatId);
          const remaining = getRemainingDailyCap(chatId);
          if (Number.isFinite(cap) && amountSol > remaining + 1e-9) {
            await bot.answerCallbackQuery(query.id, { text: "Daily cap reached" });
            await bot.sendMessage(
              chatId,
              `🚫 Daily spend cap reached. Tier: ${getUserState(chatId).tier}. Cap: ${cap} SOL. Spent today: ${spent.toFixed(4)} SOL. Remaining: ${Math.max(0, remaining).toFixed(4)} SOL.`
            );
            return;
          }
        } catch {}
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
        const swapPromise = performSwap({
          inputMint: "So11111111111111111111111111111111111111112",
          outputMint: mint,
          amountSol,
          chatId,
        });
        try {
          const TIMEOUT_MS = Number(process.env.SWAP_TIMEOUT_MS || 18000);
          const swapRes = await promiseWithTimeout(
            swapPromise,
            TIMEOUT_MS,
            "swap_timeout"
          );
          const txid = swapRes?.txid;
          const solscan = `https://solscan.io/tx/${txid}`;
          const tokOut =
            typeof swapRes?.output?.tokensOut === "number"
              ? swapRes.output.tokensOut.toFixed(4)
              : "?";
          const impact =
            swapRes?.route?.priceImpactPct != null
              ? `${swapRes.route.priceImpactPct}%`
              : "?";
          const symbol = swapRes?.output?.symbol || "TOKEN";
          await bot.sendMessage(
            chatId,
            `✅ Buy sent\n• Token: ${symbol} (${mint})\n• Amount: ${amountSol} SOL\n• Est. Tokens: ${tokOut}\n• Route: ${
              swapRes?.route?.labels || "route"
            }\n• Price impact: ${impact}\n• Slippage: ${
              swapRes?.slippageBps
            } bps\n• Priority fee: ${swapRes?.priorityFeeLamports}\n• Via: ${
              swapRes?.via
            }\n• Latency: ${
              swapRes?.latencyMs
            } ms\n• Tx: ${txid}\n🔗 ${solscan}`,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: "Re-Buy", callback_data: `AUTO_BUY_${mint}_${amountSol}` },
                    { text: "Re-Quote", callback_data: `AUTO_QUOTE_${mint}_${amountSol}` },
                  ],
                  [
                    { text: "Re-Buy (edit amount)", callback_data: `REBUY_${mint}` },
                    { text: "Re-Quote (edit amount)", callback_data: `REQUOTE_${mint}` },
                  ],
                ],
              },
            }
          );
          // Record buy trade log with racing telemetry
          addTradeLog(chatId, {
            kind: "buy",
            mint,
            sol: Number(amountSol),
            tokens: Number(swapRes?.output?.tokensOut ?? NaN),
            route: swapRes?.route?.labels,
            priceImpactPct: swapRes?.route?.priceImpactPct ?? null,
            slippageBps: swapRes?.slippageBps,
            priorityFeeLamports: swapRes?.priorityFeeLamports,
            via: swapRes?.via,
            latencyMs: swapRes?.latencyMs,
            txid,
            lastSendRaceWinner: swapRes?.lastSendRaceWinner ?? null,
            lastSendRaceAttempts: swapRes?.lastSendRaceAttempts ?? 0,
            lastSendRaceLatencyMs: swapRes?.lastSendRaceLatencyMs ?? null,
          });
          // Follow-up: notify on confirmation or failure
          notifyTxStatus(chatId, txid, { kind: "Buy" }).catch(() => {});
        } catch (e) {
          if (String(e?.message || "").includes("swap_timeout")) {
            await bot.sendMessage(
              chatId,
              "⏱️ The buy is taking longer than expected due to network congestion. It may still complete. Check /positions or /lasttx in a moment."
            );
            swapPromise
              .then((res) => {
                const txid =
                  res?.txid || (Array.isArray(res?.txids) ? res.txids[0] : null);
                if (!txid)
                  return bot.sendMessage(
                    chatId,
                    "⚠️ Swap finished but no transaction id was returned."
                  );
                const solscan = `https://solscan.io/tx/${txid}`;
                const symbol = res?.output?.symbol || "TOKEN";
                const tokOut =
                  typeof res?.output?.tokensOut === "number"
                    ? res.output.tokensOut.toFixed(4)
                    : "?";
                const impact =
                  res?.route?.priceImpactPct != null
                    ? `${res.route.priceImpactPct}%`
                    : "?";
                // Record buy trade log with racing telemetry (delayed follow-up)
                addTradeLog(chatId, {
                  kind: "buy",
                  mint,
                  sol: Number(amountSol),
                  tokens: Number(res?.output?.tokensOut ?? NaN),
                  route: res?.route?.labels,
                  priceImpactPct: res?.route?.priceImpactPct ?? null,
                  slippageBps: res?.slippageBps,
                  priorityFeeLamports: res?.priorityFeeLamports,
                  via: res?.via,
                  latencyMs: res?.latencyMs,
                  txid,
                  lastSendRaceWinner: res?.lastSendRaceWinner ?? null,
                  lastSendRaceAttempts: res?.lastSendRaceAttempts ?? 0,
                  lastSendRaceLatencyMs: res?.lastSendRaceLatencyMs ?? null,
                });
                // Notify user completed
                notifyTxStatus(chatId, txid, { kind: "Buy" }).catch(() => {});
                return bot.sendMessage(
                  chatId,
                  `✅ Buy completed\n• Token: ${symbol} (${mint})\n• Amount: ${amountSol} SOL\n• Est. Tokens: ${tokOut}\n• Route: ${
                    res?.route?.labels || "route"
                  }\n• Price impact: ${impact}\n• Slippage: ${
                    res?.slippageBps
                  } bps\n• Priority fee: ${
                    res?.priorityFeeLamports
                  }\n• Via: ${res?.via}\n• Latency: ${
                    res?.latencyMs
                  } ms\n• Tx: ${txid}\n🔗 ${solscan}`
                );
              })
              .catch((err) =>
                bot.sendMessage(
                  chatId,
                  `❌ Buy failed after timeout: ${err?.message || err}`
                )
              );

            const FINAL_TIMEOUT_MS = Number(
              process.env.SWAP_FINAL_TIMEOUT_MS || 120000
            );
            promiseWithTimeout(
              swapPromise,
              FINAL_TIMEOUT_MS,
              "swap_final_timeout"
            ).catch((err2) => {
              if (String(err2?.message || "").includes("swap_final_timeout")) {
                bot.sendMessage(
                  chatId,
                  "⌛ Still no confirmation after 120s. The transaction may still land. Check /positions or /lasttx shortly. If you see a txid above, you can also track it on Solscan."
                );
              }
            });
          } else {
            await bot.sendMessage(
              chatId,
              `❌ Buy failed: ${e?.message || e}`
            );
            // Record failed buy attempt with reason for telemetry
            try {
              const failMsg = (e?.message || String(e)).slice(0, 300);
              addTradeLog(chatId, {
                kind: "status",
                statusOf: "buy",
                mint,
                sol: Number(amountSol),
                status: "failed",
                failReason: failMsg,
              });
            } catch {}
          }
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
        try {
          addTradeLog(chatId, { kind: 'telemetry', stage: 'auto_snipe_trigger', source: 'ui:telegram', signalType: 'manual_auto_snipe', mint, params: { amountSol, pollInterval, slippageBps, retryCount, useJitoBundle } });
        } catch {}
        startLiquidityWatch(chatId, {
          mint,
          amountSol,
          priorityFeeLamports,
          useJitoBundle,
          pollInterval,
          slippageBps,
          retryCount,
          source: 'ui:telegram',
          signalType: 'manual_auto_snipe',
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
        try { await bot.answerCallbackQuery(query.id, { text: "Settings" }); } catch {}
        try {
          const markup = buildTurboSolSettingsMenu(chatId).reply_markup;
          await bot.sendMessage(chatId, "⚙️ TurboSol Settings", { reply_markup: markup });
        } catch (e) {
          try { await bot.sendMessage(chatId, "⚙️ TurboSol Settings"); } catch {}
        }
        return;
      }

      if (data === "RPC_SETTINGS" || data === "RPC_CONFIG") {
        try { await bot.answerCallbackQuery(query.id, { text: "RPC Settings" }); } catch {}
        try {
          await bot.editMessageText("🌐 RPC Settings", {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: buildRpcSettingsMenu(chatId).reply_markup,
          });
        } catch (e) {
          await bot.sendMessage(chatId, "🌐 RPC Settings", {
            reply_markup: buildRpcSettingsMenu(chatId).reply_markup,
          });
        }
        return;
      }

      // Fee Settings navigation
      if (data === "FEE_SETTINGS") {
        try { await bot.answerCallbackQuery(query.id, { text: "Fee Settings" }); } catch {}
        try {
          await bot.editMessageText("💰 Fee Settings", {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: buildFeeSettingsMenu(chatId).reply_markup,
          });
        } catch (e) {
          await bot.sendMessage(chatId, "💰 Fee Settings", {
            reply_markup: buildFeeSettingsMenu(chatId).reply_markup,
          });
        }
        return;
      }

      // Fee Settings actions
      if (data === "SET_PRIORITY_FEE") {
        setPendingInput(chatId, { type: "SET_PRIORITY_FEE", data: { messageId } });
        await bot.sendMessage(
          chatId,
          "Send global priority fee in lamports (e.g., 100000) or 0 for auto"
        );
        return;
      }

      if (data === "RESET_DYNAMIC_FEE") {
        setDynamicPriorityFeeLamports(null);
        try {
          await bot.answerCallbackQuery(query.id, { text: "Tip override cleared" });
        } catch {}
        await bot.editMessageReplyMarkup(
          buildFeeSettingsMenu(chatId).reply_markup,
          { chat_id: chatId, message_id: messageId }
        );
        return;
      }

      if (data === "LIST_RPCS") {
        const status = getRpcCoreStatus();
        const lines = (status?.endpoints || [])
          .map((e) => `${e.active ? "⭐ " : "  "}${e.url}`)
          .join("\n");
        const header = `Available RPC Endpoints${
          status?.summary?.active ? `\nActive: ${status.summary.active}` : ""
        }`;
        await bot.editMessageText(
          `${header}\n\n${lines || "(none configured)"}`,
          {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: buildRpcSettingsMenu(chatId).reply_markup,
          }
        );
        return;
      }

      if (data === "ROTATE_RPC") {
        const next = rotateRpc("manual_ui");
        try {
          await bot.answerCallbackQuery(query.id, {
            text: next ? `Rotated to: ${next}` : "No endpoints",
          });
        } catch {}
        await bot.editMessageReplyMarkup(
          buildRpcSettingsMenu(chatId).reply_markup,
          {
            chat_id: chatId,
            message_id: messageId,
          }
        );
        return;
      }

      if (data === "CYCLE_RPC_STRATEGY") {
        const order = ["conservative", "balanced", "aggressive"];
        const cur = (
          getUserState(chatId).rpcStrategy || "balanced"
        ).toLowerCase();
        const idx = order.indexOf(cur);
        const next = order[(idx + 1) % order.length];
        updateUserSetting(chatId, "rpcStrategy", next);
        await bot.editMessageReplyMarkup(
          buildRpcSettingsMenu(chatId).reply_markup,
          {
            chat_id: chatId,
            message_id: messageId,
          }
        );
        try {
          await bot.answerCallbackQuery(query.id, {
            text: `Strategy: ${next}`,
          });
        } catch {}
        return;
      }

      if (data === "CYCLE_RELAY_VENDOR") {
        const allowed = ["auto", "jito", "bloxroute", "flashbots", "generic"];
        const cur = (getRelayVendor?.() || "auto").toLowerCase();
        const idx = allowed.indexOf(cur);
        const next = allowed[(idx + 1) % allowed.length];
        try { setRelayVendor(next); } catch {}
        await bot.editMessageReplyMarkup(
          buildRpcSettingsMenu(chatId).reply_markup,
          {
            chat_id: chatId,
            message_id: messageId,
          }
        );
        try { await bot.answerCallbackQuery(query.id, { text: `Vendor: ${next}` }); } catch {}
        return;
      }

      if (data === "ADD_RPC") {
        setPendingInput(chatId, { type: "ADD_RPC_URL", data: { messageId } });
        await bot.sendMessage(
          chatId,
          "Send the RPC HTTPS URL to add (e.g., https://api.mainnet-beta.solana.com)"
        );
        return;
      }

      if (data === "SET_GRPC") {
        setPendingInput(chatId, { type: "SET_GRPC_URL", data: { messageId } });
        await bot.sendMessage(
          chatId,
          "Send the gRPC endpoint URL to set (e.g., http://localhost:10000)"
        );
        return;
      }

      if (data === "SET_RELAY_ENDPOINT_URL") {
        setPendingInput(chatId, { type: "SET_RELAY_ENDPOINT_URL", data: { messageId } });
        await bot.sendMessage(
          chatId,
          "Send the private relay endpoint URL (e.g., https://api.blxr.com or https://relay.flashbots.net)"
        );
        return;
      }

      if (data === "SET_RELAY_API_KEY") {
        setPendingInput(chatId, { type: "SET_RELAY_API_KEY", data: { messageId } });
        await bot.sendMessage(
          chatId,
          "Send the API key for the private relay (stored in-memory only, not persisted to disk)"
        );
        return;
      }

      if (data === "TRADING_TOOLS") {
        try { await bot.answerCallbackQuery(query.id, { text: "Trading Tools" }); } catch {}
        try {
          await bot.editMessageText("🛠 Trading Tools", {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: buildTradingToolsMenu().reply_markup,
          });
        } catch (e) {
          await bot.sendMessage(chatId, "🛠 Trading Tools", {
            reply_markup: buildTradingToolsMenu().reply_markup,
          });
        }
        return;
      }

      if (data === "AUTOMATION") {
        try { await bot.answerCallbackQuery(query.id, { text: "Automation" }); } catch {}
        try {
          await bot.editMessageText("🤖 Automation", {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: buildAutomationMenu(chatId).reply_markup,
          });
        } catch (e) {
          await bot.sendMessage(chatId, "🤖 Automation", {
            reply_markup: buildAutomationMenu(chatId).reply_markup,
          });
        }
        return;
      }

      if (data === "DELTA_SETTINGS") {
        try { await bot.answerCallbackQuery(query.id, { text: "Delta Settings" }); } catch {}
        try {
          await bot.editMessageText("📊 Delta Settings", {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: buildDeltaSettingsMenu(chatId).reply_markup,
          });
        } catch (e) {
          await bot.sendMessage(chatId, "📊 Delta Settings", {
            reply_markup: buildDeltaSettingsMenu(chatId).reply_markup,
          });
        }
        return;
      }

      if (data.startsWith("REBUY_")) {
        const mint = data.slice("REBUY_".length);
        try { await bot.answerCallbackQuery(query.id, { text: "Re-Buy" }); } catch {}
        const st = getUserState(chatId);
        const last = Number(st?.lastAmounts?.[mint] || st?.defaultBuySol || 0.05);
        setPendingInput(chatId, { type: "QUICK_BUY_AMOUNT", tokenAddress: mint });
        await bot.sendMessage(
          chatId,
          `💰 Quick Buy - ${mint}\n\nEnter amount in SOL (last: ${last} SOL):`
        );
        return;
      }

      if (data.startsWith("REQUOTE_")) {
        const mint = data.slice("REQUOTE_".length);
        try { await bot.answerCallbackQuery(query.id, { text: "Re-Quote" }); } catch {}
        const st = getUserState(chatId);
        const last = Number(st?.lastAmounts?.[mint] || st?.defaultBuySol || 0.05);
        setPendingInput(chatId, { type: "QUOTE_AMOUNT", tokenAddress: mint });
        await bot.sendMessage(
          chatId,
          `💰 Quote - ${mint}\n\nEnter amount in SOL to quote (last: ${last} SOL):`
        );
        return;
      }

      if (data === "MAIN_MENU") {
        try { await bot.answerCallbackQuery(query.id, { text: "Main Menu" }); } catch {}
        try {
          await bot.editMessageText("🏠 Main Menu", {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: buildMainMenu(chatId).reply_markup,
          });
        } catch (e) {
          await bot.sendMessage(chatId, "🏠 Main Menu", {
            reply_markup: buildMainMenu(chatId).reply_markup,
          });
        }
        return;
      }

      if (data === "SNIPE_DEFAULTS") {
        try { await bot.answerCallbackQuery(query.id, { text: "Snipe Defaults" }); } catch {}
        try {
          await bot.editMessageText("🎯 Snipe Defaults", {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: buildSnipeDefaultsMenu(chatId).reply_markup,
          });
        } catch (e) {
          await bot.sendMessage(chatId, "🎯 Snipe Defaults", {
            reply_markup: buildSnipeDefaultsMenu(chatId).reply_markup,
          });
        }
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
          try { await bot.answerCallbackQuery(query.id, { text: "Wallets" }); } catch {}
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
          "TOGGLE_BEHAVIOR",
          "TOGGLE_MULTIHOP",
          "TOGGLE_FUNDING",
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
          TOGGLE_BEHAVIOR: "enableBehaviorProfiling",
          TOGGLE_MULTIHOP: "enableMultiHopCorrelation",
          TOGGLE_FUNDING: "enableFundingPathAnalysis",
        };
        const key = keyMap[data];
        const current = getUserState(chatId)[key];
        updateUserSetting(chatId, key, !current);
        const isRpcPage = (query?.message?.text || "").startsWith(
          "🌐 RPC Settings"
        );
        const markup = isRpcPage
          ? buildRpcSettingsMenu(chatId).reply_markup
          : buildTurboSolSettingsMenu(chatId).reply_markup;
        await bot.editMessageReplyMarkup(markup, {
          chat_id: chatId,
          message_id: messageId,
        });
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

      // Pre-LP scanner toggle (Automation menu)
      if (data === "PRELP_TOGGLE") {
        try {
          const current = !!getUserState(chatId).preLPWatchEnabled;
          const next = !current;
          updateUserSetting(chatId, "preLPWatchEnabled", next);
          if (next) {
            await startPreLPWatch(chatId, {
              onEvent: (ev) => { try { bot.sendMessage(chatId, typeof ev === 'string' ? ev : ev?.type || 'prelp'); } catch {} },
              onSnipeEvent: (mint, m) => { try { bot.sendMessage(chatId, `[PreLP ${mint}] ${m}`); } catch {} },
              autoSnipeOnPreLP: true,
            });
          } else {
            try { stopPreLPWatch(chatId); } catch {}
          }
          try { await bot.answerCallbackQuery(query.id, { text: next ? "Pre-LP ON" : "Pre-LP OFF" }); } catch {}
          await bot.editMessageReplyMarkup(
            buildAutomationMenu(chatId).reply_markup,
            { chat_id: chatId, message_id: messageId }
          );
        } catch (e) {
          try { await bot.answerCallbackQuery(query.id, { text: "Toggle failed" }); } catch {}
        }
        return;
      }

      // Liquidity Delta heuristic toggle (Automation menu)
      if (data === "DELTA_TOGGLE") {
        try {
          const cur = !!getUserState(chatId).liqDeltaEnabled;
          const next = !cur;
          updateUserSetting(chatId, "liqDeltaEnabled", next);
          try { await bot.answerCallbackQuery(query.id, { text: next ? "Delta ON" : "Delta OFF" }); } catch {}
          await bot.editMessageReplyMarkup(
            buildAutomationMenu(chatId).reply_markup,
            { chat_id: chatId, message_id: messageId }
          );
        } catch (e) {
          try { await bot.answerCallbackQuery(query.id, { text: "Toggle failed" }); } catch {}
        }
        return;
      }

      // Pump.fun alerts toggle
      if (data === "PUMPFUN_TOGGLE") {
        try {
          const current = getUserState(chatId).pumpFunAlerts;
          const next = !current;
          updateUserSetting(chatId, "pumpFunAlerts", next);
          if (next) {
            // Start PumpPortal WebSocket listener for new launches (avoids HTTP 530)
            try {
              const existing = pumpPollers.get(chatId);
              if (existing) {
                try { existing.stop(); } catch {}
                pumpPollers.delete(chatId);
              }
              const poller = new PumpPortalListener({ apiKey: process.env.PUMPPORTAL_API_KEY });
              poller.on("new_launch", async (coin) => {
                try {
                  const state = getUserState(chatId);
                  const defaultBuy = state.defaultBuySol ?? 0.05;
                  const mint = coin?.mint;
                  if (!mint) return;
                  await bot.sendMessage(
                    chatId,
                    `🚨 Pump.fun launch detected\n\n${coin.symbol || ""} ${coin.name ? `(${coin.name})` : ""}\nMint: ${mint}\nMC: ${coin.marketCap || 0}\nCreator: ${coin.creator || "?"}\n\nChoose an action:`,
                    {
                      reply_markup: {
                        inline_keyboard: [
                          [
                            { text: `Quick Buy ${defaultBuy} SOL`, callback_data: `AUTO_BUY_${mint}_${defaultBuy}` },
                            { text: "Quote", callback_data: `AUTO_QUOTE_${mint}_${defaultBuy}` },
                          ],
                          [
                            { text: "Buy (set amount)", callback_data: `START_BUY_${mint}` },
                          ],
                        ],
                      },
                    }
                  );
                } catch (e) {
                  console.error("Failed to send Pump.fun alert message:", e);
                }
              });
              poller.start();
              pumpPollers.set(chatId, poller);
            } catch (e) {
              console.error("Failed to start Pump.fun poller:", e);
            }
          } else {
            // Stop listener if active
            try {
              const existing = pumpPollers.get(chatId);
              if (existing) {
                try { existing.stop(); } catch {}
                pumpPollers.delete(chatId);
              }
            } catch (e) {
              console.warn("Pump.fun poller stop error:", e?.message || e);
            }
            // Also stop any legacy log-based listener if running
            try {
              stopPumpFunListener(chatId);
            } catch (e) {
              console.warn("stopPumpFunListener error:", e?.message || e);
            }
          }
          await bot.answerCallbackQuery(query.id, {
            text: next ? "Pump.fun alerts enabled" : "Pump.fun alerts disabled",
          });
          await bot.editMessageReplyMarkup(
            buildAutomationMenu(chatId).reply_markup,
            {
              chat_id: chatId,
              message_id: messageId,
            }
          );
        } catch (e) {
          console.error("PUMPFUN_TOGGLE error:", e);
          await bot.answerCallbackQuery(query.id, { text: "Toggle failed" });
        }
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

      // Delta Settings numeric inputs
      if (
        [
          "SET_DELTA_PROBE",
          "SET_DELTA_IMPROV",
          "SET_DELTA_IMPACT",
          "SET_DELTA_AGE",
        ].includes(data)
      ) {
        const promptMap = {
          SET_DELTA_PROBE: "Send probe size in SOL for delta tracking (e.g., 0.1)",
          SET_DELTA_IMPROV: "Send minimum improvement percent to fire (e.g., 3)",
          SET_DELTA_IMPACT: "Send maximum acceptable price impact percent (e.g., 8)",
          SET_DELTA_AGE: "Send minimum route age in milliseconds (e.g., 1500)",
        };
        const type = data;
        setPendingInput(chatId, { type, data: { messageId } });
        await bot.sendMessage(chatId, promptMap[type]);
        return;
      }
    }
  });

  // Handle text messages
  bot.on("message", async (msg) => {
    const text = msg.text;
    const chatId = msg.chat.id;
    if (!text || text.startsWith("/")) return;

    try {
      const state = getUserState(chatId);

      // Detect pasted Jupiter Quote URL and offer Quote/Buy actions directly
      if (!state.pendingInput && /quote-api\.jup\.ag\/v6\/quote/.test(text)) {
        try {
          const url = new URL(text.trim());
          const outputMint = url.searchParams.get("outputMint");
          const amountRaw = url.searchParams.get("amount");
          const slippageBpsQS = url.searchParams.get("slippageBps");
          if (outputMint && amountRaw) {
            const amountSol = Number(amountRaw) / 1e9;
            const slippageBps = slippageBpsQS
              ? Number(slippageBpsQS)
              : undefined;
            const res = await getTokenQuote({
              inputMint: "So11111111111111111111111111111111111111112",
              outputMint,
              amountSol,
              slippageBps,
            });
            const impact =
              res?.priceImpactPct != null ? `${res.priceImpactPct}%` : "?";
            const out =
              typeof res?.outAmountFormatted === "number"
                ? res.outAmountFormatted
                : Number(res?.outAmountFormatted || 0);
            const outStr = Number.isFinite(out) ? out.toFixed(6) : "?";
            await bot.sendMessage(
              chatId,
              `Quote for ${amountSol} SOL -> ${outputMint}: ${outStr} tokens (impact ${impact})`,
              {
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: "Buy",
                        callback_data: `AUTO_BUY_${outputMint}_${amountSol}`,
                      },
                      {
                        text: "Quote",
                        callback_data: `AUTO_QUOTE_${outputMint}_${amountSol}`,
                      },
                    ],
                  ],
                },
              }
            );
            return;
          }
        } catch (e) {
          // ignore parsing errors and continue to other handlers
        }
      }

      // Detect a plain token address (mint) and offer Buy/Quote options with amount prompt
      if (!state.pendingInput) {
        try {
          const normalizedMint = new PublicKey(text.trim()).toBase58();
          const defaultBuy = state.defaultBuySol ?? 0.05;
          await bot.sendMessage(
            chatId,
            `Token detected: ${normalizedMint}\n\nChoose an action:`,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "Buy (set amount)",
                      callback_data: `START_BUY_${normalizedMint}`,
                    },
                    {
                      text: "Quote (set amount)",
                      callback_data: `START_QUOTE_${normalizedMint}`,
                    },
                  ],
                  [
                    {
                      text: `Quick Buy ${defaultBuy} SOL`,
                      callback_data: `AUTO_BUY_${normalizedMint}_${defaultBuy}`,
                    },
                  ],
                ],
              },
            }
          );
          return;
        } catch (e) {
          // not a valid mint, continue to other handlers
        }
      }

      if (state.pendingInput?.type === "IMPORT_WALLET") {
        try {
          const pub = await importUserWallet(chatId, text.trim());
          await bot.sendMessage(
            chatId,
            `Wallet imported: ${shortenAddress(pub)}`
          );
        } catch (e) {
          await bot.sendMessage(chatId, `Import failed: ${e?.message || e}`);
        }
        setPendingInput(chatId, null);
        return;
      }

      if (state.pendingInput?.type === "ADD_RPC_URL") {
        const url = (msg.text || "").trim();
        try {
          if (!/^https?:\/\//i.test(url))
            throw new Error("Must start with http(s)://");
          addRpcEndpoint(url);
          await bot.sendMessage(chatId, `✅ RPC added: ${url}`);
          await bot.sendMessage(chatId, "RPC Settings updated:", {
            reply_markup: buildRpcSettingsMenu(chatId).reply_markup,
          });
        } catch (e) {
          await bot.sendMessage(
            chatId,
            `❌ Failed to add RPC: ${e?.message || e}`
          );
        }
        setPendingInput(chatId, null);
        return;
      }

      if (state.pendingInput?.type === "SET_GRPC_URL") {
        const url = (msg.text || "").trim();
        try {
          if (!/^https?:\/\//i.test(url) && !/^grpc(s)?:\/\//i.test(url)) {
            // allow raw host:port as well
            if (!/^[\w.-]+:\d+$/.test(url))
              throw new Error("Provide http(s):// or grpc(s):// or host:port");
          }
          setGrpcEndpoint(url);
          await bot.sendMessage(chatId, `✅ gRPC set: ${url}`);
          await bot.sendMessage(chatId, "RPC Settings updated:", {
            reply_markup: buildRpcSettingsMenu(chatId).reply_markup,
          });
        } catch (e) {
          await bot.sendMessage(
            chatId,
            `❌ Failed to set gRPC: ${e?.message || e}`
          );
        }
        setPendingInput(chatId, null);
        return;
      }

      if (state.pendingInput?.type === "SET_RELAY_ENDPOINT_URL") {
        const url = (msg.text || "").trim();
        try {
          if (!/^https?:\/\//i.test(url)) throw new Error("Must start with http(s)://");
          setPrivateRelayEndpoint(url);
          await bot.sendMessage(chatId, `✅ Private relay endpoint set: ${url}`);
          await bot.sendMessage(chatId, "RPC Settings updated:", {
            reply_markup: buildRpcSettingsMenu(chatId).reply_markup,
          });
        } catch (e) {
          await bot.sendMessage(chatId, `❌ Failed to set relay endpoint: ${e?.message || e}`);
        }
        setPendingInput(chatId, null);
        return;
      }

      if (state.pendingInput?.type === "SET_RELAY_API_KEY") {
        const key = (msg.text || "").trim();
        try {
          if (!key) throw new Error("Key cannot be empty");
          setPrivateRelayApiKey(key);
          await bot.sendMessage(chatId, `✅ Private relay API key set.`);
          await bot.sendMessage(chatId, "RPC Settings updated:", {
            reply_markup: buildRpcSettingsMenu(chatId).reply_markup,
          });
        } catch (e) {
          await bot.sendMessage(chatId, `❌ Failed to set relay API key: ${e?.message || e}`);
        }
        setPendingInput(chatId, null);
        return;
      }

      // Global Fee Settings: set static priority fee lamports
      if (state.pendingInput?.type === "SET_PRIORITY_FEE") {
        const raw = (msg.text || "").trim();
        const val = Number(raw);
        if (!Number.isFinite(val) || val < 0) {
          await bot.sendMessage(chatId, "❌ Invalid number. Send 0 or a positive integer lamports value.");
          return;
        }
        setPriorityFeeLamports(val);
        setPendingInput(chatId, null);
        if (val === 0) {
          await bot.sendMessage(chatId, "✅ Auto priority fee enabled (static tip set to 0)");
        } else {
          await bot.sendMessage(chatId, `✅ Global priority fee set to ${val} lamports`);
        }
        await bot.sendMessage(chatId, "💰 Fee Settings updated:", {
          reply_markup: buildFeeSettingsMenu(chatId).reply_markup,
        });
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
          await bot.sendMessage(chatId, `Rename failed: ${e?.message || e}`);
        }
        setPendingInput(chatId, null);
        return;
      }

      // Delta Settings: probe size (SOL)
      if (state.pendingInput?.type === "SET_DELTA_PROBE") {
        const sol = parseFloat((msg.text || "").trim());
        if (!Number.isFinite(sol) || sol <= 0) {
          await bot.sendMessage(chatId, "❌ Invalid amount. Send a positive number in SOL.");
          return;
        }
        updateUserSetting(chatId, "liqDeltaProbeSol", sol);
        setPendingInput(chatId, null);
        await bot.sendMessage(chatId, `✅ Delta probe size set to ${sol} SOL`);
        await bot.sendMessage(chatId, "📊 Delta Settings updated:", {
          reply_markup: buildDeltaSettingsMenu(chatId).reply_markup,
        });
        return;
      }

      // Delta Settings: minimum improvement threshold (%)
      if (state.pendingInput?.type === "SET_DELTA_IMPROV") {
        const pct = parseFloat((msg.text || "").trim());
        if (!Number.isFinite(pct) || pct < 0) {
          await bot.sendMessage(chatId, "❌ Invalid percent. Send a non-negative number.");
          return;
        }
        updateUserSetting(chatId, "liqDeltaMinImprovPct", pct);
        setPendingInput(chatId, null);
        await bot.sendMessage(chatId, `✅ Delta min improvement set to ${pct}%`);
        await bot.sendMessage(chatId, "📊 Delta Settings updated:", {
          reply_markup: buildDeltaSettingsMenu(chatId).reply_markup,
        });
        return;
      }

      // Delta Settings: maximum price impact (%)
      if (state.pendingInput?.type === "SET_DELTA_IMPACT") {
        const pct = parseFloat((msg.text || "").trim());
        if (!Number.isFinite(pct) || pct <= 0) {
          await bot.sendMessage(chatId, "❌ Invalid percent. Send a positive number.");
          return;
        }
        updateUserSetting(chatId, "deltaMaxPriceImpactPct", pct);
        setPendingInput(chatId, null);
        await bot.sendMessage(chatId, `✅ Delta max price impact set to ${pct}%`);
        await bot.sendMessage(chatId, "📊 Delta Settings updated:", {
          reply_markup: buildDeltaSettingsMenu(chatId).reply_markup,
        });
        return;
      }

      // Snipe Defaults: set per-chat max snipe gas price (priority fee)
      if (state.pendingInput?.type === "SET_SNIPE_FEE") {
        const raw = (msg.text || "").trim();
        const val = Number(raw);
        if (!Number.isFinite(val) || val < 0) {
          await bot.sendMessage(chatId, "❌ Invalid number. Send 0 or a positive integer lamports value.");
          return;
        }
        // 0 => auto (fallback to global/auto tip); store 0 so UI shows 'auto'
        const storeVal = val;
        updateUserSetting(chatId, "maxSnipeGasPrice", storeVal);
        setPendingInput(chatId, null);
        if (storeVal === 0) {
          await bot.sendMessage(chatId, "✅ Snipe priority fee set to auto");
        } else {
          await bot.sendMessage(chatId, `✅ Snipe max priority fee set to ${storeVal} lamports`);
        }
        await bot.sendMessage(chatId, "🎯 Snipe Defaults updated:", {
          reply_markup: buildSnipeDefaultsMenu(chatId).reply_markup,
        });
        return;
      }

      // Delta Settings: minimum route age (ms)
      if (state.pendingInput?.type === "SET_DELTA_AGE") {
        const ms = parseInt((msg.text || "").trim(), 10);
        if (!Number.isFinite(ms) || ms < 0) {
          await bot.sendMessage(chatId, "❌ Invalid number. Send a non-negative integer.");
          return;
        }
        updateUserSetting(chatId, "deltaMinRouteAgeMs", ms);
        setPendingInput(chatId, null);
        await bot.sendMessage(chatId, `✅ Delta min route age set to ${ms} ms`);
        await bot.sendMessage(chatId, "📊 Delta Settings updated:", {
          reply_markup: buildDeltaSettingsMenu(chatId).reply_markup,
        });
        return;
      }

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

      if (state.pendingInput?.type === "QUICK_BUY_AMOUNT") {
        try {
          const { tokenAddress } = state.pendingInput;
          const amountSol =
            parseFloat(text.trim()) || (state.defaultBuySol ?? 0.05);
          try { const s = getUserState(chatId); s.lastAmounts = s.lastAmounts || {}; s.lastAmounts[tokenAddress] = amountSol; } catch {}
          if (amountSol <= 0) {
            await bot.sendMessage(
              chatId,
              "❌ Invalid amount. Please enter a positive number."
            );
            return;
          }
          // Enforce daily spend cap
          try {
            const cap = getDailyCap(chatId);
            const spent = getDailySpent(chatId);
            const remaining = getRemainingDailyCap(chatId);
            if (Number.isFinite(cap) && amountSol > remaining + 1e-9) {
              await bot.sendMessage(
                chatId,
                `🚫 Daily spend cap reached. Tier: ${state.tier}. Cap: ${cap} SOL. Spent today: ${spent.toFixed(4)} SOL. Remaining: ${Math.max(0, remaining).toFixed(4)} SOL.`
              );
              setPendingInput(chatId, null);
              return;
            }
          } catch {}
          if (!canProceed(chatId, "QUICK_BUY_EXECUTE", 1600)) {
            await bot.sendMessage(
              chatId,
              "⏳ Please wait a moment before sending another buy."
            );
            return;
          }
          if (!(await hasUserWallet(chatId))) {
            await bot.sendMessage(
              chatId,
              "No wallet linked. Use /setup to create or /import <privateKeyBase58> to link your wallet."
            );
            return;
          }
          let swapPromise;
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
                `❌ Risk check failed: ${risk.reason}`
              );
              setPendingInput(chatId, null);
              return;
            }
            const priorityFeeLamports = getPriorityFeeLamports();
            const useJitoBundle = getUseJitoBundle();
            await bot.sendMessage(
              chatId,
              `⏳ Placing buy ${amountSol} SOL into ${tokenAddress}...`
            );
            swapPromise = performSwap({
              inputMint: "So11111111111111111111111111111111111111112",
              outputMint: tokenAddress,
              amountSol,
              priorityFeeLamports,
              useJitoBundle,
              chatId,
            });
            const TIMEOUT_MS = Number(process.env.SWAP_TIMEOUT_MS || 18000);
            await promiseWithTimeout(swapPromise, TIMEOUT_MS, "swap_timeout");
            const swapRes = await swapPromise;
            setPendingInput(chatId, null);
            const txid =
              swapRes?.txid ||
              (Array.isArray(swapRes?.txids) ? swapRes.txids[0] : null);
            if (!txid) throw new Error("Swap succeeded but no txid returned");
            const solscan = `https://solscan.io/tx/${txid}`;
            const symbol = swapRes?.output?.symbol || "TOKEN";
            const tokOut =
              typeof swapRes?.output?.tokensOut === "number"
                ? swapRes.output.tokensOut.toFixed(4)
                : "?";
            const impact =
              swapRes?.route?.priceImpactPct != null
                ? `${swapRes.route.priceImpactPct}%`
                : "?";
            await bot.sendMessage(
              chatId,
              `✅ Buy sent\n• Token: ${symbol} (${tokenAddress})\n• Amount: ${amountSol} SOL\n• Est. Tokens: ${tokOut}\n• Route: ${
                swapRes?.route?.labels || "route"
              }\n• Price impact: ${impact}\n• Slippage: ${
                swapRes?.slippageBps
              } bps\n• Priority fee: ${swapRes?.priorityFeeLamports}\n• Via: ${
                swapRes?.via
              }\n• Latency: ${
                swapRes?.latencyMs
              } ms\n• Tx: ${txid}\n🔗 ${solscan}`
            );
            // Record buy trade log with racing telemetry
            addTradeLog(chatId, {
              kind: "buy",
              mint: tokenAddress,
              sol: Number(amountSol),
              tokens: Number(swapRes?.output?.tokensOut ?? NaN),
              route: swapRes?.route?.labels,
              priceImpactPct: swapRes?.route?.priceImpactPct ?? null,
              slippageBps: swapRes?.slippageBps,
              priorityFeeLamports: swapRes?.priorityFeeLamports,
              via: swapRes?.via,
              latencyMs: swapRes?.latencyMs,
              txid,
              lastSendRaceWinner: swapRes?.lastSendRaceWinner ?? null,
              lastSendRaceAttempts: swapRes?.lastSendRaceAttempts ?? 0,
              lastSendRaceLatencyMs: swapRes?.lastSendRaceLatencyMs ?? null,
            });
            // Follow-up: notify on confirmation or failure
            notifyTxStatus(chatId, txid, { kind: "Buy" }).catch(() => {});
          } catch (e) {
            if (String(e?.message || "").includes("swap_timeout")) {
              await bot.sendMessage(
                chatId,
                "⏱️ The buy is taking longer than expected due to network congestion. It may still complete. Check /positions or /lasttx in a moment."
              );
              swapPromise
                .then((res) => {
                  const txid =
                    res?.txid ||
                    (Array.isArray(res?.txids) ? res.txids[0] : null);
                  if (!txid)
                    return bot.sendMessage(
                      chatId,
                      "⚠️ Swap finished but no transaction id was returned."
                    );
                  const solscan = `https://solscan.io/tx/${txid}`;
                  const symbol = res?.output?.symbol || "TOKEN";
                  const tokOut =
                    typeof res?.output?.tokensOut === "number"
                      ? res.output.tokensOut.toFixed(4)
                      : "?";
                  const impact =
                    res?.route?.priceImpactPct != null
                      ? `${res.route.priceImpactPct}%`
                      : "?";
                  // Record buy trade log with racing telemetry (delayed follow-up)
                  addTradeLog(chatId, {
                    kind: "buy",
                    mint: tokenAddress,
                    sol: Number(amountSol),
                    tokens: Number(res?.output?.tokensOut ?? NaN),
                    route: res?.route?.labels,
                    priceImpactPct: res?.route?.priceImpactPct ?? null,
                    slippageBps: res?.slippageBps,
                    priorityFeeLamports: res?.priorityFeeLamports,
                    via: res?.via,
                    latencyMs: res?.latencyMs,
                    txid,
                    lastSendRaceWinner: res?.lastSendRaceWinner ?? null,
                    lastSendRaceAttempts: res?.lastSendRaceAttempts ?? 0,
                    lastSendRaceLatencyMs: res?.lastSendRaceLatencyMs ?? null,
                  });
                  // Notify user completed
                  notifyTxStatus(chatId, txid, { kind: "Buy" }).catch(() => {});
                  return bot.sendMessage(
                    chatId,
                    `✅ Buy completed\n• Token: ${symbol} (${tokenAddress})\n• Amount: ${amountSol} SOL\n• Est. Tokens: ${tokOut}\n• Route: ${
                      res?.route?.labels || "route"
                    }\n• Price impact: ${impact}\n• Slippage: ${
                      res?.slippageBps
                    } bps\n• Priority fee: ${
                      res?.priorityFeeLamports
                    }\n• Via: ${res?.via}\n• Latency: ${
                      res?.latencyMs
                    } ms\n• Tx: ${txid}\n🔗 ${solscan}`
                  );
                })
                .catch((err) =>
                  bot.sendMessage(
                    chatId,
                    `❌ Buy failed after timeout: ${err?.message || err}`
                  )
                );

              const FINAL_TIMEOUT_MS = Number(
                process.env.SWAP_FINAL_TIMEOUT_MS || 120000
              );
              promiseWithTimeout(
                swapPromise,
                FINAL_TIMEOUT_MS,
                "swap_final_timeout"
              ).catch((err2) => {
                if (
                  String(err2?.message || "").includes("swap_final_timeout")
                ) {
                  bot.sendMessage(
                    chatId,
                    "⌛ Still no confirmation after 120s. The transaction may still land. Check /positions or /lasttx shortly. If you see a txid above, you can also track it on Solscan."
                  );
                }
              });
            } else {
              const msg = String(e?.message || "");
              if (msg.includes("no_quote_route")) {
                await bot.sendMessage(
                  chatId,
                  "❌ No swap route available right now.\n• The token may not have liquidity yet or routing is saturated.\n• I retried with higher slippage and a longer quote timeout automatically.\n• Try again in a few seconds, increase slippage in Settings > Trading Tools, or wait for LP to initialize."
                );
              } else {
                await bot.sendMessage(
                  chatId,
                  `❌ Quick Buy failed: ${e?.message || e}`
                );
              }
              // Record failed buy attempt with reason for telemetry
              try {
                const failMsg = (e?.message || String(e)).slice(0, 300);
                addTradeLog(chatId, {
                  kind: "status",
                  statusOf: "buy",
                  mint: tokenAddress,
                  sol: Number(amountSol),
                  status: "failed",
                  failReason: failMsg,
                });
              } catch {}
            }
          }
        } catch (err) {
          await bot.sendMessage(
            chatId,
            `❌ Quick Buy error: ${err?.message || err}`
          );
          try {
            const failMsg = (err?.message || String(err)).slice(0, 300);
            addTradeLog(chatId, {
              kind: "status",
              statusOf: "buy",
              mint: tokenAddress,
              sol: Number(amountSol),
              status: "failed",
              failReason: failMsg,
            });
          } catch {}
        }
        setPendingInput(chatId, null);
        return;
      }

      // Handle Quick Sell flow: ask for token, then percent, then execute
      if (state.pendingInput?.type === "QUICK_SELL_TOKEN") {
        const textIn = msg.text?.trim();
        const normalizedMint = textIn;
        try {
          new PublicKey(normalizedMint);
        } catch (e) {
          await bot.sendMessage(
            chatId,
            "❌ Invalid token address. Please send a valid Solana token address."
          );
          return;
        }
        setPendingInput(chatId, {
          type: "QUICK_SELL_PERCENT",
          tokenAddress: normalizedMint,
        });
        await bot.sendMessage(
          chatId,
          "What percent of your token balance to sell? Send a number 1-100. Default is 100."
        );
        return;
      }

      if (state.pendingInput?.type === "QUICK_SELL_PERCENT") {
        const { tokenAddress } = state.pendingInput;
        const raw = (msg.text || "").trim();
        let percent = Number(raw);
        if (!Number.isFinite(percent)) percent = 100;
        percent = Math.max(1, Math.min(100, Math.floor(percent)));
        if (!canProceed(chatId, "QUICK_SELL_EXECUTE", 1600)) {
          await bot.sendMessage(
            chatId,
            "⏳ Please wait a moment before sending another sell."
          );
          return;
        }
        if (!(await hasUserWallet(chatId))) {
          await bot.sendMessage(
            chatId,
            "No wallet linked. Use /setup to create or /import <privateKeyBase58> to link your wallet."
          );
          return;
        }
        try {
          const priorityFeeLamports = getPriorityFeeLamports();
          const useJitoBundle = getUseJitoBundle();
          await bot.sendMessage(
            chatId,
            `⏳ Placing quick sell of ${percent}% for token ${tokenAddress}...`
          );
          let swapPromise = quickSell({
            tokenMint: tokenAddress,
            percent,
            priorityFeeLamports,
            useJitoBundle,
            chatId,
          });
          const TIMEOUT_MS = Number(process.env.SWAP_TIMEOUT_MS || 18000);
          try {
            const sellRes = await promiseWithTimeout(
              swapPromise,
              TIMEOUT_MS,
              "swap_timeout"
            );
            setPendingInput(chatId, null);
            const txid =
              sellRes?.txid ||
              (Array.isArray(sellRes?.txids) ? sellRes.txids[0] : null);
            const solscan = txid ? `https://solscan.io/tx/${txid}` : "";
            const solOut =
              typeof sellRes?.output?.tokensOut === "number"
                ? sellRes.output.tokensOut.toFixed(6)
                : "?";
            const impact =
              typeof sellRes?.route?.priceImpactPct === "number"
                ? `${(sellRes.route.priceImpactPct * 100).toFixed(2)}%`
                : "?";
            await bot.sendMessage(
              chatId,
              `✅ Sell sent\n• Token: ${tokenAddress}\n• Percent: ${percent}%\n• Est. SOL Out: ${solOut}\n• Route: ${
                sellRes?.route?.labels || "route"
              }\n• Price impact: ${impact}\n• Slippage: ${
                sellRes?.slippageBps
              } bps\n• Priority fee: ${sellRes?.priorityFeeLamports}\n• Via: ${
                sellRes?.via
              }\n• Latency: ${
                sellRes?.latencyMs
              } ms\n• Tx: ${txid}\n🔗 ${solscan}`
            );
            addTradeLog(chatId, {
              kind: "sell",
              mint: tokenAddress,
              percent,
              sol: Number(sellRes?.output?.tokensOut ?? NaN),
              route: sellRes?.route?.labels,
              priceImpactPct: sellRes?.route?.priceImpactPct ?? null,
              slippageBps: sellRes?.slippageBps,
              priorityFeeLamports: sellRes?.priorityFeeLamports,
              via: sellRes?.via,
              latencyMs: sellRes?.latencyMs,
              txid,
              lastSendRaceWinner: sellRes?.lastSendRaceWinner ?? null,
              lastSendRaceAttempts: sellRes?.lastSendRaceAttempts ?? 0,
              lastSendRaceLatencyMs: sellRes?.lastSendRaceLatencyMs ?? null,
            });
            notifyTxStatus(chatId, txid, { kind: "Sell" }).catch(() => {});
          } catch (err) {
            if (err?.code === "swap_timeout") {
              await bot.sendMessage(
                chatId,
                "⏳ Network congestion: Sell may still land. We'll update shortly."
              );
              const FINAL_TIMEOUT_MS = Number(
                process.env.SWAP_FINAL_TIMEOUT_MS || 120000
              );
              try {
                const sellRes = await promiseWithTimeout(
                  swapPromise,
                  FINAL_TIMEOUT_MS,
                  "final_timeout"
                );
                setPendingInput(chatId, null);
                const txid =
                  sellRes?.txid ||
                  (Array.isArray(sellRes?.txids) ? sellRes.txids[0] : null);
                const solscan = txid ? `https://solscan.io/tx/${txid}` : "";
                const solOut =
                  typeof sellRes?.output?.tokensOut === "number"
                    ? sellRes.output.tokensOut.toFixed(6)
                    : "?";
                const impact =
                  typeof sellRes?.route?.priceImpactPct === "number"
                    ? `${(sellRes.route.priceImpactPct * 100).toFixed(2)}%`
                    : "?";
                await bot.sendMessage(
                  chatId,
                  `✅ Sell sent\n• Token: ${tokenAddress}\n• Percent: ${percent}%\n• Est. SOL Out: ${solOut}\n• Route: ${
                    sellRes?.route?.labels || "route"
                  }\n• Price impact: ${impact}\n• Slippage: ${
                    sellRes?.slippageBps
                  } bps\n• Priority fee: ${sellRes?.priorityFeeLamports}\n• Via: ${
                    sellRes?.via
                  }\n• Latency: ${
                    sellRes?.latencyMs
                  } ms\n• Tx: ${txid}\n🔗 ${solscan}`
                );
                try {
                  addTradeLog(chatId, {
                    kind: "sell",
                    mint: tokenAddress,
                    percent,
                    sol: Number(sellRes?.output?.tokensOut ?? NaN),
                    route: sellRes?.route?.labels,
                    priceImpactPct: sellRes?.route?.priceImpactPct ?? null,
                    slippageBps: sellRes?.slippageBps,
                    priorityFeeLamports: sellRes?.priorityFeeLamports,
                    via: sellRes?.via,
                    latencyMs: sellRes?.latencyMs,
                    txid,
                    lastSendRaceWinner:
                      sellRes?.lastSendRaceWinner ?? null,
                    lastSendRaceAttempts:
                      sellRes?.lastSendRaceAttempts ?? 0,
                    lastSendRaceLatencyMs:
                      sellRes?.lastSendRaceLatencyMs ?? null,
                  });
                  notifyTxStatus(chatId, txid, { kind: "Sell" }).catch(
                    () => {}
                  );
                } catch {}
              } catch (finalErr) {
                const code = finalErr?.code;
                if (code === "final_timeout") {
                  await bot.sendMessage(
                    chatId,
                    "⏳ Sell still pending. We'll notify you once it confirms."
                  );
                  try {
                    addTradeLog(chatId, {
                      kind: "status",
                      statusOf: "sell",
                      mint: tokenAddress,
                      percent,
                      status: "pending",
                    });
                  } catch {}
                } else {
                  const msgErr = (finalErr?.message || String(finalErr)).slice(
                    0,
                    300
                  );
                  await bot.sendMessage(
                    chatId,
                    `❌ Quick Sell failed: ${msgErr}`
                  );
                  try {
                    addTradeLog(chatId, {
                      kind: "status",
                      statusOf: "sell",
                      mint: tokenAddress,
                      percent,
                      status: "failed",
                      failReason: msgErr,
                    });
                  } catch {}
                }
              }
            } else {
              const msgErr = (err?.message || String(err)).slice(0, 300);
              await bot.sendMessage(chatId, `❌ Quick Sell failed: ${msgErr}`);
              try {
                addTradeLog(chatId, {
                  kind: "status",
                  statusOf: "sell",
                  mint: tokenAddress,
                  percent,
                  status: "failed",
                  failReason: msgErr,
                });
              } catch {}
            }
          }
        } catch (e) {
          const msgErr = (e?.message || String(e)).slice(0, 300);
          await bot.sendMessage(chatId, `❌ Quick Sell failed: ${msgErr}`);
          try {
            addTradeLog(chatId, {
              kind: "status",
              statusOf: "sell",
              mint: tokenAddress,
              percent,
              status: "failed",
              failReason: msgErr,
            });
          } catch {}
        }
        return;
      }

      // Quote flow: ask for token, then amount, then display quote
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
            `💰 Quote - ${normalizedMint}\n\nEnter amount in SOL to quote (default: ${defaultBuy} SOL):`
          );
        } catch (e) {
          await bot.sendMessage(
            chatId,
            "❌ Invalid token address. Please send a valid Solana token address."
          );
        }
        return;
      }

      if (state.pendingInput?.type === "QUOTE_AMOUNT") {
        try {
          const { tokenAddress } = state.pendingInput;
          const amountSol =
            parseFloat(text.trim()) || (state.defaultBuySol ?? 0.05);
          try { const s = getUserState(chatId); s.lastAmounts = s.lastAmounts || {}; s.lastAmounts[tokenAddress] = amountSol; } catch {}
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
          if (!res) {
            await bot.sendMessage(
              chatId,
              "❌ Quote failed: No route returned."
            );
            setPendingInput(chatId, null);
            return;
          }
          const impact =
            res?.priceImpactPct != null ? `${res.priceImpactPct}%` : "?";
          const out =
            typeof res?.outAmountFormatted === "number"
              ? res.outAmountFormatted
              : Number(res?.outAmountFormatted || 0);
          const outStr = Number.isFinite(out) ? out.toFixed(6) : "?";
          await bot.sendMessage(
            chatId,
            `Quote for ${amountSol} SOL -> ${tokenAddress}: ${outStr} tokens (impact ${impact})`,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "Buy",
                      callback_data: `AUTO_BUY_${tokenAddress}_${amountSol}`,
                    },
                    {
                      text: "Re-Quote",
                      callback_data: `AUTO_QUOTE_${tokenAddress}_${amountSol}`,
                    },
                  ],
                  [
                    { text: "Re-Buy (edit amount)", callback_data: `REBUY_${tokenAddress}` },
                    { text: "Re-Quote (edit amount)", callback_data: `REQUOTE_${tokenAddress}` },
                  ],
                ],
              },
            }
          );
        } catch (e) {
          await bot.sendMessage(chatId, `❌ Quote failed: ${e?.message || e}`);
        }
        setPendingInput(chatId, null);
        return;
      }
    } catch (outerErr) {
      console.error("Message handler error:", outerErr);
    }
  });
} // close startTelegramBot

// Helper: monitor a tx signature and notify user on success/failure
async function notifyTxStatus(chatId, txid, { kind = "Trade" } = {}) {
  try {
    if (!txid) return;
    const connection = getRpcConnection();
    const solscan = `https://solscan.io/tx/${txid}`;
    const maxWait = Number(process.env.TX_CONFIRM_MAX_WAIT_MS || 90000);
    const interval = Number(process.env.TX_CONFIRM_POLL_INTERVAL_MS || 2000);
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      try {
        const st = await connection.getSignatureStatuses([txid]);
        const s = st?.value?.[0];
        if (s) {
          if (s.err) {
            await bot.sendMessage(
              chatId,
              `❌ ${kind} failed\n• Tx: ${txid}\n🔗 ${solscan}`
            );
            try {
              addTradeLog(chatId, {
                kind: "status",
                statusOf: String(kind || "trade").toLowerCase(),
                txid,
                status: "failed",
              });
            } catch {}
            return;
          }
          const status = s.confirmationStatus;
          if (status === "finalized" || status === "confirmed") {
            await bot.sendMessage(
              chatId,
              `🎉 ${kind} confirmed\n• Tx: ${txid}\n🔗 ${solscan}`
            );
            try {
              addTradeLog(chatId, {
                kind: "status",
                statusOf: String(kind || "trade").toLowerCase(),
                txid,
                status: "confirmed",
              });
            } catch {}
            return;
          }
        }
      } catch (e) {
        // ignore transient RPC errors and keep polling
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    // Timed out waiting for confirmation
    await bot.sendMessage(
      chatId,
      `⏳ ${kind} still pending…\n• Tx: ${txid}\n🔗 ${solscan}`
    );
    try {
      addTradeLog(chatId, {
        kind: "status",
        statusOf: String(kind || "trade").toLowerCase(),
        txid,
        status: "pending",
      });
    } catch {}
  } catch (e) {
    console.error("notifyTxStatus error:", e?.message || e);
  }
}
