const truthy = new Set(['1', 'true', 'yes', 'on']);
const falsy = new Set(['0', 'false', 'no', 'off']);
// Native alignment note: timing integrates with *WithNative stage orchestration flow.
const REQUEST_TIMELINES = new Map<string, { startedAtMs: number; lastAtMs: number }>();
const REQUEST_TIMELINE_TTL_MS = 30 * 60 * 1000;
const REQUEST_TIMELINE_MAX = 4096;
const DEFAULT_HUB_STAGE_LOG_MIN_MS = 50;
const DEFAULT_HUB_STAGE_TOP_N = 5;
const DEFAULT_HUB_STAGE_TOP_MIN_MS = 5;

type HubStageBreakdownEntry = {
  totalMs: number;
  count: number;
  maxMs: number;
};

const REQUEST_STAGE_BREAKDOWNS = new Map<string, Map<string, HubStageBreakdownEntry>>();

function resolveBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (truthy.has(normalized)) {
    return true;
  }
  if (falsy.has(normalized)) {
    return false;
  }
  return fallback;
}

function isHubStageTimingEnabled(): boolean {
  const explicit =
    process.env.ROUTECODEX_STAGE_TIMING ??
    process.env.RCC_STAGE_TIMING ??
    process.env.ROUTECODEX_HUB_STAGE_TIMING ??
    process.env.RCC_HUB_STAGE_TIMING;
  if (explicit !== undefined) {
    return resolveBool(explicit, false);
  }
  return false;
}

function isHubStageTimingVerboseEnabled(): boolean {
  const explicit =
    process.env.ROUTECODEX_STAGE_TIMING_VERBOSE ??
    process.env.RCC_STAGE_TIMING_VERBOSE ??
    process.env.ROUTECODEX_HUB_STAGE_TIMING_VERBOSE ??
    process.env.RCC_HUB_STAGE_TIMING_VERBOSE;
  if (explicit !== undefined) {
    return resolveBool(explicit, false);
  }
  return false;
}

export function isHubStageTimingDetailEnabled(): boolean {
  const explicit =
    process.env.ROUTECODEX_STAGE_TIMING_DETAIL ??
    process.env.RCC_STAGE_TIMING_DETAIL ??
    process.env.ROUTECODEX_HUB_STAGE_TIMING_DETAIL ??
    process.env.RCC_HUB_STAGE_TIMING_DETAIL;
  if (explicit !== undefined) {
    return resolveBool(explicit, false);
  }
  return false;
}

function resolveHubStageTimingMinMs(): number {
  const raw =
    process.env.ROUTECODEX_STAGE_TIMING_MIN_MS ??
    process.env.RCC_STAGE_TIMING_MIN_MS ??
    process.env.ROUTECODEX_HUB_STAGE_TIMING_MIN_MS ??
    process.env.RCC_HUB_STAGE_TIMING_MIN_MS;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }
  return DEFAULT_HUB_STAGE_LOG_MIN_MS;
}

function prune(nowMs: number): void {
  for (const [key, timeline] of REQUEST_TIMELINES.entries()) {
    if (nowMs - timeline.lastAtMs >= REQUEST_TIMELINE_TTL_MS) {
      REQUEST_TIMELINES.delete(key);
      REQUEST_STAGE_BREAKDOWNS.delete(key);
    }
  }
  while (REQUEST_TIMELINES.size > REQUEST_TIMELINE_MAX) {
    const oldestKey = REQUEST_TIMELINES.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    REQUEST_TIMELINES.delete(oldestKey);
    REQUEST_STAGE_BREAKDOWNS.delete(oldestKey);
  }
}

function touchTiming(requestId: string): void {
  const nowMs = Date.now();
  prune(nowMs);
  const existing = REQUEST_TIMELINES.get(requestId);
  if (!existing) {
    REQUEST_TIMELINES.set(requestId, {
      startedAtMs: nowMs,
      lastAtMs: nowMs
    });
    return;
  }
  existing.lastAtMs = nowMs;
}

