import { performSwap, getQuoteRaw } from "../trading/jupiter.js";
import { getWalletBalance } from "../walletInfo.js";
import { riskCheckToken } from "../risk.js";
import { measureRpcLatency } from "../rpcMonitor.js";
import {
  upsertActiveSnipe,
  markSnipeExecuted,
  markSnipeCancelled,
} from "../snipeStore.js";
import { getWatchersPaused, getWatchersSlowMs } from "../config.js";
import { addTradeLog, getUserState } from "../userState.js";
import { startFlashLpGuard } from "./stopLossWatcher.js";
import { alphaBus } from "../alphaDetection.js";
import { getRpcConnection } from "../rpc.js";

const activeWatchers = new Map();
const cooldowns = new Map(); // chatId:mint -> cool-until timestamp (ms)

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
    source, // optional: origin of this watcher (e.g., 'alpha:pump_launch')
    signalType, // optional: specific signal type/id
  }
) {
  const k = `${chatId}:${mint}`;
  const COOLDOWN_MS = Number(process.env.SNIPE_COOL_OFF_MS ?? 30000);
  const coolUntil = cooldowns.get(k) || 0;
  if (coolUntil && Date.now() < coolUntil) {
    onEvent?.(`In cool-off for ${Math.max(0, coolUntil - Date.now())}ms. Skipping start.`);
    return;
  }
  if (activeWatchers.has(k)) return;

  const baseInterval = Math.max(250, Number(pollInterval ?? 300));
  const maxAttempts = Number(retryCount ?? 3);
  let attempts = 0;
  let intervalMs = baseInterval;
  let stopped = false;
  // Warn only once for insufficient SOL and pause the watcher
  let insufficientWarned = false;

  // Liquidity delta heuristics & guardrails (configurable via ENV)
  const envDeltaEnabled = String(process.env.LIQ_DELTA_ENABLED || "true").toLowerCase() !== "false";
  const state = getUserState?.(chatId);
  const LIQ_DELTA_ENABLED = !!(state?.liqDeltaEnabled ?? envDeltaEnabled);
  const DELTA_PROBE_SOL = Number(
    state?.liqDeltaProbeSol ?? process.env.LIQ_DELTA_PROBE_SOL ?? 0.1
  ); // probe size in SOL to estimate unit-out
  const DELTA_MIN_IMPROV_PCT = Number(
    state?.liqDeltaMinImprovPct ?? process.env.LIQ_DELTA_MIN_IMPROV_PCT ?? 0
  ); // require % improvement between polls to fire
  const DELTA_MAX_PRICE_IMPACT_PCT = Number(
    state?.deltaMaxPriceImpactPct ?? process.env.DELTA_MAX_PRICE_IMPACT_PCT ?? 8
  ); // cap impact to avoid thin LP entries
  const DELTA_MIN_ROUTE_AGE_MS = Number(
    state?.deltaMinRouteAgeMs ?? process.env.DELTA_MIN_ROUTE_AGE_MS ?? 0
  ); // optional min age since first route seen
  let prevUnitOutProbe = null;
  let routeFirstSeenAt = null;

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
      source,
      signalType,
    },
  }).catch(() => {});

  const checkReady = async () => {
    // Pause switch
    if (getWatchersPaused()) {
      onEvent?.("Watchers paused by config. Skipping check.");
      return false;
    }
    // balance preflight
    const bal = await getWalletBalance(chatId);
    if ((bal?.solBalance || 0) < amountSol) {
      if (!insufficientWarned) {
        onEvent?.(`Insufficient SOL (${bal?.solBalance || 0}). Deposit to proceed.`);
        insufficientWarned = true;
        // Pause this watcher to avoid repeated warnings
        stopLiquidityWatch(chatId, mint, "insufficient_sol");
      }
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

      const slowMs = getWatchersSlowMs();
      if (slowMs > 0) await new Promise((r) => setTimeout(r, slowMs));

      // quick readiness probe for route availability via shared Jupiter helper
      const route = await getQuoteRaw({
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: mint,
        amountRaw: Math.round(amountSol * 1e9),
        slippageBps: slippageBps ?? 100,
        timeoutMs: 900,
      });
      if (!route) {
        try { addTradeLog(chatId, { kind: "telemetry", mint, stage: "route_check", status: "unavailable", attempt: attempts }); } catch {}
        return; // not ready yet
      }

      // Liquidity delta heuristic and guardrails (pre-empt launch readiness)
      if (LIQ_DELTA_ENABLED) {
        if (routeFirstSeenAt === null) routeFirstSeenAt = Date.now();

        // Probe with a fixed small size to compute per-SOL unit out and track deltas
        const probeLamports = Math.max(1_000_000, Math.round(DELTA_PROBE_SOL * 1e9)); // >= 0.001 SOL
        let probeRoute = null;
        try {
          probeRoute = await getQuoteRaw({
            inputMint: "So11111111111111111111111111111111111111112",
            outputMint: mint,
            amountRaw: probeLamports,
            slippageBps: slippageBps ?? 100,
            timeoutMs: 700,
          });
        } catch {}
        if (!probeRoute) {
          onEvent?.("Probe route unavailable yet, waiting...");
          try { addTradeLog(chatId, { kind: "telemetry", mint, stage: "probe_check", status: "unavailable", attempt: attempts, probeLamports }); } catch {}
          return;
        }

        const unitOutProbe = Number(probeRoute.outAmount || 0) / Math.max(1, probeLamports);
        const priceImpactPct = Number(probeRoute.priceImpactPct ?? route.priceImpactPct ?? 0);

        // Guardrail: avoid entering on very high impact (thin LP)
        if (priceImpactPct > DELTA_MAX_PRICE_IMPACT_PCT) {
          onEvent?.(`Impact ${priceImpactPct.toFixed(2)}% > ${DELTA_MAX_PRICE_IMPACT_PCT}%. Waiting for more depth.`);
          try { addTradeLog(chatId, { kind: "telemetry", mint, stage: "guardrail", reason: "impact_exceeds_threshold", priceImpactPct, threshold: DELTA_MAX_PRICE_IMPACT_PCT, attempt: attempts }); } catch {}
          prevUnitOutProbe = unitOutProbe;
          return;
        }

        // If we have a previous observation, require minimum improvement unless route has aged sufficiently
        if (prevUnitOutProbe !== null) {
          const improvPct = ((unitOutProbe - prevUnitOutProbe) / Math.max(1e-12, prevUnitOutProbe)) * 100;
          const ageMs = Date.now() - routeFirstSeenAt;
          if (improvPct < DELTA_MIN_IMPROV_PCT && ageMs < DELTA_MIN_ROUTE_AGE_MS) {
            onEvent?.(`ΔunitOut ${improvPct.toFixed(2)}% < ${DELTA_MIN_IMPROV_PCT}% (age ${ageMs}ms). Waiting.`);
            try { addTradeLog(chatId, { kind: "telemetry", mint, stage: "guardrail", reason: "improv_below_threshold", improvPct, minImprovementPct: DELTA_MIN_IMPROV_PCT, ageMs, minRouteAgeMs: DELTA_MIN_ROUTE_AGE_MS, attempt: attempts }); } catch {}
            prevUnitOutProbe = unitOutProbe;
            return;
          }
        } else if (DELTA_MIN_ROUTE_AGE_MS > 0) {
          const age = Date.now() - routeFirstSeenAt;
          if (age < DELTA_MIN_ROUTE_AGE_MS) {
            onEvent?.(`Route age ${age}ms < ${DELTA_MIN_ROUTE_AGE_MS}ms. Waiting.`);
            try { addTradeLog(chatId, { kind: "telemetry", mint, stage: "guardrail", reason: "route_too_young", ageMs: age, minRouteAgeMs: DELTA_MIN_ROUTE_AGE_MS, attempt: attempts }); } catch {}
            prevUnitOutProbe = unitOutProbe;
            return;
          }
        }

        // Update probe baseline for next iteration
        prevUnitOutProbe = unitOutProbe;

        // Emit a LiquidityDeltaEvent for analytics/orchestration
        try {
          alphaBus?.emit?.("liquidity_delta", {
            chatId,
            mint,
            unitOutProbe,
            prevUnitOutProbe,
            priceImpactPct,
            routeAgeMs: Date.now() - (routeFirstSeenAt || Date.now()),
            threshold: {
              minImprovementPct: DELTA_MIN_IMPROV_PCT,
              maxImpactPct: DELTA_MAX_PRICE_IMPACT_PCT,
              minRouteAgeMs: DELTA_MIN_ROUTE_AGE_MS,
              probeSol: DELTA_PROBE_SOL,
            },
            ts: Date.now(),
          });
          try { addTradeLog(chatId, { kind: "telemetry", mint, stage: "delta_emitted", unitOutProbe, priceImpactPct, attempt: attempts }); } catch {}
        } catch {}
      }

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
        const impactBase = Number(route.priceImpactPct ?? 0);

        // Probe at smaller and larger sizes to infer LP depth/curvature
        const smallAmtSol = Math.max(minSol, amountSol * 0.5);
        const largeAmtSol = Math.min(maxSol, amountSol * 2);
        try {
          const [routeSmall, routeLarge] = await Promise.all([
            getQuoteRaw({
              inputMint: "So11111111111111111111111111111111111111112",
              outputMint: mint,
              amountRaw: Math.round(smallAmtSol * 1e9),
              slippageBps: slippageBps ?? 100,
              timeoutMs: 900,
            }).catch(() => null),
            getQuoteRaw({
              inputMint: "So11111111111111111111111111111111111111112",
              outputMint: mint,
              amountRaw: Math.round(largeAmtSol * 1e9),
              slippageBps: slippageBps ?? 100,
              timeoutMs: 900,
            }).catch(() => null),
          ]);

          const unitBase = Number(route?.outAmount || 0) / Math.max(1, Math.round(amountSol * 1e9));
          const unitSmall = routeSmall ? Number(routeSmall.outAmount || 0) / Math.max(1, Math.round(smallAmtSol * 1e9)) : null;
          const unitLarge = routeLarge ? Number(routeLarge.outAmount || 0) / Math.max(1, Math.round(largeAmtSol * 1e9)) : null;

          // Depth ratio: how much worse per-SOL output gets when scaling size up
          let depthRatio = unitLarge && unitBase ? unitLarge / Math.max(1e-12, unitBase) : null;

          // Decision matrix combining price impact and depth ratio
          if (impactBase >= 7 || (depthRatio !== null && depthRatio < 0.7)) {
            // Very thin/curved: cut size aggressively
            buyAmountSol = Math.max(minSol, amountSol * 0.4);
          } else if (impactBase >= 4 || (depthRatio !== null && depthRatio < 0.85)) {
            buyAmountSol = Math.max(minSol, amountSol * 0.6);
          } else if (impactBase <= 1.0 && (depthRatio === null || depthRatio >= 0.95)) {
            // Deep and flat: scale up within cap
            buyAmountSol = Math.min(maxSol, amountSol * 1.8);
          } else if (impactBase <= 2.0 && (depthRatio === null || depthRatio >= 0.9)) {
            buyAmountSol = Math.min(maxSol, amountSol * 1.4);
          }
        } catch {
          // Fallback to simple impact-only rule if probes fail
          if (impactBase >= 5) buyAmountSol = Math.max(minSol, amountSol * 0.5);
          else if (impactBase <= 1) buyAmountSol = Math.min(maxSol, amountSol * 2);
        }
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

      const swapRes = await performSwap({
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: mint,
        amountSol: buyAmountSol,
        slippageBps: slip,
        priorityFeeLamports: prio,
        useJitoBundle,
        chatId,
      });
      const txid = swapRes?.txid;

      // Wait for confirmation before proceeding
      let confirmedOk = false;
      let failedConf = false;
      try {
        if (txid) {
          const connection = getRpcConnection();
          const maxWait = Number(process.env.TX_CONFIRM_MAX_WAIT_MS || 90000);
          const pollEvery = Number(
            process.env.TX_CONFIRM_POLL_INTERVAL_MS || 2000
          );
          const startT = Date.now();
          while (Date.now() - startT < maxWait) {
            const st = await connection
              .getSignatureStatuses([txid])
              .catch(() => null);
            const s = st?.value?.[0];
            if (s) {
              if (s.err) {
                failedConf = true;
                break;
              }
              const status = s.confirmationStatus;
              if (status === "finalized" || status === "confirmed") {
                confirmedOk = true;
                break;
              }
            }
            await new Promise((r) => setTimeout(r, pollEvery));
          }
        }
      } catch {}

      if (!confirmedOk) {
        // Treat as failed attempt so watcher can retry
        try {
          addTradeLog(chatId, {
            kind: "status",
            statusOf: "buy",
            mint,
            sol: Number(buyAmountSol),
            status: "failed",
            failReason: failedConf ? "tx_err" : "tx_unconfirmed_timeout",
            attempt: attempts,
            txid,
          });
        } catch {}
        onEvent?.(
          `⚠️ Swap tx not confirmed (${failedConf ? "failed" : "timeout"}). Retrying... Tx: ${txid}`
        );
        throw new Error("tx_not_confirmed");
      }

      onEvent?.(`Bought ${mint}. Tx: ${txid}`);

      // Record buy trade log with detailed telemetry
      try {
        addTradeLog(chatId, {
          kind: "buy",
          mint,
          sol: Number(buyAmountSol),
          tokens: Number(swapRes?.output?.tokensOut ?? NaN),
          route: swapRes?.route?.labels,
          priceImpactPct: swapRes?.route?.priceImpactPct ?? null,
          slippageBps: swapRes?.slippageBps,
          priorityFeeLamports: swapRes?.priorityFeeLamports,
          via: swapRes?.via,
          latencyMs: swapRes?.latencyMs,
          txid,
          lastSendRaceWinner: swapRes?.lastSendRaceWinner ?? null,
          lastSendRaceAttempts: swapRes?.lastSendRaceAttempts ?? 0,
          lastSendRaceLatencyMs: swapRes?.lastSendRaceLatencyMs ?? null,
        });
      } catch {}

      // Arm Flash-LP guard immediately after buy
      try {
        const amtTokens = Number(swapRes?.output?.tokensOut ?? 0);
        startFlashLpGuard(chatId, { mint, amountTokens: amtTokens, onEvent });
      } catch {}

      // Mark executed in the store before stopping the watcher
      markSnipeExecuted(chatId, mint, { txid }).catch(() => {});

      stopLiquidityWatch(chatId, mint);
    } catch (e) {
      // adaptive backoff up to 2x base
      intervalMs = Math.min(baseInterval * 2, Math.floor(intervalMs * 1.25));
      // log failure attempt for telemetry
      try {
        const failMsg = (e?.message || String(e)).slice(0, 300);
        addTradeLog(chatId, {
          kind: "status",
          statusOf: "buy",
          mint,
          sol: Number(amountSol),
          status: "failed",
          failReason: failMsg,
          attempt: attempts,
        });
      } catch {}
      // stop after too many attempts to avoid infinite loops
      if (attempts >= maxAttempts) {
        stopped = true;
        stopLiquidityWatch(chatId, mint);
        onEvent?.(`Stopped watcher after ${attempts} attempts.`);
        try {
          cooldowns.set(k, Date.now() + COOLDOWN_MS);
          addTradeLog(chatId, { kind: "telemetry", mint, stage: "cooldown_set", coolOffMs: COOLDOWN_MS, attempts });
        } catch {}
      }
    }
  };

  const interval = setInterval(attempt, intervalMs);
  activeWatchers.set(k, interval);
  onEvent?.(`Watching ${mint} every ${baseInterval}ms ...`);
}

export function stopLiquidityWatch(chatId, mint, reason = "stopped") {
  if (mint) {
    const k = `${chatId}:${mint}`;
    const interval = activeWatchers.get(k);
    if (interval) clearInterval(interval);
    activeWatchers.delete(k);
    // If still active (not executed), mark as cancelled
    markSnipeCancelled(chatId, mint, reason).catch(() => {});
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
