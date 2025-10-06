/**
 * Error Handler Registry
 * Central registry for error messages and handling functions
 * Provides standardized error handling across all modules
 */

// Import error handling components with proper type handling
import * as debugcenter from 'rcc-debugcenter';
import * as errorhandling from 'rcc-errorhandling';

// Check if ErrorHandlingCenter exists, fallback to mock if not
const EHC: any = (errorhandling as any).ErrorHandlingCenter as (new () => {
  initialize: () => Promise<void>;
  handleError: (ctx?: unknown) => Promise<void>;
  destroy: () => Promise<void>;
}) | undefined;
const ErrorHandlingCenterClass: new () => {
  initialize: () => Promise<void>;
  handleError: (ctx?: unknown) => Promise<void>;
  destroy: () => Promise<void>;
} = EHC ??
  class {
    async initialize() {/* noop */}
    async handleError() {/* noop */}
    async destroy() {/* noop */}
  };

// Check if DebugEventBus exists, fallback to mock if not
const DEB: any = (debugcenter as any).DebugEventBus as { getInstance: () => { publish: (evt: unknown) => void } } | undefined;
const DebugEventBusClass: { getInstance: () => { publish: (evt: unknown) => void } } =
  DEB ?? { getInstance: () => ({ publish: (_evt: unknown) => {} }) };

// Define ErrorContext interface locally
interface ErrorContext {
  error: unknown;
  source: string;
  severity: string;
  timestamp: number;
  module?: string;
  context: unknown;
}

/**
 * Error handler function type
 */
export type ErrorHandlerFunction = (context: ErrorContext) => Promise<void>;

/**
 * Error message template interface
 */
export interface ErrorMessageTemplate {
  code: string;
  message: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  category: string;
  description?: string;
  recovery?: string;
}

/**
 * Error handler registration interface
 */
export interface ErrorHandlerRegistration {
  errorCode: string;
  handler: ErrorHandlerFunction;
  priority: number;
  description?: string;
}

/**
 * Error Handler Registry class
 * Centralized error handling system with registered handlers and message templates
 */
export class ErrorHandlerRegistry {
  private static instance: ErrorHandlerRegistry;
  private errorHandlingCenter: unknown;
  private debugEventBus: unknown;
  private messageTemplates: Map<string, ErrorMessageTemplate> = new Map();
  private errorHandlers: Map<string, ErrorHandlerFunction[]> = new Map();
  private initialized: boolean = false;

  private constructor() {
    this.errorHandlingCenter = new ErrorHandlingCenterClass();
    this.debugEventBus = DebugEventBusClass.getInstance();
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): ErrorHandlerRegistry {
    if (!ErrorHandlerRegistry.instance) {
      ErrorHandlerRegistry.instance = new ErrorHandlerRegistry();
    }
    return ErrorHandlerRegistry.instance;
  }

  /**
   * Initialize the error handler registry
   */
  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      await (this.errorHandlingCenter as { initialize: () => Promise<void> }).initialize();
      await this.registerDefaultErrorMessages();
      await this.registerDefaultErrorHandlers();

      this.initialized = true;

