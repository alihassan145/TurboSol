// Minimal Jito bundle submit via gRPC using @grpc/grpc-js
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import path from "node:path";
import bs58 from "bs58";
import {
  getGrpcEndpoint,
  simulateTransactionRaced,
  sendTransactionRaced,
  getLastSendRaceMeta,
  mapStrategyToMicroBatch,
} from "./rpc.js";
import { getConnection } from "./wallet.js";
import { addTradeLog, getUserState } from "./userState.js";
import { recordPriorityFeeFeedback } from "./fees.js";

let jitoClient = null;

function loadProto() {
  const packageDefinition = protoLoader.loadSync(
    path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../../protos/bundle.proto"
    ),
    {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    }
  );
  const descriptor = grpc.loadPackageDefinition(packageDefinition);
  return descriptor.jito;
}

export function getJitoClient() {
  if (jitoClient) return jitoClient;
  const endpoint = getGrpcEndpoint();
  if (!endpoint) return null;
  const proto = loadProto();
  jitoClient = new proto.bundle.BundleService(
    endpoint,
    grpc.credentials.createInsecure()
  );
  return jitoClient;
}

export async function submitBundle(base64Transactions = [], opts = {}) {
  const client = getJitoClient();
  if (!client) throw new Error("gRPC endpoint not configured");
  const started = Date.now();
  return new Promise((resolve, reject) => {
    client.SubmitBundle({ transactions: base64Transactions }, (err, resp) => {
      if (err) return reject(err);
      resolve({ ...resp, latencyMs: Date.now() - started });
    });
  });
}

export async function submitSingleAsBundle(base64Tx) {
  const res = await submitBundle([base64Tx]);
  return res;
}

export function serializeToBase64(tx) {
  const bytes = tx.serialize();
  return Buffer.from(bytes).toString("base64");
}

async function waitUntilApproxTargetSlot(targetSlot, maxWaitMs = 1000) {
  if (!targetSlot) return { waitedMs: 0, currentSlot: null };
  const conn = getConnection();
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const cur = await conn.getSlot();
      if (cur >= targetSlot - 1) {
        return { waitedMs: Date.now() - start, currentSlot: cur };
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  return { waitedMs: Date.now() - start, currentSlot: null };
}

export async function submitBundleWithTarget(
  base64Transactions = [],
  {
    slotsAhead = Number(process.env.JITO_SLOTS_AHEAD || 1),
    retries = Number(process.env.JITO_RETRIES || 2),
    retryDelayMs = Number(process.env.JITO_RETRY_DELAY_MS || 100),
    maxWaitMs = Number(process.env.JITO_MAX_WAIT_MS || 1000),
  } = {}
) {
  // Compute a naive target slot and wait briefly before submit
  let targetSlot = null;
  try {
    const conn = getConnection();
    const cur = await conn.getSlot();
    targetSlot = cur + Math.max(0, Number(slotsAhead || 0));
  } catch {}

  await waitUntilApproxTargetSlot(targetSlot, maxWaitMs).catch(() => ({}));

  let lastErr = null;
  for (let attempt = 0; attempt <= Math.max(0, retries); attempt++) {
    try {
      const res = await submitBundle(base64Transactions);
      if (res && res.uuid) {
        return { ...res, targetSlot, attempts: attempt + 1 };
      }
      lastErr = new Error("Jito bundle responded without uuid");
    } catch (e) {
      lastErr = e;
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, Math.max(0, retryDelayMs)));
    }
  }
  const message = lastErr?.message || "Jito bundle submission failed";
  const error = new Error(message);
  error.targetSlot = targetSlot;
  throw error;
}

