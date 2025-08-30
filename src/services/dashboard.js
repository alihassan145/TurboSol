import express from "express";
import cors from "cors";
import { readTrades } from "./tradeStore.js";
import { getAllUserStates } from "./userState.js";

export async function startDashboardServer() {
  const enabled =
    String(process.env.DASHBOARD_ENABLED || "true").toLowerCase() !== "false";
  if (!enabled) {
    console.log("[dashboard] Disabled via env DASHBOARD_ENABLED");
    return null;
  }
  const app = express();
  app.use(cors());

  const PORT = Number(process.env.DASHBOARD_PORT || 8080);

  // Health check
  app.get("/health", (req, res) => {
    res.json({ ok: true });
  });

  // Get recent trades for a user
  app.get("/user/:chatId/trades", (req, res) => {
    const { chatId } = req.params;
    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    const trades = readTrades(chatId, limit);
    res.json({ chatId, trades });
  });

  // Summary P&L for a user (today)
  app.get("/user/:chatId/summary", (req, res) => {
    const { chatId } = req.params;
    const trades = readTrades(chatId, 5000); // larger window
    const dateKey = (ts) => {
      const d = new Date(ts);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
        2,
        "0"
      )}-${String(d.getDate()).padStart(2, "0")}`;
    };
    const today = dateKey(Date.now());
    let buySol = 0,
      sellSol = 0,
      wins = 0,
      losses = 0;
    const byMint = new Map();
    for (const t of trades) {
      if (dateKey(t.timestamp) !== today) continue;
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
    for (const [, v] of byMint) {
      if (v.sell > 0) {
        if (v.sell > v.buy) wins++;
        else losses++;
      }
    }
    const total = wins + losses;
    const pnl = sellSol - buySol;
    const winRate = total ? Math.round((wins / total) * 100) : 0;
    res.json({ chatId, buySol, sellSol, pnl, wins, losses, winRate });
  });

  // List all active users
  app.get("/users", (req, res) => {
    const entries = getAllUserStates().map(([id, state]) => ({
      chatId: id,
      trades: state.trades?.length || 0,
    }));
    res.json(entries);
  });

  return new Promise((resolve) => {
    app.listen(PORT, () => {
      console.log(`[dashboard] Listening on port ${PORT}`);
      resolve(app);
    });
  });
}
