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

type MetadataCenterLike = {
  writeDebugSnapshot?: (
    key: string,
    value: unknown,
    writer: { module: string; symbol: string; stage: string },
    reason?: string,
  ) => void;
};

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
  center.writeDebugSnapshot(
    'hubStageTop',
    hubStageTop,
    {
      module: 'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-stage-timing.ts',
      symbol: 'attachHubStageTopSummary',
      stage: 'hub_stage_timing_summary'
    },
    'hub stage timing top summary'
  );
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
