#!/usr/bin/env node

/**
 * Simple Performance Test
 * Uses the existing test infrastructure to measure performance improvements
 */

import { performance } from 'perf_hooks';
import { readFileSync } from 'fs';
import { join } from 'path';

// Import from built packages
const { CompatibilityEngine } = await import('./config-compat/dist/compatibility-engine.js');
const { ConfigParser } = await import('./config-engine/dist/core/config-parser.js');

// Test configurations
const testConfigs = {
  small: {
    version: '1.0.0',
    port: 8080,
    virtualrouter: {
      inputProtocol: 'openai',
      outputProtocol: 'openai',
      providers: {
        'test-provider': {
          type: 'openai',
          enabled: true,
          apiKey: 'sk-test-key-longer-than-8-chars',
          models: {
            'gpt-3.5-turbo': { maxTokens: 4096 }
          }
        }
      },
      routing: {
        default: ['test-provider.gpt-3.5-turbo'],
        longcontext: [], thinking: [], background: [], websearch: [], vision: [], coding: [], tools: []
      }
    }
  },
  medium: {
    version: '1.0.0',
    port: 8080,
    virtualrouter: {
      inputProtocol: 'openai',
      outputProtocol: 'openai',
      providers: {
        'provider1': { type: 'openai', enabled: true, apiKey: 'sk-test-key-1', models: { 'gpt-3.5-turbo': { maxTokens: 4096 }, 'gpt-4': { maxTokens: 8192 } } },
        'provider2': { type: 'lmstudio', enabled: true, apiKey: 'sk-test-key-2', baseURL: 'http://localhost:1234', models: { 'model1': { maxTokens: 4096 }, 'model2': { maxTokens: 8192 } } },
        'provider3': { type: 'glm', enabled: true, apiKey: 'sk-test-key-3', models: { 'glm-4': { maxTokens: 8192 } } }
      },
      routing: {
        default: ['provider1.gpt-3.5-turbo', 'provider2.model1'],
        longcontext: ['provider1.gpt-4', 'provider2.model2', 'provider3.glm-4'],
        thinking: ['provider1.gpt-4'], background: ['provider2.model1'], websearch: ['provider3.glm-4'],
        vision: ['provider1.gpt-4'], coding: ['provider1.gpt-4'], tools: ['provider2.model1']
      }
    }
  }
};

function benchmark(name, fn, iterations = 50) {
  // Warm up
  for (let i = 0; i < 5; i++) {
    fn();
  }

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();

  const totalTime = end - start;
  const avgTime = totalTime / iterations;
  const throughput = iterations / (totalTime / 1000);

  return {
    name,
    iterations,
    totalTime: parseFloat(totalTime.toFixed(2)),
    avgTime: parseFloat(avgTime.toFixed(4)),
    throughput: parseFloat(throughput.toFixed(2))
  };
}

async function testPerformance() {
  console.log('🚀 RouteCodex Performance Test');
  console.log('==============================\n');

  const compatibilityEngine = new CompatibilityEngine();
  const configParser = new ConfigParser();

  const results = [];

  for (const [size, config] of Object.entries(testConfigs)) {
    console.log(`📊 Testing ${size.toUpperCase()} configuration...`);

    const configString = JSON.stringify(config);

    // Test ConfigParser
    const parserResult = benchmark('ConfigParser', () => {
      return configParser.parseFromString(configString);
    });

    // Test CompatibilityEngine
    const compatResult = benchmark('Compatibility', () => {
      return compatibilityEngine.processCompatibility(configString);
    });

    results.push({ size, parserResult, compatResult });

    console.log(`   ConfigParser:   ${parserResult.avgTime}ms/op (${parserResult.throughput} ops/sec)`);
    console.log(`   Compatibility:  ${compatResult.avgTime}ms/op (${compatResult.throughput} ops/sec)`);
    console.log(`   Combined:       ${(parserResult.avgTime + compatResult.avgTime).toFixed(4)}ms/op\n`);
  }

  // Summary
  console.log('📈 Performance Summary');
  console.log('====================');

  results.forEach(({ size, parserResult, compatResult }) => {
    const combined = parserResult.avgTime + compatResult.avgTime;
    const status = combined < 10 ? '✅ Excellent' : combined < 20 ? '✅ Good' : '⚠️ Needs improvement';
    console.log(`${status} ${size.padEnd(8)}: ${combined.toFixed(4)}ms avg (${(parserResult.throughput + compatResult.throughput).toFixed(2)} ops/sec combined)`);
  });

  // Memory usage
  const memUsage = process.memoryUsage();
  console.log('\n💾 Memory Usage');
  console.log('===============');
  console.log(`RSS:       ${(memUsage.rss / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Heap Used: ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Heap Total: ${(memUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`);

  // Performance analysis
  console.log('\n🎯 Analysis');
  console.log('=============');

  const avgCombinedTime = results.reduce((sum, r) => sum + r.parserResult.avgTime + r.compatResult.avgTime, 0) / results.length;
  const avgThroughput = results.reduce((sum, r) => sum + r.parserResult.throughput + r.compatResult.throughput, 0) / results.length;

  console.log(`Average processing time: ${avgCombinedTime.toFixed(4)}ms`);
  console.log(`Average throughput: ${avgThroughput.toFixed(2)} ops/sec`);

  if (avgCombinedTime < 15) {
    console.log('✅ Performance is excellent - optimizations are working well!');
  } else if (avgCombinedTime < 30) {
    console.log('✅ Performance is good - within acceptable range');
  } else {
    console.log('⚠️ Performance could be improved - consider further optimizations');
  }

  console.log('\n🏁 Performance test completed!');
}

// Run the test
testPerformance().catch(console.error);