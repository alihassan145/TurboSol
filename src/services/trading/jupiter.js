import axios from "axios";
import {
  getConnection,
  getWallet,
  getUserWalletInstance,
  getUserConnectionInstance,
} from "../wallet.js";
import { VersionedTransaction, PublicKey } from "@solana/web3.js";
import { rotateRpc, sendTransactionRaced } from "../rpc.js";
import {
  submitBundle,
  submitBundleWithTarget,
  serializeToBase64,
} from "../jito.js";
import { addPosition, addTradeLog, getUserState } from "../userState.js";
import { riskCheckToken } from "../risk.js";
import { getAdaptivePriorityFee } from "../fees.js";
import { getAdaptiveSlippageBps } from "../slippage.js";
import { getAllUserWalletKeypairs, hasUserWallet } from "../userWallets.js";
import { getSolPriceUSD } from "../walletInfo.js";
import { log } from "@grpc/grpc-js/build/src/logging.js";

const JUP_BASE = process.env.JUPITER_BASE_URL || "https://quote-api.jup.ag";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUP_DEBUG =
  String(process.env.JUP_DEBUG || "").toLowerCase() === "true" ||
  process.env.JUP_DEBUG === "1";

// ✅ Environment variable validation
function validateEnvNumber(envVar, defaultValue, varName) {
  const value = process.env[envVar];
  if (!value) return defaultValue;

  const parsed = Number(value);
  if (isNaN(parsed)) {
    console.warn(
      `[ENV] Invalid ${varName}: ${value}, using default: ${defaultValue}`
    );
    return defaultValue;
  }
  return parsed;
}

// Time budgets tuned for quick-buy responsiveness
const JUP_QUOTE_TIMEOUT_MS = validateEnvNumber(
  "JUP_QUOTE_TIMEOUT_MS",
  1000,
  "JUP_QUOTE_TIMEOUT_MS"
);
const JUP_SWAP_TIMEOUT_MS = validateEnvNumber(
  "JUP_SWAP_TIMEOUT_MS",
  5000,
  "JUP_SWAP_TIMEOUT_MS"
);
const JUP_HTTP_RETRIES = validateEnvNumber(
  "JUP_HTTP_RETRIES",
  3,
  "JUP_HTTP_RETRIES"
);
const JUP_HTTP_BASE_DELAY_MS = validateEnvNumber(
  "JUP_HTTP_BASE_DELAY_MS",
  200,
  "JUP_HTTP_BASE_DELAY_MS"
);
const JUP_HTTP_MAX_DELAY_MS = validateEnvNumber(
  "JUP_HTTP_MAX_DELAY_MS",
  2000,
  "JUP_HTTP_MAX_DELAY_MS"
);

// ✅ Validate critical trading parameters
const DEFAULT_PRIORITY_FEE_LAMPORTS = validateEnvNumber(
  "DEFAULT_PRIORITY_FEE_LAMPORTS",
  100000,
  "DEFAULT_PRIORITY_FEE_LAMPORTS"
);
const DEFAULT_SLIPPAGE_BPS = validateEnvNumber(
  "DEFAULT_SLIPPAGE_BPS",
  300,
  "DEFAULT_SLIPPAGE_BPS"
);

// ✅ Debug flags for testing core Jupiter flow
const FORCE_DISABLE_JITO = process.env.FORCE_DISABLE_JITO === "true";
const FORCE_DISABLE_PRIVATE_RELAY =
  process.env.FORCE_DISABLE_PRIVATE_RELAY === "true";
const FORCE_DIRECT_SEND =
  process.env.FORCE_DIRECT_SEND === "true" ||
  process.env.DIRECT_SEND_ONLY === "true";

if (FORCE_DISABLE_JITO) {
  logDebugMessage("[DEBUG] Jito bundles DISABLED for testing");
}
if (FORCE_DISABLE_PRIVATE_RELAY) {
  logDebugMessage("[DEBUG] Private relay DISABLED for testing");
}
if (FORCE_DIRECT_SEND) {
  logDebugMessage(
    "[DEBUG] Direct send ONLY mode enabled (skipping Jito, private relay and RPC racing)"
  );
}

/**
 * Validates swap parameters and throws errors for invalid inputs
 */
function validateSwapParameters({ inputMint, outputMint, amountSol, chatId }) {
  if (!inputMint) {
    throw new Error("inputMint is required");
  }
  if (!outputMint) {
    throw new Error("outputMint is required");
  }
  if (!amountSol || amountSol <= 0) {
    throw new Error("amountSol must be a positive number");
  }
  if (!chatId) {
    throw new Error("chatId is required");
  }
}

/**
 * Initializes swap parameters with defaults and handles auto-detection
 */
async function initializeSwapParameters({
  slippageBps,
  priorityFeeLamports,
  connection,
}) {
  console.log(
    "[BUY] Starting parallel calculations for priority fee and slippage"
  );
  const parallelCalcsStart = Date.now();
  const [priorityFeeResult, slippageResult] = await Promise.allSettled([
    priorityFeeLamports == null
      ? withTimeout(getAdaptivePriorityFee(connection), 800, "priorityFee")
      : Promise.resolve(priorityFeeLamports),
    slippageBps == null
      ? withTimeout(getAdaptiveSlippageBps(), 800, "slippage")
      : Promise.resolve(slippageBps),
  ]);
  const parallelCalcsTime = Date.now() - parallelCalcsStart;
  console.log("[BUY] Parallel calculations completed", {
    totalTime: parallelCalcsTime,
    priorityFeeStatus: priorityFeeResult.status,
    slippageStatus: slippageResult.status,
  });

  // Handle priority fee result
  let finalPriorityFee = priorityFeeLamports;
  if (priorityFeeLamports == null) {
    if (priorityFeeResult.status === "fulfilled") {
      finalPriorityFee = priorityFeeResult.value;
      console.log("[BUY] Priority fee auto-detected", {
        value: finalPriorityFee,
      });
    } else {
      console.log("[BUY] Priority fee auto-detect failed, using default", {
        error: priorityFeeResult.reason?.message,
        fallback: Number(process.env.DEFAULT_PRIORITY_FEE_LAMPORTS || 3000000),
      });
      finalPriorityFee = Number(
        process.env.DEFAULT_PRIORITY_FEE_LAMPORTS || 3000000
      );
    }
  }
  if (typeof finalPriorityFee === "string") {
    finalPriorityFee = Number(finalPriorityFee);
  }

  // Handle slippage result
  let finalSlippage;
  if (slippageBps != null) {
    finalSlippage = slippageBps;
    console.log("[BUY] Using provided slippage", { value: finalSlippage });
  } else {
    if (slippageResult.status === "fulfilled") {
      console.log("Slippage found");
      finalSlippage = slippageResult.value;
      console.log("[BUY] Slippage auto-detected", { value: finalSlippage });
    } else {
      finalSlippage = Number(process.env.DEFAULT_SLIPPAGE_BPS || 100);
      console.log("[BUY] Slippage auto-detect failed, using default", {
        error: slippageResult.reason?.message,
        fallback: finalSlippage,
      });
    }
  }

  console.log("[BUY] Final parameters before risk check", {
    slippage: finalSlippage,
    priorityFeeLamports: finalPriorityFee,
    parallelCalcsTime,
  });

  return {
    priorityFeeLamports: finalPriorityFee,
    slippageBps: finalSlippage,
    parallelCalcsTime,
  };
}

/**
 * Calculates adaptive sizing based on liquidity and price impact optimization
 */
