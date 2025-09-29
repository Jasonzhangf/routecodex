/**
 * RouteCodex Main Entry Point
 * Multi-provider OpenAI proxy server with configuration management
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { homedir } from 'os';
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
  private httpServer: any;
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
      this.httpServer = new HttpServer(this.modulesConfigPath);

      // 4. 使用合并后的配置初始化服务器
      await this.httpServer.initializeWithMergedConfig(mergedConfig);

      // 5. 按 merged-config 组装流水线并注入（完全配置驱动，无硬编码）
      try {
        const { PipelineAssembler } = await import('./modules/pipeline/config/pipeline-assembler.js');
        const { manager, routePools } = await PipelineAssembler.assemble(mergedConfig);
        this.httpServer.attachPipelineManager(manager);
        this.httpServer.attachRoutePools(routePools);
        // Attach classifier config if present
        const classifierConfig = mergedConfig?.modules?.virtualrouter?.config?.classificationConfig;
        if (classifierConfig) {
          this.httpServer.attachRoutingClassifierConfig(classifierConfig);
        }
        console.log('🧩 Pipeline assembled from merged-config and attached to server.');
      } catch (e) {
        console.warn('⚠️ Failed to assemble pipeline from merged-config. Router requires pipeline; requests will fail until assembly is provided.', e);
      }

      // 6. 启动服务器
      await this.httpServer.start();
      this._isRunning = true;

      // 7. 获取服务器状态
      const status = this.httpServer.getStatus();
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
          await this.httpServer.stop();
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
  getStatus(): any {
    if (this.httpServer) {
      return this.httpServer.getStatus();
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
  private async detectServerPort(modulesConfigPath: string): Promise<number> {
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

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    gracefulShutdown(app).catch(() => process.exit(1));
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
