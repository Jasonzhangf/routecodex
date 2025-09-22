/**
 * Mock types for external dependencies
 *
 * This file provides temporary type definitions for modules that are not yet available
 * in the current build environment. These should be replaced with actual imports
 * when the corresponding modules are implemented.
 */

/**
 * Base module interface for RCC modules
 */
export interface RCCBaseModule {
  /** Module identifier */
  readonly id: string;
  /** Module type */
  readonly type: string;
  /** Module version */
  readonly version: string;
  /**
   * Initialize the module
   */
  initialize(): Promise<void>;
  /**
   * Clean up resources
   */
  cleanup(): Promise<void>;
  /**
   * Get module status
   */
  getStatus(): any;
}

/**
 * Error handling center interface
 */
export interface ErrorHandlingCenter {
  /**
   * Handle error
   */
  handleError(error: any, context?: any): Promise<void>;
  /**
   * Create error context
   */
  createContext(module: string, action: string, data?: any): any;
  /**
   * Get error statistics
   */
  getStatistics(): any;
}

/**
 * Debug center interface
 */
export interface DebugCenter {
  /**
   * Log debug message
   */
  logDebug(module: string, message: string, data?: any): void;
  /**
   * Log error
   */
  logError(module: string, error: any, context?: any): void;
  /**
   * Log module action
   */
  logModule(module: string, action: string, data?: any): void;
  /**
   * Process debug event
   */
  processDebugEvent(event: DebugEvent): void;
  /**
   * Get debug logs
   */
  getLogs(module?: string): any[];
}

/**
 * Debug event interface
 */
export interface DebugEvent {
  /** Session identifier */
  sessionId?: string;
  /** Module identifier */
  moduleId: string;
  /** Operation identifier */
  operationId: string;
  /** Event timestamp */
  timestamp: number;
  /** Event type */
  type: 'start' | 'end' | 'error';
  /** Event position */
  position: 'start' | 'middle' | 'end';
  /** Event data */
  data?: any;
}

/**
 * HTTP client interface
 */
export interface HttpClient {
  /**
   * Send HTTP request
   */
  request(config: any): Promise<any>;
  /**
   * Set default headers
   */
  setHeaders(headers: Record<string, string>): void;
  /**
   * Set timeout
   */
  setTimeout(timeout: number): void;
}

/**
 * Configuration manager interface
 */
export interface ConfigManager {
  /**
   * Get configuration value
   */
  get(key: string): any;
  /**
   * Set configuration value
   */
  set(key: string, value: any): void;
  /**
   * Get all configuration
   */
  getAll(): Record<string, any>;
}

/**
 * Logger interface
 */
export interface Logger {
  /**
   * Log info message
   */
  info(message: string, data?: any): void;
  /**
   * Log warning message
   */
  warn(message: string, data?: any): void;
  /**
   * Log error message
   */
  error(message: string, error?: any): void;
  /**
   * Log debug message
   */
  debug(message: string, data?: any): void;
}