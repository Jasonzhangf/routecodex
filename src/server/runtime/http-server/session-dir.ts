import path from 'node:path';
import { resolveRccSessionsDir } from '../../../config/user-data-paths.js';

const NON_BLOCKING_LOG_THROTTLE_MS = 60_000;
const nonBlockingLogState = new Map<string, number>();

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function logSessionDirNonBlockingError(stage: string, error: unknown, details?: Record<string, unknown>): void {
  const now = Date.now();
  const last = nonBlockingLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingLogState.set(stage, now);
  try {
    const detailSuffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(`[session-dir] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`);
  } catch {
    // Never throw from non-blocking logging.
  }
}

function sanitizeSegment(value: string): string {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeSessionDirEnvValue(raw: unknown): string {
  const normalized = String(raw || '').trim();
  if (!normalized) {
    return '';
  }
  const lowered = normalized.toLowerCase();
  if (lowered === 'undefined' || lowered === 'null') {
    return '';
  }
  return normalized;
}

export function resolveServerScopedSessionDir(serverId: string): string | null {
  try {
    const safe = sanitizeSegment(serverId);
    if (!safe) {
      return null;
    }
    return path.join(resolveRccSessionsDir(), safe);
  } catch (error) {
    logSessionDirNonBlockingError('resolveServerScopedSessionDir', error, { serverId });
    return null;
  }
}

export function ensureServerScopedSessionDir(serverId: string): string | null {
  const existing = normalizeSessionDirEnvValue(process.env.ROUTECODEX_SESSION_DIR);
  const resolved = resolveServerScopedSessionDir(serverId);
  if (!resolved) {
    return existing || null;
  }

  // Do not override explicit external configs (e.g. user points to /tmp/custom-sessions).
  // But if the existing value looks like an auto-generated canonical sessions/<serverId> path
  // and does not match the current serverId, override it to prevent cross-server leakage
  // when servers are restarted/rebound within the same process.
  if (existing) {
    try {
      const base = resolveRccSessionsDir();
      const normalizedExisting = path.resolve(existing);
      const normalizedResolved = path.resolve(resolved);
      const normalizedBase = path.resolve(base);

      const isUnderBase =
        (normalizedExisting === normalizedBase || normalizedExisting.startsWith(`${normalizedBase}${path.sep}`));

      if (!isUnderBase) {
        return existing;
      }

      if (normalizedExisting === normalizedResolved) {
        return existing;
      }
    } catch (error) {
      logSessionDirNonBlockingError('ensureServerScopedSessionDir.inspectExisting', error, {
        serverId,
        existing
      });
      return existing;
    }
  }
  process.env.ROUTECODEX_SESSION_DIR = resolved;
  return resolved;
}
