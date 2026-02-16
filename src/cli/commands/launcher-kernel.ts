import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { Command } from 'commander';

import { LOCAL_HOSTS } from '../../constants/index.js';
import { encodeClockClientApiKey } from '../../utils/clock-client-token.js';
import { logProcessLifecycle } from '../../utils/process-lifecycle-logger.js';

// Import from new launcher submodules
import type {
  Spinner,
  LoggerLike,
  LauncherCommandContext,
  LauncherCommandOptions,
  LauncherSpec,
  ResolvedServerConnection,
  ClockClientService,
  ManagedTmuxSession,
  TmuxSelfHealPolicy
} from './launcher/types.js';
import {
  resolveBinary,
  parseServerUrl,
  resolveTmuxSelfHealPolicy,
  readConfigApiKey,
  normalizeConnectHost,
  toIntegerPort,
  tryReadConfigHostPort,
  resolveIntFromEnv
} from './launcher/utils.js';

// Re-export for backward compatibility
export type {
  Spinner,
  LoggerLike,
  LauncherCommandContext,
  LauncherCommandOptions,
  LauncherSpec,
  ResolvedServerConnection,
  ClockClientService,
  ManagedTmuxSession,
  TmuxSelfHealPolicy
} from './launcher/types.js';

function resolveServerConnection(
  ctx: LauncherCommandContext,
  fsImpl: typeof fs,
  pathImpl: typeof path,
  options: LauncherCommandOptions
): ResolvedServerConnection {
  let configPath = typeof options.config === 'string' && options.config.trim() ? options.config.trim() : '';
  if (!configPath) {
    configPath = pathImpl.join(ctx.homedir(), '.routecodex', 'config.json');
  }

  let actualProtocol: 'http' | 'https' = 'http';
  let actualPort = toIntegerPort(options.port);
  let actualHost = typeof options.host === 'string' && options.host.trim() ? options.host.trim() : LOCAL_HOSTS.ANY;
  let actualBasePath = '';

  if (typeof options.url === 'string' && options.url.trim()) {
    const parsed = parseServerUrl(options.url);
    actualProtocol = parsed.protocol;
    actualHost = parsed.host || actualHost;
    actualPort = parsed.port ?? actualPort;
    actualBasePath = parsed.basePath;
  }

  if (!(typeof options.url === 'string' && options.url.trim())) {
    if (!actualPort) {
      const configMaybe = tryReadConfigHostPort(fsImpl, configPath);
      if (configMaybe.port) {
        actualPort = configMaybe.port;
      }
      if (configMaybe.host) {
        actualHost = configMaybe.host;
      }
    }

    if (!actualPort) {
      const envPort = toIntegerPort(ctx.env.ROUTECODEX_PORT || ctx.env.RCC_PORT);
      if (envPort) {
        actualPort = envPort;
      }
    }

    if (!actualPort && ctx.isDevPackage) {
      actualPort = ctx.defaultDevPort;
      ctx.logger.info(`Using dev default port ${actualPort} for routecodex launcher mode`);
    }
  }

  if (!(typeof options.url === 'string' && options.url.trim()) && !actualPort) {
    throw new Error('Invalid or missing port configuration for RouteCodex server');
  }

  const configuredApiKey =
    (typeof options.apikey === 'string' && options.apikey.trim() ? options.apikey.trim() : null) ??
    (typeof ctx.env.ROUTECODEX_APIKEY === 'string' && ctx.env.ROUTECODEX_APIKEY.trim()
      ? ctx.env.ROUTECODEX_APIKEY.trim()
      : null) ??
    (typeof ctx.env.RCC_APIKEY === 'string' && ctx.env.RCC_APIKEY.trim() ? ctx.env.RCC_APIKEY.trim() : null) ??
    readConfigApiKey(fsImpl, configPath);

  const connectHost = normalizeConnectHost(actualHost);
  const portPart = actualPort ? `:${actualPort}` : '';
  const serverUrl = `${actualProtocol}://${connectHost}${portPart}${actualBasePath}`;

  return {
    configPath,
    protocol: actualProtocol,
    host: actualHost,
    connectHost,
    port: actualPort as number,
    basePath: actualBasePath,
    portPart,
    serverUrl,
    configuredApiKey
  };
}

async function checkServerReady(
  ctx: LauncherCommandContext,
  serverUrl: string,
  apiKey: string | null,
  timeoutMs = 2500
): Promise<boolean> {
  try {
    const headers = apiKey ? { 'x-api-key': apiKey } : undefined;

    const probe = async (pathSuffix: '/ready' | '/health'): Promise<{ ok: boolean; body: any | null }> => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await ctx.fetch(`${serverUrl}${pathSuffix}`, {
          signal: controller.signal,
          method: 'GET',
          headers
        }).catch(() => null);
        if (!response || !response.ok) {
          return { ok: false, body: null };
        }
        const body = await response.json().catch(() => null);
        return { ok: true, body };
      } finally {
        clearTimeout(timeoutId);
      }
    };

    const readyProbe = await probe('/ready');
    if (readyProbe.ok) {
      const status = typeof readyProbe.body?.status === 'string' ? readyProbe.body.status : '';
      if (status.toLowerCase() === 'ready' || readyProbe.body?.ready === true) {
        return true;
      }
    }

    const healthProbe = await probe('/health');
    if (!healthProbe.ok) {
      return false;
    }
    const status = typeof healthProbe.body?.status === 'string' ? healthProbe.body.status.toLowerCase() : '';
    return status === 'ok' || status === 'ready' || healthProbe.body?.ready === true || healthProbe.body?.pipelineReady === true;
  } catch {
    return false;
  }
}

