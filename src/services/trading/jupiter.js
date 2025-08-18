import axios from "axios";
import { getConnection, getWallet, getUserWalletInstance, getUserConnectionInstance } from "../wallet.js";
import { VersionedTransaction } from "@solana/web3.js";
import { rotateRpc } from "../rpc.js";
import { submitBundle, serializeToBase64 } from "../jito.js";
import { addPosition } from "../userState.js";

const JUP_BASE = process.env.JUPITER_BASE_URL || "https://quote-api.jup.ag";

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
  chatId,
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

  const amount = toLamports(amountSol);
  const slippage =
    slippageBps ?? Number(process.env.DEFAULT_SLIPPAGE_BPS || 100);

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
  if (useJitoBundle) {
    const base64Signed = serializeToBase64(tx);
    const resp = await submitBundle([base64Signed]);
    txid = resp?.uuid || "bundle_submitted";
  } else {
    try {
      txid = await connection.sendTransaction(tx, { skipPreflight: true });
    } catch (e) {
      // rotate RPC and retry once
      rotateRpc("send failed");
      txid = await getConnection().sendTransaction(tx, {
        skipPreflight: true,
      });
    }
  }
  // Record position for this user (if chatId provided)
  try {
    if (chatId !== undefined && chatId !== null) {
      const tokensOut = route?.outAmount && route?.outToken?.decimals != null
        ? route.outAmount / 10 ** route.outToken.decimals
        : undefined;
      addPosition(chatId, {
        mint: outputMint,
        symbol: route?.outToken?.symbol || "TOKEN",
        solIn: amountSol,
        tokensOut,
        txid,
        status: "open",
        source: useJitoBundle ? "jito" : "rpc",
      });
    }
  } catch {}
  return { txid };
}
