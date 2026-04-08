import path from 'node:path';
import fs from 'node:fs/promises';
import { resolveRccPath } from '../runtime/user-data-paths.js';

export interface VirtualRouterHitEvent {
  requestId: string;
  timestamp: number;
  entryEndpoint: string;
  routeName: string;
  pool: string;
  providerKey: string;
  runtimeKey?: string;
  providerType?: string;
  modelId?: string;
  reason?: string;
  requestTokens?: number;
  selectionPenalty?: number;
  stopMessageActive?: boolean;
  stopMessageMode?: 'on' | 'off' | 'auto' | 'unset';
  stopMessageRemaining?: number;
}

export interface ProviderUsageEvent {
  requestId: string;
  timestamp: number;
  providerKey: string;
  runtimeKey?: string;
  providerType: string;
  modelId?: string;
  routeName?: string;
  entryEndpoint?: string;
  success: boolean;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface RouterStatsBucket {
  requestCount: number;
  poolHitCount: Record<string, number>;
  routeHitCount: Record<string, number>;
  providerHitCount: Record<string, number>;
  reasonHitCount: Record<string, number>;
  penaltyHitCount: Record<string, number>;
  stopMessageActiveCount: number;
}

export interface RouterStatsSnapshot {
  global: RouterStatsBucket;
  byEntryEndpoint: Record<string, RouterStatsBucket>;
}

export interface ProviderStatsBucket {
  requestCount: number;
  successCount: number;
  errorCount: number;
  latencySumMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface ProviderStatsSnapshot {
  global: ProviderStatsBucket;
  byProviderKey: Record<string, ProviderStatsBucket>;
  byRoute: Record<string, ProviderStatsBucket>;
  byEntryEndpoint: Record<string, ProviderStatsBucket>;
}

export interface StatsSnapshot {
  router: RouterStatsSnapshot;
  providers: ProviderStatsSnapshot;
}

export interface StatsCenterOptions {
  enable?: boolean;
  autoPrintOnExit?: boolean;
  persistPath?: string | null;
}

export interface StatsCenter {
  recordVirtualRouterHit(ev: VirtualRouterHitEvent): void;
  recordProviderUsage(ev: ProviderUsageEvent): void;
  getSnapshot(): StatsSnapshot;
  flushToDisk(): Promise<void>;
  reset(): void;
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function logStatsCenterNonBlockingError(stage: string, error: unknown, details?: Record<string, unknown>): void {
  try {
    const suffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(`[stats-center] ${stage} failed (non-blocking): ${formatUnknownError(error)}${suffix}`);
  } catch {
    // Never throw from non-blocking logging.
  }
}

function createEmptyRouterBucket(): RouterStatsBucket {
  return {
    requestCount: 0,
    poolHitCount: {},
    routeHitCount: {},
    providerHitCount: {},
    reasonHitCount: {},
    penaltyHitCount: {},
    stopMessageActiveCount: 0
  };
}

function createEmptyProviderBucket(): ProviderStatsBucket {
  return {
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    latencySumMs: 0,
    minLatencyMs: Number.POSITIVE_INFINITY,
    maxLatencyMs: 0,
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0
    }
  };
}

function createEmptySnapshot(): StatsSnapshot {
  return {
    router: {
      global: createEmptyRouterBucket(),
      byEntryEndpoint: {}
    },
    providers: {
      global: createEmptyProviderBucket(),
      byProviderKey: {},
      byRoute: {},
      byEntryEndpoint: {}
    }
  };
}

class NoopStatsCenter implements StatsCenter {
  recordVirtualRouterHit(): void { /* noop */ }
  recordProviderUsage(): void { /* noop */ }
  getSnapshot(): StatsSnapshot { return createEmptySnapshot(); }
  async flushToDisk(): Promise<void> { /* noop */ }
  reset(): void { /* noop */ }
}

class DefaultStatsCenter implements StatsCenter {
  private snapshot: StatsSnapshot = createEmptySnapshot();
  private dirty = false;
  private flushInFlight = false;
  private readonly persistPath: string | null;

  constructor(persistPath: string | null | undefined) {
    if (persistPath === null) {
      this.persistPath = null;
    } else if (typeof persistPath === 'string' && persistPath.trim().length) {
      this.persistPath = persistPath.trim();
    } else {
      const base = resolveRccPath('stats');
      this.persistPath = path.join(base, 'stats.json');
    }
  }

  recordVirtualRouterHit(ev: VirtualRouterHitEvent): void {
    if (!ev || !ev.routeName || !ev.providerKey) {
      return;
    }
    const snap = this.snapshot;
    this.applyRouterHitToBucket(snap.router.global, ev);
    const entryKey = ev.entryEndpoint || 'unknown';
    if (!snap.router.byEntryEndpoint[entryKey]) {
      snap.router.byEntryEndpoint[entryKey] = createEmptyRouterBucket();
    }
    this.applyRouterHitToBucket(snap.router.byEntryEndpoint[entryKey], ev);
    this.dirty = true;
  }

