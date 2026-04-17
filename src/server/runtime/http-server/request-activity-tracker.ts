type RequestActivityRecord = {
  requestId: string;
  tmuxSessionId?: string;
  sessionId?: string;
  startedAtMs: number;
};

const DEFAULT_REQUEST_ACTIVITY_TTL_MS = 30 * 60 * 1000;
const DEFAULT_REQUEST_ACTIVITY_MAX_ENTRIES = 4096;

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function resolvePositiveIntEnv(primary: string | undefined, secondary: string | undefined, fallback: number): number {
  const values = [primary, secondary];
  for (const value of values) {
    const parsed = Number.parseInt(String(value ?? '').trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      return Math.floor(parsed);
    }
  }
  return fallback;
}

export class RequestActivityTracker {
  private readonly byRequestId = new Map<string, RequestActivityRecord>();
  private readonly tmuxCounts = new Map<string, number>();
  private readonly ttlMs = resolvePositiveIntEnv(
    process.env.ROUTECODEX_REQUEST_ACTIVITY_TTL_MS,
    process.env.RCC_REQUEST_ACTIVITY_TTL_MS,
    DEFAULT_REQUEST_ACTIVITY_TTL_MS
  );
  private readonly maxEntries = resolvePositiveIntEnv(
    process.env.ROUTECODEX_REQUEST_ACTIVITY_MAX_ENTRIES,
    process.env.RCC_REQUEST_ACTIVITY_MAX_ENTRIES,
    DEFAULT_REQUEST_ACTIVITY_MAX_ENTRIES
  );

  private removeRecord(record: RequestActivityRecord): void {
    this.byRequestId.delete(record.requestId);
    if (!record.tmuxSessionId) {
      return;
    }
    const next = Math.max(0, (this.tmuxCounts.get(record.tmuxSessionId) || 0) - 1);
    if (next > 0) {
      this.tmuxCounts.set(record.tmuxSessionId, next);
    } else {
      this.tmuxCounts.delete(record.tmuxSessionId);
    }
  }

  private prune(nowMs: number): void {
    if (this.byRequestId.size < 1) {
      return;
    }
    if (Number.isFinite(this.ttlMs) && this.ttlMs > 0) {
      for (const record of this.byRequestId.values()) {
        if (nowMs - record.startedAtMs >= this.ttlMs) {
          this.removeRecord(record);
        }
      }
    }
    if (!Number.isFinite(this.maxEntries) || this.maxEntries < 1 || this.byRequestId.size <= this.maxEntries) {
      return;
    }
    const ordered = Array.from(this.byRequestId.values()).sort((a, b) => a.startedAtMs - b.startedAtMs);
    const removeCount = Math.max(0, ordered.length - this.maxEntries);
    for (let idx = 0; idx < removeCount; idx += 1) {
      this.removeRecord(ordered[idx]!);
    }
  }

  start(requestId: string, metadata?: Record<string, unknown> | null): void {
    const normalizedRequestId = readString(requestId);
    if (!normalizedRequestId) {
      return;
    }
    const nowMs = Date.now();
    this.prune(nowMs);
    this.end(normalizedRequestId);
    const tmuxSessionId = readString(metadata?.tmuxSessionId) || readString(metadata?.clientTmuxSessionId);
    const sessionId = readString(metadata?.sessionId);
    const record: RequestActivityRecord = {
      requestId: normalizedRequestId,
      ...(tmuxSessionId ? { tmuxSessionId } : {}),
      ...(sessionId ? { sessionId } : {}),
      startedAtMs: nowMs
    };
    this.byRequestId.set(normalizedRequestId, record);
    if (tmuxSessionId) {
      this.tmuxCounts.set(tmuxSessionId, (this.tmuxCounts.get(tmuxSessionId) || 0) + 1);
    }
    this.prune(nowMs);
  }

  end(requestId: string): void {
    const normalizedRequestId = readString(requestId);
    if (!normalizedRequestId) {
      return;
    }
    this.prune(Date.now());
    const existing = this.byRequestId.get(normalizedRequestId);
    if (!existing) {
      return;
    }
    this.removeRecord(existing);
  }

  countActiveRequestsForTmuxSession(tmuxSessionId: string): number {
    const normalizedTmuxSessionId = readString(tmuxSessionId);
    if (!normalizedTmuxSessionId) {
      return 0;
    }
    this.prune(Date.now());
    return this.tmuxCounts.get(normalizedTmuxSessionId) || 0;
  }
}
