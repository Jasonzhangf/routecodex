import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import type { Command } from 'commander';

// feature_id: runtime.lifecycle.restart_command
import { HTTP_PROTOCOLS, LOCAL_HOSTS } from '../../constants/index.js';
import { resolveRccSessionsDir } from '../../config/user-data-paths.js';
import { resolveRouteCodexConfigPath } from '../../config/config-paths.js';
import { decodeUserConfigFileSync } from '../../config/user-config-codec.js';
import { resolvePortGroupFromConfig } from './port-group-resolver.js';
import type { GuardianLifecycleEvent, GuardianRegistration } from '../guardian/types.js';
import { formatUnknownError } from '../../utils/common-utils.js';
import {
  describeHealthProbeFailure,
  isNativeV3RouteCodexHealthBody,
  isRouteCodexRestartReadyHealthBody,
  probeRouteCodexHealth,
  type RouteCodexHealthProbeResult
} from '../../utils/http-health-probe.js';
import { buildLocalProbeHostCandidates, resolvePreferredLocalConnectHost } from '../../utils/local-connect-host.js';
import {
  planRuntimeRestartRequest,
  type RuntimeRestartRequestPlan
} from '../../modules/llmswitch/bridge/runtime-lifecycle-host.js';

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
  ensureGuardianDaemon?: () => Promise<void>;
  registerGuardianProcess?: (registration: GuardianRegistration) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  reportGuardianLifecycle?: (event: GuardianLifecycleEvent) => Promise<boolean>;
  runNativeV3Restart?: (request: NativeV3RestartRequest) => Promise<NativeV3RestartResult> | NativeV3RestartResult;
  fsImpl?: Pick<typeof fs, 'existsSync' | 'readFileSync' | 'readdirSync' | 'statSync'>;
  pathImpl?: Pick<typeof path, 'join'>;
  getHomeDir?: () => string;
  exit: (code: number) => never;
};

type RestartApiKeyResolution = {
  value: string;
  source: 'config' | 'env' | 'none';
};

type RestartMember = {
  host: string;
  port: number;
  oldPids: number[];
};

type NativeV3RestartTarget = {
  configPath: string;
  instanceId: string;
  serverId?: string;
  members: Array<{ host: string; port: number }>;
};

export type NativeV3RestartRequest = NativeV3RestartTarget & {
  timeoutMs: number;
};

export type NativeV3RestartResult = {
  ok: boolean;
  status?: number | null;
  stdout?: string;
  stderr?: string;
  errorMessage?: string;
};

type RestartTarget = {
  host: string;
  port: number;
  oldPids: number[];
  members: RestartMember[];
  nativeV3?: NativeV3RestartTarget;
};

function logRestartNonBlocking(
  ctx: RestartCommandContext,
  stage: string,
  error: unknown,
  details: Record<string, unknown> = {}
): void {
  try {
    const detailSuffix = Object.keys(details).length ? ` details=${JSON.stringify(details)}` : '';
    ctx.logger.info(`[restart] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`);
  } catch {
    // Never throw from non-blocking logging.
  }
}

function logRestartHealthProbeNonBlocking(
  ctx: RestartCommandContext,
  stage: string,
  result: RouteCodexHealthProbeResult | null,
  details: Record<string, unknown> = {}
): void {
  if (!result || result.ok) {
    return;
  }
  try {
    const detailSuffix = Object.keys(details).length ? ` details=${JSON.stringify(details)}` : '';
    const statusSuffix = typeof result.status === 'number' ? ` status=${result.status}` : '';
    ctx.logger.info(`[restart] ${stage} probe=${result.kind}${statusSuffix}${detailSuffix}`);
  } catch {
    // Never throw from non-blocking logging.
  }
}

