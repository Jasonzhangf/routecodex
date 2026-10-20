// Isolated test-instance lifecycle for the protocol live-mock matrix.
//
// This module owns the public lifecycle façade and the foreground RCC child
// handle. Config generation, bounded HTTP, network diagnosis, and shared
// bounded utilities live in the sibling lifecycle modules.

import { spawn, spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  boundedDuration,
  delay,
  errorDetails,
} from './lifecycle-common.mjs';
import { sendHttp } from './lifecycle-http.mjs';
import {
  declaredListenerSet,
  diagnoseExactBind,
  diagnoseListenerSet,
  requirePort,
  waitForSocketClosed,
} from './lifecycle-network.mjs';
import { generateRccConfig } from './lifecycle-config.mjs';

export { generateRccConfig, sendHttp, diagnoseExactBind, diagnoseListenerSet };

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 8_000;
const DEFAULT_SOCKET_CLOSE_TIMEOUT_MS = 2_000;

/**
 * Start one public foreground RCC child and wait for its owned listener health.
 *
 * The startup result is an observation, not a promise of success. A failed
 * start sets report.status=runner_startup_failed and report.infra_failure, and
 * the returned handle remains ready=false.
 */
export async function startRcc(binary, generated, rccPort, report = {}, options = {}) {
  if (!generated?.path || !generated?.home || !generated?.state) {
    throw new Error('startRcc requires a generated config with path, home, and state');
  }
  const port = requirePort(rccPort, 'rccPort');
  const serverId = generated.server_id ?? 'loopback';
  const startupTimeoutMs = boundedDuration(options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
  const healthTimeoutMs = boundedDuration(options.healthTimeoutMs ?? 800, 1, startupTimeoutMs);
  const host = options.host ?? '127.0.0.1';
  const env = {
    ...process.env,
    HOME: generated.home,
    ROUTECODEX_V3_STATE_DIR: generated.state,
    ...(generated.env ?? {}),
    ...(options.env ?? {}),
  };
  const declaredListeners = declaredListenerSet(generated, host, port);
  const spawnArgs = ['server', 'start', '--foreground', '--config', generated.path];
  if (options.snapshotAll === true) spawnArgs.push('--snapall');
  const child = spawn(binary, spawnArgs, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let ready = false;
  let exitReceipt = null;
  let resolveExit;
  const exitPromise = new Promise((resolveExitPromise) => {
    resolveExit = resolveExitPromise;
  });
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });

  const recordExit = (kind, code, signal, error = null) => {
    if (exitReceipt) return;
    exitReceipt = {
      pid: child.pid ?? null,
      kind,
      exit_code: code,
      signal,
      at_epoch_ms: Date.now(),
      error: error ? errorDetails(error) : null,
    };
    resolveExit(exitReceipt);
  };
  child.once('exit', (code, signal) => recordExit('exit', code, signal));
  child.once('close', (code, signal) => {
    if (!exitReceipt) recordExit('close', code, signal);
  });
  child.once('error', (error) => recordExit('error', null, null, error));

  const handle = {
    child,
    pid: child.pid ?? null,
    binary,
    start_args: [...spawnArgs],
    config_path: generated.path,
    home: generated.home,
    state_root: generated.state,
    host,
    port,
    admin_bind: generated.admin_bind ?? null,
    listeners: declaredListeners,
    server_id: serverId,
    state: 'starting',
    health: null,
    identity: null,
    get ready() {
      return ready && exitReceipt === null;
    },
    get running() {
      return exitReceipt === null;
    },
    get exit_receipt() {
      return exitReceipt;
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    waitForExit(timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS) {
      return waitForPromise(exitPromise, timeoutMs);
    },
    diagnostics() {
      return {
        pid: child.pid ?? null,
        ready,
        running: exitReceipt === null,
        exit_receipt: exitReceipt,
        stdout,
        stderr,
      };
    },
  };

  const deadline = Date.now() + startupTimeoutMs;
  let lastFailure = null;
  let lastHealth = null;
  while (Date.now() < deadline) {
    if (exitReceipt) break;
    const remainingMs = Math.max(1, deadline - Date.now());
    const health = await sendHttp(`http://${host}:${port}/health`, {
      method: 'GET',
      timeoutMs: Math.min(healthTimeoutMs, remainingMs),
      maxBytes: 1024 * 1024,
    });
    lastHealth = health;
    const identity = rccHealthIdentity(health, serverId, port);
    if (identity.ok) {
      ready = true;
      handle.health = health;
      handle.identity = identity;
      handle.state = 'running';
      return handle;
    }
    lastFailure = identity.failure;
    await delay(Math.min(250, Math.max(1, deadline - Date.now())));
  }

  if (!exitReceipt) {
    // Health polling is event-driven only on the next sleep. Give an exiting
    // owned child one bounded chance to publish its native status before this
    // helper records the report or sends a shutdown signal.
    const exitGraceMs = boundedDuration(options.processExitGraceMs ?? 250);
    const graceDeadline = Date.now() + exitGraceMs;
    while (Date.now() < graceDeadline) {
      if (exitReceipt) break;
      await delay(Math.min(10, Math.max(1, graceDeadline - Date.now())));
    }
  }
  const failureCode = exitReceipt
    ? exitReceipt.kind === 'error'
      ? 'spawn_error'
      : 'process_exited_before_ready'
    : 'startup_timeout';
  const detail = describeStartupFailure(failureCode, exitReceipt, lastFailure, lastHealth, serverId, port);
  handle.state = 'infra_failure';
  report.status = 'runner_startup_failed';
  report.startup = {
    status: 'infra_failure',
    phase: 'start_rcc',
    binary,
    pid: child.pid ?? null,
    config_path: generated.path,
    state_root: generated.state,
    host,
    port,
    admin_bind: generated.admin_bind ?? null,
    listeners: declaredListeners,
    expected_server_id: serverId,
    ready: false,
    running: false,
    process_alive: exitReceipt === null,
    exit: exitReceipt,
    last_health: lastHealth,
    last_failure: lastFailure,
    stdout_tail: tailLines(stdout, 40),
    stderr_tail: tailLines(stderr, 40),
    diagnostic: detail,
  };
  report.infra_failure = {
    phase: 'start_rcc',
    code: failureCode,
    diagnostic: detail,
    pid: child.pid ?? null,
    port,
    admin_bind: generated.admin_bind ?? null,
    listeners: declaredListeners,
    expected_server_id: serverId,
  };

  await stopRcc(handle, report, {
    shutdownTimeoutMs: options.failedStartupShutdownTimeoutMs ?? 2_000,
    socketCloseTimeoutMs: options.failedStartupSocketCloseTimeoutMs ?? 1_000,
    host,
  });
  return handle;
}

/**
 * Stop only the child held by this handle, then wait for process exit and port
 * closure. Foreign listeners are observed but never selected or killed.
 */
export async function stopRcc(handle, report = {}, options = {}) {
  const started = Date.now();
  const host = options.host ?? handle?.host ?? '127.0.0.1';
  const port = Number(handle?.port);
  const shutdownTimeoutMs = boundedDuration(options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS);
  const socketCloseTimeoutMs = boundedDuration(
    options.socketCloseTimeoutMs ?? DEFAULT_SOCKET_CLOSE_TIMEOUT_MS,
  );
  const failures = [];
  let forceKilled = false;
  let killError = null;
  let processExitObserved = Boolean(handle?.exit_receipt && handle.exit_receipt.kind !== 'error');

  if (handle?.child && !handle.exit_receipt) {
    try {
      handle.child.kill('SIGTERM');
    } catch (error) {
      killError = errorDetails(error);
      failures.push(`SIGTERM failed: ${error.message}`);
    }
    processExitObserved = Boolean(await handle.waitForExit(shutdownTimeoutMs));
    if (!processExitObserved) {
      forceKilled = true;
      try {
        handle.child.kill('SIGKILL');
      } catch (error) {
        killError = errorDetails(error);
        failures.push(`SIGKILL failed: ${error.message}`);
      }
      processExitObserved = Boolean(await handle.waitForExit(2_000));
      if (!processExitObserved) failures.push('owned child did not exit after SIGKILL');
    }
  } else if (!handle?.exit_receipt) {
    failures.push('no owned child or exit receipt is available');
  }

  const declaredListeners = declaredListenerSet(handle, host, port);
  const listenerClosures = [];
  let allListenersClosed = true;
  let primarySocket = null;
  for (const listener of declaredListeners) {
    const listenerHost = listener.host ?? host;
    const listenerPort = Number(listener.port);
    const socket = Number.isInteger(listenerPort) && listenerPort > 0
      ? await waitForSocketClosed(listenerHost, listenerPort, socketCloseTimeoutMs)
      : { closed: false, error: { code: 'INVALID_PORT', message: `invalid port ${listener.port}` } };
    const closure = {
      role: listener.role ?? null,
      server_id: listener.server_id ?? null,
      host: listenerHost,
      port: Number.isInteger(listenerPort) ? listenerPort : null,
      closed: socket.closed,
      error: socket.error ?? null,
    };
    listenerClosures.push(closure);
    if (listener.role === 'primary' || primarySocket === null) primarySocket = closure;
    if (!socket.closed) {
      allListenersClosed = false;
      failures.push(
        `owned listener did not close: ${listener.role ?? 'listener'} ${listenerHost}:${listener.port} ${socket.error?.message ?? 'timeout'}`,
      );
    }
  }

  const cleanup = {
    complete: processExitObserved && allListenersClosed && !killError,
    pid: handle?.pid ?? handle?.child?.pid ?? null,
    process_exit_observed: processExitObserved,
    exit_code: handle?.exit_receipt?.exit_code ?? null,
    signal: handle?.exit_receipt?.signal ?? null,
    force_killed: forceKilled,
    kill_error: killError,
    socket_closed: primarySocket?.closed ?? false,
    socket_close_error: primarySocket?.error ?? null,
    all_listeners_closed: allListenersClosed,
    listener_closures: listenerClosures,
    elapsed_ms: Date.now() - started,
    failures,
  };
  report.cleanup = cleanup;
  return cleanup;
}

/**
 * Capture installed/candidate binary identity without changing the binary or
 * trusting a shell wrapper. spawnSync returns the real child process status.
 */
export function captureRuntimeIdentity(binary) {
  const path = resolve(binary);
  const identity = {
    path,
    version: null,
    version_output: null,
    version_stderr: null,
    exit_code: null,
    signal: null,
    size: null,
    mtime_ms: null,
    error: null,
  };

  try {
    const stat = statSync(path);
    identity.size = stat.size;
    identity.mtime_ms = stat.mtimeMs;
  } catch (error) {
    identity.error = errorDetails(error);
  }

  const version = spawnSync(path, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  identity.exit_code = version.status;
  identity.signal = version.signal;
  identity.version_output = version.stdout ?? '';
  identity.version_stderr = version.stderr ?? '';
  if (version.error) identity.error = errorDetails(version.error);
  if (version.status === 0) identity.version = (version.stdout ?? '').trim() || null;
  return identity;
}

function rccHealthIdentity(health, serverId, port) {
  if (health.error) {
    return { ok: false, failure: { code: 'health_transport_error', error: health.error_detail } };
  }
  if (health.status !== 200) {
    return { ok: false, failure: { code: 'health_status_mismatch', status: health.status } };
  }
  if (!health.body || typeof health.body !== 'object') {
    return { ok: false, failure: { code: 'health_body_not_json' } };
  }
  const body = health.body;
  if (body.status !== 'ok') {
    return { ok: false, failure: { code: 'health_status_field_mismatch', status: body.status } };
  }
  if (body.version !== 3) {
    return { ok: false, failure: { code: 'health_version_mismatch', version: body.version } };
  }
  if (body.server_id !== serverId) {
    return {
      ok: false,
      failure: { code: 'health_server_id_mismatch', expected: serverId, actual: body.server_id },
    };
  }
  if (body.port !== port) {
    return { ok: false, failure: { code: 'health_port_mismatch', expected: port, actual: body.port } };
  }
  return {
    ok: true,
    server_id: body.server_id,
    port: body.port,
    manifest_version: body.manifest_version ?? null,
    build_version: body.build_version ?? null,
  };
}

function describeStartupFailure(code, exit, lastFailure, lastHealth, serverId, port) {
  const parts = [`startup ${code}`];
  parts.push(`expected server_id=${serverId} port=${port}`);
  if (exit) {
    parts.push(`child exit_code=${exit.exit_code ?? 'null'} signal=${exit.signal ?? 'null'}`);
  }
  if (lastFailure) parts.push(`last health rejection=${JSON.stringify(lastFailure)}`);
  if (lastHealth?.error) parts.push(`last health error=${lastHealth.error}`);
  return parts.join('; ');
}

function waitForPromise(promise, timeoutMs) {
  return Promise.race([
    promise,
    delay(timeoutMs).then(() => null),
  ]);
}

function tailLines(text, count) {
  return String(text ?? '').split('\n').slice(-count).join('\n');
}
