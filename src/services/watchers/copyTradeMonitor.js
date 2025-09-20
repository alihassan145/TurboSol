import { PublicKey } from "@solana/web3.js";
import { getRpcConnection } from "../rpc.js";
import { getAllUserStates, getCopyTradeState, addTradeLog, getDailySpent } from "../userState.js";
import { hasUserWallet } from "../userWallets.js";
import { getBotInstance } from "../telegram.js";
import { notifyTxStatus } from "../telegram.js";
import { performSwap, quickSell, NATIVE_SOL } from "../trading/jupiter.js";
import { riskCheckToken } from "../risk.js";

// Lightweight copy-trade monitor:
// - Polls recent signatures for each followed wallet
// - For each new tx, fetches transaction and attempts to infer token swap direction
// - Emits normalized events and maps to buy/sell using performSwap/quickSell

const monitors = new Map(); // key per user => { interval, lastSigByAddr: Map, inflight: Set }

const DEFAULT_POLL_MS = Number(process.env.COPY_TRADE_POLL_MS || 1200);
const MAX_SIGS_PER_ADDR = 6;

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

async function analyzeSwapDirection(connection, tx) {
  // Minimal inference using pre/post token balances
  try {
    const meta = tx?.meta;
    const pre = meta?.preTokenBalances || [];
    const post = meta?.postTokenBalances || [];
    // Map owner->mint balances delta
    const byMint = new Map();
    for (const b of post) {
      const m = b?.mint;
      if (!m) continue;
      const ui = Number(b?.uiTokenAmount?.uiAmount || 0);
      const preMatch = pre.find(
        (p) => p?.mint === m && p?.owner === b?.owner && p?.accountIndex === b?.accountIndex
      );
      const preUi = Number(preMatch?.uiTokenAmount?.uiAmount || 0);
      const delta = ui - preUi;
      const agg = byMint.get(m) || 0;
      byMint.set(m, agg + delta);
    }
    // Identify largest positive delta mint (acquired) and largest negative delta mint (spent)
    let maxPos = { mint: null, amt: 0 };
    let maxNeg = { mint: null, amt: 0 };
    for (const [m, v] of byMint.entries()) {
      if (v > maxPos.amt) maxPos = { mint: m, amt: v };
      if (v < maxNeg.amt) maxNeg = { mint: m, amt: v };
    }
    if (!maxPos.mint && !maxNeg.mint) return null;
    const acquired = maxPos.amt > 0 ? maxPos : null;
    const spent = maxNeg.amt < 0 ? maxNeg : null;

    // Determine if SOL is leg: check native balance change of payer (account 0)
    const preLam = Number(tx?.meta?.preBalances?.[0] ?? NaN);
    const postLam = Number(tx?.meta?.postBalances?.[0] ?? NaN);
    const solDelta = Number.isFinite(preLam) && Number.isFinite(postLam)
      ? (postLam - preLam) / 1e9
      : 0;

    if (acquired && solDelta < 0) {
      // BUY: spent SOL to acquire acquired.mint
      return { type: "buy", mint: acquired.mint, amountOut: acquired.amt };
    }
    if (spent && solDelta > 0) {
      // SELL: sold spent.mint to get SOL
      return { type: "sell", mint: spent.mint, amountIn: Math.abs(spent.amt) };
    }

    // Fallback: logs heuristic for Jupiter mentions
    const logs = tx?.meta?.logMessages || [];
    for (const l of logs) {
      if (/jupiter|swap/i.test(l) && acquired?.mint) return { type: "buy", mint: acquired.mint };
    }
  } catch {}
  return null;
}

