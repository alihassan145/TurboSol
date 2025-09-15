import { computePriorityFeeCap } from "../fees.js";

// Using defaults: thresholds 200/500/800ms and caps 6M/10M/16M/24M with min floor 6M

describe("computePriorityFeeCap", () => {
  test("returns MID cap when latency is invalid or negative", () => {
    expect(computePriorityFeeCap(-1)).toBeGreaterThanOrEqual(6_000_000);
    expect(computePriorityFeeCap(NaN)).toBeGreaterThanOrEqual(6_000_000);
  });

  test("low latency under T1 uses LOW cap (>= min floor)", () => {
    const cap = computePriorityFeeCap(150); // <200ms
    expect(cap).toBeGreaterThanOrEqual(6_000_000);
    expect(cap).toBe(6_000_000);
  });

  test("medium latency under T2 uses MID cap", () => {
    const cap = computePriorityFeeCap(300); // <500ms
    expect(cap).toBe(10_000_000);
  });

  test("high latency under T3 uses HIGH cap", () => {
    const cap = computePriorityFeeCap(600); // <800ms
    expect(cap).toBe(16_000_000);
  });

  test("very high latency uses MAX cap", () => {
    const cap = computePriorityFeeCap(1000); // >=800ms
    expect(cap).toBe(24_000_000);
  });
});
