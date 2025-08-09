import dotenv from "dotenv";
dotenv.config();

import { startTelegramBot } from "./services/telegram.js";
import { initializeWallet } from "./services/wallet.js";

async function main() {
  await initializeWallet();
  await startTelegramBot();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal error:", err);
  process.exit(1);
});
