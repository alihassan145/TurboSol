import { Connection } from "@solana/web3.js";
import { measureEndpointsLatency } from "./rpcMonitor.js";
import axios from "axios";

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
export async function sendTransactionRaced(tx, { skipPreflight = true, maxRetries = 0, microBatch = 2, usePrivateRelay = false } = {}) {
  const raw = tx.serialize();
  const opts = { skipPreflight, maxRetries };
  
  // Try private relay first if enabled
  if (usePrivateRelay) {
    try {
      const result = await submitToPrivateRelay(raw);
      if (result.success) {
        return result.signature;
      }
    } catch (error) {
      console.log("Private relay failed, falling back to public RPC:", error.message);
    }
  }
  
  const endpoints = getAllRpcEndpoints();
  if (!endpoints.length) throw new Error("No RPC endpoints configured");

  // Measure latencies and order fastest-first
  let ordered = endpoints;
  try {
    const ranked = await measureEndpointsLatency(endpoints);
    ordered = ranked.map((r) => r.url);
  } catch {}

  // Prepare micro-batch waves to increase broadcast success under load
  const waves = [];
  for (let i = 0; i < ordered.length; i += microBatch) {
    waves.push(ordered.slice(i, i + microBatch));
  }

  let lastError;
  for (const wave of waves) {
    const attempts = wave.map((url) => {
      const c = new Connection(url, "confirmed");
      return c.sendRawTransaction(raw, opts);
    });
    try {
      const sig = await Promise.any(attempts);
      return sig;
    } catch (err) {
      lastError = err?.errors?.[0] || err;
      // continue to next wave
    }
  }
  throw lastError || new Error("All RPC broadcasts failed");
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
  
  try {
    if (relayType === 'bloxroute') {
      return await submitToBloxRoute(txBase64, apiKey, endpoint);
    } else if (relayType === 'flashbots') {
      return await submitToFlashbots(txBase64, apiKey, endpoint);
    } else {
      throw new Error(`Unsupported relay type: ${relayType}`);
    }
  } catch (error) {
    throw new Error(`Private relay submission failed: ${error.message}`);
  }
}

async function submitToBloxRoute(txBase64, apiKey, endpoint) {
  const response = await axios.post(endpoint, {
    transaction: {
      content: txBase64,
      blockchain_network: "Solana"
    }
  }, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    timeout: 5000
  });

  if (response.data && response.data.tx_hash) {
    return {
      success: true,
      signature: response.data.tx_hash
    };
  }
  
  throw new Error(response.data?.message || 'Unknown BloxRoute error');
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
    timeout: 5000
  });

  if (response.data && response.data.result) {
    return {
      success: true,
      signature: response.data.result
    };
  }
  
  throw new Error(response.data?.error?.message || 'Flashbots submission failed');
}
