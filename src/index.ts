/**
 * RouteCodex Main Entry Point
 * Multi-provider OpenAI proxy server with configuration management
 */

import { LOCAL_HOSTS, HTTP_PROTOCOLS, API_PATHS } from './constants/index.js';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { homedir } from 'os';
import net from 'net';
import { spawn, spawnSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { buildInfo } from './build-info.js';
import { isDirectExecution } from './utils/is-direct-execution.js';
import { parseNetstatListeningPids } from './utils/windows-netstat.js';
import { reportRouteError } from './error-handling/route-error-hub.js';
import { resolveRouteCodexConfigPath } from './config/config-paths.js';
import { loadRouteCodexConfig } from './config/routecodex-config-loader.js';
import type { RouteCodexHttpServer } from './server/runtime/http-server.js';

type NodeGlobalWithRequire = typeof globalThis & { require?: NodeJS.Require };
type UnknownRecord = Record<string, unknown>;

// Polyfill CommonJS require for ESM runtime to satisfy dependencies that call require()
let moduleRequire: NodeJS.Require | null = null;
try {
  moduleRequire = createRequire(import.meta.url);
  const globalScope = globalThis as NodeGlobalWithRequire;
  if (!globalScope.require) {
    globalScope.require = moduleRequire;
  }
} catch {
  moduleRequire = null;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : undefined;
}

function getNestedRecord(source: UnknownRecord, path: string[]): UnknownRecord | undefined {
  let current: unknown = source;
  for (const key of path) {
    const record = asRecord(current);
    if (!record) {
      return undefined;
    }
    current = record[key];
  }
  return asRecord(current);
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

async function reportCliError(
  code: string,
  message: string,
  error: unknown,
  severity: 'low' | 'medium' | 'high' | 'critical' = 'medium',
  details?: Record<string, unknown>
): Promise<void> {
  try {
    await reportRouteError({
      code,
      message,
      source: 'cli.routecodex',
      scope: 'cli',
      severity,
      details,
      originalError: error
    });
  } catch {
    /* ignore hub failures */
  }
}

type ShutdownReason =
  | { kind: 'signal'; signal: string }
  | { kind: 'uncaughtException'; message: string }
  | { kind: 'startupError'; message: string }
  | { kind: 'stopError'; message: string }
  | { kind: 'unknown' };

let lastShutdownReason: ShutdownReason = { kind: 'unknown' };
let restartInProgress = false;

function recordShutdownReason(reason: ShutdownReason): void {
  if (lastShutdownReason.kind === 'unknown') {
    lastShutdownReason = reason;
  }
}

process.on('exit', (code) => {
  const reason = lastShutdownReason;
  const payload: Record<string, unknown> = {
    kind: reason.kind,
    exitCode: code
  };
  if (reason.kind === 'signal') {
    payload.signal = reason.signal;
  } else if (reason.kind === 'uncaughtException' || reason.kind === 'startupError' || reason.kind === 'stopError') {
    payload.message = reason.message;
  }
  // Single-line JSON for easy grep in logs
  console.log('[routecodex:shutdown]', JSON.stringify(payload));
});

function readString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return undefined;
}

function readRecordNumber(record: UnknownRecord | undefined, key: string): number | undefined {
  if (!record) {
    return undefined;
  }
  return readNumber(record[key]);
}

function readRecordString(record: UnknownRecord | undefined, key: string): string | undefined {
  if (!record) {
    return undefined;
  }
  return readString(record[key]);
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
    if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
      return false;
    }
  }
  return undefined;
}

function readRecordBoolean(record: UnknownRecord | undefined, key: string): boolean | undefined {
  if (!record) {
    return undefined;
  }
  return readBoolean(record[key]);
}

if (!process.env.ROUTECODEX_VERSION) {
  let resolvedVersion = 'dev';
  try {
    const pkg = moduleRequire ? (moduleRequire('../package.json') as { version?: unknown }) : undefined;
    const maybeVersion = pkg?.version;
    if (typeof maybeVersion === 'string') {
      resolvedVersion = maybeVersion;
    }
  } catch {
    resolvedVersion = 'dev';
  }
  process.env.ROUTECODEX_VERSION = resolvedVersion;
}

