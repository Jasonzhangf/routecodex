#!/usr/bin/env node

/**
 * Direct Qwen Provider Authentication and API Test
 * Tests authentication and API calls at the provider level
 */

async function makeRequest(url, options = {}) {
  const { method = 'GET', headers = {}, body } = options;

  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined
    });

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      data: response.ok ? await response.json() : null,
      error: response.ok ? null : await response.text()
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      statusText: 'Network Error',
      data: null,
      error: error.message
    };
  }
}

async function testQwenProviderDirectly() {
  console.log('🔧 Testing Qwen Provider Direct Authentication and API Calls...\n');

  // First, let's check if we have a valid token
  const fs = await import('fs/promises');
  const { homedir } = await import('os');
  const tokenFile = `${homedir()}/.qwen/oauth_creds.json`;

  let accessToken = null;

  try {
    const tokenContent = await fs.readFile(tokenFile, 'utf-8');
    const tokenData = JSON.parse(tokenContent);
    accessToken = tokenData.access_token;
    console.log('📋 Found existing access token:', accessToken.substring(0, 20) + '...');

    // Check if token is expired
    if (tokenData.expires_at && new Date(tokenData.expires_at) < new Date()) {
      console.log('⚠️  Token has expired, need to refresh');
      accessToken = null;
    } else {
      console.log('✅ Token is valid');
    }
  } catch (error) {
    console.log('📋 No valid token found, need to authenticate');
  }
  console.log('');

  if (!accessToken) {
    console.log('❌ No valid access token available');
    console.log('Please run the OAuth authentication flow first:');
    console.log('  node test-oauth-full-auto.mjs');
    return;
  }

  try {
    // Test 1: Verify token with models endpoint
    console.log('Test 1: Token Validation - Models List');
    const modelsResult = await makeRequest('https://chat.qwen.ai/api/v1/models', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    if (modelsResult.ok) {
      console.log('✅ Token validation successful');
      console.log('  - Available Models:', modelsResult.data.data?.length || 0);
      if (modelsResult.data.data && modelsResult.data.data.length > 0) {
        console.log('  - First Model:', modelsResult.data.data[0].id);
      }
    } else {
      console.log('❌ Token validation failed:', modelsResult.error);
      console.log('  - Status:', modelsResult.status, modelsResult.statusText);
    }
    console.log('');

    // Test 2: Simple chat completion
    console.log('Test 2: Simple Chat Completion');
    const chatRequest = {
      model: 'qwen-turbo',
      messages: [
        { role: 'user', content: 'Hello! Please respond with just "Qwen test successful"' }
      ],
      max_tokens: 50
    };

    const chatResult = await makeRequest('https://chat.qwen.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`
      },
      body: chatRequest
    });

    if (chatResult.ok) {
      console.log('✅ Chat completion successful');
      const content = chatResult.data.choices?.[0]?.message?.content || 'No content';
      console.log('  - Response:', content);
      console.log('  - Model:', chatResult.data.model);
      console.log('  - Usage:', JSON.stringify(chatResult.data.usage || {}));
    } else {
      console.log('❌ Chat completion failed:', chatResult.error);
      console.log('  - Status:', chatResult.status, chatResult.statusText);
    }
    console.log('');

    // Test 3: Tool calling
    console.log('Test 3: Tool Calling');
    const toolRequest = {
      model: 'qwen-turbo',
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

    const toolResult = await makeRequest('https://chat.qwen.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`
      },
      body: toolRequest
    });

    if (toolResult.ok) {
      console.log('✅ Tool calling request successful');
      const message = toolResult.data.choices?.[0]?.message;
      const content = message?.content || '';
      const toolCalls = message?.tool_calls || [];

      console.log('  - Response Length:', content.length, 'characters');
      console.log('  - Tool Calls:', toolCalls.length);

      if (toolCalls.length > 0) {
        console.log('  - Tool Call Details:');
        toolCalls.forEach((tool, index) => {
          console.log(`    ${index + 1}. ${tool.function.name}(${JSON.stringify(tool.function.arguments)})`);
        });
      }

      if (content) {
        console.log('  - Content Preview:', content.substring(0, 200) + '...');
      }

      console.log('  - Usage:', JSON.stringify(toolResult.data.usage || {}));
    } else {
      console.log('❌ Tool calling failed:', toolResult.error);
      console.log('  - Status:', toolResult.status, toolResult.statusText);
    }
    console.log('');

    // Test 4: RouteCodex integration
    console.log('Test 4: RouteCodex Integration');
    const rcResult = await makeRequest('http://localhost:5506/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer rcc4-proxy-key',
        'Content-Type': 'application/json'
      },
      body: {
        model: 'qwen-turbo',
        messages: [
          { role: 'user', content: 'Hello! Just respond with "RouteCodex Qwen test successful"' }
        ],
        max_tokens: 50
      }
    });

    if (rcResult.ok) {
      console.log('✅ RouteCodex integration successful');
      const content = rcResult.data.choices?.[0]?.message?.content || 'No content';
      console.log('  - Response:', content);
    } else {
      console.log('❌ RouteCodex integration failed:', rcResult.error);
      console.log('  - Status:', rcResult.status, rcResult.statusText);
    }
    console.log('');

    // Summary
    console.log('📋 Test Summary:');
    console.log('  - Token Validation: ' + (modelsResult.ok ? '✅' : '❌'));
    console.log('  - Simple Chat: ' + (chatResult.ok ? '✅' : '❌'));
    console.log('  - Tool Calling: ' + (toolResult.ok ? '✅' : '❌'));
    console.log('  - RouteCodex Integration: ' + (rcResult.ok ? '✅' : '❌'));
    console.log('');

    console.log('🎉 Direct Qwen Provider Test Complete');

  } catch (error) {
    console.error('❌ Test failed with error:', error);
    console.error('Stack:', error.stack);
  }
}

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Run the test
testQwenProviderDirectly();