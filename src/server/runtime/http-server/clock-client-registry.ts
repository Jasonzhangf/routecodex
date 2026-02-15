import {
  cleanupDeadTmuxSessionsFromRegistry,
  cleanupStaleHeartbeatsFromRegistry,
  normalizePositiveInt,
  normalizeString,
  resolveHeartbeatTtlMs,
  resolveManagedClientProcessState,
  resolveManagedTmuxSessionState
} from './clock-client-registry-utils.js';
import type {
  ClockCleanupResult,
  ClockClientInjectArgs,
  ClockClientInjectResult,
  ClockClientRecord,
  ClockConversationBindArgs,
  ClockStaleCleanupResult
} from './clock-client-registry-utils.js';

export class ClockClientRegistry {
  private readonly records = new Map<string, ClockClientRecord>();
  private readonly conversationToTmuxSession = new Map<string, string>();

  register(input: {
    daemonId: string;
    callbackUrl: string;
    tmuxSessionId?: string;
    sessionId?: string;
    clientType?: string;
    tmuxTarget?: string;
    managedTmuxSession?: boolean;
    managedClientProcess?: boolean;
    managedClientPid?: number;
    managedClientCommandHint?: string;
  }): ClockClientRecord {
    const now = Date.now();
    const resolvedTmuxSessionId = normalizeString(input.tmuxSessionId) ?? normalizeString(input.sessionId);
    const previous = this.records.get(input.daemonId);
    const preservedConversationIds = Array.isArray(previous?.conversationSessionIds)
      ? previous?.conversationSessionIds.filter((item) => normalizeString(item))
      : [];

    const managedTmuxSession = resolveManagedTmuxSessionState({
      previousManagedTmuxSession: previous?.managedTmuxSession,
      managedTmuxSessionInput: input.managedTmuxSession
    });
    const managedClientProcess = resolveManagedClientProcessState({
      previousManagedClientProcess: previous?.managedClientProcess,
      managedClientProcessInput: input.managedClientProcess
    });
    const managedClientPid = normalizePositiveInt(input.managedClientPid) ?? normalizePositiveInt(previous?.managedClientPid);
    const managedClientCommandHint = normalizeString(input.managedClientCommandHint) ?? normalizeString(previous?.managedClientCommandHint);

    const record: ClockClientRecord = {
      daemonId: input.daemonId,
      callbackUrl: input.callbackUrl,
      ...(resolvedTmuxSessionId ? { tmuxSessionId: resolvedTmuxSessionId, sessionId: resolvedTmuxSessionId } : {}),
      ...(preservedConversationIds.length ? { conversationSessionIds: preservedConversationIds } : {}),
      ...(input.clientType ? { clientType: input.clientType } : {}),
      ...(input.tmuxTarget ? { tmuxTarget: input.tmuxTarget } : {}),
      ...(managedTmuxSession ? { managedTmuxSession: true } : {}),
      ...(managedClientProcess ? { managedClientProcess: true } : {}),
      ...(managedClientPid ? { managedClientPid } : {}),
      ...(managedClientCommandHint ? { managedClientCommandHint } : {}),
      registeredAtMs: now,
      lastHeartbeatAtMs: now
    };

    this.records.set(record.daemonId, record);

    if (resolvedTmuxSessionId && preservedConversationIds.length) {
      for (const conversationSessionId of preservedConversationIds) {
        this.conversationToTmuxSession.set(conversationSessionId, resolvedTmuxSessionId);
      }
    }

    return { ...record, ...(record.conversationSessionIds ? { conversationSessionIds: [...record.conversationSessionIds] } : {}) };
  }

  heartbeat(daemonId: string, input?: {
    tmuxSessionId?: string;
    managedTmuxSession?: boolean;
    managedClientProcess?: boolean;
    managedClientPid?: number;
    managedClientCommandHint?: string;
  }): boolean {
    const rec = this.records.get(daemonId);
    if (!rec) {
      return false;
    }

    const now = Date.now();
    const tmuxSessionIdFromHeartbeat = normalizeString(input?.tmuxSessionId);
    const previousTmuxSessionId = normalizeString(rec.tmuxSessionId) ?? normalizeString(rec.sessionId);
    const resolvedTmuxSessionId = tmuxSessionIdFromHeartbeat ?? previousTmuxSessionId;

    rec.lastHeartbeatAtMs = now;
    if (resolvedTmuxSessionId) {
      rec.tmuxSessionId = resolvedTmuxSessionId;
      rec.sessionId = resolvedTmuxSessionId;
    }

    rec.managedTmuxSession = resolveManagedTmuxSessionState({
      previousManagedTmuxSession: rec.managedTmuxSession,
      managedTmuxSessionInput: input?.managedTmuxSession
    });
    rec.managedClientProcess = resolveManagedClientProcessState({
      previousManagedClientProcess: rec.managedClientProcess,
      managedClientProcessInput: input?.managedClientProcess
    });

    const managedClientPid = normalizePositiveInt(input?.managedClientPid);
    if (managedClientPid) {
      rec.managedClientPid = managedClientPid;
    }
    const managedClientCommandHint = normalizeString(input?.managedClientCommandHint);
    if (managedClientCommandHint) {
      rec.managedClientCommandHint = managedClientCommandHint;
    }

    if (resolvedTmuxSessionId && Array.isArray(rec.conversationSessionIds)) {
      for (const conversationSessionId of rec.conversationSessionIds) {
        const normalizedConversationSessionId = normalizeString(conversationSessionId);
        if (normalizedConversationSessionId) {
          this.conversationToTmuxSession.set(normalizedConversationSessionId, resolvedTmuxSessionId);
        }
      }
    }

    this.records.set(daemonId, rec);
    return true;
  }

