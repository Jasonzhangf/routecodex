/**
 * Responses协议相关类型定义
 * 支持OpenAI Responses API的JSON↔SSE双向转换
 */

import type { BaseSseEvent, StreamDirection, JsonObject, JsonValue } from './core-interfaces.js';
import type { RequiredAction } from './sse-events.js';

// 重新导出基础事件类型
export * from './sse-events.js';

// Responses事件类型（基于SseEventType但扩展Responses协议特定事件）
export type ResponsesSseEventType =
  // 基础SSE事件类型
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
  | 'response.reasoning_signature.delta'
  | 'response.reasoning_image.delta'
  | 'response.reasoning_summary_part.added'
  | 'response.reasoning_summary_part.done'
  | 'response.reasoning_summary_text.delta'
  | 'response.reasoning_summary_text.done'
  | 'response.function_call_arguments.delta'
  | 'response.function_call_arguments.done'
  | 'response.error'
  | 'response.cancelled'
  // 兼容性事件类型（旧版本）
  | 'response.start'
  | 'content_part.delta'
  | 'reasoning.delta'
  | 'function_call.start'
  | 'function_call.delta'
  | 'function_call.done'
  | 'output_item.start'
  | 'content_part.start'
  // 扩展的Responses协议事件
  | 'content_part.done'
  | 'output_item.done'
  | 'reasoning.start'
  | 'reasoning.done'
  | 'required_action'
  | 'error';

// Responses SSE事件结构 - 扩展基础接口
export interface ResponsesSseEvent extends BaseSseEvent {
  /** 事件类型（Responses协议使用点分隔符） */
  type: ResponsesSseEventType;
  /** 时间戳 */
  timestamp: number;
  /** 协议标识 */
  protocol: 'responses';
  /** 方向标识 */
  direction: StreamDirection;
}

// Responses转换上下文
export interface ResponsesJsonToSseContext {
  requestId: string;
  model: string;
  responsesRequest: ResponsesRequest;
  options: ResponsesJsonToSseOptions;
  startTime: number;
  sequenceCounter: number;
  outputIndexCounter: number;
  contentIndexCounter: Map<string, number>;
  isStreaming: boolean;
  currentResponse: Partial<ResponsesResponse>;
  responsesResponse?: ResponsesResponse;
  eventStats: ResponsesEventStats;
  outputItemStates: Map<string, OutputItemProcessingState>;
}

export interface SseToResponsesJsonContext {
  requestId: string;
  model: string;
  options: SseToResponsesJsonOptions;
  startTime: number;
  endTime?: number;
  duration?: number;
  aggregatedEvents: ResponsesSseEvent[];
  currentResponse: Partial<ResponsesResponse>;
  outputItemBuilders: Map<string, OutputItemBuilder>;
  eventStats: ResponsesEventStats;
  isCompleted: boolean;
  isResponseCreated: boolean;
  isInProgress: boolean;
  lastSequenceNumber: number;
}

// Responses请求类型
export interface ResponsesRequest {
  model: string;
  input: ResponsesInput[];
  tools?: ResponsesTool[];
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  metadata?: JsonObject;
  store?: boolean;
  truncation?: 'auto' | 'disabled';
  user?: string;
  include?: ('user.id' | 'user.name' | 'user.email' | string)[];
  parallel_tool_calls?: boolean;
  previous_response_id?: string;
  reasoning?: ResponsesReasoningConfig;
  stream?: boolean;
}

// Responses输入
export interface ResponsesInput {
  role: 'user' | 'assistant' | 'system';
  content: ResponsesContent[];
  name?: string;
}

// Responses内容
export type ResponsesContent =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: 'auto' | 'low' | 'high' }
  | { type: 'file_search'; file_search: JsonObject }
  | { type: 'computer_use'; computer_use: JsonObject }
  | { type: 'function_call'; name: string; arguments: string }
  | { type: 'function_result'; result: JsonValue; tool_call_id: string }
  | { type: 'conversation'; conversation: JsonValue[] };

// Responses工具
export interface ResponsesTool {
  type: 'function';
  name: string;
  description?: string;
  parameters?: JsonObject;
  strict?: boolean;
}

// Responses推理配置
export interface ResponsesReasoningConfig {
  max_tokens: number;
  summarize?: boolean;
  summarize_threshold?: number;
}

