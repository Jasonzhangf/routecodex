#!/usr/bin/env node

/**
 * Test compatibility field processing
 */

import { UserConfigParser } from './dist/config/user-config-parser.js';

// Create test user config with compatibility field
const testUserConfig = {
  version: '1.0.0',
  virtualrouter: {
    inputProtocol: 'openai',
    outputProtocol: 'openai',
    providers: {
      'lmstudio': {
        type: 'lmstudio',
        baseURL: 'http://localhost:1234',
        apiKey: ['lm-studio-api-key-1234567890abcdef'],
        models: {
          'qwen3-4b-thinking-2507-mlx': {
            maxContext: 262144,
            maxTokens: 262144
          }
        }
      }
    },
    routing: {
      default: ['lmstudio.qwen3-4b-thinking-2507-mlx']
    }
  },
  compatibility: 'lmstudio'
};

async function testCompatibilityProcessing() {
  console.log('🧪 Testing compatibility field processing...\n');

  const parser = new UserConfigParser();

  try {
    // Test parseCompatibilityString method
    console.log('📋 Testing parseCompatibilityString method:');

    // Test passthrough
    const passthroughResult = parser['parseCompatibilityString']('passthrough');
    console.log('  "passthrough" ->', JSON.stringify(passthroughResult, null, 2));

    // Test lmstudio
    const lmstudioResult = parser['parseCompatibilityString']('lmstudio');
    console.log('  "lmstudio" ->', JSON.stringify(lmstudioResult, null, 2));

    // Test qwen
    const qwenResult = parser['parseCompatibilityString']('qwen');
    console.log('  "qwen" ->', JSON.stringify(qwenResult, null, 2));

    // Test iflow
    const iflowResult = parser['parseCompatibilityString']('iflow');
    console.log('  "iflow" ->', JSON.stringify(iflowResult, null, 2));

    // Test complex string
    const complexResult = parser['parseCompatibilityString']('iflow/qwen/lmstudio');
    console.log('  "iflow/qwen/lmstudio" ->', JSON.stringify(complexResult, null, 2));

    console.log('\n📋 Testing full user config parsing:');

    // Test full user config parsing
    const result = parser.parseUserConfig(testUserConfig);

    // Check if compatibility field is processed correctly
    const pipelineConfig = result.pipelineConfigs['lmstudio.qwen3-4b-thinking-2507-mlx.key1'];
    if (pipelineConfig && pipelineConfig.compatibility) {
      console.log('✅ Compatibility field processed correctly:');
      console.log('  Type:', pipelineConfig.compatibility.type);
      console.log('  Config:', JSON.stringify(pipelineConfig.compatibility.config, null, 2));
    } else {
      console.log('❌ Compatibility field not found in pipeline config');
    }

    console.log('\n✅ All compatibility field processing tests passed!');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
}

// Run the test
testCompatibilityProcessing();