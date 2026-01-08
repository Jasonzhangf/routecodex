import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';

export interface TokenManagerLeaderInfo {
  ownerId: string;
  pid: number;
  startedAt: number;
}

const STATE_DIR = path.join(homedir(), '.routecodex', 'state', 'token-manager');
const LEADER_FILE = path.join(STATE_DIR, 'leader.json');

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
  } catch {
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
  } catch {
    // Best-effort cleanup; ignore failures.
  }
}

async function ensureStateDir(): Promise<void> {
  try {
    await fs.mkdir(STATE_DIR, { recursive: true });
  } catch {
    // ignore mkdir failures; subsequent file ops will surface real errors
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
  } catch {
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
  } catch {
    return false;
  }
}

