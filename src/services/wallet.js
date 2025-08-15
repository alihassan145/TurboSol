import { Keypair, clusterApiUrl } from "@solana/web3.js";
import bs58 from "bs58";
import { getRpcConnection, initializeRpc } from "./rpc.js";
import { getUserWallet, getUserConnection, hasUserWallet } from "./userWallets.js";

let globalConnection;

export async function initializeWallet() {
  initializeRpc();
  globalConnection = getRpcConnection();
  return { connection: globalConnection };
}

// Legacy functions for backward compatibility (uses admin wallet if set)
export function getConnection() {
  if (!globalConnection) throw new Error("Wallet system not initialized");
  return globalConnection;
}

export async function getPublicKey() {
  const secretBase58 = process.env.WALLET_PRIVATE_KEY_BASE58;
  if (!secretBase58) throw new Error("No admin wallet configured");
  const wallet = Keypair.fromSecretKey(bs58.decode(secretBase58));
  return wallet.publicKey.toBase58();
}

export function getWallet() {
  const secretBase58 = process.env.WALLET_PRIVATE_KEY_BASE58;
  if (!secretBase58) throw new Error("No admin wallet configured");
  return Keypair.fromSecretKey(bs58.decode(secretBase58));
}

// New user-specific functions
export async function getUserPublicKey(chatId) {
  if (!(await hasUserWallet(chatId))) {
    throw new Error("User wallet not found. Use /setup to create a wallet.");
  }
  const wallet = await getUserWallet(chatId);
  return wallet.publicKey.toBase58();
}

export function getUserWalletInstance(chatId) {
  return getUserWallet(chatId);
}

export function getUserConnectionInstance(chatId) {
  return getUserConnection(chatId);
}