function getAllowlist() {
  const raw = String(process.env.COPY_TRADE_ALLOWLIST || "").trim();
  if (!raw) return null;
  const set = new Set(
    raw
      .split(/[\,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  );
  return set;
}

function getDenylist() {
  const raw = String(process.env.COPY_TRADE_DENYLIST || "").trim();
  if (!raw) return null;
  const set = new Set(
    raw
      .split(/[\,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  );
  return set;
}

function passesLists(mint) {
  const allow = getAllowlist();
  const deny = getDenylist();
  if (deny && deny.has(mint)) return false;
  if (allow && !allow.has(mint)) return false;
  return true;
}

export function decideCopyAction({
  eventType,
  followed = {},
  dailySpent = 0,
  envDefaultDailyCap = Number(process.env.COPY_TRADE_DEFAULT_DAILY_CAP_SOL || 5),
}) {
  if (eventType === "buy") {
    const mode = followed.mode || "fixed";
    let amountSol;
    if (mode === "percent") {
      const pct = clamp(Number(followed.percent || 10), 1, 100);
      const capBase =
        followed.dailyCapSOL != null && Number.isFinite(Number(followed.dailyCapSOL))
          ? Number(followed.dailyCapSOL)
          : envDefaultDailyCap;
      amountSol = (Number(capBase) * pct) / 100;
    } else {
      amountSol = Number.isFinite(Number(followed.amountSOL))
        ? Number(followed.amountSOL)
        : 0.05;
    }
    const perCap = Number.isFinite(Number(followed.perTradeCapSOL))
      ? Number(followed.perTradeCapSOL)
      : 0;
    if (perCap > 0) amountSol = Math.min(amountSol, perCap);

    // Enforce daily cap remaining if configured
    const dailyCap =
      followed.dailyCapSOL != null && Number.isFinite(Number(followed.dailyCapSOL))
        ? Number(followed.dailyCapSOL)
        : null;
    if (dailyCap && dailyCap > 0) {
      const remain = Math.max(0, dailyCap - Number(dailySpent || 0));
      if (remain <= 0) return { execute: false, reason: "daily_cap_exhausted" };
      amountSol = Math.min(amountSol, remain);
    }

    if (!Number.isFinite(amountSol) || amountSol <= 0)
      return { execute: false, reason: "invalid_amount" };
    return { execute: true, kind: "buy", amountSol };
  }

  if (eventType === "sell") {
    const percent = clamp(Number(followed.percent || 100), 1, 100);
    return { execute: true, kind: "sell", percent };
  }

  return { execute: false, reason: "unsupported_event" };
}

async function maybeExecuteCopy({ chatId, followed, event, sourceAddr, sig, inflightSet }) {
  const bot = getBotInstance();
  try {
    const hasWallet = await hasUserWallet(chatId).catch(() => false);
    if (!hasWallet) return;
    const copy = getCopyTradeState(chatId);
    if (!copy?.enabled) return;
    if (!followed?.enabled) return;
    if (event?.type === "buy" && followed.copyBuy === false) return;
    if (event?.type === "sell" && followed.copySell === false) return;

    const mint = event?.mint;
    if (!mint) return;

    if (!passesLists(mint)) return;

    // Risk filter
    const riskOk = await riskCheckToken(mint).catch(() => ({ ok: true }));
    if (riskOk && riskOk.ok === false) {
      addTradeLog(chatId, { kind: "copy_trade_skip", reason: "risk_check_fail", mint, sourceAddr, sig });
      return;
    }

    // Concurrency guard per chat
    const maxConc = Number.isFinite(Number(followed.maxConcurrent)) ? Number(followed.maxConcurrent) : null;
    if (maxConc && inflightSet && inflightSet.size >= maxConc) {
      return; // throttle
    }

    // Decision helper for sizing
    const spent = Number(getDailySpent(chatId));
    const decision = decideCopyAction({ eventType: event.type, followed, dailySpent: spent });
    if (!decision.execute) return;

    const slippageBps = Number.isFinite(Number(followed.slippageBps))
      ? Number(followed.slippageBps)
      : undefined;

    // Execute with idempotency
    const execKey = `${chatId}:${mint}`;
    if (inflightSet.has(execKey)) return;
    inflightSet.add(execKey);
    try {
      if (decision.kind === "buy") {
        const amountSol = decision.amountSol;
        const res = await performSwap({
          inputMint: NATIVE_SOL,
          outputMint: mint,
          amountSol,
          chatId,
          priorityFeeLamports: undefined,
          useJitoBundle: undefined,
          slippageBps,
        });
        const txid = res?.txid || null;
        bot?.sendMessage?.(
          chatId,
          `🤖 Copied BUY from ${sourceAddr}\n• Token: ${mint}\n• Amount: ${amountSol} SOL\n• Route: ${res?.route?.labels}\n• Impact: ${typeof res?.route?.priceImpactPct === "number" ? (res.route.priceImpactPct*100).toFixed(2)+"%" : "?"}\n• Slippage: ${res?.slippageBps} bps\n• Via: ${res?.via}\n• Latency: ${res?.latencyMs} ms\n• Tx: ${txid}`
        );
        addTradeLog(chatId, {
          kind: "copy_buy",
          mint,
          amountSol,
          route: res?.route?.labels,
          priceImpactPct: res?.route?.priceImpactPct ?? null,
          slippageBps: res?.slippageBps,
          via: res?.via,
          latencyMs: res?.latencyMs,
          txid,
          sourceAddr,
          sig,
        });
        notifyTxStatus(chatId, txid, { kind: "Copy Buy" }).catch(() => {});
      } else if (decision.kind === "sell") {
        const percent = decision.percent;
        const res = await quickSell({ tokenMint: mint, percent, chatId, slippageBps });
        const txid = res?.txid || (Array.isArray(res?.txids) ? res.txids[0] : null);
        bot?.sendMessage?.(
          chatId,
          `🤖 Copied SELL from ${sourceAddr}\n• Token: ${mint}\n• Percent: ${percent}%\n• Est. SOL Out: ${typeof res?.output?.tokensOut === "number" ? res.output.tokensOut.toFixed(6) : "?"}\n• Route: ${res?.route?.labels}\n• Price impact: ${typeof res?.route?.priceImpactPct === "number" ? (res.route.priceImpactPct*100).toFixed(2)+"%" : "?"}\n• Slippage: ${res?.slippageBps} bps\n• Via: ${res?.via}\n• Latency: ${res?.latencyMs} ms\n• Tx: ${txid}`
        );
        addTradeLog(chatId, {
          kind: "copy_sell",
          mint,
          percent,
          sol: Number(res?.output?.tokensOut ?? NaN),
          route: res?.route?.labels,
          priceImpactPct: res?.route?.priceImpactPct ?? null,
          slippageBps: res?.slippageBps,
          priorityFeeLamports: res?.priorityFeeLamports,
          via: res?.via,
          latencyMs: res?.latencyMs,
          txid,
          sourceAddr,
          sig,
        });
        notifyTxStatus(chatId, txid, { kind: "Copy Sell" }).catch(() => {});
      }
    } finally {
      inflightSet.delete(execKey);
    }
  } catch (e) {
    try {
      addTradeLog(chatId, { kind: "copy_trade_error", error: e?.message || String(e), sourceAddr, sig });
    } catch {}
    try {
      getBotInstance()?.sendMessage?.(chatId, `❌ Copy Trade error: ${e?.message || e}`);
    } catch {}
  }
}

export function startCopyTradeMonitor(chatId, { pollMs = DEFAULT_POLL_MS } = {}) {
  const connection = getRpcConnection();
  const copy = getCopyTradeState(chatId);
  if (!copy) return;
  if (!monitors.has(chatId)) {
    monitors.set(chatId, { interval: null, lastSigByAddr: new Map(), inflight: new Set() });
  }
  const mon = monitors.get(chatId);
  if (mon.interval) return; // already running

  mon.interval = setInterval(async () => {
    try {
      const state = getAllUserStates().get(chatId);
      if (!state) return;
      const ct = state.copyTrade || { enabled: false, followedWallets: [] };
      if (!ct.enabled) return;
      const wallets = Array.isArray(ct.followedWallets) ? ct.followedWallets : [];
      for (const w of wallets) {
        try {
          if (!w?.address || w.enabled === false) continue;
          const addr = new PublicKey(w.address);
          const sigs = await connection.getSignaturesForAddress(addr, { limit: MAX_SIGS_PER_ADDR });
          const last = mon.lastSigByAddr.get(w.address);
          for (const s of sigs) {
            if (s.signature === last) break;
            const tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null);
            if (!tx) continue;
            const event = await analyzeSwapDirection(connection, tx);
            if (event && (event.type === "buy" || event.type === "sell")) {
              await maybeExecuteCopy({ chatId, followed: w, event, sourceAddr: w.address, sig: s.signature, inflightSet: mon.inflight });
            }
          }
          if (sigs[0]) mon.lastSigByAddr.set(w.address, sigs[0].signature);
        } catch {}
      }
    } catch {}
  }, pollMs);
}

export function stopCopyTradeMonitor(chatId) {
  const mon = monitors.get(chatId);
  if (mon?.interval) clearInterval(mon.interval);
  monitors.delete(chatId);
}