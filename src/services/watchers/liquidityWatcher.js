import { performSwap, getQuoteRaw } from "../trading/jupiter.js";
import { getWalletBalance } from "../walletInfo.js";
import { riskCheckToken } from "../risk.js";
import { measureRpcLatency } from "../rpcMonitor.js";
import {
  upsertActiveSnipe,
  markSnipeExecuted,
  markSnipeCancelled,
} from "../snipeStore.js";
import { getWatchersPaused, getWatchersSlowMs } from "../config.js";
import { addTradeLog, getUserState } from "../userState.js";
import { startFlashLpGuard, startTakeProfitGuard } from "./stopLossWatcher.js";
import { alphaBus } from "../alphaDetection.js";
import { PublicKey } from "@solana/web3.js";
import {
  getRpcConnection,
  getTransactionRaced,
  getSignaturesForAddressRaced,
} from "../rpc.js";

const activeWatchers = new Map();
const cooldowns = new Map(); // chatId:mint -> cool-until timestamp (ms)

// Canonicalize mint strings: extract a valid base58 public key (32–44 chars)
function canonicalizeMint(mint) {
  const s = String(mint || "").trim();
  const match = s.match(/[A-HJ-NP-Za-km-z1-9]{32,44}/);
  return match ? match[0] : s;
}

