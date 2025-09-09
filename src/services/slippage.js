import { measureRpcLatency } from "./rpcMonitor.js";

// Estimate adaptive slippage (in basis points) based on current RPC latency.
// Heuristics (now targeting 5–10%):
//   - <200 ms   ➜ 500 bps (5%)
//   - <500 ms   ➜ 700 bps (7%)
//   - <800 ms   ➜ 900 bps (9%)
//   - ≥800 ms   ➜ 1000 bps (10%)
// Uses the larger of DEFAULT_SLIPPAGE_BPS env and the heuristic; capped at 1000 bps.
export async function getAdaptiveSlippageBps() {
  try {
    const latency = await measureRpcLatency();
    if (latency < 0) throw new Error("latency error");
    let bps;
    if (latency < 200) bps = 500;
    else if (latency < 500) bps = 700;
    else if (latency < 800) bps = 900;
    else bps = 1000;
    const base = Number(process.env.DEFAULT_SLIPPAGE_BPS || 500);
    return Math.min(1000, Math.max(base, bps));
  } catch {
    return Number(process.env.DEFAULT_SLIPPAGE_BPS || 500);
  }
}
