#!/usr/bin/env node

/**
 * Qwen Authentication Test Script
 * 测试Qwen认证系统
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// Test configuration
const SERVER_URL = 'http://localhost:5506';
const TOKEN_DIR = path.join(process.env.HOME, '.routecodex', 'tokens');
const QWEN_TOKEN_FILE = path.join(TOKEN_DIR, 'qwen-token.json');

// Test cases
const testCases = [
  {
    name: 'Server Health Check',
    endpoint: '/health',
    method: 'GET',
    headers: {}
  },
  {
    name: 'OpenAI API Test',
    endpoint: '/v1/openai/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test-key'
    },
    body: {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Hello, this is a test.' }
      ],
      max_tokens: 100
    }
  },
  {
    name: 'Anthropic API Test',
    endpoint: '/v1/anthropic/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': 'test-key',
      'anthropic-version': '2023-06-01'
    },
    body: {
      model: 'claude-3-sonnet',
      max_tokens: 100,
      messages: [
        { role: 'user', content: 'Hello, this is a test.' }
      ]
    }
  }
];

// Helper functions
async function makeRequest(url, options = {}) {
  try {
    const response = await fetch(url, options);
    const data = await response.text();

    return {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      data: data
    };
  } catch (error) {
    return {
      status: 'ERROR',
      statusText: error.message,
      headers: {},
      data: null
    };
  }
}

function logResult(testName, result) {
  console.log(`\n=== ${testName} ===`);
  console.log(`Status: ${result.status} ${result.statusText}`);
  console.log(`Headers: ${JSON.stringify(result.headers, null, 2)}`);
  if (result.data) {
    try {
      const parsed = JSON.parse(result.data);
      console.log(`Response: ${JSON.stringify(parsed, null, 2)}`);
    } catch {
      console.log(`Response: ${result.data}`);
    }
  }
}

function checkTokenFile() {
  console.log('\n=== Token File Check ===');
  if (fs.existsSync(QWEN_TOKEN_FILE)) {
    const tokenData = JSON.parse(fs.readFileSync(QWEN_TOKEN_FILE, 'utf8'));
    console.log('Token file exists:');
    console.log(`- Path: ${QWEN_TOKEN_FILE}`);
    console.log(`- Access Token: ${tokenData.access_token ? '***' + tokenData.access_token.slice(-10) : 'Not found'}`);
    console.log(`- Refresh Token: ${tokenData.refresh_token ? '***' + tokenData.refresh_token.slice(-10) : 'Not found'}`);
    console.log(`- Expires At: ${tokenData.expires_at || 'Not set'}`);
    console.log(`- Created At: ${tokenData.created_at || 'Not set'}`);
    return true;
  } else {
    console.log(`Token file not found at: ${QWEN_TOKEN_FILE}`);
    return false;
  }
}

async function testOAuthFlow() {
  console.log('\n=== OAuth Flow Test ===');

  // Test if OAuth endpoint is available
  const oauthTest = await makeRequest(`${SERVER_URL}/oauth/qwen/device-code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    }
  });

  logResult('OAuth Device Code Endpoint', oauthTest);

  // Test OAuth token endpoint
  const tokenTest = await makeRequest(`${SERVER_URL}/oauth/qwen/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      client_id: 'f0304373b74a44d2b584a3fb70ca9e56',
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'test-device-code'
    })
  });

  logResult('OAuth Token Endpoint', tokenTest);
}

async function runTests() {
  console.log('🚀 Starting Qwen Authentication Test');
  console.log(`📡 Server URL: ${SERVER_URL}`);
  console.log(`📂 Token Directory: ${TOKEN_DIR}`);
  console.log(`📄 Token File: ${QWEN_TOKEN_FILE}`);

  // Check if server is running
  const healthCheck = await makeRequest(`${SERVER_URL}/health`);
  if (healthCheck.status !== 200) {
    console.error('❌ Server is not running or not responding properly');
    console.error('Please start the server with: ~/.routecodex/start-server.sh qwen');
    process.exit(1);
  }

  console.log('✅ Server is running');
  logResult('Health Check', healthCheck);

  // Check token file
  const hasToken = checkTokenFile();

  // Test OAuth flow
  await testOAuthFlow();

  // Run API tests
  for (const testCase of testCases) {
    const url = `${SERVER_URL}${testCase.endpoint}`;
    const options = {
      method: testCase.method,
      headers: testCase.headers
    };

    if (testCase.body) {
      options.body = JSON.stringify(testCase.body);
    }

    const result = await makeRequest(url, options);
    logResult(testCase.name, result);
  }

  // Test configuration endpoint
  const configTest = await makeRequest(`${SERVER_URL}/config`);
  logResult('Configuration Check', configTest);

  // Test modules endpoint
  const modulesTest = await makeRequest(`${SERVER_URL}/modules`);
  logResult('Modules Check', modulesTest);

  console.log('\n=== Test Summary ===');
  console.log(`✅ Server Health: ${healthCheck.status === 200 ? 'PASS' : 'FAIL'}`);
  console.log(`🔑 Token File: ${hasToken ? 'EXISTS' : 'NOT FOUND'}`);
  console.log(`🔌 OAuth Endpoints: Tested`);
  console.log(`🌐 API Endpoints: Tested`);

  if (!hasToken) {
    console.log('\n📝 Next Steps:');
    console.log('1. To use OAuth authentication, you need to:');
    console.log('   - Visit the OAuth device code endpoint');
    console.log('   - Complete the authentication flow in browser');
    console.log('   - Token will be saved automatically');
    console.log('2. Or use API key authentication in the configuration');
  }
}

// Handle command line arguments
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Qwen Authentication Test Script

Usage: node test-qwen-auth.js [options]

Options:
  --help, -h     Show this help message
  --clean        Clean up token files before testing
  --verbose      Enable verbose logging

Examples:
  node test-qwen-auth.js
  node test-qwen-auth.js --clean
  node test-qwen-auth.js --verbose
`);
  process.exit(0);
}

if (args.includes('--clean')) {
  console.log('Cleaning up token files...');
  if (fs.existsSync(QWEN_TOKEN_FILE)) {
    fs.unlinkSync(QWEN_TOKEN_FILE);
    console.log(`Deleted: ${QWEN_TOKEN_FILE}`);
  }
}

// Run tests
runTests().catch(error => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});