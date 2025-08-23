import { getUserConnectionInstance } from "../wallet.js";

// Lightweight Pump.fun listener via log subscriptions.
// Configure env PUMPFUN_PROGRAM_IDS as comma-separated program IDs.
const subs = new Map();

export async function startPumpFunListener(chatId, { onMint, logHandler } = {}) {
  const ids = (process.env.PUMPFUN_PROGRAM_IDS || "").split(",").map(s=>s.trim()).filter(Boolean);
  if (ids.length === 0) return;
  const conn = await getUserConnectionInstance(chatId);
  for (const pid of ids) {
    const subId = await conn.onLogs(pid, (logs, ctx) => {
      try {
        // Heuristic: detect create/init events and emit as alpha; upstream can decide to snipe
        logHandler?.(logs);
        const txt = logs?.logs?.join("\n") || "";
        const m = txt.match(/mint\s*:\s*([A-Za-z0-9]{32,44})/i);
        if (m && onMint) onMint(m[1], { programId: pid, slot: logs.slot });
      } catch {}
    }, "confirmed");
    subs.set(`${chatId}:${pid}`, { conn, subId });
  }
}

export function stopPumpFunListener(chatId) {
  const keys = [...subs.keys()].filter(k => k.startsWith(`${chatId}:`));
  for (const k of keys) {
    const { conn, subId } = subs.get(k) || {};
    if (conn && subId != null) {
      try { conn.removeOnLogsListener(subId); } catch {}
    }
    subs.delete(k);
  }
}