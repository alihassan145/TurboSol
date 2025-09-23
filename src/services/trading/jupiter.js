import axios from "axios";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import {
  getRpcConnection,
  getParsedTokenAccountsByOwnerRaced,
} from "../rpc.js";
import { getUserWalletInstance } from "../wallet.js";
import { getPriorityFeeLamports, getUseJitoBundle } from "../config.js";
import { simulateBundleAndSend } from "../jito.js";
import { getAdaptiveSlippageBps, recordSlippageFeedback } from "../slippage.js";

export const NATIVE_SOL = "So11111111111111111111111111111111111111112";
const JUP_QUOTE_URL = "https://quote-api.jup.ag/v6/quote";
const JUP_SWAP_URL = "https://quote-api.jup.ag/v6/swap";

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

function deriveRouteLabels(route) {
  try {
    const rp = Array.isArray(route?.routePlan) ? route.routePlan : [];
    const labels = rp
      .map((s) => s?.swapInfo?.label || s?.swapInfo?.ammKey || "route")
      .join(" > ");
    return labels || "route";
  } catch {
    return "route";
  }
}

export async function getQuoteRaw({
  inputMint,
  outputMint,
  amountRaw,
  slippageBps = 100,
  onlyDirectRoutes = false,
  timeoutMs = Number(process.env.QUOTE_TIMEOUT_MS || 1200),
}) {
  if (!inputMint || !outputMint || !Number.isFinite(amountRaw)) return null;
  const params = {
    inputMint,
    outputMint,
    amount: String(Math.max(1, Math.floor(amountRaw))),
    slippageBps: Math.max(1, Math.floor(slippageBps)),
    onlyDirectRoutes: !!onlyDirectRoutes,
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
  if (!res) return null;
  if (res.status >= 400) {
    const data = res.data || {};
    return {
      __error__: true,
      errorCode: data.errorCode || `HTTP_${res.status}`,
      errorMessage: data.error || "",
    };
  }
  return res.data || null;
}

export async function getTokenQuote({
  inputMint,
  outputMint,
  amountSol,
  slippageBps = 100,
}) {
  const amountRaw = Math.floor(Number(amountSol || 0) * 1e9);
  const baseTimeout = Number(process.env.QUOTE_TIMEOUT_MS || 1200);
  const fallbackTimeout = Number(
    process.env.QUOTE_FALLBACK_TIMEOUT_MS || Math.max(2500, baseTimeout * 2)
  );
  const fallbackSlippageBps = Number(
    process.env.QUOTE_FALLBACK_SLIPPAGE_BPS || Math.max(300, slippageBps)
  );

  const tryGet = async (bps, tmo, direct = false, amt = amountRaw) => {
    let r = await getQuoteRaw({
      inputMint,
      outputMint,
      amountRaw: amt,
      slippageBps: bps,
      timeoutMs: tmo,
      onlyDirectRoutes: direct,
    }).catch(() => null);
    if (r && r.__error__) {
      // Avoid throwing here; callers expect null on failure
      r = null;
    }
    return r;
  };

  let route = await tryGet(slippageBps, baseTimeout);
  if (!route) route = await tryGet(slippageBps, fallbackTimeout);
  if (!route && fallbackSlippageBps > slippageBps)
    route = await tryGet(fallbackSlippageBps, fallbackTimeout);
  if (!route) route = await tryGet(fallbackSlippageBps, fallbackTimeout, true);
  if (!route) {
    // Probe larger amounts quietly to detect liquidity thresholds, but don't throw
    for (const mult of [1.5, 2.0]) {
      const probe = Math.max(1, Math.floor(amountRaw * mult));
      const rProbe = await tryGet(
        fallbackSlippageBps,
        fallbackTimeout,
        false,
        probe
      );
      if (rProbe) {
        // We found a route with a higher amount, but to keep existing UX, just return null and let UI handle amount input
        break;
      }
    }
  }

  if (!route) return null;

  // Shape response expected by telegram.js
  const connection = getRpcConnection();
  const outDec = await getMintDecimals(outputMint, connection).catch(() => 6);
  const outAmountRaw = Number(route?.outAmount) || 0;
  const outAmountFormatted =
    outDec > 0 ? outAmountRaw / 10 ** outDec : outAmountRaw;

  return {
    route,
    outAmountRaw,
    outAmountFormatted,
    priceImpactPct: route?.priceImpactPct ?? null,
  };
}

async function buildAndSignSwapTx({
  route,
  userPk,
  priorityFeeLamports,
  chatId,
}) {
  const body = {
    quoteResponse: route,
    userPublicKey: userPk,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: priorityFeeLamports ?? "auto",
  };
  const res = await axios.post(JUP_SWAP_URL, body, {
    timeout: Number(process.env.SWAP_BUILD_TIMEOUT_MS || 5000),
    validateStatus: (s) => s >= 200 && s < 500,
  });
  if (res.status >= 400) {
    const msg = res?.data?.error || `swap_build_error_${res.status}`;
    throw new Error(msg);
  }
  const swapTxB64 = res?.data?.swapTransaction;
  if (!swapTxB64) throw new Error("no_swap_transaction");
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTxB64, "base64"));
  return tx;
}

