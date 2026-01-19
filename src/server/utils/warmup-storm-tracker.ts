interface WarmupSkipEvent {
  endpoint: string;
  requestId: string;
  userAgent?: string;
  reason?: string;
}

interface WarmupStormStats {
  active: boolean;
  firstTimestamp: number;
  lastTimestamp: number;
  count: number;
  firstRequestId?: string;
  lastRequestId?: string;
  endpoints: Set<string>;
  userAgents: Set<string>;
  reasons: Set<string>;
}

const STORM_IDLE_TIMEOUT_MS = 60_000;

let stats: WarmupStormStats = createEmptyStats();
let summaryTimer: NodeJS.Timeout | undefined;

export function recordWarmupSkipEvent(event: WarmupSkipEvent): void {
  const now = Date.now();
  if (!stats.active) {
    stats.active = true;
    stats.firstTimestamp = now;
    stats.firstRequestId = event.requestId;
  }
  stats.count += 1;
  stats.lastTimestamp = now;
  stats.lastRequestId = event.requestId;
  stats.endpoints.add(event.endpoint);
  if (event.userAgent) {
    stats.userAgents.add(event.userAgent);
  }
  if (event.reason) {
    stats.reasons.add(event.reason);
  }
  scheduleSummaryFlush();
}

function scheduleSummaryFlush(): void {
  if (summaryTimer) {
    clearTimeout(summaryTimer);
  }
  summaryTimer = setTimeout(flushWarmupStormSummary, STORM_IDLE_TIMEOUT_MS);
}

export function flushWarmupStormSummary(): void {
  if (!stats.active || stats.count === 0) {
    resetStats();
    return;
  }
  const durationMs = Math.max(0, stats.lastTimestamp - stats.firstTimestamp);
  const endpointList = Array.from(stats.endpoints);
  const userAgentList = Array.from(stats.userAgents);
  // const _reasonList = Array.from(stats.reasons);
  const firstId = stats.firstRequestId ?? 'n/a';
  const lastId = stats.lastRequestId ?? 'n/a';

  console.log(
    `[warmup-storm] requests=${stats.count} durationMs=${durationMs} endpoints=${endpointList.join(',') || 'unknown'} ua=${userAgentList.join(',') || 'unknown'} first=${firstId} last=${lastId}`
  );

  resetStats();
}

function createEmptyStats(): WarmupStormStats {
  return {
    active: false,
    firstTimestamp: 0,
    lastTimestamp: 0,
    count: 0,
    endpoints: new Set<string>(),
    userAgents: new Set<string>(),
    reasons: new Set<string>()
  };
}

function resetStats(): void {
  if (summaryTimer) {
    clearTimeout(summaryTimer);
    summaryTimer = undefined;
  }
  stats = createEmptyStats();
}
