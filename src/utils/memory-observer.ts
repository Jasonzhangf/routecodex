/**
 * Memory observer — periodic heap diagnostics for leak detection.
 * Logs RSS / heapUsed / external every INTERVAL_MS seconds.
 * Exposes internal store sizes via globalThis for external consumers.
 */

const INTERVAL_MS = 30_000; // 30s
const LOG_PREFIX = '[mem-observer]';

interface StoreMetrics {
  requestMapSize: number;
  responseIndexSize: number;
  scopeIndexSize: number;
}

// Expose raw store for diagnostic access
(globalThis as Record<string, unknown>)['__rccGetMemoryStats'] = getMemoryStats;
(globalThis as Record<string, unknown>)['__rccGetStoreMetrics'] = getStoreMetrics;

function getMemoryStats(): NodeJS.MemoryUsage {
  return process.memoryUsage();
}

function getStoreMetrics(): StoreMetrics | null {
  const store = (globalThis as Record<string, unknown>)['__rccResponsesConversationStore'];
  if (!store || typeof store !== 'object') {
    return null;
  }
  const s = store as { requestMap?: Map<unknown, unknown>; responseIndex?: Map<unknown, unknown>; scopeIndex?: Map<unknown, unknown> };
  return {
    requestMapSize: s.requestMap?.size ?? 0,
    responseIndexSize: s.responseIndex?.size ?? 0,
    scopeIndexSize: s.scopeIndex?.size ?? 0,
  };
}

function formatBytes(mb: number): string {
  return `${mb.toFixed(1)} MB`;
}

function logSnapshot(): void {
  const mem = process.memoryUsage();
  const rssMB = mem.rss / 1024 / 1024;
  const heapUsedMB = mem.heapUsed / 1024 / 1024;
  const heapTotalMB = mem.heapTotal / 1024 / 1024;
  const externalMB = mem.external / 1024 / 1024;

  const storeMetrics = getStoreMetrics();

  const msg = [
    LOG_PREFIX,
    `rss=${formatBytes(rssMB)}`,
    `heapUsed=${formatBytes(heapUsedMB)}/${formatBytes(heapTotalMB)}`,
    `external=${formatBytes(externalMB)}`,
  ].join(' ');

  const storeMsg = storeMetrics
    ? ` [store requestMap=${storeMetrics.requestMapSize} responseIndex=${storeMetrics.responseIndexSize} scopeIndex=${storeMetrics.scopeIndexSize}]`
    : '';

  console.log(msg + storeMsg);
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startMemoryObserver(): void {
  if (timer) return;
  // Emit immediately on start
  logSnapshot();
  timer = setInterval(logSnapshot, INTERVAL_MS);
  console.log(`[mem-observer] started (interval=${INTERVAL_MS / 1000}s)`);
}

export function stopMemoryObserver(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('[mem-observer] stopped');
  }
}

export { getMemoryStats, getStoreMetrics };
