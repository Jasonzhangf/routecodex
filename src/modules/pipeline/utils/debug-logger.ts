/**
 * Pipeline Debug Logger Implementation
 *
 * Provides structured logging for pipeline operations with integration
 * to DebugCenter for centralized debugging and monitoring.
 */

import type { DebugCenter } from '../types/external-types.js';
import type { LogData } from '../../../types/common-types.js';
import { DebugEventBus } from '../../debugcenter/debug-event-bus-shim.js';

/**
 * Log entry interface
 */
export interface DebugLogEntry {
  /** Log level */
  level: 'info' | 'warn' | 'error' | 'debug';
  /** Log timestamp */
  timestamp: number;
  /** Pipeline identifier */
  pipelineId: string;
  /** Log category */
  category: string;
  /** Log message */
  message: string;
  /** Log data */
  data?: any;
  /** Request identifier */
  requestId?: string;
  /** Processing stage */
  stage?: string;
}

/**
 * Transformation log entry
 */
export interface TransformationLogEntry {
  /** Timestamp */
  timestamp: number;
  /** Pipeline identifier */
  pipelineId: string;
  /** Request identifier */
  requestId: string;
  /** Transformation stage */
  stage: string;
  /** Original data */
  originalData: any;
  /** Transformed data */
  transformedData: any;
  /** Transformation metadata */
  metadata: {
    ruleId?: string;
    processingTime: number;
    dataSize: number;
  };
}

/**
 * Provider request log entry
 */
export interface ProviderRequestLogEntry {
  /** Timestamp */
  timestamp: number;
  /** Pipeline identifier */
  pipelineId: string;
  /** Request identifier */
  requestId: string;
  /** Action type */
  action: 'request-start' | 'request-success' | 'request-error' | 'health-check';
  /** Provider information */
  provider: {
    id: string;
    type: string;
  };
  /** Request/response data */
  data: any;
  /** Performance metrics */
  metrics?: {
    responseTime?: number;
    status?: number;
    error?: string;
  };
}

/**
 * Pipeline Debug Logger
 */
export class PipelineDebugLogger {
  private logs: DebugLogEntry[] = [];
  private transformationLogs: TransformationLogEntry[] = [];
  private providerLogs: ProviderRequestLogEntry[] = [];
  private maxLogEntries = 1000;
  private eventBus?: DebugEventBus;
  private debugCenter: DebugCenter | null;

  constructor(
    debugCenter: DebugCenter | null = null,
    private options: {
      enableConsoleLogging?: boolean;
      enableDebugCenter?: boolean;
      maxLogEntries?: number;
      logLevel?: 'none' | 'basic' | 'detailed' | 'verbose';
    } = {}
  ) {
    this.debugCenter = debugCenter ?? null;
    this.options = {
      enableConsoleLogging: (process.env.ROUTECODEX_ENABLE_CONSOLE_LOGGING ?? '1') !== '0',
      // Default disable DebugCenter unless explicitly enabled
      enableDebugCenter: process.env.ROUTECODEX_ENABLE_DEBUGCENTER === '1',
      maxLogEntries: 1000,
      logLevel: 'detailed',
      ...options
    };
    this.maxLogEntries = this.options.maxLogEntries!;
    // Ensure events also flow into the global DebugEventBus so external DebugCenter listeners can capture session IO
    try {
      this.eventBus = process.env.ROUTECODEX_ENABLE_DEBUGCENTER === '1' ? DebugEventBus.getInstance() : (undefined as any);
    } catch {
      this.eventBus = undefined as any;
    }
  }

  /**
   * Log module-specific information
   */
  logModule(module: string, action: string, data?: LogData): void {
    const entry: DebugLogEntry = {
      level: 'info',
      timestamp: Date.now(),
      pipelineId: this.extractPipelineId(module),
      category: 'module',
      message: `${action}: ${module}`,
      data: this.mergeLogData({ moduleId: module, action }, data)
    };

    this.addLogEntry(entry);

    if (this.options.enableConsoleLogging) {
      this.logToConsole(entry);
    }

    if (this.options.enableDebugCenter) {
      this.logToDebugCenter(entry);
    }
  }

