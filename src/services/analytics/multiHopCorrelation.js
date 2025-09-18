// Minimal multi-hop correlation module using MongoDB
import { MongoClient } from "mongodb";

let mongoClient;
let edgesCol;

async function getCol() {
  if (edgesCol) return edgesCol;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("Missing MONGODB_URI for multi-hop correlation");
  const dbName = process.env.MONGODB_DB || "turbosol";
  mongoClient = mongoClient || new MongoClient(uri, { ignoreUndefined: true });
  if (!mongoClient.topology || !mongoClient.topology.isConnected()) {
    await mongoClient.connect();
  }
  const db = mongoClient.db(dbName);
  edgesCol = db.collection("address_edges");
  await edgesCol.createIndex({ src: 1, dst: 1 }, { unique: true });
  await edgesCol.createIndex({ src: 1, weight: -1 });
  return edgesCol;
}

// upsert directed edge src -> dst with additive weight
export async function upsertEdge(src, dst, weight = 1) {
  const col = await getCol();
  await col.updateOne(
    { src, dst },
    {
      $setOnInsert: { src, dst, createdAt: new Date() },
      $inc: { weight },
      $set: { updatedAt: new Date() },
    },
    { upsert: true }
  );
}

export async function getTopNeighbors(address, limit = 10) {
  const col = await getCol();
  const cur = col.find({ src: address }).sort({ weight: -1 }).limit(limit);
  return cur.toArray();
}

export async function getMutuals(a, b, limit = 10) {
  const col = await getCol();
  const aOut = await col
    .find({ src: a })
    .project({ dst: 1, weight: 1, _id: 0 })
    .toArray();
  const bOut = await col
    .find({ src: b })
    .project({ dst: 1, weight: 1, _id: 0 })
    .toArray();
  const map = new Map(aOut.map((e) => [e.dst, e.weight]));
  const res = [];
  for (const e of bOut) {
    if (map.has(e.dst)) res.push({ dst: e.dst, weightA: map.get(e.dst), weightB: e.weight });
  }
  res.sort((x, y) => y.weightA + y.weightB - (x.weightA + x.weightB));
  return res.slice(0, limit);
}