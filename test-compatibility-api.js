#!/usr/bin/env node

/**
 * Test compatibility field implementation with actual API calls
 */

import http from 'http';
import https from 'https';

// Test configuration
const SERVER_URL = 'http://localhost:5506';
const API_KEY = 'rcc4-proxy-key';

// Test requests
const testRequests = [
  {
    name: 'Basic compatibility test',
    endpoint: '/v1/chat/completions',
    data: {
      model: 'qwen3-4b-thinking-2507-mlx',
      messages: [
        {
          role: 'user',
          content: 'Hello, this is a test message'
        }
      ]
    }
  },
  {
    name: 'Tool compatibility test',
    endpoint: '/v1/chat/completions',
    data: {
      model: 'qwen3-4b-thinking-2507-mlx',
      messages: [
        {
          role: 'user',
          content: 'What files are in the current directory?'
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'list_files',
            description: 'List files in current directory',
            parameters: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: 'Path to list files from'
                }
              },
              required: []
            }
          }
        }
      ]
    }
  }
];

function makeRequest(endpoint, data) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);
    console.log(`📡 Making request to: http://localhost:5506${endpoint}`);
    console.log(`📋 Request data: ${postData.substring(0, 200)}...`);

    const options = {
      hostname: 'localhost',
      port: 5506,
      path: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = http.request(options, (res) => {
      let body = '';

      res.on('data', (chunk) => {
        body += chunk;
      });

      res.on('end', () => {
        console.log(`📡 Response status: ${res.statusCode}`);
        console.log(`📋 Response body: ${body.substring(0, 500)}...`);

        try {
          const result = JSON.parse(body);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            data: result
          });
        } catch (error) {
          reject(new Error(`JSON parse error: ${error.message}. Body: ${body}`));
        }
      });
    });

    req.on('error', (error) => {
      console.error(`❌ Request error: ${error.message}`);
      reject(error);
    });

    req.on('timeout', () => {
      console.error(`❌ Request timeout`);
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.setTimeout(30000); // 30 second timeout
    req.write(postData);
    req.end();
  });
}

async function runTests() {
  console.log('🧪 Testing compatibility field implementation with API calls...\n');

  for (const test of testRequests) {
    console.log(`📋 Testing: ${test.name}`);

    try {
      const result = await makeRequest(test.endpoint, test.data);

      console.log(`✅ Status: ${result.status}`);
      console.log(`📊 Response ID: ${result.data.id}`);
      console.log(`🤖 Model: ${result.data.model}`);
      console.log(`🔧 Usage: ${JSON.stringify(result.data.usage || {}, null, 2)}`);

      if (result.data.choices && result.data.choices[0]) {
        const choice = result.data.choices[0];
        console.log(`💬 Content: ${choice.message.content.substring(0, 100)}...`);

        if (choice.message.tool_calls) {
          console.log(`🔧 Tool calls: ${choice.message.tool_calls.length} found`);
        }
      }

      console.log('');

    } catch (error) {
      console.error(`❌ Test failed: ${error.message}`);
      if (error.response) {
        console.error(`   Response: ${JSON.stringify(error.response, null, 2)}`);
      }
      console.log('');
    }
  }

  console.log('✅ All compatibility API tests completed!');
}

// Run the tests
runTests().catch(console.error);