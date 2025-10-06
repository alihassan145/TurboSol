import { Connection } from "@solana/web3.js";
import { measureEndpointsLatency } from "./rpcMonitor.js";
import axios from "axios";
import { recordPriorityFeeFeedback } from "./fees.js";

// In-memory endpoint stats for scoring and backoff
const endpointStats = new Map();
const SEND_TIMEOUT_MS = Number(process.env.RPC_SEND_TIMEOUT_MS || 2000);
const READ_TIMEOUT_MS = Number(process.env.RPC_READ_TIMEOUT_MS || 8000);
const READ_RACE_RETRIES = Number(process.env.RPC_READ_RACE_RETRIES || 1);
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
  s.penalty = Math.min(MAX_BACKOFF_MS, (s.penalty || 0) * 1.4 + 100);
  s.backoffUntil = nowMs() + s.penalty;
  s.lastErrorAt = nowMs();
}

function isBackoffActive(url) {
  const s = getStats(url);
  return s.backoffUntil && s.backoffUntil > nowMs();
}

function applyFailurePenalty(url, error) {
  try {
    const msg = String(error?.message || "").toLowerCase();
    // Base penalty
    recordFailure(url);
    // Heavier penalty for gateway failures
    if (msg.includes("502") || msg.includes("bad gateway")) {
      recordFailure(url);
      recordFailure(url);
    }
    // Mild extra penalty for timeouts
    if (msg.includes("timeout") || msg.includes("timed out")) {
      recordFailure(url);
    }
  } catch {}
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

function recordRaceWin(url, latencyMs, attempts, type = "send") {
  const s = getStats(url);
  s.raceWins += 1;
  s.lastRaceAt = nowMs();
  s.lastRaceLatency = latencyMs;
  s.lastRaceAttempts = attempts;
  const meta = type === "send" ? lastSendRaceMeta : lastReadRaceMeta;
  meta.winner = url;
  meta.attempts = attempts;
  meta.latencyMs = latencyMs;
  meta.at = nowMs();
}

export function getLastSendRaceMeta() {
  return { ...lastSendRaceMeta };
}

async function planOrderedEndpoints(endpoints = []) {
  const measured = await measureEndpointsLatency(endpoints).catch(() => []);
  const scored = measured.map((m) => {
    const url = m.url;
    const lat = m.latencyMs ?? m.latency ?? Number.MAX_SAFE_INTEGER;
    const s = getStats(url);
    updateMeasuredLatency(url, lat);
    let score = lat;
    if (isBackoffActive(url)) score += 1000; // de-prioritize during backoff
    score += (s.failures || 0) * 50;
    score += (s.penalty || 0) * 0.1;
    return { url, score };
  });
  scored.sort((a, b) => a.score - b.score);
  return scored;
}

let rpcEndpoints = [];
let rpcGrpcEndpoint = null;
let currentIndex = 0;
let connection = null;
let lastRotatedAt = 0;
let lastRotatedTo = null;
let lastRotationReason = null;

export function initializeRpc() {
  if (rpcEndpoints.length) return;
  const rawList = (
    process.env.RPC_HTTP_ENDPOINTS ||
    process.env.SOLANA_RPC_URLS ||
    ""
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!rawList.length) {
    const single =
      process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
    rpcEndpoints = [single];
  } else {
    rpcEndpoints = rawList;
  }
  currentIndex = 0;
  connection = new Connection(rpcEndpoints[currentIndex], "confirmed");
  rpcGrpcEndpoint = process.env.SOLANA_RPC_GRPC || null;
}

export function getRpcConnection() {
  if (!connection) initializeRpc();
  return connection;
}

export function getGrpcEndpoint() {
  if (!rpcGrpcEndpoint) initializeRpc();
  return rpcGrpcEndpoint;
}

export function rotateRpc(reason = "") {
  if (!rpcEndpoints.length) initializeRpc();
  currentIndex = (currentIndex + 1) % rpcEndpoints.length;
  connection = new Connection(rpcEndpoints[currentIndex], "confirmed");
  lastRotatedAt = nowMs();
  lastRotatedTo = rpcEndpoints[currentIndex];
  lastRotationReason = reason || "manual";
}

export function listRpcEndpoints() {
  if (!rpcEndpoints.length) initializeRpc();
  return rpcEndpoints.slice();
}

export function addRpcEndpoint(url) {
  if (!url) return;
  if (!rpcEndpoints.length) initializeRpc();
  if (!rpcEndpoints.includes(url)) rpcEndpoints.push(url);
}

export function setGrpcEndpoint(url) {
  rpcGrpcEndpoint = url || null;
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
        recordPriorityFeeFeedback({
          fee: null,
          success: true,
          latencyMs: nowMs() - t0,
          via: "private_relay",
        });
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
            SEND_TIMEOUT_MS,
            "rpc_send_timeout"
          );
          recordSuccess(url, nowMs() - start);
          if (!winnerSet) {
            winnerSet = true;
            recordRaceWin(url, nowMs() - t0, attemptsCount, "send");
          }
          recordPriorityFeeFeedback({
            fee: null,
            success: true,
            latencyMs: nowMs() - t0,
            via: `rpc:${url}`,
          });
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
  recordPriorityFeeFeedback({
    fee: null,
    success: false,
    latencyMs: dt,
    via: "rpc_race",
  });
  throw err;
}

