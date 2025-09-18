import axios from "axios";

const PUMP_API = "https://frontend-api.pump.fun";

async function main() {
  try {
    const response = await axios.get(`${PUMP_API}/coins/recent`, {
      timeout: 10000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json, text/plain, */*",
        Referer: "https://pump.fun/",
        Origin: "https://pump.fun",
      },
    });

    console.log("✅ Request succeeded with status:", response.status);
    // Log the first few entries only to keep output short
    const coins = response.data || [];
    console.log(
      `Received ${coins.length} coins. Showing first 3 (if available):`,
      coins.slice(0, 3)
    );
  } catch (error) {
    const status = error?.response?.status;
    if (status) {
      console.error("❌ HTTP error", status, error.response.statusText);
    } else {
      console.error("❌ Request failed:", error.message);
    }
  }
}

main();