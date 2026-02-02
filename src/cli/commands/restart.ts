import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import type { Command } from 'commander';

import { API_PATHS, HTTP_PROTOCOLS, LOCAL_HOSTS } from '../../constants/index.js';

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

export type RestartCommandOptions = {
  config?: string;
  logLevel?: string;
  codex?: boolean;
  claude?: boolean;
};

export type RestartCommandContext = {
  isDevPackage: boolean;
  isWindows: boolean;
  defaultDevPort: number;
  createSpinner: (text: string) => Promise<Spinner>;
  logger: LoggerLike;
  findListeningPids: (port: number) => number[];
  sleep: (ms: number) => Promise<void>;
  sendSignal: (pid: number, signal: NodeJS.Signals) => void;
  fetch: typeof fetch;
  env?: NodeJS.ProcessEnv;
  fsImpl?: Pick<typeof fs, 'existsSync' | 'readFileSync'>;
  pathImpl?: Pick<typeof path, 'join'>;
  getHomeDir?: () => string;
  exit: (code: number) => never;
};

function parseConfigPortHost(config: any): { port: number; host: string } {
  const port = (config?.httpserver?.port ?? config?.server?.port ?? config?.port);
  const host = (config?.httpserver?.host ?? config?.server?.host ?? config?.host ?? LOCAL_HOSTS.LOCALHOST);
  return { port, host };
}

function resolvePortHost(ctx: RestartCommandContext, options: RestartCommandOptions, spinner: Spinner): { port: number; host: string } {
  if (ctx.isDevPackage) {
    const envPort = Number(ctx.env?.ROUTECODEX_PORT || ctx.env?.RCC_PORT || NaN);
    if (!Number.isNaN(envPort) && envPort > 0) {
      ctx.logger.info(
        `Using port ${envPort} from environment (ROUTECODEX_PORT/RCC_PORT) [dev package: routecodex]`
      );
      return { port: envPort, host: LOCAL_HOSTS.LOCALHOST };
    }
    const resolvedPort = ctx.defaultDevPort;
    ctx.logger.info(`Using dev default port ${resolvedPort} (routecodex dev package)`);
    return { port: resolvedPort, host: LOCAL_HOSTS.LOCALHOST };
  }

  const fsImpl = ctx.fsImpl ?? fs;
  const pathImpl = ctx.pathImpl ?? path;
  const home = ctx.getHomeDir ?? (() => homedir());
  const configPath = options.config || pathImpl.join(home(), '.routecodex', 'config.json');

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

  const { port, host } = parseConfigPortHost(config);
  if (!port || typeof port !== 'number' || port <= 0) {
    spinner.fail('Invalid or missing port configuration');
    ctx.logger.error('Configuration file must specify a valid port number');
    ctx.exit(1);
  }
  return { port, host: String(host || LOCAL_HOSTS.LOCALHOST) };
}

async function waitForRestart(ctx: RestartCommandContext, host: string, port: number, oldPids: number[]): Promise<void> {
  const deadline = Date.now() + 15000;
  const old = new Set(oldPids);
  let sawNewPid = false;
  while (Date.now() < deadline) {
    const current = ctx.findListeningPids(port);
    if (current.some((pid) => !old.has(pid))) {
      sawNewPid = true;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => {
          try { controller.abort(); } catch { /* ignore */ }
        }, 750);
        const res = await ctx.fetch(`${HTTP_PROTOCOLS.HTTP}${host}:${port}${API_PATHS.HEALTH}`, { signal: controller.signal }).catch(() => null);
        clearTimeout(timeout);
        if (res && res.ok) {
          return;
        }
      } catch {
        // ignore health failures during restart window
      }
    }
    await ctx.sleep(sawNewPid ? 250 : 150);
  }
  throw new Error('Timeout waiting for server to restart');
}

export function createRestartCommand(program: Command, ctx: RestartCommandContext): void {
  program
    .command('restart')
    .description('Restart the RouteCodex server')
    .option('-c, --config <config>', 'Configuration file path')
    .option('--log-level <level>', 'Log level (debug, info, warn, error)', 'info')
    .option('--codex', 'Use Codex system prompt (tools unchanged)')
    .option('--claude', 'Use Claude system prompt (tools unchanged)')
    .action(async (options: RestartCommandOptions) => {
      const spinner = await ctx.createSpinner('Restarting RouteCodex server...');
      try {
        const { port: resolvedPort, host: resolvedHost } = resolvePortHost(ctx, options, spinner);

        // Prompt flags cannot be applied via a signal-based restart (server reloads from its own config/env).
        if (options.codex || options.claude) {
          spinner.fail('Flags --codex/--claude are not supported for restart; edit config/env and restart again.');
          ctx.exit(1);
        }

        const pids = ctx.findListeningPids(resolvedPort);
        if (!pids.length) {
          spinner.fail(`No RouteCodex server found on ${resolvedHost}:${resolvedPort}`);
          ctx.exit(1);
        }

        if (ctx.isWindows) {
          spinner.fail('Signal-based restart is not supported on Windows');
          ctx.exit(1);
        }

        spinner.text = `Sending restart signal to ${pids.length} process(es)...`;
        for (const pid of pids) {
          try {
            ctx.sendSignal(pid, 'SIGUSR2');
          } catch {
            // best-effort: continue broadcasting
          }
        }

        spinner.text = 'Waiting for server to restart...';
        await waitForRestart(ctx, resolvedHost || LOCAL_HOSTS.LOCALHOST, resolvedPort, pids);

        spinner.succeed(`RouteCodex server restarted on ${resolvedHost}:${resolvedPort}`);
      } catch (e) {
        spinner.fail(`Failed to restart: ${(e as Error).message}`);
        ctx.exit(1);
      }
    });
}
