import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { Command } from 'commander';

import { LOCAL_HOSTS } from '../../constants/index.js';
import { resolveRccConfigFileForRead, resolveRccLogsDir, resolveRccUserDir } from '../../config/user-data-paths.js';
import {
  encodeSessionClientApiKey,
  extractSessionClientDaemonIdFromApiKey,
  extractSessionClientScopeIdFromApiKey
} from '../../utils/session-client-token.js';
import { isSessionScopeTraceEnabled, isSessionScopeTraceVerbose } from '../../utils/session-scope-trace.js';
import { logProcessLifecycle } from '../../utils/process-lifecycle-logger.js';

// Import from new launcher submodules
import type {
  Spinner,
  LoggerLike,
  LauncherCommandContext,
  LauncherCommandOptions,
  LauncherSpec,
  ResolvedServerConnection,
  SessionClientService,
  ManagedTmuxSession,
  TmuxSelfHealPolicy
} from './launcher/types.js';
import {
  resolveBinary,
  parseServerUrl,
  resolveBoolFromEnv,
  resolveTmuxSelfHealPolicy,
  readConfigApiKey,
  normalizeConnectHost,
  toIntegerPort,
  tryReadConfigHostPort,
  resolveIntFromEnv
} from './launcher/utils.js';
import { resolveRouteCodexConfigPath } from '../../config/config-paths.js';

// Re-export for backward compatibility
export type {
  Spinner,
  LoggerLike,
  LauncherCommandContext,
  LauncherCommandOptions,
  LauncherSpec,
  ResolvedServerConnection,
  SessionClientService,
  ManagedTmuxSession,
  TmuxSelfHealPolicy
} from './launcher/types.js';

function shouldStopManagedTmuxOnShutdown(signal: NodeJS.Signals, env: NodeJS.ProcessEnv): boolean {
  if (signal === 'SIGINT') {
    return true;
  }
  if (signal !== 'SIGTERM') {
    return true;
  }
  return resolveBoolFromEnv(
    env.ROUTECODEX_LAUNCHER_STOP_MANAGED_TMUX_ON_SIGTERM
      ?? env.RCC_LAUNCHER_STOP_MANAGED_TMUX_ON_SIGTERM,
    true
  );
}

function shouldStopManagedTmuxOnToolExit(env: NodeJS.ProcessEnv): boolean {
  return resolveBoolFromEnv(
    env.ROUTECODEX_LAUNCHER_STOP_MANAGED_TMUX_ON_TOOL_EXIT
      ?? env.RCC_LAUNCHER_STOP_MANAGED_TMUX_ON_TOOL_EXIT,
    true
  );
}

function shouldLogClientExitSummary(commandName: string): boolean {
  const normalized = String(commandName || '').trim().toLowerCase();
  return normalized === 'codex' || normalized === 'claude' || normalized === 'routecodex';
}

function resolveExitGracePeriodMs(env: NodeJS.ProcessEnv): number {
  const raw =
    env.ROUTECODEX_CLIENT_EXIT_GRACE_PERIOD_MS
    ?? env.RCC_CLIENT_EXIT_GRACE_PERIOD_MS
    ?? '5000';
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 5000;  // Default to 5s grace period for tools like codex that print session IDs on exit
  }
  return Math.floor(parsed);
}

function resolveLauncherConfigPath(
  ctx: LauncherCommandContext,
  fsImpl: typeof fs,
  pathImpl: typeof path,
  options: LauncherCommandOptions
): string {
  let configPath = typeof options.config === 'string' && options.config.trim() ? options.config.trim() : '';
  if (!configPath) {
    const resolved = resolveRouteCodexConfigPath();
    configPath = resolved && resolved.trim()
      ? resolved
      : resolveRccConfigFileForRead(ctx.homedir());
  }
  return configPath;
}

