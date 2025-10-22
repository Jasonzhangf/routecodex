/**
 * RouteCodex Configuration Compatibility Engine
 * Main compatibility layer that preserves existing normalization logic
 */

import { ConfigParser } from 'routecodex-config-engine';
import {
  CompatibilityConfig,
  CompatibilityOptions,
  CompatibilityResult,
  CompatibilityWarning,
  RouteTargetPool,
  PipelineConfigs,
  ModuleConfigs,
  AuthMappings,
  KeyMappings
} from './types/compatibility-types.js';

/**
 * Expands environment variables in a string
 * Replaces ${VAR_NAME} patterns with process.env values
 */
function expandEnvVar(str: string): string {
  if (typeof str !== 'string') {
    return str;
  }

  return str.replace(/\$\{([^}]+)\}/g, (match, envVar) => {
    const envValue = process.env[envVar];
    return envValue !== undefined ? envValue : match;
  });
}

import {
  getProviderKeyAliases,
  resolveKeyByAlias,
  parseRouteTarget,
  buildKeyMappings,
  resolveActualKey,
  resolveOAuthTokenPath,
  normalizeOAuthConfig
} from './normalization/key-alias-normalization.js';
import { getDefaultLLMSwitchType } from './normalization/provider-normalization.js';
import {
  DirectApiKeyConfig,
  ConfigValidationResult
} from './utils/direct-api-key-config.js';
import {
  normalizeProviderType,
  applyProviderTransformations,
  normalizeLLMSwitchType
} from './normalization/provider-normalization.js';
import {
  stableSortObject,
  sortProviders,
  sortRouting,
  sortKeyMappings
} from './utils/stable-sort.js';
// import {
//   mergeThinkingConfig,
//   mergeGLMThinkingConfig,
//   extractThinkingConfig
// } from './normalization/thinking-config-normalization.js';
import {
  parseCompatibilityString,
  normalizeCompatibilityType
} from './normalization/compatibility-string-normalization.js';

export class CompatibilityEngine {
  private configParser: ConfigParser;
  private options: CompatibilityOptions;

  constructor(options: CompatibilityOptions = {}) {
    this.configParser = new ConfigParser(undefined, { sanitizeOutput: options.sanitizeOutput !== false });
    this.options = {
      expandEnvVars: false, // Default to disabled - direct API key configuration preferred
      normalizeProviderTypes: true,
      generateKeyAliases: true,
      processOAuth: true,
      sanitizeOutput: true,
      ...options
    };
  }

  /**
   * Parse and apply compatibility transformations to configuration
   */
  async processCompatibility(
    configString: string,
    _configPath?: string
  ): Promise<CompatibilityResult> {
    // Preprocess configuration to handle legacy format before validation
    const rawConfig = JSON.parse(configString);
    const preprocessedConfig = this.preprocessLegacyConfig(rawConfig);

    // First, parse with config-engine for basic validation
    const validationResult = await this.configParser.parseFromString(JSON.stringify(preprocessedConfig));

    if (!validationResult.isValid) {
      return {
        ...validationResult,
        compatibilityWarnings: []
      };
    }

    // Validate API key configuration patterns
    const config = validationResult.normalized || preprocessedConfig;
    const apiKeyValidation = DirectApiKeyConfig.validateConfig(config);

    // Add API key validation warnings to compatibility warnings
    const additionalWarnings: CompatibilityWarning[] = apiKeyValidation.warnings.map(warning => ({
      code: 'API_KEY_VALIDATION',
      message: warning,
      path: '',
      severity: 'warn' as const,
      details: {
        validationType: 'direct-api-key',
        recommendations: this.generateApiKeyRecommendations(apiKeyValidation)
      }
    }));

    // Apply compatibility transformations
    const compatibilityResult = await this.applyCompatibilityTransformations(config);

    // Merge API key validation warnings
    return {
      ...compatibilityResult,
      compatibilityWarnings: [
        ...compatibilityResult.compatibilityWarnings,
        ...additionalWarnings
      ]
    };
  }

