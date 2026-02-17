import fs from 'node:fs';
import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { Command } from 'commander';

import { API_PATHS, HTTP_PROTOCOLS, LOCAL_HOSTS } from '../../constants/index.js';
import { logProcessLifecycleSync } from '../../utils/process-lifecycle-logger.js';
import { ensureDefaultPrecommandScriptBestEffort } from '../config/precommand-default-script.js';
import {
  clearDaemonStopIntent,
  consumeDaemonStopIntent
} from '../../utils/daemon-stop-intent.js';
import {
  buildStartCommandArgs,
  isDaemonSupervisorProcess,
  normalizeRunMode,
  parseBoolish,
  resolveDaemonRestartDelayMs,
  resolveReleaseDaemonEnabled
} from './start-utils.js';
import type { StartCommandContext, StartCommandOptions } from './start-types.js';

export type { StartCommandContext, StartCommandOptions } from './start-types.js';

export function createStartCommand(program: Command, ctx: StartCommandContext): void {
  program
    .command('start')
    .description('Start the RouteCodex server')
    .option('-c, --config <config>', 'Configuration file path')
    .option('-p, --port <port>', 'RouteCodex server port (dev package only; overrides env/config)')
    .option('--mode <mode>', 'Run mode (router|analysis|server). analysis => router + force snapshots', 'router')
    .option('--quota-routing <mode>', 'Quota routing admission control (on|off). off => do not remove providers from pool based on quota')
    .option('--log-level <level>', 'Log level (debug, info, warn, error)', 'info')
    .option('--codex', 'Use Codex system prompt (tools unchanged)')
    .option('--claude', 'Use Claude system prompt (tools unchanged)')
    .option('--ua <mode>', 'Upstream User-Agent override mode (e.g., codex)')
    .option('--snap', 'Force-enable snapshot capture')
    .option('--snap-off', 'Disable snapshot capture')
    .option('--verbose-errors', 'Print verbose error stacks in console output')
    .option('--quiet-errors', 'Silence detailed error stacks')
    .option('--restart', 'Restart if an instance is already running (default: on)', true)
    .option('--no-restart', 'Do not restart when an instance is already running')
    .option('--exclusive', 'Always take over the port (kill existing listeners)')
    .action(async (options: StartCommandOptions) => {
      const spinner = await ctx.createSpinner('Starting RouteCodex server...');

      const fsImpl = ctx.fsImpl ?? fs;
      const pathImpl = ctx.pathImpl ?? path;
      const home = ctx.homedir ?? (() => homedir());
      const tmp = ctx.tmpdir ?? (() => tmpdir());

      try {
        const runMode = normalizeRunMode(options.mode) ?? 'router';
        ctx.env.RCC_MODE = runMode;
        ctx.env.ROUTECODEX_MODE = runMode;

        if (options.snapOff && runMode === 'analysis') {
          spinner.fail('Flags --snap-off and --mode analysis are mutually exclusive');
          ctx.exit(1);
        }

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
        const forceSnapshots = runMode === 'analysis' || options.snap === true;
        if (forceSnapshots) {
          ctx.env.ROUTECODEX_SNAPSHOT = '1';
          ctx.env.ROUTECODEX_HUB_SNAPSHOTS = ctx.env.ROUTECODEX_HUB_SNAPSHOTS || '1';
          // Analysis mode should be able to capture streaming payloads even in release builds.
          // Keep this opt-in via --mode analysis (or explicit env override).
          ctx.env.ROUTECODEX_CAPTURE_STREAM_SNAPSHOTS = ctx.env.ROUTECODEX_CAPTURE_STREAM_SNAPSHOTS || '1';
        } else if (options.snapOff) {
          ctx.env.ROUTECODEX_SNAPSHOT = '0';
          ctx.env.ROUTECODEX_HUB_SNAPSHOTS = ctx.env.ROUTECODEX_HUB_SNAPSHOTS || '0';
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

        // Ensure port state aligns with requested behavior.
        // Default behavior is takeover/restart; pass --no-restart for legacy non-disruptive mode.
        const shouldRestart = options.restart !== false || options.exclusive === true;
        await ctx.ensurePortAvailable(resolvedPort, spinner, { restart: shouldRestart });

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
        const childProcessEnv = {
          ...env,
          ROUTECODEX_EXPECT_PARENT_PID: String(process.pid),
          RCC_EXPECT_PARENT_PID: String(process.pid)
        } as NodeJS.ProcessEnv;

        const args: string[] = [serverEntry, modulesConfigPath];
        const routeCodexHome = pathImpl.join(home(), '.routecodex');
        const defaultPrecommand = ensureDefaultPrecommandScriptBestEffort({
          fsImpl,
          pathImpl,
          homeDir: home()
        });
        if (!defaultPrecommand.ok) {
          spinner.warn(
            `Failed to ensure default precommand script (${defaultPrecommand.scriptPath}): ${defaultPrecommand.message || 'unknown error'}`
          );
        }
        const writePidFile = (pid: number | undefined): void => {
          try {
            fsImpl.mkdirSync(routeCodexHome, { recursive: true });
            const pidFile = pathImpl.join(routeCodexHome, `server-${resolvedPort}.pid`);
            fsImpl.writeFileSync(pidFile, String(pid ?? ''), 'utf8');
          } catch {
            /* ignore */
          }
        };

        const daemonEnabled = !ctx.isDevPackage && resolveReleaseDaemonEnabled(ctx.env);
        const daemonSupervisor = daemonEnabled && isDaemonSupervisorProcess(ctx.env);
        const daemonRestartDelayMs = resolveDaemonRestartDelayMs(ctx.env);

        if (daemonEnabled && !daemonSupervisor) {
          const cliEntry = (() => {
            const resolved = ctx.resolveCliEntryPath?.();
            if (typeof resolved === 'string' && resolved.trim()) {
              return resolved.trim();
            }
            const fallback = String(process.argv[1] || '').trim();
            return fallback || serverEntry;
          })();

          clearDaemonStopIntent(resolvedPort, routeCodexHome);
          const daemonEnv = {
            ...env,
            ROUTECODEX_DAEMON_SUPERVISOR: '1',
            RCC_DAEMON_SUPERVISOR: '1',
            ROUTECODEX_PORT: String(resolvedPort),
            RCC_PORT: String(resolvedPort)
          } as NodeJS.ProcessEnv;
          const daemonArgs = [cliEntry, ...buildStartCommandArgs(options, configPath, runMode)];
          const daemonProc = ctx.spawn(nodeBin, daemonArgs, {
            stdio: 'ignore',
            env: daemonEnv,
            detached: true
          });
          writePidFile(daemonProc.pid);
          try {
            daemonProc.unref?.();
          } catch {
            /* ignore */
          }
          spinner.succeed(`RouteCodex daemon supervisor started on ${serverHost}:${resolvedPort}`);
          ctx.logger.info(`Configuration loaded from: ${configPath}`);
          ctx.logger.info(`Supervisor PID: ${daemonProc.pid ?? 'unknown'}`);
          const configuredStopPassword =
            (ctx.env.ROUTECODEX_STOP_PASSWORD || ctx.env.RCC_STOP_PASSWORD || '').trim();
          if (configuredStopPassword) {
            ctx.logger.info('Use `rcc stop --password <password>` to stop.');
          } else {
            ctx.logger.info('Use `rcc stop` to stop.');
          }
          ctx.exit(0);
        }

        const consumeStopIntent = (): { matched: boolean; source?: string; requestedAtMs?: number } =>
          consumeDaemonStopIntent(resolvedPort, { routeCodexHomeDir: routeCodexHome });

        if (daemonSupervisor) {
          spinner.succeed(`RouteCodex daemon supervisor active on ${serverHost}:${resolvedPort}`);
          ctx.logger.info(`Configuration loaded from: ${configPath}`);
          ctx.logger.info(`Restart policy: always restart unless explicit stop intent is received`);

          while (true) {
            const pendingStop = consumeStopIntent();
            if (pendingStop.matched) {
              logProcessLifecycleSync({
                event: 'daemon_supervisor',
                source: 'cli.start',
                details: {
                  result: 'stop_intent_consumed',
                  port: resolvedPort,
                  source: pendingStop.source ?? 'unknown',
                  requestedAtMs: pendingStop.requestedAtMs
                }
              });
              ctx.exit(0);
            }

            const childProc = ctx.spawn(nodeBin, args, { stdio: 'inherit', env: childProcessEnv });
            writePidFile(childProc.pid);

            const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
              childProc.on('exit', (code, signal) => {
                resolve({ code, signal });
              });
              childProc.on('error', () => {
                resolve({ code: 1, signal: null });
              });
            });

            const stopIntent = consumeStopIntent();
            if (stopIntent.matched) {
              logProcessLifecycleSync({
                event: 'daemon_supervisor',
                source: 'cli.start',
                details: {
                  result: 'stopped_by_intent_after_child_exit',
                  port: resolvedPort,
                  childExitCode: exitInfo.code,
                  childSignal: exitInfo.signal,
                  source: stopIntent.source ?? 'unknown',
                  requestedAtMs: stopIntent.requestedAtMs
                }
              });
              ctx.exit(0);
            }

            logProcessLifecycleSync({
              event: 'daemon_supervisor',
              source: 'cli.start',
              details: {
                result: 'child_exited_restart_scheduled',
                port: resolvedPort,
                childExitCode: exitInfo.code,
                childSignal: exitInfo.signal,
                restartDelayMs: daemonRestartDelayMs
              }
            });
            await ctx.sleep(daemonRestartDelayMs);
          }
        }

        let serverLogPath: string | null = null;
        let serverLogStream: fs.WriteStream | null = null;
        let spawnOptions: any = { stdio: 'inherit', env: childProcessEnv };
        try {
          const logsDir = pathImpl.join(routeCodexHome, 'logs');
          fsImpl.mkdirSync(logsDir, { recursive: true });
          serverLogPath = pathImpl.join(logsDir, `server-${resolvedPort}.log`);
          serverLogStream = fsImpl.createWriteStream(serverLogPath, { flags: 'a' });
          spawnOptions = { stdio: ['inherit', 'pipe', 'pipe'], env: childProcessEnv };
        } catch {
          if (serverLogStream) {
            try { serverLogStream.end(); } catch { /* ignore */ }
            serverLogStream = null;
          }
          serverLogPath = null;
          spawnOptions = { stdio: 'inherit', env: childProcessEnv };
        }

        const childProc = ctx.spawn(nodeBin, args, spawnOptions);
        writePidFile(childProc.pid);

        const closeServerLogStream = () => {
          if (!serverLogStream) {
            return;
          }
          try {
            serverLogStream.end();
          } catch {
            /* ignore */
          }
          serverLogStream = null;
        };

        const forwardToConsoleAndLog = (
          stream: NodeJS.ReadableStream | null | undefined,
          output: NodeJS.WriteStream
        ) => {
          if (!stream) {
            return;
          }
          stream.on('data', (chunk: unknown) => {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            try {
              output.write(data);
            } catch {
              /* ignore */
            }
            if (serverLogStream) {
              try {
                serverLogStream.write(data);
              } catch {
                /* ignore */
              }
            }
          });
        };

        forwardToConsoleAndLog((childProc as unknown as { stdout?: NodeJS.ReadableStream | null }).stdout, process.stdout);
        forwardToConsoleAndLog((childProc as unknown as { stderr?: NodeJS.ReadableStream | null }).stderr, process.stderr);

        spinner.succeed(`RouteCodex server starting on ${serverHost}:${resolvedPort}`);
        ctx.logger.info(`Configuration loaded from: ${configPath}`);
        ctx.logger.info(`Server will run on port: ${resolvedPort}`);
        if (serverLogPath) {
          ctx.logger.info(`Server log file: ${serverLogPath}`);
        }
        ctx.logger.info('Press Ctrl+C to stop the server');

        const shutdown = async (sig: NodeJS.Signals) => {
          try {
            await ctx.fetch(`${HTTP_PROTOCOLS.HTTP}${LOCAL_HOSTS.IPV4}:${resolvedPort}${API_PATHS.SHUTDOWN}`, { method: 'POST' }).catch(() => {});
          } catch {
            /* ignore */
          }
          try {
            if (childProc.pid && childProc.pid === process.pid) {
              logProcessLifecycleSync({
                event: 'self_termination',
                source: 'cli.start.shutdown',
                details: {
                  reason: 'self_kill_guard',
                  signal: sig,
                  childPid: childProc.pid,
                  parentPid: process.pid,
                  result: 'blocked'
                }
              });
            }
            childProc.kill(sig);
          } catch {
            /* ignore */
          }
          // Avoid process-group signals here; only target the known child pid,
          // then rely on managed pid discovery + graceful/force cleanup below.
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
          logProcessLifecycleSync({
            event: 'self_termination',
            source: 'cli.start.shutdown',
            details: {
              reason: 'shutdown_sequence_completed',
              signal: sig,
              targetPort: resolvedPort,
              remainingPids: still
            }
          });
          if (ctx.isDevPackage) {
            await ctx.stopTokenDaemonIfRunning?.();
          }
          closeServerLogStream();
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
          closeServerLogStream();
          try { cleanupKeypress(); } catch { /* ignore */ }
          if (signal) {ctx.exit(0);}
          ctx.exit(code ?? 0);
        });

        await ctx.waitForever();
      } catch (error) {
        if (error instanceof Error && /^exit:\d+$/.test(error.message)) {
          throw error;
        }
        spinner.fail('Failed to start server');
        ctx.logger.error(error instanceof Error ? error.message : String(error));
        ctx.exit(1);
      }
    });
}
