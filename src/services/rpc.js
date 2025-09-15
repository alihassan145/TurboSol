import { Connection } from "@solana/web3.js";
import { measureEndpointsLatency } from "./rpcMonitor.js";
import axios from "axios";

// In-memory endpoint stats for scoring and backoff
const endpointStats = new Map();
const TIMEOUT_MS = Number(process.env.RPC_SEND_TIMEOUT_MS || 2000);
const STAGGER_STEP_MS = Number(process.env.RPC_STAGGER_STEP_MS || 20);
const INTER_WAVE_DELAY_MS = Number(process.env.RPC_INTER_WAVE_DELAY_MS || 40);
const MAX_BACKOFF_MS = 60_000;

// Telemetry of last races
let lastReadRaceMeta = { winner: null, attempts: 0, latencyMs: null, at: 0 };
let lastSendRaceMeta = { winner: null, attempts: 0, latencyMs: null, at: 0 };

function nowMs() {
  return Date.now();
}

function getStats(url) {
  let s = endpointStats.get(url);
  if (!s) {
    s = {
      ewmaLatency: null,
      successes: 0,
      failures: 0,
      penalty: 0,
      backoffUntil: 0,
      lastMeasuredLatency: null,
      recentLatencies: [],
      lastSuccessAt: 0,
      lastErrorAt: 0,
      // race telemetry (per-endpoint)
      raceWins: 0,
      lastRaceAt: 0,
      lastRaceLatency: null,
      lastRaceAttempts: 0,
    };
    endpointStats.set(url, s);
  }
  return s;
}

function recordSuccess(url, sampleLatency) {
  const s = getStats(url);
  s.successes += 1;
  s.failures = Math.max(0, s.failures - 1);
  s.penalty = Math.max(0, (s.penalty || 0) * 0.5);
  const alpha = 0.3;
  s.ewmaLatency =
    s.ewmaLatency == null
      ? sampleLatency
      : Math.round(alpha * sampleLatency + (1 - alpha) * s.ewmaLatency);
  s.backoffUntil = 0;
  s.lastSuccessAt = nowMs();
}

function recordFailure(url) {
  const s = getStats(url);
  s.failures += 1;
  s.penalty = Math.min(3, (s.penalty || 0) + 0.5);
  const backoff = Math.min(
    MAX_BACKOFF_MS,
    Math.pow(2, Math.min(8, s.failures)) * 250
  );
  s.backoffUntil = nowMs() + backoff;
  s.lastErrorAt = nowMs();
}

function isBackoffActive(url) {
  const s = getStats(url);
  return nowMs() < (s.backoffUntil || 0);
}

