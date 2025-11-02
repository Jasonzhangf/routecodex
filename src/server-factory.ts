/**
 * Server Factory - 服务器工厂
 *
 * 提供V1和V2服务器的统一创建接口
 * 支持渐进式切换，零风险部署
 */

import type { ServerConfig } from './server/RouteCodexServer.js';
// Avoid hard type coupling with V2 files to keep build green when V2 is excluded.
// Use a lightweight structural alias instead of importing types from src/server-v2/*.
type ServerConfigV2 = any;

/**
 * 服务器创建选项
 */
export interface ServerCreateOptions {
  useV2?: boolean;        // 是否使用V2服务器
  fallbackToV1?: boolean; // V2失败时是否降级到V1
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
  getStatus(): any;
  isInitialized(): boolean;
  isRunning(): boolean;
}

/**
 * 服务器工厂类
 */
export class ServerFactory {
  private static v1Instance?: ServerInstance;
  private static v2Instance?: ServerInstance;

  /**
   * 创建服务器实例
   * 根据配置自动选择V1或V2，默认V1
   */
  static async createServer(
    config: ServerConfig | ServerConfigV2,
    options: ServerCreateOptions = {}
  ): Promise<ServerInstance> {
    const useV2 = options.useV2 || process.env.ROUTECODEX_USE_V2 === 'true';
    const fallbackToV1 = options.fallbackToV1 ?? true;

    console.log(`[ServerFactory] Creating server instance (V2: ${useV2}, Fallback: ${fallbackToV1})`);

    if (useV2) {
      try {
        const v2Server = await this.createV2Server(config as ServerConfigV2, options);
        console.log('[ServerFactory] V2 server created successfully');
        return v2Server;
      } catch (error) {
        console.error('[ServerFactory] Failed to create V2 server:', error);

        if (fallbackToV1) {
          console.log('[ServerFactory] Falling back to V1 server');
          return await this.createV1Server(config as ServerConfig, options);
        } else {
          throw error;
        }
      }
    } else {
      return await this.createV1Server(config as ServerConfig, options);
    }
  }

  /**
   * 创建V1服务器实例
   */
  static async createV1Server(
    config: ServerConfig,
    options: ServerCreateOptions = {}
  ): Promise<ServerInstance> {
    if (!ServerFactory.v1Instance) {
      console.log('[ServerFactory] Creating V1 server instance');

      try {
        // 动态导入V1实现
        const { RouteCodexServer } = await import('./server/RouteCodexServer.js');
        ServerFactory.v1Instance = new RouteCodexServer(config);
        console.log('[ServerFactory] V1 server instance created');
      } catch (error) {
        console.error('[ServerFactory] Failed to create V1 server:', error);
        throw new Error(`Failed to create V1 server: ${(error as Error).message}`);
      }
    }

    return ServerFactory.v1Instance;
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
        const { RouteCodexServerV2 } = await import('./server-v2/core/route-codex-server-v2.js');

        // 合并V2配置
        const v2Config: ServerConfigV2 = {
          ...config,
          v2Config: {
            enableHooks: options.config?.v2HooksEnabled ?? true,
            enableMiddleware: options.config?.v2MiddlewareEnabled ?? true,
            ...config.v2Config
          }
        };

        ServerFactory.v2Instance = new RouteCodexServerV2(v2Config);
        console.log('[ServerFactory] V2 server instance created');
      } catch (error) {
        console.error('[ServerFactory] Failed to create V2 server:', error);
        throw new Error(`Failed to create V2 server: ${(error as Error).message}`);
      }
    }

    return ServerFactory.v2Instance!;
  }

  /**
   * 测试专用：创建V2服务器实例
   */
  static async createV2ServerForTest(config?: Partial<ServerConfigV2>): Promise<ServerInstance> {
    const defaultConfig: ServerConfigV2 = {
      server: {
        port: 5507,  // 使用不同端口避免冲突
        host: '127.0.0.1',
        useV2: true
      },
      logging: {
        level: 'debug',
        enableConsole: true
      },
      providers: {},
      v2Config: {
        enableHooks: true,
        enableMiddleware: true
      }
    };

    const finalConfig = { ...defaultConfig, ...config };
    return await this.createV2Server(finalConfig, { useV2: true, fallbackToV1: false });
  }

  /**
   * 生产专用：创建V1服务器实例
   */
  static async createV1ServerForProduction(config: ServerConfig): Promise<ServerInstance> {
    return await this.createV1Server(config, { useV2: false, fallbackToV1: false });
  }

  /**
   * 获取当前实例状态
   */
  static getInstanceStatus(): {
    v1Created: boolean;
    v2Created: boolean;
    v1Initialized: boolean;
    v2Initialized: boolean;
  } {
    return {
      v1Created: !!ServerFactory.v1Instance,
      v2Created: !!ServerFactory.v2Instance,
      v1Initialized: ServerFactory.v1Instance?.isInitialized() ?? false,
      v2Initialized: ServerFactory.v2Instance?.isInitialized() ?? false
    };
  }

  /**
   * 清理实例缓存
   */
  static clearInstances(): void {
    console.log('[ServerFactory] Clearing server instances cache');

    if (ServerFactory.v1Instance) {
      console.log('[ServerFactory] Clearing V1 instance');
      ServerFactory.v1Instance = undefined;
    }

    if (ServerFactory.v2Instance) {
      console.log('[ServerFactory] Clearing V2 instance');
      ServerFactory.v2Instance = undefined;
    }
  }

  /**
   * 强制重新创建实例
   */
  static async recreateServer(
    config: ServerConfig | ServerConfigV2,
    options: ServerCreateOptions = {}
  ): Promise<ServerInstance> {
    console.log('[ServerFactory] Recreating server instances');

    // 清理现有实例
    ServerFactory.clearInstances();

    // 创建新实例
    return await ServerFactory.createServer(config, options);
  }

  /**
   * 获取V1实例 (单例)
   */
  static getV1Instance(): ServerInstance | undefined {
    return ServerFactory.v1Instance;
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
  config: ServerConfig | ServerConfigV2,
  options: ServerCreateOptions = {}
): Promise<ServerInstance> {
  return ServerFactory.createServer(config, options);
}

/**
 * 便捷函数：创建V1服务器
 */
export function createV1Server(config: ServerConfig): Promise<ServerInstance> {
  return ServerFactory.createV1Server(config);
}

/**
 * 便捷函数：创建V2服务器
 */
export function createV2Server(config: ServerConfigV2): Promise<ServerInstance> {
  return ServerFactory.createV2Server(config);
}

// 导出工厂类和便捷函数
export { ServerFactory as default };
