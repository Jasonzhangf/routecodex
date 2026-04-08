import { resolveBoolFromEnv } from './utils.js';
import { resolveSessionAnsiColor } from '../../../../utils/session-log-color.js';
import { getSessionClientRegistry } from '../session-client-registry.js';

type VirtualRouterHitRecord = {
  routeName?: string;
  poolId?: string;
  providerKey?: string;
  model?: string;
  sessionId?: string;
  projectPath?: string;
  activeInFlight?: number;
  maxInFlight?: number;
};

type UsageRollupRecord = {
  requestId?: string;
  routeName?: string;
  poolId?: string;
  providerKey?: string;
  model?: string;
  sessionId?: string;
  projectPath?: string;
  latencyMs: number;
  internalLatencyMs?: number;
  externalLatencyMs?: number;
  trafficWaitMs?: number;
  clientInjectWaitMs?: number;
  sseDecodeMs?: number;
  codecDecodeMs?: number;
  providerAttemptCount?: number;
  retryCount?: number;
  finishReason?: string;
};

type SessionRequestEvent = {
  requestId: string;
  routeName: string;
  poolId: string;
  providerKey: string;
  model: string;
  latencyMs: number;
  internalLatencyMs: number;
  externalLatencyMs: number;
  trafficWaitMs: number;
  clientInjectWaitMs: number;
  sseDecodeMs: number;
  codecDecodeMs: number;
  providerAttemptCount: number;
  retryCount: number;
  finishReason?: string;
  atMs: number;
};

type VirtualRouterHitAgg = {
  routeName: string;
  poolId: string;
  providerKey: string;
  model: string;
  hits: number;
  totalActiveInFlight: number;
  totalMaxInFlight: number;
  peakActiveInFlight: number;
  peakMaxInFlight: number;
};

type UsageRollupAgg = {
  routeName: string;
  poolId: string;
  providerKey: string;
  model: string;
  calls: number;
  totalLatencyMs: number;
  totalInternalLatencyMs: number;
  totalExternalLatencyMs: number;
  totalTrafficWaitMs: number;
  totalClientInjectWaitMs: number;
  totalSseDecodeMs: number;
  totalCodecDecodeMs: number;
  totalProviderAttemptCount: number;
  totalRetryCount: number;
  maxLatencyMs: number;
  maxInternalLatencyMs: number;
  maxExternalLatencyMs: number;
  maxTrafficWaitMs: number;
  maxClientInjectWaitMs: number;
  maxSseDecodeMs: number;
  maxCodecDecodeMs: number;
  maxProviderAttemptCount: number;
  maxRetryCount: number;
};