  recordProviderUsage(ev: ProviderUsageEvent): void {
    if (!ev || !ev.providerKey || !ev.providerType) {
      return;
    }
    const snap = this.snapshot;
    this.applyProviderUsageToBucket(snap.providers.global, ev);

    const providerKey = ev.providerKey;
    if (!snap.providers.byProviderKey[providerKey]) {
      snap.providers.byProviderKey[providerKey] = createEmptyProviderBucket();
    }
    this.applyProviderUsageToBucket(snap.providers.byProviderKey[providerKey], ev);

    const routeKey = ev.routeName || 'unknown';
    if (!snap.providers.byRoute[routeKey]) {
      snap.providers.byRoute[routeKey] = createEmptyProviderBucket();
    }
    this.applyProviderUsageToBucket(snap.providers.byRoute[routeKey], ev);

    const entryKey = ev.entryEndpoint || 'unknown';
    if (!snap.providers.byEntryEndpoint[entryKey]) {
      snap.providers.byEntryEndpoint[entryKey] = createEmptyProviderBucket();
    }
    this.applyProviderUsageToBucket(snap.providers.byEntryEndpoint[entryKey], ev);
    this.dirty = true;
  }

  getSnapshot(): StatsSnapshot {
    return this.snapshot;
  }

  reset(): void {
    this.snapshot = createEmptySnapshot();
    this.dirty = false;
  }

  async flushToDisk(): Promise<void> {
    if (!this.persistPath || !this.dirty || this.flushInFlight) {
      return;
    }
    this.flushInFlight = true;
    try {
      const dir = path.dirname(this.persistPath);
      await fs.mkdir(dir, { recursive: true });
      const payload = JSON.stringify(this.snapshot, null, 2);
      await fs.writeFile(this.persistPath, payload, 'utf-8');
      this.dirty = false;
    } catch (persistError) {
      logStatsCenterNonBlockingError('flushToDisk', persistError, {
        persistPath: this.persistPath
      });
    } finally {
      this.flushInFlight = false;
    }
  }

  private applyRouterHitToBucket(bucket: RouterStatsBucket, ev: VirtualRouterHitEvent): void {
    bucket.requestCount += 1;
    if (ev.pool) {
      bucket.poolHitCount[ev.pool] = (bucket.poolHitCount[ev.pool] || 0) + 1;
    }
    if (ev.routeName) {
      bucket.routeHitCount[ev.routeName] = (bucket.routeHitCount[ev.routeName] || 0) + 1;
    }
    if (ev.providerKey) {
      bucket.providerHitCount[ev.providerKey] = (bucket.providerHitCount[ev.providerKey] || 0) + 1;
    }
    if (typeof ev.reason === 'string' && ev.reason.trim()) {
      const reason = ev.reason.trim();
      bucket.reasonHitCount[reason] = (bucket.reasonHitCount[reason] || 0) + 1;
    }
    if (typeof ev.selectionPenalty === 'number' && Number.isFinite(ev.selectionPenalty) && ev.selectionPenalty > 0) {
      const key = String(Math.floor(ev.selectionPenalty));
      bucket.penaltyHitCount[key] = (bucket.penaltyHitCount[key] || 0) + 1;
    }
    if (ev.stopMessageActive === true) {
      bucket.stopMessageActiveCount += 1;
    }
  }

