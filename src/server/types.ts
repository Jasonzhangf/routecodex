/**
 * Server type definitions
 * Type definitions for HTTP server and OpenAI router components
 */

import { type ModuleInfo } from 'rcc-basemodule';

/**
 * OpenAI API request types
 */
export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
}

export interface OpenAIChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  stream?: boolean;
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters: Record<string, any>;
    };
  }>;
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  user?: string;
}

export interface OpenAICompletionRequest {
  model: string;
  prompt: string | string[];
  suffix?: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  n?: number;
  stream?: boolean;
  logprobs?: number;
  echo?: boolean;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  best_of?: number;
  logit_bias?: Record<string, number>;
  user?: string;
}

export interface OpenAICompletionResponseChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    tool_calls?: OpenAIChatToolCall[];
  };
  finish_reason?: 'stop' | 'length' | 'tool_calls' | 'content_filter';
}

export interface OpenAICompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: OpenAICompletionResponseChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAIModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

/**
 * Server configuration types
 */
export interface ServerConfig {
  server: {
    port: number;
    host: string;
    cors?: {
      origin: string | string[];
      credentials?: boolean;
    };
    timeout?: number;
    bodyLimit?: string;
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    enableConsole?: boolean;
    enableFile?: boolean;
    filePath?: string;
    categories?: string[];
    categoryPath?: string;
  };
  providers: Record<string, any>;
  routing?: {
    strategy: 'round-robin' | 'weighted' | 'least-loaded';
    timeout?: number;
    retryAttempts?: number;
  };
}

/**
 * Provider configuration types
 */
export interface ProviderConfig {
  id: string;
  type: 'openai' | 'anthropic' | 'custom' | 'pass-through';
  enabled: boolean;
  baseUrl?: string;
  apiKey?: string;
  targetUrl?: string;
  models: Record<string, ModelConfig>;
  rateLimit?: {
    requestsPerMinute: number;
    tokensPerMinute: number;
  };
  timeout?: number;
  retryAttempts?: number;
  weight?: number;
  headers?: Record<string, string>;
}

export interface ModelConfig {
  id: string;
  maxTokens: number;
  temperature?: number;
  topP?: number;
  enabled: boolean;
  costPer1kTokens?: {
    input: number;
    output: number;
  };
  supportsStreaming?: boolean;
  supportsTools?: boolean;
  supportsVision?: boolean;
  contextWindow?: number;
}

/**
 * Request context types
 */
export interface RequestContext {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
  userAgent?: string;
  ip?: string;
  userId?: string;
}

export interface ResponseContext {
  id: string;
  requestId: string;
  timestamp: number;
  status: number;
  headers: Record<string, string>;
  body: any;
  duration: number;
  providerId?: string;
  modelId?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Error types
 */
export interface ServerError extends Error {
  code: string;
  status: number;
  context?: Record<string, any>;
  providerError?: any;
}

export class RouteCodexError extends Error implements ServerError {
  public code: string;
  public status: number;
  public context?: Record<string, any>;
  public providerError?: any;

  constructor(
    message: string,
    code: string,
    status: number = 500,
    context?: Record<string, any>,
    providerError?: any
  ) {
    super(message);
    this.name = 'RouteCodexError';
    this.code = code;
    this.status = status;
    this.context = context;
    this.providerError = providerError;
  }
}

/**
 * Health check types
 */
export interface HealthStatus {
  status: 'healthy' | 'unhealthy' | 'degraded';
  timestamp: string;
  uptime: number;
  memory: NodeJS.MemoryUsage;
  providers: Record<string, ProviderHealth>;
}

export interface ProviderHealth {
  status: 'healthy' | 'unhealthy' | 'unknown';
  responseTime?: number;
  lastCheck?: string;
  error?: string;
  consecutiveFailures: number;
  lastSuccess?: string;
}

export interface ProviderStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageResponseTime: number;
  totalTokensUsed: number;
  lastRequest?: string;
  lastError?: string;
  uptime?: number;
}

/**
 * Event types
 */
export interface ServerEvent {
  id: string;
  type: 'request_start' | 'request_end' | 'error' | 'provider_change' | 'config_update';
  timestamp: number;
  moduleId: string;
  data: any;
}

/**
 * Module info extension
 */
export interface ServerModuleInfo extends ModuleInfo {
  type: 'server';
  capabilities: string[];
  dependencies?: string[];
}

/**
 * HTTP server interface
 */
export interface IHttpServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): HealthStatus;
  getModuleInfo(): ServerModuleInfo;
}

/**
 * Router interface
 */
export interface IRouter {
  handleRequest(request: RequestContext): Promise<ResponseContext>;
  getRoutes(): Array<{
    method: string;
    path: string;
    handler: string;
  }>;
}

/**
 * Middleware types
 */
export type MiddlewareFunction = (
  req: any,
  res: any,
  next: (err?: any) => void
) => void;

export interface MiddlewareConfig {
  name: string;
  priority: number;
  middleware: MiddlewareFunction;
  enabled: boolean;
  paths?: string[];
  methods?: string[];
}

/**
 * Rate limiting types
 */
export interface RateLimitInfo {
  requests: number;
  windowStart: number;
  windowMs: number;
  limit: number;
  remaining: number;
  reset: number;
}

export interface RateLimitConfig {
  windowMs: number;
  max: number;
  skip?: (req: any) => boolean;
  keyGenerator?: (req: any) => string;
  handler?: (req: any, res: any) => void;
}

/**
 * Streaming types
 */
export interface StreamOptions {
  enabled: boolean;
  chunkSize?: number;
  timeout?: number;
  onChunk?: (chunk: string) => void;
  onError?: (error: Error) => void;
  onComplete?: () => void;
}

export interface StreamResponse {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      tool_calls?: OpenAIChatToolCall[];
    };
    finish_reason?: 'stop' | 'length' | 'tool_calls' | 'content_filter';
  }>;
}