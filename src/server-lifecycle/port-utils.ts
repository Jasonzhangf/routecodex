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
async function ensurePortAvailable(port: number, opts: { attemptGraceful?: boolean } = {}): Promise<void> {
  // Quick probe first; if we can bind, it's free
  try {
    const probe = net.createServer();
    const canListen = await new Promise<boolean>(resolve => {
      probe.once('error', () => resolve(false));
      probe.listen({ host: '0.0.0.0', port }, () => resolve(true));
    });
    if (canListen) {
      await new Promise(r => probe.close(() => r(null)));
      return; // free
    }
  } catch {
    // fallthrough
  }

  // Try graceful HTTP shutdown if a compatible server is there
  if (opts.attemptGraceful) {
    const graceful = await attemptHttpShutdown(port);
    if (graceful) {
      // Give the server a moment to exit cleanly
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 300));
        if (await canBind(port)) {
          return;
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
    return;
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
      return;
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
}

export { ensurePortAvailable, killPidBestEffort, canBind, attemptHttpShutdown };
