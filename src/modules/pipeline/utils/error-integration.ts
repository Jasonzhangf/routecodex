/**
 * Pipeline Error Integration Implementation
 *
 * Provides unified error handling for pipeline modules, integrating with
 * the ErrorHandlingCenter for consistent error management and recovery.
 */

import type { ErrorHandlingCenter } from '../types/external-types.js';
import type { PipelineError } from '../interfaces/pipeline-interfaces.js';

/**
 * Error context interface
 */
export interface ErrorContext {
  /** Pipeline identifier */
  pipelineId: string;
  /** Request identifier */
  requestId: string;
  /** Processing stage */
  stage: string;
  /** Error instance */
  error?: PipelineError;
  /** Additional context data */
  [key: string]: any;
}

/**
 * Error recovery strategy
 */
export type ErrorRecoveryStrategy = 'retry' | 'fallback' | 'degrade' | 'fail';

/**
 * Error handling options
 */
export interface ErrorHandlingOptions {
  /** Whether to retry on error */
  retry: boolean;
  /** Maximum retry attempts */
  maxRetries: number;
  /** Retry delay in milliseconds */
  retryDelay: number;
  /** Whether to log detailed error information */
  detailedLogging: boolean;
  /** Recovery strategy */
  recoveryStrategy: ErrorRecoveryStrategy;
}

/**
 * Pipeline Error Integration
 */
export class PipelineErrorIntegration {
  private options: ErrorHandlingOptions;
  private retryCounts: Map<string, number> = new Map();
  private errorHistory: Array<{
    timestamp: number;
    context: ErrorContext;
    error: any;
  }> = [];

  constructor(
    private errorHandlingCenter: ErrorHandlingCenter,
    options: Partial<ErrorHandlingOptions> = {}
  ) {
    this.options = {
      retry: true,
      maxRetries: 3,
      retryDelay: 1000,
      detailedLogging: true,
      recoveryStrategy: 'fail',
      ...options
    };
  }

  /**
   * Handle module error with integration to ErrorHandlingCenter
   */
  async handleModuleError(error: any, context: ErrorContext): Promise<void> {
    const timestamp = Date.now();
    const errorKey = `${context.pipelineId}:${context.requestId}:${context.stage}`;

    try {
      // Create standardized error
      const pipelineError = this.createPipelineError(error, context);

      // Add to error history
      this.errorHistory.push({
        timestamp,
        context,
        error: pipelineError
      });

      // Log detailed error information
      if (this.options.detailedLogging) {
        await this.logErrorDetails(pipelineError, context);
      }

      // Determine if retry is possible
      const shouldRetry = this.shouldRetry(error, context);
      const retryCount = this.getRetryCount(errorKey);

      if (shouldRetry && retryCount < this.options.maxRetries) {
        await this.handleRetry(error, context, retryCount);
        return;
      }

      // Execute recovery strategy
      await this.executeRecoveryStrategy(pipelineError, context);

      // Report to ErrorHandlingCenter
      await this.reportToErrorHandlingCenter(pipelineError, context);

      // Reset retry count if we're not retrying
      if (!shouldRetry || retryCount >= this.options.maxRetries) {
        this.resetRetryCount(errorKey);
      }

    } catch (handlingError) {
      // Fallback error handling
      console.error('Error in error handling:', handlingError);
      console.error('Original error:', error);
    }
  }

  /**
   * Create pipeline error from module error
   */
  private createPipelineError(error: any, context: ErrorContext): PipelineError {
    const baseError: PipelineError = {
      stage: context.stage,
      code: this.extractErrorCode(error),
      message: error.message || 'Unknown error occurred',
      details: {
        stack: error.stack,
        originalError: error,
        ...context
      },
      timestamp: Date.now()
    };

    // Add specific error categorization
    this.categorizeError(baseError, error);

    return baseError;
  }

  /**
   * Extract error code from various error types
   */
  private extractErrorCode(error: any): string {
    if (error.code) {
      return error.code;
    }

    if (error.statusCode) {
      return `HTTP_${error.statusCode}`;
    }

    if (error.name) {
      return error.name.toUpperCase().replace(/\s+/g, '_');
    }

    // Categorize based on error message patterns
    const message = error.message?.toLowerCase() || '';
    if (message.includes('timeout')) {return 'TIMEOUT';}
    if (message.includes('network')) {return 'NETWORK_ERROR';}
    if (message.includes('auth')) {return 'AUTHENTICATION_ERROR';}
    if (message.includes('permission')) {return 'PERMISSION_ERROR';}
    if (message.includes('not found')) {return 'NOT_FOUND';}
    if (message.includes('validation')) {return 'VALIDATION_ERROR';}

    return 'UNKNOWN_ERROR';
  }

