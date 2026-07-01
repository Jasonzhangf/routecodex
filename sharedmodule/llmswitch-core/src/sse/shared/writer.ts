/**
 * 统一的SSE事件流写入器
 * 处理backpressure、超时、心跳、错误处理等通用流管理逻辑
 */

import { Writable, PassThrough } from 'stream';
import type { BaseSseEvent } from '../types/core-interfaces.js';
import type { ChatSseEvent, ResponsesSseEvent, AnthropicSseEvent, GeminiSseEvent } from '../types/index.js';
import { serializeAnthropicEventToSSE } from './serializers/anthropic-event-serializer.js';
import { serializeGeminiEventToSSE } from './serializers/gemini-event-serializer.js';
import { serializeResponsesSseEventToWireWithNative } from '../../native/router-hotpath/native-responses-sse-event-payload.js';
import { TimeUtils } from './utils.js';
import { serializeChatEventToSSE } from './chat-serializer.js';

// 写入器配置
export interface StreamWriterConfig {
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

  constructor(
    private stream: PassThrough,
    config: StreamWriterConfig = {}
  ) {
    this.config = {
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
        throw new Error(
          '[SSEWriter] Event missing explicit protocol field; heuristic protocol detection is not allowed. ' +
          `Event: ${JSON.stringify((event as any)?.event ?? 'unknown')}`
        );
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
      throw error;
    }
  }

  /**
   * 处理背压
   */
  private async handleBackpressure(): Promise<void> {
    if (this.stream.destroyed || this.stream.writableLength < this.config.maxBufferSize) {
      return;
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.stream.removeListener('drain', checkDrain);
        this.stream.removeListener('close', handleClose);
        this.stream.removeListener('error', handleError);
      };
      const checkDrain = () => {
        if (this.stream.writableLength < this.config.maxBufferSize) {
          cleanup();
          resolve();
        }
      };
      const handleClose = () => {
        cleanup();
        resolve();
      };
      const handleError = (error: Error) => {
        cleanup();
        reject(error);
      };

      this.stream.on('drain', checkDrain);
      this.stream.on('close', handleClose);
      this.stream.on('error', handleError);
      checkDrain();
    });
  }

  private serializeResponsesEvent(event: ResponsesSseEvent): string {
    return serializeResponsesSseEventToWireWithNative(event);
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
      throw error;
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
