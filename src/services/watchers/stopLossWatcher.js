import { performSell } from "../trading/jupiter.js";
import { getUserState } from "../userState.js";
import { getQuoteRaw } from "../trading/jupiter.js";
import { getPositions } from "../positionStore.js";
import {
  getWatchersPaused,
  getWatchersSlowMs,
  getPriorityFeeLamports,
  getUseJitoBundle,
} from "../config.js";

const watchers = new Map();
const profitWatchers = new Map();

// Canonicalize mint strings: extract a valid base58 public key (32–44 chars)
function canonicalizeMint(mint) {
  const s = String(mint || "").trim();
  const match = s.match(/[A-HJ-NP-Za-km-z1-9]{32,44}/);
  return match ? match[0] : s;
}

export function startStopLoss(
  chatId,
  { mint, thresholdPct = 20, grid, pollMs = 400, onEvent }
) {
  const canonicalMint = canonicalizeMint(mint);
  const k = `${chatId}:${canonicalMint}`;
  if (watchers.has(k)) return;
  const state = getUserState(chatId);
  const pos = state.positions.find(
    (p) => p.mint === canonicalMint && p.status === "open"
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
        inputMint: canonicalMint,
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
              tokenMint: canonicalMint,
              percent: 100,
              chatId,
            });
            onEvent?.(`Sold. Tx: ${txid}`);
          } catch (e) {
            onEvent?.(`Sell failed: ${e.message || e}`);
          }
          stopStopLoss(chatId, canonicalMint);
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
            tokenMint: canonicalMint,
            percent: 100,
            chatId,
          });
          onEvent?.(`Sold. Tx: ${txid}`);
        } catch (e) {
          onEvent?.(`Sell failed: ${e.message || e}`);
        }
        stopStopLoss(chatId, canonicalMint);
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
              tokenMint: canonicalMint,
              percent: 100,
              chatId,
            });
            onEvent?.(`Sold. Tx: ${txid}`);
          } catch (e) {
            onEvent?.(`Sell failed: ${e.message || e}`);
          }
          stopStopLoss(chatId, canonicalMint);
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
                tokenMint: canonicalMint,
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
          stopStopLoss(chatId, canonicalMint);
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
      ? `Grid stop-loss armed for ${canonicalMint}`
      : `Stop-loss armed at -${threshold}% for ${canonicalMint}`
  );
  loop();
}

