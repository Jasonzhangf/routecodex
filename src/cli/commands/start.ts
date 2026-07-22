import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import type { Command } from 'commander';

// feature_id: runtime.lifecycle.start_command
import { API_PATHS, HTTP_PROTOCOLS, LOCAL_HOSTS } from '../../constants/index.js';
import { resolveRccUserDir } from '../../config/user-data-paths.js';
import { writeRuntimeInstance, updateRuntimeInstanceStatus } from '../../utils/runtime-instance-registry.js';
import { resolveRouteCodexConfigPath } from '../../config/config-paths.js';
import { resolvePortGroupFromConfig } from './port-group-resolver.js';
import { detectUserConfigFormat, parseUserConfigText } from '../../config/user-config-codec.js';
import { probeRouteCodexHealth } from '../../utils/http-health-probe.js';
import { buildLocalProbeHostCandidates } from '../../utils/local-connect-host.js';
import { logProcessLifecycleSync } from '../../utils/process-lifecycle-logger.js';
import { ensureDefaultPrecommandScriptBestEffort } from '../config/precommand-default-script.js';
import {
  consumeDaemonStopIntent,
  writeDaemonStopIntent
} from '../../utils/daemon-stop-intent.js';
import { writeServerPidCache } from '../../utils/server-runtime-pid.js';
import {
  resolveRuntimeLifecyclePath,
  safeReadRuntimeLifecycle
} from '../../utils/runtime-exit-forensics.js';
import {
  buildStartCommandArgs,
  isDaemonSupervisorProcess,
  normalizeRunMode,
  parseBoolish,
  resolveDaemonRestartDelayMs,
  resolveReleaseDaemonEnabled
} from './start-utils.js';
import {
  getDefaultSnapshotStageSelector,
  stageSelectorNeedsHubSnapshots
} from '../../utils/snapshot-stage-policy.js';
import type { StartCommandContext, StartCommandOptions } from './start-types.js';
import { formatUnknownError, isRecord } from '../../utils/common-utils.js';
import { buildShutdownCallerHeaders } from '../../utils/shutdown-caller-headers.js';
import { planRuntimeStartRestartTakeoverGuard } from '../../modules/llmswitch/bridge/runtime-lifecycle-host.js';

export type { StartCommandContext, StartCommandOptions } from './start-types.js';


function logStartNonBlocking(
  ctx: StartCommandContext,
  stage: string,
  error: unknown,
  details: Record<string, unknown> = {}
): void {
  try {
    const detailSuffix = Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    ctx.logger.warning(`[start] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`);
  } catch {
    // Never throw from non-blocking logging.
  }
}

function logStartHealthProbeNonBlocking(
  ctx: StartCommandContext,
  stage: string,
  result: Awaited<ReturnType<typeof probeRouteCodexHealth>>,
  details: Record<string, unknown> = {}
): void {
  if (result.ok) {
    return;
  }
  try {
    const detailSuffix = Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    const statusSuffix = typeof result.status === 'number' ? ` status=${result.status}` : '';
    ctx.logger.warning(`[start] ${stage} probe=${result.kind}${statusSuffix}${detailSuffix}`);
  } catch {
    // Never throw from non-blocking logging.
  }
}

function resolveShutdownExitCode(signal: NodeJS.Signals): number {
  if (signal === 'SIGINT') {
    return 130;
  }
  if (signal === 'SIGTERM') {
    return 143;
  }
  return 1;
}

function resolveStartShutdownHttpTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = String(env.ROUTECODEX_START_SHUTDOWN_HTTP_TIMEOUT_MS ?? env.RCC_START_SHUTDOWN_HTTP_TIMEOUT_MS ?? '').trim();
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 100) {
    return Math.floor(parsed);
  }
  return 1200;
}

function resolveStartReadyTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = String(env.ROUTECODEX_START_READY_TIMEOUT_MS ?? env.RCC_START_READY_TIMEOUT_MS ?? '').trim();
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 5000) {
    return Math.min(Math.floor(parsed), 300_000);
  }
  return 60_000;
}

function sanitizeStartLogSegment(value: string): string {
  const trimmed = String(value || '').trim();
  const withoutJson = trimmed.replace(/\.json$/i, '') || trimmed;
  const sanitized = withoutJson
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return sanitized || 'config';
}

function resolveStartConfigLogDir(args: {
  pathImpl: typeof path;
  homeDir: string;
  configPath: string;
}): string {
  const userDir = resolveRccUserDir(args.homeDir);
  const basename =
    typeof args.pathImpl.basename === 'function'
      ? args.pathImpl.basename.bind(args.pathImpl)
      : path.basename;
  const configBaseName = basename(String(args.configPath || '').trim() || 'config');
  const configSegment = sanitizeStartLogSegment(configBaseName);
  return args.pathImpl.join(userDir, 'log', configSegment);
}

type StartPortGroupLock = {
  acquired: boolean;
  lockPath: string;
  release: () => void;
};

