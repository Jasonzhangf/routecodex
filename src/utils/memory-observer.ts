/**
 * Memory observer — periodic heap diagnostics for leak detection.
 * Logs RSS / heapUsed / external every INTERVAL_MS seconds.
 * Exposes internal store sizes via native debug metrics for external consumers.
 */

import { getResponsesConversationStoreDebugStats } from '../modules/llmswitch/bridge/responses-conversation-store-host.js';

const INTERVAL_MS = 30_000; // 30s
const LOG_PREFIX = '[mem-observer]';

interface StoreMetrics {
  requestMapSize: number;
  responseIndexSize: number;
  scopeIndexSize: number;
  requestEntriesWithoutLastResponseId?: number;
  retainedInputItems?: number;
}

// Expose raw store for diagnostic access
(globalThis as Record<string, unknown>)['__rccGetMemoryStats'] = getMemoryStats;
(globalThis as Record<string, unknown>)['__rccGetStoreMetrics'] = getStoreMetrics;

function getMemoryStats(): NodeJS.MemoryUsage {
  return process.memoryUsage();
}

function getStoreMetrics(): StoreMetrics | null {
  try {
    return getResponsesConversationStoreDebugStats();
  } catch {
    return null;
  }
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
    ? ` [store requestMap=${storeMetrics.requestMapSize} responseIndex=${storeMetrics.responseIndexSize} scopeIndex=${storeMetrics.scopeIndexSize}${
        typeof storeMetrics.requestEntriesWithoutLastResponseId === 'number'
          ? ` pendingNoResponseId=${storeMetrics.requestEntriesWithoutLastResponseId}`
          : ''
      }${
        typeof storeMetrics.retainedInputItems === 'number'
          ? ` retainedInputItems=${storeMetrics.retainedInputItems}`
          : ''
      }]`
    : '';

  if (shouldLogMemoryObserver()) {
    console.log(msg + storeMsg);
  }
}

function shouldLogMemoryObserver(): boolean {
  return process.env.ROUTECODEX_MEM_OBSERVER_DISABLE !== '1' && process.env.RCC_MEM_OBSERVER_DISABLE !== '1';
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startMemoryObserver(): void {
  if (timer) return;
  // Emit immediately on start
  logSnapshot();
  timer = setInterval(logSnapshot, INTERVAL_MS);
  if (shouldLogMemoryObserver()) {
    console.log(`[mem-observer] started (interval=${INTERVAL_MS / 1000}s)`);
  }
}

export function stopMemoryObserver(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    if (shouldLogMemoryObserver()) {
      console.log('[mem-observer] stopped');
    }
  }
}

export { getMemoryStats, getStoreMetrics };
