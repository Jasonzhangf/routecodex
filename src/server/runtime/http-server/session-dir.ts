import os from 'node:os';
import path from 'node:path';

function sanitizeSegment(value: string): string {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function resolveServerScopedSessionDir(serverId: string): string | null {
  try {
    const home = os.homedir();
    if (!home) {
      return null;
    }
    const safe = sanitizeSegment(serverId);
    if (!safe) {
      return null;
    }
    return path.join(home, '.routecodex', 'sessions', safe);
  } catch {
    return null;
  }
}

export function ensureServerScopedSessionDir(serverId: string): string | null {
  const existing = String(process.env.ROUTECODEX_SESSION_DIR || '').trim();
  const resolved = resolveServerScopedSessionDir(serverId);
  if (!resolved) {
    return existing || null;
  }

  // Do not override explicit external configs (e.g. user points to /tmp/custom-sessions).
  // But if the existing value looks like an auto-generated ~/.routecodex/sessions/<serverId> path
  // and does not match the current serverId, override it to prevent cross-server leakage
  // when servers are restarted/rebound within the same process.
  if (existing) {
    try {
      const home = os.homedir();
      const base = home ? path.join(home, '.routecodex', 'sessions') : '';
      const normalizedExisting = path.resolve(existing);
      const normalizedResolved = path.resolve(resolved);
      const normalizedBase = base ? path.resolve(base) : '';

      const isUnderBase =
        Boolean(normalizedBase) &&
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