export async function submitToPrivateRelay(serializedTx, options = {}) {
  // pull dynamic values from config so Telegram UI updates take effect without restart
  const { getPrivateRelayEndpoint, getPrivateRelayApiKey, getRelayVendor } =
    await import("./config.js");
  // Prefer environment variables if present to support test/runtime overrides
  const relay = process.env.PRIVATE_RELAY_ENDPOINT || getPrivateRelayEndpoint();
  if (!relay) throw new Error("relay_not_configured");
  const txBase64 = Buffer.from(serializedTx).toString("base64");
  const apiKey = process.env.PRIVATE_RELAY_API_KEY || getPrivateRelayApiKey();
  const endpoint = relay;
  const prefer = (process.env.PRIVATE_RELAY_PREFER || "").toLowerCase();
  const vendor = (
    process.env.PRIVATE_RELAY_VENDOR ||
    getRelayVendor?.() ||
    "auto"
  ).toLowerCase();

  // Explicit vendor selection takes precedence
  if (vendor === "jito") {
    try {
      const { submitBundleWithTarget } = await import("./jito.js");
      const res = await submitBundleWithTarget([txBase64]);
      // Jito path does not yield a signature immediately; return success with uuid for telemetry
      return { success: !!res?.uuid, signature: null, uuid: res?.uuid || null };
    } catch (e) {
      return { success: false, error: e?.message || "jito_error" };
    }
  } else if (vendor === "bloxroute") {
    return submitToBloxRoute(txBase64, apiKey, endpoint);
  } else if (vendor === "flashbots") {
    return submitToFlashbots(txBase64, apiKey, endpoint);
  } else if (vendor === "generic") {
    const res = await axios.post(endpoint, {
      txBase64,
      options: options || {},
    });
    return res.data || { success: false };
  }

  // Auto-detect mode: infer by endpoint/prefs
  if (relay.includes("bloxroute") || prefer === "bloxroute") {
    return submitToBloxRoute(txBase64, apiKey, endpoint);
  } else if (relay.includes("flashbots") || prefer === "flashbots") {
    return submitToFlashbots(txBase64, apiKey, endpoint);
  } else if (prefer === "jito") {
    try {
      const { submitBundleWithTarget } = await import("./jito.js");
      const res = await submitBundleWithTarget([txBase64]);
      return { success: !!res?.uuid, signature: null, uuid: res?.uuid || null };
    } catch (e) {
      return { success: false, error: e?.message || "jito_error" };
    }
  }
  // generic webhook
  const res = await axios.post(endpoint, { txBase64, options: options || {} });
  return res.data || { success: false };
}

