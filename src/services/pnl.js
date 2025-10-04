import axios from "axios";
import { PublicKey } from "@solana/web3.js";
import { getRpcConnection } from "./rpc.js";
import { getPositions } from "./positionStore.js";

export const NATIVE_SOL = "So11111111111111111111111111111111111111112";
const JUP_QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";

const mintDecimalsCache = new Map();

function promiseWithTimeout(promise, ms, tag = "timeout") {
  let to;
  return Promise.race([
    promise.finally(() => clearTimeout(to)),
    new Promise((_, rej) => (to = setTimeout(() => rej(new Error(tag)), ms))),
  ]);
}

async function getMintDecimals(mint, connection) {
  if (mint === NATIVE_SOL) return 9;
  if (mintDecimalsCache.has(mint)) return mintDecimalsCache.get(mint);
  try {
    const info = await promiseWithTimeout(
      connection.getParsedAccountInfo(new PublicKey(mint), {
        commitment: "confirmed",
      }),
      Number(process.env.MINT_INFO_TIMEOUT_MS || 1200),
      "mint_info_timeout"
    ).catch(() => null);
    const dec = info?.value?.data?.parsed?.info?.decimals;
    const decimals = Number.isFinite(dec) ? Number(dec) : 6;
    mintDecimalsCache.set(mint, decimals);
    return decimals;
  } catch {
    return 6;
  }
}

async function getQuoteRaw({ inputMint, outputMint, amountRaw, slippageBps = 150, timeoutMs = Number(process.env.QUOTE_TIMEOUT_MS || 1200) }) {
  if (!inputMint || !outputMint || !Number.isFinite(amountRaw)) return null;
  const params = {
    inputMint,
    outputMint,
    amount: String(Math.max(1, Math.floor(amountRaw))),
    slippageBps: Math.max(1, Math.floor(slippageBps)),
    onlyDirectRoutes: false,
    asLegacyTransaction: false,
  };
  const res = await promiseWithTimeout(
    axios.get(JUP_QUOTE_URL, {
      params,
      timeout: timeoutMs,
      validateStatus: (s) => s >= 200 && s < 500,
    }),
    timeoutMs,
    "quote_timeout"
  ).catch(() => null);
  if (!res || res.status >= 400) return null;
  return res.data || null;
}

export async function estimateSolValue({ tokenMint, tokensAmount, slippageBps = Number(process.env.PNL_SLIPPAGE_BPS || 200) }) {
  const connection = getRpcConnection();
  const dec = await getMintDecimals(tokenMint, connection).catch(() => 6);
  const raw = Math.floor(Number(tokensAmount || 0) * 10 ** dec);
  if (!raw || raw <= 0) return { solOut: 0, dec };
  const route = await getQuoteRaw({ inputMint: tokenMint, outputMint: NATIVE_SOL, amountRaw: raw, slippageBps }).catch(() => null);
  const outRaw = Number(route?.outAmount) || 0;
  const solOut = outRaw / 1e9;
  return { solOut, dec };
}

export function computeUnrealizedPnl({ tokens, avgPriceSolPerToken, currentSolValue }) {
  const cost = Number(tokens || 0) * Number(avgPriceSolPerToken || 0);
  const pnl = Number(currentSolValue || 0) - cost;
  const pct = cost > 0 ? (pnl / cost) * 100 : 0;
  return { cost, pnl, pct };
}

export async function getUnrealizedPnlSummary(chatId) {
  const positions = getPositions(chatId) || [];
  const items = [];
  let totalCost = 0,
    totalValue = 0;
  for (const p of positions) {
    if (!p?.tokens || p.tokens <= 0) continue;
    const { solOut } = await estimateSolValue({ tokenMint: p.mint, tokensAmount: p.tokens }).catch(() => ({ solOut: 0 }));
    const { cost, pnl, pct } = computeUnrealizedPnl({ tokens: p.tokens, avgPriceSolPerToken: p.avgPriceSolPerToken, currentSolValue: solOut });
    items.push({ ...p, currentSolValue: solOut, cost, pnl, pct });
    totalCost += cost;
    totalValue += solOut;
  }
  const totalUnrealized = totalValue - totalCost;
  const totalPct = totalCost > 0 ? (totalUnrealized / totalCost) * 100 : 0;
  return { items, totalCost, totalValue, totalUnrealized, totalPct };
}