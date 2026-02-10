import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { Command } from 'commander';

import { LOCAL_HOSTS } from '../../constants/index.js';

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

export type LauncherCommandContext = {
  isDevPackage: boolean;
  isWindows: boolean;
  defaultDevPort: number;
  nodeBin: string;
  createSpinner: (text: string) => Promise<Spinner>;
  logger: LoggerLike;
  env: NodeJS.ProcessEnv;
  rawArgv: string[];
  fsImpl?: typeof fs;
  pathImpl?: typeof path;
  homedir: () => string;
  cwd?: () => string;
  sleep: (ms: number) => Promise<void>;
  fetch: typeof fetch;
  spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  getModulesConfigPath: () => string;
  resolveServerEntryPath: () => string;
  waitForever: () => Promise<void>;
  onSignal?: (signal: NodeJS.Signals, cb: () => void) => void;
  exit: (code: number) => never;
};

type LauncherCommandOptions = {
  port?: string;
  host: string;
  url?: string;
  config?: string;
  apikey?: string;
  cwd?: string;
  model?: string;
  profile?: string;
  ensureServer?: boolean;
  [key: string]: unknown;
};

type LauncherSpec = {
  commandName: string;
  displayName: string;
  description: string;
  binaryOptionFlags: string;
  binaryOptionName: string;
  binaryOptionDescription: string;
  binaryDefault: string;
  binaryEnvKey?: string;
  extraKnownOptions: string[];
  withModelOption?: boolean;
  withProfileOption?: boolean;
  buildArgs: (options: LauncherCommandOptions) => string[];
  buildEnv: (args: {
    env: NodeJS.ProcessEnv;
    baseUrl: string;
    configuredApiKey: string | null;
    cwd: string;
  }) => NodeJS.ProcessEnv;
};

type ResolvedServerConnection = {
  configPath: string;
  protocol: 'http' | 'https';
  host: string;
  connectHost: string;
  port: number;
  basePath: string;
  portPart: string;
  serverUrl: string;
  configuredApiKey: string | null;
};

function resolveBinary(options: {
  fsImpl: typeof fs;
  pathImpl: typeof path;
  homedir: () => string;
  command: string;
}): string {
  const raw = String(options.command || '').trim();
  if (!raw) {
    return '';
  }
  if (raw.includes('/') || raw.includes('\\')) {
    return raw;
  }

  const candidates: string[] = [];
  try {
    candidates.push(options.pathImpl.join('/opt/homebrew/bin', raw));
  } catch {
    // ignore
  }
  try {
    candidates.push(options.pathImpl.join('/usr/local/bin', raw));
  } catch {
    // ignore
  }
  try {
    candidates.push(options.pathImpl.join(options.homedir(), '.local', 'bin', raw));
  } catch {
    // ignore
  }

  for (const candidate of candidates) {
    try {
      if (candidate && options.fsImpl.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }

  return raw;
}

function parseServerUrl(
  raw: string
): { protocol: 'http' | 'https'; host: string; port: number | null; basePath: string } {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    throw new Error('--url is empty');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    parsed = new URL(`http://${trimmed}`);
  }
  const protocol = parsed.protocol === 'https:' ? 'https' : 'http';
  const host = parsed.hostname;
  const hasExplicitPort = Boolean(parsed.port && parsed.port.trim());
  const port = hasExplicitPort ? Number(parsed.port) : null;
  const rawPath = typeof parsed.pathname === 'string' ? parsed.pathname : '';
  const basePath = rawPath && rawPath !== '/' ? rawPath.replace(/\/+$/, '') : '';
  return { protocol, host, port: Number.isFinite(port as number) ? (port as number) : null, basePath };
}

function readConfigApiKey(fsImpl: typeof fs, configPath: string): string | null {
  try {
    if (!configPath || !fsImpl.existsSync(configPath)) {
      return null;
    }
    const txt = fsImpl.readFileSync(configPath, 'utf8');
    const cfg = JSON.parse(txt);
    const direct = cfg?.httpserver?.apikey ?? cfg?.modules?.httpserver?.config?.apikey ?? cfg?.server?.apikey;
    const value = typeof direct === 'string' ? direct.trim() : '';
    return value ? value : null;
  } catch {
    return null;
  }
}

function normalizeConnectHost(host: string): string {
  const value = String(host || '').toLowerCase();
  if (value === '0.0.0.0') {
    return '0.0.0.0';
  }
  if (value === '::' || value === '::1' || value === 'localhost') {
    return '0.0.0.0';
  }
  return host || '0.0.0.0';
}

function toIntegerPort(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return null;
}

function tryReadConfigHostPort(
  fsImpl: typeof fs,
  configPath: string
): { host: string | null; port: number | null } {
  if (!configPath || !fsImpl.existsSync(configPath)) {
    return { host: null, port: null };
  }
  try {
    const configContent = fsImpl.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configContent);
    const port = toIntegerPort(config?.httpserver?.port ?? config?.server?.port ?? config?.port);
    const hostRaw = config?.httpserver?.host ?? config?.server?.host ?? config?.host;
    const host = typeof hostRaw === 'string' && hostRaw.trim() ? hostRaw.trim() : null;
    return { host, port };
  } catch {
    return { host: null, port: null };
  }
}

