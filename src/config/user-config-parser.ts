/**
 * User Configuration Parser
 * 解析用户配置为模块格式
 */

import type {
  UserConfig,
  ModuleConfigs,
  RouteTargetPool,
  PipelineConfigs,
  RouteTarget
} from './merged-config-types.js';

export class UserConfigParser {
  /**
   * 解析用户配置
   */
  parseUserConfig(userConfig: UserConfig): {
    routeTargets: RouteTargetPool;
    pipelineConfigs: PipelineConfigs;
    moduleConfigs: ModuleConfigs;
  } {
    const routeTargets = this.parseRouteTargets(userConfig.virtualrouter.routing);
    const pipelineConfigs = this.parsePipelineConfigs(userConfig.virtualrouter);
    const moduleConfigs = this.parseModuleConfigs(userConfig);

    return {
      routeTargets,
      pipelineConfigs,
      moduleConfigs
    };
  }

  /**
   * 解析路由目标池
   */
  private parseRouteTargets(routingConfig: Record<string, string[]>): RouteTargetPool {
    const routeTargets: RouteTargetPool = {};

    for (const [routeName, targets] of Object.entries(routingConfig)) {
      routeTargets[routeName] = targets.map((target: string) => {
        const [providerId, modelId, keyId] = target.split('.');
        return {
          providerId,
          modelId,
          keyId,
          actualKey: this.resolveActualKey(keyId),
          inputProtocol: 'openai', // 从配置中获取
          outputProtocol: 'openai' // 从配置中获取
        };
      });
    }

    return routeTargets;
  }

  /**
   * 解析流水线配置
   */
  private parsePipelineConfigs(virtualRouterConfig: {
  providers: Record<string, {
    type: string;
    baseURL: string;
    apiKey: string[];
    models: Record<string, {
      maxContext?: number;
      maxTokens?: number;
    }>;
  }>;
  inputProtocol: string;
  outputProtocol: string;
}): PipelineConfigs {
    const pipelineConfigs: PipelineConfigs = {};

    for (const [providerId, providerConfig] of Object.entries(virtualRouterConfig.providers)) {
      for (const [modelId, modelConfig] of Object.entries(providerConfig.models)) {
        for (const keyId of providerConfig.apiKey) {
          const configKey = `${providerId}.${modelId}.${keyId}`;
          pipelineConfigs[configKey] = {
            provider: {
              type: providerConfig.type,
              baseURL: providerConfig.baseURL
            },
            model: {
              maxContext: modelConfig.maxContext || 128000,
              maxTokens: modelConfig.maxTokens || 32000
            },
            keyConfig: {
              keyId,
              actualKey: this.resolveActualKey(keyId)
            },
            protocols: {
              input: virtualRouterConfig.inputProtocol as 'openai' | 'anthropic',
              output: virtualRouterConfig.outputProtocol as 'openai' | 'anthropic'
            }
          };
        }
      }
    }

    return pipelineConfigs;
  }

  /**
   * 解析模块配置
   */
  private parseModuleConfigs(userConfig: UserConfig): ModuleConfigs {
    const moduleConfigs: ModuleConfigs = {};

    // 虚拟路由模块配置
    moduleConfigs.virtualrouter = {
      enabled: true,
      config: {
        moduleType: 'virtual-router',
        inputProtocol: userConfig.virtualrouter.inputProtocol,
        outputProtocol: userConfig.virtualrouter.outputProtocol
      }
    };

    // 其他模块配置
    for (const [moduleName, moduleConfig] of Object.entries(userConfig)) {
      if (moduleName !== 'virtualrouter' && moduleName !== 'user' && typeof moduleConfig === 'object') {
        moduleConfigs[moduleName] = {
          enabled: true,
          config: moduleConfig
        };
      }
    }

    return moduleConfigs;
  }

  /**
   * 解析实际密钥
   */
  private resolveActualKey(keyId: string): string {
    if (keyId.startsWith('authfile-')) {
      // TODO: 实现AuthFile解析
      return keyId;
    }
    return keyId;
  }
}
