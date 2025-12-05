/**
 * Pipeline Module - Core Interfaces and Types
 *
 * This module defines the core interfaces and types for the pipeline system,
 * including requests, responses, configurations, and module interfaces.
 */

import type { RCCBaseModule, ErrorHandlingCenter, DebugCenter } from '../types/external-types.js';
import type { BaseProviderConfig, BaseTransformationRule } from '../types/base-types.js';
import type { LogData, UnknownObject, JsonValue } from '../../../types/common-types.js';
import type { SharedPipelineRequest, SharedPipelineResponse, SharedPipelineError, SharedRouteRequest } from '../../../types/shared-dtos.js';
import type {
  DebugLogEntry,
  TransformationLogEntry,
  ProviderRequestLogEntry
} from '../utils/debug-logger.js';

/**
 * Route request interface for pipeline selection
 */
export type RouteRequest = SharedRouteRequest;

/**
 * Pipeline request interface
 */
export type PipelineRequest = SharedPipelineRequest;

/**
 * Pipeline response interface
 */
export type PipelineResponse = SharedPipelineResponse;

/**
 * Pipeline error interface
 */
export type PipelineError = SharedPipelineError;

/**
 * Module interface for all pipeline modules
 */
export interface PipelineModule<TIncoming = SharedPipelineRequest, TOutgoing = SharedPipelineResponse> {
  /** Module identifier */
  readonly id: string;
  /** Module type */
  readonly type: string;
  /** Module configuration */
  readonly config: ModuleConfig;

  /**
   * Initialize the module
   */
  initialize(): Promise<void>;

  /**
   * Process incoming request
   */
  processIncoming(request: TIncoming): Promise<TIncoming>;

  /**
   * Process outgoing response
   */
  processOutgoing(response: TOutgoing): Promise<TOutgoing>;

  /**
   * Clean up resources
   */
  cleanup(): Promise<void>;
}

/**
 * Module configuration interface
 */
export interface ModuleConfig {
  /** Module type */
  type: string;
  /** Module-specific configuration */
  config: Record<string, unknown>;
  /** Enable/disable module */
  enabled?: boolean;
  /** Module priority */
  priority?: number;
}

/**
 * Pipeline configuration interface
 */
export interface PipelineConfig {
  /** Pipeline identifier */
  readonly id: string;
  /** Provider configuration */
  readonly provider: ProviderConfig;
  /** Module configurations */
  readonly modules: {
    llmSwitch: ModuleConfig;
    compatibility: ModuleConfig;
    provider: ModuleConfig;
  };
  /** Pipeline-specific settings */
  readonly settings?: {
    timeout?: number;
    retryAttempts?: number;
    debugEnabled?: boolean;
  };
}

/**
 * Provider configuration interface
 */
export interface ProviderConfig extends BaseProviderConfig {}

/**
 * Pipeline manager configuration
 */
export interface PipelineManagerConfig {
  /** Available pipelines */
  readonly pipelines: PipelineConfig[];
  /** Global settings */
  readonly settings?: {
    defaultTimeout?: number;
    maxRetries?: number;
    debugLevel?: 'none' | 'basic' | 'detailed';
    rateLimit?: {
      /** Backoff schedule in ms, e.g., [30000,60000,120000] */
      backoffMs?: number[];
      /** Whether to prefer switching pipeline on 429 when candidates exist */
      switchOn429?: boolean;
      /** Optional cap for attempts managed by manager-level retries */
      maxAttempts?: number;
    };
  };
}

/**
 * Transformation rule interface
 */
export interface TransformationRule extends BaseTransformationRule {}

/**
 * Transformation log entry
 */
export interface TransformationLog {
  /** Transformation rule applied */
  readonly ruleId: string;
  /** Source path */
  readonly sourcePath: string;
  /** Target path */
  readonly targetPath: string;
  /** Original value */
  readonly originalValue: JsonValue | UnknownObject;
  /** Transformed value */
  readonly transformedValue: JsonValue | UnknownObject;
  /** Transformation time */
  readonly duration: number;
}

/**
 * Base pipeline class interface
 */
export interface BasePipeline extends RCCBaseModule {
  /** Pipeline identifier */
  readonly pipelineId: string;
  /** Pipeline configuration */
  readonly config: PipelineConfig;

