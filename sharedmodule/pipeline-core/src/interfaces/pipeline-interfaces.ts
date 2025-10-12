import type { RCCBaseModule, ErrorHandlingCenter, DebugCenter } from '../types/external-types';
import type { BaseProviderConfig, BaseTransformationRule } from '../types/base-types';
import type { LogData } from '../shared/common-types';
import type { SharedPipelineRequest, SharedPipelineResponse, SharedPipelineError, SharedRouteRequest } from '../shared/shared-dtos';
import type { DebugLogEntry, TransformationLogEntry, ProviderRequestLogEntry } from '../types/debug-logger-types';

export type RouteRequest = SharedRouteRequest;
export type PipelineRequest = SharedPipelineRequest;
export type PipelineResponse = SharedPipelineResponse;
export type PipelineError = SharedPipelineError;

export interface PipelineModule {
  readonly id: string;
  readonly type: string;
  readonly config: ModuleConfig;
  initialize(): Promise<void>;
  processIncoming(request: any): Promise<unknown>;
  processOutgoing(response: any): Promise<unknown>;
  cleanup(): Promise<void>;
}

export interface ModuleConfig {
  type: string;
  config: Record<string, any>;
  enabled?: boolean;
  priority?: number;
}

export interface PipelineConfig {
  readonly id: string;
  readonly provider: any;
  readonly modules: {
    llmSwitch: ModuleConfig;
    workflow: ModuleConfig;
    compatibility: ModuleConfig;
    provider: ModuleConfig;
  };
  readonly settings?: {
    timeout?: number;
    retryAttempts?: number;
    debugEnabled?: boolean;
  };
}

export interface ProviderConfig extends BaseProviderConfig {}

export interface PipelineManagerConfig {
  readonly pipelines: PipelineConfig[];
  readonly settings?: {
    defaultTimeout?: number;
    maxRetries?: number;
    debugLevel?: 'none' | 'basic' | 'detailed';
  };
}

export interface TransformationRule extends BaseTransformationRule {}

export interface TransformationLog {
  readonly ruleId: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly originalValue: any;
  readonly transformedValue: any;
  readonly duration: number;
}

export interface BasePipeline extends RCCBaseModule {
  readonly pipelineId: string;
  readonly config: PipelineConfig;
  processRequest(request: PipelineRequest): Promise<PipelineResponse>;
  getStatus(): PipelineStatus;
}

export interface PipelineStatus {
  readonly id: string;
  state: 'initializing' | 'ready' | 'processing' | 'error' | 'stopped';
  modules: Record<string, {
    type: string;
    state: string;
    lastActivity: number;
  }>;
  metrics: {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    averageResponseTime: number;
  };
}

export interface LLMSwitchModule extends PipelineModule {
  readonly protocol: string;
  processIncoming(request: SharedPipelineRequest): Promise<SharedPipelineRequest>;
  transformRequest(request: any): Promise<unknown>;
  transformResponse(response: any): Promise<unknown>;
}

export interface WorkflowModule extends PipelineModule {
  readonly workflowType: string;
  processStreamingControl(request: SharedPipelineRequest): Promise<SharedPipelineRequest>;
  handleStreamingResponse(response: any): Promise<unknown>;
  processIncoming(request: SharedPipelineRequest): Promise<SharedPipelineRequest>;
}

export interface CompatibilityModule extends PipelineModule {
  readonly rules: TransformationRule[];
  applyTransformations(data: any, rules: TransformationRule[]): Promise<unknown>;
  processIncoming(request: SharedPipelineRequest): Promise<SharedPipelineRequest>;
}

export interface ProviderModule extends PipelineModule {
  readonly providerType: string;
  sendRequest(request: any): Promise<unknown>;
  checkHealth(): Promise<boolean>;
}

export interface PipelineModuleRegistry {
  registerModule(type: string, factory: ModuleFactory): void;
  createModule(config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule>;
  getAvailableTypes(): string[];
  getStatus(): {
    isInitialized: boolean;
    registeredTypes: number;
    totalCreations: number;
    activeInstances: number;
    moduleTypes: string[];
  };
  initializeDebugEnhancements(): void;
  cleanup(): Promise<void>;
}

export type ModuleFactory = (config: ModuleConfig, dependencies: ModuleDependencies) => Promise<PipelineModule>;

export interface ModuleDependencies {
  errorHandlingCenter: ErrorHandlingCenter;
  debugCenter: DebugCenter;
  logger: PipelineDebugLogger;
  dispatchCenter?: any;
}

export interface PipelineDebugLogger {
  logModule(module: string, action: string, data?: LogData): void;
  logError(error: any, context?: LogData): void;
  logDebug(message: string, data?: LogData): void;
  logPipeline(pipelineId: string, action: string, data?: LogData): void;
  logRequest(requestId: string, action: string, data?: LogData): void;
  logResponse(requestId: string, action: string, data?: LogData): void;
  logTransformation(requestId: string, action: string, data?: LogData, result?: LogData): void;
  logProviderRequest(requestId: string, action: string, request?: LogData, response?: LogData): void;
  getRequestLogs(requestId: string): {
    general: DebugLogEntry[];
    transformations: TransformationLogEntry[];
    provider: ProviderRequestLogEntry[];
  };
  getPipelineLogs(pipelineId: string): {
    general: DebugLogEntry[];
    transformations: TransformationLogEntry[];
    provider: ProviderRequestLogEntry[];
  };
  getRecentLogs(count?: number): DebugLogEntry[];
  getTransformationLogs(): TransformationLogEntry[];
  getProviderLogs(): ProviderRequestLogEntry[];
  getStatistics(): {
    totalLogs: number;
    logsByLevel: Record<string, number>;
    logsByCategory: Record<string, number>;
    logsByPipeline: Record<string, number>;
    transformationCount: number;
    providerRequestCount: number;
  };
  clearLogs(): void;
  exportLogs(format?: 'json' | 'csv'): any;
  log(level: DebugLogEntry['level'], pipelineId: string, category: string, message: string, data?: LogData): void;
}

export interface PipelineManager {
  initialize(): Promise<void>;
  processRequest(request: PipelineRequest): Promise<PipelineResponse>;
  getStatus(): any;
  getStatistics(): any;
  cleanup(): Promise<void>;
}