function advanceTiming(requestId: string): { label: string; totalMs: number; deltaMs: number } {
  const nowMs = Date.now();
  prune(nowMs);
  const existing = REQUEST_TIMELINES.get(requestId);
  if (!existing) {
    REQUEST_TIMELINES.set(requestId, {
      startedAtMs: nowMs,
      lastAtMs: nowMs
    });
    return {
      label: ' t+0ms Δ0ms',
      totalMs: 0,
      deltaMs: 0
    };
  }
  const totalMs = Math.max(0, Math.round(nowMs - existing.startedAtMs));
  const deltaMs = Math.max(0, Math.round(nowMs - existing.lastAtMs));
  existing.lastAtMs = nowMs;
  return {
    label: ` t+${totalMs}ms Δ${deltaMs}ms`,
    totalMs,
    deltaMs
  };
}

function renderDetails(details?: Record<string, unknown>): string {
  if (!details || Object.keys(details).length === 0) {
    return '';
  }
  try {
    return ` ${JSON.stringify(details)}`;
  } catch {
    return '';
  }
}

export function clearHubStageTiming(requestId: string | undefined | null): void {
  if (!requestId) {
    return;
  }
  REQUEST_TIMELINES.delete(requestId);
  REQUEST_STAGE_BREAKDOWNS.delete(requestId);
}

function recordHubStageElapsed(
  requestId: string,
  stage: string,
  elapsedMs: number
): void {
  if (!requestId || !stage || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return;
  }
  const nowMs = Date.now();
  prune(nowMs);
  const byStage = REQUEST_STAGE_BREAKDOWNS.get(requestId) ?? new Map<string, HubStageBreakdownEntry>();
  if (!REQUEST_STAGE_BREAKDOWNS.has(requestId)) {
    REQUEST_STAGE_BREAKDOWNS.set(requestId, byStage);
  }
  const existing = byStage.get(stage);
  if (!existing) {
    byStage.set(stage, {
      totalMs: elapsedMs,
      count: 1,
      maxMs: elapsedMs
    });
    return;
  }
  existing.totalMs += elapsedMs;
  existing.count += 1;
  existing.maxMs = Math.max(existing.maxMs, elapsedMs);
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

export type HubStageTopSummaryEntry = {
  stage: string;
  totalMs: number;
  count: number;
  avgMs: number;
  maxMs: number;
};

export function peekHubStageTopSummary(
  requestId: string | undefined | null,
  options?: {
    topN?: number;
    minMs?: number;
  }
): HubStageTopSummaryEntry[] {
  if (!requestId) {
    return [];
  }
  const byStage = REQUEST_STAGE_BREAKDOWNS.get(requestId);
  if (!byStage || !byStage.size) {
    return [];
  }
  const topN = Math.max(1, options?.topN ?? readIntEnv('ROUTECODEX_HUB_STAGE_TOP_N', DEFAULT_HUB_STAGE_TOP_N));
  const minMs = Math.max(0, options?.minMs ?? readIntEnv('ROUTECODEX_HUB_STAGE_TOP_MIN_MS', DEFAULT_HUB_STAGE_TOP_MIN_MS));
  return Array.from(byStage.entries())
    .map(([stage, stats]) => {
      const totalMs = Math.max(0, Math.round(stats.totalMs));
      const count = Math.max(0, Math.floor(stats.count));
      const maxMs = Math.max(0, Math.round(stats.maxMs));
      const avgMs = count > 0 ? Math.max(0, Math.round(totalMs / count)) : 0;
      return {
        stage,
        totalMs,
        count,
        avgMs,
        maxMs
      };
    })
    .filter((entry) => entry.totalMs >= minMs)
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, topN);
}

