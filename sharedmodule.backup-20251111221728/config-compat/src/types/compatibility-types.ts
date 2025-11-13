/**
 * RouteCodex Configuration Compatibility Types
 * Types and interfaces for the compatibility layer that preserves existing normalization logic
 */

import {
  RouteCodexConfigType,
  ProviderConfigType,
  ConfigValidationResult
} from 'routecodex-config-engine';

// Extended configuration types that include compatibility-specific fields
export interface CompatibilityConfig {
  // Original user configuration
  originalConfig: RouteCodexConfigType;

  // Normalized configuration with all transformations applied
  normalizedConfig: NormalizedConfig;

  // Provider key mappings and aliases
  keyMappings: KeyMappings;

  // Auth mappings (OAuth and static auth files)
  authMappings: AuthMappings;

  // Route target pool with alias resolution
  routeTargets: RouteTargetPool;

  // Pipeline configurations
  pipelineConfigs: PipelineConfigs;

  // Module configurations
  moduleConfigs: ModuleConfigs;
}

// Normalized configuration after all transformations
export interface NormalizedConfig extends Omit<RouteCodexConfigType, 'virtualrouter'> {
  // All provider types are normalized to registered module types
  virtualrouter?: {
    inputProtocol: 'openai' | 'anthropic' | 'custom';
    outputProtocol: 'openai' | 'anthropic' | 'custom';
    providers: Record<string, NormalizedProviderConfig>;
    routing: Record<string, string[]>;
    dryRun?: any;
    // Additional routing fields for compatibility
    thinking?: string[];
    default?: string[];
    coding?: string[];
    longcontext?: string[];
    tools?: string[];
    vision?: string[];
    websearch?: string[];
    background?: string[];
  };
}

// Provider configuration with normalized types
export interface NormalizedProviderConfig extends ProviderConfigType {
  // Normalized provider type (e.g., 'qwen' -> 'qwen-provider' or 'openai-provider')
  normalizedType: string;

  // Key alias mappings (key1, key2, etc.)
  keyAliases: string[];

  // OAuth configuration if applicable
  oauth?: OAuthConfig;

  // Explicit auth configuration
  auth?: {
    type: 'apikey' | 'oauth' | 'bearer';
    apiKey?: string;
    oauth?: OAuthConfig;
  };
}

// OAuth configuration structure
export interface OAuthConfig {
  clientId: string;
  deviceCodeUrl: string;
  tokenUrl: string;
  scopes: string[];
  tokenFile: string;
  [key: string]: any;
}

// Key mappings for provider aliases
export interface KeyMappings {
  // Provider-specific key mappings
  providers: Record<string, Record<string, string>>;

  // Global key mappings
  global: Record<string, string>;

  // OAuth configurations
  oauth: Record<string, OAuthConfig>;
}

// Auth mappings for both static auth files and OAuth
export interface AuthMappings {
  // Auth file paths
  authFiles: Record<string, string>;

  // OAuth token paths
  oauthTokens: Record<string, string>;

  // OAuth configurations
  oauthConfigs: Record<string, OAuthConfig>;
}

// Route target with alias resolution
export interface RouteTarget {
  providerId: string;
  modelId: string;
  keyId: string; // Alias (key1, key2, etc.)
  actualKey: string; // Real key or auth mapping
  inputProtocol: 'openai' | 'anthropic' | 'custom';
  outputProtocol: 'openai' | 'anthropic' | 'custom';
}

// Route target pool by category
export interface RouteTargetPool {
  [category: string]: RouteTarget[];
}

// Pipeline configuration for individual provider/model/key combinations
export interface PipelineConfig {
  provider: {
    type: string;
    baseURL: string;
    auth?: any;
  };
  model: {
    maxContext: number;
    maxTokens: number;
    [key: string]: any;
  };
  keyConfig: {
    keyId: string;
    actualKey: string;
    keyType: 'apiKey' | 'authFile' | 'oauth';
  };
  protocols: {
    input: 'openai' | 'anthropic' | 'custom';
    output: 'openai' | 'anthropic' | 'custom';
  };
  compatibility?: {
    type: string;
    config: Record<string, any>;
  };
  llmSwitch?: {
    type: string;
    config: Record<string, any>;
  };
  workflow?: {
    type: string;
    config: Record<string, any>;
    enabled?: boolean;
  };
}

