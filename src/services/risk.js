import axios from "axios";
import { PublicKey } from "@solana/web3.js";
import { getConnection } from "./wallet.js";

// In-memory cache for risk check results to reduce provider load and latency
const riskCache = new Map();
const DEFAULT_RISK_CACHE_MS = Number(process.env.RISK_CACHE_MS || 600_000); // 10 min

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

  // Concurrently query providers (best effort)
  const tasks = {
    rugcheck: queryRugcheck(mint, timeoutMs).catch((e) => ({ error: e })),
    honey: queryHoneypotIs(mint, timeoutMs).catch((e) => ({ error: e })),
    dex: queryDexScreener(mint, timeoutMs).catch((e) => ({ error: e })),
    onchain: queryOnchainMint(mint, timeoutMs).catch((e) => ({ error: e })),
  };

  const [rug, honey, dex, onchain] = await Promise.all([
    tasks.rugcheck,
    tasks.honey,
    tasks.dex,
    tasks.onchain,
  ]);

  // Provider errors -> warnings
  if (rug?.error) warnings.push(`Rugcheck failed: ${rug.error.message || rug.error}`);
  if (honey?.error) warnings.push(`Honeypot.is failed: ${honey.error.message || honey.error}`);
  if (dex?.error) warnings.push(`Dexscreener failed: ${dex.error.message || dex.error}`);
  if (onchain?.error) warnings.push(`On-chain check failed: ${onchain.error.message || onchain.error}`);

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

  // LP lock: if required and any provider says not locked -> block
  const lpLockedRug = rug?.lpLocked;
  const lpLockedHoney = honey?.lpLocked;
  if (requireLpLock) {
    if (lpLockedRug === false || lpLockedHoney === false) {
      ok = false;
      reasons.push("LP not locked");
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

  const result = ok ? { ok: true, warnings } : { ok: false, reasons, warnings };
  riskCache.set(mint, { ts: Date.now(), result });
  return result;
}