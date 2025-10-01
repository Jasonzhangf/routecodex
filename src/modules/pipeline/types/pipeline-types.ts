/**
 * Pipeline Module - Type Definitions
 *
 * Core type definitions for the pipeline system with comprehensive type safety.
 */

import type {
  PipelineConfig,
  PipelineRequest,
  PipelineResponse,
  TransformationRule,
  ProviderConfig
} from '../interfaces/pipeline-interfaces.js';
import type { PipelineManagerConfig } from '../interfaces/pipeline-interfaces.js';

// Re-export PipelineConfig for compatibility
export type { PipelineConfig };

/**
 * Pipeline initialization state
 */
export type PipelineInitializationState = 'pending' | 'initializing' | 'ready' | 'failed';

/**
 * Module type mapping
 */
export interface ModuleTypeMapping {
  'llmswitch-openai-openai': import('../modules/llmswitch/openai-normalizer.js').OpenAINormalizerLLMSwitch;
  'llmswitch-anthropic-openai': import('../modules/llmswitch/anthropic-openai-converter.js').AnthropicOpenAIConverter;
  'streaming-control': import('../modules/workflow/streaming-control.js').StreamingControlWorkflow;
  'field-mapping': import('../modules/compatibility/field-mapping.js').FieldMappingCompatibility;
  'qwen-provider': import('../modules/provider/qwen-provider.js').QwenProvider;
  'generic-http': import('../modules/provider/generic-http-provider.js').GenericHTTPProvider;
}

/**
 * Pipeline module configuration variants
 */
export type PipelineModuleConfig =
  | { type: 'llmswitch-openai-openai'; config: Record<string, any> }
  | { type: 'llmswitch-anthropic-openai'; config: Record<string, any> }
  | { type: 'streaming-control'; config: Record<string, any> }
  | { type: 'field-mapping'; config: { rules: TransformationRule[] } }
  | { type: 'qwen-provider'; config: Record<string, any> }
  | { type: 'generic-http'; config: Record<string, any> };

/**
 * Pipeline request with type safety
 */
export interface TypedPipelineRequest<T = any> extends Omit<PipelineRequest, 'data'> {
  data: T;
}

/**
 * Pipeline response with type safety
 */
export interface TypedPipelineResponse<T = any> extends Omit<PipelineResponse, 'data'> {
  data: T;
}

/**
 * Transformation rule with type safety
 */
export interface TypedTransformationRule<T = any> extends TransformationRule {
  transform: 'mapping' | 'rename' | 'extract' | 'combine' | 'conditional';
  mapping?: Record<string, T>;
}

/**
 * Provider configuration variants
 */
export type ProviderConfigVariant =
  | { type: 'qwen'; baseUrl: string; auth: { type: 'apikey'; apiKey: string } }
  | { type: 'openai'; baseUrl: string; auth: { type: 'apikey'; apiKey: string } }
  | { type: 'custom'; baseUrl: string; auth: { type: 'apikey' | 'oauth'; credentials: any } };

/**
 * Error handling options
 */
export interface PipelineErrorOptions {
  /** Whether to retry on error */
  retry: boolean;
  /** Maximum retry attempts */
  maxRetries: number;
  /** Retry delay in milliseconds */
  retryDelay: number;
  /** Whether to fail fast */
  failFast: boolean;
}

/**
 * Debug logging options
 */
export interface PipelineDebugOptions {
  /** Debug level */
  level: 'none' | 'basic' | 'detailed' | 'verbose';
  /** Log format */
  format: 'json' | 'text';
  /** Output targets */
  outputs: ('console' | 'file' | 'debug-center')[];
  /** Maximum log entries to keep */
  maxEntries: number;
}

/**
 * Performance monitoring options
 */
export interface PipelinePerformanceOptions {
  /** Whether to enable performance monitoring */
  enabled: boolean;
  /** Sampling rate (0-1) */
  samplingRate: number;
  /** Metrics to collect */
  metrics: ('response-time' | 'memory-usage' | 'cpu-usage' | 'throughput')[];
  /** Reporting interval in milliseconds */
  reportingInterval: number;
}

/**
 * Pipeline health status
 */
export interface PipelineHealthStatus {
  /** Overall health status */
  status: 'healthy' | 'degraded' | 'unhealthy';
  /** Component health */
  components: {
    llmSwitch: 'healthy' | 'degraded' | 'unhealthy';
    workflow: 'healthy' | 'degraded' | 'unhealthy';
    compatibility: 'healthy' | 'degraded' | 'unhealthy';
    provider: 'healthy' | 'degraded' | 'unhealthy';
  };
  /** Health check timestamp */
  timestamp: number;
  /** Health issues */
  issues: string[];
}

