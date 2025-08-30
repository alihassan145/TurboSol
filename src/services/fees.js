import { Connection } from "@solana/web3.js";

/**
 * Estimate a competitive priority fee (in lamports) based on recent blocks.
 * Falls back to a static default when cluster API is unavailable.
 * @param {Connection} connection
 * @param {number} sampleSize Number of recent slots to sample for fees
 * @returns {Promise<number>} Recommended priority fee (lamports)
 */
export async function getAdaptivePriorityFee(connection, sampleSize = 20) {
  try {
    // getRecentPrioritizationFees is available in >=1.17 nodes; wrap in try/catch for compatibility
    const feeInfos = await connection
      .getRecentPrioritizationFees({ limit: sampleSize })
      .catch(() => null);
    if (feeInfos && feeInfos.length) {
      const fees = feeInfos
        .map((f) => Number(f.prioritizationFee))
        .filter((n) => Number.isFinite(n) && n > 0)
        .sort((a, b) => a - b);
      if (fees.length) {
        const median = fees[Math.floor(fees.length / 2)];
        // Add 20% buffer to improve inclusion probability
        return Math.floor(median * 1.2);
      }
    }
  } catch {}
  // Fallback default priority fee (0.0001 SOL)
  return 100000;
}
