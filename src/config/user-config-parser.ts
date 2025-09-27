/**
 * User Configuration Parser
 * 解析用户配置为模块格式
 */

import path from 'path';
import fs from 'fs';
import { homedir } from 'os';
import type {
  UserConfig,
  ModuleConfigs,
  RouteTargetPool,
  PipelineConfigs,
} from './merged-config-types.js';

export class UserConfigParser {
  private providerKeyToAuth: Record<string, Record<string, string>> = {};
  private globalKeyToAuth: Record<string, string> = {};
  private authMappings: Record<string, string> = {};
  private oauthAuthConfigs: Record<string, any> = {};
  private providerConfigs: Record<string, any> = {};

  /**
   * Expand simple env placeholders like ${VAR} or $VAR.
   * If env is not set, returns the original string unchanged.
   */
  private expandEnvVar(value: unknown): string {
    if (typeof value !== 'string') {return '';}
    const trimmed = value.trim();
    const m = trimmed.match(/^\$\{?([A-Za-z0-9_]+)\}?$/);
    if (!m) {return trimmed;}
    const envName = m[1];
    const envVal = process.env[envName];
    if (typeof envVal === 'string' && envVal.length > 0) {
      return envVal;
    }
    return trimmed;
  }

  /**
   * 解析用户配置
   */
  parseUserConfig(userConfig: UserConfig): {
    routeTargets: RouteTargetPool;
    pipelineConfigs: PipelineConfigs;
    authMappings: Record<string, string>;
    moduleConfigs: ModuleConfigs;
  } {
    this.providerKeyToAuth = {};
    this.globalKeyToAuth = {};
    this.oauthAuthConfigs = {};
    this.providerConfigs = userConfig.virtualrouter?.providers || {};
    this.authMappings = this.parseAuthMappings(userConfig.virtualrouter);
    const routeTargets = this.parseRouteTargets(userConfig.virtualrouter.routing);
    const pipelineConfigs = this.parsePipelineConfigs(userConfig.virtualrouter, userConfig);
    const moduleConfigs = this.parseModuleConfigs(userConfig);

    const result = {
      routeTargets,
      pipelineConfigs,
      authMappings: this.authMappings,
      moduleConfigs,
    };

    // Clear the mapping for next parsing
    this.providerKeyToAuth = {};
    this.globalKeyToAuth = {};
    return result;
  }

  /**
   * 解析路由目标池 - 全别名化版本
   * 所有key都使用别名，不再使用真实key
   */
  private parseRouteTargets(routingConfig: Record<string, string[]>): RouteTargetPool {
    const routeTargets: RouteTargetPool = {};

    for (const [routeName, targets] of Object.entries(routingConfig)) {
      routeTargets[routeName] = [];

      targets.forEach((target: string) => {
        // 更智能的解析：先找到provider，然后找到model，剩下的就是key别名
        const firstDotIndex = target.indexOf('.');
        if (firstDotIndex === -1) {
          throw new Error(`Invalid route target format: ${target}`);
        }

        const providerId = target.substring(0, firstDotIndex);
        const remaining = target.substring(firstDotIndex + 1);

        // 检查是否有provider配置
        const providerConfig = this.providerConfigs[providerId];
        if (!providerConfig) {
          throw new Error(`Unknown provider: ${providerId}`);
        }

        // 在剩余的字符串中找到model部分
        let modelId = '';
        let keyAlias = '';

        // 尝试匹配已知的model名称 - 按长度降序排序，优先匹配更长的model名称
        const knownModels = Object.keys(providerConfig.models || {});
        let foundModel = null;

        // 按长度降序排序，确保"glm-4.5"在"glm-4"之前被检查
        const sortedModels = knownModels.sort((a, b) => b.length - a.length);

        for (const model of sortedModels) {
          if (remaining.startsWith(`${model}.`) || remaining === model) {
            foundModel = model;
            break;
          }
        }

        // 调试输出
        if (providerId === 'glm') {
          console.log(`[DEBUG] GLM parsing - remaining: "${remaining}", knownModels:`, knownModels);
          console.log(`[DEBUG] GLM parsing - foundModel: "${foundModel}"`);
        }

        if (foundModel) {
          modelId = foundModel;
          const afterModel = remaining.substring(modelId.length);
          // 只有当剩余部分以点开头且后面还有内容时才提取key alias
          if (afterModel.startsWith('.') && afterModel.length > 1) {
            const possibleKeyAlias = afterModel.substring(1);
            // 检查是否是有效的key alias格式（key1, key2等）
            if (possibleKeyAlias.match(/^key\d+$/)) {
              keyAlias = possibleKeyAlias;
            }
            // 否则忽略，认为是模型名称的一部分
          }
        } else {
          // 如果没有找到已知model，使用简单的启发式方法
          // 假设最后一个点后面的是key，前面的是model
          const lastDotIndex = remaining.lastIndexOf('.');
          if (lastDotIndex === -1) {
            // 没有key部分，整个剩余的都是model
            modelId = remaining;
            keyAlias = '';
          } else {
            modelId = remaining.substring(0, lastDotIndex);
            keyAlias = remaining.substring(lastDotIndex + 1);
          }
        }

        // 支持两种格式：
        // 1. provider.model → 展开为所有key（使用顺序别名：key1, key2...）
        // 2. provider.model.key1/key2 → 使用指定顺序别名
        if (!keyAlias) {
          // provider.model格式：展开为所有key（使用顺序别名）
          const keyAliases = this.getProviderKeyAliases(providerId);

          // 为每个key生成顺序别名目标
          keyAliases.forEach(keyAlias => {
            routeTargets[routeName].push({
              providerId,
              modelId,
              keyId: keyAlias, // 使用顺序别名（key1, key2...）
              actualKey: this.resolveActualKey(
                providerId,
                this.resolveKeyByAlias(providerId, keyAlias)
              ),
              inputProtocol: 'openai',
              outputProtocol: 'openai',
            });
          });
        } else {
          // provider.model.key1/key2格式：使用指定顺序别名
          // 验证顺序别名是否有效
          const realKey = this.resolveKeyByAlias(providerId, keyAlias);

          routeTargets[routeName].push({
            providerId,
            modelId,
            keyId: keyAlias, // 使用顺序别名
            actualKey: this.resolveActualKey(providerId, realKey),
            inputProtocol: 'openai',
            outputProtocol: 'openai',
          });
        }
      });
    }

    return routeTargets;
  }

