import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
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
  killPidBestEffort: (pid: number, opts: { force: boolean }) => void;
  sleep: (ms: number) => Promise<void>;
  getModulesConfigPath: () => string;
  resolveServerEntryPath: () => string;
  nodeBin: string;
  spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  fetch: typeof fetch;
  setupKeypress: (onInterrupt: () => void) => () => void;
  waitForever: () => Promise<void>;
  env?: NodeJS.ProcessEnv;
  fsImpl?: Pick<typeof fs, 'existsSync' | 'readFileSync' | 'writeFileSync'>;
  pathImpl?: Pick<typeof path, 'join'>;
  getHomeDir?: () => string;
  onSignal?: (signal: NodeJS.Signals, cb: () => void) => void;
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

async function stopExisting(ctx: RestartCommandContext, port: number): Promise<void> {
  const pids = ctx.findListeningPids(port);
  if (!pids.length) return;

  for (const pid of pids) {
    ctx.killPidBestEffort(pid, { force: false });
  }
  const deadline = Date.now() + 3500;
  while (Date.now() < deadline) {
    if (ctx.findListeningPids(port).length === 0) {
      break;
    }
    await ctx.sleep(120);
  }
  const remain = ctx.findListeningPids(port);
  for (const pid of remain) {
    ctx.killPidBestEffort(pid, { force: true });
  }
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

        await stopExisting(ctx, resolvedPort);

        spinner.text = 'Starting RouteCodex server...';

        // Prompt source flags
        if (options.codex && options.claude) {
          spinner.fail('Flags --codex and --claude are mutually exclusive');
          ctx.exit(1);
        }
        const restartPrompt = options.codex ? 'codex' : (options.claude ? 'claude' : null);
        if (restartPrompt) {
          // Preserve existing behavior: mutate env for child.
          ctx.env = ctx.env || process.env;
          ctx.env.ROUTECODEX_SYSTEM_PROMPT_SOURCE = restartPrompt;
          ctx.env.ROUTECODEX_SYSTEM_PROMPT_ENABLE = '1';
        }

        const modulesConfigPath = ctx.getModulesConfigPath();
        const serverEntry = ctx.resolveServerEntryPath();
        const env = { ...(ctx.env || process.env) } as NodeJS.ProcessEnv;
        const args: string[] = [serverEntry, modulesConfigPath];
        const child = ctx.spawn(ctx.nodeBin, args, { stdio: 'inherit', env });

        const fsImpl = ctx.fsImpl ?? fs;
        const pathImpl = ctx.pathImpl ?? path;
        const home = ctx.getHomeDir ?? (() => homedir());
        try {
          fsImpl.writeFileSync(pathImpl.join(home(), '.routecodex', 'server.cli.pid'), String(child.pid ?? ''), 'utf8');
        } catch {
          /* ignore */
        }

        spinner.succeed(`RouteCodex server restarting on ${resolvedHost}:${resolvedPort}`);
        ctx.logger.info(`Server will run on port: ${resolvedPort}`);
        ctx.logger.info('Press Ctrl+C to stop the server');

        const shutdown = async (sig: NodeJS.Signals) => {
          try {
            await ctx.fetch(`${HTTP_PROTOCOLS.HTTP}${LOCAL_HOSTS.IPV4}:${resolvedPort}${API_PATHS.SHUTDOWN}`, { method: 'POST' }).catch(() => {});
          } catch {
            /* ignore */
          }
          try {
            child.kill(sig);
          } catch {
            /* ignore */
          }
          if (!ctx.isWindows) {
            try {
              if (child.pid) {
                process.kill(-child.pid, sig);
              }
            } catch {
              /* ignore */
            }
          }
          const deadline = Date.now() + 3500;
          while (Date.now() < deadline) {
            if (ctx.findListeningPids(resolvedPort).length === 0) {
              break;
            }
            await ctx.sleep(100);
          }
          const still = ctx.findListeningPids(resolvedPort);
          for (const pid of still) {
            ctx.killPidBestEffort(pid, { force: true });
          }
          try {
            ctx.exit(0);
          } catch {
            /* ignore */
          }
        };

        const onSignal = ctx.onSignal ?? ((sig: NodeJS.Signals, cb: () => void) => {
          process.on(sig, cb);
        });
        onSignal('SIGINT', () => { void shutdown('SIGINT'); });
        onSignal('SIGTERM', () => { void shutdown('SIGTERM'); });

        const cleanupKeypress2 = ctx.setupKeypress(() => { void shutdown('SIGINT'); });

        child.on('exit', (code, signal) => {
          try { cleanupKeypress2(); } catch { /* ignore */ }
          if (signal) ctx.exit(0);
          ctx.exit(code ?? 0);
        });

        await ctx.waitForever();
      } catch (e) {
        spinner.fail(`Failed to restart: ${(e as Error).message}`);
        ctx.exit(1);
      }
    });
}
