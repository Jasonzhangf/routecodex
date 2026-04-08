import fs from 'node:fs';
import path from 'node:path';
import { resolveRccSessionsDir } from '../../../config/user-data-paths.js';
import {
  normalizePositiveInt,
  normalizeString,
  resolveHeartbeatTtlMs
} from './session-client-registry-utils.js';
import { evaluateTmuxScopeCleanup } from './tmux-scope-cleanup-policy.js';

type CleanupSummary = {
  removedLegacyScopeFiles: number;
  removedDeadTmuxStateFiles: number;
  removedHeartbeatStateFiles: number;
  removedClockStateFiles: number;
  prunedRegistryDirs: number;
  removedRegistryDirs: number;
  removedRegistryRecords: number;
  removedRegistryMappings: number;
  removedToolStateEntries: number;
};

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? 'unknown');
}

function logSessionStorageCleanupNonBlockingError(stage: string, error: unknown, details?: Record<string, unknown>): void {
  try {
    const detailSuffix = details && Object.keys(details).length
      ? ` details=${JSON.stringify(details)}`
      : '';
    console.warn(
      `[session-storage-cleanup] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`
    );
  } catch {
    // Never throw from cleanup logging.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonFile(filepath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filepath, 'utf8').trim();
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code !== 'ENOENT') {
      logSessionStorageCleanupNonBlockingError('parse_json', error, { filepath });
    }
    return null;
  }
}

