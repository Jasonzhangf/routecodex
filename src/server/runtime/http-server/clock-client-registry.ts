type ClockClientRecord = {
  daemonId: string;
  tmuxSessionId?: string;
  sessionId?: string;
  conversationSessionIds?: string[];
  clientType?: string;
  callbackUrl: string;
  tmuxTarget?: string;
  managedTmuxSession?: boolean;
  managedClientProcess?: boolean;
  managedClientPid?: number;
  managedClientCommandHint?: string;
  registeredAtMs: number;
  lastHeartbeatAtMs: number;
  lastInjectAtMs?: number;
  lastError?: string;
};

type ClockClientInjectArgs = {
  tmuxSessionId?: string;
  sessionId?: string;
  text: string;
  requestId?: string;
  source?: string;
};

type ClockClientInjectResult = {
  ok: boolean;
  daemonId?: string;
  reason?: string;
};

type ClockConversationBindArgs = {
  conversationSessionId: string;
  tmuxSessionId?: string;
  daemonId?: string;
  clientType?: string;
};

type ClockCleanupResult = {
  removedDaemonIds: string[];
  removedTmuxSessionIds: string[];
  removedConversationSessionIds: string[];
  killedTmuxSessionIds: string[];
  failedKillTmuxSessionIds: string[];
  skippedKillTmuxSessionIds: string[];
  killedManagedClientPids: number[];
  failedKillManagedClientPids: number[];
  skippedKillManagedClientPids: number[];
};

type ClockStaleCleanupResult = ClockCleanupResult & {
  staleAfterMs: number;
};

const HEARTBEAT_TTL_MS = 45_000;

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function resolveHeartbeatTtlMs(): number {
  const raw = String(
    process.env.ROUTECODEX_CLOCK_CLIENT_HEARTBEAT_TTL_MS
      || process.env.RCC_CLOCK_CLIENT_HEARTBEAT_TTL_MS
      || ''
  ).trim();
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed >= 5_000) {
    return Math.floor(parsed);
  }
  return HEARTBEAT_TTL_MS;
}

function resolveManagedTmuxSessionState(args: {
  previousManagedTmuxSession?: boolean;
  managedTmuxSessionInput?: boolean;
}): boolean {
  if (args.managedTmuxSessionInput === true) {
    return true;
  }
  if (args.managedTmuxSessionInput === false) {
    return false;
  }
  return args.previousManagedTmuxSession === true;
}

function resolveManagedClientProcessState(args: {
  previousManagedClientProcess?: boolean;
  managedClientProcessInput?: boolean;
}): boolean {
  if (args.managedClientProcessInput === true) {
    return true;
  }
  if (args.managedClientProcessInput === false) {
    return false;
  }
  return args.previousManagedClientProcess === true;
}

function normalizePositiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

export class ClockClientRegistry {
  private readonly records = new Map<string, ClockClientRecord>();
  private readonly conversationToTmuxSession = new Map<string, string>();

  private removeConversationMappingsByTmuxSession(tmuxSessionId: string): string[] {
    const normalizedTmuxSessionId = normalizeString(tmuxSessionId);
    if (!normalizedTmuxSessionId) {
      return [];
    }
    const removed: string[] = [];
    for (const [conversationSessionId, mappedTmuxSessionId] of this.conversationToTmuxSession.entries()) {
      if (normalizeString(mappedTmuxSessionId) !== normalizedTmuxSessionId) {
        continue;
      }
      this.conversationToTmuxSession.delete(conversationSessionId);
      removed.push(conversationSessionId);
    }
    return removed;
  }

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
    const nowMs = Number.isFinite(args?.nowMs as number) ? Math.floor(args?.nowMs as number) : Date.now();
    const staleAfterMs = Number.isFinite(args?.staleAfterMs as number)
      ? Math.max(1, Math.floor(args?.staleAfterMs as number))
      : resolveHeartbeatTtlMs();

    const removedDaemonIds: string[] = [];
    const removedTmuxSessionIds: string[] = [];
    const removedConversationSessionIdsSet = new Set<string>();
    const killedTmuxSessionIds: string[] = [];
    const failedKillTmuxSessionIds: string[] = [];
    const skippedKillTmuxSessionIds: string[] = [];
    const killedManagedClientPids: number[] = [];
    const failedKillManagedClientPids: number[] = [];
    const skippedKillManagedClientPids: number[] = [];

    for (const [daemonId, record] of this.records.entries()) {
      if (nowMs - record.lastHeartbeatAtMs <= staleAfterMs) {
        continue;
      }

      const tmuxSessionId = normalizeString(record.tmuxSessionId) ?? normalizeString(record.sessionId);
      if (tmuxSessionId) {
        // Guardrail: stale heartbeat cleanup must never terminate tmux sessions.
        skippedKillTmuxSessionIds.push(tmuxSessionId);
      }

      const managedClientPid = normalizePositiveInt(record.managedClientPid);
      if (managedClientPid) {
        // Guardrail: stale heartbeat cleanup must never terminate managed client processes.
        skippedKillManagedClientPids.push(managedClientPid);
      }

      removedDaemonIds.push(daemonId);
      if (tmuxSessionId) {
        removedTmuxSessionIds.push(tmuxSessionId);
      }

      const conversationSessionIds = Array.isArray(record.conversationSessionIds)
        ? record.conversationSessionIds.filter((item) => normalizeString(item))
        : [];

      for (const conversationSessionId of conversationSessionIds) {
        const mapped = this.conversationToTmuxSession.get(conversationSessionId);
        if (mapped && (!tmuxSessionId || mapped === tmuxSessionId)) {
          this.conversationToTmuxSession.delete(conversationSessionId);
          removedConversationSessionIdsSet.add(conversationSessionId);
        }
      }
      if (tmuxSessionId) {
        for (const conversationSessionId of this.removeConversationMappingsByTmuxSession(tmuxSessionId)) {
          removedConversationSessionIdsSet.add(conversationSessionId);
        }
      }

      this.records.delete(daemonId);
    }

