#!/usr/bin/env node

/**
 * Check Tool Calls in Qwen Provider Response
 * 检查Qwen Provider响应中的工具调用
 */

import { QwenProvider } from './dist/modules/pipeline/modules/provider/qwen-provider.js';
import { PipelineDebugLogger } from './dist/modules/pipeline/utils/debug-logger.js';
import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';

// 创建测试依赖
const logger = new PipelineDebugLogger('qwen-tools-check');
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

async function checkToolCalls() {
  console.log('🔧 Checking Tool Calls in Qwen Provider...\n');

  try {
    // 加载有效token
    const tokenData = await loadValidToken();
    console.log('✅ Token loaded successfully');

    // 创建provider配置
    const providerConfig = createProviderConfig(tokenData);
    const moduleConfig = {
      id: 'qwen-tools-check',
      type: 'qwen-provider',
      config: providerConfig.config
    };

    // 创建provider实例
    const provider = new QwenProvider(moduleConfig, dependencies);
    provider.setTestMode(true);

    console.log('Step 1: Initializing provider...');
    await provider.initialize();
    console.log('✅ Provider initialized successfully');

    // 测试工具调用请求
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

    // 调用provider
    console.log('Step 3: Calling provider...');
    const response = await provider.processIncoming(toolRequest);

    console.log('\n🔍 CHECKING RESPONSE STRUCTURE:');
    console.log('Response type:', typeof response);
    console.log('Has choices:', !!response.choices);
    console.log('Choices length:', response.choices?.length || 0);

    if (response.choices && response.choices.length > 0) {
      const choice = response.choices[0];
      console.log('\n🔍 CHECKING CHOICE:');
      console.log('Choice finish_reason:', choice.finish_reason);
      console.log('Has message:', !!choice.message);

      if (choice.message) {
        console.log('Message role:', choice.message.role);
        console.log('Message content length:', choice.message.content?.length || 0);
        console.log('Has tool_calls:', !!choice.message.tool_calls);
        console.log('Tool calls length:', choice.message.tool_calls?.length || 0);

        if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
          console.log('\n🎉 TOOL CALLS FOUND:');
          choice.message.tool_calls.forEach((tool, index) => {
            console.log(`  Tool ${index + 1}:`);
            console.log(`    ID: ${tool.id}`);
            console.log(`    Type: ${tool.type}`);
            console.log(`    Function: ${tool.function.name}`);
            console.log(`    Arguments: ${JSON.stringify(tool.function.arguments)}`);
          });
        } else {
          console.log('\n❌ NO TOOL CALLS FOUND');
        }
      }
    }

    console.log('\n🔍 USAGE INFO:');
    console.log('Usage:', response.usage);

    console.log('\n🎉 Tool Call Check Complete');

  } catch (error) {
    console.error('❌ Check failed with error:', error);
    console.error('Stack:', error.stack);
  }
}

// 运行检查
checkToolCalls();
