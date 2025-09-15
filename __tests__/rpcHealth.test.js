import { jest } from "@jest/globals";
import {
  __resetRpcStateForTests,
  initializeRpc,
  listRpcEndpoints,
  startRpcHealthLoop,
  stopRpcHealthLoop,
  getRpcStatus,
} from "../src/services/rpc.js";

// Helper to wait some ms
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForActiveUrl(expected, timeoutMs = 1500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = getRpcStatus();
    if (status.activeUrl === expected) return status;
    await wait(50);
  }
  return getRpcStatus();
}

describe("RPC health loop", () => {
  beforeEach(() => {
    __resetRpcStateForTests();
    process.env.SOLANA_RPC_URL = "";
    process.env.RPC_HTTP_ENDPOINTS = "http://rpc-a, http://rpc-b, http://rpc-c";
  });

  afterEach(() => {
    stopRpcHealthLoop();
    delete process.env.RPC_HTTP_ENDPOINTS;
  });

  test("rotates to the fastest endpoint based on measured latency", async () => {
    // Initialize from env
    initializeRpc();
    const endpoints = listRpcEndpoints();
    expect(endpoints).toEqual(["http://rpc-a", "http://rpc-b", "http://rpc-c"]);

    // Mock measure function: returns fixed latencies (b fastest)
    const measureFn = async (urls) => {
      return urls.map((url, i) => ({
        url,
        latency: i === 0 ? 500 : i === 1 ? 50 : 80,
      }));
    };

    startRpcHealthLoop({ intervalMs: 150, measureFn });

    const status = await waitForActiveUrl("http://rpc-b", 1200);
    expect(status.activeUrl).toBe("http://rpc-b"); // rpc-b expected fastest
    expect(status.endpoints.length).toBeGreaterThanOrEqual(3);
    // Ensure stats captured
    const active = status.endpoints.find((e) => e.url === status.activeUrl);
    expect(active.lastMeasuredLatency).toBe(50);
  });

  test("handles errors in measure function gracefully", async () => {
    initializeRpc();
    startRpcHealthLoop({
      intervalMs: 150,
      measureFn: async () => {
        throw new Error("boom");
      },
    });
    await wait(350);
    const status = getRpcStatus();
    // Still returns structure even if nothing measured
    expect(status.endpoints.length).toBeGreaterThan(0);
  });
});
