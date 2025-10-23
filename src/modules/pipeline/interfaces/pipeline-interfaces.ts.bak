/**
 * Pipeline Module - Core Interfaces and Types
 *
 * This module defines the core interfaces and types for the pipeline system,
 * including requests, responses, configurations, and module interfaces.
 */

import type { RCCBaseModule, ErrorHandlingCenter, DebugCenter } from '../types/external-types.js';
import type { BaseProviderConfig, BaseTransformationRule } from '../types/base-types.js';
import type { LogData } from '../../../types/common-types.js';
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
export interface PipelineModule {
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
  processIncoming(request: any): Promise<unknown>;

  /**
   * Process outgoing response
   */
  processOutgoing(response: any): Promise<unknown>;

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
  config: Record<string, any>;
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
  readonly provider: any; // ProviderConfig;
  /** Module configurations */
  readonly modules: {
    llmSwitch: ModuleConfig;
    workflow: ModuleConfig; // required in strict mode
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
  readonly originalValue: any;
  /** Transformed value */
  readonly transformedValue: any;
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
export interface LLMSwitchModule extends PipelineModule {
  /** Protocol type */
  readonly protocol: string;

  /**
   * Process incoming request as DTO
   */
  processIncoming(request: SharedPipelineRequest): Promise<SharedPipelineRequest>;

  /**
   * Transform request to target protocol
   */
  transformRequest(request: any): Promise<unknown>;

  /**
   * Transform response from target protocol
   */
  transformResponse(response: any): Promise<unknown>;
}

/**
 * Workflow module interface
 */
export interface WorkflowModule extends PipelineModule {
  /** Workflow type */
  readonly workflowType: string;

  /**
   * Process streaming control
   */
  processStreamingControl(request: SharedPipelineRequest): Promise<SharedPipelineRequest>;

  /**
   * Handle streaming response
   */
  handleStreamingResponse(response: any): Promise<unknown>;

  /**
   * Process incoming request
   */
  processIncoming(request: SharedPipelineRequest): Promise<SharedPipelineRequest>;
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
  applyTransformations(data: any, rules: TransformationRule[]): Promise<unknown>;

  /**
   * Process incoming request (DTO)
   */
  processIncoming(request: SharedPipelineRequest): Promise<SharedPipelineRequest>;
}

/**
 * Provider module interface
 */
export interface ProviderModule extends PipelineModule {
  /** Provider type */
  readonly providerType: string;

  /**
   * Send request to provider
   */
  sendRequest(request: any): Promise<unknown>;

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

/**
 * Module dependencies interface
 */
export interface ModuleDependencies {
  errorHandlingCenter: ErrorHandlingCenter;
  debugCenter: DebugCenter;
  logger: PipelineDebugLogger;
  dispatchCenter?: any; // Optional dispatch center for notifications
}

/**
 * Pipeline debug logger interface
 */
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
  getStatus(): any;

  /**
   * Get manager statistics
   */
  getStatistics(): any;

  /**
   * Clean up resources
   */
  cleanup(): Promise<void>;
}
