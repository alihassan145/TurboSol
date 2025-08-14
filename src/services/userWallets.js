import { Keypair, Connection } from "@solana/web3.js";
import bs58 from "bs58";
import crypto from "crypto";

// In-memory storage (replace with your database)
const userWallets = new Map();
const userConnections = new Map();

function getKey() {
  const keyHex = process.env.WALLET_ENCRYPTION_KEY;
  if (!keyHex) {
    throw new Error("WALLET_ENCRYPTION_KEY not set in environment");
  }
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) {
    throw new Error("WALLET_ENCRYPTION_KEY must be 32-byte hex (64 hex chars)");
  }
  return key;
}

function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  return iv.toString("hex") + ":" + enc.toString("hex");
}

function decrypt(ciphertext) {
  const [ivHex, dataHex] = ciphertext.split(":");
  const key = getKey();
  const iv = Buffer.from(ivHex, "hex");
  const data = Buffer.from(dataHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString("utf8");
}

export async function createUserWallet(chatId) {
  // Generate new keypair for user
  const keypair = Keypair.generate();
  const privateKeyBase58 = bs58.encode(keypair.secretKey);

  // Encrypt and store private key
  const encryptedPrivateKey = encrypt(privateKeyBase58);

  // Store in database (using Map for demo - replace with DB)
  userWallets.set(chatId.toString(), {
    encryptedPrivateKey,
    publicKey: keypair.publicKey.toBase58(),
    createdAt: new Date()
  });
  
  return {
    publicKey: keypair.publicKey.toBase58(),
    privateKey: privateKeyBase58 // Return for initial setup only
  };
}

export async function getUserWallet(chatId) {
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

export async function importUserWallet(chatId, privateKeyBase58) {
  try {
    // Validate the private key
    const keypair = Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
    
    // Encrypt and store
    const encryptedPrivateKey = encrypt(privateKeyBase58);
    
    userWallets.set(chatId.toString(), {
      encryptedPrivateKey,
      publicKey: keypair.publicKey.toBase58(),
      createdAt: new Date(),
      imported: true
    });
    
    return keypair.publicKey.toBase58();
  } catch (error) {
    throw new Error("Invalid private key format");
  }
}

export function hasUserWallet(chatId) {
  return userWallets.has(chatId.toString());
}

export async function getUserPublicKey(chatId) {
  const walletData = userWallets.get(chatId.toString());
  return walletData?.publicKey || null;
}

export function getUserConnection(chatId) {
  if (!userConnections.has(chatId.toString())) {
    // Create connection for user (you can customize RPC per user)
    const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
    userConnections.set(chatId.toString(), new Connection(rpcUrl, "confirmed"));
  }
  return userConnections.get(chatId.toString());
}

export function deleteUserWallet(chatId) {
  userWallets.delete(chatId.toString());
  userConnections.delete(chatId.toString());
}

// Database integration helpers (implement based on your DB choice)
export async function saveToDatabase() {
  // TODO: Implement database save
  // Example: await db.collection('wallets').insertMany([...userWallets.entries()]);
}

export async function loadFromDatabase() {
  // TODO: Implement database load
  // Example: const wallets = await db.collection('wallets').find().toArray();
}