  /**
   * Generate API key configuration recommendations
   */
  private generateApiKeyRecommendations(validation: ConfigValidationResult): string[] {
    const recommendations: string[] = [];

    if (validation.apiKeys.envVars > 0) {
      recommendations.push(
        'Environment variable usage detected. Consider migrating to direct API key configuration for better security and maintainability.',
        'Use the DirectApiKeyConfig.migrateConfigFile() utility to automate migration.'
      );
    }

    if (validation.apiKeys.invalid > 0) {
      recommendations.push(
        'Some API keys appear to have invalid formats. Please verify your API keys are correct.',
        'Invalid API keys will cause authentication failures with AI providers.'
      );
    }

    if (validation.apiKeys.direct > 0 && validation.apiKeys.envVars === 0) {
      recommendations.push(
        '✅ Configuration uses direct API keys - this is the recommended approach.'
      );
    }

    return recommendations;
  }

  /**
   * Apply all compatibility transformations
   */
  private async applyCompatibilityTransformations(
    config: any
  ): Promise<CompatibilityResult> {
    const warnings: CompatibilityWarning[] = [];

    // Apply normalizations first to ensure correct structure
    const normalizedConfig = this.applyAllNormalizations(config, warnings);

    const keyMappings = sortKeyMappings(buildKeyMappings(normalizedConfig.virtualrouter?.providers || {})) as KeyMappings;
    const authMappings = this.buildAuthMappings(normalizedConfig.virtualrouter?.providers || {});
    const routeTargets = this.buildRouteTargets(normalizedConfig.virtualrouter?.routing || {}, normalizedConfig.virtualrouter?.providers || {});
    const pipelineConfigs = this.buildPipelineConfigs(normalizedConfig, keyMappings);
    const moduleConfigs = this.buildModuleConfigs(normalizedConfig);

    // Create compatibility configuration
    const compatibilityConfig: CompatibilityConfig = {
      originalConfig: config,
      normalizedConfig,
      keyMappings,
      authMappings,
      routeTargets: this.sortRouteTargets(routeTargets),
      pipelineConfigs,
      moduleConfigs
    };

    return {
      isValid: true,
      errors: [],
      warnings: [], // Base warnings from config-engine
      normalized: compatibilityConfig.normalizedConfig,
      compatibilityConfig,
      compatibilityWarnings: warnings
    };
  }

  /**
   * Apply stable sorting to configuration for consistent output
   */
  private applyStableSorting(config: any): any {
    // Use structuredClone if available, otherwise selective cloning
    const sorted = typeof structuredClone !== 'undefined'
      ? structuredClone(config)
      : this.selectiveClone(config);

    // Apply stable sorting to virtualrouter providers and routing
    if (sorted.virtualrouter) {
      if (sorted.virtualrouter.providers) {
        sorted.virtualrouter.providers = sortProviders(sorted.virtualrouter.providers);
      }
      if (sorted.virtualrouter.routing) {
        sorted.virtualrouter.routing = sortRouting(sorted.virtualrouter.routing);
      }
    }

    // Apply stable sorting to key mappings and auth mappings if they exist
    if (sorted.keyMappings) {
      sorted.keyMappings = sortKeyMappings(sorted.keyMappings);
    }

    // Apply selective stable sorting (only sort keys that need ordering)
    return this.selectiveStableSort(sorted);
  }

  /**
   * Apply stable sorting to route targets for consistent output
   */
  private sortRouteTargets(routeTargets: Record<string, any>): Record<string, any> {
    const sorted: Record<string, any> = {};

    // Sort route names
    const routeNames = Object.keys(routeTargets).sort();

    for (const routeName of routeNames) {
      const targets = routeTargets[routeName];
      if (Array.isArray(targets)) {
        // Sort route targets by providerId, modelId, and keyId for consistent output
        sorted[routeName] = [...targets].sort((a, b) => {
          const aKey = `${a.providerId}.${a.modelId}.${a.keyId || ''}`;
          const bKey = `${b.providerId}.${b.modelId}.${b.keyId || ''}`;
          return aKey.localeCompare(bKey);
        });
      } else {
        sorted[routeName] = stableSortObject(targets);
      }
    }

    return sorted;
  }

