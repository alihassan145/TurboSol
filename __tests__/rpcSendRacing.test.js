import { jest } from "@jest/globals";

// Ensure timeout-related env are set BEFORE importing the module so module-scope constants pick them up
process.env.RPC_SEND_TIMEOUT_MS = "60"; // small to trigger timeouts deterministically
process.env.RPC_STAGGER_STEP_MS = "5";
process.env.RPC_INTER_WAVE_DELAY_MS = "10";

// Dynamic ESM mocks must be declared before importing the module under test
let sendImpl;
let measureImpl;

jest.unstable_mockModule("../src/services/rpcMonitor.js", () => ({
  measureEndpointsLatency: async (endpoints) => {
    if (typeof measureImpl === "function") return measureImpl(endpoints);
    // default: equal latencies
    return endpoints.map((url, i) => ({ url, latency: 100 + i }));
  },
}));

jest.unstable_mockModule("@solana/web3.js", () => ({
  Connection: class MockConnection {
    constructor(url) {
      this._url = url;
    }
    sendRawTransaction(_raw, _opts) {
      if (typeof sendImpl !== "function") {
        throw new Error("sendImpl not set in test");
      }
      return sendImpl(this._url);
    }
  },
}));

const rpc = await import("../src/services/rpc.js");

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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe("sendTransactionRaced", () => {
  beforeEach(() => {
    rpc.__resetRpcStateForTests();
    process.env.SOLANA_RPC_URL = "";
    process.env.RPC_HTTP_ENDPOINTS = "http://rpc-a, http://rpc-b, http://rpc-c";
    // default time params for tests (also set above for module constants)
    process.env.RPC_SEND_TIMEOUT_MS = "60";
    process.env.RPC_STAGGER_STEP_MS = "5";
    process.env.RPC_INTER_WAVE_DELAY_MS = "10";
    rpc.initializeRpc();
  });

  afterEach(() => {
    delete process.env.RPC_HTTP_ENDPOINTS;
    delete process.env.RPC_SEND_TIMEOUT_MS;
    delete process.env.RPC_STAGGER_STEP_MS;
    delete process.env.RPC_INTER_WAVE_DELAY_MS;
  });

  test("returns first successful signature after initial timeout and records race meta", async () => {
    // Plan: a fastest by measurement but times out, then b succeeds
    measureImpl = async (endpoints) =>
      endpoints.map((url) => ({
        url,
        latency: url.includes("rpc-a") ? 10 : url.includes("rpc-b") ? 20 : 30,
      }));

    sendImpl = (url) =>
      new Promise((resolve, reject) => {
        if (url.includes("rpc-a")) {
          // exceeds timeout (60ms) => promiseWithTimeout rejects
          setTimeout(() => resolve("SIG_A"), 120);
        } else if (url.includes("rpc-b")) {
          setTimeout(() => resolve("SIG_B"), 20);
        } else {
          setTimeout(() => reject(new Error("fail_c")), 25);
        }
      });

    const fakeTx = { serialize: () => Buffer.from("00", "hex") };
    const sig = await rpc.sendTransactionRaced(fakeTx, { microBatch: 1 });
    expect(sig).toBe("SIG_B");

    const meta = rpc.getLastSendRaceMeta();
    expect(meta.winner).toBe("http://rpc-b");
    expect(meta.attempts).toBeGreaterThanOrEqual(2);
    expect(typeof meta.latencyMs).toBe("number");
    expect(meta.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("fails over across waves when first endpoint errors and records attempts", async () => {
    // a fastest by measurement but rejects; b succeeds
    measureImpl = async (endpoints) =>
      endpoints.map((url) => ({
        url,
        latency: url.includes("rpc-a") ? 5 : url.includes("rpc-b") ? 10 : 15,
      }));

    sendImpl = (url) =>
      new Promise((resolve, reject) => {
        if (url.includes("rpc-a")) {
          setTimeout(() => reject(new Error("boom_a")), 10);
        } else if (url.includes("rpc-b")) {
          setTimeout(() => resolve("SIG_OK"), 12);
        } else {
          setTimeout(() => reject(new Error("boom_c")), 14);
        }
      });

    const fakeTx = { serialize: () => Buffer.from("00", "hex") };
    const sig = await rpc.sendTransactionRaced(fakeTx, { microBatch: 1 });
    expect(sig).toBe("SIG_OK");

    const meta = rpc.getLastSendRaceMeta();
    expect(meta.winner).toBe("http://rpc-b");
    expect(meta.attempts).toBe(2);
  });

  test("respects backoff by skipping recently failed endpoint on subsequent call", async () => {
    const calls = [];
    measureImpl = async (endpoints) =>
      endpoints.map((url) => ({
        url,
        latency: url.includes("rpc-a") ? 5 : url.includes("rpc-b") ? 10 : 15,
      }));

    // First call: a fails, b succeeds
    sendImpl = (url) =>
      new Promise((resolve, reject) => {
        calls.push(url);
        if (url.includes("rpc-a")) {
          setTimeout(() => reject(new Error("boom_a")), 8);
        } else if (url.includes("rpc-b")) {
          setTimeout(() => resolve("SIG_B1"), 12);
        } else {
          setTimeout(() => reject(new Error("boom_c")), 14);
        }
      });

    const fakeTx = { serialize: () => Buffer.from("00", "hex") };
    calls.length = 0;
    const sig1 = await rpc.sendTransactionRaced(fakeTx, { microBatch: 1 });
    expect(sig1).toBe("SIG_B1");
    expect(calls[0]).toBe("http://rpc-a"); // first attempt used a

    // Second call shortly after: a should be in backoff and skipped, so first attempt is b
    calls.length = 0;
    const sig2 = await rpc.sendTransactionRaced(fakeTx, { microBatch: 1 });
    expect(sig2).toBe("SIG_B1");
    expect(calls[0]).toBe("http://rpc-b");
  });
});
