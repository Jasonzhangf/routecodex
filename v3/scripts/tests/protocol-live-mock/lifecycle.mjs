// Isolated test-instance lifecycle for the protocol live-mock matrix.
//
// This module owns one generated V3 config, one foreground RCC child, one
// bounded HTTP client, and one installed/candidate runtime identity. The V3
// declaration appends an internal admin_webui listener, so the generated
// instance owns two declared addresses: the primary server and the admin bind.
// It never invokes a managed lifecycle command, changes HOME, or kills by
// port/PID scan.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as connectTcp, createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const FAKE_TASK_TOKEN = 'fake-loopback-token';
const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 8_000;
const DEFAULT_SOCKET_CLOSE_TIMEOUT_MS = 2_000;
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
const DEFAULT_HTTP_MAX_BYTES = 16 * 1024 * 1024;
const PROTOCOLS = ['openai_chat', 'responses', 'anthropic', 'gemini'];
const MODEL_FOR_PROTOCOL = {
  openai_chat: 'chat-model',
  responses: 'responses-model',
  anthropic: 'anthropic-model',
  gemini: 'gemini-model',
};
const PROVIDER_BASE_SUFFIX = {
  openai_chat: '/v1',
  responses: '/v1',
  anthropic: '',
  gemini: '/v1beta',
};

/**
 * Write a task-owned V3 config and its referenced provider directory.
 *
 * The root file uses the supported simplified V3 authoring surface. The
 * provider directory keeps the current V3 provider file name (`config.v2.toml`)
 * because V3ConfigStore owns that parser; this function does not create a V2
 * runtime, reader, migration, or backup path.
 *
 * The internal `admin_webui` listener defaults to `127.0.0.1:8777` and is
 * appended to the managed listener set by the V3 lifecycle. A shared 8777 would
 * make every matrix instance collide on release preflight, so this function
 * allocates a task-owned loopback admin port and returns the
 * `ROUTECODEX_V3_ADMIN_BIND` override that `startRcc` passes to the child.
 */
