#!/usr/bin/env node

/**
 * Test configuration transformation
 * 测试配置转换功能
 */

import fs from 'fs';
import path from 'path';

// Test configuration with providers in config.providers (legacy format with keys)
const testConfig = {
  version: '1.0.0',
  providers: {
    'lmstudio': {
      type: 'lmstudio-http', // Legacy format
      enabled: true,
      baseUrl: 'http://localhost:1234',
      models: {
        'llama3-8b-instruct': {
          maxTokens: 4096,
          temperature: 0.7
        }
      },
      // Legacy format expects apiKey directly or keys object for multiple keys
      apiKey: 'test-api-key'
    }
  },
  virtualrouter: {
    inputProtocol: 'openai',
    outputProtocol: 'openai',
    providers: {}, // Empty providers
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

async function testConfigTransformation() {
  console.log('🧪 Testing configuration transformation...');
  console.log('\n📋 Original configuration structure:');
  console.log('- providers location:', Object.keys(testConfig));
  console.log('- virtualrouter.providers:', Object.keys(testConfig.virtualrouter.providers));
  console.log('- routing target:', testConfig.virtualrouter.routing.default[0]);

  try {
    // Test with the new configuration engine
    console.log('\n🔧 Testing with new configuration engine...');

    const { CompatibilityEngine } = await import('routecodex-config-compat');
    const engine = new CompatibilityEngine();

    // Debug: Check original config structure
    console.log('\n🔍 Debug: Original config before preprocessing:');
    console.log('- config.providers keys:', Object.keys(testConfig.providers || {}));
    console.log('- config.virtualrouter.providers keys:', Object.keys(testConfig.virtualrouter?.providers || {}));

    const result = await engine.processCompatibility(
      JSON.stringify(testConfig)
    );

    console.log('✅ Compatibility engine result:');
    console.log('- Valid:', result.isValid);
    console.log('- Errors:', result.errors?.length || 0);
    console.log('- Warnings:', result.warnings?.length || 0);
    console.log('- Compatibility warnings:', result.compatibilityWarnings?.length || 0);

    if (result.errors && result.errors.length > 0) {
      console.log('\n❌ Error details:');
      result.errors.forEach((error, index) => {
        console.log(`  ${index + 1}. ${error.code}: ${error.message}`);
        if (error.path) {
          console.log(`     Path: ${error.path}`);
        }
      });
    }

    if (result.isValid && result.normalized) {
      const normalized = result.normalized;
      console.log('\n📋 Normalized configuration structure:');
      console.log('- providers location:', Object.keys(normalized));
      console.log('- virtualrouter.providers:', Object.keys(normalized.virtualrouter?.providers || {}));

      // Check if providers were moved correctly
      if (normalized.virtualrouter?.providers?.lmstudio) {
        console.log('✅ Providers successfully moved to virtualrouter.providers');
      } else {
        console.log('❌ Providers were not moved correctly');
      }

      // Test route target parsing
      console.log('\n🎯 Testing route target parsing...');
      const routeTarget = testConfig.virtualrouter.routing.default[0];
      console.log('- Route target:', routeTarget);

      const providerId = routeTarget.split('.')[0];
      console.log('- Extracted provider ID:', providerId);

      if (normalized.virtualrouter?.providers?.[providerId]) {
        console.log('✅ Provider found in normalized config');
      } else {
        console.log('❌ Provider not found in normalized config');
        console.log('- Available providers:', Object.keys(normalized.virtualrouter?.providers || {}));
      }
    }

    console.log('\n🎉 Configuration transformation test completed successfully!');

  } catch (error) {
    console.error('\n❌ Configuration transformation test failed:', error);
    console.error('Error details:', error instanceof Error ? error.message : String(error));
    console.error('Stack:', error instanceof Error ? error.stack : 'No stack trace available');
  }
}

// Run the test
testConfigTransformation().then(success => {
  process.exit(success ? 0 : 1);
}).catch(error => {
  console.error('Test execution failed:', error);
  process.exit(1);
});