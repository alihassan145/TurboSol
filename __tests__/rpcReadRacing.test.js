import { jest } from "@jest/globals";
import {
  __resetRpcStateForTests,
  initializeRpc,
  addRpcEndpoint,
  getAllRpcEndpoints,
  getLatestBlockhashRaced,
  simulateTransactionRaced,
} from "../src/services/rpc.js";

// Helper to temporarily set env with restore
function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    process.env[k] = vars[k];
  }
  return fn().finally(() => {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}

describe("race read helpers", () => {
  beforeEach(() => {
    __resetRpcStateForTests();
    process.env.SOLANA_RPC_URL = "";
    process.env.RPC_HTTP_ENDPOINTS = "http://rpc-a, http://rpc-b, http://rpc-c";
    initializeRpc();
  });

  afterEach(() => {
    delete process.env.RPC_HTTP_ENDPOINTS;
  });

  test("getLatestBlockhashRaced returns first successful result and times out losers", async () => {
    const calls = [];
    const impl = (url) =>
      new Promise((resolve, reject) => {
        calls.push(url);
        if (url.includes("rpc-b")) {
          setTimeout(() => resolve({ blockhash: "BH_B" }), 40);
        } else if (url.includes("rpc-a")) {
          setTimeout(() => resolve({ blockhash: "BH_A" }), 100);
        } else {
          setTimeout(() => reject(new Error("boom")), 60);
        }
      });

    const res = await getLatestBlockhashRaced({ microBatch: 2, callImpl: impl });
    expect(res).toEqual({ blockhash: "BH_B" });
    // ensure multiple endpoints attempted in a wave
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  test("simulateTransactionRaced fails over when first wave errors", async () => {
    const impl = (url) =>
      new Promise((resolve, reject) => {
        if (url.includes("rpc-a")) {
          setTimeout(() => reject(new Error("fail_a")), 30);
        } else if (url.includes("rpc-b")) {
          setTimeout(() => reject(new Error("fail_b")), 35);
        } else {
          setTimeout(() => resolve({ value: { err: null, logs: ["ok"], unitsConsumed: 111 } }), 20);
        }
      });

    const res = await simulateTransactionRaced({}, { microBatch: 2, callImpl: impl });
    expect(res?.value?.err).toBeNull();
    expect(res?.value?.unitsConsumed).toBe(111);
  });

  test("raced helpers throw when all endpoints fail", async () => {
    const impl = () => Promise.reject(new Error("nope"));
    await expect(
      getLatestBlockhashRaced({ microBatch: 2, callImpl: impl })
    ).rejects.toThrow();
  });
});