import { Connection } from "@solana/web3.js";
import axios from "axios";
import { getRpcConnection } from "./rpc.js";
// import { measureRpcLatency } from "./rpcMonitor.js"; // replaced with dynamic import to avoid hard dependency during module init
import { setDynamicPriorityFeeLamports } from "./config.js";

/**
 * Estimate a competitive priority fee (in lamports) based on recent blocks.
 * Falls back to a static default when cluster API is unavailable.
 * @param {Connection} connection
 * @param {number} sampleSize Number of recent slots to sample for fees
 * @returns {Promise<number>} Recommended priority fee (lamports)
 */
const PRIORITY_FEE_TIMEOUT_MS = Number(
  process.env.PRIORITY_FEE_TIMEOUT_MS || 800
);
const PRIORITY_FEE_MULTIPLIER = Number(
  process.env.PRIORITY_FEE_MULTIPLIER || 1.5
);
const MIN_PRIORITY_FEE_LAMPORTS = Number(
  process.env.MIN_PRIORITY_FEE_LAMPORTS || 6000000
);
const DEFAULT_PRIORITY_FEE_LAMPORTS = Number(
  process.env.DEFAULT_PRIORITY_FEE_LAMPORTS || 6000000
);

// Dynamic max cap configuration (thresholds in ms and caps in lamports)
const CAP_T1_MS = Number(process.env.PRIORITY_FEE_CAP_T1_MS || 200);
const CAP_T2_MS = Number(process.env.PRIORITY_FEE_CAP_T2_MS || 500);
const CAP_T3_MS = Number(process.env.PRIORITY_FEE_CAP_T3_MS || 800);
const CAP_LOW = Number(process.env.PRIORITY_FEE_CAP_LOW || 6_000_000);
const CAP_MID = Number(process.env.PRIORITY_FEE_CAP_MID || 10_000_000);
const CAP_HIGH = Number(process.env.PRIORITY_FEE_CAP_HIGH || 16_000_000);
const CAP_MAX = Number(process.env.PRIORITY_FEE_CAP_MAX || 24_000_000);

function promiseWithTimeout(promise, ms, tag = "timeout") {
  let to;
  return Promise.race([
    promise.finally(() => clearTimeout(to)),
    new Promise((_, rej) => {
      to = setTimeout(() => rej(new Error(tag)), ms);
    }),
  ]);
}

/**
 * Compute a dynamic MAX priority fee cap (lamports) from an observed latency.
 * Step function by default; configurable via env. Ensures cap >= MIN_PRIORITY_FEE_LAMPORTS.
 * @param {number} latencyMs
 * @returns {number}
 */
export function computePriorityFeeCap(latencyMs) {
  let cap;
  if (!Number.isFinite(latencyMs) || latencyMs < 0) {
    // Default to mid cap when latency unavailable
    cap = CAP_MID;
  } else if (latencyMs < CAP_T1_MS) {
    cap = CAP_LOW;
  } else if (latencyMs < CAP_T2_MS) {
    cap = CAP_MID;
  } else if (latencyMs < CAP_T3_MS) {
    cap = CAP_HIGH;
  } else {
    cap = CAP_MAX;
  }
  // Never cap below the configured minimum send fee floor
  if (Number.isFinite(MIN_PRIORITY_FEE_LAMPORTS)) {
    cap = Math.max(cap, MIN_PRIORITY_FEE_LAMPORTS);
  }
  return cap;
}

export async function getAdaptivePriorityFee(connection, sampleSize = 20) {
  try {
    // getRecentPrioritizationFees is available in >=1.17 nodes; wrap in try/catch for compatibility
    const feeInfos = await promiseWithTimeout(
      connection
        .getRecentPrioritizationFees({ limit: sampleSize })
        .catch(() => null),
      PRIORITY_FEE_TIMEOUT_MS,
      "priority_fee_timeout"
    ).catch(() => null);
    if (feeInfos && feeInfos.length) {
      const fees = feeInfos
        .map((f) => Number(f.prioritizationFee))
        .filter((n) => Number.isFinite(n) && n > 0)
        .sort((a, b) => a - b);
      if (fees.length) {
        const median = fees[Math.floor(fees.length / 2)];
        // Base recommendation with a buffer to improve inclusion probability
        let recommended = Math.floor(median * 1.2);
        // Apply user-configurable multiplier and minimum floor
        if (
          Number.isFinite(PRIORITY_FEE_MULTIPLIER) &&
          PRIORITY_FEE_MULTIPLIER > 0
        ) {
          recommended = Math.floor(recommended * PRIORITY_FEE_MULTIPLIER);
        }
        if (
          Number.isFinite(MIN_PRIORITY_FEE_LAMPORTS) &&
          recommended < MIN_PRIORITY_FEE_LAMPORTS
        ) {
          recommended = MIN_PRIORITY_FEE_LAMPORTS;
        }
        return recommended;
      }
    }
  } catch {}
  // Fallback default priority fee
  return DEFAULT_PRIORITY_FEE_LAMPORTS;
}

