/**
 * Error Handling Utilities
 * Provides convenient utilities for modules to integrate with the enhanced error handling system
 */

import { ErrorHandlerRegistry } from './error-handler-registry.js';
import { ErrorHandlingCenter, type ErrorContext } from 'rcc-errorhandling';
import { DebugEventBus } from 'rcc-debugcenter';

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Error handling options
 */
export interface ErrorHandlingOptions {
  severity?: 'low' | 'medium' | 'high' | 'critical';
  category?: string;
  recovery?: string;
  additionalContext?: Record<string, any>;
  suppressLogging?: boolean;
}

/**
 * Error context builder interface
 */
export interface ErrorContextBuilder {
  withSeverity(severity: 'low' | 'medium' | 'high' | 'critical'): ErrorContextBuilder;
  withCategory(category: string): ErrorContextBuilder;
  withRecovery(recovery: string): ErrorContextBuilder;
  withAdditionalContext(context: Record<string, any>): ErrorContextBuilder;
  withSuppressedLogging(): ErrorContextBuilder;
  build(): ErrorContext;
}

/**
 * Context-aware error class
 */
export class ContextualError extends Error {
  public readonly context: string;
  public readonly moduleId: string;
  public readonly severity: 'low' | 'medium' | 'high' | 'critical';
  public readonly category: string;
  public readonly additionalContext?: Record<string, any>;

  constructor(
    message: string,
    context: string,
    moduleId: string,
    options: ErrorHandlingOptions = {}
  ) {
    super(message);
    this.name = 'ContextualError';
    this.context = context;
    this.moduleId = moduleId;
    this.severity = options.severity || 'medium';
    this.category = options.category || 'general';
    this.additionalContext = options.additionalContext;
  }
}

/**
 * Error Handling Utilities class
 * Provides convenient methods for error handling across all modules
 */
export class ErrorHandlingUtils {
  private static registry: ErrorHandlerRegistry | null = null;

  /**
   * Initialize error handling utilities
   */
  public static async initialize(): Promise<void> {
    if (!ErrorHandlingUtils.registry) {
      ErrorHandlingUtils.registry = ErrorHandlerRegistry.getInstance();
      await ErrorHandlingUtils.registry.initialize();
    }
  }

  /**
   * Handle error with enhanced context
   */
  public static async handleError(
    error: Error,
    context: string,
    moduleId: string,
    options: ErrorHandlingOptions = {}
  ): Promise<void> {
    try {
      // Ensure registry is initialized
      if (!ErrorHandlingUtils.registry) {
        await ErrorHandlingUtils.initialize();
      }

      // Create contextual error if needed
      const contextualError =
        error instanceof ContextualError
          ? error
          : new ContextualError(error.message, context, moduleId, options);

      // Handle error through registry
      await ErrorHandlingUtils.registry!.handleError(contextualError, context, moduleId, {
        ...options.additionalContext,
        severity: contextualError.severity,
        category: contextualError.category,
        recovery: options.recovery,
      });

      // Log error if not suppressed
      if (!options.suppressLogging) {
        this.logError(contextualError, context, moduleId, options);
      }
    } catch (handlerError) {
      console.error('Failed to handle error:', handlerError);
      console.error('Original error:', error);
    }
  }

  /**
   * Create error context builder
   */
  public static createContextBuilder(
    error: Error,
    context: string,
    moduleId: string
  ): ErrorContextBuilder {
    return new ErrorContextBuilderImpl(error, context, moduleId);
  }

