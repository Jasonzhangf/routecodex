/**
 * SSE双向转换模块类型定义统一导出
 * 支持Responses和Chat协议的JSON↔SSE双向转换
 */

// 核心接口
export type {
  BaseSseEvent,
  BaseSseEventStream,
  StreamProtocol,
  StreamDirection,
  SseProtocol,
  SseDirection
} from './core-interfaces.js';

// Chat协议类型
export type {
  ChatSseEvent,
  ChatSseEventType,
  ChatSseEventStream,
  ChatEventStats,
  ChatJsonToSseContext,
  SseToChatJsonContext,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatMessage,
  ChatJsonToSseOptions,
  SseToChatJsonOptions,
  ChatConversionError,
  ChatToolCall,
  ChatToolCallChunk,
  ChatChoiceBuilder,
  ChatMessageBuilder,
  ChatToolCallBuilder,
  ChatReasoningMode
} from './chat-types.js';

// 转换器类型
export type { ChatJsonToSseConverter } from '../json-to-sse/chat-json-to-sse-converter.js';
export type { ResponsesJsonToSseConverter } from '../json-to-sse/responses-json-to-sse-converter.js';

// Responses协议类型
export type {
  ResponsesSseEvent,
  ResponsesSseEventType,
  ResponsesSseEventStream,
  ResponsesEventStats,
  ResponsesJsonToSseContext,
  SseToResponsesJsonContext,
  ResponsesJsonToSseOptions,
  SseToResponsesJsonOptions,
  ResponsesResponse,
  ResponsesRequest,
  ResponsesOutputItem,
  ResponsesMessageItem,
  ResponsesFunctionCallItem,
  ResponsesFunctionCallOutputItem,
  ResponsesReasoningItem,
  ResponsesContent,
  ResponsesTool,
  ResponsesToolCall,
  ResponsesUsage,
  OutputItemBuilder,
  OutputItemProcessingState
} from './responses-types.js';

// Anthropic 协议类型
export type {
  AnthropicMessageResponse,
  AnthropicContentBlock,
  AnthropicJsonToSseContext,
  AnthropicJsonToSseOptions,
  AnthropicEventStats,
  SseToAnthropicJsonContext,
  SseToAnthropicJsonOptions,
  AnthropicSseEvent,
  AnthropicSseEventStream
} from './anthropic-types.js';
export { DEFAULT_ANTHROPIC_CONVERSION_CONFIG } from './anthropic-types.js';

// Gemini 协议类型
export type {
  GeminiResponse,
  GeminiCandidate,
  GeminiContentPart,
  GeminiUsageMetadata,
  GeminiJsonToSseOptions,
  GeminiJsonToSseContext,
  SseToGeminiJsonOptions,
  SseToGeminiJsonContext,
  GeminiEventStats,
  GeminiSseEvent,
  GeminiChunkEventData,
  GeminiDoneEventData
} from './gemini-types.js';
export { DEFAULT_GEMINI_CONVERSION_CONFIG } from './gemini-types.js';

// 转换器类型从对应的实现文件导出
export type { ChatSseToJsonConverter } from '../sse-to-json/chat-sse-to-json-converter.js';
export type { ResponsesSseToJsonConverterRefactored as ResponsesSseToJsonConverter } from '../sse-to-json/responses-sse-to-json-converter.js';

// 常量
export { DEFAULT_CHAT_CONVERSION_CONFIG, CHAT_CONVERSION_ERROR_CODES } from './chat-types.js';
export { DEFAULT_RESPONSES_CONVERSION_CONFIG, RESPONSES_CONVERSION_ERROR_CODES } from './responses-types.js';