export function logHubStageTiming(
  requestId: string,
  stage: string,
  phase: 'start' | 'completed' | 'error',
  details?: Record<string, unknown>
): void {
  const stageElapsedMs =
    phase === 'completed' || phase === 'error'
      ? (
          typeof details?.elapsedMs === 'number'
            ? details.elapsedMs
            : typeof details?.nativeMs === 'number'
              ? details.nativeMs
              : undefined
        )
      : undefined;
  if (
    requestId &&
    stage &&
    typeof stageElapsedMs === 'number' &&
    Number.isFinite(stageElapsedMs) &&
    stageElapsedMs >= 0
  ) {
    recordHubStageElapsed(requestId, stage, stageElapsedMs);
  }
  if (!isHubStageTimingEnabled() || !requestId || !stage) {
    return;
  }
  if (phase === 'start') {
    touchTiming(requestId);
  }
  
  // Skip start phases in non-verbose mode (they don't have elapsedMs anyway)
  if (phase === 'start' && !isHubStageTimingVerboseEnabled()) {
    return;
  }
  
  const timing = advanceTiming(requestId);
  const thresholdMs = resolveHubStageTimingMinMs();
  
  // Only gate non-error phases
  if (phase !== 'error') {
    const forceLog = details?.forceLog === true;
    
    // forceLog with detail mode: check elapsedMs if available, otherwise allow
    if (forceLog && isHubStageTimingDetailEnabled()) {
      const elapsedMs =
        typeof details?.elapsedMs === 'number'
          ? details.elapsedMs
          : typeof details?.nativeMs === 'number'
            ? details.nativeMs
            : undefined;
      // Even forceLog respects elapsedMs threshold if provided
      if (elapsedMs !== undefined && elapsedMs < thresholdMs) {
        return;
      }
      const detailSuffix = renderDetails(details);
      const line = `[hub.detail][${requestId}] ${stage}.${phase}${timing.label}${detailSuffix}`;
      console.log(line);
      return;
    }
    
    // For completed phases: use elapsedMs if available (actual stage duration)
    // This is the PRIMARY gating mechanism for completed stages
    const elapsedMs =
      typeof details?.elapsedMs === 'number'
        ? details.elapsedMs
        : typeof details?.nativeMs === 'number'
          ? details.nativeMs
          : undefined;
    
    if (elapsedMs !== undefined) {
      // Has elapsedMs: gate by elapsedMs (stage's actual duration)
      if (elapsedMs < thresholdMs) {
        return;
      }
    } else {
      // No elapsedMs: gate by deltaMs (time since last log)
      // This handles start phases and any completed phases without elapsedMs
      if (timing.deltaMs < thresholdMs) {
        return;
      }
    }
  }
  
  const detailSuffix = renderDetails(details);
  const line = `[hub.detail][${requestId}] ${stage}.${phase}${timing.label}${detailSuffix}`;
  if (phase === 'error') {
    console.error(line);
    return;
  }
  console.log(line);
}

export async function measureHubStage<T>(
  requestId: string,
  stage: string,
  fn: () => Promise<T> | T,
  options?: {
    startDetails?: Record<string, unknown>;
    mapCompletedDetails?: (value: T) => Record<string, unknown> | undefined;
    mapErrorDetails?: (error: unknown) => Record<string, unknown> | undefined;
  }
): Promise<T> {
  const startedAt = Date.now();
  logHubStageTiming(requestId, stage, 'start', options?.startDetails);
  try {
    const value = await fn();
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    logHubStageTiming(requestId, stage, 'completed', {
      elapsedMs,
      ...(options?.mapCompletedDetails?.(value) ?? {})
    });
    return value;
  } catch (error) {
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    const mapped = options?.mapErrorDetails?.(error);
    const message = error instanceof Error ? error.message : String(error ?? 'unknown');
    logHubStageTiming(requestId, stage, 'error', mapped ?? {
      elapsedMs,
      message
    });
    throw error;
  }
}
