import { getUserConnectionInstance } from "../wallet.js";
import { PublicKey } from "@solana/web3.js";
import { getUserState, addTradeLog } from "../userState.js";
import { hasUserWallet } from "../userWallets.js";
import { startLiquidityWatch } from "./liquidityWatcher.js";

const monitors = new Map();

export async function addDevWalletToMonitor(chatId, addressBase58) {
  const k = `${chatId}:set`;
  if (!monitors.has(k))
    monitors.set(k, {
      addrs: new Set(),
      last: new Map(),
      interval: null,
      listeners: new Set(),
    });
  monitors.get(k).addrs.add(addressBase58);
}

export async function startDevWalletMonitor(
  chatId,
  { intervalMs = 400, onTx, autoSnipeOnTokenProgram = true } = {}
) {
  const k = `${chatId}:set`;
  const entry = monitors.get(k) || {
    addrs: new Set(),
    last: new Map(),
    interval: null,
    listeners: new Set(),
  };
  monitors.set(k, entry);
  const conn = await getUserConnectionInstance(chatId);
  // Always register provided listener
  if (!entry.listeners) entry.listeners = new Set();
  if (onTx) entry.listeners.add(onTx);
  // If interval already running, don't start another
  if (entry.interval) return;
  entry.interval = setInterval(async () => {
    for (const addr of entry.addrs) {
      try {
        const sigs = await conn.getSignaturesForAddress(new PublicKey(addr), {
          limit: 5,
        });
        const lastSeen = entry.last.get(addr);
        for (const s of sigs) {
          if (s.signature === lastSeen) break;
          // Dispatch to all listeners
          if (entry.listeners && entry.listeners.size) {
            for (const listener of entry.listeners) {
              try {
                listener(addr, s);
              } catch {}
            }
          } else {
            // Backwards compat: invoke single provided listener if present via param (already added above)
          }

          // Auto-snipe integration: detect potential token creations/funding
          if (
            autoSnipeOnTokenProgram &&
            (await shouldTriggerAutoSnipe(chatId, s))
          ) {
            const mint = await extractMintFromTx(conn, s);
            if (mint) {
              await triggerAutoSnipe(chatId, mint, "dev-wallet");
            }
          }
        }
        if (sigs[0]) entry.last.set(addr, sigs[0].signature);
      } catch {}
    }
  }, intervalMs);
}

async function shouldTriggerAutoSnipe(chatId, sigInfo) {
  const state = getUserState(chatId);
  // Only auto-snipe if user has autoSnipeOnPaste enabled and has a wallet
  return state.autoSnipeOnPaste && (await hasUserWallet(chatId));
}

async function extractMintFromTx(connection, sigInfo) {
  try {
    const tx = await connection.getTransaction(sigInfo.signature, {
      maxSupportedTransactionVersion: 0,
    });
    const meta = tx?.meta;
    const logs = meta?.logMessages || [];
    // Simple heuristic: look for mint creation patterns in logs
    for (const log of logs) {
      const mintMatch = log.match(/mint\s*:\s*([A-Za-z0-9]{32,44})/i);
      if (mintMatch) return mintMatch[1];
      const createMatch = log.match(
        /Program\s+TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA\s.*Initialize.*Mint.*account.*([A-Za-z0-9]{32,44})/
      );
      if (createMatch) return createMatch[1];
    }
  } catch {}
  return null;
}

async function triggerAutoSnipe(chatId, mint, source) {
  const state = getUserState(chatId);
  const defaultSnipe = state.defaultSnipeSol ?? 0.05;
  const priorityFeeLamports = state.maxSnipeGasPrice;
  const useJitoBundle = state.enableJitoForSnipes;
  const pollInterval = state.snipePollInterval;
  const slippageBps = state.snipeSlippage;
  const retryCount = state.snipeRetryCount;

  try {
    addTradeLog(chatId, {
      kind: "telemetry",
      stage: "auto_snipe_trigger",
      source: `watch:${source}`,
      signalType: "dev_wallet_activity",
      mint,
      params: {
        amountSol: defaultSnipe,
        pollInterval,
        slippageBps,
        retryCount,
        useJitoBundle,
      },
    });
  } catch {}

  startLiquidityWatch(chatId, {
    mint,
    amountSol: defaultSnipe,
    priorityFeeLamports,
    useJitoBundle,
    pollInterval,
    slippageBps,
    retryCount,
    source: `watch:${source}`,
    signalType: "dev_wallet_activity",
    onEvent: (m) => {
      // Event handler will be provided by caller
    },
  });
}

export function stopDevWalletMonitor(chatId) {
  const k = `${chatId}:set`;
  const entry = monitors.get(k);
  if (entry?.interval) clearInterval(entry.interval);
  monitors.delete(k);
}
