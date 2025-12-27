#!/usr/bin/env node
/**
 * Gemini SSE 诊断工具
 * 发送一个测试请求并详细记录所有 SSE 事件
 */

import fetch from 'node-fetch';

const ENDPOINT = 'http://localhost:8080/v1/responses';
const MODEL = 'gemini-3-flash';

async function testGeminiSSE() {
    console.log('🔍 开始 Gemini SSE 诊断...\n');

    const requestBody = {
        model: MODEL,
        input: [
            {
                role: 'user',
                content: [
                    {
                        type: 'input_text',
                        text: '请简单介绍一下你自己，一句话即可。'
                    }
                ]
            }
        ],
        stream: true
    };

    console.log('📤 发送请求:');
    console.log(JSON.stringify(requestBody, null, 2));
    console.log('\n---\n');

    try {
        const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream'
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            console.error(`❌ 请求失败: ${response.status} ${response.statusText}`);
            const text = await response.text();
            console.error(text);
            return;
        }

        console.log('✅ 连接成功，开始接收 SSE 事件:\n');

        let eventCount = 0;
        let buffer = '';
        const events = [];

        for await (const chunk of response.body) {
            buffer += chunk.toString();

            // 按 \n\n 分割事件
            const parts = buffer.split('\n\n');
            buffer = parts.pop() || ''; // 保留最后不完整的部分

            for (const part of parts) {
                if (!part.trim()) continue;

                eventCount++;
                const lines = part.split('\n');
                const event = {};

                for (const line of lines) {
                    if (line.startsWith('event:')) {
                        event.type = line.substring(6).trim();
                    } else if (line.startsWith('data:')) {
                        const dataStr = line.substring(5).trim();
                        try {
                            event.data = JSON.parse(dataStr);
                        } catch {
                            event.data = dataStr;
                        }
                    }
                }

                events.push(event);

                console.log(`\n[Event #${eventCount}] ${event.type || 'unknown'}`);
                if (event.data && typeof event.data === 'object') {
                    console.log(JSON.stringify(event.data, null, 2));
                } else {
                    console.log(event.data);
                }
            }
        }

        console.log('\n---\n');
        console.log(`📊 总计收到 ${eventCount} 个事件`);

        // 统计事件类型
        const typeCount = {};
        for (const evt of events) {
            const type = evt.type || 'unknown';
            typeCount[type] = (typeCount[type] || 0) + 1;
        }

        console.log('\n事件类型统计:');
        for (const [type, count] of Object.entries(typeCount)) {
            console.log(`  ${type}: ${count}`);
        }

        // 检查是否有完整内容
        const textDeltas = events.filter(e => e.type === 'response.output_text.delta');
        const fullText = textDeltas.map(e => e.data?.delta || '').join('');

        console.log('\n📝 拼接的完整文本:');
        console.log(fullText || '(无文本输出)');

    } catch (error) {
        console.error('❌ 错误:', error.message);
        console.error(error.stack);
    }
}

testGeminiSSE();
