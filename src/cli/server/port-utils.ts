import { spawnSync as nodeSpawnSync } from 'node:child_process';
import net from 'node:net';

import { API_PATHS, HTTP_PROTOCOLS, LOCAL_HOSTS } from '../../constants/index.js';
import { logProcessLifecycle } from '../../utils/process-lifecycle-logger.js';
import { listManagedServerPidsByPort } from '../../utils/managed-server-pids.js';

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

  if (pid === process.pid) {
    logProcessLifecycle({
      event: 'self_termination',
      source: 'cli.port-utils',
      details: {
        result: 'blocked',
        reason: 'self_kill_guard',
        signal: force ? 'SIGKILL' : 'SIGTERM',
        targetPid: pid
      }
    });
    return;
  }

  if (isWindows) {
    const taskkillArgs = ['/PID', String(pid), '/T'];
    if (force) {
      taskkillArgs.push('/F');
    }
    logProcessLifecycle({
      event: 'kill_attempt',
      source: 'cli.port-utils',
      details: { targetPid: pid, signal: force ? 'TASKKILL_F' : 'TASKKILL', result: 'attempt' }
    });
    try {
      spawnSyncImpl('taskkill', taskkillArgs, { stdio: 'ignore', encoding: 'utf8' });
      logProcessLifecycle({
        event: 'kill_attempt',
        source: 'cli.port-utils',
        details: { targetPid: pid, signal: force ? 'TASKKILL_F' : 'TASKKILL', result: 'success' }
      });
    } catch (error) {
      logProcessLifecycle({
        event: 'kill_attempt',
        source: 'cli.port-utils',
        details: { targetPid: pid, signal: force ? 'TASKKILL_F' : 'TASKKILL', result: 'failed', error }
      });
    }
    return;
  }

  const signal = force ? 'SIGKILL' : 'SIGTERM';
  logProcessLifecycle({
    event: 'kill_attempt',
    source: 'cli.port-utils',
    details: { targetPid: pid, signal, result: 'attempt' }
  });
  try {
    processKill(pid, signal);
    logProcessLifecycle({
      event: 'kill_attempt',
      source: 'cli.port-utils',
      details: { targetPid: pid, signal, result: 'success' }
    });
  } catch (error) {
    logProcessLifecycle({
      event: 'kill_attempt',
      source: 'cli.port-utils',
      details: { targetPid: pid, signal, result: 'failed', error }
    });
  }
}

