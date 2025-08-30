import axios from "axios";

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
    lpLocked: Boolean(data?.liquidity?.locked),
  };
}

// ------------------------------
// Public API
// ------------------------------
// Controlled by env:
// - RISK_CHECKS_ENABLED=true|false
// - REQUIRE_LP_LOCK=true|false
// - MAX_BUY_TAX_BPS=1000 (10%)
// - RISK_CACHE_MS=600000 (optional cache TTL)
export async function riskCheckToken(
  mint,
  {
    requireLpLock = false,
    maxBuyTaxBps = 1500,
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

  // Primary provider: Rugcheck
  try {
    const { honeypot, buyTax, lpLocked } = await queryRugcheck(mint, timeoutMs);
    if (honeypot) ok = false, reasons.push("Honeypot detected");

    const buyTaxPct = buyTax <= 1 ? buyTax * 100 : buyTax;
    const buyTaxBps = Math.round(buyTaxPct * 100);
    if (!Number.isNaN(buyTaxBps) && buyTaxBps > maxBuyTaxBps) {
      ok = false;
      reasons.push(`Buy tax too high: ${buyTaxPct}%`);
    }
    if (requireLpLock && !lpLocked) {
      ok = false;
      reasons.push("LP not locked");
    }
  } catch (e) {
    warnings.push(`Rugcheck failed: ${e.message || e}`);
  }

  // Secondary provider only if still unclear / passed first check
  if (ok) {
    try {
      const { honeypot, buyTax, lpLocked } = await queryHoneypotIs(
        mint,
        timeoutMs
      );
      if (honeypot) ok = false, reasons.push("Honeypot detected (honeypot.is)");

      const buyTaxPct = buyTax <= 1 ? buyTax * 100 : buyTax;
      const buyTaxBps = Math.round(buyTaxPct * 100);
      if (!Number.isNaN(buyTaxBps) && buyTaxBps > maxBuyTaxBps) {
        ok = false;
        reasons.push(`Buy tax too high: ${buyTaxPct}% (honeypot.is)`);
      }
      if (requireLpLock && !lpLocked) {
        ok = false;
        reasons.push("LP not locked (honeypot.is)");
      }
    } catch (e) {
      warnings.push(`Honeypot.is failed: ${e.message || e}`);
    }
  }

  const result = ok ? { ok: true, warnings } : { ok: false, reasons, warnings };
  riskCache.set(mint, { ts: Date.now(), result });
  return result;
}