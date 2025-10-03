import { getQuoteRaw } from './src/services/trading/jupiter.js';
import axios from 'axios';

// Mock axios to test different response scenarios
const originalAxiosGet = axios.get;

function mockAxiosResponse(data, status = 200) {
  axios.get = jest.fn().mockResolvedValue({
    status,
    data
  });
}

async function testParsingLogic() {
  console.log("Testing Jupiter API response parsing logic...\n");
  
  // Test 1: Valid response with all required fields
  console.log("=== Test 1: Valid response ===");
  mockAxiosResponse({
    outAmount: "1000000",
    routePlan: [
      {
        swapInfo: {
          label: "Raydium",
          ammKey: "test-key"
        }
      }
    ],
    priceImpactPct: "0.5"
  });
  
  try {
    const result = await getQuoteRaw({
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amountRaw: 1000000000,
      slippageBps: 100
    });
    
    console.log("Result:", result ? "✅ Valid response parsed" : "❌ Null returned");
    if (result) {
      console.log("outAmount:", result.outAmount);
      console.log("routePlan length:", result.routePlan?.length);
      console.log("priceImpactPct:", result.priceImpactPct);
    }
  } catch (error) {
    console.log("❌ Error:", error.message);
  }
  
  // Test 2: Response with error
  console.log("\n=== Test 2: Error response ===");
  mockAxiosResponse({
    error: "No routes found",
    errorCode: "NO_ROUTES"
  });
  
  try {
    const result = await getQuoteRaw({
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amountRaw: 1000000000,
      slippageBps: 100
    });
    
    console.log("Result:", result ? "Has result" : "❌ Null returned");
    if (result && result.__error__) {
      console.log("✅ Error properly detected");
      console.log("Error code:", result.errorCode);
      console.log("Error message:", result.errorMessage);
    }
  } catch (error) {
    console.log("❌ Error:", error.message);
  }
  
  // Test 3: Response missing required fields
  console.log("\n=== Test 3: Missing required fields ===");
  mockAxiosResponse({
    someOtherField: "value"
    // Missing outAmount and routePlan
  });
  
  try {
    const result = await getQuoteRaw({
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amountRaw: 1000000000,
      slippageBps: 100
    });
    
    console.log("Result:", result ? "❌ Should be null" : "✅ Correctly returned null");
  } catch (error) {
    console.log("❌ Error:", error.message);
  }
  
  // Test 4: HTTP 400 error
  console.log("\n=== Test 4: HTTP 400 error ===");
  mockAxiosResponse({
    error: "Invalid parameters",
    errorCode: "INVALID_PARAMS"
  }, 400);
  
  try {
    const result = await getQuoteRaw({
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amountRaw: 1000000000,
      slippageBps: 100
    });
    
    console.log("Result:", result ? "Has result" : "❌ Null returned");
    if (result && result.__error__) {
      console.log("✅ HTTP error properly handled");
      console.log("Error code:", result.errorCode);
      console.log("Error message:", result.errorMessage);
    }
  } catch (error) {
    console.log("❌ Error:", error.message);
  }
  
  // Restore original axios
  axios.get = originalAxiosGet;
  
  console.log("\n✅ All parsing logic tests completed!");
}

// Simple jest mock implementation
global.jest = {
  fn: () => ({
    mockResolvedValue: (value) => () => Promise.resolve(value)
  })
};

testParsingLogic().catch(console.error);