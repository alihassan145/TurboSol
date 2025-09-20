import {
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  PublicKey,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { getUserWalletInstance, getUserConnectionInstance } from "./wallet.js";
import { simulateBundleAndSend } from "./jito.js";
import { getPriorityFeeLamports, getUseJitoBundle } from "./config.js";
import bs58 from "bs58";
import { MongoClient } from "mongodb";

let suggestionsClient = null;
let suggestionsCol = null;

async function initSuggestionsDb() {
  if (suggestionsCol) return;
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || "turbosol";
  if (!uri) return; // allow running without DB
  suggestionsClient = new MongoClient(uri, { ignoreUndefined: true });
  await suggestionsClient.connect();
  const db = suggestionsClient.db(dbName);
  suggestionsCol = db.collection("suggestions");
  await suggestionsCol.createIndex({ chatId: 1, createdAt: 1 });
}

export async function transferSol({ chatId, to, amountSol }) {
  if (!Number.isFinite(amountSol) || amountSol <= 0) {
    throw new Error("Invalid SOL amount");
  }
  let toPubkey;
  try {
    toPubkey = new PublicKey(to);
  } catch {
    throw new Error("Invalid destination address");
  }
  const wallet = await getUserWalletInstance(chatId);
  const fromPubkey = wallet.publicKey;
  const conn = await getUserConnectionInstance(chatId);

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(
    "confirmed"
  );

  const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);
  const ix = SystemProgram.transfer({ fromPubkey, toPubkey, lamports });

  // Add compute budget for priority fee if set
  const computeIxs = [];
  const priorityFeeMicroLamports = getPriorityFeeLamports();
  if (
    Number.isFinite(priorityFeeMicroLamports) &&
    priorityFeeMicroLamports > 0
  ) {
    computeIxs.push(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: Math.round(priorityFeeMicroLamports),
      })
    );
  }

  const tx = new Transaction({
    feePayer: fromPubkey,
    blockhash,
    lastValidBlockHeight,
  });
  if (computeIxs.length) tx.add(...computeIxs);
  tx.add(ix);

  tx.sign(wallet);

  const useJitoBundle = getUseJitoBundle();
  const res = await simulateBundleAndSend({
    signedTx: tx,
    chatId,
    useJitoBundle,
    priorityFeeMicroLamports: Number.isFinite(priorityFeeMicroLamports)
      ? priorityFeeMicroLamports
      : null,
  });

  // derive signature from signed transaction
  let sigStr = null;
  try {
    const sigBytes = tx.signatures?.[0]?.signature;
    if (sigBytes) sigStr = bs58.encode(sigBytes);
  } catch {}
  return {
    txid: sigStr || res?.txid || null,
    via: res?.via || (useJitoBundle ? "jito" : "rpc"),
    sendMeta: res,
  };
}

// Persist user suggestion
const suggestionsMemory = [];
const suggestionsFile = path.resolve(
  process.cwd(),
  "data",
  "suggestions.jsonl"
);

export async function saveSuggestion({ chatId, username, text }) {
  const doc = {
    chatId: String(chatId),
    username: username || null,
    text: String(text || "").slice(0, 4000),
    createdAt: new Date(),
  };
  try {
    await initSuggestionsDb();
    if (suggestionsCol) {
      await suggestionsCol.insertOne(doc);
      return { ok: true, via: "mongodb" };
    }
  } catch (e) {
    // fallthrough to file/memory
  }

  // File fallback
  try {
    const line = JSON.stringify(doc) + "\n";
    await fs.promises
      .mkdir(path.dirname(suggestionsFile), { recursive: true })
      .catch(() => {});
    await fs.promises.appendFile(suggestionsFile, line, "utf8");
    return { ok: true, via: "file" };
  } catch {}

  // Memory fallback
  suggestionsMemory.push(doc);
  return { ok: true, via: "memory" };
}
