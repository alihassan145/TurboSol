/*
  Environment validation and log redaction (fail-fast, protect secrets)
  Zero-dependency validator inspired by envalid.
*/

const BOOL_TRUE = new Set(["1", "true", "yes", "on"]);

function asBool(v, def = false) {
  if (v == null) return def;
  return BOOL_TRUE.has(String(v).toLowerCase());
}

function isHex64(str = "") {
  return /^[0-9a-fA-F]{64}$/.test(str.trim());
}

function isMongoUri(uri = "") {
  return /^mongodb(\+srv)?:\/\//.test(uri);
}

function asNumberInRange(
  name,
  v,
  { min = -Infinity, max = Infinity, def = undefined, errors }
) {
  if (v == null || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    errors.push(`${name} must be a number in [${min}, ${max}]`);
    return def;
  }
  return n;
}

function redactMongoAuth(str) {
  try {
    return str.replace(
      /(mongodb(?:\+srv)?:\/\/)([^@\n]+)@/gi,
      (m, p1) => `${p1}***@`
    );
  } catch {
    return str;
  }
}

function redactApiKeysInUrl(str) {
  try {
    // redact query params like api_key=, key=, token=
    return str.replace(/([?&](?:api_key|key|token)\s*=)\s*[^&#\s]+/gi, "$1***");
  } catch {
    return str;
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRedactor(sensitiveMap) {
  const values = Object.values(sensitiveMap).filter(Boolean).map(String);
  const patterns = [redactMongoAuth, redactApiKeysInUrl];
  const replacers = values.map((v) => ({
    re: new RegExp(escapeRegExp(v), "g"),
    replacement: "***REDACTED***",
  }));

  function redact(input) {
    try {
      let out = String(input);
      for (const fn of patterns) out = fn(out);
      for (const { re, replacement } of replacers)
        out = out.replace(re, replacement);
      return out;
    } catch {
      return input;
    }
  }

  function patchConsoleMethod(methodName) {
    const orig = console[methodName].bind(console);
    console[methodName] = (...args) => {
      try {
        const safe = args.map((a) => {
          if (typeof a === "string") return redact(a);
          try {
            return JSON.parse(redact(JSON.stringify(a)));
          } catch {
            return a;
          }
        });
        orig(...safe);
      } catch {
        orig(...args);
      }
    };
  }

  function install() {
    ["log", "info", "warn", "error"].forEach(patchConsoleMethod);
  }

  return { redact, install };
}

export function validateEnvAndInstallRedaction(options = {}) {
  const strictInProd = options.strictInProd !== false;
  const isProd =
    String(process.env.NODE_ENV || "").toLowerCase() === "production";
  const strict = strictInProd
    ? isProd || asBool(process.env.ENV_VALIDATION_STRICT)
    : false;

  const errors = [];

  // Required secrets and core endpoints
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!TELEGRAM_BOT_TOKEN) errors.push("TELEGRAM_BOT_TOKEN is required");

  const RPC_HTTP_ENDPOINTS = process.env.RPC_HTTP_ENDPOINTS;
  const SOLANA_RPC_URLS = process.env.SOLANA_RPC_URLS;
  const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL;
  if (!RPC_HTTP_ENDPOINTS && !SOLANA_RPC_URLS && !SOLANA_RPC_URL) {
    errors.push(
      "At least one of RPC_HTTP_ENDPOINTS, SOLANA_RPC_URLS, or SOLANA_RPC_URL must be set"
    );
  }

  const MONGODB_URI = process.env.MONGODB_URI;
  if (!MONGODB_URI) errors.push("MONGODB_URI is required");
  else if (!isMongoUri(MONGODB_URI))
    errors.push("MONGODB_URI must start with mongodb:// or mongodb+srv://");

  const WALLET_ENCRYPTION_KEY = process.env.WALLET_ENCRYPTION_KEY;
  if (strict && !WALLET_ENCRYPTION_KEY)
    errors.push("WALLET_ENCRYPTION_KEY is required in production");
  if (WALLET_ENCRYPTION_KEY && !isHex64(WALLET_ENCRYPTION_KEY)) {
    errors.push("WALLET_ENCRYPTION_KEY must be 64 hex chars (32 bytes)");
  }

  const ENABLE_PRIVATE_RELAY = asBool(process.env.ENABLE_PRIVATE_RELAY);
  if (ENABLE_PRIVATE_RELAY) {
    if (!process.env.PRIVATE_RELAY_ENDPOINT)
      errors.push(
        "PRIVATE_RELAY_ENDPOINT is required when ENABLE_PRIVATE_RELAY=true"
      );
    if (!process.env.PRIVATE_RELAY_API_KEY)
      errors.push(
        "PRIVATE_RELAY_API_KEY is required when ENABLE_PRIVATE_RELAY=true"
      );
  }

  // Optional relay preference
  if (
    process.env.PRIVATE_RELAY_PREFER != null &&
    process.env.PRIVATE_RELAY_PREFER !== ""
  ) {
    const v = String(process.env.PRIVATE_RELAY_PREFER).toLowerCase();
    const allowed = new Set(["jito", "bloxroute", "generic"]);
    if (!allowed.has(v))
      errors.push(
        "PRIVATE_RELAY_PREFER must be one of: jito, bloxroute, generic"
      );
  }

  // Optional: explicit relay vendor selection
  if (
    process.env.PRIVATE_RELAY_VENDOR != null &&
    process.env.PRIVATE_RELAY_VENDOR !== ""
  ) {
    const v = String(process.env.PRIVATE_RELAY_VENDOR).toLowerCase();
    const allowed = new Set([
      "auto",
      "jito",
      "bloxroute",
      "flashbots",
      "generic",
    ]);
    if (!allowed.has(v))
      errors.push(
        "PRIVATE_RELAY_VENDOR must be one of: auto, jito, bloxroute, flashbots, generic"
      );
  }

  // Numeric ranges (fail soft: report but continue unless strict)
  asNumberInRange("DEFAULT_SLIPPAGE_BPS", process.env.DEFAULT_SLIPPAGE_BPS, {
    min: 1,
    max: 5000,
    errors,
  });
  asNumberInRange(
    "QUICK_SELL_SLIPPAGE_BPS",
    process.env.QUICK_SELL_SLIPPAGE_BPS,
    { min: 1, max: 5000, errors }
  );

  // Timeouts
  asNumberInRange("QUOTE_TIMEOUT_MS", process.env.QUOTE_TIMEOUT_MS, {
    min: 100,
    max: 60000,
    errors,
  });
  asNumberInRange("SWAP_BUILD_TIMEOUT_MS", process.env.SWAP_BUILD_TIMEOUT_MS, {
    min: 100,
    max: 60000,
    errors,
  });
  asNumberInRange(
    "TOKEN_ACCOUNTS_TIMEOUT_MS",
    process.env.TOKEN_ACCOUNTS_TIMEOUT_MS,
    { min: 100, max: 60000, errors }
  );
  // Add read timeout validation for RPC
  asNumberInRange("RPC_READ_TIMEOUT_MS", process.env.RPC_READ_TIMEOUT_MS, {
    min: 500,
    max: 30000,
    errors,
  });

  asNumberInRange("RPC_READ_MICRO_BATCH", process.env.RPC_READ_MICRO_BATCH, {
    min: 1,
    max: 5,
    errors,
  });

  asNumberInRange(
    "RPC_HEALTH_INTERVAL_MS",
    process.env.RPC_HEALTH_INTERVAL_MS,
    { min: 100, max: 60000, errors }
  );
  asNumberInRange(
    "PRIORITY_FEE_REFRESH_MS",
    process.env.PRIORITY_FEE_REFRESH_MS,
    { min: 100, max: 60000, errors }
  );

  // Priority fee caps and tip model params
  [
    "PRIORITY_FEE_CAP_T1_MS",
    "PRIORITY_FEE_CAP_T2_MS",
    "PRIORITY_FEE_CAP_T3_MS",
    "PRIORITY_FEE_CAP_LOW",
    "PRIORITY_FEE_CAP_MID",
    "PRIORITY_FEE_CAP_HIGH",
    "PRIORITY_FEE_CAP_MAX",
    "PRIORITY_FEE_TARGET_PCT",
    "TIP_FEEDBACK_WINDOW",
    "TIP_TARGET_LATENCY_MS",
    "TIP_HEADROOM",
  ].forEach((k) => {
    asNumberInRange(k, process.env[k], { min: 0, max: 1e9, errors });
  });

  // RPC racing
  [
    "RPC_SEND_TIMEOUT_MS",
    "RPC_STAGGER_STEP_MS",
    "RPC_INTER_WAVE_DELAY_MS",
  ].forEach((k) => {
    asNumberInRange(k, process.env[k], { min: 1, max: 60000, errors });
  });

  // Compute budget jitter
  [
    "COMPUTE_UNIT_PRICE_JITTER_PCT",
    "COMPUTE_UNIT_LIMIT_JITTER_PCT",
    "COMPUTE_UNIT_LIMIT_BASE",
  ].forEach((k) => {
    asNumberInRange(k, process.env[k], { min: 0, max: 1e9, errors });
  });

  // Jito (optional)
  [
    "JITO_SLOTS_AHEAD",
    "JITO_RETRIES",
    "JITO_RETRY_DELAY_MS",
    "JITO_MAX_WAIT_MS",
  ].forEach((k) => {
    asNumberInRange(k, process.env[k], { min: 0, max: 1e9, errors });
  });

  // Adaptive slippage toggle (boolean-ish)
  if (process.env.ADAPTIVE_SLIPPAGE_ENABLED != null) {
    const v = String(process.env.ADAPTIVE_SLIPPAGE_ENABLED).toLowerCase();
    const ok = ["1", "true", "yes", "on", "0", "false", "no", "off", ""];
    if (!ok.includes(v))
      errors.push(
        "ADAPTIVE_SLIPPAGE_ENABLED must be one of: 1,true,yes,on,0,false,no,off"
      );
  }

  // Liquidity delta & Pre-LP knobs (optional)
  asNumberInRange(
    "DELTA_MAX_PRICE_IMPACT_PCT",
    process.env.DELTA_MAX_PRICE_IMPACT_PCT,
    { min: 0, max: 100, errors }
  );
  asNumberInRange("LIQ_DELTA_PROBE_SOL", process.env.LIQ_DELTA_PROBE_SOL, {
    min: 0.001,
    max: 1000,
    errors,
  });
  asNumberInRange(
    "LIQ_DELTA_MIN_IMPROV_PCT",
    process.env.LIQ_DELTA_MIN_IMPROV_PCT,
    { min: 0, max: 1000, errors }
  );
  asNumberInRange(
    "DELTA_MIN_ROUTE_AGE_MS",
    process.env.DELTA_MIN_ROUTE_AGE_MS,
    { min: 0, max: 1e9, errors }
  );
  asNumberInRange("PRELP_CONFIDENCE_MIN", process.env.PRELP_CONFIDENCE_MIN, {
    min: 0,
    max: 100,
    errors,
  });
  asNumberInRange("PRELP_COOL_MS", process.env.PRELP_COOL_MS, {
    min: 0,
    max: 1e9,
    errors,
  });

  // Install console redaction to protect secrets in logs
  const { install } = buildRedactor({
    TELEGRAM_BOT_TOKEN,
    WALLET_ENCRYPTION_KEY,
    PRIVATE_RELAY_API_KEY: process.env.PRIVATE_RELAY_API_KEY,
    MONGODB_URI,
  });
  install();

  if (errors.length) {
    const msg = `ENV validation warnings: ${errors.join("; ")}`;
    if (strict) {
      throw new Error(msg);
    } else {
      console.warn(msg);
    }
  }

  return { errors, strict };
}
