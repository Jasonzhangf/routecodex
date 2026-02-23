import fs from 'node:fs';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { resolveGuardianPaths } from './paths.js';
import type { GuardianLifecycleEvent, GuardianRegistration, GuardianState, GuardianStopResult } from './types.js';

type FsLike = Pick<typeof fs, 'existsSync' | 'readFileSync' | 'writeFileSync' | 'mkdirSync' | 'openSync' | 'closeSync' | 'unlinkSync'>;

type SpawnLike = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

type EnsureGuardianArgs = {
  homeDir: string;
  nodeBin: string;
  cliEntryPath: string;
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  spawn: SpawnLike;
  sleep: (ms: number) => Promise<void>;
  fsImpl?: FsLike;
};

type RegisterGuardianArgs = {
  homeDir: string;
  fetchImpl: typeof fetch;
  registration: GuardianRegistration;
  fsImpl?: FsLike;
};

type StopGuardianArgs = {
  homeDir: string;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  fsImpl?: FsLike;
};

type ReportGuardianLifecycleArgs = {
  homeDir: string;
  fetchImpl: typeof fetch;
  event: GuardianLifecycleEvent;
  fsImpl?: FsLike;
};

const GUARDIAN_HEALTH_TIMEOUT_MS = 12000;
const GUARDIAN_POLL_INTERVAL_MS = 150;

function parseGuardianState(input: unknown): GuardianState | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const rec = input as Record<string, unknown>;
  const pid = Number(rec.pid);
  const port = Number(rec.port);
  const token = typeof rec.token === 'string' ? rec.token.trim() : '';
  const stopToken = typeof rec.stopToken === 'string' ? rec.stopToken.trim() : '';
  const startedAt = typeof rec.startedAt === 'string' ? rec.startedAt.trim() : '';
  const updatedAt = typeof rec.updatedAt === 'string' ? rec.updatedAt.trim() : '';
  if (!Number.isFinite(pid) || pid <= 1) {
    return null;
  }
  if (!Number.isFinite(port) || port <= 0) {
    return null;
  }
  if (!token || !stopToken || !startedAt || !updatedAt) {
    return null;
  }
  return {
    pid: Math.floor(pid),
    port: Math.floor(port),
    token,
    stopToken,
    startedAt,
    updatedAt
  };
}

function readGuardianState(fsImpl: FsLike, homeDir: string): GuardianState | null {
  const paths = resolveGuardianPaths(homeDir);
  try {
    if (!fsImpl.existsSync(paths.stateFile)) {
      return null;
    }
    const raw = fsImpl.readFileSync(paths.stateFile, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return parseGuardianState(parsed);
  } catch {
    return null;
  }
}

async function isGuardianHealthy(fetchImpl: typeof fetch, state: GuardianState): Promise<boolean> {
  const baseUrl = `http://127.0.0.1:${state.port}`;
  try {
    const response = await fetchImpl(`${baseUrl}/health`, {
      method: 'GET',
      headers: {
        'x-rcc-guardian-token': state.token
      }
    });
    if (!response.ok) {
      return false;
    }
    const body = await response.json().catch(() => null);
    return body?.ok === true;
  } catch {
    return false;
  }
}

async function waitForHealthyGuardian(args: {
  homeDir: string;
  fetchImpl: typeof fetch;
  fsImpl: FsLike;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
}): Promise<GuardianState | null> {
  const deadline = Date.now() + Math.max(0, args.timeoutMs);
  while (Date.now() <= deadline) {
    const state = readGuardianState(args.fsImpl, args.homeDir);
    if (state) {
      const healthy = await isGuardianHealthy(args.fetchImpl, state);
      if (healthy) {
        return state;
      }
    }
    await args.sleep(GUARDIAN_POLL_INTERVAL_MS);
  }
  return null;
}

function acquireSpawnLock(fsImpl: FsLike, lockFile: string): number | null {
  try {
    return fsImpl.openSync(lockFile, 'wx');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'EEXIST') {
      return null;
    }
    throw error;
  }
}

function spawnGuardianProcess(args: {
  nodeBin: string;
  cliEntryPath: string;
  env: NodeJS.ProcessEnv;
  spawn: SpawnLike;
  stateFile: string;
  logFile: string;
}): void {
  const child = args.spawn(
    args.nodeBin,
    [args.cliEntryPath, '__guardian-daemon', '--state-file', args.stateFile, '--log-file', args.logFile],
    {
      stdio: 'ignore',
      detached: true,
      env: {
        ...args.env,
        ROUTECODEX_GUARDIAN_BOOTSTRAP: '1',
        RCC_GUARDIAN_BOOTSTRAP: '1'
      }
    }
  );
  child.unref?.();
}