async function submitToBloxRoute(txBase64, apiKey, endpoint) {
  try {
    const headers = {};
    if (apiKey) headers["X-API-KEY"] = apiKey;
    const res = await axios.post(
      `${endpoint.replace(/\/$/, "")}/tx/solana`,
      { transaction: txBase64 },
      { headers }
    );
    const d = res?.data || {};
    const signature =
      d.txHash ||
      d.signature ||
      d?.result?.txHash ||
      d?.result?.signature ||
      null;
    const ok = !!signature || d.ok === true || d.status === "ok";
    return { success: ok, signature };
  } catch (e) {
    return { success: false, error: e?.message || "bloxroute_error" };
  }
}

async function submitToFlashbots(txBase64, apiKey, endpoint) {
  try {
    const headers = {};
    if (apiKey) headers["X-API-KEY"] = apiKey;
    const res = await axios.post(
      `${endpoint.replace(/\/$/, "")}/v1/solana/submit-bundle`,
      { transactions: [txBase64] },
      { headers }
    );
    const d = res?.data || {};
    const ok = d.status === "ok" || !!d.signature;
    return { success: ok, signature: d.signature || null };
  } catch (e) {
    return { success: false, error: e?.message || "flashbots_error" };
  }
}

let healthTimer = null;

function updateMeasuredLatency(url, latency) {
  try {
    const s = getStats(url);
    s.lastMeasuredLatency = latency;
    const arr = s.recentLatencies || [];
    arr.push(latency);
    if (arr.length > 20) arr.shift();
  } catch {}
}

function computeBestEndpointFromMeasurements(measuredList) {
  const normalized = (measuredList || []).map((m) => ({
    url: m.url,
    latencyMs: m.latencyMs != null ? m.latencyMs : m.latency,
  }));
  const sorted = normalized
    .filter((x) => Number.isFinite(x.latencyMs))
    .sort((a, b) => a.latencyMs - b.latencyMs);
  if (!sorted.length) return null;
  const latencies = sorted.map((x) => x.latencyMs);
  const p50 = percentile(
    latencies.slice().sort((a, b) => a - b),
    0.5
  );
  const p95 = percentile(
    latencies.slice().sort((a, b) => a - b),
    0.95
  );
  return { best: sorted[0].url, p50, p95 };
}

export function startRpcHealthLoop({ intervalMs = 3000, measureFn } = {}) {
  if (healthTimer) return;
  const loop = async () => {
    try {
      const endpoints = listRpcEndpoints();
      const measured = await (measureFn || measureEndpointsLatency)(endpoints);
      // Update stats cache
      for (const m of measured) {
        const latency = m.latency != null ? m.latency : m.latencyMs;
        if (Number.isFinite(latency)) updateMeasuredLatency(m.url, latency);
      }
      const best = computeBestEndpointFromMeasurements(measured);
      if (best && best.best) {
        const idx = endpoints.indexOf(best.best);
        if (idx >= 0 && idx !== currentIndex) {
          currentIndex = idx;
          connection = new Connection(endpoints[currentIndex], "confirmed");
          lastRotatedAt = nowMs();
          lastRotatedTo = endpoints[currentIndex];
          lastRotationReason = "health_loop";
        }
      }
    } catch {}
  };
  healthTimer = setInterval(loop, intervalMs);
}