function resolveServerConnection(
  ctx: LauncherCommandContext,
  fsImpl: typeof fs,
  pathImpl: typeof path,
  options: LauncherCommandOptions
): ResolvedServerConnection {
  let configPath = typeof options.config === 'string' && options.config.trim() ? options.config.trim() : '';
  if (!configPath) {
    configPath = pathImpl.join(ctx.homedir(), '.routecodex', 'config.json');
  }

  let actualProtocol: 'http' | 'https' = 'http';
  let actualPort = toIntegerPort(options.port);
  let actualHost = typeof options.host === 'string' && options.host.trim() ? options.host.trim() : LOCAL_HOSTS.ANY;
  let actualBasePath = '';

  if (typeof options.url === 'string' && options.url.trim()) {
    const parsed = parseServerUrl(options.url);
    actualProtocol = parsed.protocol;
    actualHost = parsed.host || actualHost;
    actualPort = parsed.port ?? actualPort;
    actualBasePath = parsed.basePath;
  }

  if (ctx.isDevPackage) {
    if (!actualPort) {
      const envPort = toIntegerPort(ctx.env.ROUTECODEX_PORT || ctx.env.RCC_PORT);
      actualPort = envPort || ctx.defaultDevPort;
      ctx.logger.info(`Using dev default port ${actualPort} for routecodex ${ctx.isDevPackage ? 'launcher' : 'rcc'} mode`);
    }
  } else {
    if (!actualPort && !(typeof options.url === 'string' && options.url.trim())) {
      const configMaybe = tryReadConfigHostPort(fsImpl, configPath);
      actualPort = configMaybe.port;
      if (configMaybe.host) {
        actualHost = configMaybe.host;
      }
    }
  }

  if (!(typeof options.url === 'string' && options.url.trim()) && !actualPort) {
    throw new Error('Invalid or missing port configuration for RouteCodex server');
  }

  const configuredApiKey =
    (typeof options.apikey === 'string' && options.apikey.trim() ? options.apikey.trim() : null) ??
    (typeof ctx.env.ROUTECODEX_APIKEY === 'string' && ctx.env.ROUTECODEX_APIKEY.trim()
      ? ctx.env.ROUTECODEX_APIKEY.trim()
      : null) ??
    (typeof ctx.env.RCC_APIKEY === 'string' && ctx.env.RCC_APIKEY.trim() ? ctx.env.RCC_APIKEY.trim() : null) ??
    readConfigApiKey(fsImpl, configPath);

  const connectHost = normalizeConnectHost(actualHost);
  const portPart = actualPort ? `:${actualPort}` : '';
  const serverUrl = `${actualProtocol}://${connectHost}${portPart}${actualBasePath}`;

  return {
    configPath,
    protocol: actualProtocol,
    host: actualHost,
    connectHost,
    port: actualPort as number,
    basePath: actualBasePath,
    portPart,
    serverUrl,
    configuredApiKey
  };
}

async function checkServerReady(
  ctx: LauncherCommandContext,
  serverUrl: string,
  apiKey: string | null,
  timeoutMs = 2500
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const headers = apiKey ? { 'x-api-key': apiKey } : undefined;
    const response = await ctx.fetch(`${serverUrl}/ready`, { signal: controller.signal, method: 'GET', headers }).catch(() => null);
    clearTimeout(timeoutId);
    if (!response || !response.ok) {
      return false;
    }
    const body = await response.json().catch(() => null);
    return body?.status === 'ready';
  } catch {
    return false;
  }
}