export function findListeningPidsImpl(args: {
  port: number;
  isWindows?: boolean;
  routeCodexHomeDir?: string;
  processKill?: typeof process.kill;
  spawnSyncImpl?: typeof nodeSpawnSync;
  logger: PortUtilsLogger;
}): number[] {
  const { port } = args;
  const spawnSyncImpl = args.spawnSyncImpl ?? nodeSpawnSync;
  const processKill = args.processKill ?? process.kill.bind(process);

  try {
    return listManagedServerPidsByPort(port, {
      routeCodexHomeDir: args.routeCodexHomeDir,
      processKill,
      spawnSyncImpl
    });
  } catch {
    args.logger.warning(`Failed to resolve managed pid for port ${port}`);
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
    const status = typeof data?.status === 'string' ? data.status.toLowerCase() : '';
    return !!data && (status === 'healthy' || status === 'ready' || status === 'ok' || data?.ready === true || data?.pipelineReady === true);
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
  const buildRestartOnly = (() => {
    const raw = String(args.env.ROUTECODEX_BUILD_RESTART_ONLY ?? args.env.RCC_BUILD_RESTART_ONLY ?? '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
  })();

  if (!port || Number.isNaN(port)) {
    return;
  }

  logProcessLifecycle({
    event: 'port_check_start',
    source: 'cli.ensurePortAvailable',
    details: { port, restart: Boolean(opts.restart) }
  });

  const canBindPort = async (): Promise<boolean> => {
    return await new Promise<boolean>((resolve) => {
      try {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.listen({ host: '0.0.0.0', port }, () => {
          server.close(() => resolve(true));
        });
      } catch {
        resolve(false);
      }
    });
  };

  // Best-effort HTTP shutdown on common loopback hosts to cover IPv4/IPv6.
  // This is restart-only behavior; plain `rcc start` must not disrupt existing servers.
  // In build-restart-only mode, never send shutdown requests.
  if (opts.restart && !buildRestartOnly) {
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
          const callerTs = new Date().toISOString();
          logProcessLifecycle({
            event: 'port_http_shutdown',
            source: 'cli.ensurePortAvailable',
            details: {
              result: 'attempt',
              host: h,
              port,
              callerTs,
              callerPid: process.pid,
              callerCwd: process.cwd(),
              callerCmd: process.argv.join(' ').slice(0, 1024)
            }
          });
          await args.fetchImpl(`http://${h}:${port}/shutdown`, {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'x-routecodex-stop-caller-pid': String(process.pid),
              'x-routecodex-stop-caller-ts': callerTs,
              'x-routecodex-stop-caller-cwd': process.cwd(),
              'x-routecodex-stop-caller-cmd': process.argv.join(' ').slice(0, 1024)
            }
          }).catch((error) => {
            logProcessLifecycle({
              event: 'port_http_shutdown',
              source: 'cli.ensurePortAvailable',
              details: {
                result: 'failed',
                host: h,
                port,
                error
              }
            });
          });
          clearTimeout(t);
        } catch {
          /* ignore */
        }
      }
      await args.sleep(300);
    } catch {
      /* ignore */
    }
  }

  if (await canBindPort()) {
    logProcessLifecycle({
      event: 'port_check_result',
      source: 'cli.ensurePortAvailable',
      details: { port, result: 'free' }
    });
    return;
  }

  const initialPids = args.findListeningPids(port);
  if (initialPids.length === 0) {
    const healthyWithoutPid = await args.isServerHealthyQuick(port);
    if (healthyWithoutPid && opts.restart && buildRestartOnly) {
      logProcessLifecycle({
        event: 'port_check_result',
        source: 'cli.ensurePortAvailable',
        details: { port, result: 'restart_only_existing_unmanaged' }
      });
      parentSpinner.stop();
      args.logger.success(`RouteCodex is already running on port ${port}.`);
      args.logger.info(`Build restart-only mode: reusing existing server without shutdown.`);
      args.exit(0);
    }
    if (healthyWithoutPid && !opts.restart) {
      logProcessLifecycle({
        event: 'port_check_result',
        source: 'cli.ensurePortAvailable',
        details: { port, result: 'already_running_unmanaged' }
      });
    parentSpinner.stop();
    args.logger.success(`RouteCodex is already running on port ${port}.`);
    args.logger.info(`Use 'rcc stop' for graceful shutdown.`);
    args.exit(0);
  }
    logProcessLifecycle({
      event: 'port_check_result',
      source: 'cli.ensurePortAvailable',
      details: { port, result: 'occupied_unmanaged' }
    });
    throw new Error(
      `Port ${port} is occupied by an unmanaged process. Refusing blind kill; stop it manually or use /shutdown if it is RouteCodex.`
    );
  }

  logProcessLifecycle({
    event: 'port_check_result',
    source: 'cli.ensurePortAvailable',
    details: { port, result: 'occupied', pids: initialPids }
  });

  if (opts.restart && buildRestartOnly) {
    parentSpinner.stop();
    args.logger.info(`Build restart-only mode: sending in-place restart to managed PID(s): ${initialPids.join(', ')}`);
    let signaled = 0;
    for (const pid of initialPids) {
      try {
        logProcessLifecycle({
          event: 'port_restart_signal',
          source: 'cli.ensurePortAvailable',
          details: { port, pid, signal: 'SIGUSR2', result: 'attempt' }
        });
        process.kill(pid, 'SIGUSR2');
        signaled += 1;
        logProcessLifecycle({
          event: 'port_restart_signal',
          source: 'cli.ensurePortAvailable',
          details: { port, pid, signal: 'SIGUSR2', result: 'success' }
        });
      } catch (error) {
        logProcessLifecycle({
          event: 'port_restart_signal',
          source: 'cli.ensurePortAvailable',
          details: { port, pid, signal: 'SIGUSR2', result: 'failed', error }
        });
      }
    }
    if (signaled <= 0) {
      throw new Error(`Build restart-only mode failed: unable to signal SIGUSR2 to managed PID(s) on port ${port}`);
    }
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await args.isServerHealthyQuick(port)) {
        args.logger.success(`Build restart-only mode: RouteCodex restarted in place on port ${port}.`);
        args.exit(0);
      }
      await args.sleep(150);
    }
    throw new Error(`Build restart-only mode timed out waiting for restarted server on port ${port}`);
  }

  const healthy = await args.isServerHealthyQuick(port);
  if (healthy && !opts.restart) {
    logProcessLifecycle({
      event: 'port_check_result',
      source: 'cli.ensurePortAvailable',
      details: { port, result: 'already_running', pids: initialPids }
    });
    parentSpinner.stop();
    args.logger.success(`RouteCodex is already running on port ${port}.`);
    args.logger.info(`Use 'rcc stop' or 'rcc start --restart' to restart.`);
    args.exit(0);
  }

  if (!opts.restart) {
    logProcessLifecycle({
      event: 'port_check_result',
      source: 'cli.ensurePortAvailable',
      details: { port, result: 'occupied_no_restart', pids: initialPids, healthy }
    });
    throw new Error(
      `Port ${port} is occupied by RouteCodex process(es). Use 'rcc stop' or 'rcc start --restart' to take over.`
    );
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
      logProcessLifecycle({
        event: 'port_check_result',
        source: 'cli.ensurePortAvailable',
        details: { port, result: 'freed_after_graceful' }
      });
      stopSpinner.succeed(`Port ${port} freed after graceful stop.`);
      args.logger.success(`Port ${port} freed after graceful stop.`);
      parentSpinner.start('Starting RouteCodex server...');
      return;
    }
    await args.sleep(pollInterval);
  }

  let remaining = args.findListeningPids(port);
  if (remaining.length) {
    logProcessLifecycle({
      event: 'port_check_result',
      source: 'cli.ensurePortAvailable',
      details: { port, result: 'graceful_timeout', pids: remaining }
    });
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
        logProcessLifecycle({
          event: 'port_check_result',
          source: 'cli.ensurePortAvailable',
          details: { port, result: 'freed_after_force' }
        });
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
    logProcessLifecycle({
      event: 'port_check_result',
      source: 'cli.ensurePortAvailable',
      details: { port, result: 'failed', pids: remaining }
    });
    stopSpinner.fail(`Failed to free port ${port}. Still held by PID(s): ${remaining.join(', ')}`);
    args.logger.error(`Failed to free port ${port}. Still held by PID(s): ${remaining.join(', ')}`);
    throw new Error(`Failed to free port ${port}`);
  }

  logProcessLifecycle({
    event: 'port_check_result',
    source: 'cli.ensurePortAvailable',
    details: { port, result: 'freed' }
  });
  stopSpinner.succeed(`Port ${port} freed.`);
  args.logger.success(`Port ${port} freed.`);
  parentSpinner.start('Starting RouteCodex server...');
}
