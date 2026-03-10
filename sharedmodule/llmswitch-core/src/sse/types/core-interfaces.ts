/**
 * 核心接口定义
 * 统一的SSE事件最小接口，供writer.ts等共享模块使用
 */

export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

// 基础SSE事件接口 - 最小通用字段集
export interface BaseSseEvent {
  /** 事件类型 */
  type: string;
  /** 事件时间戳 */
  timestamp: number;
  /** 事件数据 */
  data: unknown;
  /** 序列号（可选） */
  sequenceNumber?: number;
  /** 协议标识 */
  protocol?: StreamProtocol;
  /** 方向标识 */
  direction?: StreamDirection;
}

// 协议标识
export type StreamProtocol = 'chat' | 'responses' | 'anthropic-messages' | 'gemini-chat';

// 方向标识
export type StreamDirection = 'json_to_sse' | 'sse_to_json';

// 向后兼容的别名
export type SseProtocol = StreamProtocol;
export type SseDirection = StreamDirection;

// 基础SSE事件流接口 - 简化类型定义，支持AsyncIterable
export interface BaseSseEventStream extends AsyncIterable<BaseSseEvent> {
  /** 获取当前统计信息 */
  getStats(): BaseSseEventStats;
  /** 完成流 */
  complete(): void;
  /** 中止流 */
  abort(error?: Error): void;
  /** 错误事件监听 */
  on(event: 'error', handler: (error: Error) => void): this;
  /** 完成事件监听 */
  on(event: 'complete', handler: () => void): this;
  /** 超时事件监听 */
  on(event: 'timeout', handler: () => void): this;
}

// 基础统计信息接口
export interface BaseSseEventStats {
  /** 总事件数 */
  totalEvents: number;
  /** 事件类型统计 */
  eventTypes: Record<string, number>;
  /** 开始时间 */
  startTime: number;
  /** 结束时间（可选） */
  endTime?: number;
  /** 持续时间（可选） */
  duration?: number;
  /** 错误计数 */
  errorCount?: number;
  /** 最后事件时间（可选） */
  lastEventTime?: number;
}

// 基础转换上下文接口
export interface BaseConversionContext {
  /** 请求ID */
  requestId: string;
  /** 模型名称 */
  model: string;
  /** 转换选项 */
  options: JsonObject;
  /** 开始时间 */
  startTime: number;
}

// 基础转换选项接口
export interface BaseConversionOptions {
  /** 请求ID */
  requestId: string;
  /** 模型名称 */
  model: string;
  /** 超时毫秒数（可选） */
  timeoutMs?: number;
}

// 基础流状态接口
export interface BaseStreamState {
  /** 是否活跃 */
  isActive: boolean;
  /** 当前序列号 */
  currentSequence: number;
  /** 缓冲区大小 */
  bufferSize: number;
  /** 错误状态 */
  hasError: boolean;
}

// 工具类型：确保事件包含协议信息
export type ProtocolSseEvent<T extends BaseSseEvent, P extends SseProtocol> = T & {
  protocol: P;
};

// 工具类型：确保事件包含方向信息
export type DirectionalSseEvent<T extends BaseSseEvent, D extends SseDirection> = T & {
  direction: D;
};

// 工具类型：完整的协议事件
export type CompleteSseEvent<
  T extends BaseSseEvent,
  P extends SseProtocol,
  D extends SseDirection
> = T & {
  protocol: P;
  direction: D;
};