async function calculateAdaptiveSizing({
  amountSol,
  outputMint,
  inputMint,
  slippageBps,
  enableSizing,
  dex,
}) {
  const originalAmountSol = Number(amountSol);
  let adjustedAmount = originalAmountSol;
  let appliedLiqCap = false;
  let appliedImpact = false;
  let finalImpactPct = null;
  let tries = 0;

  if (!enableSizing || !dex || Number(dex.liquidityUsd) <= 0) {
    console.log("[BUY] Adaptive sizing disabled or no liquidity data");
    return {
      adjustedAmount,
      appliedLiqCap,
      appliedImpact,
      finalImpactPct,
      tries,
      originalAmountSol,
    };
  }

  console.log(
    "[BUY] DEX has valid liquidity, proceeding with adaptive calculations"
  );

  const tSolPrice0 = Date.now();
  const solPrice = await withTimeout(getSolPriceUSD(), 800, "solPrice").catch(
    (err) => {
      console.log("[BUY] SOL price fetch failed", { error: err?.message });
      return undefined;
    }
  );
  const solPriceFetchTime = Date.now() - tSolPrice0;
  console.log("[BUY] SOL price result", {
    success: !!solPrice,
    fetchTime: solPriceFetchTime,
    price: solPrice,
  });

  if (!solPrice || solPrice <= 0) {
    console.log("[BUY] No valid SOL price, skipping adaptive sizing");
    return {
      adjustedAmount,
      appliedLiqCap,
      appliedImpact,
      finalImpactPct,
      tries,
      originalAmountSol,
    };
  }

  console.log("[BUY] Starting adaptive sizing by liquidity");
  const liqUsd = Number(dex.liquidityUsd);
  const baseBps = Number(process.env.MAX_NOTIONAL_BPS_OF_LIQ || 30); // baseline 0.30%
  let targetBps = baseBps;
  const tiered =
    String(process.env.ADAPTIVE_LIQ_TIER || "").toLowerCase() === "true" ||
    process.env.ADAPTIVE_LIQ_TIER === "1";

  console.log("[BUY] Liquidity sizing parameters", {
    liquidityUsd: liqUsd,
    baseBps,
    tieredEnabled: tiered,
  });

  // Apply tiered liquidity adjustments
  if (tiered && Number.isFinite(liqUsd) && liqUsd > 0) {
    const oldTargetBps = targetBps;
    if (liqUsd < 50000) targetBps = Math.max(5, Math.floor(baseBps * 0.5));
    else if (liqUsd < 150000) targetBps = Math.floor(baseBps * 0.75);
    else if (liqUsd > 500000) targetBps = Math.floor(baseBps * 1.5);

    console.log("[BUY] Tiered liquidity adjustment", {
      liquidityUsd: liqUsd,
      oldTargetBps,
      newTargetBps: targetBps,
      tier:
        liqUsd < 50000
          ? "low"
          : liqUsd < 150000
          ? "medium"
          : liqUsd > 500000
          ? "high"
          : "normal",
    });
  }

  // Calculate liquidity-based cap
  const maxSolByLiq = (liqUsd * (targetBps / 10000)) / solPrice;
  console.log("[BUY] Calculated liquidity cap", {
    maxSolByLiquidity: maxSolByLiq,
    calculation: `${liqUsd} * (${targetBps}/10000) / ${solPrice}`,
  });

  let amountAfterLiq = adjustedAmount;
  if (Number.isFinite(maxSolByLiq) && maxSolByLiq > 0) {
    const minSol = Number(process.env.MIN_BUY_SOL ?? 0.01);
    const beforeAdjustment = adjustedAmount;
    const adjusted = Math.max(minSol, Math.min(adjustedAmount, maxSolByLiq));
    appliedLiqCap = adjusted !== adjustedAmount;
    adjustedAmount = adjusted;
    amountAfterLiq = adjustedAmount;

    console.log("[BUY] Liquidity cap application", {
      originalAmount: beforeAdjustment,
      maxByLiquidity: maxSolByLiq,
      minSol,
      adjustedAmount: amountAfterLiq,
      capApplied: appliedLiqCap,
      reduction: appliedLiqCap
        ? (
            ((beforeAdjustment - amountAfterLiq) / beforeAdjustment) *
            100
          ).toFixed(2) + "%"
        : "none",
    });
  }

  // Optional: adapt amount to target price impact via Jupiter quotes
  const enableImpact =
    String(process.env.ADAPTIVE_IMPACT || "").toLowerCase() === "true" ||
    process.env.ADAPTIVE_IMPACT === "1";

  console.log("[BUY] Price impact optimization", {
    enabled: enableImpact,
  });

  if (enableImpact) {
    try {
      const targetImpactBps = Number(process.env.TARGET_PRICE_IMPACT_BPS || 80); // default 0.80%
      const targetImpactPct = targetImpactBps / 100;
      const minSol = Number(process.env.MIN_BUY_SOL ?? 0.01);
      let testSol = adjustedAmount;
      const maxTries = Number(process.env.ADAPTIVE_IMPACT_MAX_TRIES || 2);

      console.log("[BUY] Starting price impact iterations", {
        targetImpactPct,
        startingAmount: testSol,
        maxTries,
        minSol,
      });

      for (let i = 0; i < maxTries; i++) {
        tries++;
        console.log(`[BUY] Price impact iteration ${tries}/${maxTries}`, {
          testAmount: testSol,
        });

        const quoteStart = Date.now();
        const q = await getTokenQuote({
          inputMint,
          outputMint,
          amountSol: testSol,
          slippageBps,
        });
        const quoteTime = Date.now() - quoteStart;
        const impactPct = Number(q?.priceImpactPct);

        console.log(`[BUY] Impact iteration ${tries} result`, {
          quoteTime,
          impactPct,
          targetImpactPct,
          testAmount: testSol,
          valid: Number.isFinite(impactPct),
        });

        if (!Number.isFinite(impactPct)) {
          console.log(
            `[BUY] Impact iteration ${tries} - invalid impact, breaking`
          );
          break;
        }

        finalImpactPct = impactPct;
        if (impactPct <= targetImpactPct) {
          console.log(`[BUY] Impact iteration ${tries} - target achieved`, {
            impactPct,
            targetImpactPct,
          });
          break;
        }

        // Early exit if impact is already very low
        if (impactPct < 0.1) {
          console.log(
            `[BUY] Impact iteration ${tries} - impact very low, breaking`,
            { impactPct }
          );
          break;
        }

        const ratio = targetImpactPct / Math.max(impactPct, 0.001);
        const factor = Math.max(0.3, Math.min(0.9, ratio));
        const nextSol = Math.max(minSol, testSol * factor);
        const adjustmentPct = Math.abs(nextSol - testSol) / testSol;

        console.log(
          `[BUY] Impact iteration ${tries} - calculating adjustment`,
          {
            ratio,
            factor,
            nextSol,
            adjustmentPct: (adjustmentPct * 100).toFixed(2) + "%",
          }
        );

        // Early exit if adjustment is too small to matter
        if (Math.abs(nextSol - testSol) < 1e-6 || adjustmentPct < 0.05) {
          console.log(
            `[BUY] Impact iteration ${tries} - adjustment too small, breaking`,
            { adjustmentPct }
          );
          break;
        }
        testSol = nextSol;
      }

      appliedImpact = Number(testSol) !== Number(amountAfterLiq);
      adjustedAmount = testSol;

      console.log("[BUY] Price impact optimization completed", {
        totalIterations: tries,
        finalAmount: testSol,
        finalImpactPct,
        impactApplied: appliedImpact,
        amountChange: appliedImpact
          ? (((amountAfterLiq - testSol) / amountAfterLiq) * 100).toFixed(2) +
            "%"
          : "none",
      });
    } catch (impactErr) {
      console.log("[BUY] Price impact optimization failed", {
        error: impactErr?.message,
      });
    }
  }

  // Log final sizing summary
  try {
    console.log(
      `[sizing][buy] liqUsd=${liqUsd} solPrice=${solPrice} baseBps=${baseBps} targetBps=${targetBps} maxSolByLiq=${
        Number.isFinite(maxSolByLiq) ? maxSolByLiq.toFixed(6) : "n/a"
      } original=${originalAmountSol} afterLiq=${amountAfterLiq} final=${adjustedAmount} appliedLiqCap=${appliedLiqCap} appliedImpact=${appliedImpact} impactPct=${
        finalImpactPct ?? "n/a"
      } tries=${tries}`
    );
  } catch (logErr) {
    console.log("[BUY] Failed to log sizing summary", {
      error: logErr?.message,
    });
  }

  return {
    adjustedAmount,
    appliedLiqCap,
    appliedImpact,
    finalImpactPct,
    tries,
    originalAmountSol,
  };
}

async function executeMultiWalletSwap({
  chatId,
  walletsCount,
  amountSol,
  inputMint,
  outputMint,
  slippage,
  priorityFeeLamports,
  effectiveUseJitoBundle,
  shouldUsePrivateRelay,
}) {
  if (!(chatId !== undefined && chatId !== null))
    throw new Error("Split buy requires user context (chatId)");
  console.log("[BUY] Starting multi-wallet split transaction flow", {
    chatId,
    requestedWalletCount: walletsCount,
    splitAcrossWallets: true,
  });
  const wallets = await getAllUserWalletKeypairs(chatId);
  if (!wallets.length) throw new Error("No wallets available for split");
  let useCount = Math.min(walletsCount || wallets.length, wallets.length);

  // Enforce a minimum per-wallet SOL notional for buys
  let perWalletSol = Number(amountSol) / useCount;
  const minPerWalletSol = Number(process.env.MIN_PER_WALLET_SOL || 0.01);
  if (perWalletSol < minPerWalletSol) {
    const maxWalletsByMin = Math.max(
      1,
      Math.floor(Number(amountSol) / Math.max(minPerWalletSol, 1e-9))
    );
    useCount = Math.min(maxWalletsByMin, wallets.length);
    perWalletSol = Number(amountSol) / useCount;
  }

  const selected = wallets.slice(0, useCount);
  const perLamports = toLamports(perWalletSol);
  console.log("[BUY] Wallet split configuration finalized", {
    totalWalletsAvailable: wallets.length,
    walletsToUse: useCount,
    perWalletSol,
    perLamports,
    totalAmount: amountSol,
    minPerWalletSol,
  });

  if (effectiveUseJitoBundle) {
    // Build and sign all txs, then bundle
    console.log("[BUY] Building Jito bundle transactions for split wallets", {
      walletCount: selected.length,
      bundleMode: true,
    });
    const signedBase64 = [];
    const signedTxs = [];
    const perWalletMeta = [];
    for (let i = 0; i < selected.length; i++) {
      const w = selected[i];
      console.log(`[BUY] Building transaction ${i + 1}/${selected.length}`, {
        wallet: w.keypair.publicKey.toBase58(),
        amount: perWalletSol,
      });
      const { route, quoteTime } = await fetchQuoteForSwap({
        inputMint,
        outputMint,
        amount: perLamports,
        slippageBps: slippage,
      });

      const { swapTx, swapTime } = await createSwapTransaction({
        route,
        userPublicKey: w.keypair.publicKey.toBase58(),
        priorityFeeLamports,
      });

      let tx;
      try {
        tx = VersionedTransaction.deserialize(Buffer.from(swapTx, "base64"));
      } catch (e) {
        throw new TransactionDeserializationError(
          "Failed to deserialize swap transaction",
          {
            op: "BUY_MULTI_BUNDLE",
            wallet: w?.keypair?.publicKey?.toBase58?.(),
            base64Len: swapTx?.length,
            cause: e,
          }
        );
      }
      tx.sign([w.keypair]);
      // Basic signature and size check
      if (!(tx.signatures?.[0] && tx.signatures[0].length > 0)) {
        throw new Error("Signed transaction has no user signature");
      }
      const _size = tx.serialize().length;
      if (_size > 1232) {
        console.log("[BUY] Warning: bundle tx size > 1232 bytes", {
          size: _size,
        });
      }
      const serialized = serializeToBase64(tx);
      signedBase64.push(serialized);
      signedTxs.push(tx);
      perWalletMeta.push({
        wallet: w.keypair.publicKey.toBase58(),
        route,
        swapTime,
        quoteTime,
      });
    }

    console.log("[BUY] Submitting Jito bundle", {
      transactionCount: signedBase64.length,
      totalAmount: amountSol,
    });
    const bundleResult = await submitBundle(signedBase64);
    console.log("[BUY] Bundle submitted", bundleResult);

    return {
      success: true,
      bundleId: bundleResult?.bundleId,
      transactions: signedTxs.map((tx, i) => ({
        signature: tx.signatures[0],
        wallet: perWalletMeta[i].wallet,
        route: perWalletMeta[i].route,
      })),
      totalWallets: selected.length,
      perWalletAmount: perWalletSol,
      bundleMode: true,
    };
  } else {
    // Non-bundle mode: submit each transaction individually
    console.log("[BUY] Processing split wallets individually (non-bundle)", {
      walletCount: selected.length,
      bundleMode: false,
    });
    const results = [];
    for (let i = 0; i < selected.length; i++) {
      const w = selected[i];
      console.log(`[BUY] Processing wallet ${i + 1}/${selected.length}`, {
        wallet: w.keypair.publicKey.toBase58(),
        amount: perWalletSol,
      });

      const { route, quoteTime } = await fetchQuoteForSwap({
        inputMint,
        outputMint,
        amount: perLamports,
        slippageBps: slippage,
      });

      const { swapTx, swapTime } = await createSwapTransaction({
        route,
        userPublicKey: w.keypair.publicKey.toBase58(),
        priorityFeeLamports,
      });

      let tx;
      try {
        tx = VersionedTransaction.deserialize(Buffer.from(swapTx, "base64"));
      } catch (e) {
        throw new TransactionDeserializationError(
          "Failed to deserialize swap transaction",
          {
            op: "BUY_MULTI_INDIVIDUAL",
            wallet: w?.keypair?.publicKey?.toBase58?.(),
            base64Len: swapTx?.length,
            cause: e,
          }
        );
      }
      tx.sign([w.keypair]);

      // Validate signatures and size
      {
        const header = tx.message?.header;
        const required = header?.numRequiredSignatures ?? 0;
        const present = (tx.signatures || []).filter(
          (s) => s && s.length > 0
        ).length;
        if (required > 0 && present < required) {
          throw new Error(
            `Insufficient signatures: have ${present}, need ${required}`
          );
        }
        const _size = tx.serialize().length;
        if (_size > 1232) {
          console.log("[BUY] Warning: swap tx size > 1232 bytes", {
            size: _size,
          });
        }
      }

      const connection = getUserConnectionInstance(chatId);
      const signature = await submitTransaction(tx, {
        useJitoBundle: false, // Individual wallet transactions don't use Jito bundles
        usePrivateRelay: shouldUsePrivateRelay,
        connection,
        walletAddress: w.keypair.publicKey.toString(),
        operationType: "MULTI_WALLET_SWAP",
      });

      results.push({
        signature,
        wallet: w.keypair.publicKey.toBase58(),
        route,
        swapTime,
        quoteTime,
      });
      console.log(`[BUY] Transaction ${i + 1} submitted`, { signature });
    }

    return {
      success: true,
      transactions: results,
      totalWallets: selected.length,
      perWalletAmount: perWalletSol,
      bundleMode: false,
    };
  }
}