/**
 * Default modules configuration path
 */
function getDefaultModulesConfigPath(): string {
  const execDir = path.dirname(process.argv[1] || process.execPath);
  let scriptDir: string | null = null;
  try {
    const currentFile = fileURLToPath(import.meta.url);
    scriptDir = path.dirname(currentFile);
  } catch {
    scriptDir = null;
  }

  const possiblePaths = [
    process.env.ROUTECODEX_MODULES_CONFIG,
    scriptDir ? path.join(scriptDir, 'config', 'modules.json') : null,
    scriptDir ? path.join(scriptDir, '..', 'config', 'modules.json') : null,
    path.join(execDir, 'config', 'modules.json'),
    path.join(process.cwd(), 'config', 'modules.json'),
    path.join(homedir(), '.routecodex', 'config', 'modules.json')
  ];

  for (const configPath of possiblePaths) {
    if (configPath && fsSync.existsSync(configPath)) {
      const stats = fsSync.statSync(configPath);
      if (stats.isFile()) {
        return configPath;
      }
    }
  }

  return path.join(process.cwd(), 'config', 'modules.json');
}

function resolveAppBaseDir(): string {
  const env = String(process.env.ROUTECODEX_BASEDIR || process.env.RCC_BASEDIR || '').trim();
  if (env) {
    return path.resolve(env);
  }
  try {
    const __filename = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(__filename), '..');
  } catch {
    return process.cwd();
  }
}

/**
 * Main application class
 */
class RouteCodexApp {
  private httpServer: RouteCodexHttpServer | null = null;
  private modulesConfigPath: string;
  private _isRunning: boolean = false;
  private configPath: string = path.join(process.cwd(), 'config', 'config.json');
  private readonly baseDir: string;

  constructor(modulesConfigPath?: string) {
    this.modulesConfigPath = modulesConfigPath || getDefaultModulesConfigPath();

    if (!fsSync.existsSync(this.modulesConfigPath)) {
      throw new Error(`Modules configuration file not found: ${this.modulesConfigPath}`);
    }

    const modulesStats = fsSync.statSync(this.modulesConfigPath);
    if (!modulesStats.isFile()) {
      throw new Error(`Modules configuration path must be a file: ${this.modulesConfigPath}`);
    }

    this.baseDir = resolveAppBaseDir();
  }

