import { getTokenQuote, performSwap } from './src/services/trading/jupiter.js';

// Test tokens
const testTokens = [
  {
    mint: 'So11111111111111111111111111111111111111112', // SOL
    name: 'SOL'
  },
  {
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    name: 'USDC'
  }
];

async function testUpdatedJupiterAPI() {
  console.log('🧪 Testing Updated Jupiter API Implementation');
  console.log('='.repeat(50));

  // Test 1: Quote functionality
  console.log('\n📊 Testing Quote Functionality:');
  
  for (const inputToken of testTokens) {
    for (const outputToken of testTokens) {
      if (inputToken.mint === outputToken.mint) continue;
      
      console.log(`\n🔄 Testing ${inputToken.name} → ${outputToken.name}:`);
      
      try {
        const quoteResult = await getTokenQuote({
          inputMint: inputToken.mint,
          outputMint: outputToken.mint,
          amountSol: 0.01, // Small test amount
          slippageBps: 100
        });
        
        if (quoteResult && quoteResult.route) {
          console.log(`  ✅ Quote successful`);
          console.log(`  💰 Output Amount: ${quoteResult.route.outAmount}`);
          console.log(`  📈 Price Impact: ${quoteResult.route.priceImpactPct}%`);
          console.log(`  🛣️  Route Plan: ${quoteResult.route.routePlan?.length || 0} steps`);
        } else {
          console.log(`  ❌ No route found`);
        }
      } catch (error) {
        console.log(`  🚨 Error: ${error.message}`);
      }
    }
  }

  // Test 2: API Response Structure
  console.log('\n🔍 Testing API Response Structure:');
  
  try {
    const quoteResult = await getTokenQuote({
      inputMint: 'So11111111111111111111111111111111111111112', // SOL
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      amountSol: 0.1,
      slippageBps: 50
    });
    
    if (quoteResult && quoteResult.route) {
      console.log('  ✅ Response structure validation passed');
      console.log('  📋 Response fields:');
      console.log(`    - inputMint: ${quoteResult.route.inputMint ? '✅' : '❌'}`);
      console.log(`    - outputMint: ${quoteResult.route.outputMint ? '✅' : '❌'}`);
      console.log(`    - inAmount: ${quoteResult.route.inAmount ? '✅' : '❌'}`);
      console.log(`    - outAmount: ${quoteResult.route.outAmount ? '✅' : '❌'}`);
      console.log(`    - routePlan: ${quoteResult.route.routePlan ? '✅' : '❌'}`);
      console.log(`    - priceImpactPct: ${quoteResult.route.priceImpactPct !== undefined ? '✅' : '❌'}`);
      console.log(`    - slippageBps: ${quoteResult.route.slippageBps ? '✅' : '❌'}`);
    } else {
      console.log('  ❌ No valid response received');
    }
  } catch (error) {
    console.log(`  🚨 Structure test error: ${error.message}`);
  }

  console.log('\n🏁 Test completed!');
}

// Run the test
testUpdatedJupiterAPI().catch(console.error);