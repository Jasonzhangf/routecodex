import {
  advanceTiming,
  clearHubStageTimingState,
  isHubStageTimingEnabled,
  peekHubStageTopSummaryState,
  recordHubStageElapsedState,
  resolveHubStageTimingMinMs,
  touchTiming,
  type HubStageTopSummaryEntry,
} from "./hub-stage-timing-blocks.js";
import {
  buildHubStageTimingLine,
  resolveStageElapsedMs,
  shouldSkipHubStageTimingLog,
  type HubStageTimingPhase,
} from "./hub-stage-timing-log-blocks.js";

// feature_id: hub.stage_timing_observation

const METADATA_CENTER_SYMBOL = Symbol.for('routecodex.metadataCenter');
const RUST_SNAPSHOT_SYMBOL = Symbol.for('routecodex.metadataCenter.rustSnapshot');

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

export { isHubStageTimingDetailEnabled, type HubStageTopSummaryEntry } from "./hub-stage-timing-blocks.js";

export function clearHubStageTiming(requestId: string | undefined | null): void {
  clearHubStageTimingState(requestId);
}

export function peekHubStageTopSummary(
  requestId: string | undefined | null,
  options?: {
    topN?: number;
    minMs?: number;
  },
): HubStageTopSummaryEntry[] {
  return peekHubStageTopSummaryState(requestId, options);
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
    recordHubStageElapsedState(requestId, stage, stageElapsedMs);
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
