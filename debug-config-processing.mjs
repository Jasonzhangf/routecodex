#!/usr/bin/env node

/**
 * Debug Configuration Processing
 * 调试配置处理过程
 */

import fs from 'fs';
import path from 'path';

// Use the same test configuration as test-e2e-config.mjs
const testConfig = {
  version: '1.0.0',
  providers: {
    'lmstudio': {
      type: 'lmstudio-http',
      enabled: true,
      baseUrl: 'http://localhost:1234',
      models: {
        'llama3-8b-instruct': {
          maxTokens: 4096,
          temperature: 0.7
        }
      },
      keys: {
        'test-key': {
          type: 'apikey',
          apiKey: 'test-api-key'
        }
      }
    }
  },
  virtualrouter: {
    inputProtocol: 'openai',
    outputProtocol: 'openai',
    providers: {},
    routing: {
      default: ['lmstudio.llama3-8b-instruct.test-key'],
      coding: [],
      longcontext: [],
      tools: [],
      thinking: [],
      vision: [],
      websearch: [],
      background: []
    }
  },
  auth: {}
};

async function debugConfigProcessing() {
  console.log('🔍 Debugging configuration processing...\n');

  try {
    // Test 1: Test ConfigParser directly
    console.log('✅ Test 1: Testing ConfigParser');
    const { ConfigParser } = await import('routecodex-config-engine');
    const configParser = new ConfigParser();

    console.log('- Parsing original configuration...');
    const parseResult = await configParser.parseFromString(JSON.stringify(testConfig));

    console.log(`  Parse result: Valid=${parseResult.isValid}`);
    if (parseResult.errors) {
      console.log('  Parse errors:', parseResult.errors);
    }
    if (parseResult.isValid && parseResult.normalized) {
      console.log('  Normalized config keys:', Object.keys(parseResult.normalized));
      console.log('  Virtualrouter providers:', Object.keys(parseResult.normalized.virtualrouter?.providers || {}));
    }

    // Test 2: Test CompatibilityEngine
    console.log('\n✅ Test 2: Testing CompatibilityEngine');
    const { CompatibilityEngine } = await import('routecodex-config-compat');
    const compatibilityEngine = new CompatibilityEngine();

    const inputConfig = parseResult.normalized || testConfig;
    console.log('- Processing compatibility...');

    const compatResult = await compatibilityEngine.processCompatibility(
      JSON.stringify(inputConfig)
    );

    console.log(`  Compat result: Valid=${compatResult.isValid}`);
    if (compatResult.errors) {
      console.log('  Compat errors:', compatResult.errors);
    }
    if (compatResult.compatibilityConfig) {
      console.log('  Compatibility config keys:', Object.keys(compatResult.compatibilityConfig));
    }

    // Test 3: Check final validation
    if (parseResult.isValid && compatResult.isValid) {
      console.log('\n✅ Test 3: Testing final validation');
      const finalConfig = {
        ...inputConfig,
        ...compatResult.compatibilityConfig
      };

      const finalValidation = await configParser.parseFromString(JSON.stringify(finalConfig));
      console.log(`  Final validation: Valid=${finalValidation.isValid}`);
      if (finalValidation.errors) {
        console.log('  Final errors:');
        finalValidation.errors.forEach((error, index) => {
          console.log(`    ${index + 1}. ${error.code}: ${error.message}`);
          if (error.path) {
            console.log(`       Path: ${error.path}`);
          }
        });
      }
    }

    console.log('\n🎉 Debug completed successfully!');

  } catch (error) {
    console.error('\n❌ Debug failed:', error);
    console.error('Error details:', error instanceof Error ? error.message : String(error));
    console.error('Stack:', error instanceof Error ? error.stack : 'No stack trace available');
  }
}

// Run the debug
debugConfigProcessing();