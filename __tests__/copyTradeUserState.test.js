import { getUserState, getCopyTradeState, addCopyTradeWallet } from "../src/services/userState.js";

describe("copyTrade userState defaults", () => {
  test("getUserState initializes copyTrade defaults", () => {
    const chatId = 12345;
    const state = getUserState(chatId);
    expect(state.copyTrade).toBeDefined();
    expect(state.copyTrade.enabled).toBe(false);
    expect(Array.isArray(state.copyTrade.followedWallets)).toBe(true);
    expect(state.copyTrade.followedWallets.length).toBe(0);
  });

  test("addCopyTradeWallet normalizes fields with sensible defaults", () => {
    const chatId = 23456;
    addCopyTradeWallet(chatId, { address: "7YFhSg3m4mH4qVQ9fXWm8kP7J7mQw3v7bSgG3kUYt9uQ" });
    const ct = getCopyTradeState(chatId);
    expect(ct.followedWallets.length).toBe(1);
    const w = ct.followedWallets[0];
    expect(w.enabled).toBe(true);
    expect(w.copyBuy).toBe(true);
    expect(w.copySell).toBe(true);
    expect(w.mode).toBe("fixed");
    expect(typeof w.amountSOL).toBe("number");
    expect(w.amountSOL).toBeGreaterThan(0);
    expect(typeof w.percent).toBe("number");
    expect(w.percent).toBeGreaterThan(0);
    // optional caps default to null
    expect(w.perTradeCapSOL === null || typeof w.perTradeCapSOL === "number").toBe(true);
    expect(w.dailyCapSOL === null || typeof w.dailyCapSOL === "number").toBe(true);
    expect(w.slippageBps === null || typeof w.slippageBps === "number").toBe(true);
    expect(w.maxConcurrent === null || typeof w.maxConcurrent === "number").toBe(true);
  });
});