/**
 * Pipeline metrics
 */
export interface PipelineMetrics {
  /** Request metrics */
  requests: {
    total: number;
    successful: number;
    failed: number;
    averageResponseTime: number;
    p95ResponseTime: number;
    p99ResponseTime: number;
  };
  /** Module metrics */
  modules: Record<string, {
    processingTime: number;
    successRate: number;
    errorRate: number;
  }>;
  /** System metrics */
  system: {
    memoryUsage: number;
    cpuUsage: number;
    uptime: number;
  };
  /** Metrics timestamp */
  timestamp: number;
}

/**
 * Pipeline configuration validation result
 */
export interface PipelineConfigValidation {
  /** Whether configuration is valid */
  isValid: boolean;
  /** Validation errors */
  errors: string[];
  /** Validation warnings */
  warnings: string[];
  /** Normalized configuration */
  normalizedConfig?: PipelineConfig;
}

/**
 * Pipeline event types
 */
export type PipelineEventType =
  | 'pipeline-initialized'
  | 'pipeline-started'
  | 'pipeline-completed'
  | 'pipeline-failed'
  | 'module-initialized'
  | 'module-error'
  | 'transformation-applied'
  | 'provider-request'
  | 'provider-response'
  | 'debug-log';

/**
 * Pipeline event interface
 */
export interface PipelineEvent<T = any> {
  /** Event type */
  type: PipelineEventType;
  /** Event timestamp */
  timestamp: number;
  /** Pipeline identifier */
  pipelineId: string;
  /** Event data */
  data: T;
  /** Event metadata */
  metadata?: Record<string, any>;
}

/**
 * Pipeline event handler
 */
export type PipelineEventHandler<T = any> = (event: PipelineEvent<T>) => Promise<void> | void;

/**
 * Pipeline event emitter interface
 */
export interface PipelineEventEmitter {
  /**
   * Add event listener
   */
  on<T>(eventType: PipelineEventType, handler: PipelineEventHandler<T>): void;

  /**
   * Remove event listener
   */
  off<T>(eventType: PipelineEventType, handler: PipelineEventHandler<T>): void;

  /**
   * Emit event
   */
  emit<T>(eventType: PipelineEventType, data: T, metadata?: Record<string, any>): Promise<void>;
}

/**
 * Pipeline context interface
 */
export interface PipelineContext {
  /** Pipeline configuration */
  config: PipelineConfig;
  /** Request ID */
  requestId: string;
  /** Timestamp */
  timestamp: number;
  /** User context */
  user?: {
    id: string;
    roles: string[];
    permissions: string[];
  };
  /** Session context */
  session?: {
    id: string;
    data: Record<string, any>;
  };
}

/**
 * Transformation context interface
 */
export interface TransformationContext {
  /** Pipeline context */
  pipelineContext: PipelineContext;
  /** Transformation rules */
  rules: TransformationRule[];
  /** Original data */
  originalData: any;
  /** Current transformation state */
  state: Record<string, any>;
}

/**
 * Provider context interface
 */
export interface ProviderContext {
  /** Pipeline context */
  pipelineContext: PipelineContext;
  /** Provider configuration */
  providerConfig: ProviderConfigVariant;
  /** Authentication context */
  auth?: {
    type: string;
    token?: string;
    expiresAt?: number;
  };
}

/**
 * Module context interface
 */
export interface ModuleContext {
  /** Pipeline context */
  pipelineContext: PipelineContext;
  /** Module configuration */
  moduleConfig: PipelineModuleConfig;
  /** Dependencies */
  dependencies: {
    errorHandlingCenter: any;
    debugCenter: any;
    logger: any;
  };
}

/**
 * Pipeline request processor interface
 */
export interface PipelineRequestProcessor {
  /**
   * Process a request through the pipeline
   */
  process(request: PipelineRequest): Promise<PipelineResponse>;

  /**
   * Process multiple requests in parallel
   */
  processBatch(requests: PipelineRequest[]): Promise<PipelineResponse[]>;

  /**
   * Get processor status
   */
  getStatus(): {
    isRunning: boolean;
    activeRequests: number;
    queueSize: number;
  };
}

// Use the canonical definition from interfaces to avoid duplication
export type { PipelineManagerConfig } from '../interfaces/pipeline-interfaces.js';

/**
 * Pipeline configuration loader interface
 */
export interface PipelineConfigLoader {
  /**
   * Load pipeline configuration
   */
  load(configPath: string): Promise<PipelineManagerConfig>;