function promiseWithTimeout(promise, ms, tag = "timeout") {
  let to;
  return Promise.race([
    promise.finally(() => clearTimeout(to)),
    new Promise((_, rej) => {
      to = setTimeout(() => rej(new Error(tag)), ms);
    }),
  ]);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function recordRaceWin(url, latencyMs, attempts, kind /* 'read' | 'send' */) {
  const s = getStats(url);
  s.raceWins = (s.raceWins || 0) + 1;
  s.lastRaceAt = nowMs();
  s.lastRaceLatency = latencyMs;
  s.lastRaceAttempts = attempts;
  const meta = { winner: url, attempts, latencyMs, at: s.lastRaceAt };
  if (kind === "read") {
    lastReadRaceMeta = meta;
  } else if (kind === "send") {
    lastSendRaceMeta = meta;
  }
}

export function getLastSendRaceMeta() {
  return { ...lastSendRaceMeta };
}

async function planOrderedEndpoints(endpoints = []) {
  let ranked = [];
  try {
    ranked = await measureEndpointsLatency(endpoints);
  } catch {
    ranked = endpoints.map((url) => ({ url, latency: 9999 }));
  }
  const planned = [];
  for (const r of ranked) {
    const url = r.url || r;
    const baseLatency = r.latency ?? 9999;
    const s = getStats(url);
    if (isBackoffActive(url)) continue; // skip currently backed-off endpoints
    const score = baseLatency * (1 + (s.penalty || 0));
    planned.push({ url, baseLatency, score });
  }
  // If all are in backoff, ignore backoff and just use the raw order
  if (planned.length === 0) {
    return ranked.map((r) => ({
      url: r.url || r,
      baseLatency: r.latency ?? 9999,
      score: r.latency ?? 9999,
    }));
  }
  planned.sort((a, b) => a.score - b.score);
  return planned;
}

let rpcEndpoints = [];
let rpcGrpcEndpoint = null;
let currentIndex = 0;
let connection = null;
let lastRotatedAt = 0;
let lastRotatedTo = null;
let lastRotationReason = null;

export function initializeRpc() {
  const fromEnv = (process.env.RPC_HTTP_ENDPOINTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromEnv.length) {
    rpcEndpoints = fromEnv;
    currentIndex = 0;
    connection = new Connection(rpcEndpoints[currentIndex], "confirmed");
    lastRotatedAt = nowMs();
    lastRotatedTo = rpcEndpoints[currentIndex];
    lastRotationReason = "initialize";
  }
}

export function getRpcConnection() {
  if (!connection) initializeRpc();
  if (!connection) throw new Error("No RPC endpoints configured");
  return connection;
}

export function getGrpcEndpoint() {
  return rpcGrpcEndpoint;
}

export function rotateRpc(reason = "") {
  if (!rpcEndpoints.length) return null;
  currentIndex = (currentIndex + 1) % rpcEndpoints.length;
  connection = new Connection(rpcEndpoints[currentIndex], "confirmed");
  lastRotatedAt = nowMs();
  lastRotatedTo = rpcEndpoints[currentIndex];
  lastRotationReason = reason || "manual";
  return rpcEndpoints[currentIndex];
}

export function listRpcEndpoints() {
  return rpcEndpoints.slice();
}

export function addRpcEndpoint(url) {
  if (!rpcEndpoints.includes(url)) {
    rpcEndpoints.push(url);
    if (!connection) {
      currentIndex = 0;
      connection = new Connection(rpcEndpoints[currentIndex], "confirmed");
      lastRotatedAt = nowMs();
      lastRotatedTo = rpcEndpoints[currentIndex];
      lastRotationReason = "add";
    }
  }
}

export function setGrpcEndpoint(url) {
  rpcGrpcEndpoint = url;
}

export function getAllRpcEndpoints() {
  if (!rpcEndpoints.length) initializeRpc();
  return rpcEndpoints.slice();
}

export async function sendTransactionRaced(
  tx,
  {
    skipPreflight = true,
    maxRetries = 0,
    microBatch = 2,
    usePrivateRelay = false,
  } = {}
) {
  const raw = tx.serialize();
  const opts = { skipPreflight, maxRetries };
  const t0 = nowMs();
  let via = "rpc";

  // Try private relay first if enabled
  if (usePrivateRelay) {
    try {
      const result = await submitToPrivateRelay(raw);
      if (result.success && result.signature) {
        return result.signature;
      }
      // If relay returns non-success, fall through to RPC with context
      console.warn(
        `Private relay responded without success: ${JSON.stringify(
          result
        ).slice(0, 300)}`
      );
    } catch (error) {
      console.log(
        "Private relay failed, falling back to public RPC:",
        error.message
      );
    }
  }

  const endpoints = getAllRpcEndpoints();
  if (!endpoints.length) throw new Error("No RPC endpoints configured");

  // Measure latencies and compute scored fastest-first order with backoff
  const planned = await planOrderedEndpoints(endpoints);
  const ordered = planned.map((p) => p.url);

  // Prepare micro-batch waves to increase broadcast success under load
  const waves = [];
  for (let i = 0; i < ordered.length; i += microBatch) {
    waves.push(ordered.slice(i, i + microBatch));
  }

  let lastError;
  let attemptsCount = 0;
  let winnerSet = false;
  for (const wave of waves) {
    // Stagger attempts inside the wave to reduce redundant duplicates
    const attempts = wave.map((url, idx) => {
      const delayMs = idx * STAGGER_STEP_MS + Math.floor(Math.random() * 15);
      const attempt = (async () => {
        await sleep(delayMs);
        attemptsCount += 1;
        const c = new Connection(url, "confirmed");
        const start = nowMs();
        try {
          const sig = await promiseWithTimeout(
            c.sendRawTransaction(raw, opts),
            TIMEOUT_MS,
            "rpc_send_timeout"
          );
          recordSuccess(url, nowMs() - start);
          if (!winnerSet) {
            winnerSet = true;
            recordRaceWin(url, nowMs() - t0, attemptsCount, "send");
          }
          return sig;
        } catch (e) {
          recordFailure(url);
          throw e;
        }
      })();
      return attempt;
    });

    try {
      const sig = await Promise.any(attempts);
      return sig;
    } catch (err) {
      lastError = err?.errors?.[0] || err;
      // brief delay between waves to avoid thundering herd
      await sleep(INTER_WAVE_DELAY_MS);
      // continue to next wave
    }
  }
  const dt = nowMs() - t0;
  const err = lastError || new Error("All RPC broadcasts failed");
  err.meta = { source: "rpc_race", sendLatencyMs: dt };
  throw err;
}

export async function submitToPrivateRelay(serializedTx, options = {}) {
  const relay = process.env.PRIVATE_RELAY_ENDPOINT;
  if (!relay) throw new Error("relay_not_configured");
  const txBase64 = Buffer.from(serializedTx).toString("base64");
  const apiKey = process.env.PRIVATE_RELAY_API_KEY;
  const endpoint = relay;
  const prefer = (process.env.PRIVATE_RELAY_PREFER || "").toLowerCase();

  if (relay.includes("bloxroute")) {
    return submitToBloxRoute(txBase64, apiKey, endpoint);
  } else if (relay.includes("flashbots")) {
    return submitToFlashbots(txBase64, apiKey, endpoint);
  }
  // generic webhook
  const res = await axios.post(endpoint, { txBase64, options: options || {} });
  return res.data || { success: false };
}

async function submitToBloxRoute(txBase64, apiKey, endpoint) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["X-API-KEY"] = apiKey;
  const res = await axios.post(
    `${endpoint}/solana/v1/txn/submit`,
    { transaction: txBase64 },
    { headers }
  );
  const ok = res?.data?.ok || res?.status === 200;
  return { success: ok, signature: res?.data?.signature };
}

