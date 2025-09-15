import { jest } from "@jest/globals";

import {
  __resetRpcStateForTests,
  initializeRpc,
  getParsedTokenAccountsByOwnerRaced,
} from "../src/services/rpc.js";

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (typeof v === "undefined") delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("getParsedTokenAccountsByOwnerRaced", () => {
  beforeEach(() => {
    __resetRpcStateForTests();
  });

  test("returns from the fastest endpoint", async () => {
    await withEnv(
      {
        RPC_HTTP_ENDPOINTS: "http://rpc-a, http://rpc-b, http://rpc-c",
        RPC_STRATEGY_DEFAULT: "balanced",
      },
      async () => {
        initializeRpc();
        const owner = "owner-foo";
        const filters = { programId: "TokenkegQfe..." };
        const calls = [];
        const callImpl = (url) => {
          calls.push(url);
          return new Promise((resolve) => {
            // Ensure rpc-b wins even with stagger (20ms) and jitter by keeping clear separation
            const delay = url.endsWith("a") ? 100 : url.endsWith("b") ? 40 : 60;
            setTimeout(
              () => resolve({ value: [{ url, owner, filters }] }),
              delay
            );
          });
        };
        const res = await getParsedTokenAccountsByOwnerRaced(owner, filters, {
          callImpl,
          microBatch: 2,
        });
        expect(Array.isArray(res?.value)).toBe(true);
        expect(res.value[0].url).toBe("http://rpc-b");
        expect(calls.length).toBeGreaterThan(0);
      }
    );
  });

  test("fails over when the fastest rejects", async () => {
    await withEnv(
      {
        RPC_HTTP_ENDPOINTS: "http://rpc-a, http://rpc-b",
        RPC_STRATEGY_DEFAULT: "aggressive",
      },
      async () => {
        initializeRpc();
        const owner = "owner-bar";
        const filters = { programId: "TokenzQdB..." };
        const callImpl = (url) => {
          if (url.endsWith("a")) {
            return new Promise((_, reject) =>
              setTimeout(() => reject(new Error("boom")), 5)
            );
          }
          return new Promise((resolve) =>
            setTimeout(() => resolve({ value: [{ url, owner, filters }] }), 15)
          );
        };
        const res = await getParsedTokenAccountsByOwnerRaced(owner, filters, {
          callImpl,
          microBatch: 2,
        });
        expect(res?.value?.[0]?.url).toBe("http://rpc-b");
      }
    );
  });

  test("throws when all endpoints fail", async () => {
    await withEnv(
      {
        RPC_HTTP_ENDPOINTS: "http://rpc-a, http://rpc-b",
        RPC_STRATEGY_DEFAULT: "conservative",
      },
      async () => {
        initializeRpc();
        const owner = "owner-baz";
        const filters = { programId: "TokenkegQfe..." };
        const callImpl = () => Promise.reject(new Error("down"));
        await expect(
          getParsedTokenAccountsByOwnerRaced(owner, filters, {
            callImpl,
            microBatch: 1,
          })
        ).rejects.toThrow(/down/i);
      }
    );
  });
});