  /**
   * Categorize error for better handling
   */
  private categorizeError(pipelineError: PipelineError, originalError: any): void {
    const code = pipelineError.code;
    const details: any = (pipelineError as any).details || ((pipelineError as any).details = {});

    // Add error category
    if (code.startsWith('HTTP_4')) {
      details.category = 'client_error';
      details.retryable = false;
    } else if (code.startsWith('HTTP_5')) {
      details.category = 'server_error';
      details.retryable = true;
    } else if (code.includes('TIMEOUT') || code.includes('NETWORK')) {
      details.category = 'network_error';
      details.retryable = true;
    } else if (code.includes('AUTH') || code.includes('PERMISSION')) {
      details.category = 'authentication_error';
      details.retryable = false;
    } else if (code.includes('VALIDATION')) {
      details.category = 'validation_error';
      details.retryable = false;
    } else {
      details.category = 'unknown_error';
      details.retryable = false;
    }

    // Add HTTP status code if available
    if (originalError && typeof originalError === 'object' && 'statusCode' in originalError) {
      details.httpStatus = (originalError as any).statusCode;
    }

    // Add rate limit information if available
    if (code === 'RATE_LIMIT_EXCEEDED' || (originalError && (originalError as any).statusCode === 429)) {
      details.rateLimit = {
        limit: (originalError as any)?.headers?.['x-ratelimit-limit'],
        remaining: (originalError as any)?.headers?.['x-ratelimit-remaining'],
        resetTime: (originalError as any)?.['x-ratelimit-reset']
      };
    }
  }

  /**
   * Log detailed error information
   */
  private async logErrorDetails(error: PipelineError, context: ErrorContext): Promise<void> {
    const logEntry = {
      type: 'pipeline-error',
      timestamp: error.timestamp,
      pipelineId: context.pipelineId,
      requestId: context.requestId,
      stage: error.stage,
      code: error.code,
      message: error.message,
      category: (error.details as any)?.category,
      retryable: (error.details as any)?.retryable,
      context: {
        ...context,
        error: undefined // Remove circular reference
      }
    };

    // Log to ErrorHandlingCenter
    await this.errorHandlingCenter.handleError(logEntry);
  }

  /**
   * Determine if error should be retried
   */
  private shouldRetry(error: any, context: ErrorContext): boolean {
    if (!this.options.retry) {
      return false;
    }

    // Check error category
    const errorCode = this.extractErrorCode(error);

    // 429 errors are retryable and will be handled by the 429 error handling system
    if (errorCode === 'HTTP_429' || error.statusCode === 429) {
      return true;
    }

    const nonRetryableCodes = [
      'AUTHENTICATION_ERROR',
      'PERMISSION_ERROR',
      'VALIDATION_ERROR',
      'NOT_FOUND',
      'HTTP_400',
      'HTTP_401',
      'HTTP_403',
      'HTTP_404',
      'HTTP_422'
    ];

    return !nonRetryableCodes.includes(errorCode);
  }

  /**
   * Get current retry count for error key
   */
  private getRetryCount(errorKey: string): number {
    return this.retryCounts.get(errorKey) || 0;
  }

  /**
   * Reset retry count for error key
   */
  private resetRetryCount(errorKey: string): void {
    this.retryCounts.delete(errorKey);
  }