async function submitToFlashbots(txBase64, apiKey, endpoint) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["X-API-KEY"] = apiKey;
  const res = await axios.post(
    `${endpoint}/relay/v1/bundle`,
    { transaction: txBase64 },
    { headers }
  );
  const ok = res?.data?.ok || res?.status === 200;
  return { success: ok, signature: res?.data?.signature };
}

let healthTimer = null;

function updateMeasuredLatency(url, latency) {
  const s = getStats(url);
  const alpha = 0.3;
  s.lastMeasuredLatency = latency;
  s.ewmaLatency =
    s.ewmaLatency == null
      ? latency
      : Math.round(alpha * latency + (1 - alpha) * s.ewmaLatency);
  // track recent latencies (cap at 10)
  if (Number.isFinite(latency)) {
    s.recentLatencies.push(latency);
    if (s.recentLatencies.length > 10) s.recentLatencies.shift();
  }
}

function computeBestEndpointFromMeasurements(measuredList) {
  // measuredList: [{url, latency}]
  const candidates = [];
  for (const r of measuredList) {
    const url = r.url || r;
    const baseLatency = r.latency ?? 9999;
    const s = getStats(url);
    if (isBackoffActive(url)) continue;
    const score = baseLatency * (1 + (s.penalty || 0));
    candidates.push({ url, baseLatency, score });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.score - b.score);
  return candidates[0].url;
}