  /**
   * Apply all normalization rules to configuration
   */
  private applyAllNormalizations(
    config: any,
    warnings: CompatibilityWarning[]
  ): any {
    // Use structuredClone if available, otherwise selective cloning
    const normalized = typeof structuredClone !== 'undefined'
      ? structuredClone(config)
      : this.selectiveClone(config);

    // Handle providers configuration - move from config.providers to config.virtualrouter.providers
    // Only if not already processed by preprocessLegacyConfig
    if (normalized.providers && !normalized.virtualrouter?.providers) {
      if (!normalized.virtualrouter) {
        normalized.virtualrouter = {};
      }
      normalized.virtualrouter.providers = normalized.providers;
      delete normalized.providers;
    }

    if (normalized.virtualrouter?.providers) {
      normalized.virtualrouter.providers = this.normalizeProviders(
        normalized.virtualrouter.providers,
        warnings
      );
    }

    // Fix null type issue
    if (normalized.pipeline && typeof normalized.pipeline !== 'object') {
      normalized.pipeline = {};
    }

    // Apply stable sorting to ensure consistent output across platforms
    return this.applyStableSorting(normalized);
  }

  /**
   * Normalize provider configurations
   */
  private normalizeProviders(
    providers: Record<string, any>,
    warnings: CompatibilityWarning[]
  ): Record<string, any> {
    const normalized: Record<string, any> = {};

    for (const [providerId, providerConfig] of Object.entries(providers)) {
      const normalizedConfig = { ...providerConfig };

      // Normalize provider type - skip if already a valid enum type
      if (this.options.normalizeProviderTypes) {
        const originalType = providerConfig.type;
        const validEnumTypes = ['openai', 'anthropic', 'qwen', 'lmstudio', 'iflow', 'custom'];

        // Only normalize if not already a valid enum type
        if (!validEnumTypes.includes(originalType)) {
          const normalizedType = normalizeProviderType(providerId, originalType, providerConfig);

          if (originalType !== normalizedType) {
            warnings.push({
              code: 'PROVIDER_TYPE_NORMALIZED',
              message: `Normalized provider type from '${originalType}' to '${normalizedType}' for provider '${providerId}'`,
              path: `/virtualrouter/providers/${providerId}/type`,
              severity: 'info',
              details: {
                originalValue: originalType,
                normalizedValue: normalizedType,
                ruleApplied: 'provider-type-normalization'
              }
            });
          }

          normalizedConfig.type = normalizedType;
        } else {
          // Already a valid type, keep as-is, but allow heuristic overrides (GLM etc.)
          normalizedConfig.type = originalType;
          try {
            const base = String((providerConfig as any)?.baseURL || (providerConfig as any)?.baseUrl || '').toLowerCase();
            const idLower = String(providerId || '').toLowerCase();
            if (idLower.includes('glm') || /open\.bigmodel\.cn\/api\/coding\/paas/i.test(base)) {
              if (normalizedConfig.type !== 'glm-http-provider') {
                warnings.push({
                  code: 'PROVIDER_TYPE_HEURISTIC_OVERRIDE',
                  message: `Overriding provider type '${originalType}' to 'glm-http-provider' for provider '${providerId}' based on baseUrl/id heuristics`,
                  path: `/virtualrouter/providers/${providerId}/type`,
                  severity: 'info',
                  details: { originalValue: originalType, normalizedValue: 'glm-http-provider', ruleApplied: 'glm-baseurl-heuristic' }
                });
              }
              normalizedConfig.type = 'glm-http-provider';
            }
          } catch { /* ignore heuristic errors */ }
        }

        // Apply provider-specific transformations (run after potential heuristic override)
        const transformedConfig = applyProviderTransformations(
          providerId,
          normalizedConfig.type,
          normalizedConfig
        );

        Object.assign(normalizedConfig, transformedConfig);
      }

      // Expand environment variables if enabled
      if (this.options.expandEnvVars) {
        if (Array.isArray(normalizedConfig.apiKey)) {
          normalizedConfig.apiKey = normalizedConfig.apiKey.map((key: string) => expandEnvVar(key));
        } else if (typeof normalizedConfig.apiKey === 'string') {
          normalizedConfig.apiKey = expandEnvVar(normalizedConfig.apiKey);
        }
      }

      // Normalize compatibility configurations
      if (normalizedConfig.compatibility) {
        normalizedConfig.compatibility = this.normalizeProviderCompatibility(
          normalizedConfig.compatibility,
          warnings
        );
      }

      // Ensure required identifier fields exist for downstream consumers
      if (!normalizedConfig.id) {
        normalizedConfig.id = providerId;
      }
      if (typeof normalizedConfig.enabled !== 'boolean') {
        normalizedConfig.enabled = true;
      }

      // Keep baseUrl/baseURL in sync to accommodate legacy readers
      if (normalizedConfig.baseURL && !normalizedConfig.baseUrl) {
        normalizedConfig.baseUrl = normalizedConfig.baseURL;
      } else if (normalizedConfig.baseUrl && !normalizedConfig.baseURL) {
        normalizedConfig.baseURL = normalizedConfig.baseUrl;
      }

      // Normalize LLM switch configurations
      if (normalizedConfig.llmSwitch) {
        normalizedConfig.llmSwitch = this.normalizeProviderLLMSwitch(
          normalizedConfig.llmSwitch,
          warnings
        );
      }

      // Generate key aliases if enabled
      if (this.options.generateKeyAliases) {
        normalizedConfig.keyAliases = getProviderKeyAliases(providerId, normalizedConfig);
      }

      // Process OAuth configurations if enabled
      if (this.options.processOAuth && normalizedConfig.oauth) {
        normalizedConfig.oauth = this.normalizeProviderOAuth(
          normalizedConfig.oauth,
          providerId,
          warnings
        );
      }

      // Mirror normalized type to normalizedType field for downstream
      try { (normalizedConfig as any).normalizedType = normalizedConfig.type; } catch { /* ignore */ }

      normalized[providerId] = normalizedConfig;
    }

    return normalized;
  }

