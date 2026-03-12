import path from 'node:path';
import { resolveRccSessionsDir } from '../../../config/user-data-paths.js';

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
  } catch {
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
    } catch {
      return existing;
    }
  }
  process.env.ROUTECODEX_SESSION_DIR = resolved;
  return resolved;
}
