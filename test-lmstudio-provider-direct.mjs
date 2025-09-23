#!/usr/bin/env node

/**
 * Direct LMStudio Provider Authentication and API Test
 * Tests LMStudio provider without OAuth complications
 */

import fs from 'fs/promises';
import path from 'path';

// Simple HTTP client for testing
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

async function testLMStudioProviderDirectly() {
  console.log('🔧 Testing LMStudio Provider Direct Authentication and API Calls...\n');

  try {
    // Check if LMStudio is running
    const defaultUrls = [
      'http://localhost:1234',
      'http://localhost:1234/v1',
      'http://localhost:1234/api'
    ];

    let workingUrl = null;
    let serverInfo = null;

    console.log('🔍 Checking LMStudio server availability...');

    for (const url of defaultUrls) {
      console.log(`  Testing: ${url}/models`);
      const result = await makeRequest(`${url}/models`, {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer lm-studio'
        }
      });

      if (result.ok) {
        workingUrl = url;
        serverInfo = result.data;
        console.log('✅ LMStudio server found at:', url);
        console.log('  - Available Models:', serverInfo.data?.length || 0);
        if (serverInfo.data && serverInfo.data.length > 0) {
          console.log('  - First Model:', serverInfo.data[0].id);
        }
        break;
      } else {
        console.log(`  ❌ ${url}/models - ${result.status} ${result.statusText}`);
      }
    }

    if (!workingUrl) {
      console.log('❌ LMStudio server not found at default URLs');
      console.log('  Please ensure LMStudio is running and try again');
      console.log('  Default URLs tested:', defaultUrls.join(', '));
      return;
    }

    console.log('');

    // Get the base API URL
    const baseUrl = workingUrl.endsWith('/v1') ? workingUrl : workingUrl + '/v1';

    // Test 1: Simple chat completion
    console.log('Test 1: Simple Chat Completion');
    const simpleRequest = {
      model: serverInfo.data?.[0]?.id || 'local-model',
      messages: [
        { role: 'user', content: 'Hello! Please respond with just "LMStudio test successful"' }
      ],
      temperature: 0.7,
      max_tokens: 50,
      stream: false
    };

    const chatResult = await makeRequest(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer lm-studio'
      },
      body: simpleRequest
    });

    if (chatResult.ok) {
      console.log('✅ Simple chat successful');
      const content = chatResult.data.choices?.[0]?.message?.content || 'No content';
      console.log('  - Response:', content);
      console.log('  - Model:', chatResult.data.model);
      console.log('  - Usage:', JSON.stringify(chatResult.data.usage || {}));
      console.log('');
    } else {
      console.log('❌ Simple chat failed:', chatResult.error);
      console.log('  - Status:', chatResult.status, chatResult.statusText);
      console.log('');
    }

    // Test 2: Tool calling
    console.log('Test 2: Tool Calling');
    const toolRequest = {
      model: serverInfo.data?.[0]?.id || 'local-model',
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
      temperature: 0.7,
      max_tokens: 500,
      stream: false
    };

    const toolResult = await makeRequest(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer lm-studio'
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
      console.log('');
    } else {
      console.log('❌ Tool calling failed:', toolResult.error);
      console.log('  - Status:', toolResult.status, toolResult.statusText);
      console.log('');
    }

    // Test 3: Streaming chat
    console.log('Test 3: Streaming Chat');
    const streamRequest = {
      model: serverInfo.data?.[0]?.id || 'local-model',
      messages: [
        { role: 'user', content: 'Count from 1 to 5 slowly' }
      ],
      temperature: 0.7,
      max_tokens: 100,
      stream: true
    };

    const streamResult = await makeRequest(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer lm-studio'
      },
      body: streamRequest
    });

    if (streamResult.ok) {
      console.log('✅ Streaming request initiated');
      console.log('  - Response type:', typeof streamResult.data);
      console.log('  - Note: Actual streaming would require SSE parsing');
      console.log('');
    } else {
      console.log('❌ Streaming request failed:', streamResult.error);
      console.log('  - Status:', streamResult.status, streamResult.statusText);
      console.log('');
    }

    // Test 4: Embeddings (if available)
    console.log('Test 4: Embeddings');
    const embedRequest = {
      model: serverInfo.data?.[0]?.id || 'local-model',
      input: 'Hello, this is a test for embeddings'
    };

    const embedResult = await makeRequest(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer lm-studio'
      },
      body: embedRequest
    });

    if (embedResult.ok) {
      console.log('✅ Embeddings request successful');
      console.log('  - Embedding Length:', embedResult.data.data?.[0]?.embedding?.length || 0);
      console.log('  - Usage:', JSON.stringify(embedResult.data.usage || {}));
      console.log('');
    } else {
      console.log('⚠️  Embeddings request failed:', embedResult.error);
      console.log('  - Status:', embedResult.status, embedResult.statusText);
      console.log('  - This may not be supported by the loaded model');
      console.log('');
    }

    // Summary
    console.log('📋 Test Summary:');
    console.log('  - Server Connection: ✅');
    console.log('  - Server URL:', workingUrl);
    console.log('  - Simple Chat: ' + (chatResult.ok ? '✅' : '❌'));
    console.log('  - Tool Calling: ' + (toolResult.ok ? '✅' : '❌'));
    console.log('  - Streaming: ' + (streamResult.ok ? '✅' : '❌'));
    console.log('  - Embeddings: ' + (embedResult.ok ? '✅' : '❌'));
    console.log('');

    // Test the full RouteCodex pipeline with this provider
    console.log('🔗 Testing RouteCodex Integration...');
    const testToolResult = await makeRequest('http://localhost:5506/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer rcc4-proxy-key',
        'Content-Type': 'application/json'
      },
      body: {
        model: 'lmstudio-local',
        messages: [
          { role: 'user', content: 'List all files in current directory using list_files tool' }
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
                    description: 'Directory path (optional)'
                  }
                },
                required: []
              }
            }
          }
        ],
        tool_choice: 'auto'
      }
    });

    if (testToolResult.ok) {
      console.log('✅ RouteCodex integration successful');
      const message = testToolResult.data.choices?.[0]?.message;
      const toolCalls = message?.tool_calls || [];
      console.log('  - Tool Calls in Response:', toolCalls.length);
      if (toolCalls.length > 0) {
        console.log('  - Tool Functions:', toolCalls.map(t => t.function.name).join(', '));
      }
    } else {
      console.log('❌ RouteCodex integration failed:', testToolResult.error);
      console.log('  - Status:', testToolResult.status, testToolResult.statusText);
    }

    console.log('');
    console.log('🎉 Direct LMStudio Provider Test Complete');

  } catch (error) {
    console.error('❌ Test failed with error:', error);
    console.error('Stack:', error.stack);
  }
}

// Run the test
testLMStudioProviderDirectly();