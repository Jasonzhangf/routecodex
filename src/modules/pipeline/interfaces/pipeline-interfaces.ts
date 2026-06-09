/**
 * Provider/runtime compatibility interfaces.
 *
 * Host no longer owns TS PipelineManager / LLM Switch / Compatibility module
 * semantics. This file only keeps the provider/runtime dependency surface that
 * existing Provider V2 and HTTP runtime code still consumes.
 */

import type { ErrorHandlingCenter, DebugCenter } from '../types/external-types.js';
import type { LogData, UnknownObject } from '../../../types/common-types.js';
import type {
  DebugLogEntry,
  TransformationLogEntry,
  ProviderRequestLogEntry
} from '../utils/debug-logger.js';

export interface ModuleConfig {
  type: string;
  config: Record<string, unknown>;
  enabled?: boolean;
  priority?: number;
}

export interface ProviderModule {
  readonly id: string;
  readonly type: string;
  readonly config: ModuleConfig;
  readonly providerType: string;
  initialize(): Promise<void>;
  processIncoming(request: UnknownObject): Promise<UnknownObject>;
  processOutgoing(response: UnknownObject): Promise<UnknownObject>;
  sendRequest(request: UnknownObject): Promise<unknown>;
  checkHealth(): Promise<boolean>;
  cleanup(): Promise<void>;
}

export interface PipelineDispatchCenter {
  dispatch(event: string, payload?: LogData): Promise<void> | void;
}

export interface ModuleDependencies {
  errorHandlingCenter: ErrorHandlingCenter;
  debugCenter: DebugCenter;
  logger: PipelineDebugLogger;
  dispatchCenter?: PipelineDispatchCenter;
}

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
