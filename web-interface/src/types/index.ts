/**
 * RouteCodex Debug Interface Types
 */

export interface DebugEvent {
  id: string;
  type: 'debug' | 'log' | 'error' | 'performance' | 'system';
  timestamp: number;
  moduleId?: string;
  operationId?: string;
  sessionId?: string;
  data: any;
  metadata?: Record<string, any>;
}

export interface ModuleStatus {
  id: string;
  moduleId?: string;
  name: string;
  type: 'module' | 'server' | 'provider' | 'pipeline';
  status: 'healthy' | 'warning' | 'error' | 'unknown';
  healthScore: number;
  uptime: number;
  lastActivity: number;
  metrics: {
    totalRequests: number;
    errorRate: number;
    avgResponseTime: number;
    memoryUsage: number;
  };
  events: DebugEvent[];
}

export interface PerformanceMetrics {
  timestamp: number;
  responseTime: number;
  throughput: number;
  memoryUsage: number;
  cpuUsage: number;
  errorRate: number;
}

export interface SystemHealth {
  status: 'healthy' | 'warning' | 'error' | 'unknown';
  score: number;
  uptime: number;
  totalEvents: number;
  totalErrors: number;
  modules: ModuleStatus[];
  performance: {
    avgResponseTime: number;
    maxResponseTime: number;
    minResponseTime: number;
    throughput: number;
  };
  memory: {
    used: number;
    total: number;
    percentage: number;
  };
}

export interface WebSocketMessage {
  id: string;
  type: 'event' | 'status' | 'metrics' | 'health' | 'command' | 'response';
  timestamp: number;
  data: any;
}

export interface DebugConfig {
  websocket: {
    url: string;
    reconnectInterval: number;
    maxReconnectAttempts: number;
  };
  api: {
    baseUrl: string;
    timeout: number;
  };
  ui: {
    refreshInterval: number;
    maxEvents: number;
    theme: 'light' | 'dark' | 'auto';
  };
}

export interface EventFilter {
  type?: string[];
  moduleId?: string[];
  timeRange?: {
    start: number;
    end: number;
  };
  search?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
}

export interface ModuleDetails {
  id: string;
  name: string;
  type: string;
  version: string;
  description: string;
  status: 'healthy' | 'warning' | 'error' | 'unknown';
  healthScore: number;
  config: Record<string, any>;
  metrics: {
    totalRequests: number;
    errorRate: number;
    avgResponseTime: number;
    memoryUsage: number;
    uptime: number;
  };
  recentEvents: DebugEvent[];
  performance: PerformanceMetrics[];
}

// Dynamic Routing Types
export interface RoutingConfig {
  version: string;
  virtualrouter: {
    inputProtocol: string;
    outputProtocol: string;
    providers: Record<string, RoutingProvider>;
    routing: Record<string, string[]>;
  };
  httpserver: {
    port: number;
    host: string;
  };
}

export interface RoutingProvider {
  type: string;
  baseURL: string;
  apiKey: string[];
  models: Record<string, RoutingModel>;
}

export interface RoutingModel {
  maxContext: number;
  maxTokens: number;
  compatibility?: {
    type: string;
    config: Record<string, any>;
  };
}

export interface RoutingRule {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  priority: number;
  conditions: RoutingCondition[];
  actions: RoutingAction[];
  createdAt: number;
  updatedAt: number;
  stats?: {
    totalMatches: number;
    totalExecutions: number;
    successRate: number;
    avgExecutionTime: number;
  };
}

export interface RoutingCondition {
  type: 'model' | 'token_count' | 'content_type' | 'tool_type' | 'custom' | 'endpoint' | 'protocol';
  operator: 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'greater_than' | 'less_than' | 'in' | 'not_in' | 'regex';
  value: string | number | string[];
  weight?: number;
}

export interface RoutingAction {
  type: 'route_to' | 'modify_request' | 'add_header' | 'set_param' | 'transform' | 'log' | 'metric';
  value: string | number | Record<string, any>;
}

export interface RoutingTestRequest {
  model: string;
  messages: Array<{
    role: string;
    content: string;
  }>;
  tools?: any[];
  max_tokens?: number;
  endpoint?: string;
  protocol?: string;
}

export interface RoutingTestResult {
  requestId: string;
  matched: boolean;
  confidence: number;
  matchedRules: RoutingRule[];
  selectedRoute: string;
  selectedProvider: string;
  selectedModel: string;
  reasoning: string;
  executionTime: number;
}

export interface RoutingStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageResponseTime: number;
  routeUsage: Record<string, number>;
  providerUsage: Record<string, number>;
  modelUsage: Record<string, number>;
  ruleMatches: Record<string, number>;
  errors: Array<{
    type: string;
    count: number;
    lastOccurred: number;
  }>;
}

export interface RoutingProviderInfo {
  id: string;
  name: string;
  type: string;
  baseURL: string;
  status: 'healthy' | 'unhealthy' | 'unknown';
  models: string[];
  supportedFeatures: string[];
  lastHealthCheck: number;
  responseTime: number;
  uptime: number;
}