function writeJsonFile(filepath: string, payload: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  const tmp = `${filepath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filepath);
}

function removeFileIfExists(filepath: string): boolean {
  try {
    fs.unlinkSync(filepath);
    return true;
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code !== 'ENOENT') {
      logSessionStorageCleanupNonBlockingError('remove_file', error, { filepath });
    }
    return false;
  }
}

function removeDirIfEmpty(dirpath: string): boolean {
  try {
    const entries = fs.readdirSync(dirpath);
    if (entries.length > 0) {
      return false;
    }
    fs.rmdirSync(dirpath);
    return true;
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') {
      logSessionStorageCleanupNonBlockingError('remove_empty_dir', error, { dirpath });
    }
    return false;
  }
}

function readClockStateTmuxSessionId(filePath: string, fallbackName: string): string | null {
  const payload = parseJsonFile(filePath);
  if (payload) {
    const tmuxSessionId = normalizeString(payload.tmuxSessionId);
    if (tmuxSessionId) {
      return tmuxSessionId;
    }
    const sessionId = normalizeString(payload.sessionId);
    if (sessionId?.startsWith('tmux:')) {
      const rawTmux = normalizeString(sessionId.slice('tmux:'.length));
      if (rawTmux) {
        return rawTmux;
      }
    }
  }
  const fallback = normalizeString(fallbackName.replace(/\.json$/i, ''));
  if (fallback?.startsWith('tmux:')) {
    const rawTmux = normalizeString(fallback.slice('tmux:'.length));
    if (rawTmux) {
      return rawTmux;
    }
  }
  return null;
}

function sanitizeClockStateDir(args: {
  dirpath: string;
  isTmuxSessionAlive: (tmuxSessionId: string) => boolean;
}): number {
  let removedClockStateFiles = 0;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(args.dirpath, { withFileTypes: true });
  } catch (error) {
    logSessionStorageCleanupNonBlockingError('read_clock_dir', error, { dirpath: args.dirpath });
    return removedClockStateFiles;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === 'ntp-state.json') {
      continue;
    }
    const filePath = path.join(args.dirpath, entry.name);
    const tmuxSessionId = readClockStateTmuxSessionId(filePath, entry.name);
    if (!tmuxSessionId) {
      continue;
    }
    let alive = true;
    try {
      alive = args.isTmuxSessionAlive(tmuxSessionId);
    } catch (error) {
      logSessionStorageCleanupNonBlockingError('clock_liveness_probe', error, { tmuxSessionId });
      alive = true;
    }
    if (!alive && removeFileIfExists(filePath)) {
      removedClockStateFiles += 1;
    }
  }
  removeDirIfEmpty(args.dirpath);
  return removedClockStateFiles;
}

function sanitizeSessionBindingsDir(args: {
  dirpath: string;
  nowMs: number;
  staleAfterMs: number;
  isTmuxSessionAlive: (tmuxSessionId: string) => boolean;
}): Omit<
  CleanupSummary,
  'removedLegacyScopeFiles' | 'removedDeadTmuxStateFiles' | 'removedHeartbeatStateFiles' | 'removedClockStateFiles'
> {
  const bindingsFile = path.join(args.dirpath, 'session-bindings.json');
  const toolStateFile = path.join(args.dirpath, 'tmux-tools-state.json');
  const bindingsDoc = parseJsonFile(bindingsFile);
  const toolStateDoc = parseJsonFile(toolStateFile);

  const rawRecords = Array.isArray(bindingsDoc?.records) ? bindingsDoc.records : [];
  const keptRecords: Record<string, unknown>[] = [];
  const liveTmuxIds = new Set<string>();
  let removedRegistryRecords = 0;

  for (const raw of rawRecords) {
    if (!isRecord(raw)) {
      removedRegistryRecords += 1;
      continue;
    }
    const callbackUrl = normalizeString(raw.callbackUrl);
    const tmuxSessionId = normalizeString(raw.tmuxSessionId) ?? normalizeString(raw.sessionId);
    const lastHeartbeatAtMs = normalizePositiveInt(raw.lastHeartbeatAtMs) ?? 0;
    if (!callbackUrl || !tmuxSessionId) {
      removedRegistryRecords += 1;
      continue;
    }
    const cleanupDecision = evaluateTmuxScopeCleanup({
      mode: 'stale_record',
      tmuxSessionId,
      reason: 'startup_cleanup',
      isTmuxSessionAlive: args.isTmuxSessionAlive
    });
    if (cleanupDecision.cleanupTmuxScope) {
      removedRegistryRecords += 1;
      continue;
    }
    liveTmuxIds.add(tmuxSessionId);
    if (args.nowMs - lastHeartbeatAtMs > args.staleAfterMs) {
      removedRegistryRecords += 1;
      continue;
    }
    keptRecords.push(raw);
  }

  const rawMappings = isRecord(bindingsDoc?.conversationToTmuxSession)
    ? bindingsDoc?.conversationToTmuxSession
    : {};
  const keptMappings: Record<string, string> = {};
  let removedRegistryMappings = 0;
  for (const [conversationId, tmuxSessionIdRaw] of Object.entries(rawMappings)) {
    const conversationSessionId = normalizeString(conversationId);
    const tmuxSessionId = normalizeString(tmuxSessionIdRaw);
    if (!conversationSessionId || !tmuxSessionId || !liveTmuxIds.has(tmuxSessionId)) {
      removedRegistryMappings += 1;
      continue;
    }
    keptMappings[conversationSessionId] = tmuxSessionId;
  }

  const heartbeatsRaw = isRecord(toolStateDoc?.heartbeats) ? toolStateDoc.heartbeats : {};
  const injectionsRaw = isRecord(toolStateDoc?.injections) ? toolStateDoc.injections : {};
  const keptHeartbeats: Record<string, unknown> = {};
  const keptInjections: Record<string, unknown> = {};
  let removedToolStateEntries = 0;

  for (const [tmuxSessionIdRaw, value] of Object.entries(heartbeatsRaw)) {
    const tmuxSessionId = normalizeString(tmuxSessionIdRaw);
    if (!tmuxSessionId || !liveTmuxIds.has(tmuxSessionId)) {
      removedToolStateEntries += 1;
      continue;
    }
    keptHeartbeats[tmuxSessionId] = value;
  }
  for (const [tmuxSessionIdRaw, value] of Object.entries(injectionsRaw)) {
    const tmuxSessionId = normalizeString(tmuxSessionIdRaw);
    if (!tmuxSessionId || !liveTmuxIds.has(tmuxSessionId)) {
      removedToolStateEntries += 1;
      continue;
    }
    keptInjections[tmuxSessionId] = value;
  }

  let prunedRegistryDirs = 0;
  let removedRegistryDirs = 0;

  if (keptRecords.length > 0 || Object.keys(keptMappings).length > 0) {
    writeJsonFile(bindingsFile, {
      updatedAtMs: args.nowMs,
      records: keptRecords,
      conversationToTmuxSession: keptMappings
    });
    if (removedRegistryRecords > 0 || removedRegistryMappings > 0) {
      prunedRegistryDirs += 1;
    }
  } else if (removeFileIfExists(bindingsFile)) {
    removedRegistryDirs += 1;
  }

  if (Object.keys(keptHeartbeats).length > 0 || Object.keys(keptInjections).length > 0) {
    writeJsonFile(toolStateFile, {
      version: 1,
      updatedAtMs: args.nowMs,
      ...(Object.keys(keptHeartbeats).length > 0 ? { heartbeats: keptHeartbeats } : {}),
      ...(Object.keys(keptInjections).length > 0 ? { injections: keptInjections } : {})
    });
  } else {
    removeFileIfExists(toolStateFile);
  }

  if (removeDirIfEmpty(args.dirpath)) {
    removedRegistryDirs += 1;
  }

  return {
    prunedRegistryDirs,
    removedRegistryDirs,
    removedRegistryRecords,
    removedRegistryMappings,
    removedToolStateEntries
  };
}

export function cleanupSessionStorageOnStartup(options?: {
  baseDir?: string;
  nowMs?: number;
  staleAfterMs?: number;
  isTmuxSessionAlive?: (tmuxSessionId: string) => boolean;
}): CleanupSummary {
  const baseDir = path.resolve(options?.baseDir || resolveRccSessionsDir());
  const nowMs = Number.isFinite(options?.nowMs as number) ? Math.floor(options?.nowMs as number) : Date.now();
  const staleAfterMs =
    Number.isFinite(options?.staleAfterMs as number) && Number(options?.staleAfterMs) > 0
      ? Math.floor(Number(options?.staleAfterMs))
      : resolveHeartbeatTtlMs();
  const isTmuxSessionAlive = options?.isTmuxSessionAlive || (() => true);
  const tmuxLivenessCache = new Map<string, boolean>();
  const isTmuxSessionAliveMemoized = (tmuxSessionId: string): boolean => {
    const normalized = normalizeString(tmuxSessionId);
    if (!normalized) {
      return false;
    }
    const cached = tmuxLivenessCache.get(normalized);
    if (typeof cached === 'boolean') {
      return cached;
    }
    let alive = true;
    try {
      alive = isTmuxSessionAlive(normalized);
    } catch (error) {
      logSessionStorageCleanupNonBlockingError('startup_liveness_probe', error, { tmuxSessionId: normalized });
      alive = true;
    }
    tmuxLivenessCache.set(normalized, alive);
    return alive;
  };

  const summary: CleanupSummary = {
    removedLegacyScopeFiles: 0,
    removedDeadTmuxStateFiles: 0,
    removedHeartbeatStateFiles: 0,
    removedClockStateFiles: 0,
    prunedRegistryDirs: 0,
    removedRegistryDirs: 0,
    removedRegistryRecords: 0,
    removedRegistryMappings: 0,
    removedToolStateEntries: 0
  };

  try {
    if (!fs.existsSync(baseDir)) {
      return summary;
    }
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      const fullpath = path.join(baseDir, entry.name);
      if (entry.isFile()) {
        if (/^(session|conversation)-.+\.json$/i.test(entry.name)) {
          if (removeFileIfExists(fullpath)) {
            summary.removedLegacyScopeFiles += 1;
          }
          continue;
        }
        const tmuxMatch = /^tmux-(.+)\.json$/i.exec(entry.name);
        if (tmuxMatch) {
          const tmuxSessionId = normalizeString(tmuxMatch[1]);
          const alive = tmuxSessionId ? isTmuxSessionAliveMemoized(tmuxSessionId) : false;
          if (!alive && removeFileIfExists(fullpath)) {
            summary.removedDeadTmuxStateFiles += 1;
          }
        }
        continue;
      }

      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name === 'heartbeat') {
        for (const heartbeatEntry of fs.readdirSync(fullpath, { withFileTypes: true })) {
          if (!heartbeatEntry.isFile() || !heartbeatEntry.name.endsWith('.json')) {
            continue;
          }
          const tmuxSessionId = normalizeString(heartbeatEntry.name.replace(/\.json$/i, ''));
          const alive = tmuxSessionId ? isTmuxSessionAliveMemoized(tmuxSessionId) : false;
          if (!alive && removeFileIfExists(path.join(fullpath, heartbeatEntry.name))) {
            summary.removedHeartbeatStateFiles += 1;
          }
        }
        removeDirIfEmpty(fullpath);
        continue;
      }
      if (entry.name === 'clock') {
        summary.removedClockStateFiles += sanitizeClockStateDir({
          dirpath: fullpath,
          isTmuxSessionAlive: isTmuxSessionAliveMemoized
        });
        continue;
      }

      const nestedClockDir = path.join(fullpath, 'clock');
      if (fs.existsSync(nestedClockDir)) {
        summary.removedClockStateFiles += sanitizeClockStateDir({
          dirpath: nestedClockDir,
          isTmuxSessionAlive: isTmuxSessionAliveMemoized
        });
      }
      const dirSummary = sanitizeSessionBindingsDir({
        dirpath: fullpath,
        nowMs,
        staleAfterMs,
        isTmuxSessionAlive: isTmuxSessionAliveMemoized
      });
      summary.prunedRegistryDirs += dirSummary.prunedRegistryDirs;
      summary.removedRegistryDirs += dirSummary.removedRegistryDirs;
      summary.removedRegistryRecords += dirSummary.removedRegistryRecords;
      summary.removedRegistryMappings += dirSummary.removedRegistryMappings;
      summary.removedToolStateEntries += dirSummary.removedToolStateEntries;
    }
  } catch (error) {
    logSessionStorageCleanupNonBlockingError('startup_cleanup', error, { baseDir });
    return summary;
  }

  return summary;
}

export function cleanupSessionStorageOnShutdown(options?: Parameters<typeof cleanupSessionStorageOnStartup>[0]): CleanupSummary {
  return cleanupSessionStorageOnStartup(options);
}