function resolveLauncherApiKey(
  ctx: LauncherCommandContext,
  fsImpl: typeof fs,
  configPath: string,
  options: LauncherCommandOptions
): string | null {
  const fromOption = typeof options.apikey === 'string' && options.apikey.trim()
    ? options.apikey.trim()
    : null;
  if (fromOption) {
    return fromOption;
  }
  const fromRouteEnv = typeof ctx.env.ROUTECODEX_HTTP_APIKEY === 'string' && ctx.env.ROUTECODEX_HTTP_APIKEY.trim()
    ? ctx.env.ROUTECODEX_HTTP_APIKEY.trim()
    : null;
  if (fromRouteEnv) {
    return fromRouteEnv;
  }
  const fromRccEnv = typeof ctx.env.RCC_HTTP_APIKEY === 'string' && ctx.env.RCC_HTTP_APIKEY.trim()
    ? ctx.env.RCC_HTTP_APIKEY.trim()
    : null;
  if (fromRccEnv) {
    return fromRccEnv;
  }
  return readConfigApiKey(fsImpl, configPath);
}

function readProcessPpidAndCommand(pid: number): { ppid: number | null; command: string } {
  if (process.platform === 'win32') {
    return { ppid: null, command: '' };
  }
  try {
    const out = spawnSync('ps', ['-p', String(pid), '-o', 'ppid=,command='], { encoding: 'utf8' });
    if (out.error || Number(out.status ?? 0) !== 0) {
      return { ppid: null, command: '' };
    }
    const line = String(out.stdout || '')
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find(Boolean);
    if (!line) {
      return { ppid: null, command: '' };
    }
    const match = line.match(/^(\d+)\s+(.+)$/);
    if (!match) {
      return { ppid: null, command: line };
    }
    const ppid = Number.parseInt(match[1], 10);
    return {
      ppid: Number.isFinite(ppid) && ppid > 0 ? ppid : null,
      command: match[2] || ''
    };
  } catch {
    return { ppid: null, command: '' };
  }
}

