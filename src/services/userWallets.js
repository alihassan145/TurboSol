import { Keypair, Connection } from "@solana/web3.js";
import bs58 from "bs58";
import crypto from "crypto";
import { MongoClient, ObjectId } from "mongodb";

// In-memory storage (fallback)
const userWallets = new Map();
const userConnections = new Map();

let mongoClient;
let walletsCol;

export async function connectWalletsDb() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || "turbosol";
  if (!uri) return; // allow app to run without DB
  if (mongoClient && walletsCol) return; // already connected
  mongoClient = new MongoClient(uri, { ignoreUndefined: true });
  await mongoClient.connect();
  const db = mongoClient.db(dbName);
  walletsCol = db.collection("wallets");
  await walletsCol.createIndex({ chatId: 1 });
}

function getKey() {
  const keyHex = process.env.WALLET_ENCRYPTION_KEY;
  if (!keyHex) return null; // allow dev fallback without encryption
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) {
    throw new Error("WALLET_ENCRYPTION_KEY must be 32-byte hex (64 hex chars)");
  }
  return key;
}

function encrypt(plaintext) {
  const key = getKey();
  if (!key) {
    // Dev fallback: store plaintext with marker; NOT for production use
    return "plain:" + plaintext;
  }
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const enc = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);
  return iv.toString("hex") + ":" + enc.toString("hex");
}

