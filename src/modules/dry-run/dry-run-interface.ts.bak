/**
 * Dry-Run Shared Interfaces
 *
 * 定义 Dry-Run 相关的通用类型，供虚拟路由、负载均衡、流水线 dry-run 框架等复用。
 */

export interface DryRunConfig {
  enabled: boolean;
  verbosity?: 'minimal' | 'normal' | 'debug' | 'detailed';
  includePerformanceEstimate?: boolean;
  includeConfigValidation?: boolean;
  maxOutputDepth?: number;
  sensitiveFields?: string[];
}

export interface RoutingDecision {
  requestId: string;
  routeName: string;
  selectedTarget: {
    providerId: string;
    modelId: string;
    keyId?: string;
    actualKey?: string;
  };
  availableTargets: Array<{
    providerId: string;
    modelId: string;
    keyId?: string;
    health?: 'healthy' | 'degraded' | 'unhealthy';
  }>;
  loadBalancerDecision: {
    algorithm: string;
    weights: Record<string, number>;
    selectedWeight: number;
    reasoning: string;
  };
  timestamp: string;
  decisionTimeMs: number;
}

export interface FieldConversionInfo {
  originalFields: string[];
  convertedFields: string[];
  fieldMappings: Array<{ from: string; to: string; transformation: string }>;
  conversionTimeMs: number;
  success: boolean;
  isSimulated?: boolean;
}

export interface ProtocolProcessingInfo {
  inputProtocol: string;
  outputProtocol: string;
  conversionSteps: any[];
  processingTimeMs: number;
  requiresConversion: boolean;
  simulationUsed?: boolean;
}

export interface PerformanceEstimate {
  estimatedTotalTimeMs: number;
  breakdown: Record<string, number>;
  confidence: number;
  baselineSource: 'historical' | 'heuristic' | 'simulation' | 'unknown';
}

export interface ConfigValidationResult {
  routingConfig: { valid: boolean; errors: string[]; warnings: string[] };
  pipelineConfig: { valid: boolean; errors: string[]; warnings: string[] };
  targetConfig: { valid: boolean; errors: string[]; warnings: string[] };
}

export interface DryRunStats {
  totalRuns: number;
  successfulRuns: number;
  averageTimeMs: number;
  topRoutes: Array<{ route: string; count: number }>;
  topTargets: Array<{ target: string; count: number }>;
  configErrors: { routing: number; pipeline: number; target: number };
}

export interface DryRunResponse {
  mode: 'dry-run';
  requestSummary: {
    id: string;
    type: string;
    timestamp: string;
    route?: string;
    strategy?: string;
    pipelineId?: string;
    dryRunNodeCount?: number;
  };
  routingDecision: RoutingDecision;
  fieldConversion: FieldConversionInfo;
  protocolProcessing: ProtocolProcessingInfo;
  executionPlan: any;
  performanceEstimate?: PerformanceEstimate;
  configValidation?: ConfigValidationResult;
  debugInfo?: {
    logEntries: Array<{
      level: 'debug' | 'info' | 'warn' | 'error';
      message: string;
      timestamp: string;
      data?: any;
    }>;
    metrics: Record<string, any>;
  };
  totalDryRunTimeMs: number;
  // 允许扩展字段（例如 pipeline dry-run 的扩展）
  [key: string]: any;
}

