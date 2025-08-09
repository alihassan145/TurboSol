import { Connection } from "@solana/web3.js";

let rpcEndpoints = [];
let rpcGrpcEndpoint = null;
let currentIndex = 0;
let connection = null;

export function initializeRpc() {
  const fromEnv = (process.env.RPC_HTTP_ENDPOINTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const fallback = process.env.SOLANA_RPC_URL
    ? [process.env.SOLANA_RPC_URL]
    : [];
  rpcEndpoints = fromEnv.length ? fromEnv : fallback;
  rpcGrpcEndpoint = process.env.RPC_GRPC_ENDPOINT || null;
  if (rpcEndpoints.length === 0) {
    throw new Error(
      "No RPC endpoints provided. Set RPC_HTTP_ENDPOINTS or SOLANA_RPC_URL"
    );
  }
  currentIndex = 0;
  connection = new Connection(rpcEndpoints[currentIndex], "confirmed");
}

export function getRpcConnection() {
  if (!connection) initializeRpc();
  return connection;
}

export function getGrpcEndpoint() {
  return rpcGrpcEndpoint;
}

export function rotateRpc(reason = "") {
  if (rpcEndpoints.length <= 1) return getRpcConnection();
  currentIndex = (currentIndex + 1) % rpcEndpoints.length;
  connection = new Connection(rpcEndpoints[currentIndex], "confirmed");
  return connection;
}

export function listRpcEndpoints() {
  return rpcEndpoints.map((url, idx) => ({
    url,
    active: idx === currentIndex,
  }));
}

export function addRpcEndpoint(url) {
  if (!url) return listRpcEndpoints();
  if (!rpcEndpoints.includes(url)) rpcEndpoints.push(url);
  if (!connection) connection = new Connection(rpcEndpoints[0], "confirmed");
  return listRpcEndpoints();
}

export function setGrpcEndpoint(url) {
  rpcGrpcEndpoint = url;
  return rpcGrpcEndpoint;
}
