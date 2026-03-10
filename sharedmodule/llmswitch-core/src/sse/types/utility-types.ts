/**
 * 工具类型定义
 * 提供JSON↔SSE双向转换中常用的工具类型和辅助函数
 */

import type { JsonObject, JsonValue } from './core-interfaces.js';

// 协议类型
export type ProtocolType = 'chat' | 'responses';

// 转换方向
export type ConversionDirection = 'json_to_sse' | 'sse_to_json';

// 事件类型映射
export interface EventTypeMap {
  chat: {
    SSE_EVENT: 'chat_chunk' | 'chat.done' | 'error' | 'ping';
    JSON_TYPE: 'ChatCompletionChunk' | 'ChatCompletionResponse';
  };
  responses: {
    SSE_EVENT: 'response.created' | 'response.in_progress' | 'response.completed' | 'response.required_action' | 'response.done' |
                'response.output_item.added' | 'response.output_item.done' |
                'response.content_part.added' | 'response.content_part.done' |
                'response.output_text.delta' | 'response.output_text.done' |
                'response.reasoning_text.delta' | 'response.reasoning_text.done' |
                'response.function_call_arguments.delta' | 'response.function_call_arguments.done';
    JSON_TYPE: 'ResponsesResponse' | 'ResponsesRequest';
  };
}

// 泛型转换器接口
export interface GenericConverter<TProtocol extends ProtocolType, TDirection extends ConversionDirection> {
  protocol: TProtocol;
  direction: TDirection;
  convert(input: unknown, options: JsonObject): Promise<unknown>;
  validate?(input: unknown): boolean;
  getStats?(): JsonObject;
}

// 统一转换选项
export interface UnifiedConversionOptions {
  requestId: string;
  model: string;
  protocol: ProtocolType;
  direction: ConversionDirection;
  timeoutMs?: number;
  enableHeartbeat?: boolean;
  heartbeatIntervalMs?: number;
  validationMode?: 'none' | 'basic' | 'strict';
  debugMode?: boolean;
  onError?: (error: Error) => void;
  onComplete?: () => void;
}

// 统一事件流
export interface UnifiedEventStream extends AsyncIterable<unknown> {
  protocol: ProtocolType;
  direction: ConversionDirection;
  requestId: string;

  // 获取统计信息
  getStats(): JsonObject;

  // 获取配置
  getConfig(): JsonObject;

  // 流控制
  pause?(): void;
  resume?(): void;
  complete(): void;
  abort(error?: Error): void;

  // 事件监听
  on?(event: 'error', handler: (error: Error) => void): this;
  on?(event: 'complete', handler: () => void): this;
  on?(event: 'timeout', handler: () => void): this;
  on?(event: 'stats', handler: (stats: JsonObject) => void): this;
}

// 工具类型
export type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;
export type RequireKeys<T, K extends keyof T> = T & Required<Pick<T, K>>;

// 条件类型
export type JsonType<TProtocol extends ProtocolType> =
  TProtocol extends 'chat' ? ChatJsonType :
  TProtocol extends 'responses' ? ResponsesJsonType :
  never;

export type SseEventType<TProtocol extends ProtocolType> =
  TProtocol extends 'chat' ? ChatSseEventType :
  TProtocol extends 'responses' ? ResponsesSseEventType :
  never;

// Chat相关类型（简化定义）
export interface ChatJsonType {
  id: string;
  object: 'chat.completion' | 'chat.completion.chunk';
  created: number;
  model: string;
  choices: unknown[];
  usage?: JsonObject;
}

export type ChatSseEventType = 'chat_chunk' | 'chat.done' | 'error' | 'ping';

// Responses相关类型（简化定义）
export interface ResponsesJsonType {
  id: string;
  object: 'response';
  created_at: number;
  model: string;
  status: string;
  output: unknown[];
  usage?: JsonObject;
}

