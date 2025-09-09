import { Connection } from "@solana/web3.js";
import { measureEndpointsLatency } from "./rpcMonitor.js";
import axios from "axios";

// In-memory endpoint stats for scoring and backoff
const endpointStats = new Map();
const TIMEOUT_MS = Number(process.env.RPC_SEND_TIMEOUT_MS || 2500);
const STAGGER_STEP_MS = Number(process.env.RPC_STAGGER_STEP_MS || 30);
const INTER_WAVE_DELAY_MS = Number(process.env.RPC_INTER_WAVE_DELAY_MS || 60);
const MAX_BACKOFF_MS = 60_000;

function nowMs() {
  return Date.now();
}

function getStats(url) {
  let s = endpointStats.get(url);
  if (!s) {
    s = { ewmaLatency: null, successes: 0, failures: 0, penalty: 0, backoffUntil: 0 };
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
  s.ewmaLatency = s.ewmaLatency == null ? sampleLatency : Math.round(alpha * sampleLatency + (1 - alpha) * s.ewmaLatency);
  s.backoffUntil = 0;
}

function recordFailure(url) {
  const s = getStats(url);
  s.failures += 1;
  s.penalty = Math.min(3, (s.penalty || 0) + 0.5);
  const backoff = Math.min(MAX_BACKOFF_MS, Math.pow(2, Math.min(8, s.failures)) * 250);
  s.backoffUntil = nowMs() + backoff;
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
    return ranked.map((r) => ({ url: r.url || r, baseLatency: r.latency ?? 9999, score: r.latency ?? 9999 }));
  }
  planned.sort((a, b) => a.score - b.score);
  return planned;
}

let rpcEndpoints = [];
let rpcGrpcEndpoint = null;
let currentIndex = 0;
let connection = null;

export function initializeRpc() {
  const fromEnv = (process.env.RPC_HTTP_ENDPOINTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const fallback = process.env.SOLANA_RPC_URL
    ? [process.env.SOLANA_RPC_URL]
    : [];
  rpcEndpoints = fromEnv.length ? fromEnv : fallback;
  rpcGrpcEndpoint = process.env.RPC_GRPC_ENDPOINT || null;
  if (rpcEndpoints.length === 0) {
    throw new Error(
      "No RPC endpoints provided. Set RPC_HTTP_ENDPOINTS or SOLANA_RPC_URL"
    );
  }
  currentIndex = 0;
  connection = new Connection(rpcEndpoints[currentIndex], "confirmed");
}

export function getRpcConnection() {
  if (!connection) initializeRpc();
  return connection;
}

export function getGrpcEndpoint() {
  return rpcGrpcEndpoint;
}

export function rotateRpc(reason = "") {
  if (rpcEndpoints.length <= 1) return getRpcConnection();
  currentIndex = (currentIndex + 1) % rpcEndpoints.length;
  connection = new Connection(rpcEndpoints[currentIndex], "confirmed");
  return connection;
}

export function listRpcEndpoints() {
  return rpcEndpoints.map((url, idx) => ({
    url,
    active: idx === currentIndex,
  }));
}

export function addRpcEndpoint(url) {
  if (!url) return listRpcEndpoints();
  if (!rpcEndpoints.includes(url)) rpcEndpoints.push(url);
  if (!connection) connection = new Connection(rpcEndpoints[0], "confirmed");
  return listRpcEndpoints();
}

export function setGrpcEndpoint(url) {
  rpcGrpcEndpoint = url;
  return rpcGrpcEndpoint;
}

// New: expose raw endpoints
export function getAllRpcEndpoints() {
  return [...rpcEndpoints];
}

// New: race raw transaction across multiple RPCs for faster inclusion
// Enhancements:
// - latency-aware ordering (fastest first)
// - micro-batched duplicate broadcasts during congestion
// - staggered sends within a wave with per-attempt timeout
// - endpoint scoring/backoff based on recent failures/success
export async function sendTransactionRaced(
  tx,
  { skipPreflight = true, maxRetries = 0, microBatch = 2, usePrivateRelay = false } = {}
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
      console.warn(`Private relay responded without success: ${JSON.stringify(result).slice(0, 300)}`);
    } catch (error) {
      console.log("Private relay failed, falling back to public RPC:", error.message);
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
  for (const wave of waves) {
    // Stagger attempts inside the wave to reduce redundant duplicates
    const attempts = wave.map((url, idx) => {
      const delayMs = idx * STAGGER_STEP_MS + Math.floor(Math.random() * 15);
      const attempt = (async () => {
        await sleep(delayMs);
        const c = new Connection(url, "confirmed");
        const start = nowMs();
        try {
          const sig = await promiseWithTimeout(c.sendRawTransaction(raw, opts), TIMEOUT_MS, "rpc_send_timeout");
          recordSuccess(url, nowMs() - start);
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

// Private relay submission via BloxRoute or other MEV-protect services
export async function submitToPrivateRelay(serializedTx, options = {}) {
  const {
    relayType = process.env.PRIVATE_RELAY_TYPE || 'bloxroute',
    apiKey = process.env.PRIVATE_RELAY_API_KEY,
    endpoint = process.env.PRIVATE_RELAY_ENDPOINT
  } = options;

  if (!apiKey || !endpoint) {
    throw new Error("Private relay not configured. Set PRIVATE_RELAY_API_KEY and PRIVATE_RELAY_ENDPOINT");
  }

  const txBase64 = Buffer.from(serializedTx).toString('base64');
  const started = nowMs();

  try {
    if (relayType === 'bloxroute') {
      const res = await submitToBloxRoute(txBase64, apiKey, endpoint);
      return { ...res, relayType, relayLatencyMs: nowMs() - started };
    } else if (relayType === 'flashbots') {
      const res = await submitToFlashbots(txBase64, apiKey, endpoint);
      return { ...res, relayType, relayLatencyMs: nowMs() - started };
    } else {
      throw new Error(`Unsupported relay type: ${relayType}`);
    }
  } catch (error) {
    const e = new Error(`Private relay submission failed: ${error.message}`);
    e.relayType = relayType;
    e.relayLatencyMs = nowMs() - started;
    throw e;
  }
}

async function submitToBloxRoute(txBase64, apiKey, endpoint) {
  const response = await axios.post(
    endpoint,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [txBase64],
    },
    {
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      timeout: 7000,
      validateStatus: (s) => s >= 200 && s < 500,
    }
  );

  if (response.status >= 400) {
    const msg = response.data?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Bloxroute HTTP error: ${msg}`);
  }

  const data = response.data || {};
  const result = data.result || data.data || data;
  const signature = result?.signature || result?.txid || result?.txHash || result?.result;
  const success = Boolean(
    (data.result != null || data.data != null) &&
      (result?.success === true || !!signature)
  );
  if (success && signature) {
    return { success: true, signature };
  }
  throw new Error(data?.error?.message || 'Bloxroute submission failed');
}

async function submitToFlashbots(txBase64, apiKey, endpoint) {
  const response = await axios.post(endpoint, {
    jsonrpc: "2.0",
    id: 1,
    method: "sendTransaction",
    params: [txBase64]
  }, {
    headers: {
      'X-Flashbots-Signature': apiKey,
      'Content-Type': 'application/json'
    },
    timeout: 7000,
    validateStatus: (s) => s >= 200 && s < 500
  });

  if (response.status >= 400) {
    const msg = response.data?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Flashbots HTTP error: ${msg}`);
  }

  const data = response.data || {};
  const signature = data.result || data.txHash || data.signature;
  if (signature) {
    return { success: true, signature };
  }
  throw new Error(data?.error?.message || 'Flashbots submission failed');
}
