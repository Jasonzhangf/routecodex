/**
 * 流状态管理类型定义
 * 管理JSON↔SSE双向转换过程中的流状态
 */

import type { JsonToSseOptions, ResponsesJson, ResponsesPartialJson, SseToJsonOptions } from './conversion-context.js';
import { SseEvent, SseEventType } from './sse-events.js';

// 流状态枚举
export enum StreamState {
  IDLE = 'idle',
  STARTING = 'starting',
  ACTIVE = 'active',
  PAUSED = 'paused',
  COMPLETING = 'completing',
  COMPLETED = 'completed',
  ERROR = 'error',
  TIMEOUT = 'timeout',
  ABORTED = 'aborted'
}

// 流方向
export enum StreamDirection {
  JSON_TO_SSE = 'json_to_sse',
  SSE_TO_JSON = 'sse_to_json'
}

// 基础流状态
export interface BaseStreamState {
  direction: StreamDirection;
  requestId: string;
  model: string;
  status: StreamState;
  startTime: number;
  endTime?: number;
  lastActivityTime: number;
  totalEventsProcessed: number;
  bytesProcessed: number;
  errorCount: number;
  timeoutCount: number;
}

// JSON→SSE流状态
export interface JsonToSseStreamState extends BaseStreamState {
  direction: StreamDirection.JSON_TO_SSE;
  inputJson: ResponsesJson;
  options: JsonToSseOptions;
  currentOutputIndex: number;
  currentSequenceNumber: number;
  outputItemsGenerated: number;
  contentPartsGenerated: number;
  deltaEventsGenerated: number;
  isHeartbeatActive: boolean;
  lastHeartbeatTime?: number;
  chunksRemaining?: number;
  estimatedTotalEvents?: number;
}

// SSE→JSON流状态
export interface SseToJsonStreamState extends BaseStreamState {
  direction: StreamDirection.SSE_TO_JSON;
  options: SseToJsonOptions;
  expectedEventTypes: Set<SseEventType>;
  receivedEventTypes: Set<SseEventType>;
  lastSequenceNumber: number;
  expectedSequenceNumbers: Set<number>;
  missingSequenceNumbers: Set<number>;
  isResponseCreated: boolean;
  isResponseCompleted: boolean;
  isRequiredActionReceived: boolean;
  aggregatedEvents: SseEvent[];
  partialJson: ResponsesPartialJson;
}

// 流统计信息
export interface StreamStatistics {
  // 基础统计
  duration: number;
  eventsPerSecond: number;
  bytesPerSecond: number;

  // 事件统计
  eventTypeCounts: Record<SseEventType, number>;
  totalDeltaEvents: number;
  totalItemEvents: number;
  totalResponseEvents: number;

  // 错误统计
  errorRate: number;
  timeoutRate: number;
  sequenceErrorCount: number;

  // 性能统计
  averageEventProcessingTime: number;
  maxEventProcessingTime: number;
  minEventProcessingTime: number;

  // 资源使用统计
  memoryUsage: number;
  cpuUsage: number;
  bufferUtilization: number;
}

// 流监控指标
export interface StreamMetrics {
  // 时间相关指标
  eventTimestamps: Array<{
    eventType: SseEventType;
    timestamp: number;
    sequenceNumber: number;
  }>;

  // 序列号相关指标
  sequenceGaps: Array<{
    start: number;
    end: number;
    size: number;
  }>;

  // 背压指标
  backpressureEvents: number;
  maxBufferSize: number;
  averageBufferSize: number;

  // 重试指标
  retryAttempts: number;
  successfulRetries: number;

  // 超时指标
  timeoutEvents: Array<{
    eventType?: SseEventType;
    timeoutDuration: number;
    timestamp: number;
  }>;
}

// 流配置
export interface StreamConfig {
  // 超时配置
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  heartbeatTimeoutMs: number;

  // 缓冲区配置
  maxBufferSize: number;
  highWaterMark: number;
  lowWaterMark: number;

  // 背压配置
  enableBackpressure: boolean;
  backpressureThreshold: number;
  backpressureStrategy: 'drop' | 'buffer' | 'error';

