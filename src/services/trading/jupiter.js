import axios from "axios";
import {
  getConnection,
  getWallet,
  getUserWalletInstance,
  getUserConnectionInstance,
} from "../wallet.js";
import { VersionedTransaction, PublicKey } from "@solana/web3.js";
import { rotateRpc, sendTransactionRaced } from "../rpc.js";
import { submitBundle, serializeToBase64 } from "../jito.js";
import { addPosition, addTradeLog, getUserState } from "../userState.js";
import { riskCheckToken } from "../risk.js";
import { getAdaptivePriorityFee } from "../fees.js";
import { getAdaptiveSlippageBps } from "../slippage.js";
import { getAllUserWalletKeypairs } from "../userWallets.js";

const JUP_BASE = process.env.JUPITER_BASE_URL || "https://quote-api.jup.ag";
const SOL_MINT = "So11111111111111111111111111111111111111112";

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
}) {
  // Determine wallet/connection: use user-specific if chatId provided
  let connection;
  let wallet;
  try {
    if (chatId !== undefined && chatId !== null) {
      connection = await getUserConnectionInstance(chatId);
      wallet = await getUserWalletInstance(chatId);
    }
  } catch (e) {
    // Fallback to global if user-specific not available
  }
  if (!connection || !wallet) {
    connection = getConnection();
    wallet = getWallet();
  }
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
    const useCount = Math.min(walletsCount || wallets.length, wallets.length);
    const selected = wallets.slice(0, useCount);
    const perWalletSol = Number(amountSol) / useCount;
    const perLamports = toLamports(perWalletSol);

    if (useJitoBundle) {
      // Build and sign all txs, then bundle
      const signedBase64 = [];
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
        signedBase64.push(serializeToBase64(tx));
        const tokensOut =
          route?.outAmount && route?.outToken?.decimals != null
            ? route.outAmount / 10 ** route.outToken.decimals
            : undefined;
        perWalletMeta.push({ w, tokensOut, route });
      }
      const t0 = Date.now();
      const resp = await submitBundle(signedBase64);
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
    }

    // Non-Jito: send individually, possibly using private relay
    const results = [];
    const t0All = Date.now();
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
        if (!swapTx) throw new Error("No swap tx returned");
        const tx = VersionedTransaction.deserialize(
          Buffer.from(swapTx, "base64")
        );
        tx.sign([w.keypair]);
        const t0 = Date.now();
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
        const latencyMs = Date.now() - t0;
        const slot = await connection.getSlot().catch(() => undefined);
        try {
          const tokensOut =
            route?.outAmount && route?.outToken?.decimals != null
              ? route.outAmount / 10 ** route.outToken.decimals
              : undefined;
          const avgPrice = tokensOut
            ? Number(perWalletSol) / tokensOut
            : undefined;
          addPosition(chatId, {
            mint: outputMint,
            symbol: route?.outToken?.symbol || "TOKEN",
            solIn: perWalletSol,
            tokensOut,
            avgPriceSolPerToken: avgPrice,
            txid,
            status: "open",
            source: shouldUsePrivateRelay ? "relay" : "rpc",
            sendLatencyMs: latencyMs,
            slot,
          });
          addTradeLog(chatId, {
            kind: "buy",
            mint: outputMint,
            sol: perWalletSol,
            txid,
            latencyMs,
            slot,
          });
        } catch {}
        results.push({ ok: true, txid });
      } catch (e) {
        results.push({ ok: false, error: e.message });
      }
    }
    const elapsed = Date.now() - t0All;
    return {
      txids: results.filter((r) => r.ok).map((r) => r.txid),
      elapsedMs: elapsed,
    };
  }

  // Single wallet flow (default)
  const amount = toLamports(amountSol);
  const quoteRes = await axios.get(
    `${JUP_BASE}/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippage}`
  );
  const route = quoteRes?.data?.data?.[0];
  if (!route) throw new Error("No route found");

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
  let txid;
  const t0 = Date.now();
  if (useJitoBundle) {
    const base64Signed = serializeToBase64(tx);
    const resp = await submitBundle([base64Signed]);
    txid = resp?.uuid || "bundle_submitted";
  } else {
    try {
      // Race across all configured RPCs for low latency
      txid = await sendTransactionRaced(tx, {
        skipPreflight: true,
        usePrivateRelay: shouldUsePrivateRelay,
      });
    } catch (e) {
      // rotate RPC and final retry on active connection
      rotateRpc("race failed");
      txid = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
      });
    }
  }
  const latencyMs = Date.now() - t0;
  const slot = await connection.getSlot().catch(() => undefined);
  // Record position and trade log for this user (if chatId provided)
  try {
    if (chatId !== undefined && chatId !== null) {
      const tokensOut =
        route?.outAmount && route?.outToken?.decimals != null
          ? route.outAmount / 10 ** route.outToken.decimals
          : undefined;
      const avgPrice = tokensOut ? Number(amountSol) / tokensOut : undefined;
      addPosition(chatId, {
        mint: outputMint,
        symbol: route?.outToken?.symbol || "TOKEN",
        solIn: amountSol,
        tokensOut,
        avgPriceSolPerToken: avgPrice,
        txid,
        status: "open",
        source: useJitoBundle
          ? "jito"
          : shouldUsePrivateRelay
          ? "relay"
          : "rpc",
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
    }
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
}) {
  // Determine wallet/connection (default)
  let connection = getConnection();
  let wallet = getWallet();
  if (chatId !== undefined && chatId !== null) {
    try {
      connection = await getUserConnectionInstance(chatId);
      wallet = await getUserWalletInstance(chatId);
    } catch {}
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
          const resp = await submitBundle([base64Signed]);
          txid = resp?.uuid || "bundle_submitted";
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
        const slot = await connection.getSlot().catch(() => undefined);
        try {
          addTradeLog(chatId, {
            kind: "sell",
            mint: tokenMint,
            sol: null,
            txid,
            latencyMs,
            slot,
          });
        } catch {}
        results.push({ ok: true, txid });
      } catch (e) {
        results.push({ ok: false, error: e.message });
      }
    }
    const elapsedMs = Date.now() - t0All;
    return { txids: results.filter((r) => r.ok).map((r) => r.txid), elapsedMs };
  }

  // === Single wallet flow ===
  // Discover token balance and decimals
  const owner = wallet.publicKey;
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
    amountRaw = BigInt(Math.floor(Number(amountTokens) * 10 ** decimals));
  } else {
    const p = Math.max(1, Math.min(100, Math.floor(percent)));
    amountRaw = (balanceRaw * BigInt(p)) / 100n;
  }
  if (amountRaw <= 0n) throw new Error("Amount to sell is zero");

  // Reuse adaptive slippage calculated earlier
  // (variable 'slippage' defined above)
  const quoteUrl = `${JUP_BASE}/v6/quote?inputMint=${tokenMint}&outputMint=${SOL_MINT}&amount=${amountRaw.toString()}&slippageBps=${slippage}`;
  const quoteRes = await axios.get(quoteUrl);
  const route = quoteRes?.data?.data?.[0];
  if (!route) throw new Error("No route for sell");

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
    const resp = await submitBundle([base64Signed]);
    txid = resp?.uuid || "bundle_submitted";
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
  const slot = await connection.getSlot().catch(() => undefined);
  const solOut = route?.outAmount ? route.outAmount / 1e9 : undefined;
  try {
    if (chatId !== undefined && chatId !== null) {
      addTradeLog(chatId, {
        kind: "sell",
        mint: tokenMint,
        amountRaw: amountRaw.toString(),
        solOut,
        txid,
        latencyMs,
        slot,
      });
    }
  } catch {}
  return { txid };
}
