import { getRpcConnection } from "./rpc.js";
import { Connection } from "@solana/web3.js";

let latencyCache = { value: 0, timestamp: 0 };
const CACHE_DURATION = 10000; // 10 seconds

export async function measureRpcLatency() {
  const now = Date.now();
  
  // Return cached value if recent
  if (now - latencyCache.timestamp < CACHE_DURATION) {
    return latencyCache.value;
  }

  try {
    const connection = getRpcConnection();
    const start = Date.now();
    await connection.getSlot();
    const latency = Date.now() - start;
    
    latencyCache = { value: latency, timestamp: now };
    return latency;
  } catch (error) {
    return -1; // Error indicator
  }
}

export function getLatencyStatus(latency) {
  if (latency < 0) return "❌ Error";
  if (latency < 200) return "🟢 Fast";
  if (latency < 500) return "🟡 Medium";
  return "🔴 Slow";
}

export async function getRpcStatus() {
  const latency = await measureRpcLatency();
  const status = getLatencyStatus(latency);
  const latencyText = latency >= 0 ? `${latency}ms` : "Error";
  
  return {
    latency,
    status,
    display: `${status} (${latencyText})`
  };
}

// New: measure latency for a list of RPC HTTP endpoints and return sorted results
export async function measureEndpointsLatency(urls = []) {
  const checks = urls.map(async (url) => {
    const started = Date.now();
    try {
      const conn = new Connection(url, "confirmed");
      await conn.getSlot();
      return { url, latency: Date.now() - started };
    } catch (e) {
      // Put failing endpoints at the end
      return { url, latency: Number.MAX_SAFE_INTEGER };
    }
  });
  const results = await Promise.all(checks);
  results.sort((a, b) => a.latency - b.latency);
  return results;
}