export function startLiquidityWatch(
  chatId,
  {
    mint,
    amountSol,
    onEvent,
    priorityFeeLamports,
    useJitoBundle,
    pollInterval,
    slippageBps,
    retryCount,
    dynamicSizing,
    minBuySol,
    maxBuySol,
    source, // optional: origin of this watcher (e.g., 'alpha:pump_launch')
    signalType, // optional: specific signal type/id
    lpSignature, // optional: tx signature for the LP addition (for Solscan link)
    walletOverride, // optional: execute using a specific wallet keypair
    // New: allow bypassing LP signature capture requirement for faster manual snipes
    requireLpSigBeforeBuy, // optional: override env REQUIRE_LP_SIG_BEFORE_BUY
    lpSigStrictAbortIfMissing, // optional: override env LP_SIG_STRICT_ABORT_IF_MISSING
  }
) {
  const canonicalMint = canonicalizeMint(mint);
  const k = walletOverride
    ? `${chatId}:${canonicalMint}:${walletOverride.publicKey.toBase58()}`
    : `${chatId}:${canonicalMint}`;
  const COOLDOWN_MS = Number(process.env.SNIPE_COOL_OFF_MS ?? 30000);
  const coolUntil = cooldowns.get(k) || 0;
  if (coolUntil && Date.now() < coolUntil) {
    onEvent?.(
      `In cool-off for ${Math.max(
        0,
        coolUntil - Date.now()
      )}ms. Skipping start.`
    );
    return;
  }
  // Atomic guard: reserve the watcher key immediately to avoid duplicate starts
  if (activeWatchers.has(k)) return;
  activeWatchers.set(k, null);

  const baseInterval = Math.max(250, Number(pollInterval ?? 300));
  const maxAttempts = Number(retryCount ?? 3);
  let attempts = 0;
  let intervalMs = baseInterval;
  let stopped = false;
  let inflightAttempt = false; // prevent overlapping attempts while awaiting confirmation
  // Warn only once for insufficient SOL and pause the watcher
  let insufficientWarned = false;
  // Fee reserve configuration: ensure SOL is left for future fees (sell, etc.)
  const stateForReserve = getUserState?.(chatId);
  const MIN_FEE_RESERVE_SOL = Number(
    stateForReserve?.minFeeReserveSol ?? process.env.MIN_FEE_RESERVE_SOL ?? 0.02
  );

  // Liquidity delta heuristics & guardrails (configurable via ENV)
  const envDeltaEnabled =
    String(process.env.LIQ_DELTA_ENABLED || "true").toLowerCase() !== "false";
  const state = getUserState?.(chatId);
  const LIQ_DELTA_ENABLED = !!(state?.liqDeltaEnabled ?? envDeltaEnabled);
  const DELTA_PROBE_SOL = Number(
    state?.liqDeltaProbeSol ?? process.env.LIQ_DELTA_PROBE_SOL ?? 0.1
  ); // probe size in SOL to estimate unit-out
  const DELTA_MIN_IMPROV_PCT = Number(
    state?.liqDeltaMinImprovPct ?? process.env.LIQ_DELTA_MIN_IMPROV_PCT ?? 0
  ); // require % improvement between polls to fire
  const DELTA_MAX_PRICE_IMPACT_PCT = Number(
    state?.deltaMaxPriceImpactPct ?? process.env.DELTA_MAX_PRICE_IMPACT_PCT ?? 8
  ); // cap impact to avoid thin LP entries
  const DELTA_MIN_ROUTE_AGE_MS = Number(
    state?.deltaMinRouteAgeMs ?? process.env.DELTA_MIN_ROUTE_AGE_MS ?? 0
  ); // optional min age since first route seen
  let prevUnitOutProbe = null;
  let routeFirstSeenAt = null;
  // Track last seen AMM pool keys from Jupiter route to aid LP detection
  let lastAmmKeys = [];
  // LP detection wiring
  let lpSig = lpSignature || null;
  let logsSubIds = [];
  // Prevent repeated Telegram spam for missing LP signature
  let lpSigMissingWarned = false;
  const conn = getRpcConnection();
  const RAYDIUM_AMM_PROGRAM =
    process.env.RAYDIUM_AMM_PROGRAM ||
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
  // Helper: subscribe to logs for a given program and capture LP signature
  async function subscribeLpLogs(programId58) {
    try {
      const pid = new PublicKey(programId58);
      const subId = await conn
        .onLogs(
          pid,
          async ({ signature }) => {
            try {
              if (lpSig) return;
              const tx = await getTransactionRaced(signature, {
                commitment: "processed",
                maxSupportedTransactionVersion: 0,
              }).catch(() => null);
              const keys = tx?.transaction?.message?.accountKeys || [];
              const loadedW = tx?.meta?.loadedAddresses?.writable || [];
              const loadedR = tx?.meta?.loadedAddresses?.readonly || [];
              const keys58 = [
                ...keys.map((k) => {
                  try {
                    return k?.pubkey
                      ? k.pubkey.toBase58()
                      : k.toBase58?.() || String(k);
                  } catch {
                    return String(k);
                  }
                }),
                ...loadedW.map((k) => {
                  try {
                    return k?.toBase58?.() || String(k);
                  } catch {
                    return String(k);
                  }
                }),
                ...loadedR.map((k) => {
                  try {
                    return k?.toBase58?.() || String(k);
                  } catch {
                    return String(k);
                  }
                }),
              ];
              const involvesMint = keys58.includes(canonicalMint);
              const involvesAmm = lastAmmKeys?.some?.((ak) =>
                keys58.includes(ak)
              );
              if (involvesMint || involvesAmm) {
                lpSig = signature;
                // Surface the LP tx hash to the user immediately
                onEvent?.(`LP detected via logs. tx: ${signature}`);
                try {
                  addTradeLog(chatId, {
                    kind: "telemetry",
                    mint: canonicalMint,
                    stage: "lp_detected",
                    lpSignature: signature,
                    via: "logs_subscription",
                    programId: programId58,
                    match: involvesMint
                      ? "mint"
                      : involvesAmm
                      ? "ammKey"
                      : "unknown",
                  });
                } catch {}
              }
            } catch {}
          },
          "processed"
        )
        .catch(() => null);
      if (subId != null) logsSubIds.push(subId);
    } catch {}
  }
  // Helper: subscribe to logs that mention the target mint; capture earliest LP-like tx
  async function subscribeMintLogs(mint58) {
    try {
      let mintKey;
      try {
        mintKey = new PublicKey(mint58);
      } catch {
        console.warn(
          `⚠️ Invalid mint passed to mint log subscription: ${mint58}`
        );
        return;
      }
      const subId = await conn
        .onLogs(
          mintKey,
          async ({ signature, logs }) => {
            try {
              if (lpSig) return;
              const text = Array.isArray(logs?.logs)
                ? logs.logs.join("\n")
                : String(logs || "");
              const looksLp =
                /liquidity|pool|lp|raydium|meteora|orca/i.test(text) ||
                /initialize.*pool|create.*pool|add.*liquidity/i.test(text);
              const tx = await getTransactionRaced(signature, {
                commitment: "processed",
                maxSupportedTransactionVersion: 0,
              }).catch(() => null);
              const keys = tx?.transaction?.message?.accountKeys || [];
              const loadedW = tx?.meta?.loadedAddresses?.writable || [];
              const loadedR = tx?.meta?.loadedAddresses?.readonly || [];
              const keys58 = [
                ...keys.map((k) => {
                  try {
                    return k?.pubkey
                      ? k.pubkey.toBase58()
                      : k.toBase58?.() || String(k);
                  } catch {
                    return String(k);
                  }
                }),
                ...loadedW.map((k) => {
                  try {
                    return k?.toBase58?.() || String(k);
                  } catch {
                    return String(k);
                  }
                }),
                ...loadedR.map((k) => {
                  try {
                    return k?.toBase58?.() || String(k);
                  } catch {
                    return String(k);
                  }
                }),
              ];
              const involvesMint = keys58.includes(canonicalMint);
              const involvesAmm = lastAmmKeys?.some?.((ak) =>
                keys58.includes(ak)
              );
              if (looksLp && (involvesMint || involvesAmm)) {
                lpSig = signature;
                // Surface the LP tx hash to the user immediately
                onEvent?.(`LP detected via mint logs. tx: ${signature}`);
                try {
                  addTradeLog(chatId, {
                    kind: "telemetry",
                    mint: canonicalMint,
                    stage: "lp_detected",
                    lpSignature: signature,
                    via: "mint_mentions_subscription",
                    match: involvesMint
                      ? "mint"
                      : involvesAmm
                      ? "ammKey"
                      : "unknown",
                  });
                } catch {}
              }
            } catch {}
          },
          "processed"
        )
        .catch(() => null);
      if (subId != null) logsSubIds.push(subId);
    } catch {}
  }
  // Always subscribe to Raydium by default
  subscribeLpLogs(RAYDIUM_AMM_PROGRAM);
  // Optionally subscribe to additional AMM programs via env (comma-separated list)
  const MORE_AMM_PROGRAMS = String(process.env.LP_LOG_PROGRAM_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const pid of MORE_AMM_PROGRAMS) {
    // Avoid duplicate subscription if Raydium is included in the list
    if (pid === RAYDIUM_AMM_PROGRAM) continue;
    subscribeLpLogs(pid);
  }
  // Also subscribe to logs that mention the mint directly to catch LP-add quickly
  subscribeMintLogs(canonicalMint);

  // Helper: quick scan recent signatures for this mint to find likely LP tx
  async function findLikelyLpSignature({ mint58, route }) {
    try {
      const limit = Number(process.env.LP_SIG_SCAN_LIMIT || 15);
      const scanTimeout = Number(
        process.env.LP_SIG_SCAN_TX_READ_TIMEOUT_MS || 6000
      );
      const ammKeys = Array.isArray(route?.routePlan)
        ? route.routePlan
            .map((s) => s?.swapInfo?.ammKey)
            .filter((x) => typeof x === "string" && x.length > 0)
        : [];
      const candidates = Array.from(new Set([mint58, ...ammKeys])).filter(
        Boolean
      );
      const KEYWORDS = [
        "initialize pool",
        "add liquidity",
        "create pool",
        "initialize",
        "liquidity",
        "amm",
        "pool",
        "raydium",
        "meteora",
        "orca",
      ];
      for (const addr of candidates) {
        const sigs = await getSignaturesForAddressRaced(addr, {
          limit,
          timeoutMs: Number(process.env.LP_SIG_SCAN_TIMEOUT_MS || 8000),
          maxRetries: Number(process.env.LP_SIG_SCAN_RACE_RETRIES || 1),
          microBatch: Number(process.env.LP_SIG_SCAN_MICRO_BATCH || 3),
        }).catch(() => []);
        for (const s of sigs || []) {
          const sig = s?.signature || s;
          const tx = await getTransactionRaced(sig, {
            commitment: "processed",
            maxSupportedTransactionVersion: 0,
            timeoutMs: scanTimeout,
            maxRetries: 1,
          }).catch(() => null);
          const logs = tx?.meta?.logMessages || [];
          const line = (logs || []).join(" ").toLowerCase();
          const keys = tx?.transaction?.message?.accountKeys || [];
          const loadedW = tx?.meta?.loadedAddresses?.writable || [];
          const loadedR = tx?.meta?.loadedAddresses?.readonly || [];
          const keys58 = [
            ...keys.map((k) => {
              try {
                return k?.pubkey
                  ? k.pubkey.toBase58()
                  : k.toBase58?.() || String(k);
              } catch {
                return String(k);
              }
            }),
            ...loadedW.map((k) => {
              try {
                return k?.toBase58?.() || String(k);
              } catch {
                return String(k);
              }
            }),
            ...loadedR.map((k) => {
              try {
                return k?.toBase58?.() || String(k);
              } catch {
                return String(k);
              }
            }),
          ];
          const keyMatch =
            keys58.includes(mint58) ||
            ammKeys.some((ak) => keys58.includes(ak));
          if ((line && KEYWORDS.some((kw) => line.includes(kw))) || keyMatch) {
            return sig;
          }
        }
      }
    } catch {}
    return null;
  }

  // Fallback: scan recent Raydium program signatures and match our mint
  async function findLpSigViaProgramScan({ mint58 }) {
    try {
      const limit = Number(process.env.LP_SIG_PROGRAM_SCAN_LIMIT || 40);
      const sigs = await getSignaturesForAddressRaced(RAYDIUM_AMM_PROGRAM, {
        limit,
        timeoutMs: Number(process.env.LP_SIG_SCAN_TIMEOUT_MS || 8000),
        maxRetries: Number(process.env.LP_SIG_SCAN_RACE_RETRIES || 1),
        microBatch: Number(process.env.LP_SIG_SCAN_MICRO_BATCH || 3),
      }).catch(() => []);
      for (const s of sigs || []) {
        const sig = s?.signature || s;
        const tx = await getTransactionRaced(sig, {
          commitment: "processed",
          maxSupportedTransactionVersion: 0,
          timeoutMs: Number(process.env.LP_SIG_SCAN_TX_READ_TIMEOUT_MS || 6000),
          maxRetries: 1,
        }).catch(() => null);
        const logsText =
          tx?.meta?.logMessages?.join("\n")?.toLowerCase?.() || "";
        const looksLp =
          /liquidity|pool|lp|raydium|meteora|orca/.test(logsText) ||
          /initialize.*pool|create.*pool|add.*liquidity/.test(logsText);
        const keys = tx?.transaction?.message?.accountKeys || [];
        const loadedW = tx?.meta?.loadedAddresses?.writable || [];
        const loadedR = tx?.meta?.loadedAddresses?.readonly || [];
        const keys58 = [
          ...keys.map((k) => {
            try {
              return k?.pubkey
                ? k.pubkey.toBase58()
                : k.toBase58?.() || String(k);
            } catch {
              return String(k);
            }
          }),
          ...loadedW.map((k) => {
            try {
              return k?.toBase58?.() || String(k);
            } catch {
              return String(k);
            }
          }),
          ...loadedR.map((k) => {
            try {
              return k?.toBase58?.() || String(k);
            } catch {
              return String(k);
            }
          }),
        ];
        const involvesMint = keys58.includes(mint58);
        if (looksLp && involvesMint) {
          return sig;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  // Persist the snipe job as active so it can be resumed on restart
  upsertActiveSnipe(chatId, {
    mint: canonicalMint,
    amountSol,
    status: "active",
    startedAt: Date.now(),
    settings: {
      priorityFeeLamports,
      useJitoBundle,
      pollInterval: baseInterval,
      slippageBps,
      retryCount: maxAttempts,
      dynamicSizing: !!dynamicSizing,
      minBuySol,
      maxBuySol,
      source,
      signalType,
    },
  }).catch(() => {});

  const checkReady = async () => {
    // Pause switch
    if (getWatchersPaused()) {
      onEvent?.("Watchers paused by config. Skipping check.");
      return false;
    }
    // balance preflight
    let solBal = 0;
    try {
      if (walletOverride?.publicKey) {
        const conn = getRpcConnection();
        const lamports = await conn.getBalance(walletOverride.publicKey);
        solBal = lamports / 1_000_000_000;
      } else {
        const bal = await getWalletBalance(chatId);
        solBal = Number(bal?.solBalance || 0);
      }
    } catch {
      solBal = 0;
    }
    // Require enough to buy and still leave a fee reserve
    if (solBal < amountSol || solBal - amountSol < MIN_FEE_RESERVE_SOL) {
      if (!insufficientWarned) {
        const needed = Math.max(0, amountSol + MIN_FEE_RESERVE_SOL);
        onEvent?.(
          `Insufficient SOL (${solBal}). Need >= ${needed.toFixed(
            4
          )} SOL to buy and keep ${MIN_FEE_RESERVE_SOL} SOL for fees.`
        );
        insufficientWarned = true;
      }
      // Do not stop the watcher; keep probing until balance updates
      return false;
    }
    // optional risk check preflight
    try {
      const requireLpLock =
        String(process.env.REQUIRE_LP_LOCK || "").toLowerCase() === "true" ||
        process.env.REQUIRE_LP_LOCK === "1";
      const maxBuyTaxBps = Number(process.env.MAX_BUY_TAX_BPS || 1500);
      const risk = await riskCheckToken(canonicalMint, {
        requireLpLock,
        maxBuyTaxBps,
      });
      if (!risk.ok) {
        onEvent?.(`Blocked by risk: ${risk.reasons?.join("; ")}`);
        return false;
      }
    } catch {}
    return true;
  };

  const attempt = async () => {
    if (stopped) return;
    if (inflightAttempt) return; // skip if an attempt is currently running
    inflightAttempt = true;
    attempts += 1;
    try {
      const ready = await checkReady();
      if (!ready) return;

      const slowMs = getWatchersSlowMs();
      if (slowMs > 0) await new Promise((r) => setTimeout(r, slowMs));

      // quick readiness probe for route availability via shared Jupiter helper
      const route = await getQuoteRaw({
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: canonicalMint,
        amountRaw: Math.round(amountSol * 1e9),
        slippageBps: slippageBps ?? 100,
        timeoutMs: 900,
      });
      if (!route) {
        try {
          addTradeLog(chatId, {
            kind: "telemetry",
            mint,
            stage: "route_check",
            status: "unavailable",
            attempt: attempts,
          });
        } catch {}
        return; // not ready yet
      }

      // Log first liquidity detection (first time a route becomes available)
      if (routeFirstSeenAt === null) {
        routeFirstSeenAt = Date.now();
        const outRaw = Number(route?.outAmount || 0);
        const impact = Number(route?.priceImpactPct ?? 0);
        // Cache last seen AMM keys from the route for log-match assistance
        try {
          lastAmmKeys = Array.isArray(route?.routePlan)
            ? route.routePlan
                .map((s) => s?.swapInfo?.ammKey)
                .filter((x) => typeof x === "string" && x.length > 0)
            : [];
        } catch {
          lastAmmKeys = [];
        }
        // Best-effort: if we don't have lpSig yet, try a quick local scan
        if (!lpSig) {
          try {
            const quickBudget = Number(
              process.env.LP_SIG_QUICK_SCAN_BUDGET_MS || 1500
            );
            const quick = await Promise.race([
              findLikelyLpSignature({ mint58: canonicalMint, route }),
              new Promise((resolve) =>
                setTimeout(() => resolve(null), quickBudget)
              ),
            ]);
            if (quick) {
              lpSig = quick;
              try {
                addTradeLog(chatId, {
                  kind: "telemetry",
                  mint: canonicalMint,
                  stage: "lp_detected",
                  lpSignature: quick,
                  via: "scan_recent_sigs",
                });
              } catch {}
            }
          } catch {}
        }
        // Fallback: program-level scan if still not found
        if (!lpSig) {
          try {
            const progBudget = Number(
              process.env.LP_SIG_PROGRAM_SCAN_BUDGET_MS || 1200
            );
            const prog = await Promise.race([
              findLpSigViaProgramScan({ mint58: canonicalMint }),
              new Promise((resolve) =>
                setTimeout(() => resolve(null), progBudget)
              ),
            ]);
            if (prog) {
              lpSig = prog;
              try {
                addTradeLog(chatId, {
                  kind: "telemetry",
                  mint: canonicalMint,
                  stage: "lp_detected",
                  lpSignature: prog,
                  via: "program_scan",
                });
              } catch {}
            }
          } catch {}
        }
        const DISABLE_TOKEN_FALLBACK =
          String(
            process.env.LP_SOLSCAN_DISABLE_TOKEN_FALLBACK || "true"
          ).toLowerCase() === "true";
        const solscanLink = lpSig
          ? `https://solscan.io/tx/${lpSig}`
          : DISABLE_TOKEN_FALLBACK
          ? ""
          : `https://solscan.io/token/${canonicalMint}`;
        const baseMsg = `💧 Liquidity detected for ${canonicalMint} — route live. outRaw=${outRaw} impact=${impact}%`;
        console.log(
          solscanLink ? `${baseMsg} | Solscan: ${solscanLink}` : baseMsg
        );
        // Emit a user-facing message with the LP transaction link if available
        if (lpSig) {
          onEvent?.(
            `💧 LP detected for ${canonicalMint}. Solscan tx: https://solscan.io/tx/${lpSig}`
          );
        }
        try {
          addTradeLog(chatId, {
            kind: "telemetry",
            mint: canonicalMint,
            stage: "liquidity_detected",
            priceImpactPct: impact,
            outAmount: outRaw,
            at: routeFirstSeenAt,
            attempt: attempts,
            lpSignature: lpSig,
            solscan: solscanLink,
          });
        } catch {}
      }

      // Liquidity delta heuristic and guardrails (pre-empt launch readiness)
      if (LIQ_DELTA_ENABLED) {
        if (routeFirstSeenAt === null) routeFirstSeenAt = Date.now();

        // Probe with a fixed small size to compute per-SOL unit out and track deltas
        const probeLamports = Math.max(
          1_000_000,
          Math.round(DELTA_PROBE_SOL * 1e9)
        ); // >= 0.001 SOL
        let probeRoute = null;
        try {
          probeRoute = await getQuoteRaw({
            inputMint: "So11111111111111111111111111111111111111112",
            outputMint: canonicalMint,
            amountRaw: probeLamports,
            slippageBps: slippageBps ?? 100,
            timeoutMs: 700,
          });
        } catch {}
        if (!probeRoute) {
          onEvent?.("Probe route unavailable yet, waiting...");
          try {
            addTradeLog(chatId, {
              kind: "telemetry",
              mint: canonicalMint,
              stage: "probe_check",
              status: "unavailable",
              attempt: attempts,
              probeLamports,
            });
          } catch {}
          return;
        }

        const unitOutProbe =
          Number(probeRoute.outAmount || 0) / Math.max(1, probeLamports);
        const priceImpactPct = Number(
          probeRoute.priceImpactPct ?? route.priceImpactPct ?? 0
        );

        // Guardrail: avoid entering on very high impact (thin LP)
        if (priceImpactPct > DELTA_MAX_PRICE_IMPACT_PCT) {
          onEvent?.(
            `Impact ${priceImpactPct.toFixed(
              2
            )}% > ${DELTA_MAX_PRICE_IMPACT_PCT}%. Waiting for more depth.`
          );
          try {
            addTradeLog(chatId, {
              kind: "telemetry",
              mint: canonicalMint,
              stage: "guardrail",
              reason: "impact_exceeds_threshold",
              priceImpactPct,
              threshold: DELTA_MAX_PRICE_IMPACT_PCT,
              attempt: attempts,
            });
          } catch {}
          prevUnitOutProbe = unitOutProbe;
          return;
        }

        // If we have a previous observation, require minimum improvement unless route has aged sufficiently
        if (prevUnitOutProbe !== null) {
          const improvPct =
            ((unitOutProbe - prevUnitOutProbe) /
              Math.max(1e-12, prevUnitOutProbe)) *
            100;
          const ageMs = Date.now() - routeFirstSeenAt;
          if (
            improvPct < DELTA_MIN_IMPROV_PCT &&
            ageMs < DELTA_MIN_ROUTE_AGE_MS
          ) {
            onEvent?.(
              `ΔunitOut ${improvPct.toFixed(
                2
              )}% < ${DELTA_MIN_IMPROV_PCT}% (age ${ageMs}ms). Waiting.`
            );
            try {
              addTradeLog(chatId, {
                kind: "telemetry",
                mint: canonicalMint,
                stage: "guardrail",
                reason: "improv_below_threshold",
                improvPct,
                minImprovementPct: DELTA_MIN_IMPROV_PCT,
                ageMs,
                minRouteAgeMs: DELTA_MIN_ROUTE_AGE_MS,
                attempt: attempts,
              });
            } catch {}
            prevUnitOutProbe = unitOutProbe;
            return;
          }
        } else if (DELTA_MIN_ROUTE_AGE_MS > 0) {
          const age = Date.now() - routeFirstSeenAt;
          if (age < DELTA_MIN_ROUTE_AGE_MS) {
            onEvent?.(
              `Route age ${age}ms < ${DELTA_MIN_ROUTE_AGE_MS}ms. Waiting.`
            );
            try {
              addTradeLog(chatId, {
                kind: "telemetry",
                mint: canonicalMint,
                stage: "guardrail",
                reason: "route_too_young",
                ageMs: age,
                minRouteAgeMs: DELTA_MIN_ROUTE_AGE_MS,
                attempt: attempts,
              });
            } catch {}
            prevUnitOutProbe = unitOutProbe;
            return;
          }
        }

        // Update probe baseline for next iteration
        prevUnitOutProbe = unitOutProbe;

        // Emit a LiquidityDeltaEvent for analytics/orchestration
        try {
          alphaBus?.emit?.("liquidity_delta", {
            chatId,
            mint: canonicalMint,
            unitOutProbe,
            prevUnitOutProbe,
            priceImpactPct,
            routeAgeMs: Date.now() - (routeFirstSeenAt || Date.now()),
            threshold: {
              minImprovementPct: DELTA_MIN_IMPROV_PCT,
              maxImpactPct: DELTA_MAX_PRICE_IMPACT_PCT,
              minRouteAgeMs: DELTA_MIN_ROUTE_AGE_MS,
              probeSol: DELTA_PROBE_SOL,
            },
            ts: Date.now(),
          });
          try {
            addTradeLog(chatId, {
              kind: "telemetry",
              mint: canonicalMint,
              stage: "delta_emitted",
              unitOutProbe,
              priceImpactPct,
              attempt: attempts,
            });
          } catch {}
        } catch {}
      }

      // Dynamic sizing based on env or param
      const dynEnabled =
        dynamicSizing ??
        String(process.env.DYNAMIC_SIZING || "").toLowerCase() === "true";
      let buyAmountSol = amountSol;
      if (dynEnabled) {
        const minSol = Number(minBuySol ?? process.env.MIN_BUY_SOL ?? 0.01);
        const maxSol = Number(
          maxBuySol ?? process.env.MAX_BUY_SOL ?? Math.max(amountSol, 0.5)
        );
        const impactBase = Number(route.priceImpactPct ?? 0);

        // Probe at smaller and larger sizes to infer LP depth/curvature
        const smallAmtSol = Math.max(minSol, amountSol * 0.5);
        const largeAmtSol = Math.min(maxSol, amountSol * 2);
        try {
          const [routeSmall, routeLarge] = await Promise.all([
            getQuoteRaw({
              inputMint: "So11111111111111111111111111111111111111112",
              outputMint: canonicalMint,
              amountRaw: Math.round(smallAmtSol * 1e9),
              slippageBps: slippageBps ?? 100,
              timeoutMs: 900,
            }).catch(() => null),
            getQuoteRaw({
              inputMint: "So11111111111111111111111111111111111111112",
              outputMint: canonicalMint,
              amountRaw: Math.round(largeAmtSol * 1e9),
              slippageBps: slippageBps ?? 100,
              timeoutMs: 900,
            }).catch(() => null),
          ]);

          const unitBase =
            Number(route?.outAmount || 0) /
            Math.max(1, Math.round(amountSol * 1e9));
          const unitSmall = routeSmall
            ? Number(routeSmall.outAmount || 0) /
              Math.max(1, Math.round(smallAmtSol * 1e9))
            : null;
          const unitLarge = routeLarge
            ? Number(routeLarge.outAmount || 0) /
              Math.max(1, Math.round(largeAmtSol * 1e9))
            : null;

          // Depth ratio: how much worse per-SOL output gets when scaling size up
          let depthRatio =
            unitLarge && unitBase
              ? unitLarge / Math.max(1e-12, unitBase)
              : null;

          // Decision matrix combining price impact and depth ratio
          if (impactBase >= 7 || (depthRatio !== null && depthRatio < 0.7)) {
            // Very thin/curved: cut size aggressively
            buyAmountSol = Math.max(minSol, amountSol * 0.4);
          } else if (
            impactBase >= 4 ||
            (depthRatio !== null && depthRatio < 0.85)
          ) {
            buyAmountSol = Math.max(minSol, amountSol * 0.6);
          } else if (
            impactBase <= 1.0 &&
            (depthRatio === null || depthRatio >= 0.95)
          ) {
            // Deep and flat: scale up within cap
            buyAmountSol = Math.min(maxSol, amountSol * 1.8);
          } else if (
            impactBase <= 2.0 &&
            (depthRatio === null || depthRatio >= 0.9)
          ) {
            buyAmountSol = Math.min(maxSol, amountSol * 1.4);
          }
        } catch {
          // Fallback to simple impact-only rule if probes fail
          if (impactBase >= 5) buyAmountSol = Math.max(minSol, amountSol * 0.5);
          else if (impactBase <= 1)
            buyAmountSol = Math.min(maxSol, amountSol * 2);
        }
      }

      // Adaptive slippage by attempts (safe and robust without trusting priceImpact schema)
      let slip = Number(slippageBps ?? 100);
      slip = Math.min(1000, slip + (attempts - 1) * 100);

      // Priority fee optimizer from observed latency
      let prio = priorityFeeLamports;
      if (!prio) {
        const lat = await measureRpcLatency().catch(() => 400);
        if (lat < 200) prio = 50000;
        else if (lat < 500) prio = 150000;
        else prio = 300000;
      }
      if (prio && attempts <= 3)
        prio = Math.floor(prio * (0.7 + 0.15 * (attempts - 1)));

      // Optionally wait briefly until LP signature is captured before buying
      // Allow overrides per watcher for faster manual snipes (e.g., Snipe LP Add)
      // Respect per-user preference and default to immediate buy if not specified
      const userPrefs = getUserState(chatId) || {};
      const REQUIRE_LP_SIG_BEFORE_BUY =
        requireLpSigBeforeBuy ??
        (typeof userPrefs.requireLpSigBeforeBuy === "boolean"
          ? userPrefs.requireLpSigBeforeBuy
          : String(process.env.REQUIRE_LP_SIG_BEFORE_BUY || "false")
              .toLowerCase() === "true");
      const LP_SIG_STRICT_ABORT_IF_MISSING =
        lpSigStrictAbortIfMissing ??
        (typeof userPrefs.lpSigStrictAbortIfMissing === "boolean"
          ? userPrefs.lpSigStrictAbortIfMissing
          : String(process.env.LP_SIG_STRICT_ABORT_IF_MISSING || "false")
              .toLowerCase()
              .trim() === "true");
      if (REQUIRE_LP_SIG_BEFORE_BUY && !lpSig) {
        const waitMs = Number(process.env.LP_SIG_WAIT_MS || 800);
        const startWait = Date.now();
        while (!lpSig && Date.now() - startWait < waitMs) {
          await new Promise((r) => setTimeout(r, 25));
        }
        if (!lpSig) {
          // Best effort: log that we’re proceeding without a captured LP signature
          try {
            addTradeLog(chatId, {
              kind: "telemetry",
              mint: canonicalMint,
              stage: "lp_sig_wait_timeout",
              waitMs,
            });
          } catch {}
          // If strict mode is enabled, do not proceed with the buy
          if (LP_SIG_STRICT_ABORT_IF_MISSING) {
            if (!lpSigMissingWarned) {
              onEvent?.(
                "No LP tx hash from RPC listeners; skipping buy until captured."
              );
              lpSigMissingWarned = true;
            }
            try {
              addTradeLog(chatId, {
                kind: "telemetry",
                mint: canonicalMint,
                stage: "lp_sig_missing_strict_abort",
                attempt: attempts,
              });
            } catch {}
            return;
          }
          // If strict abort is disabled, proceed immediately based on liquidity detection
          try {
            addTradeLog(chatId, {
              kind: "telemetry",
              mint: canonicalMint,
              stage: "lp_sig_missing_proceed",
              attempt: attempts,
            });
          } catch {}
        }
      }

      // Enforce fee reserve by dynamically reducing buy size if needed
      try {
        const bal = await getWalletBalance(chatId);
        const solBal = Number(bal?.solBalance || 0);
        const availableForBuy = Math.max(0, solBal - MIN_FEE_RESERVE_SOL);
        const MIN_BUY_SOL_FLOOR = Number(
          process.env.MIN_BUY_SOL_FLOOR ?? 0.005
        );
        if (availableForBuy < MIN_BUY_SOL_FLOOR) {
          onEvent?.(
            `Insufficient available after reserve. Need >= ${(
              MIN_FEE_RESERVE_SOL + MIN_BUY_SOL_FLOOR
            ).toFixed(4)} SOL total.`
          );
          throw new Error("insufficient_after_reserve");
        }
        buyAmountSol = Math.min(buyAmountSol, availableForBuy);
      } catch (e) {}

      const swapRes = await performSwap({
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: canonicalMint,
        amountSol: buyAmountSol,
        slippageBps: slip,
        priorityFeeLamports: prio,
        useJitoBundle,
        chatId,
        walletOverride,
        fastSend: true,
      });
      const txid = swapRes?.txid;

      // Wait for confirmation before proceeding
      let confirmedOk = false;
      let failedConf = false;
      try {
        if (txid) {
          const connection = getRpcConnection();
          const maxWait = Number(process.env.TX_CONFIRM_MAX_WAIT_MS || 90000);
          const pollEvery = Number(
            process.env.TX_CONFIRM_POLL_INTERVAL_MS || 2000
          );
          const startT = Date.now();
          while (Date.now() - startT < maxWait) {
            const st = await connection
              .getSignatureStatuses([txid])
              .catch(() => null);
            const s = st?.value?.[0];
            if (s) {
              if (s.err) {
                failedConf = true;
                break;
              }
              const status = s.confirmationStatus;
              if (status === "finalized" || status === "confirmed") {
                confirmedOk = true;
                break;
              }
            }
            await new Promise((r) => setTimeout(r, pollEvery));
          }
        }
      } catch {}

      if (!confirmedOk) {
        const RETRY_ON_UNCONFIRMED_BUY =
          String(process.env.RETRY_ON_UNCONFIRMED_BUY || "")
            .toLowerCase()
            .trim() === "true";
        try {
          addTradeLog(chatId, {
            kind: "status",
            statusOf: "buy",
            mint: canonicalMint,
            sol: Number(buyAmountSol),
            status: RETRY_ON_UNCONFIRMED_BUY ? "failed" : "stopped",
            failReason: failedConf ? "tx_err" : "tx_unconfirmed_timeout",
            attempt: attempts,
            txid,
          });
        } catch {}
        if (RETRY_ON_UNCONFIRMED_BUY) {
          onEvent?.(
            `⚠️ Swap tx not confirmed (${
              failedConf ? "failed" : "timeout"
            }). Retrying... Tx: ${txid}`
          );
          throw new Error("tx_not_confirmed");
        } else {
          onEvent?.(
            `⚠️ Swap tx not confirmed (${
              failedConf ? "failed" : "timeout"
            }). Stopping to avoid duplicate buys. Tx: ${txid}`
          );
          stopped = true;
          stopLiquidityWatch(chatId, canonicalMint);
          try {
            cooldowns.set(k, Date.now() + COOLDOWN_MS);
            addTradeLog(chatId, {
              kind: "telemetry",
              mint: canonicalMint,
              stage: "cooldown_set",
              coolOffMs: COOLDOWN_MS,
              attempts,
            });
          } catch {}
          return;
        }
      }

      onEvent?.(`Bought ${canonicalMint}. Tx: ${txid}`);

      // Record buy trade log with detailed telemetry
      try {
        addTradeLog(chatId, {
          kind: "buy",
          mint: canonicalMint,
          sol: Number(buyAmountSol),
          tokens: Number(swapRes?.output?.tokensOut ?? NaN),
          route: swapRes?.route?.labels,
          priceImpactPct: swapRes?.route?.priceImpactPct ?? null,
          slippageBps: swapRes?.slippageBps,
          priorityFeeLamports: swapRes?.priorityFeeLamports,
          via: swapRes?.via,
          latencyMs: swapRes?.latencyMs,
          txid,
          lastSendRaceWinner: swapRes?.lastSendRaceWinner ?? null,
          lastSendRaceAttempts: swapRes?.lastSendRaceAttempts ?? 0,
          lastSendRaceLatencyMs: swapRes?.lastSendRaceLatencyMs ?? null,
        });
      } catch {}

      // Arm Flash-LP guard immediately after buy
      try {
        const amtTokens = Number(swapRes?.output?.tokensOut ?? 0);
        startFlashLpGuard(chatId, {
          mint: canonicalMint,
          amountTokens: amtTokens,
          onEvent,
        });
      } catch {}

      // Arm Take-Profit guard to exit on upside spikes shortly after buy
      try {
        const amtTokens = Number(swapRes?.output?.tokensOut ?? 0);
        startTakeProfitGuard(chatId, {
          mint: canonicalMint,
          amountTokens: amtTokens,
          onEvent,
        });
      } catch {}

      // Mark executed in the store before stopping the watcher
      markSnipeExecuted(chatId, canonicalMint, { txid }).catch(() => {});

      // Cleanup logs subscriptions once we’ve bought or finished
      try {
        if (logsSubIds?.length) {
          for (const id of logsSubIds) {
            try {
              await conn.removeOnLogsListener(id);
            } catch {}
          }
          logsSubIds = [];
        }
      } catch {}

      stopLiquidityWatch(chatId, canonicalMint);
    } catch (e) {
      // If a global buy lock is active, stop this watcher and cool off to avoid duplicates
      if (String(e?.message || "").includes("buy_locked")) {
        try {
          onEvent?.(
            "🔒 Buy lock active: another buy in-flight for this token. Stopping to avoid duplicates."
          );
          stopped = true;
          stopLiquidityWatch(chatId, canonicalMint);
          const COOLDOWN_MS = Number(process.env.SNIPE_COOL_OFF_MS ?? 30000);
          cooldowns.set(k, Date.now() + COOLDOWN_MS);
          addTradeLog(chatId, {
            kind: "telemetry",
            mint: canonicalMint,
            stage: "buy_lock",
            status: "stopped",
            coolOffMs: COOLDOWN_MS,
            attempts,
          });
        } catch {}
        return;
      }
      // adaptive backoff up to 2x base
      intervalMs = Math.min(baseInterval * 2, Math.floor(intervalMs * 1.25));
      // log failure attempt for telemetry
      try {
        const failMsg = (e?.message || String(e)).slice(0, 300);
        addTradeLog(chatId, {
          kind: "status",
          statusOf: "buy",
          mint,
          sol: Number(amountSol),
          status: "failed",
          failReason: failMsg,
          attempt: attempts,
        });
      } catch {}
      // stop after too many attempts to avoid infinite loops
      if (attempts >= maxAttempts) {
        stopped = true;
        // Cleanup logs subscriptions if stopping
        try {
          if (logsSubIds?.length) {
            for (const id of logsSubIds) {
              try {
                await conn.removeOnLogsListener(id);
              } catch {}
            }
            logsSubIds = [];
          }
        } catch {}
        stopLiquidityWatch(chatId, canonicalMint);
        onEvent?.(`Stopped watcher after ${attempts} attempts.`);
        try {
          cooldowns.set(k, Date.now() + COOLDOWN_MS);
          addTradeLog(chatId, {
            kind: "telemetry",
            mint: canonicalMint,
            stage: "cooldown_set",
            coolOffMs: COOLDOWN_MS,
            attempts,
          });
        } catch {}
      }
    }
  };

  const interval = setInterval(async () => {
    try {
      await attempt();
    } finally {
      inflightAttempt = false;
    }
  }, intervalMs);
  activeWatchers.set(k, interval);
  onEvent?.(`Watching ${canonicalMint} every ${baseInterval}ms ...`);
}

export function stopLiquidityWatch(chatId, mint, reason = "stopped") {
  const canonicalMint = canonicalizeMint(mint);
  if (mint) {
    const k = `${chatId}:${canonicalMint}`;
    const interval = activeWatchers.get(k);
    if (interval) clearInterval(interval);
    activeWatchers.delete(k);
    // If still active (not executed), mark as cancelled
    markSnipeCancelled(chatId, canonicalMint, reason).catch(() => {});
    return true;
  }
  // stop all for chatId
  [...activeWatchers.entries()].forEach(([k, interval]) => {
    if (k.startsWith(`${chatId}:`)) {
      clearInterval(interval);
      activeWatchers.delete(k);
      const [, m] = k.split(":");
      markSnipeCancelled(chatId, m, "stopped_all").catch(() => {});
    }
  });
  return true;
}
