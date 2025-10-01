#!/usr/bin/env node

/**
 * Performance Benchmark Script
 * Measures the performance improvements from optimizations
 */

import { PerformanceObserver, performance } from 'perf_hooks';
const { CompatibilityEngine } = await import('./config-compat/dist/compatibility-engine.js');
const { ConfigParser } = await import('./config-engine/dist/core/config-parser.js');

// Test configurations of different sizes
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
            'gpt-3.5-turbo': {
              maxTokens: 4096
            }
          }
        }
      },
      routing: {
        default: ['test-provider.gpt-3.5-turbo'],
        longcontext: [],
        thinking: [],
        background: [],
        websearch: [],
        vision: [],
        coding: [],
        tools: []
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
        'provider1': {
          type: 'openai',
          enabled: true,
          apiKey: 'sk-test-key-longer-than-8-chars-1',
          models: {
            'gpt-3.5-turbo': { maxTokens: 4096 },
            'gpt-4': { maxTokens: 8192 }
          }
        },
        'provider2': {
          type: 'lmstudio',
          enabled: true,
          apiKey: 'sk-test-key-longer-than-8-chars-2',
          baseURL: 'http://localhost:1234',
          models: {
            'model1': { maxTokens: 4096 },
            'model2': { maxTokens: 8192 }
          }
        },
        'provider3': {
          type: 'glm',
          enabled: true,
          apiKey: 'sk-test-key-longer-than-8-chars-3',
          models: {
            'glm-4': { maxTokens: 8192 }
          }
        }
      },
      routing: {
        default: ['provider1.gpt-3.5-turbo', 'provider2.model1'],
        longcontext: ['provider1.gpt-4', 'provider2.model2', 'provider3.glm-4'],
        thinking: ['provider1.gpt-4'],
        background: ['provider2.model1'],
        websearch: ['provider3.glm-4'],
        vision: ['provider1.gpt-4'],
        coding: ['provider1.gpt-4'],
        tools: ['provider2.model1']
      }
    }
  },
  large: {
    version: '1.0.0',
    port: 8080,
    virtualrouter: {
      inputProtocol: 'openai',
      outputProtocol: 'openai',
      providers: Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [
          `provider-${i}`,
          {
            type: i % 3 === 0 ? 'openai' : i % 3 === 1 ? 'lmstudio' : 'glm',
            enabled: true,
            apiKey: `sk-test-key-longer-than-8-chars-${i}`,
            baseURL: i % 3 === 1 ? `http://localhost:${1234 + i}` : undefined,
            models: Object.fromEntries(
              Array.from({ length: 3 }, (_, j) => [
                `model-${j}`,
                { maxTokens: 4096 + j * 1024 }
              ])
            )
          }
        ])
      ),
      routing: {
        default: Array.from({ length: 10 }, (_, i) => `provider-${i}.model-0`),
        longcontext: Array.from({ length: 15 }, (_, i) => `provider-${i % 20}.model-1`),
        thinking: Array.from({ length: 5 }, (_, i) => `provider-${i % 10}.model-2`),
        background: Array.from({ length: 8 }, (_, i) => `provider-${i % 15}.model-0`),
        websearch: Array.from({ length: 12 }, (_, i) => `provider-${i % 20}.model-1`),
        vision: Array.from({ length: 6 }, (_, i) => `provider-${i % 10}.model-2`),
        coding: Array.from({ length: 10 }, (_, i) => `provider-${i % 15}.model-0`),
        tools: Array.from({ length: 8 }, (_, i) => `provider-${i % 20}.model-1`)
      }
    }
  }
};