function rotateLogFile(fsImpl: typeof fs, filePath: string, maxBytes = 8 * 1024 * 1024, maxBackups = 3): void {
  try {
    if (!fsImpl.existsSync(filePath)) {
      return;
    }
    const stat = fsImpl.statSync(filePath);
    if (!stat.isFile() || stat.size < maxBytes) {
      return;
    }

    for (let index = maxBackups - 1; index >= 1; index--) {
      const from = `${filePath}.${index}`;
      const to = `${filePath}.${index + 1}`;
      try {
        if (fsImpl.existsSync(from)) {
          if (fsImpl.existsSync(to)) {
            fsImpl.unlinkSync(to);
          }
          fsImpl.renameSync(from, to);
        }
      } catch {
        // ignore
      }
    }

    const firstBackup = `${filePath}.1`;
    if (fsImpl.existsSync(firstBackup)) {
      try {
        fsImpl.unlinkSync(firstBackup);
      } catch {
        // ignore
      }
    }
    fsImpl.renameSync(filePath, firstBackup);
  } catch {
    // ignore rotation failures
  }
}

function ensureServerLogPath(ctx: LauncherCommandContext, fsImpl: typeof fs, pathImpl: typeof path, port: number): string {
  const logsDir = pathImpl.join(ctx.homedir(), '.routecodex', 'logs');
  fsImpl.mkdirSync(logsDir, { recursive: true });
  const logPath = pathImpl.join(logsDir, `server-${port}.log`);
  rotateLogFile(fsImpl, logPath);
  return logPath;
}

async function ensureServerReady(
  ctx: LauncherCommandContext,
  fsImpl: typeof fs,
  pathImpl: typeof path,
  spinner: Spinner,
  options: LauncherCommandOptions,
  resolved: ResolvedServerConnection
): Promise<{ started: boolean; logPath?: string }> {
  const alreadyReady = await checkServerReady(ctx, resolved.serverUrl, resolved.configuredApiKey);
  if (alreadyReady) {
    return { started: false };
  }

  const hasExplicitUrl = typeof options.url === 'string' && options.url.trim().length > 0;
  if (hasExplicitUrl) {
    throw new Error('RouteCodex server is not reachable with --url; auto-start is disabled for explicit URLs');
  }

  spinner.info('RouteCodex server is not running, starting it in background...');
  const logPath = ensureServerLogPath(ctx, fsImpl, pathImpl, resolved.port);

  const logFd = fsImpl.openSync(logPath, 'a');
  const env = {
    ...ctx.env,
    ROUTECODEX_CONFIG: resolved.configPath,
    ROUTECODEX_CONFIG_PATH: resolved.configPath,
    ROUTECODEX_PORT: String(resolved.port),
    RCC_PORT: String(resolved.port)
  } as NodeJS.ProcessEnv;

  try {
    const serverProcess = ctx.spawn(ctx.nodeBin, [ctx.resolveServerEntryPath(), ctx.getModulesConfigPath()], {
      stdio: ['ignore', logFd, logFd],
      env,
      detached: true
    });
    try {
      serverProcess.unref?.();
    } catch {
      // ignore
    }
  } finally {
    try {
      fsImpl.closeSync(logFd);
    } catch {
      // ignore
    }
  }

  spinner.text = 'Waiting for RouteCodex server to become ready...';
  for (let attempt = 0; attempt < 45; attempt++) {
    await ctx.sleep(1000);
    const ready = await checkServerReady(ctx, resolved.serverUrl, resolved.configuredApiKey, 1500);
    if (ready) {
      return { started: true, logPath };
    }
  }

  throw new Error(`RouteCodex server did not become ready in time. Check logs: ${logPath}`);
}

function resolveWorkingDirectory(ctx: LauncherCommandContext, fsImpl: typeof fs, pathImpl: typeof path, requested?: string): string {
  const getCwd = ctx.cwd ?? (() => process.cwd());
  try {
    const candidate = requested ? String(requested) : getCwd();
    const resolved = pathImpl.resolve(candidate);
    if (fsImpl.existsSync(resolved)) {
      return resolved;
    }
  } catch {
    return getCwd();
  }
  return getCwd();
}

