import axios from "axios";
import { performSwap } from "../trading/jupiter.js";

const activeWatchers = new Map();

function key(chatId, mint) {
  return `${chatId}:${mint}`;
}

async function hasLiquidity(mint) {
  // Heuristic: check if quotes exist with small SOL amount
  try {
    const url = `${
      process.env.JUPITER_BASE_URL || "https://quote-api.jup.ag"
    }/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${mint}&amount=${1e7}`; // 0.01 SOL
    const { data } = await axios.get(url, { timeout: 1200 });
    const route = data?.data?.[0];
    return Boolean(route);
  } catch {
    return false;
  }
}

export function startLiquidityWatch(
  chatId,
  { mint, amountSol, onEvent, priorityFeeLamports, useJitoBundle, pollInterval, slippageBps, retryCount }
) {
  const k = key(chatId, mint);
  if (activeWatchers.has(k)) return;

  const baseInterval = Math.max(400, Number(pollInterval ?? 2000));
  const jitter = Math.min(250, Math.floor(baseInterval * 0.2));
  const intervalMs = baseInterval + Math.floor(Math.random() * (jitter + 1));

  let stopped = false;

  const attempt = async () => {
    if (stopped) return;
    try {
      const ok = await hasLiquidity(mint);
      if (ok) {
        onEvent?.(`Liquidity detected for ${mint}. Buying ${amountSol} SOL...`);
        let success = false;
        let lastErr;
        const maxAttempts = Math.max(1, Number(retryCount ?? 0) + 1);
        const maxFee = (typeof priorityFeeLamports === "number" && priorityFeeLamports > 0) ? priorityFeeLamports : null;
        for (let i = 0; i < maxAttempts; i++) {
          try {
            let feeToUse = priorityFeeLamports;
            if (maxFee !== null) {
              // Escalate from 60% to 100% of max fee across attempts
              const ratio = Math.min(1, 0.6 + (0.4 * i) / Math.max(1, maxAttempts - 1));
              feeToUse = Math.max(1, Math.floor(maxFee * ratio));
            }
            const { txid } = await performSwap({
              inputMint: "So11111111111111111111111111111111111111112",
              outputMint: mint,
              amountSol,
              slippageBps,
              priorityFeeLamports: feeToUse,
              useJitoBundle,
              chatId,
            });
            onEvent?.(`Buy sent. Tx: ${txid}`);
            success = true;
            break;
          } catch (e) {
            lastErr = e;
            onEvent?.(`Attempt ${i + 1} failed: ${e.message || e}`);
            // brief delay before retry to allow routes to stabilize
            await new Promise((r) => setTimeout(r, 200));
          }
        }
        if (!success) {
          onEvent?.(`Buy failed: ${lastErr?.message || lastErr}`);
        }
        // stop watcher after first detection regardless of success
        const interval = activeWatchers.get(k);
        if (interval) clearInterval(interval);
        activeWatchers.delete(k);
        stopped = true;
      }
    } catch (e) {
      onEvent?.(`Watcher error: ${e.message || e}`);
    }
  };

  // Immediate first check for faster reaction
  attempt();

  const interval = setInterval(attempt, intervalMs);
  activeWatchers.set(k, interval);
}

export function stopLiquidityWatch(chatId) {
  [...activeWatchers.entries()].forEach(([k, interval]) => {
    if (k.startsWith(`${chatId}:`)) {
      clearInterval(interval);
      activeWatchers.delete(k);
    }
  });
}