    return {
      staleAfterMs,
      removedDaemonIds,
      removedTmuxSessionIds,
      removedConversationSessionIds: Array.from(removedConversationSessionIdsSet),
      killedTmuxSessionIds,
      failedKillTmuxSessionIds,
      skippedKillTmuxSessionIds,
      killedManagedClientPids,
      failedKillManagedClientPids,
      skippedKillManagedClientPids
    };
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
    const removedDaemonIds: string[] = [];
    const removedTmuxSessionIds: string[] = [];
    const removedConversationSessionIdsSet = new Set<string>();
    const killedTmuxSessionIds: string[] = [];
    const failedKillTmuxSessionIds: string[] = [];
    const skippedKillTmuxSessionIds: string[] = [];
    const killedManagedClientPids: number[] = [];
    const failedKillManagedClientPids: number[] = [];
    const skippedKillManagedClientPids: number[] = [];
    const killedSessionOnce = new Set<string>();
    const sessionKillOutcome = new Map<string, boolean>();
    const killedProcessOnce = new Set<number>();
    const processKillOutcome = new Map<number, boolean>();

    for (const [daemonId, record] of this.records.entries()) {
      const tmuxSessionId = normalizeString(record.tmuxSessionId) ?? normalizeString(record.sessionId);
      if (!tmuxSessionId) {
        continue;
      }
      let alive = true;
      try {
        alive = args.isTmuxSessionAlive(tmuxSessionId);
      } catch {
        alive = true;
      }
      if (alive) {
        continue;
      }

      let canRemoveRecord = true;

      if (record.managedTmuxSession) {
        if (killedSessionOnce.has(tmuxSessionId)) {
          skippedKillTmuxSessionIds.push(tmuxSessionId);
          if (sessionKillOutcome.get(tmuxSessionId) === false) {
            canRemoveRecord = false;
          }
        } else if (typeof args.terminateManagedTmuxSession === 'function') {
          let killed = false;
          try {
            killed = Boolean(args.terminateManagedTmuxSession(tmuxSessionId));
          } catch {
            killed = false;
          }
          if (killed) {
            killedTmuxSessionIds.push(tmuxSessionId);
          } else {
            failedKillTmuxSessionIds.push(tmuxSessionId);
            canRemoveRecord = false;
          }
          killedSessionOnce.add(tmuxSessionId);
          sessionKillOutcome.set(tmuxSessionId, killed);
        } else {
          skippedKillTmuxSessionIds.push(tmuxSessionId);
        }
      } else {
        skippedKillTmuxSessionIds.push(tmuxSessionId);
      }

      const managedClientPid = normalizePositiveInt(record.managedClientPid);
      if (record.managedClientProcess && managedClientPid) {
        if (killedProcessOnce.has(managedClientPid)) {
          skippedKillManagedClientPids.push(managedClientPid);
          if (processKillOutcome.get(managedClientPid) === false) {
            canRemoveRecord = false;
          }
        } else if (typeof args.terminateManagedClientProcess === 'function') {
          let killed = false;
          try {
            killed = Boolean(args.terminateManagedClientProcess({
              daemonId,
              pid: managedClientPid,
              commandHint: normalizeString(record.managedClientCommandHint),
              clientType: normalizeString(record.clientType)
            }));
          } catch {
            killed = false;
          }
          if (killed) {
            killedManagedClientPids.push(managedClientPid);
          } else {
            failedKillManagedClientPids.push(managedClientPid);
            canRemoveRecord = false;
          }
          killedProcessOnce.add(managedClientPid);
          processKillOutcome.set(managedClientPid, killed);
        } else {
          skippedKillManagedClientPids.push(managedClientPid);
        }
      } else if (managedClientPid) {
        skippedKillManagedClientPids.push(managedClientPid);
      }

      if (!canRemoveRecord) {
        continue;
      }

      removedDaemonIds.push(daemonId);
      removedTmuxSessionIds.push(tmuxSessionId);

      const conversationSessionIds = Array.isArray(record.conversationSessionIds)
        ? record.conversationSessionIds.filter((item) => normalizeString(item))
        : [];

      for (const conversationSessionId of conversationSessionIds) {
        const mapped = this.conversationToTmuxSession.get(conversationSessionId);
        if (mapped === tmuxSessionId) {
          this.conversationToTmuxSession.delete(conversationSessionId);
          removedConversationSessionIdsSet.add(conversationSessionId);
        }
      }
      for (const conversationSessionId of this.removeConversationMappingsByTmuxSession(tmuxSessionId)) {
        removedConversationSessionIdsSet.add(conversationSessionId);
      }

      this.records.delete(daemonId);
    }

    return {
      removedDaemonIds,
      removedTmuxSessionIds,
      removedConversationSessionIds: Array.from(removedConversationSessionIdsSet),
      killedTmuxSessionIds,
      failedKillTmuxSessionIds,
      skippedKillTmuxSessionIds,
      killedManagedClientPids,
      failedKillManagedClientPids,
      skippedKillManagedClientPids
    };
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
