import { resolveEffectiveRequestId } from '../../utils/request-id-manager.js';

export type SessionExecutionDerivedState =
  | 'IDLE'
  | 'WAITING_RESPONSE'
  | 'STREAMING_OPEN'
  | 'POST_RESPONSE_GRACE'
  | 'STALED'
  | 'UNKNOWN';

type SessionExecutionRequestRecord = {
  requestId: string;
  tmuxSessionId: string;
  startedAtMs: number;
  stream: boolean;
  sseOpen: boolean;
};

type SessionExecutionTmuxRecord = {
  tmuxSessionId: string;
  lastRequestId?: string;
  lastRequestAtMs?: number;
  lastRequestSeq?: number;
  lastRequestWasStream?: boolean;
  lastResponseRequestId?: string;
  lastResponseAtMs?: number;
  lastResponseSeq?: number;
  lastFinishReason?: string;
  lastTerminalAtMs?: number;
  lastSseOpenAtMs?: number;
  lastSseCloseAtMs?: number;
  lastClientCloseBeforeTerminalAtMs?: number;
  lastClientCloseSeq?: number;
  openSseRequestIds: Set<string>;
  lastUpdatedAtMs: number;
};

type DerivedStateOptions = {
  nowMs?: number;
  waitingTimeoutMs?: number;
  postResponseGraceMs?: number;
};

export type SessionExecutionStateSnapshot = {
  tmuxSessionId: string;
  state: SessionExecutionDerivedState;
  shouldSkipHeartbeat: boolean;
  reason:
    | 'no_state'
    | 'sse_open'
    | 'waiting_response'
    | 'request_timed_out'
    | 'recent_nonterminal_response'
    | 'latest_response_stop'
    | 'client_closed_before_terminal';
  lastRequestId?: string;
  lastRequestAtMs?: number;
  lastRequestWasStream?: boolean;
  lastResponseRequestId?: string;
  lastResponseAtMs?: number;
  lastFinishReason?: string;
  openSseCount: number;
  lastSseOpenAtMs?: number;
  lastSseCloseAtMs?: number;
  lastClientCloseBeforeTerminalAtMs?: number;
};

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeRequestId(value: unknown): string | undefined {
  const normalized = readString(resolveEffectiveRequestId(typeof value === 'string' ? value : undefined));
  if (normalized && normalized !== 'unknown' && !normalized.includes('-unknown-')) {
    return normalized;
  }
  return readString(typeof value === 'string' ? value : undefined);
}

function normalizeTmuxSessionId(metadata?: Record<string, unknown> | null): string | undefined {
  return (
    readString(metadata?.tmuxSessionId)
    || readString(metadata?.clientTmuxSessionId)
    || readString(metadata?.tmux_session_id)
    || readString(metadata?.client_tmux_session_id)
  );
}

const DEFAULT_WAITING_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_POST_RESPONSE_GRACE_MS = 60 * 1000;
const TMUX_RECORD_TTL_MS = 6 * 60 * 60 * 1000;
const REQUEST_RECORD_TTL_MS = 60 * 60 * 1000;

export class SessionExecutionStateTracker {
  private readonly byRequestId = new Map<string, SessionExecutionRequestRecord>();
  private readonly byTmuxSessionId = new Map<string, SessionExecutionTmuxRecord>();
  private sequence = 0;