  /**
   * Normalize provider compatibility configuration
   */
  private normalizeProviderCompatibility(
    compatibility: any,
    warnings: CompatibilityWarning[]
  ): any {
    if (typeof compatibility === 'string') {
      const parsed = parseCompatibilityString(compatibility);
      return {
        type: parsed.type,
        config: parsed.config
      };
    }

    if (compatibility && typeof compatibility === 'object') {
      const normalizedType = normalizeCompatibilityType(compatibility.type);
      if (compatibility.type !== normalizedType) {
        warnings.push({
          code: 'COMPATIBILITY_TYPE_NORMALIZED',
          message: `Normalized compatibility type from '${compatibility.type}' to '${normalizedType}'`,
          path: '',
          severity: 'info',
          details: {
            originalValue: compatibility.type,
            normalizedValue: normalizedType,
            ruleApplied: 'compatibility-type-normalization'
          }
        });
      }

      return {
        type: normalizedType,
        config: compatibility.config || {}
      };
    }

    return compatibility;
  }

  /**
   * Normalize provider LLM switch configuration
   */
  private normalizeProviderLLMSwitch(
    llmSwitch: any,
    warnings: CompatibilityWarning[]
  ): any {
    if (llmSwitch && typeof llmSwitch === 'object') {
      const normalizedType = normalizeLLMSwitchType(llmSwitch.type);
      if (llmSwitch.type !== normalizedType) {
        warnings.push({
          code: 'LLM_SWITCH_TYPE_NORMALIZED',
          message: `Normalized LLM switch type from '${llmSwitch.type}' to '${normalizedType}'`,
          path: '',
          severity: 'info',
          details: {
            originalValue: llmSwitch.type,
            normalizedValue: normalizedType,
            ruleApplied: 'llm-switch-type-normalization'
          }
        });
      }

      return {
        type: normalizedType,
        config: llmSwitch.config || {}
      };
    }

    return llmSwitch;
  }

