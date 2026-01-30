import fs from 'node:fs';
import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
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
  warning: (msg: string) => void;
  success: (msg: string) => void;
  error: (msg: string) => void;
};

export type StartCommandOptions = {
  config?: string;
  port?: string;
  quotaRouting?: unknown;
  logLevel?: string;
  codex?: boolean;
  claude?: boolean;
  ua?: string;
  snap?: boolean;
  snapOff?: boolean;
  verboseErrors?: boolean;
  quietErrors?: boolean;
  restart?: boolean;
  exclusive?: boolean;
};

export type StartCommandContext = {
  isDevPackage: boolean;
  isWindows: boolean;
  defaultDevPort: number;
  nodeBin: string;
  createSpinner: (text: string) => Promise<Spinner>;
  logger: LoggerLike;
  env: NodeJS.ProcessEnv;
  fsImpl?: typeof fs;
  pathImpl?: typeof path;
  homedir?: () => string;
  tmpdir?: () => string;
  sleep: (ms: number) => Promise<void>;
  ensureLocalTokenPortalEnv: () => Promise<unknown>;
  ensureTokenDaemonAutoStart: () => Promise<void>;
  stopTokenDaemonIfRunning?: () => Promise<void>;
  ensurePortAvailable: (port: number, spinner: Spinner, opts?: { restart?: boolean }) => Promise<void>;
  findListeningPids: (port: number) => number[];
  killPidBestEffort: (pid: number, opts: { force: boolean }) => void;
  getModulesConfigPath: () => string;
  resolveServerEntryPath: () => string;
  spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  fetch: typeof fetch;
  setupKeypress: (onInterrupt: () => void) => () => void;
  waitForever: () => Promise<void>;
  onSignal?: (signal: NodeJS.Signals, cb: () => void) => void;
  exit: (code: number) => never;
};

function parseBoolish(value: unknown): boolean | undefined {
  if (typeof value !== 'string') {return undefined;}
  const normalized = value.trim().toLowerCase();
  if (!normalized) {return undefined;}
  if (['1', 'true', 'yes', 'on', 'enable', 'enabled'].includes(normalized)) {return true;}
  if (['0', 'false', 'no', 'off', 'disable', 'disabled'].includes(normalized)) {return false;}
  return undefined;
}

