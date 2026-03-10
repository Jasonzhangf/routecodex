/**
 * 统一的SSE事件流写入器
 * 处理backpressure、超时、心跳、错误处理等通用流管理逻辑
 */

import { Writable, PassThrough } from 'stream';
import type { BaseSseEvent } from '../types/core-interfaces.js';
import type { ChatSseEvent, ResponsesSseEvent, AnthropicSseEvent, GeminiSseEvent } from '../types/index.js';
import { defaultResponsesEventSerializer, serializeAnthropicEventToSSE, serializeGeminiEventToSSE } from './serializers/index.js';
import { TimeUtils } from './utils.js';
import { serializeChatEventToSSE } from './chat-serializer.js';

// 写入器配置
export interface StreamWriterConfig {
  timeoutMs?: number;
  enableHeartbeat?: boolean;
  heartbeatIntervalMs?: number;
  maxBufferSize?: number;
  enableBackpressure?: boolean;
  onEvent?: (event: BaseSseEvent) => void;
  onError?: (error: Error) => void;
  onComplete?: () => void;
}

// 写入统计
export interface StreamWriterStats {
  totalEvents: number;
  bytesWritten: number;
  startTime: number;
  lastWriteTime: number;
  errors: number;
}

/**
 * 统一的SSE流写入器
 */
export class StreamWriter {
  private config: Required<StreamWriterConfig>;
  private stats: StreamWriterStats;
  private heartbeatInterval?: NodeJS.Timeout;
  private isActive = true;
  private writeQueue: BaseSseEvent[] = [];
  private isWriting = false;

  constructor(
    private stream: PassThrough,
    config: StreamWriterConfig = {}
  ) {
    this.config = {
      timeoutMs: config.timeoutMs || 30000,
      enableHeartbeat: config.enableHeartbeat ?? false,
      heartbeatIntervalMs: config.heartbeatIntervalMs || 15000,
      maxBufferSize: config.maxBufferSize || 1000,
      enableBackpressure: config.enableBackpressure ?? true,
      onEvent: config.onEvent || (() => {}),
      onError: config.onError || (() => {}),
      onComplete: config.onComplete || (() => {})
    };

    this.stats = {
      totalEvents: 0,
      bytesWritten: 0,
      startTime: TimeUtils.now(),
      lastWriteTime: 0,
      errors: 0
    };

    this.setupHeartbeat();
    this.setupErrorHandling();
  }

  /**
   * 设置心跳
   */
  private setupHeartbeat(): void {
    if (!this.config.enableHeartbeat) return;

    this.heartbeatInterval = setInterval(() => {
      if (this.isActive) {
        this.sendHeartbeat();
      }
    }, this.config.heartbeatIntervalMs);
  }

  /**
   * 设置错误处理
   */
  private setupErrorHandling(): void {
    this.stream.on('error', (error) => {
      this.stats.errors++;
      this.config.onError(error);
    });

    this.stream.on('close', () => {
      this.cleanup();
      this.config.onComplete();
    });
  }

  /**
   * 发送心跳事件
   */
  private sendHeartbeat(): void {
    const heartbeatEvent: BaseSseEvent = {
      type: 'heartbeat',
      timestamp: TimeUtils.now(),
      data: '',
      sequenceNumber: -1
    };

    this.writeEvent(heartbeatEvent);
  }

  /**
   * 写入单个事件
   */
  private async writeEvent(event: BaseSseEvent): Promise<void> {
    if (!this.isActive) return;

    try {
      // 触发事件回调
      this.config.onEvent(event as BaseSseEvent);

      // 序列化事件 - 使用协议标识进行类型识别
      let serialized: string;
      if (event && (event as any).protocol === 'chat') {
        serialized = serializeChatEventToSSE(event as ChatSseEvent);
      } else if (event && (event as any).protocol === 'responses') {
        serialized = this.serializeResponsesEvent(event as ResponsesSseEvent);
      } else if (event && (event as any).protocol === 'anthropic-messages') {
        serialized = serializeAnthropicEventToSSE(event as any);
      } else if (event && (event as any).protocol === 'gemini-chat') {
        serialized = serializeGeminiEventToSSE(event as GeminiSseEvent);
      } else {
        // 兜底处理：尝试通过事件字段识别
        const eventField = (event as any).event;
        if (eventField === 'chat_chunk' || eventField === 'chat.done' || eventField === 'error' || eventField === 'ping') {
          serialized = serializeChatEventToSSE(event as ChatSseEvent);
        } else if (eventField === 'message_start' || eventField === 'content_block_start') {
          serialized = serializeAnthropicEventToSSE(event as any);
        } else if (eventField === 'gemini.data' || eventField === 'gemini.done') {
          serialized = serializeGeminiEventToSSE(event as GeminiSseEvent);
        } else {
          serialized = this.serializeResponsesEvent(event as ResponsesSseEvent);
        }
      }

      const needsBackpressure =
        this.config.enableBackpressure && !this.stream.write(serialized);
      if (needsBackpressure) {
        await this.handleBackpressure();
      }

      // 更新统计
      this.stats.totalEvents++;
      this.stats.bytesWritten += Buffer.byteLength(serialized, 'utf8');
      this.stats.lastWriteTime = TimeUtils.now();

    } catch (error) {
      this.stats.errors++;
      this.config.onError(error as Error);
    }
  }

  /**
   * 处理背压
   */
  private async handleBackpressure(): Promise<void> {
    return new Promise((resolve) => {
      const checkDrain = () => {
        if (this.stream.writableLength < this.config.maxBufferSize) {
          this.stream.removeListener('drain', checkDrain);
          resolve();
        }
      };

      this.stream.on('drain', checkDrain);
    });
  }