export async function ensureGuardianDaemon(args: EnsureGuardianArgs): Promise<GuardianState> {
  const fsImpl = args.fsImpl ?? fs;
  const paths = resolveGuardianPaths(args.homeDir);

  try {
    fsImpl.mkdirSync(paths.rootDir, { recursive: true });
  } catch {
    // follow-up operations will throw useful errors if directory is unusable
  }

  const existingState = readGuardianState(fsImpl, args.homeDir);
  if (existingState && await isGuardianHealthy(args.fetchImpl, existingState)) {
    return existingState;
  }

  const lockFd = acquireSpawnLock(fsImpl, paths.lockFile);
  if (lockFd === null) {
    const waited = await waitForHealthyGuardian({
      homeDir: args.homeDir,
      fetchImpl: args.fetchImpl,
      fsImpl,
      sleep: args.sleep,
      timeoutMs: GUARDIAN_HEALTH_TIMEOUT_MS
    });
    if (waited) {
      return waited;
    }
    throw new Error('guardian daemon lock is busy and no healthy daemon became available');
  }

  try {
    spawnGuardianProcess({
      nodeBin: args.nodeBin,
      cliEntryPath: args.cliEntryPath,
      env: args.env,
      spawn: args.spawn,
      stateFile: paths.stateFile,
      logFile: paths.logFile
    });
  } finally {
    try {
      fsImpl.closeSync(lockFd);
    } catch {
      // ignore
    }
    try {
      fsImpl.unlinkSync(paths.lockFile);
    } catch {
      // ignore
    }
  }

  const started = await waitForHealthyGuardian({
    homeDir: args.homeDir,
    fetchImpl: args.fetchImpl,
    fsImpl,
    sleep: args.sleep,
    timeoutMs: GUARDIAN_HEALTH_TIMEOUT_MS
  });
  if (!started) {
    throw new Error('guardian daemon did not become healthy in time');
  }
  return started;
}

export async function registerGuardianProcess(args: RegisterGuardianArgs): Promise<void> {
  const fsImpl = args.fsImpl ?? fs;
  const state = readGuardianState(fsImpl, args.homeDir);
  if (!state) {
    throw new Error('guardian state is unavailable; ensure daemon before register');
  }

  const response = await args.fetchImpl(`http://127.0.0.1:${state.port}/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-rcc-guardian-token': state.token
    },
    body: JSON.stringify(args.registration)
  }).catch(() => null);

  if (!response?.ok) {
    const status = response?.status ?? 'n/a';
    throw new Error(`guardian register failed (status=${status})`);
  }
}

export async function stopGuardianDaemon(args: StopGuardianArgs): Promise<GuardianStopResult> {
  const fsImpl = args.fsImpl ?? fs;
  const state = readGuardianState(fsImpl, args.homeDir);
  if (!state) {
    return { requested: false, stopped: false, reason: 'no_state' };
  }

  const response = await args.fetchImpl(`http://127.0.0.1:${state.port}/stop`, {
    method: 'POST',
    headers: {
      'x-rcc-guardian-token': state.token,
      'x-rcc-guardian-stop-token': state.stopToken
    }
  }).catch(() => null);

  if (!response?.ok) {
    return {
      requested: false,
      stopped: false,
      reason: `stop_request_failed_status_${response?.status ?? 'n/a'}`
    };
  }

  const deadline = Date.now() + 5000;
  while (Date.now() <= deadline) {
    const next = readGuardianState(fsImpl, args.homeDir);
    if (!next) {
      return { requested: true, stopped: true, reason: 'state_removed' };
    }
    const healthy = await isGuardianHealthy(args.fetchImpl, next);
    if (!healthy) {
      return { requested: true, stopped: true, reason: 'health_down' };
    }
    await args.sleep(120);
  }

  return { requested: true, stopped: false, reason: 'timeout' };
}

export async function reportGuardianLifecycleEvent(args: ReportGuardianLifecycleArgs): Promise<boolean> {
  const fsImpl = args.fsImpl ?? fs;
  const state = readGuardianState(fsImpl, args.homeDir);
  if (!state) {
    return false;
  }
  const response = await args.fetchImpl(`http://127.0.0.1:${state.port}/lifecycle`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-rcc-guardian-token': state.token
    },
    body: JSON.stringify(args.event)
  }).catch(() => null);
  return Boolean(response?.ok);
}
