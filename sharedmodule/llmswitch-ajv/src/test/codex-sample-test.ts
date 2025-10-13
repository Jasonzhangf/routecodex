/**
 * Codex Sample Black-Box Test Framework
 * Uses real captured codex sample data to compare original vs AJV implementations
 */

import { LLMSwitchTestAdapter } from '../core/test-adapter.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { TestResult } from '../core/test-adapter.js';

/**
 * Codex Sample Test Suite
 *
 * This test suite uses real captured data from the codex-samples directory
 * to perform black-box testing between the original and AJV implementations.
 */
export class CodexSampleTestSuite {
  private testAdapter: LLMSwitchTestAdapter;
  private sampleDir: string;
  private results: TestResult[] = [];

  constructor(sampleDir: string = '/Users/fanzhang/.routecodex/codex-samples') {
    this.sampleDir = sampleDir;
    this.testAdapter = new LLMSwitchTestAdapter();
  }

  /**
   * Initialize the test suite
   */
  async initialize(): Promise<void> {
    await this.testAdapter.initialize();
    console.log('🔍 Codex Sample Test Suite initialized');
    console.log(`📁 Sample directory: ${this.sampleDir}`);
  }

  /**
   * Load and parse codex sample files
   */
  async loadCodexSamples(): Promise<any[]> {
    try {
      const files = await fs.readdir(this.sampleDir);

      // Filter for relevant sample files
      const sampleFiles = files.filter(file =>
        (file.startsWith('pipeline-in-anth_') && file.endsWith('.json')) ||
        (file.startsWith('provider-out-openai_') && file.endsWith('.json'))
      );

      console.log(`📊 Found ${sampleFiles.length} sample files`);

      const samples = [];
      // Take first 10 requests and first 10 responses for balanced testing
      const requestFiles = sampleFiles.filter(file => file.startsWith('pipeline-in-anth_')).slice(0, 10);
      const responseFiles = sampleFiles.filter(file => file.startsWith('provider-out-openai_')).slice(0, 10);
      const testFiles = [...requestFiles, ...responseFiles];

      for (const file of testFiles) {
        try {
          const filePath = path.join(this.sampleDir, file);
          const content = await fs.readFile(filePath, 'utf-8');
          const data = JSON.parse(content);

          // Determine the actual format based on content, not filename
        const actualData = data.data || data;
        const isRequestFormat = actualData.model && actualData.messages;
        const isResponseFormat = actualData.choices && actualData.id;

        samples.push({
          filename: file,
          type: isRequestFormat ? 'request' : (isResponseFormat ? 'response' : 'request'), // Default to request
          data: actualData,
          metadata: {
            file,
            timestamp: data.timestamp,
            size: content.length,
            detectedFormat: isRequestFormat ? 'request' : (isResponseFormat ? 'response' : 'unknown')
          }
        });
        } catch (error) {
          console.warn(`⚠️  Failed to parse sample file ${file}:`, error);
        }
      }

      console.log(`✅ Loaded ${samples.length} samples successfully`);
      return samples;
    } catch (error) {
      console.error('❌ Failed to load codex samples:', error);
      throw error;
    }
  }

  /**
   * Create test cases from codex samples
   */
  createTestCases(samples: any[]): Array<{ name: string; data: any; type: string }> {
    return samples.map((sample, index) => ({
      name: `codex-sample-${index}-${sample.filename}`,
      type: sample.type === 'request' ? 'request' : 'response',
      data: sample.data
    }));
  }

  /**
   * Run comprehensive codex sample test suite
   */
  async runCodexSampleTests(originalAdapter: any): Promise<{
    summary: any;
    results: TestResult[];
    metrics: any;
  }> {
    console.log('\n🚀 Starting Codex Sample Black-Box Tests');
    console.log('='.repeat(50));

    // Set the original adapter for comparison
    this.testAdapter.setOriginalAdapter(originalAdapter);

    try {
      // Load real codex samples
      const samples = await this.loadCodexSamples();
      if (samples.length === 0) {
        throw new Error('No valid codex samples found');
      }

      // Create test cases
      const testCases = this.createTestCases(samples);
      console.log(`📋 Created ${testCases.length} test cases from samples`);

      // Run the test suite
      const results = await this.testAdapter.runTestSuite(testCases);
      this.results = results;

      // Generate comprehensive report
      const report = this.generateDetailedReport(results, samples);

      // Get AJV metrics
      const metrics = this.testAdapter.getAjvMetrics();

      // Print summary
      this.printSummary(report);

      return {
        summary: report,
        results,
        metrics
      };

    } catch (error) {
      console.error('❌ Codex sample test failed:', error);
      throw error;
    }
  }

