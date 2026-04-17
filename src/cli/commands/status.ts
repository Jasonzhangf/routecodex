import type { Command } from 'commander';

import { LOCAL_HOSTS } from '../../constants/index.js';
import type { LoadedRouteCodexConfig } from '../../config/routecodex-config-loader.js';
import type { ManagedZombieProcess } from '../../utils/managed-server-pids.js';

type LoggerLike = {
  info: (msg: string) => void;
  warning: (msg: string) => void;
  success: (msg: string) => void;
  error: (msg: string) => void;
};

type HealthCheckResult = {
  status: string;
  port: number;
  host: string;
  responseTime?: number;
  version?: string;
  ready?: boolean;
  error?: string;
};

export type StatusCommandContext = {
  logger: LoggerLike;
  log: (line: string) => void;
  loadConfig: () => Promise<LoadedRouteCodexConfig>;
  fetch: typeof fetch;
  listManagedZombieChildren?: (port: number) => ManagedZombieProcess[];
};

const NON_BLOCKING_WARN_THROTTLE_MS = 60_000;
const nonBlockingWarnByStage = new Map<string, number>();

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

function logStatusNonBlocking(
  ctx: StatusCommandContext,
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
      `[status-command] stage=${stage} operation=${operation} failed (non-blocking): ${formatUnknownError(error)}${suffix}`
    );
  } catch {
    void 0;
  }
}

function pickPortHost(userConfig: Record<string, any>): { port: number | null; host: string } {
  const portCandidate = userConfig?.httpserver?.port ?? userConfig?.server?.port ?? userConfig?.port;
  const port = typeof portCandidate === 'number' && Number.isFinite(portCandidate) ? portCandidate : null;

  const hostCandidate =
    typeof userConfig?.httpserver?.host === 'string'
      ? userConfig.httpserver.host
      : (typeof userConfig?.server?.host === 'string' ? userConfig.server.host : userConfig?.host);
  const host = typeof hostCandidate === 'string' && hostCandidate.trim() ? hostCandidate.trim() : LOCAL_HOSTS.LOCALHOST;
  return { port, host };
}

async function checkServer(ctx: StatusCommandContext, port: number, host: string): Promise<HealthCheckResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const t = setTimeout(() => {
    controller.abort();
  }, 5000);

  try {
    const url = `http://${host}:${port}/health`;
    const res = await ctx.fetch(url, { method: 'GET', signal: controller.signal });
    const responseTime = Date.now() - startedAt;
    if (!res.ok) {
      logStatusNonBlocking(ctx, 'health_probe', 'check_server', `bad_status:${res.status}`, { host, port, status: res.status });
      return { status: 'error', port, host, responseTime };
    }
    let data: any = null;
    try {
      data = await res.json();
    } catch (error) {
      logStatusNonBlocking(ctx, 'health_probe', 'parse_health_json', error, { host, port });
      data = null;
    }
    const status = data?.status ? String(data.status) : 'unknown';
    const version = data?.version ? String(data.version) : undefined;
    const ready = typeof data?.ready === 'boolean' ? Boolean(data.ready) : undefined;
    return { status, port, host, responseTime, ...(version ? { version } : {}), ...(ready !== undefined ? { ready } : {}) };
  } catch (error) {
    const responseTime = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = message.toLowerCase().includes('aborted') || message.toLowerCase().includes('timeout');
    return { status: isTimeout ? 'timeout' : 'stopped', port, host, responseTime, error: message };
  } finally {
    clearTimeout(t);
  }
}

function printHuman(ctx: StatusCommandContext, status: HealthCheckResult): void {
  const normalized = status.status === 'healthy' || status.status === 'ready' ? 'running' : status.status;
  switch (normalized) {
    case 'running':
      ctx.logger.success(
        `Server is running on ${status.host}:${status.port}` + (status.version ? ` (version=${status.version})` : '')
      );
      break;
    case 'stopped':
      ctx.logger.error('Server is not running');
      break;
    case 'error':
      ctx.logger.error('Server is in error state');
      break;
    default:
      ctx.logger.warning('Server status unknown');
  }
}

function resolveManagedZombieChildren(ctx: StatusCommandContext, port: number): ManagedZombieProcess[] {
  if (typeof ctx.listManagedZombieChildren !== 'function') {
    return [];
  }
  try {
    const out = ctx.listManagedZombieChildren(port);
    return Array.isArray(out) ? out : [];
  } catch (error) {
    logStatusNonBlocking(ctx, 'managed_zombie_children', 'list_managed_zombie_children', error, { port });
    return [];
  }
}

export function createStatusCommand(program: Command, ctx: StatusCommandContext): void {
  program
    .command('status')
    .description('Show server status')
    .option('-p, --port <port>', 'RouteCodex server port (overrides config)')
    .option('--host <host>', 'RouteCodex server host (overrides config)')
    .option('-j, --json', 'Output in JSON format')
    .action(async (options: { json?: boolean; port?: string; host?: string }) => {
      try {
        let loaded: LoadedRouteCodexConfig | null = null;
        try {
          loaded = await ctx.loadConfig();
        } catch (error) {
          logStatusNonBlocking(ctx, 'config', 'load_config', error);
          loaded = null;
        }

        if (!loaded) {
          ctx.logger.error('Configuration file not found');
          ctx.logger.info('Please create a configuration file first:');
          ctx.logger.info('  rcc init');
          ctx.logger.info('  rcc config init');
          if (options.json) {
            ctx.log(JSON.stringify({ error: 'Configuration file not found' }, null, 2));
          }
          return;
        }

        const fallback = pickPortHost(loaded.userConfig as any);
        const explicitPort = typeof options.port === 'string' && options.port.trim() ? Number(options.port.trim()) : null;
        const port = explicitPort && Number.isFinite(explicitPort) && explicitPort > 0 ? explicitPort : fallback.port;
        const host = typeof options.host === 'string' && options.host.trim() ? options.host.trim() : fallback.host;
        if (!port || port <= 0) {
          const errorMsg = 'Missing port. Set via --port or config file.';
          ctx.logger.error(errorMsg);
          if (options.json) ctx.log(JSON.stringify({ error: errorMsg }, null, 2));
          return;
        }

        const status = await checkServer(ctx, port, host);
        const managedZombieChildren = resolveManagedZombieChildren(ctx, port);

        if (options.json) {
          ctx.log(JSON.stringify({
            ...status,
            managedZombieChildren
          }, null, 2));
        } else {
          printHuman(ctx, status);
          if (managedZombieChildren.length > 0) {
            const preview = managedZombieChildren
              .slice(0, 5)
              .map((item) => `${item.pid}(ppid=${item.ppid})`)
              .join(', ');
            ctx.logger.warning(
              `Detected ${managedZombieChildren.length} zombie child process(es) under managed RouteCodex parent(s): ${preview}`
            );
          }
        }
      } catch (error) {
        ctx.logger.error(`Status check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}
