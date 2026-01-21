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
  if (existing) {
    return existing;
  }
  const resolved = resolveServerScopedSessionDir(serverId);
  if (resolved) {
    process.env.ROUTECODEX_SESSION_DIR = resolved;
  }
  return resolved;
}

