/**
 * RouteCodex Main Entry Point
 * Multi-provider OpenAI proxy server with configuration management
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { homedir } from 'os';
import net from 'net';
import { spawn } from 'child_process';
import { ConfigManagerModule } from './modules/config-manager/config-manager-module.js';
import { resolveRouteCodexConfigPath } from './config/config-paths.js';

/**
 * Default modules configuration path
 */
function getDefaultModulesConfigPath(): string {
  const possiblePaths = [
    process.env.ROUTECODEX_MODULES_CONFIG,
    './config/modules.json',
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

  return './config/modules.json';
}

/**
 * Main application class
 */
class RouteCodexApp {
  private httpServer: unknown;
  private configManager: ConfigManagerModule;
  private modulesConfigPath: string;
  private _isRunning: boolean = false;
  private mergedConfigPath: string = path.join(process.cwd(), 'config', 'merged-config.json');

  constructor(modulesConfigPath?: string) {
    this.modulesConfigPath = modulesConfigPath || getDefaultModulesConfigPath();

    if (!fsSync.existsSync(this.modulesConfigPath)) {
      throw new Error(`Modules configuration file not found: ${this.modulesConfigPath}`);
    }

    const modulesStats = fsSync.statSync(this.modulesConfigPath);
    if (!modulesStats.isFile()) {
      throw new Error(`Modules configuration path must be a file: ${this.modulesConfigPath}`);
    }

    this.configManager = new ConfigManagerModule();
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

      // Ensure the port is available before continuing. Attempt graceful shutdown first.
      await ensurePortAvailable(port, { attemptGraceful: true });

      this.mergedConfigPath = path.join(process.cwd(), 'config', `merged-config.${port}.json`);

      // 确定用户配置文件路径，优先使用RCC4_CONFIG_PATH
      const userConfigPath = resolveRouteCodexConfigPath();

      const configManagerConfig = {
        configPath: userConfigPath,
        mergedConfigPath: this.mergedConfigPath,
        systemModulesPath: this.modulesConfigPath,
        autoReload: true,
        watchInterval: 5000
      };

      await this.configManager.initialize(configManagerConfig);

      // 2. 加载合并后的配置
      const mergedConfig = await this.loadMergedConfig();

      // 3. 初始化HTTP服务器
      const HttpServer = (await import('./server/http-server.js')).HttpServer;
      this.httpServer = new HttpServer(this.modulesConfigPath) as any;

      // 4. 使用合并后的配置初始化服务器
      await (this.httpServer as any).initializeWithMergedConfig(mergedConfig);

      // 5. 按 merged-config 组装流水线并注入（优先使用 sharedmodule/pipeline-core，失败则回退本地实现）
      try {
        let PipelineAssembler: any = null;
        try {
          // Prefer shared core package (phase 1 extraction)
          const core = await import('@routecodex/pipeline-core');
          PipelineAssembler = (core as any)?.PipelineAssembler || null;
        } catch {
          /* ignore and fallback */
        }
        if (!PipelineAssembler) {
          // Fallback to local assembler
          PipelineAssembler = (await import('./modules/pipeline/config/pipeline-assembler.js')).PipelineAssembler;
        }
        const { manager, routePools } = await PipelineAssembler.assemble(mergedConfig);
        (this.httpServer as any).attachPipelineManager(manager);
        (this.httpServer as any).attachRoutePools(routePools);
        // Attach classifier config if present
        const classifierConfig = mergedConfig?.modules?.virtualrouter?.config?.classificationConfig;
        if (classifierConfig) {
          (this.httpServer as any).attachRoutingClassifierConfig(classifierConfig);
        }
        console.log('🧩 Pipeline assembled from merged-config and attached to server.');
      } catch (e) {
        console.warn('⚠️ Failed to assemble pipeline from merged-config. Router requires pipeline; requests will fail until assembly is provided.', e);
      }

      // 6. 启动服务器（若端口被占用，自动释放后重试一次）
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

      // 7. 获取服务器状态
      // const status = (this.httpServer as any).getStatus();
      const serverConfig = {
        host: 'localhost',
        port
      };

      console.log(`✅ RouteCodex server started successfully!`);
      console.log(`🌐 Server URL: http://${serverConfig.host}:${serverConfig.port}`);
      console.log(`🗂️ Merged config: ${this.mergedConfigPath}`);
      console.log(`📊 Health check: http://${serverConfig.host}:${serverConfig.port}/health`);
      console.log(`🔧 Configuration: http://${serverConfig.host}:${serverConfig.port}/config`);
      console.log(`📖 OpenAI API: http://${serverConfig.host}:${serverConfig.port}/v1/openai`);
      console.log(`🔬 Anthropic API: http://${serverConfig.host}:${serverConfig.port}/v1/anthropic`);

      // Optional: run samples dry-run on startup (non-blocking)
      if (process.env.ROUTECODEX_SAMPLES_DRY_RUN_ON_START === '1') {
        try {
          const { spawn } = await import('child_process');
          const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
          const child = spawn(cmd, ['run', '-s', 'dry-run:samples'], {
            stdio: 'inherit',
            env: process.env,
            cwd: process.cwd(),
            detached: false,
          });
          child.on('exit', (code) => {
            console.log(`🧪 samples-dry-run finished with code ${code}`);
          });
        } catch (e) {
          console.warn('⚠️ Failed to run samples dry-run on start:', e);
        }
      }

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
   * Load merged configuration
   */
  private async loadMergedConfig(): Promise<any> {
    try {
      const configContent = await fs.readFile(this.mergedConfigPath, 'utf-8');
      return JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to load merged configuration:', error);
      throw error;
    }
  }

  /**
   * Detect server port from user configuration
   */
  private async detectServerPort(_modulesConfigPath: string): Promise<number> {
    try {
      // 首先检查RCC4_CONFIG_PATH环境变量（当前使用的）
      if (process.env.RCC4_CONFIG_PATH) {
        const configPath = process.env.RCC4_CONFIG_PATH;
        if (fsSync.existsSync(configPath)) {
          const stats = fsSync.statSync(configPath);
          if (!stats.isFile()) {
            throw new Error(`RCC4_CONFIG_PATH must point to a file: ${configPath}`);
          }

          const raw = await fs.readFile(configPath, 'utf-8');
          const json = JSON.parse(raw);
          const port = json?.port;
          if (typeof port === 'number' && port > 0) {
            console.log(`🔧 Using port ${port} from RCC4_CONFIG_PATH: ${configPath}`);
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
          const port = json?.port;
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
          const port = json?.port;
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
        const port = json?.port;
        if (typeof port === 'number' && port > 0) {
          console.log(`🔧 Using port ${port} from default config: ${defaultConfigPath}`);
          return port;
        }
      }
    } catch (error) {
      console.error('❌ Error detecting server port:', error);
    }
    throw new Error('HTTP server port not found. Please set "port" in your user configuration file.');
  }
}

/**
 * Ensure a TCP port is available by attempting graceful shutdown of any process holding it,
 * then force-killing as a last resort. Mirrors previous startup behavior.
 */
async function ensurePortAvailable(port: number, opts: { attemptGraceful?: boolean } = {}): Promise<void> {
  // Retained for backward-compatibility but no longer called on normal start.
  try {
    // Quick check: attempt to bind to the port
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

  // Always attempt to free the port if bind failed (legacy behavior)

  const getPids = async (): Promise<string[]> => {
    try {
      const ls = spawn('lsof', ['-ti', `:${port}`]);
      return await new Promise<string[]>((resolve) => {
        let out = '';
        ls.stdout.on('data', d => (out += String(d)));
        ls.on('close', () => {
          resolve(out.split(/\s+/).map(s => s.trim()).filter(Boolean));
        });
        ls.on('error', () => resolve([]));
      });
    } catch {
      return [];
    }
  };

  const pids = await getPids();
  if (!pids || pids.length === 0) { return; }

  if (opts.attemptGraceful) {
    const graceful = await attemptHttpShutdown(port);
    if (graceful) {
      // Give the server a moment to exit cleanly
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 300));
        const remain = await getPids();
        if (!remain.length) { return; }
      }
    }
  }

  console.warn(`⚠️ Port ${port} in use by PID(s): ${pids.join(', ')} — sending SIGTERM...`);
  for (const pid of pids) {
    try { process.kill(Number(pid), 'SIGTERM'); } catch { /* ignore */ }
  }
  // wait up to 5s for graceful shutdown
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 500));
    const remain = await getPids();
    if (!remain.length) { return; }
  }
  console.warn(`⚠️ Port ${port} still in use — sending SIGKILL...`);
  const remain = await getPids();
  for (const pid of remain) {
    try { process.kill(Number(pid), 'SIGKILL'); } catch { /* ignore */ }
  }
  await new Promise(r => setTimeout(r, 800));
}

async function attemptHttpShutdown(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      try { controller.abort(); } catch { /* ignore */ }
    }, 1000);

    const res = await fetch(`http://127.0.0.1:${port}/shutdown`, {
      method: 'POST',
      signal: (controller as any).signal
    } as any).catch(() => null);

    clearTimeout(timeout);
    if (res && res.ok) {
      console.warn(`⚠️ Requested graceful shutdown on port ${port} via /shutdown.`);
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

/** Quick health probe to avoid killing a healthy server instance */
async function isServerHealthy(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => { try { controller.abort(); } catch { /* ignore */ } }, 800);
    const res = await fetch(`http://127.0.0.1:${port}/health`, { method: 'GET', signal: (controller as any).signal } as any);
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
