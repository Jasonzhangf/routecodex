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

export type ClockAdminCommandContext = {
  isDevPackage: boolean;
  defaultDevPort: number;
  logger: LoggerLike;
  log: (line: string) => void;
  loadConfig: (explicitPath?: string) => Promise<LoadedRouteCodexConfig>;
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  exit: (code: number) => never;
};

type ClockAdminCommandOptions = {
  port?: string;
  host?: string;
  url?: string;
  config?: string;
  sessionId?: string;
  taskId?: string;
  dueAt?: string;
  task?: string;
  recurrence?: string;
  everyMinutes?: string;
  maxRuns?: string;
  list?: boolean;
  create?: boolean;
  update?: boolean;
  delete?: boolean;
  clear?: boolean;
  cleanupDeadTmux?: boolean;
  unbindSession?: string;
  clearTasks?: boolean;
  json?: boolean;
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

async function resolveBaseUrl(ctx: ClockAdminCommandContext, options: ClockAdminCommandOptions): Promise<string> {
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

async function callJson(ctx: ClockAdminCommandContext, url: string, method: string, body?: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: any }> {
  const response = await ctx.fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text().catch(() => '');
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { ok: response.ok, status: response.status, data };
}

export function createClockAdminCommand(program: Command, ctx: ClockAdminCommandContext): void {
  program
    .command('clock-admin')
    .description('Manage clock schedules and tmux/session bindings (list + CRUD + cleanup)')
    .option('--port <port>', 'RouteCodex server port')
    .option('--host <host>', 'RouteCodex server host')
    .option('--url <url>', 'RouteCodex base URL')
    .option('-c, --config <config>', 'RouteCodex configuration file path')
    .option('--session-id <sessionId>', 'Conversation/session id for clock task CRUD')
    .option('--task-id <taskId>', 'Task id for update/delete')
    .option('--due-at <dueAt>', 'ISO8601 due time for create/update')
    .option('--task <task>', 'Task text for create/update')
    .option('--recurrence <kind>', 'Recurrence kind: daily|weekly|interval')
    .option('--every-minutes <minutes>', 'everyMinutes for interval recurrence')
    .option('--max-runs <count>', 'maxRuns for recurrence')
    .option('--list', 'List clock sessions/tasks', false)
    .option('--create', 'Create clock task', false)
    .option('--update', 'Update clock task', false)
    .option('--delete', 'Delete one clock task', false)
    .option('--clear', 'Clear all tasks in a session', false)
    .option('--cleanup-dead-tmux', 'Cleanup daemons whose tmux session is gone', false)
    .option('--unbind-session <conversationSessionId>', 'Unbind conversation session mapping manually')
    .option('--clear-tasks', 'With --unbind-session, clear its clock tasks too', false)
    .option('--json', 'Print JSON output', false)
    .action(async (options: ClockAdminCommandOptions) => {
      try {
        const baseUrl = await resolveBaseUrl(ctx, options);
        const outputJson = Boolean(options.json);

        const print = (payload: unknown): void => {
          if (outputJson) {
            ctx.log(JSON.stringify(payload, null, 2));
          } else {
            ctx.log(JSON.stringify(payload, null, 2));
          }
        };

        if (options.cleanupDeadTmux) {
          const result = await callJson(ctx, `${baseUrl}/daemon/clock/cleanup`, 'POST', { mode: 'dead_tmux' });
          if (!result.ok) {
            throw new Error(`cleanup-dead-tmux failed (${result.status})`);
          }
          print(result.data);
          return;
        }

        if (typeof options.unbindSession === 'string' && options.unbindSession.trim()) {
          const result = await callJson(ctx, `${baseUrl}/daemon/clock/cleanup`, 'POST', {
            mode: 'unbind',
            conversationSessionId: options.unbindSession.trim(),
            clearTasks: Boolean(options.clearTasks)
          });
          if (!result.ok) {
            throw new Error(`unbind-session failed (${result.status})`);
          }
          print(result.data);
          return;
        }

        if (options.create) {
          const sessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
          const dueAt = typeof options.dueAt === 'string' ? options.dueAt.trim() : '';
          const task = typeof options.task === 'string' ? options.task.trim() : '';
          if (!sessionId || !dueAt || !task) {
            throw new Error('--create requires --session-id --due-at --task');
          }
          const payload: Record<string, unknown> = { sessionId, dueAt, task };
          const recurrence = typeof options.recurrence === 'string' ? options.recurrence.trim() : '';
          if (recurrence) {
            payload.recurrence = {
              kind: recurrence,
              ...(parseInteger(options.maxRuns) ? { maxRuns: parseInteger(options.maxRuns) } : {}),
              ...(parseInteger(options.everyMinutes) ? { everyMinutes: parseInteger(options.everyMinutes) } : {})
            };
          }
          const result = await callJson(ctx, `${baseUrl}/daemon/clock/tasks`, 'POST', payload);
          if (!result.ok) {
            throw new Error(`create failed (${result.status})`);
          }
          print(result.data);
          return;
        }

        if (options.update) {
          const sessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
          const taskId = typeof options.taskId === 'string' ? options.taskId.trim() : '';
          if (!sessionId || !taskId) {
            throw new Error('--update requires --session-id --task-id');
          }
          const patch: Record<string, unknown> = {};
          if (typeof options.dueAt === 'string' && options.dueAt.trim()) {
            patch.dueAt = options.dueAt.trim();
          }
          if (typeof options.task === 'string' && options.task.trim()) {
            patch.task = options.task.trim();
          }
          const recurrence = typeof options.recurrence === 'string' ? options.recurrence.trim() : '';
          if (recurrence) {
            patch.recurrence = {
              kind: recurrence,
              ...(parseInteger(options.maxRuns) ? { maxRuns: parseInteger(options.maxRuns) } : {}),
              ...(parseInteger(options.everyMinutes) ? { everyMinutes: parseInteger(options.everyMinutes) } : {})
            };
          }
          const result = await callJson(ctx, `${baseUrl}/daemon/clock/tasks`, 'PATCH', { sessionId, taskId, patch });
          if (!result.ok) {
            throw new Error(`update failed (${result.status})`);
          }
          print(result.data);
          return;
        }

        if (options.delete || options.clear) {
          const sessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
          if (!sessionId) {
            throw new Error('--delete/--clear requires --session-id');
          }
          const taskId = options.clear ? '' : (typeof options.taskId === 'string' ? options.taskId.trim() : '');
          if (options.delete && !taskId) {
            throw new Error('--delete requires --task-id (or use --clear)');
          }
          const result = await callJson(ctx, `${baseUrl}/daemon/clock/tasks`, 'DELETE', {
            sessionId,
            ...(taskId ? { taskId } : {})
          });
          if (!result.ok) {
            throw new Error(`delete/clear failed (${result.status})`);
          }
          print(result.data);
          return;
        }

        const sessionId = typeof options.sessionId === 'string' && options.sessionId.trim() ? options.sessionId.trim() : undefined;
        const listUrl = sessionId
          ? `${baseUrl}/daemon/clock/tasks?sessionId=${encodeURIComponent(sessionId)}`
          : `${baseUrl}/daemon/clock/tasks`;
        const response = await ctx.fetch(listUrl);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(`list failed (${response.status})`);
        }
        print(data);
      } catch (error) {
        ctx.logger.error(error instanceof Error ? error.message : String(error));
        ctx.exit(1);
      }
    });
}