export function stopStopLoss(chatId, mint) {
  const canonicalMint = canonicalizeMint(mint);
  const k = `${chatId}:${canonicalMint}`;
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
  const canonicalMint = canonicalizeMint(mint);
  // Convert probe token amount (assumed 6 decimals SPL) to raw amount for Jupiter
  const amountRaw = Math.floor(probeTokens * 1e6);
  const route = await getQuoteRaw({
    inputMint: canonicalMint,
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
  const canonicalMint = canonicalizeMint(mint);
  const route = await probeQuote({
    mint: canonicalMint,
    probeTokens,
    baseSlippage,
  }).catch(() => null);
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
  const canonicalMint = canonicalizeMint(mint);
  const k = `flash:${chatId}:${canonicalMint}`;
  if (flashWatchers.has(k)) return;
  let running = true;
  const endAt = Date.now() + Math.max(5000, windowMs);
  let lastPrice = null;
  let noQuote = 0;
  let selling = false;
  // Resolve entry/avg price from persistent position store (if available)
  let baseAvgFlash = null;
  try {
    const positions = getPositions(chatId) || [];
    const pos = positions.find(
      (p) => p.mint === canonicalMint && Number(p.tokens) > 0
    );
    const avg = Number(
      pos?.avgPriceSolPerToken ?? pos?.entryPriceSolPerToken ?? NaN
    );
    if (Number.isFinite(avg) && avg > 0) baseAvgFlash = avg;
  } catch {}

  const sellAll = async (reason = "Flash LP guard: exiting...") => {
    try {
      if (selling) return;
      selling = true;
      onEvent?.(`${reason}`);
      const maxRetries = Number(process.env.FLASH_LP_SELL_RETRIES || 3);
      const baseDelayMs = Number(process.env.FLASH_LP_SELL_BACKOFF_MS || 500);
      let attempt = 0;
      let lastErr = null;
      while (attempt <= maxRetries) {
        try {
          const { txid } = await performSell({
            tokenMint: canonicalMint,
            percent: 100,
            slippageBps: Number(process.env.FLASH_LP_EXIT_SLIPPAGE_BPS || 300),
            priorityFeeLamports: getPriorityFeeLamports(),
            useJitoBundle: getUseJitoBundle(),
            chatId,
          });
          onEvent?.(`Sold. Tx: ${txid}`);
          selling = false;
          return;
        } catch (e) {
          lastErr = e;
          const msg = String(e?.message || e);
          const isRateLimited = /429|rate/i.test(msg);
          if (attempt >= maxRetries || !isRateLimited) break;
          const waitMs = baseDelayMs * (attempt + 1);
          onEvent?.(
            `Sell retry ${
              attempt + 1
            }/${maxRetries} after ${waitMs}ms (reason: ${msg.slice(0, 120)})`
          );
          await new Promise((r) => setTimeout(r, waitMs));
          attempt += 1;
        }
      }
      selling = false;
      onEvent?.(`Sell failed: ${lastErr?.message || lastErr}`);
    } catch (e) {
      selling = false;
      onEvent?.(`Sell failed: ${e?.message || e}`);
    }
  };

  const loop = async () => {
    if (!running) return;
    try {
      if (Date.now() >= endAt) {
        try {
          const forceExit =
            String(process.env.FLASH_LP_FORCE_EXIT_ON_WINDOW_END || "")
              .toLowerCase()
              .trim() === "true";
          const minProfitPct = Math.max(
            0,
            Number(process.env.FLASH_LP_MIN_PROFIT_PCT || 0)
          );
          if (forceExit) {
            if (minProfitPct > 0 && baseAvgFlash) {
              // Probe current price and ensure min profit before forced exit
              const amt = Math.max(0, Number(amountTokens || 0));
              const probeTokens = Math.max(0.000001, amt > 0 ? amt * 0.01 : 0.02);
              const baseSlippage = 150;
              const route = await probeQuote({
                mint: canonicalMint,
                probeTokens,
                baseSlippage,
                timeoutMs: 900,
              }).catch(() => null);
              if (route) {
                const unitOut = Number(route.outAmount || 0) / 1e9 / probeTokens;
                const gainPct = ((unitOut - baseAvgFlash) / baseAvgFlash) * 100;
                if (Number.isFinite(gainPct) && gainPct >= minProfitPct) {
                  await sellAll(
                    `Flash-LP guard window ended: forced exit at +${gainPct.toFixed(
                      1
                    )}% (>= ${minProfitPct}%).`
                  );
                } else {
                  onEvent?.(
                    `Flash-LP guard window ended: no exit (gain ${gainPct.toFixed(
                      1
                    )}% < ${minProfitPct}%).`
                  );
                }
              } else {
                onEvent?.(
                  "Flash-LP guard window ended: probe unavailable; skipping forced exit."
                );
              }
            } else {
              await sellAll("Flash-LP guard window ended: forced exit.");
            }
          }
        } catch {}
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
      const smallProbe = Math.max(0.000001, amt > 0 ? amt * 0.005 : 0.01);
      const largeProbe = Math.max(smallProbe * 4, amt > 0 ? amt * 0.02 : 0.04);
      const baseSlippage = 150;

      // Probe sequentially to reduce bursty rate-limits under stress
      const routeSmall = await probeQuote({
        mint: canonicalMint,
        probeTokens: smallProbe,
        baseSlippage,
        timeoutMs: 900,
      }).catch(() => null);
      const routeLarge = await probeQuote({
        mint: canonicalMint,
        probeTokens: largeProbe,
        baseSlippage,
        timeoutMs: 900,
      }).catch(() => null);

      if (!routeSmall && !routeLarge) {
        noQuote += 1;
        if (noQuote >= maxNoQuote) {
          await sellAll("Flash-LP suspected: quotes vanished. Exiting now...");
          stopFlashLpGuard(chatId, canonicalMint);
          return;
        }
        return;
      }
      noQuote = 0;

      const priceNow = routeSmall
        ? Number(routeSmall.outAmount || 0) / 1e9 / smallProbe
        : routeLarge
        ? Number(routeLarge.outAmount || 0) / 1e9 / largeProbe
        : null;

      if (
        lastPrice &&
        priceNow &&
        priceNow < lastPrice * (1 - cliffDropPct / 100)
      ) {
        await sellAll(`Cliff drop >${cliffDropPct}% detected. Exiting...`);
        stopFlashLpGuard(chatId, canonicalMint);
        return;
      }
      if (priceNow) lastPrice = priceNow;

      // Extreme impact on larger probe implies shallow/vanishing LP
      const impactLarge = Number(routeLarge?.priceImpactPct ?? 0);
      if (impactLarge >= impactExitPct) {
        await sellAll(
          `Extreme price impact (${impactLarge.toFixed(1)}%). Exiting...`
        );
        stopFlashLpGuard(chatId, canonicalMint);
        return;
      }

      // Disproportionate slippage between small and large probes
      if (routeSmall && routeLarge) {
        const unitOutSmall =
          Number(routeSmall.outAmount || 0) / 1e9 / smallProbe;
        const unitOutLarge =
          Number(routeLarge.outAmount || 0) / 1e9 / largeProbe;
        if (Number.isFinite(unitOutSmall) && Number.isFinite(unitOutLarge)) {
          const ratio = unitOutLarge / Math.max(1e-9, unitOutSmall);
          if (ratio < 0.5) {
            await sellAll("Severe liquidity thinness detected. Exiting...");
            stopFlashLpGuard(chatId, canonicalMint);
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
  onEvent?.(
    `Flash-LP guard armed for ${canonicalMint} (window ${
      (windowMs / 1000) | 0
    }s)`
  );
  loop();
}

export function stopFlashLpGuard(chatId, mint) {
  const canonicalMint = canonicalizeMint(mint);
  const k = `flash:${chatId}:${canonicalMint}`;
  const stop = flashWatchers.get(k);
  if (stop) stop();
  flashWatchers.delete(k);
}

// --- Take-Profit Guard: Exit on upside spike relative to entry/avg price ---
export function startTakeProfitGuard(
  chatId,
  {
    mint,
    amountTokens,
    windowMs = Number(process.env.TAKE_PROFIT_WINDOW_MS || 60000),
    pollMs = Number(process.env.TAKE_PROFIT_POLL_MS || 300),
    profitPct = Number(process.env.TAKE_PROFIT_PCT || 20),
    sellPct = Number(process.env.TAKE_PROFIT_SELL_PCT || 100),
    onEvent,
  }
) {
  const canonicalMint = canonicalizeMint(mint);
  const k = `tp:${chatId}:${canonicalMint}`;
  if (profitWatchers.has(k)) return;
  let running = true;
  const endAt = Date.now() + Math.max(5000, windowMs);

  // Resolve entry/avg price from persistent position store
  let baseAvg = null;
  try {
    const positions = getPositions(chatId) || [];
    const pos = positions.find(
      (p) => p.mint === canonicalMint && Number(p.tokens) > 0
    );
    const avg = Number(
      pos?.avgPriceSolPerToken ?? pos?.entryPriceSolPerToken ?? NaN
    );
    if (Number.isFinite(avg) && avg > 0) baseAvg = avg;
  } catch {}
  if (!baseAvg) {
    onEvent?.("Take-profit guard: no avg price available. Skipping.");
    return;
  }

  const clampPct = (n) => Math.max(1, Math.min(200, Number(n)));
  const targetPct = clampPct(profitPct);
  const sellPercent = Math.max(1, Math.min(100, Number(sellPct)));

  let fired = false;

  const stopFn = () => {
    running = false;
  };
  profitWatchers.set(k, stopFn);

  const loop = async () => {
    if (!running) return;
    try {
      if (Date.now() >= endAt) {
        // Optional forced exit at window end, gated by minimum profitability
        try {
          const forceExit =
            String(process.env.TAKE_PROFIT_FORCE_EXIT_ON_WINDOW_END || "")
              .toLowerCase()
              .trim() === "true";
          const minProfitPct = Math.max(
            0,
            Number(process.env.TAKE_PROFIT_MIN_PROFIT_PCT || 0)
          );
          if (forceExit) {
            const amt = Math.max(0, Number(amountTokens || 0));
            const probeTokens = Math.max(0.000001, amt > 0 ? amt * 0.01 : 0.02);
            const baseSlippage = 150;
            const route = await probeQuote({
              mint: canonicalMint,
              probeTokens,
              baseSlippage,
              timeoutMs: 900,
            }).catch(() => null);
            if (route) {
              const unitOut = Number(route.outAmount || 0) / 1e9 / probeTokens;
              const gainPct = ((unitOut - baseAvg) / baseAvg) * 100;
              if (Number.isFinite(gainPct) && gainPct >= minProfitPct) {
                try {
                  const { txid } = await performSell({
                    tokenMint: canonicalMint,
                    percent: Math.max(1, Math.min(100, Number(sellPct))),
                    slippageBps: Number(
                      process.env.TAKE_PROFIT_EXIT_SLIPPAGE_BPS || 250
                    ),
                    priorityFeeLamports: getPriorityFeeLamports(),
                    useJitoBundle: getUseJitoBundle(),
                    chatId,
                  });
                  onEvent?.(
                    `Take-profit window ended: forced exit at +${gainPct.toFixed(
                      1
                    )}% (>= ${minProfitPct}%). Tx: ${txid}`
                  );
                } catch (e) {
                  onEvent?.(
                    `Take-profit forced exit failed: ${e?.message || e}`
                  );
                }
              } else {
                onEvent?.(
                  `Take-profit window ended: no exit (gain ${gainPct.toFixed(
                    1
                  )}% < ${minProfitPct}%).`
                );
              }
            }
          }
        } catch {}
        stopTakeProfitGuard(chatId, canonicalMint);
        onEvent?.("Take-profit guard window ended.");
        return;
      }
      if (getWatchersPaused()) {
        onEvent?.("Watchers paused by config. Skipping take-profit guard.");
        return;
      }
      const slowMs = getWatchersSlowMs();
      if (slowMs > 0) await new Promise((r) => setTimeout(r, slowMs));

      const amt = Math.max(0, Number(amountTokens || 0));
      const probeTokens = Math.max(0.000001, amt > 0 ? amt * 0.01 : 0.02);
      const baseSlippage = 150;

      const route = await probeQuote({
        mint: canonicalMint,
        probeTokens,
        baseSlippage,
        timeoutMs: 900,
      }).catch(() => null);

      if (!route) return; // transient; try next tick

      const unitOut = Number(route.outAmount || 0) / 1e9 / probeTokens;
      if (!Number.isFinite(unitOut) || unitOut <= 0) return;

      const gainPct = ((unitOut - baseAvg) / baseAvg) * 100;
      if (!fired && gainPct >= targetPct) {
        fired = true;
        onEvent?.(
          `Take-profit hit: +${gainPct.toFixed(
            1
          )}% >= ${targetPct}%. Selling ${sellPercent}%…`
        );
        try {
          const { txid } = await performSell({
            tokenMint: canonicalMint,
            percent: sellPercent,
            slippageBps: Number(
              process.env.TAKE_PROFIT_EXIT_SLIPPAGE_BPS || 250
            ),
            priorityFeeLamports: getPriorityFeeLamports(),
            useJitoBundle: getUseJitoBundle(),
            chatId,
          });
          onEvent?.(`Sold on take-profit. Tx: ${txid}`);
        } catch (e) {
          onEvent?.(`Take-profit sell failed: ${e?.message || e}`);
        }
        stopTakeProfitGuard(chatId, canonicalMint);
        return;
      }
    } catch {
    } finally {
      if (running) setTimeout(loop, pollMs);
    }
  };

  onEvent?.(
    `Take-profit guard armed for ${canonicalMint} (+${targetPct}% within ${
      (windowMs / 1000) | 0
    }s)`
  );
  loop();
}

export function stopTakeProfitGuard(chatId, mint) {
  const canonicalMint = canonicalizeMint(mint);
  const k = `tp:${chatId}:${canonicalMint}`;
  const stop = profitWatchers.get(k);
  if (stop) stop();
  profitWatchers.delete(k);
}
