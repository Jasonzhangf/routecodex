const truthy = new Set(['1', 'true', 'yes', 'on']);
const falsy = new Set(['0', 'false', 'no', 'off']);
const REQUEST_TIMELINES = new Map<string, { startedAtMs: number; lastAtMs: number }>();
const REQUEST_TIMELINE_TTL_MS = 30 * 60 * 1000;
const REQUEST_TIMELINE_MAX = 4096;
const DEFAULT_HUB_STAGE_LOG_MIN_MS = 25;

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
    }
  }
  while (REQUEST_TIMELINES.size > REQUEST_TIMELINE_MAX) {
    const oldestKey = REQUEST_TIMELINES.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    REQUEST_TIMELINES.delete(oldestKey);
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
}

export function logHubStageTiming(
  requestId: string,
  stage: string,
  phase: 'start' | 'completed' | 'error',
  details?: Record<string, unknown>
): void {
  if (!isHubStageTimingEnabled() || !requestId || !stage) {
    return;
  }
  if (phase === 'start') {
    touchTiming(requestId);
  }
  if (phase === 'start' && !isHubStageTimingVerboseEnabled()) {
    return;
  }
  const timing = advanceTiming(requestId);
  if (phase !== 'error') {
    const forceLog = details?.forceLog === true;
    if (forceLog && isHubStageTimingDetailEnabled()) {
      const detailSuffix = renderDetails(details);
      const line = `[hub.detail][${requestId}] ${stage}.${phase}${timing.label}${detailSuffix}`;
      console.log(line);
      return;
    }
    const thresholdMs = resolveHubStageTimingMinMs();
    const elapsedMs =
      typeof details?.elapsedMs === 'number'
        ? details.elapsedMs
        : typeof details?.nativeMs === 'number'
          ? details.nativeMs
          : undefined;
    if (elapsedMs !== undefined && elapsedMs < thresholdMs) {
      return;
    }
    if (timing.deltaMs < thresholdMs) {
      return;
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
    const mapped = options?.mapErrorDetails?.(error);
    const message = error instanceof Error ? error.message : String(error ?? 'unknown');
    logHubStageTiming(requestId, stage, 'error', mapped ?? {
      elapsedMs: Math.max(0, Date.now() - startedAt),
      message
    });
    throw error;
  }
}
