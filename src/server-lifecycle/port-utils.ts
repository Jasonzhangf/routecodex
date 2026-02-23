/**
 * Port Management Utilities
 *
 * Functions for checking port availability, cleanup, and HTTP shutdown.
 */

import net from 'net';
import { spawnSync } from 'child_process';
import { logProcessLifecycle } from '../utils/process-lifecycle-logger.js';
import { HTTP_PROTOCOLS, LOCAL_HOSTS, API_PATHS } from '../constants/index.js';
import { listManagedServerPidsByPort } from '../utils/managed-server-pids.js';
import { resolveSignalCaller } from '../sharedmodule/process-snapshot.js';

async function canBind(port: number): Promise<boolean> {
  return await new Promise<boolean>(resolve => {
    try {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen({ host: '0.0.0.0', port }, () => {
        s.close(() => resolve(true));
      });
    } catch { resolve(false); }
  });
}

function isBuildRestartOnlyMode(): boolean {
  const raw = String(process.env.ROUTECODEX_BUILD_RESTART_ONLY ?? process.env.RCC_BUILD_RESTART_ONLY ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

async function isServerHealthyQuick(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      try { controller.abort(); } catch { /* ignore */ }
    }, 800);
    const res = await fetch(`${HTTP_PROTOCOLS.HTTP}${LOCAL_HOSTS.IPV4}:${port}/health`, {
      method: 'GET',
      signal: controller.signal
    }).catch(() => null);
    clearTimeout(timeout);
    if (!res || !res.ok) {
      return false;
    }
    const data = await res.json().catch(() => null);
    const status = typeof data?.status === 'string' ? data.status.toLowerCase() : '';
    return !!data && (status === 'healthy' || status === 'ready' || status === 'ok' || data?.ready === true || data?.pipelineReady === true);
  } catch {
    return false;
  }
}

async function attemptHttpShutdown(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      try { controller.abort(); } catch { /* ignore */ }
    }, 1000);
    const res = await fetch(`${HTTP_PROTOCOLS.HTTP}${LOCAL_HOSTS.IPV4}:${port}${API_PATHS.SHUTDOWN}`, {
      method: 'POST',
      signal: controller.signal
    }).catch(() => null);
    clearTimeout(timeout);
    const ok = !!(res && res.ok);
    logProcessLifecycle({
      event: 'http_shutdown_probe',
      source: 'index.attemptHttpShutdown',
      details: { port, result: ok ? 'ok' : 'not_ready', status: res?.status }
    });
    return ok;
  } catch (error) {
    logProcessLifecycle({
      event: 'http_shutdown_probe',
      source: 'index.attemptHttpShutdown',
      details: { port, result: 'failed', error }
    });
    return false;
  }
}

function killPidBestEffort(pid: number, opts: { force: boolean }): void {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }
  if (pid === process.pid) {
    logProcessLifecycle({
      event: 'kill_attempt',
      source: 'index.ensurePortAvailable',
      details: {
        targetPid: pid,
        signal: 'SKIP_SELF',
        result: 'skipped',
        reason: 'self_kill_guard',
        caller: resolveSignalCaller('SELF_GUARD')
      }
    });
    return;
  }
  const signal = opts.force ? 'SIGKILL' : 'SIGTERM';
  if (process.platform === 'win32') {
    const args = ['/PID', String(pid), '/T'];
    if (opts.force) {
      args.push('/F');
    }
    logProcessLifecycle({
      event: 'kill_attempt',
      source: 'index.ensurePortAvailable',
      details: { targetPid: pid, signal: opts.force ? 'TASKKILL_F' : 'TASKKILL', result: 'attempt' }
    });
    try {
      spawnSync('taskkill', args, { stdio: 'ignore', encoding: 'utf8' });
      logProcessLifecycle({
        event: 'kill_attempt',
        source: 'index.ensurePortAvailable',
        details: { targetPid: pid, signal: opts.force ? 'TASKKILL_F' : 'TASKKILL', result: 'success' }
      });
    } catch (error) {
      logProcessLifecycle({
        event: 'kill_attempt',
        source: 'index.ensurePortAvailable',
        details: { targetPid: pid, signal: opts.force ? 'TASKKILL_F' : 'TASKKILL', result: 'failed', error }
      });
    }
    return;
  }
  logProcessLifecycle({
    event: 'kill_attempt',
    source: 'index.ensurePortAvailable',
    details: { targetPid: pid, signal, result: 'attempt' }
  });
  try {
    process.kill(pid, signal);
    logProcessLifecycle({
      event: 'kill_attempt',
      source: 'index.ensurePortAvailable',
      details: { targetPid: pid, signal, result: 'success' }
    });
  } catch (error) {
    logProcessLifecycle({
      event: 'kill_attempt',
      source: 'index.ensurePortAvailable',
      details: { targetPid: pid, signal, result: 'failed', error }
    });
  }
}

