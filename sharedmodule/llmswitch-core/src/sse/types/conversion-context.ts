/**
 * 转换上下文类型定义
 * 定义JSON<>SSE双向转换过程中的上下文信息
 */

import type { JsonObject, JsonValue } from './core-interfaces.js';
import type { SseEvent, SseEventStats, SseEventType } from './sse-events.js';

// 基础转换上下文
export interface BaseConversionContext {
  requestId: string;
  model: string;
  createdAt: number;
  outputIndexCounter: number;
  sequenceCounter: number;
  timeoutMs?: number;
  heartbeatTimer?: NodeJS.Timeout;
  isCompleted: boolean;
  lastEventTime: number;
  logger: ConversionLogger;
}

// JSON→SSE转换上下文
export interface JsonToSseContext extends BaseConversionContext {
  jsonResponse: ResponsesJson;
  options: JsonToSseOptions;
  eventStats: SseEventStats;
  startTime: number;
  currentOutputIndex: number;
  contentIndexCounter: Map<string, number>;
  itemIds: Map<string, string>;
  activeOutputItems: Map<number, OutputItemState>;
}

// SSE→JSON转换上下文
export interface SseToJsonContext extends BaseConversionContext {
  options: SseToJsonOptions;
  aggregatedEvents: SseEvent[];
  partialResponse: ResponsesPartialJson;
  completionTimeout?: NodeJS.Timeout;
  outputItems: Map<number, OutputItemBuilder>;
  lastSequenceNumber: number;
  expectedSequenceNumbers: Set<number>;
  isResponseCreated: boolean;
  isInProgress: boolean;
}

type ConversionContextUnion = JsonToSseContext | SseToJsonContext;

// JSON→SSE转换选项
export interface JsonToSseOptions {
  requestId: string;
  model: string;
  timeoutMs?: number;
  heartbeatIntervalMs?: number;
  chunkSize?: number;
  delayMs?: number;
  includeSequenceNumbers?: boolean;
  enableHeartbeat?: boolean;
  validationMode?: 'none' | 'basic' | 'strict';
  onEvent?: (event: SseEvent) => void;
  onError?: (error: Error) => void;
  onComplete?: () => void;
}

// SSE→JSON转换选项
export interface SseToJsonOptions {
  requestId: string;
  timeoutMs?: number;
  validateEvents?: boolean;
  enableSequenceValidation?: boolean;
  onPartialResult?: (partial: ResponsesPartialJson) => void;
  onEvent?: (event: SseEvent) => void;
  onCompletion?: (final: ResponsesJson) => void;
  onError?: (error: Error) => void;
  onTimeout?: () => void;
}

// Responses JSON类型
export interface ResponsesJson {
  id: string;
  object: 'response';
  created_at: number;
  model: string;
  status: 'in_progress' | 'requires_action' | 'completed';
  output: OutputItem[];
  usage?: UsageInfo;
  previous_response_id?: string | null;
  required_action?: RequiredAction;
  output_text?: string;
}

// 部分结果接口
export interface ResponsesPartialJson {
  id: string;
  object: 'response';
  created_at: number;
  model: string;
  status: 'in_progress' | 'requires_action' | 'completed';
  output: OutputItem[];
  usage?: UsageInfo;
  required_action?: RequiredAction;
  output_text?: string;
}

// 输出项目状态
export interface OutputItemState {
  id: string;
  type: string;
  status: 'in_progress' | 'completed';
  contentIndex: number;
  isContentPartAdded: boolean;
  isTextStarted: boolean;
  isTextCompleted: boolean;
  accumulatedText: string;
  accumulatedDelta: string;
}

// 输出项目构建器
export interface OutputItemBuilder {
  item: OutputItem;
  isCompleted: boolean;
  contentParts: ContentPart[];
  currentContentIndex: number;
  accumulatedText: string;
  hasContentPartAdded: boolean;
  isTextInProgress: boolean;
}