// ---------------- Learned Tip Model (Percentile targeting + feedback) ----------------

const TIP_TARGET_PCT = Math.min(
  0.99,
  Math.max(0.5, Number(process.env.PRIORITY_FEE_TARGET_PCT || 0.75))
);
const TIP_FEEDBACK_WINDOW = Math.max(
  10,
  Number(process.env.TIP_FEEDBACK_WINDOW || 60)
);
const TIP_TARGET_LATENCY_MS = Math.max(
  100,
  Number(process.env.TIP_TARGET_LATENCY_MS || 400)
);
const TIP_HEADROOM = Number(process.env.TIP_HEADROOM || 0.12); // add 12% headroom to percentile

const _feedback = [];

export function recordPriorityFeeFeedback({ fee, success, latencyMs, via }) {
  try {
    _feedback.push({
      t: Date.now(),
      fee: Number(fee) || 0,
      success: Boolean(success),
      latencyMs: Number(latencyMs) || null,
      via: via || null,
    });
    if (_feedback.length > TIP_FEEDBACK_WINDOW) _feedback.shift();
  } catch {}
}

export function getTipModelState() {
  const n = _feedback.length;
  const lat = _feedback
    .map((f) => f.latencyMs)
    .filter((x) => Number.isFinite(x));
  const avgLatency = lat.length
    ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length)
    : null;
  const successRate =
    n > 0 ? _feedback.filter((f) => f.success).length / n : null;
  return { count: n, avgLatency, successRate, targetPct: TIP_TARGET_PCT };
}

function percentile(sortedArr, p) {
  if (!sortedArr.length) return null;
  const clamped = Math.min(0.999, Math.max(0, p));
  const idx = Math.floor(clamped * (sortedArr.length - 1));
  return sortedArr[idx];
}

async function getJitoPercentileEstimate(targetPct) {
  const conn = getRpcConnection();
  const maxRetries = 1;
  try {
    const stats = await promiseWithTimeout(
      conn.getRecentPrioritizationFees({ limit: 40 }).catch(() => null),
      PRIORITY_FEE_TIMEOUT_MS,
      "priority_fee_timeout"
    ).catch(() => null);
    if (!stats || !Array.isArray(stats) || !stats.length) return null;
    const fees = stats
      .map((s) => Number(s.prioritizationFee))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    if (!fees.length) return null;
    return percentile(fees, targetPct);
  } catch (e) {
    return null;
  }
}

async function getRecentFeesPercentile(connection, targetPct, sampleSize) {
  try {
    const feeInfos = await promiseWithTimeout(
      connection
        .getRecentPrioritizationFees({ limit: sampleSize })
        .catch(() => null),
      PRIORITY_FEE_TIMEOUT_MS,
      "priority_fee_timeout"
    ).catch(() => null);
    if (feeInfos && feeInfos.length) {
      const fees = feeInfos
        .map((f) => Number(f.prioritizationFee))
        .filter((n) => Number.isFinite(n) && n > 0)
        .sort((a, b) => a - b);
      if (fees.length) return percentile(fees, targetPct);
    }
  } catch {}
  return null;
}

export async function getLearnedPriorityFeeEstimate(
  connection,
  { targetPct = TIP_TARGET_PCT, sampleSize = 40 } = {}
) {
  try {
    const fromJito = await getJitoPercentileEstimate(targetPct);
    if (Number.isFinite(fromJito) && fromJito > 0) {
      return Math.max(MIN_PRIORITY_FEE_LAMPORTS, Math.floor(fromJito * (1 + TIP_HEADROOM)));
    }
    const p = await getRecentFeesPercentile(connection, targetPct, sampleSize);
    if (Number.isFinite(p) && p > 0) {
      return Math.max(MIN_PRIORITY_FEE_LAMPORTS, Math.floor(p * (1 + TIP_HEADROOM)));
    }
  } catch {}
  // fallback static
  return DEFAULT_PRIORITY_FEE_LAMPORTS;
}

let _tipRefreshTimer = null;

export function startPriorityFeeRefresher({ intervalMs } = {}) {
  const interval = Math.max(2000, Number(intervalMs || 5000));
  if (_tipRefreshTimer) clearInterval(_tipRefreshTimer);
  _tipRefreshTimer = setInterval(async () => {
    try {
      const conn = getRpcConnection();
      const learned = await getLearnedPriorityFeeEstimate(conn).catch(() => null);
      if (Number.isFinite(learned) && learned > 0) {
        setDynamicPriorityFeeLamports(learned);
      }
      // Use dynamic import to avoid tight coupling and circular init issues
      const { measureRpcLatency } = await import("./rpcMonitor.js");
      const latency = await measureRpcLatency();
      const cap = computePriorityFeeCap(latency);
      setDynamicPriorityFeeLamports(Math.min(learned ?? DEFAULT_PRIORITY_FEE_LAMPORTS, cap));
    } catch {}
  }, interval);
}

export function stopPriorityFeeRefresher() {
  if (_tipRefreshTimer) clearInterval(_tipRefreshTimer);
  _tipRefreshTimer = null;
}
