import { buildInfo } from '../../build-info.js';

const truthy = new Set(['1', 'true', 'yes']);
const falsy = new Set(['0', 'false', 'no']);
let cachedStageLoggingFlag: boolean | null = null;
let cachedStageVerboseFlag: boolean | null = null;
let cachedStageTimingFlag: boolean | null = null;
let cachedStageTimingSummaryFlag: boolean | null = null;

const REQUEST_STAGE_TIMELINE_TTL_MS = 30 * 60 * 1000;
const REQUEST_STAGE_TIMELINE_MAX = 4096;
type RequestStageTimeline = {
  startedAtMs: number;
  lastAtMs: number;
};
const REQUEST_STAGE_TIMELINES = new Map<string, RequestStageTimeline>();
const REQUEST_SCOPE_STAGE_STARTS = new Map<string, number>();

const COLOR_RESET = '\x1b[0m';
const COLOR_INFO = '\x1b[90m';
const COLOR_START = '\x1b[36m';
const COLOR_SUCCESS = '\x1b[32m';
const COLOR_ERROR = '\x1b[31m';
type StageLevel = 'info' | 'start' | 'success' | 'error';

function resolveBoolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) {return fallback;}
  const normalized = value.trim().toLowerCase();
  if (truthy.has(normalized)) {return true;}
  if (falsy.has(normalized)) {return false;}
  return fallback;
}

function computeStageLoggingEnabled(): boolean {
  const raw = String(process.env.ROUTECODEX_STAGE_LOG ?? process.env.RCC_STAGE_LOG ?? '').trim().toLowerCase();
  if (truthy.has(raw)) {
    return true;
  }
  if (falsy.has(raw)) {
    return false;
  }

  const nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase();
  if (nodeEnv === 'development') {
    return true;
  }

  const runtimeBuildMode = String(process.env.ROUTECODEX_BUILD_MODE ?? process.env.BUILD_MODE ?? '').trim().toLowerCase();
  if (runtimeBuildMode === 'dev' || runtimeBuildMode === 'development') {
    return true;
  }

  return buildInfo.mode === 'dev';
}

function computeStageVerboseEnabled(): boolean {
  return resolveBoolFromEnv(
    process.env.ROUTECODEX_STAGE_LOG_VERBOSE
      ?? process.env.RCC_STAGE_LOG_VERBOSE
      ?? process.env.ROUTECODEX_PIPELINE_LOG_VERBOSE
      ?? process.env.RCC_PIPELINE_LOG_VERBOSE,
    false
  );
}

function computeStageTimingEnabled(): boolean {
  const raw =
    process.env.ROUTECODEX_STAGE_TIMING
    ?? process.env.RCC_STAGE_TIMING
    ?? process.env.ROUTECODEX_DEBUG_STAGE_TIMING
    ?? process.env.RCC_DEBUG_STAGE_TIMING;
  if (raw !== undefined) {
    return resolveBoolFromEnv(raw, false);
  }
  return false;
}

function computeStageTimingSummaryEnabled(): boolean {
  return resolveBoolFromEnv(
    process.env.ROUTECODEX_STAGE_TIMING_SUMMARY
      ?? process.env.RCC_STAGE_TIMING_SUMMARY,
    false
  );
}

function isStageVerboseEnabled(): boolean {
  if (cachedStageVerboseFlag === null) {
    cachedStageVerboseFlag = computeStageVerboseEnabled();
  }
  return cachedStageVerboseFlag;
}

function isStageTimingEnabled(): boolean {
  if (cachedStageTimingFlag === null) {
    cachedStageTimingFlag = computeStageTimingEnabled();
  }
  return cachedStageTimingFlag;
}

function isStageTimingSummaryEnabled(): boolean {
  if (cachedStageTimingSummaryFlag === null) {
    cachedStageTimingSummaryFlag = computeStageTimingSummaryEnabled();
  }
  return cachedStageTimingSummaryFlag;
}