  private nextSeq(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private ensureTmuxRecord(tmuxSessionId: string, nowMs: number): SessionExecutionTmuxRecord {
    let record = this.byTmuxSessionId.get(tmuxSessionId);
    if (!record) {
      record = {
        tmuxSessionId,
        openSseRequestIds: new Set<string>(),
        lastUpdatedAtMs: nowMs
      };
      this.byTmuxSessionId.set(tmuxSessionId, record);
      return record;
    }
    record.lastUpdatedAtMs = nowMs;
    return record;
  }

  private maybeDeleteRequest(requestId: string): void {
    const normalizedRequestId = normalizeRequestId(requestId);
    if (!normalizedRequestId) {
      return;
    }
    const requestRecord = this.byRequestId.get(normalizedRequestId);
    if (!requestRecord) {
      return;
    }
    if (requestRecord.sseOpen) {
      return;
    }
    this.byRequestId.delete(normalizedRequestId);
  }

  private closeOpenSse(requestRecord: SessionExecutionRequestRecord, tmuxRecord: SessionExecutionTmuxRecord, nowMs: number): void {
    if (!requestRecord.sseOpen) {
      return;
    }
    requestRecord.sseOpen = false;
    tmuxRecord.openSseRequestIds.delete(requestRecord.requestId);
    tmuxRecord.lastSseCloseAtMs = nowMs;
  }

  private prune(nowMs: number): void {
    for (const [requestId, record] of this.byRequestId.entries()) {
      if (record.sseOpen) {
        continue;
      }
      if (nowMs - record.startedAtMs >= REQUEST_RECORD_TTL_MS) {
        this.byRequestId.delete(requestId);
      }
    }
    for (const [tmuxSessionId, record] of this.byTmuxSessionId.entries()) {
      if (record.openSseRequestIds.size > 0) {
        continue;
      }
      if (nowMs - record.lastUpdatedAtMs >= TMUX_RECORD_TTL_MS) {
        this.byTmuxSessionId.delete(tmuxSessionId);
      }
    }
  }

  recordRequestStart(requestId: string, metadata?: Record<string, unknown> | null): void {
    const normalizedRequestId = normalizeRequestId(requestId);
    const tmuxSessionId = normalizeTmuxSessionId(metadata);
    if (!normalizedRequestId || !tmuxSessionId) {
      return;
    }
    const nowMs = Date.now();
    this.prune(nowMs);

    const existing = this.byRequestId.get(normalizedRequestId);
    if (existing) {
      const previousTmux = this.byTmuxSessionId.get(existing.tmuxSessionId);
      if (previousTmux) {
        this.closeOpenSse(existing, previousTmux, nowMs);
      }
      this.byRequestId.delete(normalizedRequestId);
    }

    const tmuxRecord = this.ensureTmuxRecord(tmuxSessionId, nowMs);
    tmuxRecord.lastRequestId = normalizedRequestId;
    tmuxRecord.lastRequestAtMs = nowMs;
    tmuxRecord.lastRequestSeq = this.nextSeq();
    tmuxRecord.lastRequestWasStream = metadata?.stream === true;

    this.byRequestId.set(normalizedRequestId, {
      requestId: normalizedRequestId,
      tmuxSessionId,
      startedAtMs: nowMs,
      stream: metadata?.stream === true,
      sseOpen: false
    });
  }

  recordJsonResponseComplete(requestId: string, finishReason?: string): void {
    const normalizedRequestId = normalizeRequestId(requestId);
    if (!normalizedRequestId) {
      return;
    }
    const requestRecord = this.byRequestId.get(normalizedRequestId);
    if (!requestRecord) {
      return;
    }
    const nowMs = Date.now();
    this.prune(nowMs);
    const tmuxRecord = this.ensureTmuxRecord(requestRecord.tmuxSessionId, nowMs);
    tmuxRecord.lastResponseRequestId = normalizedRequestId;
    tmuxRecord.lastResponseAtMs = nowMs;
    tmuxRecord.lastResponseSeq = this.nextSeq();
    tmuxRecord.lastFinishReason = readString(finishReason);
    tmuxRecord.lastTerminalAtMs = nowMs;
    this.closeOpenSse(requestRecord, tmuxRecord, nowMs);
    this.byRequestId.delete(normalizedRequestId);
  }

  recordSseStreamStart(requestId: string): void {
    const normalizedRequestId = normalizeRequestId(requestId);
    if (!normalizedRequestId) {
      return;
    }
    const requestRecord = this.byRequestId.get(normalizedRequestId);
    if (!requestRecord || requestRecord.sseOpen) {
      return;
    }
    const nowMs = Date.now();
    this.prune(nowMs);
    const tmuxRecord = this.ensureTmuxRecord(requestRecord.tmuxSessionId, nowMs);
    requestRecord.sseOpen = true;
    tmuxRecord.openSseRequestIds.add(normalizedRequestId);
    tmuxRecord.lastSseOpenAtMs = nowMs;
  }

  recordSseStreamEnd(requestId: string, options?: { finishReason?: string; terminal?: boolean }): void {
    const normalizedRequestId = normalizeRequestId(requestId);
    if (!normalizedRequestId) {
      return;
    }
    const requestRecord = this.byRequestId.get(normalizedRequestId);
    if (!requestRecord) {
      return;
    }
    const nowMs = Date.now();
    this.prune(nowMs);
    const tmuxRecord = this.ensureTmuxRecord(requestRecord.tmuxSessionId, nowMs);
    tmuxRecord.lastResponseRequestId = normalizedRequestId;
    tmuxRecord.lastResponseAtMs = nowMs;
    tmuxRecord.lastResponseSeq = this.nextSeq();
    tmuxRecord.lastFinishReason = readString(options?.finishReason);
    if (options?.terminal !== false) {
      tmuxRecord.lastTerminalAtMs = nowMs;
    }
    this.closeOpenSse(requestRecord, tmuxRecord, nowMs);
    this.byRequestId.delete(normalizedRequestId);
  }

  recordSseClientClose(requestId: string, options?: { finishReason?: string; terminal?: boolean; closeBeforeStreamEnd?: boolean }): void {
    const normalizedRequestId = normalizeRequestId(requestId);
    if (!normalizedRequestId) {
      return;
    }
    const requestRecord = this.byRequestId.get(normalizedRequestId);
    if (!requestRecord) {
      return;
    }
    const nowMs = Date.now();
    this.prune(nowMs);
    const tmuxRecord = this.ensureTmuxRecord(requestRecord.tmuxSessionId, nowMs);
    if (readString(options?.finishReason)) {
      tmuxRecord.lastFinishReason = readString(options?.finishReason);
    }
    if (options?.terminal === true) {
      tmuxRecord.lastTerminalAtMs = nowMs;
    }
    if (options?.closeBeforeStreamEnd === true) {
      tmuxRecord.lastClientCloseBeforeTerminalAtMs = nowMs;
      tmuxRecord.lastClientCloseSeq = this.nextSeq();
    }
    this.closeOpenSse(requestRecord, tmuxRecord, nowMs);
    this.byRequestId.delete(normalizedRequestId);
  }

  getStateSnapshot(tmuxSessionId: string, options?: DerivedStateOptions): SessionExecutionStateSnapshot {
    const normalizedTmuxSessionId = readString(tmuxSessionId);
    if (!normalizedTmuxSessionId) {
      return {
        tmuxSessionId: '',
        state: 'UNKNOWN',
        shouldSkipHeartbeat: false,
        reason: 'no_state',
        openSseCount: 0
      };
    }
    const nowMs = options?.nowMs ?? Date.now();
    this.prune(nowMs);
    const tmuxRecord = this.byTmuxSessionId.get(normalizedTmuxSessionId);
    if (!tmuxRecord) {
      return {
        tmuxSessionId: normalizedTmuxSessionId,
        state: 'UNKNOWN',
        shouldSkipHeartbeat: false,
        reason: 'no_state',
        openSseCount: 0
      };
    }

    const waitingTimeoutMs = options?.waitingTimeoutMs ?? DEFAULT_WAITING_TIMEOUT_MS;
    const postResponseGraceMs = options?.postResponseGraceMs ?? DEFAULT_POST_RESPONSE_GRACE_MS;
    const openSseCount = tmuxRecord.openSseRequestIds.size;
    if (openSseCount > 0) {
      return {
        tmuxSessionId: normalizedTmuxSessionId,
        state: 'STREAMING_OPEN',
        shouldSkipHeartbeat: true,
        reason: 'sse_open',
        lastRequestId: tmuxRecord.lastRequestId,
        lastRequestAtMs: tmuxRecord.lastRequestAtMs,
        lastRequestWasStream: tmuxRecord.lastRequestWasStream,
        lastResponseRequestId: tmuxRecord.lastResponseRequestId,
        lastResponseAtMs: tmuxRecord.lastResponseAtMs,
        lastFinishReason: tmuxRecord.lastFinishReason,
        openSseCount,
        lastSseOpenAtMs: tmuxRecord.lastSseOpenAtMs,
        lastSseCloseAtMs: tmuxRecord.lastSseCloseAtMs,
        lastClientCloseBeforeTerminalAtMs: tmuxRecord.lastClientCloseBeforeTerminalAtMs
      };
    }

    const requestSeq = tmuxRecord.lastRequestSeq ?? 0;
    const responseSeq = tmuxRecord.lastResponseSeq ?? 0;
    const clientCloseSeq = tmuxRecord.lastClientCloseSeq ?? 0;

    if (requestSeq === 0 && responseSeq === 0 && clientCloseSeq === 0) {
      return {
        tmuxSessionId: normalizedTmuxSessionId,
        state: 'UNKNOWN',
        shouldSkipHeartbeat: false,
        reason: 'no_state',
        lastRequestId: tmuxRecord.lastRequestId,
        lastRequestAtMs: tmuxRecord.lastRequestAtMs,
        lastRequestWasStream: tmuxRecord.lastRequestWasStream,
        lastResponseRequestId: tmuxRecord.lastResponseRequestId,
        lastResponseAtMs: tmuxRecord.lastResponseAtMs,
        lastFinishReason: tmuxRecord.lastFinishReason,
        openSseCount,
        lastSseOpenAtMs: tmuxRecord.lastSseOpenAtMs,
        lastSseCloseAtMs: tmuxRecord.lastSseCloseAtMs,
        lastClientCloseBeforeTerminalAtMs: tmuxRecord.lastClientCloseBeforeTerminalAtMs
      };
    }

    if (requestSeq > responseSeq && requestSeq > clientCloseSeq) {
      const lastRequestAtMs = tmuxRecord.lastRequestAtMs ?? nowMs;
      const timedOut = nowMs - lastRequestAtMs > waitingTimeoutMs;
      return {
        tmuxSessionId: normalizedTmuxSessionId,
        state: timedOut ? 'STALED' : 'WAITING_RESPONSE',
        shouldSkipHeartbeat: !timedOut,
        reason: timedOut ? 'request_timed_out' : 'waiting_response',
        lastRequestId: tmuxRecord.lastRequestId,
        lastRequestAtMs: tmuxRecord.lastRequestAtMs,
        lastRequestWasStream: tmuxRecord.lastRequestWasStream,
        lastResponseRequestId: tmuxRecord.lastResponseRequestId,
        lastResponseAtMs: tmuxRecord.lastResponseAtMs,
        lastFinishReason: tmuxRecord.lastFinishReason,
        openSseCount,
        lastSseOpenAtMs: tmuxRecord.lastSseOpenAtMs,
        lastSseCloseAtMs: tmuxRecord.lastSseCloseAtMs,
        lastClientCloseBeforeTerminalAtMs: tmuxRecord.lastClientCloseBeforeTerminalAtMs
      };
    }

    if (clientCloseSeq > responseSeq && clientCloseSeq > requestSeq) {
      return {
        tmuxSessionId: normalizedTmuxSessionId,
        state: 'STALED',
        shouldSkipHeartbeat: false,
        reason: 'client_closed_before_terminal',
        lastRequestId: tmuxRecord.lastRequestId,
        lastRequestAtMs: tmuxRecord.lastRequestAtMs,
        lastRequestWasStream: tmuxRecord.lastRequestWasStream,
        lastResponseRequestId: tmuxRecord.lastResponseRequestId,
        lastResponseAtMs: tmuxRecord.lastResponseAtMs,
        lastFinishReason: tmuxRecord.lastFinishReason,
        openSseCount,
        lastSseOpenAtMs: tmuxRecord.lastSseOpenAtMs,
        lastSseCloseAtMs: tmuxRecord.lastSseCloseAtMs,
        lastClientCloseBeforeTerminalAtMs: tmuxRecord.lastClientCloseBeforeTerminalAtMs
      };
    }

    const lastResponseAtMs = tmuxRecord.lastResponseAtMs ?? nowMs;
    const finishReason = readString(tmuxRecord.lastFinishReason);
    const recentNonterminal = nowMs - lastResponseAtMs <= postResponseGraceMs && finishReason !== 'stop';
    return {
      tmuxSessionId: normalizedTmuxSessionId,
      state: recentNonterminal ? 'POST_RESPONSE_GRACE' : 'IDLE',
      shouldSkipHeartbeat: recentNonterminal,
      reason: recentNonterminal ? 'recent_nonterminal_response' : 'latest_response_stop',
      lastRequestId: tmuxRecord.lastRequestId,
      lastRequestAtMs: tmuxRecord.lastRequestAtMs,
      lastRequestWasStream: tmuxRecord.lastRequestWasStream,
      lastResponseRequestId: tmuxRecord.lastResponseRequestId,
      lastResponseAtMs: tmuxRecord.lastResponseAtMs,
      lastFinishReason: tmuxRecord.lastFinishReason,
      openSseCount,
      lastSseOpenAtMs: tmuxRecord.lastSseOpenAtMs,
      lastSseCloseAtMs: tmuxRecord.lastSseCloseAtMs,
      lastClientCloseBeforeTerminalAtMs: tmuxRecord.lastClientCloseBeforeTerminalAtMs
    };
  }
}

const singleton = new SessionExecutionStateTracker();

export function getSessionExecutionStateTracker(): SessionExecutionStateTracker {
  return singleton;
}
