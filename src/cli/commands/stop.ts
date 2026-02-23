import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import type { Command } from 'commander';
import { LOCAL_HOSTS } from '../../constants/index.js';
import { logProcessLifecycleSync } from '../../utils/process-lifecycle-logger.js';
import { writeDaemonStopIntent } from '../../utils/daemon-stop-intent.js';
import type { GuardianLifecycleEvent, GuardianStopResult } from '../guardian/types.js';

type Spinner = {
  start(text?: string): Spinner;
  succeed(text?: string): void;
  fail(text?: string): void;
  warn(text?: string): void;
  info(text?: string): void;
  stop(): void;
  text: string;
};

type LoggerLike = {
  info: (msg: string) => void;
  error: (msg: string) => void;
};

interface StopCommandOptions {
  password?: string;
}

interface StopCallerAudit {
  callerTs: string;
  callerPid: number;
  callerCwd: string;
  callerCmd: string;
}

export type StopCommandContext = {
  isDevPackage: boolean;
  defaultDevPort: number;
  createSpinner: (text: string) => Promise<Spinner>;
  logger: LoggerLike;
  findListeningPids: (port: number) => number[];
  killPidBestEffort: (pid: number, opts: { force: boolean }) => void;
  sleep: (ms: number) => Promise<void>;
  stopTokenDaemonIfRunning?: () => Promise<void>;
  stopGuardianDaemon?: () => Promise<GuardianStopResult>;
  reportGuardianLifecycle?: (event: GuardianLifecycleEvent) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  fsImpl?: Pick<typeof fs, 'existsSync' | 'readFileSync'>;
  pathImpl?: Pick<typeof path, 'join'>;
  getHomeDir?: () => string;
  exit: (code: number) => never;
};

function parseConfigPort(config: any): number {
  const port = config?.httpserver?.port ?? config?.server?.port ?? config?.port;
  return typeof port === 'number' && Number.isFinite(port) ? port : NaN;
}

function resolveStopPort(ctx: StopCommandContext, spinner: Spinner): number {
  if (ctx.isDevPackage) {
    const envPort = Number(ctx.env?.ROUTECODEX_PORT || ctx.env?.RCC_PORT || NaN);
    if (!Number.isNaN(envPort) && envPort > 0) {
      ctx.logger.info(
        `Using port ${envPort} from environment (ROUTECODEX_PORT/RCC_PORT) [dev package: routecodex]`
      );
      return envPort;
    }
    const resolvedPort = ctx.defaultDevPort;
    ctx.logger.info(`Using dev default port ${resolvedPort} (routecodex dev package)`);
    return resolvedPort;
  }

  const fsImpl = ctx.fsImpl ?? fs;
  const pathImpl = ctx.pathImpl ?? path;
  const home = ctx.getHomeDir ?? (() => homedir());
  const configPath = pathImpl.join(home(), '.routecodex', 'config.json');

  if (!fsImpl.existsSync(configPath)) {
    spinner.fail(`Configuration file not found: ${configPath}`);
    ctx.logger.error('Cannot determine server port without configuration file');
    ctx.logger.info('Please create a configuration file first:');
    ctx.logger.info('  rcc init');
    ctx.logger.info('  rcc config init');
    ctx.exit(1);
  }

  let config: any;
  try {
    const configContent = fsImpl.readFileSync(configPath, 'utf8');
    config = JSON.parse(configContent);
  } catch {
    spinner.fail('Failed to parse configuration file');
    ctx.logger.error(`Invalid JSON in configuration file: ${configPath}`);
    ctx.exit(1);
  }

  const port = parseConfigPort(config);
  if (!Number.isFinite(port) || port <= 0) {
    spinner.fail('Invalid or missing port configuration');
    ctx.logger.error('Configuration file must specify a valid port number');
    ctx.exit(1);
  }

  return port;
}

function resolveStopPassword(ctx: StopCommandContext): string | null {
  const configured = ctx.env?.ROUTECODEX_STOP_PASSWORD || ctx.env?.RCC_STOP_PASSWORD;
  if (typeof configured === 'string' && configured.trim()) {
    return configured.trim();
  }
  return null;
}

function enforceStopPassword(
  providedPassword: string | undefined,
  expectedPassword: string | null,
  spinner: Spinner,
  ctx: StopCommandContext
): void {
  if (!expectedPassword) {
    return;
  }
  if (providedPassword === expectedPassword) {
    return;
  }
  spinner.fail('Stop denied: invalid password.');
  ctx.logger.error('Stop denied. Use --password <value> (or configure ROUTECODEX_STOP_PASSWORD).');
  ctx.exit(1);
}

function buildCallerAudit(): StopCallerAudit {
  return {
    callerTs: new Date().toISOString(),
    callerPid: process.pid,
    callerCwd: process.cwd(),
    callerCmd: process.argv.join(' ').slice(0, 1024)
  };
}

function resolveFetchImpl(ctx: StopCommandContext): typeof fetch | null {
  if (typeof ctx.fetchImpl === 'function') {
    return ctx.fetchImpl;
  }
  if (typeof fetch === 'function') {
    return fetch;
  }
  return null;
}

