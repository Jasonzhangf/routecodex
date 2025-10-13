/**
 * Core types for LLMSwitch AJV module
 */

import type { LLMSwitchModule, ModuleConfig, ModuleDependencies } from 'rcc-basemodule';

// Re-export from basemodule for convenience
export type { LLMSwitchModule, ModuleConfig, ModuleDependencies };

/**
 * Shared Pipeline Request DTO
 */
export interface LLMSwitchRequest {
  data: Record<string, unknown>;
  route: {
    providerId: string;
    modelId: string;
    requestId: string;
    timestamp: number;
  };
  metadata: Record<string, unknown>;
  debug: {
    enabled: boolean;
    stages: Record<string, unknown>;
  };
}

/**
 * Shared Pipeline Response DTO
 */
export interface LLMSwitchResponse {
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
  usage?: Record<string, number>;
}

/**
 * AJV Validation Result
 */
export interface ValidationResult {
  valid: boolean;
  data?: any;
  errors?: Array<{
    instancePath: string;
    schemaPath: string;
    keyword: string;
    params: Record<string, any>;
    message?: string;
  }>;
}

/**
 * Conversion Direction
 */
export type ConversionDirection = 'openai-to-anthropic' | 'anthropic-to-openai' | 'passthrough';

/**
 * Message Format Detection
 */
export type MessageFormat = 'openai' | 'anthropic' | 'unknown';

/**
 * Tool Schema Mapping
 */
export interface ToolSchemaMap {
  [toolName: string]: {
    parameters?: any; // JSON Schema
    input_schema?: any; // Anthropic input_schema
  };
}

/**
 * Conversion Configuration
 */
export interface ConversionConfig {
  enableStreaming: boolean;
  enableTools: boolean;
  strictMode: boolean;
  fallbackToOriginal: boolean;
  customSchemas: Record<string, any>;
  performanceMonitoring: boolean;
}

/**
 * Performance Metrics
 */
export interface PerformanceMetrics {
  conversionTime: number;
  validationTime: number;
  totalTime: number;
  schemaCacheHits: number;
  schemaCacheMisses: number;
  errorCount: number;
}

/**
 * Conversion Context
 */
export interface ConversionContext {
  requestId: string;
  direction: ConversionDirection;
  originalFormat: MessageFormat;
  targetFormat: MessageFormat;
  toolSchemas?: ToolSchemaMap;
  metrics: PerformanceMetrics;
}

/**
 * Schema Cache Entry
 */
export interface SchemaCacheEntry {
  validateFunction: any; // AJV ValidateFunction
  lastUsed: number;
  useCount: number;
}

/**
 * Module Configuration
 */
export interface LLMSwitchAjvConfig extends ModuleConfig {
  config: ConversionConfig;
}

/**
 * Logger Interface
 */
export interface Logger {
  logModule(moduleId: string, event: string, data: any): void;
  logTransformation(moduleId: string, type: string, input: any, output: any): void;
  logPerformance(moduleId: string, metrics: PerformanceMetrics): void;
  logError(moduleId: string, error: Error, context?: any): void;
}

/**
 * JSON Schema types
 */
export interface JsonSchema {
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  definitions?: Record<string, JsonSchema>;
  type?: string | string[];
  properties?: Record<string, JsonSchema & { ['x-aliases']?: string[]; default?: any }>;
  required?: string[];
  items?: JsonSchema & { ['x-aliases']?: string[]; default?: any };
  additionalProperties?: boolean | JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  not?: JsonSchema;
  const?: any;
  enum?: any[];
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  default?: any;
}

/**
 * OpenAI Message Types
 */
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; text?: string; [key: string]: any }>;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: JsonSchema;
  };
}

/**
 * Anthropic Message Types
 */
export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: JsonSchema;
}

/**
 * Conversion Error Types
 */
export class ConversionError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: any
  ) {
    super(message);
    this.name = 'ConversionError';
  }
}

/**
 * ValidationError Types
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly validationErrors: any[],
    public readonly context?: any
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}