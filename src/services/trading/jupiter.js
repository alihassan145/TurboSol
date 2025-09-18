import axios from "axios";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import {
  getRpcConnection,
  getParsedTokenAccountsByOwnerRaced,
} from "../rpc.js";
import { getUserWalletInstance } from "../wallet.js";
import { getAdaptivePriorityFee, computePriorityFeeCap } from "../fees.js";
import { getPriorityFeeLamports, getUseJitoBundle } from "../config.js";
import { simulateBundleAndSend } from "../jito.js";
import { measureRpcLatency } from "../rpcMonitor.js";
import { getAdaptiveSlippageBps, recordSlippageFeedback } from "../slippage.js";

const JUP_QUOTE_URL = "https://quote-api.jup.ag/v6/quote";
const JUP_SWAP_URL = "https://quote-api.jup.ag/v6/swap";
export const NATIVE_SOL = "So11111111111111111111111111111111111111112";

const mintDecimalsCache = new Map();

function promiseWithTimeout(promise, ms, tag = "timeout") {
  let to;
  return Promise.race([
    promise.finally(() => clearTimeout(to)),
    new Promise((_, rej) => {
      to = setTimeout(() => rej(new Error(tag)), ms);
    }),
  ]);
}

async function getMintDecimals(mint, connection) {
  if (mint === NATIVE_SOL) return 9;
  if (mintDecimalsCache.has(mint)) return mintDecimalsCache.get(mint);
  const info = await promiseWithTimeout(
    connection.getParsedAccountInfo(new PublicKey(mint)).catch(() => null),
    Number(process.env.MINT_INFO_TIMEOUT_MS || 1200),
    "mint_info_timeout"
  ).catch(() => null);
  const dec = info?.value?.data?.parsed?.info?.decimals;
  const decimals = Number.isFinite(dec) ? Number(dec) : 6;
  mintDecimalsCache.set(mint, decimals);
  return decimals;
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
  if (!res || res.status >= 400) return null;
  return res.data || null;
}

export async function getTokenQuote({
  inputMint,
  outputMint,
  amountSol,
  slippageBps = 100,
}) {
  const connection = getRpcConnection();
  const amountRaw = Math.floor(Number(amountSol || 0) * 1e9);
  const route = await getQuoteRaw({
    inputMint,
    outputMint,
    amountRaw,
    slippageBps,
  }).catch(() => null);
  if (!route) return null;
  const outDecimals = await getMintDecimals(outputMint, connection).catch(
    () => 6
  );
  const outAmount = Number(route.outAmount || 0);
  const outAmountFormatted = outAmount / Math.pow(10, outDecimals);
  return {
    outAmountFormatted,
    priceImpactPct: route.priceImpactPct,
    route: { ...route, labels: deriveRouteLabels(route) },
  };
}