  unregister(daemonId: string): boolean {
    const record = this.records.get(daemonId);
    if (record) {
      const tmuxSessionId = normalizeString(record.tmuxSessionId) ?? normalizeString(record.sessionId);
      const boundConversationSessionIds = Array.isArray(record.conversationSessionIds)
        ? record.conversationSessionIds
        : [];
      for (const conversationSessionId of boundConversationSessionIds) {
        const mapped = this.conversationToTmuxSession.get(conversationSessionId);
        if (mapped && tmuxSessionId && mapped === tmuxSessionId) {
          this.conversationToTmuxSession.delete(conversationSessionId);
        }
      }
    }
    return this.records.delete(daemonId);
  }

  list(): ClockClientRecord[] {
    return Array.from(this.records.values())
      .map((entry) => ({
        ...entry,
        ...(Array.isArray(entry.conversationSessionIds)
          ? { conversationSessionIds: [...entry.conversationSessionIds] }
          : {})
      }))
      .sort((a, b) => b.lastHeartbeatAtMs - a.lastHeartbeatAtMs);
  }

  unbindConversationSession(conversationSessionIdRaw: string): { ok: boolean; removed: boolean; daemonIds: string[] } {
    const conversationSessionId = normalizeString(conversationSessionIdRaw);
    if (!conversationSessionId) {
      return { ok: false, removed: false, daemonIds: [] };
    }
    const daemonIds: string[] = [];
    for (const [daemonId, record] of this.records.entries()) {
      const list = Array.isArray(record.conversationSessionIds) ? record.conversationSessionIds.filter((item) => normalizeString(item)) : [];
      const next = list.filter((item) => item !== conversationSessionId);
      if (next.length !== list.length) {
        daemonIds.push(daemonId);
        record.conversationSessionIds = next;
        this.records.set(daemonId, record);
      }
    }
    const removed = this.conversationToTmuxSession.delete(conversationSessionId) || daemonIds.length > 0;
    return { ok: true, removed, daemonIds };
  }

  cleanupStaleHeartbeats(args?: {
    nowMs?: number;
    staleAfterMs?: number;
    terminateManagedTmuxSession?: (tmuxSessionId: string) => boolean;
    terminateManagedClientProcess?: (processInfo: {
      daemonId: string;
      pid: number;
      commandHint?: string;
      clientType?: string;
    }) => boolean;
  }): ClockStaleCleanupResult {
    return cleanupStaleHeartbeatsFromRegistry({
      records: this.records,
      conversationToTmuxSession: this.conversationToTmuxSession,
      ...args
    });
  }

  cleanupDeadTmuxSessions(args: {
    isTmuxSessionAlive: (tmuxSessionId: string) => boolean;
    terminateManagedTmuxSession?: (tmuxSessionId: string) => boolean;
    terminateManagedClientProcess?: (processInfo: {
      daemonId: string;
      pid: number;
      commandHint?: string;
      clientType?: string;
    }) => boolean;
  }): ClockCleanupResult {
    return cleanupDeadTmuxSessionsFromRegistry({
      records: this.records,
      conversationToTmuxSession: this.conversationToTmuxSession,
      ...args
    });
  }

  private isAlive(record: ClockClientRecord): boolean {
    return Date.now() - record.lastHeartbeatAtMs <= resolveHeartbeatTtlMs();
  }

  private pickAliveCandidates(filters?: {
    tmuxSessionId?: string;
    daemonId?: string;
    clientType?: string;
  }): ClockClientRecord[] {
    let records = Array.from(this.records.values()).filter((entry) => this.isAlive(entry));

    const daemonId = normalizeString(filters?.daemonId);
    if (daemonId) {
      records = records.filter((entry) => entry.daemonId === daemonId);
    }

    const tmuxSessionId = normalizeString(filters?.tmuxSessionId);
    if (tmuxSessionId) {
      records = records.filter((entry) => entry.tmuxSessionId === tmuxSessionId);
    }

    const clientType = normalizeString(filters?.clientType);
    if (clientType) {
      records = records.filter((entry) => normalizeString(entry.clientType) === clientType);
    }

    return records.sort((a, b) => b.lastHeartbeatAtMs - a.lastHeartbeatAtMs);
  }

