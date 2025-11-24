/**
 * V1/V2一致性测试类型定义
 */

export interface ConsistencyTestCase {
  id: string;
  timestamp: string;
  protocol: 'openai-chat' | 'anthropic-messages' | 'openai-responses';
  inputRequest: any;
  v1Data: V1ProcessingData;
  v2Data: V2ProcessingData;
}

export interface V1ProcessingData {
  compatPre?: any;
  compatPost?: any;
  providerRequest?: any;
  providerResponse?: any;
  finalResponse?: any;
}

export interface V2ProcessingData {
  providerRequest?: any;
  providerResponse?: any;
  finalResponse?: any;
}

export interface ConsistencyCheck {
  category: 'provider-request' | 'provider-response' | 'tool-processing' | 'final-response';
  passed: boolean;
  details: string;
  differences: ConsistencyDifference[];
}

export interface ConsistencyDifference {
  path: string;
  v1Value: any;
  v2Value: any;
  severity: 'critical' | 'major' | 'minor';
  reason: string;
}

export interface ConsistencyReport {
  summary: ConsistencySummary;
  testResults: ConsistencyTestResult[];
  failures: ConsistencyFailure[];
  recommendations: string[];
}

export interface ConsistencySummary {
  totalTests: number;
  passedTests: number;
  failedTests: number;
  consistencyRate: number;
  providerRequestConsistency: number;
  providerResponseConsistency: number;
  toolProcessingConsistency: number;
  finalResponseConsistency: number;
}

export interface ConsistencyTestResult {
  testCaseId: string;
  protocol: string;
  passed: boolean;
  checks: ConsistencyCheck[];
  executionTime: number;
}

export interface ConsistencyFailure {
  testCaseId: string;
  category: string;
  severity: 'critical' | 'major' | 'minor';
  description: string;
  v1Result: any;
  v2Result: any;
  differences: ConsistencyDifference[];
}

export interface SnapshotData {
  meta: {
    stage: string;
    version: string;
    buildTime: string;
  };
  data?: any;
  url?: string;
  headers?: any;
  body?: any;
}

export interface ConsistencyTestConfig {
  samplesDir: string;
  outputDir: string;
  maxTestCases: number;
  ignoreFields: string[];
  tolerance: {
    timeDifference: number;
    numericPrecision: number;
  };
}