  /**
   * Generate detailed test report
   */
  private generateDetailedReport(results: TestResult[], samples: any[]): any {
    const passed = results.filter(r => r.passed).length;
    const failed = results.length - passed;
    const passRate = (passed / results.length) * 100;

    // Performance analysis
    const performanceData = results.map(r => r.performance);
    const avgImprovement = performanceData.reduce((sum, p) => sum + p.improvement, 0) / performanceData.length;
    const fastestTest = results.reduce((min, r) => r.performance.ajv < min.performance.ajv ? r : min);
    const slowestTest = results.reduce((max, r) => r.performance.ajv > max.performance.ajv ? r : max);

    // Error analysis
    const errorTypes = new Map<string, number>();
    const failedTests = results.filter(r => !r.passed);
    failedTests.forEach(test => {
      test.errors.forEach(error => {
        const key = error.substring(0, 50) + '...'; // Truncate long errors
        errorTypes.set(key, (errorTypes.get(key) || 0) + 1);
      });
    });

    // Sample type analysis
    const requestTests = results.filter(r => r.testCase.type === 'request');
    const responseTests = results.filter(r => r.testCase.type === 'response');
    const requestPassRate = (requestTests.filter(r => r.passed).length / requestTests.length) * 100;
    const responsePassRate = (responseTests.filter(r => r.passed).length / responseTests.length) * 100;

    // Common differences analysis
    const commonDifferences = this.analyzeCommonDifferences(results);

    return {
      summary: {
        total: results.length,
        passed,
        failed,
        passRate,
        samplesUsed: samples.length,
        testCases: {
          requests: requestTests.length,
          responses: responseTests.length
        }
      },
      performance: {
        averageImprovement: avgImprovement,
        fastestTest: fastestTest.testName,
        slowestTest: slowestTest.testName,
        fastestTime: fastestTest.performance.ajv,
        slowestTime: slowestTest.performance.ajv,
        averageOriginalTime: performanceData.reduce((sum, p) => sum + p.original, 0) / performanceData.length,
        averageAjvTime: performanceData.reduce((sum, p) => sum + p.ajv, 0) / performanceData.length
      },
      analysis: {
        requestTests: {
          total: requestTests.length,
          passed: requestTests.filter(r => r.passed).length,
          passRate: requestPassRate
        },
        responseTests: {
          total: responseTests.length,
          passed: responseTests.filter(r => r.passed).length,
          passRate: responsePassRate
        }
      },
      errors: {
        totalErrors: failedTests.reduce((sum, t) => sum + t.errors.length, 0),
        errorTypes: Array.from(errorTypes.entries())
          .map(([error, count]) => ({ error, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 10) // Top 10 errors
      },
      differences: commonDifferences,
      failedTests: failedTests.map(t => ({
        name: t.testName,
        errors: t.errors,
        differences: t.differences
      }))
    };
  }

  /**
   * Analyze common differences between implementations
   */
  private analyzeCommonDifferences(results: TestResult[]): Array<{
    path: string;
    frequency: number;
    type: string;
    examples: any[];
  }> {
    const differenceMap = new Map<string, { count: number; type: string; examples: any[] }>();

    results.forEach(result => {
      result.differences.forEach(diff => {
        const key = `${diff.path}:${diff.type}`;
        if (!differenceMap.has(key)) {
          differenceMap.set(key, {
            count: 0,
            type: diff.type,
            examples: []
          });
        }
        const entry = differenceMap.get(key)!;
        entry.count++;
        if (entry.examples.length < 3) {
          entry.examples.push({
            test: result.testName,
            original: diff.originalValue,
            ajv: diff.ajvValue
          });
        }
      });
    });

    return Array.from(differenceMap.entries())
      .map(([path, data]) => ({
        path: path.split(':')[0],
        type: data.type,
        frequency: data.count,
        examples: data.examples
      }))
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 15); // Top 15 differences
  }

  /**
   * Print test summary to console
   */
  private printSummary(report: any): void {
    console.log('\n📊 CODEX SAMPLE TEST RESULTS');
    console.log('='.repeat(50));

    console.log(`\n📈 SUMMARY:`);
    console.log(`   Total Tests: ${report.summary.total}`);
    console.log(`   Passed: ${report.summary.passed} ✅`);
    console.log(`   Failed: ${report.summary.failed} ❌`);
    console.log(`   Pass Rate: ${report.summary.passRate.toFixed(2)}%`);
    console.log(`   Samples Used: ${report.summary.samplesUsed}`);

    console.log(`\n⚡ PERFORMANCE:`);
    console.log(`   Average Improvement: ${report.performance.averageImprovement.toFixed(2)}%`);
    console.log(`   Fastest Test: ${report.performance.fastestTest} (${report.performance.fastestTime.toFixed(2)}ms)`);
    console.log(`   Slowest Test: ${report.performance.slowestTest} (${report.performance.slowestTime.toFixed(2)}ms)`);
    console.log(`   Avg Original Time: ${report.performance.averageOriginalTime.toFixed(2)}ms`);
    console.log(`   Avg AJV Time: ${report.performance.averageAjvTime.toFixed(2)}ms`);

    console.log(`\n🔍 ANALYSIS BY TYPE:`);
    console.log(`   Request Tests: ${report.analysis.requestTests.passed}/${report.analysis.requestTests.total} (${report.analysis.requestTests.passRate.toFixed(1)}%)`);
    console.log(`   Response Tests: ${report.analysis.responseTests.passed}/${report.analysis.responseTests.total} (${report.analysis.responseTests.passRate.toFixed(1)}%)`);

    if (report.errors.totalErrors > 0) {
      console.log(`\n❌ ERROR ANALYSIS:`);
      console.log(`   Total Errors: ${report.errors.totalErrors}`);
      console.log(`   Top Error Types:`);
      report.errors.errorTypes.slice(0, 5).forEach((error: any, index: number) => {
        console.log(`   ${index + 1}. ${error.error} (${error.count} occurrences)`);
      });
    }

    if (report.differences.length > 0) {
      console.log(`\n🔍 COMMON DIFFERENCES:`);
      report.differences.slice(0, 5).forEach((diff: any, index: number) => {
        console.log(`   ${index + 1}. ${diff.path} (${diff.type}) - ${diff.frequency} occurrences`);
        diff.examples.forEach((example: any, exIndex: number) => {
          console.log(`      Example ${exIndex + 1}: ${example.test}`);
        });
      });
    }

    if (report.failedTests.length > 0) {
      console.log(`\n❌ FAILED TESTS:`);
      report.failedTests.slice(0, 5).forEach((test: any) => {
        console.log(`   • ${test.name}`);
        test.errors.forEach((error: any) => {
          console.log(`     Error: ${error}`);
        });
      });
      if (report.failedTests.length > 5) {
        console.log(`   ... and ${report.failedTests.length - 5} more failed tests`);
      }
    }

    console.log('\n' + '='.repeat(50));

    if (report.summary.passRate >= 90) {
      console.log('🎉 EXCELLENT! AJV implementation shows high compatibility');
    } else if (report.summary.passRate >= 75) {
      console.log('👍 GOOD! AJV implementation shows reasonable compatibility');
    } else if (report.summary.passRate >= 50) {
      console.log('⚠️  MODERATE! AJV implementation needs improvement');
    } else {
      console.log('🚨 POOR! AJV implementation has significant issues');
    }
  }

  /**
   * Save detailed report to file
   */
  async saveReport(report: any, filename: string = 'codex-sample-test-report.json'): Promise<void> {
    try {
      const reportPath = path.join(this.sampleDir, filename);
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');
      console.log(`\n💾 Detailed report saved to: ${reportPath}`);
    } catch (error) {
      console.error('❌ Failed to save report:', error);
    }
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    await this.testAdapter.cleanup();
    console.log('🧹 Codex Sample Test Suite cleaned up');
  }

  /**
   * Get test results
   */
  getResults(): TestResult[] {
    return this.results;
  }
}

/**
 * Run codex sample tests (convenience function)
 */
export async function runCodexSampleTests(originalAdapter: any): Promise<{
  summary: any;
  results: TestResult[];
  metrics: any;
}> {
  const testSuite = new CodexSampleTestSuite();

  try {
    await testSuite.initialize();
    const results = await testSuite.runCodexSampleTests(originalAdapter);
    await testSuite.saveReport(results.summary);
    return results;
  } finally {
    await testSuite.cleanup();
  }
}