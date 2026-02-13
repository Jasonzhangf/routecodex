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

export type TmuxInjectCommandContext = {
  isDevPackage: boolean;
  defaultDevPort: number;
  logger: LoggerLike;
  log: (line: string) => void;
  loadConfig: (explicitPath?: string) => Promise<LoadedRouteCodexConfig>;
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  exit: (code: number) => never;
};

type TmuxInjectCommandOptions = {
  port?: string;
  host?: string;
  url?: string;
  config?: string;
  tmuxSessionId?: string;
  sessionId?: string;
  daemonId?: string;
  text?: string;
  list?: boolean;
  json?: boolean;
  source?: string;
  requestId?: string;
};

type ClockClientRecord = {
  daemonId?: string;
  tmuxSessionId?: string;
  sessionId?: string;
  callbackUrl?: string;
  clientType?: string;
  tmuxTarget?: string;
  registeredAtMs?: number;
  lastHeartbeatAtMs?: number;
};

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

async function resolveBaseUrl(ctx: TmuxInjectCommandContext, options: TmuxInjectCommandOptions): Promise<string> {
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

async function fetchDaemonList(ctx: TmuxInjectCommandContext, baseUrl: string): Promise<ClockClientRecord[]> {
  const url = `${baseUrl}/daemon/clock-client/list`;
  const response = await ctx.fetch(url, { method: 'GET' });
  if (!response.ok) {
    const text = await response.text().catch(() => String(response.status));
    throw new Error(`Failed to list clock daemons (${response.status}): ${text}`);
  }
  const data = (await response.json().catch(() => null)) as { records?: unknown } | null;
  const records = Array.isArray(data?.records) ? data?.records : [];
  return records.filter((item) => item && typeof item === 'object') as ClockClientRecord[];
}

function resolveTargetTmuxSessionId(records: ClockClientRecord[], options: TmuxInjectCommandOptions): string {
  const explicitTmuxSession = typeof options.tmuxSessionId === 'string' ? options.tmuxSessionId.trim() : '';
  if (explicitTmuxSession) {
    return explicitTmuxSession;
  }

  const explicitSessionAlias = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
  if (explicitSessionAlias) {
    return explicitSessionAlias;
  }

  const explicitDaemon = typeof options.daemonId === 'string' ? options.daemonId.trim() : '';
  if (explicitDaemon) {
    const found = records.find((item) => String(item.daemonId || '').trim() === explicitDaemon);
    const tmuxSessionId =
      found && typeof found.tmuxSessionId === 'string' && found.tmuxSessionId.trim()
        ? found.tmuxSessionId.trim()
        : found && typeof found.sessionId === 'string'
          ? found.sessionId.trim()
          : '';
    if (!tmuxSessionId) {
      throw new Error(`daemonId ${explicitDaemon} not found or missing tmuxSessionId`);
    }
    return tmuxSessionId;
  }

  const withSession = records.filter(
    (item) =>
      (typeof item.tmuxSessionId === 'string' && item.tmuxSessionId.trim()) ||
      (typeof item.sessionId === 'string' && item.sessionId.trim())
  );
  if (withSession.length === 1) {
    const target =
      typeof withSession[0].tmuxSessionId === 'string' && withSession[0].tmuxSessionId.trim()
        ? withSession[0].tmuxSessionId.trim()
        : String(withSession[0].sessionId || '').trim();
    return target;
  }

  if (!withSession.length) {
    throw new Error('No available clock daemon tmux session. Start rcc codex/claude first.');
  }

  throw new Error('Multiple daemon tmux sessions found; specify --tmux-session-id/--session-id or --daemon-id (use --list).');
}

function formatTime(ms?: number): string {
  if (!Number.isFinite(ms as number)) {
    return '-';
  }
  try {
    return new Date(ms as number).toISOString();
  } catch {
    return String(ms);
  }
}

function printList(ctx: TmuxInjectCommandContext, records: ClockClientRecord[], asJson: boolean): void {
  if (asJson) {
    ctx.log(JSON.stringify({ ok: true, records }, null, 2));
    return;
  }
  if (!records.length) {
    ctx.logger.info('No clock-client daemons registered.');
    return;
  }
  ctx.logger.info(`Found ${records.length} clock-client daemon(s):`);
  for (const rec of records) {
    const daemonId = String(rec.daemonId || '-');
    const tmuxSessionId = String(rec.tmuxSessionId || rec.sessionId || '-');
    const tmuxTarget = String(rec.tmuxTarget || '-');
    const heartbeat = formatTime(rec.lastHeartbeatAtMs);
    ctx.log(`- daemonId=${daemonId} tmuxSessionId=${tmuxSessionId} tmux=${tmuxTarget} heartbeat=${heartbeat}`);
  }
}

export function createTmuxInjectCommand(program: Command, ctx: TmuxInjectCommandContext): void {
  program
    .command('tmux-inject')
    .description('Inject text into tmux-backed codex/claude session via RouteCodex clock daemon')
    .option('--port <port>', 'RouteCodex server port')
    .option('--host <host>', 'RouteCodex server host')
    .option('--url <url>', 'RouteCodex base URL, e.g. http://127.0.0.1:5520')
    .option('-c, --config <config>', 'RouteCodex configuration file path')
    .option('--tmux-session-id <tmuxSessionId>', 'Target daemon tmux session id')
    .option('--session-id <sessionId>', 'Alias of --tmux-session-id (deprecated)')
    .option('--daemon-id <daemonId>', 'Target daemonId (tmux session auto-resolved)')
    .option('--text <text>', 'Text to inject into target tmux pane and press Enter')
    .option('--source <source>', 'Injection source tag', 'cli.tmux-inject')
    .option('--request-id <requestId>', 'Optional request id for tracing')
    .option('--list', 'List available daemon targets only')
    .option('--json', 'Print result/list in JSON')
    .action(async (options: TmuxInjectCommandOptions) => {
      try {
        const waitHint = 'Hint: if waiting is needed, only call tools that are available in your current runtime.';
        const baseUrl = await resolveBaseUrl(ctx, options);
        const records = await fetchDaemonList(ctx, baseUrl);

        if (options.list) {
          printList(ctx, records, Boolean(options.json));
          return;
        }

        const text = typeof options.text === 'string' ? options.text : '';
        if (!text.trim()) {
          throw new Error('Missing injection text. Provide --text "..."');
        }

        const tmuxSessionId = resolveTargetTmuxSessionId(records, options);
        const payload: Record<string, unknown> = {
          text,
          tmuxSessionId,
          sessionId: tmuxSessionId,
          source: typeof options.source === 'string' && options.source.trim() ? options.source.trim() : 'cli.tmux-inject'
        };
        if (typeof options.requestId === 'string' && options.requestId.trim()) {
          payload.requestId = options.requestId.trim();
        }

        const injectUrl = `${baseUrl}/daemon/clock-client/inject`;
        const response = await ctx.fetch(injectUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        if (!response.ok) {
          const reason =
            (typeof data?.reason === 'string' && data.reason) ||
            (typeof (data as any)?.error?.message === 'string' && (data as any).error.message) ||
            `http_${response.status}`;
          throw new Error(`Injection failed: ${reason}`);
        }

        const daemonId = typeof data?.daemonId === 'string' ? data.daemonId : undefined;
        if (options.json) {
          ctx.log(
            JSON.stringify(
              {
                ok: true,
                tmuxSessionId,
                ...(daemonId ? { daemonId } : {}),
                server: baseUrl,
                hint: waitHint
              },
              null,
              2
            )
          );
          return;
        }

        ctx.logger.success(`Injected text to tmux session ${tmuxSessionId}${daemonId ? ` (daemon ${daemonId})` : ''}`);
        ctx.logger.info(waitHint);
      } catch (error) {
        ctx.logger.error(error instanceof Error ? error.message : String(error));
        ctx.exit(1);
      }
    });
}
