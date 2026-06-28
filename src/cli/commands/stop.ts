import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import type { Command } from 'commander';
import { LOCAL_HOSTS } from '../../constants/index.js';
import { resolveRccUserDir } from '../../config/user-data-paths.js';
import { resolveRouteCodexConfigPath } from '../../config/config-paths.js';
import { decodeUserConfigFileSync } from '../../config/user-config-codec.js';
import { resolvePortGroupFromConfig } from './port-group-resolver.js';
import { logProcessLifecycleSync } from '../../utils/process-lifecycle-logger.js';
import { writeDaemonStopIntent } from '../../utils/daemon-stop-intent.js';
import { updateRuntimeInstanceStatus } from '../../utils/runtime-instance-registry.js';
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
  port?: string;
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
  let configPath: string;
  try {
    configPath = resolveRouteCodexConfigPath();
  } catch (error) {
    spinner.fail(error instanceof Error ? error.message : 'Configuration file not found');
    ctx.logger.error('Cannot determine server port without configuration file');
    ctx.logger.info('Please create a configuration file first:');
    ctx.logger.info('  rcc init');
    ctx.logger.info('  rcc config init');
    ctx.exit(1);
  }

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
    config = decodeUserConfigFileSync(
      configPath,
      fsImpl as Pick<typeof fs, 'readFileSync'>
    ).parsed;
  } catch {
    spinner.fail('Failed to parse configuration file');
    ctx.logger.error(`Invalid configuration file: ${configPath}`);
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
    .option('-p, --port <port>', 'RouteCodex server port')
    .action(async (options: StopCommandOptions) => {
      const spinner = await ctx.createSpinner('Stopping RouteCodex server...');
      const callerAudit = buildCallerAudit();
      try {
        const expectedPassword = resolveStopPassword(ctx);
        enforceStopPassword(options?.password, expectedPassword, spinner, ctx);

        const explicitPort = typeof options?.port === 'string' && options.port.trim() ? Number(options.port.trim()) : NaN;
        const basePort = Number.isFinite(explicitPort) && explicitPort > 0 ? explicitPort : resolveStopPort(ctx, spinner);
        const grouped = ctx.isDevPackage ? null : resolvePortGroupFromConfig(ctx, { targetPort: basePort });
        const targetPorts = grouped?.ports?.length ? grouped.ports : [basePort];
        if (targetPorts.length > 1) {
          ctx.logger.info(`[stop] resolved config port-group: ${targetPorts.join(', ')}`);
        }
        const reportLifecycle = async (event: GuardianLifecycleEvent): Promise<void> => {
          const ok = await ctx.reportGuardianLifecycle?.(event);
          if (ctx.reportGuardianLifecycle && ok !== true) {
            throw new Error(`guardian lifecycle apply rejected (${event.action})`);
          }
        };
        const finalizeStop = async (resolvedPort: number): Promise<void> => {
          await reportLifecycle({
            action: 'stop_finalize',
            source: 'cli.stop',
            actorPid: process.pid,
            metadata: { port: resolvedPort }
          });
          await ctx.stopGuardianDaemon?.();
        };
        for (const resolvedPort of targetPorts) {
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
            const home = ctx.getHomeDir ?? (() => homedir());
            const routeCodexHomeDir = resolveRccUserDir(home());
            writeDaemonStopIntent(resolvedPort, {
              source: 'cli.stop',
              routeCodexHomeDir,
              pid: process.pid
            });
            try {
              updateRuntimeInstanceStatus({
                port: resolvedPort,
                status: 'shutdown-intent',
                routeCodexHomeDir,
                notes: { source: 'cli.stop' }
              });
            } catch (error) {
              logProcessLifecycleSync({
                event: 'stop_command',
                source: 'cli.stop',
                details: {
                  result: 'instance_registry_update_failed',
                  port: resolvedPort,
                  error: error instanceof Error ? error.message : String(error)
                }
              });
            }
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
            await finalizeStop(resolvedPort);
            continue;
          }

          await reportLifecycle({
            action: 'stop_http_shutdown_request',
            source: 'cli.stop',
            actorPid: process.pid,
            metadata: { port: resolvedPort }
          });
          const httpShutdownAccepted = await attemptHttpShutdown(ctx, resolvedPort, callerAudit);
          const gracefulDeadline = Date.now() + 3000;
          let stopped = false;
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
              await finalizeStop(resolvedPort);
              stopped = true;
              break;
            }
            await ctx.sleep(100);
          }
          if (stopped) {
            continue;
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
        }
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
