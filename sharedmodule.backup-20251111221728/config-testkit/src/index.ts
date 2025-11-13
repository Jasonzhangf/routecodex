/**
 * RouteCodex Configuration TestKit
 * Complete testing framework for configuration systems
 */

// Main testing classes
import { BlackBoxTester } from './tests/blackbox-tester.js';
import { GoldenSnapshotTester } from './tests/golden-snapshot-tester.js';
import { PerformanceBenchmarker, type BenchmarkResult } from './tests/performance-benchmark.js';

// Type definitions
export type * from './types/testkit-types.js';

// Re-export classes
export { BlackBoxTester, GoldenSnapshotTester, PerformanceBenchmarker, type BenchmarkResult };

// Export test configuration samples and test cases
export { SAMPLE_CONFIGS, BLACKBOX_TEST_CASES } from './fixtures/sample-configs.js';

// Factory functions
export function createBlackBoxTester(): BlackBoxTester {
  return new BlackBoxTester();
}

export function createGoldenSnapshotTester(snapshotsDir?: string): GoldenSnapshotTester {
  return new GoldenSnapshotTester(snapshotsDir);
}

export function createPerformanceBenchmarker(): PerformanceBenchmarker {
  return new PerformanceBenchmarker();
}

// Convenience functions for common testing scenarios
export async function testConfiguration(
  config: any,
  expectedOutput?: any
): Promise<{
  isValid: boolean;
  errors: any[];
  warnings: any[];
  output?: any;
}> {
  const { ConfigParser } = await import('routecodex-config-engine');
  const { CompatibilityEngine } = await import('routecodex-config-compat');

  const parser = new ConfigParser();
  const engine = new CompatibilityEngine();

  const validationResult = await parser.parseFromString(JSON.stringify(config));

  if (!validationResult.isValid) {
    return {
      isValid: false,
      errors: validationResult.errors,
      warnings: validationResult.warnings
    };
  }

  const compatibilityResult = await engine.processCompatibility(
    JSON.stringify(config)
  );

  if (expectedOutput) {
    const blackboxTester = new BlackBoxTester();
    const matches = blackboxTester['validateOutput'](
      compatibilityResult,
      expectedOutput
    );

    if (!matches) {
      return {
        isValid: false,
        errors: [{ code: 'OUTPUT_MISMATCH', message: 'Output does not match expected' }],
        warnings: compatibilityResult.compatibilityWarnings || [],
        output: compatibilityResult
      };
    }
  }

  return {
    isValid: true,
    errors: [],
    warnings: compatibilityResult.compatibilityWarnings || [],
    output: compatibilityResult
  };
}

// Test suite runner
export class TestSuiteRunner {
  private blackboxTester: BlackBoxTester;
  private snapshotTester: GoldenSnapshotTester;
  private benchmarker: PerformanceBenchmarker;

  constructor(
    private options: {
      snapshotsDir?: string;
      verbose?: boolean;
      stopOnFailure?: boolean;
    } = {}
  ) {
    this.blackboxTester = new BlackBoxTester();
    this.snapshotTester = new GoldenSnapshotTester(options.snapshotsDir);
    this.benchmarker = new PerformanceBenchmarker();
  }

  async runTestSuite(tests: any[]): Promise<{
    passed: number;
    failed: number;
    skipped: number;
    results: any[];
  }> {
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    const results: any[] = [];

    for (const test of tests) {
      try {
        if (test.skip) {
          skipped++;
          results.push({ ...test, status: 'skipped' });
          continue;
        }

        let result;
        switch (test.type) {
          case 'blackbox':
            result = await this.blackboxTester.runTest(test);
            break;
          case 'snapshot':
            result = await this.snapshotTester.testAgainstSnapshot(
              test.snapshotId,
              test.inputConfig,
              test.updateSnapshots
            );
            break;
          case 'performance':
            result = await this.benchmarker.runBenchmark(test);
            break;
          default:
            throw new Error(`Unknown test type: ${test.type}`);
        }

        const isPassed = 'passed' in result ? result.passed : result.status === 'passed';
        results.push({ ...test, result, status: isPassed ? 'passed' : 'failed' });

        if (isPassed) {
          passed++;
        } else {
          failed++;
          if (this.options.stopOnFailure) {
            break;
          }
        }

      } catch (error) {
        failed++;
        results.push({
          ...test,
          status: 'failed',
          error: { message: (error as Error).message, stack: (error as Error).stack }
        });

        if (this.options.stopOnFailure) {
          break;
        }
      }
    }

    return { passed, failed, skipped, results };
  }
}

// Export version
export const CONFIG_TESTKIT_VERSION = '1.0.0';

// Default export
export default {
  BlackBoxTester,
  GoldenSnapshotTester,
  PerformanceBenchmarker,
  TestSuiteRunner,
  testConfiguration,
  CONFIG_TESTKIT_VERSION
};