export function startRpcHealthLoop({ intervalMs = 3000, measureFn } = {}) {
  if (healthTimer) return false;
  healthTimer = setInterval(async () => {
    try {
      const endpoints = getAllRpcEndpoints();
      if (!endpoints.length) return;
      const measure = measureFn || measureEndpointsLatency;
      const measured = await measure(endpoints);
      // Update EWMA and recent samples
      for (const m of measured) updateMeasuredLatency(m.url, m.latency);
      // Compute best endpoint and rotate if different
      const best = computeBestEndpointFromMeasurements(measured);
      const activeUrl = rpcEndpoints[currentIndex];
      if (best !== activeUrl) {
        const idx = rpcEndpoints.indexOf(best);
        if (idx >= 0) {
          currentIndex = idx;
          connection = new Connection(rpcEndpoints[currentIndex], "confirmed");
          lastRotatedAt = nowMs();
          lastRotatedTo = best;
          lastRotationReason = "health_loop_best";
          // eslint-disable-next-line no-console
          console.log(`[rpc] Rotated active endpoint to ${best}`);
        }
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[rpc] Health loop error:", e?.message || e);
    }
  }, Math.max(500, intervalMs));
  return true;
}

export function stopRpcHealthLoop() {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
}

function percentile(sorted, p) {
  const n = sorted.length;
  if (!n) return null;
  const idx = Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1));
  return sorted[idx];
}

export function getRpcStatus() {
  const list = rpcEndpoints.map((url, idx) => {
    const s = getStats(url);
    const samples = (s.recentLatencies || []).slice().sort((a, b) => a - b);
    const p50 = percentile(samples, 0.5);
    const p95 = percentile(samples, 0.95);
    return {
      url,
      active: idx === currentIndex,
      ewmaLatency: s.ewmaLatency,
      lastMeasuredLatency: s.lastMeasuredLatency,
      successes: s.successes,
      failures: s.failures,
      penalty: s.penalty,
      backoffUntil: s.backoffUntil,
      backoffRemainingMs: Math.max(0, (s.backoffUntil || 0) - nowMs()),
      lastSuccessAt: s.lastSuccessAt || null,
      lastErrorAt: s.lastErrorAt || null,
      p50Latency: p50,
      p95Latency: p95,
      sampleSize: samples.length,
      raceWins: s.raceWins || 0,
      lastRaceAt: s.lastRaceAt || 0,
      lastRaceLatency: s.lastRaceLatency || null,
      lastRaceAttempts: s.lastRaceAttempts || 0,
    };
  });
  // Build human-readable summary
  const active = rpcEndpoints[currentIndex] || null;
  let fastest = null;
  let fastestP50 = null;
  let fastestP95 = null;
  for (const e of list) {
    if (e.sampleSize === 0 || e.p50Latency == null) continue;
    if (fastest == null || e.p50Latency < fastestP50) {
      fastest = e.url;
      fastestP50 = e.p50Latency;
      fastestP95 = e.p95Latency;
    }
  }
  const summary = {
    active,
    fastest,
    fastestP50,
    fastestP95,
    rotatedAt: lastRotatedAt || null,
    rotatedTo: lastRotatedTo || null,
    rotationReason: lastRotationReason || null,
    // telemetry of last races
    lastReadRaceWinner: lastReadRaceMeta.winner,
    lastReadRaceAttempts: lastReadRaceMeta.attempts,
    lastReadRaceLatencyMs: lastReadRaceMeta.latencyMs,
    lastSendRaceWinner: lastSendRaceMeta.winner,
    lastSendRaceAttempts: lastSendRaceMeta.attempts,
    lastSendRaceLatencyMs: lastSendRaceMeta.latencyMs,
  };
  return {
    activeUrl: active,
    lastRotatedAt: lastRotatedAt || null,
    lastRotatedTo: lastRotatedTo || null,
    lastRotationReason: lastRotationReason || null,
    endpoints: list,
    summary,
  };
}

// Test utility: reset internal state (safe to keep exported; no-op in production)
export function __resetRpcStateForTests() {
  stopRpcHealthLoop();
  endpointStats.clear();
  rpcEndpoints = [];
  rpcGrpcEndpoint = null;
  currentIndex = 0;
  connection = null;
  lastRotatedAt = 0;
  lastRotatedTo = null;
  lastRotationReason = null;
  lastReadRaceMeta = { winner: null, attempts: 0, latencyMs: null, at: 0 };
  lastSendRaceMeta = { winner: null, attempts: 0, latencyMs: null, at: 0 };
}

