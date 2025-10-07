import fs from "fs";
import path from "path";
import { MongoClient } from "mongodb";

let mongoClient;
let snipesCol;

function getDataDir() {
  return path.resolve(process.env.DATA_DIR || "./data");
}

function ensureDir() {
  const dir = path.join(getDataDir(), "snipes");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function filePath() {
  return path.join(ensureDir(), "snipes.json");
}

function readFileStore() {
  try {
    const fp = filePath();
    if (!fs.existsSync(fp)) return [];
    const txt = fs.readFileSync(fp, "utf8");
    return JSON.parse(txt || "[]");
  } catch {
    return [];
  }
}

function writeFileStore(items) {
  try {
    const fp = filePath();
    fs.writeFileSync(fp, JSON.stringify(items, null, 2));
  } catch {}
}

export async function initSnipeStore() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || "turbosol";
  if (!uri) return false;
  if (mongoClient && snipesCol) return true;
  try {
    mongoClient = new MongoClient(uri, {
      ignoreUndefined: true,
      retryWrites: true,
      minPoolSize: 1,
      maxPoolSize: Number(process.env.MONGO_MAX_POOL || 10),
      serverSelectionTimeoutMS: Number(process.env.MONGO_SELECT_TIMEOUT_MS || 5000),
      connectTimeoutMS: Number(process.env.MONGO_CONNECT_TIMEOUT_MS || 10000),
      socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS || 20000),
    });
    await mongoClient.connect();
    const db = mongoClient.db(dbName);
    snipesCol = db.collection("snipes");
    try {
      await snipesCol.createIndex({ chatId: 1, mint: 1, status: 1 });
      await snipesCol.createIndex({ status: 1, startedAt: -1 });
    } catch {}
    return true;
  } catch (e) {
    // Swallow DB init errors; fallback to file store
    mongoClient = null;
    snipesCol = null;
    try {
      console.warn(`Mongo snipes DB unavailable: ${e?.message || e}`);
    } catch {}
    return false;
  }
}

export async function upsertActiveSnipe(
  chatId,
  { mint, amountSol, status = "active", startedAt = Date.now(), settings = {} }
) {
  if (snipesCol) {
    await snipesCol.updateOne(
      { chatId: String(chatId), mint, status: "active" },
      {
        $setOnInsert: { chatId: String(chatId), mint, startedAt },
        $set: { amountSol, status: "active", settings },
      },
      { upsert: true }
    );
    return;
  }
  const items = readFileStore();
  const idx = items.findIndex(
    (i) =>
      i.chatId === String(chatId) && i.mint === mint && i.status === "active"
  );
  const doc = {
    chatId: String(chatId),
    mint,
    amountSol,
    status: "active",
    startedAt,
    settings,
  };
  if (idx >= 0) items[idx] = { ...items[idx], ...doc };
  else items.push(doc);
  writeFileStore(items);
}

export async function markSnipeExecuted(chatId, mint, { txid } = {}) {
  const endedAt = Date.now();
  if (snipesCol) {
    await snipesCol.updateOne(
      { chatId: String(chatId), mint, status: "active" },
      { $set: { status: "executed", endedAt, txid } }
    );
    return;
  }
  const items = readFileStore();
  const idx = items.findIndex(
    (i) =>
      i.chatId === String(chatId) && i.mint === mint && i.status === "active"
  );
  if (idx >= 0) {
    items[idx].status = "executed";
    items[idx].endedAt = endedAt;
    if (txid) items[idx].txid = txid;
    writeFileStore(items);
  }
}

export async function markSnipeCancelled(chatId, mint, reason = "stopped") {
  const endedAt = Date.now();
  if (snipesCol) {
    await snipesCol.updateOne(
      { chatId: String(chatId), mint, status: "active" },
      { $set: { status: "cancelled", reason, endedAt } }
    );
    return;
  }
  const items = readFileStore();
  const idx = items.findIndex(
    (i) =>
      i.chatId === String(chatId) && i.mint === mint && i.status === "active"
  );
  if (idx >= 0) {
    items[idx].status = "cancelled";
    items[idx].reason = reason;
    items[idx].endedAt = endedAt;
    writeFileStore(items);
  }
}

export async function loadActiveSnipes() {
  if (snipesCol) {
    const cur = snipesCol.find({ status: "active" });
    return await cur.toArray();
  }
  const items = readFileStore();
  return items.filter((i) => i.status === "active");
}

export async function loadActiveSnipesByChat(chatId) {
  if (snipesCol) {
    const cur = snipesCol.find({ chatId: String(chatId), status: "active" });
    return await cur.toArray();
  }
  const items = readFileStore();
  return items.filter(
    (i) => i.status === "active" && i.chatId === String(chatId)
  );
}
