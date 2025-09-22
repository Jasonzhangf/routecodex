/**
 * Pipeline Debug Logger Implementation
 *
 * Provides structured logging for pipeline operations with integration
 * to DebugCenter for centralized debugging and monitoring.
 */

import type { DebugCenter } from '../types/external-types.js';

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

  constructor(
    private debugCenter: DebugCenter,
    private options: {
      enableConsoleLogging?: boolean;
      enableDebugCenter?: boolean;
      maxLogEntries?: number;
      logLevel?: 'none' | 'basic' | 'detailed' | 'verbose';
    } = {}
  ) {
    this.options = {
      enableConsoleLogging: true,
      enableDebugCenter: true,
      maxLogEntries: 1000,
      logLevel: 'detailed',
      ...options
    };
    this.maxLogEntries = this.options.maxLogEntries!;
  }

  /**
   * Log module-specific information
   */
  logModule(module: string, action: string, data?: any): void {
    const entry: DebugLogEntry = {
      level: 'info',
      timestamp: Date.now(),
      pipelineId: this.extractPipelineId(module),
      category: 'module',
      message: `${action}: ${module}`,
      data: {
        moduleId: module,
        action,
        ...data
      }
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
  logRequest(requestId: string, action: string, data?: any): void {
    const entry: DebugLogEntry = {
      level: 'info',
      timestamp: Date.now(),
      pipelineId: this.extractPipelineIdFromRequest(data),
      category: 'request',
      message: `Request ${action}`,
      data: {
        requestId,
        action,
        ...data
      },
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
  logResponse(requestId: string, action: string, data?: any): void {
    const entry: DebugLogEntry = {
      level: 'info',
      timestamp: Date.now(),
      pipelineId: this.extractPipelineIdFromResponse(data),
      category: 'response',
      message: `Response ${action}`,
      data: {
        requestId,
        action,
        ...data
      },
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
    const data = { ...request, response };
    const pipelineId = request?.pipelineId || request?.providerId || 'unknown';
    const entry: ProviderRequestLogEntry = {
      timestamp: Date.now(),
      pipelineId,
      requestId,
      action,
      provider: {
        id: request?.providerId || 'unknown',
        type: request?.providerType || 'unknown'
      },
      data: this.sanitizeData(data),
      metrics: response?.metrics || request?.metrics
    };

    this.providerLogs.push(entry);

    // Keep only recent provider logs
    if (this.providerLogs.length > this.maxLogEntries) {
      this.providerLogs = this.providerLogs.slice(-this.maxLogEntries);
    }

    // Log as debug entry
    this.log('debug', pipelineId, 'provider', action, data);
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
    try {
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
    return data.pipelineId || data.route?.pipelineId || 'unknown';
  }

  /**
   * Extract pipeline ID from response data
   */
  private extractPipelineIdFromResponse(data: any): string {
    return data.pipelineId || data.metadata?.pipelineId || 'unknown';
  }

  /**
   * Extract pipeline ID from generic data
   */
  private extractPipelineIdFromData(data: any): string {
    return data.pipelineId || data.metadata?.pipelineId || 'unknown';
  }

  /**
   * Sanitize data for logging (remove sensitive information)
   */
  private sanitizeData(data: any): any {
    if (!data || typeof data !== 'object') {
      return data;
    }

    const sanitized = { ...data };

    // Remove sensitive fields
    const sensitiveFields = [
      'apiKey', 'api_key', 'token', 'password', 'secret',
      'authorization', 'auth', 'credentials'
    ];

    sensitiveFields.forEach(field => {
      if (field in sanitized) {
        sanitized[field] = '[REDACTED]';
      }
    });

    return sanitized;
  }
}