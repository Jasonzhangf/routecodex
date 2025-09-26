#!/usr/bin/env node

const https = require('https');
const http = require('http');
const fs = require('fs');

// Server configuration
const BASE_URL = 'http://localhost:4006';
const API_KEY = 'test-key';

function makeRequest(url, options, data = null) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const isHttps = urlObj.protocol === 'https:';
        const lib = isHttps ? https : http;

        const reqOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: options.headers || {}
        };

        const req = lib.request(reqOptions, (res) => {
            let body = '';
            res.on('data', (chunk) => {
                body += chunk;
            });
            res.on('end', () => {
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: body
                });
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        if (data) {
            req.write(data);
        }
        req.end();
    });
}

async function testToolCalling() {
    console.log('🧪 Testing tool calling functionality...');
    console.log(`📡 Sending request to ${BASE_URL}/v1/openai/chat/completions`);

    const payload = {
        model: 'Qwen/Qwen3-Coder-480B-A35B-Instruct',
        messages: [
            { role: 'user', content: '请列出当前目录中的所有文件夹' }
        ],
        tools: [
            {
                type: 'function',
                function: {
                    name: 'list_files',
                    description: '列出指定目录中的文件和文件夹',
                    parameters: {
                        type: 'object',
                        properties: {
                            path: {
                                type: 'string',
                                description: '要列出的目录路径'
                            }
                        },
                        required: ['path']
                    }
                }
            }
        ],
        tool_choice: 'auto'
    };

    console.log('📋 Payload:', JSON.stringify(payload, null, 2));
    console.log('-'.repeat(50));

    try {
        const response = await makeRequest(`${BASE_URL}/v1/openai/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Length': Buffer.byteLength(JSON.stringify(payload))
            }
        }, JSON.stringify(payload));

        console.log(`📊 Status Code: ${response.status}`);
        console.log('📋 Response Headers:', JSON.stringify(response.headers, null, 2));

        if (response.status === 200) {
            const result = JSON.parse(response.body);
            console.log('✅ Response:', JSON.stringify(result, null, 2));

            // Check if tool calls were made
            if (result.choices && result.choices.length > 0) {
                const choice = result.choices[0];
                if (choice.message && choice.message.tool_calls) {
                    const toolCalls = choice.message.tool_calls;
                    console.log(`🔧 Tool calls detected: ${toolCalls.length}`);
                    toolCalls.forEach((toolCall, i) => {
                        console.log(`  Tool ${i + 1}: ${toolCall.function.name}`);
                        console.log(`    Arguments: ${toolCall.function.arguments}`);
                    });
                } else {
                    console.log('⚠️ No tool calls in response');
                }
            } else {
                console.log('⚠️ No choices in response');
            }
        } else {
            console.log('❌ Error response:', response.body);
        }
    } catch (error) {
        console.log('❌ Error:', error.message);
    }
}

async function testBasicChat() {
    console.log('\n🧪 Testing basic chat functionality...');
    console.log(`📡 Sending request to ${BASE_URL}/v1/openai/chat/completions`);

    const payload = {
        model: 'Qwen/Qwen3-Coder-480B-A35B-Instruct',
        messages: [
            { role: 'user', content: 'Hello, how are you?' }
        ]
    };

    console.log('-'.repeat(50));

    try {
        const response = await makeRequest(`${BASE_URL}/v1/openai/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Length': Buffer.byteLength(JSON.stringify(payload))
            }
        }, JSON.stringify(payload));

        console.log(`📊 Status Code: ${response.status}`);

        if (response.status === 200) {
            const result = JSON.parse(response.body);
            console.log('✅ Response:', JSON.stringify(result, null, 2));
        } else {
            console.log('❌ Error response:', response.body);
        }
    } catch (error) {
        console.log('❌ Error:', error.message);
    }
}

async function checkServerHealth() {
    console.log('🏥 Checking server health...');
    console.log(`📡 Checking ${BASE_URL}/health`);
    console.log('-'.repeat(50));

    try {
        const response = await makeRequest(`${BASE_URL}/health`, {
            method: 'GET'
        });

        console.log(`📊 Status Code: ${response.status}`);

        if (response.status === 200) {
            const result = JSON.parse(response.body);
            console.log('✅ Health check:', JSON.stringify(result, null, 2));
            return true;
        } else {
            console.log('❌ Health check failed:', response.body);
            return false;
        }
    } catch (error) {
        console.log('❌ Health check error:', error.message);
        return false;
    }
}

async function main() {
    console.log('🚀 RouteCodex Tool Calling Test');
    console.log('='.repeat(50));

    // Check server health first
    const isHealthy = await checkServerHealth();
    if (!isHealthy) {
        console.log('❌ Server is not healthy, exiting...');
        process.exit(1);
    }

    // Test basic chat first
    await testBasicChat();

    // Test tool calling
    await testToolCalling();

    console.log('\n✅ Test completed!');
}

main().catch(console.error);