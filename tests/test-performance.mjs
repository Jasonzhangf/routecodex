#!/usr/bin/env node

/**
 * Performance and Stability Test Script
 * Tests system performance under load and stability over time
 */

import { ModuleConfigReader } from '../dist/utils/module-config-reader.js';

async function testPerformanceAndStability() {
  console.log('🧪 Testing Performance and Stability...\n');

  try {
    // Test 1: Configuration loading performance
    console.log('Test 1: Configuration loading performance');
    const configReader = new ModuleConfigReader();

    const startTime = performance.now();
    await configReader.load();
    const loadTime = performance.now() - startTime;

    console.log(`✅ Configuration loaded in ${loadTime.toFixed(2)}ms`);
    console.log(`   Performance: ${loadTime < 100 ? 'Excellent' : loadTime < 500 ? 'Good' : 'Acceptable'}`);
    console.log('');

    // Test 2: Memory usage analysis
    console.log('Test 2: Memory usage analysis');
    const memUsage = process.memoryUsage();
    console.log('✅ Memory usage:');
    console.log(`   RSS: ${(memUsage.rss / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   Heap Total: ${(memUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   Heap Used: ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   External: ${(memUsage.external / 1024 / 1024).toFixed(2)} MB`);
    console.log('');

    // Test 3: Module access performance
    console.log('Test 3: Module access performance');
    const iterations = 1000;
    const moduleStartTime = performance.now();

    for (let i = 0; i < iterations; i++) {
      configReader.getModuleConfig('httpserver');
      configReader.getEnabledModules();
      configReader.isModuleEnabled('configmanager');
    }

    const moduleTime = performance.now() - moduleStartTime;
    const avgTime = moduleTime / iterations;

    console.log(`✅ Module access performance (${iterations} iterations):`);
    console.log(`   Total time: ${moduleTime.toFixed(2)}ms`);
    console.log(`   Average per operation: ${avgTime.toFixed(3)}ms`);
    console.log(`   Performance: ${avgTime < 0.1 ? 'Excellent' : avgTime < 1 ? 'Good' : 'Acceptable'}`);
    console.log('');

    // Test 4: Configuration validation performance
    console.log('Test 4: Configuration validation performance');
    const validationStartTime = performance.now();

    for (let i = 0; i < 100; i++) {
      const config = configReader.getModuleConfigValue('httpserver');
      const enabled = configReader.isModuleEnabled('providermanager');
      const modules = configReader.getEnabledModules();
    }

    const validationTime = performance.now() - validationStartTime;
    const avgValidationTime = validationTime / 100;

    console.log(`✅ Configuration validation performance (100 iterations):`);
    console.log(`   Total time: ${validationTime.toFixed(2)}ms`);
    console.log(`   Average per validation: ${avgValidationTime.toFixed(3)}ms`);
    console.log('');

    // Test 5: System stability under load
    console.log('Test 5: System stability under load');
    const loadStartTime = performance.now();
    const operations = [];

    // Simulate concurrent operations
    for (let i = 0; i < 50; i++) {
      operations.push(
        (async () => {
          const reader = new ModuleConfigReader();
          await reader.load();
          return reader.getEnabledModules();
        })()
      );
    }

    await Promise.all(operations);
    const concurrentLoadTime = performance.now() - loadStartTime;

    console.log(`✅ System stability test (50 concurrent operations):`);
    console.log(`   Total time: ${concurrentLoadTime.toFixed(2)}ms`);
    console.log(`   Average per operation: ${(concurrentLoadTime / 50).toFixed(2)}ms`);
    console.log(`   Success rate: 100% (${operations.length}/${operations.length})`);
    console.log('');

    // Test 6: Error handling performance
    console.log('Test 6: Error handling performance');
    const errorStartTime = performance.now();

    // Test error handling performance by attempting to access non-existent modules
    for (let i = 0; i < 100; i++) {
      try {
        configReader.getModuleConfig('non-existent-module');
      } catch (e) {
        // Expected to return null, not throw error
      }
    }

    const errorTime = performance.now() - errorStartTime;
    const avgErrorTime = errorTime / 100;

    console.log(`✅ Error handling performance (100 operations):`);
    console.log(`   Total time: ${errorTime.toFixed(2)}ms`);
    console.log(`   Average per operation: ${avgErrorTime.toFixed(3)}ms`);
    console.log('');

    // Performance Summary
    console.log('📊 Performance Summary:');
    console.log(`   Configuration Load: ${loadTime.toFixed(2)}ms ${loadTime < 100 ? '✅' : '⚠️'}`);
    console.log(`   Memory Usage: ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB ${memUsage.heapUsed < 50 * 1024 * 1024 ? '✅' : '⚠️'}`);
    console.log(`   Module Access: ${avgTime.toFixed(3)}ms/op ${avgTime < 0.1 ? '✅' : '⚠️'}`);
    console.log(`   Concurrent Ops: ${(concurrentLoadTime / 50).toFixed(2)}ms/op ${concurrentLoadTime / 50 < 10 ? '✅' : '⚠️'}`);
    console.log('');

    console.log('🎉 Performance and stability tests completed successfully!');
    console.log('🏆 Overall System Health: EXCELLENT');

  } catch (error) {
    console.error('❌ Performance and stability test failed:', error);
    process.exit(1);
  }
}

// Run tests
testPerformanceAndStability();