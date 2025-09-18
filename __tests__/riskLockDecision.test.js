import { jest } from "@jest/globals";

// Dynamic ESM mocks must be declared before importing the module under test
let axiosGet;
let mockParsed;

jest.unstable_mockModule("axios", () => ({
  default: { get: (...args) => axiosGet?.(...args) },
}));

jest.unstable_mockModule("../src/services/wallet.js", () => ({
  getConnection: () => ({
    getParsedAccountInfo: async (_pk) =>
      mockParsed?.() ?? {
        value: { data: { parsed: { info: { mintAuthorityOption: 0, freezeAuthorityOption: 0 } } } },
      },
  }),
}));

const { riskCheckToken } = await import("../src/services/risk.js");

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  const finalize = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (typeof v === "undefined") delete process.env[k];
      else process.env[k] = v;
    }
  };
  const ret = fn();
  return ret?.then?.(finalize, (e) => {
    finalize();
    throw e;
  });
}

describe("riskCheckToken LP lock decisions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    axiosGet = undefined;
    mockParsed = undefined;
  });

  test("blocks when requireLpLock=true and a provider reports unlocked", async () => {
    await withEnv({ RISK_CHECKS_ENABLED: "true" }, async () => {
      axiosGet = async (url) => {
        if (url.includes("rugcheck"))
          return { data: { is_honeypot: false, buyTax: 0, sellTax: 0, lp: { locked: false } } };
        if (url.includes("honeypot.is"))
          return { data: { honeypotResult: { isHoneypot: false }, taxes: { buy: 0, sell: 0 }, liquidity: { locked: true } } };
        if (url.includes("dexscreener")) return { data: { pairs: [] } };
        throw new Error("unexpected axios.get url: " + url);
      };

      const res = await riskCheckToken(
        "DummyMint1111111111111111111111111111111",
        { requireLpLock: true, timeoutMs: 5, cacheMs: 0 }
      );
      expect(res.ok).toBe(false);
      expect(res.reasons.join(" ")).toMatch(/LP not locked|LP lock not verified/);
    });
  });

  test("blocks when requireLpLock=true and no provider verifies a lock", async () => {
    await withEnv({ RISK_CHECKS_ENABLED: "true" }, async () => {
      axiosGet = async (url) => {
        if (url.includes("rugcheck"))
          return { data: { is_honeypot: false, taxes: { buy: 0, sell: 0 } } };
        if (url.includes("honeypot.is"))
          return { data: { honeypotResult: { isHoneypot: false }, taxes: { buy: 0, sell: 0 } } };
        if (url.includes("dexscreener")) return { data: { pairs: [] } };
        throw new Error("unexpected axios.get url: " + url);
      };

      const res = await riskCheckToken(
        "DummyMint2222222222222222222222222222222",
        { requireLpLock: true, timeoutMs: 5, cacheMs: 0 }
      );
      expect(res.ok).toBe(false);
      expect(res.reasons.join(" ")).toMatch(/LP lock not verified|LP not locked/);
    });
  });

  test("passes when requireLpLock=false even if providers are inconclusive", async () => {
    await withEnv({ RISK_CHECKS_ENABLED: "true" }, async () => {
      axiosGet = async (url) => {
        if (url.includes("rugcheck"))
          return { data: { is_honeypot: false, taxes: { buy: 0, sell: 0 } } };
        if (url.includes("honeypot.is"))
          return { data: { honeypotResult: { isHoneypot: false }, taxes: { buy: 0, sell: 0 } } };
        if (url.includes("dexscreener")) return { data: { pairs: [] } };
        throw new Error("unexpected axios.get url: " + url);
      };

      const res = await riskCheckToken(
        "DummyMint3333333333333333333333333333333",
        { requireLpLock: false, timeoutMs: 5, cacheMs: 0 }
      );
      expect(res.ok).toBe(true);
      expect(res.warnings).toBeDefined();
    });
  });
});