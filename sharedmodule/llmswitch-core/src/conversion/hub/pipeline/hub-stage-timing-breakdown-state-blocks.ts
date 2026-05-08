import {
  resolveHubStageTopMinMs,
  resolveHubStageTopN,
} from "./hub-stage-timing-env-blocks.js";

const REQUEST_STAGE_BREAKDOWNS = new Map<
  string,
  Map<string, { totalMs: number; count: number; maxMs: number }>
>();

export type HubStageTopSummaryEntry = {
  stage: string;
  totalMs: number;
  count: number;
  avgMs: number;
  maxMs: number;
};

export function clearTimingBreakdown(requestId: string): void {
  REQUEST_STAGE_BREAKDOWNS.delete(requestId);
}

export function recordHubStageElapsedBreakdown(
  requestId: string,
  stage: string,
  elapsedMs: number,
): void {
  if (!requestId || !stage || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return;
  }
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

export function peekHubStageTopSummaryBreakdown(
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
