import { Connection } from '@solana/web3.js';
import { EventEmitter } from 'events';

class MultiRPCLatencyRacing extends EventEmitter {
  constructor(rpcEndpoints = []) {
    super();
    this.rpcEndpoints = rpcEndpoints.map(endpoint => ({
      url: endpoint.url,
      name: endpoint.name || endpoint.url,
      weight: endpoint.weight || 1.0,
      timeout: endpoint.timeout || 5000,
      healthy: true,
      latency: 0,
      lastCheck: 0,
      failures: 0,
      totalRequests: 0,
      successfulRequests: 0
    }));
    
    this.isRunning = false;
    this.healthCheckInterval = null;
    this.currentPrimary = null;
    this.fallbackQueue = [];
    this.stats = {
      totalRequests: 0,
      failedRequests: 0,
      avgLatency: 0,
      lastUpdate: 0
    };
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    
    await this.initializeConnections();
    this.startHealthChecks();
    
    console.log('🌐 Multi-RPC latency racing started');
  }

  stop() {
    this.isRunning = false;
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
    console.log('🌐 Multi-RPC latency racing stopped');
  }

  async initializeConnections() {
    console.log('🔧 Initializing RPC connections...');
    
    // Add default RPCs if none provided
    if (this.rpcEndpoints.length === 0) {
      this.rpcEndpoints = [
        {
          url: 'https://api.mainnet-beta.solana.com',
          name: 'Solana Mainnet',
          weight: 1.0,
          timeout: 5000,
          healthy: true,
          latency: 0,
          lastCheck: 0,
          failures: 0,
          totalRequests: 0,
          successfulRequests: 0
        },
        {
          url: 'https://solana-api.projectserum.com',
          name: 'Project Serum',
          weight: 1.2,
          timeout: 5000,
          healthy: true,
          latency: 0,
          lastCheck: 0,
          failures: 0,
          totalRequests: 0,
          successfulRequests: 0
        }
      ];
    }

    // Initial health check
    await this.performHealthCheck();
    this.selectPrimaryRPC();
    
    console.log(`✅ ${this.rpcEndpoints.filter(r => r.healthy).length} RPCs ready`);
  }

  startHealthChecks() {
    this.healthCheckInterval = setInterval(async () => {
      if (!this.isRunning) return;
      
      try {
        await this.performHealthCheck();
        this.selectPrimaryRPC();
        this.emit('health_update', this.getHealthStatus());
      } catch (error) {
        console.error('❌ Health check error:', error.message);
      }
    }, 3000); // Health check every 3 seconds
  }

  async performHealthCheck() {
    const checkPromises = this.rpcEndpoints.map(async (endpoint) => {
      const startTime = Date.now();
      
      try {
        const connection = new Connection(endpoint.url, {
          commitment: 'confirmed',
          confirmTransactionInitialTimeout: endpoint.timeout
        });
        
        // Test with lightweight call
        await Promise.race([
          connection.getSlot(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout')), endpoint.timeout)
          )
        ]);
        
        const latency = Date.now() - startTime;
        
        endpoint.latency = latency;
        endpoint.healthy = true;
        endpoint.lastCheck = Date.now();
        endpoint.failures = 0;
        endpoint.totalRequests++;
        endpoint.successfulRequests++;
        
      } catch (error) {
        endpoint.latency = endpoint.timeout;
        endpoint.healthy = false;
        endpoint.failures++;
        endpoint.totalRequests++;
        
        console.warn(`⚠️ RPC ${endpoint.name} failed: ${error.message}`);
      }
    });

    await Promise.allSettled(checkPromises);
  }

  selectPrimaryRPC() {
    const healthyEndpoints = this.rpcEndpoints.filter(endpoint => endpoint.healthy);
    
    if (healthyEndpoints.length === 0) {
      console.error('❌ No healthy RPC endpoints available');
      this.currentPrimary = null;
      return;
    }

    // Sort by weighted latency
    healthyEndpoints.sort((a, b) => {
      const weightedA = a.latency / a.weight;
      const weightedB = b.latency / b.weight;
      return weightedA - weightedB;
    });

    const newPrimary = healthyEndpoints[0];
    
    if (this.currentPrimary?.url !== newPrimary.url) {
      this.currentPrimary = newPrimary;
      this.emit('primary_changed', newPrimary);
      console.log(`🎯 New primary RPC: ${newPrimary.name} (${newPrimary.latency}ms)`);
    }
  }

