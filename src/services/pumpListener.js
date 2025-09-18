import axios from "axios";
import { EventEmitter } from "events";

const PUMP_API = "https://frontend-api.pump.fun";

class PumpListener extends EventEmitter {
  constructor() {
    super();
    this.isRunning = false;
    this.lastCheck = 0;
    this.seenMints = new Set();
    // Backoff control for rate limiting
    this.backoffMs = 0;
    this.backoffUntil = 0;
    this.consecutiveErrors = 0;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastCheck = Date.now();

    console.log("🚀 Pump.fun listener started");
    this.poll();
  }

  stop() {
    this.isRunning = false;
    console.log("🚀 Pump.fun listener stopped");
  }

  async poll() {
    while (this.isRunning) {
      try {
        // Respect backoff window after failures
        if (this.backoffUntil && Date.now() < this.backoffUntil) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }

        // Add random delay to avoid synchronized requests
        const randomDelay = Math.floor(Math.random() * 500);
        await new Promise((resolve) => setTimeout(resolve, randomDelay));

        const response = await axios.get(`${PUMP_API}/coins/recent`, {
          timeout: 10000, // Increased timeout to 10s
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept: "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate, br",
            Referer: "https://pump.fun/",
            Origin: "https://pump.fun",
            Connection: "keep-alive",
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-site",
          },
        });

        // Reset backoff on success
        this.backoffMs = 0;
        this.backoffUntil = 0;
        this.consecutiveErrors = 0;

        const coins = response.data || [];
        const newLaunches = coins.filter((coin) => {
          const created = new Date(coin.created_timestamp).getTime();
          return created > this.lastCheck && !this.seenMints.has(coin.mint);
        });

        for (const coin of newLaunches) {
          this.seenMints.add(coin.mint);

          const launchData = {
            mint: coin.mint,
            name: coin.name,
            symbol: coin.symbol,
            creator: coin.creator,
            marketCap: coin.usd_market_cap || 0,
            createdAt: coin.created_timestamp,
            description: coin.description || "",
            twitter: coin.twitter || "",
            telegram: coin.telegram || "",
            website: coin.website || "",
            image: coin.image_uri || "",
          };

          console.log(`🎯 New Pump.fun launch: ${coin.symbol} (${coin.name})`);
          this.emit("new_launch", launchData);
        }

        this.lastCheck = Date.now();
      } catch (error) {
        const status = error?.response?.status;
        console.error("❌ Pump listener error:", error.message);

        this.consecutiveErrors++;

        // Apply exponential backoff for rate limiting and server errors
        if (
          status === 530 ||
          status === 403 ||
          status === 429 ||
          status === 502 ||
          status === 503 ||
          status === 504 ||
          (typeof status === "number" && status >= 500)
        ) {
          // More aggressive backoff for 530 errors
          const baseBackoff = status === 530 ? 5000 : 2000;
          this.backoffMs = Math.min(
            this.backoffMs ? this.backoffMs * 2 : baseBackoff,
            300000
          ); // Max 5 minutes
          const jitter = Math.floor(Math.random() * 2000);
          this.backoffUntil = Date.now() + this.backoffMs + jitter;
          console.warn(
            `⚠️ Backing off Pump.fun polling for ${Math.floor(
              (this.backoffMs + jitter) / 1000
            )}s due to status ${status}`
          );
        } else if (this.consecutiveErrors >= 5) {
          // Generic backoff for other errors after multiple failures
          this.backoffMs = Math.min(10000 * this.consecutiveErrors, 120000);
          this.backoffUntil = Date.now() + this.backoffMs;
          console.warn(
            `⚠️ Multiple errors detected, backing off for ${Math.floor(
              this.backoffMs / 1000
            )}s`
          );
        }
      }

      // Base polling interval - slower to reduce API pressure
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
  }

  async getCoinDetails(mint) {
    try {
      const response = await axios.get(`${PUMP_API}/coins/${mint}`, {
        timeout: 8000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; TurboSol/1.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "application/json, text/plain, */*",
          Referer: "https://pump.fun/",
          Origin: "https://pump.fun",
        },
      });
      return response.data;
    } catch (error) {
      console.error("❌ Failed to get coin details:", error.message);
      return null;
    }
  }

  async getTrendingCoins() {
    try {
      const response = await axios.get(`${PUMP_API}/coins/trending`, {
        timeout: 8000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; TurboSol/1.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "application/json, text/plain, */*",
          Referer: "https://pump.fun/",
          Origin: "https://pump.fun",
        },
      });
      return response.data || [];
    } catch (error) {
      console.error("❌ Failed to get trending coins:", error.message);
      return [];
    }
  }
}

export default PumpListener;
