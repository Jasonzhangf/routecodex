import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';

import { LOCAL_HOSTS } from '../../constants/index.js';
import type { LoadedRouteCodexConfig } from '../../config/routecodex-config-loader.js';
import { resolveRccUserDir } from '../../config/user-data-paths.js';
import { normalizeConnectHost, normalizePort } from '../utils/normalize.js';

type LoggerLike = {
  info: (msg: string) => void;
  warning: (msg: string) => void;
  success: (msg: string) => void;
  error: (msg: string) => void;
};

export type HeartbeatCommandContext = {
  isDevPackage: boolean;
  defaultDevPort: number;
  logger: LoggerLike;
  log: (line: string) => void;
  loadConfig: (explicitPath?: string) => Promise<LoadedRouteCodexConfig>;
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  exit: (code: number) => never;
};

type HeartbeatCommandOptions = {
  port?: string;
  host?: string;
  url?: string;
  config?: string;
  tmuxSessionId?: string;
  sessionId?: string;
  daemonId?: string;
  json?: boolean;
  dryRun?: boolean;
  limit?: string;
};

const NON_BLOCKING_WARN_THROTTLE_MS = 60_000;
const nonBlockingWarnByStage = new Map<string, number>();

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error ?? 'unknown');
  }
}

function shouldLogNonBlockingStage(stage: string): boolean {
  const now = Date.now();
  const lastAt = nonBlockingWarnByStage.get(stage) ?? 0;
  if (now - lastAt < NON_BLOCKING_WARN_THROTTLE_MS) {
    return false;
  }
  nonBlockingWarnByStage.set(stage, now);
  return true;
}

function logHeartbeatNonBlocking(
  ctx: HeartbeatCommandContext,
  stage: string,
  operation: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  if (!shouldLogNonBlockingStage(stage)) {
    return;
  }
  try {
    const suffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    ctx.logger.warning(
      `[heartbeat-command] stage=${stage} operation=${operation} failed (non-blocking): ${formatUnknownError(error)}${suffix}`
    );
  } catch {
    void 0;
  }
}

async function loadConfigBestEffort(
  ctx: HeartbeatCommandContext,
  explicitPath?: string
): Promise<LoadedRouteCodexConfig | null> {
  try {
    return await ctx.loadConfig(explicitPath);
  } catch (error) {
    logHeartbeatNonBlocking(ctx, 'config', 'load_config', error, {
      configPath: explicitPath || '(default)'
    });
    return null;
  }
}

function resolveConfigApiKeyValue(raw: unknown, env: NodeJS.ProcessEnv): string {
  const trimmed = normalizeString(raw);
  if (!trimmed) {
    return '';
  }
  const envMatch = trimmed.match(/^\$\{([A-Z0-9_]+)\}$/i);
  if (envMatch) {
    return normalizeString(env[envMatch[1]]);
  }
  if (/^[A-Z][A-Z0-9_]+$/.test(trimmed)) {
    return normalizeString(env[trimmed]);
  }
  return trimmed;
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    throw new Error('--url is empty');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    parsed = new URL(`http://${trimmed}`);
  }
  const protocol = parsed.protocol === 'https:' ? 'https:' : 'http:';
  const pathname = !parsed.pathname || parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  return `${protocol}//${parsed.host}${pathname}`;
}

function readPortHostFromConfig(loaded: LoadedRouteCodexConfig | null): { host: string | undefined; port: number } {
  const cfg = (loaded?.userConfig || {}) as Record<string, any>;
  const host =
    typeof cfg?.httpserver?.host === 'string'
      ? cfg.httpserver.host
      : typeof cfg?.server?.host === 'string'
        ? cfg.server.host
        : typeof cfg?.host === 'string'
          ? cfg.host
          : undefined;
  const port = normalizePort(cfg?.httpserver?.port ?? cfg?.server?.port ?? cfg?.port);
  return { host, port };
}

