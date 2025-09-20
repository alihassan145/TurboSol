import dotenv from "dotenv";
dotenv.config();

import { validateEnvAndInstallRedaction } from "./services/envValidator.js";

import { startTelegramBot, getBotInstance } from "./services/telegram.js";
import { startDashboardServer } from "./services/dashboard.js";
import { initializeWallet } from "./services/wallet.js";
import { connectWalletsDb, hasUserWallet } from "./services/userWallets.js";
import { getAllUserStates, addTradeLog } from "./services/userState.js";
import { initSnipeStore, loadActiveSnipes } from "./services/snipeStore.js";
import { startLiquidityWatch } from "./services/watchers/liquidityWatcher.js";
import { startRpcHealthLoop, getRpcConnection } from "./services/rpc.js";
import { startPriorityFeeRefresher } from "./services/fees.js";
import { startCopyTradeMonitor } from "./services/watchers/copyTradeMonitor.js";
import AlphaDetection, { alphaBus } from "./services/alphaDetection.js";
// LP lock alerts wiring
import { lpLockEvents } from "./services/risk.js";
import { shortenAddress } from "./services/walletInfo.js";

async function main() {
  // Validate environment early and install log redaction
  validateEnvAndInstallRedaction();

  await connectWalletsDb();
  await initializeWallet();
  await initSnipeStore().catch(() => false);
  await startTelegramBot();
  await startDashboardServer();

  // Start RPC health/latency monitoring loop
  startRpcHealthLoop({
    intervalMs: Number(process.env.RPC_HEALTH_INTERVAL_MS || 3000),
  });

  // Start dynamic priority fee refresher (learned tip model)
  startPriorityFeeRefresher({
    intervalMs: Number(process.env.PRIORITY_FEE_REFRESH_MS || 1500),
  });

  // Start Copy-Trade monitors per user
  try {
    for (const [chatId] of getAllUserStates()) {
      startCopyTradeMonitor(chatId);
    }
  } catch {}

  // Start Alpha Detection layer (emits to alphaBus)
  try {
    const conn = getRpcConnection();
    const alpha = new AlphaDetection(conn);
    await alpha.start();
  } catch (e) {
    console.error("AlphaDetection failed to start:", e?.message || e);
  }

  // Early-snipe Orchestrator: subscribe to alphaBus and kick off watchers per user
  function orchestrateEarlySnipe(signalType, payload) {
    try {
      // Persist signal telemetry once centrally
      for (const [chatId, state] of getAllUserStates()) {
        // Gate by user settings and wallet availability
        const gating = state?.autoSnipeOnPaste === true && true;
        if (!gating) continue;
        addTradeLog(chatId, {
          kind: "telemetry",
          stage: "alpha_signal",
          signalType,
          payload: {
            mint: payload?.mint,
            meta: { source: payload?.type || signalType },
          },
        });
      }
    } catch {}

    const entries = Array.from(getAllUserStates().entries());
    entries.forEach(async ([chatId, state]) => {
      try {
        // User gating: must have wallet and have auto-snipe enabled
        const hasWallet = await hasUserWallet(chatId).catch(() => false);
        if (!state?.autoSnipeOnPaste || !hasWallet) return;

        // For pre-LP style signals, optionally respect per-chat toggle if present
        if (
          signalType === "pre_lp_detected" &&
          state?.preLPWatchEnabled === false
        )
          return;

        const bot = getBotInstance();
        const mint = payload?.mint;
        if (!mint) return;
        const amountSol = Number(state?.defaultSnipeSol ?? 0.05);
        const useJitoBundle = !!state?.enableJitoForSnipes;
        const pollInterval = Number(state?.snipePollInterval ?? 300);
        const slippageBps = Number(state?.snipeSlippage ?? 100);
        const retryCount = Number(state?.snipeRetryCount ?? 3);

        // Announce intent (non-blocking)
        try {
          bot?.sendMessage?.(
            chatId,
            `🎯 Alpha signal (${signalType}) for ${mint}. Starting early snipe watcher...`
          );
        } catch {}

        // Kick off the shared liquidity watcher (has guardrails, cool-off, flash-LP guard)
        startLiquidityWatch(chatId, {
          mint,
          amountSol,
          priorityFeeLamports: undefined,
          useJitoBundle,
          pollInterval,
          slippageBps,
          retryCount,
          dynamicSizing: true,
          source: `alpha:${signalType}`,
          signalType,
          onEvent: (m) => getBotInstance()?.sendMessage?.(chatId, m),
        });

        // Persist orchestrator decision
        try {
          addTradeLog(chatId, {
            kind: "telemetry",
            stage: "orchestrator_start",
            signalType,
            mint,
            params: {
              amountSol,
              pollInterval,
              slippageBps,
              retryCount,
              useJitoBundle,
            },
          });
        } catch {}
      } catch (e) {
        // best-effort; continue other users
      }
    });
  }

  alphaBus.on("pump_launch", (p) => orchestrateEarlySnipe("pump_launch", p));
  alphaBus.on("known_dev_launch", (p) =>
    orchestrateEarlySnipe("known_dev_launch", p)
  );
  alphaBus.on("pre_lp_detected", (p) =>
    orchestrateEarlySnipe("pre_lp_detected", p)
  );
  alphaBus.on("dev_wallet_activity", (p) =>
    orchestrateEarlySnipe("dev_wallet_activity", p)
  );

  // LP unlock alarms -> Telegram broadcast per user setting
  function humanizeDelta(ms) {
    const abs = Math.abs(ms);
    const sign = ms < 0 ? "ago" : "in";
    const minutes = Math.floor(abs / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return `${sign} ${days}d ${hours % 24}h`;
    if (hours > 0) return `${sign} ${hours}h ${minutes % 60}m`;
    return `${sign} ${minutes}m`;
  }

  lpLockEvents.on("lp_unlock_alarm", (evt) => {
    try {
      const { type, mint, provider, unlockAt } = evt || {};
      const bot = getBotInstance();
      if (!bot || !mint) return;
      const whenStr = unlockAt
        ? new Date(unlockAt).toLocaleString()
        : "unknown";
      const rel = unlockAt ? humanizeDelta(unlockAt - Date.now()) : "";
      const short = shortenAddress(String(mint));
      const link = `https://dexscreener.com/solana/${mint}`;
      const header =
        type === "unlock" ? "🔓 LP Unlock" : "⏰ LP Unlock (Pre-Alert)";
      const body = [
        `${header}`,
        `Token: <code>${short}</code>`,
        `Provider: ${provider || "unknown"}`,
        unlockAt ? `When: ${whenStr} (${rel})` : undefined,
        `Link: ${link}`,
      ]
        .filter(Boolean)
        .join("\n");

      for (const [chatId, state] of getAllUserStates()) {
        if (state?.lpUnlockAlerts === false) continue; // respect per-user toggle
        try {
          bot.sendMessage(chatId, body, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
          });
        } catch {}
      }
    } catch (e) {
      console.error("Failed to broadcast LP unlock alarm:", e?.message || e);
    }
  });

  // Resume active snipes from persistence
  try {
    const bot = getBotInstance();
    const jobs = await loadActiveSnipes();
    for (const job of jobs) {
      const { chatId, mint, amountSol, settings = {} } = job;
      startLiquidityWatch(chatId, {
        mint,
        amountSol,
        priorityFeeLamports: settings.priorityFeeLamports,
        useJitoBundle: settings.useJitoBundle,
        pollInterval: settings.pollInterval,
        slippageBps: settings.slippageBps,
        retryCount: settings.retryCount,
        dynamicSizing: settings.dynamicSizing,
        minBuySol: settings.minBuySol,
        maxBuySol: settings.maxBuySol,
        onEvent: (m) => bot?.sendMessage?.(chatId, m),
        source: settings.source,
        signalType: settings.signalType,
      });
      bot?.sendMessage?.(
        chatId,
        `⏯ Resumed active snipe watcher for ${mint} (${amountSol} SOL).`
      );
    }
  } catch (e) {
    console.error("Failed to resume snipes:", e?.message || e);
  }

  // Daily P&L report scheduler
  const REPORT_HOUR = Number(process.env.DAILY_REPORT_HOUR || 23);
  const REPORT_MIN = Number(process.env.DAILY_REPORT_MINUTE || 59);
  let lastReportDateKey = null;

  function dateKey(ts = Date.now()) {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  setInterval(async () => {
    try {
      const now = new Date();
      const dk = dateKey(now.getTime());
      if (
        now.getHours() === REPORT_HOUR &&
        now.getMinutes() === REPORT_MIN &&
        lastReportDateKey !== dk
      ) {
        lastReportDateKey = dk;
        const bot = getBotInstance();
        if (!bot) return;
        const entries = getAllUserStates(); // [ [chatId, state], ... ]
        for (const [chatId, state] of entries) {
          if (!state?.privatePnl) continue; // respect privacy setting
          const trades = (state.trades || []).filter(
            (t) => dateKey(t.timestamp) === dk
          );
          if (!trades.length) continue;
          let buySol = 0,
            sellSol = 0;
          const byMint = new Map();
          for (const t of trades) {
            if (t.kind === "buy") {
              const s = Number(t.sol || 0);
              buySol += s;
              const m = byMint.get(t.mint) || { buy: 0, sell: 0 };
              m.buy += s;
              byMint.set(t.mint, m);
            } else if (t.kind === "sell") {
              const sOut = Number(t.solOut || t.sol || 0);
              sellSol += sOut;
              const m = byMint.get(t.mint) || { buy: 0, sell: 0 };
              m.sell += sOut;
              byMint.set(t.mint, m);
            }
          }
          const pnl = sellSol - buySol;
          let wins = 0,
            losses = 0;
          for (const [, v] of byMint) {
            if (v.sell > 0) {
              if (v.sell > v.buy) wins++;
              else losses++;
            }
          }
          const total = wins + losses;
          const winRate = total ? Math.round((wins / total) * 100) : 0;
          const sign = pnl >= 0 ? "🟢" : "🔴";
          const msg = [
            `📊 Daily Report (${dk})`,
            `Buys: ${buySol.toFixed(4)} SOL`,
            `Sells: ${sellSol.toFixed(4)} SOL`,
            `${sign} P&L: ${pnl.toFixed(4)} SOL`,
            `Win-rate: ${winRate}% (${wins}/${total})`,
          ].join("\n");
          await bot.sendMessage(chatId, msg);
        }
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("Report scheduler error:", e.message || e);
    }
  }, 60 * 1000);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal error:", err);
  process.exit(1);
});
