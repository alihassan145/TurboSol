import { performSwap, getQuoteRaw } from "../trading/jupiter.js";
import { getWalletBalance } from "../walletInfo.js";
import { riskCheckToken } from "../risk.js";
import { measureRpcLatency } from "../rpcMonitor.js";
import {
  upsertActiveSnipe,
  markSnipeExecuted,
  markSnipeCancelled,
} from "../snipeStore.js";

const activeWatchers = new Map();

export function startLiquidityWatch(
  chatId,
  {
    mint,
    amountSol,
    onEvent,
    priorityFeeLamports,
    useJitoBundle,
    pollInterval,
    slippageBps,
    retryCount,
    dynamicSizing,
    minBuySol,
    maxBuySol,
  }
) {
  const k = `${chatId}:${mint}`;
  if (activeWatchers.has(k)) return;

  const baseInterval = Math.max(250, Number(pollInterval ?? 300));
  const maxAttempts = Number(retryCount ?? 3);
  let attempts = 0;
  let intervalMs = baseInterval;
  let stopped = false;

  // Persist the snipe job as active so it can be resumed on restart
  upsertActiveSnipe(chatId, {
    mint,
    amountSol,
    status: "active",
    startedAt: Date.now(),
    settings: {
      priorityFeeLamports,
      useJitoBundle,
      pollInterval: baseInterval,
      slippageBps,
      retryCount: maxAttempts,
      dynamicSizing: !!dynamicSizing,
      minBuySol,
      maxBuySol,
    },
  }).catch(() => {});

  const checkReady = async () => {
    // balance preflight
    const bal = await getWalletBalance(chatId);
    if ((bal?.solBalance || 0) < amountSol) {
      onEvent?.(
        `Insufficient SOL (${bal?.solBalance || 0}). Deposit to proceed.`
      );
      return false;
    }
    // optional risk check preflight
    try {
      const requireLpLock =
        String(process.env.REQUIRE_LP_LOCK || "").toLowerCase() === "true" ||
        process.env.REQUIRE_LP_LOCK === "1";
      const maxBuyTaxBps = Number(process.env.MAX_BUY_TAX_BPS || 1500);
      const risk = await riskCheckToken(mint, { requireLpLock, maxBuyTaxBps });
      if (!risk.ok) {
        onEvent?.(`Blocked by risk: ${risk.reasons?.join("; ")}`);
        return false;
      }
    } catch {}
    return true;
  };

  const attempt = async () => {
    if (stopped) return;
    attempts += 1;
    try {
      const ready = await checkReady();
      if (!ready) return;
      // quick readiness probe for route availability via shared Jupiter helper
      const route = await getQuoteRaw({
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: mint,
        amountRaw: Math.round(amountSol * 1e9),
        slippageBps: slippageBps ?? 100,
        timeoutMs: 900,
      });
      if (!route) return; // not ready yet

      // Dynamic sizing based on env or param
      const dynEnabled =
        dynamicSizing ??
        String(process.env.DYNAMIC_SIZING || "").toLowerCase() === "true";
      let buyAmountSol = amountSol;
      if (dynEnabled) {
        const minSol = Number(minBuySol ?? process.env.MIN_BUY_SOL ?? 0.01);
        const maxSol = Number(
          maxBuySol ?? process.env.MAX_BUY_SOL ?? Math.max(amountSol, 0.5)
        );
        const impact = Number(route.priceImpactPct ?? 0); // best-effort
        if (impact >= 5) buyAmountSol = Math.max(minSol, amountSol * 0.5);
        else if (impact <= 1) buyAmountSol = Math.min(maxSol, amountSol * 2);
      }

      // Adaptive slippage by attempts (safe and robust without trusting priceImpact schema)
      let slip = Number(slippageBps ?? 100);
      slip = Math.min(1000, slip + (attempts - 1) * 100);

      // Priority fee optimizer from observed latency
      let prio = priorityFeeLamports;
      if (!prio) {
        const lat = await measureRpcLatency().catch(() => 400);
        if (lat < 200) prio = 50000;
        else if (lat < 500) prio = 150000;
        else prio = 300000;
      }
      if (prio && attempts <= 3)
        prio = Math.floor(prio * (0.7 + 0.15 * (attempts - 1)));

      const { txid } = await performSwap({
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: mint,
        amountSol: buyAmountSol,
        slippageBps: slip,
        priorityFeeLamports: prio,
        useJitoBundle,
        chatId,
      });
      onEvent?.(`Bought ${mint}. Tx: ${txid}`);

      // Mark executed in the store before stopping the watcher
      markSnipeExecuted(chatId, mint, { txid }).catch(() => {});

      stopLiquidityWatch(chatId, mint);
    } catch (e) {
      // adaptive backoff up to 2x base
      intervalMs = Math.min(baseInterval * 2, Math.floor(intervalMs * 1.25));
    }
  };

  const interval = setInterval(attempt, intervalMs);
  activeWatchers.set(k, interval);
  onEvent?.(`Watching ${mint} every ${baseInterval}ms ...`);
}

export function stopLiquidityWatch(chatId, mint) {
  if (mint) {
    const k = `${chatId}:${mint}`;
    const interval = activeWatchers.get(k);
    if (interval) clearInterval(interval);
    activeWatchers.delete(k);
    // If still active (not executed), mark as cancelled
    markSnipeCancelled(chatId, mint, "stopped").catch(() => {});
    return true;
  }
  // stop all for chatId
  [...activeWatchers.entries()].forEach(([k, interval]) => {
    if (k.startsWith(`${chatId}:`)) {
      clearInterval(interval);
      activeWatchers.delete(k);
      const [, m] = k.split(":");
      markSnipeCancelled(chatId, m, "stopped_all").catch(() => {});
    }
  });
  return true;
}
