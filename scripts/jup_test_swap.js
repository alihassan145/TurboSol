// Standalone Jupiter swap smoke test
// WARNING: This script contains a hardcoded private key placeholder.
// Replace PRIVATE_KEY_BASE58 with a test wallet that you control and fund with small SOL.
// Do NOT commit real keys to version control.

import axios from "axios";
import bs58 from "bs58";
import {
  Connection,
  VersionedTransaction,
  Keypair,
  PublicKey,
} from "@solana/web3.js";

// ===== Config (hardcoded for quick testing) =====
const JUP_BASE = "https://quote-api.jup.ag"; // Jupiter public API base
const RPC_URL = "https://api.mainnet-beta.solana.com"; // You can swap to your own RPC

// Common mints
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "85ioZLv1JYA7z8YxAQ7PXeSCFbQWfn7J5L1ftbxQpump";

// Swap parameters (edit as needed)
const INPUT_MINT = SOL_MINT; // swap from SOL
const OUTPUT_MINT = USDC_MINT; // to USDC
const AMOUNT_LAMPORTS = 1_000_000; // 0.001 SOL
const SLIPPAGE_BPS = 100; // 1%

// Private key of the wallet to sign and pay fees (base58-encoded secret key)
// Replace this placeholder with a funded test wallet (small SOL) that YOU control.
const PRIVATE_KEY_BASE58 =
  "56WVC8RucaxHhRhWodpcHXguLX65md57mzbMhfPBhBEu57aqqBFDadJyuax1XpYAdeuqJUMHxNHSBmR5xVyrKR6A";

async function main() {
  if (!PRIVATE_KEY_BASE58 || PRIVATE_KEY_BASE58.startsWith("PASTE_")) {
    throw new Error(
      "Please set PRIVATE_KEY_BASE58 to a base58-encoded secret key before running."
    );
  }

  const connection = new Connection(RPC_URL, "confirmed");
  const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY_BASE58));
  const userPublicKey = keypair.publicKey.toBase58();

  console.log("[SETUP] Wallet & RPC ready", {
    wallet: userPublicKey,
    rpc: RPC_URL,
  });

  // 1) Get a quote
  const qUrl = `${JUP_BASE}/v6/quote?inputMint=${INPUT_MINT}&outputMint=${OUTPUT_MINT}&amount=${AMOUNT_LAMPORTS}&slippageBps=${SLIPPAGE_BPS}`;
  console.log("[QUOTE] Requesting", { qUrl });

  const quoteStart = Date.now();
  const qRes = await axios.get(qUrl, { timeout: 5000 });
  const quoteTime = Date.now() - quoteStart;
  const route = qRes?.data;

  if (!route) throw new Error("No route returned by Jupiter");

  console.log("[QUOTE] OK", {
    quoteTime,
    outAmount: route?.outAmount,
    priceImpactPct: route?.priceImpactPct,
    routeLabels:
      route?.routePlan?.map((p) => p?.swapInfo?.label).join(">") || "unknown",
  });

  // 2) Create swap transaction
  const swapBody = {
    quoteResponse: route,
    userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: "auto",
  };

  console.log("[SWAP] Creating transaction via Jupiter", {
    userPublicKey,
    prioritization: swapBody.prioritizationFeeLamports,
  });

  const swapStart = Date.now();
  const swapRes = await axios.post(`${JUP_BASE}/v6/swap`, swapBody, {
    timeout: 7000,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    validateStatus: (s) => s >= 200 && s < 500,
  });
  const swapTime = Date.now() - swapStart;

  if (swapRes.status >= 400) {
    throw new Error(
      `Jupiter swap creation failed: HTTP ${swapRes.status} ${
        swapRes.data?.error || ""
      }`
    );
  }

  const swapTxB64 = swapRes?.data?.swapTransaction;
  if (!swapTxB64) throw new Error("No swapTransaction returned by Jupiter");

  console.log("[SWAP] Transaction created", {
    swapTime,
    base64Size: swapTxB64.length,
  });

  // 3) Deserialize, sign, and submit
  let tx;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(swapTxB64, "base64"));
  } catch (e) {
    console.error("[ERROR] Failed to deserialize tx", {
      base64Len: swapTxB64?.length,
      error: e?.message,
    });
    throw e;
  }

  tx.sign([keypair]);

  // Quick sanity: check we have at least one signature
  if (!(tx.signatures?.[0] && tx.signatures[0].length > 0)) {
    throw new Error("Signed transaction has no wallet signature");
  }

  const raw = tx.serialize();
  console.log("[SEND] Submitting raw transaction", { size: raw.length });

  const sig = await connection.sendRawTransaction(raw, {
    skipPreflight: true,
    maxRetries: 3,
  });
  console.log("[SEND] Submitted", {
    signature: sig,
    explorer: `https://solscan.io/tx/${sig}`,
  });

  const conf = await connection.confirmTransaction(sig, "confirmed");
  console.log("[CONFIRMED]", conf);

  console.log("✅ Done");
}

main().catch((err) => {
  // Axios/Jupiter error handling
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const body = err.response?.data;
    console.error("[AXIOS ERROR]", {
      message: err.message,
      status,
      body,
    });
  } else {
    console.error("[ERROR]", err?.message || err);
  }
  process.exit(1);
});
