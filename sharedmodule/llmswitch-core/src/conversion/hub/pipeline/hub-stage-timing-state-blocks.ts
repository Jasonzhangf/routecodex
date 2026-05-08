import {
  advanceTimingTimeline,
  clearTimingTimeline,
  pruneTimelineState,
  touchTimingTimeline,
} from "./hub-stage-timing-timeline-state-blocks.js";
import {
  clearTimingBreakdown,
  peekHubStageTopSummaryBreakdown,
  recordHubStageElapsedBreakdown,
  type HubStageTopSummaryEntry,
} from "./hub-stage-timing-breakdown-state-blocks.js";
export type { HubStageTopSummaryEntry } from "./hub-stage-timing-breakdown-state-blocks.js";

export function touchTiming(requestId: string): void {
  const nowMs = Date.now();
  for (const removedRequestId of pruneTimelineState(nowMs)) {
    clearTimingBreakdown(removedRequestId);
  }
  touchTimingTimeline(requestId, nowMs);
}

export function advanceTiming(requestId: string): {
  label: string;
  totalMs: number;
  deltaMs: number;
} {
  const nowMs = Date.now();
  for (const removedRequestId of pruneTimelineState(nowMs)) {
    clearTimingBreakdown(removedRequestId);
  }
  return advanceTimingTimeline(requestId, nowMs);
}

export function clearHubStageTimingState(
  requestId: string | undefined | null,
): void {
  if (!requestId) {
    return;
  }
  clearTimingTimeline(requestId);
  clearTimingBreakdown(requestId);
}

export function recordHubStageElapsedState(
  requestId: string,
  stage: string,
  elapsedMs: number,
): void {
  const nowMs = Date.now();
  for (const removedRequestId of pruneTimelineState(nowMs)) {
    clearTimingBreakdown(removedRequestId);
  }
  recordHubStageElapsedBreakdown(requestId, stage, elapsedMs);
}

export function peekHubStageTopSummaryState(
  requestId: string | undefined | null,
  options?: {
    topN?: number;
    minMs?: number;
  },
): HubStageTopSummaryEntry[] {
  return peekHubStageTopSummaryBreakdown(requestId, options);
}
