/**
 * Chat协议相关类型定义
 * 支持OpenAI Chat Completions的JSON↔SSE双向转换
 */

import type { BaseSseEvent, StreamDirection } from './core-interfaces.js';

type JsonObject = Record<string, unknown>;

// Chat事件类型 (基于Server-Sent Events规范)
export type ChatSseEventType =
  // 基础Chat事件
  | 'chat_chunk'
  | 'chat.done'
  | 'error'
  | 'ping';

// Chat SSE事件结构 - 扩展基础接口
export interface ChatSseEvent extends BaseSseEvent {
  /** 事件类型（SSE标准wire格式） */
  event: ChatSseEventType;
  /** 重写type字段以满足BaseSseEvent要求，与event保持一致 */
  type: string;
  /** 时间戳 */
  timestamp: number;
  /** 事件ID（SSE标准字段） */
  id?: string;
  /** 重试间隔（SSE标准字段） */
  retry?: number;
  /** 协议标识 */
  protocol: 'chat';
  /** 方向标识 */
  direction: StreamDirection;
}

// Chat SSE事件（使用event字段作为类型标识符的版本）
export interface ChatSseEventWithEventField {
  id?: string;  // 事件ID
  event: ChatSseEventType;  // 事件类型
  data: string;  // JSON字符串数据
  timestamp?: number;  // 时间戳
  retry?: number;  // 重试间隔
  // 可选的内部序号（用于测试/对拍，不写入 wire 协议）
  sequenceNumber?: number;
}

// Chat Completion Chunk (对应data字段解析后的结构)
export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  system_fingerprint?: string;
  choices: ChatChoiceChunk[];
  usage?: ChatUsage;
}

// Chat Choice Chunk
export interface ChatChoiceChunk {
  index: number;
  delta: ChatDelta;
  finish_reason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' | null;
  logprobs?: ChatLogProbs;
}

// Chat Delta
export interface ChatDelta {
  role?: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  reasoning?: string;
  reasoning_content?: string;
  function_call?: ChatFunctionCall;
  tool_calls?: ChatToolCallChunk[];
}

// Chat Function Call
export interface ChatFunctionCall {
  name?: string;
  arguments?: string;
}

