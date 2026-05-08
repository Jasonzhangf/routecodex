export {
  isHubStageTimingDetailEnabled,
  isHubStageTimingEnabled,
  isHubStageTimingVerboseEnabled,
  resolveHubStageTimingMinMs,
} from "./hub-stage-timing-env-blocks.js";
export {
  advanceTiming,
  clearHubStageTimingState,
  peekHubStageTopSummaryState,
  recordHubStageElapsedState,
  touchTiming,
  type HubStageTopSummaryEntry,
} from "./hub-stage-timing-state-blocks.js";

export function renderTimingDetails(details?: Record<string, unknown>): string {
  if (!details || Object.keys(details).length === 0) {
    return "";
  }
  try {
    return ` ${JSON.stringify(details)}`;
  } catch {
    return "";
  }
}
