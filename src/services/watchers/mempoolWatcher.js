import { getUserConnectionInstance } from "../wallet.js";
import { getUserState } from "../userState.js";
import { hasUserWallet } from "../userWallets.js";
import { startLiquidityWatch } from "./liquidityWatcher.js";

const subs = new Map();

export async function startMempoolWatch(chatId, { programIds = [], onEvent, onSnipeEvent, autoSnipeOnLPEvents = true } = {}) {
  const conn = await getUserConnectionInstance(chatId);
  for (const pid of programIds) {
    const subId = await conn.onLogs(pid, async (logs, ctx) => {
      try { 
        onEvent?.({ programId: pid, logs }); 

        // Auto-snipe integration: check for mint creation or LP events
        if (autoSnipeOnLPEvents && await shouldTriggerAutoSnipe(chatId)) {
          const mint = extractMintFromLogs(logs);
          if (mint && await isLPEvent(logs)) {
            await triggerAutoSnipe(chatId, mint, 'mempool', onSnipeEvent);
          }
        }
      } catch {}
    }, "confirmed");
    subs.set(`${chatId}:${pid}`, { conn, subId });
  }
}

async function shouldTriggerAutoSnipe(chatId) {
  const state = getUserState(chatId);
  // Only auto-snipe if user has autoSnipeOnPaste enabled and has a wallet
  return state.autoSnipeOnPaste && (await hasUserWallet(chatId));
}

function extractMintFromLogs(logs) {
  const logText = logs?.logs?.join("\n") || "";
  // Look for mint addresses in various patterns
  const mintMatch = logText.match(/mint\s*:\s*([A-Za-z0-9]{32,44})/i) ||
                   logText.match(/token.*([A-Za-z0-9]{32,44})/i) ||
                   logText.match(/([A-Za-z0-9]{32,44}).*mint/i);
  return mintMatch ? mintMatch[1] : null;
}

async function isLPEvent(logs) {
  const logText = logs?.logs?.join("\n") || "";
  // Heuristics to detect LP creation or funding events
  return /liquidity|pool|lp|raydium|orca|serum/i.test(logText) ||
         /initialize.*pool|create.*pool|add.*liquidity/i.test(logText);
}

async function triggerAutoSnipe(chatId, mint, source, onSnipeEvent) {
  const state = getUserState(chatId);
  const defaultSnipe = state.defaultSnipeSol ?? 0.05;
  const priorityFeeLamports = state.maxSnipeGasPrice;
  const useJitoBundle = state.enableJitoForSnipes;
  const pollInterval = state.snipePollInterval;
  const slippageBps = state.snipeSlippage;
  const retryCount = state.snipeRetryCount;

  startLiquidityWatch(chatId, {
    mint,
    amountSol: defaultSnipe,
    priorityFeeLamports,
    useJitoBundle,
    pollInterval,
    slippageBps,
    retryCount,
    onEvent: (m) => {
      try { onSnipeEvent?.(mint, m); } catch {}
    }
  });
}

export function stopMempoolWatch(chatId) {
  const keys = [...subs.keys()].filter(k => k.startsWith(`${chatId}:`));
  for (const k of keys) {
    const { conn, subId } = subs.get(k) || {};
    if (conn && subId != null) { try { conn.removeOnLogsListener(subId); } catch {} }
    subs.delete(k);
  }
}