function parseConfigPortHost(config: any): { port: number; host: string } {
  const port = (config?.httpserver?.port ?? config?.server?.port ?? config?.port);
  const host = (config?.httpserver?.host ?? config?.server?.host ?? config?.host ?? LOCAL_HOSTS.LOCALHOST);
  return { port, host };
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveConfigApiKeyValue(raw: unknown, env: NodeJS.ProcessEnv | undefined): string {
  const trimmed = normalizeString(raw);
  if (!trimmed) {
    return '';
  }
  const envMatch = trimmed.match(/^\$\{([A-Z0-9_]+)\}$/i);
  if (envMatch) {
    return normalizeString(env?.[envMatch[1]]);
  }
  if (/^[A-Z][A-Z0-9_]+$/.test(trimmed)) {
    return normalizeString(env?.[trimmed]);
  }
  return trimmed;
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

function isHttpOnlyRestartMode(ctx: RestartCommandContext): boolean {
  const raw = String(ctx.env?.ROUTECODEX_RESTART_HTTP_ONLY ?? ctx.env?.RCC_RESTART_HTTP_ONLY ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

function resolveConfigPortHostMaybe(
  ctx: RestartCommandContext,
  options: RestartCommandOptions,
  spinner: Spinner,
  opts?: { strict?: boolean }
): { port: number; host: string } | null {
  const fsImpl = ctx.fsImpl ?? fs;
  let configPath: string;
  try {
    configPath = options.config ? resolveRouteCodexConfigPath(options.config) : resolveRouteCodexConfigPath();
  } catch {
    if (opts?.strict) {
      spinner.fail('Configuration file not found');
      ctx.logger.error('Cannot determine server port without configuration file');
      ctx.logger.info('Please create a configuration file first:');
      ctx.logger.info('  rcc init');
      ctx.logger.info('  rcc config init');
      ctx.exit(1);
    }
    return null;
  }

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
    config = decodeUserConfigFileSync(
      configPath,
      fsImpl as Pick<typeof fs, 'readFileSync'>
    ).parsed;
  } catch {
    if (opts?.strict) {
      spinner.fail('Failed to parse configuration file');
      ctx.logger.error(`Invalid configuration file: ${configPath}`);
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

function readConfigApiKeyRaw(config: any): { present: boolean; raw: unknown } {
  if (config && typeof config === 'object') {
    if (config.httpserver && typeof config.httpserver === 'object' && 'apikey' in config.httpserver) {
      return { present: true, raw: config.httpserver.apikey };
    }
    if (config.modules?.httpserver?.config && typeof config.modules.httpserver.config === 'object' && 'apikey' in config.modules.httpserver.config) {
      return { present: true, raw: config.modules.httpserver.config.apikey };
    }
    if (config.server && typeof config.server === 'object' && 'apikey' in config.server) {
      return { present: true, raw: config.server.apikey };
    }
  }
  return { present: false, raw: undefined };
}

function resolveRestartApiKey(
  ctx: RestartCommandContext,
  options: RestartCommandOptions
): RestartApiKeyResolution {
  const fsImpl = ctx.fsImpl ?? fs;
  let configPath: string;
  try {
    configPath = options.config ? resolveRouteCodexConfigPath(options.config) : resolveRouteCodexConfigPath();
  } catch {
    const fromEnv = normalizeString(ctx.env?.ROUTECODEX_HTTP_APIKEY) || normalizeString(ctx.env?.RCC_HTTP_APIKEY);
    if (fromEnv) {
      return { value: fromEnv, source: 'env' };
    }
    return { value: '', source: 'none' };
  }
  if (fsImpl.existsSync(configPath)) {
    try {
      const config = decodeUserConfigFileSync(
        configPath,
        fsImpl as Pick<typeof fs, 'readFileSync'>
      ).parsed;
      const apiKeyField = readConfigApiKeyRaw(config);
      if (apiKeyField.present) {
        return {
          value: resolveConfigApiKeyValue(apiKeyField.raw, ctx.env),
          source: 'config'
        };
      }
    } catch {
      return { value: '', source: 'none' };
    }
  }
  const fromEnv = normalizeString(ctx.env?.ROUTECODEX_HTTP_APIKEY) || normalizeString(ctx.env?.RCC_HTTP_APIKEY);
  if (fromEnv) {
    return { value: fromEnv, source: 'env' };
  }
  return { value: '', source: 'none' };
}

function getSessionCandidatePorts(ctx: RestartCommandContext): number[] {
  const fsImpl =
    ctx.fsImpl && typeof (ctx.fsImpl as any).readdirSync === 'function' && typeof (ctx.fsImpl as any).statSync === 'function'
      ? (ctx.fsImpl as any as typeof fs)
      : fs;
  const pathImpl = ctx.pathImpl ?? path;
  const home = ctx.getHomeDir ?? (() => homedir());
  const base = resolveRccSessionsDir(home());
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

async function probeRouteCodexServer(
  ctx: RestartCommandContext,
  host: string,
  port: number
): Promise<RouteCodexHealthProbeResult> {
  return probeRouteCodexHealth({
    fetchImpl: ctx.fetch,
    host,
    port,
    timeoutMs: 900
  });
}

function normalizeHostForHttp(host: string): string {
  return resolvePreferredLocalConnectHost(host);
}

function nativeV3StateInstancesDir(ctx: RestartCommandContext): string {
  const pathImpl = ctx.pathImpl ?? path;
  const home = ctx.getHomeDir ?? (() => homedir());
  const explicit = normalizeString(ctx.env?.ROUTECODEX_V3_STATE_DIR ?? ctx.env?.RCC_V3_STATE_DIR);
  if (explicit) {
    return pathImpl.join(explicit, 'instances');
  }
  return pathImpl.join(home(), '.rcc', 'state', 'v3-runtime', 'instances');
}

function parseJsonFile(ctx: RestartCommandContext, filePath: string): any | null {
  const fsImpl = ctx.fsImpl ?? fs;
  try {
    return JSON.parse(String(fsImpl.readFileSync(filePath)));
  } catch {
    return null;
  }
}

function entryName(entry: unknown): string {
  if (typeof entry === 'string') {
    return entry;
  }
  const name = (entry as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : '';
}

function entryIsDirectory(ctx: RestartCommandContext, base: string, entry: unknown): boolean {
  if (typeof entry !== 'string') {
    const fn = (entry as { isDirectory?: () => boolean } | null)?.isDirectory;
    if (typeof fn === 'function') {
      return Boolean(fn.call(entry));
    }
  }
  const fsImpl = ctx.fsImpl ?? fs;
  const pathImpl = ctx.pathImpl ?? path;
  try {
    return Boolean((fsImpl.statSync(pathImpl.join(base, entryName(entry))) as any)?.isDirectory?.());
  } catch {
    return false;
  }
}

function nativeV3MemberHost(bind: unknown): string {
  const raw = typeof bind === 'string' && bind.trim() ? bind.trim() : LOCAL_HOSTS.LOCALHOST;
  return normalizeHostForHttp(raw);
}

function resolveNativeV3RestartTargetFromRegistry(
  ctx: RestartCommandContext,
  args: {
    port: number;
    serverId?: string;
    configPath?: string;
  }
): NativeV3RestartTarget | null {
  const fsImpl = ctx.fsImpl ?? fs;
  const pathImpl = ctx.pathImpl ?? path;
  const instancesDir = nativeV3StateInstancesDir(ctx);
  try {
    if (!fsImpl.existsSync(instancesDir)) {
      return null;
    }
  } catch {
    return null;
  }

  const entries = (() => {
    try {
      return (fsImpl.readdirSync as any)?.(instancesDir, { withFileTypes: true }) ?? fsImpl.readdirSync(instancesDir);
    } catch {
      return [] as unknown[];
    }
  })();

  type Candidate = NativeV3RestartTarget & {
    updatedAt: number;
    mtimeMs: number;
  };
  const candidates: Candidate[] = [];
  for (const entry of entries as unknown[]) {
    const name = entryName(entry);
    if (!name || !entryIsDirectory(ctx, instancesDir, entry)) {
      continue;
    }
    const dir = pathImpl.join(instancesDir, name);
    const instancePath = pathImpl.join(dir, 'instance.json');
    const statusPath = pathImpl.join(dir, 'status.json');
    if (!fsImpl.existsSync(instancePath) || !fsImpl.existsSync(statusPath)) {
      continue;
    }
    const declaration = parseJsonFile(ctx, instancePath);
    const status = parseJsonFile(ctx, statusPath);
    const listeners = Array.isArray(declaration?.listeners) ? declaration.listeners : [];
    const matchesPort = listeners.some((listener: any) => Number(listener?.port) === args.port);
    if (!matchesPort) {
      continue;
    }
    if (args.serverId && !listeners.some((listener: any) => (
      Number(listener?.port) === args.port && listener?.server_id === args.serverId
    ))) {
      continue;
    }
    if (args.configPath && declaration?.config_path !== args.configPath) {
      continue;
    }
    const configPath = typeof declaration?.config_path === 'string' ? declaration.config_path : '';
    const instanceId = typeof declaration?.instance_id === 'string' ? declaration.instance_id : '';
    if (!configPath || !instanceId || !fsImpl.existsSync(configPath)) {
      continue;
    }
    const state = typeof status?.state === 'string' ? status.state : '';
    if (state === 'stopped' || state === 'failed') {
      continue;
    }
    const updatedAt = Number(status?.updated_at_epoch_ms ?? 0);
    const mtimeMs = (() => {
      try {
        return Number((fsImpl.statSync(statusPath) as any)?.mtimeMs ?? 0);
      } catch {
        return 0;
      }
    })();
    const members = listeners
      .map((listener: any) => ({
        host: nativeV3MemberHost(listener?.bind),
        port: Number(listener?.port)
      }))
      .filter((member: { host: string; port: number }) => Number.isFinite(member.port) && member.port > 0)
      .sort((a: { port: number }, b: { port: number }) => a.port - b.port);
    if (!members.length) {
      continue;
    }
    const matchingListener = listeners.find((listener: any) => Number(listener?.port) === args.port);
    candidates.push({
      configPath,
      instanceId,
      serverId: typeof matchingListener?.server_id === 'string' ? matchingListener.server_id : undefined,
      members,
      updatedAt,
      mtimeMs
    });
  }

  candidates.sort((a, b) => (
    b.updatedAt - a.updatedAt
    || b.mtimeMs - a.mtimeMs
    || a.instanceId.localeCompare(b.instanceId)
  ));
  const selected = candidates[0];
  if (!selected) {
    return null;
  }
  const sameRank = candidates.filter((candidate) => (
    candidate.updatedAt === selected.updatedAt && candidate.mtimeMs === selected.mtimeMs
  ));
  if (sameRank.length > 1) {
    return null;
  }
  return {
    configPath: selected.configPath,
    instanceId: selected.instanceId,
    serverId: selected.serverId,
    members: selected.members
  };
}

function buildNativeV3RestartMembers(
  ctx: RestartCommandContext,
  nativeV3: NativeV3RestartTarget,
  explicitHost: string | null
): RestartMember[] {
  return nativeV3.members.map((member) => ({
    port: member.port,
    host: explicitHost || member.host || LOCAL_HOSTS.LOCALHOST,
    oldPids: normalizePids(ctx.findListeningPids(member.port))
  }));
}

async function runNativeV3Restart(
  ctx: RestartCommandContext,
  nativeV3: NativeV3RestartTarget,
  timeoutMs: number
): Promise<NativeV3RestartResult> {
  const request: NativeV3RestartRequest = {
    ...nativeV3,
    timeoutMs
  };
  if (ctx.runNativeV3Restart) {
    return await ctx.runNativeV3Restart(request);
  }
  const result = spawnSync('rccv3', [
    'restart',
    '--config',
    nativeV3.configPath,
    '--timeout-ms',
    String(timeoutMs)
  ], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ...(ctx.env ?? {})
    }
  });
  return {
    ok: result.status === 0,
    status: result.status,
    errorMessage: result.error ? formatUnknownError(result.error) : undefined
  };
}

function normalizePids(pids: number[]): number[] {
  return Array.from(new Set(
    pids.filter((pid) => Number.isFinite(pid) && pid > 0).map((pid) => Math.floor(pid))
  )).sort((a, b) => a - b);
}

function pidIdentityKey(pids: number[]): string {
  return normalizePids(pids).join(',');
}

function formatRestartMember(member: Pick<RestartMember, 'host' | 'port'>): string {
  return `${member.host}:${member.port}`;
}

function isAggregateMemberReady(probe: RouteCodexHealthProbeResult | null): boolean {
  return probe?.ok === true && isRouteCodexRestartReadyHealthBody(probe.body);
}

async function resolveMemberProbeHost(
  ctx: RestartCommandContext,
  member: Pick<RestartMember, 'host' | 'port'>
): Promise<{ host: string; probe: RouteCodexHealthProbeResult | null }> {
  const probeHosts = buildLocalProbeHostCandidates(member.host);
  let lastProbe: RouteCodexHealthProbeResult | null = null;
  for (const probeHost of probeHosts) {
    lastProbe = await probeRouteCodexServer(ctx, probeHost, member.port);
    if (lastProbe.ok) {
      return { host: probeHost, probe: lastProbe };
    }
  }
  if (!lastProbe) {
    lastProbe = await probeRouteCodexServer(ctx, member.host, member.port);
  }
  return { host: member.host, probe: lastProbe };
}

async function requestProcessRestartViaHttp(
  ctx: RestartCommandContext,
  target: RestartTarget,
  apiKey: string | undefined,
  fallbackTransport: RuntimeRestartRequestPlan['httpFallbackTransport']
): Promise<'http' | 'signal'> {
  const host = normalizeHostForHttp(target.host || LOCAL_HOSTS.LOCALHOST);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      try {
        controller.abort();
      } catch (error) {
        logRestartNonBlocking(ctx, 'restart_process.abort_controller', error, {
          host,
          port: target.port
        });
      }
    }, 2500);
    const res = await ctx.fetch(`${HTTP_PROTOCOLS.HTTP}${host}:${target.port}/daemon/restart-process`, {
      method: 'POST',
      headers: apiKey ? { 'x-api-key': apiKey } : undefined,
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (res && (res.status === 200 || res.status === 202 || res.status === 204)) {
      return 'http';
    }
    if (res && ![404, 405, 501].includes(res.status)) {
      const body = await res.text().catch(() => '');
      throw new Error(`restart endpoint rejected on ${host}:${target.port} (${res.status}): ${body}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('restart endpoint rejected')) {
      throw error;
    }
    logRestartNonBlocking(ctx, 'restart_process.http_probe', error, {
      host,
      port: target.port
    });
  }
  if (fallbackTransport !== 'signal') {
    throw new Error(`restart endpoint unavailable on ${host}:${target.port}; manual one-time restart required to adopt server-managed restart`);
  }
  requestInPlaceRestart(ctx, target);
  return 'signal';
}

function planRestartTransport(
  ctx: RestartCommandContext,
  target: RestartTarget,
  restartApiKey: RestartApiKeyResolution
): RuntimeRestartRequestPlan {
  return planRuntimeRestartRequest({
    oldPids: Array.isArray(target.oldPids) ? target.oldPids : [],
    restartApiKey,
    httpOnly: isHttpOnlyRestartMode(ctx)
  });
}

async function resolveRestartTarget(ctx: RestartCommandContext, options: RestartCommandOptions, spinner: Spinner): Promise<RestartTarget> {
  const explicitPort = parsePortOption(ctx, spinner, options.port);
  const explicitHost = typeof options.host === 'string' && options.host.trim() ? options.host.trim() : null;

  if (explicitPort) {
    const grouped = ctx.isDevPackage
      ? null
      : resolvePortGroupFromConfig(ctx, {
          configPath: options.config,
          targetPort: explicitPort,
          includeSiblingsForTarget: true
        });
    const configuredMembers = grouped?.members?.length
      ? grouped.members
      : [{ port: explicitPort, host: grouped?.host || LOCAL_HOSTS.LOCALHOST }];
    const members: RestartMember[] = configuredMembers
      .map((member) => ({
        port: member.port,
        host: explicitHost || member.host || LOCAL_HOSTS.LOCALHOST,
        oldPids: normalizePids(ctx.findListeningPids(member.port))
      }))
      .sort((a, b) => a.port - b.port);
    const locator = members.find((member) => member.port === explicitPort);
    if (!locator?.oldPids.length) {
      const nativeV3 = resolveNativeV3RestartTargetFromRegistry(ctx, {
        port: explicitPort,
        configPath: options.config ? resolveRouteCodexConfigPath(options.config) : undefined
      });
      if (nativeV3) {
        const nativeMembers = buildNativeV3RestartMembers(ctx, nativeV3, explicitHost)
          .sort((a, b) => a.port - b.port);
        const nativeLocator = nativeMembers.find((member) => member.port === explicitPort) || nativeMembers[0];
        return {
          host: nativeLocator.host,
          port: nativeLocator.port,
          oldPids: nativeLocator.oldPids,
          members: nativeMembers,
          nativeV3
        };
      }
      const host = locator?.host || explicitHost || grouped?.host || LOCAL_HOSTS.LOCALHOST;
      spinner.fail(`No RouteCodex server found on ${host}:${explicitPort}`);
      ctx.exit(1);
    }
    const locatorIdentity = pidIdentityKey(locator.oldPids);
    const conflictingMember = members.find((member) => (
      member.oldPids.length > 0 && pidIdentityKey(member.oldPids) !== locatorIdentity
    ));
    if (conflictingMember) {
      spinner.fail('Configured aggregate server ports resolve to different listener identities');
      ctx.logger.error(
        `Locator ${formatRestartMember(locator)} pid(s)=${locatorIdentity}; `
        + `${formatRestartMember(conflictingMember)} pid(s)=${pidIdentityKey(conflictingMember.oldPids)}`
      );
      ctx.exit(1);
    }
    let nativeV3: NativeV3RestartTarget | null = null;
    for (const member of members) {
      const resolved = await resolveMemberProbeHost(ctx, member);
      member.host = resolved.host;
      if (
        member.port === explicitPort
        && resolved.probe?.ok === true
        && isNativeV3RouteCodexHealthBody(resolved.probe.body)
      ) {
        nativeV3 = resolveNativeV3RestartTargetFromRegistry(ctx, {
          port: explicitPort,
          serverId: typeof resolved.probe.body.server_id === 'string' ? resolved.probe.body.server_id : undefined,
          configPath: options.config ? resolveRouteCodexConfigPath(options.config) : undefined
        });
        if (!nativeV3) {
          const serverId = typeof resolved.probe.body.server_id === 'string'
            ? resolved.probe.body.server_id
            : 'unknown';
          spinner.fail(`Native V3 managed server registry not found for ${serverId} on ${formatRestartMember(member)}`);
          ctx.logger.error('Refusing to restart a native V3 listener through legacy signal transport.');
          ctx.exit(1);
        }
      }
      if (!isAggregateMemberReady(resolved.probe)) {
        const probeDetails = resolved.probe?.ok
          ? `ready=${String(resolved.probe.body.ready)} pipelineReady=${String(resolved.probe.body.pipelineReady)}`
          : resolved.probe
            ? describeHealthProbeFailure(resolved.probe)
            : 'no probe result';
        spinner.warn(
          `Health probe degraded on ${formatRestartMember(member)} `
          + `(${probeDetails}); `
          + 'requesting one aggregate in-session restart.'
        );
      }
    }
    if (members.length > 1) {
      ctx.logger.info(`[restart] resolved aggregate members: ${members.map((member) => member.port).join(', ')}`);
    }
    if (nativeV3) {
      const nativeMembers = buildNativeV3RestartMembers(ctx, nativeV3, explicitHost)
        .sort((a, b) => a.port - b.port);
      const nativeLocator = nativeMembers.find((member) => member.port === explicitPort) || nativeMembers[0];
      return {
        host: nativeLocator.host,
        port: nativeLocator.port,
        oldPids: nativeLocator.oldPids,
        members: nativeMembers,
        nativeV3
      };
    }
    return {
      host: locator.host,
      port: locator.port,
      oldPids: locator.oldPids,
      members
    };
  }

  const candidateMembers = new Map<number, { port: number; host: string; required: boolean }>();
  const addCandidate = (port: number, host: string, required = false): void => {
    if (Number.isFinite(port) && port > 0 && !candidateMembers.has(port)) {
      candidateMembers.set(port, {
        port: Math.floor(port),
        host: explicitHost || host || LOCAL_HOSTS.LOCALHOST,
        required
      });
      return;
    }
    const existing = candidateMembers.get(Math.floor(port));
    if (existing && required) {
      existing.required = true;
      existing.host = explicitHost || host || existing.host;
    }
  };

  for (const p of getSessionCandidatePorts(ctx)) {
    addCandidate(p, LOCAL_HOSTS.LOCALHOST);
  }

  if (ctx.isDevPackage) {
    const envPort = Number(ctx.env?.ROUTECODEX_PORT || ctx.env?.RCC_PORT || NaN);
    if (!Number.isNaN(envPort) && envPort > 0) {
      addCandidate(envPort, LOCAL_HOSTS.LOCALHOST);
    }
    addCandidate(ctx.defaultDevPort, LOCAL_HOSTS.LOCALHOST);
  }

  const configMaybe = resolveConfigPortHostMaybe(ctx, options, spinner, { strict: Boolean(options.config) });
  const configuredGroup = ctx.isDevPackage
    ? null
    : resolvePortGroupFromConfig(ctx, { configPath: options.config });
  if (configuredGroup?.members?.length) {
    for (const member of configuredGroup.members) {
      addCandidate(member.port, member.host, true);
    }
  } else if (configMaybe?.port) {
    addCandidate(configMaybe.port, configMaybe.host, true);
  }

  const candidates = Array.from(candidateMembers.values()).sort((a, b) => a.port - b.port);
  if (!candidates.length) {
    spinner.fail('No known server ports to restart');
    ctx.logger.error('Start a server first or specify a port: routecodex restart --port <port>');
    ctx.exit(1);
  }

  const membersByPort = new Map<number, RestartMember>();
  for (const candidate of candidates) {
    const pids = normalizePids(ctx.findListeningPids(candidate.port));
    if (!pids.length) {
      if (candidate.required) {
        membersByPort.set(candidate.port, {
          host: candidate.host,
          port: candidate.port,
          oldPids: []
        });
      }
      continue;
    }
    const resolved = await resolveMemberProbeHost(ctx, candidate);
    if (resolved.probe && !resolved.probe.ok && resolved.probe.kind !== 'starting') {
      logRestartHealthProbeNonBlocking(ctx, 'resolve_target.health_probe', resolved.probe, {
        host: resolved.host,
        port: candidate.port,
        kind: resolved.probe.kind
      });
    }
    membersByPort.set(candidate.port, {
      host: resolved.host,
      port: candidate.port,
      oldPids: pids
    });
  }

  const activeMembers = Array.from(membersByPort.values()).filter((member) => member.oldPids.length > 0);
  if (!activeMembers.length) {
    spinner.fail('No RouteCodex servers found to restart');
    ctx.logger.error(`Checked ports: ${candidates.map((candidate) => candidate.port).join(', ')}`);
    ctx.logger.info('Tip: specify the port explicitly: routecodex restart --port <port>');
    ctx.exit(1);
  }

  const identityKeys = Array.from(new Set(activeMembers.map((member) => pidIdentityKey(member.oldPids))));
  if (identityKeys.length > 1) {
    spinner.fail('Multiple aggregate RouteCodex server instances detected');
    ctx.logger.error(
      `Detected instances: ${activeMembers.map((member) => `${formatRestartMember(member)} pid(s)=${pidIdentityKey(member.oldPids)}`).join(', ')}`
    );
    ctx.logger.info('Use --port only to locate one aggregate server instance.');
    ctx.exit(1);
  }
  const members = Array.from(membersByPort.values());
  members.sort((a, b) => a.port - b.port);
  const locator = members.find((member) => member.oldPids.length > 0)!;
  if (members.length > 1) {
    ctx.logger.info(`[restart] grouped aggregate members by listener identity: ${members.map((member) => member.port).join(', ')}`);
  }
  return {
    host: locator.host,
    port: locator.port,
    oldPids: locator.oldPids,
    members
  };
}

async function waitForRestart(ctx: RestartCommandContext, target: RestartTarget): Promise<void> {
  const deadline = Date.now() + resolveRestartWaitMs(ctx);
  const old = new Set(target.oldPids);
  let sawNewPid = false;
  let sawEndpointUnavailable = false;
  let samePidHealthyStreak = 0;
  while (Date.now() < deadline) {
    const currentMembers = target.members.map((member) => ({
      member,
      pids: normalizePids(ctx.findListeningPids(member.port))
    }));
    if (currentMembers.some((item) => item.pids.length === 0)) {
      sawEndpointUnavailable = true;
      samePidHealthyStreak = 0;
      await ctx.sleep(150);
      continue;
    }
    const identityKeys = Array.from(new Set(currentMembers.map((item) => pidIdentityKey(item.pids))));
    if (identityKeys.length !== 1) {
      samePidHealthyStreak = 0;
      await ctx.sleep(150);
      continue;
    }
    const current = currentMembers[0].pids;
    if (current.some((pid) => !old.has(pid))) {
      sawNewPid = true;
    }
    let allHealthy = true;
    for (const item of currentMembers) {
      const resolved = await resolveMemberProbeHost(ctx, item.member);
      item.member.host = resolved.host;
      if (!isAggregateMemberReady(resolved.probe)) {
        allHealthy = false;
        sawEndpointUnavailable = true;
        samePidHealthyStreak = 0;
        if (resolved.probe?.ok) {
          ctx.logger.info(
            `[restart] wait_for_restart.not_ready host=${resolved.host} port=${item.member.port} `
            + `ready=${String(resolved.probe.body.ready)} pipelineReady=${String(resolved.probe.body.pipelineReady)}`
          );
        } else if (resolved.probe?.kind !== 'starting') {
          logRestartHealthProbeNonBlocking(
            ctx,
            'wait_for_restart.health_probe',
            resolved.probe || { ok: false, kind: 'network_error' },
            {
              host: resolved.host,
              port: item.member.port,
              kind: resolved.probe?.kind
            }
          );
        }
        break;
      }
    }
    if (!allHealthy) {
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
  throw new Error(
    `Timeout waiting for aggregate server to restart and restore members: `
    + target.members.map(formatRestartMember).join(', ')
  );
}

function requestInPlaceRestart(ctx: RestartCommandContext, target: RestartTarget): void {
  const pids = Array.isArray(target.oldPids) ? target.oldPids : [];
  let signaled = 0;
  for (const pid of pids) {
    try {
      ctx.sendSignal(pid, 'SIGUSR2');
      signaled += 1;
    } catch {
      // ignore; wait phase will verify
    }
  }
  if (signaled <= 0) {
    throw new Error(`failed to signal restart to ${target.host}:${target.port}`);
  }
}

export function createRestartCommand(program: Command, ctx: RestartCommandContext): void {
  program
    .command('restart')
    .description('Restart one aggregate RouteCodex server instance')
    .option('-c, --config <config>', 'Configuration file path')
    .option('-p, --port <port>', 'Member port used to locate the aggregate server instance')
    .option('--host <host>', 'Host for health probing (default: localhost)')
    .option('--log-level <level>', 'Log level (debug, info, warn, error)', 'info')
    .option('--codex', 'Use Codex system prompt (tools unchanged)')
    .option('--claude', 'Use Claude system prompt (tools unchanged)')
    .action(async (options: RestartCommandOptions) => {
      const spinner = await ctx.createSpinner('Restarting aggregate RouteCodex server...');
      try {
        const restartApiKey = resolveRestartApiKey(ctx, options);
        // Prompt flags cannot be applied via restart endpoint (server reloads from its own config/env).
        if (options.codex || options.claude) {
          spinner.fail('Flags --codex/--claude are not supported for restart; edit config/env and restart again.');
          ctx.exit(1);
        }

        const target = await resolveRestartTarget(ctx, options, spinner);
        await ctx.ensureGuardianDaemon?.();
        await ctx.registerGuardianProcess?.({
          source: 'restart',
          pid: process.pid,
          ppid: process.ppid,
          metadata: {
            locator: `${target.host}:${target.port}`,
            members: target.members.map(formatRestartMember)
          }
        });

        spinner.text = 'Requesting RouteCodex restart...';
        const approved = await ctx.reportGuardianLifecycle?.({
          action: 'restart_request',
          source: 'cli.restart',
          actorPid: process.pid,
          metadata: {
            host: target.host,
            locatorPort: target.port,
            memberPorts: target.members.map((member) => member.port)
          }
        });
        if (ctx.reportGuardianLifecycle && approved !== true) {
          throw new Error(`guardian lifecycle apply rejected for aggregate server at ${target.host}:${target.port}`);
        }
        const restartWaitMs = resolveRestartWaitMs(ctx);
        const transport = target.nativeV3
          ? await (async () => {
            const result = await runNativeV3Restart(ctx, target.nativeV3!, restartWaitMs);
            if (!result.ok) {
              const detail = result.errorMessage || result.stderr || result.stdout || `status=${String(result.status ?? 'unknown')}`;
              throw new Error(`native V3 managed restart failed for ${target.nativeV3!.configPath}: ${detail}`);
            }
            return 'native_v3' as const;
          })()
          : await (async () => {
            const plan = planRestartTransport(ctx, target, restartApiKey);
            return plan.preferredTransport === 'http'
              ? await requestProcessRestartViaHttp(ctx, target, restartApiKey.value, plan.httpFallbackTransport)
              : plan.preferredTransport === 'signal'
                ? (() => {
                  requestInPlaceRestart(ctx, target);
                  return 'signal' as const;
                })()
                : (() => {
                  throw new Error(`no restart transport available for aggregate server at ${target.host}:${target.port} (${plan.reasonCode})`);
                })();
          })();
        if (transport === 'signal') {
          spinner.warn(`Used one in-place signal restart for aggregate server at ${target.host}:${target.port}.`);
        } else if (transport === 'native_v3') {
          spinner.info(`Used native V3 managed restart for aggregate server at ${target.host}:${target.port}.`);
        }

        spinner.text = 'Waiting for aggregate server members to become healthy...';
        await waitForRestart(ctx, target);

        const members = target.members.map(formatRestartMember).join(', ');
        spinner.succeed(`Aggregate RouteCodex server restarted: ${members}`);
      } catch (e) {
        spinner.fail(`Failed to restart: ${(e as Error).message}`);
        ctx.exit(1);
      }
    });
}