export async function generateRccConfig(options = {}) {
  const mockPort = requirePort(options.mockPort, 'mockPort');
  const rccPort = requirePort(options.rccPort, 'rccPort');
  const adminHost = options.adminHost ?? '127.0.0.1';
  const inheritedAdminBind = options.inheritedAdminBind ?? process.env.ROUTECODEX_V3_ADMIN_BIND ?? null;
  let adminPort = options.adminPort !== undefined
    ? requirePort(options.adminPort, 'adminPort')
    : await allocateLoopbackPort(adminHost);
  while (adminPort === rccPort || adminPort === mockPort) {
    adminPort = await allocateLoopbackPort(adminHost);
  }
  const adminBind = `${adminHost}:${adminPort}`;
  const providerProtocol = requireProtocol(options.providerProtocol ?? 'responses');
  const mode = options.mode ?? null;
  if (mode !== null && mode !== 'direct' && mode !== 'relay') {
    throw new Error('mode must be direct or relay');
  }
  const serverId = requireIdentifier(options.serverId ?? 'loopback', 'serverId');
  const defaultProviderId = requireIdentifier(options.providerId ?? `mock-${providerProtocol}`, 'providerId');
  const defaultModel = options.model ?? `mock.${MODEL_FOR_PROTOCOL[providerProtocol]}`;
  const defaultWireModel = options.wireModel ?? MODEL_FOR_PROTOCOL[providerProtocol];
  const runtimeSetup = options.runtimeSetup ?? null;
  const plan = resolveCandidatePlan({
    runtimeSetup,
    defaultProviderId,
    defaultModel,
    defaultWireModel,
  });
  const wireModel = plan.wireModel;
  const workRoot = resolve(options.workRoot ?? process.cwd());
  mkdirSync(workRoot, { recursive: true });
  const root = mkdtempSync(join(workRoot, 'v3-protocol-live-mock-lifecycle-'));
  const state = join(root, 'state');
  const providerRoot = join(root, 'provider');
  const configPath = join(root, 'config.toml');

  mkdirSync(providerRoot, { recursive: true });
  mkdirSync(state, { recursive: true });

  const baseURL = `http://127.0.0.1:${mockPort}${PROVIDER_BASE_SUFFIX[providerProtocol]}`;
  const providerFiles = plan.candidates.map((candidate) => {
    const providerDir = join(providerRoot, candidate.providerId);
    const providerPath = join(providerDir, 'config.v2.toml');
    mkdirSync(providerDir, { recursive: true });
    const text = renderProviderFile({
      providerId: candidate.providerId,
      providerProtocol,
      baseURL,
      wireModel: candidate.wireModel,
      model: candidate.model,
      token: candidate.token,
    });
    writeFileSync(providerPath, text);
    validateProviderFile(providerPath, candidate);
    return {
      candidate_id: candidate.candidateId,
      provider_id: candidate.providerId,
      path: providerPath,
      text,
      model: candidate.model,
      wire_model: candidate.wireModel,
      token: candidate.token,
      sha256: createHash('sha256').update(text).digest('hex'),
    };
  });
  if (providerFiles.length !== plan.candidates.length) {
    throw new Error(
      `runtimeSetup declared ${plan.candidates.length} candidates but authored ${providerFiles.length} provider files`,
    );
  }
  const primary = providerFiles[0];

  const configText = `version = 3

[servers.${tomlKey(serverId)}]
bind = "127.0.0.1"
port = ${rccPort}
endpoints = ${tomlStringArray(PROTOCOLS)}
${mode ? `
[servers.${tomlKey(serverId)}.execution]
allowed_modes = ["${mode}"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
` : ''}

[servers.${tomlKey(serverId)}.routes.default]
tiers = ${renderDefaultTier(plan.candidates)}
`;

  writeFileSync(configPath, configText);
  // Receipt the authoring file, rather than echoing the requested option.
  // Config check and public-entry evidence remain separate runtime gates.
  const writtenConfig = readFileSync(configPath, 'utf8');
  const writtenMode = writtenConfig.match(/^allowed_modes = \["(direct|relay)"\]$/m)?.[1] ?? null;

  const listeners = [
    { role: 'primary', server_id: serverId, host: '127.0.0.1', port: rccPort },
    { role: 'admin_webui', server_id: 'admin_webui', host: adminHost, port: adminPort },
  ];
  const env = { ROUTECODEX_V3_ADMIN_BIND: adminBind };

  // Independent candidate identity receipt. The fixture's `auth_orders` stay
  // the source of truth for allowed identity orders; this receipt only names
  // the identities that were authored, so G4 can bind config evidence.
  const candidateIdentityReceipts = {
    validated: true,
    protocol: providerProtocol,
    wire_model: wireModel,
    tier_count: 1,
    candidates: providerFiles.map((file) => ({
      candidate_id: file.candidate_id,
      provider_id: file.provider_id,
      model: file.model,
      wire_model: file.wire_model,
      provider_path: file.path,
      provider_sha256: file.sha256,
      auth_token: file.token,
      authorization: `Bearer ${file.token}`,
      declared: true,
    })),
  };

  return {
    root,
    home: root,
    state,
    path: configPath,
    text: configText,
    env,
    provider_root: providerRoot,
    provider_dir: dirname(primary.path),
    provider_path: primary.path,
    provider_text: primary.text,
    provider_files: providerFiles.map((file) => ({
      provider_id: file.provider_id,
      path: file.path,
      text: file.text,
      model: file.model,
      wire_model: file.wire_model,
    })),
    candidate_identity_receipts: candidateIdentityReceipts,
    mock_port: mockPort,
    rcc_port: rccPort,
    admin_host: adminHost,
    admin_port: adminPort,
    admin_bind: adminBind,
    inherited_admin_bind: inheritedAdminBind,
    listeners,
    provider_protocol: providerProtocol,
    mode: writtenMode,
    mode_receipt: writtenMode ? {
      field: `servers.${serverId}.execution.allowed_modes`,
      allowed_modes: [writtenMode],
      config_sha256: createHash('sha256').update(writtenConfig).digest('hex'),
    } : null,
    provider_id: primary.provider_id,
    model: primary.model,
    model_alias: primary.model,
    wire_model: wireModel,
    runtime_setup: runtimeSetup,
    candidate_ids: plan.candidates.map((candidate) => candidate.candidateId),
    server_id: serverId,
    binary: options.binary ?? null,
    fixture_root: options.fixtureRoot ?? null,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Resolve the authored provider/model candidates from the runtime setup.
 *
 * A single declared candidate keeps the legacy task token and the
 * `provider_id`/`model`/`wire_model` options. Multiple candidates declare one
 * provider each inside one default pool tier; every candidate gets a distinct
 * explicit fake token, and the declared model/wire model are shared. The plan
 * is validated here so generation never silently collapses a multi-candidate
 * request onto a single default provider.
 */
function resolveCandidatePlan({ runtimeSetup, defaultProviderId, defaultModel, defaultWireModel }) {
  if (!runtimeSetup) {
    return {
      wireModel: defaultWireModel,
      candidates: [{
        candidateId: `${defaultProviderId}/${defaultModel}`,
        providerId: defaultProviderId,
        model: defaultModel,
        wireModel: defaultWireModel,
        token: FAKE_TASK_TOKEN,
      }],
    };
  }
  const rawCandidates = runtimeSetup.candidate_ids;
  if (!Array.isArray(rawCandidates) || rawCandidates.length === 0) {
    throw new Error('runtimeSetup.candidate_ids must declare at least one provider/model candidate');
  }
  const declaredModel = runtimeSetup.model ?? defaultModel;
  const declaredWireModel = runtimeSetup.wire_model ?? defaultWireModel;
  const parsed = rawCandidates.map((raw) => {
    const parts = String(raw).split('/');
    if (parts.length !== 2 || parts.some((part) => !part)) {
      throw new Error(`runtimeSetup candidate ${raw} must be provider/model`);
    }
    return {
      candidateId: String(raw),
      providerId: requireIdentifier(parts[0], 'runtimeSetup provider'),
      model: parts[1],
    };
  });
  if (parsed.length === 1) {
    const [only] = parsed;
    if (only.providerId !== defaultProviderId) {
      throw new Error(`runtimeSetup provider ${only.providerId} does not match generated provider ${defaultProviderId}`);
    }
    return {
      wireModel: declaredWireModel,
      candidates: [{
        ...only,
        wireModel: declaredWireModel,
        token: FAKE_TASK_TOKEN,
      }],
    };
  }
  const seenProviders = new Set();
  for (const entry of parsed) {
    if (seenProviders.has(entry.providerId)) {
      throw new Error(`runtimeSetup declares duplicate provider ${entry.providerId} in one tier`);
    }
    seenProviders.add(entry.providerId);
    if (entry.model !== declaredModel) {
      throw new Error(`runtimeSetup candidate ${entry.candidateId} model ${entry.model} must match declared model ${declaredModel}`);
    }
  }
  return {
    wireModel: declaredWireModel,
    candidates: parsed.map((entry) => ({
      ...entry,
      wireModel: declaredWireModel,
      token: `${FAKE_TASK_TOKEN}-${entry.providerId}`,
    })),
  };
}

function renderProviderFile({ providerId, providerProtocol, baseURL, wireModel, model, token }) {
  return `version = "2.0.0"
providerId = "${providerId}"

[provider]
id = "${providerId}"
enabled = true
type = "${providerProtocol}"
baseURL = "${baseURL}"
defaultModel = "${wireModel}"

[provider.auth]
type = "apikey"
apiKey = "${token}"

[provider.models."${model}"]
wireName = "${wireModel}"
capabilities = ["text", "tools", "reasoning", "multimodal"]
supportsStreaming = true
`;
}

function renderDefaultTier(candidates) {
  if (candidates.length === 1) {
    return `[[{ use = "${candidates[0].providerId}/${candidates[0].model}" }]]`;
  }
  const members = candidates.map((candidate) => `  { use = "${candidate.providerId}/${candidate.model}" },`);
  members[members.length - 1] = members[members.length - 1].replace(/,$/, '');
  return `[[\n${members.join('\n')}\n]]`;
}

/**
 * Re-read an authored provider file and prove the candidate identity it
 * declares. This is the guard that a candidate profile is backed by a real
 * declared model entry, its wire name, and its explicit token.
 */
function validateProviderFile(path, candidate) {
  const text = readFileSync(path, 'utf8');
  const required = [
    `providerId = "${candidate.providerId}"`,
    `[provider.models."${candidate.model}"]`,
    `wireName = "${candidate.wireModel}"`,
    `apiKey = "${candidate.token}"`,
  ];
  const missing = required.filter((needle) => !text.includes(needle));
  if (missing.length > 0) {
    throw new Error(`generated provider file ${path} is missing ${missing.join(', ')}`);
  }
}

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
  const child = spawn(binary, ['server', 'start', '--foreground', '--config', generated.path], {
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
 * Bounded HTTP client that keeps raw status, headers, bytes, close state, and
 * error details. It never throws for response/transport failures.
 */
export async function sendHttp(url, options = {}) {
  const started = Date.now();
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported URL protocol: ${parsed.protocol}`);
  }
  const transport = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
  const method = String(options.method ?? 'GET').toUpperCase();
  const headers = lowerHeaders(options.headers ?? {});
  const timeoutMs = boundedDuration(options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS, 1);
  const maxBytes = boundedDuration(options.maxBytes ?? DEFAULT_HTTP_MAX_BYTES, 1);
  const body = options.body;

  return new Promise((resolveResponse) => {
    const result = {
      url,
      method,
      request_headers: headers,
      status: null,
      status_text: null,
      headers: {},
      raw_headers: [],
      body: null,
      bodyText: '',
      bodyBytes: Buffer.alloc(0),
      bodyBytesBase64: '',
      response_ended: false,
      complete: null,
      closed: false,
      aborted: false,
      truncated: false,
      elapsed_ms: 0,
      error: null,
      error_detail: null,
    };
    let settled = false;
    let timer = null;
    const chunks = [];
    let receivedBytes = 0;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const bodyBuffer = Buffer.concat(chunks);
      result.bodyBytes = bodyBuffer;
      result.bodyBytesBase64 = bodyBuffer.toString('base64');
      result.bodyText = bodyBuffer.toString('utf8');
      try {
        result.body = result.bodyText ? JSON.parse(result.bodyText) : null;
      } catch {
        result.body = null;
      }
      result.elapsed_ms = Date.now() - started;
      request?.destroy();
      resolveResponse(result);
    };

    const fail = (error, closed = true) => {
      result.error = error?.message ?? String(error);
      result.error_detail = errorDetails(error);
      result.closed = closed;
      finish();
    };

    let request;
    try {
      request = transport(parsed, { method, headers, agent: false }, (response) => {
        result.status = response.statusCode ?? null;
        result.status_text = response.statusMessage ?? null;
        result.headers = lowerHeaders(response.headers);
        result.raw_headers = [...response.rawHeaders];
        response.on('data', (chunk) => {
          const buffer = Buffer.from(chunk);
          receivedBytes += buffer.length;
          if (receivedBytes > maxBytes) {
            result.truncated = true;
            const error = new Error(`response exceeded maxBytes=${maxBytes}`);
            error.code = 'RESPONSE_TOO_LARGE';
            fail(error);
            response.destroy(error);
            return;
          }
          chunks.push(buffer);
        });
        response.on('aborted', () => {
          result.aborted = true;
          result.closed = true;
          result.complete = false;
        });
        response.on('error', (error) => {
          result.aborted = true;
          fail(error);
        });
        response.on('end', () => {
          result.response_ended = true;
          result.complete = response.complete === true;
          result.closed = result.complete === false;
          finish();
        });
        response.on('close', () => {
          result.closed = result.closed || response.complete === false || !result.response_ended;
          if (!result.response_ended) result.complete = false;
          if (!result.response_ended) finish();
        });
      });
    } catch (error) {
      fail(error);
      return;
    }

    timer = setTimeout(() => {
      const error = new Error(`request timed out after ${timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      fail(error);
      request.destroy(error);
    }, timeoutMs);

    request.on('error', (error) => fail(error));
    if (body !== undefined && body !== null) request.write(body);
    request.end();
  });
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
    sha256: null,
    size: null,
    mtime_ms: null,
    error: null,
  };

  try {
    const stat = statSync(path);
    identity.size = stat.size;
    identity.mtime_ms = stat.mtimeMs;
    identity.sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
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

/**
 * Attempt exactly one declared loopback address and release it immediately.
 * The returned error is the original bind error, not a guessed occupied state.
 */
export function diagnoseExactBind(host, port, options = {}) {
  const bindHost = host ?? '127.0.0.1';
  const bindPort = requirePort(port, 'port');
  const timeoutMs = boundedDuration(options.timeoutMs ?? 2_000);
  return new Promise((resolveBind) => {
    const server = createTcpServer();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (server.listening) {
        server.close((error) => {
          value.released = !error;
          value.release_error = error ? errorDetails(error) : null;
          resolveBind(value);
        });
        return;
      }
      resolveBind(value);
    };
    const timer = setTimeout(() => {
      finish({
        host: bindHost,
        port: bindPort,
        bound: false,
        released: false,
        error: { name: 'Error', message: `bind timed out after ${timeoutMs}ms`, code: 'ETIMEDOUT' },
      });
    }, timeoutMs);
    server.once('error', (error) => {
      finish({
        host: bindHost,
        port: bindPort,
        bound: false,
        released: true,
        error: errorDetails(error),
      });
    });
    server.listen({ host: bindHost, port: bindPort, exclusive: true }, () => {
      const address = server.address();
      finish({
        host: bindHost,
        port: bindPort,
        bound: true,
        released: false,
        release_error: null,
        address: typeof address === 'object' && address ? { address: address.address, port: address.port } : null,
        error: null,
      });
    });
  });
}

/**
 * Check every declared loopback address in order, releasing each before the
 * next. The full declared set is the primary server plus the internal
 * admin_webui listener; a single free address does not prove the set is free.
 * Each entry keeps the original bind/release errno.
 */
export async function diagnoseListenerSet(listeners, options = {}) {
  const declared = Array.isArray(listeners) ? listeners : [];
  const addresses = [];
  for (const listener of declared) {
    const host = listener?.host ?? '127.0.0.1';
    const port = requirePort(listener?.port, 'port');
    const result = await diagnoseExactBind(host, port, options);
    addresses.push({
      role: listener?.role ?? null,
      server_id: listener?.server_id ?? null,
      host,
      port,
      bound: result.bound,
      released: result.released,
      address: result.address ?? null,
      error: result.error ?? null,
      release_error: result.release_error ?? null,
    });
  }
  const firstFailure = addresses.find((entry) => !entry.bound || !entry.released) ?? null;
  return {
    addresses,
    all_bound: addresses.length > 0 && addresses.every((entry) => entry.bound),
    all_released: addresses.every((entry) => entry.released),
    first_failure: firstFailure,
  };
}

function declaredListenerSet(source, defaultHost, defaultPort) {
  if (Array.isArray(source?.listeners) && source.listeners.length > 0) {
    return source.listeners.map((listener) => ({
      role: listener.role ?? null,
      server_id: listener.server_id ?? null,
      host: listener.host ?? defaultHost,
      port: listener.port,
    }));
  }
  return [
    { role: 'primary', server_id: source?.server_id ?? null, host: defaultHost, port: defaultPort },
  ];
}

function allocateLoopbackPort(host) {
  return new Promise((resolvePort, rejectPort) => {
    const server = createTcpServer();
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      rejectPort(error);
    };
    server.once('error', fail);
    server.listen({ host, port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => {
        if (settled) return;
        if (error) {
          fail(error);
          return;
        }
        if (!Number.isInteger(port) || port < 1) {
          fail(new Error('failed to allocate a loopback admin port'));
          return;
        }
        settled = true;
        resolvePort(port);
      });
    });
  });
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

async function waitForSocketClosed(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  do {
    const attempt = await connectOnce(host, port, Math.min(250, Math.max(1, deadline - Date.now())));
    if (attempt.closed) return { closed: true, error: null };
    lastError = attempt.error;
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  return { closed: false, error: lastError ?? { code: 'ETIMEDOUT', message: 'socket close timeout' } };
}

function connectOnce(host, port, timeoutMs) {
  return new Promise((resolveConnect) => {
    const socket = connectTcp({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveConnect(value);
    };
    socket.setTimeout(timeoutMs, () => {
      finish({ closed: false, error: { code: 'ETIMEDOUT', message: 'connect timeout' } });
    });
    socket.once('connect', () => finish({ closed: false, error: null }));
    socket.once('error', (error) => {
      const details = errorDetails(error);
      if (details.code === 'ECONNREFUSED' || details.code === 'ECONNRESET') {
        finish({ closed: true, error: null });
        return;
      }
      finish({ closed: false, error: details });
    });
  });
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

function requirePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  return port;
}

function requireProtocol(value) {
  if (!PROTOCOLS.includes(value)) {
    throw new Error(`providerProtocol must be one of ${PROTOCOLS.join(', ')}`);
  }
  return value;
}

function requireIdentifier(value, name) {
  const text = String(value);
  if (!/^[A-Za-z0-9_.-]+$/.test(text)) {
    throw new Error(`${name} must match [A-Za-z0-9_.-]+`);
  }
  return text;
}

function tomlStringArray(values) {
  return `[${values.map((value) => `"${value}"`).join(', ')}]`;
}

function tomlKey(value) {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
}

function lowerHeaders(headers) {
  const output = {};
  if (!headers) return output;
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => {
      output[String(key).toLowerCase()] = String(value);
    });
    return output;
  }
  for (const [key, value] of Object.entries(headers)) {
    output[String(key).toLowerCase()] = String(value);
  }
  return output;
}

function errorDetails(error) {
  if (!error) return null;
  return {
    name: error.name ?? null,
    message: error.message ?? String(error),
    code: error.code ?? null,
    errno: error.errno ?? null,
    syscall: error.syscall ?? null,
    stack: error.stack ?? null,
  };
}

function boundedDuration(value, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
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