  /**
   * Process a pipeline request
   */
  processRequest(request: PipelineRequest): Promise<PipelineResponse>;

  /**
   * Get pipeline status
   */
  getStatus(): PipelineStatus;
}

/**
 * Pipeline status interface
 */
export interface PipelineStatus {
  /** Pipeline identifier */
  readonly id: string;
  /** Pipeline state */
  state: 'initializing' | 'ready' | 'processing' | 'error' | 'stopped';
  /** Module statuses */
  modules: Record<string, {
    type: string;
    state: string;
    lastActivity: number;
  }>;
  /** Performance metrics */
  metrics: {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    averageResponseTime: number;
  };
}

/**
 * LLM Switch module interface
 */
export interface LLMSwitchModule extends PipelineModule<SharedPipelineRequest, SharedPipelineResponse> {
  /** Protocol type */
  readonly protocol: string;

  /**
   * Process incoming request as DTO
   */
  processIncoming(request: SharedPipelineRequest): Promise<SharedPipelineRequest>;

  /**
   * Transform request to target protocol
   */
  transformRequest(request: UnknownObject): Promise<UnknownObject>;

  /**
   * Transform response from target protocol
   */
  transformResponse(response: UnknownObject): Promise<UnknownObject>;
}

/**
 * Compatibility module interface
 */
export interface CompatibilityModule extends PipelineModule {
  /** Compatibility rules */
  readonly rules: TransformationRule[];

  /**
   * Apply compatibility transformations
   */
  applyTransformations(data: UnknownObject | JsonValue, rules: TransformationRule[]): Promise<unknown>;

  /**
   * Process incoming request (DTO)
   */
  processIncoming(request: SharedPipelineRequest): Promise<SharedPipelineRequest>;
}

/**
 * Provider module interface
 */
export interface ProviderModule extends PipelineModule<UnknownObject, UnknownObject> {
  /** Provider type */
  readonly providerType: string;

  /**
   * Send request to provider
   */
  sendRequest(request: UnknownObject): Promise<unknown>;

  /**
   * Check provider health
   */
  checkHealth(): Promise<boolean>;
}

/**
 * Pipeline module registry interface
 */
export interface PipelineModuleRegistry {
  /**
   * Register a module factory
   */
  registerModule(type: string, factory: ModuleFactory): void;

  /**
   * Create a module instance
   */
  createModule(config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule>;

  /**
   * Get available module types
   */
  getAvailableTypes(): string[];

  /**
   * Get registry status
   */
  getStatus(): {
    isInitialized: boolean;
    registeredTypes: number;
    totalCreations: number;
    activeInstances: number;
    moduleTypes: string[];
  };

  /**
   * Initialize debug enhancements
   */
  initializeDebugEnhancements(): void;

  /**
   * Clean up resources
   */
  cleanup(): Promise<void>;
}

/**
 * Module factory function type
 */
export type ModuleFactory = (config: ModuleConfig, dependencies: ModuleDependencies) => Promise<PipelineModule>;

export interface PipelineDispatchCenter {
  dispatch(event: string, payload?: LogData): Promise<void> | void;
}

/**
 * Module dependencies interface
 */
export interface ModuleDependencies {
  errorHandlingCenter: ErrorHandlingCenter;
  debugCenter: DebugCenter;
  logger: PipelineDebugLogger;
  dispatchCenter?: PipelineDispatchCenter; // Optional dispatch center for notifications
}

/**
 * Pipeline debug logger interface
 */
export interface PipelineDebugLogger {
  logModule(module: string, action: string, data?: LogData): void;
  logError(error: unknown, context?: LogData): void;
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
  exportLogs(format?: 'json' | 'csv'): DebugLogEntry[] | string[];
  log(level: DebugLogEntry['level'], pipelineId: string, category: string, message: string, data?: LogData): void;
}

/**
 * Pipeline manager interface
 */
export interface PipelineManager {
  /**
   * Initialize the pipeline manager
   */
  initialize(): Promise<void>;

  /**
   * Process a request through the appropriate pipeline
   */
  processRequest(request: PipelineRequest): Promise<PipelineResponse>;

  /**
   * Get pipeline status
   */
  getStatus(): PipelineStatus | UnknownObject;

  /**
   * Get manager statistics
   */
  getStatistics(): UnknownObject;

  /**
   * Clean up resources
   */
  cleanup(): Promise<void>;
}