function resolveApiKeyFromConfig(ctx: HeartbeatCommandContext, loaded: LoadedRouteCodexConfig | null): string {
  const fromEnv = normalizeString(ctx.env.ROUTECODEX_HTTP_APIKEY) || normalizeString(ctx.env.RCC_HTTP_APIKEY);
  if (fromEnv) {
    return fromEnv;
  }
  const cfg = (loaded?.userConfig || {}) as Record<string, any>;
  return resolveConfigApiKeyValue(
    cfg?.httpserver?.apikey ?? cfg?.modules?.httpserver?.config?.apikey ?? cfg?.server?.apikey,
    ctx.env
  );
}

async function resolveBaseUrl(ctx: HeartbeatCommandContext, options: HeartbeatCommandOptions): Promise<string> {
  if (typeof options.url === 'string' && options.url.trim()) {
    return normalizeBaseUrl(options.url);
  }

  let loaded: LoadedRouteCodexConfig | null = null;
  loaded = await loadConfigBestEffort(ctx, typeof options.config === 'string' ? options.config : undefined);

  const configPick = readPortHostFromConfig(loaded);
  const host = normalizeConnectHost(options.host || configPick.host || LOCAL_HOSTS.LOCALHOST, LOCAL_HOSTS.IPV4);
  const explicitPortFromFlag = normalizePort(options.port);
  const hasExplicitPort = Number.isFinite(explicitPortFromFlag) && explicitPortFromFlag > 0;
  let port = normalizePort(options.port);
  if (!Number.isFinite(port) || port <= 0) {
    port = configPick.port;
  }
  if (!Number.isFinite(port) || port <= 0) {
    port = normalizePort(ctx.env.ROUTECODEX_PORT || ctx.env.RCC_PORT);
  }
  if ((!Number.isFinite(port) || port <= 0) && ctx.isDevPackage) {
    port = ctx.defaultDevPort;
  }
  if (
    !hasExplicitPort &&
    Number.isFinite(port) &&
    port > 0 &&
    !(await probeServerHealth(ctx, host, port))
  ) {
    const discovered = await resolveDiscoveredActiveServerPort(ctx, host, new Set<number>([port]));
    if (typeof discovered === 'number' && Number.isFinite(discovered) && discovered > 0) {
      ctx.logger.warning(
        `Configured heartbeat endpoint ${host}:${port} is unavailable; switched to active server ${host}:${discovered}.`
      );
      port = discovered;
    }
  }
  if (!Number.isFinite(port) || port <= 0) {
    const discovered = await resolveDiscoveredActiveServerPort(ctx, host);
    if (typeof discovered === 'number' && Number.isFinite(discovered) && discovered > 0) {
      port = discovered;
      ctx.logger.info(`Auto-discovered active RouteCodex server on ${host}:${port} (heartbeat is tmux-scoped).`);
    }
  }
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error('Missing server port. Use --port / --url, env, or config file.');
  }
  return `http://${host}:${Math.floor(port)}`;
}

function normalizePositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  const floored = Math.floor(parsed);
  return floored > 0 ? floored : undefined;
}

async function probeServerHealth(
  ctx: HeartbeatCommandContext,
  host: string,
  port: number
): Promise<boolean> {
  if (!Number.isFinite(port) || port <= 0) {
    return false;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, 800);
    const response = await ctx.fetch(`http://${host}:${port}/health`, {
      method: 'GET',
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) {
      logHeartbeatNonBlocking(ctx, 'health_probe', 'probe_server_health', `bad_status:${response.status}`, {
        host,
        port,
        status: response.status
      });
      return false;
    }
    let payload: any = null;
    try {
      payload = await response.json();
    } catch (error) {
      logHeartbeatNonBlocking(ctx, 'health_probe', 'parse_health_json', error, { host, port });
      payload = null;
    }
    const status = typeof payload?.status === 'string' ? payload.status.toLowerCase() : '';
    return Boolean(
      payload &&
      (status === 'healthy' || status === 'ready' || status === 'ok' || payload?.ready === true || payload?.pipelineReady === true)
    );
  } catch (error) {
    logHeartbeatNonBlocking(ctx, 'health_probe', 'probe_server_health', error, { host, port });
    return false;
  }
}