function collectPassThroughArgs(args: {
  rawArgv: string[];
  commandName: string;
  knownOptions: Set<string>;
  requiredValueOptions: Set<string>;
  extraArgsFromCommander: string[];
}): string[] {
  const { rawArgv, commandName, knownOptions, requiredValueOptions, extraArgsFromCommander } = args;

  const indexCommand = rawArgv.findIndex((token) => token === commandName);
  const afterCommand = indexCommand >= 0 ? rawArgv.slice(indexCommand + 1) : [];
  const separatorIndex = afterCommand.indexOf('--');
  const tail = separatorIndex >= 0 ? afterCommand.slice(separatorIndex + 1) : afterCommand;

  const passThrough: string[] = [];
  for (let index = 0; index < tail.length; index++) {
    const token = tail[index];
    if (knownOptions.has(token)) {
      if (requiredValueOptions.has(token)) {
        index += 1;
      }
      continue;
    }
    if (token.startsWith('--')) {
      const equalIndex = token.indexOf('=');
      if (equalIndex > 2) {
        const optionName = token.slice(0, equalIndex);
        if (knownOptions.has(optionName)) {
          continue;
        }
      }
    }
    passThrough.push(token);
  }

  const merged: string[] = [];
  const seen = new Set<string>();
  const appendUnique = (values: string[]) => {
    for (const value of values) {
      if (!seen.has(value)) {
        seen.add(value);
        merged.push(value);
      }
    }
  };

  appendUnique(extraArgsFromCommander);
  appendUnique(passThrough);
  return merged;
}

function normalizeOpenAiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/v1')) {
    return trimmed;
  }
  return `${trimmed}/v1`;
}