  /**
   * 序列化Responses事件（临时实现，需要 ResponsesSerializer）
   * TODO: 等Responses协议修复后，实现完整的ResponsesSerializer
   * 当前为临时实现，仅用于避免编译错误
   */
  private serializeResponsesEvent(event: ResponsesSseEvent): string {
    try {
      if (typeof (event as any).type === 'string' && (event as any).type.startsWith('response.')) {
        return defaultResponsesEventSerializer.serializeToWire(event as any);
      }
    } catch {
      // ignore and fallback
    }
    const eventType = String((event as any).type ?? 'response.unknown');
    const rawData = (event as any).data;
    const timestamp = typeof (event as any).timestamp === 'number' ? (event as any).timestamp : undefined;
    const sequenceNumber = typeof (event as any).sequenceNumber === 'number' ? (event as any).sequenceNumber : undefined;

    let wire = `event: ${eventType}\n`;

    if (rawData === '[DONE]') {
      wire += 'data: [DONE]\n';
    } else if (typeof rawData === 'string') {
      wire += `data: ${rawData}\n`;
    } else {
      const payload: Record<string, unknown> = rawData && typeof rawData === 'object' ? { ...(rawData as any) } : {};
      if (!Object.prototype.hasOwnProperty.call(payload, 'type')) payload.type = eventType;
      if (sequenceNumber !== undefined && !Object.prototype.hasOwnProperty.call(payload, 'sequence_number')) {
        payload.sequence_number = sequenceNumber;
      }
      wire += `data: ${JSON.stringify(payload)}\n`;
    }

    if (timestamp !== undefined) {
      wire += `id: ${timestamp}\n`;
    }

    wire += '\n';
    return wire;
  }

  /**
   * 异步写入事件流
   */
  async writeEventStream(events: AsyncIterable<BaseSseEvent>): Promise<void> {
    if (!this.isActive) return;

    try {
      for await (const event of events) {
        if (!this.isActive) break;
        await this.writeEvent(event);
      }
    } catch (error) {
      this.stats.errors++;
      this.config.onError(error as Error);
    }
  }

  /**
   * 同步写入事件数组
   */
  async writeEvents(events: BaseSseEvent[]): Promise<void> {
    if (!this.isActive) return;

    for (const event of events) {
      if (!this.isActive) break;
      await this.writeEvent(event);
    }
  }

  /**
   * 写入Chat事件流
   */
  async writeChatEvents(events: AsyncIterable<ChatSseEvent> | ChatSseEvent[]): Promise<void> {
    await this.writeEventStream(events as AsyncIterable<BaseSseEvent>);
  }

  /**
   * 写入Responses事件流
   */
  async writeResponsesEvents(events: AsyncIterable<ResponsesSseEvent> | ResponsesSseEvent[]): Promise<void> {
    await this.writeEventStream(events as AsyncIterable<BaseSseEvent>);
  }

  /**
   * 写入Anthropic事件流
   */
  async writeAnthropicEvents(events: AsyncIterable<AnthropicSseEvent> | AnthropicSseEvent[]): Promise<void> {
    await this.writeEventStream(events as AsyncIterable<BaseSseEvent>);
  }

  /**
   * 写入Gemini事件流
   */
  async writeGeminiEvents(events: AsyncIterable<GeminiSseEvent> | GeminiSseEvent[]): Promise<void> {
    await this.writeEventStream(events as AsyncIterable<BaseSseEvent>);
  }

  /**
   * 完成流写入
   */
  complete(): void {
    if (!this.isActive) return;

    this.isActive = false;

    // 确保所有数据都写入完成
    if (this.stream.writable) {
      this.stream.end();
    }
  }

  /**
   * 中止流写入
   */
  abort(error?: Error): void {
    if (!this.isActive) return;

    this.isActive = false;

    if (error) {
      this.stats.errors++;
      this.config.onError(error);
    }

    if (this.stream.writable) {
      this.stream.destroy(error);
    }
  }

  /**
   * 获取写入统计
   */
  getStats(): StreamWriterStats {
    return {
      ...this.stats,
      duration: TimeUtils.now() - this.stats.startTime
    } as StreamWriterStats & { duration: number };
  }

  /**
   * 检查流是否活跃
   */
  isStreamActive(): boolean {
    return this.isActive && this.stream.writable;
  }

  /**
   * 清理资源
   */
  private cleanup(): void {
    this.isActive = false;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
  }

  /**
   * 获取底层流
   */
  getUnderlyingStream(): PassThrough {
    return this.stream;
  }
}

/**
 * 创建Chat流写入器工厂函数
 */
export function createChatStreamWriter(
  stream: PassThrough,
  config: StreamWriterConfig = {}
): StreamWriter {
  return new StreamWriter(stream, config);
}

/**
 * 创建Responses流写入器工厂函数
 */
export function createResponsesStreamWriter(
  stream: PassThrough,
  config: StreamWriterConfig = {}
): StreamWriter {
  return new StreamWriter(stream, config);
}

/**
 * 创建Anthropic流写入器工厂函数
 */
export function createAnthropicStreamWriter(
  stream: PassThrough,
  config: StreamWriterConfig = {}
): StreamWriter {
  return new StreamWriter(stream, config);
}

/**
 * 创建Gemini流写入器工厂函数
 */
export function createGeminiStreamWriter(
  stream: PassThrough,
  config: StreamWriterConfig = {}
): StreamWriter {
  return new StreamWriter(stream, config);
}
