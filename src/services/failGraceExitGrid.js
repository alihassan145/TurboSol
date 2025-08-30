import { Connection, PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

const CONFIG_FILE = './data/exit_grid_config.json';

class FailGraceExitGrid extends EventEmitter {
  constructor(connection, wallet) {
    super();
    this.connection = connection;
    this.wallet = wallet;
    this.isRunning = false;
    this.monitorInterval = null;
    this.positions = new Map();
    this.exitRules = new Map();
    this.alertThresholds = new Map();
    this.exitHistory = [];
    this.config = this.loadConfig();
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    
    await this.loadPositions();
    this.startMonitoring();
    
    console.log('🛡️ Fail-grace exit grid started');
  }

  stop() {
    this.isRunning = false;
    if (this.monitorInterval) clearInterval(this.monitorInterval);
    this.saveExitHistory();
    console.log('🛡️ Fail-grace exit grid stopped');
  }

  loadConfig() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const data = fs.readFileSync(CONFIG_FILE, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.error('❌ Failed to load exit grid config:', error.message);
    }

    return {
      defaultStopLoss: -0.05, // -5%
      defaultTakeProfit: 0.2, // 20%
      trailingStopLoss: 0.15, // 15%
      maxPositionSize: 0.1, // 10% of portfolio
      emergencyExitThreshold: -0.1, // -10%
      partialExitLevels: [
        { profit: 0.5, exitPercent: 0.25 }, // 50% profit = sell 25%
        { profit: 1.0, exitPercent: 0.5 },  // 100% profit = sell 50%
        { profit: 2.0, exitPercent: 0.75 }  // 200% profit = sell 75%
      ],
      liquidityDrainThreshold: 0.3, // 30% liquidity drop
      timeBasedExits: {
        maxHoldTime: 24 * 60 * 60 * 1000, // 24 hours
        scalpingTime: 5 * 60 * 1000, // 5 minutes
        swingTime: 4 * 60 * 60 * 1000 // 4 hours
      }
    };
  }

  saveConfig() {
    try {
      const dir = path.dirname(CONFIG_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
    } catch (error) {
      console.error('❌ Failed to save exit grid config:', error.message);
    }
  }

  async loadPositions() {
    try {
      // Load from storage or initialize empty
      this.positions.clear();
      console.log('📊 Positions loaded');
    } catch (error) {
      console.error('❌ Failed to load positions:', error.message);
    }
  }

  startMonitoring() {
    this.monitorInterval = setInterval(async () => {
      if (!this.isRunning) return;
      
      try {
        await this.monitorPositions();
        await this.checkExitTriggers();
      } catch (error) {
        console.error('❌ Exit grid monitoring error:', error.message);
      }
    }, 2000); // Check every 2 seconds
  }

  addPosition(token, position) {
    const positionData = {
      token,
      entryPrice: position.entryPrice,
      quantity: position.quantity,
      entryTime: Date.now(),
      stopLoss: position.stopLoss || this.config.defaultStopLoss,
      takeProfit: position.takeProfit || this.config.defaultTakeProfit,
      maxPositionSize: position.maxPositionSize || this.config.maxPositionSize,
      currentPrice: position.entryPrice,
      unrealizedPNL: 0,
      exitRules: this.generateExitRules(position),
      alerts: [],
      status: 'active'
    };

    this.positions.set(token, positionData);
    this.emit('position_added', positionData);
    
    console.log(`📈 Added position: ${token} @ $${position.entryPrice}`);
    return positionData;
  }

  generateExitRules(position) {
    const rules = [];
    
    // Stop loss rule
    rules.push({
      type: 'stop_loss',
      triggerPrice: position.entryPrice * (1 + this.config.defaultStopLoss),
      action: 'full_exit',
      active: true
    });

    // Take profit rule
    rules.push({
      type: 'take_profit',
      triggerPrice: position.entryPrice * (1 + this.config.defaultTakeProfit),
      action: 'partial_exit',
      exitPercent: 0.5,
      active: true
    });

    // Partial exit rules
    this.config.partialExitLevels.forEach(level => {
      rules.push({
        type: 'partial_exit',
        triggerPrice: position.entryPrice * (1 + level.profit),
        action: 'partial_exit',
        exitPercent: level.exitPercent,
        active: true
      });
    });

    // Trailing stop loss
    rules.push({
      type: 'trailing_stop',
      trailPercent: this.config.trailingStopLoss,
      action: 'full_exit',
      active: true
    });

    return rules;
  }

  async monitorPositions() {
    for (const [token, position] of this.positions) {
      if (position.status !== 'active') continue;

      try {
        const currentPrice = await this.getCurrentPrice(token);
        if (!currentPrice) continue;

        position.currentPrice = currentPrice;
        position.unrealizedPNL = (currentPrice - position.entryPrice) / position.entryPrice;
        
        // Update trailing stop
        this.updateTrailingStop(token, currentPrice);
        
        this.emit('position_update', {
          token,
          currentPrice,
          unrealizedPNL: position.unrealizedPNL
        });

      } catch (error) {
        console.error(`❌ Failed to monitor ${token}:`, error.message);
      }
    }
  }

  async checkExitTriggers() {
    for (const [token, position] of this.positions) {
      if (position.status !== 'active') continue;

      const triggers = this.evaluateExitTriggers(position);
      
      for (const trigger of triggers) {
        if (trigger.shouldExit) {
          await this.executeExit(token, trigger);
        }
      }
    }
  }

  evaluateExitTriggers(position) {
    const triggers = [];
    const currentPrice = position.currentPrice;
    const pnl = position.unrealizedPNL;

    // Price-based triggers
    if (pnl <= position.stopLoss) {
      triggers.push({
        type: 'stop_loss',
        shouldExit: true,
        exitPercent: 1.0,
        reason: `Stop loss triggered: ${(pnl * 100).toFixed(2)}%`
      });
    }

    if (pnl >= position.takeProfit) {
      triggers.push({
        type: 'take_profit',
        shouldExit: true,
        exitPercent: 0.5,
        reason: `Take profit triggered: ${(pnl * 100).toFixed(2)}%`
      });
    }

    // Emergency exit
    if (pnl <= this.config.emergencyExitThreshold) {
      triggers.push({
        type: 'emergency',
        shouldExit: true,
        exitPercent: 1.0,
        reason: `Emergency exit: ${(pnl * 100).toFixed(2)}%`
      });
    }

    // Time-based exits
    const holdTime = Date.now() - position.entryTime;
    if (holdTime >= this.config.timeBasedExits.maxHoldTime) {
      triggers.push({
        type: 'time_limit',
        shouldExit: true,
        exitPercent: 1.0,
        reason: `Max hold time reached: ${(holdTime / 3600000).toFixed(1)}h`
      });
    }

    // Liquidity drain detection
    if (this.detectLiquidityDrain(token)) {
      triggers.push({
        type: 'liquidity_drain',
        shouldExit: true,
        exitPercent: 0.8,
        reason: 'Liquidity drain detected'
      });
    }

    return triggers;
  }

  async executeExit(token, trigger) {
    const position = this.positions.get(token);
    if (!position || position.status !== 'active') return;

    try {
      const exitAmount = position.quantity * trigger.exitPercent;
      const exitValue = exitAmount * position.currentPrice;

      const exitOrder = {
        token,
        exitAmount,
        exitPrice: position.currentPrice,
        exitType: trigger.type,
        reason: trigger.reason,
        timestamp: Date.now(),
        pnl: position.unrealizedPNL,
        status: 'executing'
      };

      position.status = 'exiting';
      this.emit('exit_triggered', exitOrder);

      // Simulate execution
      setTimeout(() => {
        this.completeExit(token, exitOrder);
      }, 1000);

      console.log(`🚨 Exit triggered for ${token}: ${trigger.reason}`);

    } catch (error) {
      console.error(`❌ Failed to execute exit for ${token}:`, error.message);
    }
  }

  async completeExit(token, exitOrder) {
    const position = this.positions.get(token);
    if (!position) return;

    try {
      exitOrder.status = 'completed';
      exitOrder.completionTime = Date.now();
      
      // Update position
      position.quantity -= exitOrder.exitAmount;
      if (position.quantity <= 0) {
        position.status = 'closed';
        this.positions.delete(token);
      } else {
        position.status = 'active';
      }

      this.exitHistory.push(exitOrder);
      this.saveExitHistory();

      this.emit('exit_completed', exitOrder);
      console.log(`✅ Exit completed for ${token}: ${exitOrder.exitAmount} tokens`);

    } catch (error) {
      console.error(`❌ Failed to complete exit for ${token}:`, error.message);
    }
  }

  async getCurrentPrice(token) {
    try {
      // Placeholder - implement actual price fetching
      // This would integrate with your price oracle or DEX APIs
      return Math.random() * 10; // Mock price
    } catch (error) {
      console.error(`❌ Failed to get price for ${token}:`, error.message);
      return null;
    }
  }

  detectLiquidityDrain(token) {
    // Placeholder - implement actual liquidity monitoring
    return Math.random() < 0.1; // 10% chance for demo
  }

  updateTrailingStop(token, currentPrice) {
    const position = this.positions.get(token);
    if (!position) return;

    const trailingStopPrice = currentPrice * (1 - this.config.trailingStopLoss);
    
    // Update existing trailing stop rule
    const trailingRule = position.exitRules.find(rule => rule.type === 'trailing_stop');
    if (trailingRule) {
      trailingRule.triggerPrice = Math.max(
        trailingRule.triggerPrice || 0,
        trailingStopPrice
      );
    }
  }

  addAlert(token, alert) {
    const position = this.positions.get(token);
    if (!position) return;

    position.alerts.push({
      ...alert,
      id: Date.now().toString(),
      created: Date.now(),
      triggered: false
    });

    this.emit('alert_added', { token, alert });
  }

  removeAlert(token, alertId) {
    const position = this.positions.get(token);
    if (!position) return;

    position.alerts = position.alerts.filter(alert => alert.id !== alertId);
    this.emit('alert_removed', { token, alertId });
  }

  getPosition(token) {
    return this.positions.get(token);
  }

  getAllPositions() {
    return Array.from(this.positions.values());
  }

  getActivePositions() {
    return Array.from(this.positions.values()).filter(p => p.status === 'active');
  }

  getExitHistory() {
    return this.exitHistory.slice(-50); // Last 50 exits
  }

  getPortfolioSummary() {
    const positions = this.getAllPositions();
    const activePositions = this.getActivePositions();
    
    const totalValue = activePositions.reduce((sum, pos) => 
      sum + (pos.quantity * pos.currentPrice), 0);
    
    const totalUnrealizedPNL = activePositions.reduce((sum, pos) => 
      sum + (pos.unrealizedPNL * pos.quantity * pos.entryPrice), 0);
    
    return {
      totalPositions: positions.length,
      activePositions: activePositions.length,
      totalValue,
      totalUnrealizedPNL,
      averageHoldTime: this.calculateAverageHoldTime(activePositions),
      winRate: this.calculateWinRate()
    };
  }

  calculateAverageHoldTime(positions) {
    if (positions.length === 0) return 0;
    
    const totalHoldTime = positions.reduce((sum, pos) => 
      sum + (Date.now() - pos.entryTime), 0);
    
    return totalHoldTime / positions.length;
  }

  calculateWinRate() {
    if (this.exitHistory.length === 0) return 0;
    
    const profitableExits = this.exitHistory.filter(exit => 
      exit.pnl > 0).length;
    
    return (profitableExits / this.exitHistory.length) * 100;
  }

  saveExitHistory() {
    try {
      const filePath = './data/exit_history.json';
      const dir = path.dirname(filePath);
      
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(filePath, JSON.stringify(this.exitHistory, null, 2));
    } catch (error) {
      console.error('❌ Failed to save exit history:', error.message);
    }
  }

  emergencyExitAll(reason = 'Emergency exit triggered') {
    console.log('🚨 EMERGENCY EXIT ALL POSITIONS');
    
    const activePositions = this.getActivePositions();
    activePositions.forEach(position => {
      this.executeExit(position.token, {
        type: 'emergency',
        shouldExit: true,
        exitPercent: 1.0,
        reason
      });
    });
  }

  getRiskMetrics() {
    const positions = this.getActivePositions();
    
    if (positions.length === 0) {
      return {
        maxDrawdown: 0,
        valueAtRisk: 0,
        sharpeRatio: 0,
        riskLevel: 'low'
      };
    }

    const pnls = positions.map(pos => pos.unrealizedPNL);
    const maxDrawdown = Math.min(...pnls);
    const avgPnl = pnls.reduce((sum, pnl) => sum + pnl, 0) / pnls.length;
    const volatility = Math.sqrt(pnls.reduce((sum, pnl) => sum + Math.pow(pnl - avgPnl, 2), 0) / pnls.length);

    let riskLevel = 'low';
    if (maxDrawdown < -0.05) riskLevel = 'high';
    else if (maxDrawdown < -0.02) riskLevel = 'medium';

    return {
      maxDrawdown,
      valueAtRisk: maxDrawdown * positions.length,
      volatility,
      riskLevel,
      positions: positions.length
    };
  }
}

export default FailGraceExitGrid;