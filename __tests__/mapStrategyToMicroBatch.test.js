import { mapStrategyToMicroBatch } from "../src/services/rpc.js";

describe("mapStrategyToMicroBatch", () => {
  test("defaults to 2 for unknown or missing strategy", () => {
    expect(mapStrategyToMicroBatch()).toBe(2);
    expect(mapStrategyToMicroBatch(null)).toBe(2);
    expect(mapStrategyToMicroBatch("standard")).toBe(2);
  });

  test("returns 1 for conservative", () => {
    expect(mapStrategyToMicroBatch("conservative")).toBe(1);
    expect(mapStrategyToMicroBatch("Conservative")).toBe(1);
  });

  test("returns 2 for balanced", () => {
    expect(mapStrategyToMicroBatch("balanced")).toBe(2);
    expect(mapStrategyToMicroBatch("Balanced")).toBe(2);
  });

  test("returns 3 for aggressive", () => {
    expect(mapStrategyToMicroBatch("aggressive")).toBe(3);
    expect(mapStrategyToMicroBatch("AGGRESSIVE")).toBe(3);
  });
});
