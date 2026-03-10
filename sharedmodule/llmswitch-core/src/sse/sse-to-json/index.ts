/**
 * SSE→JSON转换模块导出
 */

// Chat协议转换器
export { ChatSseToJsonConverter, defaultChatSseToJsonConverter } from './chat-sse-to-json-converter.js';

// Responses协议转换器（重构版本）
export { ResponsesSseToJsonConverterRefactored as ResponsesSseToJsonConverter } from './responses-sse-to-json-converter.js';
// Gemini协议转换器
export { GeminiSseToJsonConverter } from './gemini-sse-to-json-converter.js';

// 重新导出类型
export type {
  SseToChatJsonOptions,
  SseToChatJsonContext,
  ChatEventStats,
  SseToResponsesJsonOptions,
  SseToResponsesJsonContext,
  ResponsesEventStats,
  SseToGeminiJsonOptions,
  SseToGeminiJsonContext,
  GeminiEventStats
} from '../types/index.js';
