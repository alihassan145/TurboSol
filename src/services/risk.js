import axios from "axios";
import { PublicKey } from "@solana/web3.js";
import { getConnection } from "./wallet.js";
import { EventEmitter } from "events";

// In-memory cache for risk check results to reduce provider load and latency
const riskCache = new Map();
const DEFAULT_RISK_CACHE_MS = Number(process.env.RISK_CACHE_MS || 600_000); // 10 min

// LP unlock alarm bus and timers
export const lpLockEvents = new EventEmitter();
const lpUnlockTimers = new Map(); // key => timeoutId

function truthyEnv(name, defaultBool = true) {
  const v = process.env[name];
  if (v == null) return !!defaultBool;
  const s = String(v).toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function scheduleLongTimeout(ms, cb) {
  // Node's max setTimeout delay ~2,147,483,647ms (~24.8 days)
  const MAX = 2_147_483_647;
  if (ms <= 0) {
    return setTimeout(cb, 0);
  }
  if (ms <= MAX) {
    return setTimeout(cb, ms);
  }
  const id = setTimeout(() => {
    scheduleLongTimeout(ms - MAX, cb);
  }, MAX);
  return id;
}

function keyForAlarm(mint, provider, unlockAt, kind) {
  return `${mint}|${provider}|${unlockAt}|${kind}`;
}

function scheduleUnlockAlarms({ mint, provider, unlockAt, preAlertHours = Number(process.env.LP_UNLOCK_PREALERT_HOURS || 6) }) {
  if (!unlockAt || Number.isNaN(unlockAt)) return;
  const now = Date.now();
  const preAt = unlockAt - preAlertHours * 3600_000;

  // Pre-alert
  if (preAt > now) {
    const k = keyForAlarm(mint, provider, unlockAt, "pre");
    if (!lpUnlockTimers.has(k)) {
      const tid = scheduleLongTimeout(preAt - now, () => {
        lpLockEvents.emit("lp_unlock_alarm", {
          type: "pre_alert",
          mint,
          provider,
          unlockAt,
          when: Date.now(),
        });
        lpUnlockTimers.delete(k);
      });
      lpUnlockTimers.set(k, tid);
      console.log(`⏰ Scheduled LP pre-alert (${provider}) for ${mint} at ${new Date(preAt).toISOString()}`);
    }
  }

  // Exact unlock alert
  if (unlockAt > now) {
    const k2 = keyForAlarm(mint, provider, unlockAt, "unlock");
    if (!lpUnlockTimers.has(k2)) {
      const tid2 = scheduleLongTimeout(unlockAt - now, () => {
        lpLockEvents.emit("lp_unlock_alarm", {
          type: "unlock",
          mint,
          provider,
          unlockAt,
          when: Date.now(),
        });
        lpUnlockTimers.delete(k2);
      });
      lpUnlockTimers.set(k2, tid2);
      console.log(`🔓 Scheduled LP unlock alarm (${provider}) for ${mint} at ${new Date(unlockAt).toISOString()}`);
    }
  }
}

// ------------------------------
// Provider helpers
// ------------------------------
async function queryRugcheck(mint, timeoutMs) {
  const url = `https://api.rugcheck.xyz/api/v1/tokens/${mint}`;
  const { data } = await axios.get(url, { timeout: timeoutMs });
  return {
    honeypot: Boolean(data?.is_honeypot || data?.honeypot?.is),
    buyTax: Number(data?.buyTax ?? data?.taxes?.buy ?? 0),
    sellTax: Number(data?.sellTax ?? data?.taxes?.sell ?? 0),
    lpLocked: Boolean(data?.lp?.locked ?? data?.lpLocked),
  };
}

// Secondary fallback — schema may differ, wrap in try/catch by caller
async function queryHoneypotIs(mint, timeoutMs) {
  const url = `https://honeypot.is/api/v2/chain/solana/address/${mint}`;
  const { data } = await axios.get(url, { timeout: timeoutMs });
  return {
    honeypot: Boolean(data?.honeypotResult?.isHoneypot),
    buyTax: Number(data?.taxes?.buy ?? 0),
    sellTax: Number(data?.taxes?.sell ?? 0),
    lpLocked: Boolean(data?.liquidity?.locked),
  };
}

// Liquidity info via Dexscreener (best-effort)
async function queryDexScreener(mint, timeoutMs) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
  const { data } = await axios.get(url, { timeout: timeoutMs });
  const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
  let maxLiqUsd = 0;
  for (const p of pairs) {
    const liq = Number(p?.liquidity?.usd || 0);
    if (!Number.isNaN(liq)) maxLiqUsd = Math.max(maxLiqUsd, liq);
  }
  return { liquidityUsd: maxLiqUsd, pairCount: pairs.length };
}

