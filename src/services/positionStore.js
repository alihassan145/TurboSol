import fs from "fs";
import path from "path";

function getDataDir() {
  return path.resolve(process.env.POSITIONS_DIR || "./data/positions");
}

function ensureDir() {
  const dir = getDataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getFilePath(chatId) {
  ensureDir();
  return path.join(getDataDir(), `${chatId}.json`);
}

function readJson(fp) {
  try {
    if (!fs.existsSync(fp)) return {};
    const txt = fs.readFileSync(fp, "utf8");
    return JSON.parse(txt || "{}");
  } catch {
    return {};
  }
}

function writeJson(fp, obj) {
  try {
    fs.writeFileSync(fp, JSON.stringify(obj));
  } catch {}
}

// Position keyed by wallet+mint
export function upsertPosition({
  chatId,
  wallet,
  mint,
  tokensAdded,
  solSpent,
  feesLamports = 0,
}) {
  if (!chatId || !wallet || !mint) return;
  const fp = getFilePath(String(chatId));
  const store = readJson(fp);
  const key = `${wallet}:${mint}`;
  const p = store[key] || {
    wallet,
    mint,
    tokens: 0,
    avgPriceSolPerToken: 0,
    realizedPnlSol: 0,
    feesLamports: 0,
    entryPriceSolPerToken: null,
    entrySizeTokens: null,
    entryFeesLamports: null,
    lastUpdated: Date.now(),
  };
  const toks = Number(tokensAdded || 0);
  const sol = Number(solSpent || 0);
  if (toks > 0 && sol > 0) {
    const wasZero = (p.tokens || 0) <= 0;
    const newTokens = p.tokens + toks;
    const newCostSol = p.avgPriceSolPerToken * p.tokens + sol;
    const newAvg = newTokens > 0 ? newCostSol / newTokens : p.avgPriceSolPerToken;
    p.tokens = newTokens;
    p.avgPriceSolPerToken = newAvg;
    p.feesLamports = Number(p.feesLamports || 0) + Number(feesLamports || 0);
    if (wasZero) {
      p.entryPriceSolPerToken = Number(newAvg || sol / toks || 0);
      p.entrySizeTokens = toks;
      p.entryFeesLamports = Number(feesLamports || 0);
    }
    p.lastUpdated = Date.now();
  }
  store[key] = p;
  writeJson(fp, store);
  return p;
}

export function getPositions(chatId) {
  const fp = getFilePath(String(chatId));
  const store = readJson(fp);
  return Object.values(store);
}

export function applySellToPosition({
  chatId,
  wallet,
  mint,
  tokensSold,
  solReceived,
  feesLamports = 0,
}) {
  if (!chatId || !wallet || !mint) return;
  const fp = getFilePath(String(chatId));
  const store = readJson(fp);
  const key = `${wallet}:${mint}`;
  const p = store[key];
  if (!p) return null;
  const toks = Number(tokensSold || 0);
  const sol = Number(solReceived || 0);
  if (toks <= 0) return p;
  const remaining = Math.max(0, (p.tokens || 0) - toks);
  // Realized PnL = proceeds - cost basis of sold tokens
  const costBasis = toks * Number(p.avgPriceSolPerToken || 0);
  const realized = sol - costBasis;
  p.tokens = remaining;
  p.realizedPnlSol = Number(p.realizedPnlSol || 0) + realized;
  p.feesLamports = Number(p.feesLamports || 0) + Number(feesLamports || 0);
  p.lastUpdated = Date.now();
  // If position fully closed, keep avgPrice as is for history
  store[key] = p;
  writeJson(fp, store);
  return p;
}

// Persist a PnL snapshot for auditing/history (JSONL per chat)
export function recordPnlSnapshot(chatId, snapshot) {
  try {
    if (!chatId || !snapshot) return;
    const dir = path.resolve(process.env.PNL_DIR || "./data/pnl");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, `${chatId}.jsonl`);
    const line = JSON.stringify({ ...snapshot, ts: Date.now() });
    fs.appendFileSync(fp, line + "\n");
  } catch {}
}