// Pipeline configurations by config key
export interface PipelineConfigs {
  [configKey: string]: PipelineConfig;
}

// Module configurations
export interface ModuleConfigs {
  [moduleName: string]: {
    enabled: boolean;
    config: Record<string, any>;
  };
}

// Compatibility normalization options
export interface CompatibilityOptions {
  // Whether to enable environment variable expansion
  expandEnvVars?: boolean;

  // Whether to normalize provider types
  normalizeProviderTypes?: boolean;

  // Whether to generate key aliases
  generateKeyAliases?: boolean;

  // Whether to process OAuth configurations
  processOAuth?: boolean;

  // Whether to sanitize sensitive data in output
  sanitizeOutput?: boolean;

  // Default compatibility type if not specified
  defaultCompatibility?: string;

  // Default LLM switch type if not specified
  defaultLLMSwitch?: string;
}

// Thinking configuration merging options
export interface ThinkingConfigMerge {
  providerThinking?: any;
  modelThinking?: any;
  legacyModelThinking?: any;
}

// Compatibility result with validation
export interface CompatibilityResult extends ConfigValidationResult {
  // The compatibility-processed configuration
  compatibilityConfig?: CompatibilityConfig;

  // Warnings specific to compatibility processing
  compatibilityWarnings: CompatibilityWarning[];
}

// Compatibility-specific warnings
export interface CompatibilityWarning {
  code: string;
  message: string;
  path?: string;
  severity: 'info' | 'warn' | 'deprecation';
  // Additional compatibility-specific metadata
  details?: {
    originalValue?: any;
    normalizedValue?: any;
    ruleApplied?: string;
    tokenPath?: string;
    providerId?: string;
    oauthName?: string;
    [key: string]: any;
  };
}

// Provider type normalization rules
export interface ProviderNormalizationRule {
  // Input provider type pattern
  inputPattern: string | RegExp;

  // Normalized provider type
  normalizedType: string;

  // Conditions for applying this rule
  conditions?: {
    hasOAuth?: boolean;
    hasApiKey?: boolean;
    providerId?: string;
  };

  // Additional transformations
  transformations?: {
    baseURL?: (url: string) => string;
    auth?: (config: any) => any;
  };
}

// Environment variable expansion options
export interface EnvExpansionOptions {
  // Supported variable formats
  formats?: ('${VAR}' | '$VAR')[];

  // Whether to throw on undefined variables
  throwOnUndefined?: boolean;

  // Default value for undefined variables
  defaultValue?: string;
}

// Thinking configuration types
export interface ThinkingConfig {
  enabled?: boolean;
  payload?: {
    type: 'enabled' | 'disabled' | 'custom';
    [key: string]: any;
  };
  models?: Record<string, any>;
  [key: string]: any;
}

// Compatibility string configuration
export interface CompatibilityStringConfig {
  type: string;
  config?: Record<string, any>;
}

// Compatibility type enumeration
export type CompatibilityType =
  | 'passthrough-compatibility'
  | 'glm-compatibility'
  | 'openai-compatibility'
  | 'anthropic-compatibility'
  | 'custom';

// LLM Switch configuration
export interface LLMSwitchConfig {
  type: string;
  config?: Record<string, any>;
}

// Thinking mode enumeration
export type ThinkingMode = 'enabled' | 'disabled' | 'custom';

// Additional utility types
export interface RouteTarget {
  providerId: string;
  modelId: string;
  keyId: string;
  actualKey: string;
  inputProtocol: 'openai' | 'anthropic' | 'custom';
  outputProtocol: 'openai' | 'anthropic' | 'custom';
}