  /**
   * Normalize provider OAuth configuration
   */
  private normalizeProviderOAuth(
    oauth: any,
    providerId: string,
    warnings: CompatibilityWarning[]
  ): any {
    if (oauth && typeof oauth === 'object') {
      const normalized: any = {};

      for (const [oauthName, oauthConfig] of Object.entries(oauth)) {
        normalized[oauthName] = normalizeOAuthConfig(oauthConfig);

        // Validate token file path
        const tokenPath = resolveOAuthTokenPath(providerId, oauthName, oauthConfig);
        try {
          const fs = require('fs');
          if (!fs.existsSync(tokenPath)) {
            warnings.push({
              code: 'OAUTH_TOKEN_FILE_NOT_FOUND',
              message: `OAuth token file not found: ${tokenPath}`,
              path: `/virtualrouter/providers/${providerId}/oauth/${oauthName}`,
              severity: 'warn',
              details: {
                tokenPath,
                providerId,
                oauthName
              }
            });
          }
        } catch (error) {
          // File system access not available in some environments
        }
      }

      return normalized;
    }

    return oauth;
  }

  /**
   * Build auth mappings
   */
  private buildAuthMappings(providers: Record<string, any>): AuthMappings {
    const authMappings: AuthMappings = {
      authFiles: {},
      oauthTokens: {},
      oauthConfigs: {}
    };

    for (const [providerId, providerConfig] of Object.entries(providers)) {
      // Process static auth file mappings
      if (providerConfig.auth) {
        for (const [authName, authPath] of Object.entries(providerConfig.auth)) {
          const authId = `auth-${authName}`;
          let counter = 1;

          while (authMappings.authFiles[authId]) {
            authId.replace(`-${counter}`, `-${counter + 1}`);
            counter++;
          }

          authMappings.authFiles[authId] = authPath as string;
        }
      }

      // Process OAuth configurations
      if (providerConfig.oauth) {
        for (const [oauthName, oauthConfig] of Object.entries(providerConfig.oauth)) {
          const oauthAuthId = `auth-${providerId}-${oauthName}`;
          const tokenPath = resolveOAuthTokenPath(providerId, oauthName, oauthConfig);

          authMappings.oauthTokens[oauthAuthId] = tokenPath;
          authMappings.oauthConfigs[oauthAuthId] = normalizeOAuthConfig(oauthConfig);
        }
      }
    }

    return authMappings;
  }

  /**
   * Build route targets
   */
  private buildRouteTargets(
    routing: Record<string, string[]>,
    providers: Record<string, any>,
    _authMappings: AuthMappings = { authFiles: {}, oauthTokens: {}, oauthConfigs: {} }
  ): RouteTargetPool {
    const routeTargets: RouteTargetPool = {};

    // Pre-compute key mappings to avoid repeated computation
    const keyMappings = buildKeyMappings(providers);

    for (const [routeName, targets] of Object.entries(routing)) {
      const expanded: any[] = [];

      for (const target of targets) {
        try {
          const processed = this.processRouteTarget(target, providers, keyMappings);
          if (!processed) {
            continue;
          }
          if (Array.isArray(processed)) {
            for (const entry of processed) {
              if (entry) {
                expanded.push(entry);
              }
            }
          } else {
            expanded.push(processed);
          }
        } catch (error) {
          console.warn(`Skipping invalid route target '${target}':`, error);
        }
      }

      routeTargets[routeName] = expanded;
    }

    return routeTargets;
  }

