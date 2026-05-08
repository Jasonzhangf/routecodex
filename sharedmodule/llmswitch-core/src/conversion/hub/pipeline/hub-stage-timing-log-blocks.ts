import {
  isHubStageTimingDetailEnabled,
  isHubStageTimingVerboseEnabled,
  renderTimingDetails,
} from "./hub-stage-timing-blocks.js";

export type HubStageTimingPhase = "start" | "completed" | "error";

export function resolveStageElapsedMs(
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

export function shouldSkipHubStageTimingLog(args: {
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

export function buildHubStageTimingLine(args: {
  requestId: string;
  stage: string;
  phase: HubStageTimingPhase;
  timingLabel: string;
  details?: Record<string, unknown>;
}): string {
  const detailSuffix = renderTimingDetails(args.details);
  return `[hub.detail][${args.requestId}] ${args.stage}.${args.phase}${args.timingLabel}${detailSuffix}`;
}
