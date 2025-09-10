let priorityFeeLamports = process.env.DEFAULT_PRIORITY_FEE_LAMPORTS
  ? Number(process.env.DEFAULT_PRIORITY_FEE_LAMPORTS)
  : undefined;
let useJitoBundle = false;

export function getPriorityFeeLamports() {
  return priorityFeeLamports;
}

export function setPriorityFeeLamports(value) {
  if (value === undefined || value === null || Number.isNaN(Number(value))) {
    priorityFeeLamports = undefined;
  } else {
    priorityFeeLamports = Number(value);
  }
  return priorityFeeLamports;
}

export function getUseJitoBundle() {
  return useJitoBundle;
}

export function setUseJitoBundle(value) {
  useJitoBundle = Boolean(value);
  return useJitoBundle;
}

// Add: watcher control via env switches
let watchersPaused =
  String(process.env.WATCHERS_PAUSED || "").toLowerCase() === "true" ||
  process.env.WATCHERS_PAUSED === "1";
let watchersSlowMs = Number(process.env.WATCHERS_SLOW_MS || 0);

export function getWatchersPaused() {
  return watchersPaused;
}
export function setWatchersPaused(v) {
  watchersPaused = Boolean(v);
  return watchersPaused;
}
export function getWatchersSlowMs() {
  return watchersSlowMs;
}
export function setWatchersSlowMs(v) {
  const n = Number(v);
  watchersSlowMs = Number.isFinite(n) && n >= 0 ? n : 0;
  return watchersSlowMs;
}
