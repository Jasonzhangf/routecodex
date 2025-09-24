/**
 * Simple test for OpenAI provider module
 */

import { OpenAIProvider } from './dist/modules/pipeline/modules/provider/openai-provider.js';

async function testOpenAIProvider() {
  console.log('🧪 Testing OpenAI Provider...');

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

  // Create provider configuration
  const providerConfig = {
    type: 'openai-provider',
    config: {
      id: 'openai-test',
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      auth: {
        type: 'apikey',
        apiKey: process.env.OPENAI_API_KEY || 'sk-test-key'
      },
      models: {
        'gpt-3.5-turbo': {
          enabled: true,
          maxTokens: 4096
        }
      }
    }
  };

  try {
    // Create provider instance
    const provider = new OpenAIProvider(providerConfig, mockDependencies);

    console.log('✅ Provider created successfully');
    console.log('📋 Provider status:', provider.getStatus());

    // Initialize provider (will fail without valid API key, but should handle gracefully)
    try {
      await provider.initialize();
      console.log('✅ Provider initialized successfully');

      // Test health check
      const isHealthy = await provider.checkHealth();
      console.log('🏥 Health check result:', isHealthy);

      // Test a simple request (will fail without valid API key)
      try {
        const testRequest = {
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'user', content: 'Hello, this is a test!' }
          ]
        };

        const response = await provider.sendRequest(testRequest);
        console.log('✅ Request sent successfully');
        console.log('📊 Response status:', response.status);
        console.log('📊 Response metadata:', response.metadata);
      } catch (requestError) {
        console.log('⚠️ Request failed (expected without valid API key):', requestError.message);
      }

    } catch (initError) {
      console.log('⚠️ Initialization failed (expected without valid API key):', initError.message);
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

  console.log('🎉 OpenAI Provider test completed');
}

// Run the test
testOpenAIProvider().catch(console.error);