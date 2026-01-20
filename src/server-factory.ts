/**
 * Server Factory - 服务器工厂
 *
 * 提供V1和V2服务器的统一创建接口
 * 支持渐进式切换，零风险部署
 */

import { LOCAL_HOSTS } from './constants/index.js';

import type { ServerConfig } from './server/RouteCodexServer.js';
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
  useV2?: boolean;        // 是否使用V2服务器
  fallbackToV1?: boolean; // 历史参数（保留类型）。V2全局禁用降级，忽略此参数。
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
    // 新开关：ROUTECODEX_PIPELINE_MODE=dynamic|static（默认dynamic）
    const modeEnv = String(process.env.ROUTECODEX_PIPELINE_MODE || process.env.RCC_PIPELINE_MODE || '').trim().toLowerCase();
    const resolveUseV2 = (): boolean => {
      if (modeEnv === 'dynamic' || modeEnv === 'v2') {
        return true;
      }
      if (modeEnv === 'static' || modeEnv === 'v1') {
        return false;
      }
      const legacy = String(process.env.ROUTECODEX_USE_V2 || '').trim().toLowerCase();
      if (legacy === 'true' || legacy === '1') {
        console.warn('[ServerFactory] ROUTECODEX_USE_V2 已弃用，请使用 ROUTECODEX_PIPELINE_MODE=dynamic|static');
        return true;
      }
      if (legacy === 'false' || legacy === '0') {
        console.warn('[ServerFactory] ROUTECODEX_USE_V2 已弃用，请使用 ROUTECODEX_PIPELINE_MODE=dynamic|static');
        return false;
      }
      return true; // 默认动态（V2）
    };
    const useV2 = options.useV2 ?? resolveUseV2();
    // 全局禁用降级（Fail Fast）：如果V2启用但创建失败，直接抛错，不再回退到V1
    const fallbackToV1 = false;

    console.log(`[ServerFactory] Creating server instance (V2: ${useV2}, Fallback: ${fallbackToV1})`);

    if (useV2) {
      try {
        const v2Server = await this.createV2Server(config as ServerConfigV2, options);
        console.log('[ServerFactory] V2 server created successfully');
        return v2Server;
      } catch (error) {
        console.error('[ServerFactory] Failed to create V2 server:', error);

        // 不再降级
        throw error;
      }
    } else {
      return await this.createV1Server(config as ServerConfig);
    }
  }

  /**
   * 创建V1服务器实例
   */
  static async createV1Server(
    config: ServerConfig,
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

    if (!ServerFactory.v1Instance) {
      throw new Error('RouteCodex V1 server was not created');
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
        useV2: config.server?.useV2 ?? true
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
        useV2: true
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
    return await this.createV2Server(finalConfig, { useV2: true, fallbackToV1: false });
  }

  /**
   * 生产专用：创建V1服务器实例
   */
  static async createV1ServerForProduction(config: ServerConfig): Promise<ServerInstance> {
    return await this.createV1Server(config);
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
