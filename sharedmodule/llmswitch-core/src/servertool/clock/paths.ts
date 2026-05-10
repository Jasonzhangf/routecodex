import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveRccPath } from '../../runtime/user-data-paths.js';

export function readSessionDirEnv(): string {
  const direct = String(
    process.env.ROUTECODEX_SESSION_DIR
    || process.env.RCC_SESSION_DIR
    || ''
  ).trim();
  if (direct) {
    const lowered = direct.toLowerCase();
    if (lowered !== 'undefined' && lowered !== 'null') {
      return direct;
    }
  }
  try {
    return resolveRccPath('sessions');
  } catch {
    return '';
  }
}

function sanitizeSegment(value: string): string {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function resolveClockDir(sessionDir: string): string {
  return path.join(sessionDir, 'clock');
}

export function resolveClockNtpStateFile(sessionDir: string): string {
  return path.join(resolveClockDir(sessionDir), 'ntp-state.json');
}

export function resolveClockStateFile(sessionDir: string, sessionId: string): string | null {
  const safe = sanitizeSegment(sessionId);
  if (!safe) {
    return null;
  }
  return path.join(resolveClockDir(sessionDir), `${safe}.json`);
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}
