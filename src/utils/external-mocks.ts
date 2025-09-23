/**
 * External Dependencies Mock Implementation
 *
 * This file provides mock implementations for external dependencies that are not yet available
 * in the current build environment. These mocks provide the interfaces expected by the
 * debug system and other components.
 */

/**
 * Mock DebugEventBus implementation
 */
export class DebugEventBus {
  private static instance: DebugEventBus;
  private subscribers: Map<string, Function[]> = new Map();

  static getInstance(): DebugEventBus {
    if (!DebugEventBus.instance) {
      DebugEventBus.instance = new DebugEventBus();
    }
    return DebugEventBus.instance;
  }

  subscribe(eventType: string, handler: Function): void {
    if (!this.subscribers.has(eventType)) {
      this.subscribers.set(eventType, []);
    }
    this.subscribers.get(eventType)!.push(handler);
  }

  publish(event: any): void {
    const handlers = this.subscribers.get(event.operationId) || this.subscribers.get('*') || [];
    handlers.forEach(handler => {
      try {
        handler(event);
      } catch (error) {
        console.warn('DebugEventBus handler error:', error);
      }
    });
  }
}

/**
 * Mock ErrorHandlingCenter implementation
 */
export class ErrorHandlingCenter {
  private static instance: ErrorHandlingCenter;

  static getInstance(): ErrorHandlingCenter {
    if (!ErrorHandlingCenter.instance) {
      ErrorHandlingCenter.instance = new ErrorHandlingCenter();
    }
    return ErrorHandlingCenter.instance;
  }

  async handleError(error: any, context?: any): Promise<void> {
    console.error('ErrorHandlingCenter:', error, context);
  }

  createContext(module: string, action: string, data?: any): any {
    return {
      module,
      action,
      data,
      timestamp: Date.now()
    };
  }

  async initialize(): Promise<void> {
    // Initialize error handling center
  }

  async destroy(): Promise<void> {
    // Destroy error handling center
  }

  getStatistics(): any {
    return {
      totalErrors: 0,
      errorByModule: {},
      recentErrors: []
    };
  }
}

/**
 * Mock ErrorHandlerRegistry implementation
 */
export class ErrorHandlerRegistry {
  private static instance: ErrorHandlerRegistry;

  static getInstance(): ErrorHandlerRegistry {
    if (!ErrorHandlerRegistry.instance) {
      ErrorHandlerRegistry.instance = new ErrorHandlerRegistry();
    }
    return ErrorHandlerRegistry.instance;
  }

  async initialize(): Promise<void> {
    // Mock initialization
  }

  async handleError(error: Error, operation: string, moduleId: string, context?: any): Promise<void> {
    console.error(`ErrorHandlerRegistry [${moduleId}:${operation}]:`, error.message, context);
  }
}

// Mock type definitions for compatibility
export interface ErrorContext {
  module?: string;
  action?: string;
  data?: any;
  timestamp?: number;
  error?: Error;
  source?: string;
  severity?: string;
  context?: any;
}

/**
 * Debug event interface (matching external-types.ts)
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

// ErrorContext is already exported above, no need for re-export