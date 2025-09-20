import { decideCopyAction } from "../src/services/watchers/copyTradeMonitor.js";

describe("decideCopyAction", () => {
  test("fixed buy uses amountSOL and applies perTradeCap and dailyCap remaining", () => {
    const followed = {
      mode: "fixed",
      amountSOL: 0.2,
      perTradeCapSOL: 0.1,
      dailyCapSOL: 0.15,
    };
    const res = decideCopyAction({
      eventType: "buy",
      followed,
      dailySpent: 0.05,
      envDefaultDailyCap: 10,
    });
    // amount=0.2 -> perTradeCap 0.1 -> daily remain 0.10 -> final 0.1
    expect(res.execute).toBe(true);
    expect(res.kind).toBe("buy");
    expect(res.amountSol).toBeCloseTo(0.1, 6);
  });

  test("percent buy uses dailyCap% and respects remaining", () => {
    const followed = { mode: "percent", percent: 20, dailyCapSOL: 1 };
    const res = decideCopyAction({
      eventType: "buy",
      followed,
      dailySpent: 0.9,
      envDefaultDailyCap: 5,
    });
    // base=1, 20% => 0.2, remaining=0.1 -> min -> 0.1
    expect(res.execute).toBe(true);
    expect(res.amountSol).toBeCloseTo(0.1, 6);
  });

  test("percent buy falls back to env default daily cap when not set", () => {
    const followed = { mode: "percent", percent: 10 };
    const res = decideCopyAction({
      eventType: "buy",
      followed,
      dailySpent: 0,
      envDefaultDailyCap: 2,
    });
    expect(res.execute).toBe(true);
    expect(res.amountSol).toBeCloseTo(0.2, 6);
  });

  test("sell returns percent clamped to [1,100]", () => {
    const followed = { percent: 150 };
    const res = decideCopyAction({
      eventType: "sell",
      followed,
      dailySpent: 0,
    });
    expect(res.execute).toBe(true);
    expect(res.kind).toBe("sell");
    expect(res.percent).toBe(100);
  });

  test("invalid or exhausted daily cap returns execute=false", () => {
    const followed = { mode: "fixed", amountSOL: 0.05, dailyCapSOL: 0.1 };
    const r1 = decideCopyAction({
      eventType: "buy",
      followed,
      dailySpent: 0.1,
    });
    expect(r1.execute).toBe(false);
    expect(r1.reason).toBe("daily_cap_exhausted");

    const r2 = decideCopyAction({
      eventType: "buy",
      followed: { mode: "fixed", amountSOL: 0 },
      dailySpent: 0,
    });
    expect(r2.execute).toBe(false);
    expect(r2.reason).toBe("invalid_amount");
  });
});
