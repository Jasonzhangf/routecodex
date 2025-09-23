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