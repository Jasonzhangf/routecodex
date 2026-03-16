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
  prunedRegistryDirs: number;
  removedRegistryDirs: number;
  removedRegistryRecords: number;
  removedRegistryMappings: number;
  removedToolStateEntries: number;
};

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
  } catch {
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
  } catch {
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
  } catch {
    return false;
  }
}

function sanitizeSessionBindingsDir(args: {
  dirpath: string;
  nowMs: number;
  staleAfterMs: number;
  isTmuxSessionAlive: (tmuxSessionId: string) => boolean;
}): Omit<
  CleanupSummary,
  'removedLegacyScopeFiles' | 'removedDeadTmuxStateFiles' | 'removedHeartbeatStateFiles'
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

  const summary: CleanupSummary = {
    removedLegacyScopeFiles: 0,
    removedDeadTmuxStateFiles: 0,
    removedHeartbeatStateFiles: 0,
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
          let alive = Boolean(tmuxSessionId);
          if (tmuxSessionId) {
            try {
              alive = isTmuxSessionAlive(tmuxSessionId);
            } catch {
              alive = true;
            }
          }
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
          let alive = Boolean(tmuxSessionId);
          if (tmuxSessionId) {
            try {
              alive = isTmuxSessionAlive(tmuxSessionId);
            } catch {
              alive = true;
            }
          }
          if (!alive && removeFileIfExists(path.join(fullpath, heartbeatEntry.name))) {
            summary.removedHeartbeatStateFiles += 1;
          }
        }
        removeDirIfEmpty(fullpath);
        continue;
      }
      const dirSummary = sanitizeSessionBindingsDir({
        dirpath: fullpath,
        nowMs,
        staleAfterMs,
        isTmuxSessionAlive
      });
      summary.prunedRegistryDirs += dirSummary.prunedRegistryDirs;
      summary.removedRegistryDirs += dirSummary.removedRegistryDirs;
      summary.removedRegistryRecords += dirSummary.removedRegistryRecords;
      summary.removedRegistryMappings += dirSummary.removedRegistryMappings;
      summary.removedToolStateEntries += dirSummary.removedToolStateEntries;
    }
  } catch {
    return summary;
  }

  return summary;
}
