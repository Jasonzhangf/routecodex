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
  port?: string;
  host?: string;
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
  fsImpl?: Pick<typeof fs, 'existsSync' | 'readFileSync' | 'readdirSync' | 'statSync'>;
  pathImpl?: Pick<typeof path, 'join'>;
  getHomeDir?: () => string;
  exit: (code: number) => never;
};

function parseConfigPortHost(config: any): { port: number; host: string } {
  const port = (config?.httpserver?.port ?? config?.server?.port ?? config?.port);
  const host = (config?.httpserver?.host ?? config?.server?.host ?? config?.host ?? LOCAL_HOSTS.LOCALHOST);
  return { port, host };
}

function parsePortOption(ctx: RestartCommandContext, spinner: Spinner, value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const raw = String(value).trim();
  if (!raw) {
    return null;
  }
  const port = Number(raw);
  if (!Number.isFinite(port) || port <= 0) {
    spinner.fail(`Invalid --port value: ${raw}`);
    ctx.exit(1);
  }
  return port;
}

function resolveRestartWaitMs(ctx: RestartCommandContext): number {
  const raw = String(ctx.env?.ROUTECODEX_RESTART_WAIT_MS ?? ctx.env?.RCC_RESTART_WAIT_MS ?? '').trim();
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 5000) {
    return Math.floor(parsed);
  }
  return 45000;
}

function resolveConfigPortHostMaybe(
  ctx: RestartCommandContext,
  options: RestartCommandOptions,
  spinner: Spinner,
  opts?: { strict?: boolean }
): { port: number; host: string } | null {
  const fsImpl = ctx.fsImpl ?? fs;
  const pathImpl = ctx.pathImpl ?? path;
  const home = ctx.getHomeDir ?? (() => homedir());
  const configPath = options.config || pathImpl.join(home(), '.routecodex', 'config.json');

  if (!fsImpl.existsSync(configPath)) {
    if (opts?.strict) {
      spinner.fail(`Configuration file not found: ${configPath}`);
      ctx.logger.error('Cannot determine server port without configuration file');
      ctx.logger.info('Please create a configuration file first:');
      ctx.logger.info('  rcc init');
      ctx.logger.info('  rcc config init');
      ctx.exit(1);
    }
    return null;
  }

  let config: any;
  try {
    const configContent = fsImpl.readFileSync(configPath, 'utf8');
    config = JSON.parse(configContent);
  } catch {
    if (opts?.strict) {
      spinner.fail('Failed to parse configuration file');
      ctx.logger.error(`Invalid JSON in configuration file: ${configPath}`);
      ctx.exit(1);
    }
    return null;
  }

  const { port, host } = parseConfigPortHost(config);
  if (!port || typeof port !== 'number' || port <= 0) {
    if (opts?.strict) {
      spinner.fail('Invalid or missing port configuration');
      ctx.logger.error('Configuration file must specify a valid port number');
      ctx.exit(1);
    }
    return null;
  }
  return { port, host: String(host || LOCAL_HOSTS.LOCALHOST) };
}

function getSessionCandidatePorts(ctx: RestartCommandContext): number[] {
  const fsImpl =
    ctx.fsImpl && typeof (ctx.fsImpl as any).readdirSync === 'function' && typeof (ctx.fsImpl as any).statSync === 'function'
      ? (ctx.fsImpl as any as typeof fs)
      : fs;
  const pathImpl = ctx.pathImpl ?? path;
  const home = ctx.getHomeDir ?? (() => homedir());
  const base = pathImpl.join(home(), '.routecodex', 'sessions');
  try {
    if (!fsImpl.existsSync(base)) {
      return [];
    }
    const entries = (fsImpl.readdirSync as any)?.(base, { withFileTypes: true }) ?? fsImpl.readdirSync(base);
    const ports: number[] = [];
    for (const entry of entries as any[]) {
      const name = typeof entry === 'string' ? entry : String(entry?.name ?? '');
      if (!name) {
        continue;
      }
      const isDir =
        typeof entry !== 'string'
          ? Boolean((entry as { isDirectory?: () => boolean }).isDirectory?.())
          : (() => {
              try {
                return fsImpl.statSync(pathImpl.join(base, name)).isDirectory();
              } catch {
                return false;
              }
            })();
      if (!isDir) {
        continue;
      }
      const m = name.match(/_(\d+)$/);
      if (!m) {
        continue;
      }
      const port = Number(m[1]);
      if (Number.isFinite(port) && port > 0) {
        ports.push(port);
      }
    }
    return ports;
  } catch {
    return [];
  }
}

