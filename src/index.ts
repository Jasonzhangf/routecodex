/**
 * RouteCodex Main Entry Point
 * Multi-provider OpenAI proxy server with configuration management
 */

import { LOCAL_HOSTS, HTTP_PROTOCOLS, API_PATHS } from "./constants/index.js";
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { homedir } from 'os';
import net from 'net';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { buildInfo } from './build-info.js';
import { resolveRouteCodexConfigPath } from './config/config-paths.js';
import { loadRouteCodexConfig } from './config/routecodex-config-loader.js';

// Polyfill CommonJS require for ESM runtime to satisfy dependencies that call require()
let moduleRequire: ((moduleId: string) => unknown) | null = null;
try {
  moduleRequire = createRequire(import.meta.url);
  if (!(globalThis as any).require) {
    (globalThis as any).require = moduleRequire;
  }
} catch {
  moduleRequire = null;
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
  // 获取当前执行文件的目录（用于找到打包后的modules.json）
  const execDir = path.dirname(process.argv[1] || process.execPath);

  const possiblePaths = [
    process.env.ROUTECODEX_MODULES_CONFIG,
    // 优先查找打包后的modules.json（在npm包中）
    path.join(execDir, 'config', 'modules.json'),
    // 开发环境的相对路径
    './config/modules.json',
    // 当前工作目录
    path.join(process.cwd(), 'config', 'modules.json'),
    // 用户主目录
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

  return './config/modules.json';
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
  private httpServer: unknown;
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
    this.httpServer = null; // 将在初始化时设置
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

      // 确定用户配置文件路径，优先使用环境变量（RCC4_CONFIG_PATH / ROUTECODEX_CONFIG / ROUTECODEX_CONFIG_PATH），否则回退到共享解析
      function pickUserConfigPath(): string {
        const envPaths = [
          process.env.RCC4_CONFIG_PATH,
          process.env.ROUTECODEX_CONFIG,
          process.env.ROUTECODEX_CONFIG_PATH,
        ].filter(Boolean) as string[];
        for (const p of envPaths) {
          try {
            if (p && fsSync.existsSync(p) && fsSync.statSync(p).isFile()) {
              return p;
            }
          } catch { /* ignore */ }
        }
        return resolveRouteCodexConfigPath();
      }
      const userConfigPath = pickUserConfigPath();
      this.configPath = userConfigPath;

      // Honor serverTools toggle strictly by config.json (single source of truth)
      // Set ROUTECODEX_SERVER_TOOLS env based on user config, so core replacement logic
      // relies only on config, avoiding cwd/path ambiguity.
      const { userConfig, configPath: resolvedConfigPath } = await loadRouteCodexConfig(userConfigPath);
      this.configPath = resolvedConfigPath;

      try {
        const st = (userConfig && typeof userConfig === 'object') ? (userConfig as any).serverTools : null;
        const enabled = !!(st && st.enabled === true && st.replace && st.replace.web_fetch && st.replace.web_fetch.enabled === true);
        // 单一判断来源：严格以用户配置为准，强制覆盖核心的其他推断路径
        const val = enabled ? '1' : '0';
        process.env.ROUTECODEX_SERVER_TOOLS = val;
        process.env.RCC_SERVER_TOOLS = val;
        try { console.log(`[ServerTools] web_fetch replacement = ${enabled ? 'ENABLED' : 'DISABLED'} (from ${userConfigPath})`); } catch {}
      } catch {
        // 配置缺失则明确关闭
        process.env.ROUTECODEX_SERVER_TOOLS = '0';
        process.env.RCC_SERVER_TOOLS = '0';
      }

      if (!process.env.ROUTECODEX_STAGE_LOG || process.env.ROUTECODEX_STAGE_LOG.trim() === '') {
        if (buildInfo.mode === 'dev') {
          process.env.ROUTECODEX_STAGE_LOG = '1';
        }
      }

      console.log(`ℹ RouteCodex version: ${buildInfo.version} (${buildInfo.mode} build)`);

      // 3. 初始化服务器（V1/V2可切换，默认动态V2）
      // 3. 初始化服务器（仅使用 V2 动态流水线架构）
      // Resolve host/port from merged config for V2 constructor
      let bindHost = '0.0.0.0';
      let bindPort = port;
      try {
        const envPort = Number(process.env.ROUTECODEX_PORT || process.env.RCC_PORT || NaN);
        const http = (userConfig as any)?.httpserver || (userConfig as any)?.modules?.httpserver?.config || {};
        bindHost = String(http.host || '0.0.0.0');
        const portRaw = http.port ?? (userConfig as any)?.server?.port ?? port;
        if (Number.isFinite(envPort) && envPort > 0) {
          bindPort = envPort;
        } else {
          bindPort = typeof portRaw === 'number' ? portRaw : parseInt(String(portRaw), 10);
        }
        if (!Number.isFinite(bindPort)) bindPort = port;
      } catch { /* keep defaults */ }
      const { RouteCodexHttpServer } = await import('./server/runtime/http-server.js');
      // V2 hooks 开关：默认开启；可通过 ROUTECODEX_V2_HOOKS=0/false/no 关闭
      const hooksEnv = String(process.env.ROUTECODEX_V2_HOOKS || process.env.RCC_V2_HOOKS || '').trim().toLowerCase();
      const hooksOff = hooksEnv === '0' || hooksEnv === 'false' || hooksEnv === 'no';
      const hooksOn = !hooksOff;
      this.httpServer = new RouteCodexHttpServer({ server: { host: bindHost, port: bindPort, useV2: true }, logging: { level: 'debug', enableConsole: true }, providers: {}, v2Config: { enableHooks: hooksOn } }) as any;
      await (this.httpServer as any).initializeWithUserConfig(userConfig);

      // 4.1 校验 virtualrouter 配置
      const vrSection = (userConfig as any)?.virtualrouter;
      if (!vrSection || !vrSection.routing || !Object.keys(vrSection.routing).length) {
        throw new Error(`user config 缺少 virtualrouter.routing，无法启动`);
      }
      console.log(`🧱 Virtual router routes: ${Object.keys(vrSection.routing).length}`);
      console.log(`🔑 Provider targets: ${Object.keys((vrSection.routing || {})).reduce((acc, key) => acc + (Array.isArray(vrSection.routing[key]) ? vrSection.routing[key].length : 0), 0)}`);

      // 6. 启动服务器（若端口被占用，先尝试优雅释放；确保在合并配置已生成之后）
      // Ensure the port is available before continuing. Attempt graceful shutdown first.
      await ensurePortAvailable(port, { attemptGraceful: true });
      try {
        await (this.httpServer as any).start();
      } catch (err: any) {
        const code = (err && (err as any).code) || (err && (err as any).errno) || '';
        const msg = (err instanceof Error ? err.message : String(err || ''));
        if (String(code) === 'EADDRINUSE' || /address already in use/i.test(msg)) {
          console.warn(`⚠ Port ${port} in use; attempting to free and retry...`);
          try {
            await ensurePortAvailable(port, { attemptGraceful: true });
            await (this.httpServer as any).start();
          } catch (e) {
            throw err; // keep original error context
          }
        } else {
          throw err;
        }
      }
      this._isRunning = true;

      // 7. 记录当前运行模式（仅 V2）
      console.log(`${buildInfo.mode === 'dev' ? '🧪 dev' : '🚢 release'} mode · 🔵 V2 dynamic pipeline active`);

      // 7. 获取服务器状态（使用 HTTP 服务器解析后的最终绑定地址与端口）
      // 优先读取服务器自身解析结果，避免日志误导（例如 host 放在不同层级或为 0.0.0.0 时）
      let serverConfig = { host: LOCAL_HOSTS.IPV4, port } as { host: string; port: number };
      try {
        const resolved = await (this.httpServer as any).getServerConfig?.();
        if (resolved && resolved.server) {
          serverConfig = { host: String(resolved.server.host || LOCAL_HOSTS.IPV4), port: Number(resolved.server.port || port) };
        }
      } catch { /* ignore; fall back to defaults */ }

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
      console.error('❌ Failed to start RouteCodex server:', error);
      process.exit(1);
    }
  }

  /**
   * Stop the RouteCodex server
   */
  async stop(): Promise<void> {
    try {
      if (this._isRunning) {
        console.log('🛑 Stopping RouteCodex server...');

        if (this.httpServer) {
          await (this.httpServer as any).stop();
        }

        this._isRunning = false;
        console.log('✅ RouteCodex server stopped successfully');
      }
    } catch (error) {
      console.error('❌ Failed to stop RouteCodex server:', error);
      process.exit(1);
    }
  }

  /**
   * Get server status
   */
  getStatus(): unknown {
    if (this.httpServer) {
      return (this.httpServer as any).getStatus();
    }
    return {
      status: 'stopped',
      message: 'Server not initialized'
    };
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
        if (await canBind(port)) return;
      }
    }
  }

  // Fall back to SIGTERM/SIGKILL processes listening on the port (avoid self-kill by probing first)
  const pids = await listPidsOnPort(port);
  if (!pids.length) return;
  for (const pid of pids) {
    try { process.kill(Number(pid), 'SIGTERM'); } catch { /* ignore */ }
  }
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 300));
    if (await canBind(port)) return;
  }
  const remain = await listPidsOnPort(port);
  for (const pid of remain) {
    try { process.kill(Number(pid), 'SIGKILL'); } catch { /* ignore */ }
  }
  await new Promise(r => setTimeout(r, 500));
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
      signal: (controller as any).signal
    } as any).catch(() => null);
    clearTimeout(timeout);
    return !!(res && res.ok);
  } catch { return false; }
}

