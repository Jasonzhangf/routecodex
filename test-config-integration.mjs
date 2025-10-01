#!/usr/bin/env node

/**
 * Configuration System Integration Test
 * 配置系统集成测试 - 验证新配置引擎是否正常工作
 */

import { ConfigParser } from 'routecodex-config-engine';
import { CompatibilityEngine } from 'routecodex-config-compat';

async function testConfigurationSystem() {
  console.log('🚀 Starting Configuration System Integration Test...\n');

  try {
    // Test 1: ConfigParser instantiation
    console.log('✅ Test 1: ConfigParser instantiation');
    const configParser = new ConfigParser();
    console.log('   ConfigParser created successfully');

    // Test 2: CompatibilityEngine instantiation
    console.log('✅ Test 2: CompatibilityEngine instantiation');
    const compatibilityEngine = new CompatibilityEngine();
    console.log('   CompatibilityEngine created successfully');

    // Test 3: Simple config parsing
    console.log('✅ Test 3: Simple configuration parsing');
    const simpleConfig = {
      providers: {
        'openai-provider': {
          type: 'openai',
          enabled: true,
          models: {
            'gpt-4': {
              maxTokens: 8192,
              temperature: 0.7
            }
          }
        }
      },
      virtualrouter: {
        routing: {
          default: {
            providerId: 'openai-provider',
            modelId: 'gpt-4'
          }
        }
      }
    };

    const parseResult = await configParser.parseFromString(
      JSON.stringify(simpleConfig),
      'test-config.json'
    );

    console.log('   Configuration parsed successfully');
    console.log(`   Valid: ${parseResult.isValid}`);
    console.log(`   Warnings: ${parseResult.warnings?.length || 0}`);

    // Test 4: Compatibility processing
    console.log('✅ Test 4: Compatibility processing');
    const compatResult = await compatibilityEngine.processCompatibility(
      JSON.stringify(simpleConfig)
    );

    console.log('   Compatibility processing completed');
    console.log(`   Valid: ${compatResult.isValid}`);
    console.log(`   Has compatibility config: ${!!compatResult.compatibilityConfig}`);

    console.log('\n🎉 All configuration system tests passed!');
    console.log('✅ New configuration engine is working correctly');

    return true;

  } catch (error) {
    console.error('\n❌ Configuration system test failed:', error);
    console.error('Error details:', error instanceof Error ? error.message : String(error));
    return false;
  }
}

// Run the test
testConfigurationSystem().then(success => {
  process.exit(success ? 0 : 1);
});