async function isRouteCodexServer(ctx: RestartCommandContext, host: string, port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      try { controller.abort(); } catch { /* ignore */ }
    }, 900);
    const res = await ctx.fetch(`${HTTP_PROTOCOLS.HTTP}${host}:${port}${API_PATHS.HEALTH}`, { signal: controller.signal }).catch(() => null);
    clearTimeout(timeout);
    if (!res || !res.ok) {
      return false;
    }
    const data = await (res as any).json?.().catch(() => null);
    return Boolean(data && typeof data === 'object' && (data as any).server === 'routecodex');
  } catch {
    return false;
  }
}

type RestartTarget = { host: string; port: number; oldPids: number[] };

async function resolveRestartTargets(ctx: RestartCommandContext, options: RestartCommandOptions, spinner: Spinner): Promise<RestartTarget[]> {
  const explicitPort = parsePortOption(ctx, spinner, options.port);
  const explicitHost = typeof options.host === 'string' && options.host.trim() ? options.host.trim() : null;

  if (explicitPort) {
    const host = explicitHost || LOCAL_HOSTS.LOCALHOST;
    const pids = ctx.findListeningPids(explicitPort);
    if (!pids.length) {
      spinner.fail(`No RouteCodex server found on ${host}:${explicitPort}`);
      ctx.exit(1);
    }
    const ok = await isRouteCodexServer(ctx, host === LOCAL_HOSTS.LOCALHOST ? LOCAL_HOSTS.IPV4 : host, explicitPort)
      || await isRouteCodexServer(ctx, host, explicitPort);
    if (!ok) {
      spinner.fail(`No RouteCodex server found on ${host}:${explicitPort}`);
      ctx.exit(1);
    }
    return [{ host, port: explicitPort, oldPids: pids }];
  }

  const candidatePorts = new Set<number>();

  for (const p of getSessionCandidatePorts(ctx)) {
    candidatePorts.add(p);
  }

  if (ctx.isDevPackage) {
    const envPort = Number(ctx.env?.ROUTECODEX_PORT || ctx.env?.RCC_PORT || NaN);
    if (!Number.isNaN(envPort) && envPort > 0) {
      candidatePorts.add(envPort);
    }
    candidatePorts.add(ctx.defaultDevPort);
  }

  const configMaybe = resolveConfigPortHostMaybe(ctx, options, spinner, { strict: Boolean(options.config) });
  if (configMaybe?.port) {
    candidatePorts.add(configMaybe.port);
  }

  const ports = Array.from(candidatePorts.values()).filter((p) => Number.isFinite(p) && p > 0);
  if (!ports.length) {
    spinner.fail('No known server ports to restart');
    ctx.logger.error('Start a server first or specify a port: routecodex restart --port <port>');
    ctx.exit(1);
  }

  const targets: RestartTarget[] = [];
  const healthHosts = [explicitHost, LOCAL_HOSTS.IPV4, LOCAL_HOSTS.LOCALHOST].filter(Boolean) as string[];
  for (const port of ports) {
    const pids = ctx.findListeningPids(port);
    if (!pids.length) {
      continue;
    }
    let ok = false;
    let hostUsed: string = LOCAL_HOSTS.LOCALHOST;
    for (const h of healthHosts) {
      if (await isRouteCodexServer(ctx, h, port)) {
        ok = true;
        hostUsed = h;
        break;
      }
    }
    if (!ok) {
      continue;
    }
    targets.push({ host: hostUsed, port, oldPids: pids });
  }

  if (!targets.length) {
    spinner.fail('No RouteCodex servers found to restart');
    ctx.logger.error(`Checked ports: ${ports.join(', ')}`);
    ctx.logger.info('Tip: specify the port explicitly: routecodex restart --port <port>');
    ctx.exit(1);
  }

  // Deterministic ordering for logs/tests.
  targets.sort((a, b) => a.port - b.port);
  return targets;
}