// Chat Tool Call Chunk
export interface ChatToolCallChunk {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

// Chat Log Probs
export interface ChatLogProbs {
  content?: ChatTokenLogProb[];
}

// Chat Token Log Prob
export interface ChatTokenLogProb {
  token: string;
  logprob: number;
  bytes?: number[];
  top_logprobs?: ChatTopLogProb[];
}

// Chat Top Log Prob
export interface ChatTopLogProb {
  token: string;
  logprob: number;
  bytes?: number[];
}

// Chat Usage
export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// Chat Completion Request
export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  functions?: ChatFunction[];
  function_call?: 'auto' | 'none' | { name: string };
  tools?: ChatTool[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  temperature?: number;
  top_p?: number;
  n?: number;
  stream?: boolean;
  stop?: string | string[] | null;
  max_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  logit_bias?: Record<string, number>;
  user?: string;
  response_format?: { type: 'text' | 'json_object' };
  seed?: number;
}

// Chat Message
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  name?: string;
  reasoning_content?: string;
  reasoning?: string;
  function_call?: ChatFunctionCall;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

// Chat Function
export interface ChatFunction {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

// Chat Tool
export interface ChatTool {
  type: 'function';
  function: ChatFunction;
}

// Chat Tool Call
export interface ChatToolCall {
  id: string;
  type: 'function';
  function: ChatFunctionCall;
}

// Chat Completion Response (非流式)
export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  system_fingerprint?: string;
  choices: ChatChoice[];
  usage?: ChatUsage; // 使 usage 字段可选，因为流式响应可能不包含
}

// Chat Choice
export interface ChatChoice {
  index: number;
  message: ChatMessage;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call';
  logprobs?: ChatLogProbs;
}

// Chat转换上下文
export interface ChatJsonToSseContext {
  requestId: string;
  model: string;
  chatRequest: ChatCompletionRequest;
  options: ChatJsonToSseOptions;
  startTime: number;
  sequenceCounter: number;
  choiceIndexCounter: number;
  toolCallIndexCounter: number;
  isStreaming: boolean;
  currentChunk: Partial<ChatCompletionChunk>;
  eventStats: ChatEventStats;
  // 可选扩展（编排器/生成器内部使用）
  contentIndexCounter?: Map<string, number>;
  currentRequest?: ChatCompletionRequest;
  currentResponse?: ChatCompletionResponse;
  chatResponse?: ChatCompletionResponse;
}

export interface SseToChatJsonContext {
  requestId: string;
  model: string;
  options: SseToChatJsonOptions;
  startTime: number;
  aggregatedChunks: ChatCompletionChunk[];
  currentResponse: Partial<ChatCompletionResponse>;
  choiceIndexMap: Map<number, ChatChoiceBuilder>;
  toolCallIndexMap: Map<number, Map<number, ChatToolCallBuilder>>;
  eventStats: ChatEventStats;
  isCompleted: boolean;
}

// Chat选择构建器
export interface ChatChoiceBuilder {
  index: number;
  delta: ChatDelta;
  finishReason?: ChatChoice['finish_reason'];
  logprobs?: ChatLogProbs;
  messageBuilder: ChatMessageBuilder;
  isCompleted: boolean;
  accumulatedContent: string;
  toolCallBuilders: Map<number, ChatToolCallBuilder>;
}

// Chat消息构建器
export interface ChatMessageBuilder {
  role?: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  reasoningContent?: string;
  name?: string;
  functionCall?: ChatFunctionCall;
  toolCalls?: ChatToolCall[];
  toolCallId?: string;
  isCompleted: boolean;
}

// Chat Tool Call构建器
export interface ChatToolCallBuilder {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
  isCompleted: boolean;
  accumulatedArguments: string;
}

// Chat转换选项
export type ChatReasoningMode = 'channel' | 'text' | 'drop';

export interface ChatJsonToSseOptions {
  requestId: string;
  model: string;
  timeoutMs?: number;
  enableHeartbeat?: boolean;
  heartbeatIntervalMs?: number;
  chunkDelayMs?: number;
  includeSystemFingerprint?: boolean;
  includeLogprobs?: boolean;
  maxTokensPerChunk?: number;
  validationMode?: 'none' | 'basic' | 'strict';
  reasoningMode?: ChatReasoningMode;
  reasoningTextPrefix?: string;
  onChunk?: (chunk: ChatCompletionChunk) => void;
  onError?: (error: Error) => void;
  onComplete?: () => void;
}

export interface SseToChatJsonOptions {
  requestId: string;
  model: string;
  timeoutMs?: number;
  validateChunks?: boolean;
  enableSequenceValidation?: boolean;
  accumulateToolCalls?: boolean;
  reasoningMode?: ChatReasoningMode;
  reasoningTextPrefix?: string;
  onPartialResponse?: (partial: Partial<ChatCompletionResponse>) => void;
  onEvent?: (event: ChatSseEvent) => void;
  onChunk?: (chunk: ChatCompletionChunk) => void;
  onCompletion?: (final: ChatCompletionResponse) => void;
  onError?: (error: Error) => void;
  onTimeout?: () => void;
}

// Chat事件统计
export interface ChatEventStats {
  totalChunks: number;
  totalTokens: number;
  totalChoices: number;
  totalToolCalls: number;
  startTime: number;
  endTime?: number;
  duration?: number;
  tokenRate: number; // tokens per second
  chunkRate: number;  // chunks per second
  errorCount: number;
  retryCount: number;
  // 可选扩展，用于对拍/调试
  totalEvents?: number;
  eventTypes?: Record<string, number>;
  lastEventTime?: number;
}

// Chat转换错误
export interface ChatConversionError extends Error {
  code: string;
  requestId: string;
  chunkId?: string;
  choiceIndex?: number;
  toolCallIndex?: number;
  context?: JsonObject;
}

// Chat转换错误代码
export const CHAT_CONVERSION_ERROR_CODES = {
  TIMEOUT: 'CHAT_TIMEOUT',
  INVALID_CHUNK: 'CHAT_INVALID_CHUNK',
  SEQUENCE_ERROR: 'CHAT_SEQUENCE_ERROR',
  TOOL_CALL_ERROR: 'CHAT_TOOL_CALL_ERROR',
  PARSE_ERROR: 'CHAT_PARSE_ERROR',
  VALIDATION_ERROR: 'CHAT_VALIDATION_ERROR',
  STREAM_ERROR: 'CHAT_STREAM_ERROR'
} as const;

// Chat事件验证规则
export interface ChatEventValidationRule {
  eventType: ChatSseEventType;
  requiredFields: string[];
  optionalFields: string[];
  dataValidation?: {
    schema?: JsonObject;
    customValidator?: (data: JsonObject) => boolean;
  };
}

// Chat转换配置
export interface ChatConversionConfig {
  // 超时配置
  defaultTimeoutMs: number;
  heartbeatIntervalMs: number;
  chunkTimeoutMs: number;

  // 分块配置
  defaultChunkDelayMs: number;
  maxTokensPerChunk: number;
  maxChunkSize: number;

  // 验证配置
  enableChunkValidation: boolean;
  strictMode: boolean;
  validateToolCalls: boolean;

  // 性能配置
  maxConcurrentChoices: number;
  maxConcurrentToolCalls: number;
  eventBufferSize: number;

  // 调试配置
  debugMode: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  enableMetrics: boolean;
  reasoningMode: ChatReasoningMode;
  reasoningTextPrefix?: string;
}

// 默认Chat转换配置
export const DEFAULT_CHAT_CONVERSION_CONFIG: ChatConversionConfig = {
  defaultTimeoutMs: 30000,
  heartbeatIntervalMs: 15000,
  chunkTimeoutMs: 5000,

  defaultChunkDelayMs: 10,
  maxTokensPerChunk: 100,
  maxChunkSize: 1024,

  enableChunkValidation: true,
  strictMode: false,
  validateToolCalls: true,

  maxConcurrentChoices: 10,
  maxConcurrentToolCalls: 50,
  eventBufferSize: 1000,

  debugMode: false,
  logLevel: 'info',
  enableMetrics: true,
  reasoningMode: 'channel'
};

// Chat SSE事件流 - 简化类型定义，支持AsyncIterable
export interface ChatSseEventStream extends AsyncIterable<ChatSseEvent> {
  // 获取流统计
  getStats(): ChatEventStats;
  // 获取当前配置
  getConfig(): ChatConversionConfig;
  // 手动完成流
  complete(): void;
  // 手动中止流
  abort(error?: Error): void;
  // 监听器（简化版，避免与Node.js.Readable冲突）
  on(event: 'error', handler: (error: Error) => void): this;
  on(event: 'complete', handler: () => void): this;
  on(event: 'timeout', handler: () => void): this;
  on(event: 'chunk', handler: (chunk: ChatCompletionChunk) => void): this;
  on(event: 'stats', handler: (stats: ChatEventStats) => void): this;
}
