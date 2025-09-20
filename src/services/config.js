import dotenv from "dotenv";
dotenv.config();

let staticPriorityFeeLamports = Number(process.env.PRIORITY_FEE_LAMPORTS || 0);
let dynamicPriorityFeeLamports = null; // dynamic override by tip optimizer
let useJitoBundle =
  String(process.env.USE_JITO_BUNDLE || "true").toLowerCase() !== "false";

let watchersPaused = false;
let watchersSlowMs = Number(process.env.WATCHERS_SLOW_MS || 600);

let privateRelayEndpoint = process.env.PRIVATE_RELAY_ENDPOINT || "";
let privateRelayApiKey = process.env.PRIVATE_RELAY_API_KEY || "";
// New: relay vendor selection (auto|jito|bloxroute|flashbots|generic)
let relayVendor = (process.env.PRIVATE_RELAY_VENDOR || "auto").toLowerCase();

export function getPriorityFeeLamports() {
  return dynamicPriorityFeeLamports ?? staticPriorityFeeLamports;
}

export function setPriorityFeeLamports(value) {
  staticPriorityFeeLamports = Number(value || 0);
}

export function setDynamicPriorityFeeLamports(value) {
  if (value == null) {
    dynamicPriorityFeeLamports = null;
  } else {
    dynamicPriorityFeeLamports = Number(value || 0);
  }
}

export function getDynamicPriorityFeeLamports() {
  return dynamicPriorityFeeLamports;
}

export function getUseJitoBundle() {
  return !!useJitoBundle;
}

export function setUseJitoBundle(value) {
  useJitoBundle = !!value;
}

export function getWatchersPaused() {
  return !!watchersPaused;
}

export function setWatchersPaused(value) {
  watchersPaused = !!value;
}

export function getWatchersSlowMs() {
  return watchersSlowMs;
}

export function setWatchersSlowMs(value) {
  watchersSlowMs = Number(value || 0);
}

export function getPrivateRelayEndpoint() {
  return privateRelayEndpoint;
}

export function setPrivateRelayEndpoint(url) {
  privateRelayEndpoint = String(url || "");
}

export function getPrivateRelayApiKey() {
  return privateRelayApiKey;
}

export function setPrivateRelayApiKey(value) {
  privateRelayApiKey = String(value || "");
}

// New: Relay vendor getter/setter
export function getRelayVendor() {
  return relayVendor;
}

export function setRelayVendor(value) {
  const v = String(value || "auto").toLowerCase();
  const allowed = ["auto", "jito", "bloxroute", "flashbots", "generic"];
  relayVendor = allowed.includes(v) ? v : "auto";
}
