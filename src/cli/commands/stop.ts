import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import type { Command } from 'commander';

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

export type StopCommandContext = {
  isDevPackage: boolean;
  defaultDevPort: number;
  createSpinner: (text: string) => Promise<Spinner>;
  logger: LoggerLike;
  findListeningPids: (port: number) => number[];
  killPidBestEffort: (pid: number, opts: { force: boolean }) => void;
  sleep: (ms: number) => Promise<void>;
  stopTokenDaemonIfRunning?: () => Promise<void>;
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

export function createStopCommand(program: Command, ctx: StopCommandContext): void {
  program
    .command('stop')
    .description('Stop the RouteCodex server')
    .action(async () => {
      const spinner = await ctx.createSpinner('Stopping RouteCodex server...');
      try {
        const resolvedPort = resolveStopPort(ctx, spinner);

        const pids = ctx.findListeningPids(resolvedPort);
        if (!pids.length) {
          spinner.succeed(`No server listening on ${resolvedPort}.`);
          if (ctx.isDevPackage) {
            await ctx.stopTokenDaemonIfRunning?.();
          }
          return;
        }

        for (const pid of pids) {
          ctx.killPidBestEffort(pid, { force: false });
        }

        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          if (ctx.findListeningPids(resolvedPort).length === 0) {
            spinner.succeed(`Stopped server on ${resolvedPort}.`);
            if (ctx.isDevPackage) {
              await ctx.stopTokenDaemonIfRunning?.();
            }
            return;
          }
          await ctx.sleep(100);
        }

        const remain = ctx.findListeningPids(resolvedPort);
        if (remain.length) {
          for (const pid of remain) {
            ctx.killPidBestEffort(pid, { force: true });
          }
        }
        spinner.succeed(`Force stopped server on ${resolvedPort}.`);
        if (ctx.isDevPackage) {
          await ctx.stopTokenDaemonIfRunning?.();
        }
      } catch (e) {
        spinner.fail(`Failed to stop: ${(e as Error).message}`);
        ctx.exit(1);
      }
    });
}

