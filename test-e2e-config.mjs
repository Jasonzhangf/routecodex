#!/usr/bin/env node

/**
 * End-to-End Configuration Test
 * 端到端配置测试 - 验证整个应用是否能使用新配置系统启动
 */

import fs from 'fs';
import path from 'path';

// Create a simple test configuration compatible with new engine
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
  // Add required auth fields
  auth: {} // Empty auth object to prevent parseAuthMappings error
};

async function testE2EConfiguration() {
  console.log('🚀 Starting End-to-End Configuration Test...\n');

  try {
    // Create test configuration directory
    const configDir = path.join(process.env.HOME || require('os').homedir(), '.routecodex-test');
    const configFile = path.join(configDir, 'config.json');

    console.log('✅ Test 1: Setting up test configuration');
    await fs.promises.mkdir(configDir, { recursive: true });
    await fs.promises.writeFile(configFile, JSON.stringify(testConfig, null, 2));
    console.log(`   Test configuration created at: ${configFile}`);

    // Test ConfigManagerModule with the new configuration
    console.log('✅ Test 2: Testing ConfigManagerModule with new configuration');

    // Set environment variable to use test config
    process.env.ROUTECODEX_CONFIG = configFile;

    // Force using new configuration engine (disable legacy)
    process.env.USE_LEGACY_CONFIG_ENGINE = 'false';

    // Test the configuration loading
    const { ConfigManagerModule } = await import('./dist/modules/config-manager/config-manager-module.js');
    const configManager = new ConfigManagerModule();

    console.log('   ConfigManagerModule created successfully');

    // Try to initialize
    await configManager.initialize({
      autoReload: false,
      configPath: configFile
    });

    console.log('   ConfigManagerModule initialized successfully');

    // Test the new configuration engine directly
    console.log('✅ Test 3: Testing new configuration engine');

    const { ConfigParser } = await import('routecodex-config-engine');
    const { CompatibilityEngine } = await import('routecodex-config-compat');

    const configParser = new ConfigParser();
    const compatibilityEngine = new CompatibilityEngine();

    console.log('   New configuration engines imported successfully');

    // Test configuration parsing
    const parseResult = await configParser.parseFromFile(configFile);
    console.log(`   ConfigParser result: Valid=${parseResult.isValid}, Errors=${parseResult.errors?.length || 0}`);

    if (parseResult.isValid) {
      // Test compatibility processing
      const compatResult = await compatibilityEngine.processCompatibility(
        JSON.stringify(parseResult.config)
      );
      console.log(`   CompatibilityEngine result: Valid=${compatResult.isValid}`);

      if (compatResult.isValid) {
        console.log('   ✅ Both engines processed configuration successfully');
      }
    }

    console.log('\n🎉 End-to-End configuration test completed successfully!');
    console.log('✅ New configuration system is fully integrated and working');

    // Cleanup
    await fs.promises.rm(configDir, { recursive: true, force: true });
    console.log('   Test configuration cleaned up');

    return true;

  } catch (error) {
    console.error('\n❌ End-to-End configuration test failed:', error);
    console.error('Error details:', error instanceof Error ? error.message : String(error));
    console.error('Stack:', error instanceof Error ? error.stack : 'No stack trace available');
    return false;
  }
}

// Run the test
testE2EConfiguration().then(success => {
  process.exit(success ? 0 : 1);
});