  getPrimaryConnection() {
    if (!this.currentPrimary) {
      throw new Error('No healthy RPC endpoint available');
    }
    
    return new Connection(this.currentPrimary.url, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: this.currentPrimary.timeout
    });
  }

  async executeWithLatencyRacing(method, ...args) {
    if (!this.isRunning) {
      throw new Error('RPC racing not started');
    }

    const healthyEndpoints = this.rpcEndpoints.filter(endpoint => endpoint.healthy);
    
    if (healthyEndpoints.length === 0) {
      throw new Error('No healthy RPC endpoints available');
    }

    const startTime = Date.now();
    const promises = healthyEndpoints.map(async (endpoint) => {
      try {
        const connection = new Connection(endpoint.url, {
          commitment: 'confirmed',
          confirmTransactionInitialTimeout: endpoint.timeout
        });
        
        const methodStart = Date.now();
        const result = await connection[method](...args);
        const latency = Date.now() - methodStart;
        
        return {
          endpoint,
          result,
          latency,
          success: true
        };
      } catch (error) {
        return {
          endpoint,
          error: error.message,
          latency: endpoint.timeout,
          success: false
        };
      }
    });

    // Race all promises and take the fastest successful result
    const results = await Promise.allSettled(promises);
    const successfulResults = results
      .filter(r => r.status === 'fulfilled' && r.value.success)
      .map(r => r.value)
      .sort((a, b) => a.latency - b.latency);

    if (successfulResults.length > 0) {
      const fastest = successfulResults[0];
      const totalLatency = Date.now() - startTime;
      
      this.updateStats(totalLatency, true);
      this.emit('request_success', {
        endpoint: fastest.endpoint,
        latency: fastest.latency,
        method,
        totalLatency
      });
      
      return fastest.result;
    }

    // All endpoints failed
    const failedResults = results
      .filter(r => r.status === 'fulfilled' && !r.value.success)
      .map(r => r.value);
    
    this.updateStats(Date.now() - startTime, false);
    this.emit('request_failed', {
      method,
      failures: failedResults
    });

    throw new Error(`All RPC endpoints failed for method ${method}`);
  }

  updateStats(latency, success) {
    this.stats.totalRequests++;
    if (!success) this.stats.failedRequests++;
    
    // Update average latency
    const totalLatency = this.stats.avgLatency * (this.stats.totalRequests - 1) + latency;
    this.stats.avgLatency = totalLatency / this.stats.totalRequests;
    this.stats.lastUpdate = Date.now();
  }

  getHealthStatus() {
    return {
      endpoints: this.rpcEndpoints.map(endpoint => ({
        name: endpoint.name,
        url: endpoint.url,
        healthy: endpoint.healthy,
        latency: endpoint.latency,
        weight: endpoint.weight,
        successRate: endpoint.totalRequests > 0 ? 
          (endpoint.successfulRequests / endpoint.totalRequests) * 100 : 0,
        failures: endpoint.failures
      })),
      currentPrimary: this.currentPrimary,
      healthyCount: this.rpcEndpoints.filter(e => e.healthy).length,
      totalCount: this.rpcEndpoints.length,
      stats: this.stats
    };
  }

  addRPCEndpoint(url, name, weight = 1.0) {
    const exists = this.rpcEndpoints.some(endpoint => endpoint.url === url);
    if (exists) {
      console.warn(`⚠️ RPC endpoint already exists: ${url}`);
      return false;
    }

    const newEndpoint = {
      url,
      name,
      weight,
      timeout: 5000,
      healthy: true,
      latency: 0,
      lastCheck: 0,
      failures: 0,
      totalRequests: 0,
      successfulRequests: 0
    };

    this.rpcEndpoints.push(newEndpoint);
    
    // Immediate health check
    setTimeout(async () => {
      await this.performHealthCheck();
      this.selectPrimaryRPC();
    }, 1000);

    console.log(`✅ Added RPC endpoint: ${name} (${url})`);
    return true;
  }

  removeRPCEndpoint(url) {
    const index = this.rpcEndpoints.findIndex(endpoint => endpoint.url === url);
    if (index === -1) {
      console.warn(`⚠️ RPC endpoint not found: ${url}`);
      return false;
    }

    this.rpcEndpoints.splice(index, 1);
    
    // Re-select primary if needed
    if (this.currentPrimary?.url === url) {
      this.selectPrimaryRPC();
    }

    console.log(`❌ Removed RPC endpoint: ${url}`);
    return true;
  }

  async benchmarkAllEndpoints() {
    console.log('🏁 Starting RPC benchmark...');
    
    const benchmarkPromises = this.rpcEndpoints.map(async (endpoint) => {
      const startTime = Date.now();
      const results = [];
      
      for (let i = 0; i < 5; i++) {
        try {
          const connection = new Connection(endpoint.url);
          const slotStart = Date.now();
          await connection.getSlot();
          const latency = Date.now() - slotStart;
          results.push(latency);
        } catch (error) {
          results.push(endpoint.timeout);
        }
      }
      
      const avgLatency = results.reduce((a, b) => a + b, 0) / results.length;
      const minLatency = Math.min(...results);
      const maxLatency = Math.max(...results);
      
      return {
        endpoint,
        avgLatency,
        minLatency,
        maxLatency,
        samples: results
      };
    });

    const benchmarkResults = await Promise.allSettled(benchmarkPromises);
    const successfulResults = benchmarkResults
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value)
      .sort((a, b) => a.avgLatency - b.avgLatency);

    console.log('📊 RPC Benchmark Results:');
    successfulResults.forEach((result, index) => {
      console.log(`${index + 1}. ${result.endpoint.name}: ${result.avgLatency.toFixed(1)}ms avg (${result.minLatency}-${result.maxLatency}ms)`);
    });

    return successfulResults;
  }

  getStats() {
    return {
      isRunning: this.isRunning,
      primaryRPC: this.currentPrimary?.name,
      healthyEndpoints: this.rpcEndpoints.filter(e => e.healthy).length,
      totalEndpoints: this.rpcEndpoints.length,
      stats: this.stats,
      lastHealthCheck: Math.max(...this.rpcEndpoints.map(e => e.lastCheck))
    };
  }
}

export default MultiRPCLatencyRacing;