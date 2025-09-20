import { measureRpcLatency } from "./rpcMonitor.js";
import { MongoClient } from "mongodb";

// In-memory slippage feedback store (simple ring buffer)
const FEEDBACK_WINDOW = 100; // keep last N observations
const slipStore = [];

// Lazy Mongo connection for optional DB persistence
let mongoClient;
let slipCol;
let connectingPromise;

async function ensureSlippageCol() {
  if (slipCol) return slipCol;
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (!connectingPromise) {
    connectingPromise = (async () => {
      const client = new MongoClient(uri, { ignoreUndefined: true });
      await client.connect();
      const db = client.db(process.env.MONGODB_DB || "turbosol");
      const col = db.collection("slippage_feedback");
      try {
        await col.createIndex({ ts: -1 });
        await col.createIndex({ success: 1, ts: -1 });
      } catch {}
      mongoClient = client;
      slipCol = col;
      return col;
    })();
  }
  try {
    await connectingPromise;
  } catch {}
  return slipCol || null;
}

function pushFeedback(entry) {
  slipStore.push({ ...entry, ts: Date.now() });
  if (slipStore.length > FEEDBACK_WINDOW) slipStore.shift();
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((p / 100) * (sorted.length - 1)))
  );
  return sorted[idx];
}

function toBpsFromImpact(priceImpactPct) {
  const v = Number(priceImpactPct || 0);
  if (!Number.isFinite(v) || v <= 0) return 0;
  // Heuristic: if value looks like a fraction (<=1.5), treat as 0..1 => 0..100%
  // otherwise assume already percent (e.g., 2.5 => 2.5%)
  return v <= 1.5 ? Math.round(v * 10000) : Math.round(v * 100);
}

// Record observed slippage/impact after a swap attempt
// usedBps: slippage supplied to the quote
// priceImpactPct: observed route impact (fraction or percent; we'll normalize)
// success: whether the send step succeeded (does not imply on-chain fill success)
// latencyMs: optional latency of send path
export function recordSlippageFeedback({
  usedBps,
  priceImpactPct,
  success,
  latencyMs,
}) {
  try {
    const used = Number(usedBps || 0);
    const impactBps = toBpsFromImpact(priceImpactPct);
    const entry = {
      usedBps: used,
      impactBps,
      success: !!success,
      latencyMs: Number(latencyMs || 0),
    };
    pushFeedback(entry);
    // Fire-and-forget DB insert
    ensureSlippageCol()
      .then((col) => {
        if (!col) return;
        return col.insertOne({ ...entry, ts: Date.now() }).catch(() => {});
      })
      .catch(() => {});
  } catch {}
}

// Derive a learned slippage estimate from recent in-memory observations
export function getLearnedSlippageBps() {
  try {
    if (!slipStore.length) return 0;
    // Focus on successful sends to avoid bias from unrelated failures
    const ok = slipStore.filter((s) => s.success);
    const sample = ok.length ? ok : slipStore;
    const impactBpsList = sample
      .map((s) => s.impactBps)
      .filter((n) => Number.isFinite(n) && n >= 0);
    if (!impactBpsList.length) return 0;
    const p90 = percentile(impactBpsList, 90);
    const headroom = 25; // extra bps to guard against variance
    const baseEnv = Number(process.env.DEFAULT_SLIPPAGE_BPS || 100);
    const base = Math.max(100, baseEnv); // enforce minimum of 1% for adaptive
    const cap = 800;
    return Math.min(cap, Math.max(base, p90 + headroom));
  } catch {
    return 0;
  }
}

async function getLearnedSlippageBpsFromDb(limit = 300) {
  try {
    const col = await ensureSlippageCol();
    if (!col) return 0;
    const docs = await col
      .find(
        {},
        { projection: { impactBps: 1, success: 1 }, sort: { ts: -1 }, limit }
      )
      .toArray()
      .catch(() => []);
    if (!docs.length) return 0;
    const ok = docs.filter((d) => d?.success);
    const sample = ok.length ? ok : docs;
    const impactBpsList = sample
      .map((d) => Number(d?.impactBps))
      .filter((n) => Number.isFinite(n) && n >= 0);
    if (!impactBpsList.length) return 0;
    const p90 = percentile(impactBpsList, 90);
    const headroom = 25;
    const baseEnv = Number(process.env.DEFAULT_SLIPPAGE_BPS || 100);
    const base = Math.max(100, baseEnv);
    const cap = 800;
    return Math.min(cap, Math.max(base, p90 + headroom));
  } catch {
    return 0;
  }
}

// Estimate adaptive slippage (in basis points) combining RPC latency heuristic and learned feedback.
// Target range: 1–8% (100–800 bps).
// Optimized heuristics (now targeting 1–3% for faster execution):
//   - <200 ms   ➜ 100 bps (1%)
//   - <500 ms   ➜ 150 bps (1.5%)
//   - <800 ms   ➜ 200 bps (2%)
//   - ≥800 ms   ➜ 300 bps (3%)
// Uses the max of DEFAULT_SLIPPAGE_BPS, the heuristic, and the learned estimate; capped at 800 bps and floored at 100 bps.
export async function getAdaptiveSlippageBps() {
  try {
    const latency = await measureRpcLatency();
    if (latency < 0) throw new Error("latency error");
    let rpcHeuristic;
    if (latency < 200) rpcHeuristic = 100;
    else if (latency < 500) rpcHeuristic = 150;
    else if (latency < 800) rpcHeuristic = 200;
    else rpcHeuristic = 300;

    const learnedMem = getLearnedSlippageBps();
    const learnedDb = await getLearnedSlippageBpsFromDb().catch(() => 0);
    const learned = Math.max(learnedMem, learnedDb);

    const baseEnv = Number(process.env.DEFAULT_SLIPPAGE_BPS || 100);
    const base = Math.max(100, baseEnv);
    return Math.min(800, Math.max(base, rpcHeuristic, learned));
  } catch {
    const baseEnv = Number(process.env.DEFAULT_SLIPPAGE_BPS || 100);
    const base = Math.max(100, baseEnv);
    const learnedMem = getLearnedSlippageBps();
    const learnedDb = await getLearnedSlippageBpsFromDb().catch(() => 0);
    const learned = Math.max(learnedMem, learnedDb);
    return Math.min(800, Math.max(base, learned));
  }
}
