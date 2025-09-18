import WebSocket from "ws";

// Optional: export PUMPPORTAL_API_KEY in your env if you have one
const API_KEY = process.env.PUMPPORTAL_API_KEY;
const URL = `wss://pumpportal.fun/api/data${API_KEY ? `?api-key=${encodeURIComponent(API_KEY)}` : ""}`;

const OPEN_TIMEOUT_MS = 10000; // fail fast if cannot connect

// Allow configurable listen duration via --duration=SECONDS or LISTEN_SECONDS env
const argDuration = (() => {
  const arg = process.argv.find((a) => a.startsWith("--duration="));
  if (!arg) return undefined;
  const n = Number(arg.split("=")[1]);
  return Number.isFinite(n) ? n : undefined;
})();
const LISTEN_SECONDS = argDuration ?? (process.env.LISTEN_SECONDS ? Number(process.env.LISTEN_SECONDS) : 300);
const LISTEN_TIMEOUT_MS = Number.isFinite(LISTEN_SECONDS) && LISTEN_SECONDS > 0 ? LISTEN_SECONDS * 1000 : 0; // 0 = no timeout

const PING_INTERVAL_MS = 25000; // keep-alive pings

function logEvent(tag, payload) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${tag}:`, payload);
}

async function main() {
  const ws = new WebSocket(URL, {
    headers: {
      // Make it look like a normal client; not strictly required
      "User-Agent": "Mozilla/5.0 (compatible; TurboSol/1.0)",
      "Origin": "https://pumpportal.fun",
    },
  });

  let opened = false;
  let gotEvent = false;
  let pingTimer;

  const openTimer = setTimeout(() => {
    if (!opened) {
      console.error("❌ WS open timeout");
      try { ws.terminate(); } catch {}
      process.exit(1);
    }
  }, OPEN_TIMEOUT_MS);

  const listenTimer = LISTEN_TIMEOUT_MS > 0 ? setTimeout(() => {
    if (!gotEvent) {
      console.warn("⚠️ No events received within listen window. Closing.");
    }
    try { ws.close(); } catch {}
  }, LISTEN_TIMEOUT_MS) : null;

  ws.on("open", () => {
    opened = true;
    clearTimeout(openTimer);
    logEvent("WS_OPEN", { url: URL.replace(/api-key=[^&]+/, "api-key=***"), duration_s: LISTEN_SECONDS || "infinite" });

    // Start keep-alive pings
    pingTimer = setInterval(() => {
      try { ws.ping(); } catch {}
    }, PING_INTERVAL_MS);

    // Subscribe to new token events
    const subNewToken = { method: "subscribeNewToken" };
    ws.send(JSON.stringify(subNewToken));

    // You can also try migrations or token trade streams if desired
    // ws.send(JSON.stringify({ method: "subscribeMigration" }));
    // ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: ["<mint>"] }));
  });

  ws.on("pong", () => {
    // Optional: uncomment for verbose heartbeat logging
    // logEvent("WS_PONG", null);
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      gotEvent = true;
      // Print compact summary if it looks like a new token event
      if (msg?.type === "newToken" || msg?.method === "newToken") {
        const info = {
          mint: msg?.mint || msg?.data?.mint,
          name: msg?.name || msg?.data?.name,
          symbol: msg?.symbol || msg?.data?.symbol,
          creator: msg?.creator || msg?.data?.creator,
        };
        logEvent("NEW_TOKEN", info);
      } else {
        logEvent("MESSAGE", msg);
      }
      // Note: Do not auto-close after first message; keep listening until timeout or manual stop
    } catch (e) {
      logEvent("MESSAGE_RAW", data.toString().slice(0, 300));
    }
  });

  ws.on("error", (err) => {
    console.error("❌ WS_ERROR:", err?.message || err);
  });

  ws.on("close", (code, reason) => {
    if (listenTimer) clearTimeout(listenTimer);
    if (pingTimer) clearInterval(pingTimer);
    logEvent("WS_CLOSE", { code, reason: reason?.toString?.() });
    process.exit(gotEvent ? 0 : 2);
  });
}

main().catch((e) => {
  console.error("❌ Fatal:", e?.message || e);
  process.exit(1);
});