export function getRpcStatus() {
  const endpoints = listRpcEndpoints();
  const status = endpoints.map((url) => {
    const s = getStats(url);
    return {
      url,
      successes: s.successes,
      failures: s.failures,
      ewmaLatency: s.ewmaLatency,
      lastMeasuredLatency: s.lastMeasuredLatency,
      penalty: s.penalty,
      lastSuccessAt: s.lastSuccessAt,
      lastErrorAt: s.lastErrorAt,
      raceWins: s.raceWins,
      lastRaceLatency: s.lastRaceLatency,
      lastRaceAttempts: s.lastRaceAttempts,
    };
  });
  // Build summary from cached measurements
  const measuredList = status
    .filter((e) => Number.isFinite(e.lastMeasuredLatency))
    .map((e) => ({ url: e.url, latencyMs: e.lastMeasuredLatency }));
  const best = computeBestEndpointFromMeasurements(measuredList) || {};
  const activeUrl = endpoints[currentIndex];
  return {
    activeUrl,
    endpoints: status,
    summary: {
      active: activeUrl,
      fastest: best.best || null,
      fastestP50: best.p50 ?? null,
      fastestP95: best.p95 ?? null,
    },
    lastReadRaceMeta,
    lastSendRaceMeta,
    currentEndpoint: endpoints[currentIndex],
    rotatedAt: lastRotatedAt,
    rotatedTo: lastRotatedTo,
    lastRotationReason,
  };
}

export function stopRpcHealthLoop() {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
}

function percentile(sorted, p) {
  const clamped = Math.min(0.999, Math.max(0, p));
  const idx = Math.floor(clamped * (sorted.length - 1));
  return sorted[idx];
}

function getRpcStatusLegacy() {
  const endpoints = listRpcEndpoints();
  const status = endpoints.map((url) => {
    const s = getStats(url);
    return {
      url,
      successes: s.successes,
      failures: s.failures,
      ewmaLatency: s.ewmaLatency,
      lastMeasuredLatency: s.lastMeasuredLatency,
      penalty: s.penalty,
      lastSuccessAt: s.lastSuccessAt,
      lastErrorAt: s.lastErrorAt,
      raceWins: s.raceWins,
      lastRaceLatency: s.lastRaceLatency,
      lastRaceAttempts: s.lastRaceAttempts,
    };
  });
  return {
    endpoints: status,
    lastReadRaceMeta,
    lastSendRaceMeta,
    currentEndpoint: rpcEndpoints[currentIndex],
    rotatedAt: lastRotatedAt,
    rotatedTo: lastRotatedTo,
    lastRotationReason,
  };
}

export function __resetRpcStateForTests() {
  endpointStats.clear();
  lastReadRaceMeta = { winner: null, attempts: 0, latencyMs: null, at: 0 };
  lastSendRaceMeta = { winner: null, attempts: 0, latencyMs: null, at: 0 };
  rpcEndpoints = [];
  rpcGrpcEndpoint = null;
  currentIndex = 0;
  connection = null;
  lastRotatedAt = 0;
  lastRotatedTo = null;
  lastRotationReason = null;
}

async function raceReadAcrossEndpoints({ callImpl, microBatch = 2, timeoutMs, maxRetries } = {}) {
  const endpoints = listRpcEndpoints();
  const planned = await planOrderedEndpoints(endpoints);
  const ordered = planned.map((p) => p.url);

  const groups = [];
  for (let i = 0; i < ordered.length; i += microBatch) {
    groups.push(ordered.slice(i, i + microBatch));
  }

  let attempts = 0;
  let lastError;

  // Allow limited retries across all waves for transient failures
  const retries = Number.isFinite(maxRetries)
    ? Math.max(0, maxRetries)
    : Number.isFinite(READ_RACE_RETRIES)
    ? Math.max(0, READ_RACE_RETRIES)
    : 1;

  for (let retry = 0; retry <= retries; retry++) {
    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi];
      // Grow timeout per wave up to 3x to accommodate congested RPCs
      const configuredTimeout = Number.isFinite(timeoutMs)
        ? timeoutMs
        : READ_TIMEOUT_MS;
      const baseTimeout = configuredTimeout * Math.min(3, gi + 1);

      const attemptsInGroup = group.map((url, idx) => {
        const delayMs = idx * STAGGER_STEP_MS + Math.floor(Math.random() * 15);
        return (async () => {
          await sleep(delayMs);
          attempts += 1;
          try {
            const res = await promiseWithTimeout(
              callImpl(url),
              baseTimeout,
              "read_timeout"
            );
            return res;
          } catch (e) {
            applyFailurePenalty(url, e);
            throw e;
          }
        })();
      });

      try {
        const res = await Promise.any(attemptsInGroup);
        return res;
      } catch (err) {
        lastError = err?.errors?.[0] || err;
        await sleep(INTER_WAVE_DELAY_MS);
      }
    }

    // If we got here, the whole pass failed; decide whether to retry
    const msg = String(lastError?.message || "").toLowerCase();
    const isTransient =
      msg.includes("timeout") ||
      msg.includes("bad gateway") ||
      msg.includes("502");
    if (retry < retries && isTransient) {
      // brief exponential backoff between retries
      const backoff = 100 + retry * 200;
      await sleep(backoff);
      continue;
    }
    break;
  }

  throw lastError || new Error("read_race_failed");
}