// Utility to race read-type RPC calls across endpoints
async function raceReadAcrossEndpoints({ callImpl, microBatch = 2 }) {
  const endpoints = getAllRpcEndpoints();
  if (!endpoints.length) throw new Error("No RPC endpoints configured");
  const planned = await planOrderedEndpoints(endpoints);
  const ordered = planned.map((p) => p.url);

  const waves = [];
  for (let i = 0; i < ordered.length; i += microBatch) {
    waves.push(ordered.slice(i, i + microBatch));
  }

  let lastError;
  const t0 = nowMs();
  let attemptsCount = 0;
  let winnerSet = false;
  for (const wave of waves) {
    const attempts = wave.map((url, idx) => {
      const delayMs = idx * STAGGER_STEP_MS + Math.floor(Math.random() * 15);
      const attempt = (async () => {
        await sleep(delayMs);
        attemptsCount += 1;
        const start = nowMs();
        try {
          const res = await promiseWithTimeout(
            callImpl(url),
            TIMEOUT_MS,
            "rpc_read_timeout"
          );
          recordSuccess(url, nowMs() - start);
          if (!winnerSet) {
            winnerSet = true;
            recordRaceWin(url, nowMs() - t0, attemptsCount, "read");
          }
          return res;
        } catch (e) {
          recordFailure(url);
          throw e;
        }
      })();
      return attempt;
    });
    try {
      return await Promise.any(attempts);
    } catch (err) {
      lastError = err?.errors?.[0] || err;
      await sleep(INTER_WAVE_DELAY_MS);
    }
  }
  const dt = nowMs() - t0;
  const err = lastError || new Error("All RPC reads failed");
  err.meta = { source: "rpc_read_race", latencyMs: dt };
  throw err;
}

export function getDefaultReadMicroBatch() {
  const strat = process.env.RPC_STRATEGY_DEFAULT || "balanced";
  return mapStrategyToMicroBatch(strat);
}

export async function getParsedTokenAccountsByOwnerRaced(
  owner,
  filters,
  { commitment = "confirmed", microBatch, callImpl } = {}
) {
  const impl =
    typeof callImpl === "function"
      ? callImpl
      : (url) =>
          new Connection(url, commitment).getParsedTokenAccountsByOwner(
            owner,
            filters
          );
  const mb = Number.isFinite(microBatch)
    ? microBatch
    : getDefaultReadMicroBatch();
  return raceReadAcrossEndpoints({ callImpl: impl, microBatch: mb });
}

export async function getLatestBlockhashRaced({
  commitment = "confirmed",
  microBatch,
  callImpl,
} = {}) {
  const impl =
    typeof callImpl === "function"
      ? callImpl
      : (url) =>
          new Connection(url, commitment).getLatestBlockhash({ commitment });
  const mb = Number.isFinite(microBatch)
    ? microBatch
    : getDefaultReadMicroBatch();
  return raceReadAcrossEndpoints({ callImpl: impl, microBatch: mb });
}

export async function simulateTransactionRaced(
  transaction,
  { commitment = "confirmed", microBatch, callImpl, simulateOptions } = {}
) {
  const impl =
    typeof callImpl === "function"
      ? callImpl
      : (url) =>
          new Connection(url, commitment).simulateTransaction(
            transaction,
            simulateOptions || { sigVerify: false, commitment }
          );
  const mb = Number.isFinite(microBatch)
    ? microBatch
    : getDefaultReadMicroBatch();
  return raceReadAcrossEndpoints({ callImpl: impl, microBatch: mb });
}

export function mapStrategyToMicroBatch(strategy) {
  const s = String(strategy || "balanced").toLowerCase();
  if (s === "conservative") return 1;
  if (s === "aggressive") return 3;
  return 2;
}
