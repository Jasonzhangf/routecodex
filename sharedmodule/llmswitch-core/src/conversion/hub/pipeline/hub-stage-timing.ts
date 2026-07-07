import { METADATA_CENTER_SYMBOL, RUST_SNAPSHOT_SYMBOL } from '../metadata-center-runtime-control-writer.js';

// feature_id: hub.stage_timing_observation

const truthy = new Set(["1", "true", "yes", "on"]);
const falsy = new Set(["0", "false", "no", "off"]);

const DEFAULT_HUB_STAGE_LOG_MIN_MS = 50;
const DEFAULT_HUB_STAGE_TOP_N = 5;
const DEFAULT_HUB_STAGE_TOP_MIN_MS = 5;
const REQUEST_TIMELINE_TTL_MS = 30 * 60 * 1000;
const REQUEST_TIMELINE_MAX = 4096;

const REQUEST_TIMELINES = new Map<
  string,
  { startedAtMs: number; lastAtMs: number }
>();

const REQUEST_STAGE_BREAKDOWNS = new Map<
  string,
  Map<string, { totalMs: number; count: number; maxMs: number }>
>();

export type HubStageTimingPhase = "start" | "completed" | "error";

export type HubStageTopSummaryEntry = {
  stage: string;
  totalMs: number;
  count: number;
  avgMs: number;
  maxMs: number;
};

function resolveBool(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) {
    return defaultValue;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (truthy.has(normalized)) {
    return true;
  }
  if (falsy.has(normalized)) {
    return false;
  }
  return defaultValue;
}

function readIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  const parsed = Number.parseInt(String(raw ?? "").trim(), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return defaultValue;
}

function isHubStageTimingEnabled(): boolean {
  const explicit =
    process.env.ROUTECODEX_STAGE_TIMING ??
    process.env.RCC_STAGE_TIMING ??
    process.env.ROUTECODEX_HUB_STAGE_TIMING ??
    process.env.RCC_HUB_STAGE_TIMING;
  return explicit !== undefined ? resolveBool(explicit, false) : false;
}

export function isHubStageTimingDetailEnabled(): boolean {
  const explicit =
    process.env.ROUTECODEX_STAGE_TIMING_DETAIL ??
    process.env.RCC_STAGE_TIMING_DETAIL ??
    process.env.ROUTECODEX_HUB_STAGE_TIMING_DETAIL ??
    process.env.RCC_HUB_STAGE_TIMING_DETAIL;
  return explicit !== undefined ? resolveBool(explicit, false) : false;
}

