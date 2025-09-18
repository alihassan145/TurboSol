// Minimal funding path analysis with MongoDB
import { MongoClient } from "mongodb";

let mongoClient;
let flowsCol;

async function getCol() {
  if (flowsCol) return flowsCol;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("Missing MONGODB_URI for funding path analysis");
  const dbName = process.env.MONGODB_DB || "turbosol";
  mongoClient = mongoClient || new MongoClient(uri, { ignoreUndefined: true });
  if (!mongoClient.topology || !mongoClient.topology.isConnected()) {
    await mongoClient.connect();
  }
  const db = mongoClient.db(dbName);
  flowsCol = db.collection("funding_flows");
  await flowsCol.createIndex({ dst: 1, ts: -1 });
  await flowsCol.createIndex({ src: 1, ts: -1 });
  return flowsCol;
}

// Record a transfer of native SOL between addresses for graphing paths
export async function recordTransfer({ src, dst, lamports, ts = Date.now(), txid }) {
  const col = await getCol();
  await col.insertOne({ src, dst, lamports, ts, txid });
}

// Get the most recent inbound funding edges for an address
export async function getRecentFunders(address, lookbackMs = 24 * 3600 * 1000, limit = 20) {
  const col = await getCol();
  const since = Date.now() - lookbackMs;
  return col
    .find({ dst: address, ts: { $gte: since } })
    .sort({ ts: -1 })
    .limit(limit)
    .toArray();
}

// BFS up to depth to find funding paths into target wallet
export async function findFundingPaths(target, depth = 3, maxEdges = 500) {
  const col = await getCol();
  const visited = new Set([target]);
  const queue = [{ addr: target, path: [] }];
  const results = [];
  let edgesExplored = 0;
  while (queue.length && results.length < 20 && edgesExplored < maxEdges) {
    const { addr, path } = queue.shift();
    const edges = await col
      .find({ dst: addr })
      .project({ src: 1, lamports: 1, ts: 1, _id: 0 })
      .limit(50)
      .toArray();
    for (const e of edges) {
      edgesExplored++;
      if (visited.has(e.src)) continue;
      visited.add(e.src);
      const next = { addr: e.src, path: [...path, { src: e.src, dst: addr, lamports: e.lamports, ts: e.ts }] };
      results.push(next.path);
      if (path.length + 1 < depth) queue.push(next);
    }
  }
  return results;
}