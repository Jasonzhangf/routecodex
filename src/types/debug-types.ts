/**
 * RouteCodex Debugging System Types
 *
 * This file contains comprehensive type definitions for the RouteCodex debugging system,
 * including all interfaces, enums, and structures required for the debugging infrastructure.
 */

import type { DebugEvent } from '../utils/external-mocks.js';

/**
 * Debug system initialization options
 */
export interface DebugSystemOptions {
  /** Enable debugging features */
  enabled?: boolean;
  /** Debug logging level */
  logLevel?: 'none' | 'basic' | 'detailed' | 'verbose';
  /** Maximum number of debug entries to keep */
  maxEntries?: number;
  /** Enable console output */
  enableConsole?: boolean;
  /** Enable file-based logging */
  enableFileLogging?: boolean;
  /** Enable WebSocket server for real-time debugging */
  enableWebSocket?: boolean;
  /** WebSocket port for debugging */
  wsPort?: number;
  /** Enable REST API for debugging */
  enableRestApi?: boolean;
  /** REST API port for debugging */
  restPort?: number;
  /** Enable performance monitoring */
  enablePerformanceMonitoring?: boolean;
  /** Enable memory profiling */
  enableMemoryProfiling?: boolean;
  /** Enable request/response capture */
  enableRequestCapture?: boolean;
  /** Enable error tracking */
  enableErrorTracking?: boolean;
  /** Configuration for debug adapters */
  adapters?: DebugAdapterConfig[];
}

/**
 * Debug adapter configuration
 */
export interface DebugAdapterConfig {
  /** Adapter identifier */
  id: string;
  /** Adapter type */
  type: 'module' | 'server' | 'provider' | 'pipeline' | 'custom';
  /** Adapter class name */
  className: string;
  /** Adapter configuration */
  config?: Record<string, any> & {
    maxHookEntries?: number;
    captureHeaders?: boolean;
    captureBody?: boolean;
    maxRequestBodySize?: number;
    maxResponseBodySize?: number;
    sensitiveHeaders?: string[];
  };
  /** Enable adapter */
  enabled?: boolean;
  /** Adapter priority */
  priority?: number;
}

/**
 * Debug adapter interface
 */
export interface DebugAdapter {
  /** Adapter identifier */
  readonly id: string;
  /** Adapter type */
  readonly type: string;
  /** Adapter version */
  readonly version: string;
  /** Adapter description */
  readonly description: string;
  /** Initialization status */
  readonly isInitialized: boolean;

  /**
   * Initialize the adapter
   */
  initialize(options?: Record<string, any>): Promise<void>;

  /**
   * Start debugging for a specific context
   */
  startDebugging(context: DebugContext): Promise<void>;

  /**
   * Stop debugging for a specific context
   */
  stopDebugging(context: DebugContext): Promise<void>;

  /**
   * Get debug data for a specific context
   */
  getDebugData(context: DebugContext): Promise<DebugData>;

  /**
   * Get adapter health status
   */
  getHealth(): DebugAdapterHealth;

  /**
   * Get adapter statistics
   */
  getStats(): DebugAdapterStats;

  /**
   * Configure the adapter
   */
  configure(config: Record<string, any>): Promise<void>;

  /**
   * Cleanup adapter resources
   */
  destroy(): Promise<void>;
}

/**
 * Debug context information
 */
export interface DebugContext {
  /** Context identifier */
  id: string;
  /** Context type */
  type: 'request' | 'response' | 'pipeline' | 'module' | 'provider' | 'server' | 'session';
  /** Associated session ID */
  sessionId?: string;
  /** Associated request ID */
  requestId?: string;
  /** Associated pipeline ID */
  pipelineId?: string;
  /** Associated module ID */
  moduleId?: string;
  /** Context metadata */
  metadata?: Record<string, any>;
  /** Timestamp */
  timestamp?: number;
}

/**
 * Debug data container
 */
export interface DebugData {
  /** Data identifier */
  id: string;
  /** Context information */
  context: DebugContext;
  /** Data type */
  type: 'metrics' | 'logs' | 'events' | 'errors' | 'performance' | 'memory' | 'custom';
  /** Data content */
  content: any;
  /** Data timestamp */
  timestamp: number;
  /** Data metadata */
  metadata?: Record<string, any>;
}

/**
 * Debug adapter health status
 */
