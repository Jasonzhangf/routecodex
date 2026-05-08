const REQUEST_TIMELINES = new Map<
  string,
  { startedAtMs: number; lastAtMs: number }
>();
const REQUEST_TIMELINE_TTL_MS = 30 * 60 * 1000;
const REQUEST_TIMELINE_MAX = 4096;

export function pruneTimelineState(nowMs: number): string[] {
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
  return removedRequestIds;
}

export function touchTimingTimeline(requestId: string, nowMs: number): void {
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

export function advanceTimingTimeline(requestId: string, nowMs: number): {
  label: string;
  totalMs: number;
  deltaMs: number;
} {
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

export function clearTimingTimeline(requestId: string): void {
  REQUEST_TIMELINES.delete(requestId);
}
