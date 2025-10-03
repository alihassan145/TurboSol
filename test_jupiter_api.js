import axios from 'axios';

const JUP_QUOTE_URL = "https://quote-api.jup.ag/v6/quote";
const NATIVE_SOL = "So11111111111111111111111111111111111111112";

async function testJupiterAPI() {
  const tokens = [
    "B8yZCDqk8AHTZ9vMPjJbVi7HU1rKk1ikHSgQ6QXnpump",
    "8p2txXCUokzGe6QzBV1SSi8gqifEHDUAYChRNAJdaos"
  ];
  
  for (const token of tokens) {
    console.log(`\n=== Testing token: ${token} ===`);
    
    const params = {
      inputMint: NATIVE_SOL,
      outputMint: token,
      amount: "1000000000", // 1 SOL in lamports
      slippageBps: 100,
      onlyDirectRoutes: false,
      asLegacyTransaction: false,
    };
    
    try {
      console.log("Making request to Jupiter API...");
      const response = await axios.get(JUP_QUOTE_URL, {
        params,
        timeout: 5000,
        validateStatus: (s) => s >= 200 && s < 500,
      });
      
      console.log(`Status: ${response.status}`);
      console.log("Response data:", JSON.stringify(response.data, null, 2));
      
      // Check if response has expected fields
      const data = response.data;
      if (data) {
        console.log("Has outAmount:", !!data.outAmount);
        console.log("Has routePlan:", !!data.routePlan);
        console.log("Has priceImpactPct:", !!data.priceImpactPct);
        console.log("outAmount value:", data.outAmount);
        console.log("routePlan length:", data.routePlan?.length || 0);
      }
      
    } catch (error) {
      console.log("Error:", error.message);
      if (error.response) {
        console.log("Response status:", error.response.status);
        console.log("Response data:", JSON.stringify(error.response.data, null, 2));
      }
    }
  }
}

testJupiterAPI().catch(console.error);