  /**
   * 解析流水线配置
   */
  private parsePipelineConfigs(
    virtualRouterConfig: {
      providers: Record<
        string,
        {
          type: string;
          baseURL: string;
          apiKey: string[];
          compatibility?: { type: string; config?: Record<string, any> };
          llmSwitch?: { type: string; config?: Record<string, any> };
          workflow?: { type: string; config?: Record<string, any>; enabled?: boolean };
          models: Record<
            string,
            {
              maxContext?: number;
              maxTokens?: number;
              compatibility?: { type: string; config?: Record<string, any> };
              llmSwitch?: { type: string; config?: Record<string, any> };
              workflow?: { type: string; config?: Record<string, any>; enabled?: boolean };
            }
          >;
        }
      >;
      inputProtocol: string;
      outputProtocol: string;
    },
    userConfig: UserConfig
  ): PipelineConfigs {
    const pipelineConfigs: PipelineConfigs = {};

    for (const [providerId, providerConfig] of Object.entries(virtualRouterConfig.providers)) {
      for (const [modelId, modelConfig] of Object.entries(providerConfig.models)) {
        // 为每个key别名创建配置（使用顺序别名：key1, key2...）
        const keyAliases = this.getProviderKeyAliases(providerId);
        for (const keyAlias of keyAliases) {
          const configKey = `${providerId}.${modelId}.${keyAlias}`; // 使用key别名作为配置键
          const realKey = this.resolveKeyByAlias(providerId, keyAlias); // 解析真实key
          const resolvedKey = this.resolveActualKey(providerId, realKey);
          const hasAuthMapping = this.hasAuthMapping(providerId, realKey);
          const apiKeyValue = this.resolveApiKeyValue(
            providerId,
            realKey,
            resolvedKey,
            hasAuthMapping
          );
          // compatibility selection: user config > model-level > provider-level > auto-infer
          const modelCompat = (modelConfig as any)?.compatibility;
          const providerCompat = (providerConfig as any)?.compatibility;
          let compatibility = undefined;

          // First check user config compatibility field (simple string format)
          const userCompat = (userConfig as any)?.compatibility;
          if (userCompat && typeof userCompat === 'string') {
            compatibility = this.parseCompatibilityString(userCompat);
          } else if (modelCompat?.type) {
            // Then check model-level compatibility
            compatibility = { type: modelCompat.type, config: modelCompat.config || {} };
          } else if (providerCompat?.type) {
            // Then check provider-level compatibility
            compatibility = { type: providerCompat.type, config: providerCompat.config || {} };
          }

          const modelLlmSwitch = (modelConfig as any)?.llmSwitch;
          const providerLlmSwitch = (providerConfig as any)?.llmSwitch;
          const llmSwitch = modelLlmSwitch?.type
            ? { type: modelLlmSwitch.type, config: modelLlmSwitch.config || {} }
            : providerLlmSwitch?.type
              ? { type: providerLlmSwitch.type, config: providerLlmSwitch.config || {} }
              : undefined;

          const modelWorkflow = (modelConfig as any)?.workflow;
          const providerWorkflow = (providerConfig as any)?.workflow;
          const workflow = modelWorkflow?.type
            ? {
                type: modelWorkflow.type,
                config: modelWorkflow.config || {},
                enabled: modelWorkflow.enabled,
              }
            : providerWorkflow?.type
              ? {
                  type: providerWorkflow.type,
                  config: providerWorkflow.config || {},
                  enabled: providerWorkflow.enabled,
                }
              : undefined;

          // 不再在解析层推断compatibility/llmSwitch/workflow默认值，交由装配阶段按规则决定
          // Normalize provider type to registered module types
          const rawProviderType = (providerConfig.type || '').toLowerCase();
          const normalizedProviderType =
            rawProviderType === 'lmstudio'
              ? 'lmstudio-http'
              : rawProviderType === 'qwen'
                ? 'qwen-provider'
                : rawProviderType === 'openai'
                  ? 'openai-provider'
                  : rawProviderType === 'iflow' || rawProviderType === 'iflow-http'
                    ? 'generic-http'
                    : providerConfig.type;

          // Normalize baseURL for LM Studio: http(s) -> ws(s)
          let baseURL = providerConfig.baseURL;
          if (normalizedProviderType === 'lmstudio-http') {
            const envBase = process.env.LMSTUDIO_BASE_URL || process.env.LM_STUDIO_BASE_URL;
            if (envBase && typeof envBase === 'string' && envBase.trim()) {
              baseURL = envBase.trim();
            }
          }

          // Build provider auth block per provider type (independent, configurable)
          let providerAuth: any = undefined;
          // LM Studio HTTP: optional apikey structure; may be keyless
          if (normalizedProviderType === 'lmstudio-http') {
            providerAuth = { type: 'apikey' };
          }
          // OpenAI provider: uses bearer token auth
          if (normalizedProviderType === 'openai-provider') {
            providerAuth = { type: 'bearer' };
          }
          // Qwen provider: prefers OAuth; read from provider-level oauth if present
          if (normalizedProviderType === 'qwen-provider') {
            const oauthCfg = (providerConfig as any).oauth || (providerConfig as any).auth?.oauth;
            if (oauthCfg && typeof oauthCfg === 'object') {
              const oc = (oauthCfg as any).default || oauthCfg;
              providerAuth = {
                type: 'oauth',
                oauth: {
                  clientId: oc.clientId,
                  deviceCodeUrl: oc.deviceCodeUrl,
                  tokenUrl: oc.tokenUrl,
                  scopes: oc.scopes,
                  tokenFile: oc.tokenFile,
                },
              };
            }
          }
          // LM Studio HTTP provider expects http(s) baseURL to REST API (e.g., http://<host>:1234)

          // Optional auth for providers that need API key
          const auth =
            normalizedProviderType === 'lmstudio-http' ||
            normalizedProviderType === 'openai-provider'
              ? { type: 'apikey', ...(apiKeyValue ? { apiKey: apiKeyValue } : {}) }
              : undefined;

          pipelineConfigs[configKey] = {
            provider: {
              type: normalizedProviderType,
              baseURL,
              ...(providerAuth ? { auth: providerAuth } : {}),
              ...(auth ? { auth } : {}),
            },
            model: {
              maxContext: modelConfig.maxContext || 128000,
              maxTokens: modelConfig.maxTokens || 32000,
            },
            keyConfig: {
              keyId: keyAlias, // 使用key别名
              actualKey: resolvedKey,
              keyType: hasAuthMapping ? 'authFile' : 'apiKey',
            },
            protocols: {
              input: virtualRouterConfig.inputProtocol as 'openai' | 'anthropic',
              output: virtualRouterConfig.outputProtocol as 'openai' | 'anthropic',
            },
            // 保留用户显式提供的模块配置；缺省值在装配阶段应用
            ...(compatibility ? { compatibility } : {}),
            ...(llmSwitch ? { llmSwitch } : {}),
            ...(workflow ? { workflow } : {}),
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
        outputProtocol: userConfig.virtualrouter.outputProtocol,
      },
    };

    // HTTP服务器模块配置 - 处理简单端口配置
    if (userConfig.port) {
      moduleConfigs.httpserver = {
        enabled: true,
        config: {
          port: userConfig.port,
        },
      };
    }

    // 其他模块配置
    for (const [moduleName, moduleConfig] of Object.entries(userConfig)) {
      if (
        moduleName !== 'virtualrouter' &&
        moduleName !== 'httpserver' &&
        moduleName !== 'port' &&
        moduleName !== 'user' &&
        typeof moduleConfig === 'object'
      ) {
        moduleConfigs[moduleName] = {
          enabled: true,
          config: moduleConfig,
        };
      }
    }

    return moduleConfigs;
  }

  /**
   * 解析简单字符串格式的compatibility字段
   * 支持 "iflow/qwen/lmstudio" 或 "passthrough" 格式
   */
  private parseCompatibilityString(compatString: string): {
    type: string;
    config: Record<string, any>;
  } {
    if (!compatString || compatString.trim() === '' || compatString === 'passthrough') {
      return { type: 'passthrough-compatibility', config: {} };
    }

    const types = compatString.split('/').map(t => t.trim().toLowerCase());
    const primaryType = types[0];

    const typeMap: Record<string, string> = {
      lmstudio: 'lmstudio-compatibility',
      qwen: 'qwen-compatibility',
      iflow: 'iflow-compatibility',
      passthrough: 'passthrough-compatibility',
      'field-mapping': 'field-mapping',
    };

    return {
      type: typeMap[primaryType] || 'passthrough-compatibility',
      config: {},
    };
  }

  /**
   * 解析Auth映射
   * 支持静态auth文件和OAuth配置
   */
  private parseAuthMappings(virtualRouterConfig: {
    providers: Record<
      string,
      {
        type: string;
        baseURL: string;
        apiKey: string[];
        auth?: Record<string, string>;
        oauth?: Record<string, any>;
        models: Record<
          string,
          {
            maxContext?: number;
            maxTokens?: number;
          }
        >;
      }
    >;
  }): Record<string, string> {
    const authMappings: Record<string, string> = {};

    for (const [providerId, providerConfig] of Object.entries(virtualRouterConfig.providers)) {
      // 处理传统auth文件映射
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

          if (!this.providerKeyToAuth[providerId]) {
            this.providerKeyToAuth[providerId] = {};
          }
          this.providerKeyToAuth[providerId][authName] = authId;

          if (!this.globalKeyToAuth[authName]) {
            this.globalKeyToAuth[authName] = authId;
          }
        }
      }

      // 处理OAuth配置 - 为每个OAuth配置创建虚拟auth映射
      if (providerConfig.oauth) {
        for (const [oauthName, oauthConfig] of Object.entries(providerConfig.oauth)) {
          const oauthAuthId = `auth-${providerId}-${oauthName}`;
          const tokenPath = this.resolveOAuthTokenPath(providerId, oauthName, oauthConfig);

          authMappings[oauthAuthId] = tokenPath;
          this.oauthAuthConfigs[oauthAuthId] = this.normalizeOAuthConfig(oauthConfig);

          if (!this.providerKeyToAuth[providerId]) {
            this.providerKeyToAuth[providerId] = {};
          }
          this.providerKeyToAuth[providerId][oauthName] = oauthAuthId;

          if (!this.globalKeyToAuth[oauthName]) {
            this.globalKeyToAuth[oauthName] = oauthAuthId;
          }
        }
      }
    }

    return authMappings;
  }