type SessionRollupAgg = {
  sessionId: string;
  projectPath?: string;
  virtualHits: number;
  usageCalls: number;
  totalLatencyMs: number;
  totalInternalLatencyMs: number;
  totalExternalLatencyMs: number;
  totalTrafficWaitMs: number;
  totalClientInjectWaitMs: number;
  totalSseDecodeMs: number;
  totalCodecDecodeMs: number;
  totalProviderAttemptCount: number;
  totalRetryCount: number;
  maxLatencyMs: number;
  maxInternalLatencyMs: number;
  maxExternalLatencyMs: number;
  maxTrafficWaitMs: number;
  maxClientInjectWaitMs: number;
  maxSseDecodeMs: number;
  maxCodecDecodeMs: number;
  maxProviderAttemptCount: number;
  maxRetryCount: number;
};

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_BUCKETS = 4096;
const DEFAULT_TOP_N = 20;
const ANSI_RESET = '\x1b[0m';
const ANSI_DIM = '\x1b[90m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_HEADER = '\x1b[38;5;252m';
const ANSI_VR = '\x1b[38;5;208m';
const ANSI_USAGE = '\x1b[38;5;39m';
const ANSI_SESSION = '\x1b[38;5;141m';
const ANSI_BAR = '\x1b[38;5;240m';
const ANSI_WHITE = '\x1b[97m';
let flushTimer: NodeJS.Timeout | undefined;
let windowStartedAtMs = Date.now();

const virtualRouterHits = new Map<string, VirtualRouterHitAgg>();
const usageRollups = new Map<string, UsageRollupAgg>();
const sessionRollups = new Map<string, SessionRollupAgg>();
const sessionRequestEvents = new Map<string, SessionRequestEvent[]>();
let exitHookBound = false;

function normalizeLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeSessionId(value: unknown): string {
  if (typeof value !== 'string') {
    return 'unknown';
  }
  const trimmed = value.trim();
  return trimmed || 'unknown';
}

function resolveWindowMs(): number {
  const raw = process.env.ROUTECODEX_LOG_ROLLUP_WINDOW_MS ?? process.env.RCC_LOG_ROLLUP_WINDOW_MS;
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  if (Number.isFinite(parsed) && parsed >= 1_000) {
    return parsed;
  }
  return DEFAULT_WINDOW_MS;
}

function resolveMaxBuckets(): number {
  const raw = process.env.ROUTECODEX_LOG_ROLLUP_MAX_BUCKETS ?? process.env.RCC_LOG_ROLLUP_MAX_BUCKETS;
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  if (Number.isFinite(parsed) && parsed >= 16) {
    return parsed;
  }
  return DEFAULT_MAX_BUCKETS;
}

function resolveTopN(): number {
  const raw = process.env.ROUTECODEX_LOG_ROLLUP_TOP_N ?? process.env.RCC_LOG_ROLLUP_TOP_N;
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  if (Number.isFinite(parsed) && parsed >= 1) {
    return parsed;
  }
  return DEFAULT_TOP_N;
}

function isRollupEnabled(): boolean {
  return resolveBoolFromEnv(
    process.env.ROUTECODEX_LOG_ROLLUP ?? process.env.RCC_LOG_ROLLUP,
    true
  );
}

function isRealtimeRollupEnabled(): boolean {
  return resolveBoolFromEnv(
    process.env.ROUTECODEX_LOG_ROLLUP_REALTIME ?? process.env.RCC_LOG_ROLLUP_REALTIME,
    true
  );
}

function buildKey(routeName: string, poolId: string, providerKey: string, model: string): string {
  return `${routeName}\u0000${poolId}\u0000${providerKey}\u0000${model}`;
}

function ensureStarted(): void {
  if (!isRollupEnabled()) {
    return;
  }
  if (isRealtimeRollupEnabled()) {
    bindExitHooksOnce();
    return;
  }
  if (!flushTimer) {
    flushTimer = setInterval(() => {
      flushLogRollup('interval');
    }, resolveWindowMs());
    flushTimer.unref?.();
  }
  bindExitHooksOnce();
}

function bindExitHooksOnce(): void {
  if (exitHookBound) {
    return;
  }
  exitHookBound = true;
  process.once('beforeExit', () => flushLogRollup('beforeExit'));
  process.once('exit', () => flushLogRollup('exit'));
}

function clearWindow(nowMs: number): void {
  virtualRouterHits.clear();
  usageRollups.clear();
  sessionRollups.clear();
  sessionRequestEvents.clear();
  windowStartedAtMs = nowMs;
}

function shouldDropBucket(map: Map<string, unknown>, key: string): boolean {
  if (map.has(key)) {
    return false;
  }
  return map.size >= resolveMaxBuckets();
}

function formatMs(value: number): string {
  return `${Math.max(0, Math.round(value))}ms`;
}

function formatRatio(numerator: number, denominator: number): string {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return '0.0%';
  }
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function formatPerSecond(value: number, seconds: number): string {
  if (!Number.isFinite(value) || !Number.isFinite(seconds) || seconds <= 0) {
    return '0.00/s';
  }
  return `${(value / seconds).toFixed(2)}/s`;
}

function colorize(text: string, color: string): string {
  return `${color}${text}${ANSI_RESET}`;
}

function formatRoutePool(routeName: string, poolId: string): string {
  return poolId !== '-' ? `${routeName}/${poolId}` : routeName;
}

function formatProvider(providerKey: string, model: string): string {
  return model !== '-' ? `${providerKey}.${model}` : providerKey;
}

function normalizeProjectPath(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeFinishReason(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function shortSessionId(value: string): string {
  const normalized = normalizeSessionId(value);
  if (normalized.length <= 22) {
    return normalized;
  }
  return `${normalized.slice(0, 10)}…${normalized.slice(-8)}`;
}

function shortRequestId(value: string): string {
  const normalized = normalizeLabel(value, 'unknown-request');
  if (normalized.length <= 42) {
    return normalized;
  }
  return `${normalized.slice(0, 20)}…${normalized.slice(-14)}`;
}

function trimPathForLog(value: string, maxLen = 96): string {
  if (value.length <= maxLen) {
    return value;
  }
  const keep = Math.max(8, Math.floor((maxLen - 1) / 2));
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

function emitRealtimeSessionRequestLog(args: {
  sessionId: string;
  projectPath?: string;
  event: SessionRequestEvent;
}): void {
  const sessionColor = resolveSessionAnsiColor(args.sessionId) || ANSI_SESSION;
  const sessionLabel = shortSessionId(args.sessionId);
  const project = trimPathForLog(
    normalizeProjectPath(args.projectPath)
    || resolveProjectPathFromRegistry(args.sessionId)
    || '-'
  );
  const routePool = formatRoutePool(args.event.routeName, args.event.poolId);
  const provider = formatProvider(args.event.providerKey, args.event.model);
  const requestLabel = shortRequestId(args.event.requestId);
  const finishReason = args.event.finishReason ?? 'unknown';
  const sessionAgg = sessionRollups.get(args.sessionId);
  const calls = sessionAgg?.usageCalls ?? 0;
  const retries = sessionAgg?.totalRetryCount ?? 0;
  console.log(colorize(`[session-request][rt] session=${sessionLabel} project=${project}`, sessionColor));
  console.log(
    `${colorize(
      `  req=${requestLabel} ${routePool} -> ${provider} total=${formatMs(args.event.latencyMs)} internal=${formatMs(args.event.internalLatencyMs)} external=${formatMs(args.event.externalLatencyMs)} retries=${args.event.retryCount} attempts=${args.event.providerAttemptCount} wait.traffic=${formatMs(args.event.trafficWaitMs)} wait.inject=${formatMs(args.event.clientInjectWaitMs)} decode.sse=${formatMs(args.event.sseDecodeMs)} decode.codec=${formatMs(args.event.codecDecodeMs)}`,
      sessionColor
    )} ${ANSI_WHITE}finish_reason=${finishReason}${ANSI_RESET}`
  );
  console.log(colorize(`  session.calls=${calls} session.retries=${retries}`, sessionColor));
}

function emitRealtimeVirtualRouterHitLog(args: {
  sessionId: string;
  projectPath?: string;
  routeName: string;
  poolId: string;
  providerKey: string;
  model: string;
  activeInFlight: number;
  maxInFlight: number;
  sessionVirtualHits: number;
}): void {
  const sessionColor = resolveSessionAnsiColor(args.sessionId) || ANSI_SESSION;
  const sessionLabel = shortSessionId(args.sessionId);
  const project = trimPathForLog(
    normalizeProjectPath(args.projectPath)
      || resolveProjectPathFromRegistry(args.sessionId)
      || '-'
  );
  const routePool = formatRoutePool(args.routeName, args.poolId);
  const provider = formatProvider(args.providerKey, args.model);
  const active = Math.max(0, Math.floor(args.activeInFlight));
  const max = Math.max(0, Math.floor(args.maxInFlight));
  console.log(colorize(`[virtual-router-hit][rt] session=${sessionLabel} project=${project}`, sessionColor));
  console.log(
    colorize(
      `  ${routePool} -> ${provider} [concurrency:${active}/${max}] session.virtual_hits=${Math.max(0, Math.floor(args.sessionVirtualHits))}`,
      sessionColor
    )
  );
}

function resolveProjectPathFromRegistry(sessionId: string): string | undefined {
  const normalizedSession = normalizeSessionId(sessionId);
  if (!normalizedSession || normalizedSession === 'unknown') {
    return undefined;
  }
  try {
    const registry = getSessionClientRegistry();
    const byTmux = registry.findByTmuxSessionId(normalizedSession);
    const tmuxWorkdir = normalizeProjectPath(byTmux?.workdir);
    if (tmuxWorkdir) {
      return tmuxWorkdir;
    }
    const boundWorkdir = normalizeProjectPath(registry.resolveBoundWorkdir(normalizedSession));
    if (boundWorkdir) {
      return boundWorkdir;
    }
  } catch {
    // non-blocking fallback
  }
  return undefined;
}

function updateSessionProjectPath(sessionId: string, incomingProjectPath?: string): void {
  const record = sessionRollups.get(sessionId);
  if (!record) {
    return;
  }
  const normalizedIncoming = normalizeProjectPath(incomingProjectPath);
  if (normalizedIncoming) {
    record.projectPath = normalizedIncoming;
    return;
  }
  if (record.projectPath) {
    return;
  }
  const fallback = resolveProjectPathFromRegistry(sessionId);
  if (fallback) {
    record.projectPath = fallback;
  }
}

export function recordVirtualRouterHitRollup(event: VirtualRouterHitRecord): void {
  ensureStarted();
  if (!isRollupEnabled()) {
    return;
  }
  const routeName = normalizeLabel(event.routeName, 'route');
  const poolId = normalizeLabel(event.poolId, '-');
  const providerKey = normalizeLabel(event.providerKey, 'unknown-provider');
  const model = normalizeLabel(event.model, '-');
  const key = buildKey(routeName, poolId, providerKey, model);
  if (shouldDropBucket(virtualRouterHits, key)) {
    return;
  }
  const existing = virtualRouterHits.get(key);
  if (existing) {
    existing.hits += 1;
    existing.totalActiveInFlight += Math.max(0, Math.floor(event.activeInFlight ?? 0));
    existing.totalMaxInFlight += Math.max(0, Math.floor(event.maxInFlight ?? 0));
    existing.peakActiveInFlight = Math.max(existing.peakActiveInFlight, Math.max(0, Math.floor(event.activeInFlight ?? 0)));
    existing.peakMaxInFlight = Math.max(existing.peakMaxInFlight, Math.max(0, Math.floor(event.maxInFlight ?? 0)));
  } else {
    virtualRouterHits.set(key, {
      routeName,
      poolId,
      providerKey,
      model,
      hits: 1,
      totalActiveInFlight: Math.max(0, Math.floor(event.activeInFlight ?? 0)),
      totalMaxInFlight: Math.max(0, Math.floor(event.maxInFlight ?? 0)),
      peakActiveInFlight: Math.max(0, Math.floor(event.activeInFlight ?? 0)),
      peakMaxInFlight: Math.max(0, Math.floor(event.maxInFlight ?? 0))
    });
  }
  const sessionId = normalizeSessionId(event.sessionId);
  const sessionExisting = sessionRollups.get(sessionId);
  if (sessionExisting) {
    sessionExisting.virtualHits += 1;
    updateSessionProjectPath(sessionId, event.projectPath);
    if (isRealtimeRollupEnabled()) {
      emitRealtimeVirtualRouterHitLog({
        sessionId,
        projectPath: sessionExisting.projectPath,
        routeName,
        poolId,
        providerKey,
        model,
        activeInFlight: Math.max(0, Math.floor(event.activeInFlight ?? 0)),
        maxInFlight: Math.max(0, Math.floor(event.maxInFlight ?? 0)),
        sessionVirtualHits: sessionExisting.virtualHits
      });
    }
    return;
  }
  sessionRollups.set(sessionId, {
    sessionId,
    projectPath: normalizeProjectPath(event.projectPath),
    virtualHits: 1,
    usageCalls: 0,
    totalLatencyMs: 0,
    totalInternalLatencyMs: 0,
    totalExternalLatencyMs: 0,
    totalTrafficWaitMs: 0,
    totalClientInjectWaitMs: 0,
    totalSseDecodeMs: 0,
    totalCodecDecodeMs: 0,
    totalProviderAttemptCount: 0,
    totalRetryCount: 0,
    maxLatencyMs: 0,
    maxInternalLatencyMs: 0,
    maxExternalLatencyMs: 0,
    maxTrafficWaitMs: 0,
    maxClientInjectWaitMs: 0,
    maxSseDecodeMs: 0,
    maxCodecDecodeMs: 0,
    maxProviderAttemptCount: 0,
    maxRetryCount: 0
  });
  updateSessionProjectPath(sessionId, event.projectPath);
  if (isRealtimeRollupEnabled()) {
    emitRealtimeVirtualRouterHitLog({
      sessionId,
      projectPath: sessionRollups.get(sessionId)?.projectPath,
      routeName,
      poolId,
      providerKey,
      model,
      activeInFlight: Math.max(0, Math.floor(event.activeInFlight ?? 0)),
      maxInFlight: Math.max(0, Math.floor(event.maxInFlight ?? 0)),
      sessionVirtualHits: 1
    });
  }
}

export function recordUsageRollup(event: UsageRollupRecord): void {
  ensureStarted();
  if (!isRollupEnabled()) {
    return;
  }
  const routeName = normalizeLabel(event.routeName, 'route');
  const poolId = normalizeLabel(event.poolId, '-');
  const providerKey = normalizeLabel(event.providerKey, 'unknown-provider');
  const model = normalizeLabel(event.model, '-');
  const key = buildKey(routeName, poolId, providerKey, model);
  if (shouldDropBucket(usageRollups, key)) {
    return;
  }
  const externalLatencyMs = Math.max(0, Number.isFinite(event.externalLatencyMs as number) ? Number(event.externalLatencyMs) : 0);
  const internalLatencyMs = Math.max(
    0,
    Number.isFinite(event.internalLatencyMs as number)
      ? Number(event.internalLatencyMs)
      : Math.max(0, event.latencyMs - externalLatencyMs)
  );
  const trafficWaitMs = Math.max(0, Number.isFinite(event.trafficWaitMs as number) ? Number(event.trafficWaitMs) : 0);
  const clientInjectWaitMs = Math.max(
    0,
    Number.isFinite(event.clientInjectWaitMs as number) ? Number(event.clientInjectWaitMs) : 0
  );
  const sseDecodeMs = Math.max(0, Number.isFinite(event.sseDecodeMs as number) ? Number(event.sseDecodeMs) : 0);
  const codecDecodeMs = Math.max(
    0,
    Number.isFinite(event.codecDecodeMs as number) ? Number(event.codecDecodeMs) : 0
  );
  const providerAttemptCount = Math.max(
    1,
    Number.isFinite(event.providerAttemptCount as number) ? Math.floor(Number(event.providerAttemptCount)) : 1
  );
  const retryCount = Math.max(
    0,
    Number.isFinite(event.retryCount as number) ? Math.floor(Number(event.retryCount)) : Math.max(0, providerAttemptCount - 1)
  );
  const requestId = normalizeLabel(event.requestId, 'unknown-request');
  const nowMs = Date.now();
  const existing = usageRollups.get(key);
  if (existing) {
    existing.calls += 1;
    existing.totalLatencyMs += event.latencyMs;
    existing.totalInternalLatencyMs += internalLatencyMs;
    existing.totalExternalLatencyMs += externalLatencyMs;
    existing.totalTrafficWaitMs += trafficWaitMs;
    existing.totalClientInjectWaitMs += clientInjectWaitMs;
    existing.totalSseDecodeMs += sseDecodeMs;
    existing.totalCodecDecodeMs += codecDecodeMs;
    existing.totalProviderAttemptCount += providerAttemptCount;
    existing.totalRetryCount += retryCount;
    existing.maxLatencyMs = Math.max(existing.maxLatencyMs, Math.max(0, event.latencyMs));
    existing.maxInternalLatencyMs = Math.max(existing.maxInternalLatencyMs, internalLatencyMs);
    existing.maxExternalLatencyMs = Math.max(existing.maxExternalLatencyMs, externalLatencyMs);
    existing.maxTrafficWaitMs = Math.max(existing.maxTrafficWaitMs, trafficWaitMs);
    existing.maxClientInjectWaitMs = Math.max(existing.maxClientInjectWaitMs, clientInjectWaitMs);
    existing.maxSseDecodeMs = Math.max(existing.maxSseDecodeMs, sseDecodeMs);
    existing.maxCodecDecodeMs = Math.max(existing.maxCodecDecodeMs, codecDecodeMs);
    existing.maxProviderAttemptCount = Math.max(existing.maxProviderAttemptCount, providerAttemptCount);
    existing.maxRetryCount = Math.max(existing.maxRetryCount, retryCount);
  } else {
    usageRollups.set(key, {
      routeName,
      poolId,
      providerKey,
      model,
      calls: 1,
      totalLatencyMs: event.latencyMs,
      totalInternalLatencyMs: internalLatencyMs,
      totalExternalLatencyMs: externalLatencyMs,
      totalTrafficWaitMs: trafficWaitMs,
      totalClientInjectWaitMs: clientInjectWaitMs,
      totalSseDecodeMs: sseDecodeMs,
      totalCodecDecodeMs: codecDecodeMs,
      totalProviderAttemptCount: providerAttemptCount,
      totalRetryCount: retryCount,
      maxLatencyMs: Math.max(0, event.latencyMs),
      maxInternalLatencyMs: internalLatencyMs,
      maxExternalLatencyMs: externalLatencyMs,
      maxTrafficWaitMs: trafficWaitMs,
      maxClientInjectWaitMs: clientInjectWaitMs,
      maxSseDecodeMs: sseDecodeMs,
      maxCodecDecodeMs: codecDecodeMs,
      maxProviderAttemptCount: providerAttemptCount,
      maxRetryCount: retryCount
    });
  }
  const sessionId = normalizeSessionId(event.sessionId);
  const sessionEvent: SessionRequestEvent = {
    requestId,
    routeName,
    poolId,
    providerKey,
    model,
    latencyMs: Math.max(0, event.latencyMs),
    internalLatencyMs,
    externalLatencyMs,
    trafficWaitMs,
    clientInjectWaitMs,
    sseDecodeMs,
    codecDecodeMs,
    providerAttemptCount,
    retryCount,
    finishReason: normalizeFinishReason(event.finishReason),
    atMs: nowMs
  };
  if (!isRealtimeRollupEnabled()) {
    const sessionEvents = sessionRequestEvents.get(sessionId);
    if (sessionEvents) {
      sessionEvents.push(sessionEvent);
    } else {
      sessionRequestEvents.set(sessionId, [sessionEvent]);
    }
  }
  const sessionExisting = sessionRollups.get(sessionId);
  if (sessionExisting) {
    sessionExisting.usageCalls += 1;
    sessionExisting.totalLatencyMs += event.latencyMs;
    sessionExisting.totalInternalLatencyMs += internalLatencyMs;
    sessionExisting.totalExternalLatencyMs += externalLatencyMs;
    sessionExisting.totalTrafficWaitMs += trafficWaitMs;
    sessionExisting.totalClientInjectWaitMs += clientInjectWaitMs;
    sessionExisting.totalSseDecodeMs += sseDecodeMs;
    sessionExisting.totalCodecDecodeMs += codecDecodeMs;
    sessionExisting.totalProviderAttemptCount += providerAttemptCount;
    sessionExisting.totalRetryCount += retryCount;
    sessionExisting.maxLatencyMs = Math.max(sessionExisting.maxLatencyMs, Math.max(0, event.latencyMs));
    sessionExisting.maxInternalLatencyMs = Math.max(sessionExisting.maxInternalLatencyMs, internalLatencyMs);
    sessionExisting.maxExternalLatencyMs = Math.max(sessionExisting.maxExternalLatencyMs, externalLatencyMs);
    sessionExisting.maxTrafficWaitMs = Math.max(sessionExisting.maxTrafficWaitMs, trafficWaitMs);
    sessionExisting.maxClientInjectWaitMs = Math.max(sessionExisting.maxClientInjectWaitMs, clientInjectWaitMs);
    sessionExisting.maxSseDecodeMs = Math.max(sessionExisting.maxSseDecodeMs, sseDecodeMs);
    sessionExisting.maxCodecDecodeMs = Math.max(sessionExisting.maxCodecDecodeMs, codecDecodeMs);
    sessionExisting.maxProviderAttemptCount = Math.max(sessionExisting.maxProviderAttemptCount, providerAttemptCount);
    sessionExisting.maxRetryCount = Math.max(sessionExisting.maxRetryCount, retryCount);
    updateSessionProjectPath(sessionId, event.projectPath);
    if (isRealtimeRollupEnabled()) {
      emitRealtimeSessionRequestLog({
        sessionId,
        projectPath: sessionExisting.projectPath,
        event: sessionEvent
      });
    }
    return;
  }
  sessionRollups.set(sessionId, {
    sessionId,
    projectPath: normalizeProjectPath(event.projectPath),
    virtualHits: 0,
    usageCalls: 1,
    totalLatencyMs: event.latencyMs,
    totalInternalLatencyMs: internalLatencyMs,
    totalExternalLatencyMs: externalLatencyMs,
    totalTrafficWaitMs: trafficWaitMs,
    totalClientInjectWaitMs: clientInjectWaitMs,
    totalSseDecodeMs: sseDecodeMs,
    totalCodecDecodeMs: codecDecodeMs,
    totalProviderAttemptCount: providerAttemptCount,
    totalRetryCount: retryCount,
    maxLatencyMs: Math.max(0, event.latencyMs),
    maxInternalLatencyMs: internalLatencyMs,
    maxExternalLatencyMs: externalLatencyMs,
    maxTrafficWaitMs: trafficWaitMs,
    maxClientInjectWaitMs: clientInjectWaitMs,
    maxSseDecodeMs: sseDecodeMs,
    maxCodecDecodeMs: codecDecodeMs,
    maxProviderAttemptCount: providerAttemptCount,
    maxRetryCount: retryCount
  });
  updateSessionProjectPath(sessionId, event.projectPath);
  if (isRealtimeRollupEnabled()) {
    emitRealtimeSessionRequestLog({
      sessionId,
      projectPath: sessionRollups.get(sessionId)?.projectPath,
      event: sessionEvent
    });
  }
}

export function flushLogRollup(trigger: 'interval' | 'beforeExit' | 'exit' | 'manual' = 'manual'): void {
  if (!isRollupEnabled()) {
    return;
  }
  if (isRealtimeRollupEnabled()) {
    return;
  }
  const nowMs = Date.now();
  const windowMs = Math.max(1, nowMs - windowStartedAtMs);
  const windowSeconds = Math.max(1, Math.round(windowMs / 1000));

  const vrRows = Array.from(virtualRouterHits.values()).sort((a, b) => b.hits - a.hits);
  const vrTopRows = vrRows.slice(0, resolveTopN());
  const vrOtherRows = vrRows.slice(resolveTopN());
  const vrTotalHits = vrRows.reduce((sum, row) => sum + row.hits, 0);
  const usageRows = Array.from(usageRollups.values()).sort((a, b) => b.calls - a.calls);
  const usageTopRows = usageRows.slice(0, resolveTopN());
  const usageOtherRows = usageRows.slice(resolveTopN());
  const usageTotalCalls = usageRows.reduce((sum, row) => sum + row.calls, 0);
  if (usageTotalCalls <= 0) {
    clearWindow(nowMs);
    return;
  }
  const divider = colorize('─'.repeat(96), ANSI_BAR);
  console.log(divider);
  console.log(
    colorize(
      `${ANSI_BOLD}[rollup][1m]${ANSI_RESET} window=${windowSeconds}s trigger=${trigger} at=${new Date(nowMs).toLocaleTimeString()}`,
      ANSI_HEADER
    )
  );
  console.log(
    colorize(
      `${ANSI_BOLD}[virtual-router-hit][1m]${ANSI_RESET} groups=${vrRows.length} hits=${vrTotalHits} rate=${formatPerSecond(vrTotalHits, windowSeconds)}`,
      ANSI_VR
    )
  );
  if (vrRows.length === 0) {
    console.log(colorize('  - no hits in this window', ANSI_DIM));
  }
  for (const [idx, row] of vrTopRows.entries()) {
    const avgActive = row.hits > 0 ? row.totalActiveInFlight / row.hits : 0;
    const avgMax = row.hits > 0 ? row.totalMaxInFlight / row.hits : 0;
    const routePool = formatRoutePool(row.routeName, row.poolId);
    const provider = formatProvider(row.providerKey, row.model);
    console.log(colorize(`  ${idx + 1}) ${routePool}`, ANSI_VR));
    console.log(
      colorize(
        `     provider=${provider} hits=${row.hits} share=${formatRatio(row.hits, vrTotalHits)}`,
        ANSI_VR
      )
    );
    console.log(
      colorize(
        `     concurrency avg=${avgActive.toFixed(2)}/${avgMax.toFixed(2)} peak=${row.peakActiveInFlight}/${row.peakMaxInFlight}`,
        ANSI_VR
      )
    );
  }
  if (vrOtherRows.length > 0) {
    const otherHits = vrOtherRows.reduce((sum, row) => sum + row.hits, 0);
    const otherActive = vrOtherRows.reduce((sum, row) => sum + row.totalActiveInFlight, 0);
    const otherMax = vrOtherRows.reduce((sum, row) => sum + row.totalMaxInFlight, 0);
    const avgActive = otherHits > 0 ? otherActive / otherHits : 0;
    const avgMax = otherHits > 0 ? otherMax / otherHits : 0;
    console.log(colorize('  others)', ANSI_VR));
    console.log(
      colorize(
        `     groups=${vrOtherRows.length} hits=${otherHits} share=${formatRatio(otherHits, vrTotalHits)}`,
        ANSI_VR
      )
    );
    console.log(colorize(`     concurrency avg=${avgActive.toFixed(2)}/${avgMax.toFixed(2)}`, ANSI_VR));
  }

  console.log(
    colorize(
      `${ANSI_BOLD}[usage][1m]${ANSI_RESET} groups=${usageRows.length} requests=${usageTotalCalls} rate=${formatPerSecond(usageTotalCalls, windowSeconds)}`,
      ANSI_USAGE
    )
  );
  if (usageRows.length === 0) {
    console.log(colorize('  - no usage records in this window', ANSI_DIM));
  }
  for (const [idx, row] of usageTopRows.entries()) {
    const avgLatencyMs = row.calls > 0 ? row.totalLatencyMs / row.calls : 0;
    const avgInternalMs = row.calls > 0 ? row.totalInternalLatencyMs / row.calls : 0;
    const avgExternalMs = row.calls > 0 ? row.totalExternalLatencyMs / row.calls : 0;
    const avgTrafficWaitMs = row.calls > 0 ? row.totalTrafficWaitMs / row.calls : 0;
    const avgInjectWaitMs = row.calls > 0 ? row.totalClientInjectWaitMs / row.calls : 0;
    const avgSseDecodeMs = row.calls > 0 ? row.totalSseDecodeMs / row.calls : 0;
    const avgCodecDecodeMs = row.calls > 0 ? row.totalCodecDecodeMs / row.calls : 0;
    const avgDecodeEffectiveMs = Math.max(avgSseDecodeMs, avgCodecDecodeMs);
    const avgCoreInternalMs = Math.max(
      0,
      avgInternalMs - avgTrafficWaitMs - avgInjectWaitMs - avgDecodeEffectiveMs
    );
    const avgAttempts = row.calls > 0 ? row.totalProviderAttemptCount / row.calls : 1;
    const avgRetries = row.calls > 0 ? row.totalRetryCount / row.calls : 0;
    const routePool = formatRoutePool(row.routeName, row.poolId);
    const provider = formatProvider(row.providerKey, row.model);
    console.log(colorize(`  ${idx + 1}) ${routePool}`, ANSI_USAGE));
    console.log(
      colorize(
        `     provider=${provider} calls=${row.calls} share=${formatRatio(row.calls, usageTotalCalls)}`,
        ANSI_USAGE
      )
    );
    console.log(
      colorize(
        `     avg.total=${formatMs(avgLatencyMs)} avg.internal=${formatMs(avgInternalMs)} avg.external=${formatMs(avgExternalMs)}`,
        ANSI_USAGE
      )
    );
    console.log(
      colorize(
        `     max.total=${formatMs(row.maxLatencyMs)} max.internal=${formatMs(row.maxInternalLatencyMs)} max.external=${formatMs(row.maxExternalLatencyMs)}`,
        ANSI_USAGE
      )
    );
    console.log(
      colorize(
        `     avg.retries=${avgRetries.toFixed(2)} avg.attempts=${avgAttempts.toFixed(2)} avg.wait.traffic=${formatMs(avgTrafficWaitMs)} avg.wait.inject=${formatMs(avgInjectWaitMs)} avg.decode.sse=${formatMs(avgSseDecodeMs)} avg.decode.codec=${formatMs(avgCodecDecodeMs)} avg.decode.effective=${formatMs(avgDecodeEffectiveMs)} avg.core_internal=${formatMs(avgCoreInternalMs)}`,
        ANSI_USAGE
      )
    );
    console.log(
      colorize(
        `     max.retries=${row.maxRetryCount} max.attempts=${row.maxProviderAttemptCount} max.wait.traffic=${formatMs(row.maxTrafficWaitMs)} max.wait.inject=${formatMs(row.maxClientInjectWaitMs)} max.decode.sse=${formatMs(row.maxSseDecodeMs)} max.decode.codec=${formatMs(row.maxCodecDecodeMs)} max.decode.effective=${formatMs(Math.max(row.maxSseDecodeMs, row.maxCodecDecodeMs))}`,
        ANSI_USAGE
      )
    );
  }
  if (usageOtherRows.length > 0) {
    const otherCalls = usageOtherRows.reduce((sum, row) => sum + row.calls, 0);
    const otherTotal = usageOtherRows.reduce((sum, row) => sum + row.totalLatencyMs, 0);
    const otherInternal = usageOtherRows.reduce((sum, row) => sum + row.totalInternalLatencyMs, 0);
    const otherExternal = usageOtherRows.reduce((sum, row) => sum + row.totalExternalLatencyMs, 0);
    const otherTrafficWait = usageOtherRows.reduce((sum, row) => sum + row.totalTrafficWaitMs, 0);
    const otherInjectWait = usageOtherRows.reduce((sum, row) => sum + row.totalClientInjectWaitMs, 0);
    const otherSseDecode = usageOtherRows.reduce((sum, row) => sum + row.totalSseDecodeMs, 0);
    const otherCodecDecode = usageOtherRows.reduce((sum, row) => sum + row.totalCodecDecodeMs, 0);
    const otherAttempts = usageOtherRows.reduce((sum, row) => sum + row.totalProviderAttemptCount, 0);
    const otherRetries = usageOtherRows.reduce((sum, row) => sum + row.totalRetryCount, 0);
    const avgTotal = otherCalls > 0 ? otherTotal / otherCalls : 0;
    const avgInternal = otherCalls > 0 ? otherInternal / otherCalls : 0;
    const avgExternal = otherCalls > 0 ? otherExternal / otherCalls : 0;
    const avgTrafficWait = otherCalls > 0 ? otherTrafficWait / otherCalls : 0;
    const avgInjectWait = otherCalls > 0 ? otherInjectWait / otherCalls : 0;
    const avgSseDecode = otherCalls > 0 ? otherSseDecode / otherCalls : 0;
    const avgCodecDecode = otherCalls > 0 ? otherCodecDecode / otherCalls : 0;
    const avgDecodeEffective = Math.max(avgSseDecode, avgCodecDecode);
    const avgCoreInternal = Math.max(
      0,
      avgInternal - avgTrafficWait - avgInjectWait - avgDecodeEffective
    );
    const avgAttempts = otherCalls > 0 ? otherAttempts / otherCalls : 1;
    const avgRetries = otherCalls > 0 ? otherRetries / otherCalls : 0;
    console.log(colorize('  others)', ANSI_USAGE));
    console.log(
      colorize(
        `     groups=${usageOtherRows.length} calls=${otherCalls} share=${formatRatio(otherCalls, usageTotalCalls)}`,
        ANSI_USAGE
      )
    );
    console.log(
      colorize(
        `     avg.total=${formatMs(avgTotal)} avg.internal=${formatMs(avgInternal)} avg.external=${formatMs(avgExternal)}`,
        ANSI_USAGE
      )
    );
    console.log(
      colorize(
        `     avg.retries=${avgRetries.toFixed(2)} avg.attempts=${avgAttempts.toFixed(2)} avg.wait.traffic=${formatMs(avgTrafficWait)} avg.wait.inject=${formatMs(avgInjectWait)} avg.decode.sse=${formatMs(avgSseDecode)} avg.decode.codec=${formatMs(avgCodecDecode)} avg.decode.effective=${formatMs(avgDecodeEffective)} avg.core_internal=${formatMs(avgCoreInternal)}`,
        ANSI_USAGE
      )
    );
  }

  const sessionRows = Array.from(sessionRollups.values()).sort((a, b) => {
    if (b.usageCalls !== a.usageCalls) {
      return b.usageCalls - a.usageCalls;
    }
    return b.virtualHits - a.virtualHits;
  });
  const sessionTopRows = sessionRows.slice(0, resolveTopN());
  const sessionOtherRows = sessionRows.slice(resolveTopN());
  const totalVirtualHits = sessionRows.reduce((sum, row) => sum + row.virtualHits, 0);
  const totalUsageCalls = sessionRows.reduce((sum, row) => sum + row.usageCalls, 0);
  console.log(
    colorize(
      `${ANSI_BOLD}[session-rollup][1m]${ANSI_RESET} sessions=${sessionRows.length} virtual_hits=${totalVirtualHits} usage_calls=${totalUsageCalls}`,
      ANSI_SESSION
    )
  );
  if (sessionRows.length === 0) {
    console.log(colorize('  - no sessions in this window', ANSI_DIM));
  }
  for (const [idx, row] of sessionTopRows.entries()) {
    const avgTotal = row.usageCalls > 0 ? row.totalLatencyMs / row.usageCalls : 0;
    const avgInternal = row.usageCalls > 0 ? row.totalInternalLatencyMs / row.usageCalls : 0;
    const avgExternal = row.usageCalls > 0 ? row.totalExternalLatencyMs / row.usageCalls : 0;
    const avgTrafficWait = row.usageCalls > 0 ? row.totalTrafficWaitMs / row.usageCalls : 0;
    const avgInjectWait = row.usageCalls > 0 ? row.totalClientInjectWaitMs / row.usageCalls : 0;
    const avgSseDecode = row.usageCalls > 0 ? row.totalSseDecodeMs / row.usageCalls : 0;
    const avgCodecDecode = row.usageCalls > 0 ? row.totalCodecDecodeMs / row.usageCalls : 0;
    const avgDecodeEffective = Math.max(avgSseDecode, avgCodecDecode);
    const avgCoreInternal = Math.max(
      0,
      avgInternal - avgTrafficWait - avgInjectWait - avgDecodeEffective
    );
    const avgAttempts = row.usageCalls > 0 ? row.totalProviderAttemptCount / row.usageCalls : 1;
    const avgRetries = row.usageCalls > 0 ? row.totalRetryCount / row.usageCalls : 0;
    const sessionDir = row.sessionId === 'unknown'
      ? '-'
      : (normalizeProjectPath(row.projectPath) || resolveProjectPathFromRegistry(row.sessionId) || '-');
    const sessionColor = resolveSessionAnsiColor(row.sessionId) || ANSI_SESSION;
    const sessionLabel = shortSessionId(row.sessionId);
    console.log(colorize(`  ${idx + 1}) session=${sessionLabel}`, sessionColor));
    console.log(colorize(`     project=${trimPathForLog(sessionDir)}`, sessionColor));
    console.log(
      colorize(
        `     virtual_hits=${row.virtualHits} usage_calls=${row.usageCalls} share=${formatRatio(row.usageCalls, totalUsageCalls)}`,
        sessionColor
      )
    );
    console.log(
      colorize(
        `     avg.total=${formatMs(avgTotal)} avg.internal=${formatMs(avgInternal)} avg.external=${formatMs(avgExternal)}`,
        sessionColor
      )
    );
    console.log(
      colorize(
        `     max.total=${formatMs(row.maxLatencyMs)} max.internal=${formatMs(row.maxInternalLatencyMs)} max.external=${formatMs(row.maxExternalLatencyMs)}`,
        sessionColor
      )
    );
    console.log(
      colorize(
        `     avg.retries=${avgRetries.toFixed(2)} avg.attempts=${avgAttempts.toFixed(2)} avg.wait.traffic=${formatMs(avgTrafficWait)} avg.wait.inject=${formatMs(avgInjectWait)} avg.decode.sse=${formatMs(avgSseDecode)} avg.decode.codec=${formatMs(avgCodecDecode)} avg.decode.effective=${formatMs(avgDecodeEffective)} avg.core_internal=${formatMs(avgCoreInternal)}`,
        sessionColor
      )
    );
  }
  if (sessionOtherRows.length > 0) {
    const otherVirtualHits = sessionOtherRows.reduce((sum, row) => sum + row.virtualHits, 0);
    const otherUsageCalls = sessionOtherRows.reduce((sum, row) => sum + row.usageCalls, 0);
    const otherTotal = sessionOtherRows.reduce((sum, row) => sum + row.totalLatencyMs, 0);
    const otherInternal = sessionOtherRows.reduce((sum, row) => sum + row.totalInternalLatencyMs, 0);
    const otherExternal = sessionOtherRows.reduce((sum, row) => sum + row.totalExternalLatencyMs, 0);
    const otherTrafficWait = sessionOtherRows.reduce((sum, row) => sum + row.totalTrafficWaitMs, 0);
    const otherInjectWait = sessionOtherRows.reduce((sum, row) => sum + row.totalClientInjectWaitMs, 0);
    const otherSseDecode = sessionOtherRows.reduce((sum, row) => sum + row.totalSseDecodeMs, 0);
    const otherCodecDecode = sessionOtherRows.reduce((sum, row) => sum + row.totalCodecDecodeMs, 0);
    const otherAttempts = sessionOtherRows.reduce((sum, row) => sum + row.totalProviderAttemptCount, 0);
    const otherRetries = sessionOtherRows.reduce((sum, row) => sum + row.totalRetryCount, 0);
    const avgTotal = otherUsageCalls > 0 ? otherTotal / otherUsageCalls : 0;
    const avgInternal = otherUsageCalls > 0 ? otherInternal / otherUsageCalls : 0;
    const avgExternal = otherUsageCalls > 0 ? otherExternal / otherUsageCalls : 0;
    const avgTrafficWait = otherUsageCalls > 0 ? otherTrafficWait / otherUsageCalls : 0;
    const avgInjectWait = otherUsageCalls > 0 ? otherInjectWait / otherUsageCalls : 0;
    const avgSseDecode = otherUsageCalls > 0 ? otherSseDecode / otherUsageCalls : 0;
    const avgCodecDecode = otherUsageCalls > 0 ? otherCodecDecode / otherUsageCalls : 0;
    const avgDecodeEffective = Math.max(avgSseDecode, avgCodecDecode);
    const avgCoreInternal = Math.max(
      0,
      avgInternal - avgTrafficWait - avgInjectWait - avgDecodeEffective
    );
    const avgAttempts = otherUsageCalls > 0 ? otherAttempts / otherUsageCalls : 1;
    const avgRetries = otherUsageCalls > 0 ? otherRetries / otherUsageCalls : 0;
    console.log(colorize('  others)', ANSI_SESSION));
    console.log(
      colorize(
        `     groups=${sessionOtherRows.length} virtual_hits=${otherVirtualHits} usage_calls=${otherUsageCalls} share=${formatRatio(otherUsageCalls, totalUsageCalls)}`,
        ANSI_SESSION
      )
    );
    console.log(
      colorize(
        `     avg.total=${formatMs(avgTotal)} avg.internal=${formatMs(avgInternal)} avg.external=${formatMs(avgExternal)}`,
        ANSI_SESSION
      )
    );
    console.log(
      colorize(
        `     avg.retries=${avgRetries.toFixed(2)} avg.attempts=${avgAttempts.toFixed(2)} avg.wait.traffic=${formatMs(avgTrafficWait)} avg.wait.inject=${formatMs(avgInjectWait)} avg.decode.sse=${formatMs(avgSseDecode)} avg.decode.codec=${formatMs(avgCodecDecode)} avg.decode.effective=${formatMs(avgDecodeEffective)} avg.core_internal=${formatMs(avgCoreInternal)}`,
        ANSI_SESSION
      )
    );
  }
  const timelineRows = Array.from(sessionRequestEvents.entries())
    .map(([sessionId, events]) => ({
      sessionId,
      events: [...events].sort((a, b) => a.atMs - b.atMs),
      projectPath: normalizeProjectPath(sessionRollups.get(sessionId)?.projectPath) || resolveProjectPathFromRegistry(sessionId)
    }))
    .filter((row) => row.events.length > 0)
    .sort((a, b) => {
      const aTs = a.events[0]?.atMs ?? 0;
      const bTs = b.events[0]?.atMs ?? 0;
      return aTs - bTs;
    });
  const timelineTotalRequests = timelineRows.reduce((sum, row) => sum + row.events.length, 0);
  console.log(
    colorize(
      `${ANSI_BOLD}[session-requests][1m]${ANSI_RESET} sessions=${timelineRows.length} requests=${timelineTotalRequests} order=by_session_then_time`,
      ANSI_SESSION
    )
  );
  if (timelineRows.length === 0) {
    console.log(colorize('  - no request timeline in this window', ANSI_DIM));
  }
  for (const [sessionIdx, row] of timelineRows.entries()) {
    const sessionColor = resolveSessionAnsiColor(row.sessionId) || ANSI_SESSION;
    const sessionLabel = shortSessionId(row.sessionId);
    const project = trimPathForLog(row.projectPath || '-');
    console.log(colorize(`  ${sessionIdx + 1}) session=${sessionLabel} project=${project}`, sessionColor));
    for (const [requestIdx, event] of row.events.entries()) {
      const ts = new Date(event.atMs).toLocaleTimeString();
      const routePool = formatRoutePool(event.routeName, event.poolId);
      const provider = formatProvider(event.providerKey, event.model);
      const requestLabel = shortRequestId(event.requestId);
      const finishReasonTag = ` ${ANSI_WHITE}finish_reason=${event.finishReason ?? 'unknown'}${ANSI_RESET}`;
      console.log(
        `${colorize(
          `     ${requestIdx + 1}. [${ts}] req=${requestLabel} ${routePool} -> ${provider} total=${formatMs(event.latencyMs)} internal=${formatMs(event.internalLatencyMs)} external=${formatMs(event.externalLatencyMs)} retries=${event.retryCount} attempts=${event.providerAttemptCount} wait.traffic=${formatMs(event.trafficWaitMs)} wait.inject=${formatMs(event.clientInjectWaitMs)} decode.sse=${formatMs(event.sseDecodeMs)} decode.codec=${formatMs(event.codecDecodeMs)}`,
          sessionColor
        )}${finishReasonTag}`
      );
    }
  }
  console.log(divider);

  clearWindow(nowMs);
}

export function __resetLogRollupForTest(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = undefined;
  }
  clearWindow(Date.now());
}
