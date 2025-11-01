/**
 * Hook系统核心类型定义
 *
 * 统一的Hook接口定义，兼容现有Provider v2的BidirectionalHook
 */

// 统一的Hook阶段枚举（扩展现有Provider v2的HookStage）
export enum UnifiedHookStage {
  // Provider v2 原有阶段（保持兼容）
  INITIALIZATION = 'initialization',
  REQUEST_PREPROCESSING = 'request_preprocessing',
  REQUEST_VALIDATION = 'request_validation',
  AUTHENTICATION = 'authentication',
  HTTP_REQUEST = 'http_request',
  HTTP_RESPONSE = 'http_response',
  RESPONSE_VALIDATION = 'response_validation',
  RESPONSE_POSTPROCESSING = 'response_postprocessing',
  FINALIZATION = 'finalization',
  ERROR_HANDLING = 'error_handling',

  // 扩展阶段（支持其他模块）
  PIPELINE_PREPROCESSING = 'pipeline_preprocessing',
  PIPELINE_PROCESSING = 'pipeline_processing',
  PIPELINE_POSTPROCESSING = 'pipeline_postprocessing',
  SERVER_REQUEST_RECEIVING = 'server_request_receiving',
  SERVER_RESPONSE_SENDING = 'server_response_sending',
  LLM_SWITCH_PROCESSING = 'llm_switch_processing'
}

// 统一的Hook目标类型
export type HookTarget =
  | 'request'
  | 'response'
  | 'headers'
  | 'config'
  | 'auth'
  | 'error'
  | 'pipeline-data'
  | 'http-request'
  | 'http-response'
  | 'all';

// Hook执行结果
export interface HookResult {
  success: boolean;
  data?: unknown;
  error?: Error;
  executionTime: number;
  metadata?: Record<string, unknown>;
  observations?: string[];
  metrics?: Record<string, unknown>;
}

// Hook执行上下文（兼容现有Provider v2）
export interface HookExecutionContext {
  readonly executionId: string;
  readonly stage: UnifiedHookStage;
  readonly startTime: number;
  readonly requestId?: string;
  readonly moduleId?: string;
  readonly metadata?: Record<string, any>;
}

// Hook数据包（兼容现有Provider v2）
export interface HookDataPacket {
  data: unknown;
  metadata: {
    size: number;
    timestamp: number;
    source?: string;
    target?: string;
    [key: string]: any;
  };
}

// Hook读取结果
export interface ReadResult {
  observations: string[];
  metrics?: Record<string, any>;
  shouldContinue?: boolean;
}

// Hook写入结果
export interface WriteResult {
  modifiedData: unknown;
  changes: DataChange[];
  observations: string[];
  metrics?: Record<string, any>;
}

// Hook转换结果
export interface TransformResult {
  data: unknown;
  changes: DataChange[];
  observations: string[];
  metrics?: Record<string, any>;
}

// 数据变更记录
export interface DataChange {
  type: 'added' | 'modified' | 'removed';
  path: string;
  oldValue?: unknown;
  newValue?: unknown;
  reason: string;
}

// 统一的Hook接口（兼容BidirectionalHook）
export interface IHook {
  readonly name: string;
  readonly stage: UnifiedHookStage;
  readonly target: HookTarget;
  readonly priority: number;
  readonly isDebugHook?: boolean;

  execute(context: HookExecutionContext, data: HookDataPacket): Promise<HookResult>;
}

// 双向Hook接口（与现有Provider v2完全兼容）
export interface IBidirectionalHook extends IHook {
  read?(data: HookDataPacket, context: HookExecutionContext): Promise<ReadResult>;
  write?(data: HookDataPacket, context: HookExecutionContext): Promise<WriteResult>;
  transform?(data: HookDataPacket, context: HookExecutionContext): Promise<TransformResult>;
}

// Hook执行结果聚合
export interface HookExecutionResult {
  hookName: string;
  stage: UnifiedHookStage;
  target: HookTarget;
  success: boolean;
  executionTime: number;
  data?: unknown;
  changes?: DataChange[];
  observations?: string[];
  metrics?: Record<string, any>;
  error?: Error;
}

// Hook配置接口
export interface HookConfig {
  name: string;
  stage: UnifiedHookStage;
  target: HookTarget;
  priority: number;
  isDebugHook?: boolean;
  required?: boolean;
  handler?: (context: HookExecutionContext, data: HookDataPacket) => Promise<HookResult>;
}

// Hook注册信息
export interface HookRegistration {
  hook: IBidirectionalHook;
  moduleId: string;
  registeredAt: number;
  config?: HookConfig;
}

// Hook过滤器
export interface HookFilter {
  stages?: UnifiedHookStage[];
  targets?: HookTarget[];
  modules?: string[];
  priorityRange?: { min: number; max: number };
}

// Hook执行统计
export interface HookExecutionStats {
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  averageExecutionTime: number;
  totalExecutionTime: number;
  lastExecutionTime: number;
  errorCount: number;
  errorsByType: Record<string, number>;
}

// 快照数据类型
export interface SnapshotData {
  metadata: {
    moduleId: string;
    requestId?: string;
    stage: UnifiedHookStage;
    timestamp: number;
    snapshotId: string;
    format: 'json' | 'structured' | 'compact';
    compression?: 'gzip' | 'lz4' | 'none';
  };
  executionContext: HookExecutionContext;
  hooks: HookExecutionResult[];
  summary: {
    totalHooks: number;
    successfulHooks: number;
    failedHooks: number;
    totalExecutionTime: number;
    dataSize: number;
  };
}

