import axios from "axios";
import {
  getConnection,
  getWallet,
  getUserWalletInstance,
  getUserConnectionInstance,
} from "../wallet.js";
import { VersionedTransaction, PublicKey } from "@solana/web3.js";
import { rotateRpc, sendTransactionRaced } from "../rpc.js";
import { submitBundle, submitBundleWithTarget, serializeToBase64 } from "../jito.js";
import { addPosition, addTradeLog, getUserState } from "../userState.js";
import { riskCheckToken } from "../risk.js";
import { getAdaptivePriorityFee } from "../fees.js";
import { getAdaptiveSlippageBps } from "../slippage.js";
import { getAllUserWalletKeypairs, hasUserWallet } from "../userWallets.js";
import { getSolPriceUSD } from "../walletInfo.js";

const JUP_BASE = process.env.JUPITER_BASE_URL || "https://quote-api.jup.ag";
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Best-effort Dexscreener fetch for liquidity and price
async function fetchDexTokenInfo(mint, timeoutMs = 1200) {
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
  return Math.round(Number(sol) * 1e9);
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
  const { data } = await axios.get(url);
  const route = data?.data?.[0];
  if (!route) return null;
  const outAmountFormatted = route.outAmount / 10 ** route.outToken.decimals;
  return {
    route,
    outAmountFormatted,
    outputSymbol: route.outToken.symbol,
    routeName: route.marketInfos?.map((m) => m.amm.label).join(">") || "route",
    priceImpactPct: Math.round(route.priceImpactPct * 10000) / 100,
  };
}

