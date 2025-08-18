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
import { hasUserWallet, createUserWallet, importUserWallet, getUserPublicKey as getUserPk, listUserWallets, setActiveWallet, renameUserWallet } from "./userWallets.js";
import { getWalletInfo, shortenAddress } from "./walletInfo.js";
import { buildTurboSolMainMenu, buildTurboSolSettingsMenu, buildPositionsMenu, buildWalletsMenu, buildWalletDetailsMenu, buildSnipeDefaultsMenu } from "./menuBuilder.js";
import { getUserState, updateUserSetting, setPendingInput } from "./userState.js";
import { PublicKey } from "@solana/web3.js";

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

async function buildTurboSolWelcomeMessage(chatId) {
  if (await hasUserWallet(chatId)) {
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
      { command: "address", description: "Show wallet address" }
    ]);
    console.log('Bot commands registered successfully');
  } catch (e) {
    console.error('Failed to set bot commands:', e);
  }

  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const welcomeMessage = await buildTurboSolWelcomeMessage(chatId);
      await bot.sendMessage(chatId, welcomeMessage);
      await bot.sendMessage(chatId, "Choose an option:", {
        reply_markup: buildTurboSolMainMenu(),
      });
    } catch (e) {
      await bot.sendMessage(chatId, `🚀 Welcome to TurboSol!\n\nUse /setup to create a wallet or /import <privateKeyBase58>.`);
    }
  });

  // Setup a new wallet for this chat/user
  bot.onText(/\/setup/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      if (await hasUserWallet(chatId)) {
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
      if (!(await hasUserWallet(chatId))) return bot.sendMessage(chatId, `No wallet linked. Use /setup or /import`);
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
        return bot.sendMessage(chatId, "Choose an option:", { reply_markup: buildTurboSolMainMenu() });
      }
      if (data === "CLOSE_MENU") {
        try { await bot.deleteMessage(chatId, messageId); } catch {}
        return; 
      }

      if (data === "STOP_SNIPE") {
        stopLiquidityWatch(chatId);
        await bot.answerCallbackQuery(query.id, { text: "Stopped sniping" });
        await bot.sendMessage(chatId, "Stopped all active liquidity watches for this chat.");
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
          await bot.sendMessage(chatId, `No wallet linked. Use /setup to create or /import <privateKeyBase58>.`);
          return;
        }
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
          await bot.sendMessage(chatId, `No wallet linked. Use /setup to create or /import <privateKeyBase58>.`);
          return;
        }
        const s = getUserState(chatId);
        const priorityFeeLamports = s.maxSnipeGasPrice ?? getPriorityFeeLamports();
        const useJitoBundle = s.enableJitoForSnipes ?? getUseJitoBundle();
        const pollInterval = s.snipePollInterval;
        const slippageBps = s.snipeSlippage;
        const retryCount = s.snipeRetryCount;
        startLiquidityWatch(chatId, { mint, amountSol, priorityFeeLamports, useJitoBundle, pollInterval, slippageBps, retryCount, onEvent: (m) => bot.sendMessage(chatId, m) });
        await bot.sendMessage(chatId, `Watching for LP on ${mint}. Will buy ${amountSol} SOL when detected.`);
        return;
      }

      if (data.startsWith("DISMISS_")) {
        try { await bot.deleteMessage(chatId, messageId); } catch {}
        return;
      }

      // Settings submenu handling via callback
      if (data === "SETTINGS") {
        await bot.editMessageText("⚙️ TurboSol Settings", {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: buildTurboSolSettingsMenu(chatId).reply_markup
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
        const menu = await buildWalletsMenu(chatId);
        await bot.editMessageText("💼 Wallets — manage your wallets", {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: menu.reply_markup
        });
        return;
      }

      if (data === "CREATE_WALLET") {
        const res = await createUserWallet(chatId);
        await bot.answerCallbackQuery(query.id, { text: "Wallet created" });
        const menu = await buildWalletsMenu(chatId);
        await bot.editMessageReplyMarkup(menu.reply_markup, { chat_id: chatId, message_id: messageId });
        return;
      }

      if (data === "IMPORT_WALLET") {
        setPendingInput(chatId, { type: "IMPORT_WALLET" });
        await bot.sendMessage(chatId, "Send your private key in Base58 to import your wallet.\nWarning: Only share with trusted bots. You can revoke access anytime.");
        return;
      }

      if (data.startsWith("WALLET_DETAILS_")) {
        const walletId = data.replace("WALLET_DETAILS_", "");
        const details = await buildWalletDetailsMenu(chatId, walletId);
        await bot.editMessageText("💼 Wallet Details", { chat_id: chatId, message_id: messageId, reply_markup: details.reply_markup });
        return;
      }

      if (data.startsWith("SET_ACTIVE_")) {
        const walletId = data.replace("SET_ACTIVE_", "");
        await setActiveWallet(chatId, walletId);
        const details = await buildWalletDetailsMenu(chatId, walletId);
        await bot.editMessageReplyMarkup(details.reply_markup, { chat_id: chatId, message_id: messageId });
        return;
      }

      if (data.startsWith("RENAME_WALLET_")) {
        const walletId = data.replace("RENAME_WALLET_", "");
        setPendingInput(chatId, { type: "RENAME_WALLET", walletId });
        await bot.sendMessage(chatId, "Enter a new name for this wallet:");
        return;
      }

      if (data.startsWith("COPY_ADDRESS_")) {
        const walletId = data.replace("COPY_ADDRESS_", "");
        const wallets = await listUserWallets(chatId);
        const w = wallets.find(x => x.id === walletId);
        if (w) await bot.sendMessage(chatId, `Address: ${w.publicKey}`);
        return;
      }

      if (data.startsWith("DELETE_WALLET_")) {
        // For safety, we will not permanently delete yet; could implement soft delete
        await bot.answerCallbackQuery(query.id, { text: "Delete not implemented yet" });
        return;
      }

      // TurboSol Positions view
      if (data === "POSITIONS") {
        const state = getUserState(chatId);
        const hasPositions = (state.positions || []).length > 0;
        const body = hasPositions
          ? "You have open positions. Tap 'View All Positions' to see details."
          : "No open positions yet!\nStart your trading journey by pasting a contract address in chat.";
        await bot.editMessageText(`🚀 TurboSol Positions\n\n${body}` , {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: buildPositionsMenu(chatId).reply_markup
        });
        return;
      }

      if (data === "VIEW_ALL_POSITIONS") {
        const state = getUserState(chatId);
        const list = (state.positions || []);
        if (!list.length) {
          await bot.answerCallbackQuery(query.id, { text: "No positions" });
          return;
        }
        const lines = list.map((p, i) => {
          const t = new Date(p.timestamp).toLocaleString();
          const mintShort = shortenAddress ? shortenAddress(p.mint) : p.mint;
          const tokOut = (typeof p.tokensOut === 'number') ? Number(p.tokensOut).toFixed(4) : "?";
          const txShort = p.txid ? (p.txid.slice(0, 8) + "…" + p.txid.slice(-8)) : "";
          return `${i + 1}. ${p.symbol || "TOKEN"} (${mintShort}) — ${p.solIn} SOL -> ~${tokOut}  [${t}] ${txShort}`;
        }).join("\n");
        await bot.editMessageText(`📈 Open Positions\n\n${lines}`, {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "POSITIONS" }], [{ text: "🏠 Main", callback_data: "MAIN_MENU" }]] }
        });
        return;
      }

      // Toggle handlers for settings
      if (["TOGGLE_DEGEN", "TOGGLE_BUY_PROTECTION", "TOGGLE_EXPERT", "TOGGLE_PNL"].includes(data)) {
        const keyMap = {
          TOGGLE_DEGEN: 'degenMode',
          TOGGLE_BUY_PROTECTION: 'buyProtection',
          TOGGLE_EXPERT: 'expertMode',
          TOGGLE_PNL: 'privatePnl'
        };
        const key = keyMap[data];
        const current = getUserState(chatId)[key];
        updateUserSetting(chatId, key, !current);
        await bot.editMessageReplyMarkup(buildTurboSolSettingsMenu(chatId).reply_markup, {
          chat_id: chatId,
          message_id: messageId
        });
        return;
      }

      // Snipe Defaults toggles
      if (["TOGGLE_AUTO_SNIPE_PASTE", "TOGGLE_SNIPE_JITO"].includes(data)) {
        const keyMap = {
          TOGGLE_AUTO_SNIPE_PASTE: 'autoSnipeOnPaste',
          TOGGLE_SNIPE_JITO: 'enableJitoForSnipes',
        };
        const key = keyMap[data];
        const current = getUserState(chatId)[key];
        updateUserSetting(chatId, key, !current);
        await bot.editMessageReplyMarkup(buildSnipeDefaultsMenu(chatId).reply_markup, {
          chat_id: chatId,
          message_id: messageId,
        });
        return;
      }

      // Snipe Defaults numeric inputs
      if (["SET_DEFAULT_BUY", "SET_DEFAULT_SNIPE", "SET_SNIPE_SLIPPAGE", "SET_SNIPE_FEE", "SET_SNIPE_INTERVAL", "SET_SNIPE_RETRY"].includes(data)) {
        const promptMap = {
          SET_DEFAULT_BUY: "Send new default Buy amount in SOL (e.g., 0.05)",
          SET_DEFAULT_SNIPE: "Send new default Snipe amount in SOL (e.g., 0.05)",
          SET_SNIPE_SLIPPAGE: "Send snipe slippage in bps (e.g., 100 for 1%)",
          SET_SNIPE_FEE: "Send max priority fee lamports for snipes (or 0 for auto)",
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
          await bot.sendMessage(chatId, `Wallet imported: ${shortenAddress(pub)}`);
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
          await bot.sendMessage(chatId, `Wallet renamed to: ${text.slice(0, 24)}`);
        } catch (e) {
          await bot.sendMessage(chatId, `Rename failed: ${e.message || e}`);
        }
        setPendingInput(chatId, null);
        return;
      }

      // Handle pending Snipe Defaults numeric inputs
      if (["SET_DEFAULT_BUY", "SET_DEFAULT_SNIPE", "SET_SNIPE_SLIPPAGE", "SET_SNIPE_FEE", "SET_SNIPE_INTERVAL", "SET_SNIPE_RETRY"].includes(state.pendingInput?.type)) {
        const pending = state.pendingInput;
        const t = pending.type;
        const vNum = Number(text);
        if (Number.isNaN(vNum) || vNum < 0) {
          await bot.sendMessage(chatId, "Invalid number. Please try again.");
          return;
        }
        const keyMap = {
          SET_DEFAULT_BUY: 'defaultBuySol',
          SET_DEFAULT_SNIPE: 'defaultSnipeSol',
          SET_SNIPE_SLIPPAGE: 'snipeSlippage',
          SET_SNIPE_FEE: 'maxSnipeGasPrice',
          SET_SNIPE_INTERVAL: 'snipePollInterval',
          SET_SNIPE_RETRY: 'snipeRetryCount',
        };
        const key = keyMap[t];
        const val = (t === 'SET_SNIPE_FEE' && vNum === 0)
          ? undefined
          : (t === 'SET_DEFAULT_BUY' || t === 'SET_DEFAULT_SNIPE')
            ? Number(vNum.toFixed(6))
            : Math.floor(vNum);
        updateUserSetting(chatId, key, val);
        setPendingInput(chatId, null);
        await bot.sendMessage(chatId, "Updated.");
        const mid = pending?.data?.messageId;
        if (mid) {
          try {
            await bot.editMessageReplyMarkup(buildSnipeDefaultsMenu(chatId).reply_markup, { chat_id: chatId, message_id: mid });
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
      if (text.startsWith("grpc set ")) {
        const addr = text.split(/\s+/)[2];
        setGrpcEndpoint(addr);
        return bot.sendMessage(chatId, `gRPC endpoint set: ${addr}`);
      }
      if (text.startsWith("fee ")) {
        const lamports = Number(text.split(/\s+/)[1]);
        setPriorityFeeLamports(lamports);
        return bot.sendMessage(chatId, `Priority fee set: ${lamports || "auto"}`);
      }
      if (text === "jito on") {
        setUseJitoBundle(true);
        return bot.sendMessage(chatId, "Jito bundling: ON");
      }
      if (text === "jito off") {
        setUseJitoBundle(false);
        return bot.sendMessage(chatId, "Jito bundling: OFF");
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
        const [, mint, solStr] = text.split(/\s+/);
        const amountSol = parseFloat(solStr);
        if (!mint || !amountSol)
          return bot.sendMessage(chatId, "Usage: buy <MINT> <amount SOL>");
        const result = await performSwap({
          inputMint: "So11111111111111111111111111111111111111112",
          outputMint: mint,
          amountSol,
          chatId,
        });
        if (result?.txid) {
          return bot.sendMessage(
            chatId,
            `Swap submitted. Tx: ${result.txid}`
          );
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
        startLiquidityWatch(chatId, { mint, amountSol, priorityFeeLamports, useJitoBundle, onEvent: (m) => bot.sendMessage(chatId, m) });
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
            const priorityFeeLamports = s.maxSnipeGasPrice ?? getPriorityFeeLamports();
            const useJitoBundle = s.enableJitoForSnipes ?? getUseJitoBundle();
            const pollInterval = s.snipePollInterval;
            const slippageBps = s.snipeSlippage;
            const retryCount = s.snipeRetryCount;
            startLiquidityWatch(chatId, { mint, amountSol: defaultSnipe, priorityFeeLamports, useJitoBundle, pollInterval, slippageBps, retryCount, onEvent: (m) => bot.sendMessage(chatId, m) });
            await bot.sendMessage(chatId, `Auto-snipe started for ${mint} — amount ${defaultSnipe} SOL`);
            return;
          }
          const kb = {
            inline_keyboard: [
              [
                { text: `📈 Quote ${defaultBuy} SOL`, callback_data: `AUTO_QUOTE_${mint}_${defaultBuy}` },
                { text: `⚡ Buy ${defaultBuy} SOL`, callback_data: `AUTO_BUY_${mint}_${defaultBuy}` },
              ],
              [
                { text: `🎯 Snipe on LP ${defaultSnipe} SOL`, callback_data: `AUTO_SNIPE_${mint}_${defaultSnipe}` },
                { text: "❌ Dismiss", callback_data: `DISMISS_${Date.now()}` },
              ],
            ],
          };
          await bot.sendMessage(chatId, `Detected token/mint: ${mint}\nChoose an action:`, { reply_markup: kb });
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