export function isStageLoggingEnabled(): boolean {
  if (cachedStageLoggingFlag === null) {
    cachedStageLoggingFlag = computeStageLoggingEnabled();
  }
  return cachedStageLoggingFlag;
}

export function logPipelineStage(stage: string, requestId: string, details?: Record<string, unknown>): void {
  const timingEnabled = isStageTimingEnabled();
  const timingSummaryEnabled = isStageTimingSummaryEnabled();
  const { scope, action } = parseStage(stage);
  const level = detectStageLevel(stage);
  const releaseSummaryStage = shouldLogReleaseSummaryStage(stage);
  const releaseSummaryTrackedScope = shouldTrackReleaseSummaryScope(stage);

  if ((timingEnabled || timingSummaryEnabled || releaseSummaryTrackedScope) && !REQUEST_STAGE_TIMELINES.has(requestId)) {
    touchRequestStageTimeline(requestId);
  }

  if ((timingEnabled || releaseSummaryTrackedScope) && level === 'start') {
    touchRequestStageTimeline(requestId);
    markScopeStageStart(requestId, scope);
  }

  if (!isStageLoggingEnabled() && !releaseSummaryStage) {
    return;
  }

  const verbose = isStageVerboseEnabled();

  const scopeElapsedMs = resolveScopeStageElapsedMs(requestId, scope, level);

  if (!shouldLogStage(stage, scope, level, verbose, timingEnabled, releaseSummaryStage)) {
    return;
  }

  const showDetail = !releaseSummaryStage && (verbose || level === 'error');
  const providerLabel = showDetail && typeof details?.providerLabel === 'string' ? details?.providerLabel : undefined;
  const detailPayload = showDetail
    ? (providerLabel
      ? (() => {
          const clone = { ...details } as Record<string, unknown>;
          delete clone.providerLabel;
          return clone;
        })()
      : details)
    : undefined;

  const timingLabel = timingEnabled
    ? advanceRequestStageTimingLabel(requestId)
    : releaseSummaryStage
      ? formatReleaseSummaryTimingLabel(
        (typeof details?.elapsedMs === 'number' ? details.elapsedMs : undefined)
          ?? scopeElapsedMs
          ?? peekRequestStageTimingStats(requestId)?.deltaMs
      )
      : '';
  const suffix = detailPayload && Object.keys(detailPayload).length ? ` ${JSON.stringify(detailPayload)}` : '';
  const label = `[${scope}][${requestId}] ${action}${timingLabel}`;
  const providerTag = providerLabel ? ` ${colorizeProviderLabel(level, providerLabel)}` : '';
  console.log(`${colorize(level, label)}${providerTag}${suffix}`);
  if (isTerminalStage(stage) && !timingSummaryEnabled) {
    clearRequestStageState(requestId);
  }
}

export function formatRequestTimingSummary(requestId: string, options?: { terminal?: boolean }): string {
  if (!isStageTimingSummaryEnabled()) {
    return '';
  }
  const label = peekRequestStageTimingLabel(requestId);
  if (options?.terminal) {
    clearRequestStageState(requestId);
  }
  return label;
}

export function rebindRequestTimingTimeline(fromRequestId: string, toRequestId: string): void {
  if (!fromRequestId || !toRequestId || fromRequestId === toRequestId) {
    return;
  }
  const fromTimeline = REQUEST_STAGE_TIMELINES.get(fromRequestId);
  if (!fromTimeline) {
    return;
  }
  const existing = REQUEST_STAGE_TIMELINES.get(toRequestId);
  if (!existing) {
    REQUEST_STAGE_TIMELINES.set(toRequestId, { ...fromTimeline });
    REQUEST_STAGE_TIMELINES.delete(fromRequestId);
    return;
  }
  existing.startedAtMs = Math.min(existing.startedAtMs, fromTimeline.startedAtMs);
  existing.lastAtMs = Math.max(existing.lastAtMs, fromTimeline.lastAtMs);
  REQUEST_STAGE_TIMELINES.delete(fromRequestId);
}