async function requestSwapTransaction({
  route,
  userPublicKey,
  priorityFeeMicroLamports,
}) {
  // Optional jitter on priority fee hint for builder
  let hinted = priorityFeeMicroLamports;
  const priceJitterPct = Math.max(0, Number(process.env.COMPUTE_UNIT_PRICE_JITTER_PCT || 0));
  if (Number.isFinite(hinted) && hinted > 0 && priceJitterPct > 0) {
    const sign = Math.random() < 0.5 ? -1 : 1;
    const jitter = 1 + (sign * (Math.random() * priceJitterPct) / 100);
    hinted = Math.max(1, Math.floor(hinted * jitter));
  }

  const buildBody = (overrides = {}) => {
    const body = {
      quoteResponse: route,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      useSharedAccounts: true,
      asLegacyTransaction: false,
      ...overrides,
    };
    if (
      Number.isFinite(hinted) &&
      hinted > 0 &&
      overrides.computeUnitPriceMicroLamports !== null
    ) {
      body.computeUnitPriceMicroLamports = Math.floor(hinted);
    }
    return body;
  };

  const timeoutMs = Number(process.env.SWAP_BUILD_TIMEOUT_MS || 3000);

  // Attempt 1: default body
  let res;
  try {
    res = await promiseWithTimeout(
      axios.post(JUP_SWAP_URL, buildBody(), {
        timeout: timeoutMs,
        validateStatus: (s) => s >= 200 && s < 500,
      }),
      timeoutMs,
      "swap_build_timeout"
    );
  } catch (e) {
    throw e;
  }

  // If success
  if (res && res.status < 400) {
    const txb64 = res.data?.swapTransaction;
    if (!txb64) throw new Error("no_swap_tx_returned");
    return txb64;
  }

  // Attempt 2: retry with useSharedAccounts=false
  let lastErrDetail = res?.data
    ? typeof res.data === "string"
      ? res.data
      : JSON.stringify(res.data)
    : "";
  try {
    const res2 = await promiseWithTimeout(
      axios.post(JUP_SWAP_URL, buildBody({ useSharedAccounts: false }), {
        timeout: timeoutMs,
        validateStatus: (s) => s >= 200 && s < 500,
      }),
      timeoutMs,
      "swap_build_timeout"
    );
    if (res2 && res2.status < 400) {
      const txb64 = res2.data?.swapTransaction;
      if (!txb64) throw new Error("no_swap_tx_returned");
      return txb64;
    }
    lastErrDetail = res2?.data
      ? typeof res2.data === "string"
        ? res2.data
        : JSON.stringify(res2.data)
      : lastErrDetail;
  } catch (_) {}

  // Attempt 3: retry without priority fee field (some backends may reject this field)
  try {
    const res3 = await promiseWithTimeout(
      axios.post(
        JUP_SWAP_URL,
        buildBody({ computeUnitPriceMicroLamports: null }),
        { timeout: timeoutMs, validateStatus: (s) => s >= 200 && s < 500 }
      ),
      timeoutMs,
      "swap_build_timeout"
    );
    if (res3 && res3.status < 400) {
      const txb64 = res3.data?.swapTransaction;
      if (!txb64) throw new Error("no_swap_tx_returned");
      return txb64;
    }
    lastErrDetail = res3?.data
      ? typeof res3.data === "string"
        ? res3.data
        : JSON.stringify(res3.data)
      : lastErrDetail;
  } catch (_) {}

  // All attempts failed
  const code = res?.status || 400;
  const errMsg = `swap_build_err_${code}${
    lastErrDetail ? `:${lastErrDetail}` : ""
  }`;
  throw new Error(errMsg);
}

async function signAndBroadcast({
  txBase64,
  wallet,
  useJitoBundle = false,
  chatId,
  priorityFeeMicroLamports,
}) {
  const raw = Buffer.from(txBase64, "base64");
  const tx = VersionedTransaction.deserialize(raw);
  tx.sign([wallet]);
  // Delegate to centralized simulate + bundle + send flow with telemetry
  return await simulateBundleAndSend({
    signedTx: tx,
    chatId,
    useJitoBundle,
    priorityFeeMicroLamports,
  });
}

