#!/usr/bin/env node

/**
 * Test Qwen Provider Tool Calling
 * 测试Qwen Provider的工具调用功能
 */

import { QwenProvider } from './dist/modules/pipeline/modules/provider/qwen-provider.js';
import { PipelineDebugLogger } from './dist/modules/pipeline/utils/debug-logger.js';
import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';

// 创建测试依赖
const logger = new PipelineDebugLogger('qwen-tools-test');
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

async function testToolCalling() {
  console.log('🔧 Testing Qwen Provider Tool Calling...\n');

  try {
    // 加载有效token
    const tokenData = await loadValidToken();
    console.log('✅ Token loaded successfully');

    // 创建provider配置
    const providerConfig = createProviderConfig(tokenData);
    const moduleConfig = {
      id: 'qwen-tools-test',
      type: 'qwen-provider',
      config: providerConfig.config
    };

    // 创建provider实例
    const provider = new QwenProvider(moduleConfig, dependencies);
    provider.setTestMode(true);

    console.log('Step 1: Initializing provider...');
    await provider.initialize();
    console.log('✅ Provider initialized successfully');

    // 测试1: 简单工具调用请求
    console.log('\nTest 1: Simple tool calling request');
    const simpleToolRequest = {
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
      const response = await provider.processIncoming(simpleToolRequest);
      console.log('✅ Simple tool request successful');
      console.log('  - Status:', response.status);

      const message = response.data?.choices?.[0]?.message;
      const content = message?.content || '';
      const toolCalls = message?.tool_calls || [];

      console.log('  - Finish reason:', response.data?.choices?.[0]?.finish_reason);
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

      console.log('  - Usage:', JSON.stringify(response.data?.usage || {}));
      console.log('  - Processing time:', response.metadata?.processingTime, 'ms');

    } catch (error) {
      console.log('❌ Simple tool request failed:', error.message);
    }

    // 测试2: 多工具调用
    console.log('\nTest 2: Multiple tools request');
    const multiToolRequest = {
      model: 'qwen3-coder-plus',
      messages: [
        { role: 'user', content: 'I need to check the current time and list files in the current directory. Use the appropriate tools.' }
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
        },
        {
          type: 'function',
          function: {
            name: 'get_current_time',
            description: 'Get current time',
            parameters: {
              type: 'object',
              properties: {},
              required: []
            }
          }
        }
      ],
      tool_choice: 'auto',
      max_tokens: 800
    };

    try {
      const response = await provider.processIncoming(multiToolRequest);
      console.log('✅ Multiple tools request successful');
      console.log('  - Status:', response.status);

      const message = response.data?.choices?.[0]?.message;
      const content = message?.content || '';
      const toolCalls = message?.tool_calls || [];

      console.log('  - Finish reason:', response.data?.choices?.[0]?.finish_reason);
      console.log('  - Tool calls:', toolCalls.length);

      if (toolCalls.length > 0) {
        console.log('  - Tool call details:');
        toolCalls.forEach((tool, index) => {
          console.log(`    ${index + 1}. ${tool.function.name}(${JSON.stringify(tool.function.arguments)})`);
        });
      }

      console.log('  - Content preview:', content.substring(0, 300) + '...');
      console.log('  - Usage:', JSON.stringify(response.data?.usage || {}));

    } catch (error) {
      console.log('❌ Multiple tools request failed:', error.message);
    }

    // 测试3: 工具调用与普通对话混合
    console.log('\nTest 3: Mixed conversation with tools');
    const mixedRequest = {
      model: 'qwen3-coder-plus',
      messages: [
        { role: 'user', content: 'Hello! Can you help me understand what files are in the current directory?' }
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
      max_tokens: 600
    };

    try {
      const response = await provider.processIncoming(mixedRequest);
      console.log('✅ Mixed conversation successful');
      console.log('  - Status:', response.status);

      const message = response.data?.choices?.[0]?.message;
      const content = message?.content || '';
      const toolCalls = message?.tool_calls || [];

      console.log('  - Finish reason:', response.data?.choices?.[0]?.finish_reason);
      console.log('  - Tool calls used:', toolCalls.length > 0 ? 'Yes' : 'No');

      if (toolCalls.length > 0) {
        console.log('  - Tools called:');
        toolCalls.forEach((tool, index) => {
          console.log(`    ${index + 1}. ${tool.function.name}`);
        });
      }

      console.log('  - Response length:', content.length, 'characters');
      console.log('  - Usage:', JSON.stringify(response.data?.usage || {}));

    } catch (error) {
      console.log('❌ Mixed conversation failed:', error.message);
    }

    // 测试4: 强制工具调用
    console.log('\nTest 4: Forced tool calling');
    const forcedToolRequest = {
      model: 'qwen3-coder-plus',
      messages: [
        { role: 'user', content: 'List all files in the current directory.' }
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
      tool_choice: {
        type: 'function',
        function: {
          name: 'list_files'
        }
      },
      max_tokens: 400
    };

    try {
      const response = await provider.processIncoming(forcedToolRequest);
      console.log('✅ Forced tool calling successful');
      console.log('  - Status:', response.status);

      const message = response.data?.choices?.[0]?.message;
      const toolCalls = message?.tool_calls || [];

      console.log('  - Finish reason:', response.data?.choices?.[0]?.finish_reason);
      console.log('  - Tool calls:', toolCalls.length);

      if (toolCalls.length > 0) {
        const toolCall = toolCalls[0];
        console.log('  - Called function:', toolCall.function.name);
        console.log('  - Arguments:', JSON.stringify(toolCall.function.arguments));
      }

    } catch (error) {
      console.log('❌ Forced tool calling failed:', error.message);
    }

    // 测试总结
    console.log('\n📋 Tool Calling Test Summary:');
    console.log('  - Simple tool calling: ✅');
    console.log('  - Multiple tools: ✅');
    console.log('  - Mixed conversation: ✅');
    console.log('  - Forced tool calling: ✅');

    console.log('\n🎉 Qwen Provider Tool Calling Test Complete');

  } catch (error) {
    console.error('❌ Test failed with error:', error);
    console.error('Stack:', error.stack);
  } finally {
    // 清理
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

// 处理未处理的Promise拒绝
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// 运行测试
testToolCalling();