  /**
   * Start the RouteCodex server
   */
  async start(): Promise<void> {
    try {
      console.log('🚀 Starting RouteCodex server...');
      console.log(`📁 Modules configuration file: ${this.modulesConfigPath}`);

      // 简化日志已移除运行时自动应用，保留 CLI 配置能力

      // 1. 初始化配置管理器
      const port = await this.detectServerPort(this.modulesConfigPath);

      // config path reference will be set after resolving user config below

      const userConfigPath = this.resolveUserConfigPath();
      this.configPath = userConfigPath;

      const { userConfig, configPath: resolvedConfigPath, providerProfiles } = await loadRouteCodexConfig(userConfigPath);
      this.configPath = resolvedConfigPath;
      const userConfigRecord = asRecord(userConfig) ?? {};

      if (!process.env.ROUTECODEX_STAGE_LOG || process.env.ROUTECODEX_STAGE_LOG.trim() === '') {
        if (buildInfo.mode === 'dev') {
          process.env.ROUTECODEX_STAGE_LOG = '1';
        }
      }

      console.log(`ℹ RouteCodex version: ${buildInfo.version} (${buildInfo.mode} build)`);

      // Persist Antigravity thoughtSignature across restarts (default ON).
      // This is required to avoid cold-start tool-call failures after server restarts.
      try {
        const { warmupAntigravitySessionSignatureModule, configureAntigravitySessionSignaturePersistence } =
          await import('./modules/llmswitch/bridge.js');
        const stateDir = path.join(homedir(), '.routecodex', 'state');
        try {
          fsSync.mkdirSync(stateDir, { recursive: true });
        } catch {
          // ignore
        }
        await warmupAntigravitySessionSignatureModule();
        configureAntigravitySessionSignaturePersistence({ stateDir });
      } catch {
        // ignore best-effort persistence wiring failures
      }

      // 3. 初始化服务器（仅使用 V2 动态流水线架构）
      // Resolve host/port from merged config for V2 constructor
      let bindHost = readRecordString(getNestedRecord(userConfigRecord, ['httpserver']), 'host')
        ?? readRecordString(getNestedRecord(userConfigRecord, ['modules', 'httpserver', 'config']), 'host')
        ?? readRecordString(getNestedRecord(userConfigRecord, ['server']), 'host')
        ?? '0.0.0.0';
      let bindPort = port;
      let bindApiKey = readRecordString(getNestedRecord(userConfigRecord, ['httpserver']), 'apikey')
        ?? readRecordString(getNestedRecord(userConfigRecord, ['modules', 'httpserver', 'config']), 'apikey');
      let quotaRoutingEnabled: boolean | undefined;
      try {
        const envPort = Number(process.env.ROUTECODEX_PORT || process.env.RCC_PORT || NaN);
        const httpConfig =
          getNestedRecord(userConfigRecord, ['httpserver']) ??
          getNestedRecord(userConfigRecord, ['modules', 'httpserver', 'config']);
        const serverConfig = getNestedRecord(userConfigRecord, ['server']);
        const portRaw = readRecordNumber(httpConfig, 'port') ?? readRecordNumber(serverConfig, 'port');
        quotaRoutingEnabled =
          readRecordBoolean(httpConfig, 'quotaRoutingEnabled') ??
          readRecordBoolean(httpConfig, 'quotaRouting');
        bindApiKey = readRecordString(httpConfig, 'apikey') ?? bindApiKey;
        if (Number.isFinite(envPort) && envPort > 0) {
          bindPort = envPort;
        } else if (typeof portRaw === 'number') {
          bindPort = portRaw;
        }
        if (!Number.isFinite(bindPort)) {
          bindPort = port;
        }
      } catch {
        bindHost = '0.0.0.0';
        bindPort = port;
        bindApiKey = undefined;
      }
      const { RouteCodexHttpServer } = await import('./server/runtime/http-server.js');
      // V2 hooks 开关：默认开启；可通过 ROUTECODEX_V2_HOOKS=0/false/no 关闭
      const hooksEnv = String(process.env.ROUTECODEX_V2_HOOKS || process.env.RCC_V2_HOOKS || '').trim().toLowerCase();
      const hooksOff = hooksEnv === '0' || hooksEnv === 'false' || hooksEnv === 'no';
      const hooksOn = !hooksOff;
      this.httpServer = new RouteCodexHttpServer({
        configPath: this.configPath,
        server: {
          host: bindHost,
          port: bindPort,
          apikey: bindApiKey,
          ...(typeof quotaRoutingEnabled === 'boolean' ? { quotaRoutingEnabled } : {})
        },
        logging: { level: 'debug', enableConsole: true },
        providers: {},
        v2Config: { enableHooks: hooksOn }
      });

      // 4.1 校验 virtualrouter 配置
      const virtualRouter = getNestedRecord(userConfigRecord, ['virtualrouter']);
      const routing = getNestedRecord(virtualRouter ?? userConfigRecord, ['routing']);
      const routingRecord: UnknownRecord = routing ?? {};
      if (Object.keys(routingRecord).length === 0) {
        throw new Error(`user config 缺少 virtualrouter.routing，无法启动`);
      }
      const routeEntries = Object.entries(routingRecord);
      const targetCount = routeEntries.reduce((acc, [, value]) => {
        if (Array.isArray(value)) {
          return acc + value.length;
        }
        return acc;
      }, 0);
      console.log(`🧱 Virtual router routes: ${routeEntries.length}`);
      console.log(`🔑 Provider targets: ${targetCount}`);

      const normalizePortalHost = (value: string): string => {
        const normalized = value.trim().toLowerCase();
        if (!normalized || normalized === '0.0.0.0' || normalized === '::' || normalized === '::1' || normalized === 'localhost') {
          return LOCAL_HOSTS.IPV4;
        }
        return value;
      };
      process.env.ROUTECODEX_PORT = String(bindPort);
      process.env.RCC_PORT = String(bindPort);
      process.env.ROUTECODEX_HTTP_HOST = bindHost;
      process.env.ROUTECODEX_HTTP_PORT = String(bindPort);
      if (!process.env.ROUTECODEX_TOKEN_PORTAL_BASE) {
        const portalHost = normalizePortalHost(bindHost);
        const portalBaseUrl = `${HTTP_PROTOCOLS.HTTP}${portalHost}:${bindPort}/token-auth/demo`;
        process.env.ROUTECODEX_TOKEN_PORTAL_BASE = portalBaseUrl;
      }

      // 5. 启动 HTTP Server 监听端口（若端口被占用，先尝试优雅释放）
      //    必须在 provider OAuth 初始化之前完成监听，否则本地 token portal 无法访问。
      // Ensure the port is available before continuing. Attempt graceful shutdown first.
      await ensurePortAvailable(port, { attemptGraceful: true });
      try {
        await this.httpServer.start();
      } catch (err) {
        const nodeError = err as NodeJS.ErrnoException | undefined;
        const code = nodeError?.code ?? nodeError?.errno ?? '';
        const msg = err instanceof Error ? err.message : String(err ?? '');
        if (String(code) === 'EADDRINUSE' || /address already in use/i.test(msg)) {
          console.warn(`⚠ Port ${port} in use; attempting to free and retry...`);
          try {
            await ensurePortAvailable(port, { attemptGraceful: true });
            await this.httpServer.start();
          } catch (e) {
            throw err;
          }
        } else {
          throw err;
        }
      }

      // 6. 在服务已监听的前提下初始化运行时（包括 Hub Pipeline 和 Provider OAuth）
      await this.httpServer.initializeWithUserConfig(userConfig, { providerProfiles });

      this._isRunning = true;

      // 7. 记录当前运行模式（仅 V2）
      console.log(`${buildInfo.mode === 'dev' ? '🧪 dev' : '🚢 release'} mode · 🔵 V2 dynamic pipeline active`);

      // 7. 获取服务器状态（使用 HTTP 服务器解析后的最终绑定地址与端口）
      // 优先读取服务器自身解析结果，避免日志误导（例如 host 放在不同层级或为 0.0.0.0 时）
      let serverConfig: { host: string; port: number } = { host: LOCAL_HOSTS.IPV4, port };
      try {
        const resolved = this.httpServer.getServerConfig();
        if (resolved && resolved.host && resolved.port) {
          serverConfig = resolved;
        }
      } catch {
        /* ignore; fall back to defaults */
      }

      console.log(`✅ RouteCodex server started successfully!`);
      console.log(`🌐 Server URL: http://${serverConfig.host}:${serverConfig.port}`);
      console.log(`🗂️ User config: ${this.configPath}`);
      console.log(`📊 Health check: http://${serverConfig.host}:${serverConfig.port}/health`);
      console.log(`🔧 Configuration: http://${serverConfig.host}:${serverConfig.port}/config`);
      console.log(`📖 OpenAI API: http://${serverConfig.host}:${serverConfig.port}/v1/openai`);
      // Anthropic 入口保持 V2 之前的一致形态：/v1/messages
      // 不在日志中引入新的 /v1/anthropic 前缀，避免与实际路由不符
      console.log(`🔬 Anthropic API: http://${serverConfig.host}:${serverConfig.port}/v1/messages`);

      // samples dry-run removed

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? '');
      recordShutdownReason({ kind: 'startupError', message });
      await reportCliError('SERVER_START_FAILED', 'Failed to start RouteCodex server', error, 'critical');
      console.error('❌ Failed to start RouteCodex server:', error);
      process.exit(1);
    }
  }

  /**
   * Stop the RouteCodex server
   */
  async stop(): Promise<void> {
    try {
      recordShutdownReason({ kind: 'stopError', message: 'stop() invoked' });
      if (this._isRunning) {
        console.log('🛑 Stopping RouteCodex server...');

        if (this.httpServer) {
          await this.httpServer.stop();
        }

        try {
          const { flushAntigravitySessionSignaturePersistenceSync } = await import('./modules/llmswitch/bridge.js');
          flushAntigravitySessionSignaturePersistenceSync();
        } catch {
          // ignore
        }

        this._isRunning = false;
        console.log('✅ RouteCodex server stopped successfully');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? '');
      recordShutdownReason({ kind: 'stopError', message });
      await reportCliError('SERVER_STOP_FAILED', 'Failed to stop RouteCodex server', error, 'high');
      console.error('❌ Failed to stop RouteCodex server:', error);
      process.exit(1);
    }
  }

  /**
   * Get server status
   */
  getStatus(): unknown {
    if (this.httpServer) {
      return this.httpServer.getStatus();
    }
    return {
      status: 'stopped',
      message: 'Server not initialized'
    };
  }

  /**
   * Detect server port from user configuration
   */
  private resolveUserConfigPath(): string {
    const envPaths = [
      process.env.RCC4_CONFIG_PATH,
      process.env.ROUTECODEX_CONFIG,
      process.env.ROUTECODEX_CONFIG_PATH
    ].filter(Boolean) as string[];
    for (const candidate of envPaths) {
      try {
        if (candidate && fsSync.existsSync(candidate) && fsSync.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // ignore and fall back to the next candidate
      }
    }
    return resolveRouteCodexConfigPath();
  }

  /**
   * Detect server port from user configuration
   */
  private async detectServerPort(_modulesConfigPath: string): Promise<number> {
    try {
      // Highest priority: explicit environment override
      const envPort = Number(process.env.ROUTECODEX_PORT || process.env.RCC_PORT || NaN);
      if (!Number.isNaN(envPort) && envPort > 0) {
        console.log(`🔧 Using port ${envPort} from environment (ROUTECODEX_PORT/RCC_PORT)`);
        return envPort;
      }

      // Dev 模式：无论配置是否存在，若未显式指定端口，则使用固定默认 5555
      if (buildInfo.mode === 'dev') {
        console.log('🔧 Using dev default port 5555');
        return 5555;
      }
      // 首先检查ROUTECODEX_CONFIG_PATH环境变量（当前使用的）
      if (process.env.ROUTECODEX_CONFIG_PATH) {
        const configPath = process.env.ROUTECODEX_CONFIG_PATH;
        if (fsSync.existsSync(configPath)) {
          const stats = fsSync.statSync(configPath);
          if (!stats.isFile()) {
            throw new Error(`ROUTECODEX_CONFIG_PATH must point to a file: ${configPath}`);
          }

          const raw = await fs.readFile(configPath, 'utf-8');
          const json = JSON.parse(raw);
          const port = (json && typeof json.httpserver === 'object' && typeof json.httpserver.port === 'number')
            ? json.httpserver.port
            : json?.port;
          if (typeof port === 'number' && port > 0) {
            console.log(`🔧 Using port ${port} from ROUTECODEX_CONFIG_PATH: ${configPath}`);
            return port;
          }
        }
      }

      // 然后检查ROUTECODEX_CONFIG环境变量
      if (process.env.ROUTECODEX_CONFIG) {
        const configPath = process.env.ROUTECODEX_CONFIG;
        if (fsSync.existsSync(configPath)) {
          const stats = fsSync.statSync(configPath);
          if (!stats.isFile()) {
            throw new Error(`ROUTECODEX_CONFIG must point to a file: ${configPath}`);
          }

          const raw = await fs.readFile(configPath, 'utf-8');
          const json = JSON.parse(raw);
          const port = (json && typeof json.httpserver === 'object' && typeof json.httpserver.port === 'number')
            ? json.httpserver.port
            : json?.port;
          if (typeof port === 'number' && port > 0) {
            console.log(`🔧 Using port ${port} from ROUTECODEX_CONFIG: ${configPath}`);
            return port;
          }
        }
      }

      // 使用共享解析逻辑解析用户配置路径（支持 ~/.routecodex/config 目录）
      try {
        const sharedPath = resolveRouteCodexConfigPath();
        if (sharedPath && fsSync.existsSync(sharedPath)) {
          const raw = await fs.readFile(sharedPath, 'utf-8');
          const json = JSON.parse(raw);
          const port = (json && typeof json.httpserver === 'object' && typeof json.httpserver.port === 'number')
            ? json.httpserver.port
            : json?.port;
          if (typeof port === 'number' && port > 0) {
            console.log(`🔧 Using port ${port} from resolved config: ${sharedPath}`);
            return port;
          }
        }
      } catch (e) {
        // ignore and fall back
      }

      // 最后检查默认配置文件
      const defaultConfigPath = path.join(homedir(), '.routecodex', 'config.json');
      if (fsSync.existsSync(defaultConfigPath)) {
        const defaultStats = fsSync.statSync(defaultConfigPath);
        if (!defaultStats.isFile()) {
          throw new Error(`Default configuration path must be a file: ${defaultConfigPath}`);
        }

        const raw = await fs.readFile(defaultConfigPath, 'utf-8');
        const json = JSON.parse(raw);
        const port = (json && typeof json.httpserver === 'object' && typeof json.httpserver.port === 'number')
          ? json.httpserver.port
          : json?.port;
        if (typeof port === 'number' && port > 0) {
          console.log(`🔧 Using port ${port} from default config: ${defaultConfigPath}`);
          return port;
        }
      }
    } catch (error) {
      console.error('❌ Error detecting server port:', error);
    }
    // Release 模式：必须从配置获取端口或通过环境传入；走到这里表示未命中，Fail Fast
    throw new Error('HTTP server port not found. In release mode, set httpserver.port in your user configuration file.');
  }
}