export async function performSwap({
  inputMint,
  outputMint,
  amountSol,
  slippageBps,
  priorityFeeLamports,
  useJitoBundle = false,
  usePrivateRelay, // optional override
  splitAcrossWallets = false,
  walletsCount, // optional desired wallet count for split
  chatId,
  riskBypass = false,
  adaptiveSizingByLiquidity, // optional override
  adaptiveSplit, // optional override
}) {
  // Enforce user wallet context and disallow admin fallback
  if (chatId == null) throw new Error("Trading requires user wallet context (chatId)");
  if (!(await hasUserWallet(chatId))) {
    throw new Error("User wallet not found. Use /setup to create or /import to add one.");
  }
  const connection = await getUserConnectionInstance(chatId);
  const wallet = await getUserWalletInstance(chatId);

  // Auto-determine competitive priority fee when not supplied
  if (priorityFeeLamports == null) {
    try {
      priorityFeeLamports = await getAdaptivePriorityFee(connection);
    } catch {}
  }
  // Determine adaptive slippage
  let slippage;
  if (slippageBps != null) {
    slippage = slippageBps;
  } else {
    slippage = await getAdaptiveSlippageBps();
  }

  // Optional risk checks before building swap
  if (!riskBypass) {
    const requireLpLock =
      String(process.env.REQUIRE_LP_LOCK || "").toLowerCase() === "true" ||
      process.env.REQUIRE_LP_LOCK === "1";
    const maxBuyTaxBps = Number(process.env.MAX_BUY_TAX_BPS || 1500);
    const risk = await riskCheckToken(outputMint, {
      requireLpLock,
      maxBuyTaxBps,
    });
    if (!risk.ok) {
      throw new Error(
        `Risk check failed: ${risk.reasons?.join("; ") || "blocked"}`
      );
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
    if (remaining <= 0)
      throw new Error(`Daily cap reached for tier '${tier}' (${cap} SOL)`);
    if (amountSol > remaining) amountSol = remaining;
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
    if (enableSizing || enableSplit) {
      const dex = await fetchDexTokenInfo(outputMint).catch(() => null);
      if (dex && Number(dex.liquidityUsd) > 0) {
        const solPrice = await getSolPriceUSD().catch(() => undefined);
        const originalAmountSol = Number(amountSol);
        if (enableSizing && solPrice && solPrice > 0) {
          const liqUsd = Number(dex.liquidityUsd);
          const baseBps = Number(process.env.MAX_NOTIONAL_BPS_OF_LIQ || 30); // baseline 0.30%
          let targetBps = baseBps;
          const tiered =
            String(process.env.ADAPTIVE_LIQ_TIER || "").toLowerCase() === "true" ||
            process.env.ADAPTIVE_LIQ_TIER === "1";
          if (tiered && Number.isFinite(liqUsd) && liqUsd > 0) {
            if (liqUsd < 50000) targetBps = Math.max(5, Math.floor(baseBps * 0.5));
            else if (liqUsd < 150000) targetBps = Math.floor(baseBps * 0.75);
            else if (liqUsd > 500000) targetBps = Math.floor(baseBps * 1.5);
          }
          const maxSolByLiq = (liqUsd * (targetBps / 10000)) / solPrice;
          let appliedLiqCap = false;
          let amountAfterLiq = Number(amountSol);
          if (Number.isFinite(maxSolByLiq) && maxSolByLiq > 0) {
            const minSol = Number(process.env.MIN_BUY_SOL ?? 0.01);
            const adjusted = Math.max(minSol, Math.min(amountSol, maxSolByLiq));
            appliedLiqCap = adjusted !== amountSol;
            amountSol = adjusted;
            amountAfterLiq = Number(amountSol);
          }
        
          // Optional: adapt amount to target price impact via Jupiter quotes
          const enableImpact =
            String(process.env.ADAPTIVE_IMPACT || "").toLowerCase() === "true" ||
            process.env.ADAPTIVE_IMPACT === "1";
          let appliedImpact = false;
          let finalImpactPct = null;
          let tries = 0;
          if (enableImpact) {
            try {
              const targetImpactBps = Number(process.env.TARGET_PRICE_IMPACT_BPS || 80); // default 0.80%
              const targetImpactPct = targetImpactBps / 100;
              const minSol = Number(process.env.MIN_BUY_SOL ?? 0.01);
              let testSol = Number(amountSol);
              const maxTries = Number(process.env.ADAPTIVE_IMPACT_MAX_TRIES || 3);
              for (let i = 0; i < maxTries; i++) {
                tries++;
                const q = await getTokenQuote({
                  inputMint,
                  outputMint,
                  amountSol: testSol,
                  slippageBps: slippage,
                });
                const impactPct = Number(q?.priceImpactPct);
                if (!Number.isFinite(impactPct)) break;
                finalImpactPct = impactPct;
                if (impactPct <= targetImpactPct) break;
                const ratio = targetImpactPct / Math.max(impactPct, 0.001);
                const factor = Math.max(0.3, Math.min(0.9, ratio));
                const nextSol = Math.max(minSol, testSol * factor);
                if (Math.abs(nextSol - testSol) < 1e-6) break;
                testSol = nextSol;
              }
              appliedImpact = Number(testSol) !== Number(amountAfterLiq);
              amountSol = testSol;
            } catch {}
          }
        
          try {
            console.log(
              `[sizing][buy] liqUsd=${liqUsd} solPrice=${solPrice} baseBps=${baseBps} targetBps=${targetBps} maxSolByLiq=${Number.isFinite(maxSolByLiq) ? maxSolByLiq.toFixed(6) : 'n/a'} original=${originalAmountSol} afterLiq=${amountAfterLiq} final=${amountSol} appliedLiqCap=${appliedLiqCap} appliedImpact=${appliedImpact} impactPct=${finalImpactPct ?? 'n/a'} tries=${tries}`
            );
          } catch {}
        }
        if (enableSplit && chatId != null && (walletsCount == null || walletsCount <= 0)) {
          const solPrice = await getSolPriceUSD().catch(() => undefined);
          if (solPrice && solPrice > 0) {
            const perWalletUsd = Number(process.env.ADAPTIVE_WALLET_USD_TARGET || 400);
            const needed = Math.ceil((amountSol * solPrice) / Math.max(1, perWalletUsd));
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
  const shouldUsePrivateRelay =
    usePrivateRelay != null
      ? !!usePrivateRelay
      : chatId != null
      ? !!getUserState(chatId).enablePrivateRelay
      : String(process.env.ENABLE_PRIVATE_RELAY || "").toLowerCase() === "true" ||
        process.env.ENABLE_PRIVATE_RELAY === "1";

  // Multi-wallet split flow
  if (splitAcrossWallets || (walletsCount && walletsCount > 1)) {
    if (!(chatId !== undefined && chatId !== null))
      throw new Error("Split buy requires user context (chatId)");
    const wallets = await getAllUserWalletKeypairs(chatId);
    if (!wallets.length) throw new Error("No wallets available for split");
    let useCount = Math.min(walletsCount || wallets.length, wallets.length);

    // Enforce a minimum per-wallet SOL notional for buys
    let perWalletSol = Number(amountSol) / useCount;
    const minPerWalletSol = Number(process.env.MIN_PER_WALLET_SOL || 0.005);
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

    if (useJitoBundle) {
      // Build and sign all txs, then bundle
      const signedBase64 = [];
      const signedTxs = [];
      const perWalletMeta = [];
      for (const w of selected) {
        const qUrl = `${JUP_BASE}/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${perLamports}&slippageBps=${slippage}`;
        const qRes = await axios.get(qUrl);
        const route = qRes?.data?.data?.[0];
        if (!route) throw new Error("No route for split");
        const swapRes = await axios.post(`${JUP_BASE}/v6/swap`, {
          quoteResponse: route,
          userPublicKey: w.keypair.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: priorityFeeLamports ?? "auto",
        });
        const swapTx = swapRes?.data?.swapTransaction;
        const tx = VersionedTransaction.deserialize(
          Buffer.from(swapTx, "base64")
        );
        tx.sign([w.keypair]);
        signedTxs.push(tx);
        signedBase64.push(serializeToBase64(tx));
        const tokensOut =
          route?.outAmount && route?.outToken?.decimals != null
            ? route.outAmount / 10 ** route.outToken.decimals
            : undefined;
        perWalletMeta.push({ w, tokensOut, route });
      }
      const t0 = Date.now();
      try {
        const resp = await submitBundleWithTarget(signedBase64);
        const latencyMs = Date.now() - t0;
        const bundleUuid = resp?.uuid || "bundle_submitted";
        const slot = await connection.getSlot().catch(() => undefined);
        try {
          for (const m of perWalletMeta) {
            const avgPrice = m.tokensOut
              ? Number(perWalletSol) / m.tokensOut
              : undefined;
            addPosition(chatId, {
              mint: outputMint,
              symbol: m.route?.outToken?.symbol || "TOKEN",
              solIn: perWalletSol,
              tokensOut: m.tokensOut,
              avgPriceSolPerToken: avgPrice,
              txid: bundleUuid,
              status: "open",
              source: "jito",
              sendLatencyMs: latencyMs,
              slot,
            });
            addTradeLog(chatId, {
              kind: "buy",
              mint: outputMint,
              sol: perWalletSol,
              txid: bundleUuid,
              latencyMs,
              slot,
            });
          }
        } catch {}
        return { txids: [bundleUuid] };
      } catch (bundleErr) {
        // Fallback: send individually via RPC/relay
        const results = [];
        for (let i = 0; i < signedTxs.length; i++) {
          const tx = signedTxs[i];
          try {
            const tSend0 = Date.now();
            let txid;
            try {
              txid = await sendTransactionRaced(tx, {
                skipPreflight: true,
                usePrivateRelay: shouldUsePrivateRelay,
              });
            } catch (e) {
              rotateRpc("race failed");
              txid = await connection.sendRawTransaction(tx.serialize(), {
                skipPreflight: true,
              });
            }
            const latencyMs = Date.now() - tSend0;
            results.push(txid);
            try {
              addTradeLog(chatId, {
                kind: "buy",
                mint: outputMint,
                sol: perWalletSol,
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
    }

    // Non-Jito path: send sequentially or race via RPC
    const results = [];
    for (const w of selected) {
      try {
        const qUrl = `${JUP_BASE}/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${perLamports}&slippageBps=${slippage}`;
        const qRes = await axios.get(qUrl);
        const route = qRes?.data?.data?.[0];
        if (!route) throw new Error("No route for split");
        const swapRes = await axios.post(`${JUP_BASE}/v6/swap`, {
          quoteResponse: route,
          userPublicKey: w.keypair.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: priorityFeeLamports ?? "auto",
        });
        const swapTx = swapRes?.data?.swapTransaction;
        if (!swapTx) throw new Error("No swap transaction returned");
        const tx = VersionedTransaction.deserialize(
          Buffer.from(swapTx, "base64")
        );
        tx.sign([w.keypair]);
        let txid;
        try {
          txid = await sendTransactionRaced(tx, {
            skipPreflight: true,
            usePrivateRelay: shouldUsePrivateRelay,
          });
        } catch (e) {
          rotateRpc("race failed");
          txid = await connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: true,
          });
        }
        results.push(txid);
        try {
          addTradeLog(chatId, {
            kind: "buy",
            mint: outputMint,
            sol: perWalletSol,
            txid,
          });
        } catch {}
      } catch (e) {
        // continue
      }
    }
    return { txids: results };
  }

    // Single-wallet flow
    const amount = toLamports(amountSol);
    const slippageVal = slippage;
    const qUrl = `${JUP_BASE}/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageVal}`;
    const { data } = await axios.get(qUrl);
    const route = data?.data?.[0];
    if (!route) throw new Error("No route");
    const swapRes = await axios.post(`${JUP_BASE}/v6/swap`, {
      quoteResponse: route,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: priorityFeeLamports ?? "auto",
    });
    const swapTx = swapRes?.data?.swapTransaction;
    if (!swapTx) throw new Error("No swap transaction returned");
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTx, "base64"));
    tx.sign([wallet]);

    const t0 = Date.now();
    let txid;
    let via = "rpc";
    try {
      if (useJitoBundle) {
        const base64Signed = serializeToBase64(tx);
        const resp = await submitBundleWithTarget([base64Signed]);
        txid = resp?.uuid || "bundle_submitted";
        via = "jito";
      } else {
        txid = await sendTransactionRaced(tx, {
          skipPreflight: true,
          usePrivateRelay: shouldUsePrivateRelay,
        });
      }
    } catch (e) {
      // fallback single send
      rotateRpc("race failed");
      txid = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
      });
    }
    const latencyMs = Date.now() - t0;

    try {
      const outTokens =
        route?.outAmount && route?.outToken?.decimals != null
          ? route.outAmount / 10 ** route?.outToken.decimals
          : undefined;
      const avgPrice = outTokens ? Number(amountSol) / outTokens : undefined;
      const slot = await connection.getSlot().catch(() => undefined);
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
      addTradeLog(chatId, {
        kind: "buy",
        mint: outputMint,
        sol: amountSol,
        txid,
        latencyMs,
        slot,
      });
    } catch {}

    return { txid };
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
    if (chatId == null) throw new Error("Trading requires user wallet context (chatId)");
    if (!(await hasUserWallet(chatId))) {
      throw new Error("User wallet not found. Use /setup to create or /import to add one.");
    }
    const connection = await getUserConnectionInstance(chatId);
    const wallet = await getUserWalletInstance(chatId);

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

    // Adaptive split for sells when explicit amount is provided
    try {
      const enableSplit =
        adaptiveSplit != null
          ? !!adaptiveSplit
          : String(process.env.ADAPTIVE_SPLIT || "").toLowerCase() === "true" ||
            process.env.ADAPTIVE_SPLIT === "1";
      if (enableSplit && amountTokens != null && chatId != null && (walletsCount == null || walletsCount <= 0)) {
        const dex = await fetchDexTokenInfo(tokenMint).catch(() => null);
        const priceUsd = dex?.priceUsd;
        const liqUsd = Number(dex?.liquidityUsd || 0);
        if (priceUsd && priceUsd > 0) {
          const totalUsd = Number(amountTokens) * priceUsd;
          const basePerWalletUsd = Number(process.env.ADAPTIVE_WALLET_USD_TARGET || 400);
          let perWalletUsd = basePerWalletUsd;
          const tiered =
            String(process.env.ADAPTIVE_LIQ_TIER || "").toLowerCase() === "true" ||
            process.env.ADAPTIVE_LIQ_TIER === "1";
          if (tiered && Number.isFinite(liqUsd) && liqUsd > 0) {
            if (liqUsd < 50000) perWalletUsd = Math.max(100, Math.floor(basePerWalletUsd * 0.5));
            else if (liqUsd < 150000) perWalletUsd = Math.floor(basePerWalletUsd * 0.75);
            else if (liqUsd > 500000) perWalletUsd = Math.floor(basePerWalletUsd * 1.5);
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
      const wallets = await getAllUserWalletKeypairs(chatId);
      if (!wallets.length) throw new Error("No wallets available for split");
      const useCount = Math.min(walletsCount || wallets.length, wallets.length);
      const selected = wallets.slice(0, useCount);
      const results = [];
      const t0All = Date.now();
      for (const w of selected) {
        try {
          const owner = w.keypair.publicKey;
          const tokenPk = new PublicKey(tokenMint);
          const resp = await connection.getParsedTokenAccountsByOwner(owner, {
            mint: tokenPk,
          });
          const acct = resp.value?.[0]?.account?.data?.parsed?.info;
          if (!acct) throw new Error("Token account not found");
          const decimals = Number(acct.tokenAmount?.decimals || 0);
          const balanceRaw = BigInt(acct.tokenAmount?.amount || "0");
          if (balanceRaw === 0n) throw new Error("Zero token balance");
          let amountRaw;
          if (amountTokens != null) {
            const perWallet = Number(amountTokens) / useCount;
            amountRaw = BigInt(Math.floor(perWallet * 10 ** decimals));
          } else {
            const p = Math.max(1, Math.min(100, Math.floor(percent)));
            amountRaw = (balanceRaw * BigInt(p)) / 100n;
          }
          if (amountRaw <= 0n) throw new Error("Amount to sell is zero");
          // using outer slippage
          const quoteUrl = `${JUP_BASE}/v6/quote?inputMint=${tokenMint}&outputMint=${SOL_MINT}&amount=${amountRaw.toString()}&slippageBps=${slippage}`;
          const quoteRes = await axios.get(quoteUrl);
          const route = quoteRes?.data?.data?.[0];
          if (!route) throw new Error("No route for sell");
          const swapRes = await axios.post(`${JUP_BASE}/v6/swap`, {
            quoteResponse: route,
            userPublicKey: owner.toBase58(),
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true,
            prioritizationFeeLamports: priorityFeeLamports ?? "auto",
          });
          const swapTx = swapRes?.data?.swapTransaction;
          if (!swapTx) throw new Error("No swap transaction returned");
          const tx = VersionedTransaction.deserialize(
            Buffer.from(swapTx, "base64")
          );
          tx.sign([w.keypair]);
          const shouldUsePrivateRelay =
            usePrivateRelay != null
              ? !!usePrivateRelay
              : chatId != null
              ? !!getUserState(chatId).enablePrivateRelay
              : false;
          let txid;
          const t0 = Date.now();
          if (useJitoBundle) {
            const base64Signed = serializeToBase64(tx);
            try {
              const resp = await submitBundleWithTarget([base64Signed]);
              txid = resp?.uuid || "bundle_submitted";
            } catch (e) {
              try {
                txid = await sendTransactionRaced(tx, {
                  skipPreflight: true,
                  usePrivateRelay: shouldUsePrivateRelay,
                });
              } catch (e2) {
                rotateRpc("race failed");
                txid = await connection.sendRawTransaction(tx.serialize(), {
                  skipPreflight: true,
                });
              }
            }
          } else {
            try {
              txid = await sendTransactionRaced(tx, {
                skipPreflight: true,
                usePrivateRelay: shouldUsePrivateRelay,
              });
            } catch (e) {
              rotateRpc("race failed");
              txid = await connection.sendRawTransaction(tx.serialize(), {
                skipPreflight: true,
              });
            }
          }
          const latencyMs = Date.now() - t0;
          results.push(txid);
          try {
            addTradeLog(chatId, {
              kind: "sell",
              mint: tokenMint,
              solOut: route?.outAmount && route?.outToken?.decimals != null ? route.outAmount / 10 ** route.outToken.decimals : undefined,
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

    // Single-wallet sell flow
    const owner = wallet.publicKey;
    const tokenPk = new PublicKey(tokenMint);
    const resp = await connection.getParsedTokenAccountsByOwner(owner, {
      mint: tokenPk,
    });
    const acct = resp.value?.[0]?.account?.data?.parsed?.info;
    if (!acct) throw new Error("Token account not found");
    const decimals = Number(acct.tokenAmount?.decimals || 0);
    const balanceRaw = BigInt(acct.tokenAmount?.amount || "0");
    let amountRaw;
    if (amountTokens != null) {
      amountRaw = BigInt(Math.floor(Number(amountTokens) * 10 ** decimals));
    } else {
      const p = Math.max(1, Math.min(100, Math.floor(percent)));
      amountRaw = (balanceRaw * BigInt(p)) / 100n;
    }
    if (amountRaw <= 0n) throw new Error("Amount to sell is zero");

    const quoteUrl = `${JUP_BASE}/v6/quote?inputMint=${tokenMint}&outputMint=${SOL_MINT}&amount=${amountRaw.toString()}&slippageBps=${slippage}`;
    const quoteRes = await axios.get(quoteUrl);
    const route = quoteRes?.data?.data?.[0];
    if (!route) throw new Error("No route for sell");
    const swapRes = await axios.post(`${JUP_BASE}/v6/swap`, {
      quoteResponse: route,
      userPublicKey: owner.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: priorityFeeLamports ?? "auto",
    });
    const swapTx = swapRes?.data?.swapTransaction;
    if (!swapTx) throw new Error("No swap transaction returned");
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTx, "base64"));
    tx.sign([wallet]);
    let txid;
    const t0 = Date.now();
    const shouldUsePrivateRelay =
      usePrivateRelay != null
        ? !!usePrivateRelay
        : chatId != null
        ? !!getUserState(chatId).enablePrivateRelay
        : false;
    if (useJitoBundle) {
      const base64Signed = serializeToBase64(tx);
      try {
        const resp = await submitBundleWithTarget([base64Signed]);
        txid = resp?.uuid || "bundle_submitted";
      } catch (e) {
        try {
          txid = await sendTransactionRaced(tx, {
            skipPreflight: true,
            usePrivateRelay: shouldUsePrivateRelay,
          });
        } catch (e2) {
          rotateRpc("race failed");
          txid = await connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: true,
          });
        }
      }
    } else {
      try {
        txid = await sendTransactionRaced(tx, {
          skipPreflight: true,
          usePrivateRelay: shouldUsePrivateRelay,
        });
      } catch (e) {
        rotateRpc("race failed");
        txid = await connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: true,
        });
      }
    }
    const latencyMs = Date.now() - t0;
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
    return { txid };
  }
