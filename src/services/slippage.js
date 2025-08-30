import { measureRpcLatency } from "./rpcMonitor.js";

// Estimate adaptive slippage (in basis points) based on current RPC latency.
// Heuristics:
//   - <200 ms   ➜ 100 bps (1%)
//   - <500 ms   ➜ 150 bps (1.5%)
//   - <800 ms   ➜ 200 bps (2%)
//   - ≥800 ms   ➜ 300 bps (3%)
// Overrides DEFAULT_SLIPPAGE_BPS env when larger; capped at 800 bps.
export async function getAdaptiveSlippageBps() {
  try {
    const latency = await measureRpcLatency();
    if (latency < 0) throw new Error("latency error");
    let bps;
    if (latency < 200) bps = 100;
    else if (latency < 500) bps = 150;
    else if (latency < 800) bps = 200;
    else bps = 300;
    const base = Number(process.env.DEFAULT_SLIPPAGE_BPS || 100);
    return Math.min(800, Math.max(base, bps));
  } catch {
    return Number(process.env.DEFAULT_SLIPPAGE_BPS || 100);
  }
}