// Responses响应
export interface ResponsesResponse {
  id: string;
  object: 'response';
  created_at: number;
  status: 'in_progress' | 'requires_action' | 'completed' | 'failed' | 'incomplete';
  error?: JsonValue;
  model: string;
  output: ResponsesOutputItem[];
  previous_response_id?: string;
  usage?: ResponsesUsage;
  required_action?: RequiredAction;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  metadata?: JsonObject;
  user?: string;
  store?: boolean;
  truncation?: 'auto' | 'disabled';
  include?: string[];
  parallel_tool_calls?: boolean;
}

// Responses输出项
export type ResponsesOutputItem =
  | ResponsesMessageItem
  | ResponsesReasoningItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem
  | ResponsesSystemItem;

// Responses消息项
export interface ResponsesMessageItem {
  id: string;
  type: 'message';
  status: 'in_progress' | 'completed';
  role: 'assistant';
  content: ResponsesContent[];
}

// Responses推理项
export interface ResponsesReasoningItem {
  id: string;
  type: 'reasoning';
  summary?: Array<string | { type: 'summary_text'; text: string }>;
  content?: ResponsesReasoningContent[];
  encrypted_content?: string;
}

// Responses推理内容
export type ResponsesReasoningContent =
  | { type: 'reasoning_text'; text: string }
  | { type: 'reasoning_signature'; signature: JsonObject }
  | { type: 'reasoning_image'; image_url: string };

// Responses函数调用项
export interface ResponsesFunctionCallItem {
  id: string;
  type: 'function_call';
  status: 'in_progress' | 'completed';
  call_id: string;
  name: string;
  arguments: string;
}

// Responses函数调用输出项
export interface ResponsesFunctionCallOutputItem {
  id: string;
  type: 'function_call_output';
  call_id: string;
  output: JsonValue;
  tool_call_id?: string;
}

// Responses系统项
export interface ResponsesSystemItem {
  id: string;
  type: 'system';
  name: string;
  data: JsonValue;
}

// Responses使用量
export interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details: {
    cached_tokens: number;
    audio_tokens: number;
    text_tokens: number;
    image_tokens: number;
  };
  output_tokens_details: {
    reasoning_tokens: number;
    audio_tokens: number;
    text_tokens: number;
  };
}

// Responses必需动作
export interface ResponsesRequiredAction {
  type: 'submit_tool_outputs' | 'run_parallel_tools';
  submit_tool_outputs?: {
    tool_calls: ResponsesToolCall[];
  };
  run_parallel_tools?: {
    tool_calls: ResponsesToolCall[];
  };
}

// Responses工具调用
export interface ResponsesToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

// Responses转换选项
export interface ResponsesJsonToSseOptions {
  requestId: string;
  model: string;
  timeoutMs?: number;
  enableHeartbeat?: boolean;
  heartbeatIntervalMs?: number;
  chunkSize?: number;
  delayMs?: number;
  includeSequenceNumbers?: boolean;
  includeMetadata?: boolean;
  validationMode?: 'none' | 'basic' | 'strict';
  onEvent?: (event: ResponsesSseEvent) => void;
  onError?: (error: Error) => void;
  onComplete?: () => void;
  resumeToolOutputs?: ResponsesFunctionCallOutputItem[];
}

export interface SseToResponsesJsonOptions {
  requestId: string;
  model: string;
  timeoutMs?: number;
  validateEvents?: boolean;
  enableSequenceValidation?: boolean;
  accumulateOutputItems?: boolean;
  onPartialResult?: (partial: Partial<ResponsesResponse>) => void;
  onEvent?: (event: ResponsesSseEvent) => void;
  onCompletion?: (final: ResponsesResponse) => void;
  onError?: (error: Error) => void;
  onTimeout?: () => void;
}

// Responses事件统计
export interface ResponsesEventStats {
  totalEvents: number;
  eventTypes: Record<string, number>;
  startTime: number;
  endTime?: number;
  duration?: number;
  outputItemsCount: number;
  contentPartsCount: number;
  deltaEventsCount: number;
  reasoningEventsCount: number;
  functionCallEventsCount: number;
  messageEventsCount: number;
  errorCount: number;
  lastEventTime?: number;
}

