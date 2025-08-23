import axios from "axios";

// Basic risk checks using external intelligence providers (optional)
// Controlled by env:
// - RISK_CHECKS_ENABLED=true|false
// - REQUIRE_LP_LOCK=true|false
// - MAX_BUY_TAX_BPS=1000 (10%)
// If a provider call fails, this function returns ok=true with a warning (fail-open).
export async function riskCheckToken(mint, { requireLpLock = false, maxBuyTaxBps = 1500, timeoutMs = 1200 } = {}) {
  const enabled = String(process.env.RISK_CHECKS_ENABLED || "").toLowerCase() === "true" || process.env.RISK_CHECKS_ENABLED === "1";
  if (!enabled) {
    return { ok: true, warnings: ["Risk checks disabled"] };
  }
  const warnings = [];

  // Rugcheck API (heuristic parsing; schema may evolve)
  try {
    const url = `https://api.rugcheck.xyz/api/v1/tokens/${mint}`;
    const { data } = await axios.get(url, { timeout: timeoutMs });
    const honeypot = Boolean(data?.is_honeypot || data?.honeypot?.is);
    if (honeypot) {
      return { ok: false, reasons: ["Honeypot detected"] };
    }
    const buyTax = Number(data?.buyTax ?? data?.taxes?.buy ?? 0);
    // Interpret buyTax as percentage if <= 1, else as percent already
    const buyTaxPct = buyTax <= 1 ? buyTax * 100 : buyTax;
    const buyTaxBps = Math.round(buyTaxPct * 100);
    if (!Number.isNaN(buyTaxBps) && buyTaxBps > maxBuyTaxBps) {
      return { ok: false, reasons: [`Buy tax too high: ${buyTaxPct}%`] };
    }
    const lpLocked = Boolean(data?.lp?.locked ?? data?.lpLocked);
    if (requireLpLock && !lpLocked) {
      return { ok: false, reasons: ["LP not locked"] };
    }
  } catch (e) {
    warnings.push(`Rugcheck failed: ${e.message || e}`);
  }

  return { ok: true, warnings };
}