  bindConversationSession(args: ClockConversationBindArgs): { ok: boolean; reason?: string; daemonId?: string; tmuxSessionId?: string } {
    const conversationSessionId = normalizeString(args.conversationSessionId);
    if (!conversationSessionId) {
      return { ok: false, reason: 'conversation_session_required' };
    }

    const tmuxSessionHint = normalizeString(args.tmuxSessionId);
    const daemonHint = normalizeString(args.daemonId);
    const clientTypeHint = normalizeString(args.clientType);

    let candidate: ClockClientRecord | undefined;

    if (daemonHint) {
      candidate = this.pickAliveCandidates({ daemonId: daemonHint })[0];
    }

    if (!candidate && tmuxSessionHint) {
      candidate = this.pickAliveCandidates({ tmuxSessionId: tmuxSessionHint })[0];
    }

    if (!candidate) {
      const mappedTmuxSession = normalizeString(this.conversationToTmuxSession.get(conversationSessionId));
      if (mappedTmuxSession) {
        candidate = this.pickAliveCandidates({ tmuxSessionId: mappedTmuxSession })[0];
      }
    }

    if (!candidate && clientTypeHint) {
      const byClientType = this.pickAliveCandidates({ clientType: clientTypeHint });
      if (byClientType.length === 1) {
        candidate = byClientType[0];
      }
    }

    if (!candidate) {
      const onlyAlive = this.pickAliveCandidates();
      if (onlyAlive.length === 1) {
        candidate = onlyAlive[0];
      }
    }

    if (!candidate) {
      return { ok: false, reason: 'no_binding_candidate' };
    }

    const tmuxSessionId = normalizeString(candidate.tmuxSessionId) ?? normalizeString(candidate.sessionId);
    if (!tmuxSessionId) {
      return { ok: false, reason: 'candidate_missing_tmux_session' };
    }

    const existingConversationIds = Array.isArray(candidate.conversationSessionIds)
      ? candidate.conversationSessionIds.filter((item) => normalizeString(item))
      : [];
    if (!existingConversationIds.includes(conversationSessionId)) {
      existingConversationIds.push(conversationSessionId);
    }

    candidate.conversationSessionIds = existingConversationIds;
    this.records.set(candidate.daemonId, candidate);
    this.conversationToTmuxSession.set(conversationSessionId, tmuxSessionId);

    return { ok: true, daemonId: candidate.daemonId, tmuxSessionId };
  }

  private resolveInjectTmuxSessionId(args: ClockClientInjectArgs): string | undefined {
    const directTmuxSession = normalizeString(args.tmuxSessionId);
    if (directTmuxSession) {
      return directTmuxSession;
    }

    const sessionAlias = normalizeString(args.sessionId);
    if (!sessionAlias) {
      return undefined;
    }

    const asTmuxSession = this.pickAliveCandidates({ tmuxSessionId: sessionAlias });
    if (asTmuxSession.length > 0) {
      return sessionAlias;
    }

    const mapped = normalizeString(this.conversationToTmuxSession.get(sessionAlias));
    if (mapped) {
      return mapped;
    }

    return sessionAlias;
  }

  async inject(args: ClockClientInjectArgs): Promise<ClockClientInjectResult> {
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text) {
      return { ok: false, reason: 'empty_text' };
    }

    const tmuxSessionId = this.resolveInjectTmuxSessionId(args);
    if (!tmuxSessionId) {
      return { ok: false, reason: 'tmux_session_required' };
    }

    const candidates = this.pickAliveCandidates({ tmuxSessionId });
    if (!candidates.length) {
      return { ok: false, reason: 'no_matching_tmux_session_daemon' };
    }

    for (const candidate of candidates) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1500);
      try {
        const response = await fetch(candidate.callbackUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text,
            requestId: args.requestId,
            source: args.source,
            tmuxSessionId,
            sessionId: tmuxSessionId
          }),
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!response.ok) {
          const errorText = await response.text().catch(() => String(response.status));
          candidate.lastError = `inject_http_${response.status}:${errorText}`;
          this.records.set(candidate.daemonId, candidate);
          continue;
        }
        candidate.lastInjectAtMs = Date.now();
        candidate.lastError = undefined;
        this.records.set(candidate.daemonId, candidate);
        return { ok: true, daemonId: candidate.daemonId };
      } catch (error) {
        clearTimeout(timeoutId);
        candidate.lastError = error instanceof Error ? error.message : String(error ?? 'unknown');
        this.records.set(candidate.daemonId, candidate);
      }
    }

    return { ok: false, reason: 'inject_failed' };
  }
}

const singleton = new ClockClientRegistry();

export function getClockClientRegistry(): ClockClientRegistry {
  return singleton;
}

export async function injectClockClientPrompt(args: ClockClientInjectArgs): Promise<void> {
  try {
    await singleton.inject(args);
  } catch {
    // best-effort only
  }
}
