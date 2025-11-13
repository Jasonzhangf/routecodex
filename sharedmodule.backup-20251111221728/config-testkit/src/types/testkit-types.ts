/**
 * RouteCodex Configuration TestKit Types
 * Types for testing framework, black box testing, and golden snapshots
 */

import type {
  ConfigValidationResult,
  ConfigError,
  ConfigWarning,
  RouteCodexConfig
} from 'routecodex-config-engine';
import type {
  CompatibilityConfig,
  CompatibilityResult,
  CompatibilityWarning
} from 'routecodex-config-compat';

/**
 * Test case configuration
 */
export interface TestCase {
  id: string;
  name: string;
  description: string;
  category: 'unit' | 'integration' | 'performance' | 'regression';
  config: any;
  expected?: any;
  expectations: TestExpectation[];
  skip?: boolean;
  timeout?: number;
}

/**
 * Test expectation specification
 */
export interface TestExpectation {
  type: 'validation' | 'compatibility' | 'normalization' | 'performance' | 'error';
  description: string;
  validator: (result: any) => boolean;
  severity: 'critical' | 'major' | 'minor';
}

/**
 * Black box test configuration
 */
export interface BlackBoxTest {
  id: string;
  name: string;
  inputConfig: any;
  expectedOutput: any;
  environment: TestEnvironment;
  preconditions?: TestCondition[];
  postconditions?: TestCondition[];
}

/**
 * Test environment configuration
 */
export interface TestEnvironment {
  variables: Record<string, string>;
  mockServices: Record<string, any>;
  networkConditions?: {
    latency: number;
    bandwidth: number;
    packetLoss: number;
  };
}

/**
 * Test condition for pre/post conditions
 */
export interface TestCondition {
  type: 'file-exists' | 'env-var' | 'service-available' | 'config-valid';
  value: any;
  operator: 'equals' | 'contains' | 'exists' | 'greater-than' | 'less-than';
}

/**
 * Golden snapshot configuration
 */
export interface GoldenSnapshot {
  id: string;
  name: string;
  description: string;
  input: any;
  expectedOutput: any;
  metadata: {
    version: string;
    timestamp: number;
    author: string;
    tags: string[];
  };
  tolerance?: SnapshotTolerance;
}

/**
 * Snapshot tolerance settings
 */
export interface SnapshotTolerance {
  numeric?: number;
  string?: 'exact' | 'fuzzy';
  array?: 'exact-order' | 'unordered';
  object?: 'exact-keys' | 'subset-keys';
  custom?: (actual: any, expected: any) => boolean;
}

/**
 * Performance benchmark configuration
 */
export interface PerformanceBenchmark {
  id: string;
  name: string;
  iterations: number;
  warmupIterations: number;
  config: any;
  metrics: PerformanceMetric[];
  thresholds: PerformanceThreshold;
}

/**
 * Performance metric definition
 */
export interface PerformanceMetric {
  name: string;
  type: 'time' | 'memory' | 'cpu' | 'throughput';
  unit: string;
  aggregator: 'min' | 'max' | 'avg' | 'median' | 'p95' | 'p99';
}

/**
 * Performance threshold settings
 */
export interface PerformanceThreshold {
  warning: number;
  critical: number;
  unit: string;
}

/**
 * Test suite configuration
 */
export interface TestSuite {
  id: string;
  name: string;
  description: string;
  tests: (TestCase | BlackBoxTest | PerformanceBenchmark)[];
  setup?: TestSetup;
  teardown?: TestTeardown;
  parallel?: boolean;
  timeout?: number;
}

/**
 * Test setup configuration
 */
export interface TestSetup {
  beforeAll?: () => Promise<void>;
  beforeEach?: (test: any) => Promise<void>;
  environment?: TestEnvironment;
}

/**
 * Test teardown configuration
 */
export interface TestTeardown {
  afterAll?: () => Promise<void>;
  afterEach?: (test: any) => Promise<void>;
  cleanup?: () => Promise<void>;
}

/**
 * Test result
 */