  /**
   * Log pipeline lifecycle events
   */
  logPipeline(pipelineId: string, action: string, data?: any): void {
    const entry: DebugLogEntry = {
      level: 'info',
      timestamp: Date.now(),
      pipelineId,
      category: 'pipeline-lifecycle',
      message: action,
      data
    };

    this.addLogEntry(entry);

    if (this.options.enableConsoleLogging) {
      this.logToConsole(entry);
    }

    if (this.options.enableDebugCenter) {
      this.logToDebugCenter(entry);
    }
  }

  /**
   * Log request processing information
   */
  logRequest(requestId: string, action: string, data?: LogData): void {
    const entry: DebugLogEntry = {
      level: 'info',
      timestamp: Date.now(),
      pipelineId: this.extractPipelineIdFromRequest(data),
      category: 'request',
      message: `Request ${action}`,
      data: this.mergeLogData({ requestId, action }, data),
      requestId
    };

    this.addLogEntry(entry);

    if (this.options.enableConsoleLogging && this.options.logLevel !== 'none') {
      this.logToConsole(entry);
    }

    if (this.options.enableDebugCenter) {
      this.logToDebugCenter(entry);
    }
  }

  /**
   * Log response processing information
   */
  logResponse(requestId: string, action: string, data?: LogData): void {
    const entry: DebugLogEntry = {
      level: 'info',
      timestamp: Date.now(),
      pipelineId: this.extractPipelineIdFromResponse(data),
      category: 'response',
      message: `Response ${action}`,
      data: this.mergeLogData({ requestId, action }, data),
      requestId
    };

    this.addLogEntry(entry);

    if (this.options.enableConsoleLogging && this.options.logLevel !== 'none') {
      this.logToConsole(entry);
    }

    if (this.options.enableDebugCenter) {
      this.logToDebugCenter(entry);
    }
  }

  /**
   * Log transformation operations
   */
  logTransformation(requestId: string, action: string, data?: any, result?: any): void {
    const pipelineId = this.extractPipelineIdFromData(data);
    const entry: TransformationLogEntry = {
      timestamp: Date.now(),
      pipelineId,
      requestId,
      stage: action,
      originalData: this.sanitizeData(data),
      transformedData: this.sanitizeData(result),
      metadata: {
        ruleId: action,
        processingTime: 0,
        dataSize: data ? JSON.stringify(data).length : 0
      }
    };

    this.transformationLogs.push(entry);

    // Keep only recent transformation logs
    if (this.transformationLogs.length > this.maxLogEntries) {
      this.transformationLogs = this.transformationLogs.slice(-this.maxLogEntries);
    }

    // Log as debug entry
    this.log('debug', pipelineId, 'transformation', action, {
      transformationType: action,
      processingTime: entry.metadata.processingTime,
      dataSize: entry.metadata.dataSize
    });

    // Publish detailed IO to DebugEventBus (if available)
    if (this.eventBus) {
      this.eventBus.publish({
        sessionId: requestId,
        moduleId: pipelineId,
        operationId: `transformation:${action}`,
        timestamp: entry.timestamp,
        type: 'start',
        position: 'middle',
        data: {
          input: this.sanitizeData(data),
          output: this.sanitizeData(result)
        }
      });
    }
  }