export type ResponsesSseEventType =
  | 'response.created'
  | 'response.in_progress'
  | 'response.completed'
  | 'response.required_action'
  | 'response.done'
  | 'response.output_item.added'
  | 'response.output_item.done'
  | 'response.content_part.added'
  | 'response.content_part.done'
  | 'response.output_text.delta'
  | 'response.output_text.done'
  | 'response.reasoning_text.delta'
  | 'response.reasoning_text.done'
  | 'response.function_call_arguments.delta'
  | 'response.function_call_arguments.done';

// 转换结果
export interface ConversionResult<TSuccess = unknown, TError = Error> {
  success: boolean;
  data?: TSuccess;
  error?: TError;
  metadata?: {
    duration: number;
    eventsProcessed: number;
    bytesProcessed: number;
    protocol: ProtocolType;
    direction: ConversionDirection;
  };
}

// 异步转换结果
export type AsyncConversionResult<TSuccess = unknown, TError = Error> = Promise<ConversionResult<TSuccess, TError>>;

// 转换工厂接口
export interface ConverterFactory {
  createJsonToSseConverter<TProtocol extends ProtocolType>(
    protocol: TProtocol,
    options: UnifiedConversionOptions
  ): GenericConverter<TProtocol, 'json_to_sse'>;

  createSseToJsonConverter<TProtocol extends ProtocolType>(
    protocol: TProtocol,
    options: UnifiedConversionOptions
  ): GenericConverter<TProtocol, 'sse_to_json'>;
}

// 转换器注册表
export interface ConverterRegistry {
  register<TProtocol extends ProtocolType, TDirection extends ConversionDirection>(
    protocol: TProtocol,
    direction: TDirection,
    converter: GenericConverter<TProtocol, TDirection>
  ): void;

  get<TProtocol extends ProtocolType, TDirection extends ConversionDirection>(
    protocol: TProtocol,
    direction: TDirection
  ): GenericConverter<TProtocol, TDirection> | undefined;

  list(): Array<{
    protocol: ProtocolType;
    direction: ConversionDirection;
    converter: GenericConverter<ProtocolType, ConversionDirection>;
  }>;
}

// 验证器接口
export interface Validator<T> {
  validate(input: T): ValidationResult;
  isValid(input: T): boolean;
  getErrors(input: T): string[];
}

// 验证结果
export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

// 验证错误
export interface ValidationError {
  code: string;
  message: string;
  path: string;
  value?: JsonValue;
}

// 验证警告
export interface ValidationWarning {
  code: string;
  message: string;
  path: string;
  value?: JsonValue;
}

// 序列化器接口
export interface Serializer<T> {
  serialize(input: T): string;
  deserialize(input: string): T;
  isValid(input: string): boolean;
}

// 缓存接口
export interface Cache<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  has(key: K): boolean;
  delete(key: K): boolean;
  clear(): void;
  size: number;
}

// 指标收集器接口
export interface MetricsCollector {
  incrementCounter(name: string, tags?: Record<string, string>): void;
  recordHistogram(name: string, value: number, tags?: Record<string, string>): void;
  setGauge(name: string, value: number, tags?: Record<string, string>): void;
  recordTimer(name: string, duration: number, tags?: Record<string, string>): void;
  getMetrics(): Record<string, unknown>;
}

// 日志记录器接口
type LoggerMetadata = Record<string, unknown>;

export interface Logger {
  debug(message: string, meta?: LoggerMetadata): void;
  info(message: string, meta?: LoggerMetadata): void;
  warn(message: string, meta?: LoggerMetadata): void;
  error(message: string, error?: Error, meta?: LoggerMetadata): void;
  child(meta: LoggerMetadata): Logger;
}

// 重试配置
export interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitter: boolean;
  retryableErrors: string[];
}

// 断路器配置
export interface CircuitBreakerConfig {
  failureThreshold: number;
  recoveryTimeoutMs: number;
  monitoringPeriodMs: number;
  expectedRecoveryTimeMs: number;
}