  /**
   * Handle retry logic
   */
  private async handleRetry(error: any, context: ErrorContext, retryCount: number): Promise<void> {
    const errorKey = `${context.pipelineId}:${context.requestId}:${context.stage}`;
    const nextRetryCount = retryCount + 1;

    // Update retry count
    this.retryCounts.set(errorKey, nextRetryCount);

    // Calculate delay with exponential backoff
    const delay = this.options.retryDelay * Math.pow(2, retryCount);

    // Log retry attempt
    await this.errorHandlingCenter.handleError({
      type: 'retry-attempt',
      timestamp: Date.now(),
      pipelineId: context.pipelineId,
      requestId: context.requestId,
      stage: context.stage,
      attempt: nextRetryCount,
      maxAttempts: this.options.maxRetries,
      delay: delay,
      error: error.message
    });

    // Wait before retry (in real implementation, this would be handled by the caller)
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  /**
   * Execute recovery strategy
   */
  private async executeRecoveryStrategy(error: PipelineError, context: ErrorContext): Promise<void> {
    // Special handling for 429 errors
    if (error.code === 'HTTP_429' || (error.details as any)?.httpStatus === 429) {
      await this.execute429Strategy(error, context);
      return;
    }

    switch (this.options.recoveryStrategy) {
      case 'retry':
        // Retry logic is handled in handleRetry
        break;

      case 'fallback':
        await this.executeFallbackStrategy(error, context);
        break;

      case 'degrade':
        await this.executeDegradeStrategy(error, context);
        break;

      case 'fail':
      default:
        await this.executeFailStrategy(error, context);
        break;
    }
  }

  /**
   * Execute fallback strategy
   */
  private async executeFallbackStrategy(error: PipelineError, context: ErrorContext): Promise<void> {
    await this.errorHandlingCenter.handleError({
      type: 'fallback-executed',
      timestamp: Date.now(),
      pipelineId: context.pipelineId,
      requestId: context.requestId,
      stage: context.stage,
      originalError: error.code,
      fallbackAction: 'using_default_response'
    });

    // Would implement actual fallback logic here
    // For example: return cached response, use alternative provider, etc.
  }

  /**
   * Execute degrade strategy
   */
  private async executeDegradeStrategy(error: PipelineError, context: ErrorContext): Promise<void> {
    await this.errorHandlingCenter.handleError({
      type: 'degrade-executed',
      timestamp: Date.now(),
      pipelineId: context.pipelineId,
      requestId: context.requestId,
      stage: context.stage,
      originalError: error.code,
      degradeAction: 'reduced_functionality'
    });

    // Would implement actual degrade logic here
    // For example: disable non-essential features, use simpler processing, etc.
  }

  /**
   * Execute 429 error strategy
   */
  private async execute429Strategy(error: PipelineError, context: ErrorContext): Promise<void> {
    // Extract key information from error context
    const key = (error.details as any)?.key || (context as any).key || 'unknown';
    const pipelineIds = (error.details as any)?.pipelineIds || [context.pipelineId];

    // Log 429 error to ErrorHandlingCenter
    await this.errorHandlingCenter.handleError({
      type: '429-error-executed',
      timestamp: Date.now(),
      pipelineId: context.pipelineId,
      requestId: context.requestId,
      stage: context.stage,
      finalError: error.code,
      action: '429_rate_limit_handling',
      key,
      pipelineIds,
      retryable: true
    });

    // The actual retry logic will be handled by the PipelineManager's retry scheduler
    // This method is responsible for logging and preparing the error for retry
    throw new Error(`429 Rate Limit Error in ${context.stage}: ${error.message} (key: ${key})`);
  }

  /**
   * Execute fail strategy
   */
  private async executeFailStrategy(error: PipelineError, context: ErrorContext): Promise<void> {
    await this.errorHandlingCenter.handleError({
      type: 'fail-executed',
      timestamp: Date.now(),
      pipelineId: context.pipelineId,
      requestId: context.requestId,
      stage: context.stage,
      finalError: error.code,
      action: 'request_failed'
    });
    // Do not throw a new error here to preserve original error context.
    // The caller will rethrow the original module error after integration.
  }

  /**
   * Report error to ErrorHandlingCenter
   */
  private async reportToErrorHandlingCenter(error: PipelineError, context: ErrorContext): Promise<void> {
    const errorReport = {
      type: 'pipeline-error',
      timestamp: error.timestamp,
      severity: ((error.details as any)?.category === 'network_error') ? 'warning' : 'error',
      pipelineId: context.pipelineId,
      requestId: context.requestId,
      stage: error.stage,
      code: error.code,
      message: error.message,
      details: error.details,
      context: context
    };

    await this.errorHandlingCenter.handleError(errorReport);
  }

  /**
   * Get error statistics
   */
  getErrorStatistics(): {
    totalErrors: number;
    errorsByStage: Record<string, number>;
    errorsByCategory: Record<string, number>;
    retryCounts: Record<string, number>;
    recentErrors: Array<{ timestamp: number; stage: string; code: string }>;
  } {
    const errorsByStage: Record<string, number> = {};
    const errorsByCategory: Record<string, number> = {};

    // Count errors by stage and category
    this.errorHistory.forEach(entry => {
      errorsByStage[entry.context.stage] = (errorsByStage[entry.context.stage] || 0) + 1;
      const category = entry.error.details?.category || 'unknown';
      errorsByCategory[category] = (errorsByCategory[category] || 0) + 1;
    });

    // Get recent errors (last hour)
    const oneHourAgo = Date.now() - 3600000;
    const recentErrors = this.errorHistory
      .filter(entry => entry.timestamp > oneHourAgo)
      .map(entry => ({
        timestamp: entry.timestamp,
        stage: entry.context.stage,
        code: entry.error.code
      }))
      .slice(-10); // Last 10 errors

    return {
      totalErrors: this.errorHistory.length,
      errorsByStage,
      errorsByCategory,
      retryCounts: Object.fromEntries(this.retryCounts),
      recentErrors
    };
  }

  /**
   * Clear error history
   */
  clearErrorHistory(): void {
    this.errorHistory = [];
    this.retryCounts.clear();
  }

  /**
   * Update error handling options
   */
  updateOptions(options: Partial<ErrorHandlingOptions>): void {
    this.options = { ...this.options, ...options };
  }
}
