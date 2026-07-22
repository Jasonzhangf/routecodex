import { spawnSync as nodeSpawnSync } from 'node:child_process';
import net from 'node:net';

import { API_PATHS, HTTP_PROTOCOLS, LOCAL_HOSTS } from '../../constants/index.js';
import { logProcessLifecycle } from '../../utils/process-lifecycle-logger.js';
import { probeRouteCodexHealth, type RouteCodexHealthProbeResult } from '../../utils/http-health-probe.js';
import { listListeningPortsByPid, listManagedServerPidsByPort } from '../../utils/managed-server-pids.js';
import { formatUnknownError, isRecord } from '../../utils/common-utils.js';
import { buildShutdownCallerHeaders } from '../../utils/shutdown-caller-headers.js';

// feature_id: runtime.lifecycle.port_scoped_start_stop

function logPortUtilsNonBlockingError(
  stage: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  try {
    const suffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(`[port-utils] ${stage} failed (non-blocking): ${formatUnknownError(error)}${suffix}`);
  } catch {
    void 0;
  }
}

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

export function findListeningPortsByPidImpl(args: {
  pid: number;
  logger: PortUtilsLogger;
  spawnSyncImpl?: typeof nodeSpawnSync;
}): number[] {
  try {
    return listListeningPortsByPid(args.pid, {
      spawnSyncImpl: args.spawnSyncImpl
    });
  } catch {
    args.logger.warning(`Failed to resolve managed ports for pid ${args.pid}`);
    return [];
  }
}

export async function probeServerHealthQuickImpl(args: {
  port: number;
  fetchImpl: typeof fetch;
}): Promise<RouteCodexHealthProbeResult> {
  return probeRouteCodexHealth({
    fetchImpl: args.fetchImpl,
    host: LOCAL_HOSTS.IPV4,
    port: args.port,
    timeoutMs: 800
  });
}

export async function isServerHealthyQuickImpl(args: { port: number; fetchImpl: typeof fetch }): Promise<boolean> {
  const probe = await probeServerHealthQuickImpl(args);
  return probe.ok;
}

