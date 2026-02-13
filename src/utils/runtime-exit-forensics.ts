import fsSync from 'node:fs';
import fsAsync from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

export type RuntimeExitMarker = {
  kind: string;
  code: number | null;
  signal?: string;
  message?: string;
  recordedAt: string;
};

export type RuntimeLifecycleState = {
  runId: string;
  pid: number;
  port: number;
  startedAt: string;
  buildVersion?: string;
  buildMode?: string;
  exit?: RuntimeExitMarker;
};

export type UngracefulInference = {
  shouldReport: boolean;
  reason: string;
};

function normalizePort(port: number): number {
  return Number.isFinite(port) && port > 0 ? Math.floor(port) : 0;
}

export function resolveRuntimeLifecyclePath(port: number, routeCodexHomeDir?: string): string {
  const home = routeCodexHomeDir || path.join(homedir(), '.routecodex');
  return path.join(home, 'state', 'runtime-lifecycle', `server-${normalizePort(port)}.json`);
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fsSync.existsSync(dir)) {
    fsSync.mkdirSync(dir, { recursive: true });
  }
}

async function ensureParentDirAsync(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fsAsync.mkdir(dir, { recursive: true });
}

export function safeReadRuntimeLifecycle(filePath: string): RuntimeLifecycleState | null {
  try {
    if (!fsSync.existsSync(filePath)) {
      return null;
    }
    const raw = fsSync.readFileSync(filePath, 'utf8');
    if (!raw.trim()) {
      return null;
    }
    const parsed = JSON.parse(raw) as RuntimeLifecycleState;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const pid = Number((parsed as RuntimeLifecycleState).pid);
    const port = Number((parsed as RuntimeLifecycleState).port);
    const runId = String((parsed as RuntimeLifecycleState).runId || '').trim();
    if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(port) || port <= 0 || !runId) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function safeWriteRuntimeLifecycle(filePath: string, state: RuntimeLifecycleState): Promise<boolean> {
  try {
    await ensureParentDirAsync(filePath);
    await fsAsync.writeFile(filePath, JSON.stringify(state, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function safeMarkRuntimeExit(filePath: string, marker: RuntimeExitMarker): boolean {
  try {
    const existing = safeReadRuntimeLifecycle(filePath);
    if (!existing) {
      return false;
    }
    const next: RuntimeLifecycleState = {
      ...existing,
      exit: marker
    };
    return safeWriteRuntimeLifecycle(filePath, next);
  } catch {
    return false;
  }
}

export function isPidAliveForForensics(pid: number): boolean {
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

export function inferUngracefulPreviousExit(args: {
  previous: RuntimeLifecycleState | null;
  currentPid: number;
  isPidAlive?: (pid: number) => boolean;
}): UngracefulInference {
  const previous = args.previous;
  if (!previous) {
    return { shouldReport: false, reason: 'no_previous_state' };
  }
  if (previous.exit) {
    return { shouldReport: false, reason: 'previous_exit_recorded' };
  }
  const previousPid = Number(previous.pid);
  if (!Number.isFinite(previousPid) || previousPid <= 0) {
    return { shouldReport: false, reason: 'invalid_previous_pid' };
  }
  if (Number(previousPid) === Number(args.currentPid)) {
    return { shouldReport: false, reason: 'same_pid_reentry' };
  }

  const isPidAlive = args.isPidAlive ?? isPidAliveForForensics;
  if (isPidAlive(previousPid)) {
    return { shouldReport: false, reason: 'previous_pid_alive' };
  }

  return { shouldReport: true, reason: 'previous_missing_exit_marker_pid_dead' };
}
