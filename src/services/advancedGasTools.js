import { Connection, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { EventEmitter } from "events";
import axios from "axios";
import { simulateTransactionRaced } from "./rpc.js";

class AdvancedGasTools extends EventEmitter {
  constructor(connection, config = {}) {
    super();
    this.connection = connection;
    this.config = {
      baseFee: 5000, // Base fee in microlamports
      maxFee: 100000, // Maximum fee in microlamports
      urgencyMultiplier: 2.5, // Multiplier for urgent transactions
      networkCongestionFactor: 1.0, // Dynamic based on network
      ...config,
    };
    this.isRunning = false;
    this.feeMonitor = null;
    this.congestionData = {
      recentFees: [],
      avgFee: 0,
      congestionLevel: "low",
      lastUpdate: 0,
    };
    this.blockSpaceReservations = new Map();
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    await this.initializeFeeMonitoring();
    this.startFeeUpdates();

    console.log("⚡ Advanced gas tools started");
  }

  stop() {
    this.isRunning = false;
    if (this.feeMonitor) clearInterval(this.feeMonitor);
    console.log("⚡ Advanced gas tools stopped");
  }

  async initializeFeeMonitoring() {
    try {
      await this.updateCongestionData();
      console.log("📊 Fee monitoring initialized");
    } catch (error) {
      console.error("❌ Failed to initialize fee monitoring:", error.message);
    }
  }

  startFeeUpdates() {
    this.feeMonitor = setInterval(async () => {
      if (!this.isRunning) return;

      try {
        await this.updateCongestionData();
        this.emit("fee_update", this.congestionData);
      } catch (error) {
        console.error("❌ Fee update error:", error.message);
      }
    }, 1000); // Update every second
  }

  async updateCongestionData() {
    try {
      // Get recent fee statistics
      const recentBlocks = await this.connection.getRecentPrioritizationFees({
        lockedWritableAccounts: [],
      });

      if (recentBlocks.length > 0) {
        const fees = recentBlocks
          .slice(-20)
          .map((block) => block.prioritizationFee);
        this.congestionData.recentFees = fees;
        this.congestionData.avgFee = Math.round(
          fees.reduce((a, b) => a + b, 0) / fees.length
        );

        // Determine congestion level
        if (this.congestionData.avgFee < 1000) {
          this.congestionData.congestionLevel = "low";
        } else if (this.congestionData.avgFee < 5000) {
          this.congestionData.congestionLevel = "medium";
        } else {
          this.congestionData.congestionLevel = "high";
        }

        this.congestionData.lastUpdate = Date.now();
      }
    } catch (error) {
      console.error("❌ Failed to update congestion data:", error.message);
    }
  }

  calculateOptimalFee(urgency = "normal", txSize = 200) {
    let baseFee = this.congestionData.avgFee || this.config.baseFee;

    // Apply urgency multiplier
    switch (urgency.toLowerCase()) {
      case "low":
        baseFee *= 0.5;
        break;
      case "high":
        baseFee *= this.config.urgencyMultiplier;
        break;
      case "urgent":
        baseFee *= this.config.urgencyMultiplier * 2;
        break;
      default: // normal
        baseFee *= 1.0;
    }

    // Apply network congestion factor
    switch (this.congestionData.congestionLevel) {
      case "low":
        baseFee *= 0.8;
        break;
      case "medium":
        baseFee *= 1.0;
        break;
      case "high":
        baseFee *= 1.5;
        break;
    }

    // Apply transaction size factor
    const sizeFactor = Math.max(0.5, Math.min(2.0, txSize / 200));
    baseFee *= sizeFactor;

    // Ensure within bounds
    baseFee = Math.max(1000, Math.min(this.config.maxFee, Math.round(baseFee)));

    return baseFee;
  }

  async createOptimizedTransaction(
    instructions,
    urgency = "normal",
    options = {}
  ) {
    try {
      const optimalFee = this.calculateOptimalFee(
        urgency,
        options.txSize || 200
      );

      // Create compute budget instructions
      const computeBudgetIx = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: optimalFee,
      });

      const computeUnitLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: options.computeUnits || 200000,
      });

      // Build transaction with optimized fees
      const transaction = new Transaction();
      transaction.add(computeBudgetIx, computeUnitLimitIx, ...instructions);

      return {
        transaction,
        fee: optimalFee,
        urgency,
        congestionLevel: this.congestionData.congestionLevel,
      };
    } catch (error) {
      console.error(
        "❌ Failed to create optimized transaction:",
        error.message
      );
      throw error;
    }
  }

  async reserveBlockSpace(duration = 30000) {
    const reservationId = Date.now().toString();

    try {
      // Create dummy transaction to reserve space
      const dummyTx = new Transaction();
      dummyTx.add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1000 })
      );

      this.blockSpaceReservations.set(reservationId, {
        created: Date.now(),
        duration,
        transaction: dummyTx,
        replaced: false,
      });

      console.log(`🎯 Block space reserved: ${reservationId}`);

      // Auto-cleanup after duration
      setTimeout(() => {
        this.releaseBlockSpace(reservationId);
      }, duration);

      return reservationId;
    } catch (error) {
      console.error("❌ Failed to reserve block space:", error.message);
      return null;
    }
  }

  async replaceReservation(reservationId, realTransaction) {
    const reservation = this.blockSpaceReservations.get(reservationId);
    if (!reservation || reservation.replaced) {
      return false;
    }

    try {
      reservation.replaced = true;
      this.blockSpaceReservations.delete(reservationId);

      console.log(`🔄 Block space reservation replaced: ${reservationId}`);
      this.emit("reservation_replaced", {
        reservationId,
        transaction: realTransaction,
      });

      return true;
    } catch (error) {
      console.error("❌ Failed to replace reservation:", error.message);
      return false;
    }
  }

  releaseBlockSpace(reservationId) {
    const reservation = this.blockSpaceReservations.get(reservationId);
    if (reservation) {
      this.blockSpaceReservations.delete(reservationId);
      console.log(`🗑️ Block space reservation released: ${reservationId}`);
    }
  }

  async sendLatencyOptimizedTransaction(transaction, urgency = "normal") {
    try {
      const optimalFee = this.calculateOptimalFee(urgency);

      // Add compute budget instructions if not present
      if (
        !transaction.instructions.some(
          (ix) =>
            ix.programId.toString() ===
            "ComputeBudget111111111111111111111111111111"
        )
      ) {
        transaction.instructions.unshift(
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: optimalFee,
          }),
          ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 })
        );
      }

      // Create multiple copies with slight variations
      const transactions = this.createLatencyOptimizedCopies(
        transaction,
        urgency
      );

      console.log(
        `🚀 Sending ${transactions.length} latency-optimized transactions`
      );

      return {
        transactions,
        fee: optimalFee,
        urgency,
        strategy: "latency_racing",
      };
    } catch (error) {
      console.error(
        "❌ Failed to send latency optimized transaction:",
        error.message
      );
      throw error;
    }
  }

  createLatencyOptimizedCopies(transaction, urgency) {
    const copies = [];
    const baseFee = this.calculateOptimalFee(urgency);

    // Create 3 copies with different fee strategies
    const strategies = [
      { multiplier: 0.8, label: "conservative" },
      { multiplier: 1.0, label: "standard" },
      { multiplier: 1.3, label: "aggressive" },
    ];

    for (const strategy of strategies) {
      const copy = new Transaction();
      copy.add(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: Math.round(baseFee * strategy.multiplier),
        }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 })
      );
      copy.add(
        ...transaction.instructions.filter(
          (ix) =>
            ix.programId.toString() !==
            "ComputeBudget111111111111111111111111111111"
        )
      );

      copies.push({
        transaction: copy,
        fee: Math.round(baseFee * strategy.multiplier),
        strategy: strategy.label,
      });
    }

    return copies;
  }

  async monitorGasPrices() {
    try {
      const response = await axios.get(
        "https://api.jito.wtf/api/v1/bundles/fee_stats",
        {
          timeout: 5000,
        }
      );

      if (response.data) {
        const jitoFees = response.data;
        this.emit("jito_fees_update", jitoFees);
        return jitoFees;
      }
    } catch (error) {
      console.error("❌ Failed to get Jito fees:", error.message);
    }
    return null;
  }

  async getNetworkHealth() {
    try {
      const slot = await this.connection.getSlot();
      const blockTime = await this.connection.getBlockTime(slot);

      return {
        slot,
        blockTime,
        congestionLevel: this.congestionData.congestionLevel,
        avgFee: this.congestionData.avgFee,
        lastUpdate: this.congestionData.lastUpdate,
        isHealthy: Date.now() - this.congestionData.lastUpdate < 5000,
      };
    } catch (error) {
      console.error("❌ Failed to get network health:", error.message);
      return {
        isHealthy: false,
        error: error.message,
      };
    }
  }

  getFeeStats() {
    return {
      recentFees: this.congestionData.recentFees,
      avgFee: this.congestionData.avgFee,
      minFee: Math.min(...this.congestionData.recentFees),
      maxFee: Math.max(...this.congestionData.recentFees),
      congestionLevel: this.congestionData.congestionLevel,
      reservations: this.blockSpaceReservations.size,
    };
  }

  async simulateTransactionCost(transaction) {
    try {
      // Use multi-RPC raced simulation for robustness and speed
      const strategy = this.config?.rpcStrategy || "balanced";
      const { mapStrategyToMicroBatch } = await import("./rpc.js");
      const simulation = await simulateTransactionRaced(transaction, {
        commitment: "confirmed",
        microBatch: mapStrategyToMicroBatch(strategy),
      });

      return {
        computeUnits: simulation.value?.unitsConsumed || 0,
        fee: simulation.value?.err ? 0 : this.calculateOptimalFee(),
        success: !simulation.value?.err,
        logs: simulation.value?.logs || [],
      };
    } catch (error) {
      console.error("❌ Failed to simulate transaction:", error.message);
      return {
        computeUnits: 0,
        fee: 0,
        success: false,
        error: error.message,
      };
    }
  }

  async getFeeRecommendations() {
    const recommendations = {
      low: this.calculateOptimalFee("low"),
      normal: this.calculateOptimalFee("normal"),
      high: this.calculateOptimalFee("high"),
      urgent: this.calculateOptimalFee("urgent"),
    };

    return {
      recommendations,
      congestionLevel: this.congestionData.congestionLevel,
      lastUpdate: this.congestionData.lastUpdate,
    };
  }
}

export default AdvancedGasTools;