/**
 * Ensure a TCP port is available by attempting graceful shutdown of any process holding it,
 * then force-killing as a last resort. Mirrors previous startup behavior.
 */
async function ensurePortAvailable(port: number, opts: { attemptGraceful?: boolean } = {}): Promise<void> {
  // Quick probe first; if we can bind, it's free
  try {
    const probe = net.createServer();
    const canListen = await new Promise<boolean>(resolve => {
      probe.once('error', () => resolve(false));
      probe.listen({ host: '0.0.0.0', port }, () => resolve(true));
    });
    if (canListen) {
      await new Promise(r => probe.close(() => r(null)));
      return; // free
    }
  } catch {
    // fallthrough
  }

  // Try graceful HTTP shutdown if a compatible server is there
  if (opts.attemptGraceful) {
    const graceful = await attemptHttpShutdown(port);
    if (graceful) {
      // Give the server a moment to exit cleanly
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 300));
        if (await canBind(port)) {
          return;
        }
      }
    }
  }

  // Fall back to SIGTERM/SIGKILL processes listening on the port (avoid self-kill by probing first)
  const pids = await listPidsOnPort(port);
  if (!pids.length) {
    return;
  }
  for (const pid of pids) {
    killPidBestEffort(Number(pid), { force: false });
  }
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 300));
    if (await canBind(port)) {
      return;
    }
  }
  const remain = await listPidsOnPort(port);
  for (const pid of remain) {
    killPidBestEffort(Number(pid), { force: true });
  }
  await new Promise(r => setTimeout(r, 500));
}

