import { EventEmitter } from "events";
import WebSocket from "ws";

// PumpPortal WebSocket listener for Pump.fun token creation events
// Emits: "new_launch" with launchData { mint, name, symbol, creator, marketCap, createdAt, description, twitter, telegram, website, image }
class PumpPortalListener extends EventEmitter {
  constructor({ apiKey, url } = {}) {
    super();
    this.apiKey = apiKey || process.env.PUMPPORTAL_API_KEY || "";
    this.baseUrl = url || "wss://pumpportal.fun/api/data";
    this.isRunning = false;
    this.ws = null;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.backoffMs = 0;
  }

  buildUrl() {
    if (this.apiKey) {
      const sep = this.baseUrl.includes("?") ? "&" : "?";
      return `${this.baseUrl}${sep}api-key=${encodeURIComponent(this.apiKey)}`;
    }
    return this.baseUrl;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.connect();
  }

  stop() {
    this.isRunning = false;
    try { clearInterval(this.pingTimer); } catch {}
    try { clearTimeout(this.reconnectTimer); } catch {}
    this.pingTimer = null;
    this.reconnectTimer = null;
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }

  connect() {
    const URL = this.buildUrl();
    const ws = new WebSocket(URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; TurboSol/1.0)",
        Origin: "https://pumpportal.fun",
      },
    });
    this.ws = ws;

    ws.on("open", () => {
      this.backoffMs = 0; // reset backoff on successful connect
      // Keep-alive pings every 25s
      try { clearInterval(this.pingTimer); } catch {}
      this.pingTimer = setInterval(() => {
        try { ws.ping(); } catch {}
      }, 25000);

      // Subscribe to new token creation events
      try {
        ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      } catch {}
      // Optional: more subscriptions can be added here if needed
    });

    ws.on("message", (data) => {
      try {
        const text = data?.toString?.() ?? String(data);
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          // non-JSON or plain text messages can be ignored
          return;
        }
        // Ignore simple acknowledgements
        if (typeof msg?.message === "string") return;

        // PumpPortal new token payload example includes fields like: mint, name, symbol, traderPublicKey, marketCapSol, txType
        const mint = msg?.mint;
        const txType = msg?.txType;
        if (txType === "create" && mint) {
          const launchData = {
            mint,
            name: msg?.name || "",
            symbol: msg?.symbol || "",
            creator: msg?.traderPublicKey || "",
            marketCap: typeof msg?.marketCapSol === "number" ? msg.marketCapSol : 0, // in SOL
            createdAt: Date.now(),
            description: "",
            twitter: "",
            telegram: "",
            website: "",
            image: "",
          };
          this.emit("new_launch", launchData);
        }
      } catch (e) {
        // swallow per-message errors
      }
    });

    ws.on("close", () => {
      try { clearInterval(this.pingTimer); } catch {}
      this.pingTimer = null;
      if (!this.isRunning) return;
      // Reconnect with backoff
      const base = this.backoffMs || 1000;
      this.backoffMs = Math.min(base * 2, 30000); // cap at 30s
      const jitter = Math.floor(Math.random() * 1000);
      const delay = this.backoffMs + jitter;
      this.reconnectTimer = setTimeout(() => {
        if (this.isRunning) this.connect();
      }, delay);
    });

    ws.on("error", () => {
      // Let 'close' handle reconnection
    });

    ws.on("pong", () => {
      // heartbeat ok
    });
  }
}

export default PumpPortalListener;