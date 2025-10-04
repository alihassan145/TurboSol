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
import { initTrade, updateTradeStatus } from "../tradeState.js";
import { monitorSignatures } from "../signatureMonitor.js";
import { upsertPosition, applySellToPosition } from "../positionStore.js";
import { recordPnlSnapshot } from "../positionStore.js";
import { getUserState } from "../userState.js";

export const NATIVE_SOL = "So11111111111111111111111111111111111111112";
const JUP_QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";
const JUP_SWAP_URL = "https://lite-api.jup.ag/swap/v1/swap";

const mintDecimalsCache = new Map();

// Global buy locks to prevent concurrent duplicate buys across sources (per chatId+mint)
const _buyLocks = new Map(); // key: `${chatId}:${mint}` -> expiresAt (ms)

// Canonicalize mint strings: extract a valid base58 public key (32–44 chars)
function canonicalizeMint(mint) {
  const s = String(mint || "").trim();
  const match = s.match(/[A-HJ-NP-Za-km-z1-9]{32,44}/);
  return match ? match[0] : s;
}

function getBuyLockKey(chatId, mint) {
  const canonical = canonicalizeMint(mint);
  return `${chatId}:${canonical}`;
}

function isBuyLocked(chatId, mint) {
  const k = getBuyLockKey(chatId, mint);
  const until = _buyLocks.get(k) || 0;
  return until && Date.now() < until;
}

function acquireBuyLock(chatId, mint) {
  const k = getBuyLockKey(chatId, mint);
  const ttlMs = Number(
    process.env.BUY_LOCK_MS || process.env.TX_CONFIRM_MAX_WAIT_MS || 90000
  );
  _buyLocks.set(k, Date.now() + ttlMs);
}