function killPidBestEffort(pid: number, opts: { force: boolean }): void {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }
  if (process.platform === 'win32') {
    const args = ['/PID', String(pid), '/T'];
    if (opts.force) {
      args.push('/F');
    }
    try {
      spawnSync('taskkill', args, { stdio: 'ignore', encoding: 'utf8' });
    } catch {
      // best-effort
    }
    return;
  }
  try {
    process.kill(pid, opts.force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    // best-effort
  }
}

async function canBind(port: number): Promise<boolean> {
  return await new Promise<boolean>(resolve => {
    try {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen({ host: '0.0.0.0', port }, () => {
        s.close(() => resolve(true));
      });
    } catch { resolve(false); }
  });
}

async function listPidsOnPort(port: number): Promise<string[]> {
  if (process.platform === 'win32') {
    try {
      const result = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
      if (result.error) {
        return [];
      }
      return parseNetstatListeningPids(result.stdout || '', port).map(String);
    } catch {
      return [];
    }
  }
  return await new Promise<string[]>(resolve => {
    try {
      const ps = spawn('lsof', ['-ti', `:${port}`]);
      let out = '';
      ps.stdout.on('data', d => (out += String(d)));
      ps.on('close', () => resolve(out.split(/\s+/).map(s => s.trim()).filter(Boolean)));
      ps.on('error', () => resolve([]));
    } catch { resolve([]); }
  });
}