function isHubStageTimingVerboseEnabled(): boolean {
  const explicit =
    process.env.ROUTECODEX_STAGE_TIMING_VERBOSE ??
    process.env.RCC_STAGE_TIMING_VERBOSE ??
    process.env.ROUTECODEX_HUB_STAGE_TIMING_VERBOSE ??
    process.env.RCC_HUB_STAGE_TIMING_VERBOSE;
  return explicit !== undefined ? resolveBool(explicit, false) : false;
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

function resolveHubStageTopN(override?: number): number {
  return Math.max(
    1,
    override ??
      readIntEnv("ROUTECODEX_HUB_STAGE_TOP_N", DEFAULT_HUB_STAGE_TOP_N),
  );
}

function resolveHubStageTopMinMs(override?: number): number {
  return Math.max(
    0,
    override ??
      readIntEnv(
        "ROUTECODEX_HUB_STAGE_TOP_MIN_MS",
        DEFAULT_HUB_STAGE_TOP_MIN_MS,
      ),
  );
}

function pruneTimingState(nowMs: number): void {
  const removedRequestIds: string[] = [];
  for (const [key, timeline] of REQUEST_TIMELINES.entries()) {
    if (nowMs - timeline.lastAtMs >= REQUEST_TIMELINE_TTL_MS) {
      REQUEST_TIMELINES.delete(key);
      removedRequestIds.push(key);
    }
  }
  while (REQUEST_TIMELINES.size > REQUEST_TIMELINE_MAX) {
    const oldestKey = REQUEST_TIMELINES.keys().next().value as
      | string
      | undefined;
    if (!oldestKey) {
      break;
    }
    REQUEST_TIMELINES.delete(oldestKey);
    removedRequestIds.push(oldestKey);
  }
  for (const requestId of removedRequestIds) {
    REQUEST_STAGE_BREAKDOWNS.delete(requestId);
  }
}

function touchTiming(requestId: string): void {
  const nowMs = Date.now();
  pruneTimingState(nowMs);
  const existing = REQUEST_TIMELINES.get(requestId);
  if (!existing) {
    REQUEST_TIMELINES.set(requestId, {
      startedAtMs: nowMs,
      lastAtMs: nowMs,
    });
    return;
  }
  existing.lastAtMs = nowMs;
}

function advanceTiming(requestId: string): {
  label: string;
  totalMs: number;
  deltaMs: number;
} {
  const nowMs = Date.now();
  pruneTimingState(nowMs);
  const existing = REQUEST_TIMELINES.get(requestId);
  if (!existing) {
    REQUEST_TIMELINES.set(requestId, {
      startedAtMs: nowMs,
      lastAtMs: nowMs,
    });
    return { label: " t+0ms Δ0ms", totalMs: 0, deltaMs: 0 };
  }
  const totalMs = Math.max(0, Math.round(nowMs - existing.startedAtMs));
  const deltaMs = Math.max(0, Math.round(nowMs - existing.lastAtMs));
  existing.lastAtMs = nowMs;
  return {
    label: ` t+${totalMs}ms Δ${deltaMs}ms`,
    totalMs,
    deltaMs,
  };
}

function recordHubStageElapsed(
  requestId: string,
  stage: string,
  elapsedMs: number,
): void {
  if (!requestId || !stage || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return;
  }
  pruneTimingState(Date.now());
  const byStage =
    REQUEST_STAGE_BREAKDOWNS.get(requestId) ??
    new Map<string, { totalMs: number; count: number; maxMs: number }>();
  if (!REQUEST_STAGE_BREAKDOWNS.has(requestId)) {
    REQUEST_STAGE_BREAKDOWNS.set(requestId, byStage);
  }
  const existing = byStage.get(stage);
  if (!existing) {
    byStage.set(stage, {
      totalMs: elapsedMs,
      count: 1,
      maxMs: elapsedMs,
    });
    return;
  }
  existing.totalMs += elapsedMs;
  existing.count += 1;
  existing.maxMs = Math.max(existing.maxMs, elapsedMs);
}

function renderTimingDetails(details?: Record<string, unknown>): string {
  if (!details || Object.keys(details).length === 0) {
    return "";
  }
  try {
    return ` ${JSON.stringify(details)}`;
  } catch (err) {
    console.warn('[renderTimingDetails] JSON.stringify failed:', err);
    return "";
  }
}

function resolveStageElapsedMs(
  phase: HubStageTimingPhase,
  details?: Record<string, unknown>,
): number | undefined {
  if (phase !== "completed" && phase !== "error") {
    return undefined;
  }
  if (typeof details?.elapsedMs === "number") {
    return details.elapsedMs;
  }
  if (typeof details?.nativeMs === "number") {
    return details.nativeMs;
  }
  return undefined;
}

function shouldSkipHubStageTimingLog(args: {
  phase: HubStageTimingPhase;
  details?: Record<string, unknown>;
  thresholdMs: number;
  deltaMs: number;
}): boolean {
  if (args.phase === "start" && !isHubStageTimingVerboseEnabled()) {
    return true;
  }
  if (args.phase === "error") {
    return false;
  }
  const elapsedMs = resolveStageElapsedMs(args.phase, args.details);
  if (args.details?.forceLog === true && isHubStageTimingDetailEnabled()) {
    return elapsedMs !== undefined && elapsedMs < args.thresholdMs;
  }
  if (elapsedMs !== undefined) {
    return elapsedMs < args.thresholdMs;
  }
  return args.deltaMs < args.thresholdMs;
}

function buildHubStageTimingLine(args: {
  requestId: string;
  stage: string;
  phase: HubStageTimingPhase;
  timingLabel: string;
  details?: Record<string, unknown>;
}): string {
  const detailSuffix = renderTimingDetails(args.details);
  return `[hub.detail][${args.requestId}] ${args.stage}.${args.phase}${args.timingLabel}${detailSuffix}`;
}

type MetadataCenterLike = {
  writeDebugSnapshot?: (
    key: string,
    value: unknown,
    writer: { module: string; symbol: string; stage: string },
    reason?: string,
  ) => void;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function writeMetadataCenterSlot(args: {
  target: Record<string, unknown>;
  center: MetadataCenterLike;
  family: 'debug_snapshot';
  key: string;
  value: unknown;
  writer: { module: string; symbol: string; stage: string };
  reason: string;
}): void {
  if (args.family !== 'debug_snapshot') {
    throw new Error(`MetadataCenter unsupported family for hub-stage timing: ${args.family}`);
  }
  args.center.writeDebugSnapshot?.(args.key, args.value, args.writer, args.reason);
  const currentSnapshot = asRecord(Reflect.get(args.target, RUST_SNAPSHOT_SYMBOL));
  const nextSnapshot = currentSnapshot ? { ...currentSnapshot } : {};
  const debugSnapshot = asRecord(nextSnapshot.debugSnapshot) ?? {};
  debugSnapshot[args.key] = structuredClone(args.value);
  nextSnapshot.debugSnapshot = debugSnapshot;
  Reflect.set(args.target, RUST_SNAPSHOT_SYMBOL, nextSnapshot);
}

export function clearHubStageTiming(requestId: string | undefined | null): void {
  if (!requestId) {
    return;
  }
  REQUEST_TIMELINES.delete(requestId);
  REQUEST_STAGE_BREAKDOWNS.delete(requestId);
}

export function peekHubStageTopSummary(
  requestId: string | undefined | null,
  options?: {
    topN?: number;
    minMs?: number;
  },
): HubStageTopSummaryEntry[] {
  if (!requestId) {
    return [];
  }
  const byStage = REQUEST_STAGE_BREAKDOWNS.get(requestId);
  if (!byStage || !byStage.size) {
    return [];
  }
  const topN = resolveHubStageTopN(options?.topN);
  const minMs = resolveHubStageTopMinMs(options?.minMs);
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
        maxMs,
      };
    })
    .filter((entry) => entry.totalMs >= minMs)
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, topN);
}

