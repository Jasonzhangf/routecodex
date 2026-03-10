/**
 * SSE双向转换模块统一导出
 * 支持Chat和Responses协议的JSON↔SSE双向转换
 */

import type {
  ChatCompletionResponse,
  ChatJsonToSseOptions,
  ResponsesJsonToSseOptions,
  ResponsesResponse,
  SseToChatJsonOptions,
  SseToResponsesJsonOptions
} from './types/index.js';
import type { AnthropicMessageResponse } from './types/anthropic-types.js';
import type {
  GeminiResponse,
  GeminiJsonToSseOptions,
  SseToGeminiJsonOptions
} from './types/gemini-types.js';
import { ChatJsonToSseConverter as ChatJsonToSseConverterCtor } from './json-to-sse/index.js';
import { ChatSseToJsonConverter as ChatSseToJsonConverterCtor } from './sse-to-json/index.js';
import { ResponsesJsonToSseConverter as ResponsesJsonToSseConverterCtor } from './json-to-sse/index.js';
import { ResponsesSseToJsonConverter as ResponsesSseToJsonConverterCtor } from './sse-to-json/index.js';
import { AnthropicJsonToSseConverter as AnthropicJsonToSseConverterCtor } from './json-to-sse/anthropic-json-to-sse-converter.js';
import { AnthropicSseToJsonConverter as AnthropicSseToJsonConverterCtor } from './sse-to-json/anthropic-sse-to-json-converter.js';
import { GeminiJsonToSseConverter as GeminiJsonToSseConverterCtor } from './json-to-sse/gemini-json-to-sse-converter.js';
import { GeminiSseToJsonConverter as GeminiSseToJsonConverterCtor } from './sse-to-json/gemini-sse-to-json-converter.js';

// Chat协议转换器
export { ChatJsonToSseConverter } from './json-to-sse/index.js';
export { ChatSseToJsonConverter } from './sse-to-json/index.js';

// Responses协议转换器
export { ResponsesJsonToSseConverter } from './json-to-sse/index.js';
export { ResponsesSseToJsonConverter } from './sse-to-json/index.js';
// Gemini协议转换器
export { GeminiJsonToSseConverter } from './json-to-sse/index.js';
export { GeminiSseToJsonConverter } from './sse-to-json/index.js';

// 共享工具导出
export * from './shared/utils.js';
// 序列化器暂时禁用以专注核心SSE转换功能
// export * from './shared/serializers/index.js';

// 类型导出
export * from './types/index.js';

/**
 * 工厂函数：创建Chat协议转换器
 */
export function createChatConverters() {
  const jsonToSse = new ChatJsonToSseConverterCtor();
  const sseToJson = new ChatSseToJsonConverterCtor();

  return {
    jsonToSse,
    sseToJson,

    /**
     * 执行完整的回环测试
     */
    async roundTrip(
      input: ChatCompletionResponse,
      options: ChatJsonToSseOptions & SseToChatJsonOptions
    ): Promise<ChatCompletionResponse> {
      const sseStream = await jsonToSse.convertResponseToJsonToSse(input, options);
      const result = await sseToJson.convertSseToJson(sseStream, options);
      return result;
    }
  };
}

/**
 * 工厂函数：创建Responses协议转换器
 */
export function createResponsesConverters() {
  const jsonToSse = new ResponsesJsonToSseConverterCtor();
  const sseToJson = new ResponsesSseToJsonConverterCtor();

  return {
    jsonToSse,
    sseToJson,

    /**
     * 执行完整的回环测试
     */
    async roundTrip(
      input: ResponsesResponse,
      options: ResponsesJsonToSseOptions & SseToResponsesJsonOptions
    ): Promise<ResponsesResponse> {
      const sseStream = await jsonToSse.convertResponseToJsonToSse(input, options);
      const result = await sseToJson.convertSseToJson(sseStream, options);
      return result;
    }
  };
}

/**
 * 工厂函数：创建Anthropic协议转换器
 */
export function createAnthropicConverters() {
  const jsonToSse = new AnthropicJsonToSseConverterCtor();
  const sseToJson = new AnthropicSseToJsonConverterCtor();

  return {
    jsonToSse,
    sseToJson,

    async roundTrip(
      input: AnthropicMessageResponse,
      options: {
        requestId: string;
        model: string;
        reasoningMode?: import('./types/chat-types.js').ChatReasoningMode;
        reasoningTextPrefix?: string;
      }
    ): Promise<AnthropicMessageResponse> {
      const sseStream = await jsonToSse.convertResponseToJsonToSse(input, options);
      const result = await sseToJson.convertSseToJson(sseStream as any, options);
      return result;
    }
  };
}

/**
 * 工厂函数：创建Gemini协议转换器
 */
export function createGeminiConverters() {
  const jsonToSse = new GeminiJsonToSseConverterCtor();
  const sseToJson = new GeminiSseToJsonConverterCtor();

  return {
    jsonToSse,
    sseToJson,

    async roundTrip(
      input: GeminiResponse,
      options: GeminiJsonToSseOptions & SseToGeminiJsonOptions
    ): Promise<GeminiResponse> {
      const sseStream = await jsonToSse.convertResponseToJsonToSse(input, options);
      const result = await sseToJson.convertSseToJson(sseStream as any, options);
      return result;
    }
  };
}

/**
 * 工厂函数：创建完整的双向转换器（支持Chat和Responses协议）
 */
export function createBidirectionalConverters() {
  const chat = createChatConverters();
  const responses = createResponsesConverters();
  const anthropic = createAnthropicConverters();
  const gemini = createGeminiConverters();

  return {
    chat,
    responses,
    anthropic,
    gemini,

    /**
     * 自动检测协议类型并执行转换
     */
    async autoConvert(input: any, options: any = {}) {
      // 根据输入数据的结构自动检测协议类型
      if (input.object === 'chat.completion') {
        return await chat.roundTrip(input, options);
      } else if (input.object === 'response') {
        return await responses.roundTrip(input, options);
      } else if (input.type === 'message') {
        return await anthropic.roundTrip(input, options);
      } else if (Array.isArray(input?.candidates)) {
        return await gemini.roundTrip(input, options);
      } else {
        throw new Error(`无法识别的协议类型: ${input.object}`);
      }
    }
  };
}

/**
 * 默认转换器实例
 */
export const chatConverters = createChatConverters();
export const responsesConverters = createResponsesConverters();
export const bidirectionalConverters = createBidirectionalConverters();
export const anthropicConverters = createAnthropicConverters();
export const geminiConverters = createGeminiConverters();

export {
  defaultSseCodecRegistry,
  SseCodecRegistry,
  type SseCodec,
  type SseProtocol,
  type JsonToSseContext,
  type SseToJsonContext,
  type NormalizeSseContext
} from './registry/sse-codec-registry.js';