async function attemptHttpShutdown(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      try { controller.abort(); } catch { /* ignore */ }
    }, 1000);
    const res = await fetch(`${HTTP_PROTOCOLS.HTTP}${LOCAL_HOSTS.IPV4}:${port}${API_PATHS.SHUTDOWN}`, {
      method: 'POST',
      signal: controller.signal
    }).catch(() => null);
    clearTimeout(timeout);
    return !!(res && res.ok);
  } catch { return false; }
}

/**
 * Handle graceful shutdown
 */
async function gracefulShutdown(app: RouteCodexApp): Promise<void> {
  const reason = lastShutdownReason;
  const reasonLabel =
    reason.kind === 'signal'
      ? `signal=${reason.signal}`
      : reason.kind === 'uncaughtException'
        ? 'reason=uncaughtException'
        : reason.kind === 'startupError'
          ? 'reason=startupError'
          : reason.kind === 'stopError'
            ? 'reason=stopError'
            : 'reason=unknown';
  console.log(`\n🛑 Stopping RouteCodex server gracefully... (${reasonLabel})`);
  try {
    await app.stop();
    process.exit(0);
  } catch (error) {
    await reportCliError('GRACEFUL_SHUTDOWN_FAILED', 'Error during graceful shutdown', error, 'high');
    console.error('❌ Error during graceful shutdown:', error);
    process.exit(1);
  }
}

