import express from "express";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getRpcStatus } from "./rpc.js";
import http from "http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json());

// Health endpoint for the app
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: Date.now() });
});

// Expose enriched RPC status with latency percentiles and rotation metadata
app.get("/rpc/status", (req, res) => {
  try {
    const status = getRpcStatus();
    res.status(200).json(status);
  } catch (e) {
    res.status(500).json({ error: e?.message || "failed to get rpc status" });
  }
});

// Serve user trades
app.get("/trades", (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const filePath = path.join(__dirname, "../../data/trades", `${userId}.jsonl`);
  if (!fs.existsSync(filePath))
    return res.status(404).json({ error: "not found" });
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  res.json(lines);
});

// Summary endpoint
app.get("/summary", (req, res) => {
  // Placeholder for PnL summary computation
  res.json({ message: "Summary not implemented yet" });
});

// Active users endpoint
app.get("/active-users", (req, res) => {
  // Placeholder for active users logic
  res.json({ users: [] });
});

export function startDashboardServer(port) {
  // Prefer explicit arg, then env vars, then default
  let desired = Number(
    port ?? process.env.DASHBOARD_PORT ?? process.env.PORT ?? 3000
  );

  return new Promise((resolve) => {
    const server = http.createServer(app);

    const tryListen = (p) => {
      server.removeAllListeners("error");
      server.on("error", (e) => {
        if (e && e.code === "EADDRINUSE") {
          const next = p + 1;
          console.warn(`Port ${p} in use, attempting ${next}...`);
          // Retry same server on next port
          setTimeout(() => tryListen(next), 50);
        } else {
          throw e;
        }
      });

      server.listen(p, () => {
        console.log(`Dashboard server running on port ${p}`);
        resolve(server);
      });
    };

    tryListen(desired);
  });
}

export default app;