export function createLauncherCommand(program: Command, ctx: LauncherCommandContext, spec: LauncherSpec): void {
  const fsImpl = ctx.fsImpl ?? fs;
  const pathImpl = ctx.pathImpl ?? path;

  const command = program
    .command(spec.commandName)
    .description(spec.description)
    .option('-p, --port <port>', 'RouteCodex server port (overrides config file)')
    .option('-h, --host <host>', 'RouteCodex server host', LOCAL_HOSTS.ANY)
    .option('--url <url>', 'RouteCodex base URL (overrides host/port), e.g. https://proxy.example.com')
    .option('-c, --config <config>', 'RouteCodex configuration file path')
    .option('--apikey <apikey>', 'RouteCodex server apikey (defaults to httpserver.apikey in config when present)')
    .option('--cwd <dir>', `Working directory for ${spec.displayName} (defaults to current shell cwd)`)
    .option('--ensure-server', 'Ensure RouteCodex server is running before launching')
    .option(spec.binaryOptionFlags, spec.binaryOptionDescription, spec.binaryDefault)
    .argument('[extraArgs...]', `Additional args to pass through to ${spec.displayName}`)
    .allowUnknownOption(true)
    .allowExcessArguments(true);

  if (spec.withModelOption) {
    command.option('--model <model>', `Model to use with ${spec.displayName}`);
  }
  if (spec.withProfileOption) {
    command.option('--profile <profile>', `${spec.displayName} profile to use`);
  }

  command.action(async (extraArgs: string[] = [], options: LauncherCommandOptions) => {
    const spinner = await ctx.createSpinner(`Preparing ${spec.displayName} with RouteCodex...`);

    try {
      const resolved = resolveServerConnection(ctx, fsImpl, pathImpl, options);
      const ensureResult = await ensureServerReady(ctx, fsImpl, pathImpl, spinner, options, resolved);

      spinner.text = `Launching ${spec.displayName}...`;

      const baseUrl = `${resolved.protocol}://${resolved.connectHost}${resolved.portPart}${resolved.basePath}`;
      const currentCwd = resolveWorkingDirectory(ctx, fsImpl, pathImpl, options.cwd);
      const toolEnv = spec.buildEnv({
        env: {
          ...ctx.env,
          PWD: currentCwd,
          RCC_WORKDIR: currentCwd,
          ROUTECODEX_WORKDIR: currentCwd,
          OPENAI_BASE_URL: normalizeOpenAiBaseUrl(baseUrl),
          OPENAI_API_BASE: normalizeOpenAiBaseUrl(baseUrl),
          OPENAI_API_BASE_URL: normalizeOpenAiBaseUrl(baseUrl),
          OPENAI_API_KEY: resolved.configuredApiKey || 'rcc-proxy-key'
        } as NodeJS.ProcessEnv,
        baseUrl,
        configuredApiKey: resolved.configuredApiKey,
        cwd: currentCwd
      });

      const toolArgs: string[] = spec.buildArgs(options);

      const knownOptions = new Set<string>([
        '-p',
        '--port',
        '-h',
        '--host',
        '--url',
        '-c',
        '--config',
        '--apikey',
        '--cwd',
        '--ensure-server',
        ...spec.extraKnownOptions
      ]);
      const requiredValueOptions = new Set<string>([
        '-p',
        '--port',
        '-h',
        '--host',
        '--url',
        '-c',
        '--config',
        '--apikey',
        '--cwd',
        ...spec.extraKnownOptions
      ]);

      const passThroughArgs = collectPassThroughArgs({
        rawArgv: Array.isArray(ctx.rawArgv) ? ctx.rawArgv : [],
        commandName: spec.commandName,
        knownOptions,
        requiredValueOptions,
        extraArgsFromCommander: Array.isArray(extraArgs) ? extraArgs : []
      });

      if (passThroughArgs.length) {
        toolArgs.push(...passThroughArgs);
      }

      const binaryCandidate = (() => {
        const fromOption = String(options[spec.binaryOptionName] ?? '').trim();
        if (fromOption) {
          return fromOption;
        }
        if (spec.binaryEnvKey) {
          const fromEnv = String(ctx.env[spec.binaryEnvKey] || '').trim();
          if (fromEnv) {
            return fromEnv;
          }
        }
        return spec.binaryDefault;
      })();

      const resolvedBinary = resolveBinary({
        fsImpl,
        pathImpl,
        homedir: ctx.homedir,
        command: binaryCandidate
      });

      const shouldUseShell =
        ctx.isWindows &&
        !pathImpl.extname(resolvedBinary) &&
        !resolvedBinary.includes('/') &&
        !resolvedBinary.includes('\\');

      const toolProcess = ctx.spawn(resolvedBinary, toolArgs, {
        stdio: 'inherit',
        env: toolEnv,
        cwd: currentCwd,
        shell: shouldUseShell
      });

      spinner.succeed(`${spec.displayName} launched with RouteCodex proxy`);
      ctx.logger.info(`Using RouteCodex server at: ${baseUrl}`);
      ctx.logger.info(`${spec.displayName} binary: ${resolvedBinary}`);
      if (ensureResult.started && ensureResult.logPath) {
        ctx.logger.info(`RouteCodex auto-start logs: ${ensureResult.logPath}`);
      }
      ctx.logger.info(`Working directory for ${spec.displayName}: ${currentCwd}`);
      ctx.logger.info(`Press Ctrl+C to exit ${spec.displayName}`);

      const shutdown = async (signal: NodeJS.Signals) => {
        try {
          toolProcess.kill(signal);
        } catch {
          // ignore
        }
        ctx.exit(0);
      };

      const onSignal = ctx.onSignal ?? ((signal: NodeJS.Signals, cb: () => void) => process.on(signal, cb));
      onSignal('SIGINT', () => {
        void shutdown('SIGINT');
      });
      onSignal('SIGTERM', () => {
        void shutdown('SIGTERM');
      });

      toolProcess.on('error', (error) => {
        try {
          ctx.logger.error(
            `Failed to launch ${spec.displayName} (${resolvedBinary}): ${error instanceof Error ? error.message : String(error)}`
          );
        } catch {
          // ignore
        }
        ctx.exit(1);
      });

      toolProcess.on('exit', (code, signal) => {
        if (signal) {
          ctx.exit(0);
          return;
        }
        ctx.exit(code ?? 0);
      });

      await ctx.waitForever();
    } catch (error) {
      spinner.fail(`Failed to launch ${spec.displayName}`);
      ctx.logger.error(error instanceof Error ? error.message : String(error));
      ctx.exit(1);
    }
  });
}

export { normalizeOpenAiBaseUrl };