  /**
   * Log provider request/response operations
   */
  logProviderRequest(
    requestId: string,
    action: ProviderRequestLogEntry['action'],
    request?: any,
    response?: any
  ): void {
    const sanitizedRequest = this.sanitizeData(request);
    const sanitizedResponse = this.sanitizeData(response);

    const pipelineIdCandidate =
      sanitizedRequest && typeof sanitizedRequest === 'object' && !Array.isArray(sanitizedRequest)
        ? (sanitizedRequest as Record<string, unknown>).pipelineId ||
          (sanitizedRequest as Record<string, unknown>).providerId
        : undefined;
    const pipelineId =
      typeof pipelineIdCandidate === 'string' && pipelineIdCandidate.length > 0
        ? pipelineIdCandidate
        : 'unknown';

    const providerIdCandidate =
      sanitizedRequest && typeof sanitizedRequest === 'object' && !Array.isArray(sanitizedRequest)
        ? (sanitizedRequest as Record<string, unknown>).providerId
        : undefined;
    const providerTypeCandidate =
      sanitizedRequest && typeof sanitizedRequest === 'object' && !Array.isArray(sanitizedRequest)
        ? (sanitizedRequest as Record<string, unknown>).providerType
        : undefined;

    const providerId =
      typeof providerIdCandidate === 'string' && providerIdCandidate.length > 0
        ? providerIdCandidate
        : 'unknown';
    const providerType =
      typeof providerTypeCandidate === 'string' && providerTypeCandidate.length > 0
        ? providerTypeCandidate
        : 'unknown';

    const providerData: Record<string, unknown> = {
      request: sanitizedRequest,
      response: sanitizedResponse
    };

    const entry: ProviderRequestLogEntry = {
      timestamp: Date.now(),
      pipelineId,
      requestId,
      action,
      provider: {
        id: providerId,
        type: providerType
      },
      data: providerData,
      metrics: response?.metrics || request?.metrics
    };

    this.providerLogs.push(entry);

    // Keep only recent provider logs
    if (this.providerLogs.length > this.maxLogEntries) {
      this.providerLogs = this.providerLogs.slice(-this.maxLogEntries);
    }

    // Log as debug entry
    this.log('debug', pipelineId, 'provider', action, providerData);

    // Publish detailed IO to DebugEventBus (if available)
    if (this.eventBus) {
      this.eventBus.publish({
        sessionId: requestId,
        moduleId: pipelineId,
        operationId: `provider:${action}`,
        timestamp: entry.timestamp,
        type: action === 'request-error' ? 'error' : 'start',
        position: 'middle',
        data: {
          input: sanitizedRequest,
          output: sanitizedResponse
        }
      });
    }
  }

  /**
   * Log error information
   */
  logError(error: any, context?: any): void {
    const entry: DebugLogEntry = {
      level: 'error',
      timestamp: Date.now(),
      pipelineId: this.extractPipelineIdFromData(context),
      category: 'error',
      message: error instanceof Error ? error.message : String(error),
      data: {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        context
      },
      requestId: context?.requestId
    };

    this.addLogEntry(entry);

    if (this.options.enableConsoleLogging) {
      this.logToConsole(entry);
    }

    if (this.options.enableDebugCenter) {
      this.logToDebugCenter(entry);
    }
  }

  /**
   * Log debug information
   */
  logDebug(message: string, data?: any): void {
    const entry: DebugLogEntry = {
      level: 'debug',
      timestamp: Date.now(),
      pipelineId: this.extractPipelineIdFromData(data),
      category: 'debug',
      message,
      data
    };

    this.addLogEntry(entry);

    if (this.options.enableConsoleLogging) {
      this.logToConsole(entry);
    }

    if (this.options.enableDebugCenter) {
      this.logToDebugCenter(entry);
    }
  }

  /**
   * Get logs for a specific request
   */
  getRequestLogs(requestId: string): {
    general: DebugLogEntry[];
    transformations: TransformationLogEntry[];
    provider: ProviderRequestLogEntry[];
  } {
    return {
      general: this.logs.filter(log => log.requestId === requestId),
      transformations: this.transformationLogs.filter(log => log.requestId === requestId),
      provider: this.providerLogs.filter(log => log.requestId === requestId)
    };
  }

  /**
   * Get logs for a specific pipeline
   */
  getPipelineLogs(pipelineId: string): {
    general: DebugLogEntry[];
    transformations: TransformationLogEntry[];
    provider: ProviderRequestLogEntry[];
  } {
    return {
      general: this.logs.filter(log => log.pipelineId === pipelineId),
      transformations: this.transformationLogs.filter(log => log.pipelineId === pipelineId),
      provider: this.providerLogs.filter(log => log.pipelineId === pipelineId)
    };
  }

