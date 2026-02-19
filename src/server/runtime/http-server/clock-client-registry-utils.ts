import path from 'node:path';

export type ClockClientRecord = {
  daemonId: string;
  tmuxSessionId?: string;
  sessionId?: string;
  workdir?: string;
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

export type ClockClientInjectArgs = {
  tmuxSessionId?: string;
  sessionId?: string;
  workdir?: string;
  text: string;
  requestId?: string;
  source?: string;
};

export type ClockClientInjectResult = {
  ok: boolean;
  daemonId?: string;
  reason?: string;
};

export type ClockConversationBindArgs = {
  conversationSessionId: string;
  tmuxSessionId?: string;
  daemonId?: string;
  clientType?: string;
  workdir?: string;
};

export type ClockCleanupResult = {
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

export type ClockStaleCleanupResult = ClockCleanupResult & {
  staleAfterMs: number;
};

type ManagedProcessInfo = {
  daemonId: string;
  pid: number;
  commandHint?: string;
  clientType?: string;
};

const HEARTBEAT_TTL_MS = 45_000;

export function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function normalizeWorkdir(value: unknown): string | undefined {
  const normalized = normalizeString(value);
  if (!normalized) {
    return undefined;
  }
  if (!path.isAbsolute(normalized)) {
    return undefined;
  }
  const resolved = path.normalize(normalized);
  if (!resolved) {
    return undefined;
  }
  if (process.platform === 'win32') {
    return resolved.toLowerCase();
  }
  return resolved;
}

function isSameOrDescendantPath(parentDir: string, childDir: string): boolean {
  const relative = path.relative(parentDir, childDir);
  if (!relative) {
    return true;
  }
  if (relative === '..') {
    return false;
  }
  if (relative.startsWith(`..${path.sep}`)) {
    return false;
  }
  return !path.isAbsolute(relative);
}

export function isWorkdirCompatible(recordWorkdirRaw: unknown, hintWorkdirRaw: unknown): boolean {
  const recordWorkdir = normalizeWorkdir(recordWorkdirRaw);
  const hintWorkdir = normalizeWorkdir(hintWorkdirRaw);
  if (!recordWorkdir || !hintWorkdir) {
    return false;
  }

  return isSameOrDescendantPath(recordWorkdir, hintWorkdir) || isSameOrDescendantPath(hintWorkdir, recordWorkdir);
}

export function resolveHeartbeatTtlMs(): number {
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

export function resolveManagedTmuxSessionState(args: {
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

export function resolveManagedClientProcessState(args: {
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

export function normalizePositiveInt(value: unknown): number | undefined {
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

export function removeConversationMappingsByTmuxSession(
  conversationToTmuxSession: Map<string, string>,
  tmuxSessionIdRaw: string
): string[] {
  const tmuxSessionId = normalizeString(tmuxSessionIdRaw);
  if (!tmuxSessionId) {
    return [];
  }
  const removed: string[] = [];
  for (const [conversationSessionId, mappedTmuxSessionId] of conversationToTmuxSession.entries()) {
    if (normalizeString(mappedTmuxSessionId) !== tmuxSessionId) {
      continue;
    }
    conversationToTmuxSession.delete(conversationSessionId);
    removed.push(conversationSessionId);
  }
  return removed;
}

function hasOtherDaemonForTmuxSession(args: {
  records: Map<string, ClockClientRecord>;
  daemonId: string;
  tmuxSessionId: string;
}): boolean {
  const targetTmuxSessionId = normalizeString(args.tmuxSessionId);
  if (!targetTmuxSessionId) {
    return false;
  }
  for (const [daemonId, record] of args.records.entries()) {
    if (daemonId === args.daemonId) {
      continue;
    }
    const recordTmuxSessionId = normalizeString(record.tmuxSessionId) ?? normalizeString(record.sessionId);
    if (recordTmuxSessionId === targetTmuxSessionId) {
      return true;
    }
  }
  return false;
}

export function cleanupStaleHeartbeatsFromRegistry(args: {
  records: Map<string, ClockClientRecord>;
  conversationToTmuxSession: Map<string, string>;
  nowMs?: number;
  staleAfterMs?: number;
  terminateManagedTmuxSession?: (tmuxSessionId: string) => boolean;
  terminateManagedClientProcess?: (processInfo: ManagedProcessInfo) => boolean;
}): ClockStaleCleanupResult {
  const nowMs = Number.isFinite(args.nowMs as number) ? Math.floor(args.nowMs as number) : Date.now();
  const staleAfterMs = Number.isFinite(args.staleAfterMs as number)
    ? Math.max(1, Math.floor(args.staleAfterMs as number))
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

  for (const [daemonId, record] of args.records.entries()) {
    if (nowMs - record.lastHeartbeatAtMs <= staleAfterMs) {
      continue;
    }

    const tmuxSessionId = normalizeString(record.tmuxSessionId) ?? normalizeString(record.sessionId);
    const hasSharedTmuxPeer = tmuxSessionId
      ? hasOtherDaemonForTmuxSession({ records: args.records, daemonId, tmuxSessionId })
      : false;
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

    if (!hasSharedTmuxPeer) {
      for (const conversationSessionId of conversationSessionIds) {
        const mapped = args.conversationToTmuxSession.get(conversationSessionId);
        if (mapped && (!tmuxSessionId || mapped === tmuxSessionId)) {
          args.conversationToTmuxSession.delete(conversationSessionId);
          removedConversationSessionIdsSet.add(conversationSessionId);
        }
      }
      if (tmuxSessionId) {
        for (const conversationSessionId of removeConversationMappingsByTmuxSession(args.conversationToTmuxSession, tmuxSessionId)) {
          removedConversationSessionIdsSet.add(conversationSessionId);
        }
      }
    }

    args.records.delete(daemonId);
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

export function cleanupDeadTmuxSessionsFromRegistry(args: {
  records: Map<string, ClockClientRecord>;
  conversationToTmuxSession: Map<string, string>;
  isTmuxSessionAlive: (tmuxSessionId: string) => boolean;
  terminateManagedTmuxSession?: (tmuxSessionId: string) => boolean;
  terminateManagedClientProcess?: (processInfo: ManagedProcessInfo) => boolean;
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

  for (const [daemonId, record] of args.records.entries()) {
    const tmuxTarget = normalizeString(record.tmuxTarget);

    // Process-managed records without tmux target are non-tmux clients.
    // Skip dead-tmux cleanup for these records to avoid terminating
    // foreground-managed client processes by mistake.
    if (record.managedClientProcess && !record.managedTmuxSession && !tmuxTarget) {
      const managedClientPid = normalizePositiveInt(record.managedClientPid);
      if (managedClientPid) {
        skippedKillManagedClientPids.push(managedClientPid);
      }
      continue;
    }

    const tmuxSessionId = normalizeString(record.tmuxSessionId) ?? normalizeString(record.sessionId);
    const hasSharedTmuxPeer = tmuxSessionId
      ? hasOtherDaemonForTmuxSession({ records: args.records, daemonId, tmuxSessionId })
      : false;
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

    if (!hasSharedTmuxPeer) {
      for (const conversationSessionId of conversationSessionIds) {
        const mapped = args.conversationToTmuxSession.get(conversationSessionId);
        if (mapped === tmuxSessionId) {
          args.conversationToTmuxSession.delete(conversationSessionId);
          removedConversationSessionIdsSet.add(conversationSessionId);
        }
      }
      for (const conversationSessionId of removeConversationMappingsByTmuxSession(args.conversationToTmuxSession, tmuxSessionId)) {
        removedConversationSessionIdsSet.add(conversationSessionId);
      }
    }

    args.records.delete(daemonId);
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
