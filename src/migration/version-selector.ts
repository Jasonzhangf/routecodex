/**
 * Version Selector - 版本选择器
 *
 * 提供V1和V2服务器的统一选择和切换机制
 * 支持运行时版本控制和安全切换
 */

import type { ServerConfig } from '../server/RouteCodexServer.js';
import type { ServerConfigV2 } from '../server-v2/core/route-codex-server-v2.js';
import type { ServerInstance } from '../server-factory.js';
import { ServerFactory } from '../server-factory.js';

/**
 * 版本选择器配置
 */
export interface VersionSelectorConfig {
  defaultVersion?: 'v1' | 'v2';
  allowRuntimeSwitch?: boolean;
  enableHealthCheck?: boolean;
  fallbackToV1?: boolean;
}

/**
 * 版本信息
 */
export interface VersionInfo {
  version: 'v1' | 'v2';
  status: 'available' | 'unavailable' | 'error';
  initialized: boolean;
  running: boolean;
  error?: string;
  uptime?: number;
  port?: number;
}

/**
 * 切换结果
 */
export interface SwitchResult {
  success: boolean;
  fromVersion: 'v1' | 'v2';
  toVersion: 'v1' | 'v2';
  message: string;
  timestamp: number;
}

/**
 * 版本选择器
 */
export class VersionSelector {
  private static instance: VersionSelector;
  private config: VersionSelectorConfig;
  private currentVersion: 'v1' | 'v2' = 'v1';
  private v1Instance?: ServerInstance;
  private v2Instance?: ServerInstance;
  private switchHistory: SwitchResult[] = [];

  constructor(config: VersionSelectorConfig = {}) {
    this.config = {
      defaultVersion: 'v1',
      allowRuntimeSwitch: false,
      enableHealthCheck: true,
      fallbackToV1: true,
      ...config
    };

    this.currentVersion = this.config.defaultVersion || 'v1';
    console.log(`[VersionSelector] Initialized with default version: ${this.currentVersion}`);
  }

  /**
   * 获取单例实例
   */
  static getInstance(config?: VersionSelectorConfig): VersionSelector {
    if (!VersionSelector.instance) {
      VersionSelector.instance = new VersionSelector(config);
    }
    return VersionSelector.instance;
  }

  /**
   * 获取当前版本的服务器实例
   */
  async getCurrentServer(config: ServerConfig | ServerConfigV2): Promise<ServerInstance> {
    if (this.currentVersion === 'v1') {
      return await this.getV1Server(config as ServerConfig);
    } else {
      return await this.getV2Server(config as ServerConfigV2);
    }
  }

  /**
   * 获取V1服务器实例
   */
  async getV1Server(config: ServerConfig): Promise<ServerInstance> {
    if (!this.v1Instance) {
      console.log('[VersionSelector] Creating V1 server instance');
      this.v1Instance = await ServerFactory.createV1Server(config);
    }
    return this.v1Instance;
  }

  /**
   * 获取V2服务器实例
   */
  async getV2Server(config: ServerConfigV2): Promise<ServerInstance> {
    if (!this.v2Instance) {
      console.log('[VersionSelector] Creating V2 server instance');

      if (!this.config.fallbackToV1) {
        this.v2Instance = await ServerFactory.createV2Server(config, {
          fallbackToV1: false
        });
      } else {
        this.v2Instance = await ServerFactory.createV2Server(config);
      }
    }
    return this.v2Instance;
  }

  /**
   * 切换到V1
   */
  async switchToV1(config: ServerConfig): Promise<SwitchResult> {
    return this.switchVersion('v1', config);
  }

  /**
   * 切换到V2
   */
  async switchToV2(config: ServerConfigV2): Promise<SwitchResult> {
    return this.switchVersion('v2', config);
  }

  /**
   * 执行版本切换
   */
  private async switchVersion(
    targetVersion: 'v1' | 'v2',
    config: ServerConfig | ServerConfigV2
  ): Promise<SwitchResult> {
    const fromVersion = this.currentVersion;
    const timestamp = Date.now();

    console.log(`[VersionSelector] Switching from ${fromVersion} to ${targetVersion}`);

    // 检查是否允许运行时切换
    if (!this.config.allowRuntimeSwitch) {
      const error = 'Runtime switching is disabled';
      console.error(`[VersionSelector] ${error}`);
      return {
        success: false,
        fromVersion,
        toVersion: targetVersion,
        message: error,
        timestamp
      };
    }

    try {
      // 检查目标版本是否可用
      const targetInfo = await this.getVersionInfo(targetVersion, config);
      if (targetInfo.status !== 'available') {
        const error = `Target version ${targetVersion} is not available: ${targetInfo.error}`;
        console.error(`[VersionSelector] ${error}`);
        return {
          success: false,
          fromVersion,
          toVersion: targetVersion,
          message: error,
          timestamp
        };
      }

      // 停止当前实例
      if (this.currentVersion === 'v1' && this.v1Instance) {
        if (this.v1Instance.isRunning()) {
          await this.v1Instance.stop();
          console.log('[VersionSelector] V1 server stopped');
        }
      } else if (this.currentVersion === 'v2' && this.v2Instance) {
        if (this.v2Instance.isRunning()) {
          await this.v2Instance.stop();
          console.log('[VersionSelector] V2 server stopped');
        }
      }

      // 切换版本
      this.currentVersion = targetVersion;

      // 记录切换历史
      const switchResult: SwitchResult = {
        success: true,
        fromVersion,
        toVersion: targetVersion,
        message: `Successfully switched from ${fromVersion} to ${targetVersion}`,
        timestamp
      };

      this.switchHistory.push(switchResult);
      console.log(`[VersionSelector] Successfully switched to ${targetVersion}`);

      return switchResult;

    } catch (error) {
      const errorMessage = `Failed to switch from ${fromVersion} to ${targetVersion}: ${(error as Error).message}`;
      console.error(`[VersionSelector] ${errorMessage}`);

      const switchResult: SwitchResult = {
        success: false,
        fromVersion,
        toVersion: targetVersion,
        message: errorMessage,
        timestamp
      };

      this.switchHistory.push(switchResult);
      return switchResult;
    }
  }

