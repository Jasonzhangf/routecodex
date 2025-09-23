#!/usr/bin/env node

/**
 * Direct Qwen Provider Response Test
 * Tests Qwen provider responses starting from the provider level
 */

import { QwenProvider } from './dist/modules/pipeline/modules/provider/qwen-provider.js';
import { PipelineDebugLogger } from './dist/modules/pipeline/utils/debug-logger.js';

// Create test dependencies
const logger = new PipelineDebugLogger('qwen-provider-test');
const dependencies = {
  logger,
  errorHandlingCenter: {
    handleError: async (error) => {
      console.log('Error handled:', error);
    }
  },
  dispatchCenter: {
    notify: async (notification) => {
      console.log('Dispatch center notified:', notification);
    }
  }
};

// Test configuration
const providerConfig = {
  type: 'qwen-provider',
  config: {
    baseUrl: 'https://chat.qwen.ai',
    auth: {
      oauth: {
        clientId: 'f0304373b74a44d2b584a3fb70ca9e56',
        deviceCodeUrl: 'https://chat.qwen.ai/api/v1/oauth2/device/code',
        tokenUrl: 'https://chat.qwen.ai/api/v1/oauth2/token',
        scopes: ['openid', 'profile', 'email', 'model.completion'],
        tokenFile: `${process.env.HOME}/.qwen/oauth_creds.json`
      }
    },
    models: {
      'qwen3-coder-plus': {
        maxTokens: 131072,
        temperature: 0.7,
        supportsStreaming: true,
        supportsTools: true
      }
    },
    timeout: 60000,
    retryAttempts: 3
  }
};

const moduleConfig = {
  id: 'qwen-provider-test',
  type: 'qwen-provider',
  config: providerConfig.config
};

async function testQwenProviderResponses() {
  console.log('🔧 Testing Qwen Provider Responses...\n');

  try {
    // Create provider instance
    const provider = new QwenProvider(moduleConfig, dependencies);

    // Set test mode to prevent browser opening
    provider.setTestMode(true);

    console.log('Step 1: Initializing provider...');
    await provider.initialize();
    console.log('✅ Provider initialized successfully\n');

    // Check provider status
    const status = provider.getStatus();
    console.log('Step 2: Provider status:', JSON.stringify(status, null, 2));
    console.log('');

    // Test 1: Simple chat request
    console.log('Test 1: Simple chat request');
    const simpleRequest = {
      model: 'qwen3-coder-plus',
      messages: [
        { role: 'user', content: 'Hello! Please respond with just "Qwen provider test successful"' }
      ],
      max_tokens: 50,
      temperature: 0.7
    };

    try {
      const simpleResponse = await provider.processIncoming(simpleRequest);
      console.log('✅ Simple chat request successful');
      console.log('  - Status:', simpleResponse.status);
      console.log('  - Model:', simpleResponse.data?.model);
      console.log('  - Content:', simpleResponse.data?.choices?.[0]?.message?.content?.substring(0, 100));
      console.log('  - Usage:', JSON.stringify(simpleResponse.data?.usage || {}));
      console.log('  - Processing time:', simpleResponse.metadata?.processingTime, 'ms');
      console.log('');
    } catch (error) {
      console.log('❌ Simple chat request failed:', error.message);
      console.log('');
    }

    // Test 2: Tool calling request
    console.log('Test 2: Tool calling request');
    const toolRequest = {
      model: 'qwen3-coder-plus',
      messages: [
        { role: 'user', content: 'What files are in the current directory? Use the list_files tool.' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'list_files',
            description: 'List files in directory',
            parameters: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: 'Directory path (optional, defaults to current directory)'
                }
              },
              required: []
            }
          }
        }
      ],
      tool_choice: 'auto',
      max_tokens: 500
    };

    try {
      const toolResponse = await provider.processIncoming(toolRequest);
      console.log('✅ Tool calling request successful');
      console.log('  - Status:', toolResponse.status);
      console.log('  - Finish reason:', toolResponse.data?.choices?.[0]?.finish_reason);

      const message = toolResponse.data?.choices?.[0]?.message;
      const content = message?.content || '';
      const toolCalls = message?.tool_calls || [];

      console.log('  - Content length:', content.length, 'characters');
      console.log('  - Tool calls:', toolCalls.length);

      if (toolCalls.length > 0) {
        console.log('  - Tool call details:');
        toolCalls.forEach((tool, index) => {
          console.log(`    ${index + 1}. ${tool.function.name}(${JSON.stringify(tool.function.arguments)})`);
        });
      }

      if (content) {
        console.log('  - Content preview:', content.substring(0, 200) + '...');
      }

      console.log('  - Usage:', JSON.stringify(toolResponse.data?.usage || {}));
      console.log('  - Processing time:', toolResponse.metadata?.processingTime, 'ms');
      console.log('');
    } catch (error) {
      console.log('❌ Tool calling request failed:', error.message);
      console.log('');
    }

    // Test 3: Health check
    console.log('Test 3: Health check');
    try {
      const isHealthy = await provider.checkHealth();
      console.log('✅ Health check completed');
      console.log('  - Health status:', isHealthy ? 'Healthy' : 'Unhealthy');

      const metrics = await provider.getMetrics();
      console.log('  - Request metrics:', JSON.stringify(metrics, null, 2));
      console.log('');
    } catch (error) {
      console.log('❌ Health check failed:', error.message);
      console.log('');
    }

    // Test 4: Check token validation
    console.log('Test 4: Token validation');
    try {
      // Access private method for testing
      const isValid = await provider.validateToken();
      console.log('✅ Token validation completed');
      console.log('  - Token valid:', isValid);
      console.log('');
    } catch (error) {
      console.log('❌ Token validation failed:', error.message);
      console.log('');
    }

    // Summary
    console.log('📋 Test Summary:');
    console.log('  - Provider initialization: ✅');
    console.log('  - Simple chat request: ' + (simpleResponse?.ok ? '✅' : '❌'));
    console.log('  - Tool calling request: ' + (toolResponse?.ok ? '✅' : '❌'));
    console.log('  - Health check: ' + (isHealthy !== undefined ? '✅' : '❌'));
    console.log('  - Token validation: ' + (isValid !== undefined ? '✅' : '❌'));
    console.log('');

    console.log('🎉 Qwen Provider Response Test Complete');

  } catch (error) {
    console.error('❌ Test failed with error:', error);
    console.error('Stack:', error.stack);
  } finally {
    // Cleanup
    if (provider) {
      try {
        await provider.cleanup();
        console.log('✅ Provider cleanup completed');
      } catch (cleanupError) {
        console.log('⚠️  Cleanup error:', cleanupError.message);
      }
    }
  }
}

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Run the test
testQwenProviderResponses();