  /**
   * 解析实际密钥
   * 支持静态auth文件和OAuth配置
   */
  private hasAuthMapping(providerId: string, keyId: string): boolean {
    if (keyId.startsWith('auth-')) {
      return true;
    }

    const providerMapping = this.providerKeyToAuth[providerId]?.[keyId];
    if (providerMapping) {
      return true;
    }

    return Boolean(this.globalKeyToAuth[keyId]);
  }

  private resolveApiKeyValue(
    providerId: string,
    keyId: string,
    resolvedKey: string,
    hasAuthMapping: boolean
  ): string | undefined {
    if (!resolvedKey) {
      return undefined;
    }
    const expandedKey = this.expandEnvVar(resolvedKey);

    if (!hasAuthMapping) {
      return expandedKey;
    }

    const authId = this.resolveActualKey(providerId, keyId);
    if (!authId) {
      return expandedKey;
    }

    const authPath = this.authMappings[authId];
    if (!authPath) {
      return expandedKey;
    }

    const normalizedPath = authPath.startsWith('~')
      ? path.join(homedir(), authPath.slice(1))
      : authPath;

    try {
      if (fs.existsSync(normalizedPath)) {
        const fileContent = fs.readFileSync(normalizedPath, 'utf-8').trim();
        if (fileContent) {
          return fileContent;
        }
      }
    } catch (error) {
      console.warn(`Failed to read auth file ${normalizedPath}:`, error);
    }

    // If file not available or unreadable, fall back to expanded inline key
    return expandedKey;
  }