  // 重试配置
  maxRetries: number;
  retryDelayMs: number;
  retryBackoffMultiplier: number;

  // 监控配置
  enableMetrics: boolean;
  metricsIntervalMs: number;
  enableDetailedLogging: boolean;

  // 性能配置
  maxConcurrentEvents: number;
  eventProcessingTimeoutMs: number;
  gcThreshold: number;
}

// 默认流配置
export const DEFAULT_STREAM_CONFIG: StreamConfig = {
  idleTimeoutMs: 30000,
  totalTimeoutMs: 300000, // 5分钟
  heartbeatTimeoutMs: 60000,

  maxBufferSize: 10000,
  highWaterMark: 8000,
  lowWaterMark: 2000,

  enableBackpressure: true,
  backpressureThreshold: 0.8,
  backpressureStrategy: 'buffer',

  maxRetries: 3,
  retryDelayMs: 1000,
  retryBackoffMultiplier: 2,

  enableMetrics: true,
  metricsIntervalMs: 5000,
  enableDetailedLogging: false,

  maxConcurrentEvents: 50,
  eventProcessingTimeoutMs: 5000,
  gcThreshold: 1000
};

// 流事件
export interface StreamEvent<TPayload = unknown> {
  type: 'state_change' | 'error' | 'timeout' | 'metrics' | 'heartbeat' | 'completion';
  timestamp: number;
  requestId: string;
  data: TPayload;
}

// 状态变化事件
export interface StateChangeEvent extends StreamEvent<{
  oldState: StreamState;
  newState: StreamState;
  reason?: string;
}> {
  type: 'state_change';
}

// 错误事件
export interface StreamErrorEvent extends StreamEvent<{
  error: Error;
  eventType?: SseEventType;
  sequenceNumber?: number;
  recoverable: boolean;
}> {
  type: 'error';
}

// 超时事件
export interface StreamTimeoutEvent extends StreamEvent<{
  timeoutType: 'idle' | 'total' | 'heartbeat' | 'event_processing';
  timeoutDuration: number;
  lastActivityTime: number;
}> {
  type: 'timeout';
}

// 指标事件
export interface StreamMetricsEvent extends StreamEvent<StreamStatistics> {
  type: 'metrics';
}

// 心跳事件
export interface StreamHeartbeatEvent extends StreamEvent<{
  interval: number;
  eventsSinceLastHeartbeat: number;
}> {
  type: 'heartbeat';
}

// 完成事件
export interface StreamCompletionEvent extends StreamEvent<{
  finalState: StreamState;
  totalEvents: number;
  totalDuration: number;
  success: boolean;
}> {
  type: 'completion';
}

// 联合类型
export type StreamEventData =
  | StateChangeEvent
  | StreamErrorEvent
  | StreamTimeoutEvent
  | StreamMetricsEvent
  | StreamHeartbeatEvent
  | StreamCompletionEvent;

// 流状态监听器
export interface StreamStateListener {
  onStateChange(event: StateChangeEvent): void;
  onError(event: StreamErrorEvent): void;
  onTimeout(event: StreamTimeoutEvent): void;
  onMetrics(event: StreamMetricsEvent): void;
  onHeartbeat(event: StreamHeartbeatEvent): void;
  onCompletion(event: StreamCompletionEvent): void;
}

// 流状态管理器接口
export interface StreamStateManager {
  // 状态管理
  getCurrentState(): StreamState;
  setState(newState: StreamState, reason?: string): void;
  transitionTo( newState: StreamState, condition?: () => boolean): boolean;

  // 活动跟踪
  updateActivity(): void;
  isIdle(): boolean;
  isCompleted(): boolean;
  isError(): boolean;

  // 事件处理
  processEvent(event: SseEvent): void;
  incrementEventCount(): void;
  incrementErrorCount(): void;

  // 统计信息
  getStatistics(): StreamStatistics;
  getMetrics(): StreamMetrics;

  // 监听器管理
  addListener(listener: StreamStateListener): void;
  removeListener(listener: StreamStateListener): void;

  // 生命周期
  start(): void;
  pause(): void;
  resume(): void;
  complete(): void;
  abort(error?: Error): void;
  reset(): void;
}
