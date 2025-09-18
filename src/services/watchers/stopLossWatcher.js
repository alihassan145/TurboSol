import { performSell } from "../trading/jupiter.js";
import { getUserState } from "../userState.js";
import { getQuoteRaw } from "../trading/jupiter.js";
import { getWatchersPaused, getWatchersSlowMs, getPriorityFeeLamports, getUseJitoBundle } from "../config.js";

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

// --- Flash LP Guard: Detect transient/flash liquidity and exit immediately ---
const flashWatchers = new Map();

export function startFlashLpGuard(
  chatId,
  {
    mint,
    amountTokens,
    windowMs = Number(process.env.FLASH_LP_WINDOW_MS || 90000),
    pollMs = Number(process.env.FLASH_LP_POLL_MS || 300),
    cliffDropPct = Number(process.env.FLASH_LP_CLIFF_DROP_PCT || 25),
    maxNoQuote = Number(process.env.FLASH_LP_MAX_NOQUOTE || 2),
    impactExitPct = Number(process.env.FLASH_LP_IMPACT_EXIT_PCT || 60),
    onEvent,
  }
) {
  const k = `flash:${chatId}:${mint}`;
  if (flashWatchers.has(k)) return;
  let running = true;
  const endAt = Date.now() + Math.max(5000, windowMs);
  let lastPrice = null;
  let noQuote = 0;

  const sellAll = async (reason = "Flash LP guard: exiting...") => {
    try {
      onEvent?.(`${reason}`);
      const { txid } = await performSell({
        tokenMint: mint,
        percent: 100,
        slippageBps: Number(process.env.FLASH_LP_EXIT_SLIPPAGE_BPS || 300),
        priorityFeeLamports: getPriorityFeeLamports(),
        useJitoBundle: getUseJitoBundle(),
        chatId,
      });
      onEvent?.(`Sold. Tx: ${txid}`);
    } catch (e) {
      onEvent?.(`Sell failed: ${e?.message || e}`);
    }
  };

  const loop = async () => {
    if (!running) return;
    try {
      if (Date.now() >= endAt) {
        stopFlashLpGuard(chatId, mint);
        onEvent?.("Flash-LP guard window ended.");
        return;
      }
      if (getWatchersPaused()) {
        onEvent?.("Watchers paused by config. Skipping flash-LP guard.");
        return;
      }
      const slowMs = getWatchersSlowMs();
      if (slowMs > 0) await new Promise((r) => setTimeout(r, slowMs));

      const amt = Math.max(0, Number(amountTokens || 0));
      const smallProbe = Math.max(0.000001, (amt > 0 ? amt * 0.005 : 0.01));
      const largeProbe = Math.max(smallProbe * 4, (amt > 0 ? amt * 0.02 : 0.04));
      const baseSlippage = 150;

      const [routeSmall, routeLarge] = await Promise.all([
        probeQuote({ mint, probeTokens: smallProbe, baseSlippage, timeoutMs: 900 }).catch(() => null),
        probeQuote({ mint, probeTokens: largeProbe, baseSlippage, timeoutMs: 900 }).catch(() => null),
      ]);

      if (!routeSmall && !routeLarge) {
        noQuote += 1;
        if (noQuote >= maxNoQuote) {
          await sellAll("Flash-LP suspected: quotes vanished. Exiting now...");
          stopFlashLpGuard(chatId, mint);
          return;
        }
        return;
      }
      noQuote = 0;

      const priceNow = routeSmall
        ? (Number(routeSmall.outAmount || 0) / 1e9) / smallProbe
        : routeLarge
        ? (Number(routeLarge.outAmount || 0) / 1e9) / largeProbe
        : null;

      if (lastPrice && priceNow && priceNow < lastPrice * (1 - cliffDropPct / 100)) {
        await sellAll(`Cliff drop >${cliffDropPct}% detected. Exiting...`);
        stopFlashLpGuard(chatId, mint);
        return;
      }
      if (priceNow) lastPrice = priceNow;

      // Extreme impact on larger probe implies shallow/vanishing LP
      const impactLarge = Number(routeLarge?.priceImpactPct ?? 0);
      if (impactLarge >= impactExitPct) {
        await sellAll(`Extreme price impact (${impactLarge.toFixed(1)}%). Exiting...`);
        stopFlashLpGuard(chatId, mint);
        return;
      }

      // Disproportionate slippage between small and large probes
      if (routeSmall && routeLarge) {
        const unitOutSmall = (Number(routeSmall.outAmount || 0) / 1e9) / smallProbe;
        const unitOutLarge = (Number(routeLarge.outAmount || 0) / 1e9) / largeProbe;
        if (Number.isFinite(unitOutSmall) && Number.isFinite(unitOutLarge)) {
          const ratio = unitOutLarge / Math.max(1e-9, unitOutSmall);
          if (ratio < 0.5) {
            await sellAll("Severe liquidity thinness detected. Exiting...");
            stopFlashLpGuard(chatId, mint);
            return;
          }
        }
      }
    } catch (e) {
      // ignore transient errors
    } finally {
      if (running) setTimeout(loop, pollMs);
    }
  };

  flashWatchers.set(k, () => {
    running = false;
  });
  onEvent?.(`Flash-LP guard armed for ${mint} (window ${(windowMs / 1000) | 0}s)`);
  loop();
}

export function stopFlashLpGuard(chatId, mint) {
  const k = `flash:${chatId}:${mint}`;
  const stop = flashWatchers.get(k);
  if (stop) stop();
  flashWatchers.delete(k);
}