  /**
   * Get recent logs
   */
  getRecentLogs(count: number = 100): DebugLogEntry[] {
    return this.logs.slice(-count);
  }

  /**
   * Get transformation logs
   */
  getTransformationLogs(): TransformationLogEntry[] {
    return [...this.transformationLogs];
  }

  /**
   * Get provider logs
   */
  getProviderLogs(): ProviderRequestLogEntry[] {
    return [...this.providerLogs];
  }

  /**
   * Get log statistics
   */
  getStatistics(): {
    totalLogs: number;
    logsByLevel: Record<string, number>;
    logsByCategory: Record<string, number>;
    logsByPipeline: Record<string, number>;
    transformationCount: number;
    providerRequestCount: number;
  } {
    const logsByLevel: Record<string, number> = {};
    const logsByCategory: Record<string, number> = {};
    const logsByPipeline: Record<string, number> = {};

    this.logs.forEach(log => {
      logsByLevel[log.level] = (logsByLevel[log.level] || 0) + 1;
      logsByCategory[log.category] = (logsByCategory[log.category] || 0) + 1;
      logsByPipeline[log.pipelineId] = (logsByPipeline[log.pipelineId] || 0) + 1;
    });

    return {
      totalLogs: this.logs.length,
      logsByLevel,
      logsByCategory,
      logsByPipeline,
      transformationCount: this.transformationLogs.length,
      providerRequestCount: this.providerLogs.length
    };
  }

  /**
   * Clear all logs
   */
  clearLogs(): void {
    this.logs = [];
    this.transformationLogs = [];
    this.providerLogs = [];
  }

  /**
   * Export logs to file or object
   */
  exportLogs(format: 'json' | 'csv' = 'json'): any {
    if (format === 'json') {
      return {
        timestamp: Date.now(),
        general: this.logs,
        transformations: this.transformationLogs,
        provider: this.providerLogs,
        statistics: this.getStatistics()
      };
    }

    // Would implement CSV export here
    return { error: 'CSV export not implemented yet' };
  }

  /**
   * Log general debug messages
   */
  log(level: DebugLogEntry['level'], pipelineId: string, category: string, message: string, data?: any): void {
    const entry: DebugLogEntry = {
      level,
      timestamp: Date.now(),
      pipelineId,
      category,
      message,
      data
    };

    this.addLogEntry(entry);

    // Console logging
    if (this.options.enableConsoleLogging) {
      this.logToConsole(entry);
    }

    // DebugCenter integration
    if (this.options.enableDebugCenter) {
      this.logToDebugCenter(entry);
    }
  }

  /**
   * Add log entry with size management
   */
  private addLogEntry(entry: DebugLogEntry): void {
    this.logs.push(entry);

    // Keep only recent logs
    if (this.logs.length > this.maxLogEntries) {
      this.logs = this.logs.slice(-this.maxLogEntries);
    }
  }

  /**
   * Log to console
   */
  private logToConsole(entry: DebugLogEntry): void {
    const timestamp = new Date(entry.timestamp).toISOString();
    const prefix = `[${timestamp}] [${entry.level.toUpperCase()}] [${entry.pipelineId}] [${entry.category}]`;

    switch (entry.level) {
      case 'error':
        console.error(prefix, entry.message, entry.data);
        break;
      case 'warn':
        console.warn(prefix, entry.message, entry.data);
        break;
      case 'debug':
        if (this.options.logLevel === 'verbose' || this.options.logLevel === 'detailed') {
          console.debug(prefix, entry.message, entry.data);
        }
        break;
      default:
        if (this.options.logLevel !== 'none') {
          console.log(prefix, entry.message, entry.data);
        }
        break;
    }
  }