  /**
   * Handle async function with error handling
   */
  public static async withErrorHandling<T>(
    fn: () => Promise<T>,
    context: string,
    moduleId: string,
    options: ErrorHandlingOptions = {}
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      await ErrorHandlingUtils.handleError(
        error instanceof Error ? error : new Error(String(error)),
        context,
        moduleId,
        options
      );
      throw error; // Re-throw to allow caller to handle
    }
  }

  /**
   * Handle sync function with error handling
   */
  public static withSyncErrorHandling<T>(
    fn: () => T,
    context: string,
    moduleId: string,
    options: ErrorHandlingOptions = {}
  ): T {
    try {
      return fn();
    } catch (error) {
      ErrorHandlingUtils.handleError(
        error instanceof Error ? error : new Error(String(error)),
        context,
        moduleId,
        options
      ).catch(handlerError => {
        console.error('Failed to handle error:', handlerError);
      });
      throw error; // Re-throw to allow caller to handle
    }
  }

  /**
   * Register custom error message
   */
  public static registerErrorMessage(
    code: string,
    message: string,
    severity: 'low' | 'medium' | 'high' | 'critical',
    category: string,
    description?: string,
    recovery?: string
  ): void {
    if (!ErrorHandlingUtils.registry) {
      console.warn('Error handling registry not initialized. Call initialize() first.');
      return;
    }

    ErrorHandlingUtils.registry.registerErrorMessage({
      code,
      message,
      severity,
      category,
      description,
      recovery,
    });
  }

  /**
   * Register custom error handler
   */
  public static registerErrorHandler(
    errorCode: string,
    handler: (context: ErrorContext) => Promise<void>,
    priority: number = 10,
    description?: string
  ): void {
    if (!ErrorHandlingUtils.registry) {
      console.warn('Error handling registry not initialized. Call initialize() first.');
      return;
    }

    // @ts-ignore - Type mismatch between ErrorContext definitions
    ErrorHandlingUtils.registry.registerErrorHandler({
      errorCode,
      handler: handler as any,
      priority,
      description,
    });
  }

  /**
   * Create module-specific error handler
   */
  public static createModuleErrorHandler(moduleId: string) {
    return {
      /**
       * Handle error for this module
       */
      handle: async (
        error: Error,
        context: string,
        options: ErrorHandlingOptions = {}
      ): Promise<void> => {
        await ErrorHandlingUtils.handleError(error, context, moduleId, options);
      },

      /**
       * Create contextual error for this module
       */
      createError: (
        message: string,
        context: string,
        options: ErrorHandlingOptions = {}
      ): ContextualError => {
        return new ContextualError(message, context, moduleId, options);
      },

      /**
       * Register error message for this module
       */
      registerMessage: (
        code: string,
        message: string,
        severity: 'low' | 'medium' | 'high' | 'critical',
        category: string,
        description?: string,
        recovery?: string
      ): void => {
        const moduleCode = `${moduleId}_${code}`;
        ErrorHandlingUtils.registerErrorMessage(
          moduleCode,
          message,
          severity,
          category,
          description,
          recovery
        );
      },

      /**
       * Register error handler for this module
       */
      registerHandler: (
        errorCode: string,
        handler: (context: ErrorContext) => Promise<void>,
        priority: number = 10,
        description?: string
      ): void => {
        const moduleCode = `${moduleId}_${errorCode}`;
        ErrorHandlingUtils.registerErrorHandler(moduleCode, handler, priority, description);
      },

      /**
       * Wrap async function with error handling for this module
       */
      wrapAsync: <T>(
        fn: () => Promise<T>,
        context: string,
        options: ErrorHandlingOptions = {}
      ): (() => Promise<T>) => {
        return async () => {
          try {
            return await fn();
          } catch (error) {
            await ErrorHandlingUtils.handleError(
              error instanceof Error ? error : new Error(String(error)),
              context,
              moduleId,
              options
            );
            throw error;
          }
        };
      },

      /**
       * Wrap sync function with error handling for this module
       */
      wrapSync: <T>(
        fn: () => T,
        context: string,
        options: ErrorHandlingOptions = {}
      ): (() => T) => {
        return () => {
          try {
            return fn();
          } catch (error) {
            ErrorHandlingUtils.handleError(
              error instanceof Error ? error : new Error(String(error)),
              context,
              moduleId,
              options
            ).catch(handlerError => {
              console.error('Failed to handle error:', handlerError);
            });
            throw error;
          }
        };
      },
    };
  }

  /**
   * Log error with context
   */
  private static logError(
    error: Error,
    context: string,
    moduleId: string,
    options: ErrorHandlingOptions
  ): void {
    const logLevel = this.getLogLevel(options.severity);
    const logMessage = `${moduleId}::${context} - ${error.message}`;
    const logData = {
      error: error.message,
      stack: error.stack,
      name: error.name,
      moduleId,
      context,
      severity: options.severity,
      category: options.category,
      additionalContext: options.additionalContext,
    };

    switch (logLevel) {
      case 'error':
        console.error(logMessage, logData);
        break;
      case 'warn':
        console.warn(logMessage, logData);
        break;
      case 'info':
        console.info(logMessage, logData);
        break;
      case 'debug':
        console.debug(logMessage, logData);
        break;
    }
  }

  /**
   * Get log level based on severity
   */
  private static getLogLevel(severity?: string): 'error' | 'warn' | 'info' | 'debug' {
    switch (severity) {
      case 'critical':
      case 'high':
        return 'error';
      case 'medium':
        return 'warn';
      case 'low':
        return 'info';
      default:
        return 'debug';
    }
  }

  /**
   * Cleanup error handling utilities
   */
  public static async destroy(): Promise<void> {
    if (ErrorHandlingUtils.registry) {
      await ErrorHandlingUtils.registry.destroy();
      ErrorHandlingUtils.registry = null;
    }
  }
}

/**
 * Error Context Builder implementation
 */
class ErrorContextBuilderImpl implements ErrorContextBuilder {
  private error: Error;
  private context: string;
  private moduleId: string;
  private options: ErrorHandlingOptions = {};

  constructor(error: Error, context: string, moduleId: string) {
    this.error = error;
    this.context = context;
    this.moduleId = moduleId;
  }

  public withSeverity(severity: 'low' | 'medium' | 'high' | 'critical'): ErrorContextBuilder {
    this.options.severity = severity;
    return this;
  }

  public withCategory(category: string): ErrorContextBuilder {
    this.options.category = category;
    return this;
  }

  public withRecovery(recovery: string): ErrorContextBuilder {
    this.options.recovery = recovery;
    return this;
  }

  public withAdditionalContext(context: Record<string, any>): ErrorContextBuilder {
    this.options.additionalContext = { ...this.options.additionalContext, ...context };
    return this;
  }

  public withSuppressedLogging(): ErrorContextBuilder {
    this.options.suppressLogging = true;
    return this;
  }

  public build(): ErrorContext {
    return {
      error: this.error.message,
      source: `${this.moduleId}.${this.context}`,
      severity: this.options.severity || 'medium',
      timestamp: Date.now(),
      moduleId: this.moduleId,
      context: {
        stack: this.error.stack,
        name: this.error.name,
        ...this.options.additionalContext,
      },
    };
  }
}
