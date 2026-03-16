import type { Command } from 'commander';

import { LOCAL_HOSTS } from '../../constants/index.js';
import type { LoadedRouteCodexConfig } from '../../config/routecodex-config-loader.js';
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
};

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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
  try {
    loaded = await ctx.loadConfig(typeof options.config === 'string' ? options.config : undefined);
  } catch {
    loaded = null;
  }

  const configPick = readPortHostFromConfig(loaded);
  const host = normalizeConnectHost(options.host || configPick.host || LOCAL_HOSTS.LOCALHOST, LOCAL_HOSTS.IPV4);
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
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error('Missing server port. Use --port / --url, env, or config file.');
  }
  return `http://${host}:${Math.floor(port)}`;
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
  const text = await response.text().catch(() => '');
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
    const loaded = await ctx.loadConfig(typeof options.config === 'string' ? options.config : undefined).catch(() => null);
    const baseUrl = await resolveBaseUrl(ctx, options);
    const apiKey = resolveApiKeyFromConfig(ctx, loaded);
    const payload = await callJson(ctx, `${baseUrl}/daemon/heartbeat/list`, 'GET', apiKey);
    print(options, payload);
  });

  base(command.command('status').description('Show one heartbeat state')).action(async (options: HeartbeatCommandOptions) => {
    const loaded = await ctx.loadConfig(typeof options.config === 'string' ? options.config : undefined).catch(() => null);
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
    const loaded = await ctx.loadConfig(typeof options.config === 'string' ? options.config : undefined).catch(() => null);
    const baseUrl = await resolveBaseUrl(ctx, options);
    const apiKey = resolveApiKeyFromConfig(ctx, loaded);
    const payload = await callJson(ctx, `${baseUrl}/daemon/heartbeat`, 'POST', apiKey, {
      action: 'on',
      ...buildTarget(options)
    });
    print(options, payload);
  });

  base(command.command('off').description('Disable heartbeat')).action(async (options: HeartbeatCommandOptions) => {
    const loaded = await ctx.loadConfig(typeof options.config === 'string' ? options.config : undefined).catch(() => null);
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
    const loaded = await ctx.loadConfig(typeof options.config === 'string' ? options.config : undefined).catch(() => null);
    const baseUrl = await resolveBaseUrl(ctx, options);
    const apiKey = resolveApiKeyFromConfig(ctx, loaded);
    const payload = await callJson(ctx, `${baseUrl}/daemon/heartbeat`, 'POST', apiKey, {
      action: 'trigger',
      ...buildTarget(options),
      ...(options.dryRun ? { dryRun: true } : {})
    });
    print(options, payload);
  });
}