export async function performSwap({
  inputMint,
  outputMint,
  amountSol,
  chatId,
  priorityFeeLamports,
  useJitoBundle,
  slippageBps: slippageBpsOverride,
  walletOverride,
}) {
  if (!Number.isFinite(Number(amountSol)) || Number(amountSol) <= 0)
    throw new Error("invalid_amount");
  const connection = getRpcConnection();
  const wallet = walletOverride || (await getUserWalletInstance(chatId));
  const slippageBps = Number.isFinite(Number(slippageBpsOverride))
    ? Number(slippageBpsOverride)
    : await getAdaptiveSlippageBps().catch(() =>
        Number(process.env.DEFAULT_SLIPPAGE_BPS || 100)
      );

  const quoteRes = await getTokenQuote({
    inputMint,
    outputMint,
    amountSol,
    slippageBps,
  });
  const route = quoteRes?.route || null;
  if (!route) throw new Error("no_quote_route");

  const tx = await buildAndSignSwapTx({
    route,
    userPk: wallet.publicKey.toBase58(),
    priorityFeeLamports,
    chatId,
  });
  tx.sign([wallet]);

  let sendRes;
  try {
    sendRes = await simulateBundleAndSend({
      signedTx: tx,
      chatId,
      useJitoBundle: useJitoBundle ?? getUseJitoBundle(),
      priorityFeeMicroLamports: null,
    });
  } catch (e) {
    try {
      recordSlippageFeedback({
        usedBps: slippageBps,
        priceImpactPct: route?.priceImpactPct,
        success: false,
        latencyMs: null,
      });
    } catch {}
    throw e;
  }
  try {
    recordSlippageFeedback({
      usedBps: slippageBps,
      priceImpactPct: route?.priceImpactPct,
      success: true,
      latencyMs: sendRes?.latencyMs,
    });
  } catch {}

  const outDec = await getMintDecimals(outputMint, connection).catch(() => 6);
  const tokensOut = Number(route?.outAmount)
    ? Number(route.outAmount) / 10 ** outDec
    : null;

  return {
    txid: sendRes?.txid || null,
    route: {
      labels: deriveRouteLabels(route),
      priceImpactPct: route?.priceImpactPct ?? null,
    },
    slippageBps,
    priorityFeeLamports: priorityFeeLamports ?? "auto",
    via: sendRes?.via || null,
    latencyMs: sendRes?.latencyMs ?? null,
    lastSendRaceWinner: sendRes?.lastSendRaceWinner ?? null,
    lastSendRaceAttempts: sendRes?.lastSendRaceAttempts ?? 0,
    lastSendRaceLatencyMs: sendRes?.lastSendRaceLatencyMs ?? null,
    output: { tokensOut, symbol: null },
  };
}

export async function quickSell({
  tokenMint,
  percent = 100,
  chatId,
  priorityFeeLamports,
  useJitoBundle,
  slippageBps: slippageBpsOverride,
}) {
  const connection = getRpcConnection();
  const wallet = await getUserWalletInstance(chatId);

  // Fetch token balance (sum across accounts of this mint)
  const resp = await getParsedTokenAccountsByOwnerRaced(
    wallet.publicKey,
    { mint: new PublicKey(tokenMint) },
    { commitment: "confirmed" }
  ).catch(() => null);
  const accounts = resp?.value || [];
  let rawBalance = 0n;
  for (const acc of accounts) {
    const amtStr = acc?.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (amtStr) rawBalance += BigInt(amtStr);
  }
  if (rawBalance <= 0n) throw new Error("no_token_balance");
  const sellRaw =
    (rawBalance * BigInt(Math.max(1, Math.min(100, Math.floor(percent))))) /
    100n;
  if (sellRaw <= 0n) throw new Error("sell_amount_zero");

  const slippageBps = Number.isFinite(Number(slippageBpsOverride))
    ? Number(slippageBpsOverride)
    : await getAdaptiveSlippageBps().catch(() =>
        Number(process.env.DEFAULT_SLIPPAGE_BPS || 100)
      );
  const route = await getQuoteRaw({
    inputMint: tokenMint,
    outputMint: NATIVE_SOL,
    amountRaw: Number(sellRaw),
    slippageBps,
  }).catch(() => null);
  if (!route) throw new Error("no_quote_route");

  const tx = await buildAndSignSwapTx({
    route,
    userPk: wallet.publicKey.toBase58(),
    priorityFeeLamports,
    chatId,
  });
  tx.sign([wallet]);

  let sendRes;
  try {
    sendRes = await simulateBundleAndSend({
      signedTx: tx,
      chatId,
      useJitoBundle: useJitoBundle ?? getUseJitoBundle(),
      priorityFeeMicroLamports: null,
    });
  } catch (e) {
    try {
      recordSlippageFeedback({
        usedBps: slippageBps,
        priceImpactPct: route?.priceImpactPct,
        success: false,
        latencyMs: null,
      });
    } catch {}
    throw e;
  }
  try {
    recordSlippageFeedback({
      usedBps: slippageBps,
      priceImpactPct: route?.priceImpactPct,
      success: true,
      latencyMs: sendRes?.latencyMs,
    });
  } catch {}

  const tokensOut = Number(route?.outAmount)
    ? Number(route.outAmount) / 1e9
    : null;

  return {
    txid: sendRes?.txid || null,
    route: {
      labels: deriveRouteLabels(route),
      priceImpactPct: route?.priceImpactPct ?? null,
    },
    slippageBps,
    priorityFeeLamports: priorityFeeLamports ?? "auto",
    via: sendRes?.via || null,
    latencyMs: sendRes?.latencyMs ?? null,
    lastSendRaceWinner: sendRes?.lastSendRaceWinner ?? null,
    lastSendRaceAttempts: sendRes?.lastSendRaceAttempts ?? 0,
    lastSendRaceLatencyMs: sendRes?.lastSendRaceLatencyMs ?? null,
    output: { tokensOut, symbol: "SOL" },
  };
}

export const performSell = quickSell;