/**
 * Fetches a quote from Jupiter API for a swap operation.
 *
 * @param {Object} params - Quote parameters
 * @param {string} params.inputMint - Input token mint address
 * @param {string} params.outputMint - Output token mint address
 * @param {number} params.amount - Amount in lamports
 * @param {number} params.slippageBps - Slippage in basis points
 * @returns {Promise<Object>} Quote response with route and timing info
 */
async function fetchQuoteForSwap({
  inputMint,
  outputMint,
  amount,
  slippageBps,
}) {
  const qUrl = `${JUP_BASE}/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
  console.log("[QUOTE] Fetching quote", { qUrl });

  const quoteStart = Date.now();
  const qRes = await httpGetWithRetry(qUrl);
  const quoteTime = Date.now() - quoteStart;
  const route = qRes?.data;

  if (!route) {
    throw new Error("No route available for swap");
  }

  // Add debug logging to see the actual response structure
  if (JUP_DEBUG) {
    console.log("[QUOTE] Raw response:", JSON.stringify(route, null, 2));
  }

  console.log("[QUOTE] Quote received", {
    quoteTime,
    outAmount: route?.outAmount,
    priceImpact: route?.priceImpactPct,
    routeLabels:
      route?.routePlan?.map((p) => p?.swapInfo?.label).join(">") || "unknown",
  });

  return { route, quoteTime };
}

/**
 * Creates a swap transaction using Jupiter API.
 *
 * @param {Object} params - Transaction creation parameters
 * @param {Object} params.route - Quote route from Jupiter
 * @param {string} params.userPublicKey - User's public key
 * @param {number|string} params.priorityFeeLamports - Priority fee in lamports or 'auto'
 * @returns {Promise<Object>} Swap transaction response with timing info
 */
async function createSwapTransaction({
  route,
  userPublicKey,
  priorityFeeLamports,
}) {
  console.log("[SWAP] Creating swap transaction");

  const swapStart = Date.now();
  console.log(route);
  console.log(userPublicKey);
  console.log(priorityFeeLamports);

  const swapRes = await httpPostWithRetry(
    `${JUP_BASE}/v6/swap`,
    {
      quoteResponse: route,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: (() => {
        if (priorityFeeLamports === null || priorityFeeLamports === undefined) {
          return "auto";
        }
        if (typeof priorityFeeLamports === "string") {
          if (priorityFeeLamports.toLowerCase() === "auto") {
            return "auto";
          }
          const parsed = parseInt(priorityFeeLamports, 10);
          if (isNaN(parsed)) {
            console.warn(
              `[SWAP] Invalid priorityFeeLamports string: ${priorityFeeLamports}, using auto`
            );
            return "auto";
          }
          return parsed;
        }
        return priorityFeeLamports;
      })(),
    },
    { timeout: JUP_SWAP_TIMEOUT_MS }
  );
  console.log(swapRes?.data || swapRes);

  const swapTime = Date.now() - swapStart;
  const swapTx = swapRes?.data?.swapTransaction;

  if (!swapTx) {
    throw new Error("No swap transaction received");
  }

  console.log("[SWAP] Swap transaction created", {
    swapTime,
    txSize: swapTx.length,
  });

  // Extra debug: log base64 head and decoded transaction summary (no secrets)
  try {
    const head = swapTx.slice(0, 160);
    console.log("[SWAP] swapTx base64 head", { headLen: head.length, head });
    const txDecoded = VersionedTransaction.deserialize(
      Buffer.from(swapTx, "base64")
    );
    const msg = txDecoded.message || {};
    // Attempt to extract a few safe details
    const recentBlockhash =
      msg.recentBlockhash || msg.header?.recentBlockhash || undefined;
    const staticKeys = Array.isArray(msg.staticAccountKeys)
      ? msg.staticAccountKeys.map((k) =>
          typeof k?.toBase58 === "function" ? k.toBase58() : String(k)
        )
      : [];
    const compiled = Array.isArray(msg.compiledInstructions)
      ? msg.compiledInstructions
      : Array.isArray(msg.instructions)
      ? msg.instructions
      : [];
    const programIds = Array.from(
      new Set(
        compiled
          .map((ix) => {
            const idx =
              typeof ix?.programIdIndex === "number"
                ? ix.programIdIndex
                : undefined;
            if (typeof idx === "number" && staticKeys[idx])
              return staticKeys[idx];
            // Some web3 versions may have programId directly
            const pid = ix?.programId;
            if (pid && typeof pid?.toBase58 === "function")
              return pid.toBase58();
            return idx;
          })
          .filter((v) => v !== undefined)
      )
    );
    console.log("[SWAP] Decoded tx summary", {
      feePayer: staticKeys[0],
      numStaticAccountKeys: staticKeys.length,
      numInstructions: compiled.length,
      recentBlockhash,
      programIds,
    });
  } catch (decErr) {
    console.log("[SWAP] Failed to decode swapTx for debug", {
      error: decErr?.message,
    });
  }

  return { swapTx, swapTime };
}

/**
 * Get wallet token balance and account information
 * @param {PublicKey} walletPublicKey - The wallet's public key
 * @param {string} tokenMint - The token mint address
 * @param {Connection} connection - Solana connection
 * @returns {Promise<{balanceRaw: bigint, decimals: number, account: any}>}
 */
async function getWalletTokenBalance(walletPublicKey, tokenMint, connection) {
  const tokenPk = new PublicKey(tokenMint);
  const resp = await connection.getParsedTokenAccountsByOwner(walletPublicKey, {
    mint: tokenPk,
  });
  const acct = resp.value?.[0]?.account?.data?.parsed?.info;
  if (!acct) throw new Error("Token account not found");
  const decimals = Number(acct.tokenAmount?.decimals || 0);
  const balanceRaw = BigInt(acct.tokenAmount?.amount || "0");
  return { balanceRaw, decimals, account: acct };
}

/**
 * Calculate the amount to sell based on tokens or percentage
 * @param {number|null} amountTokens - Exact token amount to sell
 * @param {number} percent - Percentage of balance to sell
 * @param {bigint} balanceRaw - Raw token balance
 * @param {number} decimals - Token decimals
 * @param {number} walletCount - Number of wallets (for splitting)
 * @returns {bigint} Amount to sell in raw units
 */
function calculateSellAmount(
  amountTokens,
  percent,
  balanceRaw,
  decimals,
  walletCount = 1
) {
  let amountRaw;
  if (amountTokens != null) {
    if (walletCount > 1) {
      const perWallet = Number(amountTokens) / walletCount;
      amountRaw = BigInt(Math.floor(perWallet * 10 ** decimals));
    } else {
      amountRaw = BigInt(Math.floor(Number(amountTokens) * 10 ** decimals));
    }
  } else {
    const p = Math.max(1, Math.min(100, Math.floor(percent)));
    amountRaw = (balanceRaw * BigInt(p)) / 100n;
  }
  if (amountRaw <= 0n) throw new Error("Amount to sell is zero");
  return amountRaw;
}

/**
 * Execute multi-wallet sell operation
 * @param {Object} params - Sell parameters
 * @param {string} params.chatId - User chat ID
 * @param {string} params.tokenMint - Token mint to sell
 * @param {number|null} params.amountTokens - Exact token amount
 * @param {number} params.percent - Percentage to sell
 * @param {number} params.slippage - Slippage in BPS
 * @param {number} params.priorityFeeLamports - Priority fee
 * @param {boolean} params.effectiveUseJitoBundle - Use Jito bundle
 * @param {boolean} params.shouldUsePrivateRelay - Use private relay
 * @param {number} params.walletsCount - Number of wallets to use
 * @param {Connection} params.connection - Solana connection
 * @returns {Promise<{txids: string[]}>}
 */
async function executeMultiWalletSell({
  chatId,
  tokenMint,
  amountTokens,
  percent,
  slippage,
  priorityFeeLamports,
  effectiveUseJitoBundle,
  shouldUsePrivateRelay,
  walletsCount,
  connection,
}) {
  const wallets = await getAllUserWalletKeypairs(chatId);
  if (!wallets.length) throw new Error("No wallets available for split");
  const useCount = Math.min(walletsCount || wallets.length, wallets.length);
  const selected = wallets.slice(0, useCount);
  const results = [];

  for (const w of selected) {
    try {
      const { balanceRaw, decimals } = await getWalletTokenBalance(
        w.keypair.publicKey,
        tokenMint,
        connection
      );

      if (balanceRaw === 0n) throw new Error("Zero token balance");

      const amountRaw = calculateSellAmount(
        amountTokens,
        percent,
        balanceRaw,
        decimals,
        useCount
      );

      const { route, quoteTime } = await fetchQuoteForSwap({
        inputMint: tokenMint,
        outputMint: SOL_MINT,
        amount: amountRaw.toString(),
        slippageBps: slippage,
      });

      const { swapTx, swapTime } = await createSwapTransaction({
        route,
        userPublicKey: w.keypair.publicKey.toBase58(),
        priorityFeeLamports,
      });

      let tx;
      try {
        tx = VersionedTransaction.deserialize(Buffer.from(swapTx, "base64"));
      } catch (e) {
        throw new TransactionDeserializationError(
          "Failed to deserialize swap transaction",
          {
            op: "SELL_MULTI",
            wallet: w?.keypair?.publicKey?.toBase58?.(),
            base64Len: swapTx?.length,
            cause: e,
          }
        );
      }
      tx.sign([w.keypair]);

      // Validate signatures and size
      {
        const header = tx.message?.header;
        const required = header?.numRequiredSignatures ?? 0;
        const present = (tx.signatures || []).filter(
          (s) => s && s.length > 0
        ).length;
        if (required > 0 && present < required) {
          throw new Error(
            `Insufficient signatures: have ${present}, need ${required}`
          );
        }
        const _size = tx.serialize().length;
        if (_size > 1232) {
          console.log("[SELL] Warning: swap tx size > 1232 bytes", {
            size: _size,
          });
        }
      }

      const t0 = Date.now();
      const txid = await submitTransaction(tx, {
        useJitoBundle: effectiveUseJitoBundle,
        usePrivateRelay: shouldUsePrivateRelay,
        connection,
        walletAddress: w.keypair.publicKey.toString(),
        operationType: "SELL",
      });
      const latencyMs = Date.now() - t0;
      results.push(txid);

      try {
        addTradeLog(chatId, {
          kind: "sell",
          mint: tokenMint,
          solOut:
            route?.outAmount && route?.outToken?.decimals != null
              ? route.outAmount / 10 ** route.outToken.decimals
              : undefined,
          txid,
          latencyMs,
        });
      } catch {}
    } catch (e) {
      // continue other wallets
    }
  }
  return { txids: results };
}

/**
 * Configures private relay setting based on user preferences and debug flags
 * @param {boolean|null} usePrivateRelay - Explicit override for private relay
 * @param {string|null} chatId - User chat ID for getting user state
 * @returns {boolean} Whether to use private relay
 */
function configurePrivateRelay(usePrivateRelay, chatId) {
  let shouldUsePrivateRelay =
    usePrivateRelay != null
      ? !!usePrivateRelay
      : chatId != null
      ? !!getUserState(chatId).enablePrivateRelay
      : false;

  // Apply debug flag override for private relay
  if (FORCE_DISABLE_PRIVATE_RELAY) {
    shouldUsePrivateRelay = false;
    logDebugMessage(
      "[DEBUG] Private relay disabled by FORCE_DISABLE_PRIVATE_RELAY"
    );
  }

  return shouldUsePrivateRelay;
}

/**
 * Safely adds a trade log entry with error handling
 * @param {string} chatId - User chat ID
 * @param {Object} logData - Trade log data
 */
function addTradeLogSafely(chatId, logData) {
  try {
    addTradeLog(chatId, logData);
  } catch {}
}

/**
 * Logs debug messages when JUP_DEBUG is enabled
 * @param {string} message - Debug message to log
 * @param {Object} data - Optional data to include in log
 */
function logDebugMessage(message, data = null) {
  // Backward compatible helper
  logDebug(message, data);
}

// Structured logging helpers
function logStructured(level, message, data = null) {
  const payload = {
    level,
    ts: new Date().toISOString(),
    module: "jupiter",
    msg: message,
    ...(data && typeof data === "object" ? data : data != null ? { data } : {}),
  };
  if (level === "error") return console.error(payload);
  if (level === "warn") return console.warn(payload);
  if (level === "info") return console.log(payload);
  // debug level
  if (JUP_DEBUG) return console.log(payload);
}
function logDebug(message, data = null) {
  return logStructured("debug", message, data);
}
function logInfo(message, data = null) {
  return logStructured("info", message, data);
}
function logWarn(message, data = null) {
  return logStructured("warn", message, data);
}
function logError(message, data = null) {
  return logStructured("error", message, data);
}

// Custom error types for clearer control flow and retries
class JupiterApiError extends Error {
  constructor(
    message,
    { url, method = "GET", status, code, attempt, attempts, data, cause } = {}
  ) {
    super(message);
    this.name = "JupiterApiError";
    this.url = url;
    this.method = method;
    this.status = status;
    this.code = code;
    this.attempt = attempt;
    this.attempts = attempts;
    this.data = data;
    if (cause) this.cause = cause;
  }
}

class NetworkTimeoutError extends Error {
  constructor(
    message,
    { url, method = "GET", timeout, attempt, attempts, cause } = {}
  ) {
    super(message);
    this.name = "NetworkTimeoutError";
    this.url = url;
    this.method = method;
    this.timeout = timeout;
    this.attempt = attempt;
    this.attempts = attempts;
    if (cause) this.cause = cause;
  }
}

class TransactionDeserializationError extends Error {
  constructor(message, { op, wallet, base64Len, cause } = {}) {
    super(message);
    this.name = "TransactionDeserializationError";
    this.op = op;
    this.wallet = wallet;
    this.base64Len = base64Len;
    if (cause) this.cause = cause;
  }
}

class TransactionConstructionError extends Error {}
class SubmissionError extends Error {}
class RateLimitedError extends Error {}

/**
 * Unified transaction submission handler that supports Jito bundles, RPC racing, and fallback mechanisms
 * @param {VersionedTransaction} tx - The signed transaction to submit
 * @param {Object} options - Submission options
 * @param {boolean} options.useJitoBundle - Whether to attempt Jito bundle submission first
 * @param {boolean} options.usePrivateRelay - Whether to use private relay for RPC racing
 * @param {Connection} options.connection - Solana connection instance
 * @param {string} options.walletAddress - Wallet address for logging purposes
 * @param {string} options.operationType - Operation type ('BUY' or 'SELL') for logging
 * @returns {Promise<string>} Transaction ID or bundle UUID
 */
async function submitTransaction(
  tx,
  {
    useJitoBundle = false,
    usePrivateRelay = false,
    connection,
    walletAddress = "unknown",
    operationType = "TRANSACTION",
  }
) {
  const t0 = Date.now();
  let txid;

  // Basic preflight checks and diagnostics
  try {
    const header = tx.message?.header;
    const required = header?.numRequiredSignatures ?? 0;
    const present = (tx.signatures || []).filter(
      (s) => s && s.length > 0
    ).length;
    if (required > 0 && present < required) {
      throw new Error(
        `Cannot submit: have ${present} signatures, need ${required}`
      );
    }
    const serializedLen = tx.serialize().length;
    const instrCount = tx.message?.compiledInstructions?.length ?? 0;
    if (JUP_DEBUG) {
      console.log(`[${operationType}] Tx preflight`, {
        walletAddress,
        serializedLen,
        instrCount,
      });
    }
  } catch (e) {
    console.log(
      `[${operationType}] Tx preflight failed for wallet ${walletAddress}`,
      {
        error: e.message,
      }
    );
    throw e;
  }

  if (useJitoBundle) {
    console.log(
      `[${operationType}] Attempting Jito bundle submission for wallet ${walletAddress}`
    );
    const base64Signed = serializeToBase64(tx);
    try {
      const resp = await submitBundleWithTarget([base64Signed]);
      txid = resp?.uuid || "bundle_submitted";
      console.log(
        `[${operationType}] Jito bundle submitted for wallet ${walletAddress}`,
        { bundleUuid: txid, latencyMs: Date.now() - t0 }
      );
      return txid;
    } catch (e) {
      console.log(
        `[${operationType}] Jito bundle failed for wallet ${walletAddress}, trying RPC race`,
        {
          error: e.message,
          errorCode: e.code,
        }
      );
      // Fall through to RPC racing
    }
  }

  // RPC racing with fallback
  try {
    txid = await sendTransactionRaced(tx, {
      skipPreflight: true,
      usePrivateRelay: usePrivateRelay,
    });
    console.log(
      `[${operationType}] RPC race successful for wallet ${walletAddress}`,
      { txid, latencyMs: Date.now() - t0 }
    );
  } catch (e) {
    console.log(
      `[${operationType}] RPC race failed for wallet ${walletAddress}, trying raw RPC`,
      {
        error: e.message,
        errorCode: e.code,
      }
    );
    rotateRpc("race failed");
    const rawBytes = tx.serialize();
    const maxRawAttempts = 2;
    for (let attempt = 1; attempt <= maxRawAttempts; attempt++) {
      try {
        txid = await connection.sendRawTransaction(rawBytes, {
          skipPreflight: true,
        });
        console.log(
          `[${operationType}] Raw RPC successful for wallet ${walletAddress}`,
          { txid, latencyMs: Date.now() - t0, attempt }
        );
        break;
      } catch (err) {
        const msg = err?.message || String(err);
        const retryable =
          /429|Too Many Requests|Node is behind|RPC endpoint unavailable|Connection reset|Blockhash not found|rate limit/i.test(
            msg
          );
        console.log(
          `[${operationType}] Raw RPC attempt ${attempt} failed for wallet ${walletAddress}`,
          { error: msg }
        );
        if (attempt < maxRawAttempts && retryable) {
          rotateRpc("raw send retry");
          await sleep(300 * attempt);
          continue;
        }
        throw err;
      }
    }
  }

  return txid;
}

// Retry helpers to mitigate 429s and transient errors from Jupiter
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function isRetryableError(err) {
  const status = err?.response?.status;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  const code = err?.code;
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNABORTED")
    return true;
  const msg = err?.message || "";
  if (msg.toLowerCase().includes("timeout")) return true;
  return false;
}

// Lightweight global concurrency + min-gap limiter for Jupiter HTTP attempts
const MAX_CONCURRENCY = Number(process.env.JUP_CONCURRENCY || 3);
const MIN_GAP_MS = Number(process.env.JUP_MIN_GAP_MS || 300);
const RL_CONCURRENCY = Number(process.env.JUP_RL_CONCURRENCY || 1);
const RL_MIN_GAP_MS = Number(process.env.JUP_RL_MIN_GAP_MS || 1000);

let inFlight = 0;
let lastStartAt = 0;
let rlActiveUntil = 0; // when > now, enter stricter limiter mode
const waitQueue = [];

function isRlActive() {
  return Date.now() < rlActiveUntil;
}
function currentConcurrency() {
  return isRlActive() ? RL_CONCURRENCY : MAX_CONCURRENCY;
}
function currentMinGap() {
  return isRlActive() ? RL_MIN_GAP_MS : MIN_GAP_MS;
}
function markRateLimited(ms) {
  const bump = Math.max(ms || 0, currentMinGap());
  rlActiveUntil = Math.max(rlActiveUntil, Date.now() + bump);
  if (JUP_DEBUG) console.log(`[RL] Activating rate-limit window for ${bump}ms`);
}

async function scheduleJupAttempt() {
  return new Promise((resolve) => {
    const tryStart = async () => {
      const now = Date.now();
      const gapSinceLast = now - lastStartAt;
      const minGap = currentMinGap();
      if (
        inFlight < currentConcurrency() &&
        gapSinceLast >= minGap &&
        now >= rlActiveUntil
      ) {
        inFlight += 1;
        lastStartAt = now;
        resolve(() => {
          inFlight = Math.max(0, inFlight - 1);
          const next = waitQueue.shift();
          if (next) setTimeout(next, currentMinGap());
        });
      } else {
        waitQueue.push(tryStart);
      }
    };
    tryStart();
  });
}

function parseRetryAfterMs(err) {
  const h = err?.response?.headers || {};
  const ra = h["retry-after"] || h["Retry-After"];
  if (!ra) return null;
  const n = Number(ra);
  if (Number.isFinite(n)) return Math.max(0, Math.floor(n * 1000));
  const ts = Date.parse(ra);
  if (Number.isFinite(ts)) return Math.max(0, ts - Date.now());
  return null;
}

/* Removed duplicate QUOTE_CACHE/httpGetWithRetry/httpPostWithRetry/fetchDexTokenInfo/toLamports block */

// Small utility to cap long-running awaits in pre-quote phase
async function withTimeout(promise, ms, label = "op") {
  let to;
  const t0 = Date.now();
  return Promise.race([
    promise.finally(() => clearTimeout(to)),
    new Promise((_, rej) => {
      to = setTimeout(
        () => rej(new Error(`${label} timed out after ${ms}ms`)),
        ms
      );
    }),
  ]).finally(() => {
    const dt = Date.now() - t0;
    if (JUP_DEBUG) console.log(`[withTimeout] ${label} finished in ${dt}ms`);
  });
}

// Short-lived cache and in-flight deduplication for identical quote URLs
const QUOTE_CACHE_TTL = Number(process.env.JUP_QUOTE_CACHE_MS || 1000);
const quoteCache = new Map(); // url -> { at, resp }
const inflightQuotes = new Map(); // url -> Promise

async function httpGetWithRetry(
  url,
  options = {},
  retries = 6,
  baseDelayMs = 200,
  maxDelayMs = 2000
) {
  const isQuote =
    typeof url === "string" && url.startsWith(`${JUP_BASE}/v6/quote`);
  if (JUP_DEBUG && isQuote) console.log(`[JUP] GET ${url}`);

  async function coreGet() {
    let attempt = 0;
    while (true) {
      if (JUP_DEBUG && isQuote) console.log("[JUP] trying to get quote");

      let release;
      try {
        release = await scheduleJupAttempt();
        const merged = {
          timeout: 1500,
          ...options,
          headers: {
            "User-Agent": "TurboSolBot/1.0",
            Accept: "application/json",
            ...(options?.headers || {}),
          },
        };
        const result = await axios.get(url, merged);

        if (JUP_DEBUG && isQuote)
          console.log(`[JUP] response ${result.status} ${result.statusText}`);

        return result;
      } catch (e) {
        attempt++;
        if (attempt > retries || !isRetryableError(e)) {
          const isTimeout =
            e?.code === "ETIMEDOUT" ||
            e?.code === "ECONNABORTED" ||
            /timed out/i.test(e?.message || "");
          const finalErr = isTimeout
            ? new NetworkTimeoutError("GET request timed out", {
                url,
                method: "GET",
                timeout: options?.timeout ?? 1500,
                attempt,
                attempts: retries,
                cause: e,
              })
            : new JupiterApiError("Jupiter API GET failed", {
                url,
                method: "GET",
                status: e?.response?.status,
                code: e?.code,
                attempt,
                attempts: retries,
                cause: e,
              });
          throw finalErr;
        }
        const retryAfter = parseRetryAfterMs(e);
        // Activate stricter rate-limit window based on server signal
        try {
          markRateLimited(retryAfter);
        } catch {}
        const backoff = baseDelayMs * 2 ** (attempt - 1);
        const jitter = Math.floor(Math.random() * 180);
        const delay = Math.min(
          retryAfter != null
            ? Math.max(retryAfter, backoff) + jitter
            : backoff + jitter,
          maxDelayMs
        );
        await sleep(delay);
      } finally {
        try {
          release && release();
        } catch {}
      }
    }
  }

  if (isQuote && QUOTE_CACHE_TTL > 0) {
    const cached = quoteCache.get(url);
    const now = Date.now();
    if (cached && now - cached.at <= QUOTE_CACHE_TTL) {
      return cached.resp;
    }
    const inflight = inflightQuotes.get(url);
    if (inflight) return await inflight;
    const p = (async () => {
      try {
        const resp = await coreGet();
        quoteCache.set(url, { at: Date.now(), resp });
        return resp;
      } finally {
        inflightQuotes.delete(url);
      }
    })();
    inflightQuotes.set(url, p);
    return await p;
  }
  return await coreGet();
}

async function httpPostWithRetry(
  url,
  body,
  options = {},
  retries = 6,
  baseDelayMs = 1000,
  maxDelayMs = 2000
) {
  console.log("Posting with retry", url, body, options);
  console.log(body["quoteResponse"]["routePlan"]);

  let attempt = 0;
  const startTime = Date.now();
  if (JUP_DEBUG) {
    console.log("[HTTP] Starting POST request", {
      url,
      timeout: options?.timeout || 2000,
      retries,
      attempt: 0,
    });
  }

  while (true) {
    let release;
    const attemptStart = Date.now();
    try {
      release = await scheduleJupAttempt();
      const merged = {
        timeout: options?.timeout ?? JUP_SWAP_TIMEOUT_MS,
        ...options,
        headers: {
          "User-Agent": "TurboSolBot/1.0",
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(options?.headers || {}),
        },
      };

      if (JUP_DEBUG) {
        console.log("[HTTP] Making request attempt", {
          attempt: attempt + 1,
          timeout: merged.timeout,
          elapsed: Date.now() - startTime,
        });
      }

      const result = await axios.post(url, body, merged);

      console.log("Result is ");

      console.log(result);

      if (JUP_DEBUG) {
        console.log("[HTTP] Request successful", {
          attempt: attempt + 1,
          totalTime: Date.now() - startTime,
          attemptTime: Date.now() - attemptStart,
        });
      }

      return result;
    } catch (e) {
      attempt++;
      const attemptTime = Date.now() - attemptStart;

      if (JUP_DEBUG) {
        console.log("[HTTP] Request attempt failed", {
          attempt,
          error: e?.message,
          code: e?.code,
          status: e?.response?.status,
          attemptTime,
          totalTime: Date.now() - startTime,
          isRetryable: isRetryableError(e),
          willRetry: attempt <= retries && isRetryableError(e),
        });
      }

      if (attempt > retries || !isRetryableError(e)) {
        if (JUP_DEBUG) {
          console.log("[HTTP] Giving up on request", {
            finalAttempt: attempt,
            totalTime: Date.now() - startTime,
            reason: attempt > retries ? "max_retries" : "non_retryable_error",
          });
        }
        const isTimeout =
          e?.code === "ETIMEDOUT" ||
          e?.code === "ECONNABORTED" ||
          /timed out/i.test(e?.message || "");
        const finalErr = isTimeout
          ? new NetworkTimeoutError("POST request timed out", {
              url,
              method: "POST",
              timeout: options?.timeout ?? JUP_SWAP_TIMEOUT_MS,
              attempt,
              attempts: retries,
              cause: e,
            })
          : new JupiterApiError("Jupiter API POST failed", {
              url,
              method: "POST",
              status: e?.response?.status,
              code: e?.code,
              attempt,
              attempts: retries,
              data: body,
              cause: e,
            });
        throw finalErr;
      }

      const retryAfter = parseRetryAfterMs(e);
      // Activate stricter rate-limit window based on server signal
      try {
        markRateLimited(retryAfter);
      } catch {}
      const backoff = baseDelayMs * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * 200);
      const delay = Math.min(
        retryAfter != null
          ? Math.max(retryAfter, backoff) + jitter
          : backoff + jitter,
        maxDelayMs
      );

      if (JUP_DEBUG) {
        console.log("[HTTP] Waiting before retry", {
          delay,
          retryAfter,
          backoff,
          jitter,
        });
      }

      await sleep(delay);
    } finally {
      try {
        release && release();
      } catch {}
    }
  }
}

// Best-effort Dexscreener fetch for liquidity and price
async function fetchDexTokenInfo(mint, timeoutMs = 800) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
  const { data } = await axios.get(url, { timeout: timeoutMs });
  const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
  let best = null;
  for (const p of pairs) {
    const liq = Number(p?.liquidity?.usd || 0);
    if (!Number.isNaN(liq)) {
      if (!best || liq > best.liquidityUsd) {
        best = {
          liquidityUsd: liq,
          priceUsd: p?.priceUsd != null ? Number(p.priceUsd) : undefined,
        };
      }
    }
  }
  return best || { liquidityUsd: 0, priceUsd: undefined };
}

function toLamports(sol) {
  return Math.floor(Number(sol) * 1e9);
}

// Generic raw quote helper (input/output can be any mint; amountRaw is base units of inputMint)
export async function getQuoteRaw({
  inputMint,
  outputMint,
  amountRaw,
  slippageBps,
  timeoutMs,
}) {
  const slippage =
    slippageBps ?? Number(process.env.DEFAULT_SLIPPAGE_BPS || 100);
  const url = `${JUP_BASE}/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippage}`;
  const { data } = await httpGetWithRetry(
    url,
    timeoutMs ? { timeout: timeoutMs } : undefined
  );

  const route = data;
  return route || null;
}

// Cache for mint decimals to avoid repeated RPC calls
const mintDecimalsCache = new Map();
async function getMintDecimalsCached(mint) {
  if (mintDecimalsCache.has(mint)) return mintDecimalsCache.get(mint);
  try {
    const conn = getConnection();
    const info = await conn.getParsedAccountInfo(new PublicKey(mint));
    const decimals = info?.value?.data?.parsed?.info?.decimals;
    if (decimals != null) {
      mintDecimalsCache.set(mint, Number(decimals));
      return Number(decimals);
    }
  } catch (e) {
    // swallow; we'll handle undefined decimals upstream
  }
  return undefined;
}

export async function getTokenQuote({
  inputMint,
  outputMint,
  amountSol,
  slippageBps,
}) {
  const amount = toLamports(amountSol);
  const slippage =
    slippageBps ?? Number(process.env.DEFAULT_SLIPPAGE_BPS || 100);
  const url = `${JUP_BASE}/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippage}`;
  if (JUP_DEBUG) console.log("[IMPACT] Quote URL", url);
  const { data } = await httpGetWithRetry(
    url,
    { timeout: JUP_QUOTE_TIMEOUT_MS },
    JUP_HTTP_RETRIES,
    JUP_HTTP_BASE_DELAY_MS,
    JUP_HTTP_MAX_DELAY_MS
  );
  console.log("[JUPITER] Raw API Response:", JSON.stringify(data, null, 2));
  console.log("[JUPITER] Response Validation:", {
    hasOutAmount: !!data.outAmount,
    hasFormatted: !!data.outAmountFormatted,
    routeExists: data.routePlan?.length > 0,
  });

  const route = data;
  if (!route) return null;

  // Determine decimals from route token info or fall back to on-chain mint data
  let decimals = route?.outToken?.decimals;
  if (decimals == null) {
    decimals = await getMintDecimalsCached(outputMint);
  }

  const outAmountFormatted =
    decimals != null
      ? Number(route.outAmount) / 10 ** Number(decimals)
      : Number(route.outAmount);

  return {
    route,
    outAmountFormatted,
    outputSymbol: route?.outToken?.symbol,
    routeName:
      route?.routePlan?.map((p) => p?.swapInfo?.label).join(">") ||
      (route?.routePlan ? "routePlan" : "route"),
    priceImpactPct:
      route?.priceImpactPct != null
        ? Math.round(route.priceImpactPct * 10000) / 100
        : undefined,
  };
}

export async function performSwap({
  inputMint,
  outputMint,
  amountSol,
  slippageBps,
  priorityFeeLamports,
  useJitoBundle = true,
  usePrivateRelay,
  splitAcrossWallets = false,
  walletsCount,
  chatId,
  riskBypass = false,
  adaptiveSizingByLiquidity,
  adaptiveSplit,
}) {
  const swapStartTime = Date.now();
  console.log("[BUY] performSwap start", {
    chatId,
    inputMint,
    outputMint,
    amountSol,
    slippageBps,
    priorityFeeLamports,
    useJitoBundle,
    usePrivateRelay,
    splitAcrossWallets,
    walletsCount,
    timestamp: swapStartTime,
  });

  // Validate required parameters
  validateSwapParameters({ inputMint, outputMint, amountSol, chatId });

  // SIMPLE MODE: minimal path to make transactions work (bypasses risk checks, adaptive sizing, bundles, relays, and racing)
  if (String(process.env.SIMPLE_MODE || '').toLowerCase() === 'true') {
    const simpleStart = Date.now();
    try {
      const connection = await getUserConnectionInstance(chatId);
      const wallet = await getUserWalletInstance(chatId);

      const simpleSlippageBps =
        slippageBps ?? Number(process.env.DEFAULT_SLIPPAGE_BPS || 100);
      const { route, outAmountFormatted, outputSymbol, priceImpactPct } =
        await getTokenQuote({
          inputMint,
          outputMint,
          amountSol,
          slippageBps: simpleSlippageBps,
        });
      if (!route) {
        throw new Error('No route returned from quote');
      }

      const { swapTx } = await createSwapTransaction({
        route,
        userPublicKey: wallet.publicKey.toBase58(),
        priorityFeeLamports:
          priorityFeeLamports ??
          Number(process.env.DEFAULT_PRIORITY_FEE_LAMPORTS || 100000),
      });
      if (!swapTx) throw new Error('No swap transaction returned');

      let tx;
      try {
        tx = VersionedTransaction.deserialize(Buffer.from(swapTx, 'base64'));
      } catch (e) {
        throw new TransactionDeserializationError('Failed to deserialize swap transaction', {
          op: 'BUY_SIMPLE_MODE',
          wallet: wallet?.publicKey?.toBase58?.(),
          base64Len: swapTx?.length,
          cause: e,
        });
      }

      try {
        tx.sign([wallet]);
      } catch (e) {
        throw new Error(`Transaction signing failed: ${e?.message || e}`);
      }

      const rawBytes = tx.serialize();
      let txid;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          txid = await connection.sendRawTransaction(rawBytes, {
            skipPreflight: true,
            maxRetries: 2,
          });
          break;
        } catch (e) {
          if (attempt === 3) {
            throw new SubmissionError('Raw send failed in SIMPLE_MODE', { cause: e });
          }
          await sleep(150 * attempt);
        }
      }

      const latencyMs = Date.now() - simpleStart;
      return {
        txid,
        output: {
          tokensOut: outAmountFormatted,
          symbol: outputSymbol,
        },
        route: {
          priceImpactPct,
          labels: route?.routePlan?.map((p) => p?.swapInfo?.label),
        },
        slippageBps: simpleSlippageBps,
        priorityFeeLamports:
          priorityFeeLamports ??
          Number(process.env.DEFAULT_PRIORITY_FEE_LAMPORTS || 100000),
        via: 'SIMPLE_MODE',
        latencyMs,
      };
    } catch (e) {
      console.error('[SIMPLE_MODE] swap failed', { error: e?.message || e });
      throw e;
    }
  }

  const connection = await getUserConnectionInstance(chatId);
  console.log(connection);

  const wallet = await getUserWalletInstance(chatId);
  console.log(wallet);

  // Initialize parameters with auto-detection and defaults
  const {
    priorityFeeLamports: finalPriorityFee,
    slippageBps: slippage,
    parallelCalcsTime,
  } = await initializeSwapParameters({
    slippageBps,
    priorityFeeLamports,
    connection,
  });

  priorityFeeLamports = finalPriorityFee;
  console.log("Priority fee lamports", priorityFeeLamports);

  if (!riskBypass) {
    const requireLpLock =
      String(process.env.REQUIRE_LP_LOCK || "").toLowerCase() === "true" ||
      process.env.REQUIRE_LP_LOCK === "1";
    const maxBuyTaxBps = Number(process.env.MAX_BUY_TAX_BPS || 1500);
    console.log("[BUY] riskCheckToken start", {
      outputMint,
      requireLpLock,
      maxBuyTaxBps,
    });
    const tRisk0 = Date.now();
    const risk = await riskCheckToken(outputMint, {
      requireLpLock,
      maxBuyTaxBps,
    });
    console.log("[BUY] riskCheckToken end", {
      ok: risk.ok,
      ms: Date.now() - tRisk0,
      reasons: risk.reasons,
    });
    if (!risk.ok) {
      const errorMsg = `Risk check failed: ${
        risk.reasons?.join("; ") || "blocked"
      }`;
      console.log("[BUY] Risk check failed - transaction blocked", {
        outputMint,
        reasons: risk.reasons,
        requireLpLock,
        maxBuyTaxBps,
        chatId,
      });
      throw new Error(errorMsg);
    }
  }

  // Enforce tier daily spend caps if user context exists
  if (chatId !== undefined && chatId !== null) {
    const s = getUserState(chatId);
    const tier = s.tier || "basic";
    const cap =
      s.tierCaps && s.tierCaps[tier] != null
        ? Number(s.tierCaps[tier])
        : Infinity;
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(
      2,
      "0"
    )}-${String(today.getDate()).padStart(2, "0")}`;
    const spent = Number(s.dailySpend?.[key] || 0);
    const remaining = cap === Infinity ? Infinity : Math.max(0, cap - spent);
    console.log("[BUY] Daily spend check", {
      tier,
      cap,
      spent,
      remaining,
      requestedAmount: amountSol,
      chatId,
    });
    if (remaining <= 0) {
      console.log("[BUY] Daily cap exceeded - transaction blocked", {
        tier,
        cap,
        spent,
        chatId,
      });
      throw new Error(`Daily cap reached for tier '${tier}' (${cap} SOL)`);
    }
    if (amountSol > remaining) {
      console.log("[BUY] Amount reduced to fit daily cap", {
        originalAmount: amountSol,
        adjustedAmount: remaining,
        tier,
        chatId,
      });
      amountSol = remaining;
    }
  }

  // Adaptive sizing by liquidity and adaptive split (optional)

  try {
    const enableSizing =
      adaptiveSizingByLiquidity != null
        ? !!adaptiveSizingByLiquidity
        : String(process.env.ADAPTIVE_SIZING_LIQ || "").toLowerCase() ===
            "true" || process.env.ADAPTIVE_SIZING_LIQ === "1";
    const enableSplit =
      adaptiveSplit != null
        ? !!adaptiveSplit
        : String(process.env.ADAPTIVE_SPLIT || "").toLowerCase() === "true" ||
          process.env.ADAPTIVE_SPLIT === "1";
    console.log("[BUY] Adaptive sizing configuration", {
      enableSizing,
      enableSplit,
      originalAmount: amountSol,
    });
    if (enableSizing || enableSplit) {
      console.log("[BUY] Fetching DEX token info for adaptive calculations");
      const tDex0 = Date.now();
      const dex = await withTimeout(
        fetchDexTokenInfo(outputMint),
        1000,
        "dexInfo"
      ).catch((err) => {
        console.log("[BUY] DEX info fetch failed", { error: err?.message });
        return null;
      });
      const dexFetchTime = Date.now() - tDex0;
      console.log("[BUY] DEX info result", {
        success: !!dex,
        fetchTime: dexFetchTime,
        liquidityUsd: dex?.liquidityUsd,
        priceUsd: dex?.priceUsd,
        mint: outputMint,
      });

      if (dex && Number(dex.liquidityUsd) > 0) {
        console.log(
          "[BUY] DEX has valid liquidity, proceeding with adaptive calculations"
        );
        const tSolPrice0 = Date.now();
        const solPrice = await withTimeout(
          getSolPriceUSD(),
          800,
          "solPrice"
        ).catch((err) => {
          console.log("[BUY] SOL price fetch failed", { error: err?.message });
          return undefined;
        });
        const solPriceFetchTime = Date.now() - tSolPrice0;
        console.log("[BUY] SOL price result", {
          success: !!solPrice,
          fetchTime: solPriceFetchTime,
          price: solPrice,
        });
        const originalAmountSol = Number(amountSol);
        if (enableSizing && solPrice && solPrice > 0) {
          const sizingResult = await calculateAdaptiveSizing({
            amountSol,
            outputMint,
            inputMint,
            slippageBps: slippage,
            enableSizing,
            dex,
          });

          amountSol = sizingResult.adjustedAmount;
          const appliedLiqCap = sizingResult.appliedLiqCap;
          const appliedImpact = sizingResult.appliedImpact;
          const finalImpactPct = sizingResult.finalImpactPct;
          const tries = sizingResult.tries;
        }
        if (
          enableSplit &&
          chatId != null &&
          (walletsCount == null || walletsCount <= 0)
        ) {
          const solPrice = await getSolPriceUSD().catch(() => undefined);
          if (solPrice && solPrice > 0) {
            const perWalletUsd = Number(
              process.env.ADAPTIVE_WALLET_USD_TARGET || 400
            );
            const needed = Math.ceil(
              (amountSol * solPrice) / Math.max(1, perWalletUsd)
            );
            if (needed > 1) {
              splitAcrossWallets = true;
              walletsCount = needed;
            }
          }
        }
      }
    }
  } catch {}

  // slippage already determined above
  let shouldUsePrivateRelay =
    usePrivateRelay != null
      ? !!usePrivateRelay
      : chatId != null
      ? !!getUserState(chatId).enablePrivateRelay
      : String(process.env.ENABLE_PRIVATE_RELAY || "").toLowerCase() ===
          "true" || process.env.ENABLE_PRIVATE_RELAY === "1";

  // Apply debug flag overrides
  let effectiveUseJitoBundle = useJitoBundle;
  if (FORCE_DISABLE_JITO) {
    effectiveUseJitoBundle = false;
    logDebugMessage("[DEBUG] Jito bundle disabled by FORCE_DISABLE_JITO");
  }
  if (FORCE_DISABLE_PRIVATE_RELAY) {
    shouldUsePrivateRelay = false;
    if (JUP_DEBUG)
      console.log(
        "[DEBUG] Private relay disabled by FORCE_DISABLE_PRIVATE_RELAY"
      );
  }

  // Multi-wallet split flow
  if (splitAcrossWallets || (walletsCount && walletsCount > 1)) {
    return await executeMultiWalletSwap({
      chatId,
      walletsCount,
      amountSol,
      inputMint,
      outputMint,
      slippage,
      priorityFeeLamports,
      effectiveUseJitoBundle,
      shouldUsePrivateRelay,
    });
  }

  // Single wallet transaction flow
  console.log("[BUY] Starting single-wallet transaction flow", {
    wallet: wallet.publicKey.toBase58(),
    amount: amountSol,
  });
  const amount = toLamports(amountSol);

  const quoteStart = Date.now();
  const { route, quoteTime: fetchQuoteTime } = await fetchQuoteForSwap({
    inputMint,
    outputMint,
    amount,
    slippageBps: slippage,
  });
  const quoteTime = Date.now() - quoteStart;

  console.log("[BUY] Quote received for single wallet", {
    quoteTime,
    fetchQuoteTime,
    outAmount: route?.outAmount,
    priceImpact: route?.priceImpactPct,
    routeLabels:
      route?.routePlan?.map((p) => p?.swapInfo?.label).join(">") || "unknown",
  });

  const { swapTx, swapTime } = await createSwapTransaction({
    route,
    userPublicKey: wallet.publicKey.toBase58(),
    priorityFeeLamports,
  });
  if (!swapTx) {
    console.log("[BUY] No swap transaction in response");
    throw new Error("No swap transaction returned");
  }

  console.log("[BUY] Swap transaction created for single wallet", { swapTime });

  console.log("[BUY] Signing transaction for single wallet");
  let tx;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(swapTx, "base64"));
  } catch (e) {
    throw new TransactionDeserializationError(
      "Failed to deserialize swap transaction",
      {
        op: "BUY_SINGLE",
        wallet: wallet?.publicKey?.toBase58?.(),
        base64Len: swapTx?.length,
        cause: e,
      }
    );
  }

  // Ensure wallet is a signer (Keypair-like)
  if (!wallet || typeof wallet.sign !== "function") {
    throw new Error(
      `Invalid wallet for signing: expected Keypair-like signer, got ${typeof wallet}`
    );
  }

  try {
    tx.sign([wallet]);
    console.log("[BUY] Transaction signed successfully");
  } catch (signError) {
    console.error("[BUY] Transaction signing failed:", {
      error: signError.message,
      walletType: typeof wallet,
      hasSecretKey: wallet.secretKey ? "yes" : "no",
    });
    throw new Error(`Transaction signing failed: ${signError.message}`);
  }
  // Pre-submission validation
  {
    const header = tx.message?.header;
    const required = header?.numRequiredSignatures ?? 0;
    const present = (tx.signatures || []).filter(
      (s) => s && s.length > 0
    ).length;
    if (required > 0 && present < required) {
      throw new Error(
        `Insufficient signatures: have ${present}, need ${required}`
      );
    }
    const serializedBytes = tx.serialize().length;
    const instructionCount = tx.message?.compiledInstructions?.length ?? 0;
    if (serializedBytes > 1232) {
      console.log("[BUY] Warning: swap tx size > 1232 bytes", {
        serializedBytes,
        instructionCount,
      });
    }
  }
  console.log("[BUY] Transaction signed and ready for submission", {
    totalBuildTime: quoteTime + swapTime,
  });

  const t0 = Date.now();
  let txid;
  let via = "rpc";
  console.log("[BUY] Preparing to send swap transaction", {
    chatId,
    amountSol,
    inputMint,
    outputMint,
    slippage,
    useJitoBundle: effectiveUseJitoBundle,
    usePrivateRelay: shouldUsePrivateRelay,
    debugFlags: {
      forceDisableJito: FORCE_DISABLE_JITO,
      forceDisablePrivateRelay: FORCE_DISABLE_PRIVATE_RELAY,
    },
    priorityFeeLamports,
    usePrivateRelay: shouldUsePrivateRelay,
    useJitoBundle,
  });
  txid = await submitTransaction(tx, {
    useJitoBundle: effectiveUseJitoBundle,
    usePrivateRelay: shouldUsePrivateRelay,
    connection,
    walletAddress: wallet.publicKey.toString(),
    operationType: "SWAP",
  });
  via = effectiveUseJitoBundle ? "jito" : "rpc-race";
  const latencyMs = Date.now() - t0;
  console.log("[BUY] Swap sent", { via, txid, latencyMs });

  try {
    const outTokens =
      route?.outAmount && route?.outToken?.decimals != null
        ? route.outAmount / 10 ** route?.outToken.decimals
        : undefined;
    const avgPrice = outTokens ? Number(amountSol) / outTokens : undefined;
    const slot = await withTimeout(connection.getSlot(), 500, "slot").catch(
      () => undefined
    );
    addPosition(chatId, {
      mint: outputMint,
      symbol: route?.outToken?.symbol || "TOKEN",
      solIn: amountSol,
      tokensOut: outTokens,
      avgPriceSolPerToken: avgPrice,
      txid,
      status: "open",
      source: via,
      sendLatencyMs: latencyMs,
      slot,
    });
  } catch {}

  addTradeLogSafely(chatId, {
    kind: "buy",
    mint: outputMint,
    sol: amountSol,
    txid,
    latencyMs,
    slot,
  });

  // Final comprehensive summary log
  const totalExecutionTime = Date.now() - swapStartTime;
  const isMultiWallet =
    splitAcrossWallets || (walletsCount && walletsCount > 1);
  console.log("[BUY] ===== SWAP EXECUTION COMPLETE =====", {
    chatId,
    success: true,
    totalExecutionTime,
    executionTimeBreakdown: {
      parallelCalculationsTime: parallelCalcsEnd - parallelCalcsStart,
      adaptiveSizingTime: adaptiveSizingEnabled
        ? "included_in_parallel"
        : "disabled",
      transactionBuildingTime: "logged_per_wallet",
      submissionTime: latencyMs,
    },
    transactionDetails: {
      inputToken: inputMint,
      outputToken: outputMint,
      totalAmount: amountSol,
      slippage,
      priorityFee: priorityFeeLamports || "auto",
      useJitoBundle,
      isMultiWallet,
      walletCount: isMultiWallet ? splitResults?.length || "unknown" : 1,
    },
    results: {
      mainSignature: txid,
      tokensOut:
        route?.outAmount && route?.outToken?.decimals != null
          ? route.outAmount / 10 ** route?.outToken.decimals
          : undefined,
      splitResultsCount: splitResults?.length || 0,
      wallet: wallet.publicKey.toBase58(),
      via,
      slot,
    },
    performanceMetrics: {
      adaptiveSizingEnabled,
      parallelCalculationsUsed: true,
      bundleSubmissionUsed: useJitoBundle,
      rpcTimeoutsApplied: true,
      priceImpact:
        route?.priceImpactPct != null
          ? Math.round(route.priceImpactPct * 10000) / 100
          : undefined,
    },
  });

  return {
    txid,
    via,
    latencyMs,
    amountSol,
    slippageBps: slippage,
    priorityFeeLamports,
    output: {
      mint: outputMint,
      symbol: route?.outToken?.symbol,
      decimals: route?.outToken?.decimals,
      tokensOut:
        route?.outAmount && route?.outToken?.decimals != null
          ? route.outAmount / 10 ** route?.outToken.decimals
          : undefined,
    },
    route: {
      labels:
        route?.routePlan?.map((p) => p?.swapInfo?.label).join(">") ||
        (route?.routePlan ? "routePlan" : "route"),
      priceImpactPct:
        route?.priceImpactPct != null
          ? Math.round(route.priceImpactPct * 10000) / 100
          : undefined,
    },
  };
}

