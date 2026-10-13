export function errorDetails(error) {
  if (!error) return null;
  return {
    name: error.name ?? null,
    message: error.message ?? String(error),
    code: error.code ?? null,
    errno: error.errno ?? null,
    syscall: error.syscall ?? null,
    stack: error.stack ?? null,
  };
}

export function boundedDuration(value, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

export function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
