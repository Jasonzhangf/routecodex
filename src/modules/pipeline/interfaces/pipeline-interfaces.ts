/**
 * Pipeline Module - Core Interfaces and Types
 *
 * This module defines the core interfaces and types for the pipeline system,
 * including requests, responses, configurations, and module interfaces.
 */

import type { RCCBaseModule, ErrorHandlingCenter, DebugCenter } from '../types/external-types.js';
import type { BaseProviderConfig, BaseTransformationRule } from '../types/base-types.js';

/**
 * Route request interface for pipeline selection
 */
export interface RouteRequest {
  /** Provider identifier */
  readonly providerId: string;
  /** Model identifier */
  readonly modelId: string;
  /** Request identifier */
  readonly requestId: string;
  /** Request timestamp */
  readonly timestamp?: number;
}

/**
 * Pipeline request interface
 */
export interface PipelineRequest {
  /** Original request data */
  readonly data: any;
  /** Route information */
  readonly route: {
    providerId: string;
    modelId: string;
    requestId: string;
    timestamp: number;
  };
  /** Metadata from original request */
  readonly metadata: Record<string, any>;
  /** Debug context */
  readonly debug: {
    enabled: boolean;
    stages: Record<string, boolean>;
  };
}

/**
 * Pipeline response interface
 */
export interface PipelineResponse {
  /** Response data */
  readonly data: any;
  /** Processing metadata */
  readonly metadata: {
    pipelineId: string;
    processingTime: number;
    stages: string[];
    errors?: PipelineError[];
  };
  /** Debug information */
  readonly debug?: {
    request: any;
    response: any;
    transformations: TransformationLog[];
    timings: Record<string, number>;
  };
}

/**
 * Pipeline error interface
 */
export interface PipelineError {
  /** Error stage */
  readonly stage: string;
  /** Error code */
  readonly code: string;
  /** Error message */
  readonly message: string;
  /** Error details */
  readonly details?: any;
  /** Error timestamp */
  readonly timestamp: number;
}

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
  processIncoming(request: any): Promise<any>;

  /**
   * Process outgoing response
   */
  processOutgoing(response: any): Promise<any>;

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
    workflow: ModuleConfig;
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
   * Transform request to target protocol
   */
  transformRequest(request: any): Promise<any>;

  /**
   * Transform response from target protocol
   */
  transformResponse(response: any): Promise<any>;
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
  processStreamingControl(request: any): Promise<any>;

  /**
   * Handle streaming response
   */
  handleStreamingResponse(response: any): Promise<any>;
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
  applyTransformations(data: any, rules: TransformationRule[]): Promise<any>;
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
  sendRequest(request: any): Promise<any>;

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
  logModule(module: string, action: string, data?: any): void;
  logError(error: any, context?: any): void;
  logDebug(message: string, data?: any): void;
  logPipeline(pipelineId: string, action: string, data?: any): void;
  logRequest(requestId: string, action: string, data?: any): void;
  logResponse(requestId: string, action: string, data?: any): void;
  logTransformation(requestId: string, action: string, data?: any, result?: any): void;
  logProviderRequest(requestId: string, action: string, request?: any, response?: any): void;
  getRequestLogs(requestId: string): {
    general: any[];
    transformations: any[];
    provider: any[];
  };
  getPipelineLogs(pipelineId: string): {
    general: any[];
    transformations: any[];
    provider: any[];
  };
  getRecentLogs(count?: number): any[];
  getTransformationLogs(): any[];
  getProviderLogs(): any[];
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
  log(level: any, pipelineId: string, category: string, message: string, data?: any): void;
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