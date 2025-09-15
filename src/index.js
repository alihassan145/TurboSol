import dotenv from "dotenv";
dotenv.config();

import { startTelegramBot, getBotInstance } from "./services/telegram.js";
import { startDashboardServer } from "./services/dashboard.js";
import { initializeWallet } from "./services/wallet.js";
import { connectWalletsDb } from "./services/userWallets.js";
import { getAllUserStates } from "./services/userState.js";
import { initSnipeStore, loadActiveSnipes } from "./services/snipeStore.js";
import { startLiquidityWatch } from "./services/watchers/liquidityWatcher.js";
import { startRpcHealthLoop } from "./services/rpc.js";

async function main() {
  await connectWalletsDb();
  await initializeWallet();
  await initSnipeStore().catch(() => false);
  await startTelegramBot();
  await startDashboardServer();

  // Start RPC health/latency monitoring loop
  startRpcHealthLoop({ intervalMs: Number(process.env.RPC_HEALTH_INTERVAL_MS || 3000) });

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
