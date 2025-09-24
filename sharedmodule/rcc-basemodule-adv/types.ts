export type DryRunMode = 'full' | 'partial' | 'mixed';
export type DryRunVerbosity = 'minimal' | 'normal' | 'detailed';

export interface DryRunConfig {
  enabled: boolean;
  mode?: DryRunMode;
  verbosity?: DryRunVerbosity;
  includePerformanceEstimate?: boolean;
  includeConfigValidation?: boolean;
  sensitiveFields?: string[];
}

export interface OutputValidationRule {
  id: string;
  type: 'schema' | 'format' | 'value-range' | 'custom';
  condition: any;
  errorMessage: string;
  severity: 'warning' | 'error' | 'critical';
}

export interface ErrorSimulationConfig {
  enabled: boolean;
  errorType: 'timeout' | 'network' | 'validation' | 'custom';
  probability: number; // 0..1
  customError?: any;
}

export interface NodeDryRunConfig {
  enabled: boolean;
  mode: 'output-validation' | 'full-analysis' | 'error-simulation';
  validationRules?: OutputValidationRule[];
  errorSimulation?: ErrorSimulationConfig;
  breakpointBehavior: 'continue' | 'pause' | 'terminate' | 'no-propagation';
  verbosity: DryRunVerbosity;
}

export interface ValidationResult {
  ruleId: string;
  passed: boolean;
  message: string;
  severity: 'warning' | 'error' | 'critical';
  details?: any;
}

export interface DryRunContext {
  requestId: string;
  pipelineId?: string;
  nodeId: string;
  nodeType: string;
  phase: 'pre-process' | 'process' | 'post-process' | 'response' | 'internal';
  metadata?: Record<string, any>;
}

export interface PerformanceMetrics {
  estimatedTime: number;
  estimatedMemory: number;
  complexity: number;
}

export interface LogEntry {
  timestamp: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: any;
}

export interface NodeDryRunResult {
  nodeId: string;
  nodeType: string;
  status: 'success' | 'warning' | 'error' | 'simulated-error';
  inputData: any;
  expectedOutput: any;
  validationResults: ValidationResult[];
  performanceMetrics: PerformanceMetrics;
  executionLog: LogEntry[];
  error?: any;
}

export interface OperationDescriptor {
  opName: string;
  phase: DryRunContext['phase'];
  direction?: 'incoming' | 'outgoing' | 'internal' | 'response';
}

