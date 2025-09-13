// Minimal Jito bundle submit via gRPC using @grpc/grpc-js
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import path from "node:path";
import { getGrpcEndpoint } from "./rpc.js";
import { getConnection } from "./wallet.js";

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