// Sell helper: swap token -> SOL
export async function performSell({
  tokenMint,
  amountTokens, // optional exact token units (not lamports)
  percent = 100, // percentage of balance to sell if amountTokens not provided
  slippageBps,
  priorityFeeLamports,
  useJitoBundle = false,
  usePrivateRelay, // optional override
  splitAcrossWallets = false,
  walletsCount,
  chatId,
  adaptiveSplit, // optional override for adaptive split on sell
}) {
  // Enforce user wallet context and disallow admin fallback
  if (chatId == null)
    throw new Error("Trading requires user wallet context (chatId)");
  if (!(await hasUserWallet(chatId))) {
    throw new Error(
      "User wallet not found. Use /setup to create or /import to add one."
    );
  }
  const connection = await getUserConnectionInstance(chatId);
  const wallet = await getUserWalletInstance(chatId);

  // SIMPLE MODE: minimal path to make sell transactions work (bypasses bundles, relays, multi-wallet, etc.)
  if (String(process.env.SIMPLE_MODE || '').toLowerCase() === 'true') {
    const simpleStart = Date.now();
    try {
      const owner = wallet.publicKey;
      // Fetch token balance and decimals, then compute raw amount to sell
      const { balanceRaw, decimals } = await getWalletTokenBalance(
        owner,
        tokenMint,
        connection
      );
      const amountRaw = calculateSellAmount(
        amountTokens,
        percent,
        balanceRaw,
        decimals
      );

      const simpleSlippageBps =
        slippageBps ?? Number(process.env.DEFAULT_SLIPPAGE_BPS || 100);

      const route = await getQuoteRaw({
        inputMint: tokenMint,
        outputMint: SOL_MINT,
        amountRaw: amountRaw.toString(),
        slippageBps: simpleSlippageBps,
      });
      if (!route) throw new Error('No route returned from quote');

      const { swapTx } = await createSwapTransaction({
        route,
        userPublicKey: owner.toBase58(),
        priorityFeeLamports:
          priorityFeeLamports ??
          Number(process.env.DEFAULT_PRIORITY_FEE_LAMPORTS || 100000),
      });
      if (!swapTx) throw new Error('No swap transaction returned');

      let tx;
      try {
        tx = VersionedTransaction.deserialize(Buffer.from(swapTx, 'base64'));
      } catch (e) {
        throw new TransactionDeserializationError('Failed to deserialize swap transaction', {
          op: 'SELL_SIMPLE_MODE',
          wallet: wallet?.publicKey?.toBase58?.(),
          base64Len: swapTx?.length,
          cause: e,
        });
      }

      try {
        tx.sign([wallet]);
      } catch (e) {
        throw new Error(`Transaction signing failed: ${e?.message || e}`);
      }

      const rawBytes = tx.serialize();
      let txid;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          txid = await connection.sendRawTransaction(rawBytes, {
            skipPreflight: true,
            maxRetries: 2,
          });
          break;
        } catch (e) {
          if (attempt === 3) {
            throw new SubmissionError('Raw send failed in SIMPLE_MODE', { cause: e });
          }
          await sleep(150 * attempt);
        }
      }

      const latencyMs = Date.now() - simpleStart;
      addTradeLogSafely(chatId, {
        kind: 'sell',
        mint: tokenMint,
        txid,
        latencyMs,
      });
      return { txid };
    } catch (e) {
      console.error('[SIMPLE_MODE] sell failed', { error: e?.message || e });
      throw e;
    }
  }

  // Auto-priority fee if not supplied
  if (priorityFeeLamports == null) {
    try {
      priorityFeeLamports = await getAdaptivePriorityFee(connection);
    } catch {}
  }

  // Resolve slippage value
  let slippage;
  if (slippageBps != null) {
    slippage = slippageBps;
  } else {
    try {
      slippage = await getAdaptiveSlippageBps();
    } catch {
      slippage = Number(process.env.DEFAULT_SLIPPAGE_BPS || 100);
    }
  }

  // Apply debug flag overrides
  let effectiveUseJitoBundle = useJitoBundle;
  if (FORCE_DISABLE_JITO) {
    effectiveUseJitoBundle = false;
    if (JUP_DEBUG)
      console.log("[DEBUG] Jito bundle disabled by FORCE_DISABLE_JITO");
  }

  // Adaptive split for sells when explicit amount is provided
  try {
    const enableSplit =
      adaptiveSplit != null
        ? !!adaptiveSplit
        : String(process.env.ADAPTIVE_SPLIT || "").toLowerCase() === "true" ||
          process.env.ADAPTIVE_SPLIT === "1";
    if (
      enableSplit &&
      amountTokens != null &&
      chatId != null &&
      (walletsCount == null || walletsCount <= 0)
    ) {
      const dex = await fetchDexTokenInfo(tokenMint).catch(() => null);
      const priceUsd = dex?.priceUsd;
      const liqUsd = Number(dex?.liquidityUsd || 0);
      if (priceUsd && priceUsd > 0) {
        const totalUsd = Number(amountTokens) * priceUsd;
        const basePerWalletUsd = Number(
          process.env.ADAPTIVE_WALLET_USD_TARGET || 400
        );
        let perWalletUsd = basePerWalletUsd;
        const tiered =
          String(process.env.ADAPTIVE_LIQ_TIER || "").toLowerCase() ===
            "true" || process.env.ADAPTIVE_LIQ_TIER === "1";
        if (tiered && Number.isFinite(liqUsd) && liqUsd > 0) {
          if (liqUsd < 50000)
            perWalletUsd = Math.max(100, Math.floor(basePerWalletUsd * 0.5));
          else if (liqUsd < 150000)
            perWalletUsd = Math.floor(basePerWalletUsd * 0.75);
          else if (liqUsd > 500000)
            perWalletUsd = Math.floor(basePerWalletUsd * 1.5);
        }
        const needed = Math.ceil(totalUsd / Math.max(1, perWalletUsd));
        if (needed > 1) {
          splitAcrossWallets = true;
          walletsCount = needed;
        }
      }
    }
  } catch {}

  // Multi-wallet split flow
  if (splitAcrossWallets || (walletsCount && walletsCount > 1)) {
    if (!(chatId !== undefined && chatId !== null))
      throw new Error("Split sell requires user context (chatId)");

    const shouldUsePrivateRelay = configurePrivateRelay(
      usePrivateRelay,
      chatId
    );

    return await executeMultiWalletSell({
      chatId,
      tokenMint,
      amountTokens,
      percent,
      slippage,
      priorityFeeLamports,
      effectiveUseJitoBundle,
      shouldUsePrivateRelay,
      walletsCount,
      connection,
    });
  }

  // Single-wallet sell flow
  const owner = wallet.publicKey;
  const { balanceRaw, decimals } = await getWalletTokenBalance(
    owner,
    tokenMint,
    connection
  );
  const amountRaw = calculateSellAmount(
    amountTokens,
    percent,
    balanceRaw,
    decimals
  );

  const { route, quoteTime } = await fetchQuoteForSwap({
    inputMint: tokenMint,
    outputMint: SOL_MINT,
    amount: amountRaw.toString(),
    slippageBps: slippage,
  });
  const { swapTx, swapTime } = await createSwapTransaction({
    route,
    userPublicKey: owner.toBase58(),
    priorityFeeLamports,
  });
  if (!swapTx || typeof swapTx !== "string") {
    console.error("[SELL] Invalid swap transaction payload", {
      typeofSwapTx: typeof swapTx,
    });
    throw new Error("Invalid swap transaction returned");
  }
  let tx;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(swapTx, "base64"));
  } catch (e) {
    throw new TransactionDeserializationError(
      "Failed to deserialize swap transaction",
      {
        op: "SELL_SINGLE",
        wallet: wallet?.publicKey?.toBase58?.(),
        base64Len: swapTx?.length,
        cause: e,
      }
    );
  }
  if (!wallet || typeof wallet.sign !== "function") {
    throw new Error(
      `Invalid wallet for signing: expected Keypair-like signer, got ${typeof wallet}`
    );
  }
  try {
    tx.sign([wallet]);
  } catch (signError) {
    console.error("[SELL] Transaction signing failed:", {
      error: signError.message,
    });
    throw new Error(`Transaction signing failed: ${signError.message}`);
  }
  let txid;
  const t0 = Date.now();
  let shouldUsePrivateRelay =
    usePrivateRelay != null
      ? !!usePrivateRelay
      : chatId != null
      ? !!getUserState(chatId).enablePrivateRelay
      : false;

  // Apply debug flag override for private relay
  if (FORCE_DISABLE_PRIVATE_RELAY) {
    shouldUsePrivateRelay = false;
    if (JUP_DEBUG)
      console.log(
        "[DEBUG] Private relay disabled by FORCE_DISABLE_PRIVATE_RELAY"
      );
  }

  txid = await submitTransaction(tx, {
    useJitoBundle: effectiveUseJitoBundle,
    usePrivateRelay: shouldUsePrivateRelay,
    connection,
    walletAddress: wallet.publicKey.toString(),
    operationType: "SELL",
  });
  const latencyMs = Date.now() - t0;
  addTradeLogSafely(chatId, {
    kind: "sell",
    mint: tokenMint,
    solOut: route?.outAmount ? Number(route.outAmount) / 1e9 : undefined,
    txid,
    latencyMs,
  });
  return { txid };
}