  /**
   * Build pipeline configurations
   */
  private buildPipelineConfigs(
    config: any,
    keyMappings: any
  ): PipelineConfigs {
    const pipelines: PipelineConfigs = {};

    const vr = (config?.virtualrouter || {}) as any;
    const providers = (vr.providers || {}) as Record<string, any>;

    // Helper: pick compatibility by family/type with light defaults
    const pickCompatibility = (normalizedType: string): { type: string; config: Record<string, any> } => {
      const t = String(normalizedType || '').toLowerCase();
      if (t.includes('qwen')) { return { type: 'qwen-compatibility', config: {} }; }
      if (t.includes('glm')) { return { type: 'glm-compatibility', config: {} }; }
      if (t.includes('lmstudio')) { return { type: 'lmstudio-compatibility', config: {} }; }
      if (t.includes('iflow')) { return { type: 'iflow-compatibility', config: {} }; }
      return { type: 'field-mapping', config: {} };
    };

    const pickLlmswitchConfig = (llmSwitchType: string, existing?: Record<string, unknown>): Record<string, unknown> => {
      if (existing && Object.keys(existing).length > 0) {
        return existing;
      }
      switch (llmSwitchType) {
        case 'llmswitch-conversion-router':
          return {
            profilesPath: 'config/conversion/llmswitch-profiles.json',
            defaultProfile: 'openai-chat'
          };
        default:
          return {};
      }
    };

    // Build minimal pipelines per provider/model/key alias
    for (const [providerId, pCfg] of Object.entries(providers)) {
      const normalizedType = String(pCfg?.normalizedType || pCfg?.type || providerId);
      const baseURL = pCfg?.baseURL || pCfg?.baseUrl || '';
      const models = (pCfg?.models || {}) as Record<string, any>;
      const aliases = (keyMappings?.providers?.[providerId] ? Object.keys(keyMappings.providers[providerId]) : ['key1']) as string[];

      for (const [modelId, mCfg] of Object.entries(models)) {
        const maxContext = Number((mCfg as any)?.maxContext) || undefined;
        const maxTokens = Number((mCfg as any)?.maxTokens) || undefined;
        for (const keyId of aliases) {
          const cfgKey = `${providerId}.${modelId}.${keyId}`;
          const inputProtocol = vr?.inputProtocol || 'openai';
          const llmSwitchType = getDefaultLLMSwitchType(inputProtocol);
          pipelines[cfgKey] = {
            provider: {
              type: normalizedType,
              baseURL,
              // auth will be injected later by assembler/engine using alias mapping
            },
            model: {
              maxContext: maxContext ?? 0,
              maxTokens: maxTokens ?? 0,
            },
            keyConfig: {
              keyId,
              actualKey: keyMappings.providers?.[providerId]?.[keyId] || keyId,
              keyType: 'apiKey',
            },
            protocols: {
              input: inputProtocol,
              output: 'openai',
            },
            compatibility: pickCompatibility(normalizedType),
            llmSwitch: { type: llmSwitchType, config: pickLlmswitchConfig(llmSwitchType) },
            workflow: { type: 'streaming-control', config: {} },
          } as any;
        }
      }
    }

    return pipelines;
  }

  /**
   * Build module configurations
   */
  private buildModuleConfigs(config: any): ModuleConfigs {
    const moduleConfigs: ModuleConfigs = {};

    // Virtual router module
    if (config.virtualrouter) {
      moduleConfigs.virtualrouter = {
        enabled: true,
        config: {
          moduleType: 'virtual-router',
          inputProtocol: config.virtualrouter.inputProtocol,
          outputProtocol: config.virtualrouter.outputProtocol
        }
      };
    }

    // HTTP server module
    if (config.port) {
      moduleConfigs.httpserver = {
        enabled: true,
        config: { port: config.port }
      };
    }

    // Other modules
    for (const [moduleName, moduleConfig] of Object.entries(config)) {
      if (
        moduleName !== 'virtualrouter' &&
        moduleName !== 'httpserver' &&
        moduleName !== 'port' &&
        moduleName !== 'user' &&
        typeof moduleConfig === 'object' &&
        moduleConfig !== null
      ) {
        moduleConfigs[moduleName] = {
          enabled: true,
          config: moduleConfig
        };
      }
    }

    return moduleConfigs;
  }

  /**
   * Extract API key from keys object with any structure
   */
  private extractApiKeyFromKeys(keys: any): string | undefined {
    if (!keys || typeof keys !== 'object') {
      return undefined;
    }

    // Try to find API key in any key entry (only for non-OAuth configs)
    for (const [, keyConfig] of Object.entries(keys)) {
      if (keyConfig && typeof keyConfig === 'object') {
        // Skip OAuth configurations
        if ((keyConfig as any).type === 'oauth' || (keyConfig as any).oauth) {
          continue;
        }

        if ('apiKey' in keyConfig) {
          return (keyConfig as any).apiKey;
        }
      }
    }

    return undefined;
  }

