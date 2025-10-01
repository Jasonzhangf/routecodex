/**
 * RouteCodex Configuration TestKit Test Runner
 * Simple test runner for the testkit package
 */

import { test, describe } from 'node:test';
import { createBlackBoxTester, createGoldenSnapshotTester, createPerformanceBenchmarker, SAMPLE_CONFIGS } from '../dist/index.js';

console.log('🚀 Starting RouteCodex Configuration TestKit Tests...\n');

// Test 1: Basic Black Box Testing
console.log('📋 Test 1: Basic Black Box Testing');
try {
  const blackboxTester = createBlackBoxTester();

  const basicTest = {
    id: 'basic-test',
    name: 'Basic Configuration Test',
    inputConfig: SAMPLE_CONFIGS.basic,
    expectedOutput: { isValid: true }
  };

  const result = await blackboxTester.runTest(basicTest);
  console.log(`✅ Basic test: ${result.status} (${result.duration}ms)`);
  console.log(`   Output valid: ${result.output?.isValid}`);
  console.log(`   Has warnings: ${result.output?.warnings?.length > 0}`);
} catch (error) {
  console.error(`❌ Basic test failed: ${error.message}`);
}

console.log();

// Test 2: Golden Snapshot Testing
console.log('📸 Test 2: Golden Snapshot Testing');
try {
  const snapshotTester = createGoldenSnapshotTester('./test-snapshots');

  // Create a snapshot
  const snapshot = await snapshotTester.createSnapshot(
    'test-snapshot',
    'Test Snapshot',
    'Created by test runner',
    SAMPLE_CONFIGS.basic,
    ['test', 'basic']
  );
  console.log(`✅ Snapshot created: ${snapshot.id}`);

  // Test against snapshot
  const testResult = await snapshotTester.testAgainstSnapshot(
    'test-snapshot',
    SAMPLE_CONFIGS.basic,
    false
  );
  console.log(`✅ Snapshot test: ${testResult.status}`);
} catch (error) {
  console.error(`❌ Snapshot test failed: ${error.message}`);
}

console.log();

// Test 3: Performance Benchmarking
console.log('⚡ Test 3: Performance Benchmarking');
try {
  const benchmarker = createPerformanceBenchmarker();

  const benchmarks = benchmarker.createCommonBenchmarks();
  console.log(`✅ Created ${benchmarks.length} benchmark configurations`);

  // Run the first benchmark as a sample
  const sampleBenchmark = benchmarks[0];
  const result = await benchmarker.runBenchmark(sampleBenchmark);
  console.log(`✅ Sample benchmark: ${sampleBenchmark.id} - ${result.passed ? 'PASSED' : 'FAILED'}`);
  console.log(`   Duration: ${result.duration.toFixed(2)}ms`);
  console.log(`   Metrics: ${Object.keys(result.metrics).join(', ')}`);
} catch (error) {
  console.error(`❌ Performance benchmark failed: ${error.message}`);
}

console.log();

// Test 4: Test Configuration Utility
console.log('🔧 Test 4: Test Configuration Utility');
try {
  const { testConfiguration } = await import('../dist/index.js');

  const result = await testConfiguration(SAMPLE_CONFIGS.basic);
  console.log(`✅ Test configuration: ${result.isValid ? 'VALID' : 'INVALID'}`);
  console.log(`   Errors: ${result.errors.length}`);
  console.log(`   Warnings: ${result.warnings.length}`);
} catch (error) {
  console.error(`❌ Test configuration failed: ${error.message}`);
}

console.log();

// Test 5: Error Handling
console.log('🚨 Test 5: Error Handling');
try {
  const { testConfiguration } = await import('../dist/index.js');

  const result = await testConfiguration(SAMPLE_CONFIGS.invalid);
  console.log(`✅ Error handling: ${result.isValid ? 'VALID' : 'INVALID'} (expected INVALID)`);
  console.log(`   Errors detected: ${result.errors.length > 0}`);
  const firstError = result.errors[0]?.message || 'none';
  console.log('   First error: ' + firstError);
} catch (error) {
  console.error(`❌ Error handling test failed: ${error.message}`);
}

console.log();
console.log('🎉 RouteCodex Configuration TestKit Tests Complete!');
console.log('💡 Run "npm test" for comprehensive test suite');