      (this.debugEventBus as { publish: (evt: unknown) => void }).publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'error-handler-registry',
        operationId: 'error_handler_registry_initialized',
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          messageTemplateCount: this.messageTemplates.size,
          handlerCount: this.errorHandlers.size,
        },
      });
    } catch (error) {
      console.error('Failed to initialize Error Handler Registry:', error);
      throw error;
    }
  }

  /**
   * Register error message template
   */
  public registerErrorMessage(template: ErrorMessageTemplate): void {
    // Check if already registered to avoid duplicates
    if (this.messageTemplates.has(template.code)) {
      return;
    }
    
    this.messageTemplates.set(template.code, template);

    // Only publish debug events during normal operation (not during initialization)
    if (this.initialized) {
      (this.debugEventBus as { publish: (evt: unknown) => void }).publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'error-handler-registry',
        operationId: 'error_message_registered',
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          errorCode: template.code,
          severity: template.severity,
          category: template.category,
        },
      });
    }
  }

  /**
   * Register error handler function
   */
  public registerErrorHandler(registration: ErrorHandlerRegistration): void {
    if (!this.errorHandlers.has(registration.errorCode)) {
      this.errorHandlers.set(registration.errorCode, []);
    }

    const handlers = this.errorHandlers.get(registration.errorCode)!;
    
    // Check if this handler is already registered to avoid duplicates
    const existingHandlerIndex = handlers.findIndex(h => h === registration.handler);
    if (existingHandlerIndex !== -1) {
      return;
    }
    
    handlers.push(registration.handler);

    // Sort by priority (lower number = higher priority)
    handlers.sort((a, b) => {
      const priorityA = (a as unknown as { _priority?: number })._priority || 0;
      const priorityB = (b as unknown as { _priority?: number })._priority || 0;
      return priorityA - priorityB;
    });

    // Store priority on handler for future sorting
    (registration.handler as unknown as { _priority?: number })._priority = registration.priority;

    // Only publish debug events during normal operation (not during initialization)
    if (this.initialized) {
      (this.debugEventBus as { publish: (evt: unknown) => void }).publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'error-handler-registry',
        operationId: 'error_handler_registered',
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          errorCode: registration.errorCode,
          priority: registration.priority,
          description: registration.description,
        },
      });
    }
  }

  /**
   * Handle error with registered handlers
   */
  public async handleError(
    error: Error,
    context: string,
    moduleId: string,
    additionalContext?: Record<string, unknown>
  ): Promise<void> {
    try {
      // Get error message template
      const template = this.getErrorMessageTemplate(error, context);

      // Create error context
      const errorContext: ErrorContext = {
        error: error,
        source: `${moduleId}.${context}`,
        severity: template.severity,
        timestamp: Date.now(),
        module: moduleId,
        context: {
          ...additionalContext,
          stack: error.stack,
          name: error.name,
          errorCode: template.code,
          errorCategory: template.category,
          errorDescription: template.description,
          recovery: template.recovery,
        },
      };

      // Use ErrorHandlingCenter for base error handling
      await (this.errorHandlingCenter as { handleError: (ctx: unknown) => Promise<void> }).handleError(errorContext);

      // Execute registered error handlers
      await this.executeErrorHandlers(template.code, errorContext);
    } catch (handlerError) {
      console.error('Failed to handle error:', handlerError);
      console.error('Original error:', error);
    }
  }

  /**
   * Get error message template for error
   */
  private getErrorMessageTemplate(error: Error, context: string): ErrorMessageTemplate {
    // Try to find specific error template based on error type or message
    const errorType = error.constructor.name;
    const errorCode = this.generateErrorCode(errorType, context);

    let template = this.messageTemplates.get(errorCode);

    if (!template) {
      // Try to find template by error type
      for (const [code, tmpl] of this.messageTemplates.entries()) {
        if (code.includes(errorType.toLowerCase()) || code.includes(context.toLowerCase())) {
          template = tmpl;
          break;
        }
      }
    }

    // Default template if no specific template found
    if (!template) {
      template = {
        code: errorCode,
        message: error.message,
        severity: 'medium' as const,
        category: 'general',
        description: 'General error occurred',
        recovery: 'Retry the operation or contact support',
      };
    }

    return template;
  }

  /**
   * Generate error code based on error type and context
   */
  private generateErrorCode(errorType: string, context: string): string {
    return `${errorType.toLowerCase()}_${context.toLowerCase()}`.replace(/\s+/g, '_');
  }

  /**
   * Execute registered error handlers for specific error code
   */
  private async executeErrorHandlers(errorCode: string, errorContext: ErrorContext): Promise<void> {
    const handlers = this.errorHandlers.get(errorCode);

    if (!handlers || handlers.length === 0) {
      return;
    }

    for (const handler of handlers) {
      try {
        await handler(errorContext);
      } catch (handlerError) {
        console.error(`Error handler failed for error code ${errorCode}:`, handlerError);
      }
    }
  }

  /**
   * Register default error messages
   */
  private async registerDefaultErrorMessages(): Promise<void> {
    const defaultTemplates: ErrorMessageTemplate[] = [
      {
        code: 'sandbox_error',
        message: 'Sandbox or permission policy denied the operation',
        severity: 'high',
        category: 'sandbox',
        description: 'The runtime sandbox (OS or policy) blocked this action (e.g., EPERM/EACCES, MacOS Seatbelt).',
        recovery: 'Grant required permissions, relax sandbox, or avoid restricted operations',
      },
      {
        code: 'validation_error',
        message: 'Request validation failed',
        severity: 'medium',
        category: 'validation',
        description: 'The incoming request failed validation',
        recovery: 'Check request parameters and format',
      },
      {
        code: 'authentication_error',
        message: 'Authentication failed',
        severity: 'high',
        category: 'security',
        description: 'Authentication or authorization failed',
        recovery: 'Check credentials and permissions',
      },
      {
        code: 'provider_error',
        message: 'Provider error occurred',
        severity: 'medium',
        category: 'provider',
        description: 'AI provider returned an error',
        recovery: 'Retry with different parameters or provider',
      },
      {
        code: 'network_error',
        message: 'Network connectivity error',
        severity: 'medium',
        category: 'network',
        description: 'Failed to connect to external service',
        recovery: 'Check network connection and retry',
      },
      {
        code: 'timeout_error',
        message: 'Request timeout',
        severity: 'medium',
        category: 'performance',
        description: 'Request exceeded time limit',
        recovery: 'Increase timeout or optimize request',
      },
      {
        code: 'rate_limit_error',
        message: 'Rate limit exceeded',
        severity: 'medium',
        category: 'performance',
        description: 'Too many requests in time period',
        recovery: 'Wait and retry with lower frequency',
      },
      {
        code: 'configuration_error',
        message: 'Configuration error',
        severity: 'high',
        category: 'configuration',
        description: 'Invalid or missing configuration',
        recovery: 'Check configuration files and environment',
      },
      {
        code: 'initialization_error',
        message: 'Service initialization failed',
        severity: 'critical',
        category: 'system',
        description: 'Failed to initialize required service',
        recovery: 'Check logs and restart service',
      },
      {
        code: 'not_implemented_error',
        message: 'Feature not implemented',
        severity: 'low',
        category: 'development',
        description: 'Requested feature is not yet implemented',
        recovery: 'Use different approach or wait for implementation',
      },
    ];

    for (const template of defaultTemplates) {
      this.registerErrorMessage(template);
    }
  }

  /**
   * Register default error handlers
   */
  private async registerDefaultErrorHandlers(): Promise<void> {
    // Log error handler
    this.registerErrorHandler({
      errorCode: 'validation_error',
      handler: async (context: ErrorContext) => {
        console.warn(`Validation Error in ${context.source}: ${context.error}`);
      },
      priority: 1,
      description: 'Log validation errors',
    });

    // Network error handler
    this.registerErrorHandler({
      errorCode: 'network_error',
      handler: async (context: ErrorContext) => {
        console.error(`Network Error in ${context.source}: ${context.error}`);
        // Could implement automatic retry logic here
      },
      priority: 1,
      description: 'Handle network connectivity errors',
    });

    // Provider error handler
    this.registerErrorHandler({
      errorCode: 'provider_error',
      handler: async (context: ErrorContext) => {
        console.error(`Provider Error in ${context.source}: ${context.error}`);
        // Could implement provider failover logic here
      },
      priority: 2,
      description: 'Handle AI provider errors',
    });

    // Critical error handler
    this.registerErrorHandler({
      errorCode: 'initialization_error',
      handler: async (context: ErrorContext) => {
        console.error(`Critical Error in ${context.source}: ${context.error}`);
        // Could implement service restart logic here
      },
      priority: 0,
      description: 'Handle critical system errors',
    });
  }

  /**
   * Get all registered error message templates
   */
  public getRegisteredMessages(): ErrorMessageTemplate[] {
    return Array.from(this.messageTemplates.values());
  }

  /**
   * Get registered handlers for specific error code
   */
  public getRegisteredHandlers(errorCode: string): ErrorHandlerFunction[] {
    return this.errorHandlers.get(errorCode) || [];
  }

  /**
   * Destroy registry and cleanup resources
   */
  public async destroy(): Promise<void> {
    try {
      this.messageTemplates.clear();
      this.errorHandlers.clear();
      await (this.errorHandlingCenter as { destroy: () => Promise<void> }).destroy();
      this.initialized = false;

      (this.debugEventBus as { publish: (evt: unknown) => void }).publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'error-handler-registry',
        operationId: 'error_handler_registry_destroyed',
        timestamp: Date.now(),
        type: 'end',
        position: 'middle',
        data: {},
      });
    } catch (error) {
      console.error('Failed to destroy Error Handler Registry:', error);
    }
  }
}
