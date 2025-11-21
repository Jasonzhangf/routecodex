import path from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import fs from 'fs';
import type { Spinner } from './spinner.js';
import { createSpinner } from './spinner.js';
import { logger } from './logger.js';
import { LOCAL_HOSTS, HTTP_PROTOCOLS, API_PATHS } from '../constants/index.js';

export async function ensurePortAvailable(port: number, parentSpinner: Spinner, opts: { restart?: boolean } = {}): Promise<void> {
  if (!port || Number.isNaN(port)) { return; }
  try {
    const candidates = [LOCAL_HOSTS.IPV4, LOCAL_HOSTS.LOCALHOST];
    for (const h of candidates) {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => { try { controller.abort(); } catch { /* ignore */ } }, 700);
        await fetch(`http://${h}:${port}/shutdown`, { method: 'POST', signal: controller.signal }).catch(() => {});
        clearTimeout(t);
      } catch { /* ignore */ }
    }
    await sleep(300);
  } catch { /* ignore */ }

  const initialPids = findListeningPids(port);
  if (initialPids.length === 0) { return; }

  const healthy = await isServerHealthyQuick(port);
  if (healthy && !opts.restart) {
    parentSpinner.stop();
    logger.success(`RouteCodex is already running on port ${port}.`);
    logger.info(`Use 'rcc stop' or 'rcc start --restart' to restart.`);
    process.exit(0);
  }

  parentSpinner.stop();
  logger.warning(`Port ${port} is in use by PID(s): ${initialPids.join(', ')}`);
  const stopSpinner = await createSpinner(`Port ${port} is in use on 0.0.0.0. Attempting graceful stop...`);
  const gracefulTimeout = Number(process.env.ROUTECODEX_STOP_TIMEOUT_MS ?? 5000);
  const killTimeout = Number(process.env.ROUTECODEX_KILL_TIMEOUT_MS ?? 3000);
  const pollInterval = 150;

  for (const pid of initialPids) {
    try { process.kill(pid, 'SIGTERM'); } catch (error) {
      stopSpinner.warn(`Failed to send SIGTERM to PID ${pid}: ${(error as Error).message}`);
    }
  }

  const gracefulDeadline = Date.now() + gracefulTimeout;
  while (Date.now() < gracefulDeadline) {
    if (findListeningPids(port).length === 0) {
      stopSpinner.succeed(`Port ${port} freed after graceful stop.`);
      logger.success(`Port ${port} freed after graceful stop.`);
      parentSpinner.start('Starting RouteCodex server...');
      return;
    }
    await sleep(pollInterval);
  }

  let remaining = findListeningPids(port);
  if (remaining.length) {
    stopSpinner.warn(`Graceful stop timed out, sending SIGKILL to PID(s): ${remaining.join(', ')}`);
    logger.warning(`Graceful stop timed out. Forcing SIGKILL to PID(s): ${remaining.join(', ')}`);
    for (const pid of remaining) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) {
        const message = (error as Error).message;
        stopSpinner.warn(`Failed to send SIGKILL to PID ${pid}: ${message}`);
        logger.error(`Failed to SIGKILL PID ${pid}: ${message}`);
      }
    }

    const killDeadline = Date.now() + killTimeout;
    while (Date.now() < killDeadline) {
      if (findListeningPids(port).length === 0) {
        stopSpinner.succeed(`Port ${port} freed after SIGKILL.`);
        logger.success(`Port ${port} freed after SIGKILL.`);
        parentSpinner.start('Starting RouteCodex server...');
        return;
      }
      await sleep(pollInterval);
    }
  }

  remaining = findListeningPids(port);
  if (remaining.length) {
    stopSpinner.fail(`Failed to free port ${port}. Still held by PID(s): ${remaining.join(', ')}`);
    logger.error(`Failed to free port ${port}. Still held by PID(s): ${remaining.join(', ')}`);
    throw new Error(`Failed to free port ${port}`);
  }

  stopSpinner.succeed(`Port ${port} freed.`);
  logger.success(`Port ${port} freed.`);
  parentSpinner.start('Starting RouteCodex server...');
}

export async function isServerHealthyQuick(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => { try { controller.abort(); } catch { /* ignore */ } }, 800);
    const res = await fetch(`${HTTP_PROTOCOLS.HTTP}${LOCAL_HOSTS.IPV4}:${port}${API_PATHS.HEALTH}`, { method: 'GET', signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) { return false; }
    const data = await res.json().catch(() => null);
    return !!data && (data.status === 'healthy' || data.status === 'ready');
  } catch {
    return false;
  }
}

