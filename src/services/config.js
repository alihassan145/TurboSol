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
