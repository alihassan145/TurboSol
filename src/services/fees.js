import { Connection } from "@solana/web3.js";

/**
 * Estimate a competitive priority fee (in lamports) based on recent blocks.
 * Falls back to a static default when cluster API is unavailable.
 * @param {Connection} connection
 * @param {number} sampleSize Number of recent slots to sample for fees
 * @returns {Promise<number>} Recommended priority fee (lamports)
 */
const PRIORITY_FEE_TIMEOUT_MS = Number(
  process.env.PRIORITY_FEE_TIMEOUT_MS || 1200
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

function promiseWithTimeout(promise, ms, tag = "timeout") {
  let to;
  return Promise.race([
    promise.finally(() => clearTimeout(to)),
    new Promise((_, rej) => {
      to = setTimeout(() => rej(new Error(tag)), ms);
    }),
  ]);
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
