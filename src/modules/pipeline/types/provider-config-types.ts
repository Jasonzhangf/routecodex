import type { BaseProviderConfig } from './base-types.js';
import type { JsonValue, UnknownObject } from '../../../types/common-types.js';

/**
 * Provider configuration interface
 */
export interface ProviderConfig extends BaseProviderConfig, UnknownObject {}

/**
 * Provider type variants
 */
export type ProviderType = 'openai' | 'qwen' | 'anthropic' | 'cohere' | 'custom';

/**
 * Authentication type variants
 */
export type AuthType = 'apikey' | 'oauth' | 'bearer' | 'basic' | 'custom';

/**
 * Provider configuration variants
 */
export type ProviderConfigVariant =
  | OpenAIProviderConfig
  | QwenProviderConfig
  | AnthropicProviderConfig
  | CohereProviderConfig
  | CustomProviderConfig;

/**
 * OpenAI provider configuration
 */
export interface OpenAIProviderConfig extends ProviderConfig {
  type: 'openai';
  baseUrl: string;
  auth: {
    type: 'apikey';
    apiKey: string;
  };
  models: Record<string, OpenAIModelConfig>;
  compatibility?: OpenAICompatibilityConfig;
}

/**
 * Qwen provider configuration
 */
export interface QwenProviderConfig extends ProviderConfig {
  type: 'qwen';
  baseUrl: string;
  auth: {
    type: 'apikey';
    apiKey: string;
  };
  models: Record<string, QwenModelConfig>;
  compatibility?: QwenCompatibilityConfig;
}

/**
 * Anthropic provider configuration
 */
export interface AnthropicProviderConfig extends ProviderConfig {
  type: 'anthropic';
  baseUrl: string;
  auth: {
    type: 'apikey';
    apiKey: string;
  };
  models: Record<string, AnthropicModelConfig>;
  compatibility?: AnthropicCompatibilityConfig;
}

/**
 * Cohere provider configuration
 */
export interface CohereProviderConfig extends ProviderConfig {
  type: 'cohere';
  baseUrl: string;
  auth: {
    type: 'apikey';
    apiKey: string;
  };
  models: Record<string, CohereModelConfig>;
  compatibility?: CohereCompatibilityConfig;
}

/**
 * Custom provider configuration
 */
export interface CustomProviderConfig extends ProviderConfig {
  type: 'custom';
  baseUrl: string;
  auth: AuthConfig;
  models: Record<string, CustomModelConfig>;
  compatibility?: CustomCompatibilityConfig;
  customSettings?: Record<string, JsonValue | UnknownObject>;
}

/**
 * Authentication configuration variants
 */
export type AuthConfig =
  | APIKeyAuthConfig
  | OAuthAuthConfig
  | BearerAuthConfig
  | BasicAuthConfig
  | CustomAuthConfig;

/**
 * API key authentication configuration
 */
export interface APIKeyAuthConfig extends UnknownObject {
  type: 'apikey';
  apiKey: string;
  headerName?: string;
  queryParam?: string;
  prefix?: string;
}

/**
 * OAuth authentication configuration
 */
export interface OAuthAuthConfig extends UnknownObject {
  type: 'oauth';
  clientId: string;
  clientSecret?: string;
  tokenUrl: string;
  deviceCodeUrl?: string;
  scopes?: string[];
  redirectUri?: string;
  tokenFile?: string;
  refreshBuffer?: number; // milliseconds before token expires
}

/**
 * Bearer token authentication configuration
 */
export interface BearerAuthConfig extends UnknownObject {
  type: 'bearer';
  token: string;
  refreshUrl?: string;
  refreshBuffer?: number;
}

/**
 * Basic authentication configuration
 */
export interface BasicAuthConfig extends UnknownObject {
  type: 'basic';
  username: string;
  password: string;
}

/**
 * Custom authentication configuration
 */
export interface CustomAuthConfig extends UnknownObject {
  type: 'custom';
  implementation: string; // path to custom auth implementation
  config: Record<string, unknown>;
}

/**
 * Model configuration interface
 */
export interface BaseModelConfig extends UnknownObject {
  id: string;
  name: string;
  description?: string;
  maxTokens: number;
  supportsStreaming: boolean;
  supportsFunctions: boolean;
  supportsVision: boolean;
  parameters: Record<string, JsonValue>;
  pricing?: {
    input: number; // per 1k tokens
    output: number; // per 1k tokens
  };
}

/**
 * OpenAI model configuration
 */
export interface OpenAIModelConfig extends BaseModelConfig {
  type: 'gpt-3.5-turbo' | 'gpt-4' | 'gpt-4-turbo' | 'gpt-4o' | 'custom';
  contextLength: number;
  trainingData?: string;
}

/**
 * Qwen model configuration
 */
export interface QwenModelConfig extends BaseModelConfig {
  type: 'qwen-turbo' | 'qwen-plus' | 'qwen-max' | 'qwen-coder' | 'custom';
  contextLength: number;
  version?: string;
}

/**
 * Anthropic model configuration
 */
export interface AnthropicModelConfig extends BaseModelConfig {
  type: 'claude-3-opus' | 'claude-3-sonnet' | 'claude-3-haiku' | 'custom';
  contextLength: number;
  maxOutputTokens: number;
}

/**
 * Cohere model configuration
 */
export interface CohereModelConfig extends BaseModelConfig {
  type: 'command' | 'command-light' | 'command-r' | 'command-r-plus' | 'custom';
  contextLength: number;
  connectors?: string[];
}

/**
 * Custom model configuration
 */
export interface CustomModelConfig extends BaseModelConfig {
  type: 'custom';
  customParameters: Record<string, JsonValue>;
}

/**
 * Compatibility configuration interface
 */
export interface BaseCompatibilityConfig extends UnknownObject {
  enabled: boolean;
  requestMappings?: UnknownObject[];
  responseMappings?: UnknownObject[];
  toolAdaptation?: boolean;
  streamingAdaptation?: boolean;
}

/**
 * OpenAI compatibility configuration
 */
export interface OpenAICompatibilityConfig extends BaseCompatibilityConfig {
  targetProtocol: 'openai' | 'custom';
  modelMapping?: Record<string, string>;
  parameterMapping?: Record<string, string>;
}

/**
 * Qwen compatibility configuration
 */
export interface QwenCompatibilityConfig extends BaseCompatibilityConfig {
  targetProtocol: 'openai' | 'qwen' | 'custom';
  modelMapping?: Record<string, string>;
  toolFormat?: 'openai' | 'qwen' | 'custom';
}

/**
 * Anthropic compatibility configuration
 */
export interface AnthropicCompatibilityConfig extends BaseCompatibilityConfig {
  targetProtocol: 'anthropic' | 'openai' | 'custom';
  modelMapping?: Record<string, string>;
  messageFormat?: 'anthropic' | 'openai' | 'custom';
}

/**
 * Cohere compatibility configuration
 */
export interface CohereCompatibilityConfig extends BaseCompatibilityConfig {
  targetProtocol: 'cohere' | 'openai' | 'custom';
  modelMapping?: Record<string, string>;
  connectorMapping?: Record<string, string>;
}

/**
 * Custom compatibility configuration
 */
export interface CustomCompatibilityConfig extends BaseCompatibilityConfig {
  targetProtocol: string;
  customMappings?: Record<string, UnknownObject>;
}
