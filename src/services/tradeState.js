// Lightweight per-trade state tracking with optional persistence via tradeStore
import { appendTrade } from "./tradeStore.js";

const trades = new Map();

export function initTrade({
  tradeKey,
  chatId,
  wallet,
  mint,
  side, // 'buy' | 'sell'
  amountSol,
  tokens,
  slippageBps,
  priorityFeeLamports,
  via,
  createdAt = Date.now(),
}) {
  const entry = {
    tradeKey,
    status: "pending",
    chatId: chatId != null ? String(chatId) : null,
    wallet,
    mint,
    side,
    amountSol: Number(amountSol ?? 0),
    tokens: Number(tokens ?? 0),
    slippageBps: slippageBps ?? null,
    priorityFeeLamports: priorityFeeLamports ?? null,
    via: via ?? null,
    createdAt,
    updatedAt: createdAt,
    txid: null,
    confirmations: 0,
    error: null,
  };
  trades.set(tradeKey, entry);
  try {
    if (chatId != null)
      appendTrade(String(chatId), {
        kind: side,
        mint,
        sol: side === "buy" ? Number(amountSol ?? 0) : undefined,
        tokens: side === "sell" ? Number(tokens ?? 0) : undefined,
        slippageBps,
        priorityFeeLamports,
        via,
        txid: null,
        tradeKey,
        timestamp: createdAt,
        status: "pending",
      });
  } catch {}
  return entry;
}

export function updateTradeStatus(tradeKey, status, info = {}) {
  const t = trades.get(tradeKey);
  if (!t) return null;
  const updated = {
    ...t,
    status,
    updatedAt: Date.now(),
    txid: info.txid ?? t.txid ?? null,
    confirmations: info.confirmations ?? t.confirmations ?? 0,
    error: info.error ?? null,
  };
  trades.set(tradeKey, updated);
  try {
    if (updated.chatId != null)
      appendTrade(String(updated.chatId), {
        kind: updated.side,
        mint: updated.mint,
        sol: updated.side === "buy" ? Number(updated.amountSol ?? 0) : undefined,
        tokens:
          updated.side === "sell" ? Number(updated.tokens ?? 0) : undefined,
        slippageBps: updated.slippageBps,
        priorityFeeLamports: updated.priorityFeeLamports,
        via: updated.via,
        txid: updated.txid,
        tradeKey,
        timestamp: updated.updatedAt,
        status,
        error: updated.error || undefined,
      });
  } catch {}
  return updated;
}

export function getTrade(tradeKey) {
  return trades.get(tradeKey) || null;
}

export function getAllTrades() {
  return Array.from(trades.values());
}