import { getTokenQuote } from "./src/services/trading/jupiter.js";

const NATIVE_SOL = "So11111111111111111111111111111111111111112";

async function testFix() {
  console.log("Testing the Jupiter API fix with enhanced logging...\n");

  const tokens = [
    {
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      name: "USDC (should work)",
    },
    { mint: "B8yZCDqk8AHTZ9vMPjJbVi7HU1rKk1ikHSgQ6QXnpump", name: "Token 1" },
    { mint: "8p2txXCUokzGe6QzBV1SSi8gqifEHDUAYChRNAJdaos", name: "Token 2" },
  ];

  for (const token of tokens) {
    console.log(`\n=== Testing ${token.name}: ${token.mint} ===`);

    try {
      const result = await getTokenQuote({
        inputMint: NATIVE_SOL,
        outputMint: token.mint,
        amountSol: 1,
        slippageBps: 100,
      });

      if (result) {
        console.log("✅ Quote successful!");
        console.log(`Output amount: ${result.outAmountFormatted}`);
        console.log(`Price impact: ${result.priceImpactPct}%`);
        console.log(`Route details:`, result.route ? "Present" : "Missing");
      } else {
        console.log("❌ No route returned (null result)");
      }
    } catch (error) {
      console.log("❌ Error occurred:", error.message);
    }

    console.log("=".repeat(50));
  }
}

testFix().catch(console.error);
