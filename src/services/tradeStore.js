import fs from "fs";
import path from "path";
import { MongoClient } from "mongodb";

function getDataDir() {
  return path.resolve(process.env.DATA_DIR || "./data/trades");
}

function ensureDir() {
  const dir = getDataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getFilePath(chatId) {
  ensureDir();
  return path.join(getDataDir(), `${chatId}.jsonl`);
}

// Lazy Mongo connection for optional DB persistence
let mongoClient;
let tradesCol;
let connectingPromise;

async function ensureTradesCol() {
  if (tradesCol) return tradesCol;
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (!connectingPromise) {
    connectingPromise = (async () => {
      const client = new MongoClient(uri, { ignoreUndefined: true });
      await client.connect();
      const db = client.db(process.env.MONGODB_DB || "turbosol");
      const col = db.collection("trades");
      try {
        await col.createIndex({ chatId: 1, timestamp: -1 });
        await col.createIndex({ mint: 1, kind: 1, timestamp: -1 });
      } catch {}
      mongoClient = client;
      tradesCol = col;
      return col;
    })();
  }
  try {
    await connectingPromise;
  } catch (e) {
    // swallow DB init errors to avoid impacting file persistence
  }
  return tradesCol || null;
}

function insertTradeDb(chatId, tradeEntry) {
  // Fire-and-forget DB insert; do not block file append
  ensureTradesCol()
    .then((col) => {
      if (!col) return;
      const doc = { chatId: String(chatId), ...tradeEntry };
      return col.insertOne(doc).catch(() => {});
    })
    .catch(() => {});
}

// Append a trade entry as JSON Lines for efficient streaming analytics
export function appendTrade(chatId, tradeEntry) {
  try {
    const fp = getFilePath(chatId);
    fs.appendFileSync(fp, JSON.stringify(tradeEntry) + "\n");
  } catch (e) {
    console.error("[tradeStore] append failed", e);
  }
  // Also persist to MongoDB if configured
  try {
    insertTradeDb(chatId, tradeEntry);
  } catch {}
}

export function readTrades(chatId, limit = 1000) {
  try {
    const fp = getFilePath(chatId);
    if (!fs.existsSync(fp)) return [];
    const lines = fs.readFileSync(fp, "utf8").trim().split(/\n+/).slice(-limit);
    return lines.map((l) => JSON.parse(l));
  } catch (e) {
    console.error("[tradeStore] read failed", e);
    return [];
  }
}