export function createStartCommand(program: Command, ctx: StartCommandContext): void {
  program
    .command('start')
    .description('Start the RouteCodex server')
    .option('-c, --config <config>', 'Configuration file path')
    .option('-p, --port <port>', 'RouteCodex server port (dev package only; overrides env/config)')
    .option('--quota-routing <mode>', 'Quota routing admission control (on|off). off => do not remove providers from pool based on quota')
    .option('--log-level <level>', 'Log level (debug, info, warn, error)', 'info')
    .option('--codex', 'Use Codex system prompt (tools unchanged)')
    .option('--claude', 'Use Claude system prompt (tools unchanged)')
    .option('--ua <mode>', 'Upstream User-Agent override mode (e.g., codex)')
    .option('--snap', 'Force-enable snapshot capture')
    .option('--snap-off', 'Disable snapshot capture')
    .option('--verbose-errors', 'Print verbose error stacks in console output')
    .option('--quiet-errors', 'Silence detailed error stacks')
    .option('--restart', 'Restart if an instance is already running')
    .option('--exclusive', 'Always take over the port (kill existing listeners)')
    .action(async (options: StartCommandOptions) => {
      const spinner = await ctx.createSpinner('Starting RouteCodex server...');

      const fsImpl = ctx.fsImpl ?? fs;
      const pathImpl = ctx.pathImpl ?? path;
      const home = ctx.homedir ?? (() => homedir());
      const tmp = ctx.tmpdir ?? (() => tmpdir());

      try {
        // Validate system prompt replacement flags
        if (options.codex && options.claude) {
          spinner.fail('Flags --codex and --claude are mutually exclusive');
          ctx.exit(1);
        }
        const explicitPromptFlag = options.codex ? 'codex' : (options.claude ? 'claude' : null);
        const uaFromFlag = typeof options.ua === 'string' && options.ua.trim() ? options.ua.trim() : null;
        const uaMode = uaFromFlag || (options.codex ? 'codex' : null);
        if (uaMode) {
          ctx.env.ROUTECODEX_UA_MODE = uaMode;
        }
        if (options.snap && options.snapOff) {
          spinner.fail('Flags --snap and --snap-off are mutually exclusive');
          ctx.exit(1);
        }
        if (options.snap) {
          ctx.env.ROUTECODEX_SNAPSHOT = '1';
        } else if (options.snapOff) {
          ctx.env.ROUTECODEX_SNAPSHOT = '0';
        }
        if (options.verboseErrors && options.quietErrors) {
          spinner.fail('Flags --verbose-errors and --quiet-errors are mutually exclusive');
          ctx.exit(1);
        }
        if (options.verboseErrors) {
          ctx.env.ROUTECODEX_VERBOSE_ERRORS = '1';
        } else if (options.quietErrors) {
          ctx.env.ROUTECODEX_VERBOSE_ERRORS = '0';
        }

        // Resolve config path
        let configPath = options.config;
        if (!configPath) {
          // Respect env overrides used by install/global verification scripts.
          // CLI flags still take precedence when provided.
          configPath =
            (ctx.env.ROUTECODEX_CONFIG_PATH || ctx.env.ROUTECODEX_CONFIG || '').trim() ||
            pathImpl.join(home(), '.routecodex', 'config.json');
        }

        // Ensure provided config path is a file (not a directory)
        if (fsImpl.existsSync(configPath)) {
          const stats = fsImpl.statSync(configPath);
          if (stats.isDirectory()) {
            spinner.fail(`Configuration path must be a file, received directory: ${configPath}`);
            ctx.exit(1);
          }
        }

        // Check if config exists; do NOT create defaults
        if (!fsImpl.existsSync(configPath)) {
          spinner.fail(`Configuration file not found: ${configPath}`);
          ctx.logger.error('Please create a RouteCodex user config first (e.g., ~/.routecodex/config.json).');
          ctx.logger.error('Or initialize via CLI:');
          ctx.logger.error('  rcc init');
          ctx.logger.error('  rcc config init');
          ctx.logger.error('Or specify a custom configuration file:');
          ctx.logger.error('  rcc start --config ./my-config.json');
          ctx.exit(1);
        }

        // Load and validate configuration (non-dev packages rely on config port)
        let config: any;
        try {
          const configContent = fsImpl.readFileSync(configPath, 'utf8');
          config = JSON.parse(configContent);
        } catch {
          spinner.fail('Failed to parse configuration file');
          ctx.logger.error(`Invalid JSON in configuration file: ${configPath}`);
          ctx.exit(1);
        }

        const promptFlag = explicitPromptFlag ?? null;
        if (promptFlag) {
          ctx.env.ROUTECODEX_SYSTEM_PROMPT_SOURCE = promptFlag;
          ctx.env.ROUTECODEX_SYSTEM_PROMPT_ENABLE = '1';
        }

        const quotaRoutingOverride = parseBoolish((options as { quotaRouting?: unknown }).quotaRouting);
        if ((options as { quotaRouting?: unknown }).quotaRouting !== undefined && quotaRoutingOverride === undefined) {
          spinner.fail('Invalid --quota-routing value. Use on|off');
          ctx.exit(1);
        }
        if (typeof quotaRoutingOverride === 'boolean') {
          const carrier = config && typeof config === 'object' ? (config as Record<string, unknown>) : {};
          const httpserver =
            carrier.httpserver && typeof carrier.httpserver === 'object' && carrier.httpserver !== null
              ? (carrier.httpserver as Record<string, unknown>)
              : {};
          carrier.httpserver = {
            ...httpserver,
            quotaRoutingEnabled: quotaRoutingOverride
          };
          config = carrier;

          const dir = fsImpl.mkdtempSync(pathImpl.join(tmp(), 'routecodex-config-'));
          const patchedPath = pathImpl.join(dir, 'config.json');
          fsImpl.writeFileSync(patchedPath, JSON.stringify(config, null, 2), 'utf8');
          configPath = patchedPath;
          spinner.info(`quota routing override: ${quotaRoutingOverride ? 'on' : 'off'} (temp config)`);
        }

        // Determine effective port:
        // - dev package (`routecodex`): env override, otherwise固定端口 DEFAULT_DEV_PORT
        // - release package (`rcc`): 严格按配置文件端口启动
        let resolvedPort: number;
        if (ctx.isDevPackage) {
          const flagPort = typeof options.port === 'string' ? Number(options.port) : NaN;
          if (!Number.isNaN(flagPort) && flagPort > 0) {
            ctx.logger.info(`Using port ${flagPort} from --port flag [dev package: routecodex]`);
            resolvedPort = flagPort;
          } else {
            const envPort = Number(ctx.env.ROUTECODEX_PORT || ctx.env.RCC_PORT || NaN);
            if (!Number.isNaN(envPort) && envPort > 0) {
              ctx.logger.info(`Using port ${envPort} from environment (ROUTECODEX_PORT/RCC_PORT) [dev package: routecodex]`);
              resolvedPort = envPort;
            } else {
              resolvedPort = ctx.defaultDevPort;
              ctx.logger.info(`Using dev default port ${resolvedPort} (routecodex dev package)`);
            }
          }
        } else {
          const port = (config?.httpserver?.port ?? config?.server?.port ?? config?.port);
          if (!port || typeof port !== 'number' || port <= 0) {
            spinner.fail('Invalid or missing port configuration');
            ctx.logger.error('Please set a valid port (httpserver.port or top-level port) in your configuration');
            ctx.exit(1);
          }
          resolvedPort = port;
        }

        // Ensure port state aligns with requested behavior
        // Preserve existing CLI behavior: always attempt takeover; "restart" flag is informational only here.
        await ctx.ensurePortAvailable(resolvedPort, spinner, { restart: true });

        const resolveServerHost = (): string => {
          if (typeof config?.httpserver?.host === 'string' && config.httpserver.host.trim()) {return config.httpserver.host;}
          if (typeof config?.server?.host === 'string' && config.server.host.trim()) {return config.server.host;}
          if (typeof config?.host === 'string' && config.host.trim()) {return config.host;}
          return LOCAL_HOSTS.LOCALHOST;
        };
        const serverHost = resolveServerHost();

        ctx.env.ROUTECODEX_PORT = String(resolvedPort);
        ctx.env.RCC_PORT = String(resolvedPort);
        ctx.env.ROUTECODEX_HTTP_HOST = serverHost;
        ctx.env.ROUTECODEX_HTTP_PORT = String(resolvedPort);
        await ctx.ensureLocalTokenPortalEnv();

        // Best-effort auto-start of token daemon (can be disabled via env)
        await ctx.ensureTokenDaemonAutoStart();

        const modulesConfigPath = ctx.getModulesConfigPath();
        if (!fsImpl.existsSync(modulesConfigPath)) {
          spinner.fail(`Modules configuration file not found: ${modulesConfigPath}`);
          ctx.exit(1);
        }

        const nodeBin = ctx.nodeBin || process.execPath;
        const serverEntry = ctx.resolveServerEntryPath();

        const env = { ...ctx.env } as NodeJS.ProcessEnv;
        env.ROUTECODEX_CONFIG = configPath;
        env.ROUTECODEX_CONFIG_PATH = configPath;
        if (ctx.isDevPackage) {
          env.ROUTECODEX_PORT = String(resolvedPort);
        }

        const args: string[] = [serverEntry, modulesConfigPath];
        const childProc = ctx.spawn(nodeBin, args, { stdio: 'inherit', env });

        try {
          const pidFile = pathImpl.join(home(), '.routecodex', 'server.cli.pid');
          fsImpl.writeFileSync(pidFile, String(childProc.pid ?? ''), 'utf8');
        } catch {
          /* ignore */
        }

        spinner.succeed(`RouteCodex server starting on ${serverHost}:${resolvedPort}`);
        ctx.logger.info(`Configuration loaded from: ${configPath}`);
        ctx.logger.info(`Server will run on port: ${resolvedPort}`);
        ctx.logger.info('Press Ctrl+C to stop the server');

        const shutdown = async (sig: NodeJS.Signals) => {
          try {
            await ctx.fetch(`${HTTP_PROTOCOLS.HTTP}${LOCAL_HOSTS.IPV4}:${resolvedPort}${API_PATHS.SHUTDOWN}`, { method: 'POST' }).catch(() => {});
          } catch {
            /* ignore */
          }
          try {
            childProc.kill(sig);
          } catch {
            /* ignore */
          }
          if (!ctx.isWindows) {
            try {
              if (childProc.pid) {
                process.kill(-childProc.pid, sig);
              }
            } catch {
              /* ignore */
            }
          }
          const deadline = Date.now() + 3500;
          while (Date.now() < deadline) {
            if (ctx.findListeningPids(resolvedPort).length === 0) {break;}
            await ctx.sleep(120);
          }
          const remain = ctx.findListeningPids(resolvedPort);
          if (remain.length) {
            for (const pid of remain) {ctx.killPidBestEffort(pid, { force: false });}
            const killDeadline = Date.now() + 1500;
            while (Date.now() < killDeadline) {
              if (ctx.findListeningPids(resolvedPort).length === 0) {break;}
              await ctx.sleep(100);
            }
          }
          const still = ctx.findListeningPids(resolvedPort);
          if (still.length) {
            for (const pid of still) {ctx.killPidBestEffort(pid, { force: true });}
          }
          if (ctx.isDevPackage) {
            await ctx.stopTokenDaemonIfRunning?.();
          }
          try {
            ctx.exit(0);
          } catch {
            /* ignore */
          }
        };

        const onSignal = ctx.onSignal ?? ((sig: NodeJS.Signals, cb: () => void) => process.on(sig, cb));
        onSignal('SIGINT', () => { void shutdown('SIGINT'); });
        onSignal('SIGTERM', () => { void shutdown('SIGTERM'); });

        const cleanupKeypress = ctx.setupKeypress(() => { void shutdown('SIGINT'); });
        childProc.on('exit', (code, signal) => {
          try { cleanupKeypress(); } catch { /* ignore */ }
          if (signal) {ctx.exit(0);}
          ctx.exit(code ?? 0);
        });

        await ctx.waitForever();
      } catch (error) {
        spinner.fail('Failed to start server');
        ctx.logger.error(error instanceof Error ? error.message : String(error));
        ctx.exit(1);
      }
    });
}