function decrypt(ciphertext) {
  if (ciphertext?.startsWith("plain:")) {
    // Dev fallback decoding
    return ciphertext.slice(6);
  }
  const parts = ciphertext.split(":");
  if (parts.length !== 2) {
    throw new Error("Invalid ciphertext format");
  }
  const [ivHex, dataHex] = parts;
  const key = getKey();
  if (!key) {
    throw new Error("WALLET_ENCRYPTION_KEY not set");
  }
  const iv = Buffer.from(ivHex, "hex");
  const data = Buffer.from(dataHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString("utf8");
}

// Helpers
async function getDbWallets(chatId) {
  if (!walletsCol) return null;
  const docs = await walletsCol
    .find({ chatId: chatId.toString(), deletedAt: { $exists: false } })
    .toArray();
  return docs;
}

async function setActiveInDb(chatId, walletId) {
  if (!walletsCol) return;
  await walletsCol.updateMany(
    { chatId: chatId.toString(), active: true },
    { $set: { active: false } }
  );
  await walletsCol.updateOne(
    { _id: new ObjectId(walletId) },
    { $set: { active: true } }
  );
}

export async function createUserWallet(chatId, name = "Wallet 1") {
  const keypair = Keypair.generate();
  const privateKeyBase58 = bs58.encode(keypair.secretKey);
  const encryptedPrivateKey = encrypt(privateKeyBase58);

  if (walletsCol) {
    const doc = {
      chatId: chatId.toString(),
      name,
      encryptedPrivateKey,
      publicKey: keypair.publicKey.toBase58(),
      createdAt: new Date(),
      imported: false,
      active: true,
    };
    // make others inactive
    await walletsCol.updateMany(
      { chatId: chatId.toString(), active: true },
      { $set: { active: false } }
    );
    const res = await walletsCol.insertOne(doc);
    return {
      id: res.insertedId.toString(),
      publicKey: doc.publicKey,
      privateKey: privateKeyBase58,
    };
  }

  // Fallback in-memory (single wallet)
  userWallets.set(chatId.toString(), {
    encryptedPrivateKey,
    publicKey: keypair.publicKey.toBase58(),
    createdAt: new Date(),
    name,
    active: true,
  });
  return {
    publicKey: keypair.publicKey.toBase58(),
    privateKey: privateKeyBase58,
  };
}

export async function importUserWallet(
  chatId,
  privateKeyBase58,
  name = "Imported"
) {
  try {
    const keypair = Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
    const encryptedPrivateKey = encrypt(privateKeyBase58);

    if (walletsCol) {
      await walletsCol.updateMany(
        { chatId: chatId.toString(), active: true },
        { $set: { active: false } }
      );
      const doc = {
        chatId: chatId.toString(),
        name,
        encryptedPrivateKey,
        publicKey: keypair.publicKey.toBase58(),
        createdAt: new Date(),
        imported: true,
        active: true,
      };
      const res = await walletsCol.insertOne(doc);
      return keypair.publicKey.toBase58();
    }

    userWallets.set(chatId.toString(), {
      encryptedPrivateKey,
      publicKey: keypair.publicKey.toBase58(),
      createdAt: new Date(),
      name,
      imported: true,
      active: true,
    });
    return keypair.publicKey.toBase58();
  } catch (error) {
    throw new Error("Invalid private key format");
  }
}

export async function listUserWallets(chatId) {
  if (walletsCol) {
    const docs = await getDbWallets(chatId);
    return docs.map((d) => ({
      id: d._id.toString(),
      name: d.name,
      publicKey: d.publicKey,
      active: !!d.active,
    }));
  }
  const entry = userWallets.get(chatId.toString());
  if (!entry) return [];
  return [
    {
      id: "memory",
      name: entry.name || "Wallet",
      publicKey: entry.publicKey,
      active: true,
    },
  ];
}

export async function setActiveWallet(chatId, walletId) {
  if (walletsCol) {
    await setActiveInDb(chatId, walletId);
    return;
  }
  // in-memory single wallet already active
}

export async function renameUserWallet(chatId, walletId, newName) {
  if (walletsCol) {
    await walletsCol.updateOne(
      { _id: new ObjectId(walletId), chatId: chatId.toString() },
      { $set: { name: newName } }
    );
    return;
  }
  const entry = userWallets.get(chatId.toString());
  if (entry) entry.name = newName;
}

export async function hasUserWallet(chatId) {
  if (walletsCol) {
    const count = await walletsCol.countDocuments({
      chatId: chatId.toString(),
      deletedAt: { $exists: false },
    });
    return count > 0;
  }
  return userWallets.has(chatId.toString());
}

export async function getUserWallet(chatId) {
  if (walletsCol) {
    const docs = await getDbWallets(chatId);
    if (!docs || docs.length === 0)
      throw new Error("User wallet not found. Use /setup to create a wallet.");
    const active = docs.find((d) => d.active) || docs[0];
    const decryptedPrivateKey = decrypt(active.encryptedPrivateKey);
    const keypair = Keypair.fromSecretKey(bs58.decode(decryptedPrivateKey));
    return keypair;
  }

  const walletData = userWallets.get(chatId.toString());
  if (!walletData) {
    throw new Error("User wallet not found. Use /setup to create a wallet.");
  }
  try {
    const decryptedPrivateKey = decrypt(walletData.encryptedPrivateKey);
    const keypair = Keypair.fromSecretKey(bs58.decode(decryptedPrivateKey));
    return keypair;
  } catch (error) {
    throw new Error("Failed to decrypt wallet: " + error.message);
  }
}

export async function getUserPublicKey(chatId) {
  if (walletsCol) {
    const docs = await getDbWallets(chatId);
    const active = docs?.find((d) => d.active) || docs?.[0];
    return active?.publicKey || null;
  }
  const walletData = userWallets.get(chatId.toString());
  return walletData?.publicKey || null;
}

export function getUserConnection(chatId) {
  if (!userConnections.has(chatId.toString())) {
    const rpcUrl =
      process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
    userConnections.set(chatId.toString(), new Connection(rpcUrl, "confirmed"));
  }
  return userConnections.get(chatId.toString());
}

// New: return all wallet keypairs for this user (for multi-wallet split)
export async function getAllUserWalletKeypairs(chatId) {
  if (walletsCol) {
    const docs = await getDbWallets(chatId);
    if (!docs || !docs.length) return [];
    return docs.map((d) => {
      const dec = decrypt(d.encryptedPrivateKey);
      const kp = Keypair.fromSecretKey(bs58.decode(dec));
      return {
        id: d._id.toString(),
        name: d.name,
        publicKey: d.publicKey,
        keypair: kp,
        active: !!d.active,
      };
    });
  }
  const entry = userWallets.get(chatId.toString());
  if (!entry) return [];
  try {
    const dec = decrypt(entry.encryptedPrivateKey);
    const kp = Keypair.fromSecretKey(bs58.decode(dec));
    return [
      {
        id: "memory",
        name: entry.name || "Wallet",
        publicKey: entry.publicKey,
        keypair: kp,
        active: true,
      },
    ];
  } catch (e) {
    return [];
  }
}

// Optionally get a specific wallet by ID
export async function getUserWalletKeypairById(chatId, walletId) {
  if (walletsCol) {
    const docs = await getDbWallets(chatId);
    const d = docs?.find((x) => x._id.toString() === walletId);
    if (!d) return null;
    const dec = decrypt(d.encryptedPrivateKey);
    const kp = Keypair.fromSecretKey(bs58.decode(dec));
    return {
      id: d._id.toString(),
      name: d.name,
      publicKey: d.publicKey,
      keypair: kp,
      active: !!d.active,
    };
  }
  const list = await getAllUserWalletKeypairs(chatId);
  return list.find((x) => x.id === walletId) || null;
}

export function deleteUserWallet(chatId) {
  userConnections.delete(chatId.toString());
  if (walletsCol) {
    // Soft delete all wallets for chat
    return walletsCol.updateMany(
      { chatId: chatId.toString() },
      { $set: { deletedAt: new Date(), active: false } }
    );
  }
  userWallets.delete(chatId.toString());
}

// Database integration placeholders for compatibility
export async function saveToDatabase() {}
export async function loadFromDatabase() {}