export interface DebugAdapterHealth {
  /** Health status */
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  /** Last check timestamp */
  lastCheck: number;
  /** Health score (0-100) */
  score: number;
  /** Health issues */
  issues: DebugHealthIssue[];
}

/**
 * Health issue information
 */
export interface DebugHealthIssue {
  /** Issue identifier */
  id: string;
  /** Issue severity */
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** Issue type */
  type: 'performance' | 'memory' | 'connection' | 'configuration' | 'custom';
  /** Issue description */
  description: string;
  /** Issue timestamp */
  timestamp: number;
  /** Recommended action */
  recommendedAction?: string;
}

/**
 * Debug adapter statistics
 */
export interface DebugAdapterStats {
  /** Total debug sessions */
  totalSessions: number;
  /** Active debug sessions */
  activeSessions: number;
  /** Total events captured */
  totalEvents: number;
  /** Total errors captured */
  totalErrors: number;
  /** Average processing time */
  avgProcessingTime: number;
  /** Memory usage */
  memoryUsage: {
    used: number;
    total: number;
    percentage: number;
  };
  /** Performance metrics */
  performance: {
    avgResponseTime: number;
    maxResponseTime: number;
    minResponseTime: number;
    throughput: number;
  };
  /** Custom metrics */
  custom?: Record<string, number>;
}

/**
 * Module debug adapter interface
 */
export interface ModuleDebugAdapter extends DebugAdapter {
  /** Module information */
  readonly moduleInfo: {
    id: string;
    name: string;
    version: string;
    type: string;
  };

  /**
   * Hook into module method execution
   */
  hookMethod(methodName: string, options: MethodHookOptions): Promise<void>;

  /**
   * Unhook from module method execution
   */
  unhookMethod(methodName: string): Promise<void>;

  /**
   * Get module-specific debug data
   */
  getModuleDebugData(): Promise<ModuleDebugData>;
}

/**
 * Method hook options
 */
export interface MethodHookOptions {
  /** Enable timing capture */
  enableTiming?: boolean;
  /** Enable parameter capture */
  enableParams?: boolean;
  /** Enable result capture */
  enableResult?: boolean;
  /** Enable error capture */
  enableErrors?: boolean;
  /** Capture depth */
  captureDepth?: number;
  /** Filter function */
  filter?: (data: MethodHookData) => boolean;
}

/**
 * Method hook data
 */
export interface MethodHookData {
  /** Method name */
  methodName: string;
  /** Method parameters */
  params?: any[];
  /** Method result */
  result?: any;
  /** Method error */
  error?: Error;
  /** Execution time */
  executionTime: number;
  /** Timestamp */
  timestamp: number;
  /** Call stack */
  callStack?: string[];
  /** Metadata */
  metadata?: Record<string, any>;
}

/**
 * Module debug data
 */
export interface ModuleDebugData extends DebugData {
  /** Module information */
  moduleInfo: {
    id: string;
    name: string;
    version: string;
    type: string;
  };
  /** Method hooks data */
  methodHooks: MethodHookData[];
  /** Module state */
  state?: Record<string, any>;
  /** Module events */
  events: DebugEvent[];
  /** Module errors */
  errors: any[];
  /** Content data (for compatibility) - overrides DebugData.content */
  content: {
    moduleInfo: {
      id: string;
      name: string;
      version: string;
      type: string;
    };
    methodHooks: MethodHookData[];
    state?: Record<string, any>;
    events: DebugEvent[];
    errors: any[];
  };
}

/**
 * HTTP server debug adapter interface
 */
export interface HttpServerDebugAdapter extends DebugAdapter {
  /** Server information */
  readonly serverInfo: {
    host: string;
    port: number;
    protocol: string;
  };

  /**
   * Capture HTTP request
   */
  captureRequest(request: DebugHttpRequest): Promise<void>;

  /**
   * Capture HTTP response
   */
  captureResponse(response: DebugHttpResponse): Promise<void>;

  /**
   * Get request/response data
   */
  getHttpRequestData(requestId: string): Promise<HttpDebugData>;
}

/**
 * Debug HTTP request
 */
export interface DebugHttpRequest {
  /** Request identifier */
  id: string;
  /** HTTP method */
  method: string;
  /** Request URL */
  url: string;
  /** Request headers */
  headers: Record<string, string>;
  /** Request body */
  body?: any;
  /** Request parameters */
  params?: Record<string, string>;
  /** Request query */
  query?: Record<string, string>;
  /** Timestamp */
  timestamp: number;
  /** Request metadata */
  metadata?: Record<string, any>;
}