function isStartLockOwnerAlive(pid: number): boolean {
  const normalizedPid = Math.floor(Number(pid));
  if (!Number.isFinite(normalizedPid) || normalizedPid <= 0) {
    return false;
  }
  if (normalizedPid === process.pid) {
    return true;
  }
  try {
    process.kill(normalizedPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function resolveStartPortGroupLockPath(args: {
  pathImpl: typeof path;
  routeCodexHomeDir: string;
  ports: number[];
}): string {
  const normalizedPorts = [...new Set(
    args.ports
      .map((port) => Math.floor(Number(port)))
      .filter((port) => Number.isFinite(port) && port > 0)
  )].sort((a, b) => a - b);
  const key = normalizedPorts.length ? normalizedPorts.join('-') : 'unknown';
  return args.pathImpl.join(
    args.routeCodexHomeDir,
    'state',
    'runtime-lifecycle',
    'start-locks',
    `${key}.lock`
  );
}

function acquireStartPortGroupLock(args: {
  fsImpl: typeof fs;
  pathImpl: typeof path;
  routeCodexHomeDir: string;
  ports: number[];
  staleMs?: number;
  reapDeadOwner?: boolean;
}): StartPortGroupLock {
  const lockPath = resolveStartPortGroupLockPath(args);
  const staleMs = Number.isFinite(args.staleMs as number) && Number(args.staleMs) > 0
    ? Math.floor(Number(args.staleMs))
    : 120_000;
  const release = () => {
    try {
      if (args.fsImpl.existsSync(lockPath)) {
        const raw = args.fsImpl.readFileSync(lockPath, 'utf8');
        const parsed = JSON.parse(String(raw || '{}')) as { pid?: number };
        if (Number(parsed?.pid) === process.pid) {
          args.fsImpl.unlinkSync(lockPath);
        }
      }
    } catch {
      // lock release is best-effort; stale locks are reaped by age
    }
  };
  try {
    const dirname =
      typeof args.pathImpl.dirname === 'function'
        ? args.pathImpl.dirname.bind(args.pathImpl)
        : path.dirname;
    args.fsImpl.mkdirSync(dirname(lockPath), { recursive: true });
    if (args.fsImpl.existsSync(lockPath)) {
      try {
        const stat = args.fsImpl.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          args.fsImpl.unlinkSync(lockPath);
        } else if (args.reapDeadOwner === true) {
          const raw = args.fsImpl.readFileSync(lockPath, 'utf8');
          const parsed = JSON.parse(String(raw || '{}')) as { pid?: number };
          const ownerPid = Math.floor(Number(parsed?.pid));
          if (
            Number.isFinite(ownerPid)
            && ownerPid > 0
            && ownerPid !== process.pid
            && !isStartLockOwnerAlive(ownerPid)
          ) {
            args.fsImpl.unlinkSync(lockPath);
          }
        }
      } catch {
        // Keep the existing lock if it cannot be inspected safely.
      }
    }
    const fd = args.fsImpl.openSync(lockPath, 'wx');
    try {
      const record = {
        pid: process.pid,
        ports: [...new Set(args.ports)].sort((a, b) => a - b),
        startedAtMs: Date.now()
      };
      args.fsImpl.writeFileSync(fd, JSON.stringify(record), 'utf8');
    } finally {
      args.fsImpl.closeSync(fd);
    }
    return { acquired: true, lockPath, release };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'EEXIST') {
      return { acquired: false, lockPath, release: () => {} };
    }
    return { acquired: true, lockPath, release: () => {} };
  }
}

function readChildStartupExitState(args: {
  port: number;
  routeCodexHomeDir?: string;
}): { kind?: string; message?: string } | null {
  try {
    const lifecyclePath = resolveRuntimeLifecyclePath(args.port, args.routeCodexHomeDir);
    const state = safeReadRuntimeLifecycle(lifecyclePath);
    if (!state?.exit || typeof state.exit !== 'object') {
      return null;
    }
    const kind = typeof state.exit.kind === 'string' ? state.exit.kind.trim() : '';
    const message = typeof state.exit.message === 'string' ? state.exit.message.trim() : '';
    return {
      ...(kind ? { kind } : {}),
      ...(message ? { message } : {})
    };
  } catch {
    return null;
  }
}

export function createStartCommand(program: Command, ctx: StartCommandContext): void {
  program
    .command('start')
    .description('Start the RouteCodex server')
    .option('-c, --config <config>', 'Configuration file path')
    .option('-p, --port <port>', 'RouteCodex server port (overrides env/config)')
    .option('--mode <mode>', 'Run mode (router|analysis|server). analysis => router + force snapshots', 'router')
    .option('--log-level <level>', 'Log level (debug, info, warn, error)', 'info')
    .option('--codex', 'Use Codex system prompt (tools unchanged)')
    .option('--claude', 'Use Claude system prompt (tools unchanged)')
    .option('--ua <mode>', 'Upstream User-Agent override mode (e.g., codex)')
    .option('--snap', 'Force-enable snapshot capture')
    .option('--snap-stages <stages>', 'Comma-separated snapshot stages/prefixes (supports * suffix; e.g. chat_process.req.*)')
    .option('--snap-off', 'Disable snapshot capture')
    .option('--verbose-errors', 'Print verbose error stacks in console output')
    .option('--quiet-errors', 'Silence detailed error stacks')
    .option('--restart', 'Restart if an instance is already running')
    .option('--no-restart', 'Do not restart when an instance is already running')
    .option('--exclusive', 'Always take over the port (kill existing listeners)')
    .action(async (options: StartCommandOptions) => {
      const spinner = await ctx.createSpinner('Starting RouteCodex server...');

      const fsImpl = ctx.fsImpl ?? fs;
      const pathImpl = ctx.pathImpl ?? path;
      const home = ctx.homedir ?? (() => homedir());
      let startPortGroupLock: StartPortGroupLock | null = null;
      const releaseStartPortGroupLock = (): void => {
        if (!startPortGroupLock) {
          return;
        }
        startPortGroupLock.release();
        startPortGroupLock = null;
      };
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
          const explicitSnapStages = typeof options.snapStages === 'string' ? options.snapStages.trim() : '';
          const existingSnapStages = String(
            ctx.env.ROUTECODEX_SNAPSHOT_STAGES
            ?? ctx.env.RCC_SNAPSHOT_STAGES
            ?? ''
          ).trim();
          const stageSelector = explicitSnapStages || existingSnapStages;
          if (runMode === 'analysis') {
            const analysisSelector = stageSelector || '*';
            ctx.env.ROUTECODEX_SNAPSHOT_STAGES = analysisSelector;
            ctx.env.ROUTECODEX_HUB_SNAPSHOTS = ctx.env.ROUTECODEX_HUB_SNAPSHOTS || '1';
          } else {
            const effectiveSelector = stageSelector || getDefaultSnapshotStageSelector();
            ctx.env.ROUTECODEX_SNAPSHOT_STAGES = effectiveSelector;
            ctx.env.ROUTECODEX_HUB_SNAPSHOTS = ctx.env.ROUTECODEX_HUB_SNAPSHOTS
              || (stageSelectorNeedsHubSnapshots(effectiveSelector) ? '1' : '0');
          }
          // Analysis mode should be able to capture streaming payloads even in release builds.
          // Keep this opt-in via --mode analysis (or explicit env override).
          ctx.env.ROUTECODEX_CAPTURE_STREAM_SNAPSHOTS = ctx.env.ROUTECODEX_CAPTURE_STREAM_SNAPSHOTS || '1';
          // Ensure upstream error payloads are logged when snapshots are enabled.
          ctx.env.ROUTECODEX_HTTP_ERROR_META_LOG = ctx.env.ROUTECODEX_HTTP_ERROR_META_LOG || '1';
          ctx.env.RCC_HTTP_ERROR_META_LOG = ctx.env.RCC_HTTP_ERROR_META_LOG || '1';
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
          const envConfigPath = (ctx.env.ROUTECODEX_CONFIG_PATH || ctx.env.ROUTECODEX_CONFIG || '').trim();
          configPath = envConfigPath
            ? resolveRouteCodexConfigPath(envConfigPath)
            : resolveRouteCodexConfigPath();
        } else {
          configPath = pathImpl.resolve(configPath);
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
          ctx.logger.error('Please create a RouteCodex user config first (e.g., ~/.rcc/config.toml).');
          ctx.logger.error('Or initialize via CLI:');
          ctx.logger.error('  rcc init');
          ctx.logger.error('  rcc config init');
          ctx.logger.error('Or specify a custom configuration file:');
          ctx.logger.error('  rcc start --config ./config.toml');
          ctx.exit(1);
        }

        // Load and validate configuration (non-dev packages rely on config port)
        let config: any;
        let configFormat: 'json' | 'toml';
        try {
          const configContent = fsImpl.readFileSync(configPath, 'utf8');
          configFormat = detectUserConfigFormat(configPath);
          config = parseUserConfigText(configContent, configFormat);
        } catch {
          spinner.fail('Failed to parse configuration file');
          ctx.logger.error(`Invalid configuration file: ${configPath}`);
          ctx.exit(1);
        }

        const promptFlag = explicitPromptFlag ?? null;
        if (promptFlag) {
          ctx.env.ROUTECODEX_SYSTEM_PROMPT_SOURCE = promptFlag;
          ctx.env.ROUTECODEX_SYSTEM_PROMPT_ENABLE = '1';
        }

        // Determine effective port:
        // - dev package (`routecodex`): env override, otherwise固定端口 DEFAULT_DEV_PORT
        // - release package (`rcc`): 严格按配置文件端口启动
        const resolvedPortGroup = resolvePortGroupFromConfig(ctx, { configPath });
        const hasMultiPortConfig = !!(resolvedPortGroup?.ports && resolvedPortGroup.ports.length > 1);
        let resolvedPort: number;
        if (ctx.isDevPackage) {
          const flagPort = typeof options.port === 'string' ? Number(options.port) : NaN;
          if (!Number.isNaN(flagPort) && flagPort > 0) {
            ctx.logger.info(`Using port ${flagPort} from --port flag [dev package: routecodex]`);
            resolvedPort = flagPort;
          } else if (hasMultiPortConfig) {
            resolvedPort = resolvedPortGroup!.ports[0];
            ctx.logger.info(`Using first port ${resolvedPort} from multi-port config [dev package: routecodex]`);
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
          const flagPort = typeof options.port === 'string' ? Number(options.port) : NaN;
          if (!Number.isNaN(flagPort) && flagPort > 0) {
            ctx.logger.info(`Using port ${flagPort} from --port flag [release package: rcc]`);
            resolvedPort = flagPort;
          } else {
            const port = (config?.httpserver?.port ?? config?.server?.port ?? config?.port);
            if (!port || typeof port !== 'number' || port <= 0) {
              spinner.fail('Invalid or missing port configuration');
              ctx.logger.error('Please set a valid port (httpserver.port or top-level port) in your configuration');
              ctx.exit(1);
            }
            resolvedPort = port;
          }
        }

        await ctx.ensureGuardianDaemon?.();
        await ctx.registerGuardianProcess?.({
          source: 'start',
          pid: process.pid,
          ppid: process.ppid,
          port: resolvedPort,
          metadata: {
            mode: runMode,
            configPath
          }
        });
        const applyLifecycleOrThrow = async (args: {
          action: string;
          signal?: string;
          targetPid?: number | null;
          metadata?: Record<string, unknown>;
        }): Promise<void> => {
          const accepted = await ctx.reportGuardianLifecycle?.({
            action: args.action,
            source: 'cli.start',
            actorPid: process.pid,
            targetPid: args.targetPid && args.targetPid > 0 ? args.targetPid : undefined,
            signal: args.signal,
            metadata: {
              port: resolvedPort,
              ...(args.metadata || {})
            }
          });
          if (ctx.reportGuardianLifecycle && accepted !== true) {
            throw new Error(`guardian lifecycle apply rejected (${args.action})`);
          }
        };

        const restartExplicitlyDisabled = options.restart === false;
        const shouldRestart = options.exclusive === true || !restartExplicitlyDisabled;
        const grouped = hasMultiPortConfig
          ? resolvedPortGroup
          : (ctx.isDevPackage
            ? null
            : resolvePortGroupFromConfig(ctx, {
                configPath,
                targetPort: resolvedPort,
                includeSiblingsForTarget: true
              }));
        const portGroup = grouped?.ports?.length ? grouped.ports : [resolvedPort];
        const explicitFlagPort = typeof options.port === 'string' ? Number(options.port) : NaN;
        const effectivePortGroup = ctx.isDevPackage && Number.isFinite(explicitFlagPort) && explicitFlagPort > 0
          ? [resolvedPort]
          : portGroup;
        if (effectivePortGroup.length > 1) {
          spinner.info(`[start] resolved config port-group: ${effectivePortGroup.join(', ')}`);
        }
        const routeCodexHome = resolveRccUserDir(home());
        const resolveServerHost = (): string => {
          if (typeof config?.httpserver?.host === 'string' && config.httpserver.host.trim()) {return config.httpserver.host;}
          if (typeof config?.server?.host === 'string' && config.server.host.trim()) {return config.server.host;}
          if (typeof config?.host === 'string' && config.host.trim()) {return config.host;}
          return LOCAL_HOSTS.LOCALHOST;
        };
        const serverHost = resolveServerHost();
        const daemonEnabled = !ctx.isDevPackage && resolveReleaseDaemonEnabled(ctx.env);
        const daemonSupervisor = daemonEnabled && isDaemonSupervisorProcess(ctx.env);
        const daemonRestartDelayMs = resolveDaemonRestartDelayMs(ctx.env);
        const daemonSupervisorIgnoreStopIntentPid = (() => {
          const raw = String(
            ctx.env.ROUTECODEX_DAEMON_SUPERVISOR_IGNORE_STOP_INTENT_PID
            ?? ctx.env.RCC_DAEMON_SUPERVISOR_IGNORE_STOP_INTENT_PID
            ?? ''
          ).trim();
          const parsed = Number(raw);
          return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
        })();
        const probeStartHealth = async (
          stage: string,
          options: { logFailure?: boolean } = {}
        ): Promise<boolean> => {
          let lastProbe: Awaited<ReturnType<typeof probeRouteCodexHealth>> | null = null;
          for (const host of buildLocalProbeHostCandidates(serverHost)) {
            const probe = await probeRouteCodexHealth({
              fetchImpl: ctx.fetch,
              host,
              port: resolvedPort,
              timeoutMs: 800
            });
            lastProbe = probe;
            if (probe.ok) {
              return true;
            }
          }
          if (options.logFailure === true && lastProbe && !lastProbe.ok) {
            logStartHealthProbeNonBlocking(ctx, stage, lastProbe, {
              port: resolvedPort,
              kind: lastProbe.kind
            });
          }
          return false;
        };
        const waitForDaemonSupervisorReadyOrExit = async (
          proc: ReturnType<typeof ctx.spawn>,
          deadlineMs: number
        ): Promise<{
          ready: boolean;
          exitCode?: number | null;
          signal?: NodeJS.Signals | null;
          startupExitState?: { kind?: string; message?: string } | null;
        }> => {
          let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
          try {
            proc.once?.('exit', (code: number | null, signal: NodeJS.Signals | null) => {
              exitInfo = { code, signal };
            });
            proc.once?.('error', () => {
              exitInfo = { code: 1, signal: null };
            });
          } catch (error) {
            logStartNonBlocking(ctx, 'daemon_supervisor_exit_listener', error, {
              port: resolvedPort,
              daemonPid: proc.pid ?? null
            });
          }
          while (Date.now() < deadlineMs) {
            if (await probeStartHealth('daemon_supervisor_health_probe')) {
              return { ready: true };
            }
            const procRecord = proc as unknown as {
              exitCode?: number | null;
              signalCode?: NodeJS.Signals | null;
            };
            const observedExitInfo = exitInfo as { code: number | null; signal: NodeJS.Signals | null } | null;
            const exitCode = observedExitInfo ? observedExitInfo.code : procRecord.exitCode;
            const signal = observedExitInfo ? observedExitInfo.signal : procRecord.signalCode;
            const exited = typeof exitCode === 'number' || Boolean(signal);
            if (exited) {
              return {
                ready: false,
                exitCode,
                signal,
                startupExitState: readChildStartupExitState({
                  port: resolvedPort,
                  routeCodexHomeDir: routeCodexHome
                })
              };
            }
            await ctx.sleep(250);
          }
          return { ready: false };
        };
        const stopSpawnedDaemonSupervisorBestEffort = async (proc: ReturnType<typeof ctx.spawn>): Promise<void> => {
          const daemonPid = proc.pid;
          for (const p of effectivePortGroup) {
            writeDaemonStopIntent(p, {
              source: 'cli.start.daemon_start_failed',
              routeCodexHomeDir: routeCodexHome,
              pid: process.pid
            });
          }
          if (!daemonPid || daemonPid <= 0) {
            return;
          }
          try {
            ctx.killPidBestEffort(daemonPid, { force: false });
          } catch (error) {
            logStartNonBlocking(ctx, 'daemon_supervisor_stop_signal', error, { port: resolvedPort, daemonPid });
          }
          await ctx.sleep(1500);
          try {
            ctx.killPidBestEffort(daemonPid, { force: true });
          } catch (error) {
            logStartNonBlocking(ctx, 'daemon_supervisor_stop_force', error, { port: resolvedPort, daemonPid });
          }
        };
        const refuseStartTakeoverIfOccupied = async (): Promise<void> => {
          if (options.exclusive === true || daemonSupervisor) {
            return;
          }
          const occupied: Array<{ port: number; pids: number[] }> = [];
          for (const p of effectivePortGroup) {
            const pids = ctx.findListeningPids(p);
            if (pids.length > 0) {
              occupied.push({ port: p, pids });
            }
          }
          if (occupied.length === 0) {
            return;
          }
          const guard = planRuntimeStartRestartTakeoverGuard({
            explicitRestart: options.restart === true,
            noRestart: restartExplicitlyDisabled,
            exclusive: false,
            daemonSupervisor,
            occupiedPorts: occupied.map((item) => item.port)
          });
          if (guard.action !== 'refuse') {
            return;
          }
          logProcessLifecycleSync({
            event: 'start_takeover_refused',
            source: 'cli.start',
            details: {
              reason: guard.reasonCode,
              explicitRestart: options.restart === true,
              ports: occupied.map((item) => ({
                port: item.port,
                pids: item.pids
              }))
            }
          });
          spinner.fail(`rcc start --no-restart refuses to stop existing RouteCodex runtime on port-group: ${guard.ports.join(', ')}`);
          ctx.logger.error(`Use plain start without --no-restart to take over the occupied port-group.`);
          ctx.logger.error(`Use 'rcc stop --port ${resolvedPort}' only when an explicit stop without restart is intended.`);
          ctx.exit(1);
        };
        await refuseStartTakeoverIfOccupied();
        if (shouldRestart && !daemonSupervisor) {
          startPortGroupLock = acquireStartPortGroupLock({
            fsImpl,
            pathImpl,
            routeCodexHomeDir: routeCodexHome,
            ports: effectivePortGroup
          });
          if (!startPortGroupLock.acquired) {
            spinner.info(`[start] another start is already taking over port-group: ${effectivePortGroup.join(', ')}`);
            const waitMsRaw = String(ctx.env.ROUTECODEX_START_LOCK_WAIT_MS ?? ctx.env.RCC_START_LOCK_WAIT_MS ?? '').trim();
            const waitMsParsed = Number(waitMsRaw);
            const waitMs = Number.isFinite(waitMsParsed) && waitMsParsed >= 1000 ? Math.floor(waitMsParsed) : 60_000;
            const deadline = Date.now() + waitMs;
            let acquiredAfterWait = false;
            let nextWaitLogAt = Date.now();
            while (Date.now() < deadline) {
              const retryLock = acquireStartPortGroupLock({
                fsImpl,
                pathImpl,
                routeCodexHomeDir: routeCodexHome,
                ports: effectivePortGroup,
                reapDeadOwner: true
              });
              if (retryLock.acquired) {
                startPortGroupLock = retryLock;
                acquiredAfterWait = true;
                spinner.info(`[start] previous takeover lock released; continuing startup on port-group: ${effectivePortGroup.join(', ')}`);
                break;
              }
              const nowMs = Date.now();
              if (nowMs >= nextWaitLogAt) {
                const remainingSeconds = Math.max(0, Math.ceil((deadline - nowMs) / 1000));
                spinner.info(`[start] waiting for existing start takeover to finish (${remainingSeconds}s remaining): ${effectivePortGroup.join(', ')}`);
                nextWaitLogAt = nowMs + 2_000;
              }
              await ctx.sleep(250);
            }
            if (!acquiredAfterWait) {
              throw new Error(`Another rcc start is still taking over port-group ${effectivePortGroup.join(', ')}`);
            }
          }
        }
        if (shouldRestart && !daemonSupervisor) {
          for (const p of effectivePortGroup) {
            writeDaemonStopIntent(p, {
              source: options.exclusive === true ? 'cli.start.exclusive_takeover' : 'cli.start.port_takeover',
              routeCodexHomeDir: routeCodexHome,
              pid: process.pid
            });
          }
        }
        for (const p of effectivePortGroup) {
          await ctx.ensurePortAvailable(p, spinner, { restart: shouldRestart, targetPorts: effectivePortGroup });
        }

        const isMultiPortGroup = effectivePortGroup.length > 1;
        if (!isMultiPortGroup) {
          ctx.env.ROUTECODEX_PORT = String(resolvedPort);
          ctx.env.RCC_PORT = String(resolvedPort);
        } else {
          // Multi-port startup must not be collapsed by single-port env overrides.
          delete ctx.env.ROUTECODEX_PORT;
          delete ctx.env.RCC_PORT;
        }
        ctx.env.ROUTECODEX_HTTP_HOST = serverHost;
        ctx.env.ROUTECODEX_HTTP_PORT = String(resolvedPort);

        const modulesConfigPath = ctx.getModulesConfigPath();
        if (!fsImpl.existsSync(modulesConfigPath)) {
          spinner.fail(`Modules configuration file not found: ${modulesConfigPath}`);
          ctx.exit(1);
        }

        const nodeBin = ctx.nodeBin || process.execPath;
        const serverEntry = ctx.resolveServerEntryPath();
        const resolveServerRuntimeCwd = (entryPath: string): string => {
          const dirname =
            typeof (pathImpl as typeof path).dirname === 'function'
              ? (pathImpl as typeof path).dirname.bind(pathImpl)
              : path.dirname;
          const basename =
            typeof (pathImpl as typeof path).basename === 'function'
              ? (pathImpl as typeof path).basename.bind(pathImpl)
              : path.basename;
          const entryDir = dirname(entryPath);
          if (basename(entryDir) === 'dist') {
            return dirname(entryDir);
          }
          return entryDir;
        };
        const serverRuntimeCwd = resolveServerRuntimeCwd(serverEntry);

        const env = { ...ctx.env } as NodeJS.ProcessEnv;
        env.ROUTECODEX_CONFIG = configPath;
        env.ROUTECODEX_CONFIG_PATH = configPath;
        env.ROUTECODEX_BASEDIR = env.ROUTECODEX_BASEDIR || serverRuntimeCwd;
        env.RCC_BASEDIR = env.RCC_BASEDIR || serverRuntimeCwd;
        const baseDirWasDefaulted =
          !String(ctx.env.ROUTECODEX_BASEDIR || '').trim()
          && !String(ctx.env.RCC_BASEDIR || '').trim();
        if (ctx.isDevPackage && !isMultiPortGroup) {
          env.ROUTECODEX_PORT = String(resolvedPort);
        }
        const bindServerToParent = parseBoolish(
          ctx.env.ROUTECODEX_SERVER_PARENT_GUARD ?? ctx.env.RCC_SERVER_PARENT_GUARD
        ) ?? false;
        const portLogRoot = pathImpl.join(resolveStartConfigLogDir({
          pathImpl,
          homeDir: home(),
          configPath
        }), 'ports');
        const childProcessEnv = {
          ...env,
          ROUTECODEX_MANAGED_BY_START: '1',
          RCC_MANAGED_BY_START: '1',
          ROUTECODEX_PORT_LOG_ROOT: portLogRoot,
          RCC_PORT_LOG_ROOT: portLogRoot,
          ...(bindServerToParent
            ? {
              ROUTECODEX_EXPECT_PARENT_PID: String(process.pid),
              RCC_EXPECT_PARENT_PID: String(process.pid)
            }
            : {})
        } as NodeJS.ProcessEnv;

        const args: string[] = [serverEntry, modulesConfigPath];

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
            writeServerPidCache({
              port: resolvedPort,
              pid: pid ?? 0,
              origin: 'start',
              routeCodexHomeDir: routeCodexHome
            });
          } catch (error) {
            logStartNonBlocking(ctx, 'write_pid_file', error, {
              port: resolvedPort,
              pid: pid ?? null
            });
          }
        };

        type ServerSpawnPlan = {
          entry: string;
          modulesConfigPath: string;
          args: string[];
          cwd: string;
          env: NodeJS.ProcessEnv;
        };

        const resolveLiveServerSpawnPlan = (): ServerSpawnPlan => {
          let nextEntry = serverEntry;
          let nextModulesConfigPath = modulesConfigPath;
          try {
            const cliEntry = String(process.argv[1] || '').trim();
            if (cliEntry) {
              const dirname =
                typeof (pathImpl as typeof path).dirname === 'function'
                  ? (pathImpl as typeof path).dirname.bind(pathImpl)
                  : path.dirname;
              const basename =
                typeof (pathImpl as typeof path).basename === 'function'
                  ? (pathImpl as typeof path).basename.bind(pathImpl)
                  : path.basename;
              const join =
                typeof (pathImpl as typeof path).join === 'function'
                  ? (pathImpl as typeof path).join.bind(pathImpl)
                  : path.join;
              const cliBase = basename(cliEntry).toLowerCase();
              if (cliBase === 'cli.js' || cliBase === 'index.js') {
                const distDir = dirname(cliEntry);
                const installRoot = dirname(distDir);
                const candidateEntry = join(distDir, 'index.js');
                const candidateModulesConfigPath = join(installRoot, 'config', 'modules.json');
                if (fsImpl.existsSync(candidateEntry) && fsImpl.existsSync(candidateModulesConfigPath)) {
                  nextEntry = candidateEntry;
                  nextModulesConfigPath = candidateModulesConfigPath;
                }
              }
            }
          } catch (error) {
            logStartNonBlocking(ctx, 'resolve_live_server_spawn_plan', error, {
              port: resolvedPort,
              fallbackEntry: serverEntry,
              fallbackModulesConfigPath: modulesConfigPath
            });
          }

          const nextCwd = resolveServerRuntimeCwd(nextEntry);
          const nextEnv = {
            ...childProcessEnv,
            ...(baseDirWasDefaulted
              ? {
                ROUTECODEX_BASEDIR: nextCwd,
                RCC_BASEDIR: nextCwd
              }
              : {})
          } as NodeJS.ProcessEnv;
          return {
            entry: nextEntry,
            modulesConfigPath: nextModulesConfigPath,
            args: [nextEntry, nextModulesConfigPath],
            cwd: nextCwd,
            env: nextEnv
          };
        };

        if (daemonEnabled && !daemonSupervisor) {
          const cliEntry = (() => {
            const resolved = ctx.resolveCliEntryPath?.();
            if (typeof resolved === 'string' && resolved.trim()) {
              return resolved.trim();
            }
            const fallback = String(process.argv[1] || '').trim();
            return fallback || serverEntry;
          })();

          const daemonEnv = {
            ...env,
            ROUTECODEX_DAEMON_SUPERVISOR: '1',
            RCC_DAEMON_SUPERVISOR: '1',
            ROUTECODEX_DAEMON_SUPERVISOR_IGNORE_STOP_INTENT_PID: String(process.pid),
            RCC_DAEMON_SUPERVISOR_IGNORE_STOP_INTENT_PID: String(process.pid),
            ROUTECODEX_PORT: String(resolvedPort),
            RCC_PORT: String(resolvedPort)
          } as NodeJS.ProcessEnv;
          const daemonArgs = [cliEntry, ...buildStartCommandArgs(options, configPath, runMode)];
          const daemonProc = ctx.spawn(nodeBin, daemonArgs, {
            stdio: 'ignore',
            env: daemonEnv,
            detached: true,
            cwd: serverRuntimeCwd
          });
          writePidFile(daemonProc.pid);
          const readyResult = await waitForDaemonSupervisorReadyOrExit(
            daemonProc,
            Date.now() + resolveStartReadyTimeoutMs(ctx.env)
          );
          if (!readyResult.ready) {
            await stopSpawnedDaemonSupervisorBestEffort(daemonProc);
            releaseStartPortGroupLock();
            const message = readyResult.startupExitState?.kind === 'startupError'
              ? `RouteCodex startup failed on port ${resolvedPort}: ${readyResult.startupExitState.message || 'startupError'}`
              : typeof readyResult.exitCode === 'number' || readyResult.signal
                ? `RouteCodex daemon supervisor exited before server became ready (code=${readyResult.exitCode ?? 'n/a'}, signal=${readyResult.signal ?? 'none'})`
                : `Timed out waiting for RouteCodex server to become ready on port ${resolvedPort}`;
            logProcessLifecycleSync({
              event: 'daemon_supervisor_start_wait',
              source: 'cli.start',
              details: {
                result: 'failed',
                port: resolvedPort,
                daemonPid: daemonProc.pid ?? null,
                message
              }
            });
            spinner.fail(message);
            ctx.exit(1);
          }
          try {
            daemonProc.unref?.();
          } catch (error) {
            logStartNonBlocking(ctx, 'daemon_proc.unref', error, {
              port: resolvedPort,
              daemonPid: daemonProc.pid ?? null
            });
          }
          logProcessLifecycleSync({
            event: 'daemon_supervisor_start_wait',
            source: 'cli.start',
            details: {
              result: 'ready',
              port: resolvedPort,
              daemonPid: daemonProc.pid ?? null
            }
          });
          spinner.succeed(`RouteCodex server started on ${serverHost}:${resolvedPort}`);
          ctx.logger.info(`Configuration loaded from: ${configPath}`);
          ctx.logger.info(`Supervisor PID: ${daemonProc.pid ?? 'unknown'}`);
          const configuredStopPassword =
            (ctx.env.ROUTECODEX_STOP_PASSWORD || ctx.env.RCC_STOP_PASSWORD || '').trim();
          if (configuredStopPassword) {
            ctx.logger.info('Use `rcc stop --password <password>` to stop.');
          } else {
            ctx.logger.info('Use `rcc stop` to stop.');
          }
          releaseStartPortGroupLock();
          ctx.exit(0);
        }

        const consumeStopIntent = (): { matched: boolean; source?: string; requestedAtMs?: number; pid?: number } =>
          consumeDaemonStopIntent(resolvedPort, {
            routeCodexHomeDir: routeCodexHome,
            ignorePid: daemonSupervisorIgnoreStopIntentPid,
            preserveMatched: true
          });

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

            const spawnPlan = resolveLiveServerSpawnPlan();
            const childProc = ctx.spawn(nodeBin, spawnPlan.args, {
              stdio: 'inherit',
              env: spawnPlan.env,
              cwd: spawnPlan.cwd
            });
            writePidFile(childProc.pid);
            try {
              writeRuntimeInstance({
                port: resolvedPort,
                host: serverHost,
                command: 'rcc start (daemon supervisor)',
                configPath: configPath,
                ownerScope: 'cli.start.daemon',
                status: 'declared',
                routeCodexHomeDir: routeCodexHome,
              });
            } catch (error) {
              logStartNonBlocking(ctx, 'write_runtime_instance.daemon_supervisor', error, { port: resolvedPort });
            }

            const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
              childProc.on('exit', (code, signal) => {
                resolve({ code, signal });
              });
              childProc.on('error', () => {
                resolve({ code: 1, signal: null });
              });
            });
            const codeLabel =
              typeof exitInfo.code === 'number' && Number.isFinite(exitInfo.code) ? String(exitInfo.code) : 'n/a';
            const signalLabel = exitInfo.signal || 'none';
            ctx.logger.info(`[client-exit] RouteCodex exited (code=${codeLabel}, signal=${signalLabel})`);

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

            const childExitState = readChildStartupExitState({
              port: resolvedPort,
              routeCodexHomeDir: routeCodexHome
            });
            if (childExitState?.kind === 'startupError') {
              logProcessLifecycleSync({
                event: 'daemon_supervisor',
                source: 'cli.start',
                details: {
                  result: 'child_exited_no_restart_startup_error',
                  port: resolvedPort,
                  childExitCode: exitInfo.code,
                  childSignal: exitInfo.signal,
                  startupError: childExitState.message ?? null
                }
              });
              ctx.logger.error(
                `[client-exit] RouteCodex startup failed on port ${resolvedPort}; supervisor will not restart automatically`
              );
              if (childExitState.message) {
                ctx.logger.error(`[client-exit] startupError=${childExitState.message}`);
              }
              ctx.exit(typeof exitInfo.code === 'number' && Number.isFinite(exitInfo.code) ? exitInfo.code : 1);
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
        let spawnOptions: any = { stdio: 'inherit', env: childProcessEnv, cwd: serverRuntimeCwd };
        try {
          const logsDir = pathImpl.join(routeCodexHome, 'logs');
          fsImpl.mkdirSync(logsDir, { recursive: true });
          serverLogPath = pathImpl.join(logsDir, `server-${resolvedPort}.log`);
          serverLogStream = fsImpl.createWriteStream(serverLogPath, { flags: 'a' });
          spawnOptions = { stdio: ['inherit', 'pipe', 'pipe'], env: childProcessEnv, cwd: serverRuntimeCwd };
        } catch {
          if (serverLogStream) {
            try {
              serverLogStream.end();
            } catch (error) {
              logStartNonBlocking(ctx, 'server_log_stream.end_on_spawn_fallback', error, {
                port: resolvedPort
              });
            }
            serverLogStream = null;
          }
          serverLogPath = null;
          spawnOptions = { stdio: 'inherit', env: childProcessEnv, cwd: serverRuntimeCwd };
        }

        const restartExitCode = 75;
        const restartRecoveryWaitMs = (() => {
          const raw = String(ctx.env.ROUTECODEX_RESTART_WAIT_MS ?? ctx.env.RCC_RESTART_WAIT_MS ?? '').trim();
          const parsed = Number(raw);
          if (Number.isFinite(parsed) && parsed >= 5000) {
            return Math.floor(parsed);
          }
          return 45000;
        })();

        const closeServerLogStream = () => {
          if (!serverLogStream) {
            return;
          }
          try {
            serverLogStream.end();
          } catch (error) {
            logStartNonBlocking(ctx, 'server_log_stream.end', error, {
              port: resolvedPort
            });
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
            } catch (error) {
              logStartNonBlocking(ctx, 'forward_stream.output_write', error, {
                port: resolvedPort,
                streamTarget: output === process.stderr ? 'stderr' : 'stdout'
              });
            }
            if (serverLogStream) {
              try {
                serverLogStream.write(data);
              } catch (error) {
                logStartNonBlocking(ctx, 'forward_stream.logfile_write', error, {
                  port: resolvedPort,
                  logPath: serverLogPath
                });
              }
            }
          });
        };

        const isChildHealthy = async (): Promise<boolean> => {
          return probeStartHealth('child_health_probe');
        };

        const waitForServerEntryReady = async (entryPath: string, deadlineMs: number): Promise<boolean> => {
          while (Date.now() < deadlineMs) {
            try {
              if (fsImpl.existsSync(entryPath)) {
                const stat = fsImpl.statSync(entryPath);
                if (!stat.isDirectory()) {
                  return true;
                }
              }
            } catch {
              // ignore transient fs errors while rebuild/restart race is in progress
            }
            await ctx.sleep(150);
          }
          return false;
        };

        const waitForChildHealthyOrExit = async (
          proc: ReturnType<typeof ctx.spawn>,
          deadlineMs: number
        ): Promise<{
          healthy: boolean;
          exitCode?: number | null;
          signal?: NodeJS.Signals | null;
          startupExitState?: { kind?: string; message?: string } | null;
        }> => {
          while (Date.now() < deadlineMs) {
            if (await isChildHealthy()) {
              return { healthy: true };
            }
            const procRecord = proc as unknown as {
              exitCode?: number | null;
              signalCode?: NodeJS.Signals | null;
            };
            const exited =
              typeof procRecord.exitCode === 'number'
              || Boolean(procRecord.signalCode);
            if (exited) {
              const startupExitState = readChildStartupExitState({
                port: resolvedPort,
                routeCodexHomeDir: routeCodexHome
              });
              return {
                healthy: false,
                exitCode: procRecord.exitCode,
                signal: procRecord.signalCode,
                startupExitState
              };
            }
            await ctx.sleep(150);
          }
          return { healthy: false };
        };

        let activeChildProc = null as ReturnType<typeof ctx.spawn> | null;
        let shuttingDown = false;
        let restartInFlight = false;
        let shutdownSignalCount = 0;
        let cleanupKeypress = () => {};

        const attachChildExitHandler = (proc: ReturnType<typeof ctx.spawn>): void => {
          proc.on('exit', (code, signal) => {
            const codeLabel = typeof code === 'number' && Number.isFinite(code) ? String(code) : 'n/a';
            const signalLabel = signal || 'none';
            ctx.logger.info(`[client-exit] RouteCodex exited (code=${codeLabel}, signal=${signalLabel})`);
            if (!shuttingDown && code === restartExitCode) {
              if (restartInFlight) {
                return;
              }
              restartInFlight = true;
              ctx.logger.info(`[client-restart] RouteCodex requested managed restart on port ${resolvedPort}`);
              void (async () => {
                try {
                  const exitPid = proc.pid ?? null;
                  const restartDeadline = Date.now() + restartRecoveryWaitMs;
                  while (Date.now() < restartDeadline) {
                    const pids = ctx.findListeningPids(resolvedPort);
                    if (!pids.length || (exitPid && pids.every((pid) => pid !== exitPid))) {
                      break;
                    }
                    await ctx.sleep(150);
                  }
                  const attempt = 1;
                  const spawnPlan = resolveLiveServerSpawnPlan();
                  const entryReady = await waitForServerEntryReady(spawnPlan.entry, restartDeadline);
                  if (!entryReady) {
                    throw new Error(
                      `Timed out waiting for restarted child on port ${resolvedPort}: server entry not ready: ${spawnPlan.entry}`
                    );
                  }
                  const nextChild = ctx.spawn(nodeBin, spawnPlan.args, {
                    ...spawnOptions,
                    env: spawnPlan.env,
                    cwd: spawnPlan.cwd
                  });
                  activeChildProc = nextChild;
                  writePidFile(nextChild.pid);
                  try {
                    writeRuntimeInstance({
                      port: resolvedPort,
                      host: serverHost,
                      command: 'rcc start (daemon restart)',
                      configPath: configPath,
                      ownerScope: 'cli.start.daemon',
                      status: 'declared',
                      routeCodexHomeDir: routeCodexHome,
                    });
                  } catch (error) {
                    logStartNonBlocking(ctx, 'write_runtime_instance.daemon_restart', error, { port: resolvedPort });
                  }
                  forwardToConsoleAndLog((nextChild as unknown as { stdout?: NodeJS.ReadableStream | null }).stdout, process.stdout);
                  forwardToConsoleAndLog((nextChild as unknown as { stderr?: NodeJS.ReadableStream | null }).stderr, process.stderr);
                  attachChildExitHandler(nextChild);
                  const probe = await waitForChildHealthyOrExit(nextChild, restartDeadline);
                  if (probe.healthy) {
                    try {
                      updateRuntimeInstanceStatus({ port: resolvedPort, status: 'healthy', routeCodexHomeDir: routeCodexHome });
                    } catch (error) {
                      logStartNonBlocking(ctx, 'update_runtime_instance.healthy', error, { port: resolvedPort });
                    }
                    ctx.logger.info(`[client-restart] RouteCodex child restarted on port ${resolvedPort} (pid=${nextChild.pid ?? 'unknown'}, attempt=${attempt})`);
                    restartInFlight = false;
                    return;
                  }
                  const exited =
                    typeof probe.exitCode === 'number'
                    || Boolean(probe.signal);
                  if (!exited) {
                    throw new Error(
                      `Timed out waiting for restarted child on port ${resolvedPort}: attempt=${attempt} did not become healthy before timeout`
                    );
                  }
                  throw new Error(
                    probe.startupExitState?.kind === 'startupError'
                      ? `RouteCodex startup failed on port ${resolvedPort}; managed restart stopped: ${probe.startupExitState.message || 'startupError'}`
                      : `Timed out waiting for restarted child on port ${resolvedPort}: attempt=${attempt} child exited early (code=${probe.exitCode ?? 'n/a'}, signal=${probe.signal ?? 'none'})`
                  );
                } catch (error) {
                  closeServerLogStream();
                  try {
                    cleanupKeypress();
                  } catch (cleanupError) {
                    logStartNonBlocking(ctx, 'cleanup_keypress.after_restart_failure', cleanupError, {
                      port: resolvedPort
                    });
                  }
                  const startupExitState = readChildStartupExitState({
                    port: resolvedPort,
                    routeCodexHomeDir: routeCodexHome
                  });
                  if (startupExitState?.kind === 'startupError' && startupExitState.message) {
                    ctx.logger.error(`[client-exit] startupError=${startupExitState.message}`);
                  }
                  ctx.logger.error(error instanceof Error ? error.message : String(error));
                  ctx.exit(1);
                }
              })();
              return;
            }
            if (restartInFlight) {
              // During managed restart bootstrap, child exits are handled by the restart loop.
              // Do not terminate parent process prematurely.
              return;
            }
            closeServerLogStream();
            try {
              cleanupKeypress();
            } catch (error) {
              logStartNonBlocking(ctx, 'cleanup_keypress.child_exit', error, {
                port: resolvedPort
              });
            }
            releaseStartPortGroupLock();
            if (signal) {ctx.exit(0);}
            ctx.exit(code ?? 0);
          });
        };

        const spawnChild = (): ReturnType<typeof ctx.spawn> => {
          const spawnPlan = resolveLiveServerSpawnPlan();
          const proc = ctx.spawn(nodeBin, spawnPlan.args, {
            ...spawnOptions,
            env: spawnPlan.env,
            cwd: spawnPlan.cwd
          });
          activeChildProc = proc;
          writePidFile(proc.pid);
          try {
            writeRuntimeInstance({
              port: resolvedPort,
              host: serverHost,
              command: 'rcc start',
              configPath: configPath,
              ownerScope: 'cli.start',
              status: 'declared',
              routeCodexHomeDir: routeCodexHome,
            });
          } catch (error) {
            logStartNonBlocking(ctx, 'write_runtime_instance', error, { port: resolvedPort });
          }
          forwardToConsoleAndLog((proc as unknown as { stdout?: NodeJS.ReadableStream | null }).stdout, process.stdout);
          forwardToConsoleAndLog((proc as unknown as { stderr?: NodeJS.ReadableStream | null }).stderr, process.stderr);
          attachChildExitHandler(proc);
          return proc;
        };

        const initialChild = spawnChild();

        spinner.succeed(`RouteCodex server starting on ${serverHost}:${resolvedPort}`);
        ctx.logger.info(`Configuration loaded from: ${configPath}`);
        ctx.logger.info(`Server will run on port: ${resolvedPort}`);
        if (serverLogPath) {
          ctx.logger.info(`Server log file: ${serverLogPath}`);
        }
        ctx.logger.info('Press Ctrl+C to stop the server');

        void (async () => {
          const probe = await waitForChildHealthyOrExit(initialChild, Date.now() + 60_000);
          if (probe.healthy) {
            try {
              updateRuntimeInstanceStatus({ port: resolvedPort, status: 'healthy', routeCodexHomeDir: routeCodexHome });
            } catch (error) {
              logStartNonBlocking(ctx, 'update_runtime_instance.healthy_initial', error, { port: resolvedPort });
            }
          }
          releaseStartPortGroupLock();
        })();

        const shutdown = async (sig: NodeJS.Signals) => {
          shutdownSignalCount += 1;
          if (shuttingDown) {
            const code = resolveShutdownExitCode(sig);
            ctx.logger.warning(`[start] received ${sig} while shutdown is in progress; forcing exit.`);
            try {
              activeChildProc?.kill('SIGKILL');
            } catch (error) {
              logStartNonBlocking(ctx, 'shutdown.force_kill_on_reentry', error, {
                port: resolvedPort,
                signal: sig
              });
            }
            closeServerLogStream();
            releaseStartPortGroupLock();
            try {
              cleanupKeypress();
            } catch (error) {
              logStartNonBlocking(ctx, 'cleanup_keypress.force_exit', error, {
                port: resolvedPort,
                signal: sig
              });
            }
            ctx.exit(code);
            return;
          }
          shuttingDown = true;
          try {
            updateRuntimeInstanceStatus({ port: resolvedPort, status: 'shutdown-intent', routeCodexHomeDir: routeCodexHome });
          } catch (error) {
            logStartNonBlocking(ctx, 'update_runtime_instance.shutdown_intent', error, { port: resolvedPort });
          }
          try {
            await applyLifecycleOrThrow({
              action: 'server_shutdown_requested',
              signal: sig,
              targetPid: activeChildProc?.pid ?? null
            });
            try {
              const controller = new AbortController();
              const timeoutMs = resolveStartShutdownHttpTimeoutMs(ctx.env);
              const timeout = setTimeout(() => {
                try {
                  controller.abort();
                } catch (error) {
                  logStartNonBlocking(ctx, 'shutdown_http.abort_controller', error, {
                    port: resolvedPort,
                    timeoutMs
                  });
                }
              }, timeoutMs);
              try {
                await ctx.fetch(`${HTTP_PROTOCOLS.HTTP}${LOCAL_HOSTS.IPV4}:${resolvedPort}${API_PATHS.SHUTDOWN}`, {
                  method: 'POST',
                  signal: controller.signal,
                  headers: buildShutdownCallerHeaders()
                }).catch((error) => {
                  ctx.logger.warning(
                    `[start] shutdown request failed (non-blocking) port=${resolvedPort}: ${error instanceof Error ? error.message : String(error)}`
                  );
                });
              } finally {
                clearTimeout(timeout);
              }
            } catch (error) {
              ctx.logger.warning(
                `[start] shutdown request threw (non-blocking) port=${resolvedPort}: ${error instanceof Error ? error.message : String(error)}`
              );
            }
            try {
              const currentChildPid = activeChildProc?.pid;
              if (currentChildPid && currentChildPid === process.pid) {
                logProcessLifecycleSync({
                  event: 'self_termination',
                  source: 'cli.start.shutdown',
                  details: {
                    reason: 'self_kill_guard',
                    signal: sig,
                    childPid: currentChildPid,
                    parentPid: process.pid,
                    result: 'blocked'
                  }
                });
              } else {
                activeChildProc?.kill(sig);
              }
            } catch (error) {
              logStartNonBlocking(ctx, 'shutdown.signal_child', error, {
                port: resolvedPort,
                signal: sig,
                childPid: activeChildProc?.pid ?? null
              });
            }
            const childExited = await new Promise<boolean>((resolve) => {
              let settled = false;
              const complete = (value: boolean) => {
                if (settled) {
                  return;
                }
                settled = true;
                resolve(value);
              };
              activeChildProc?.once('exit', () => complete(true));
              setTimeout(() => complete(false), 3500);
            });
            if (!childExited) {
              try {
                activeChildProc?.kill('SIGKILL');
              } catch (error) {
                logStartNonBlocking(ctx, 'shutdown.force_kill_after_timeout', error, {
                  port: resolvedPort,
                  childPid: activeChildProc?.pid ?? null
                });
              }
            }
            logProcessLifecycleSync({
              event: 'self_termination',
              source: 'cli.start.shutdown',
              details: {
                reason: 'shutdown_sequence_completed',
                signal: sig,
                targetPort: resolvedPort,
                childPid: activeChildProc?.pid ?? null,
                childExited
              }
            });
            await applyLifecycleOrThrow({
              action: 'server_shutdown_complete',
              signal: sig,
              targetPid: activeChildProc?.pid ?? null,
              metadata: {
                childExited
              }
            });
            closeServerLogStream();
            try {
              ctx.exit(0);
            } catch (error) {
              logStartNonBlocking(ctx, 'shutdown.exit_zero', error, {
                port: resolvedPort
              });
            }
          } catch (error) {
            closeServerLogStream();
            releaseStartPortGroupLock();
            ctx.logger.error(error instanceof Error ? error.message : String(error));
            ctx.exit(1);
          }
        };

        const onSignal = ctx.onSignal ?? ((sig: NodeJS.Signals, cb: () => void) => process.on(sig, cb));
        onSignal('SIGINT', () => { void shutdown('SIGINT'); });
        onSignal('SIGTERM', () => { void shutdown('SIGTERM'); });

        cleanupKeypress = ctx.setupKeypress(() => { void shutdown('SIGINT'); });
        await ctx.waitForever();
      } catch (error) {
        releaseStartPortGroupLock();
        if (error instanceof Error && /^exit:\d+$/.test(error.message)) {
          throw error;
        }
        spinner.fail('Failed to start server');
        ctx.logger.error(error instanceof Error ? error.message : String(error));
        ctx.exit(1);
      }
    });
}
