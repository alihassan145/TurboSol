import fs from "fs";
import path from "path";

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

// Append a trade entry as JSON Lines for efficient streaming analytics
export function appendTrade(chatId, tradeEntry) {
  try {
    const fp = getFilePath(chatId);
    fs.appendFileSync(fp, JSON.stringify(tradeEntry) + "\n");
  } catch (e) {
    console.error("[tradeStore] append failed", e);
  }
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