export async function jitoHealthCheck() {
  const client = getJitoClient();
  if (!client) return { ok: false, error: "no_endpoint" };
  return new Promise((resolve) => {
    try {
      // Basic empty call to test channel (no dedicated ping in proto)
      client.waitForReady(Date.now() + 1500, (err) => {
        if (err) return resolve({ ok: false, error: err.message });
        resolve({ ok: true });
      });
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

// Centralized: simulate -> bundle -> send (fallback), with telemetry
export async function simulateBundleAndSend({
  signedTx,
  chatId,
  useJitoBundle = false,
  priorityFeeMicroLamports,
}) {
  const sig = bs58.encode(signedTx.signatures?.[0] || []);
  const t0 = Date.now();
  const base64 = serializeToBase64(signedTx);

  // 1) Simulate pre-send (don't block on failure; log telemetry)
  try {
    const sim = await simulateTransactionRaced(signedTx, {
      commitment: "confirmed",
      simulateOptions: { sigVerify: true },
    });
    try {
      addTradeLog(chatId, {
        kind: "telemetry",
        stage: "pre_send_simulation",
        ok: true,
        units: sim?.value?.unitsConsumed ?? null,
        err: null,
      });
    } catch {}
  } catch (e) {
    try {
      addTradeLog(chatId, {
        kind: "telemetry",
        stage: "pre_send_simulation",
        ok: false,
        units: null,
        err: String(e?.message || e),
      });
    } catch {}
  }

  // 2) Primary path: Jito bundle
  let via = useJitoBundle ? "jupiter+jito" : "jupiter+rpc";
  let jitoErr = null;
  if (useJitoBundle) {
    const tJ = Date.now();
    try {
      const res = await submitBundleWithTarget([base64]).catch(async () => {
        // fallback to simple submit if target flow not available/supported
        return await submitSingleAsBundle(base64);
      });
      try {
        addTradeLog(chatId, {
          kind: "telemetry",
          stage: "jito_submit",
          ok: true,
          uuid: res?.uuid || null,
          latencyMs: res?.latencyMs ?? Date.now() - tJ,
        });
      } catch {}
      try {
        recordPriorityFeeFeedback({
          fee: priorityFeeMicroLamports ?? null,
          success: true,
          latencyMs: Date.now() - tJ,
          via: "jupiter+jito",
        });
      } catch {}
    } catch (e) {
      jitoErr = e;
      try {
        addTradeLog(chatId, {
          kind: "telemetry",
          stage: "jito_submit",
          ok: false,
          err: String(e?.message || e),
          latencyMs: Date.now() - tJ,
        });
      } catch {}
      try {
        recordPriorityFeeFeedback({
          fee: priorityFeeMicroLamports ?? null,
          success: false,
          latencyMs: Date.now() - tJ,
          via: "jupiter+jito",
        });
      } catch {}
    }
  }

  // 3) Fallback or direct RPC send
  if (!useJitoBundle || jitoErr) {
    const state = chatId != null ? getUserState(chatId) : {};
    const usePrivateRelay = !!state.enablePrivateRelay;
    const microBatch = mapStrategyToMicroBatch(state.rpcStrategy);
    const tR = Date.now();
    try {
      const sigRpc = await sendTransactionRaced(signedTx, {
        skipPreflight: true,
        maxRetries: 0,
        microBatch,
        usePrivateRelay,
      });
      via = jitoErr ? "jupiter+jito_fallback_rpc" : "jupiter+rpc";
      try {
        addTradeLog(chatId, {
          kind: "telemetry",
          stage: "rpc_send",
          ok: true,
          signature: sigRpc,
          latencyMs: Date.now() - tR,
          usePrivateRelay,
          microBatch,
        });
      } catch {}
      try {
        recordPriorityFeeFeedback({
          fee: priorityFeeMicroLamports ?? null,
          success: true,
          latencyMs: Date.now() - tR,
          via,
        });
      } catch {}
    } catch (e) {
      // If Jito succeeded (no jitoErr), we still return sig; otherwise throw
      try {
        addTradeLog(chatId, {
          kind: "telemetry",
          stage: "rpc_send",
          ok: false,
          err: String(e?.message || e),
          latencyMs: Date.now() - tR,
          usePrivateRelay,
          microBatch,
        });
      } catch {}
      if (!useJitoBundle || jitoErr) {
        // Both paths failed
        try {
          recordPriorityFeeFeedback({
            fee: priorityFeeMicroLamports ?? null,
            success: false,
            latencyMs: Date.now() - tR,
            via: "jupiter+rpc",
          });
        } catch {}
        throw e;
      }
    }
  }

  const raceMeta = getLastSendRaceMeta?.() || {};
  return {
    txid: sig,
    via,
    latencyMs: Date.now() - t0,
    lastSendRaceWinner: raceMeta?.winner || null,
    lastSendRaceAttempts: raceMeta?.attempts || 0,
    lastSendRaceLatencyMs: raceMeta?.latencyMs ?? null,
  };
}
