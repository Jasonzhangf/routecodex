/**
 * RouteCodex Configuration Engine Types
 * Core type definitions for the configuration system
 */

import { z } from 'zod';

// Basic JSON value types
export type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
export interface JsonObject { [key: string]: JsonValue; }
export type JsonArray = JsonValue[];

// Configuration validation result
export interface ConfigValidationResult {
  isValid: boolean;
  errors: ConfigError[];
  warnings: ConfigWarning[];
  normalized?: any;
  versionInfo?: {
    configVersion: string;
    schemaVersion?: string;
    currentSchemaVersion: string;
    compatible: boolean;
    features: string[];
  };
}

// Configuration error with JSON Pointer support
export interface ConfigError {
  code: string;
  message: string;
  path?: string; // JSON Pointer path
  value?: any;
  expected?: string;
}

// Configuration warning
export interface ConfigWarning {
  code: string;
  message: string;
  path?: string;
  severity: 'info' | 'warn' | 'deprecation';
}

// Configuration source
export interface ConfigSource {
  name: string;
  priority: number;
  isRequired: boolean;
  loader: ConfigLoader;
}

// Configuration loader interface
export interface ConfigLoader {
  load(): Promise<JsonValue>;
  validate?(config: JsonValue): Promise<ConfigValidationResult>;
}

// Provider configuration
export interface ProviderConfig {
  id: string;
  type: 'openai' | 'anthropic' | 'qwen' | 'lmstudio' | 'iflow' | 'custom';
  enabled: boolean;
  baseURL?: string;
  apiKey?: string | string[];  // Optional when using OAuth
  models: Record<string, ModelConfig>;
  compatibility?: CompatibilityConfig;
  auth?: AuthConfig;
}

// Model configuration
export interface ModelConfig {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  thinking?: ThinkingConfig;
  [key: string]: any;
}

// Thinking configuration
export interface ThinkingConfig {
  enabled: boolean;
  payload?: {
    type: 'enabled' | 'disabled' | 'custom';
    [key: string]: any;
  };
}

// Compatibility configuration
export interface CompatibilityConfig {
  type: string;
  config: Record<string, any>;
}

// Authentication configuration
export interface AuthConfig {
  type: 'apikey' | 'oauth' | 'bearer' | 'custom';
  [key: string]: any;
}

// Routing configuration
export interface RoutingConfig {
  default: string[];
  coding: string[];
  longcontext: string[];
  tools: string[];
  thinking: string[];
  vision: string[];
  websearch: string[];
  background: string[];
  [key: string]: string[];
}

// Virtual router configuration
export interface VirtualRouterConfig {
  inputProtocol: 'openai' | 'anthropic' | 'custom';
  outputProtocol: 'openai' | 'anthropic' | 'custom';
  providers: Record<string, ProviderConfig>;
  routing: RoutingConfig;
  dryRun?: DryRunConfig;
}

// Dry run configuration
export interface DryRunConfig {
  enabled: boolean;
  includeLoadBalancerDetails?: boolean;
  includeHealthStatus?: boolean;
  includeWeightCalculation?: boolean;
  simulateProviderHealth?: boolean;
}

// Main configuration interface
export interface RouteCodexConfig {
  version: string;
  schemaVersion?: string; // Schema version for validation and compatibility
  port?: number;
  virtualrouter: VirtualRouterConfig;
  [key: string]: any;
}

// Zod schemas for validation
export const ProviderConfigSchema = z.object({
  id: z.string(),
  type: z.enum(['openai', 'anthropic', 'qwen', 'lmstudio', 'iflow', 'glm', 'generic_responses', 'custom']),
  enabled: z.boolean(),
  baseURL: z.string().url().optional(),
  apiKey: z.union([z.string(), z.array(z.string())]).optional(),
  models: z.record(z.string(), z.object({
    maxTokens: z.number().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    topP: z.number().min(0).max(1).optional(),
    topK: z.number().min(0).optional(),
    frequencyPenalty: z.number().min(-2).max(2).optional(),
    presencePenalty: z.number().min(-2).max(2).optional(),
    thinking: z.object({
      enabled: z.boolean(),
      payload: z.object({
        type: z.enum(['enabled', 'disabled', 'custom']),
      }).optional(),
    }).optional(),
  }).passthrough()),
  compatibility: z.object({
    type: z.string(),
    config: z.record(z.any()),
  }).optional(),
  auth: z.object({
    type: z.enum(['apikey', 'oauth', 'bearer', 'custom']),
  }).passthrough().optional(),
}).refine((data) => {
  // If auth type is not 'oauth', apiKey is required
  if (data.auth?.type !== 'oauth' && !data.apiKey) {
    return false;
  }
  return true;
}, {
  message: "apiKey is required when auth type is not 'oauth'",
  path: ["apiKey"],
});

export const RoutingConfigSchema = z.object({
  default: z.array(z.string()),
  coding: z.array(z.string()),
  longcontext: z.array(z.string()),
  tools: z.array(z.string()),
  thinking: z.array(z.string()),
  vision: z.array(z.string()),
  websearch: z.array(z.string()),
  background: z.array(z.string()),
});

export const VirtualRouterConfigSchema = z.object({
  inputProtocol: z.enum(['openai', 'anthropic', 'custom']),
  outputProtocol: z.enum(['openai', 'anthropic', 'custom']),
  providers: z.record(z.string(), ProviderConfigSchema),
  routing: RoutingConfigSchema,
  dryRun: z.object({
    enabled: z.boolean(),
    includeLoadBalancerDetails: z.boolean().optional(),
    includeHealthStatus: z.boolean().optional(),
    includeWeightCalculation: z.boolean().optional(),
    simulateProviderHealth: z.boolean().optional(),
  }).optional(),
});

export const RouteCodexConfigSchema = z.object({
  version: z.string(),
  schemaVersion: z.string().optional(),
  port: z.number().positive().optional(),
  virtualrouter: VirtualRouterConfigSchema,
});

// Type helpers
export type InferConfig<T extends z.ZodSchema> = z.infer<T>;
export type ProviderConfigType = InferConfig<typeof ProviderConfigSchema>;
export type VirtualRouterConfigType = InferConfig<typeof VirtualRouterConfigSchema>;
export type RouteCodexConfigType = InferConfig<typeof RouteCodexConfigSchema>;