// 转换日志记录器
type LoggerMetadata = Record<string, unknown>;

export interface ConversionLogger {
  debug(message: string, meta?: LoggerMetadata): void;
  info(message: string, meta?: LoggerMetadata): void;
  warn(message: string, meta?: LoggerMetadata): void;
  error(message: string, error?: Error, meta?: LoggerMetadata): void;
  event(eventType: string, data?: LoggerMetadata): void;
  metric(name: string, value: number, tags?: Record<string, string>): void;
}

// 转换错误类型
export interface ConversionError extends Error {
  code: string;
  requestId: string;
  eventType?: string;
  sequenceNumber?: number;
  context?: JsonObject;
}

// 流状态信息
export interface StreamState {
  isStarted: boolean;
  isCompleted: boolean;
  isAborted: boolean;
  lastActivityTime: number;
  totalEventsProcessed: number;
  bytesProcessed: number;
  errorCount: number;
}

// SSE事件流
export interface SseEventStream extends AsyncIterable<SseEvent> {
  // 获取流统计信息
  getStats(): SseEventStats;
  // 获取流状态
  getState(): StreamState;
  // 手动完成流
  complete(): void;
  // 手动中止流
  abort(error?: Error): void;
  // 监听器
  on?(event: 'error', handler: (error: Error) => void): this;
  on?(event: 'complete', handler: () => void): this;
  on?(event: 'timeout', handler: () => void): this;
  on?(event: 'stats', handler: (stats: SseEventStats) => void): this;
}

// 转换配置
export interface ConversionConfig {
  // 超时配置
  defaultTimeoutMs: number;
  heartbeatIntervalMs: number;
  inactivityTimeoutMs: number;

  // 分块配置
  defaultChunkSize: number;
  defaultDelayMs: number;

  // 验证配置
  enableEventValidation: boolean;
  enableSequenceValidation: boolean;
  strictMode: boolean;

  // 性能配置
  maxConcurrentEvents: number;
  eventBufferSize: number;

  // 调试配置
  debugMode: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  enableMetrics: boolean;
}

// 预定义配置
export const DEFAULT_CONVERSION_CONFIG: ConversionConfig = {
  defaultTimeoutMs: 30000,
  heartbeatIntervalMs: 15000,
  inactivityTimeoutMs: 60000,

  defaultChunkSize: 12,
  defaultDelayMs: 8,

  enableEventValidation: true,
  enableSequenceValidation: true,
  strictMode: false,

  maxConcurrentEvents: 10,
  eventBufferSize: 1000,

  debugMode: false,
  logLevel: 'info',
  enableMetrics: true
};

// 事件处理器
export interface EventHandler {
  canHandle(eventType: SseEventType): boolean;
  handle(event: SseEvent, context: ConversionContextUnion): Promise<void>;
}

// 转换中间件
export interface ConversionMiddleware {
  name: string;
  beforeConversion?: (context: ConversionContextUnion) => Promise<void>;
  afterConversion?: (context: ConversionContextUnion, result: unknown) => Promise<void>;
  onError?: (context: ConversionContextUnion, error: Error) => Promise<void>;
}

// 从现有类型导入
interface OutputItem {
  id: string;
  type: 'reasoning' | 'message' | 'function_call' | 'system_message';
  status?: 'in_progress' | 'completed';
  content?: ContentPart[];
  summary?: JsonValue[];
  role?: string;
  arguments?: string;
  call_id?: string;
  name?: string;
  message?: MessageContent;
}

interface ContentPart {
  type: 'reasoning_text' | 'output_text' | 'input_text' | 'commentary';
  text: string;
}

interface MessageContent {
  id?: string;
  role: string;
  status?: string;
  content: ContentPart[];
}

interface UsageInfo {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  output_tokens_details?: {
    reasoning_tokens: number;
  };
}

interface RequiredAction {
  type: 'submit_tool_outputs';
  submit_tool_outputs: {
    tool_calls: ToolCall[];
  };
}

interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}