export function findListeningPids(port: number): number[] {
  try {
    const result = spawnSync('lsof', ['-tiTCP', `:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    if (result.error) {
      logger.warning(`lsof not available to inspect port usage: ${result.error.message}`);
      return [];
    }
    const stdout = (result.stdout || '').trim();
    if (!stdout) return [];
    return stdout.split(/\s+/).map((v) => parseInt(v, 10)).filter((pid) => !Number.isNaN(pid));
  } catch (error) {
    logger.warning(`Failed to inspect port ${port}: ${(error as Error).message}`);
    return [];
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function setupKeypress(onInterrupt: () => void): () => void {
  try {
    const stdin = process.stdin as unknown as {
      isTTY?: boolean;
      setRawMode?: (v: boolean) => void;
      resume?: () => void;
      pause?: () => void;
      on?: (ev: string, cb: (data: Buffer) => void) => void;
      off?: (ev: string, cb: (data: Buffer) => void) => void;
    };
    if (stdin && stdin.isTTY) {
      const onData = (data: Buffer) => {
        const s = data.toString('utf8');
        if (s === '\u0003') { try { onInterrupt(); } catch { /* ignore */ } return; }
        if (s === 'q' || s === 'Q') { try { onInterrupt(); } catch { /* ignore */ } return; }
      };
      stdin.setRawMode?.(true);
      stdin.resume?.();
      stdin.on?.('data', onData);
      return () => {
        try { stdin.off?.('data', onData); } catch { /* ignore */ }
        try { stdin.setRawMode?.(false); } catch { /* ignore */ }
        try { stdin.pause?.(); } catch { /* ignore */ }
      };
    }
  } catch { /* ignore */ }
  return () => {};
}

export async function runServerChild(params: {
  configPath: string;
  resolvedPort: number;
  config: any;
  isDevPackage: boolean;
}): Promise<void> {
  const { configPath, resolvedPort, config, isDevPackage } = params;
  const nodeBin = process.execPath;
  const thisDir = path.dirname(new URL(import.meta.url).pathname);
  const serverEntry = path.resolve(thisDir, '../index.js');
  const { spawn } = await import('child_process');

  const env = { ...process.env } as NodeJS.ProcessEnv;
  env.ROUTECODEX_CONFIG = configPath;
  if (isDevPackage) env.ROUTECODEX_PORT = String(resolvedPort);
  // Prefer workspace config/modules.json to avoid depending on packaged dist/config
  const candidate1 = path.join(process.cwd(), 'config', 'modules.json');
  const candidate2 = path.join(homedir(), '.routecodex', 'config', 'modules.json');
  const candidate3 = path.resolve(thisDir, '../config/modules.json');
  const chosen = [candidate1, candidate2, candidate3].find(p => {
    try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; }
  });
  if (chosen) env.ROUTECODEX_MODULES_CONFIG = chosen;
  const args: string[] = [serverEntry];

  const childProc = spawn(nodeBin, args, { stdio: 'inherit', env });
  try {
    const pidFile = path.join(homedir(), '.routecodex', 'server.cli.pid');
    fsSafeWrite(pidFile, String(childProc.pid ?? ''));
  } catch { /* ignore */ }

  const host = (config?.httpserver?.host || config?.server?.host || config?.host || LOCAL_HOSTS.LOCALHOST);
  logger.info(`Configuration loaded from: ${configPath}`);
  logger.info(`Server will run on port: ${resolvedPort}`);
  logger.success(`RouteCodex server starting on ${host}:${resolvedPort}`);
  logger.info('Press Ctrl+C to stop the server');

  const shutdown = async (sig: NodeJS.Signals) => {
    try { await fetch(`${HTTP_PROTOCOLS.HTTP}${LOCAL_HOSTS.IPV4}:${resolvedPort}${API_PATHS.SHUTDOWN}`, { method: 'POST' }).catch(() => {}); } catch {}
    try { childProc.kill(sig); } catch {}
    try { if (childProc.pid) { process.kill(-childProc.pid, sig); } } catch {}
    const deadline = Date.now() + 3500;
    while (Date.now() < deadline) {
      if (findListeningPids(resolvedPort).length === 0) break;
      await sleep(120);
    }
    const remain = findListeningPids(resolvedPort);
    if (remain.length) {
      for (const pid of remain) { try { process.kill(pid, 'SIGTERM'); } catch {} }
      const killDeadline = Date.now() + 1500;
      while (Date.now() < killDeadline) {
        if (findListeningPids(resolvedPort).length === 0) break;
        await sleep(100);
      }
    }
    const still = findListeningPids(resolvedPort);
    if (still.length) {
      for (const pid of still) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
    try { process.exit(0); } catch {}
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

  const cleanupKeypress = setupKeypress(() => { void shutdown('SIGINT'); });
  childProc.on('exit', (code, signal) => {
    try { cleanupKeypress(); } catch {}
    if (signal) process.exit(0); else process.exit(code ?? 0);
  });

  // 永不返回，保持父进程存活
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  await new Promise(() => {});
}

function fsSafeWrite(p: string, content: string) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  } catch { /* ignore */ }
}
