// Minimal behavioral profiling module with MongoDB-backed storage
import { MongoClient, MongoServerError } from "mongodb";

let mongoClient;
let profilesCol;

async function getCol() {
  if (profilesCol) return profilesCol;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("Missing MONGODB_URI for behavioral profiling");
  const dbName = process.env.MONGODB_DB || "turbosol";
  mongoClient = mongoClient || new MongoClient(uri, { ignoreUndefined: true });
  if (!mongoClient.topology || !mongoClient.topology.isConnected()) {
    await mongoClient.connect();
  }
  const db = mongoClient.db(dbName);
  profilesCol = db.collection("behavior_profiles");
  await profilesCol.createIndex({ chatId: 1, wallet: 1 }, { unique: true });
  await profilesCol.createIndex({ chatId: 1, "features.lastEventAt": -1 });
  return profilesCol;
}

// Draft event shape used by downstream analytics
// { chatId, wallet, mint, side: 'buy'|'sell', amountSol, txid, blockTimeMs }
export async function recordTradeEvent(evt) {
  const col = await getCol();
  const { chatId, wallet } = evt;
  // Minimal professional upsert that maintains rolling counters and timestamps
  const now = evt.blockTimeMs || Date.now();
  const hour = new Date(now).getHours();

  try {
    await col.updateOne(
      { chatId, wallet },
      {
        $setOnInsert: {
          chatId,
          wallet,
          features: {
            totalBuys: 0,
            totalSells: 0,
            hourHistogram: Array.from({ length: 24 }, () => 0),
            lastEventAt: null,
            interArrivalMsEma: null,
          },
          createdAt: new Date(),
        },
        $inc: {
          "features.totalBuys": evt.side === "buy" ? 1 : 0,
          "features.totalSells": evt.side === "sell" ? 1 : 0,
          ["features.hourHistogram." + hour]: 1,
        },
        $set: { "features.lastEventAt": new Date(now) },
      },
      { upsert: true }
    );
  } catch (err) {
    // Handle potential path conflict arising from legacy documents with non-object `features`
    if (err instanceof MongoServerError && err.code === 40) {
      const baseDoc = {
        chatId,
        wallet,
        features: {
          totalBuys: evt.side === "buy" ? 1 : 0,
          totalSells: evt.side === "sell" ? 1 : 0,
          hourHistogram: Array.from({ length: 24 }, (_, i) =>
            i === hour ? 1 : 0
          ),
          lastEventAt: new Date(now),
          interArrivalMsEma: null,
        },
        createdAt: new Date(),
      };
      // Replace conflicting document entirely to reset structure
      await col.replaceOne({ chatId, wallet }, baseDoc, { upsert: true });
    } else {
      throw err; // rethrow unexpected errors
    }
  }

  // Lightweight inter-arrival EMA update (single doc read+write for accuracy)
  const doc = await col.findOne(
    { chatId, wallet },
    { projection: { features: 1 } }
  );
  if (doc?.features?.lastEventAt) {
    const prev = new Date(doc.features.lastEventAt).getTime();
    const gap = Math.max(0, now - prev);
    const alpha = 0.2; // smoothing factor
    const ema =
      doc.features.interArrivalMsEma == null
        ? gap
        : alpha * gap + (1 - alpha) * doc.features.interArrivalMsEma;
    await col.updateOne(
      { chatId, wallet },
      { $set: { "features.interArrivalMsEma": Math.round(ema) } }
    );
  }
}

export async function getBehaviorProfile(chatId, wallet) {
  const col = await getCol();
  return col.findOne({ chatId, wallet });
}