// Generic helpers to parse locker responses
function coerceTsMs(val) {
  if (val == null) return undefined;
  if (typeof val === "number") {
    // assume seconds if < 10^12
    return val > 4_000_000_000 ? val : val * 1000;
  }
  if (typeof val === "string") {
    const n = Number(val);
    if (!Number.isNaN(n)) return coerceTsMs(n);
    const t = Date.parse(val);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

function findEarliestUnlockFromObject(obj) {
  let earliest;
  const stack = [obj];
  let cap = 0;
  while (stack.length && cap < 5000) {
    cap++;
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      for (const it of cur) stack.push(it);
      continue;
    }
    if (cur && typeof cur === "object") {
      for (const [k, v] of Object.entries(cur)) {
        const key = k.toLowerCase();
        if (key.includes("unlock")) {
          const ts = coerceTsMs(v);
          if (ts && (!earliest || ts < earliest)) earliest = ts;
        }
        if (v && typeof v === "object") stack.push(v);
      }
    }
  }
  return earliest;
}

function inferLockedFromObject(obj) {
  let result;
  const stack = [obj];
  let cap = 0;
  while (stack.length && cap < 5000) {
    cap++;
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      for (const it of cur) stack.push(it);
      continue;
    }
    if (cur && typeof cur === "object") {
      for (const [k, v] of Object.entries(cur)) {
        const key = k.toLowerCase();
        if (key.includes("locked") || key.includes("islocked") || key.includes("lp_locked")) {
          if (typeof v === "boolean") return v;
          if (typeof v === "number") result = Boolean(v);
          if (typeof v === "string") result = v.toLowerCase() === "true" || v === "1";
        }
        if (v && typeof v === "object") stack.push(v);
      }
    }
  }
  return result;
}

async function queryLockerGeneric(name, baseEnv, keyEnv, mint, timeoutMs, path = "/locks") {
  const base = process.env[baseEnv];
  if (!base) return null;
  const key = process.env[keyEnv];
  const url = `${base.replace(/\/$/, "")}${path}?token=${mint}&chain=solana`;
  const headers = key ? { "x-api-key": key } : undefined;
  const { data } = await axios.get(url, { timeout: timeoutMs, headers });
  const unlockAt = findEarliestUnlockFromObject(data);
  const locked = inferLockedFromObject(data);
  return { locker: name, lpLocked: locked, unlockAt };
}

async function queryUnicrypt(mint, timeoutMs) {
  return queryLockerGeneric("unicrypt", "UNICRYPT_API_BASE", "UNICRYPT_API_KEY", mint, timeoutMs);
}
async function queryPinkLock(mint, timeoutMs) {
  return queryLockerGeneric("pinklock", "PINKLOCK_API_BASE", "PINKLOCK_API_KEY", mint, timeoutMs);
}
async function queryTeamFinance(mint, timeoutMs) {
  return queryLockerGeneric("teamfinance", "TEAMFINANCE_API_BASE", "TEAMFINANCE_API_KEY", mint, timeoutMs);
}
async function queryUncx(mint, timeoutMs) {
  return queryLockerGeneric("uncx", "UNCX_API_BASE", "UNCX_API_KEY", mint, timeoutMs);
}

// On-chain mint authority checks: renounced mint/freeze?
async function queryOnchainMint(mint, timeoutMs = 1200) {
  const conn = getConnection();
  const pk = new PublicKey(mint);
  const p = conn.getParsedAccountInfo(pk).then((resp) => {
    const info = resp?.value?.data?.parsed?.info || {};
    const hasMintAuthority = info?.mintAuthorityOption === 1 && !!info?.mintAuthority;
    const hasFreezeAuthority = info?.freezeAuthorityOption === 1 && !!info?.freezeAuthority;
    return {
      hasMintAuthority,
      hasFreezeAuthority,
    };
  });
  // Timeout wrapper
  let to;
  const timeout = new Promise((_, rej) => {
    to = setTimeout(() => rej(new Error("onchain_timeout")), timeoutMs);
  });
  try {
    const res = await Promise.race([p, timeout]);
    return res;
  } finally {
    clearTimeout(to);
  }
}