async function waitForRestart(ctx: RestartCommandContext, host: string, port: number, oldPids: number[]): Promise<void> {
  const deadline = Date.now() + resolveRestartWaitMs(ctx);
  const old = new Set(oldPids);
  let sawNewPid = false;
  let sawEndpointUnavailable = false;
  let samePidHealthyStreak = 0;
  while (Date.now() < deadline) {
    const current = ctx.findListeningPids(port);
    if (!current.length) {
      sawEndpointUnavailable = true;
      samePidHealthyStreak = 0;
      await ctx.sleep(150);
      continue;
    }
    if (current.some((pid) => !old.has(pid))) {
      sawNewPid = true;
    }
    const healthy = await isRouteCodexServer(ctx, host, port);
    if (!healthy) {
      sawEndpointUnavailable = true;
      samePidHealthyStreak = 0;
      await ctx.sleep(sawNewPid ? 250 : 150);
      continue;
    }
    if (sawNewPid || sawEndpointUnavailable) {
      return;
    }
    const allCurrentPidsAreOld = current.length > 0 && current.every((pid) => old.has(pid));
    if (allCurrentPidsAreOld) {
      // In-process runtime reload may keep the same listening PID. Accept this after
      // multiple successful health probes so restart does not false-timeout.
      samePidHealthyStreak += 1;
      if (samePidHealthyStreak >= 3) {
        return;
      }
    } else {
      samePidHealthyStreak = 0;
    }
    await ctx.sleep(150);
  }
  throw new Error('Timeout waiting for server to restart');
}

export function createRestartCommand(program: Command, ctx: RestartCommandContext): void {
  program
    .command('restart')
    .description('Restart RouteCodex server(s) (default: broadcast to all running servers)')
    .option('-c, --config <config>', 'Configuration file path')
    .option('-p, --port <port>', 'Restart a specific RouteCodex server port')
    .option('--host <host>', 'Host for health probing (default: localhost)')
    .option('--log-level <level>', 'Log level (debug, info, warn, error)', 'info')
    .option('--codex', 'Use Codex system prompt (tools unchanged)')
    .option('--claude', 'Use Claude system prompt (tools unchanged)')
    .action(async (options: RestartCommandOptions) => {
      const spinner = await ctx.createSpinner('Restarting RouteCodex server(s)...');
      try {
        // Prompt flags cannot be applied via a signal-based restart (server reloads from its own config/env).
        if (options.codex || options.claude) {
          spinner.fail('Flags --codex/--claude are not supported for restart; edit config/env and restart again.');
          ctx.exit(1);
        }

        if (ctx.isWindows) {
          spinner.fail('Signal-based restart is not supported on Windows');
          ctx.exit(1);
        }

        const targets = await resolveRestartTargets(ctx, options, spinner);

        const pidSeen = new Set<number>();
        const totalPids = targets.reduce((acc, t) => acc + t.oldPids.length, 0);
        spinner.text = `Sending restart signal to ${targets.length} server(s) (${totalPids} process(es))...`;
        for (const t of targets) {
          for (const pid of t.oldPids) {
            if (pidSeen.has(pid)) {
              continue;
            }
            pidSeen.add(pid);
            try {
              ctx.sendSignal(pid, 'SIGUSR2');
            } catch {
              // best-effort: continue broadcasting
            }
          }
        }

        spinner.text = 'Waiting for server(s) to restart...';
        for (const t of targets) {
          await waitForRestart(ctx, t.host || LOCAL_HOSTS.LOCALHOST, t.port, t.oldPids);
        }

        const ports = targets.map((t) => `${t.host}:${t.port}`).join(', ');
        spinner.succeed(`RouteCodex server(s) restarted: ${ports}`);
      } catch (e) {
        spinner.fail(`Failed to restart: ${(e as Error).message}`);
        ctx.exit(1);
      }
    });
}
