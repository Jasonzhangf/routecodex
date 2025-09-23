#!/usr/bin/env node

/**
 * Direct Qwen API Tool Calling Test
 * 直接测试Qwen API的工具调用功能
 */

import fs from 'fs/promises';

// 加载有效的token
async function loadValidToken() {
  try {
    const tokenContent = await fs.readFile('/Users/fanzhang/.qwen/oauth_creds.json', 'utf8');
    const tokenData = JSON.parse(tokenContent);
    return tokenData;
  } catch (error) {
    console.error('❌ Failed to load token:', error.message);
    throw error;
  }
}

async function testDirectQwenTools() {
  console.log('🔧 Testing Direct Qwen API Tool Calling...\n');

  try {
    // 加载有效token
    const tokenData = await loadValidToken();
    console.log('✅ Token loaded successfully');

    const authHeader = `Bearer ${tokenData.access_token}`;

    // 测试1: 简单工具调用
    console.log('\nTest 1: Simple tool calling');
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

    const response = await fetch('https://portal.qwen.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
        'User-Agent': 'google-api-nodejs-client/9.15.1',
        'X-Goog-Api-Client': 'gl-node/22.17.0',
        'Client-Metadata': 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI',
        'Accept': 'application/json'
      },
      body: JSON.stringify(toolRequest)
    });

    console.log('  - Status:', response.status);

    if (response.ok) {
      const data = await response.json();
      console.log('✅ Direct tool call successful');
      console.log('  - Model:', data.model);
      console.log('  - Finish reason:', data.choices?.[0]?.finish_reason);

      const message = data.choices?.[0]?.message;
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
        console.log('  - Content:', content);
      }

      console.log('  - Usage:', JSON.stringify(data.usage || {}));
    } else {
      const errorText = await response.text();
      console.log('❌ Direct tool call failed:', errorText);
    }

    // 测试2: 没有工具的普通对话
    console.log('\nTest 2: Normal conversation without tools');
    const normalRequest = {
      model: 'qwen3-coder-plus',
      messages: [
        { role: 'user', content: 'Hello! Please respond with just "Hello from Qwen"' }
      ],
      max_tokens: 50
    };

    const normalResponse = await fetch('https://portal.qwen.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
        'User-Agent': 'google-api-nodejs-client/9.15.1',
        'X-Goog-Api-Client': 'gl-node/22.17.0',
        'Client-Metadata': 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI',
        'Accept': 'application/json'
      },
      body: JSON.stringify(normalRequest)
    });

    console.log('  - Status:', normalResponse.status);

    if (normalResponse.ok) {
      const normalData = await normalResponse.json();
      console.log('✅ Normal conversation successful');
      console.log('  - Model:', normalData.model);
      console.log('  - Response:', normalData.choices?.[0]?.message?.content);
      console.log('  - Usage:', JSON.stringify(normalData.usage || {}));
    } else {
      const errorText = await normalResponse.text();
      console.log('❌ Normal conversation failed:', errorText);
    }

    // 测试3: 检查Qwen是否支持工具调用
    console.log('\nTest 3: Checking Qwen models that support tools');
    const modelsResponse = await fetch('https://portal.qwen.ai/v1/models', {
      method: 'GET',
      headers: {
        'Authorization': authHeader,
        'Accept': 'application/json'
      }
    });

    console.log('  - Models Status:', modelsResponse.status);

    if (modelsResponse.ok) {
      const modelsData = await modelsResponse.json();
      console.log('✅ Models retrieved successfully');
      console.log('  - Available models:', modelsData.data?.length || 0);

      if (modelsData.data && modelsData.data.length > 0) {
        console.log('  - Models list:');
        modelsData.data.forEach((model, index) => {
          const supportsTools = model.id.includes('coder') || model.id.includes('tool');
          console.log(`    ${index + 1}. ${model.id} ${supportsTools ? '(supports tools)' : ''}`);
        });
      }
    } else {
      const errorText = await modelsResponse.text();
      console.log('❌ Models check failed:', errorText);
    }

    console.log('\n🎉 Direct Qwen API Tool Calling Test Complete');

  } catch (error) {
    console.error('❌ Test failed with error:', error);
    console.error('Stack:', error.stack);
  }
}

// 运行测试
testDirectQwenTools();