export async function performSwap({
  inputMint,
  outputMint,
  amountSol,
  amountRaw,
  slippageBps = Number(process.env.DEFAULT_SLIPPAGE_BPS || 100),
  priorityFeeLamports,
  useJitoBundle,
  chatId,
}) {
  const connection = getRpcConnection();
  const wallet = await getUserWalletInstance(chatId);

  let inAmountRaw = Number.isFinite(amountRaw)
    ? Math.floor(amountRaw)
    : Math.floor(Number(amountSol || 0) * 1e9);

  // Optionally elevate slippage using adaptive heuristic when enabled
  let slipBps = slippageBps;
  try {
    const flag = String(process.env.ADAPTIVE_SLIPPAGE_ENABLED || "").toLowerCase();
    const enabled = flag === "1" || flag === "true" || flag === "yes";
    if (enabled) {
      const adaptive = await getAdaptiveSlippageBps().catch(() => null);
      if (Number.isFinite(adaptive) && adaptive > 0) {
        slipBps = Math.max(Number(slipBps) || 0, adaptive);
      }
    }
  } catch {}

  let route = await getQuoteRaw({
    inputMint,
    outputMint,
    amountRaw: inAmountRaw,
    slippageBps: slipBps,
  }).catch(() => null);
  if (!route) throw new Error("no_quote_route");

  let prio = priorityFeeLamports;
  if (!Number.isFinite(prio) || prio <= 0) {
    try {
      prio = getPriorityFeeLamports();
    } catch {}
  }
  if (!Number.isFinite(prio) || prio <= 0) {
    try {
      prio = await getAdaptivePriorityFee(connection);
    } catch {}
  }
  // Apply dynamic congestion-based cap
  try {
    const latencyForCap = await measureRpcLatency().catch(() => -1);
    const cap = computePriorityFeeCap(latencyForCap);
    if (Number.isFinite(prio) && prio > 0) {
      prio = Math.min(prio, cap);
    } else {
      prio = cap;
    }
  } catch {}

  let txb64;
  try {
    txb64 = await requestSwapTransaction({
      route,
      userPublicKey: wallet.publicKey.toBase58(),
      priorityFeeMicroLamports: prio,
    });
  } catch (e1) {
    // Re-quote and retry once (route might have expired or changed)
    route = await getQuoteRaw({
      inputMint,
      outputMint,
      amountRaw: inAmountRaw,
      slippageBps: slipBps,
    }).catch(() => null);
    if (!route) throw e1;
    try {
      txb64 = await requestSwapTransaction({
        route,
        userPublicKey: wallet.publicKey.toBase58(),
        priorityFeeMicroLamports: prio,
      });
    } catch (e2) {
      // Final attempt: retry with no priority fee hint
      txb64 = await requestSwapTransaction({
        route,
        userPublicKey: wallet.publicKey.toBase58(),
        priorityFeeMicroLamports: undefined,
      });
    }
  }

  let sendRes;
  try {
    sendRes = await signAndBroadcast({
      txBase64: txb64,
      wallet,
      useJitoBundle: useJitoBundle ?? getUseJitoBundle(),
      chatId,
      priorityFeeMicroLamports: prio,
    });
    // Feedback: success case
    try {
      recordSlippageFeedback({
        usedBps: slipBps,
        priceImpactPct: route?.priceImpactPct,
        success: true,
        latencyMs: sendRes?.latencyMs,
      });
    } catch {}
  } catch (e) {
    // Feedback: failure case (send path failed)
    try {
      recordSlippageFeedback({
        usedBps: slipBps,
        priceImpactPct: route?.priceImpactPct,
        success: false,
        latencyMs: null,
      });
    } catch {}
    throw e;
  }

  const outDecimals = await getMintDecimals(outputMint, connection).catch(
    () => 6
  );
  const tokensOut = Number(route.outAmount || 0) / Math.pow(10, outDecimals);

  return {
    txid: sendRes.txid,
    output: { symbol: undefined, tokensOut },
    route: {
      priceImpactPct: route.priceImpactPct,
      labels: deriveRouteLabels(route),
      outAmount: route.outAmount,
    },
    slippageBps: slipBps,
    priorityFeeLamports: prio,
    via: sendRes.via,
    latencyMs: sendRes.latencyMs,
    lastSendRaceWinner: sendRes.lastSendRaceWinner,
    lastSendRaceAttempts: sendRes.lastSendRaceAttempts,
    lastSendRaceLatencyMs: sendRes.lastSendRaceLatencyMs,
  };
}

export async function performSell({
  tokenMint,
  percent = 100,
  slippageBps = 150,
  priorityFeeLamports,
  useJitoBundle,
  chatId,
}) {
  const connection = getRpcConnection();
  const wallet = await getUserWalletInstance(chatId);
  const owner = wallet.publicKey;
  const accounts = await promiseWithTimeout(
    getParsedTokenAccountsByOwnerRaced(owner, {
      mint: new PublicKey(tokenMint),
    }).catch(() => ({ value: [] })),
    Number(process.env.TOKEN_ACCOUNTS_TIMEOUT_MS || 1500),
    "token_acc_timeout"
  ).catch(() => ({ value: [] }));
  const acc = accounts?.value?.[0];
  const info = acc?.account?.data?.parsed?.info;
  const uiAmt = Number(info?.tokenAmount?.uiAmount || 0);
  const dec = Number(info?.tokenAmount?.decimals || 6);
  if (uiAmt <= 0) throw new Error("no_tokens_to_sell");
  const toSellUi = (uiAmt * Math.max(1, Math.min(100, percent))) / 100;
  const inAmountRaw = Math.floor(toSellUi * Math.pow(10, dec));
  return await performSwap({
    inputMint: tokenMint,
    outputMint: NATIVE_SOL,
    amountRaw: inAmountRaw,
    slippageBps,
    priorityFeeLamports,
    useJitoBundle,
    chatId,
  });
}

// Quick-sell convenience wrapper with aggressive defaults for speed
export async function quickSell({
  tokenMint,
  percent = 100,
  slippageBps,
  priorityFeeLamports,
  useJitoBundle,
  chatId,
}) {
  const defaultSellSlippage = Number(
    slippageBps ?? process.env.QUICK_SELL_SLIPPAGE_BPS ?? 200
  );
  return performSell({
    tokenMint,
    percent,
    slippageBps: defaultSellSlippage,
    priorityFeeLamports,
    useJitoBundle,
    chatId,
  });
}