  /**
   * Validate configuration
   */
  validate(config: PipelineManagerConfig): Promise<PipelineConfigValidation>;

  /**
   * Watch for configuration changes
   */
  watch(configPath: string, callback: (config: PipelineManagerConfig) => void): void;
}

/**
 * OpenAI chat completion request
 */
export interface OpenAIChatCompletionRequest {
  /** Messages to send to the model */
  messages: OpenAIChatCompletionMessage[];
  /** ID of the model to use */
  model: string;
  /** Sampling temperature to use */
  temperature?: number;
  /** Maximum number of tokens to generate */
  max_tokens?: number;
  /** Nucleus sampling probability */
  top_p?: number;
  /** Penalty for repeating tokens */
  presence_penalty?: number;
  /** Penalty for new tokens */
  frequency_penalty?: number;
  /** Generate multiple completions */
  n?: number;
  /** Stop sequences */
  stop?: string | string[];
  /** Stream responses */
  stream?: boolean;
  /** Log probabilities */
  logprobs?: number;
  /** Echo the prompt in addition to the completion */
  echo?: boolean;
  /** User identifier */
  user?: string;
  /** Tools for function calling */
  tools?: OpenAIChatCompletionTool[];
  /** Tool choice behavior */
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  /** Response format */
  response_format?: { type: 'text' | 'json_object' };
  /** Seed for deterministic sampling */
  seed?: number;
}

/**
 * OpenAI chat completion message
 */
export interface OpenAIChatCompletionMessage {
  /** Message role */
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Message content */
  content: string | Array<{ type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }>;
  /** Tool call ID (for tool messages) */
  tool_call_id?: string;
  /** Name of the tool (for tool messages) */
  name?: string;
  /** Tool calls (for assistant messages) */
  tool_calls?: OpenAIChatCompletionToolCall[];
}

/**
 * OpenAI chat completion tool
 */
export interface OpenAIChatCompletionTool {
  /** Tool type */
  type: 'function';
  /** Function definition */
  function: {
    /** Function name */
    name: string;
    /** Function description */
    description?: string;
    /** Function parameters */
    parameters: Record<string, any>;
  };
}

/**
 * OpenAI chat completion tool call
 */
export interface OpenAIChatCompletionToolCall {
  /** Tool call ID */
  id: string;
  /** Tool type */
  type: 'function';
  /** Function call information */
  function: {
    /** Function name */
    name: string;
    /** Function arguments */
    arguments: string;
  };
}

/**
 * OpenAI chat completion response
 */
export interface OpenAIChatCompletionResponse {
  /** Unique identifier for the completion */
  id: string;
  /** Object type (always 'chat.completion') */
  object: 'chat.completion';
  /** Timestamp when the completion was created */
  created: number;
  /** Model used for the completion */
  model: string;
  /** System fingerprint */
  system_fingerprint?: string;
  /** Array of completion choices */
  choices: OpenAIChatCompletionChoice[];
  /** Usage statistics */
  usage: OpenAIChatCompletionUsage;
  /** Service tier */
  service_tier?: string;
}

/**
 * OpenAI chat completion choice
 */
export interface OpenAIChatCompletionChoice {
  /** Index of the choice */
  index: number;
  /** Message object */
  message: OpenAIChatCompletionMessage;
  /** Reason the model stopped generating */
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter';
  /** Log probabilities */
  logprobs?: any;
}

/**
 * OpenAI chat completion usage statistics
 */
export interface OpenAIChatCompletionUsage {
  /** Number of prompt tokens used */
  prompt_tokens: number;
  /** Number of completion tokens used */
  completion_tokens: number;
  /** Total number of tokens used */
  total_tokens: number;
}

/**
 * Qwen provider configuration
 */
export interface QwenProviderConfig {
  type: 'qwen';
  baseUrl: string;
  auth: {
    type: 'apikey';
    apiKey: string;
  };
  models: Record<string, any>;
  compatibility?: any;
}

/**
 * LM Studio provider configuration
 */
export interface LMStudioProviderConfig {
  type: 'lmstudio';
  baseUrl: string;
  auth: {
    type: 'none';
  };
  models: Record<string, any>;
  compatibility?: any;
}

/**
 * Generic provider configuration
 */
export interface GenericProviderConfig {
  type: 'generic';
  baseUrl: string;
  auth: {
    type: 'apikey' | 'bearer' | 'none';
    apiKey?: string;
    token?: string;
  };
  models: Record<string, any>;
  compatibility?: any;
}
