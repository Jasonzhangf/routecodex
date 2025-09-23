/**
 * User Configuration Parser
 * 解析用户配置为模块格式
 */

import path from 'path';
import { homedir } from 'os';
import type {
  UserConfig,
  ModuleConfigs,
  RouteTargetPool,
  PipelineConfigs,
  RouteTarget
} from './merged-config-types.js';

export class UserConfigParser {
  private providerKeyToAuth: Record<string, Record<string, string>> = {};
  private globalKeyToAuth: Record<string, string> = {};
  private authMappings: Record<string, string> = {};
  private oauthAuthConfigs: Record<string, any> = {};

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
    this.providerKeyToAuth = {};
    this.globalKeyToAuth = {};
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
          actualKey: this.resolveActualKey(providerId, keyId),
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
    compatibility?: { type: string; config?: Record<string, any> };
    llmSwitch?: { type: string; config?: Record<string, any> };
    workflow?: { type: string; config?: Record<string, any>; enabled?: boolean };
    models: Record<string, {
      maxContext?: number;
      maxTokens?: number;
      compatibility?: { type: string; config?: Record<string, any> };
      llmSwitch?: { type: string; config?: Record<string, any> };
      workflow?: { type: string; config?: Record<string, any>; enabled?: boolean };
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
          const resolvedKey = this.resolveActualKey(providerId, keyId);
          const hasAuthMapping = this.hasAuthMapping(providerId, keyId);
          // compatibility selection: model-level overrides provider-level
          const modelCompat = (modelConfig as any)?.compatibility;
          const providerCompat = (providerConfig as any)?.compatibility;
          let compatibility = modelCompat?.type
            ? { type: modelCompat.type, config: modelCompat.config || {} }
            : providerCompat?.type
              ? { type: providerCompat.type, config: providerCompat.config || {} }
              : undefined;

          const modelLlmSwitch = (modelConfig as any)?.llmSwitch;
          const providerLlmSwitch = (providerConfig as any)?.llmSwitch;
          let llmSwitch = modelLlmSwitch?.type
            ? { type: modelLlmSwitch.type, config: modelLlmSwitch.config || {} }
            : providerLlmSwitch?.type
              ? { type: providerLlmSwitch.type, config: providerLlmSwitch.config || {} }
              : undefined;

          const modelWorkflow = (modelConfig as any)?.workflow;
          const providerWorkflow = (providerConfig as any)?.workflow;
          let workflow = modelWorkflow?.type
            ? { type: modelWorkflow.type, config: modelWorkflow.config || {}, enabled: modelWorkflow.enabled }
            : providerWorkflow?.type
              ? { type: providerWorkflow.type, config: providerWorkflow.config || {}, enabled: providerWorkflow.enabled }
              : undefined;

          // Defaults: ensure assembler-required modules exist
          if (!llmSwitch) {
            llmSwitch = { type: 'openai-passthrough', config: {} };
          }
          if (!workflow) {
            workflow = { type: 'streaming-control', enabled: true, config: {} } as any;
          }
          if (!compatibility) {
            // Try to infer from provider type
            const pType = (providerConfig as any)?.type?.toLowerCase?.() || '';
            if (pType.includes('lmstudio')) {
              compatibility = { type: 'lmstudio-compatibility', config: {} };
            } else if (pType.includes('qwen')) {
              compatibility = { type: 'qwen-compatibility', config: {} } as any;
            } else {
              // Fallback generic mapping
              compatibility = { type: 'field-mapping', config: {} } as any;
            }
          }
            // Normalize provider type to registered module types
            const rawProviderType = (providerConfig.type || '').toLowerCase();
            const normalizedProviderType = rawProviderType === 'lmstudio' ? 'lmstudio-http'
              : rawProviderType === 'qwen' ? 'qwen-provider'
              : rawProviderType === 'iflow' || rawProviderType === 'iflow-http' ? 'generic-http'
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
                    tokenFile: oc.tokenFile
                  }
                };
              }
            }
            // LM Studio HTTP provider expects http(s) baseURL to REST API (e.g., http://<host>:1234)

            // Optional auth for LM Studio HTTP (may be keyless; presence required by provider)
            const auth = normalizedProviderType === 'lmstudio-http'
              ? ({ type: 'apikey', ...(hasAuthMapping ? { apiKey: resolvedKey } : {}) })
              : undefined;

            pipelineConfigs[configKey] = {
              provider: {
                type: normalizedProviderType,
                baseURL,
                ...(providerAuth ? { auth: providerAuth } : {}),
                ...(auth ? { auth } : {})
              },
              model: {
                maxContext: modelConfig.maxContext || 128000,
                maxTokens: modelConfig.maxTokens || 32000
              },
              keyConfig: {
                keyId,
                actualKey: resolvedKey,
                keyType: hasAuthMapping ? 'authFile' : 'apiKey'
              },
              protocols: {
                input: virtualRouterConfig.inputProtocol as 'openai' | 'anthropic',
                output: virtualRouterConfig.outputProtocol as 'openai' | 'anthropic'
              },
            compatibility,
            llmSwitch,
            workflow
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
   * 支持静态auth文件和OAuth配置
   */
  private parseAuthMappings(virtualRouterConfig: {
    providers: Record<string, {
      type: string;
      baseURL: string;
      apiKey: string[];
      auth?: Record<string, string>;
      oauth?: Record<string, any>;
      models: Record<string, {
        maxContext?: number;
        maxTokens?: number;
      }>;
    }>;
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
      const tokenCandidate = oauthConfig.tokens.find((token: unknown) => typeof token === 'string' && token.trim());
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
}
