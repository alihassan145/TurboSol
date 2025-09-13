import {
  getConnection,
  getWallet,
  getUserWalletInstance,
  getUserConnectionInstance,
} from "./wallet.js";
import { getUserPublicKey } from "./userWallets.js";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import axios from "axios";

// In-memory caches for efficiency
const _tokenListCacheByChat = new Map(); // chatId -> { ts, items }
const _tokenMetaCache = new Map(); // mint -> { ts, symbol, name }
const TOKEN_LIST_TTL_MS = Number(process.env.TOKEN_LIST_TTL_MS || 20000);
const TOKEN_META_TTL_MS = Number(process.env.TOKEN_META_TTL_MS || 3600_000);
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqUfnv3V9xRpxo3cLZg1VbG7sWXeDaD7B";

async function getTokenMeta(mint) {
  const now = Date.now();
  const cached = _tokenMetaCache.get(mint);
  if (cached && now - cached.ts < TOKEN_META_TTL_MS) return { symbol: cached.symbol, name: cached.name };
  try {
    const timeoutMs = Number(process.env.DEXSCREENER_TIMEOUT_MS || 1200);
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const res = await axios.get(url, { timeout: timeoutMs, validateStatus: (s) => s >= 200 && s < 500 });
    const pair = Array.isArray(res?.data?.pairs) && res.data.pairs.length ? res.data.pairs[0] : null;
    const symbol = pair?.baseToken?.symbol || undefined;
    const name = pair?.baseToken?.name || undefined;
    _tokenMetaCache.set(mint, { ts: now, symbol, name });
    return { symbol, name };
  } catch {
    _tokenMetaCache.set(mint, { ts: now, symbol: undefined, name: undefined });
    return { symbol: undefined, name: undefined };
  }
}

export async function getWalletSellTokens(chatId) {
  // Return cached if fresh
  const now = Date.now();
  const cached = _tokenListCacheByChat.get(chatId);
  if (cached && now - cached.ts < TOKEN_LIST_TTL_MS) return cached.items;

  // Use global connection for reliability
  const connection = getConnection();
  const ownerBase58 = await getUserPublicKey(chatId);
  if (!ownerBase58) {
    return [];
  }
  const owner = new PublicKey(ownerBase58);

  // Fetch all SPL token accounts owned by user for both programs
  let resp1, resp2;
  try {
    resp1 = await connection.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey(TOKEN_PROGRAM_ID) });
  } catch {}
  try {
    resp2 = await connection.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey(TOKEN_2022_PROGRAM_ID) });
  } catch {}
  const combined = [
    ...((resp1 && resp1.value) || []),
    ...((resp2 && resp2.value) || []),
  ];

  const byMint = new Map();
  for (const { account } of combined) {
    const info = account?.data?.parsed?.info;
    const amount = info?.tokenAmount?.amount;
    const decimals = info?.tokenAmount?.decimals ?? 0;
    const mint = info?.mint;
    if (!mint || !amount) continue;
    const raw = Number(amount);
    if (!Number.isFinite(raw)) continue;
    const prev = byMint.get(mint) || { raw: 0, decimals };
    byMint.set(mint, { raw: prev.raw + raw, decimals });
  }

  // Build items (filter non-zero)
  const items = [];
  for (const [mint, { raw, decimals }] of byMint.entries()) {
    if (raw <= 0) continue;
    const uiAmount = raw / Math.pow(10, Math.max(0, decimals));
    if (uiAmount <= 0) continue;
    const meta = await getTokenMeta(mint);
    items.push({ mint, uiAmount, decimals, symbol: meta.symbol, name: meta.name });
  }

  // Sort by descending uiAmount for nicer UX
  items.sort((a, b) => b.uiAmount - a.uiAmount);

  // Only cache non-empty results to avoid stale empty state
  if (items.length > 0) {
    _tokenListCacheByChat.set(chatId, { ts: now, items });
  }
  return items;
}

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
    const timeoutMs = Number(process.env.PRICE_API_TIMEOUT_MS || 1500);
    const response = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { timeout: timeoutMs, validateStatus: (s) => s >= 200 && s < 500 }
    );
    const usd = response?.data?.solana?.usd;
    return Number.isFinite(usd) ? usd : null;
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