/**
 * Debug HTTP response
 */
export interface DebugHttpResponse {
  /** Request identifier */
  requestId: string;
  /** Response status */
  status: number;
  /** Response headers */
  headers: Record<string, string>;
  /** Response body */
  body?: any;
  /** Response time */
  responseTime: number;
  /** Timestamp */
  timestamp: number;
  /** Response metadata */
  metadata?: Record<string, any>;
}

/**
 * HTTP debug data
 */
export interface HttpDebugData extends DebugData {
  /** HTTP request */
  request: DebugHttpRequest;
  /** HTTP response */
  response?: DebugHttpResponse;
  /** Request lifecycle events */
  events: DebugEvent[];
  /** Performance metrics */
  performance: {
    totalProcessingTime: number;
    serverProcessingTime: number;
    networkTime: number;
  };
  /** Content data (for compatibility) - overrides DebugData.content */
  content: {
    request: DebugHttpRequest;
    response?: DebugHttpResponse;
    events: DebugEvent[];
    performance: {
      totalProcessingTime: number;
      serverProcessingTime: number;
      networkTime: number;
    };
  };
}

/**
 * Debug API extension interface
 */
export interface DebugAPIExtension {
  /** Extension identifier */
  readonly id: string;
  /** Extension version */
  readonly version: string;
  /** Extension description */
  readonly description: string;

  /**
   * Initialize the extension
   */
  initialize(options?: Record<string, any>): Promise<void>;

  /**
   * Register debug endpoints
   */
  registerEndpoints(): Promise<void>;

  /**
   * Handle debug API request
   */
  handleRequest(request: DebugAPIRequest): Promise<DebugAPIResponse>;

  /**
   * Get extension health
   */
  getHealth(): DebugExtensionHealth;

  /**
   * Cleanup extension resources
   */
  destroy(): Promise<void>;
}

/**
 * Debug API request
 */
export interface DebugAPIRequest {
  /** Request identifier */
  id: string;
  /** Request path */
  path: string;
  /** HTTP method */
  method: string;
  /** Request headers */
  headers: Record<string, string>;
  /** Request body */
  body?: any;
  /** Request parameters */
  params?: Record<string, string>;
  /** Query parameters */
  query?: Record<string, string>;
  /** Timestamp */
  timestamp: number;
}

/**
 * Debug API response
 */
export interface DebugAPIResponse {
  /** Request identifier */
  requestId: string;
  /** Response status */
  status: number;
  /** Response headers */
  headers: Record<string, string>;
  /** Response body */
  body?: any;
  /** Response metadata */
  metadata?: Record<string, any>;
  /** Processing time */
  processingTime: number;
  /** Timestamp */
  timestamp: number;
}

/**
 * Debug extension health
 */
export interface DebugExtensionHealth {
  /** Health status */
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  /** Last check timestamp */
  lastCheck: number;
  /** Health score (0-100) */
  score: number;
  /** Active connections */
  activeConnections: number;
  /** Total requests handled */
  totalRequests: number;
  /** Error rate */
  errorRate: number;
  /** Average response time */
  avgResponseTime: number;
}

/**
 * WebSocket debug server interface
 */
export interface WebSocketDebugServer {
  /** Server identifier */
  readonly id: string;
  /** Server version */
  readonly version: string;
  /** Server information */
  readonly serverInfo: {
    host: string;
    port: number;
    path: string;
  };

  /**
   * Start the WebSocket server
   */
  start(): Promise<void>;

  /**
   * Stop the WebSocket server
   */
  stop(): Promise<void>;

  /**
   * Send debug event to connected clients
   */
  sendEvent(event: DebugWebSocketEvent): Promise<void>;

  /**
   * Broadcast message to all clients
   */
  broadcast(message: DebugWebSocketMessage): Promise<void>;

  /**
   * Get server statistics
   */
  getStats(): WebSocketServerStats;

  /**
   * Get server health
   */
  getHealth(): WebSocketServerHealth;
}

/**
 * Debug WebSocket event
 */
export interface DebugWebSocketEvent {
  /** Event identifier */
  id: string;
  /** Event type */
  type: 'debug' | 'log' | 'error' | 'performance' | 'system';
  /** Event data */
  data: any;
  /** Timestamp */
  timestamp: number;
  /** Event metadata */
  metadata?: Record<string, any>;
}

