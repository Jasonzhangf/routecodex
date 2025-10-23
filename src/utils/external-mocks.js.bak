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
  constructor() {
    this.subscribers = new Map();
  }
  static getInstance() {
    if (!DebugEventBus.instance) {
      DebugEventBus.instance = new DebugEventBus();
    }
    return DebugEventBus.instance;
  }
  subscribe(eventType, handler) {
    if (!this.subscribers.has(eventType)) {
      this.subscribers.set(eventType, []);
    }
    this.subscribers.get(eventType).push(handler);
  }
  publish(event) {
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
  static getInstance() {
    if (!ErrorHandlingCenter.instance) {
      ErrorHandlingCenter.instance = new ErrorHandlingCenter();
    }
    return ErrorHandlingCenter.instance;
  }
  async handleError(error, context) {
    console.error('ErrorHandlingCenter:', error, context);
  }
  createContext(module, action, data) {
    return {
      module,
      action,
      data,
      timestamp: Date.now(),
    };
  }
  async initialize() {
    // Initialize error handling center
  }
  async destroy() {
    // Destroy error handling center
  }
  getStatistics() {
    return {
      totalErrors: 0,
      errorByModule: {},
      recentErrors: [],
    };
  }
}
/**
 * Mock ErrorHandlerRegistry implementation
 */
export class ErrorHandlerRegistry {
  static getInstance() {
    if (!ErrorHandlerRegistry.instance) {
      ErrorHandlerRegistry.instance = new ErrorHandlerRegistry();
    }
    return ErrorHandlerRegistry.instance;
  }
  async initialize() {
    // Mock initialization
  }
  async handleError(error, operation, moduleId, context) {
    console.error(`ErrorHandlerRegistry [${moduleId}:${operation}]:`, error.message, context);
  }
}
/**
 * Mock DebugCenter implementation
 */
export class DebugCenter {
  constructor() {
    this.debugLogs = [];
  }
  static getInstance() {
    if (!DebugCenter.instance) {
      DebugCenter.instance = new DebugCenter();
    }
    return DebugCenter.instance;
  }
  logDebug(module, message, data) {
    const logEntry = {
      timestamp: Date.now(),
      module,
      message,
      data,
      level: 'debug',
    };
    this.debugLogs.push(logEntry);
    console.log(`[DebugCenter] ${module}: ${message}`, data || '');
  }
  logError(module, error, context) {
    const logEntry = {
      timestamp: Date.now(),
      module,
      error: error.message || String(error),
      context,
      level: 'error',
    };
    this.debugLogs.push(logEntry);
    console.error(`[DebugCenter] ${module}:`, error, context || '');
  }
  logModule(module, action, data) {
    const logEntry = {
      timestamp: Date.now(),
      module,
      action,
      data,
      level: 'module',
    };
    this.debugLogs.push(logEntry);
    console.log(`[DebugCenter] ${module}:${action}`, data || '');
  }
  processDebugEvent(event) {
    this.debugLogs.push({
      timestamp: Date.now(),
      event,
      level: 'event',
    });
    console.log('[DebugCenter] Event:', event);
  }
  getLogs(module) {
    if (module) {
      return this.debugLogs.filter(log => log.module === module);
    }
    return [...this.debugLogs];
  }
  clearLogs() {
    this.debugLogs.length = 0;
  }
}
// ErrorContext is already exported above, no need for re-export