function shouldLogStage(
  stage: string,
  scope: string,
  level: StageLevel,
  verbose: boolean,
  timingEnabled: boolean,
  releaseSummaryStage: boolean
): boolean {
  const normalizedScope = scope.trim().toLowerCase();
  const normalizedStage = stage.trim().toLowerCase();

  if (releaseSummaryStage) {
    return true;
  }

  // `response.sse.preview` is too noisy even in timing mode.
  if (normalizedStage === 'response.sse.preview') {
    return false;
  }

  // HTTP handlers already emit one concise colored request-failed line.
  // Keep provider.send.error silent even in timing mode to avoid duplicates.
  if (normalizedScope === 'provider.send' && normalizedStage.endsWith('.error')) {
    return false;
  }

  if (timingEnabled) {
    return true;
  }

  if (verbose) {
    return true;
  }

  // Keep default runtime logs concise:
  // - only errors are printed by stage logger
  // - detailed pipeline/hub/provider lifecycle logs are available in verbose mode.
  if (level === 'error') {
    // HTTP handlers already print a single colored terminal error line.
    // Suppress provider send errors here to avoid duplicate console output.
    if (normalizedScope === 'provider.send' || normalizedStage.startsWith('provider.send.')) {
      return false;
    }
    return true;
  }

  if (normalizedScope === 'response.sse' || normalizedStage.startsWith('response.sse')) {
    return false;
  }

  if (scope.startsWith('response.sse')) {
    return false;
  }

  return false;
}

function parseStage(stage: string): { scope: string; action: string } {
  const segments = stage.split('.').filter(Boolean);
  if (segments.length <= 1) {
    return { scope: 'pipeline', action: segments[0] || stage };
  }
  return {
    scope: segments.slice(0, -1).join('.'),
    action: segments[segments.length - 1]
  };
}

function detectStageLevel(stage: string): StageLevel {
  const normalized = stage.toLowerCase();
  if (normalized.includes('error') || normalized.includes('fail')) {
    return 'error';
  }
  if (normalized.includes('completed') || normalized.includes('end')) {
    return 'success';
  }
  if (normalized.includes('start') || normalized.includes('prepare')) {
    return 'start';
  }
  return 'info';
}

function colorize(level: StageLevel, text: string): string {
  switch (level) {
    case 'start':
      return `${COLOR_START}${text}${COLOR_RESET}`;
    case 'success':
      return `${COLOR_SUCCESS}${text}${COLOR_RESET}`;
    case 'error':
      return `${COLOR_ERROR}${text}${COLOR_RESET}`;
    default:
      return `${COLOR_INFO}${text}${COLOR_RESET}`;
  }
}

function colorizeProviderLabel(level: StageLevel, label: string): string {
  const color = level === 'error' ? COLOR_ERROR : COLOR_SUCCESS;
  return `${color}[${label}]${COLOR_RESET}`;
}

function pruneRequestStageTimelines(nowMs: number): void {
  for (const [key, timeline] of REQUEST_STAGE_TIMELINES.entries()) {
    if (nowMs - timeline.lastAtMs >= REQUEST_STAGE_TIMELINE_TTL_MS) {
      REQUEST_STAGE_TIMELINES.delete(key);
    }
  }
  while (REQUEST_STAGE_TIMELINES.size > REQUEST_STAGE_TIMELINE_MAX) {
    const oldestKey = REQUEST_STAGE_TIMELINES.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    REQUEST_STAGE_TIMELINES.delete(oldestKey);
  }
}

function scopeStageKey(requestId: string, scope: string): string {
  return `${requestId}::${scope.trim().toLowerCase()}`;
}

function markScopeStageStart(requestId: string, scope: string): void {
  if (!requestId || !scope) {
    return;
  }
  REQUEST_SCOPE_STAGE_STARTS.set(scopeStageKey(requestId, scope), Date.now());
}