function releaseBuyLock(chatId, mint) {
  const k = getBuyLockKey(chatId, mint);
  _buyLocks.delete(k);
}

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

  const responseData = res.data;

  // Validate response structure
  if (!responseData || typeof responseData !== "object") {
    return null;
  }

  // Check if response contains an error
  if (responseData.error || responseData.errorCode) {
    return {
      __error__: true,
      errorCode: responseData.errorCode || "API_ERROR",
      errorMessage: responseData.error || "Unknown API error",
    };
  }

  // Check if response has essential fields for a valid quote
  if (!responseData.outAmount || !responseData.routePlan) {
    return null;
  }

  return responseData;
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
    console.log(
      `[QUOTE] Attempting quote with slippage: ${bps}bps, timeout: ${tmo}ms, direct: ${direct}, amount: ${amt}`
    );
    let r = await getQuoteRaw({
      inputMint,
      outputMint,
      amountRaw: amt,
      slippageBps: bps,
      timeoutMs: tmo,
      onlyDirectRoutes: direct,
    }).catch((err) => {
      console.log(`[QUOTE] Error in getQuoteRaw:`, err.message);
      return null;
    });

    if (r && r.__error__) {
      console.log(`[QUOTE] API returned error:`, r.errorCode, r.errorMessage);
      // Avoid throwing here; callers expect null on failure
      r = null;
    } else if (r) {
      console.log(
        `[QUOTE] Success! outAmount: ${r.outAmount}, priceImpact: ${r.priceImpactPct}%`
      );
    } else {
      console.log(`[QUOTE] No route found`);
    }

    return r;
  };

  let route = await tryGet(slippageBps, baseTimeout);
  console.log(
    `[QUOTE] Final route result:`,
    route ? `Found route with outAmount: ${route.outAmount}` : "No route found"
  );

  if (!route) route = await tryGet(slippageBps, fallbackTimeout);
  if (!route && fallbackSlippageBps > slippageBps)
    route = await tryGet(fallbackSlippageBps, fallbackTimeout);
  if (!route) route = await tryGet(fallbackSlippageBps, fallbackTimeout, true);
  if (!route) {
    console.log(`[QUOTE] Probing larger amounts for liquidity detection...`);
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
        console.log(
          `[QUOTE] Found route with larger amount (${mult}x), but returning null to maintain UX`
        );
        // We found a route with a higher amount, but to keep existing UX, just return null and let UI handle amount input
        break;
      }
    }
  }

  if (!route) {
    console.log(`[QUOTE] No route found after all attempts`);
    return null;
  }

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
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: {
        maxLamports: priorityFeeLamports ?? 10000000,
        priorityLevel: "veryHigh",
      },
    },
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
  tradeKey,
}) {
  if (!Number.isFinite(Number(amountSol)) || Number(amountSol) <= 0)
    throw new Error("invalid_amount");
  const connection = getRpcConnection();
  const wallet = walletOverride || (await getUserWalletInstance(chatId));
  const state = chatId != null ? getUserState(chatId) : {};
  const slippageBps = Number.isFinite(Number(slippageBpsOverride))
    ? Number(slippageBpsOverride)
    : Number.isFinite(Number(state?.snipeSlippage))
    ? Number(state.snipeSlippage)
    : await getAdaptiveSlippageBps().catch(() =>
        Number(process.env.DEFAULT_SLIPPAGE_BPS || 100)
      );

  const effectivePriorityFeeLamports =
    priorityFeeLamports != null
      ? Number(priorityFeeLamports)
      : Number.isFinite(Number(state?.priorityFeeLamports))
      ? Number(state.priorityFeeLamports)
      : Number.isFinite(Number(state?.maxSnipeGasPrice))
      ? Number(state.maxSnipeGasPrice)
      : Number(getPriorityFeeLamports() || 0);

  const effectiveUseJitoBundle =
    useJitoBundle != null
      ? !!useJitoBundle
      : state?.enableJitoForSnipes != null
      ? !!state.enableJitoForSnipes
      : !!getUseJitoBundle();

  const quoteRes = await getTokenQuote({
    inputMint,
    outputMint,
    amountSol,
    slippageBps,
  });
  const route = quoteRes?.route || null;
  if (!route) throw new Error("no_quote_route");

  // Prevent concurrent duplicate buys across multiple sources by enforcing a global per-chat+mint lock
  const isSolToToken = String(inputMint) === NATIVE_SOL && !!outputMint && chatId != null;
  let lockAcquired = false;
  if (isSolToToken) {
    if (isBuyLocked(chatId, outputMint)) {
      throw new Error("buy_locked");
    }
    acquireBuyLock(chatId, outputMint);
    lockAcquired = true;
  }

  // Pre-compute expected tokens out for trade state
  const outDecPre = await getMintDecimals(outputMint, connection).catch(() => 6);
  const tokensOutExpected = Number(route?.outAmount)
    ? Number(route.outAmount) / 10 ** outDecPre
    : null;
  const tk = tradeKey || `${String(chatId)}:${outputMint}:${Date.now()}`;
  try {
    initTrade({
      tradeKey: tk,
      chatId,
      wallet: wallet.publicKey?.toBase58?.() || wallet.publicKey?.toString?.(),
      mint: outputMint,
      side: "buy",
      amountSol,
      tokens: tokensOutExpected,
      slippageBps,
      priorityFeeLamports: priorityFeeLamports ?? "auto",
      via: null,
    });
  } catch {}

  const tx = await buildAndSignSwapTx({
    route,
    userPk: wallet.publicKey.toBase58(),
    priorityFeeLamports: effectivePriorityFeeLamports,
    chatId,
  });
  tx.sign([wallet]);

  let sendRes;
  try {
    sendRes = await simulateBundleAndSend({
      signedTx: tx,
      chatId,
      useJitoBundle: effectiveUseJitoBundle,
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
    // Release buy lock on immediate send/build failure
    if (lockAcquired) {
      try { releaseBuyLock(chatId, outputMint); } catch {}
    }
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

  const txid = sendRes?.txid || null;
  // If send produced no txid, release the buy lock to allow retry
  if (!txid && lockAcquired) {
    try { releaseBuyLock(chatId, outputMint); } catch {}
  }
  try {
    updateTradeStatus(tk, "pending", { txid, confirmations: 0 });
    // Monitor confirmation and update position store on success
    if (txid) {
      monitorSignatures({
        connection,
        signatures: [txid],
        tradeKey: tk,
        chatId,
        kind: "Buy",
        onConfirmed: ({ trade }) => {
          try {
            upsertPosition({
              chatId,
              wallet: wallet.publicKey?.toBase58?.() || wallet.publicKey?.toString?.(),
              mint: outputMint,
              tokensAdded: Number(trade?.tokens || tokensOut || 0),
              solSpent: Number(amountSol || 0),
              feesLamports: Number(effectivePriorityFeeLamports || 0),
            });
            recordPnlSnapshot(chatId, {
              kind: "buy",
              mint: outputMint,
              wallet: wallet.publicKey?.toBase58?.() || wallet.publicKey?.toString?.(),
              tokens: Number(trade?.tokens || tokensOut || 0),
              sol: Number(amountSol || 0),
              feesLamports: Number(effectivePriorityFeeLamports || 0),
            });
          } catch {}
        },
      }).catch(() => {});
    }
  } catch {}

  return {
    txid,
    route: {
      labels: deriveRouteLabels(route),
      priceImpactPct: route?.priceImpactPct ?? null,
    },
    slippageBps,
    priorityFeeLamports: effectivePriorityFeeLamports ?? "auto",
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
  tradeKey,
}) {
  const connection = getRpcConnection();
  const wallet = await getUserWalletInstance(chatId);
  const state = chatId != null ? getUserState(chatId) : {};

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
  // Estimate tokens sold for trade state
  const outDecTok = await getMintDecimals(tokenMint, connection).catch(() => 6);
  const tokensSold = Number(sellRaw) / 10 ** outDecTok;

  const slippageBps = Number.isFinite(Number(slippageBpsOverride))
    ? Number(slippageBpsOverride)
    : Number.isFinite(Number(state?.snipeSlippage))
    ? Number(state.snipeSlippage)
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

  const tk = tradeKey || `${String(chatId)}:${tokenMint}:${Date.now()}`;
  try {
    initTrade({
      tradeKey: tk,
      chatId,
      wallet: wallet.publicKey?.toBase58?.() || wallet.publicKey?.toString?.(),
      mint: tokenMint,
      side: "sell",
      amountSol: null,
      tokens: tokensSold,
      slippageBps,
      priorityFeeLamports: priorityFeeLamports ?? "auto",
      via: null,
    });
  } catch {}

  const effectivePriorityFeeLamports =
    priorityFeeLamports != null
      ? Number(priorityFeeLamports)
      : Number.isFinite(Number(state?.priorityFeeLamports))
      ? Number(state.priorityFeeLamports)
      : Number.isFinite(Number(state?.maxSnipeGasPrice))
      ? Number(state.maxSnipeGasPrice)
      : Number(getPriorityFeeLamports() || 0);

  const effectiveUseJitoBundle =
    useJitoBundle != null
      ? !!useJitoBundle
      : state?.enableJitoForSnipes != null
      ? !!state.enableJitoForSnipes
      : !!getUseJitoBundle();

  const tx = await buildAndSignSwapTx({
    route,
    userPk: wallet.publicKey.toBase58(),
    priorityFeeLamports: effectivePriorityFeeLamports,
    chatId,
  });
  tx.sign([wallet]);

  let sendRes;
  try {
    sendRes = await simulateBundleAndSend({
      signedTx: tx,
      chatId,
      useJitoBundle: effectiveUseJitoBundle,
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

  const txid = sendRes?.txid || null;
  try {
    updateTradeStatus(tk, "pending", { txid, confirmations: 0 });
    if (txid) {
      monitorSignatures({
        connection,
        signatures: [txid],
        tradeKey: tk,
        chatId,
        kind: "Sell",
        onConfirmed: () => {
          try {
            applySellToPosition({
              chatId,
              wallet: wallet.publicKey?.toBase58?.() || wallet.publicKey?.toString?.(),
              mint: tokenMint,
              tokensSold: Number(tokensSold || 0),
              solReceived: Number(tokensOut || 0),
              feesLamports: Number(effectivePriorityFeeLamports || 0),
            });
            recordPnlSnapshot(chatId, {
              kind: "sell",
              mint: tokenMint,
              wallet: wallet.publicKey?.toBase58?.() || wallet.publicKey?.toString?.(),
              tokens: Number(tokensSold || 0),
              sol: Number(tokensOut || 0),
              feesLamports: Number(effectivePriorityFeeLamports || 0),
            });
          } catch {}
        },
      }).catch(() => {});
    }
  } catch {}

  return {
    txid,
    route: {
      labels: deriveRouteLabels(route),
      priceImpactPct: route?.priceImpactPct ?? null,
    },
    slippageBps,
    priorityFeeLamports: effectivePriorityFeeLamports ?? "auto",
    via: sendRes?.via || null,
    latencyMs: sendRes?.latencyMs ?? null,
    lastSendRaceWinner: sendRes?.lastSendRaceWinner ?? null,
    lastSendRaceAttempts: sendRes?.lastSendRaceAttempts ?? 0,
    lastSendRaceLatencyMs: sendRes?.lastSendRaceLatencyMs ?? null,
    output: { tokensOut, symbol: "SOL" },
  };
}

export const performSell = quickSell;
