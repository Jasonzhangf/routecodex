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
import { measureHubStageExecution } from "./hub-stage-timing-measure-blocks.js";

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

export async function measureHubStage<T>(
  requestId: string,
  stage: string,
  fn: () => Promise<T> | T,
  options?: {
    startDetails?: Record<string, unknown>;
    mapCompletedDetails?: (value: T) => Record<string, unknown> | undefined;
    mapErrorDetails?: (error: unknown) => Record<string, unknown> | undefined;
  },
): Promise<T> {
  return measureHubStageExecution(requestId, stage, fn, options);
}
