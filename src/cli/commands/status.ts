import type { Command } from 'commander';

import { LOCAL_HOSTS } from '../../constants/index.js';
import type { LoadedRouteCodexConfig } from '../../config/routecodex-config-loader.js';

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
  error?: string;
};

export type StatusCommandContext = {
  logger: LoggerLike;
  log: (line: string) => void;
  loadConfig: () => Promise<LoadedRouteCodexConfig>;
  fetch: typeof fetch;
};

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
    try {
      controller.abort();
    } catch {
      /* ignore */
    }
  }, 5000);

  try {
    const url = `http://${host}:${port}/health`;
    const res = await ctx.fetch(url, { method: 'GET', signal: controller.signal });
    const responseTime = Date.now() - startedAt;
    if (!res.ok) {
      return { status: 'error', port, host, responseTime };
    }
    const data = await res.json().catch(() => null);
    const status = data?.status ? String(data.status) : 'unknown';
    return { status, port, host, responseTime };
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
      ctx.logger.success(`Server is running on ${status.host}:${status.port}`);
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

export function createStatusCommand(program: Command, ctx: StatusCommandContext): void {
  program
    .command('status')
    .description('Show server status')
    .option('-j, --json', 'Output in JSON format')
    .action(async (options: { json?: boolean }) => {
      try {
        let loaded: LoadedRouteCodexConfig | null = null;
        try {
          loaded = await ctx.loadConfig();
        } catch {
          loaded = null;
        }

        if (!loaded) {
          ctx.logger.error('Configuration file not found');
          ctx.logger.info('Please create a configuration file first:');
          ctx.logger.info('  rcc config init');
          if (options.json) {
            ctx.log(JSON.stringify({ error: 'Configuration file not found' }, null, 2));
          }
          return;
        }

        const { port, host } = pickPortHost(loaded.userConfig as any);
        if (!port || port <= 0) {
          const errorMsg = 'Invalid or missing port configuration in configuration file';
          ctx.logger.error(errorMsg);
          if (options.json) {
            ctx.log(JSON.stringify({ error: errorMsg }, null, 2));
          }
          return;
        }

        const status = await checkServer(ctx, port, host);
        if (options.json) {
          ctx.log(JSON.stringify(status, null, 2));
        } else {
          printHuman(ctx, status);
        }
      } catch (error) {
        ctx.logger.error(`Status check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

