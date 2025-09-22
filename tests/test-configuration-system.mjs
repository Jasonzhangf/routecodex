#!/usr/bin/env node

/**
 * Configuration System Test Script
 * Tests the module-based configuration system functionality
 */

import { ModuleConfigReader } from '../dist/utils/module-config-reader.js';

async function testConfigurationSystem() {
  console.log('🧪 Testing Configuration System...\n');

  try {
    // Test 1: ModuleConfigReader instantiation
    console.log('Test 1: ModuleConfigReader instantiation');
    const configReader = new ModuleConfigReader();
    console.log('✅ ModuleConfigReader instantiated successfully\n');

    // Test 2: Load configuration
    console.log('Test 2: Load configuration');
    const config = await configReader.load();
    console.log('✅ Configuration loaded successfully');
    console.log('   Configuration keys:', Object.keys(config));
    console.log('   Modules:', Object.keys(config.modules));
    console.log('');

    // Test 3: Get HTTP server configuration
    console.log('Test 3: Get HTTP server configuration');
    const httpServerConfig = configReader.getModuleConfigValue('httpserver');
    if (httpServerConfig) {
      console.log('✅ HTTP server configuration retrieved');
      console.log('   Port:', httpServerConfig.port);
      console.log('   Host:', httpServerConfig.host);
      console.log('   CORS:', httpServerConfig.cors);
    } else {
      console.log('❌ HTTP server configuration not found');
    }
    console.log('');

    // Test 4: Get enabled modules
    console.log('Test 4: Get enabled modules');
    const enabledModules = configReader.getEnabledModules();
    console.log('✅ Enabled modules:', enabledModules);
    console.log('');

    // Test 5: Check if modules are enabled
    console.log('Test 5: Check module enable status');
    const isHttpServerEnabled = configReader.isModuleEnabled('httpserver');
    const isConfigManagerEnabled = configReader.isModuleEnabled('configmanager');
    console.log('   HTTP server enabled:', isHttpServerEnabled);
    console.log('   Config manager enabled:', isConfigManagerEnabled);
    console.log('✅ Module enable status checks completed');
    console.log('');

    // Test 6: Get module configuration
    console.log('Test 6: Get module configuration');
    const providerManagerConfig = configReader.getModuleConfig('providermanager');
    if (providerManagerConfig) {
      console.log('✅ Provider manager configuration retrieved');
      console.log('   Enabled:', providerManagerConfig.enabled);
      console.log('   Config type:', providerManagerConfig.config.moduleType);
    } else {
      console.log('❌ Provider manager configuration not found');
    }
    console.log('');

    console.log('🎉 Configuration system tests completed successfully!');

  } catch (error) {
    console.error('❌ Configuration system test failed:', error);
    process.exit(1);
  }
}

// Run tests
testConfigurationSystem();