function rotateLogFile(fsImpl: typeof fs, filePath: string, maxBytes = 8 * 1024 * 1024, maxBackups = 3): void {
  try {
    if (!fsImpl.existsSync(filePath)) {
      return;
    }
    const stat = fsImpl.statSync(filePath);
    if (!stat.isFile() || stat.size < maxBytes) {
      return;
    }

    for (let index = maxBackups - 1; index >= 1; index--) {
      const from = `${filePath}.${index}`;
      const to = `${filePath}.${index + 1}`;
      try {
        if (fsImpl.existsSync(from)) {
          if (fsImpl.existsSync(to)) {
            fsImpl.unlinkSync(to);
          }
          fsImpl.renameSync(from, to);
        }
      } catch {
        // ignore
      }
    }

    const firstBackup = `${filePath}.1`;
    if (fsImpl.existsSync(firstBackup)) {
      try {
        fsImpl.unlinkSync(firstBackup);
      } catch {
        // ignore
      }
    }
    fsImpl.renameSync(filePath, firstBackup);
  } catch {
    // ignore rotation failures
  }
}

function ensureServerLogPath(ctx: LauncherCommandContext, fsImpl: typeof fs, pathImpl: typeof path, port: number): string {
  const logsDir = pathImpl.join(ctx.homedir(), '.routecodex', 'logs');
  fsImpl.mkdirSync(logsDir, { recursive: true });
  const logPath = pathImpl.join(logsDir, `server-${port}.log`);
  rotateLogFile(fsImpl, logPath);
  return logPath;
}

async function ensureServerReady(
  ctx: LauncherCommandContext,
  fsImpl: typeof fs,
  pathImpl: typeof path,
  spinner: Spinner,
  options: LauncherCommandOptions,
  resolved: ResolvedServerConnection
): Promise<{ started: boolean; logPath?: string }> {
  const alreadyReady = await checkServerReady(ctx, resolved.serverUrl, resolved.configuredApiKey);
  if (alreadyReady) {
    return { started: false };
  }

  const hasExplicitUrl = typeof options.url === 'string' && options.url.trim().length > 0;
  if (hasExplicitUrl) {
    throw new Error('RouteCodex server is not reachable with --url; auto-start is disabled for explicit URLs');
  }

  spinner.info('RouteCodex server is not running, starting it in background...');
  const logPath = ensureServerLogPath(ctx, fsImpl, pathImpl, resolved.port);

  const logFd = fsImpl.openSync(logPath, 'a');
  const env = {
    ...ctx.env,
    ROUTECODEX_CONFIG: resolved.configPath,
    ROUTECODEX_CONFIG_PATH: resolved.configPath,
    ROUTECODEX_PORT: String(resolved.port),
    RCC_PORT: String(resolved.port)
  } as NodeJS.ProcessEnv;

  logProcessLifecycle({
    event: 'detached_spawn',
    source: 'cli.launcher.ensureServerReady',
    details: {
      role: 'routecodex-server',
      result: 'attempt',
      port: resolved.port,
      command: ctx.nodeBin,
      args: [ctx.resolveServerEntryPath(), ctx.getModulesConfigPath()],
      logPath
    }
  });

  try {
    try {
      const serverProcess = ctx.spawn(ctx.nodeBin, [ctx.resolveServerEntryPath(), ctx.getModulesConfigPath()], {
        stdio: ['ignore', logFd, logFd],
        env,
        detached: true
      });
      logProcessLifecycle({
        event: 'detached_spawn',
        source: 'cli.launcher.ensureServerReady',
        details: {
          role: 'routecodex-server',
          result: 'success',
          port: resolved.port,
          command: ctx.nodeBin,
          args: [ctx.resolveServerEntryPath(), ctx.getModulesConfigPath()],
          childPid: serverProcess.pid ?? null,
          logPath
        }
      });
      const onChildError = (error: unknown) => {
        logProcessLifecycle({
          event: 'detached_spawn',
          source: 'cli.launcher.ensureServerReady',
          details: {
            role: 'routecodex-server',
            result: 'failed',
            port: resolved.port,
            command: ctx.nodeBin,
            args: [ctx.resolveServerEntryPath(), ctx.getModulesConfigPath()],
            childPid: serverProcess.pid ?? null,
            logPath,
            error
          }
        });
      };
      if (typeof (serverProcess as { once?: unknown }).once === 'function') {
        (serverProcess as { once: (event: string, listener: (error: unknown) => void) => void }).once('error', onChildError);
      } else if (typeof (serverProcess as { on?: unknown }).on === 'function') {
        (serverProcess as { on: (event: string, listener: (error: unknown) => void) => void }).on('error', onChildError);
      }
      try {
        serverProcess.unref?.();
      } catch {
        // ignore
      }
    } catch (error) {
      logProcessLifecycle({
        event: 'detached_spawn',
        source: 'cli.launcher.ensureServerReady',
        details: {
          role: 'routecodex-server',
          result: 'failed',
          port: resolved.port,
          command: ctx.nodeBin,
          args: [ctx.resolveServerEntryPath(), ctx.getModulesConfigPath()],
          logPath,
          error
        }
      });
      throw error;
    }
  } finally {
    try {
      fsImpl.closeSync(logFd);
    } catch {
      // ignore
    }
  }

  spinner.text = 'Waiting for RouteCodex server to become ready...';
  for (let attempt = 0; attempt < 45; attempt++) {
    await ctx.sleep(1000);
    const ready = await checkServerReady(ctx, resolved.serverUrl, resolved.configuredApiKey, 1500);
    if (ready) {
      return { started: true, logPath };
    }
  }

  logProcessLifecycle({
    event: 'detached_spawn',
    source: 'cli.launcher.ensureServerReady',
    details: {
      role: 'routecodex-server',
      result: 'not_ready_timeout',
      port: resolved.port,
      logPath
    }
  });

  throw new Error(`RouteCodex server did not become ready in time. Check logs: ${logPath}`);
}