export function getDefaultReadMicroBatch() {
  const s = Number(
    process.env.RPC_READ_MICRO_BATCH || process.env.READ_MICRO_BATCH || 2
  );
  return Number.isFinite(s) && s > 0 ? s : 2;
}

export async function getParsedTokenAccountsByOwnerRaced(
  owner,
  filters,
  { commitment = "confirmed", microBatch, callImpl } = {}
) {
  const conn = getRpcConnection();
  return raceReadAcrossEndpoints({
    microBatch: microBatch || getDefaultReadMicroBatch(),
    callImpl:
      callImpl ||
      (async (url) => {
        const c = new Connection(url, commitment);
        return c.getParsedTokenAccountsByOwner(owner, filters);
      }),
  });
}

export async function getLatestBlockhashRaced({
  commitment = "confirmed",
  microBatch,
  callImpl,
} = {}) {
  const conn = getRpcConnection();
  return raceReadAcrossEndpoints({
    microBatch: microBatch || getDefaultReadMicroBatch(),
    callImpl:
      callImpl ||
      (async (url) => {
        const c = new Connection(url, commitment);
        return c.getLatestBlockhash();
      }),
  });
}

export async function simulateTransactionRaced(
  transaction,
  { commitment = "confirmed", microBatch, callImpl, simulateOptions } = {}
) {
  const conn = getRpcConnection();
  return raceReadAcrossEndpoints({
    microBatch: microBatch || getDefaultReadMicroBatch(),
    callImpl:
      callImpl ||
      (async (url) => {
        const c = new Connection(url, commitment);
        return c.simulateTransaction(transaction, simulateOptions);
      }),
  });
}

export function mapStrategyToMicroBatch(strategy) {
  const s = String(strategy || "").toLowerCase();
  if (s === "aggressive") return 3;
  if (s === "conservative") return 1;
  return 2;
}

export async function getSignaturesForAddressRaced(
  address,
  { commitment = "confirmed", options = {}, microBatch, callImpl, timeoutMs, maxRetries } = {}
) {
  return raceReadAcrossEndpoints({
    microBatch: microBatch || getDefaultReadMicroBatch(),
    timeoutMs,
    maxRetries,
    callImpl:
      callImpl ||
      (async (url) => {
        const c = new Connection(url, commitment);
        return c.getSignaturesForAddress(address, options);
      }),
  });
}

export async function getTransactionRaced(
  signature,
  {
    commitment = "confirmed",
    maxSupportedTransactionVersion = 0,
    microBatch,
    callImpl,
    timeoutMs,
    maxRetries,
  } = {}
) {
  return raceReadAcrossEndpoints({
    microBatch: microBatch || getDefaultReadMicroBatch(),
    timeoutMs,
    maxRetries,
    callImpl:
      callImpl ||
      (async (url) => {
        const c = new Connection(url, commitment);
        return c.getTransaction(signature, {
          commitment,
          maxSupportedTransactionVersion,
        });
      }),
  });
}