export async function ensurePortAvailableImpl(args: {
  port: number;
  parentSpinner: PortUtilsSpinner;
  opts?: { restart?: boolean; targetPorts?: number[] };
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  env: NodeJS.ProcessEnv;
  logger: PortUtilsLogger;
  createSpinner: (text: string) => Promise<PortUtilsSpinner>;
  findListeningPids: (port: number) => number[];
  findListeningPortsByPid?: (pid: number) => number[];
  killPidBestEffort: (pid: number, opts: { force: boolean }) => void;
  isServerHealthyQuick: (port: number) => Promise<boolean>;
  exit: (code: number) => never;
}): Promise<void> {
  const { port, parentSpinner } = args;
  const opts = args.opts ?? {};
  const targetPorts = Array.from(
    new Set(
      ((Array.isArray(opts.targetPorts) && opts.targetPorts.length > 0 ? opts.targetPorts : [port])
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item) && item > 0))
    )
  );
  const targetPortSet = new Set(targetPorts);
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

  const waitForPortFree = async (timeoutMs: number, pollIntervalMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await canBindPort()) {
        return true;
      }
      await args.sleep(pollIntervalMs);
    }
    return await canBindPort();
  };

  const attemptConfirmedPortScopedShutdown = async (): Promise<boolean> => {
    let accepted = false;
    try {
      const candidates = [LOCAL_HOSTS.IPV4, LOCAL_HOSTS.LOCALHOST];
      for (const h of candidates) {
        try {
          const controller = new AbortController();
          const t = setTimeout(() => {
            try {
              controller.abort();
            } catch (abortError) {
              logPortUtilsNonBlockingError('ensurePortAvailableImpl.portScopedShutdown.abortController', abortError, {
                host: h,
                port
              });
            }
          }, 700);
          const callerHeaders = buildShutdownCallerHeaders();
          logProcessLifecycle({
            event: 'port_scoped_shutdown',
            source: 'cli.ensurePortAvailable',
            details: {
              result: 'attempt',
              host: h,
              port,
              callerTs: callerHeaders['x-routecodex-stop-caller-ts'],
              callerPid: callerHeaders['x-routecodex-stop-caller-pid'],
              callerCwd: callerHeaders['x-routecodex-stop-caller-cwd'],
              callerCmd: callerHeaders['x-routecodex-stop-caller-cmd']
            }
          });
          await args.fetchImpl(`http://${h}:${port}/_routecodex/admin/ports/${port}/stop`, {
            method: 'POST',
            signal: controller.signal,
            headers: callerHeaders
          }).then((response) => {
            accepted = accepted || Boolean((response as { ok?: boolean })?.ok);
          }).catch((error) => {
            logProcessLifecycle({
              event: 'port_scoped_shutdown',
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
        } catch (shutdownHostError) {
          logPortUtilsNonBlockingError('ensurePortAvailableImpl.portScopedShutdownHost', shutdownHostError, {
            host: h,
            port
          });
        }
      }
    } catch (shutdownError) {
      logPortUtilsNonBlockingError('ensurePortAvailableImpl.portScopedShutdown', shutdownError, {
        port
      });
    }
    return accepted;
  };

  const attemptConfirmedHttpShutdown = async (): Promise<boolean> => {
    let accepted = false;
    try {
      const candidates = [LOCAL_HOSTS.IPV4, LOCAL_HOSTS.LOCALHOST];
      for (const h of candidates) {
        try {
          const controller = new AbortController();
          const t = setTimeout(() => {
            try {
              controller.abort();
            } catch (abortError) {
              logPortUtilsNonBlockingError('ensurePortAvailableImpl.abortController', abortError, {
                host: h,
                port
              });
            }
          }, 700);
          const callerHeaders = buildShutdownCallerHeaders();
          logProcessLifecycle({
            event: 'port_http_shutdown',
            source: 'cli.ensurePortAvailable',
            details: {
              result: 'attempt',
              host: h,
              port,
              callerTs: callerHeaders['x-routecodex-stop-caller-ts'],
              callerPid: callerHeaders['x-routecodex-stop-caller-pid'],
              callerCwd: callerHeaders['x-routecodex-stop-caller-cwd'],
              callerCmd: callerHeaders['x-routecodex-stop-caller-cmd']
            }
          });
          await args.fetchImpl(`http://${h}:${port}/shutdown`, {
            method: 'POST',
            signal: controller.signal,
            headers: callerHeaders
          }).then((response) => {
            accepted = accepted || Boolean((response as { ok?: boolean })?.ok);
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
        } catch (shutdownHostError) {
          logPortUtilsNonBlockingError('ensurePortAvailableImpl.shutdownHost', shutdownHostError, {
            host: h,
            port
          });
        }
      }
    } catch (shutdownError) {
      logPortUtilsNonBlockingError('ensurePortAvailableImpl.gracefulHttpShutdown', shutdownError, {
        port
      });
    }
    return accepted;
  };

  if (await canBindPort()) {
    logProcessLifecycle({
      event: 'port_check_result',
      source: 'cli.ensurePortAvailable',
      details: { port, result: 'free' }
    });
    return;
  }

  let initialPids = args.findListeningPids(port);
  if (initialPids.length === 0) {
    const healthyWithoutPid = await args.isServerHealthyQuick(port);
    if (healthyWithoutPid && opts.restart && !buildRestartOnly) {
      const accepted = await attemptConfirmedPortScopedShutdown();
      const shutdownTimeoutMs = Number(args.env.ROUTECODEX_STOP_TIMEOUT_MS ?? 5000);
      if (accepted && await waitForPortFree(shutdownTimeoutMs, 150)) {
        logProcessLifecycle({
          event: 'port_check_result',
          source: 'cli.ensurePortAvailable',
          details: { port, result: 'freed_after_port_scoped_shutdown_no_pid' }
        });
        return;
      }
      const lateManagedPids = args.findListeningPids(port);
      if (lateManagedPids.length > 0) {
        initialPids = lateManagedPids;
      } else {
        const result = accepted ? 'port_scoped_shutdown_timeout_no_pid' : 'port_scoped_shutdown_unconfirmed_no_pid';
        logProcessLifecycle({
          event: 'port_check_result',
          source: 'cli.ensurePortAvailable',
          details: { port, result }
        });
        throw new Error(
          accepted
            ? `Timed out waiting for RouteCodex port-scoped stop to free port ${port}; no managed PID is available for signal fallback.`
            : `Port ${port} is occupied by RouteCodex but no managed PID is available; refusing to start until port-scoped stop is confirmed.`
        );
      }
    }
    if (initialPids.length === 0 && healthyWithoutPid && opts.restart && buildRestartOnly) {
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
    if (initialPids.length === 0 && healthyWithoutPid && !opts.restart) {
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
  }

  if (initialPids.length === 0) {
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

  const extraPortsByPid = new Map<number, number[]>();
  const getPidPorts = (pid: number): number[] => {
    if (extraPortsByPid.has(pid)) {
      return extraPortsByPid.get(pid) ?? [];
    }
    const ports = Array.from(
      new Set(
        (typeof args.findListeningPortsByPid === 'function'
          ? args.findListeningPortsByPid(pid)
          : [])
          .map((item) => Number(item))
          .filter((item) => Number.isFinite(item) && item > 0)
      )
    );
    extraPortsByPid.set(pid, ports);
    return ports;
  };
  const unsafePids = initialPids.filter((pid) => getPidPorts(pid).some((listenerPort) => !targetPortSet.has(listenerPort)));
  const assertNoUnsafePidSignal = (): void => {
    if (unsafePids.length === 0) {
      return;
    }
    throw new Error(
      `Port ${port} is occupied by managed PID(s) that also own non-target listener port(s): ${unsafePids.join(', ')}`
    );
  };

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
    args.logger.info(`Use 'rcc stop' or plain 'rcc start' to restart.`);
    args.exit(0);
  }

  if (!opts.restart) {
    logProcessLifecycle({
      event: 'port_check_result',
      source: 'cli.ensurePortAvailable',
      details: { port, result: 'occupied_no_restart', pids: initialPids, healthy }
    });
    throw new Error(
      `Port ${port} is occupied by RouteCodex process(es). Use 'rcc stop' or plain 'rcc start' to take over.`
    );
  }

  parentSpinner.stop();
  args.logger.warning(`Port ${port} is in use by PID(s): ${initialPids.join(', ')}`);
  const stopSpinner = await args.createSpinner(`Port ${port} is in use on 0.0.0.0. Attempting graceful stop...`);
  const gracefulTimeout = Number(args.env.ROUTECODEX_STOP_TIMEOUT_MS ?? 5000);
  const killTimeout = Number(args.env.ROUTECODEX_KILL_TIMEOUT_MS ?? 3000);
  const pollInterval = 150;

  const portScopedShutdownAccepted = await attemptConfirmedPortScopedShutdown();
  if (portScopedShutdownAccepted) {
    if (await waitForPortFree(gracefulTimeout, pollInterval)) {
      logProcessLifecycle({
        event: 'port_check_result',
        source: 'cli.ensurePortAvailable',
        details: { port, result: 'freed_after_port_scoped_shutdown' }
      });
      stopSpinner.succeed(`Port ${port} freed after RouteCodex port-scoped stop.`);
      args.logger.success(`Port ${port} freed after RouteCodex port-scoped stop.`);
      parentSpinner.start('Starting RouteCodex server...');
      return;
    }
    logProcessLifecycle({
      event: 'port_check_result',
      source: 'cli.ensurePortAvailable',
      details: { port, result: 'port_scoped_shutdown_timeout', pids: args.findListeningPids(port) }
    });
  }

  assertNoUnsafePidSignal();

  stopSpinner.warn(`Graceful shutdown did not free port ${port}, sending SIGTERM to managed PID(s): ${initialPids.join(', ')}`);
  for (const pid of initialPids) {
    try {
      args.killPidBestEffort(pid, { force: false });
    } catch (error) {
      stopSpinner.warn(`Failed to send SIGTERM to PID ${pid}: ${(error as Error).message}`);
    }
  }

  const gracefulDeadline = Date.now() + gracefulTimeout;
  while (Date.now() < gracefulDeadline) {
    if (await canBindPort()) {
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
      if (await canBindPort()) {
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
  if (remaining.length || !(await canBindPort())) {
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