function resolveWorkingDirectory(ctx: LauncherCommandContext, fsImpl: typeof fs, pathImpl: typeof path, requested?: string): string {
  const getCwd = ctx.cwd ?? (() => process.cwd());
  const normalizeRequested = typeof requested === 'string' ? requested.trim() : '';
  if (normalizeRequested) {
    const resolved = pathImpl.resolve(normalizeRequested);
    if (!fsImpl.existsSync(resolved)) {
      throw new Error(`Invalid --cwd: path does not exist: ${resolved}`);
    }
    const stats = fsImpl.statSync(resolved);
    if (!stats || typeof stats.isDirectory !== 'function' || !stats.isDirectory()) {
      throw new Error(`Invalid --cwd: path is not a directory: ${resolved}`);
    }
    return resolved;
  }
  try {
    return pathImpl.resolve(getCwd());
  } catch {
    return getCwd();
  }
}

function isTmuxAvailable(spawnSyncImpl: typeof spawnSync = spawnSync): boolean {
  try {
    const result = spawnSyncImpl('tmux', ['-V'], { encoding: 'utf8' });
    return result.status === 0;
  } catch {
    return false;
  }
}

function resolveCurrentTmuxTarget(env: NodeJS.ProcessEnv, spawnSyncImpl: typeof spawnSync = spawnSync): string | null {
  const tmuxEnv = typeof env.TMUX === 'string' ? env.TMUX.trim() : '';
  if (!tmuxEnv) {
    return null;
  }
  try {
    const result = spawnSyncImpl('tmux', ['display-message', '-p', '#S:#I.#P'], { encoding: 'utf8' });
    if (result.status !== 0) {
      return null;
    }
    const target = String(result.stdout || '').trim();
    return target || null;
  } catch {
    return null;
  }
}