function resolveRestartEntryScript(argv: string[]): string | null {
  if (!Array.isArray(argv) || argv.length === 0) {
    return null;
  }
  const raw = typeof argv[0] === 'string' ? argv[0].trim() : '';
  if (!raw) {
    return null;
  }
  if (raw.startsWith('-')) {
    return null;
  }
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

function parseRestartEntryWaitMs(): number {
  const raw = process.env.ROUTECODEX_RESTART_ENTRY_WAIT_MS;
  const parsed = typeof raw === 'string' ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 12_000;
  }
  return Math.floor(parsed);
}

async function ensureRestartEntryReady(argv: string[]): Promise<{ ready: boolean; entryPath?: string; waitedMs: number }> {
  const entryPath = resolveRestartEntryScript(argv);
  if (!entryPath) {
    return { ready: true, waitedMs: 0 };
  }

  const maxWaitMs = parseRestartEntryWaitMs();
  const stepMs = 200;
  const startedAt = Date.now();

  while (true) {
    if (fsSync.existsSync(entryPath)) {
      return { ready: true, entryPath, waitedMs: Date.now() - startedAt };
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed >= maxWaitMs) {
      return { ready: false, entryPath, waitedMs: elapsed };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(stepMs, Math.max(1, maxWaitMs - elapsed))));
  }
}

