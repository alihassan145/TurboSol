import {
  getConnection,
  getWallet,
  getUserWalletInstance,
  getUserConnectionInstance,
} from "./wallet.js";
import { getUserPublicKey } from "./userWallets.js";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import axios from "axios";

export async function getWalletBalance(chatId = null) {
  try {
    let connection, wallet;

    // Always use the global rotating RPC connection for reliability
    connection = getConnection();

    if (chatId !== null) {
      wallet = await getUserWalletInstance(chatId);
    } else {
      wallet = getWallet();
    }

    const balance = await connection.getBalance(wallet.publicKey);
    const solBalance = balance / LAMPORTS_PER_SOL;
    return { solBalance, lamportsBalance: balance };
  } catch (error) {
    return { solBalance: 0, lamportsBalance: 0, error: error.message };
  }
}

export async function getSolPriceUSD() {
  try {
    const response = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
    );
    return response.data.solana.usd;
  } catch (error) {
    return null;
  }
}

export function shortenAddress(address, prefix = 4, suffix = 4) {
  if (!address || address.length <= prefix + suffix) return address;
  return `${address.slice(0, prefix)}...${address.slice(-suffix)}`;
}

export async function getWalletInfo(chatId = null) {
  let address;

  if (chatId !== null) {
    address = await getUserPublicKey(chatId);
  } else {
    const wallet = getWallet();
    address = wallet.publicKey.toBase58();
  }

  const { solBalance } = await getWalletBalance(chatId);
  const solPrice = await getSolPriceUSD();
  const usdBalance = solPrice ? (solBalance * solPrice).toFixed(2) : "N/A";

  return {
    address,
    shortAddress: shortenAddress(address),
    solBalance: solBalance.toFixed(4),
    usdBalance,
    solPrice,
  };
}