function isReusableTmuxPaneTarget(
  spawnSyncImpl: typeof spawnSync,
  tmuxTarget: string,
  cwd: string
): boolean {
  const normalizedTarget = String(tmuxTarget || '').trim();
  if (!normalizedTarget) {
    return false;
  }
  const expectedCwd = normalizePathForComparison(cwd);
  if (!expectedCwd) {
    return false;
  }
  try {
    const paneResult = spawnSyncImpl(
      'tmux',
      ['list-panes', '-t', normalizedTarget, '-F', '#{pane_current_command}\t#{pane_current_path}'],
      { encoding: 'utf8' }
    );
    if (paneResult.status !== 0) {
      return false;
    }
    const firstLine = String(paneResult.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (!firstLine) {
      return false;
    }
    const [command, panePath] = firstLine.split('\t');
    const normalizedPanePath = normalizePathForComparison(String(panePath || '').trim());
    return isReusableIdlePaneCommand(String(command || '').trim()) && normalizedPanePath === expectedCwd;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${String(value ?? '').replace(/'/g, `'"'"'`)}'`;
}

function buildShellCommand(tokens: string[]): string {
  return tokens.map((token) => shellQuote(token)).join(' ');
}

type EnvDiff = {
  set: Array<[string, string]>;
  unset: string[];
};

function collectChangedEnv(baseEnv: NodeJS.ProcessEnv, nextEnv: NodeJS.ProcessEnv): EnvDiff {
  const set: Array<[string, string]> = [];
  const unset: string[] = [];

  for (const [key, value] of Object.entries(nextEnv)) {
    if (typeof value !== 'string') {
      continue;
    }
    if (baseEnv[key] !== value) {
      set.push([key, value]);
    }
  }

  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value !== 'string') {
      continue;
    }
    if (typeof nextEnv[key] === 'undefined') {
      unset.push(key);
    }
  }

  return { set, unset };
}

function sendTmuxSubmitKey(
  spawnSyncImpl: typeof spawnSync,
  tmuxTarget: string,
  clientType?: string
): { ok: true } | { ok: false; error: string } {
  const type = String(clientType || '').trim().toLowerCase();
  const submitKeys = type === 'codex' || type === 'claude'
    ? ['Enter', 'C-m', 'KPEnter']
    : ['Enter', 'C-m'];
  let lastError = '';
  for (const submitKey of submitKeys) {
    try {
      const result = spawnSyncImpl('tmux', ['send-keys', '-t', tmuxTarget, submitKey], { encoding: 'utf8' });
      if (result.status === 0) {
        return { ok: true };
      }
      lastError =
        String(result.stderr || result.stdout || `tmux send-keys ${submitKey} failed`).trim()
        || `tmux send-keys ${submitKey} failed`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error ?? `tmux send-keys ${submitKey} failed`);
    }
  }
  for (const fallback of ['\r', '\n']) {
    try {
      const literal = spawnSyncImpl('tmux', ['send-keys', '-t', tmuxTarget, '-l', '--', fallback], { encoding: 'utf8' });
      if (literal.status === 0) {
        return { ok: true };
      }
      lastError =
        String(literal.stderr || literal.stdout || 'tmux send-keys literal newline failed').trim()
        || 'tmux send-keys literal newline failed';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error ?? 'tmux send-keys literal newline failed');
    }
  }
  return { ok: false, error: lastError || 'tmux send-keys submit failed' };
}

function isReusableIdlePaneCommand(command: string): boolean {
  const normalized = String(command || '').trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return normalized === 'zsh'
    || normalized === 'bash'
    || normalized === 'sh'
    || normalized === 'fish'
    || normalized === 'nu';
}

function normalizeSessionToken(value: string): string {
  return String(value || '').replace(/[^a-zA-Z0-9_-]+/g, '_') || 'launcher';
}

function normalizePathForComparison(candidate: string): string {
  const raw = String(candidate || '').trim();
  if (!raw) {
    return '';
  }
  try {
    const resolved = path.resolve(raw).replace(/[\\/]+$/, '');
    if (process.platform === 'win32') {
      return resolved.toLowerCase();
    }
    return resolved;
  } catch {
    return raw;
  }
}

function findReusableManagedTmuxSession(
  spawnSyncImpl: typeof spawnSync,
  cwd: string,
  commandName: string
): { sessionName: string; tmuxTarget: string } | null {
  const expectedCwd = normalizePathForComparison(cwd);
  const expectedSessionPrefix = `rcc_${normalizeSessionToken(commandName)}_`;
  try {
    const listResult = spawnSyncImpl('tmux', ['list-sessions', '-F', '#S	#{session_attached}'], { encoding: 'utf8' });
    if (listResult.status !== 0) {
      return null;
    }

    const lines = String(listResult.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      const [sessionName, attachedFlag] = line.split('	');
      const normalizedName = String(sessionName || '').trim();
      if (!normalizedName.startsWith(expectedSessionPrefix)) {
        continue;
      }
      if (String(attachedFlag || '').trim() === '1') {
        continue;
      }

      const panesResult = spawnSyncImpl(
        'tmux',
        [
          'list-panes',
          '-t',
          normalizedName,
          '-F',
          '#{session_name}:#{window_index}.#{pane_index}	#{pane_current_command}	#{pane_current_path}'
        ],
        { encoding: 'utf8' }
      );
      if (panesResult.status !== 0) {
        continue;
      }

      const panes = String(panesResult.stdout || '')
        .split(/\r?\n/)
        .map((paneLine) => paneLine.trim())
        .filter(Boolean);

      for (const pane of panes) {
        const [target, command, panePath] = pane.split('	');
        const tmuxTarget = String(target || '').trim();
        const currentCommand = String(command || '').trim().toLowerCase();
        const normalizedPanePath = normalizePathForComparison(String(panePath || '').trim());
        if (!tmuxTarget) {
          continue;
        }
        if (!isReusableIdlePaneCommand(currentCommand)) {
          continue;
        }
        if (!normalizedPanePath || normalizedPanePath !== expectedCwd) {
          continue;
        }
        return { sessionName: normalizedName, tmuxTarget };
      }
    }

    return null;
  } catch {
    return null;
  }
}

function createManagedTmuxSession(args: {
  spawnSyncImpl: typeof spawnSync;
  cwd: string;
  commandName: string;
}): ManagedTmuxSession | null {
  const { spawnSyncImpl, cwd, commandName } = args;

  const reusable = findReusableManagedTmuxSession(spawnSyncImpl, cwd, commandName);
  if (reusable) {
    return {
      sessionName: reusable.sessionName,
      tmuxTarget: reusable.tmuxTarget,
      reused: true,
      stop: () => {
        try {
          spawnSyncImpl('tmux', ['kill-session', '-t', reusable.sessionName], { encoding: 'utf8' });
        } catch {
          // ignore
        }
      }
    };
  }

  const sessionName = (() => {
    const token = normalizeSessionToken(commandName);
    return `rcc_${token}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  })();

  try {
    const result = spawnSyncImpl('tmux', ['new-session', '-d', '-s', sessionName, '-c', cwd], { encoding: 'utf8' });
    if (result.status !== 0) {
      return null;
    }
  } catch {
    return null;
  }

  const tmuxTarget = `${sessionName}:0.0`;
  return {
    sessionName,
    tmuxTarget,
    reused: false,
    stop: () => {
      try {
        spawnSyncImpl('tmux', ['kill-session', '-t', sessionName], { encoding: 'utf8' });
      } catch {
        // ignore
      }
    }
  };
}

function launchCommandInTmuxPane(args: {
  spawnSyncImpl: typeof spawnSync;
  tmuxTarget: string;
  cwd: string;
  command: string;
  commandName: string;
  commandArgs: string[];
  envOverrides: EnvDiff;
  selfHealPolicy: TmuxSelfHealPolicy;
}): boolean {
  const { spawnSyncImpl, tmuxTarget, cwd, command, commandName, commandArgs, envOverrides, selfHealPolicy } = args;
  const envTokens = [
    ...envOverrides.unset.flatMap((key) => ['-u', key]),
    ...envOverrides.set.map(([key, value]) => `${key}=${value}`)
  ];
  const baseCommand = buildShellCommand(['env', ...envTokens, command, ...commandArgs]);
  // Keep the managed tmux session alive when the client process exits.
  // Session cleanup is handled by managed heartbeat/reaper logic, not by inline shell self-kill.
  const shellCommand = (() => {
    if (!selfHealPolicy.enabled || selfHealPolicy.maxRetries <= 0) {
      return `cd -- ${shellQuote(cwd)} && ${baseCommand}`;
    }
    const safeCommandName = shellQuote(commandName || command || 'client');
    const loopBody = [
      `${baseCommand}`,
      '__rcc_exit=$?',
      'if [ "$__rcc_exit" -eq 0 ] || [ "$__rcc_exit" -eq 130 ] || [ "$__rcc_exit" -eq 143 ]; then exit "$__rcc_exit"; fi',
      'if [ "$__rcc_try" -ge "$__rcc_max" ]; then exit "$__rcc_exit"; fi',
      '__rcc_try=$((__rcc_try + 1))',
      `echo "[routecodex][self-heal] ${safeCommandName} exited with code $__rcc_exit; retry $__rcc_try/$__rcc_max in $__rcc_delay s" >&2`,
      'sleep "$__rcc_delay"'
    ].join('; ');
    return [
      `cd -- ${shellQuote(cwd)} || exit 1`,
      '__rcc_try=0',
      `__rcc_max=${selfHealPolicy.maxRetries}`,
      `__rcc_delay=${selfHealPolicy.retryDelaySec}`,
      `while true; do ${loopBody}; done`
    ].join('; ');
  })();
  try {
    // Prefer respawn-pane for deterministic execution in managed sessions.
    // This avoids flaky "typed but not submitted" behavior from send-keys on some terminals.
    const respawn = spawnSyncImpl('tmux', ['respawn-pane', '-k', '-t', tmuxTarget, shellCommand], { encoding: 'utf8' });
    if (respawn.status === 0) {
      return true;
    }
  } catch {
    // fallback to send-keys injection
  }
  try {
    // Best-effort exit copy-mode before injecting and submitting shell command.
    spawnSyncImpl('tmux', ['send-keys', '-t', tmuxTarget, '-X', 'cancel'], { encoding: 'utf8' });
    // Reset any stale partially-typed command in reusable panes before injecting.
    // This prevents duplicated/concatenated command lines when previous launches failed to submit.
    spawnSyncImpl('tmux', ['send-keys', '-t', tmuxTarget, 'C-u'], { encoding: 'utf8' });
    const literal = spawnSyncImpl('tmux', ['send-keys', '-t', tmuxTarget, '-l', '--', shellCommand], { encoding: 'utf8' });
    if (literal.status !== 0) {
      return false;
    }
    const submit = sendTmuxSubmitKey(spawnSyncImpl, tmuxTarget, commandName);
    return submit.ok;
  } catch {
    return false;
  }
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        resolve(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(body);
}

async function startClockClientService(args: {
  ctx: LauncherCommandContext;
  resolved: ResolvedServerConnection;
  workdir: string;
  tmuxTarget: string | null;
  spawnSyncImpl: typeof spawnSync;
  clientType: string;
  managedTmuxSession: boolean;
  getManagedProcessState?: () => {
    managedClientProcess?: boolean;
    managedClientPid?: number | null;
    managedClientCommandHint?: string;
  };
}): Promise<ClockClientService | null> {
  const {
    ctx,
    resolved,
    workdir,
    tmuxTarget,
    spawnSyncImpl,
    clientType,
    managedTmuxSession,
    getManagedProcessState
  } = args;

  const daemonId = (() => {
    try {
      return `clockd_${crypto.randomUUID()}`;
    } catch {
      return `clockd_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    }
  })();

  const normalizedTmuxTarget = String(tmuxTarget || '').trim();
  const tmuxSessionId = (() => {
    if (!normalizedTmuxTarget) {
      return daemonId;
    }
    const idx = normalizedTmuxTarget.indexOf(':');
    const candidate = (idx >= 0 ? normalizedTmuxTarget.slice(0, idx) : normalizedTmuxTarget).trim();
    return candidate || daemonId;
  })();

  let server: ReturnType<typeof createServer> | null = null;
  let callbackUrl = 'http://127.0.0.1:0/inject';

  if (normalizedTmuxTarget) {
    server = createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/inject') {
        sendJson(res, 404, { ok: false, message: 'not_found' });
        return;
      }
      const body = await readJsonBody(req);
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) {
        sendJson(res, 400, { ok: false, message: 'text is required' });
        return;
      }
      try {
        const literal = spawnSyncImpl('tmux', ['send-keys', '-t', normalizedTmuxTarget, '-l', '--', text], { encoding: 'utf8' });
        if (literal.status !== 0) {
          sendJson(res, 500, {
            ok: false,
            message: String(literal.stderr || literal.stdout || 'tmux send-keys failed').trim() || 'tmux send-keys failed'
          });
          return;
        }
        await ctx.sleep(80);
        const submit = sendTmuxSubmitKey(spawnSyncImpl, normalizedTmuxTarget, clientType);
        if (!submit.ok) {
          sendJson(res, 500, {
            ok: false,
            message: submit.error
          });
          return;
        }
        sendJson(res, 200, { ok: true, tmuxTarget: normalizedTmuxTarget });
      } catch (error) {
        sendJson(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error ?? 'unknown') });
      }
    });

    const port = await new Promise<number>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => {
        const address = server?.address();
        if (!address || typeof address === 'string') {
          reject(new Error('failed to resolve clock daemon callback address'));
          return;
        }
        resolve(address.port);
      });
    }).catch(() => 0);

    if (!port) {
      try {
        server.close();
      } catch {
        // ignore
      }
      return null;
    }

    callbackUrl = `http://127.0.0.1:${port}/inject`;
  }

  const controlUrl = `${resolved.protocol}://127.0.0.1:${resolved.port}${resolved.basePath}`;

  const normalizeManagedProcessPayload = (): Record<string, unknown> => {
    const state = typeof getManagedProcessState === 'function' ? getManagedProcessState() : undefined;
    const managedClientProcess = state?.managedClientProcess === true;
    const managedClientPid = typeof state?.managedClientPid === 'number' && Number.isFinite(state.managedClientPid) && state.managedClientPid > 0
      ? Math.floor(state.managedClientPid)
      : undefined;
    const managedClientCommandHint = typeof state?.managedClientCommandHint === 'string' && state.managedClientCommandHint.trim()
      ? state.managedClientCommandHint.trim()
      : undefined;

    return {
      ...(managedClientProcess ? { managedClientProcess: true } : {}),
      ...(managedClientPid ? { managedClientPid } : {}),
      ...(managedClientCommandHint ? { managedClientCommandHint } : {})
    };
  };

  const post = async (
    pathSuffix: string,
    payload: Record<string, unknown>
  ): Promise<{ ok: boolean; status: number }> => {
    try {
      const response = await ctx.fetch(`${controlUrl}${pathSuffix}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      return { ok: response.ok, status: response.status };
    } catch {
      return { ok: false, status: 0 };
    }
  };

  const reRegisterBackoffMs = resolveIntFromEnv(
    ctx.env.ROUTECODEX_CLOCK_CLIENT_REREGISTER_BACKOFF_MS ?? ctx.env.RCC_CLOCK_CLIENT_REREGISTER_BACKOFF_MS,
    1500,
    200,
    60_000
  );
  let registerInFlight: Promise<boolean> | null = null;
  let lastRegisterAttemptAtMs = 0;

  const registerDaemon = async (): Promise<boolean> => {
    if (registerInFlight) {
      return await registerInFlight;
    }
    registerInFlight = (async () => {
      lastRegisterAttemptAtMs = Date.now();
      const result = await post('/daemon/clock-client/register', {
        daemonId,
        tmuxSessionId,
        sessionId: tmuxSessionId,
        workdir,
        clientType,
        ...(normalizedTmuxTarget ? { tmuxTarget: normalizedTmuxTarget } : {}),
        managedTmuxSession,
        callbackUrl,
        ...normalizeManagedProcessPayload()
      });
      return result.ok;
    })();
    try {
      return await registerInFlight;
    } finally {
      registerInFlight = null;
    }
  };

  const syncHeartbeat = async (): Promise<boolean> => {
    const heartbeat = await post('/daemon/clock-client/heartbeat', {
      daemonId,
      tmuxSessionId,
      sessionId: tmuxSessionId,
      workdir,
      managedTmuxSession,
      ...normalizeManagedProcessPayload()
    });
    if (heartbeat.ok) {
      return true;
    }
    const shouldReRegister =
      heartbeat.status === 404
      || heartbeat.status === 410
      || heartbeat.status === 0
      || heartbeat.status >= 500;
    if (!shouldReRegister) {
      return false;
    }
    const allowImmediateReRegister = heartbeat.status === 404 || heartbeat.status === 410;
    if (!allowImmediateReRegister && Date.now() - lastRegisterAttemptAtMs < reRegisterBackoffMs) {
      return false;
    }
    return await registerDaemon();
  };

  const registered = await registerDaemon();

  if (!registered) {
    if (server) {
      try {
        server.close();
      } catch {
        // ignore
      }
    }
    return null;
  }

  const heartbeat = setInterval(() => {
    void syncHeartbeat();
  }, 10_000);
  heartbeat.unref?.();

  return {
    daemonId,
    tmuxSessionId,
    ...(normalizedTmuxTarget ? { tmuxTarget: normalizedTmuxTarget } : {}),
    syncHeartbeat,
    stop: async () => {
      clearInterval(heartbeat);
      await post('/daemon/clock-client/unregister', { daemonId });
      if (!server) {
        return;
      }
      await new Promise<void>((resolve) => {
        try {
          server?.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }
  };
}


function collectPassThroughArgs(args: {
  rawArgv: string[];
  commandName: string;
  knownOptions: Set<string>;
  requiredValueOptions: Set<string>;
  extraArgsFromCommander: string[];
}): string[] {
  const { rawArgv, commandName, knownOptions, requiredValueOptions, extraArgsFromCommander } = args;

  const indexCommand = rawArgv.findIndex((token) => token === commandName);
  const afterCommand = indexCommand >= 0 ? rawArgv.slice(indexCommand + 1) : [];
  const separatorIndex = afterCommand.indexOf('--');
  const tail = separatorIndex >= 0 ? afterCommand.slice(separatorIndex + 1) : afterCommand;

  const passThrough: string[] = [];
  for (let index = 0; index < tail.length; index++) {
    const token = tail[index];
    if (knownOptions.has(token)) {
      if (requiredValueOptions.has(token)) {
        index += 1;
      }
      continue;
    }
    if (token.startsWith('--')) {
      const equalIndex = token.indexOf('=');
      if (equalIndex > 2) {
        const optionName = token.slice(0, equalIndex);
        if (knownOptions.has(optionName)) {
          continue;
        }
      }
    }
    passThrough.push(token);
  }

  const merged: string[] = [];
  const seen = new Set<string>();
  const appendUnique = (values: string[]) => {
    for (const value of values) {
      if (!seen.has(value)) {
        seen.add(value);
        merged.push(value);
      }
    }
  };

  appendUnique(extraArgsFromCommander);
  appendUnique(passThrough);
  return merged;
}

function normalizeOpenAiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/v1')) {
    return trimmed;
  }
  return `${trimmed}/v1`;
}

export function createLauncherCommand(program: Command, ctx: LauncherCommandContext, spec: LauncherSpec): void {
  const fsImpl = ctx.fsImpl ?? fs;
  const pathImpl = ctx.pathImpl ?? path;

  const command = program
    .command(spec.commandName)
    .description(spec.description)
    .option('--port <port>', 'RouteCodex server port (overrides config file)')
    .option('-h, --host <host>', 'RouteCodex server host', LOCAL_HOSTS.ANY)
    .option('--url <url>', 'RouteCodex base URL (overrides host/port), e.g. https://proxy.example.com')
    .option('-c, --config <config>', 'RouteCodex configuration file path')
    .option('--apikey <apikey>', 'RouteCodex server apikey (defaults to httpserver.apikey in config when present)')
    .option('--cwd <dir>', `Working directory for ${spec.displayName} (defaults to current shell cwd)`)
    .option('--ensure-server', 'Ensure RouteCodex server is running before launching')
    .option(spec.binaryOptionFlags, spec.binaryOptionDescription, spec.binaryDefault)
    .argument('[extraArgs...]', `Additional args to pass through to ${spec.displayName}`)
    .allowUnknownOption(true)
    .allowExcessArguments(true);

  if (spec.withModelOption) {
    command.option('--model <model>', `Model to use with ${spec.displayName}`);
  }
  if (spec.withProfileOption) {
    command.option('--profile <profile>', `${spec.displayName} profile to use`);
  }

  command.action(async (extraArgs: string[] = [], options: LauncherCommandOptions) => {
    const spinner = await ctx.createSpinner(`Preparing ${spec.displayName} with RouteCodex...`);

    try {
      const resolved = resolveServerConnection(ctx, fsImpl, pathImpl, options);
      const ensureResult = await ensureServerReady(ctx, fsImpl, pathImpl, spinner, options, resolved);

      spinner.text = `Launching ${spec.displayName}...`;

      const baseUrl = `${resolved.protocol}://${resolved.connectHost}${resolved.portPart}${resolved.basePath}`;
      const currentCwd = resolveWorkingDirectory(ctx, fsImpl, pathImpl, options.cwd);

      const spawnSyncImpl = ctx.spawnSyncImpl ?? spawnSync;
      const tmuxSelfHealPolicy = resolveTmuxSelfHealPolicy(ctx.env);

      const toolArgs: string[] = spec.buildArgs(options);

      const knownOptions = new Set<string>([
        '--port',
        '-h',
        '--host',
        '--url',
        '-c',
        '--config',
        '--apikey',
        '--cwd',
        '--ensure-server',
        ...spec.extraKnownOptions
      ]);
      const requiredValueOptions = new Set<string>([
        '--port',
        '-h',
        '--host',
        '--url',
        '-c',
        '--config',
        '--apikey',
        '--cwd',
        ...spec.extraKnownOptions
      ]);

      const passThroughArgs = collectPassThroughArgs({
        rawArgv: Array.isArray(ctx.rawArgv) ? ctx.rawArgv : [],
        commandName: spec.commandName,
        knownOptions,
        requiredValueOptions,
        extraArgsFromCommander: Array.isArray(extraArgs) ? extraArgs : []
      });

      if (passThroughArgs.length) {
        toolArgs.push(...passThroughArgs);
      }

      const binaryCandidate = (() => {
        const fromOption = String(options[spec.binaryOptionName] ?? '').trim();
        if (fromOption) {
          return fromOption;
        }
        if (spec.binaryEnvKey) {
          const fromEnv = String(ctx.env[spec.binaryEnvKey] || '').trim();
          if (fromEnv) {
            return fromEnv;
          }
        }
        return spec.binaryDefault;
      })();

      const resolvedBinary = resolveBinary({
        fsImpl,
        pathImpl,
        homedir: ctx.homedir,
        command: binaryCandidate
      });

      let managedTmuxSession: ManagedTmuxSession | null = null;
      const tmuxEnabled = isTmuxAvailable(spawnSyncImpl);
      if (!tmuxEnabled) {
        ctx.logger.warning('[clock-advanced] tmux not found; advanced clock client service disabled (launcher will continue).');
      }
      let tmuxTarget = tmuxEnabled ? resolveCurrentTmuxTarget(ctx.env, spawnSyncImpl) : null;
      if (tmuxTarget && !isReusableTmuxPaneTarget(spawnSyncImpl, tmuxTarget, currentCwd)) {
        tmuxTarget = null;
      }
      if (tmuxEnabled && !tmuxTarget) {
        managedTmuxSession = createManagedTmuxSession({
          spawnSyncImpl,
          cwd: currentCwd,
          commandName: spec.commandName
        });
        if (managedTmuxSession) {
          tmuxTarget = managedTmuxSession.tmuxTarget;
          if (managedTmuxSession.reused) {
            ctx.logger.info('[clock-advanced] reused existing managed tmux session and rebound launcher automatically.');
          } else {
            ctx.logger.info('[clock-advanced] started managed tmux session automatically; no manual tmux setup needed.');
          }
        } else {
          ctx.logger.warning('[clock-advanced] failed to start managed tmux session; launcher continues without advanced mode.');
        }
      }

      const managedClientProcessEnabled = !managedTmuxSession;
      let managedClientPid: number | null = null;
      const managedClientCommandHint = managedClientProcessEnabled ? resolvedBinary : undefined;

      const reclaimRequiredRaw = String(
        ctx.env.ROUTECODEX_CLOCK_RECLAIM_REQUIRED
          ?? ctx.env.RCC_CLOCK_RECLAIM_REQUIRED
          ?? '1'
      )
        .trim()
        .toLowerCase();
      const reclaimRequired = reclaimRequiredRaw !== '0' && reclaimRequiredRaw !== 'false' && reclaimRequiredRaw !== 'no';

      const clockClientService = await startClockClientService({
        ctx,
        resolved,
        workdir: currentCwd,
        tmuxTarget,
        spawnSyncImpl,
        clientType: spec.commandName,
        managedTmuxSession: Boolean(managedTmuxSession),
        getManagedProcessState: () => ({
          managedClientProcess: managedClientProcessEnabled,
          managedClientPid,
          managedClientCommandHint
        })
      });
      if (managedClientProcessEnabled && reclaimRequired && !clockClientService) {
        throw new Error('clock client registration failed for managed child process; aborting launch to avoid orphan process');
      }
      if (tmuxTarget && !clockClientService) {
        ctx.logger.warning('[clock-advanced] failed to start clock client daemon service; launcher continues without advanced mode.');
      }

      const clockAdvancedEnabled = Boolean(clockClientService && tmuxTarget);
      const clockClientApiKey = clockAdvancedEnabled && clockClientService
        ? encodeClockClientApiKey(resolved.configuredApiKey || 'rcc-proxy-key', clockClientService.daemonId)
        : (resolved.configuredApiKey || 'rcc-proxy-key');

      const toolEnv = spec.buildEnv({
        env: {
          ...ctx.env,
          PWD: currentCwd,
          RCC_WORKDIR: currentCwd,
          ROUTECODEX_WORKDIR: currentCwd,
          OPENAI_BASE_URL: normalizeOpenAiBaseUrl(baseUrl),
          OPENAI_API_BASE: normalizeOpenAiBaseUrl(baseUrl),
          OPENAI_API_BASE_URL: normalizeOpenAiBaseUrl(baseUrl),
          OPENAI_API_KEY: clockClientApiKey,
          RCC_CLOCK_ADVANCED_ENABLED: clockAdvancedEnabled ? '1' : '0',
          ...(clockAdvancedEnabled && clockClientService
            ? {
              RCC_CLOCK_CLIENT_SESSION_ID: clockClientService.tmuxSessionId,
              RCC_CLOCK_CLIENT_TMUX_SESSION_ID: clockClientService.tmuxSessionId,
              RCC_CLOCK_CLIENT_DAEMON_ID: clockClientService.daemonId
            }
            : {})
        } as NodeJS.ProcessEnv,
        baseUrl,
        configuredApiKey: resolved.configuredApiKey,
        cwd: currentCwd
      });

      const shouldUseShell =
        ctx.isWindows &&
        !pathImpl.extname(resolvedBinary) &&
        !resolvedBinary.includes('/') &&
        !resolvedBinary.includes('\\');

      const toolProcess = (() => {
        if (managedTmuxSession) {
          const envOverrides = collectChangedEnv(ctx.env, toolEnv);
          const launched = launchCommandInTmuxPane({
            spawnSyncImpl,
            tmuxTarget: managedTmuxSession.tmuxTarget,
            cwd: currentCwd,
            command: resolvedBinary,
            commandName: spec.commandName,
            commandArgs: toolArgs,
            envOverrides,
            selfHealPolicy: tmuxSelfHealPolicy
          });
          if (!launched) {
            managedTmuxSession.stop();
            managedTmuxSession = null;
            throw new Error(`Failed to send ${spec.displayName} command to managed tmux session`);
          }
          return ctx.spawn('tmux', ['attach-session', '-t', managedTmuxSession.sessionName], {
            stdio: 'inherit',
            env: ctx.env,
            cwd: currentCwd
          });
        }

        return ctx.spawn(resolvedBinary, toolArgs, {
          stdio: 'inherit',
          env: toolEnv,
          cwd: currentCwd,
          shell: shouldUseShell
        });
      })();

      managedClientPid = typeof toolProcess.pid === 'number' && Number.isFinite(toolProcess.pid)
        ? Math.floor(toolProcess.pid)
        : null;
      if (clockClientService && managedClientProcessEnabled && managedClientPid) {
        void clockClientService.syncHeartbeat();
      }

      spinner.succeed(`${spec.displayName} launched with RouteCodex proxy`);
      if (!managedTmuxSession) {
        ctx.logger.info(`Using RouteCodex server at: ${baseUrl}`);
        ctx.logger.info(`${spec.displayName} binary: ${resolvedBinary}`);
        if (ensureResult.started && ensureResult.logPath) {
          ctx.logger.info(`RouteCodex auto-start logs: ${ensureResult.logPath}`);
        }
        ctx.logger.info(`Working directory for ${spec.displayName}: ${currentCwd}`);
        ctx.logger.info(`Press Ctrl+C to exit ${spec.displayName}`);
      }

      const shutdown = async (signal: NodeJS.Signals) => {
        try {
          toolProcess.kill(signal);
        } catch {
          // ignore
        }
        try {
          await clockClientService?.stop();
        } catch {
          // ignore
        }
        try {
          managedTmuxSession?.stop();
        } catch {
          // ignore
        }
        ctx.exit(0);
      };

      const onSignal = ctx.onSignal ?? ((signal: NodeJS.Signals, cb: () => void) => process.on(signal, cb));
      onSignal('SIGINT', () => {
        void shutdown('SIGINT');
      });
      onSignal('SIGTERM', () => {
        void shutdown('SIGTERM');
      });

      toolProcess.on('error', (error) => {
        void (async () => {
          try {
            ctx.logger.error(
              `Failed to launch ${spec.displayName} (${resolvedBinary}): ${error instanceof Error ? error.message : String(error)}`
            );
          } catch {
            // ignore
          }
          try {
            await clockClientService?.stop();
          } catch {
            // ignore
          }
          try {
            managedTmuxSession?.stop();
          } catch {
            // ignore
          }
          ctx.exit(1);
        })();
      });

      toolProcess.on('exit', (code, signal) => {
        void (async () => {
          try {
            await clockClientService?.stop();
          } catch {
            // ignore
          }
          try {
            managedTmuxSession?.stop();
          } catch {
            // ignore
          }
          if (signal) {
            ctx.exit(0);
            return;
          }
          ctx.exit(code ?? 0);
        })();
      });

      await ctx.waitForever();
    } catch (error) {
      spinner.fail(`Failed to launch ${spec.displayName}`);
      ctx.logger.error(error instanceof Error ? error.message : String(error));
      ctx.exit(1);
    }
  });
}

export { normalizeOpenAiBaseUrl };
