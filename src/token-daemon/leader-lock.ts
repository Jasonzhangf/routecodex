import fs from 'fs/promises';
import path from 'path';
import { resolveRccPath } from '../config/user-data-paths.js';

export interface TokenManagerLeaderInfo {
  ownerId: string;
  pid: number;
  startedAt: number;
}

const STATE_DIR = resolveRccPath('state', 'token-manager');
const LEADER_FILE = path.join(STATE_DIR, 'leader.json');
const NON_BLOCKING_WARN_THROTTLE_MS = 60_000;
const nonBlockingWarnByStage = new Map<string, number>();

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

function shouldLogNonBlockingStage(stage: string): boolean {
  const now = Date.now();
  const lastAt = nonBlockingWarnByStage.get(stage) ?? 0;
  if (now - lastAt < NON_BLOCKING_WARN_THROTTLE_MS) {
    return false;
  }
  nonBlockingWarnByStage.set(stage, now);
  return true;
}

function readErrorCode(error: unknown): string {
  const value = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return typeof value === 'string' ? value : '';
}

function logLeaderLockNonBlockingError(
  stage: string,
  operation: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  if (!shouldLogNonBlockingStage(stage)) {
    return;
  }
  try {
    const suffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(
      `[leader-lock] stage=${stage} operation=${operation} failed (non-blocking): ${formatUnknownError(error)}${suffix}`
    );
  } catch {
    void 0;
  }
}

export function getTokenManagerLeaderFilePath(): string {
  return LEADER_FILE;
}

export async function tryAcquireTokenManagerLeader(
  ownerId: string
): Promise<{ isLeader: boolean; leader?: TokenManagerLeaderInfo }> {
  await ensureStateDir();

  const existing = await readCurrentLeader();
  if (existing && (await isPidAlive(existing.pid))) {
    return { isLeader: false, leader: existing };
  }

  const info: TokenManagerLeaderInfo = {
    ownerId,
    pid: process.pid,
    startedAt: Date.now()
  };

  try {
    const payload = JSON.stringify(info, null, 2);
    await fs.writeFile(LEADER_FILE, payload, 'utf8');
    return { isLeader: true, leader: info };
  } catch (error) {
    logLeaderLockNonBlockingError('leader_acquire', 'write_leader', error, {
      ownerId,
      filepath: LEADER_FILE
    });
    // Possible race: another process became leader in the meantime.
    const after = await readCurrentLeader();
    if (after && (await isPidAlive(after.pid))) {
      return { isLeader: false, leader: after };
    }
    return { isLeader: false };
  }
}

export async function releaseTokenManagerLeader(ownerId: string): Promise<void> {
  try {
    const existing = await readCurrentLeader();
    if (!existing || existing.ownerId !== ownerId || existing.pid !== process.pid) {
      return;
    }
    await fs.unlink(LEADER_FILE);
  } catch (error) {
    logLeaderLockNonBlockingError('leader_release', 'release_leader', error, {
      ownerId,
      filepath: LEADER_FILE
    });
  }
}

async function ensureStateDir(): Promise<void> {
  try {
    await fs.mkdir(STATE_DIR, { recursive: true });
  } catch (error) {
    logLeaderLockNonBlockingError('state_dir', 'ensure_state_dir', error, {
      filepath: STATE_DIR
    });
  }
}

async function readCurrentLeader(): Promise<TokenManagerLeaderInfo | null> {
  try {
    const raw = await fs.readFile(LEADER_FILE, 'utf8');
    const parsed = JSON.parse(raw) as TokenManagerLeaderInfo;
    if (!parsed || typeof parsed.pid !== 'number' || !Number.isFinite(parsed.pid)) {
      return null;
    }
    return parsed;
  } catch (error) {
    if (readErrorCode(error) !== 'ENOENT') {
      logLeaderLockNonBlockingError('leader_read', 'read_current_leader', error, {
        filepath: LEADER_FILE
      });
    }
    return null;
  }
}

async function isPidAlive(pid: number): Promise<boolean> {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = readErrorCode(error);
    if (code && code !== 'ESRCH') {
      logLeaderLockNonBlockingError('pid_probe', 'pid_alive_probe', error, {
        pid
      });
    }
    return false;
  }
}
