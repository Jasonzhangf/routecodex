/**
 * Server Factory - 服务器工厂
 *
 * Unified Hub V1: single execution path.
 * Only RouteCodexHttpServer is supported.
 */

import { LOCAL_HOSTS } from './constants/index.js';

import type { ServerConfigV2 as HttpServerConfigV2 } from './server/runtime/http-server.js';

type ServerConfigV2 = Partial<HttpServerConfigV2> & {
  server?: Partial<HttpServerConfigV2['server']>;
  logging?: Partial<HttpServerConfigV2['logging']>;
  providers?: Record<string, unknown>;
};

/**
 * 服务器创建选项
 */
export interface ServerCreateOptions {
  config?: {              // 额外配置
    v2HooksEnabled?: boolean;
    v2MiddlewareEnabled?: boolean;
  };
}

/**
 * 服务器实例接口
 */
export interface ServerInstance {
  initialize(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): unknown;
  isInitialized(): boolean;
  isRunning(): boolean;
}

/**
 * 服务器工厂类
 */
export class ServerFactory {
  private static v2Instance?: ServerInstance;

  /**
   * 创建服务器实例
   * Unified Hub V1: always create V2 server.
   */
  static async createServer(
    config: ServerConfigV2,
    options: ServerCreateOptions = {}
  ): Promise<ServerInstance> {
    console.log('[ServerFactory] Creating server instance (Unified Hub V1)');
    const v2Server = await this.createV2Server(config as ServerConfigV2, options);
    console.log('[ServerFactory] V2 server created successfully');
    return v2Server;
  }

  /**
   * 创建V2服务器实例
   */
  static async createV2Server(
    config: ServerConfigV2,
    options: ServerCreateOptions = {}
  ): Promise<ServerInstance> {
    if (!ServerFactory.v2Instance) {
      console.log('[ServerFactory] Creating V2 server instance');

      try {
        // 动态导入V2实现
        const { RouteCodexHttpServer } = await import('./server/runtime/http-server.js');

        // 合并V2配置
        const v2Config: ServerConfigV2 = {
          ...config,
          v2Config: {
            enableHooks: options.config?.v2HooksEnabled ?? true,
            ...config.v2Config
          }
        };
        const normalizedConfig = ServerFactory.normalizeV2Config(v2Config);

        ServerFactory.v2Instance = new RouteCodexHttpServer(normalizedConfig);
        console.log('[ServerFactory] V2 server instance created');
      } catch (error) {
        console.error('[ServerFactory] Failed to create V2 server:', error);
        throw new Error(`Failed to create V2 server: ${(error as Error).message}`);
      }
    }

    if (!ServerFactory.v2Instance) {
      throw new Error('RouteCodex V2 server was not created');
    }

    return ServerFactory.v2Instance;
  }

  private static normalizeV2Config(config: ServerConfigV2): HttpServerConfigV2 {
    const resolveLevel = (level?: unknown): HttpServerConfigV2['logging']['level'] => {
      return level === 'info' || level === 'warn' || level === 'error' ? level : 'debug';
    };

    return {
      server: {
        port: Number.isFinite(config.server?.port) ? Number(config.server?.port) : 5521,
        host: (typeof config.server?.host === 'string' && config.server.host.trim()) ? config.server.host : LOCAL_HOSTS.IPV4,
        timeout: config.server?.timeout,
      },
      logging: {
        level: resolveLevel(config.logging?.level),
        enableConsole: config.logging?.enableConsole ?? true,
        enableFile: config.logging?.enableFile ?? false,
        filePath: config.logging?.filePath
      },
      providers: config.providers ?? {},
      v2Config: config.v2Config
    };
  }

  /**
   * 测试专用：创建V2服务器实例
   */
  static async createV2ServerForTest(config?: Partial<ServerConfigV2>): Promise<ServerInstance> {
    const defaultConfig: ServerConfigV2 = {
      server: {
        port: 5507,  // 使用不同端口避免冲突
        host: LOCAL_HOSTS.IPV4,
      },
      logging: {
        level: 'debug',
        enableConsole: true
      },
      providers: {},
      v2Config: {
        enableHooks: true
      }
    };

    const finalConfig = { ...defaultConfig, ...config };
    return await this.createV2Server(finalConfig, {});
  }

  /**
   * 获取当前实例状态
   */
  static getInstanceStatus(): {
    v2Created: boolean;
    v2Initialized: boolean;
  } {
    return {
      v2Created: !!ServerFactory.v2Instance,
      v2Initialized: ServerFactory.v2Instance?.isInitialized() ?? false
    };
  }

  /**
   * 清理实例缓存
   */
  static clearInstances(): void {
    console.log('[ServerFactory] Clearing server instances cache');

    if (ServerFactory.v2Instance) {
      console.log('[ServerFactory] Clearing V2 instance');
      ServerFactory.v2Instance = undefined;
    }
  }

  /**
   * 强制重新创建实例
   */
  static async recreateServer(
    config: ServerConfigV2,
    options: ServerCreateOptions = {}
  ): Promise<ServerInstance> {
    console.log('[ServerFactory] Recreating server instances');

    // 清理现有实例
    ServerFactory.clearInstances();

    // 创建新实例
    return await ServerFactory.createServer(config, options);
  }

  /**
   * 获取V2实例 (单例)
   */
  static getV2Instance(): ServerInstance | undefined {
    return ServerFactory.v2Instance;
  }
}

/**
 * 便捷函数：创建服务器
 */
export function createRouteCodexServer(
  config: ServerConfigV2,
  options: ServerCreateOptions = {}
): Promise<ServerInstance> {
  return ServerFactory.createServer(config, options);
}

/**
 * 便捷函数：创建V2服务器
 */
export function createV2Server(config: ServerConfigV2): Promise<ServerInstance> {
  return ServerFactory.createV2Server(config);
}

// 导出工厂类和便捷函数
export { ServerFactory as default };