  private resolveActualKey(providerId: string, keyId: string): string {
    if (keyId.startsWith('auth-')) {
      return keyId;
    }

    const providerMapping = this.providerKeyToAuth[providerId]?.[keyId];
    if (providerMapping) {
      return providerMapping;
    }

    const globalMapping = this.globalKeyToAuth[keyId];
    if (globalMapping) {
      return globalMapping;
    }

    return keyId;
  }

  /**
   * 检查是否为OAuth配置
   */
  isOAuthConfig(providerId: string, keyId: string): boolean {
    const authId = this.resolveActualKey(providerId, keyId);
    return Boolean(this.oauthAuthConfigs[authId]);
  }

  /**
   * 获取OAuth配置信息
   */
  getOAuthConfig(providerId: string, keyId: string): any {
    const authId = this.resolveActualKey(providerId, keyId);
    if (!this.isOAuthConfig(providerId, keyId)) {
      return null;
    }

    const authMapping = this.authMappings[authId];
    if (!authMapping) {
      return null;
    }

    return this.oauthAuthConfigs[authId] || null;
  }

  /**
   * 获取OAuth提供者ID
   */
  getOAuthProviderId(providerId: string, keyId: string): string | null {
    const authId = this.resolveActualKey(providerId, keyId);
    if (!this.isOAuthConfig(providerId, keyId)) {
      return null;
    }

    const parts = authId.split('-');
    return parts.length >= 3 ? parts[1] : null;
  }