// 限流配置
export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  burstSize?: number;
  strategy: 'sliding_window' | 'fixed_window' | 'token_bucket';
}

// 健康检查接口
export interface HealthCheck {
  isHealthy(): Promise<boolean>;
  getStatus(): HealthStatus;
  onHealthChange(callback: (status: HealthStatus) => void): void;
}

// 健康状态
export interface HealthStatus {
  healthy: boolean;
  timestamp: number;
  details?: Record<string, unknown>;
}

// 生命周期钩子
type LifecycleContext = Record<string, unknown>;

export interface LifecycleHooks {
  beforeConversion?: (context: LifecycleContext) => Promise<void>;
  afterConversion?: (context: LifecycleContext, result: unknown) => Promise<void>;
  onError?: (context: LifecycleContext, error: Error) => Promise<void>;
  onTimeout?: (context: LifecycleContext) => Promise<void>;
  onRetry?: (context: LifecycleContext, attempt: number) => Promise<void>;
}

// 中间件接口
export interface Middleware {
  name: string;
  priority: number;
  beforeConversion?: (context: LifecycleContext) => Promise<void>;
  afterConversion?: (context: LifecycleContext, result: unknown) => Promise<void>;
  onError?: (context: LifecycleContext, error: Error) => Promise<void>;
}

// 插件接口
export interface Plugin {
  name: string;
  version: string;
  initialize(context: LifecycleContext): Promise<void>;
  destroy(): Promise<void>;
  getMiddlewares(): Middleware[];
  getHooks(): LifecycleHooks;
}

// 配置合并器
export interface ConfigMerger {
  merge<T>(base: T, override: Partial<T>): T;
  validate<T>(config: T): ValidationResult;
  normalize<T>(config: T): T;
}

// 环境变量解析器
export interface EnvironmentParser {
  getString(key: string, defaultValue?: string): string;
  getNumber(key: string, defaultValue?: number): number;
  getBoolean(key: string, defaultValue?: boolean): boolean;
  getArray(key: string, delimiter?: string): string[];
  getObject(key: string): JsonObject;
}

// 类型守卫工具函数
export const TypeGuards = {
  isString: (value: unknown): value is string => typeof value === 'string',
  isNumber: (value: unknown): value is number => typeof value === 'number' && !Number.isNaN(value),
  isBoolean: (value: unknown): value is boolean => typeof value === 'boolean',
  isObject: (value: unknown): value is JsonObject =>
    value !== null && typeof value === 'object' && !Array.isArray(value),
  isArray: (value: unknown): value is JsonValue[] => Array.isArray(value),
  isFunction: (value: unknown): value is (...args: unknown[]) => unknown => typeof value === 'function',
  isDate: (value: unknown): value is Date => value instanceof Date,
  isNull: (value: unknown): value is null => value === null,
  isUndefined: (value: unknown): value is undefined => value === undefined,
  isNullOrUndefined: (value: unknown): value is null | undefined =>
    value === null || value === undefined
};

// 异步工具函数
export const AsyncUtils = {
  delay: (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms)),
  timeout: <T>(promise: Promise<T>, ms: number): Promise<T> => {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Operation timed out after ${ms}ms`)), ms)
      )
    ]);
  },
  retry: async <T>(
    fn: () => Promise<T>,
    config: RetryConfig
  ): Promise<T> => {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        lastError = normalizedError;
        if (!config.retryableErrors.includes(normalizedError.name) || attempt === config.maxAttempts) {
          throw normalizedError;
        }
        const delay = Math.min(
          config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt - 1),
          config.maxDelayMs
        );
        const jitter = config.jitter ? Math.random() * delay * 0.1 : 0;
        await AsyncUtils.delay(delay + jitter);
      }
    }
    throw lastError ?? new Error('Operation failed after retry attempts');
  }
};