  /**
   * Log to DebugCenter
   */
  private logToDebugCenter(entry: DebugLogEntry): void {
    if (!this.options.enableDebugCenter) {
      return;
    }

    try {
      if (!this.debugCenter || typeof this.debugCenter.processDebugEvent !== 'function') {
        return;
      }

      this.debugCenter.processDebugEvent({
        sessionId: entry.requestId || 'unknown',
        moduleId: entry.pipelineId || 'unknown',
        operationId: `log-${entry.category}`,
        timestamp: entry.timestamp,
        type: 'start',
        position: 'middle',
        data: {
          level: entry.level,
          category: entry.category,
          message: entry.message,
          data: entry.data,
          requestId: entry.requestId,
          stage: entry.stage
        }
      });
      // Also publish to DebugEventBus for file-based session capture by external DebugCenter
      if (this.eventBus) {
        this.eventBus.publish({
          sessionId: entry.requestId || 'unknown',
          moduleId: entry.pipelineId || 'pipeline',
          operationId: `pipeline-${entry.category}`,
          timestamp: entry.timestamp,
          type: entry.level === 'error' ? 'error' : 'start',
          position: 'middle',
          data: entry.data
        });
      }
    } catch (error) {
      // Fallback to console if DebugCenter fails
      console.warn('Failed to log to DebugCenter:', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Extract pipeline ID from module ID
   */
  private extractPipelineId(moduleId: string): string {
    // Extract pipeline ID from module ID format
    const match = moduleId.match(/^(\w+)-/);
    return match ? match[1] : moduleId;
  }

  /**
   * Extract pipeline ID from request data
   */
  private extractPipelineIdFromRequest(data: any): string {
    if (!data || typeof data !== 'object') {
      return 'unknown';
    }

    const record = data as Record<string, any>;
    return record.pipelineId || record.route?.pipelineId || 'unknown';
  }

  /**
   * Extract pipeline ID from response data
   */
  private extractPipelineIdFromResponse(data: any): string {
    if (!data || typeof data !== 'object') {
      return 'unknown';
    }

    const record = data as Record<string, any>;
    return record.pipelineId || record.metadata?.pipelineId || 'unknown';
  }

  /**
   * Extract pipeline ID from generic data
   */
  private extractPipelineIdFromData(data: any): string {
    if (!data || typeof data !== 'object') {
      return 'unknown';
    }

    const record = data as Record<string, any>;
    return record.pipelineId || record.metadata?.pipelineId || 'unknown';
  }

  /**
   * Merge base log data with any additional payload in a safe way
   */
  private mergeLogData(base: Record<string, unknown>, extra?: LogData): LogData {
    if (extra === undefined) {
      return base;
    }

    if (typeof extra === 'object' && extra !== null && !Array.isArray(extra)) {
      return { ...base, ...(extra as Record<string, unknown>) };
    }

    return { ...base, value: extra };
  }

  /**
   * Sanitize data for logging (remove sensitive information)
   */
  private sanitizeData(data: any): any {
    const sensitiveKeys = new Set<string>([
      'apiKey', 'api_key', 'token', 'password', 'secret',
      'authorization', 'auth', 'credentials'
    ]);

    const redact = (value: any): any => {
      if (value === null || value === undefined) { return value; }
      const t = typeof value;
      if (t === 'string' || t === 'number' || t === 'boolean') { return value; }
      if (Array.isArray(value)) { return value.map(v => redact(v)); }
      if (t === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (sensitiveKeys.has(k.toLowerCase()) || sensitiveKeys.has(k)) {
            out[k] = '[REDACTED]';
          } else if (k.toLowerCase() === 'headers') {
            // Special-case headers: redact common auth headers
            const headers = v as Record<string, unknown> | undefined;
            const hOut: Record<string, unknown> = {};
            if (headers && typeof headers === 'object') {
              for (const [hk, hv] of Object.entries(headers)) {
                if (/^authorization$/i.test(hk) || /api[-_]?key/i.test(hk)) {
                  hOut[hk] = '[REDACTED]';
                } else {
                  hOut[hk] = redact(hv);
                }
              }
            }
            out[k] = hOut;
          } else {
            out[k] = redact(v);
          }
        }
        return out;
      }
      return value;
    };

    return redact(data);
  }
}