function commandLikelyMatchesHint(command: string, commandHint: string): boolean {
  const normalizedCommand = String(command || '').toLowerCase();
  const normalizedHint = String(commandHint || '').toLowerCase().trim();
  if (!normalizedHint) {
    return true;
  }
  const hintBase = path.basename(normalizedHint);
  if (hintBase && normalizedCommand.includes(hintBase)) {
    return true;
  }
  const tokens = normalizedHint
    .split(/[\\/\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
  return tokens.some((token) => normalizedCommand.includes(token));
}

function canSignalOwnedToolProcess(args: {
  env: NodeJS.ProcessEnv;
  pid: number | null | undefined;
  expectedParentPid: number;
  commandHint: string;
}): { ok: boolean; reason: string } {
  const strictGuard = resolveBoolFromEnv(
    args.env.ROUTECODEX_LAUNCHER_STRICT_SIGNAL_GUARD ?? args.env.RCC_LAUNCHER_STRICT_SIGNAL_GUARD,
    true
  );
  if (!strictGuard) {
    return { ok: true, reason: 'strict_guard_disabled' };
  }
  if (!args.pid || !Number.isFinite(args.pid) || args.pid <= 1) {
    return { ok: false, reason: 'invalid_pid' };
  }
  if (process.platform === 'win32') {
    return { ok: true, reason: 'unsupported_platform' };
  }
  const snapshot = readProcessPpidAndCommand(args.pid);
  if (!snapshot.ppid) {
    return { ok: false, reason: 'ppid_unavailable' };
  }
  if (snapshot.ppid !== args.expectedParentPid) {
    return { ok: false, reason: 'ppid_mismatch' };
  }
  if (!commandLikelyMatchesHint(snapshot.command, args.commandHint)) {
    return { ok: false, reason: 'command_mismatch' };
  }
  return { ok: true, reason: 'owned_child' };
}

function resolveServerConnection(
  ctx: LauncherCommandContext,
  fsImpl: typeof fs,
  pathImpl: typeof path,
  options: LauncherCommandOptions,
  configPathOverride?: string
): ResolvedServerConnection {
  const configPath = configPathOverride && configPathOverride.trim()
    ? configPathOverride.trim()
    : resolveLauncherConfigPath(ctx, fsImpl, pathImpl, options);

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

  const configuredApiKey = resolveLauncherApiKey(ctx, fsImpl, configPath, options);

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
  const headers = apiKey ? { 'x-api-key': apiKey } : undefined;
  const probeTargets = resolveServerProbeTargets(serverUrl);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (const target of probeTargets) {
      try {
        const healthProbe = await probeServerState(ctx, `${target}/health`, headers, timeoutMs);
        if (healthProbe.ok) {
          const status = typeof healthProbe.body?.status === 'string' ? healthProbe.body.status.toLowerCase() : '';
          if (
            status === 'ok' ||
            status === 'ready' ||
            healthProbe.body?.ready === true ||
            healthProbe.body?.pipelineReady === true ||
            healthProbe.body === null
          ) {
            return true;
          }
        }

        const readyProbe = await probeServerState(ctx, `${target}/ready`, headers, timeoutMs);
        if (readyProbe.ok) {
          const status = typeof readyProbe.body?.status === 'string' ? readyProbe.body.status.toLowerCase() : '';
          if (status === 'ready' || readyProbe.body?.ready === true || readyProbe.body === null) {
            return true;
          }
        }
      } catch {
        // try next target
      }
    }
    if (attempt < 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  return false;
}

function resolveServerProbeTargets(serverUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const pushTarget = (value: string) => {
    const normalized = value.trim().replace(/\/+$/, '');
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    out.push(normalized);
  };

  pushTarget(serverUrl);
  try {
    const parsed = new URL(serverUrl);
    if (parsed.hostname === '0.0.0.0' || parsed.hostname === '::' || parsed.hostname === '::1' || parsed.hostname === 'localhost') {
      const loopback = new URL(serverUrl);
      loopback.hostname = '127.0.0.1';
      pushTarget(loopback.toString());
    }
  } catch {
    // ignore invalid URL parse; keep original
  }
  return out;
}

async function probeServerState(
  ctx: LauncherCommandContext,
  url: string,
  headers: Record<string, string> | undefined,
  timeoutMs: number
): Promise<{ ok: boolean; body: any | null }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await ctx.fetch(url, {
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
  const logsDir = resolveRccLogsDir();
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
  resolved: ResolvedServerConnection,
  allowAutoStartServer: boolean
): Promise<{ started: boolean; ready: boolean; logPath?: string }> {
  const alreadyReady = await checkServerReady(ctx, resolved.serverUrl, resolved.configuredApiKey);
  if (alreadyReady) {
    return { started: false, ready: true };
  }

  if (!allowAutoStartServer) {
    return { started: false, ready: false };
  }

  const hasExplicitUrl = typeof options.url === 'string' && options.url.trim().length > 0;
  if (hasExplicitUrl) {
    throw new Error('RouteCodex server is not reachable with --url; auto-start is disabled for explicit URLs');
  }

  spinner.info('RouteCodex server is not running, starting it in background...');
  const logPath = ensureServerLogPath(ctx, fsImpl, pathImpl, resolved.port);

  const logFd = fsImpl.openSync(logPath, 'a');
  // Launcher auto-started server follows launcher lifecycle by default.
  // This is intentionally different from `routecodex start`, which is persistent by default.
  const bindServerToParent = resolveBoolFromEnv(
    ctx.env.ROUTECODEX_LAUNCHER_SERVER_PARENT_GUARD
      ?? ctx.env.RCC_LAUNCHER_SERVER_PARENT_GUARD
      ?? ctx.env.ROUTECODEX_SERVER_PARENT_GUARD
      ?? ctx.env.RCC_SERVER_PARENT_GUARD,
    true
  );
  const env = {
    ...ctx.env,
    ROUTECODEX_CONFIG: resolved.configPath,
    ROUTECODEX_CONFIG_PATH: resolved.configPath,
    ROUTECODEX_PORT: String(resolved.port),
    RCC_PORT: String(resolved.port),
    ...(bindServerToParent
      ? {
        ROUTECODEX_EXPECT_PARENT_PID: String(process.pid),
        RCC_EXPECT_PARENT_PID: String(process.pid)
      }
      : {})
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
      return { started: true, ready: true, logPath };
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

function inferTmuxSessionIdFromTarget(tmuxTarget: string | null | undefined): string | null {
  const normalized = String(tmuxTarget || '').trim();
  if (!normalized) {
    return null;
  }
  const index = normalized.indexOf(':');
  if (index <= 0) {
    return null;
  }
  const sessionName = normalized.slice(0, index).trim();
  return sessionName || null;
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

function formatHmms(value: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(value.getHours())}${pad(value.getMinutes())}${pad(value.getSeconds())}`;
}

function tmuxSessionExists(spawnSyncImpl: typeof spawnSync, sessionName: string): boolean {
  try {
    const result = spawnSyncImpl('tmux', ['has-session', '-t', sessionName], { encoding: 'utf8' });
    return result.status === 0;
  } catch {
    return false;
  }
}

function buildManagedTmuxSessionName(nowMs: number, attempt: number): string {
  const stamp = formatHmms(new Date(nowMs + attempt * 1000));
  return `rcc-tmux-${stamp}`;
}

function requestManagedTmuxSessionExit(
  spawnSyncImpl: typeof spawnSync,
  sessionName: string
): void {
  const target = String(sessionName || '').trim();
  if (!target) {
    return;
  }
  try {
    spawnSyncImpl('tmux', ['send-keys', '-t', target, '-X', 'cancel'], { encoding: 'utf8' });
  } catch {
    // ignore
  }
  try {
    spawnSyncImpl('tmux', ['send-keys', '-t', target, 'C-c'], { encoding: 'utf8' });
  } catch {
    // ignore
  }
  try {
    spawnSyncImpl('tmux', ['send-keys', '-t', target, '-l', '--', 'exit'], { encoding: 'utf8' });
  } catch {
    // ignore
  }
  try {
    sendTmuxSubmitKey(spawnSyncImpl, target);
  } catch {
    // ignore
  }
}

function createManagedTmuxSession(args: {
  spawnSyncImpl: typeof spawnSync;
  cwd: string;
}): ManagedTmuxSession | null {
  const { spawnSyncImpl, cwd } = args;

  const baseNow = Date.now();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const sessionName = buildManagedTmuxSessionName(baseNow, attempt);
    if (tmuxSessionExists(spawnSyncImpl, sessionName)) {
      continue;
    }
    try {
      const result = spawnSyncImpl('tmux', ['new-session', '-d', '-s', sessionName, '-c', cwd], { encoding: 'utf8' });
      if (result.status !== 0) {
        continue;
      }
    } catch {
      continue;
    }

    const tmuxTarget = `${sessionName}:0.0`;
    return {
      sessionName,
      tmuxTarget,
      reused: false,
      stop: () => {
        requestManagedTmuxSessionExit(spawnSyncImpl, sessionName);
      }
    };
  }

  return null;
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
  const tmuxSessionName = (() => {
    const idx = String(tmuxTarget || '').indexOf(':');
    const name = idx >= 0 ? String(tmuxTarget).slice(0, idx) : String(tmuxTarget || '');
    return name.trim();
  })();
  const envTokens = [
    ...envOverrides.unset.flatMap((key) => ['-u', key]),
    ...envOverrides.set.map(([key, value]) => `${key}=${value}`)
  ];
  const baseCommand = buildShellCommand(['env', ...envTokens, command, ...commandArgs]);
  const commandBody = (() => {
    if (!selfHealPolicy.enabled || selfHealPolicy.maxRetries <= 0) {
      return `cd -- ${shellQuote(cwd)} || exit 1; ${baseCommand}; __rcc_exit=$?`;
    }
    const safeCommandName = shellQuote(commandName || command || 'client');
    const loopBody = [
      `${baseCommand}`,
      '__rcc_exit=$?',
      'if [ "$__rcc_exit" -eq 0 ] || [ "$__rcc_exit" -eq 130 ] || [ "$__rcc_exit" -eq 143 ]; then break; fi',
      'if [ "$__rcc_try" -ge "$__rcc_max" ]; then break; fi',
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
  // Let the client finish rendering its own shutdown output before launcher cleanup
  // asks the managed tmux session to exit from the outside.
  const shellCommand = [
    commandBody,
    'exit "$__rcc_exit"'
  ].join('; ');
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

function normalizeTmuxInjectedText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ')
    .trim();
}

async function startSessionClientService(args: {
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
}): Promise<SessionClientService | null> {
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
      return `sessiond_${crypto.randomUUID()}`;
    } catch {
      return `sessiond_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    }
  })();

  const normalizedTmuxTarget = String(tmuxTarget || '').trim();
  if (!normalizedTmuxTarget) {
    // No tmux target means no reliable stdin injection path.
    // Do not register a session-client daemon with a synthetic session id.
    return null;
  }
  const tmuxSessionId = (() => {
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
      const text = typeof body.text === 'string' ? normalizeTmuxInjectedText(body.text) : '';
      if (!text) {
        sendJson(res, 400, { ok: false, message: 'text is required' });
        return;
      }
      try {
        // Ensure pane is not stuck in copy-mode before literal injection + submit.
        spawnSyncImpl('tmux', ['send-keys', '-t', normalizedTmuxTarget, '-X', 'cancel'], { encoding: 'utf8' });
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
          reject(new Error('failed to resolve session daemon callback address'));
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
  const controlRequestTimeoutMs = resolveIntFromEnv(
    ctx.env.ROUTECODEX_SESSION_CLIENT_CONTROL_TIMEOUT_MS ?? ctx.env.RCC_SESSION_CLIENT_CONTROL_TIMEOUT_MS,
    1500,
    200,
    30_000
  );
  const controlApiKey = resolved.configuredApiKey
    ? encodeSessionClientApiKey(resolved.configuredApiKey, daemonId, tmuxSessionId)
    : '';

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
    const abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutHandle = abortController
      ? setTimeout(() => {
          try {
            abortController.abort();
          } catch {
            // ignore abort failures
          }
        }, controlRequestTimeoutMs)
      : null;
    if (timeoutHandle && typeof (timeoutHandle as NodeJS.Timeout).unref === 'function') {
      (timeoutHandle as NodeJS.Timeout).unref();
    }
    try {
      const response = await ctx.fetch(`${controlUrl}${pathSuffix}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(controlApiKey ? { 'x-api-key': controlApiKey } : {})
        },
        body: JSON.stringify(payload),
        ...(abortController ? { signal: abortController.signal } : {})
      });
      return { ok: response.ok, status: response.status };
    } catch {
      return { ok: false, status: 0 };
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  };

  const reRegisterBackoffMs = resolveIntFromEnv(
    ctx.env.ROUTECODEX_SESSION_CLIENT_REREGISTER_BACKOFF_MS ?? ctx.env.RCC_SESSION_CLIENT_REREGISTER_BACKOFF_MS,
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
      const result = await post('/daemon/session-client/register', {
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
    const heartbeat = await post('/daemon/session-client/heartbeat', {
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
      await post('/daemon/session-client/unregister', { daemonId });
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
      const tmuxOnly = spec.commandName === 'codex';
      const configPath = resolveLauncherConfigPath(ctx, fsImpl, pathImpl, options);
      const resolved = tmuxOnly ? undefined : resolveServerConnection(ctx, fsImpl, pathImpl, options, configPath);
      const requireResolved = (): ResolvedServerConnection => {
        if (!resolved) {
          throw new Error('RouteCodex server connection is not available for this launcher');
        }
        return resolved;
      };
      let ensureResult: { ready: boolean; started?: boolean; logPath?: string } | null = null;
      if (!tmuxOnly) {
        const server = requireResolved();
        await ctx.ensureGuardianDaemon?.();
        ensureResult = await ensureServerReady(
          ctx,
          fsImpl,
          pathImpl,
          spinner,
          options,
          server,
          spec.allowAutoStartServer === true
        );
        if (!ensureResult.ready) {
          spinner.info('RouteCodex server is not running; launcher will continue and wait for your next requests.');
        }
      }

      spinner.text = `Launching ${spec.displayName}...`;

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
        ctx.logger.warning('[session-advanced] tmux not found; advanced session client service disabled (launcher will continue).');
      }
      let tmuxTarget: string | null = null;
      if (tmuxEnabled && !tmuxOnly) {
        tmuxTarget = resolveCurrentTmuxTarget(ctx.env, spawnSyncImpl);
      }
      if (tmuxEnabled && (tmuxOnly || !tmuxTarget)) {
        managedTmuxSession = createManagedTmuxSession({
          spawnSyncImpl,
          cwd: currentCwd
        });
        if (managedTmuxSession) {
          tmuxTarget = managedTmuxSession.tmuxTarget;
          ctx.logger.info('[session-advanced] started managed tmux session automatically; no manual tmux setup needed.');
        } else {
          ctx.logger.warning('[session-advanced] failed to start managed tmux session; launcher continues without advanced mode.');
        }
      }

      const managedClientProcessEnabled = !managedTmuxSession;
      let managedClientPid: number | null = null;
      const managedClientCommandHint = managedClientProcessEnabled ? resolvedBinary : undefined;

      const reclaimRequiredRaw = String(
        ctx.env.ROUTECODEX_SESSION_RECLAIM_REQUIRED
          ?? ctx.env.RCC_SESSION_RECLAIM_REQUIRED
          ?? '1'
      )
        .trim()
        .toLowerCase();
      const reclaimRequired = reclaimRequiredRaw !== '0' && reclaimRequiredRaw !== 'false' && reclaimRequiredRaw !== 'no';

      let sessionClientService: SessionClientService | null = null;
      let sessionAdvancedEnabled = false;
      let inferredTmuxSessionId: string | undefined;
      let inferredDaemonId: string | undefined;
      let sessionClientApiKey: string | undefined;
      let tmuxOnlySessionId: string | undefined;
      if (!tmuxOnly) {
        const server = requireResolved();
        sessionClientService = await startSessionClientService({
          ctx,
          resolved: server,
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
        if (managedClientProcessEnabled && reclaimRequired && tmuxTarget && !sessionClientService) {
          throw new Error('session client registration failed for managed child process; aborting launch to avoid orphan process');
        }
        if (tmuxTarget && !sessionClientService) {
          ctx.logger.warning('[session-advanced] failed to start session client daemon service; launcher continues without advanced mode.');
        }

        sessionAdvancedEnabled = Boolean(sessionClientService && tmuxTarget);
        inferredTmuxSessionId =
          sessionClientService?.tmuxSessionId ||
          inferTmuxSessionIdFromTarget(tmuxTarget) ||
          undefined;
        inferredDaemonId =
          sessionClientService?.daemonId ||
          (inferredTmuxSessionId ? `sessiond_unbound_${process.pid}` : undefined);
        sessionClientApiKey =
          inferredTmuxSessionId && inferredDaemonId
            ? encodeSessionClientApiKey(
              server.configuredApiKey || 'rcc-proxy-key',
              inferredDaemonId,
              inferredTmuxSessionId
            )
            : (server.configuredApiKey || 'rcc-proxy-key');
        if (isSessionScopeTraceEnabled()) {
          try {
            const parsedDaemonId = extractSessionClientDaemonIdFromApiKey(sessionClientApiKey) || 'none';
            const parsedTmuxSessionId = extractSessionClientScopeIdFromApiKey(sessionClientApiKey) || 'none';
            const verbose = isSessionScopeTraceVerbose();
            ctx.logger.info(
              `[session-scope][launch] command=${spec.commandName} advanced=${sessionAdvancedEnabled ? 'on' : 'off'} ` +
              `daemon=${parsedDaemonId} tmux=${parsedTmuxSessionId} tmuxTarget=${tmuxTarget || 'none'}` +
              (verbose ? ` managedTmux=${managedTmuxSession ? 'yes' : 'no'} serverStarted=${ensureResult?.started ? 'yes' : 'no'}` : '')
            );
          } catch {
            // best-effort diagnostics only
          }
        }
        await ctx.registerGuardianProcess?.({
          source: spec.commandName,
          pid: process.pid,
          ppid: process.ppid,
          port: server.port,
          tmuxSessionId: sessionClientService?.tmuxSessionId || inferTmuxSessionIdFromTarget(tmuxTarget) || undefined,
          tmuxTarget: tmuxTarget || undefined,
          metadata: {
            workingDirectory: currentCwd,
            binary: resolvedBinary,
            managedTmuxSession: Boolean(managedTmuxSession),
            autoStartedServer: ensureResult?.started === true
          }
        });
      }
      const applyLifecycleOrThrow = async (args: {
        action: string;
        signal?: string;
        targetPid?: number | null;
      }): Promise<void> => {
        if (tmuxOnly || !resolved) {
          return;
        }
        const server = requireResolved();
        const accepted = await ctx.reportGuardianLifecycle?.({
          action: args.action,
          source: `cli.launcher.${spec.commandName}`,
          actorPid: process.pid,
          targetPid: args.targetPid && args.targetPid > 0 ? args.targetPid : undefined,
          signal: args.signal,
          metadata: {
            port: server.port,
            serverUrl: server.serverUrl
          }
        });
        if (ctx.reportGuardianLifecycle && accepted !== true) {
          throw new Error(`guardian lifecycle apply rejected (${args.action})`);
        }
      };

      if (tmuxOnly) {
        const tmuxSessionId = inferTmuxSessionIdFromTarget(tmuxTarget) || '';
        tmuxOnlySessionId = tmuxSessionId || undefined;
      }

      const toolEnv = (() => {
        if (tmuxOnly) {
          const env = { ...ctx.env };
          if (tmuxOnlySessionId) {
            const baseKey = resolveLauncherApiKey(ctx, fsImpl, configPath, options);
            if (!baseKey) {
              throw new Error(
                'Missing apikey for tmux scope. Set --apikey or ROUTECODEX_HTTP_APIKEY/RCC_HTTP_APIKEY or httpserver.apikey in config.'
              );
            }
            const scopedKey = encodeSessionClientApiKey(baseKey, '', tmuxOnlySessionId);
            env.ROUTECODEX_HTTP_APIKEY = scopedKey;
            env.RCC_HTTP_APIKEY = scopedKey;
            env.OPENAI_API_KEY = scopedKey;
            env.ANTHROPIC_AUTH_TOKEN = scopedKey;
          }
          return env;
        }
        const server = requireResolved();
        return spec.buildEnv({
          env: {
            ...ctx.env,
            PWD: currentCwd,
            RCC_WORKDIR: currentCwd,
            ROUTECODEX_WORKDIR: currentCwd,
            OPENAI_BASE_URL: normalizeOpenAiBaseUrl(`${server.protocol}://${server.connectHost}${server.portPart}${server.basePath}`),
            OPENAI_API_BASE: normalizeOpenAiBaseUrl(`${server.protocol}://${server.connectHost}${server.portPart}${server.basePath}`),
            OPENAI_API_BASE_URL: normalizeOpenAiBaseUrl(`${server.protocol}://${server.connectHost}${server.portPart}${server.basePath}`),
            OPENAI_API_KEY: sessionClientApiKey,
            RCC_SESSION_ADVANCED_ENABLED: sessionAdvancedEnabled ? '1' : '0',
            ...(inferredTmuxSessionId
              ? {
                RCC_SESSION_CLIENT_SESSION_ID: inferredTmuxSessionId,
                RCC_SESSION_CLIENT_TMUX_SESSION_ID: inferredTmuxSessionId
              }
              : {}),
            ...(inferredDaemonId
              ? { RCC_SESSION_CLIENT_DAEMON_ID: inferredDaemonId }
              : {})
          } as NodeJS.ProcessEnv,
          baseUrl: `${server.protocol}://${server.connectHost}${server.portPart}${server.basePath}`,
          configuredApiKey: server.configuredApiKey,
          cwd: currentCwd
        });
      })();

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
      if (sessionClientService && managedClientProcessEnabled && managedClientPid) {
        void sessionClientService.syncHeartbeat();
      }

      spinner.succeed(`${spec.displayName} launched with RouteCodex proxy`);
      if (!managedTmuxSession) {
        if (!tmuxOnly) {
          const server = requireResolved();
          ctx.logger.info(`Using RouteCodex server at: ${server.protocol}://${server.connectHost}${server.portPart}${server.basePath}`);
        }
        ctx.logger.info(`${spec.displayName} binary: ${resolvedBinary}`);
        if (!tmuxOnly && ensureResult?.started && ensureResult.logPath) {
          ctx.logger.info(`RouteCodex auto-start logs: ${ensureResult.logPath}`);
        }
        ctx.logger.info(`Working directory for ${spec.displayName}: ${currentCwd}`);
        ctx.logger.info(`Press Ctrl+C to exit ${spec.displayName}`);
      }

      let shutdownTriggered = false;
      let toolProcessClosing = false;
      let observedToolExitCode: number | null | undefined;
      let observedToolExitSignal: NodeJS.Signals | null = null;
      let requestedShutdownSignal: NodeJS.Signals | null = null;
      let clientExitSummaryLogged = false;
      const logClientExitSummary = (): void => {
        if (clientExitSummaryLogged || !shouldLogClientExitSummary(spec.commandName)) {
          return;
        }
        clientExitSummaryLogged = true;
        const codeLabel =
          typeof observedToolExitCode === 'number' && Number.isFinite(observedToolExitCode)
            ? String(observedToolExitCode)
            : 'n/a';
        const signalLabel = observedToolExitSignal || 'none';
        ctx.logger.info(`[client-exit] ${spec.displayName} exited (code=${codeLabel}, signal=${signalLabel})`);
      };
      const finalizeToolTermination = async (options?: { forceExitCode?: number }): Promise<void> => {
        if (toolProcessClosing) {
          return;
        }
        toolProcessClosing = true;
        logClientExitSummary();

        try {
          await sessionClientService?.stop();
        } catch {
          // ignore
        }
        try {
          if (managedTmuxSession && shouldStopManagedTmuxOnToolExit(ctx.env)) {
            managedTmuxSession.stop();
          }
        } catch {
          // ignore
        }
        try {
          await applyLifecycleOrThrow({
            action: 'launcher_tool_exit',
            signal: observedToolExitSignal ? String(observedToolExitSignal) : undefined,
            targetPid: toolProcess.pid ?? null
          });
        } catch {
          // ignore lifecycle logging errors in exit path
        }
        const forcedExitCode = options?.forceExitCode;
        if (typeof forcedExitCode === 'number' && Number.isFinite(forcedExitCode)) {
          ctx.exit(Math.max(0, Math.floor(forcedExitCode)));
          return;
        }
        if (requestedShutdownSignal || observedToolExitSignal) {
          ctx.exit(0);
          return;
        }
        ctx.exit(observedToolExitCode ?? 0);
      };
      const shutdown = async (signal: NodeJS.Signals) => {
        if (shutdownTriggered) {
          return;
        }
        shutdownTriggered = true;
        requestedShutdownSignal = signal;

        const targetGuard = canSignalOwnedToolProcess({
          env: ctx.env,
          pid: toolProcess.pid ?? null,
          expectedParentPid: process.pid,
          commandHint: resolvedBinary
        });
        logProcessLifecycle({
          event: 'launcher_signal_guard',
          source: 'cli.launcher.shutdown',
          details: {
            commandName: spec.commandName,
            signal,
            targetPid: toolProcess.pid ?? null,
            result: targetGuard.ok ? 'allowed' : 'blocked',
            reason: targetGuard.reason
          }
        });
        logProcessLifecycle({
          event: 'launcher_signal_forward',
          source: 'cli.launcher.shutdown',
          details: {
            commandName: spec.commandName,
            signal,
            forwarded: false,
            targetPid: toolProcess.pid ?? null,
            reason: 'disabled_no_forward'
          }
        });
        try {
          await applyLifecycleOrThrow({
            action: 'launcher_exit_signal',
            signal,
            targetPid: toolProcess.pid ?? null
          });
        } catch (error) {
          try {
            ctx.logger.error(error instanceof Error ? error.message : String(error));
          } catch {
            // ignore
          }
        }
        try {
          if (managedTmuxSession && shouldStopManagedTmuxOnShutdown(signal, ctx.env)) {
            managedTmuxSession.stop();
          }
        } catch {
          // ignore
        }
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
            await applyLifecycleOrThrow({
              action: 'launcher_tool_error_exit',
              targetPid: toolProcess.pid ?? null
            });
          } catch {
            // ignore lifecycle logging errors for terminal error path
          }
          await finalizeToolTermination({ forceExitCode: 1 });
        })();
      });

      toolProcess.on('exit', (code, signal) => {
        observedToolExitCode = code;
        observedToolExitSignal = signal ?? null;
      });

      toolProcess.on('close', (code, signal) => {
        if (observedToolExitCode === undefined) {
          observedToolExitCode = code;
        }
        if (!observedToolExitSignal) {
          observedToolExitSignal = signal ?? null;
        }
        logClientExitSummary();
        // Add grace period before exiting to allow child process output to flush
        // This is important for tools like codex that print session IDs on exit
        const gracePeriodMs = resolveExitGracePeriodMs(ctx.env);
        if (gracePeriodMs > 0) {
          ctx.logger.info(`[client-exit] Waiting ${gracePeriodMs}ms for output to flush...`);
          setTimeout(() => {
            void finalizeToolTermination();
          }, gracePeriodMs);
        } else {
          void finalizeToolTermination();
        }
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
