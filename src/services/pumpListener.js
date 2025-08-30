import axios from 'axios';
import { EventEmitter } from 'events';

const PUMP_API = 'https://frontend-api.pump.fun';

class PumpListener extends EventEmitter {
  constructor() {
    super();
    this.isRunning = false;
    this.lastCheck = 0;
    this.seenMints = new Set();
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastCheck = Date.now();
    
    console.log('🚀 Pump.fun listener started');
    this.poll();
  }

  stop() {
    this.isRunning = false;
    console.log('🚀 Pump.fun listener stopped');
  }

  async poll() {
    while (this.isRunning) {
      try {
        const response = await axios.get(`${PUMP_API}/coins/recent`, {
          timeout: 5000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; TurboSol/1.0)'
          }
        });

        const coins = response.data || [];
        const newLaunches = coins.filter(coin => {
          const created = new Date(coin.created_timestamp).getTime();
          return created > this.lastCheck && !this.seenMints.has(coin.mint);
        });

        for (const coin of newLaunches) {
          this.seenMints.add(coin.mint);
          
          const launchData = {
            mint: coin.mint,
            name: coin.name,
            symbol: coin.symbol,
            creator: coin.creator,
            marketCap: coin.usd_market_cap || 0,
            createdAt: coin.created_timestamp,
            description: coin.description || '',
            twitter: coin.twitter || '',
            telegram: coin.telegram || '',
            website: coin.website || '',
            image: coin.image_uri || ''
          };

          console.log(`🎯 New Pump.fun launch: ${coin.symbol} (${coin.name})`);
          this.emit('new_launch', launchData);
        }

        this.lastCheck = Date.now();
        
      } catch (error) {
        console.error('❌ Pump listener error:', error.message);
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  async getCoinDetails(mint) {
    try {
      const response = await axios.get(`${PUMP_API}/coins/${mint}`);
      return response.data;
    } catch (error) {
      console.error('❌ Failed to get coin details:', error.message);
      return null;
    }
  }

  async getTrendingCoins() {
    try {
      const response = await axios.get(`${PUMP_API}/coins/trending`);
      return response.data || [];
    } catch (error) {
      console.error('❌ Failed to get trending coins:', error.message);
      return [];
    }
  }
}

export default PumpListener;