  /**
   * 获取版本信息
   */
  async getVersionInfo(
    version: 'v1' | 'v2',
    config?: ServerConfig | ServerConfigV2
  ): Promise<VersionInfo> {
    try {
      if (version === 'v1') {
        if (!this.v1Instance && config) {
          await this.getV1Server(config as ServerConfig);
        }

        if (this.v1Instance) {
          return {
            version: 'v1',
            status: 'available',
            initialized: this.v1Instance.isInitialized(),
            running: this.v1Instance.isRunning(),
            uptime: this.v1Instance.getStatus()?.uptime
          };
        } else {
          return {
            version: 'v1',
            status: 'unavailable',
            initialized: false,
            running: false,
            error: 'V1 instance not created'
          };
        }
      } else {
        if (!this.v2Instance && config) {
          await this.getV2Server(config as ServerConfigV2);
        }

        if (this.v2Instance) {
          const status = this.v2Instance.getStatus();
          return {
            version: 'v2',
            status: 'available',
            initialized: this.v2Instance.isInitialized(),
            running: this.v2Instance.isRunning(),
            uptime: status.uptime,
            port: status.port
          };
        } else {
          return {
            version: 'v2',
            status: 'unavailable',
            initialized: false,
            running: false,
            error: 'V2 instance not created'
          };
        }
      }
    } catch (error) {
      return {
        version,
        status: 'error',
        initialized: false,
        running: false,
        error: (error as Error).message
      };
    }
  }

  /**
   * 获取所有版本信息
   */
  async getAllVersionInfo(
    v1Config?: ServerConfig,
    v2Config?: ServerConfigV2
  ): Promise<{ v1: VersionInfo; v2: VersionInfo }> {
    const [v1Info, v2Info] = await Promise.all([
      this.getVersionInfo('v1', v1Config),
      this.getVersionInfo('v2', v2Config)
    ]);

    return { v1: v1Info, v2: v2Info };
  }

  /**
   * 获取当前版本
   */
  getCurrentVersion(): 'v1' | 'v2' {
    return this.currentVersion;
  }

  /**
   * 获取切换历史
   */
  getSwitchHistory(): SwitchResult[] {
    return [...this.switchHistory];
  }

  /**
   * 清理所有实例
   */
  async cleanup(): Promise<void> {
    console.log('[VersionSelector] Cleaning up all instances');

    if (this.v1Instance && this.v1Instance.isRunning()) {
      await this.v1Instance.stop();
    }

    if (this.v2Instance && this.v2Instance.isRunning()) {
      await this.v2Instance.stop();
    }

    ServerFactory.clearInstances();
    this.v1Instance = undefined;
    this.v2Instance = undefined;

    console.log('[VersionSelector] All instances cleaned up');
  }

  /**
   * 健康检查
   */
  async healthCheck(config?: { v1?: ServerConfig; v2?: ServerConfigV2 }): Promise<{
    healthy: boolean;
    currentVersion: string;
    versions: { v1: VersionInfo; v2: VersionInfo };
    issues: string[];
  }> {
    const issues: string[] = [];

    try {
      const versionInfo = await this.getAllVersionInfo(config?.v1, config?.v2);

      // 检查当前版本
      const currentInfo = this.currentVersion === 'v1' ? versionInfo.v1 : versionInfo.v2;
      if (currentInfo.status !== 'available') {
        issues.push(`Current version ${this.currentVersion} is not available: ${currentInfo.error}`);
      }

      // 检查V1
      if (versionInfo.v1.status === 'error') {
        issues.push(`V1 server error: ${versionInfo.v1.error}`);
      }

      // 检查V2
      if (versionInfo.v2.status === 'error') {
        issues.push(`V2 server error: ${versionInfo.v2.error}`);
      }

      return {
        healthy: issues.length === 0,
        currentVersion: this.currentVersion,
        versions: versionInfo,
        issues
      };

    } catch (error) {
      return {
        healthy: false,
        currentVersion: this.currentVersion,
        versions: {
          v1: { version: 'v1', status: 'error', initialized: false, running: false, error: (error as Error).message },
          v2: { version: 'v2', status: 'error', initialized: false, running: false, error: (error as Error).message }
        },
        issues: [`Health check failed: ${(error as Error).message}`]
      };
    }
  }
}

/**
 * 便捷函数：获取版本选择器实例
 */
export function getVersionSelector(config?: VersionSelectorConfig): VersionSelector {
  return VersionSelector.getInstance(config);
}

/**
 * 便捷函数：根据环境变量自动选择版本
 */
export async function createAutoSelectedServer(
  v1Config: ServerConfig,
  v2Config: ServerConfigV2,
  selectorConfig?: VersionSelectorConfig
): Promise<ServerInstance> {
  const selector = getVersionSelector(selectorConfig);

  // 检查环境变量
  const useV2 = process.env.ROUTECODEX_USE_V2 === 'true';

  if (useV2) {
    console.log('[AutoSelect] Using V2 server based on environment variable');
    return await selector.getV2Server(v2Config);
  } else {
    console.log('[AutoSelect] Using V1 server (default)');
    return await selector.getV1Server(v1Config);
  }
}