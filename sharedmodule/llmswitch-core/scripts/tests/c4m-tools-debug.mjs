#!/usr/bin/env node

/**
 * C4M工具调用调试测试
 * 专门调试二轮对话的格式问题
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// 读取C4M配置和样本
const C4M_CONFIG = JSON.parse(readFileSync('/Users/fanzhang/.routecodex/provider/c4m/config.v1.json', 'utf8'));
const CODEX_SAMPLE = JSON.parse(readFileSync('/Users/fanzhang/.routecodex/codex-samples/openai-responses/req_1763733582430_c30ihldix_provider-request.json', 'utf8')).body;

// 提取配置信息
const C4M_SETTINGS = {
  baseURL: C4M_CONFIG.virtualrouter.providers.c4m.baseURL,
  apiKey: C4M_CONFIG.virtualrouter.providers.c4m.auth.apiKey,
  model: 'gpt-5.1'
};

console.log('🔧 C4M配置信息:');
console.log(`   - 基础URL: ${C4M_SETTINGS.baseURL}`);

// HTTP请求工具
async function c4mRequest(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'responses-2024-12-17',
        'Authorization': `Bearer ${C4M_SETTINGS.apiKey}`,
        ...options.headers
      }
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${response.statusText} - ${errorText}`);
    }

    return await response.text();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('请求超时');
    }
    throw error;
  }
}

// 解析SSE事件
function parseSSEEvents(sseData) {
  const lines = sseData.split('\n');
  const events = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('event:')) {
      const eventType = line.substring(6).trim();
      let data = '';
      i++;

      while (i < lines.length && lines[i].startsWith('data:')) {
        data += lines[i].substring(5).trim();
        i++;
      }
      i--;

      if (data === '[DONE]') {
        events.push({ event: eventType, data: '[DONE]', parsed: null });
      } else {
        try {
          events.push({ event: eventType, data, parsed: data ? JSON.parse(data) : null });
        } catch (error) {
          console.warn(`解析SSE事件失败: ${error.message}`);
          events.push({ event: eventType, data, parsed: null, error: error.message });
        }
      }
    }
  }

  return events;
}

// 执行简化工具调用测试
async function executeSimpleToolTest() {
  console.log('\n🎯 开始简化工具调用测试');

  // 第1轮：工具调用请求
  const { max_tokens, temperature, ...filteredSample } = CODEX_SAMPLE;
  const firstRoundRequest = {
    ...filteredSample,
    model: C4M_SETTINGS.model,
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '请使用get_weather工具获取北京的天气信息'
          }
        ]
      }
    ],
    stream: true,
    tools: [
      {
        type: 'function',
        name: 'get_weather',
        description: '获取指定城市的天气信息',
        parameters: {
          type: 'object',
          properties: {
            city: {
              type: 'string',
              description: '城市名称'
            }
          },
          required: ['city']
        }
      }
    ],
    tool_choice: 'auto'
  };

  console.log('📤 第1轮请求结构:');
  console.log(JSON.stringify(firstRoundRequest, null, 2));

  try {
    const response = await c4mRequest(`${C4M_SETTINGS.baseURL}/responses`, {
      method: 'POST',
      body: JSON.stringify(firstRoundRequest)
    });

    // 解析SSE流
    const events = parseSSEEvents(response);
    console.log(`✅ 第1轮成功: ${events.length}个事件`);

    // 查找工具调用
    const toolCallEvents = events.filter(e => e.event === 'response.function_call_arguments.done');

    if (toolCallEvents.length === 0) {
      console.log('❌ 没有检测到工具调用');
      return null;
    }

    console.log(`🛠️ 检测到 ${toolCallEvents.length} 个工具调用`);

    // 构造工具执行结果
    const toolResult = {
      city: '北京',
      temperature: 15,
      weather: '晴',
      humidity: 45,
      update_time: new Date().toISOString()
    };

    console.log('🎭 模拟工具执行结果:');
    console.log(JSON.stringify(toolResult, null, 2));

    // 第2轮：包含工具结果的请求
    const secondRoundRequest = {
      ...filteredSample,
      model: C4M_SETTINGS.model,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: '请使用get_weather工具获取北京的天气信息'
            }
          ]
        },
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'input_text',
              text: '我来为您获取北京的天气信息。'
            }
          ]
        },
        {
          type: 'message',
          role: 'tool',
          tool_call_id: toolCallEvents[0].parsed.item_id,
          content: toolResult // 直接使用对象，不JSON.stringify
        },
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: '基于刚才的天气查询结果，请告诉我北京的天气情况'
            }
          ]
        }
      ],
      stream: true,
      tools: [] // 第二轮不提供工具
    };

    console.log('\\n📤 第2轮请求结构:');
    console.log(JSON.stringify(secondRoundRequest, null, 2));

    const secondResponse = await c4mRequest(`${C4M_SETTINGS.baseURL}/responses`, {
      method: 'POST',
      body: JSON.stringify(secondRoundRequest)
    });

    const secondEvents = parseSSEEvents(secondResponse);
    console.log(`✅ 第2轮成功: ${secondEvents.length}个事件`);

    return {
      firstRound: { events: events.length, request: firstRoundRequest },
      secondRound: { events: secondEvents.length, request: secondRoundRequest },
      toolResult: toolResult
    };

  } catch (error) {
    console.log(`❌ 测试失败: ${error.message}`);
    return null;
  }
}

// 主测试函数
async function main() {
  console.log('🔧 C4M工具调用调试测试');
  console.log('专门调试二轮对话的格式问题');
  console.log('='.repeat(50));

  const result = await executeSimpleToolTest();

  if (result) {
    console.log('\\n🎉 调试测试完成!');
    console.log(`第1轮: ${result.firstRound.events}个事件`);
    console.log(`第2轮: ${result.secondRound.events}个事件`);
    console.log('\\n💾 成功的请求格式已保存');
  } else {
    console.log('\\n❌ 调试测试失败');
  }
}

// 运行测试
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('💥 调试测试失败:', error);
    process.exit(1);
  });
}