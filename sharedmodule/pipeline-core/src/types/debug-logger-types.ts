export interface DebugLogEntry {
  level: 'info' | 'warn' | 'error' | 'debug';
  timestamp: number;
  pipelineId: string;
  category: string;
  message: string;
  data?: any;
  requestId?: string;
  stage?: string;
}

export interface TransformationLogEntry {
  timestamp: number;
  pipelineId: string;
  requestId: string;
  stage: string;
  originalData: any;
  transformedData: any;
  metadata: {
    ruleId?: string;
    processingTime: number;
    dataSize: number;
  };
}

export interface ProviderRequestLogEntry {
  timestamp: number;
  pipelineId: string;
  requestId: string;
  action: 'request-start' | 'request-success' | 'request-error' | 'health-check';
  provider: {
    id: string;
    type: string;
  };
  data: any;
  metrics?: {
    responseTime?: number;
    status?: number;
    error?: string;
  };
}