/**
 * Debug WebSocket message
 */
export interface DebugWebSocketMessage {
  /** Message identifier */
  id: string;
  /** Message type */
  type: 'event' | 'command' | 'response' | 'heartbeat' | 'subscription' | 'system' | 'error';
  /** Message data */
  data: any;
  /** Timestamp */
  timestamp: number;
  /** Target client ID (optional) */
  clientId?: string;
}

/**
 * WebSocket server statistics
 */
export interface WebSocketServerStats {
  /** Total connections */
  totalConnections: number;
  /** Active connections */
  activeConnections: number;
  /** Total messages sent */
  totalMessagesSent: number;
  /** Total messages received */
  totalMessagesReceived: number;
  /** Average message size */
  avgMessageSize: number;
  /** Uptime */
  uptime: number;
  /** Bandwidth usage */
  bandwidth: {
    sent: number;
    received: number;
  };
}

/**
 * WebSocket server health
 */
export interface WebSocketServerHealth {
  /** Health status */
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  /** Last check timestamp */
  lastCheck: number;
  /** Health score (0-100) */
  score: number;
  /** Health issues */
  issues: DebugHealthIssue[];
}

/**
 * Debug utility functions interface
 */
export interface DebugUtils {
  /**
   * Sanitize data for logging (remove sensitive information)
   */
  sanitizeData(data: any, options?: SanitizeOptions): any;

  /**
   * Format data for display
   */
  formatData(data: any, options?: FormatOptions): string;

  /**
   * Calculate data size
   */
  calculateDataSize(data: any): number;

  /**
   * Deep clone data
   */
  deepClone<T>(data: T): T;

  /**
   * Generate unique identifier
   */
  generateId(prefix?: string): string;

  /**
   * Measure execution time
   */
  measureTime<T>(fn: () => T): { result: T; time: number };

  /**
   * Measure async execution time
   */
  measureTimeAsync<T>(fn: () => Promise<T>): Promise<{ result: T; time: number }>;

  /**
   * Create performance marker
   */
  createPerformanceMarker(name: string): PerformanceMarker;
}

/**
 * Sanitize options
 */
export interface SanitizeOptions {
  /** Fields to redact */
  redactFields?: string[];
  /** Maximum depth */
  maxDepth?: number;
  /** Maximum string length */
  maxStringLength?: number;
  /** Maximum array length */
  maxArrayLength?: number;
  /** Custom sanitizer function */
  customSanitizer?: (data: any) => any;
}

/**
 * Format options
 */
export interface FormatOptions {
  /** Output format */
  format?: 'json' | 'pretty' | 'compact' | 'custom';
  /** Indentation level */
  indent?: number;
  /** Custom formatter function */
  customFormatter?: (data: any) => string;
}

/**
 * Performance marker interface
 */
export interface PerformanceMarker {
  /** Marker name */
  name: string;
  /** Start timestamp */
  startTime: number;
  /** End timestamp */
  endTime?: number;
  /** Duration */
  duration?: number;

  /**
   * Stop the marker and return duration
   */
  stop(): number;

  /**
   * Get current duration
   */
  getDuration(): number;
}

/**
 * Debug configuration interface
 */
export interface DebugConfiguration {
  /** Global debug settings */
  global: {
    enabled: boolean;
    logLevel: 'none' | 'basic' | 'detailed' | 'verbose';
    maxEntries: number;
    enableConsole: boolean;
    enableFileLogging: boolean;
    enableWebSocket: boolean;
    enableRestApi: boolean;
    wsPort: number;
    restPort: number;
    enablePerformanceMonitoring: boolean;
    enableMemoryProfiling: boolean;
    enableRequestCapture: boolean;
    enableErrorTracking: boolean;
  };
  /** Adapter configurations */
  adapters: DebugAdapterConfig[];
  /** WebSocket configuration */
  websocket: {
    host: string;
    port: number;
    path: string;
    maxConnections: number;
    enableCompression: boolean;
    enableHeartbeat: boolean;
    heartbeatInterval: number;
  };
  /** REST API configuration */
  restApi: {
    host: string;
    port: number;
    path: string;
    enableCors: boolean;
    enableAuth: boolean;
    authProvider?: string;
  };
  /** File logging configuration */
  fileLogging: {
    enabled: boolean;
    logDirectory: string;
    maxFileSize: number;
    maxFiles: number;
    rotateInterval: string;
  };
  /** Performance monitoring configuration */
  performance: {
    enabled: boolean;
    samplingRate: number;
    maxSamples: number;
    reportInterval: number;
  };
  /** Memory profiling configuration */
  memory: {
    enabled: boolean;
    samplingRate: number;
    maxSamples: number;
    reportInterval: number;
  };
}