export function attachHubStageTopSummary(args: {
  requestId: string;
  metadata: Record<string, unknown>;
}): void {
  const hubStageTop = peekHubStageTopSummary(args.requestId);
  if (!hubStageTop.length) return;
  const center = Reflect.get(args.metadata, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
  if (!center || typeof center.writeDebugSnapshot !== 'function') {
    return;
  }
  writeMetadataCenterSlot({
    target: args.metadata,
    center,
    family: 'debug_snapshot',
    key: 'hubStageTop',
    value: hubStageTop,
    writer: {
      module: 'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-stage-timing.ts',
      symbol: 'attachHubStageTopSummary',
      stage: 'hub_stage_timing_summary'
    },
    reason: 'hub stage timing top summary'
  });
}

export function logHubStageTiming(
  requestId: string,
  stage: string,
  phase: HubStageTimingPhase,
  details?: Record<string, unknown>,
): void {
  const stageElapsedMs = resolveStageElapsedMs(phase, details);
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
  if (phase === "start") {
    touchTiming(requestId);
  }
  const timing = advanceTiming(requestId);
  const thresholdMs = resolveHubStageTimingMinMs();
  if (
    shouldSkipHubStageTimingLog({
      phase,
      details,
      thresholdMs,
      deltaMs: timing.deltaMs,
    })
  ) {
    return;
  }
  const line = buildHubStageTimingLine({
    requestId,
    stage,
    phase,
    timingLabel: timing.label,
    details,
  });
  if (phase === "error") {
    console.error(line);
    return;
  }
  console.log(line);
}
