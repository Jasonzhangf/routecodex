type RequestActivityRecord = {
  requestId: string;
  tmuxSessionId?: string;
  sessionId?: string;
  startedAtMs: number;
};

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export class RequestActivityTracker {
  private readonly byRequestId = new Map<string, RequestActivityRecord>();
  private readonly tmuxCounts = new Map<string, number>();

  start(requestId: string, metadata?: Record<string, unknown> | null): void {
    const normalizedRequestId = readString(requestId);
    if (!normalizedRequestId) {
      return;
    }
    this.end(normalizedRequestId);
    const tmuxSessionId = readString(metadata?.tmuxSessionId) || readString(metadata?.clientTmuxSessionId);
    const sessionId = readString(metadata?.sessionId);
    const record: RequestActivityRecord = {
      requestId: normalizedRequestId,
      ...(tmuxSessionId ? { tmuxSessionId } : {}),
      ...(sessionId ? { sessionId } : {}),
      startedAtMs: Date.now()
    };
    this.byRequestId.set(normalizedRequestId, record);
    if (tmuxSessionId) {
      this.tmuxCounts.set(tmuxSessionId, (this.tmuxCounts.get(tmuxSessionId) || 0) + 1);
    }
  }

  end(requestId: string): void {
    const normalizedRequestId = readString(requestId);
    if (!normalizedRequestId) {
      return;
    }
    const existing = this.byRequestId.get(normalizedRequestId);
    if (!existing) {
      return;
    }
    this.byRequestId.delete(normalizedRequestId);
    if (existing.tmuxSessionId) {
      const next = Math.max(0, (this.tmuxCounts.get(existing.tmuxSessionId) || 0) - 1);
      if (next > 0) {
        this.tmuxCounts.set(existing.tmuxSessionId, next);
      } else {
        this.tmuxCounts.delete(existing.tmuxSessionId);
      }
    }
  }

  countActiveRequestsForTmuxSession(tmuxSessionId: string): number {
    const normalizedTmuxSessionId = readString(tmuxSessionId);
    if (!normalizedTmuxSessionId) {
      return 0;
    }
    return this.tmuxCounts.get(normalizedTmuxSessionId) || 0;
  }
}
