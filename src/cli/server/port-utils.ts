import { spawnSync as nodeSpawnSync } from 'node:child_process';

import { API_PATHS, HTTP_PROTOCOLS, LOCAL_HOSTS } from '../../constants/index.js';

export type PortUtilsSpinner = {
  start(text?: string): PortUtilsSpinner;
  succeed(text?: string): void;
  fail(text?: string): void;
  warn(text?: string): void;
  info(text?: string): void;
  stop(): void;
  text: string;
};

export type PortUtilsLogger = {
  info: (msg: string) => void;
  success: (msg: string) => void;
  warning: (msg: string) => void;
  error: (msg: string) => void;
};

export function killPidBestEffortImpl(args: {
  pid: number;
  force: boolean;
  isWindows: boolean;
  spawnSyncImpl?: typeof nodeSpawnSync;
  processKill?: typeof process.kill;
}): void {
  const { pid, force, isWindows } = args;
  const spawnSyncImpl = args.spawnSyncImpl ?? nodeSpawnSync;
  const processKill = args.processKill ?? process.kill.bind(process);

  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }
  if (isWindows) {
    const taskkillArgs = ['/PID', String(pid), '/T'];
    if (force) {
      taskkillArgs.push('/F');
    }
    try {
      spawnSyncImpl('taskkill', taskkillArgs, { stdio: 'ignore', encoding: 'utf8' });
    } catch {
      // best-effort
    }
    return;
  }
  try {
    processKill(pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    // best-effort
  }
}