/**
 * Debug system events
 */
export enum DebugSystemEvent {
  /** System initialized */
  INITIALIZED = 'debug_system_initialized',
  /** System started */
  STARTED = 'debug_system_started',
  /** System stopped */
  STOPPED = 'debug_system_stopped',
  /** System error */
  ERROR = 'debug_system_error',
  /** Adapter registered */
  ADAPTER_REGISTERED = 'debug_adapter_registered',
  /** Adapter initialized */
  ADAPTER_INITIALIZED = 'debug_adapter_initialized',
  /** Adapter destroyed */
  ADAPTER_DESTROYED = 'debug_adapter_destroyed',
  /** Debug session started */
  SESSION_STARTED = 'debug_session_started',
  /** Debug session ended */
  SESSION_ENDED = 'debug_session_ended',
  /** Data captured */
  DATA_CAPTURED = 'debug_data_captured',
  /** Performance data updated */
  PERFORMANCE_UPDATED = 'debug_performance_updated',
  /** Health check completed */
  HEALTH_CHECK_COMPLETED = 'debug_health_check_completed',
  /** Adapter configured */
  ADAPTER_CONFIGURED = 'debug_adapter_configured',
  /** Health issue detected */
  HEALTH_ISSUE_DETECTED = 'debug_health_issue_detected',
  /** System error occurred */
  SYSTEM_ERROR = 'debug_system_error',
  /** HTTP server debug adapter initialized */
  HTTP_SERVER_DEBUG_ADAPTER_INITIALIZED = 'http_server_debug_adapter_initialized',
  /** HTTP server debugging started */
  HTTP_SERVER_DEBUGGING_STARTED = 'http_server_debugging_started',
  /** HTTP server debugging stopped */
  HTTP_SERVER_DEBUGGING_STOPPED = 'http_server_debugging_stopped',
  /** HTTP server debug adapter destroyed */
  HTTP_SERVER_DEBUG_ADAPTER_DESTROYED = 'http_server_debug_adapter_destroyed',
  /** HTTP request captured */
  HTTP_REQUEST_CAPTURED = 'http_request_captured',
  /** HTTP response captured */
  HTTP_RESPONSE_CAPTURED = 'http_response_captured',
  /** HTTP server state captured */
  HTTP_SERVER_STATE_CAPTURED = 'http_server_state_captured',
  /** HTTP server configuration updated */
  HTTP_SERVER_CONFIG_UPDATED = 'http_server_config_updated',
  /** Module debug adapter initialized */
  MODULE_DEBUG_ADAPTER_INITIALIZED = 'module_debug_adapter_initialized',
  /** Module debugging started */
  MODULE_DEBUGGING_STARTED = 'module_debugging_started',
  /** Module debugging stopped */
  MODULE_DEBUGGING_STOPPED = 'module_debugging_stopped',
  /** Module debug adapter destroyed */
  MODULE_DEBUG_ADAPTER_DESTROYED = 'module_debug_adapter_destroyed',
  /** Method hook registered */
  METHOD_HOOK_REGISTERED = 'method_hook_registered',
  /** Method hook removed */
  METHOD_HOOK_REMOVED = 'method_hook_removed',
  /** Module state captured */
  MODULE_STATE_CAPTURED = 'module_state_captured',
  /** Method hook executed */
  METHOD_HOOK_EXECUTED = 'method_hook_executed'
}

/**
 * Debug system health status
 */
export interface DebugSystemHealth {
  /** Overall health status */
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  /** Last check timestamp */
  lastCheck: number;
  /** Health score (0-100) */
  score: number;
  /** System components health */
  components: {
    adapters: DebugAdapterHealth[];
    websocket?: WebSocketServerHealth;
    restApi?: DebugExtensionHealth;
  };
  /** System issues */
  issues: DebugHealthIssue[];
  /** System metrics */
  metrics: {
    uptime: number;
    totalSessions: number;
    activeSessions: number;
    totalEvents: number;
    totalErrors: number;
    memoryUsage: {
      used: number;
      total: number;
      percentage: number;
    };
  };
}