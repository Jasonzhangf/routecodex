/**
 * Test GLM provider functionality
 */

import { OpenAIProvider } from './dist/modules/pipeline/modules/provider/openai-provider.js';
import { PipelineModuleRegistryImpl } from './dist/modules/pipeline/core/pipeline-registry.js';
import { PipelineModuleRegistrar } from './dist/modules/pipeline/core/module-registrar.js';

async function testGLMProvider() {
  console.log('🧪 Testing GLM Provider Configuration...');

  // Check environment variable
  const apiKey = process.env.GLM_API_KEY;
  if (!apiKey) {
    console.log('⚠️ GLM_API_KEY environment variable not set');
    console.log('📝 Please set: export GLM_API_KEY=your-api-key');
    console.log('🔄 Continuing with test mode...');
  }

  // Create mock dependencies
  const mockLogger = {
    logModule: (id, action, data = {}) => {
      console.log(`[${id}] ${action}`, data);
    }
  };

  const mockDependencies = {
    logger: mockLogger,
    errorHandlingCenter: {},
    debugCenter: {}
  };

  try {
    // Test 1: Create provider instance
    console.log('\n📋 Test 1: Creating GLM Provider instance...');

    const providerConfig = {
      type: 'openai-provider',
      config: {
        id: 'glm-provider',
        type: 'openai',
        baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        auth: {
          type: 'apikey',
          apiKey: apiKey || 'test-key'
        },
        models: {
          'glm-4': {
            enabled: true,
            maxTokens: 8192
          }
        },
        compatibility: {
          timeout: 30000
        }
      }
    };

    const provider = new OpenAIProvider(providerConfig, mockDependencies);
    console.log('✅ GLM Provider instance created successfully');
    console.log('📊 Provider status:', provider.getStatus());

    // Test 2: Module registry
    console.log('\n📋 Test 2: Testing module registry...');

    const registry = new PipelineModuleRegistryImpl();
    const registrar = new PipelineModuleRegistrar(registry);

    console.log('📝 Available module types:', registrar.getRegisteredTypes());
    console.log('✅ Module registry initialized');

    // Test 3: Provider initialization (with API key)
    if (apiKey) {
      console.log('\n📋 Test 3: Testing provider initialization...');
      try {
        await provider.initialize();
        console.log('✅ Provider initialized successfully');

        // Test 4: Health check
        console.log('\n📋 Test 4: Testing health check...');
        const isHealthy = await provider.checkHealth();
        console.log('🏥 Health check result:', isHealthy ? '✅ Healthy' : '❌ Unhealthy');

        // Test 5: Simple request
        console.log('\n📋 Test 5: Testing chat completion request...');
        const testRequest = {
          model: 'glm-4',
          messages: [
            { role: 'user', content: 'Hello! Please respond in English with a brief greeting.' }
          ],
          max_tokens: 100,
          temperature: 0.7
        };

        const response = await provider.sendRequest(testRequest);
        console.log('✅ Request sent successfully');
        console.log('📊 Response status:', response.status);
        console.log('📊 Response metadata:', response.metadata);

        if (response.data && response.data.choices && response.data.choices.length > 0) {
          const message = response.data.choices[0].message;
          console.log('💬 AI Response:', message.content);
          console.log('✅ Chat completion working correctly');
        } else {
          console.log('⚠️ Unexpected response format');
        }

      } catch (error) {
        console.log('❌ Provider test failed:', error.message);
        if (error && error.message && error.message.includes('401')) {
          console.log('🔑 Authentication failed - check API key');
        } else if (error && error.message && error.message.includes('timeout')) {
          console.log('⏱️ Request timeout - check network connection');
        } else if (error && error.message && error.message.includes('429')) {
          console.log('💰 Rate limit or balance issue - check account status');
        } else {
          console.log('🔍 Unknown error - check configuration');
        }
      }
    } else {
      console.log('\n⚠️ Skipping provider initialization tests (no API key)');
    }

    // Test 6: Configuration validation
    console.log('\n📋 Test 6: Testing configuration structure...');

    // Load configuration from file
    const fs = await import('fs');
    if (fs.existsSync('./config/glm-provider-config.json')) {
      const configData = fs.readFileSync('./config/glm-provider-config.json', 'utf8');
      const config = JSON.parse(configData);

      console.log('✅ Configuration file loaded successfully');
      console.log('📊 Provider count:', Object.keys(config.providers).length);
      console.log('📊 Pipeline count:', config.pipelines.length);
      console.log('📊 Dynamic routing enabled:', config.dynamicRouting.enabled);

      // Validate GLM provider configuration
      const glmProvider = config.providers['glm-provider'];
      if (glmProvider) {
        console.log('✅ GLM provider found in configuration');
        console.log('📊 Base URL:', glmProvider.baseUrl);
        console.log('📊 Available models:', Object.keys(glmProvider.models).join(', '));
      } else {
        console.log('❌ GLM provider not found in configuration');
      }
    } else {
      console.log('❌ Configuration file not found');
    }

    // Cleanup
    try {
      await provider.cleanup();
      console.log('✅ Provider cleaned up successfully');
    } catch (cleanupError) {
      console.log('⚠️ Cleanup failed:', cleanupError.message);
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Stack:', error.stack);
  }

  console.log('\n🎉 GLM Provider test completed');
  console.log('\n📋 Usage Instructions:');
  console.log('1. Set environment variable: export GLM_API_KEY=your-api-key');
  console.log('2. Use configuration: config/glm-provider-config.json');
  console.log('3. Start server: routecodex start --config config/glm-provider-config.json');
}

// Run the test
testGLMProvider().catch(console.error);