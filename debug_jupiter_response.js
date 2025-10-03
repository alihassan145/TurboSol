import https from 'https';
import { URL } from 'url';

const JUP_QUOTE_URL = "https://quote-api.jup.ag/v6/quote";
const NATIVE_SOL = "So11111111111111111111111111111111111111112";

function makeRequest(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      timeout: 5000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    req.end();
  });
}

async function testJupiterResponse() {
  const params = new URLSearchParams({
    inputMint: NATIVE_SOL,
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC - should have liquidity
    amount: "1000000000", // 1 SOL
    slippageBps: "100",
    onlyDirectRoutes: "false",
    asLegacyTransaction: "false"
  });

  const url = `${JUP_QUOTE_URL}?${params}`;
  console.log("Testing Jupiter API with USDC (should work)...");
  console.log("URL:", url);

  try {
    const response = await makeRequest(url);
    console.log("Status:", response.status);
    console.log("Response structure:");
    console.log(JSON.stringify(response.data, null, 2));
    
    if (response.data && typeof response.data === 'object') {
      console.log("\nResponse analysis:");
      console.log("Has outAmount:", !!response.data.outAmount);
      console.log("Has routePlan:", !!response.data.routePlan);
      console.log("Has priceImpactPct:", !!response.data.priceImpactPct);
      console.log("Has error:", !!response.data.error);
      console.log("Has errorCode:", !!response.data.errorCode);
      console.log("Object keys:", Object.keys(response.data));
    }
  } catch (error) {
    console.log("Error:", error.message);
  }
}

testJupiterResponse();