// ------------------------------
// Public API
// ------------------------------
// Controlled by env:
// - RISK_CHECKS_ENABLED=true|false
// - REQUIRE_LP_LOCK=true|false
// - REQUIRE_RENOUNCED=true|false (both mint & freeze authority null)
// - MIN_LIQ_USD=1000 (minimum liquidity threshold)
// - MAX_BUY_TAX_BPS=1000 (10%)
// - MAX_SELL_TAX_BPS=2000 (20%)
// - RISK_CACHE_MS=600000 (optional cache TTL)
export async function riskCheckToken(
  mint,
  {
    requireLpLock = false,
    requireRenounced = false,
    minLiquidityUsd = Number(process.env.MIN_LIQ_USD || 0),
    maxBuyTaxBps = Number(process.env.MAX_BUY_TAX_BPS || 1500),
    maxSellTaxBps = Number(process.env.MAX_SELL_TAX_BPS || 2500),
    timeoutMs = 1200,
    cacheMs = DEFAULT_RISK_CACHE_MS,
  } = {}
) {
  const enabled =
    String(process.env.RISK_CHECKS_ENABLED || "").toLowerCase() === "true" ||
    process.env.RISK_CHECKS_ENABLED === "1";
  if (!enabled) {
    return { ok: true, warnings: ["Risk checks disabled"] };
  }

  // Return cached result if still fresh
  const cached = riskCache.get(mint);
  if (cached && Date.now() - cached.ts < cacheMs) {
    return {
      ...cached.result,
      warnings: [...(cached.result.warnings || []), "(cached)"],
    };
  }

  const warnings = [];
  let ok = true;
  const reasons = [];

  const lpAlarmsEnabled = truthyEnv("LP_UNLOCK_ALARMS_ENABLED", true);
  const preAlertHours = Number(process.env.LP_UNLOCK_PREALERT_HOURS || 6);

  // Concurrently query providers (best effort)
  const tasks = {
    rugcheck: queryRugcheck(mint, timeoutMs).catch((e) => ({ error: e })),
    honey: queryHoneypotIs(mint, timeoutMs).catch((e) => ({ error: e })),
    dex: queryDexScreener(mint, timeoutMs).catch((e) => ({ error: e })),
    onchain: queryOnchainMint(mint, timeoutMs).catch((e) => ({ error: e })),
  };

  // Optional locker providers (only queried if configured)
  const lockerPromises = [];
  if (process.env.UNICRYPT_API_BASE) lockerPromises.push(queryUnicrypt(mint, timeoutMs).catch((e) => ({ error: e, locker: "unicrypt" })));
  if (process.env.PINKLOCK_API_BASE) lockerPromises.push(queryPinkLock(mint, timeoutMs).catch((e) => ({ error: e, locker: "pinklock" })));
  if (process.env.TEAMFINANCE_API_BASE) lockerPromises.push(queryTeamFinance(mint, timeoutMs).catch((e) => ({ error: e, locker: "teamfinance" })));
  if (process.env.UNCX_API_BASE) lockerPromises.push(queryUncx(mint, timeoutMs).catch((e) => ({ error: e, locker: "uncx" })));

  const [rug, honey, dex, onchain, lockerResults] = await Promise.all([
    tasks.rugcheck,
    tasks.honey,
    tasks.dex,
    tasks.onchain,
    Promise.all(lockerPromises),
  ]);

  // Provider errors -> warnings
  if (rug?.error) warnings.push(`Rugcheck failed: ${rug.error.message || rug.error}`);
  if (honey?.error) warnings.push(`Honeypot.is failed: ${honey.error.message || honey.error}`);
  if (dex?.error) warnings.push(`Dexscreener failed: ${dex.error.message || dex.error}`);
  if (onchain?.error) warnings.push(`On-chain check failed: ${onchain.error.message || onchain.error}`);
  for (const lr of lockerResults || []) {
    if (lr?.error) warnings.push(`${lr.locker || "locker"} failed: ${lr.error.message || lr.error}`);
  }

  // Honeypot decision: any provider true blocks
  const isHoney = Boolean(rug?.honeypot) || Boolean(honey?.honeypot);
  if (isHoney) {
    ok = false;
    reasons.push("Honeypot detected");
  }

  // Taxes: take worst case across providers
  const buyTaxPct = Math.max(
    0,
    ...[rug?.buyTax, honey?.buyTax].map((x) => (x == null ? 0 : x <= 1 ? x * 100 : x))
  );
  const sellTaxPct = Math.max(
    0,
    ...[rug?.sellTax, honey?.sellTax].map((x) => (x == null ? 0 : x <= 1 ? x * 100 : x))
  );
  const buyTaxBps = Math.round(buyTaxPct * 100);
  const sellTaxBps = Math.round(sellTaxPct * 100);
  if (!Number.isNaN(buyTaxBps) && buyTaxBps > maxBuyTaxBps) {
    ok = false;
    reasons.push(`Buy tax too high: ${buyTaxPct}%`);
  }
  if (!Number.isNaN(sellTaxBps) && sellTaxBps > maxSellTaxBps) {
    ok = false;
    reasons.push(`Sell tax too high: ${sellTaxPct}%`);
  }

  // LP lock aggregation across providers
  const lpLockedRug = rug?.lpLocked;
  const lpLockedHoney = honey?.lpLocked;
  const lockerFlags = (lockerResults || []).map((l) => l?.lpLocked).filter((v) => v !== undefined);
  const anyUnlocked = [lpLockedRug, lpLockedHoney, ...lockerFlags].some((v) => v === false);
  const anyLocked = [lpLockedRug, lpLockedHoney, ...lockerFlags].some((v) => v === true);

  if (requireLpLock) {
    if (anyUnlocked) {
      ok = false;
      reasons.push("LP not locked");
    } else if (!anyLocked) {
      // Strengthened: if lock required but no provider can verify a lock, block
      ok = false;
      reasons.push("LP lock not verified");
    }
  }

  // Liquidity threshold via Dexscreener
  const liquidityUsd = Number(dex?.liquidityUsd || 0);
  if (minLiquidityUsd > 0 && (Number.isNaN(liquidityUsd) || liquidityUsd < minLiquidityUsd)) {
    ok = false;
    reasons.push(`Liquidity below threshold: $${liquidityUsd.toFixed(0)} < $${minLiquidityUsd}`);
  }

  // On-chain renounced checks
  const hasMintAuthority = Boolean(onchain?.hasMintAuthority);
  const hasFreezeAuthority = Boolean(onchain?.hasFreezeAuthority);
  const envRequireRenounced = String(process.env.REQUIRE_RENOUNCED || "").toLowerCase() === "true" || process.env.REQUIRE_RENOUNCED === "1";
  const needRenounced = requireRenounced || envRequireRenounced;
  if (needRenounced && (hasMintAuthority || hasFreezeAuthority)) {
    ok = false;
    const parts = [];
    if (hasMintAuthority) parts.push("mintAuthority present");
    if (hasFreezeAuthority) parts.push("freezeAuthority present");
    reasons.push(`Renounce required: ${parts.join(", ")}`);
  }

  // Locker unlock schedules -> schedule alarms and attach warnings
  const lpLockProviders = [];
  for (const l of lockerResults || []) {
    if (!l || l.error) continue;
    lpLockProviders.push({ locker: l.locker, lpLocked: l.lpLocked, unlockAt: l.unlockAt });
    if (l.unlockAt && l.unlockAt > Date.now()) {
      warnings.push(`LP unlock scheduled via ${l.locker} at ${new Date(l.unlockAt).toISOString()}`);
      if (lpAlarmsEnabled) {
        scheduleUnlockAlarms({ mint, provider: l.locker, unlockAt: l.unlockAt, preAlertHours });
      }
    }
  }

  const details = { lpLock: { anyLocked, anyUnlocked, providers: lpLockProviders } };

  const result = ok ? { ok: true, warnings, details } : { ok: false, reasons, warnings, details };
  riskCache.set(mint, { ts: Date.now(), result });
  return result;
}