export interface TestResult {
  id: string;
  name: string;
  status: 'passed' | 'failed' | 'skipped' | 'timeout';
  duration: number;
  error?: TestError;
  metrics?: Record<string, number>;
  output?: any;
  snapshots?: SnapshotResult[];
}

/**
 * Test error information
 */
export interface TestError {
  type: string;
  message: string;
  stack?: string;
  context?: any;
}

/**
 * Snapshot result
 */
export interface SnapshotResult {
  id: string;
  status: 'passed' | 'failed' | 'updated';
  diff?: string;
  toleranceApplied?: boolean;
}

/**
 * Test run configuration
 */
export interface TestRun {
  id: string;
  timestamp: number;
  suites: TestSuite[];
  config: TestRunConfig;
  environment: TestEnvironment;
}

/**
 * Test run configuration
 */
export interface TestRunConfig {
  filter?: TestFilter;
  parallel: boolean;
  timeout: number;
  verbose: boolean;
  coverage: boolean;
  updateSnapshots: boolean;
  stopOnFailure: boolean;
}

/**
 * Test filter configuration
 */
export interface TestFilter {
  include?: string[];
  exclude?: string[];
  tags?: string[];
  categories?: string[];
}

/**
 * Test report
 */
export interface TestReport {
  runId: string;
  timestamp: number;
  duration: number;
  summary: TestSummary;
  suites: TestSuiteReport[];
  errors: TestError[];
  coverage?: CoverageReport;
}

/**
 * Test summary
 */
export interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  successRate: number;
  duration: number;
}

/**
 * Test suite report
 */
export interface TestSuiteReport {
  id: string;
  name: string;
  summary: TestSummary;
  tests: TestResult[];
  setupTime?: number;
  teardownTime?: number;
}

/**
 * Coverage report
 */
export interface CoverageReport {
  statements: number;
  branches: number;
  functions: number;
  lines: number;
  files: CoverageFile[];
}

/**
 * Coverage file report
 */
export interface CoverageFile {
  path: string;
  statements: {
    total: number;
    covered: number;
    percentage: number;
  };
  branches: {
    total: number;
    covered: number;
    percentage: number;
  };
  functions: {
    total: number;
    covered: number;
    percentage: number;
  };
  lines: {
    total: number;
    covered: number;
    percentage: number;
  };
}

/**
 * Test utilities
 */
export interface TestUtilities {
  createMockConfig: (overrides?: any) => any;
  createValidationError: (message: string, path?: string) => ConfigError;
  createCompatibilityWarning: (message: string, path?: string) => CompatibilityWarning;
  waitForCondition: (condition: () => boolean, timeout?: number) => Promise<boolean>;
  measurePerformance: (fn: () => Promise<any>) => Promise<{ duration: number; result: any }>;
}

/**
 * Assertion utilities
 */
export interface Assertions {
  equal: (actual: any, expected: any, message?: string) => void;
  deepEqual: (actual: any, expected: any, message?: string) => void;
  throws: (fn: () => any, expectedError?: any, message?: string) => void;
  match: (actual: string, pattern: RegExp, message?: string) => void;
  contains: (actual: any, expected: any, message?: string) => void;
  hasProperty: (obj: any, property: string, message?: string) => void;
  typeOf: (value: any, type: string, message?: string) => void;
}

/**
 * Mock configuration
 */
export interface MockConfig {
  providers: Record<string, any>;
  routing: Record<string, string[]>;
  pipeline: any;
  modules: Record<string, any>;
}

/**
 * Fixture configuration
 */
export interface FixtureConfig {
  name: string;
  config: any;
  description?: string;
  tags?: string[];
  environment?: TestEnvironment;
}

/**
 * Test data generator
 */
export interface TestDataGenerator {
  generateProviderConfig: (type: string, overrides?: any) => any;
  generateRoutingConfig: (routes: string[], overrides?: any) => any;
  generateCompatibilityConfig: (type: string, overrides?: any) => any;
  generateErrorConfig: (errorType: string, overrides?: any) => any;
  generatePerformanceConfig: (complexity: 'simple' | 'medium' | 'complex', overrides?: any) => any;
}