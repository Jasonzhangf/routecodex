import type { UnknownObject } from '../../../types/common-types.js';

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
  getStatus(): unknown;
}

/**
 * Error handling center interface
 */
export interface ErrorHandlingCenter {
  /**
   * Handle error
   */
  handleError(error: unknown, context?: UnknownObject): Promise<void>;
  /**
   * Create error context
   */
  createContext(module: string, action: string, data?: UnknownObject): UnknownObject;
  /**
   * Get error statistics
   */
  getStatistics(): UnknownObject;
}

/**
 * Debug center interface
 */
export interface DebugCenter {
  /**
   * Log debug message
   */
  logDebug(module: string, message: string, data?: UnknownObject): void;
  /**
   * Log error
   */
  logError(module: string, error: unknown, context?: UnknownObject): void;
  /**
   * Log module action
   */
  logModule(module: string, action: string, data?: UnknownObject): void;
  /**
   * Process debug event
   */
  processDebugEvent(event: DebugEvent): void;
  /**
   * Get debug logs
   */
  getLogs(module?: string): DebugEvent[];
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
  data?: UnknownObject;
}

/**
 * HTTP client interface
 */
export interface HttpClient {
  /**
   * Send HTTP request
   */
  request(config: UnknownObject): Promise<UnknownObject>;
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
  get(key: string): unknown;
  /**
   * Set configuration value
   */
  set(key: string, value: unknown): void;
  /**
   * Get all configuration
   */
  getAll(): Record<string, unknown>;
}

/**
 * Logger interface
 */
export interface Logger {
  /**
   * Log info message
   */
  info(message: string, data?: UnknownObject): void;
  /**
   * Log warning message
   */
  warn(message: string, data?: UnknownObject): void;
  /**
   * Log error message
   */
  error(message: string, error?: unknown): void;
  /**
   * Log debug message
   */
  debug(message: string, data?: UnknownObject): void;
}

/**
 * Dispatch center interface
 */
export interface DispatchCenter {
  /**
   * Send notification to dispatch center
   */
  notify(notification: DispatchNotification): Promise<void>;
}

/**
 * Dispatch notification interface
 */
export interface DispatchNotification {
  /** Notification type */
  type: string;
  /** Provider identifier */
  provider?: string;
  /** Notification status */
  status?: string;
  /** Notification details */
  details?: UnknownObject;
  /** Notification timestamp */
  timestamp?: number;
}