/** Quick health probe to avoid killing a healthy server instance */
async function isServerHealthy(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => { try { controller.abort(); } catch { /* ignore */ } }, 800);
    const res = await fetch(`${HTTP_PROTOCOLS.HTTP}${LOCAL_HOSTS.IPV4}:${port}${API_PATHS.HEALTH}`, { method: 'GET', signal: (controller as any).signal } as any);
    clearTimeout(t);
    if (!res.ok) { return false; }
    const data = await res.json().catch(() => null);
    return !!data && (data.status === 'healthy' || data.status === 'ready');
  } catch {
    return false;
  }
}

/**
 * Handle graceful shutdown
 */
async function gracefulShutdown(app: RouteCodexApp): Promise<void> {
  console.log('\n🛑 Received shutdown signal, stopping server gracefully...');
  try {
    await app.stop();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during graceful shutdown:', error);
    process.exit(1);
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const modulesConfigPath = process.argv[2]; // Allow modules config path as command line argument
  const app = new RouteCodexApp(modulesConfigPath);

  // Setup signal handlers for graceful shutdown
  process.on('SIGTERM', () => gracefulShutdown(app));
  process.on('SIGINT', () => gracefulShutdown(app));

  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    gracefulShutdown(app).catch(() => process.exit(1));
  });

  // Handle unhandled promise rejections (log only; do not shutdown)
  process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  });

  // Start the server
  await app.start();
}

// Start the application if this file is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('❌ Failed to start RouteCodex:', error);
    process.exit(1);
  });
}

export { RouteCodexApp, main };