// 指标数据类型
export interface MetricsData {
  timestamp: number;
  moduleId: string;
  hookName?: string;
  stage?: UnifiedHookStage;
  metricName: string;
  value: number;
  unit?: string;
  tags?: Record<string, string>;
}

// Hook错误类型
export const HookErrorType = {
  REGISTRATION_ERROR: 'registration_error',
  EXECUTION_ERROR: 'execution_error',
  VALIDATION_ERROR: 'validation_error',
  SNAPSHOT_ERROR: 'snapshot_error',
  METRICS_ERROR: 'metrics_error',
  TIMEOUT_ERROR: 'timeout_error',
  LIFECYCLE_ERROR: 'lifecycle_error'
} as const;

export type HookErrorType = typeof HookErrorType[keyof typeof HookErrorType];

// Hook错误信息
export interface HookError {
  type: HookErrorType;
  message: string;
  hookName?: string;
  stage?: UnifiedHookStage;
  moduleId?: string;
  cause?: Error;
  timestamp: number;
  context?: Record<string, any>;
}

// 错误处理结果
export interface ErrorHandlingResult {
  handled: boolean;
  action: 'retry' | 'continue' | 'fail' | 'ignore';
  retryDelay?: number;
  fallbackData?: unknown;
  shouldLog: boolean;
}

// 模块适配器接口
export interface IModuleAdapter {
  readonly moduleId: string;
  readonly hooksModule: unknown; // 避免循环依赖，使用any类型

  registerHook(hookConfig: HookConfig): void;
  unregisterHook(hookName: string): void;
  enableHooks(): void;
  disableHooks(): void;
  getHookStatus(): { enabled: boolean; hookCount: number };
}

// Hook管理器接口
export interface IHookManager {
  registerHook(hook: IBidirectionalHook, moduleId?: string): void;
  unregisterHook(hookName: string): void;
  executeHooks(
    stage: UnifiedHookStage,
    target: HookTarget,
    data: unknown,
    context: HookExecutionContext
  ): Promise<HookExecutionResult[]>;
  getRegisteredHooks(filter?: HookFilter): HookRegistration[];
  clearHooks(): void;
}

// Hook执行器接口
export interface IHookExecutor {
  execute(
    hook: IBidirectionalHook,
    data: HookDataPacket,
    context: HookExecutionContext
  ): Promise<HookExecutionResult>;
  executeParallel(
    hooks: IBidirectionalHook[],
    data: HookDataPacket,
    context: HookExecutionContext
  ): Promise<HookExecutionResult[]>;
  executeSequential(
    hooks: IBidirectionalHook[],
    data: HookDataPacket,
    context: HookExecutionContext
  ): Promise<HookExecutionResult[]>;
}

// Hook注册中心接口
export interface IHookRegistry {
  register(hook: IBidirectionalHook, moduleId?: string): void;
  unregister(hookName: string): void;
  find(stage: UnifiedHookStage, target: HookTarget): IBidirectionalHook[];
  findByModule(moduleId: string): IBidirectionalHook[];
  getAll(): IBidirectionalHook[];
  clear(): void;
  getStats(): { totalHooks: number; hooksByStage: Record<string, number>; hooksByModule: Record<string, number> };
}

// 生命周期状态
export const HookSystemState = {
  UNINITIALIZED: 'uninitialized',
  INITIALIZING: 'initializing',
  RUNNING: 'running',
  PAUSED: 'paused',
  STOPPING: 'stopping',
  STOPPED: 'stopped',
  ERROR: 'error'
} as const;

export type HookSystemState = typeof HookSystemState[keyof typeof HookSystemState];

// 生命周期管理器接口
export interface ILifecycleManager {
  initialize(): Promise<void>;
  start(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  shutdown(): Promise<void>;
  getState(): HookSystemState;
  onStateChange(callback: (oldState: HookSystemState, newState: HookSystemState) => void): void;
}

// 错误处理器接口
export interface IErrorHandler {
  handleError(error: HookError, context: HookExecutionContext): Promise<ErrorHandlingResult>;
  shouldRetry(error: HookError): boolean;
  getRetryDelay(attempt: number): number;
}

// 兼容性：Provider v2的BidirectionalHook类型别名
export type ProviderV2BidirectionalHook = IBidirectionalHook;

// 兼容性：Provider v2的HookStage类型别名
export type ProviderV2HookStage =
  | 'initialization'
  | 'request_preprocessing'
  | 'request_validation'
  | 'authentication'
  | 'http_request'
  | 'http_response'
  | 'response_validation'
  | 'response_postprocessing'
  | 'finalization'
  | 'error_handling';

// 类型守卫函数
export function isBidirectionalHook(hook: IHook): hook is IBidirectionalHook {
  return 'read' in hook || 'write' in hook || 'transform' in hook;
}

export function isProviderV2HookStage(stage: string): stage is ProviderV2HookStage {
  return [
    'initialization',
    'request_preprocessing',
    'request_validation',
    'authentication',
    'http_request',
    'http_response',
    'response_validation',
    'response_postprocessing',
    'finalization',
    'error_handling'
  ].includes(stage);
}

// 转换函数：Provider v2 HookStage -> UnifiedHookStage
export function providerV2StageToUnified(stage: ProviderV2HookStage): UnifiedHookStage {
  return stage as UnifiedHookStage;
}

// 转换函数：UnifiedHookStage -> Provider v2 HookStage
export function unifiedStageToProviderV2(stage: UnifiedHookStage): ProviderV2HookStage | null {
  if (isProviderV2HookStage(stage)) {
    return stage as ProviderV2HookStage;
  }
  return null;
}