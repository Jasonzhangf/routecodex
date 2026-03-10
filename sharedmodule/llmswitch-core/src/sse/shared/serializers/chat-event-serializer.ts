/**
 * Chat协议事件序列化适配器
 * 将内部ChatSseEvent对象转换为真实的SSE wire格式
 */

import type { ChatSseEvent, ChatSseEventType } from '../../types/chat-types.js';
import type { EventSerializer } from './base-serializer.js';

/**
 * Chat协议SSE事件序列化器
 * 负责将内部事件对象转换为符合SSE标准的文本格式
 */
export class ChatEventSerializer implements EventSerializer<ChatSseEvent> {
  /**
   * 将Chat事件序列化为SSE wire格式
   */
  serializeToWire(event: ChatSseEvent): string {
    switch (event.type) {
      case 'chat_chunk':
        return this.serializeChatChunk(event);
      case 'chat.done':
        return this.serializeChatDone(event);
      case 'chat.error':
        return this.serializeChatError(event);
      case 'chat.heartbeat':
        return this.serializeHeartbeat(event);
      default:
        throw new Error(`Unsupported ChatSseEvent type: ${(event as any).type}`);
    }
  }

  /**
   * 从SSE wire格式反序列化为Chat事件
   */
  deserializeFromWire(wireData: string): ChatSseEvent {
    const lines = wireData.trim().split('\n');
    let eventType: string | null = null;
    let eventData: string | null = null;

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventType = line.substring(6).trim();
      } else if (line.startsWith('data:')) {
        eventData = line.substring(5).trim();
      }
    }

    if (!eventType) {
      throw new Error('Missing event type in SSE data');
    }

    switch (eventType) {
      case 'chat_chunk':
        return this.deserializeChatChunk(eventData, wireData);
      case 'chat.done':
        return this.deserializeChatDone(eventData, wireData);
      case 'chat.error':
        return this.deserializeChatError(eventData, wireData);
      case 'chat.heartbeat':
        return this.deserializeHeartbeat(eventData, wireData);
      default:
        throw new Error(`Unknown Chat event type: ${eventType}`);
    }
  }

  /**
   * 验证SSE wire格式
   */
  validateWireFormat(wireData: string): boolean {
    try {
      const lines = wireData.trim().split('\n');
      let hasEvent = false;
      let hasData = false;

      for (const line of lines) {
        if (line.startsWith('event:')) {
          hasEvent = true;
        } else if (line.startsWith('data:')) {
          hasData = true;
        }
      }

      return hasEvent && hasData;
    } catch {
      return false;
    }
  }

  /**
   * 序列化Chat chunk事件
   * 格式: event: chat_chunk\ndata: {...}\n\n
   */
  private serializeChatChunk(event: ChatSseEvent): string {
    const timestamp = event.timestamp ?? Date.now();
    let wireEvent = `event: chat_chunk\n`;
    wireEvent += `data: ${event.data}\n`;
    wireEvent += `id: ${timestamp}\n`;
    wireEvent += `\n`;
    return wireEvent;
  }

  /**
   * 序列化Chat完成事件
   * 格式: event: chat.done\ndata: {"type":"done",...}\n\n
   */
  private serializeChatDone(event: ChatSseEvent): string {
    const timestamp = event.timestamp ?? Date.now();
    let wireEvent = `event: chat.done\n`;
    wireEvent += `data: ${event.data}\n`;
    wireEvent += `id: ${timestamp}\n`;
    wireEvent += `\n`;
    return wireEvent;
  }

  /**
   * 序列化Chat错误事件
   */
  private serializeChatError(event: ChatSseEvent): string {
    const timestamp = event.timestamp ?? Date.now();
    let wireEvent = `event: chat.error\n`;
    wireEvent += `data: ${event.data}\n`;
    wireEvent += `id: ${timestamp}\n`;
    wireEvent += `\n`;
    return wireEvent;
  }

  /**
   * 序列化心跳事件
   */
  private serializeHeartbeat(event: ChatSseEvent): string {
    const timestamp = event.timestamp ?? Date.now();
    let wireEvent = `event: chat.heartbeat\n`;
    wireEvent += `data: ${event.data || 'ping'}\n`;
    wireEvent += `id: ${timestamp}\n`;
    wireEvent += `\n`;
    return wireEvent;
  }

  /**
   * 反序列化Chat chunk事件
   */
  private deserializeChatChunk(data: string | null, rawWireData: string): ChatSseEvent {
    if (!data) {
      throw new Error('Missing data for chat_chunk event');
    }

    return {
      event: 'chat_chunk',
      type: 'chat_chunk',
      timestamp: this.extractTimestamp(rawWireData),
      data,
      protocol: 'chat',
      direction: 'sse_to_json'
    };
  }

  /**
   * 反序列化Chat完成事件
   */
  private deserializeChatDone(data: string | null, rawWireData: string): ChatSseEvent {
    if (!data) {
      throw new Error('Missing data for chat.done event');
    }

    return {
      event: 'chat.done',
      type: 'chat.done',
      timestamp: this.extractTimestamp(rawWireData),
      data,
      protocol: 'chat',
      direction: 'sse_to_json'
    };
  }

  /**
   * 反序列化Chat错误事件
   */
  private deserializeChatError(data: string | null, rawWireData: string): ChatSseEvent {
    if (!data) {
      throw new Error('Missing data for chat.error event');
    }

    return {
      event: 'error',
      type: 'error',
      timestamp: this.extractTimestamp(rawWireData),
      data,
      protocol: 'chat',
      direction: 'sse_to_json'
    };
  }

  /**
   * 反序列化心跳事件
   */
  private deserializeHeartbeat(data: string | null, rawWireData: string): ChatSseEvent {
    return {
      event: 'ping',
      type: 'ping',
      timestamp: this.extractTimestamp(rawWireData),
      data: data || 'ping',
      protocol: 'chat',
      direction: 'sse_to_json'
    };
  }

  /**
   * 从wire数据中提取时间戳
   */
  private extractTimestamp(wireData: string): number {
    const lines = wireData.split('\n');
    for (const line of lines) {
      if (line.startsWith('id:')) {
        const idValue = line.substring(3).trim();
        const numeric = Number(idValue);
        if (!Number.isNaN(numeric)) {
          return numeric;
        }
        const parsed = Date.parse(idValue);
        if (!Number.isNaN(parsed)) {
          return parsed;
        }
      }
    }
    return Date.now();
  }

  /**
   * 创建标准Chat chunk事件
   */
  static createChunkEvent(chunkData: any, timestamp?: number): ChatSseEvent {
    return {
      event: 'chat_chunk',
      type: 'chat_chunk',
      timestamp: timestamp ?? Date.now(),
      data: JSON.stringify(chunkData),
      protocol: 'chat',
      direction: 'json_to_sse'
    };
  }

  /**
   * 创建标准Chat完成事件
   */
  static createDoneEvent(requestId: string, totalEvents: number, timestamp?: number): ChatSseEvent {
    return {
      event: 'chat.done',
      type: 'chat.done',
      timestamp: timestamp ?? Date.now(),
      data: JSON.stringify({
        type: 'done',
        requestId,
        totalEvents
      }),
      protocol: 'chat',
      direction: 'json_to_sse'
    };
  }

  /**
   * 创建标准Chat错误事件
   */
  static createErrorEvent(error: Error, requestId: string, timestamp?: number): ChatSseEvent {
    return {
      event: 'error',
      type: 'error',
      timestamp: timestamp ?? Date.now(),
      data: JSON.stringify({
        type: 'error',
        requestId,
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack
        }
      }),
      protocol: 'chat',
      direction: 'json_to_sse'
    };
  }

  /**
   * 创建心跳事件
   */
  static createHeartbeatEvent(timestamp?: number): ChatSseEvent {
    return {
      event: 'ping',
      type: 'ping',
      timestamp: timestamp ?? Date.now(),
      data: 'ping',
      protocol: 'chat',
      direction: 'json_to_sse'
    };
  }
}

/**
 * 默认Chat事件序列化器实例
 */
export const defaultChatEventSerializer = new ChatEventSerializer();
