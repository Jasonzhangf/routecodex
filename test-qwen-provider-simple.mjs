#!/usr/bin/env node

/**
 * Simple Qwen Provider Direct Test
 * Tests OAuth authentication and basic API calls using simplified approach
 */

import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';

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

async function testQwenAuthDirectly() {
  console.log('🔧 Testing Qwen OAuth Authentication and API Directly...\n');

  try {
    // Check token file
    const tokenFile = path.join(homedir(), '.qwen/oauth_creds.json');
    console.log('📁 Checking token file:', tokenFile);

    let tokenData = null;
    try {
      const tokenContent = await fs.readFile(tokenFile, 'utf-8');
      tokenData = JSON.parse(tokenContent);
      console.log('✅ Token file found and parsed');
      console.log('  - Access Token:', tokenData.access_token ? `${tokenData.access_token.substring(0, 20)}...` : 'Missing');
      console.log('  - Refresh Token:', tokenData.refresh_token ? 'Present' : 'Missing');
      console.log('  - Expires At:', tokenData.expires_at || 'Not set');
      console.log('  - Token Type:', tokenData.token_type || 'Not set');
      console.log('');
    } catch (error) {
      console.log('❌ Token file not found or invalid:', error.message);
      return;
    }

    // Check if token is expired
    const now = Date.now();
    const expiresAt = tokenData.expires_at ? new Date(tokenData.expires_at).getTime() : 0;
    const isExpired = expiresAt > 0 && now >= expiresAt;

    console.log('🔍 Token Status:');
    console.log('  - Current Time:', new Date(now).toISOString());
    console.log('  - Expires At:', tokenData.expires_at ? new Date(expiresAt).toISOString() : 'Not set');
    console.log('  - Is Expired:', isExpired);
    console.log('');

    if (isExpired && tokenData.refresh_token) {
      console.log('🔄 Token expired, attempting refresh...');

      const refreshResult = await makeRequest('https://chat.qwen.ai/api/v1/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: {
          grant_type: 'refresh_token',
          refresh_token: tokenData.refresh_token,
          client_id: 'f0304373b74a44d2b584a3fb70ca9e56'
        }
      });

      if (refreshResult.ok) {
        console.log('✅ Token refresh successful');

        // Update token data
        const newTokenData = {
          ...tokenData,
          access_token: refreshResult.data.access_token,
          refresh_token: refreshResult.data.refresh_token || tokenData.refresh_token,
          token_type: refreshResult.data.token_type,
          expires_in: refreshResult.data.expires_in,
          expires_at: new Date(Date.now() + refreshResult.data.expires_in * 1000).toISOString()
        };

        await fs.writeFile(tokenFile, JSON.stringify(newTokenData, null, 2));
        tokenData = newTokenData;

        console.log('  - New Access Token:', `${tokenData.access_token.substring(0, 20)}...`);
        console.log('  - New Expires At:', tokenData.expires_at);
        console.log('');
      } else {
        console.log('❌ Token refresh failed:', refreshResult.error);
        console.log('  - Status:', refreshResult.status, refreshResult.statusText);
        console.log('');
        return;
      }
    }

    if (!tokenData.access_token) {
      console.log('❌ No access token available');
      return;
    }

    // Test API calls with valid token
    console.log('📤 Testing Qwen API calls...\n');

    // Test 1: Simple chat completion
    console.log('Test 1: Simple Chat Completion');
    const chatRequest = {
      model: 'qwen-turbo',
      messages: [
        { role: 'user', content: 'Hello! Please respond with just "API test successful"' }
      ],
      temperature: 0.7,
      max_tokens: 50
    };

    const chatResult = await makeRequest('https://chat.qwen.ai/api/v1/services/aigc/text-generation/generation', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`
      },
      body: chatRequest
    });

    if (chatResult.ok) {
      console.log('✅ Simple chat successful');
      console.log('  - Response:', chatResult.data.output?.text || chatResult.data.output?.choices?.[0]?.message?.content || 'No content');
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
                  description: 'Directory path'
                }
              },
              required: []
            }
          }
        }
      ],
      tool_choice: 'auto',
      temperature: 0.7,
      max_tokens: 500
    };

    const toolResult = await makeRequest('https://chat.qwen.ai/api/v1/services/aigc/text-generation/generation', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`
      },
      body: toolRequest
    });

    if (toolResult.ok) {
      console.log('✅ Tool calling request successful');
      const content = toolResult.data.output?.text || toolResult.data.output?.choices?.[0]?.message?.content || '';
      const hasToolCalls = content.includes('list_files') || content.includes('tool_calls');

      console.log('  - Response Length:', content.length, 'characters');
      console.log('  - Contains Tool Calls:', hasToolCalls);
      console.log('  - Usage:', JSON.stringify(toolResult.data.usage || {}));

      if (hasToolCalls) {
        console.log('  - Content Preview:', content.substring(0, 200) + '...');
      }
      console.log('');
    } else {
      console.log('❌ Tool calling failed:', toolResult.error);
      console.log('  - Status:', toolResult.status, toolResult.statusText);
      console.log('');
    }

    // Test 3: Model info
    console.log('Test 3: Model Information');
    const modelResult = await makeRequest('https://chat.qwen.ai/api/v1/models', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`
      }
    });

    if (modelResult.ok) {
      console.log('✅ Model info request successful');
      console.log('  - Available Models:', modelResult.data.data?.length || 0);
      if (modelResult.data.data && modelResult.data.data.length > 0) {
        console.log('  - First Model:', modelResult.data.data[0].id);
      }
      console.log('');
    } else {
      console.log('❌ Model info request failed:', modelResult.error);
      console.log('  - Status:', modelResult.status, modelResult.statusText);
      console.log('');
    }

    // Summary
    console.log('📋 Test Summary:');
    console.log('  - Token File Access: ✅');
    console.log('  - Token Valid: ' + (tokenData.access_token && !isExpired ? '✅' : '❌'));
    console.log('  - Simple Chat: ' + (chatResult.ok ? '✅' : '❌'));
    console.log('  - Tool Calling: ' + (toolResult.ok ? '✅' : '❌'));
    console.log('  - Model Info: ' + (modelResult.ok ? '✅' : '❌'));
    console.log('');

    console.log('🎉 Direct Qwen Authentication and API Test Complete');

  } catch (error) {
    console.error('❌ Test failed with error:', error);
    console.error('Stack:', error.stack);
  }
}

// Run the test
testQwenAuthDirectly();