async function collectCandidatePortsFromUserDir(
  ctx: HeartbeatCommandContext,
  userDir: string
): Promise<number[]> {
  const out = new Set<number>();
  try {
    const entries = await fs.readdir(userDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const match = entry.name.match(/^server-(\d+)\.pid$/);
      if (!match || !match[1]) {
        continue;
      }
      const parsed = normalizePositiveInt(match[1]);
      if (parsed) {
        out.add(parsed);
      }
    }
  } catch (error) {
    logHeartbeatNonBlocking(
      ctx,
      'port_discovery',
      'read_server_pid_dir',
      error,
      { userDir }
    );
  }

  try {
    const lifecycleDir = path.join(userDir, 'state', 'runtime-lifecycle');
    const entries = await fs.readdir(lifecycleDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const match = entry.name.match(/^server-(\d+)\.json$/);
      if (!match || !match[1]) {
        continue;
      }
      const parsed = normalizePositiveInt(match[1]);
      if (parsed) {
        out.add(parsed);
      }
    }
  } catch (error) {
    logHeartbeatNonBlocking(
      ctx,
      'port_discovery',
      'read_runtime_lifecycle_dir',
      error,
      { lifecycleDir: path.join(userDir, 'state', 'runtime-lifecycle') }
    );
  }

  return Array.from(out);
}

async function resolveDiscoveredActiveServerPort(
  ctx: HeartbeatCommandContext,
  host: string,
  excludePorts?: Set<number>
): Promise<number | undefined> {
  const userDir = resolveRccUserDir();
  const candidates = await collectCandidatePortsFromUserDir(ctx, userDir);
  for (const port of candidates) {
    if (excludePorts?.has(port)) {
      continue;
    }
    if (await probeServerHealth(ctx, host, port)) {
      return port;
    }
  }
  return undefined;
}