// Benchmark function
async function runBenchmark(name, config, iterations = 100) {
  const compatibilityEngine = new CompatibilityEngine();
  const configParser = new ConfigParser();

  const configString = JSON.stringify(config);

  // Warm up
  for (let i = 0; i < 10; i++) {
    await compatibilityEngine.processCompatibility(configString);
    await configParser.parseFromString(configString);
  }

  // Benchmark ConfigParser
  const parserStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    await configParser.parseFromString(configString);
  }
  const parserEnd = performance.now();
  const parserTime = parserEnd - parserStart;

  // Benchmark CompatibilityEngine
  const compatStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    await compatibilityEngine.processCompatibility(configString);
  }
  const compatEnd = performance.now();
  const compatTime = compatEnd - compatStart;

  return {
    name,
    iterations,
    parserTime: parseFloat(parserTime.toFixed(2)),
    compatTime: parseFloat(compatTime.toFixed(2)),
    parserAvg: parseFloat((parserTime / iterations).toFixed(4)),
    compatAvg: parseFloat((compatTime / iterations).toFixed(4)),
    throughput: {
      parser: parseFloat((iterations / (parserTime / 1000)).toFixed(2)),
      compat: parseFloat((iterations / (compatTime / 1000)).toFixed(2))
    }
  };
}

// Main benchmark runner
async function main() {
  console.log('🚀 RouteCodex Performance Benchmark');
  console.log('=====================================\n');

  const results = [];

  for (const [size, config] of Object.entries(testConfigs)) {
    console.log(`📊 Benchmarking ${size.toUpperCase()} configuration...`);
    const result = await runBenchmark(size, config);
    results.push(result);

    console.log(`   ConfigParser:   ${result.parserAvg}ms/op (${result.throughput.parser} ops/sec)`);
    console.log(`   Compatibility:  ${result.compatAvg}ms/op (${result.throughput.compat} ops/sec)`);
    console.log(`   Total time:     ${result.parserTime + result.compatTime}ms for ${result.iterations} iterations\n`);
  }

  // Summary
  console.log('📈 Performance Summary');
  console.log('========================');

  results.forEach(result => {
    const improvement = ((result.parserAvg + result.compatAvg) < 10 ? '✅' : '⚠️');
    console.log(`${improvement} ${result.name.padEnd(8)}: ${result.parserAvg + result.compatAvg}ms avg`);
  });

  // Memory usage
  const memUsage = process.memoryUsage();
  console.log('\n💾 Memory Usage');
  console.log('===============');
  console.log(`RSS:       ${(memUsage.rss / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Heap Total: ${(memUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Heap Used:  ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`);
  console.log(`External:   ${(memUsage.external / 1024 / 1024).toFixed(2)} MB`);

  // Performance recommendations
  console.log('\n🎯 Performance Analysis');
  console.log('=======================');

  results.forEach(result => {
    const totalTime = result.parserAvg + result.compatAvg;
    if (totalTime < 5) {
      console.log(`✅ ${result.name}: Excellent performance (< 5ms)`);
    } else if (totalTime < 10) {
      console.log(`✅ ${result.name}: Good performance (< 10ms)`);
    } else if (totalTime < 25) {
      console.log(`⚠️  ${result.name}: Acceptable performance (< 25ms)`);
    } else {
      console.log(`❌ ${result.name}: Poor performance (> 25ms)`);
    }
  });

  // Throughput analysis
  console.log('\n📊 Throughput Analysis');
  console.log('====================');

  const avgThroughput = results.reduce((sum, r) => sum + r.throughput.compat, 0) / results.length;
  console.log(`Average Compatibility Engine throughput: ${avgThroughput.toFixed(2)} ops/sec`);

  if (avgThroughput > 100) {
    console.log('✅ Excellent throughput (> 100 ops/sec)');
  } else if (avgThroughput > 50) {
    console.log('✅ Good throughput (> 50 ops/sec)');
  } else if (avgThroughput > 20) {
    console.log('⚠️  Acceptable throughput (> 20 ops/sec)');
  } else {
    console.log('❌ Poor throughput (< 20 ops/sec)');
  }

  console.log('\n🏁 Benchmark completed successfully!');
}

// Run the benchmark
main().catch(console.error);