export function findListeningPidsImpl(args: {
  port: number;
  isWindows: boolean;
  spawnSyncImpl?: typeof nodeSpawnSync;
  logger: PortUtilsLogger;
  parseNetstatListeningPids: (stdout: string, port: number) => number[];
}): number[] {
  const { port, isWindows, logger, parseNetstatListeningPids } = args;
  const spawnSyncImpl = args.spawnSyncImpl ?? nodeSpawnSync;

  try {
    if (isWindows) {
      const result = spawnSyncImpl('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
      if (result.error) {
        logger.warning(`netstat not available to inspect port usage: ${result.error.message}`);
        return [];
      }
      return parseNetstatListeningPids(result.stdout || '', port);
    }

    // macOS/BSD lsof expects either "-i TCP:port" or "-tiTCP:port" as a single argument.
    // Use the compact form to avoid treating ":port" as a filename.
    const result = spawnSyncImpl('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    if (result.error) {
      logger.warning(`lsof not available to inspect port usage: ${result.error.message}`);
      return [];
    }

    const out = String(result.stdout || '').trim();
    if (!out) {
      return [];
    }
    return out
      .split(/\s+/g)
      .map((s) => Number(String(s).trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

export async function isServerHealthyQuickImpl(args: { port: number; fetchImpl: typeof fetch }): Promise<boolean> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    }, 800);
    const res = await args.fetchImpl(`${HTTP_PROTOCOLS.HTTP}${LOCAL_HOSTS.IPV4}:${args.port}${API_PATHS.HEALTH}`, {
      method: 'GET',
      signal: controller.signal
    });
    clearTimeout(t);
    if (!res.ok) {
      return false;
    }
    const data = await res.json().catch(() => null);
    return !!data && (data.status === 'healthy' || data.status === 'ready');
  } catch {
    return false;
  }
}

export async function ensurePortAvailableImpl(args: {
  port: number;
  parentSpinner: PortUtilsSpinner;
  opts?: { restart?: boolean };
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  env: NodeJS.ProcessEnv;
  logger: PortUtilsLogger;
  createSpinner: (text: string) => Promise<PortUtilsSpinner>;
  findListeningPids: (port: number) => number[];
  killPidBestEffort: (pid: number, opts: { force: boolean }) => void;
  isServerHealthyQuick: (port: number) => Promise<boolean>;
  exit: (code: number) => never;
}): Promise<void> {
  const { port, parentSpinner } = args;
  const opts = args.opts ?? {};

  if (!port || Number.isNaN(port)) {
    return;
  }

  // Best-effort HTTP shutdown on common loopback hosts to cover IPv4/IPv6
  try {
    const candidates = [LOCAL_HOSTS.IPV4, LOCAL_HOSTS.LOCALHOST];
    for (const h of candidates) {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => {
          try {
            controller.abort();
          } catch {
            /* ignore */
          }
        }, 700);
        await args.fetchImpl(`http://${h}:${port}/shutdown`, {
          method: 'POST',
          signal: controller.signal
        }).catch(() => {});
        clearTimeout(t);
      } catch {
        /* ignore */
      }
    }
    await args.sleep(300);
  } catch {
    /* ignore */
  }

  const initialPids = args.findListeningPids(port);
  if (initialPids.length === 0) {
    return;
  }

  const healthy = await args.isServerHealthyQuick(port);
  if (healthy && !opts.restart) {
    parentSpinner.stop();
    args.logger.success(`RouteCodex is already running on port ${port}.`);
    args.logger.info(`Use 'rcc stop' or 'rcc start --restart' to restart.`);
    args.exit(0);
  }

  parentSpinner.stop();
  args.logger.warning(`Port ${port} is in use by PID(s): ${initialPids.join(', ')}`);
  const stopSpinner = await args.createSpinner(`Port ${port} is in use on 0.0.0.0. Attempting graceful stop...`);
  const gracefulTimeout = Number(args.env.ROUTECODEX_STOP_TIMEOUT_MS ?? 5000);
  const killTimeout = Number(args.env.ROUTECODEX_KILL_TIMEOUT_MS ?? 3000);
  const pollInterval = 150;

  for (const pid of initialPids) {
    try {
      args.killPidBestEffort(pid, { force: false });
    } catch (error) {
      stopSpinner.warn(`Failed to send SIGTERM to PID ${pid}: ${(error as Error).message}`);
    }
  }

  const gracefulDeadline = Date.now() + gracefulTimeout;
  while (Date.now() < gracefulDeadline) {
    if (args.findListeningPids(port).length === 0) {
      stopSpinner.succeed(`Port ${port} freed after graceful stop.`);
      args.logger.success(`Port ${port} freed after graceful stop.`);
      parentSpinner.start('Starting RouteCodex server...');
      return;
    }
    await args.sleep(pollInterval);
  }

  let remaining = args.findListeningPids(port);
  if (remaining.length) {
    stopSpinner.warn(`Graceful stop timed out, sending SIGKILL to PID(s): ${remaining.join(', ')}`);
    args.logger.warning(`Graceful stop timed out. Forcing SIGKILL to PID(s): ${remaining.join(', ')}`);
    for (const pid of remaining) {
      try {
        args.killPidBestEffort(pid, { force: true });
      } catch (error) {
        const message = (error as Error).message;
        stopSpinner.warn(`Failed to send SIGKILL to PID ${pid}: ${message}`);
        args.logger.error(`Failed to SIGKILL PID ${pid}: ${message}`);
      }
    }

    const killDeadline = Date.now() + killTimeout;
    while (Date.now() < killDeadline) {
      if (args.findListeningPids(port).length === 0) {
        stopSpinner.succeed(`Port ${port} freed after SIGKILL.`);
        args.logger.success(`Port ${port} freed after SIGKILL.`);
        parentSpinner.start('Starting RouteCodex server...');
        return;
      }
      await args.sleep(pollInterval);
    }
  }

  remaining = args.findListeningPids(port);
  if (remaining.length) {
    stopSpinner.fail(`Failed to free port ${port}. Still held by PID(s): ${remaining.join(', ')}`);
    args.logger.error(`Failed to free port ${port}. Still held by PID(s): ${remaining.join(', ')}`);
    throw new Error(`Failed to free port ${port}`);
  }

  stopSpinner.succeed(`Port ${port} freed.`);
  args.logger.success(`Port ${port} freed.`);
  parentSpinner.start('Starting RouteCodex server...');
}