async function callJson(
  ctx: HeartbeatCommandContext,
  url: string,
  method: 'GET' | 'POST',
  apiKey?: string,
  body?: Record<string, unknown>
): Promise<any> {
  const response = await ctx.fetch(url, {
    method,
    headers: {
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      ...(apiKey ? { 'x-api-key': apiKey } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  let text = '';
  try {
    text = await response.text();
  } catch (error) {
    logHeartbeatNonBlocking(ctx, 'http_call', 'read_response_text', error, { url, method });
    text = '';
  }
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`heartbeat request failed (${response.status}): ${text}`);
  }
  return data;
}

function buildTarget(options: HeartbeatCommandOptions): Record<string, unknown> {
  const tmuxSessionId = normalizeString(options.tmuxSessionId);
  const sessionId = normalizeString(options.sessionId);
  const daemonId = normalizeString(options.daemonId);
  return {
    ...(tmuxSessionId ? { tmuxSessionId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(daemonId ? { daemonId } : {})
  };
}

export function createHeartbeatCommand(program: Command, ctx: HeartbeatCommandContext): void {
  const base = (command: Command): Command =>
    command
      .option('--port <port>', 'RouteCodex server port')
      .option('--host <host>', 'RouteCodex server host')
      .option('--url <url>', 'RouteCodex base URL')
      .option('-c, --config <config>', 'RouteCodex configuration file path')
      .option('--tmux-session-id <tmuxSessionId>', 'Target tmux session id')
      .option('--session-id <sessionId>', 'Alias for tmux session id / conversation session id')
      .option('--daemon-id <daemonId>', 'Resolve target tmux session from daemon id')
      .option('--json', 'Print JSON output');

  const print = (options: HeartbeatCommandOptions, payload: unknown): void => {
    if (options.json) {
      ctx.log(JSON.stringify(payload, null, 2));
      return;
    }
    ctx.log(JSON.stringify(payload, null, 2));
  };

  const command = program.command('heartbeat').description('Manage tmux heartbeat state and trigger heartbeat injections');

  base(command.command('list').description('List all heartbeat states')).action(async (options: HeartbeatCommandOptions) => {
    const loaded = await loadConfigBestEffort(ctx, typeof options.config === 'string' ? options.config : undefined);
    const baseUrl = await resolveBaseUrl(ctx, options);
    const apiKey = resolveApiKeyFromConfig(ctx, loaded);
    const payload = await callJson(ctx, `${baseUrl}/daemon/heartbeat/list`, 'GET', apiKey);
    print(options, payload);
  });

  base(command.command('status').description('Show one heartbeat state')).action(async (options: HeartbeatCommandOptions) => {
    const loaded = await loadConfigBestEffort(ctx, typeof options.config === 'string' ? options.config : undefined);
    const baseUrl = await resolveBaseUrl(ctx, options);
    const apiKey = resolveApiKeyFromConfig(ctx, loaded);
    const params = new URLSearchParams();
    const target = buildTarget(options);
    for (const [key, value] of Object.entries(target)) {
      if (typeof value === 'string' && value.trim()) {
        params.set(key, value);
      }
    }
    const payload = await callJson(ctx, `${baseUrl}/daemon/heartbeat?${params.toString()}`, 'GET', apiKey);
    print(options, payload);
  });

  base(command.command('on').description('Enable heartbeat and attempt immediate trigger')).action(async (options: HeartbeatCommandOptions) => {
    const loaded = await loadConfigBestEffort(ctx, typeof options.config === 'string' ? options.config : undefined);
    const baseUrl = await resolveBaseUrl(ctx, options);
    const apiKey = resolveApiKeyFromConfig(ctx, loaded);
    const payload = await callJson(ctx, `${baseUrl}/daemon/heartbeat`, 'POST', apiKey, {
      action: 'on',
      ...buildTarget(options)
    });
    print(options, payload);
  });

  base(command.command('off').description('Disable heartbeat')).action(async (options: HeartbeatCommandOptions) => {
    const loaded = await loadConfigBestEffort(ctx, typeof options.config === 'string' ? options.config : undefined);
    const baseUrl = await resolveBaseUrl(ctx, options);
    const apiKey = resolveApiKeyFromConfig(ctx, loaded);
    const payload = await callJson(ctx, `${baseUrl}/daemon/heartbeat`, 'POST', apiKey, {
      action: 'off',
      ...buildTarget(options)
    });
    print(options, payload);
  });

  base(
    command
      .command('trigger')
      .description('Trigger one heartbeat dispatch immediately')
      .option('--dry-run', 'Evaluate gating without injecting')
  ).action(async (options: HeartbeatCommandOptions) => {
    const loaded = await loadConfigBestEffort(ctx, typeof options.config === 'string' ? options.config : undefined);
    const baseUrl = await resolveBaseUrl(ctx, options);
    const apiKey = resolveApiKeyFromConfig(ctx, loaded);
    const payload = await callJson(ctx, `${baseUrl}/daemon/heartbeat`, 'POST', apiKey, {
      action: 'trigger',
      ...buildTarget(options),
      ...(options.dryRun ? { dryRun: true } : {})
    });
    print(options, payload);
  });

  base(
    command
      .command('history')
      .description('Show heartbeat execution history for a tmux session')
      .option('--limit <limit>', 'Max number of records (default: 100)')
  ).action(async (options: HeartbeatCommandOptions) => {
    const loaded = await loadConfigBestEffort(ctx, typeof options.config === 'string' ? options.config : undefined);
    const baseUrl = await resolveBaseUrl(ctx, options);
    const apiKey = resolveApiKeyFromConfig(ctx, loaded);
    const params = new URLSearchParams();
    const target = buildTarget(options);
    for (const [key, value] of Object.entries(target)) {
      if (typeof value === 'string' && value.trim()) {
        params.set(key, value);
      }
    }
    const limit = normalizePositiveInt(options.limit);
    if (limit) {
      params.set('limit', String(limit));
    }
    const payload = await callJson(ctx, `${baseUrl}/daemon/heartbeat/history?${params.toString()}`, 'GET', apiKey);
    print(options, payload);
  });
}
