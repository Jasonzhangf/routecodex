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

export type SessionAdminCommandContext = {
  isDevPackage: boolean;
  defaultDevPort: number;
  logger: LoggerLike;
  log: (line: string) => void;
  loadConfig: (explicitPath?: string) => Promise<LoadedRouteCodexConfig>;
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  exit: (code: number) => never;
};

type SessionAdminCommandOptions = {
  port?: string;
  host?: string;
  url?: string;
  config?: string;
  list?: boolean;
  create?: boolean;
  update?: boolean;
  delete?: boolean;
  clear?: boolean;
  cleanupDeadTmux?: boolean;
  unbindSession?: string;
  json?: boolean;
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
  const pathname = (() => {
    const p = typeof parsed.pathname === 'string' ? parsed.pathname : '';
    if (!p || p === '/') {
      return '';
    }
    return p.replace(/\/+$/, '');
  })();
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

function resolveApiKeyFromConfig(ctx: SessionAdminCommandContext, loaded: LoadedRouteCodexConfig | null): string {
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

async function resolveBaseUrl(ctx: SessionAdminCommandContext, options: SessionAdminCommandOptions): Promise<string> {
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

function parseInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return Math.floor(parsed);
}

async function callJson(
  ctx: SessionAdminCommandContext,
  url: string,
  method: string,
  body?: Record<string, unknown>,
  apiKey?: string
): Promise<{ ok: boolean; status: number; data: any }> {
  const response = await ctx.fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { 'x-api-key': apiKey } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { ok: response.ok, status: response.status, data };
}

export function createSessionAdminCommand(program: Command, ctx: SessionAdminCommandContext): void {
  program
    .command('session-admin')
    .description('Manage session bindings and cleanup')
    .option('--port <port>', 'RouteCodex server port')
    .option('--host <host>', 'RouteCodex server host')
    .option('--url <url>', 'RouteCodex base URL')
    .option('-c, --config <config>', 'RouteCodex configuration file path')
    .option('--cleanup-dead-tmux', 'Cleanup daemons whose tmux session is gone', false)
    .option('--unbind-session <conversationSessionId>', 'Unbind conversation session mapping manually')
    .option('--json', 'Print JSON output', false)
    .action(async (options: SessionAdminCommandOptions) => {
      try {
        let loaded: LoadedRouteCodexConfig | null = null;
        try {
          loaded = await ctx.loadConfig(typeof options.config === 'string' ? options.config : undefined);
        } catch {
          loaded = null;
        }
        const baseUrl = await resolveBaseUrl(ctx, options);
        const apiKey = resolveApiKeyFromConfig(ctx, loaded);
        const outputJson = Boolean(options.json);

        const print = (payload: unknown): void => {
          if (outputJson) {
            ctx.log(JSON.stringify(payload, null, 2));
          } else {
            ctx.log(JSON.stringify(payload, null, 2));
          }
        };

        if (options.cleanupDeadTmux) {
          const result = await callJson(ctx, `${baseUrl}/daemon/session/cleanup`, 'POST', { mode: 'dead_tmux' }, apiKey);
          if (!result.ok) {
            throw new Error(`cleanup-dead-tmux failed (${result.status})`);
          }
          print(result.data);
          return;
        }

        if (typeof options.unbindSession === 'string' && options.unbindSession.trim()) {
          const result = await callJson(ctx, `${baseUrl}/daemon/session/cleanup`, 'POST', {
            mode: 'unbind',
            conversationSessionId: options.unbindSession.trim(),
            clearTasks: false
          }, apiKey);
          if (!result.ok) {
            throw new Error(`unbind-session failed (${result.status})`);
          }
          print(result.data);
          return;
        }

        throw new Error('session-admin requires --cleanup-dead-tmux or --unbind-session');
      } catch (error) {
        ctx.logger.error(error instanceof Error ? error.message : String(error));
        ctx.exit(1);
      }
    });
}
