import fs from "fs";
import path from "path";
import os from "os";

// Set DATA_DIR to a temp directory for testing
const TMP_DIR = path.join(os.tmpdir(), "turbosol_test_trades");
process.env.DATA_DIR = TMP_DIR;

import { appendTrade, readTrades } from "../src/services/tradeStore.js";

beforeAll(() => {
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }
});

afterAll(() => {
  // Clean up temp directory
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("tradeStore", () => {
  const chatId = "test_chat";
  it("should append and read trades", () => {
    const trade = {
      kind: "buy",
      mint: "So11111111111111111111111111111111111111112",
      sol: 0.5,
    };
    appendTrade(chatId, trade);
    const trades = readTrades(chatId);
    expect(trades.length).toBe(1);
    expect(trades[0].kind).toBe("buy");
    expect(trades[0].sol).toBe(0.5);
  });
});
