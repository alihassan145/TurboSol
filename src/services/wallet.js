import { Keypair, clusterApiUrl } from "@solana/web3.js";
import bs58 from "bs58";
import { getRpcConnection, initializeRpc } from "./rpc.js";

let connection;
let wallet;

export async function initializeWallet() {
  initializeRpc();
  connection = getRpcConnection();

  const secretBase58 = process.env.WALLET_PRIVATE_KEY_BASE58;
  if (!secretBase58) throw new Error("Missing WALLET_PRIVATE_KEY_BASE58");
  wallet = Keypair.fromSecretKey(bs58.decode(secretBase58));
  return { connection, wallet };
}

export function getConnection() {
  if (!connection) throw new Error("Wallet not initialized");
  return connection;
}

export async function getPublicKey() {
  if (!wallet) throw new Error("Wallet not initialized");
  return wallet.publicKey.toBase58();
}

export function getWallet() {
  if (!wallet) throw new Error("Wallet not initialized");
  return wallet;
}
