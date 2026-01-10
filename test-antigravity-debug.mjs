#!/usr/bin/env node
/**
 * 测试Antigravity provider，抓取完整HTTP请求
 */

import fetch from 'node-fetch';

const ENDPOINT = 'http://localhost:5555/v1/responses';

async function testAntigravityRequest() {
    console.log('🔍 测试Antigravity provider - gemini-3-pro-high\n');

    const requestBody = {
        model: 'gemini-3-pro-high',
        input: [
            {
                role: 'user',
                content: [
                    {
                        type: 'input_text',
                        text: '你好，请用一句话介绍你自己。'
                    }
                ]
            }
        ],
        stream: false  // 先测试非流式
    };

    console.log('📤 发送请求:');
    console.log(JSON.stringify(requestBody, null, 2));
    console.log('\n---\n');

    try {
        const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        console.log(`📥 响应状态: ${response.status} ${response.statusText}\n`);

        const text = await response.text();
        console.log('响应内容:');
        console.log(text);

    } catch (error) {
        console.error('❌ 错误:', error.message);
        console.error(error.stack);
    }
}

testAntigravityRequest();