function resolveScopeStageElapsedMs(requestId: string, scope: string, level: StageLevel): number | undefined {
  if (level !== 'success' && level !== 'error') {
    return undefined;
  }
  const key = scopeStageKey(requestId, scope);
  const startedAtMs = REQUEST_SCOPE_STAGE_STARTS.get(key);
  if (startedAtMs === undefined) {
    return undefined;
  }
  REQUEST_SCOPE_STAGE_STARTS.delete(key);
  return Math.max(0, Date.now() - startedAtMs);
}

function formatReleaseSummaryTimingLabel(elapsedMs: number | undefined): string {
  if (elapsedMs === undefined) {
    return '';
  }
  return ` total=${formatDurationMs(elapsedMs)}`;
}

function shouldLogReleaseSummaryStage(stage: string): boolean {
  if (buildInfo.mode !== 'release') {
    return false;
  }
  const normalized = stage.trim().toLowerCase();
  return normalized === 'hub.completed' || normalized === 'provider.send.completed';
}

function shouldTrackReleaseSummaryScope(stage: string): boolean {
  if (buildInfo.mode !== 'release') {
    return false;
  }
  const normalized = stage.trim().toLowerCase();
  return normalized === 'hub.start'
    || normalized === 'hub.completed'
    || normalized === 'provider.send.start'
    || normalized === 'provider.send.completed';
}

function clearRequestStageState(requestId: string): void {
  REQUEST_STAGE_TIMELINES.delete(requestId);
  for (const key of REQUEST_SCOPE_STAGE_STARTS.keys()) {
    if (key.startsWith(`${requestId}::`)) {
      REQUEST_SCOPE_STAGE_STARTS.delete(key);
    }
  }
}

function formatDurationMs(value: number): string {
  const rounded = Math.max(0, Math.round(value));
  return `${rounded}ms`;
}

function touchRequestStageTimeline(requestId: string): void {
  const nowMs = Date.now();
  pruneRequestStageTimelines(nowMs);
  const existing = REQUEST_STAGE_TIMELINES.get(requestId);
  if (!existing) {
    REQUEST_STAGE_TIMELINES.set(requestId, {
      startedAtMs: nowMs,
      lastAtMs: nowMs
    });
    return;
  }
  existing.lastAtMs = nowMs;
}

function peekRequestStageTimingStats(requestId: string): { totalMs: number; deltaMs: number } | null {
  const nowMs = Date.now();
  pruneRequestStageTimelines(nowMs);
  const existing = REQUEST_STAGE_TIMELINES.get(requestId);
  if (!existing) {
    return null;
  }
  return {
    totalMs: nowMs - existing.startedAtMs,
    deltaMs: nowMs - existing.lastAtMs
  };
}

function advanceRequestStageTimingLabel(requestId: string): string {
  const nowMs = Date.now();
  pruneRequestStageTimelines(nowMs);
  const existing = REQUEST_STAGE_TIMELINES.get(requestId);
  if (!existing) {
    REQUEST_STAGE_TIMELINES.set(requestId, {
      startedAtMs: nowMs,
      lastAtMs: nowMs
    });
    return ' t+0ms Δ0ms';
  }
  const totalMs = nowMs - existing.startedAtMs;
  const deltaMs = nowMs - existing.lastAtMs;
  existing.lastAtMs = nowMs;
  return ` t+${formatDurationMs(totalMs)} Δ${formatDurationMs(deltaMs)}`;
}

function peekRequestStageTimingLabel(requestId: string): string {
  const nowMs = Date.now();
  pruneRequestStageTimelines(nowMs);
  const existing = REQUEST_STAGE_TIMELINES.get(requestId);
  if (!existing) {
    return '';
  }
  const totalMs = nowMs - existing.startedAtMs;
  const deltaMs = nowMs - existing.lastAtMs;
  return ` t+${formatDurationMs(totalMs)} Δ${formatDurationMs(deltaMs)}`;
}

function isTerminalStage(stage: string): boolean {
  const normalized = stage.trim().toLowerCase();
  return normalized === 'response.json.completed'
    || normalized === 'response.json.empty'
    || normalized === 'response.sse.stream.end'
    || normalized === 'response.sse.stream.error'
    || normalized === 'response.sse.missing';
}