  /**
   * Extract OAuth configuration from keys object
   */
  private extractOAuthConfig(keys: any): any {
    if (!keys || typeof keys !== 'object') {
      return undefined;
    }

    // Find OAuth configuration in any key entry
    for (const [, keyConfig] of Object.entries(keys)) {
      if (keyConfig && typeof keyConfig === 'object') {
        const config = keyConfig as any;
        if (config.type === 'oauth' && config.oauth) {
          return config.oauth;
        }
        // Also check if oauth is directly in the key config
        if (config.oauth) {
          return config.oauth;
        }
      }
    }

    return undefined;
  }

  /**
   * Selective cloning for performance optimization
   */
  private selectiveClone(obj: any): any {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.selectiveClone(item));
    }

    // Only clone the parts we need to modify
    const cloned: any = {};

    // Always clone virtualrouter section as it's frequently modified
    if (obj.virtualrouter) {
      cloned.virtualrouter = {
        ...obj.virtualrouter,
        providers: obj.virtualrouter.providers ? { ...obj.virtualrouter.providers } : undefined,
        routing: obj.virtualrouter.routing ? { ...obj.virtualrouter.routing } : undefined
      };
    }

    // Clone other top-level properties that might be modified
    for (const [key, value] of Object.entries(obj)) {
      if (key !== 'virtualrouter') {
        cloned[key] = value;
      }
    }

    return cloned;
  }

  /**
   * Selective stable sorting for performance optimization
   */
  private selectiveStableSort(obj: any): any {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return [...obj].sort();
    }

    const sorted: any = {};

    // Only sort keys that need consistent ordering
    const sortableKeys = ['virtualrouter', 'providers', 'routing', 'keyMappings', 'authMappings'];
    const otherKeys = Object.keys(obj).filter(key => !sortableKeys.includes(key));

    // Process sortable keys first
    for (const key of sortableKeys.sort()) {
      if (obj[key] !== undefined) {
        sorted[key] = this.selectiveStableSort(obj[key]);
      }
    }

    // Process other keys
    for (const key of otherKeys.sort()) {
      sorted[key] = this.selectiveStableSort(obj[key]);
    }

    return sorted;
  }

  /**
   * Preprocess legacy configuration format
   * Converts old format (config.providers) to new format (config.virtualrouter.providers)
   * Also normalizes provider types and adds required fields
   */
  private preprocessLegacyConfig(config: any): any {
    // Use structuredClone if available, otherwise selective cloning
    const preprocessed = typeof structuredClone !== 'undefined'
      ? structuredClone(config)
      : this.selectiveClone(config);

    // Debug: Log preprocessing action
    console.log('🔧 Debug: Preprocessing legacy config...');
    console.log('- Before: config.providers keys:', Object.keys(preprocessed.providers || {}));
    console.log('- Before: config.virtualrouter.providers keys:', Object.keys(preprocessed.virtualrouter?.providers || {}));

    // Handle providers configuration - move from config.providers to config.virtualrouter.providers
    if (preprocessed.providers && (!preprocessed.virtualrouter?.providers || Object.keys(preprocessed.virtualrouter.providers).length === 0)) {
      if (!preprocessed.virtualrouter) {
        preprocessed.virtualrouter = {};
      }

      // Transform providers to new format before moving
      const transformedProviders: Record<string, any> = {};
      for (const [providerId, providerConfig] of Object.entries(preprocessed.providers)) {
        const config = providerConfig as any;

        // Convert to new format expected by config-engine
        const transformedProvider: any = {
          id: providerId, // Add required id field
          type: this.normalizeProviderTypeForConfigEngine(config.type), // Normalize type
          enabled: config.enabled,
          baseUrl: config.baseUrl,
          models: config.models
        };

        // Handle API key vs OAuth configuration
        const extractedApiKey = config.apiKey ||
                               config.keys?.key1?.apiKey ||
                               this.extractApiKeyFromKeys(config.keys);

        if (extractedApiKey) {
          transformedProvider.apiKey = extractedApiKey;
          // For API key auth, set auth type to 'apikey'
          transformedProvider.auth = {
            type: 'apikey'
          };
        } else {
          // Check for OAuth configuration and convert to new format
          const oauthConfig = this.extractOAuthConfig(config.keys);
          if (oauthConfig) {
            transformedProvider.auth = {
              type: 'oauth',
              ...oauthConfig
            };
            console.log(`🔐 Debug: Added OAuth config for ${providerId}:`, {
              hasOAuth: !!oauthConfig,
              oauthKeys: Object.keys(oauthConfig || {})
            });
          }
        }

        transformedProviders[providerId] = transformedProvider;

        console.log(`🔄 Debug: Transformed provider ${providerId}:`, {
          oldType: config.type,
          newType: transformedProviders[providerId].type,
          hasApiKey: !!transformedProviders[providerId].apiKey,
          hasAuth: !!transformedProviders[providerId].auth,
          authType: transformedProviders[providerId].auth?.type
        });
      }

      preprocessed.virtualrouter.providers = transformedProviders;
      delete preprocessed.providers;
      console.log('✅ Debug: Moved and transformed providers from config.providers to config.virtualrouter.providers');
    }

    console.log('- After: config.providers keys:', Object.keys(preprocessed.providers || {}));
    console.log('- After: config.virtualrouter.providers keys:', Object.keys(preprocessed.virtualrouter?.providers || {}));

    // Ensure minimal required fields exist for config-engine validation
    if (preprocessed.virtualrouter?.providers) {
      for (const [providerId, providerConfig] of Object.entries(preprocessed.virtualrouter.providers)) {
        const cfg = providerConfig as Record<string, unknown>;
        if (!cfg.id) {
          cfg.id = providerId;
        }
        if (typeof cfg.enabled !== 'boolean') {
          cfg.enabled = true;
        }
        if (cfg.baseURL && !cfg.baseUrl) {
          cfg.baseUrl = cfg.baseURL;
        } else if (cfg.baseUrl && !cfg.baseURL) {
          cfg.baseURL = cfg.baseUrl;
        }
      }
    }

    return preprocessed;
  }

  /**
   * Normalize provider type for config-engine compatibility
   */
  private normalizeProviderTypeForConfigEngine(type: string): string {
    // Map legacy types to new config-engine expected types
    const typeMapping: Record<string, string> = {
      'lmstudio-http': 'lmstudio',
      'qwen-provider': 'qwen',
      'iflow-http': 'iflow',
      'anthropic-http': 'anthropic',
      'openai-http': 'openai',
      'glm-http': 'glm',
      'glm-provider': 'glm'
    };

    // Return mapped type or original if no mapping exists
    return typeMapping[type] || type;
  }

  /**
   * Process a single route target for better performance
   */
  private processRouteTarget(
    target: string,
    providers: Record<string, any>,
    keyMappings: any
  ): any {
    const parsed = parseRouteTarget(target, providers);

    if (!parsed.keyAlias) {
      // Expand to all key aliases
      const keyAliases = getProviderKeyAliases(parsed.providerId, providers[parsed.providerId]);

      // Return array of targets for batch processing
      return keyAliases.map(keyAlias => ({
        providerId: parsed.providerId,
        modelId: parsed.modelId,
        keyId: keyAlias,
        actualKey: resolveActualKey(
          parsed.providerId,
          resolveKeyByAlias(parsed.providerId, keyAlias, providers[parsed.providerId]),
          keyMappings,
          {}
        ),
        inputProtocol: 'openai',
        outputProtocol: 'openai'
      }));
    } else {
      // Use specific key alias
      return {
        providerId: parsed.providerId,
        modelId: parsed.modelId,
        keyId: parsed.keyAlias,
        actualKey: resolveActualKey(
          parsed.providerId,
          resolveKeyByAlias(parsed.providerId, parsed.keyAlias, providers[parsed.providerId]),
          keyMappings,
          {}
        ),
        inputProtocol: 'openai',
        outputProtocol: 'openai'
      };
    }
  }
}
