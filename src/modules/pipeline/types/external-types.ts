import type { UnknownObject } from '../../../types/common-types.js';

/**
 * Provider/runtime compatibility shims that are still consumed by the Host
 * dependency surface. This file must not grow generic module, HTTP client,
 * config manager, logger, or dispatch-center abstractions.
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
