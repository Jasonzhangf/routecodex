#!/usr/bin/env node

/**
 * Authentication Comparison Test
 * Tests both RouteCodex and CLIProxyAPI authentication methods
 */

import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';

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

async function testAuthenticationMethods() {
  console.log('🔧 Testing Qwen Authentication Methods...\n');

  // Read current token
  const tokenFile = path.join(homedir(), '.qwen/oauth_creds.json');
  const tokenContent = await fs.readFile(tokenFile, 'utf-8');
  const tokenData = JSON.parse(tokenContent);

  console.log('📋 Current Token Info:');
  console.log('  - Access Token:', tokenData.access_token.substring(0, 20) + '...');
  console.log('  - Token Type:', tokenData.token_type);
  console.log('  - Scope:', tokenData.scope);
  console.log('');

  // Test different API endpoints
  const tests = [
    {
      name: 'RouteCodex Method (text-generation/generation)',
      url: 'https://chat.qwen.ai/api/v1/services/aigc/text-generation/generation',
      request: {
        model: 'qwen-turbo',
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 10
      }
    },
    {
      name: 'OpenAI Compatible Method (/v1/chat/completions)',
      url: 'https://chat.qwen.ai/api/v1/chat/completions',
      request: {
        model: 'qwen-turbo',
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 10
      }
    },
    {
      name: 'Model List Method (/v1/models)',
      url: 'https://chat.qwen.ai/api/v1/models',
      request: null
    },
    {
      name: 'User Info Method (/user/info)',
      url: 'https://chat.qwen.ai/api/v1/user/info',
      request: null
    }
  ];

  for (const test of tests) {
    console.log(`🧪 Testing: ${test.name}`);
    console.log(`  URL: ${test.url}`);

    const result = await makeRequest(test.url, {
      method: test.request ? 'POST' : 'GET',
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`
      },
      body: test.request
    });

    if (result.ok) {
      console.log('  ✅ SUCCESS');
      if (test.request) {
        const content = result.data.output?.text ||
                      result.data.output?.choices?.[0]?.message?.content ||
                      result.data.choices?.[0]?.message?.content;
        if (content) {
          console.log(`  📝 Response: ${content.substring(0, 100)}...`);
        }
      }
      console.log('  📊 Full Response:', JSON.stringify(result.data, null, 2).substring(0, 200) + '...');
    } else {
      console.log('  ❌ FAILED');
      console.log(`  🚫 Status: ${result.status} ${result.statusText}`);
      console.log(`  💥 Error: ${result.error}`);
    }
    console.log('');
  }

  // Test token refresh
  console.log('🔄 Testing Token Refresh...');
  const refreshResult = await makeRequest('https://chat.qwen.ai/api/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: {
      grant_type: 'refresh_token',
      refresh_token: tokenData.refresh_token,
      client_id: 'f0304373b74a44d2b584a3fb70ca9e56',
      scope: 'openid profile email model.completion'
    }
  });

  if (refreshResult.ok) {
    console.log('  ✅ Token refresh successful');
    console.log('  🆕 New Token:', refreshResult.data.access_token.substring(0, 20) + '...');
    console.log('  ⏰ Expires In:', refreshResult.data.expires_in, 'seconds');
  } else {
    console.log('  ❌ Token refresh failed');
    console.log(`  🚫 Status: ${refreshResult.status} ${refreshResult.statusText}`);
    console.log(`  💥 Error: ${refreshResult.error}`);
  }
  console.log('');

  console.log('🎉 Authentication Comparison Test Complete');
}

testAuthenticationMethods().catch(console.error);