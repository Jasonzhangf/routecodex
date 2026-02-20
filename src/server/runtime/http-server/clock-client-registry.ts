import fs from 'node:fs';
import path from 'node:path';
import {
  cleanupDeadTmuxSessionsFromRegistry,
  cleanupStaleHeartbeatsFromRegistry,
  isWorkdirCompatible,
  normalizePositiveInt,
  normalizeString,
  normalizeWorkdir,
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
  private bindingsLoaded = false;
  private bindingsStorePath: string | undefined;

  private normalizeSessionDirEnvValue(raw: unknown): string | undefined {
    const normalized = normalizeString(raw);
    if (!normalized) {
      return undefined;
    }
    const lowered = normalized.toLowerCase();
    if (lowered === 'undefined' || lowered === 'null') {
      return undefined;
    }
    return normalized;
  }

  private resolveBindingsStorePath(): string | undefined {
    const sessionDir = this.normalizeSessionDirEnvValue(process.env.ROUTECODEX_SESSION_DIR);
    if (!sessionDir) {
      return undefined;
    }
    return path.join(sessionDir, 'clock-session-bindings.json');
  }

  private ensureConversationBindingsLoaded(): void {
    const nextStorePath = this.resolveBindingsStorePath();
    if (this.bindingsLoaded && this.bindingsStorePath === nextStorePath) {
      return;
    }

    this.conversationToTmuxSession.clear();
    this.bindingsLoaded = true;
    this.bindingsStorePath = nextStorePath;
    if (!nextStorePath) {
      return;
    }

    try {
      const raw = fs.readFileSync(nextStorePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const container = parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : {};
      const rawMappings =
        container.conversationToTmuxSession && typeof container.conversationToTmuxSession === 'object'
          ? (container.conversationToTmuxSession as Record<string, unknown>)
          : (container as Record<string, unknown>);
      for (const [conversationSessionIdRaw, tmuxSessionIdRaw] of Object.entries(rawMappings)) {
        const conversationSessionId = normalizeString(conversationSessionIdRaw);
        const tmuxSessionId = normalizeString(tmuxSessionIdRaw);
        if (!conversationSessionId || !tmuxSessionId) {
          continue;
        }
        this.conversationToTmuxSession.set(conversationSessionId, tmuxSessionId);
      }
    } catch {
      // best-effort only
    }
  }

  private persistConversationBindings(): void {
    this.ensureConversationBindingsLoaded();
    if (!this.bindingsStorePath) {
      return;
    }

    try {
      fs.mkdirSync(path.dirname(this.bindingsStorePath), { recursive: true });
      const payload: Record<string, unknown> = {
        updatedAtMs: Date.now(),
        conversationToTmuxSession: Object.fromEntries(this.conversationToTmuxSession.entries())
      };
      const tempPath = `${this.bindingsStorePath}.tmp`;
      fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      fs.renameSync(tempPath, this.bindingsStorePath);
    } catch {
      // best-effort only
    }
  }

  register(input: {
    daemonId: string;
    callbackUrl: string;
    tmuxSessionId?: string;
    sessionId?: string;
    workdir?: string;
    clientType?: string;
    tmuxTarget?: string;
    managedTmuxSession?: boolean;
    managedClientProcess?: boolean;
    managedClientPid?: number;
    managedClientCommandHint?: string;
  }): ClockClientRecord {
    this.ensureConversationBindingsLoaded();
    const now = Date.now();
    const resolvedTmuxSessionId = normalizeString(input.tmuxSessionId) ?? normalizeString(input.sessionId);
    const previous = this.records.get(input.daemonId);
    const resolvedWorkdir = normalizeWorkdir(input.workdir) ?? normalizeWorkdir(previous?.workdir);
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
      ...(resolvedWorkdir ? { workdir: resolvedWorkdir } : {}),
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
      this.persistConversationBindings();
    }

    return { ...record, ...(record.conversationSessionIds ? { conversationSessionIds: [...record.conversationSessionIds] } : {}) };
  }

  heartbeat(daemonId: string, input?: {
    tmuxSessionId?: string;
    workdir?: string;
    managedTmuxSession?: boolean;
    managedClientProcess?: boolean;
    managedClientPid?: number;
    managedClientCommandHint?: string;
  }): boolean {
    this.ensureConversationBindingsLoaded();
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
    const workdir = normalizeWorkdir(input?.workdir);
    if (workdir) {
      rec.workdir = workdir;
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
      this.persistConversationBindings();
    }

    this.records.set(daemonId, rec);
    return true;
  }

  unregister(daemonId: string): boolean {
    this.ensureConversationBindingsLoaded();
    const record = this.records.get(daemonId);
    let mappingChanged = false;
    if (record) {
      const tmuxSessionId = normalizeString(record.tmuxSessionId) ?? normalizeString(record.sessionId);
      const boundConversationSessionIds = Array.isArray(record.conversationSessionIds)
        ? record.conversationSessionIds
        : [];
      for (const conversationSessionId of boundConversationSessionIds) {
        const mapped = this.conversationToTmuxSession.get(conversationSessionId);
        if (mapped && tmuxSessionId && mapped === tmuxSessionId) {
          this.conversationToTmuxSession.delete(conversationSessionId);
          mappingChanged = true;
        }
      }
    }
    const removed = this.records.delete(daemonId);
    if (mappingChanged) {
      this.persistConversationBindings();
    }
    return removed;
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

  findByDaemonId(daemonIdRaw: string): ClockClientRecord | undefined {
    const daemonId = normalizeString(daemonIdRaw);
    if (!daemonId) {
      return undefined;
    }
    const record = this.records.get(daemonId);
    if (!record) {
      return undefined;
    }
    return {
      ...record,
      ...(Array.isArray(record.conversationSessionIds)
        ? { conversationSessionIds: [...record.conversationSessionIds] }
        : {})
    };
  }

  unbindConversationSession(conversationSessionIdRaw: string): { ok: boolean; removed: boolean; daemonIds: string[] } {
    this.ensureConversationBindingsLoaded();
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
    if (removed) {
      this.persistConversationBindings();
    }
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
    this.ensureConversationBindingsLoaded();
    const result = cleanupStaleHeartbeatsFromRegistry({
      records: this.records,
      conversationToTmuxSession: this.conversationToTmuxSession,
      ...args
    });
    if (result.removedConversationSessionIds.length > 0) {
      this.persistConversationBindings();
    }
    return result;
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
    this.ensureConversationBindingsLoaded();
    const result = cleanupDeadTmuxSessionsFromRegistry({
      records: this.records,
      conversationToTmuxSession: this.conversationToTmuxSession,
      ...args
    });
    if (result.removedConversationSessionIds.length > 0) {
      this.persistConversationBindings();
    }
    return result;
  }

  private isAlive(record: ClockClientRecord): boolean {
    return Date.now() - record.lastHeartbeatAtMs <= resolveHeartbeatTtlMs();
  }

  private pickAliveCandidates(filters?: {
    tmuxSessionId?: string;
    daemonId?: string;
    clientType?: string;
    workdir?: string;
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

    const workdir = normalizeWorkdir(filters?.workdir);
    if (workdir) {
      records = records.filter((entry) => isWorkdirCompatible(entry.workdir, workdir));
    }

    return records.sort((a, b) => b.lastHeartbeatAtMs - a.lastHeartbeatAtMs);
  }

  private resolveNoBindingReason(workdirHint: string | undefined): string {
    if (!workdirHint) {
      return 'no_binding_candidate';
    }
    const alive = this.pickAliveCandidates();
    if (!alive.length) {
      return 'no_binding_candidate';
    }
    return 'no_binding_candidate_for_workdir';
  }

  bindConversationSession(args: ClockConversationBindArgs): { ok: boolean; reason?: string; daemonId?: string; tmuxSessionId?: string } {
    this.ensureConversationBindingsLoaded();
    const conversationSessionId = normalizeString(args.conversationSessionId);
    if (!conversationSessionId) {
      return { ok: false, reason: 'conversation_session_required' };
    }

    const tmuxSessionHint = normalizeString(args.tmuxSessionId);
    const daemonHint = normalizeString(args.daemonId);
    const clientTypeHint = normalizeString(args.clientType);
    const workdirHint = normalizeWorkdir(args.workdir);
    const filteredCandidates = (filters?: {
      tmuxSessionId?: string;
      daemonId?: string;
      clientType?: string;
    }): ClockClientRecord[] => (
      this.pickAliveCandidates({
        ...(filters ?? {}),
        ...(workdirHint ? { workdir: workdirHint } : {})
      })
    );

    let candidate: ClockClientRecord | undefined;

    if (daemonHint) {
      candidate = filteredCandidates({ daemonId: daemonHint })[0];
    }

    if (!candidate && tmuxSessionHint) {
      candidate = filteredCandidates({ tmuxSessionId: tmuxSessionHint })[0];
    }

    if (!candidate) {
      const mappedTmuxSession = normalizeString(this.conversationToTmuxSession.get(conversationSessionId));
      if (mappedTmuxSession) {
        candidate = filteredCandidates({ tmuxSessionId: mappedTmuxSession })[0];
      }
    }

    if (!candidate && clientTypeHint) {
      const byClientType = filteredCandidates({ clientType: clientTypeHint });
      if (byClientType.length === 1) {
        candidate = byClientType[0];
      }
    }

    if (!candidate) {
      const onlyAlive = filteredCandidates();
      if (onlyAlive.length === 1) {
        candidate = onlyAlive[0];
      }
    }

    if (!candidate) {
      return { ok: false, reason: this.resolveNoBindingReason(workdirHint) };
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
    this.persistConversationBindings();

    return { ok: true, daemonId: candidate.daemonId, tmuxSessionId };
  }

  resolveBoundTmuxSession(conversationSessionIdRaw: string): string | undefined {
    this.ensureConversationBindingsLoaded();
    const conversationSessionId = normalizeString(conversationSessionIdRaw);
    if (!conversationSessionId) {
      return undefined;
    }
    return normalizeString(this.conversationToTmuxSession.get(conversationSessionId));
  }

  resolveBoundWorkdir(conversationSessionIdRaw: string): string | undefined {
    this.ensureConversationBindingsLoaded();
    const conversationSessionId = normalizeString(conversationSessionIdRaw);
    if (!conversationSessionId) {
      return undefined;
    }

    const tmuxSessionId = normalizeString(this.conversationToTmuxSession.get(conversationSessionId));
    if (!tmuxSessionId) {
      return undefined;
    }

    const aliveCandidates = this.pickAliveCandidates({ tmuxSessionId });
    const aliveWorkdirs = Array.from(
      new Set(
        aliveCandidates
          .map((entry) => normalizeWorkdir(entry.workdir))
          .filter((entry): entry is string => Boolean(entry))
      )
    );
    if (aliveWorkdirs.length === 1) {
      return aliveWorkdirs[0];
    }
    if (aliveWorkdirs.length > 1) {
      return undefined;
    }

    const historical = Array.from(this.records.values())
      .filter((entry) => {
        const recordTmuxSessionId = normalizeString(entry.tmuxSessionId) ?? normalizeString(entry.sessionId);
        return recordTmuxSessionId === tmuxSessionId;
      })
      .sort((a, b) => b.lastHeartbeatAtMs - a.lastHeartbeatAtMs);

    for (const entry of historical) {
      const workdir = normalizeWorkdir(entry.workdir);
      if (workdir) {
        return workdir;
      }
    }

    return undefined;
  }

  private resolveInjectTmuxSessionId(args: ClockClientInjectArgs, workdirHint?: string): string | undefined {
    this.ensureConversationBindingsLoaded();
    const directTmuxSession = normalizeString(args.tmuxSessionId);
    if (directTmuxSession) {
      return directTmuxSession;
    }

    const sessionAlias = normalizeString(args.sessionId);
    if (!sessionAlias) {
      return undefined;
    }

    const asTmuxSession = this.pickAliveCandidates({
      tmuxSessionId: sessionAlias,
      ...(workdirHint ? { workdir: workdirHint } : {})
    });
    if (asTmuxSession.length > 0) {
      return sessionAlias;
    }

    const mapped = normalizeString(this.conversationToTmuxSession.get(sessionAlias));
    if (mapped) {
      return mapped;
    }

    return undefined;
  }

  async inject(args: ClockClientInjectArgs): Promise<ClockClientInjectResult> {
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text) {
      return { ok: false, reason: 'empty_text' };
    }

    const workdirHint = normalizeWorkdir(args.workdir);
    const tmuxSessionId = this.resolveInjectTmuxSessionId(args, workdirHint);
    if (!tmuxSessionId) {
      return { ok: false, reason: 'tmux_session_required' };
    }

    const candidates = this.pickAliveCandidates({
      tmuxSessionId,
      ...(workdirHint ? { workdir: workdirHint } : {})
    });
    if (!candidates.length) {
      if (workdirHint && this.pickAliveCandidates({ tmuxSessionId }).length > 0) {
        return { ok: false, reason: 'workdir_mismatch' };
      }
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
            sessionId: tmuxSessionId,
            ...(workdirHint ? { workdir: workdirHint } : {})
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

export async function injectClockClientPromptWithResult(args: ClockClientInjectArgs): Promise<ClockClientInjectResult> {
  return await singleton.inject(args);
}

export async function injectClockClientPrompt(args: ClockClientInjectArgs): Promise<void> {
  try {
    await singleton.inject(args);
  } catch {
    // best-effort only
  }
}