async function restartSelf(app: RouteCodexApp, signal: NodeJS.Signals): Promise<void> {
  if (restartInProgress) {
    return;
  }
  restartInProgress = true;
  recordShutdownReason({ kind: 'signal', signal });
  console.log(`\n🔄 Restart signal received (${signal}). Restarting RouteCodex server process...`);

  const argv = process.argv.slice(1);
  const env = { ...process.env } as NodeJS.ProcessEnv;
  env.ROUTECODEX_RESTARTED_AT = String(Date.now());
  // IMPORTANT: avoid inheriting a stale ROUTECODEX_VERSION across restarts.
  // The child process should re-resolve version from the current code/package on disk.
  delete env.ROUTECODEX_VERSION;

  const entryCheck = await ensureRestartEntryReady(argv);
  if (!entryCheck.ready) {
    await reportCliError(
      'SERVER_RESTART_ENTRY_MISSING',
      'Restart aborted because restart entry script is missing',
      new Error(`restart entry missing: ${entryCheck.entryPath || 'unknown'}`),
      'high',
      {
        signal,
        waitedMs: entryCheck.waitedMs,
        entryPath: entryCheck.entryPath
      }
    ).catch(() => {});
    console.error(
      `❌ Restart aborted: entry script is missing (${entryCheck.entryPath || 'unknown'}) after waiting ${entryCheck.waitedMs}ms.`
    );
    console.error('💡 Hint: run `npm run build:dev` (or wait for current build) and retry `routecodex restart`.');
    restartInProgress = false;
    return;
  }

  try {
    await app.stop();
  } catch (error) {
    // Best-effort: even if stop fails, attempt to spawn a replacement to recover.
    await reportCliError('SERVER_RESTART_STOP_FAILED', 'Failed to stop before restart', error, 'high').catch(() => {});
  }

  try {
    const child = spawn(process.execPath, argv, { stdio: 'inherit', env });
    console.log(`[routecodex:restart] spawned pid=${child.pid ?? 'unknown'}`);
  } catch (error) {
    await reportCliError('SERVER_RESTART_SPAWN_FAILED', 'Failed to spawn restarted server', error, 'critical').catch(() => {});
    console.error('❌ Failed to spawn restarted server:', error);
    process.exit(1);
  }

  process.exit(0);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const modulesConfigPath = process.argv[2]; // Allow modules config path as command line argument
  const app = new RouteCodexApp(modulesConfigPath);

  // Setup signal handlers for graceful shutdown
  process.on('SIGTERM', () => {
    recordShutdownReason({ kind: 'signal', signal: 'SIGTERM' });
    void gracefulShutdown(app);
  });
  process.on('SIGINT', () => {
    recordShutdownReason({ kind: 'signal', signal: 'SIGINT' });
    void gracefulShutdown(app);
  });

  // Restart signal:
  // - CLI sends SIGUSR2 to ask the server to restart with new code/config from disk.
  // - The server respawns itself (same argv), then exits.
  if (process.platform !== 'win32') {
    process.on('SIGUSR2', () => {
      void restartSelf(app, 'SIGUSR2');
    });
    process.on('SIGHUP', () => {
      void restartSelf(app, 'SIGHUP');
    });
  }

  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    const message = error instanceof Error ? error.message : String(error ?? '');
    recordShutdownReason({ kind: 'uncaughtException', message });
    void reportCliError('UNCAUGHT_EXCEPTION', 'Uncaught Exception', error, 'critical');
    console.error('❌ Uncaught Exception:', error);
    gracefulShutdown(app).catch(() => process.exit(1));
  });

  // Handle unhandled promise rejections (log only; do not shutdown)
  process.on('unhandledRejection', (reason, promise) => {
    void reportCliError('UNHANDLED_REJECTION', 'Unhandled promise rejection', reason, 'high', {
      promise: String(promise)
    });
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  });

  // Start the server
  await app.start();
}

// Start the application if this file is run directly
if (isDirectExecution(import.meta.url, process.argv[1])) {
  main().catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error ?? '');
    recordShutdownReason({ kind: 'startupError', message });
    await reportCliError('MAIN_START_FAILED', 'Failed to start RouteCodex', error, 'critical');
    console.error('❌ Failed to start RouteCodex:', error);
    process.exit(1);
  });
}

export { RouteCodexApp, main };
