import { jest } from "@jest/globals";

// Ensure timeout-related env are set BEFORE importing the module so module-scope constants pick them up
process.env.RPC_SEND_TIMEOUT_MS = "60"; // small to trigger timeouts deterministically
process.env.RPC_STAGGER_STEP_MS = "5";
process.env.RPC_INTER_WAVE_DELAY_MS = "10";

// Dynamic ESM mocks must be declared before importing the module under test
let sendImpl;
let measureImpl;
let axiosPost;

jest.unstable_mockModule("../src/services/rpcMonitor.js", () => ({
  measureEndpointsLatency: async (endpoints) => {
    if (typeof measureImpl === "function") return measureImpl(endpoints);
    // default: equal latencies
    return endpoints.map((url, i) => ({ url, latency: 100 + i }));
  },
}));

jest.unstable_mockModule("axios", () => ({
  default: { post: (...args) => axiosPost?.(...args) },
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

describe("sendTransactionRaced with private relay", () => {
  beforeEach(() => {
    rpc.__resetRpcStateForTests();
    process.env.SOLANA_RPC_URL = "";
    process.env.RPC_HTTP_ENDPOINTS = "http://rpc-a, http://rpc-b";
    process.env.RPC_SEND_TIMEOUT_MS = "60";
    process.env.RPC_STAGGER_STEP_MS = "5";
    process.env.RPC_INTER_WAVE_DELAY_MS = "10";
    rpc.initializeRpc();
    axiosPost = undefined;
    sendImpl = undefined;
    measureImpl = undefined;
  });

  afterEach(() => {
    delete process.env.RPC_HTTP_ENDPOINTS;
    delete process.env.RPC_SEND_TIMEOUT_MS;
    delete process.env.RPC_STAGGER_STEP_MS;
    delete process.env.RPC_INTER_WAVE_DELAY_MS;
    delete process.env.PRIVATE_RELAY_ENDPOINT;
    delete process.env.PRIVATE_RELAY_API_KEY;
  });

  test("succeeds via private relay when relay returns success+signature", async () => {
    await withEnv(
      { PRIVATE_RELAY_ENDPOINT: "https://bloxroute.mock" },
      async () => {
        axiosPost = async (url, body, opts) => {
          expect(url).toMatch(/bloxroute\.mock/);
          return { status: 200, data: { ok: true, signature: "RELAY_SIG" } };
        };
        // RPC should not be called if relay succeeds first
        sendImpl = () => Promise.reject(new Error("rpc should not be used"));

        const fakeTx = { serialize: () => Buffer.from("00", "hex") };
        const sig = await rpc.sendTransactionRaced(fakeTx, {
          microBatch: 1,
          usePrivateRelay: true,
        });
        expect(sig).toBe("RELAY_SIG");
      }
    );
  });

  test("falls back to RPC when relay throws error", async () => {
    await withEnv(
      { PRIVATE_RELAY_ENDPOINT: "https://bloxroute.mock" },
      async () => {
        axiosPost = async () => {
          throw new Error("relay_down");
        };
        // make rpc-b succeed fast
        measureImpl = async (endpoints) =>
          endpoints.map((url) => ({
            url,
            latency: url.includes("rpc-b") ? 5 : 20,
          }));
        sendImpl = (url) =>
          new Promise((resolve, reject) => {
            if (url.includes("rpc-b"))
              setTimeout(() => resolve("SIG_RPC_B"), 10);
            else setTimeout(() => reject(new Error("boom_a")), 15);
          });

        const fakeTx = { serialize: () => Buffer.from("00", "hex") };
        const sig = await rpc.sendTransactionRaced(fakeTx, {
          microBatch: 1,
          usePrivateRelay: true,
        });
        expect(sig).toBe("SIG_RPC_B");
      }
    );
  });

  test("falls back to RPC when relay returns non-success", async () => {
    await withEnv(
      { PRIVATE_RELAY_ENDPOINT: "https://webhook.mock" },
      async () => {
        axiosPost = async () => ({ status: 200, data: { ok: false } });
        // rpc b succeeds
        measureImpl = async (endpoints) =>
          endpoints.map((url) => ({
            url,
            latency: url.includes("rpc-b") ? 5 : 20,
          }));
        sendImpl = (url) =>
          new Promise((resolve, reject) => {
            if (url.includes("rpc-b"))
              setTimeout(() => resolve("SIG_RPC_B"), 10);
            else setTimeout(() => reject(new Error("boom_a")), 15);
          });

        const fakeTx = { serialize: () => Buffer.from("00", "hex") };
        const sig = await rpc.sendTransactionRaced(fakeTx, {
          microBatch: 1,
          usePrivateRelay: true,
        });
        expect(sig).toBe("SIG_RPC_B");
      }
    );
  });
});

describe("sendTransactionRaced with Flashbots private relay", () => {
  beforeEach(() => {
    rpc.__resetRpcStateForTests();
    process.env.SOLANA_RPC_URL = "";
    process.env.RPC_HTTP_ENDPOINTS = "http://rpc-a, http://rpc-b";
    process.env.RPC_SEND_TIMEOUT_MS = "60";
    process.env.RPC_STAGGER_STEP_MS = "5";
    process.env.RPC_INTER_WAVE_DELAY_MS = "10";
    rpc.initializeRpc();
    axiosPost = undefined;
    sendImpl = undefined;
    measureImpl = undefined;
  });

  afterEach(() => {
    delete process.env.RPC_HTTP_ENDPOINTS;
    delete process.env.RPC_SEND_TIMEOUT_MS;
    delete process.env.RPC_STAGGER_STEP_MS;
    delete process.env.RPC_INTER_WAVE_DELAY_MS;
    delete process.env.PRIVATE_RELAY_ENDPOINT;
    delete process.env.PRIVATE_RELAY_API_KEY;
    delete process.env.PRIVATE_RELAY_VENDOR;
  });

  test("uses Flashbots vendor path and succeeds without RPC", async () => {
    await withEnv(
      {
        PRIVATE_RELAY_ENDPOINT: "https://relay.flashbots.mock",
        PRIVATE_RELAY_VENDOR: "flashbots",
      },
      async () => {
        axiosPost = async (url, body, opts) => {
          expect(url).toMatch(/flashbots\.mock\/v1\/solana\/submit-bundle$/);
          expect(body && Array.isArray(body.transactions)).toBe(true);
          return {
            status: 200,
            data: { status: "ok", signature: "FLASH_SIG" },
          };
        };
        // RPC should not be called if relay succeeds
        sendImpl = () => Promise.reject(new Error("rpc should not be used"));

        const fakeTx = { serialize: () => Buffer.from("00", "hex") };
        const sig = await rpc.sendTransactionRaced(fakeTx, {
          microBatch: 1,
          usePrivateRelay: true,
        });
        expect(sig).toBe("FLASH_SIG");
      }
    );
  });

  test("falls back to RPC when Flashbots relay errors", async () => {
    await withEnv(
      {
        PRIVATE_RELAY_ENDPOINT: "https://relay.flashbots.mock",
        PRIVATE_RELAY_VENDOR: "flashbots",
      },
      async () => {
        axiosPost = async () => {
          throw new Error("flashbots_down");
        };
        // make rpc-b succeed fast
        measureImpl = async (endpoints) =>
          endpoints.map((url) => ({
            url,
            latency: url.includes("rpc-b") ? 5 : 20,
          }));
        sendImpl = (url) =>
          new Promise((resolve, reject) => {
            if (url.includes("rpc-b"))
              setTimeout(() => resolve("SIG_RPC_B"), 10);
            else setTimeout(() => reject(new Error("boom_a")), 15);
          });

        const fakeTx = { serialize: () => Buffer.from("00", "hex") };
        const sig = await rpc.sendTransactionRaced(fakeTx, {
          microBatch: 1,
          usePrivateRelay: true,
        });
        expect(sig).toBe("SIG_RPC_B");
      }
    );
  });
});
