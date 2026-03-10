/**
 * 事件序列化适配器模块导出
 * 提供Chat和Responses协议的事件序列化功能
 */

import { BatchSerializer } from './base-serializer.js';
import type { EventSerializer, SerializationOptions } from './base-serializer.js';
import { ChatEventSerializer, defaultChatEventSerializer } from './chat-event-serializer.js';
import { ResponsesEventSerializer, defaultResponsesEventSerializer } from './responses-event-serializer.js';
import { serializeAnthropicEventToSSE } from './anthropic-event-serializer.js';
import { serializeGeminiEventToSSE } from './gemini-event-serializer.js';

// 从types.ts导入基础类型
export type {
  SerializationOptions,
  ChatSerializationOptions,
  ResponsesSerializationOptions,
  EventSerializer,
  ChatEventSerializer,
  ResponsesEventSerializer
} from './types.js';

// 基础序列化接口和工具
export type {
  BaseEventSerializer,
  SerializationError,
  SerializationResult,
  BatchSerializer
} from './base-serializer.js';

// Chat协议序列化器
export { defaultChatEventSerializer } from './chat-event-serializer.js';

// Responses协议序列化器
export { defaultResponsesEventSerializer } from './responses-event-serializer.js';
export { serializeAnthropicEventToSSE } from './anthropic-event-serializer.js';
export { serializeGeminiEventToSSE } from './gemini-event-serializer.js';

/**
 * 创建序列化器工厂
 */
export class SerializerFactory {
  /**
   * 创建Chat协议序列化器
   */
  static createChatSerializer(options?: SerializationOptions): ChatEventSerializer {
    return new ChatEventSerializer();
  }

  /**
   * 创建Responses协议序列化器
   */
  static createResponsesSerializer(options?: SerializationOptions): ResponsesEventSerializer {
    return new ResponsesEventSerializer();
  }

  /**
   * 根据协议类型创建序列化器
   */
  static createSerializer(protocol: 'chat' | 'responses', options?: SerializationOptions): EventSerializer<any> {
    switch (protocol) {
      case 'chat':
        return this.createChatSerializer(options);
      case 'responses':
        return this.createResponsesSerializer(options);
      default:
        throw new Error(`Unsupported protocol: ${protocol}`);
    }
  }

  /**
   * 创建批量序列化器
   */
  static createBatchSerializer<TEvent>(
    serializer: EventSerializer<TEvent>
  ): BatchSerializer<TEvent> {
    return new BatchSerializer(serializer);
  }
}

/**
 * 默认序列化器实例
 */
export const defaultSerializers = {
  chat: defaultChatEventSerializer,
  responses: defaultResponsesEventSerializer
};
