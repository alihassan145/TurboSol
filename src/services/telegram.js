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

export async function startTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

  bot = new TelegramBot(token, { polling: true });

  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const pub = await getPublicKey();
    await bot.sendMessage(chatId, `Hello! Wallet: ${pub}`);
    await bot.sendMessage(chatId, buildMainMenu(chatId).text, {
      reply_markup: buildMainMenu(chatId).reply_markup,
    });
  });

  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    try {
      if (data === "WALLET") {
        const pub = await getPublicKey();
        await bot.sendMessage(chatId, `Wallet: ${pub}`);
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
      if (data === "SNIPE_LP") {
        await bot.sendMessage(chatId, "Send: snipe <MINT> <amount SOL>");
      }
      if (data === "STOP_SNIPE") {
        stopLiquidityWatch(chatId);
        await bot.sendMessage(chatId, "Stopped all snipes for this chat.");
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
      if (text === "settings") {
        return bot.sendMessage(
          chatId,
          `Settings:\nfee=${
            getPriorityFeeLamports() ?? "auto"
          }\njito=${getUseJitoBundle()}`
        );
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
          ...flags,
        });
        await bot.sendMessage(chatId, `Swap sent: ${txid}`);
      }
      if (text.startsWith("snipe ")) {
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
    } catch (e) {
      await bot.sendMessage(chatId, `Error: ${e.message || e}`);
    }
  });

  return bot;
}

export function getBotInstance() {
  return bot;
}
