import { updateTradeStatus, getTrade } from "./tradeState.js";

// Poll signature statuses until confirmation or timeout
export async function monitorSignatures({
  connection,
  signatures = [],
  tradeKey,
  chatId,
  kind, // 'Buy' | 'Sell'
  timeoutMs = Number(process.env.TX_CONFIRM_TIMEOUT_MS || 15000),
  pollMs = 750,
  onConfirmed,
  onFailed,
}) {
  if (!connection || !Array.isArray(signatures) || signatures.length === 0)
    return;
  const deadline = Date.now() + timeoutMs;
  let lastStatuses = null;
  while (Date.now() < deadline) {
    try {
      const res = await connection.getSignatureStatuses(signatures, {
        searchTransactionHistory: true,
      });
      lastStatuses = res?.value || [];
      const anyConfirmed = lastStatuses.find((s) => s?.confirmationStatus);
      if (anyConfirmed) {
        const txid = signatures[0];
        updateTradeStatus(tradeKey, "confirmed", {
          txid,
          confirmations: 1,
        });
        try {
          const trade = getTrade(tradeKey);
          if (typeof onConfirmed === "function") onConfirmed({ txid, trade });
        } catch {}
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, pollMs));
  }
  // Timeout
  const txid = signatures[0];
  updateTradeStatus(tradeKey, "failed", {
    txid,
    confirmations: 0,
    error: "confirmation_timeout",
  });
  try {
    if (typeof onFailed === "function") onFailed({ txid });
  } catch {}
}