  /**
   * Resolve OAuth token file path from configuration
   */
  private resolveOAuthTokenPath(providerId: string, oauthName: string, oauthConfig: any): string {
    if (oauthConfig && typeof oauthConfig.tokenFile === 'string' && oauthConfig.tokenFile.trim()) {
      const rawPath = oauthConfig.tokenFile.trim();
      if (rawPath.startsWith('~')) {
        return path.join(homedir(), rawPath.slice(1));
      }
      return rawPath;
    }

    if (oauthConfig && Array.isArray(oauthConfig.tokens) && oauthConfig.tokens.length > 0) {
      const tokenCandidate = oauthConfig.tokens.find(
        (token: unknown) => typeof token === 'string' && token.trim()
      );
      if (typeof tokenCandidate === 'string') {
        return tokenCandidate.trim();
      }
    }

    // Fallback defaults per provider family
    const home = homedir();
    if (providerId.toLowerCase().includes('qwen')) {
      return path.join(home, '.qwen', 'oauth_creds.json');
    }

    if (providerId.toLowerCase().includes('iflow')) {
      return path.join(home, '.iflow', 'oauth_creds.json');
    }

    // Generic fallback under .routecodex/tokens
    return path.join(home, '.routecodex', 'tokens', `${providerId}-${oauthName}.json`);
  }

  private normalizeOAuthConfig(oauthConfig: unknown): any {
    if (!oauthConfig || typeof oauthConfig !== 'object') {
      return { value: oauthConfig };
    }

    try {
      return JSON.parse(JSON.stringify(oauthConfig));
    } catch {
      return { ...oauthConfig };
    }
  }

  /**
   * 获取provider的key别名映射
   * 自动生成顺序别名：key1, key2, key3... 映射到真实key
   * 同时支持用户自定义别名
   */
  private getKeyAliasMapping(providerId: string): Record<string, string> {
    const providerConfig = this.providerConfigs[providerId];
    if (!providerConfig || !providerConfig.apiKey) {
      return { key1: 'default' }; // 默认fallback
    }

    const mapping: Record<string, string> = {};

    // 为每个真实key生成顺序别名：key1, key2, key3...
    providerConfig.apiKey.forEach((realKey: string, index: number) => {
      const alias = `key${index + 1}`;
      // Support env placeholders like ${VAR} or $VAR
      mapping[alias] = this.expandEnvVar(realKey);
    });

    return mapping;
  }

  /**
   * 获取provider的所有key别名（顺序别名）
   */
  private getProviderKeyAliases(providerId: string): string[] {
    const mapping = this.getKeyAliasMapping(providerId);
    return Object.keys(mapping);
  }

  /**
   * 通过别名解析真实key
   */
  private resolveKeyByAlias(providerId: string, keyAlias: string): string {
    const mapping = this.getKeyAliasMapping(providerId);
    const realKey = mapping[keyAlias];

    if (!realKey) {
      throw new Error(
        `Key alias '${keyAlias}' not found for provider '${providerId}'. Available aliases: ${Object.keys(mapping).join(', ')}`
      );
    }

    return realKey;
  }
}
