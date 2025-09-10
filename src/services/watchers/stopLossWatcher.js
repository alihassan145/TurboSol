import { performSell } from "../trading/jupiter.js";
import { getUserState } from "../userState.js";
import { getQuoteRaw } from "../trading/jupiter.js";
import { getWatchersPaused, getWatchersSlowMs } from "../config.js";

const watchers = new Map();

export function startStopLoss(
  chatId,
  { mint, thresholdPct = 20, grid, pollMs = 400, onEvent }
) {
  const k = `${chatId}:${mint}`;
  if (watchers.has(k)) return;
  const state = getUserState(chatId);
  const pos = state.positions.find(
    (p) => p.mint === mint && p.status === "open"
  );
  if (!pos || !pos.avgPriceSolPerToken || !pos.tokensOut) {
    onEvent?.("No open position with avg price available.");
    return;
  }
  const avg = Number(pos.avgPriceSolPerToken);
  const amountTokens = Number(pos.tokensOut);
  const threshold = Math.max(1, Math.min(95, Number(thresholdPct)));
  let running = true;
  let lastPrice = null;
  let missQuotes = 0;
  const gridLevels = Array.isArray(grid)
    ? grid.slice().sort((a, b) => a.dropPct - b.dropPct)
    : null;
  const fired = new Set();

  const loop = async () => {
    if (!running) return;
    try {
      // Pause switch
      if (getWatchersPaused()) {
        onEvent?.("Watchers paused by config. Skipping stop-loss check.");
        return;
      }
      const slowMs = getWatchersSlowMs();
      if (slowMs > 0) await new Promise((r) => setTimeout(r, slowMs));

      // Quote ~1% of position to estimate price
      const probeTokens = Math.max(0.000001, amountTokens * 0.01);
      const baseSlippage = 150; // generous to get quotes in stress
      const route = await getQuoteRaw({
        inputMint: mint,
        outputMint: "So11111111111111111111111111111111111111112",
        amountRaw: Math.floor(probeTokens * 1e6),
        slippageBps: baseSlippage,
        timeoutMs: 1000,
      });
      if (!route) {
        missQuotes += 1;
        if (missQuotes >= 2) {
          onEvent?.(
            "Liquidity drain suspected (no quotes). Exiting full position..."
          );
          try {
            const { txid } = await performSell({
              tokenMint: mint,
              percent: 100,
              chatId,
            });
            onEvent?.(`Sold. Tx: ${txid}`);
          } catch (e) {
            onEvent?.(`Sell failed: ${e.message || e}`);
          }
          stopStopLoss(chatId, mint);
          return;
        }
        return;
      }
      missQuotes = 0;
      const solOut = route.outAmount / 1e9; // SOL decimals
      const priceNow = solOut / probeTokens;
      const dropPct = ((avg - priceNow) / avg) * 100;
      // Fast drain: single-interval cliff > 30%
      if (lastPrice && priceNow < lastPrice * 0.7) {
        onEvent?.("Cliff drop detected (>30%). Exiting full position...");
        try {
          const { txid } = await performSell({
            tokenMint: mint,
            percent: 100,
            chatId,
          });
          onEvent?.(`Sold. Tx: ${txid}`);
        } catch (e) {
          onEvent?.(`Sell failed: ${e.message || e}`);
        }
        stopStopLoss(chatId, mint);
        return;
      }
      lastPrice = priceNow;

      if (!gridLevels) {
        if (dropPct >= threshold) {
          onEvent?.(
            `Stop-loss triggered (${dropPct.toFixed(
              1
            )}% <= -${threshold}%). Selling all...`
          );
          try {
            const { txid } = await performSell({
              tokenMint: mint,
              percent: 100,
              chatId,
            });
            onEvent?.(`Sold. Tx: ${txid}`);
          } catch (e) {
            onEvent?.(`Sell failed: ${e.message || e}`);
          }
          stopStopLoss(chatId, mint);
        }
      } else {
        // Grid mode: fire partial exits as thresholds are crossed
        for (let i = 0; i < gridLevels.length; i++) {
          const level = gridLevels[i];
          const d = Math.max(1, Math.min(95, Number(level.dropPct)));
          const sellPct = Math.max(1, Math.min(100, Number(level.sellPct)));
          if (!fired.has(i) && dropPct >= d) {
            fired.add(i);
            onEvent?.(`Grid stop hit: -${d}% -> selling ${sellPct}%`);
            try {
              const { txid } = await performSell({
                tokenMint: mint,
                percent: sellPct,
                chatId,
              });
              onEvent?.(`Partial sold (${sellPct}%). Tx: ${txid}`);
            } catch (e) {
              onEvent?.(`Partial sell failed: ${e.message || e}`);
            }
          }
        }
        if (fired.size === gridLevels.length) {
          stopStopLoss(chatId, mint);
          onEvent?.("All grid levels executed. Stop-loss watcher stopped.");
        }
      }
    } catch (e) {
      // ignore transient errors
    } finally {
      if (running) setTimeout(loop, pollMs);
    }
  };

  watchers.set(k, () => {
    running = false;
  });
  onEvent?.(
    gridLevels
      ? `Grid stop-loss armed for ${mint}`
      : `Stop-loss armed at -${threshold}% for ${mint}`
  );
  loop();
}

export function stopStopLoss(chatId, mint) {
  const k = `${chatId}:${mint}`;
  const stop = watchers.get(k);
  if (stop) stop();
  watchers.delete(k);
}

async function probeQuote({
  mint,
  probeTokens,
  baseSlippage = 100,
  timeoutMs = 900,
}) {
  // Convert probe token amount (assumed 6 decimals SPL) to raw amount for Jupiter
  const amountRaw = Math.floor(probeTokens * 1e6);
  const route = await getQuoteRaw({
    inputMint: mint,
    outputMint: "So11111111111111111111111111111111111111112",
    amountRaw,
    slippageBps: baseSlippage,
    timeoutMs,
  });
  return route;
}

export async function checkStopLoss({
  mint,
  thresholdPrice,
  probeTokens = 1,
  baseSlippage = 100,
}) {
  const route = await probeQuote({ mint, probeTokens, baseSlippage }).catch(
    () => null
  );
  if (!route) return { triggered: false };
  const outAmount = Number(route.outAmount || 0);
  // price per token in lamports
  const priceLamports = outAmount / Math.max(1, Math.floor(probeTokens * 1e6));
  if (!Number.isFinite(priceLamports)) return { triggered: false };
  const priceSol = priceLamports / 1e9;
  return { triggered: priceSol <= thresholdPrice, priceSol };
}