// 输出项处理状态
export interface OutputItemProcessingState {
  id: string;
  type: string;
  status: 'in_progress' | 'completed';
  contentIndex: number;
  isContentPartAdded: boolean;
  accumulatedContent: ResponsesContent[];
  deltaBuffer: string;
  isTextStarted: boolean;
  isTextCompleted: boolean;
}

// 输出项构建器
export interface OutputItemBuilder {
  id: string;
  type: string;
  status: 'in_progress' | 'completed';
  contentParts: ResponsesContent[];
  currentContentIndex: number;
  accumulatedContent: ResponsesContent[];
  hasContentPartAdded: boolean;
  isTextInProgress: boolean;
  callId?: string;
  name?: string;
  arguments?: string;
  role?: string;
}

// Responses转换错误
export interface ResponsesConversionError extends Error {
  code: string;
  requestId: string;
  eventId?: string;
  outputItemId?: string;
  sequenceNumber?: number;
  context?: JsonObject;
}

// Responses转换错误代码
export const RESPONSES_CONVERSION_ERROR_CODES = {
  TIMEOUT: 'RESPONSES_TIMEOUT',
  INVALID_EVENT: 'RESPONSES_INVALID_EVENT',
  SEQUENCE_ERROR: 'RESPONSES_SEQUENCE_ERROR',
  OUTPUT_ITEM_ERROR: 'RESPONSES_OUTPUT_ITEM_ERROR',
  CONTENT_PART_ERROR: 'RESPONSES_CONTENT_PART_ERROR',
  PARSE_ERROR: 'RESPONSES_PARSE_ERROR',
  VALIDATION_ERROR: 'RESPONSES_VALIDATION_ERROR',
  STREAM_ERROR: 'RESPONSES_STREAM_ERROR'
} as const;

// Responses转换配置
export interface ResponsesConversionConfig {
  // 超时配置
  defaultTimeoutMs: number;
  heartbeatIntervalMs: number;
  eventTimeoutMs: number;

  // 分块配置
  defaultChunkSize: number;
  defaultDelayMs: number;
  reasoningChunkSize: number;
  textChunkSize: number;
  functionCallChunkSize: number;

  // 验证配置
  enableEventValidation: boolean;
  enableSequenceValidation: boolean;
  strictMode: boolean;
  validateOutputItems: boolean;

  // 性能配置
  maxConcurrentOutputItems: number;
  maxConcurrentContentParts: number;
  eventBufferSize: number;

  // 调试配置
  debugMode: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  enableMetrics: boolean;
}

// 默认Responses转换配置
export const DEFAULT_RESPONSES_CONVERSION_CONFIG: ResponsesConversionConfig = {
  defaultTimeoutMs: 30000,
  heartbeatIntervalMs: 15000,
  eventTimeoutMs: 5000,

  defaultChunkSize: 12,
  defaultDelayMs: 8,
  reasoningChunkSize: 24,
  textChunkSize: 128,
  functionCallChunkSize: 24,

  enableEventValidation: true,
  enableSequenceValidation: true,
  strictMode: false,
  validateOutputItems: true,

  maxConcurrentOutputItems: 10,
  maxConcurrentContentParts: 50,
  eventBufferSize: 1000,

  debugMode: false,
  logLevel: 'info',
  enableMetrics: true
};

// Responses SSE事件流 - 简化类型定义，支持AsyncIterable
export interface ResponsesSseEventStream extends AsyncIterable<ResponsesSseEvent> {
  // 获取流统计
  getStats(): ResponsesEventStats;
  // 获取当前配置
  getConfig(): ResponsesConversionConfig;
  // 手动完成流
  complete(): void;
  // 手动中止流
  abort(error?: Error): void;
  // 监听器（简化版，避免与Node.js.Readable冲突）
  on(event: 'error', handler: (error: Error) => void): this;
  on(event: 'complete', handler: () => void): this;
  on(event: 'timeout', handler: () => void): this;
  on(event: 'output_item', handler: (item: ResponsesOutputItem) => void): this;
  on(event: 'content_part', handler: (part: ResponsesContent) => void): this;
  on(event: 'stats', handler: (stats: ResponsesEventStats) => void): this;
}