  private applyProviderUsageToBucket(bucket: ProviderStatsBucket, ev: ProviderUsageEvent): void {
    bucket.requestCount += 1;
    if (ev.success) {
      bucket.successCount += 1;
    } else {
      bucket.errorCount += 1;
    }
    if (Number.isFinite(ev.latencyMs) && ev.latencyMs >= 0) {
      bucket.latencySumMs += ev.latencyMs;
      if (ev.latencyMs < bucket.minLatencyMs) {
        bucket.minLatencyMs = ev.latencyMs;
      }
      if (ev.latencyMs > bucket.maxLatencyMs) {
        bucket.maxLatencyMs = ev.latencyMs;
      }
    }
    if (typeof ev.promptTokens === 'number' && Number.isFinite(ev.promptTokens)) {
      bucket.usage.promptTokens += Math.max(0, ev.promptTokens);
    }
    if (typeof ev.completionTokens === 'number' && Number.isFinite(ev.completionTokens)) {
      bucket.usage.completionTokens += Math.max(0, ev.completionTokens);
    }
    if (typeof ev.totalTokens === 'number' && Number.isFinite(ev.totalTokens)) {
      bucket.usage.totalTokens += Math.max(0, ev.totalTokens);
    } else {
      const derivedTotal =
        (typeof ev.promptTokens === 'number' ? Math.max(0, ev.promptTokens) : 0) +
        (typeof ev.completionTokens === 'number' ? Math.max(0, ev.completionTokens) : 0);
      bucket.usage.totalTokens += derivedTotal;
    }
  }
}

let instance: StatsCenter | null = null;

function resolveEnableFlag(defaultValue: boolean): boolean {
  const raw = process.env.ROUTECODEX_STATS;
  if (!raw) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function printStatsToConsole(snapshot: StatsSnapshot): void {
  const router = snapshot.router;
  const providers = snapshot.providers;

  const totalRequests = router.global.requestCount;
  const poolEntries = Object.entries(router.global.poolHitCount);
  const providerEntries = Object.entries(router.global.providerHitCount);
  const reasonEntries = Object.entries(router.global.reasonHitCount);

  // Router summary
  // eslint-disable-next-line no-console
  console.log('[stats] Virtual Router:');
  // eslint-disable-next-line no-console
  console.log(`  total requests: ${totalRequests}`);
  if (poolEntries.length) {
    // eslint-disable-next-line no-console
    console.log('  pools:');
    for (const [pool, count] of poolEntries) {
      const ratio = totalRequests > 0 ? (count / totalRequests) * 100 : 0;
      // eslint-disable-next-line no-console
      console.log(`    ${pool}: ${count} (${ratio.toFixed(2)}%)`);
    }
  }
  if (providerEntries.length) {
    // eslint-disable-next-line no-console
    console.log('  top providers:');
    const sorted = providerEntries.sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [providerKey, count] of sorted) {
      // eslint-disable-next-line no-console
      console.log(`    ${providerKey}: ${count}`);
    }
  }
  if (reasonEntries.length) {
    // eslint-disable-next-line no-console
    console.log('  top reasons:');
    const sortedReasons = reasonEntries.sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [reason, count] of sortedReasons) {
      // eslint-disable-next-line no-console
      console.log(`    ${reason}: ${count}`);
    }
  }
  if (router.global.stopMessageActiveCount > 0) {
    // eslint-disable-next-line no-console
    console.log(`  stopMessage-active hits: ${router.global.stopMessageActiveCount}`);
  }

  const globalProvider = providers.global;
  const totalProviderRequests = globalProvider.requestCount;
  const avgLatency =
    globalProvider.successCount > 0 ? globalProvider.latencySumMs / globalProvider.successCount : 0;

  // Provider summary
  // eslint-disable-next-line no-console
  console.log('\n[stats] Providers:');
  // eslint-disable-next-line no-console
  console.log(
    `  total requests : ${totalProviderRequests} (success=${globalProvider.successCount}, error=${globalProvider.errorCount})`
  );
  // eslint-disable-next-line no-console
  console.log(`  avg latency    : ${avgLatency.toFixed(1)} ms`);
  // eslint-disable-next-line no-console
  console.log(
    `  total tokens   : prompt=${globalProvider.usage.promptTokens} completion=${globalProvider.usage.completionTokens} total=${globalProvider.usage.totalTokens}`
  );
}

export function initStatsCenter(options?: StatsCenterOptions): StatsCenter {
  if (instance) {
    return instance;
  }
  const enabled = resolveEnableFlag(options?.enable ?? true);
  if (!enabled) {
    instance = new NoopStatsCenter();
    return instance;
  }
  const center = new DefaultStatsCenter(options?.persistPath);
  instance = center;

  const autoPrint = options?.autoPrintOnExit !== false;
  if (autoPrint && typeof process !== 'undefined' && typeof process.on === 'function') {
    const handler = async () => {
      try {
        await center.flushToDisk();
      } catch (flushError) {
        logStatsCenterNonBlockingError('beforeExit.flushToDisk', flushError);
      }
      try {
        const snapshot = center.getSnapshot();
        printStatsToConsole(snapshot);
      } catch (printError) {
        logStatsCenterNonBlockingError('beforeExit.printStatsToConsole', printError);
      }
    };
    try {
      process.once('beforeExit', handler);
    } catch (bindBeforeExitError) {
      logStatsCenterNonBlockingError('bind.beforeExit', bindBeforeExitError);
    }
    try {
      process.once('SIGINT', handler);
    } catch (bindSigintError) {
      logStatsCenterNonBlockingError('bind.SIGINT', bindSigintError);
    }
    try {
      process.once('SIGTERM', handler);
    } catch (bindSigtermError) {
      logStatsCenterNonBlockingError('bind.SIGTERM', bindSigtermError);
    }
  }

  return instance;
}

export function getStatsCenter(): StatsCenter {
  if (!instance) {
    return initStatsCenter();
  }
  return instance;
}
