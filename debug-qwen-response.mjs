#!/usr/bin/env node

/**
 * Debug Qwen Provider Response
 * 调试Qwen Provider响应处理
 */

import { QwenProvider } from './dist/modules/pipeline/modules/provider/qwen-provider.js';
import { PipelineDebugLogger } from './dist/modules/pipeline/utils/debug-logger.js';
import fs from 'fs/promises';

// 创建测试依赖
const logger = new PipelineDebugLogger('qwen-debug-test');
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

// 加载有效的token
async function loadValidToken() {
  try {
    const tokenContent = await fs.readFile(path.join(homedir(), '.qwen', 'oauth_creds.json'), 'utf8');
    const tokenData = JSON.parse(tokenContent);
    return tokenData;
  } catch (error) {
    console.error('❌ Failed to load token:', error.message);
    throw error;
  }
}

// 创建Provider配置
function createProviderConfig(tokenData) {
  return {
  type: 'qwen-provider',
    config: {
      baseUrl: 'https://portal.qwen.ai/v1',
      auth: {
        oauth: {
          clientId: 'f0304373b74a44d2b584a3fb70ca9e56',
          deviceCodeUrl: 'https://chat.qwen.ai/api/v1/oauth2/device/code',
          tokenUrl: 'https://chat.qwen.ai/api/v1/oauth2/token',
          scopes: ['openid', 'profile', 'email', 'model.completion'],
          tokenFile: path.join(homedir(), '.qwen', 'oauth_creds.json')
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
}

async function debugProviderResponse() {
  console.log('🔧 Debugging Qwen Provider Response...\n');

  try {
    // 加载有效token
    const tokenData = await loadValidToken();
    console.log('✅ Token loaded successfully');

    // 创建provider配置
    const providerConfig = createProviderConfig(tokenData);
    const moduleConfig = {
      id: 'qwen-debug-test',
      type: 'qwen-provider',
      config: providerConfig.config
    };

    // 创建provider实例
    const provider = new QwenProvider(moduleConfig, dependencies);
    provider.setTestMode(true);

    console.log('Step 1: Initializing provider...');
    await provider.initialize();
    console.log('✅ Provider initialized successfully');

    // 测试简单的工具调用请求
    console.log('\nStep 2: Testing tool calling request...');
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

    // 调用provider并检查完整响应
    console.log('Step 3: Calling provider.processIncoming...');
    const response = await provider.processIncoming(toolRequest);

    console.log('\n🔍 DEBUG - Complete Response Object:');
    console.log('Response type:', typeof response);
    console.log('Response value:', response);
    console.log('Response keys:', Object.keys(response || {}));

    // 检查响应结构
    if (response && response.data) {
      console.log('\n🔍 DEBUG - Response.data structure:');
      console.log('data type:', typeof response.data);
      console.log('data keys:', Object.keys(response.data));
      console.log('data choices:', response.data.choices);
      console.log('data usage:', response.data.usage);
    } else {
      console.log('\n❌ No response.data found!');
    }

    // 检查原始Provider响应
    console.log('\nStep 4: Testing direct sendChatRequest...');
    const rawResponse = await provider.sendRequest(toolRequest);
    console.log('Raw response type:', typeof rawResponse);
    console.log('Raw response:', rawResponse);

    if (rawResponse && rawResponse.data) {
      console.log('Raw response data:', rawResponse.data);
      console.log('Raw response choices:', rawResponse.data.choices);
    }

    console.log('\n🎉 Debug Complete');

  } catch (error) {
    console.error('❌ Debug failed with error:', error);
    console.error('Stack:', error.stack);
  }
}

// 运行调试
debugProviderResponse();
