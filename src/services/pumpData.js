import axios from "axios";
import https from "https";

// Rate-limited, cached Pump.fun data fetcher to avoid 429s
// Exposes: getCoinDetailsRL(mint)

const PUMP_API = "https://frontend-api.pump.fun";

// Simple in-memory cache: mint -> { data, ts }
const cache = new Map();
const CACHE_TTL_MS = Number(process.env.PUMPFUN_CACHE_TTL_MS || 120000); // 2 minutes

// Global limiter state
let inFlight = 0;
const MAX_CONCURRENCY = Number(process.env.PUMPFUN_MAX_CONCURRENCY || 1);
let minIntervalMs = Number(process.env.PUMPFUN_MIN_INTERVAL_MS || 1500);
let lastRunAt = 0;

// Backoff when server responds with 429
let backoffUntil = 0;
let backoffMs = 0;

const agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 10 });

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runWithLimits(fn) {
  // Respect backoff window
  if (backoffUntil && Date.now() < backoffUntil) {
    await sleep(500);
  }
  // Concurrency gate
  while (inFlight >= MAX_CONCURRENCY) {
    await sleep(50);
  }
  // Min interval gate
  const since = Date.now() - lastRunAt;
  if (since < minIntervalMs) {
    await sleep(minIntervalMs - since);
  }
  inFlight++;
  try {
    lastRunAt = Date.now();
    return await fn();
  } catch (e) {
    // If 429, increase backoff and min interval
    const status = e?.response?.status;
    if (status === 429) {
      backoffMs = Math.min(backoffMs ? backoffMs * 2 : 2000, 120000);
      const jitter = Math.floor(Math.random() * 1000);
      backoffUntil = Date.now() + backoffMs + jitter;
      // Increase min interval slightly to be gentle
      minIntervalMs = Math.min(minIntervalMs + 250, 5000);
      // Rethrow to allow caller to handle
      throw e;
    }
    throw e;
  } finally {
    inFlight--;
  }
}

export async function getCoinDetailsRL(mint) {
  const key = String(mint || "").trim();
  if (!key) return null;
  // Serve from cache if fresh
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) {
    return entry.data;
  }
  const data = await runWithLimits(async () => {
    const url = `${PUMP_API}/coins/${encodeURIComponent(key)}`;
    const res = await axios.get(url, {
      timeout: 8000,
      httpsAgent: agent,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; TurboSol/1.0)",
        Accept: "application/json, text/plain, */*",
        Referer: "https://pump.fun/",
        Origin: "https://pump.fun",
        Connection: "keep-alive",
      },
    });
    return res?.data || null;
  }).catch((e) => {
    // On error, do not cache; return null
    return null;
  });
  if (data) cache.set(key, { data, ts: Date.now() });
  return data;
}

export default { getCoinDetailsRL };