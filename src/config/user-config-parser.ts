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
  private keyToAuthMapping: Record<string, string> = {};
  private authMappings: Record<string, string> = {};

  /**
   * 解析用户配置
   */
  parseUserConfig(userConfig: UserConfig): {
    routeTargets: RouteTargetPool;
    pipelineConfigs: PipelineConfigs;
    authMappings: Record<string, string>;
    moduleConfigs: ModuleConfigs;
  } {
    this.authMappings = this.parseAuthMappings(userConfig.virtualrouter);
    const routeTargets = this.parseRouteTargets(userConfig.virtualrouter.routing);
    const pipelineConfigs = this.parsePipelineConfigs(userConfig.virtualrouter);
    const moduleConfigs = this.parseModuleConfigs(userConfig);

    const result = {
      routeTargets,
      pipelineConfigs,
      authMappings: this.authMappings,
      moduleConfigs
    };

    // Clear the mapping for next parsing
    this.keyToAuthMapping = {};
    return result;
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
              actualKey: this.resolveActualKey(keyId),
              keyType: this.keyToAuthMapping[keyId] ? 'authFile' : 'apiKey'
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
   * 解析Auth映射
   */
  private parseAuthMappings(virtualRouterConfig: {
    providers: Record<string, {
      type: string;
      baseURL: string;
      apiKey: string[];
      auth?: Record<string, string>;
      models: Record<string, {
        maxContext?: number;
        maxTokens?: number;
      }>;
    }>;
  }): Record<string, string> {
    const authMappings: Record<string, string> = {};

    for (const [providerId, providerConfig] of Object.entries(virtualRouterConfig.providers)) {
      if (providerConfig.auth) {
        for (const [authName, authPath] of Object.entries(providerConfig.auth)) {
          // 生成唯一的auth id: auth-<name> 或 auth-<name>-<index>处理重名
          let authId = `auth-${authName}`;
          let counter = 1;

          while (authMappings[authId]) {
            authId = `auth-${authName}-${counter}`;
            counter++;
          }

          authMappings[authId] = authPath;

          // 建立key name到auth id的映射
          this.keyToAuthMapping[authName] = authId;
        }
      }
    }

    return authMappings;
  }

  /**
   * 解析实际密钥
   */
  private resolveActualKey(keyId: string): string {
    // auth ids直接返回，运行时通过auth映射解析
    if (keyId.startsWith('auth-')) {
      return keyId;
    }

    // 检查是否在keyToAuthMapping中
    const authId = this.keyToAuthMapping[keyId];
    if (authId) {
      return authId;
    }

    return keyId;
  }
}
