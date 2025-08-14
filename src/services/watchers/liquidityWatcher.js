import axios from "axios";
import { performSwap } from "../trading/jupiter.js";

const activeWatchers = new Map();

function key(chatId, mint) {
  return `${chatId}:${mint}`;
}

async function hasLiquidity(mint) {
  // Heuristic: check if quotes exist with small SOL amount
  try {
    const url = `${
      process.env.JUPITER_BASE_URL || "https://quote-api.jup.ag"
    }/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${mint}&amount=${1e7}`; // 0.01 SOL
    const { data } = await axios.get(url, { timeout: 8000 });
    const route = data?.data?.[0];
    return Boolean(route);
  } catch {
    return false;
  }
}

export function startLiquidityWatch(
  chatId,
  { mint, amountSol, onEvent, priorityFeeLamports, useJitoBundle }
) {
  const k = key(chatId, mint);
  if (activeWatchers.has(k)) return;
  const interval = setInterval(async () => {
    try {
      const ok = await hasLiquidity(mint);
      if (ok) {
        onEvent?.(`Liquidity detected for ${mint}. Buying ${amountSol} SOL...`);
        try {
          const { txid } = await performSwap({
            inputMint: "So11111111111111111111111111111111111111112",
            outputMint: mint,
            amountSol,
            priorityFeeLamports,
            useJitoBundle,
            chatId,
          });
          onEvent?.(`Buy sent. Tx: ${txid}`);
        } catch (e) {
          onEvent?.(`Buy failed: ${e.message || e}`);
        }
        clearInterval(interval);
        activeWatchers.delete(k);
      }
    } catch (e) {
      onEvent?.(`Watcher error: ${e.message || e}`);
    }
  }, 4000);
  activeWatchers.set(k, interval);
}

export function stopLiquidityWatch(chatId) {
  [...activeWatchers.entries()].forEach(([k, interval]) => {
    if (k.startsWith(`${chatId}:`)) {
      clearInterval(interval);
      activeWatchers.delete(k);
    }
  });
}