async function attemptHttpShutdown(
  ctx: StopCommandContext,
  resolvedPort: number,
  callerAudit: StopCallerAudit
): Promise<boolean> {
  const fetchImpl = resolveFetchImpl(ctx);
  if (!fetchImpl) {
    return false;
  }

  const candidates = [LOCAL_HOSTS.IPV4, LOCAL_HOSTS.LOCALHOST];
  for (const host of candidates) {
    try {
      logProcessLifecycleSync({
        event: 'stop_http_shutdown',
        source: 'cli.stop',
        details: {
          result: 'attempt',
          host,
          port: resolvedPort,
          ...callerAudit
        }
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        try {
          controller.abort();
        } catch {
          /* ignore */
        }
      }, 1200);

      const response = await fetchImpl(`http://${host}:${resolvedPort}/shutdown`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'x-routecodex-stop-caller-pid': String(callerAudit.callerPid),
          'x-routecodex-stop-caller-ts': callerAudit.callerTs,
          'x-routecodex-stop-caller-cwd': callerAudit.callerCwd,
          'x-routecodex-stop-caller-cmd': callerAudit.callerCmd
        }
      });
      clearTimeout(timeout);

      logProcessLifecycleSync({
        event: 'stop_http_shutdown',
        source: 'cli.stop',
        details: {
          result: response.ok ? 'accepted' : 'rejected',
          host,
          port: resolvedPort,
          statusCode: response.status,
          ...callerAudit
        }
      });

      if (response.ok) {
        return true;
      }
    } catch (error) {
      logProcessLifecycleSync({
        event: 'stop_http_shutdown',
        source: 'cli.stop',
        details: {
          result: 'failed',
          host,
          port: resolvedPort,
          error,
          ...callerAudit
        }
      });
    }
  }

  return false;
}

export function createStopCommand(program: Command, ctx: StopCommandContext): void {
  program
    .command('stop')
    .description('Stop the RouteCodex server')
    .option('--password <password>', 'Password required to stop server')
    .action(async (options: StopCommandOptions) => {
      const spinner = await ctx.createSpinner('Stopping RouteCodex server...');
      const callerAudit = buildCallerAudit();
      try {
        const expectedPassword = resolveStopPassword(ctx);
        enforceStopPassword(options?.password, expectedPassword, spinner, ctx);

        const resolvedPort = resolveStopPort(ctx, spinner);
        const reportLifecycle = async (event: GuardianLifecycleEvent): Promise<void> => {
          const ok = await ctx.reportGuardianLifecycle?.(event);
          if (ctx.reportGuardianLifecycle && ok !== true) {
            throw new Error(`guardian lifecycle apply rejected (${event.action})`);
          }
        };
        const finalizeStop = async (): Promise<void> => {
          await reportLifecycle({
            action: 'stop_finalize',
            source: 'cli.stop',
            actorPid: process.pid,
            metadata: { port: resolvedPort }
          });
          if (ctx.isDevPackage) {
            await ctx.stopTokenDaemonIfRunning?.();
          }
          await ctx.stopGuardianDaemon?.();
        };
        logProcessLifecycleSync({
          event: 'stop_command',
          source: 'cli.stop',
          details: {
            result: 'requested',
            port: resolvedPort,
            ...callerAudit
          }
        });

        try {
          const pathImpl = ctx.pathImpl ?? path;
          const home = ctx.getHomeDir ?? (() => homedir());
          writeDaemonStopIntent(resolvedPort, {
            source: 'cli.stop',
            routeCodexHomeDir: pathImpl.join(home(), '.routecodex'),
            pid: process.pid
          });
        } catch {
          /* ignore */
        }

        const pids = ctx.findListeningPids(resolvedPort);
        if (!pids.length) {
          spinner.succeed(`No server listening on ${resolvedPort}.`);
          logProcessLifecycleSync({
            event: 'stop_command',
            source: 'cli.stop',
            details: {
              result: 'no_server',
              port: resolvedPort,
              ...callerAudit
            }
          });
          await finalizeStop();
          return;
        }

        await reportLifecycle({
          action: 'stop_http_shutdown_request',
          source: 'cli.stop',
          actorPid: process.pid,
          metadata: { port: resolvedPort }
        });
        const httpShutdownAccepted = await attemptHttpShutdown(ctx, resolvedPort, callerAudit);
        const gracefulDeadline = Date.now() + 3000;
        while (Date.now() < gracefulDeadline) {
          if (ctx.findListeningPids(resolvedPort).length === 0) {
            spinner.succeed(`Stopped server on ${resolvedPort}.`);
            logProcessLifecycleSync({
              event: 'stop_command',
              source: 'cli.stop',
              details: {
                result: httpShutdownAccepted ? 'stopped_via_http_shutdown' : 'stopped_after_wait',
                port: resolvedPort,
                ...callerAudit
              }
            });
            await finalizeStop();
            return;
          }
          await ctx.sleep(100);
        }

        const remain = ctx.findListeningPids(resolvedPort);
        spinner.fail(`Graceful stop timed out on ${resolvedPort}; direct signal fallback is disabled.`);
        logProcessLifecycleSync({
          event: 'stop_command',
          source: 'cli.stop',
          details: {
            result: 'graceful_timeout_no_fallback',
            port: resolvedPort,
            remainingPids: remain,
            ...callerAudit
          }
        });
        ctx.exit(1);
      } catch (e) {
        logProcessLifecycleSync({
          event: 'stop_command',
          source: 'cli.stop',
          details: {
            result: 'failed',
            error: e,
            ...callerAudit
          }
        });
        spinner.fail(`Failed to stop: ${(e as Error).message}`);
        ctx.exit(1);
      }
    });
}