/**
 * Ensure a TCP port is available by attempting graceful shutdown of any process holding it,
 * then force-killing as a last resort.
 */
async function ensurePortAvailable(
  port: number,
  opts: { attemptGraceful?: boolean; restartInPlaceOnly?: boolean } = {}
): Promise<'available' | 'handled_existing_server'> {
  const restartInPlaceOnly = Boolean(opts.restartInPlaceOnly ?? isBuildRestartOnlyMode());
  // Quick probe first; if we can bind, it's free
  try {
    const probe = net.createServer();
    const canListen = await new Promise<boolean>(resolve => {
      probe.once('error', () => resolve(false));
      probe.listen({ host: '0.0.0.0', port }, () => resolve(true));
    });
    if (canListen) {
      await new Promise(r => probe.close(() => r(null)));
      return 'available'; // free
    }
  } catch {
    // fallthrough
  }

  if (restartInPlaceOnly) {
    const managedPids = listManagedServerPidsByPort(port).map(Number).filter(pid => Number.isFinite(pid) && pid > 0);
    if (managedPids.length > 0) {
      let signaled = 0;
      for (const pid of managedPids) {
        try {
          logProcessLifecycle({
            event: 'port_restart_signal',
            source: 'index.ensurePortAvailable',
            details: { port, pid, signal: 'SIGUSR2', result: 'attempt' }
          });
          process.kill(pid, 'SIGUSR2');
          signaled += 1;
          logProcessLifecycle({
            event: 'port_restart_signal',
            source: 'index.ensurePortAvailable',
            details: { port, pid, signal: 'SIGUSR2', result: 'success' }
          });
        } catch (error) {
          logProcessLifecycle({
            event: 'port_restart_signal',
            source: 'index.ensurePortAvailable',
            details: { port, pid, signal: 'SIGUSR2', result: 'failed', error }
          });
        }
      }
      if (signaled > 0) {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          if (await isServerHealthyQuick(port)) {
            return 'handled_existing_server';
          }
          await new Promise(r => setTimeout(r, 150));
        }
        throw new Error(`Build restart-only mode timed out waiting for restarted server on port ${port}`);
      }
      throw new Error(`Build restart-only mode failed: unable to signal SIGUSR2 to managed PID(s) on port ${port}`);
    }

    if (await isServerHealthyQuick(port)) {
      logProcessLifecycle({
        event: 'port_check_result',
        source: 'index.ensurePortAvailable',
        details: { port, result: 'restart_only_reuse_existing' }
      });
      return 'handled_existing_server';
    }

    throw new Error(
      `Port ${port} is occupied by unmanaged process; build restart-only mode refuses shutdown/kill.`
    );
  }

  // Try graceful HTTP shutdown if a compatible server is there
  if (opts.attemptGraceful) {
    const graceful = await attemptHttpShutdown(port);
    if (graceful) {
      // Give the server a moment to exit cleanly
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 300));
        if (await canBind(port)) {
          return 'available';
        }
      }
    }
  }

  // Fall back to SIGTERM/SIGKILL on managed RouteCodex pid files only.
  const pids = listManagedServerPidsByPort(port).map(String);
  if (!pids.length) {
    const occupied = !(await canBind(port));
    if (occupied) {
      logProcessLifecycle({
        event: 'port_cleanup',
        source: 'index.ensurePortAvailable',
        details: { port, result: 'occupied_unmanaged' }
      });
      throw new Error(
        `Port ${port} is occupied by unmanaged process; refusing blind kill. Stop process manually or call /shutdown if it is RouteCodex.`
      );
    }
    logProcessLifecycle({
      event: 'port_cleanup',
      source: 'index.ensurePortAvailable',
      details: { port, result: 'no_managed_pid' }
    });
    return 'available';
  }
  logProcessLifecycle({
    event: 'port_cleanup',
    source: 'index.ensurePortAvailable',
    details: { port, result: 'managed_pid_found', pids }
  });
  for (const pid of pids) {
    killPidBestEffort(Number(pid), { force: false });
  }
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 300));
    if (await canBind(port)) {
      return 'available';
    }
  }
  const remain = listManagedServerPidsByPort(port).map(String);
  if (remain.length) {
    logProcessLifecycle({
      event: 'port_cleanup',
      source: 'index.ensurePortAvailable',
      details: { port, result: 'force_kill', pids: remain }
    });
  }
  for (const pid of remain) {
    killPidBestEffort(Number(pid), { force: true });
  }
  await new Promise(r => setTimeout(r, 500));
  return 'available';
}

export { ensurePortAvailable, killPidBestEffort, canBind, attemptHttpShutdown };
