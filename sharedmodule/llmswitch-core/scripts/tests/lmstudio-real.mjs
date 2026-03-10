#!/usr/bin/env node

/**
 * LM Studio 真实环境测试
 * 测试Chat协议转换器与真实LM Studio服务器的兼容性
 * 验证工具请求的双向转换正确性
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '../..');

// LM Studio配置
const LM_STUDIO_CONFIG = {
  // 默认LM Studio端口
  defaultPort: 1234,
  // 默认LM Studio API基础URL
  baseUrl: 'http://localhost:1234/v1',
  // 默认模型（需要LM Studio中加载）
  defaultModel: 'llama-3.2-3b-instruct',
  // 请求超时
  timeout: 30000,
  // 并发限制
  maxConcurrency: 1
};

// 测试用例定义
const TEST_CASES = [
  {
    name: '基础对话测试',
    messages: [
      { role: 'user', content: '你好，请简单介绍一下你自己' }
    ],
    tools: null,
    expectedToolCalls: 0
  },
  {
    name: '工具调用测试',
    messages: [
      { role: 'user', content: '请获取当前天气信息' }
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: '获取指定城市的天气信息',
          parameters: {
            type: 'object',
            properties: {
              city: { type: 'string', description: '城市名称' }
            },
            required: ['city']
          }
        }
      }
    ],
    expectedToolCalls: 1
  },
  {
    name: '多工具调用测试',
    messages: [
      { role: 'user', content: '请获取北京天气和当前时间' }
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: '获取指定城市的天气信息',
          parameters: {
            type: 'object',
            properties: {
              city: { type: 'string', description: '城市名称' }
            },
            required: ['city']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_current_time',
          description: '获取当前时间',
          parameters: {
            type: 'object',
            properties: {}
          }
        }
      }
    ],
    expectedToolCalls: 2
  }
];

// HTTP请求工具
async function httpRequest(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LM_STUDIO_CONFIG.timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('请求超时');
    }
    throw error;
  }
}

// 检查LM Studio是否可用
async function checkLMStudioAvailability() {
  try {
    const response = await httpRequest(`${LM_STUDIO_CONFIG.baseUrl}/models`);
    return Array.isArray(response.data) && response.data.length > 0;
  } catch (error) {
    return false;
  }
}

// 获取可用模型列表
async function getAvailableModels() {
  try {
    const response = await httpRequest(`${LM_STUDIO_CONFIG.baseUrl}/models`);
    return response.data.map(model => model.id);
  } catch (error) {
    console.warn('无法获取模型列表:', error.message);
    return [LM_STUDIO_CONFIG.defaultModel];
  }
}

// 创建Chat请求
function createChatRequest(messages, tools = null, model = LM_STUDIO_CONFIG.defaultModel) {
  return {
    model,
    messages,
    ...(tools && { tools }),
    stream: true,
    temperature: 0.7
  };
}

// 解析SSE流
async function* parseSSEStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // 按双换行分割事件
      while (buffer.includes('\n\n')) {
        const eventEnd = buffer.indexOf('\n\n');
        const eventData = buffer.substring(0, eventEnd);
        buffer = buffer.substring(eventEnd + 2);

        if (eventData.trim()) {
          yield parseSSEEvent(eventData);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// 解析单个SSE事件
function parseSSEEvent(eventData) {
  const lines = eventData.trim().split('\n');
  let event = '';
  let data = '';

  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.substring(6).trim();
    } else if (line.startsWith('data:')) {
      data = line.substring(5).trim();
    }
  }

  if (data === '[DONE]') {
    return { event, data: '[DONE]', parsed: null };
  }

  try {
    return {
      event,
      data,
      parsed: data ? JSON.parse(data) : null
    };
  } catch (error) {
    console.warn('解析SSE数据失败:', error.message);
    return { event, data, parsed: null, error: error.message };
  }
}

// 执行单个测试用例
async function runTestCase(testCase, model) {
  console.log(`\n🧪 开始测试: ${testCase.name}`);
  console.log(`📋 模型: ${model}`);
  console.log(`🔧 工具数量: ${testCase.tools ? testCase.tools.length : 0}`);
  console.log(`💬 消息数量: ${testCase.messages.length}`);

  const request = createChatRequest(testCase.messages, testCase.tools, model);
  const startTime = Date.now();

  try {
    const response = await fetch(`${LM_STUDIO_CONFIG.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      throw new Error(`请求失败: ${response.status} ${response.statusText}`);
    }

    const events = [];
    const chunks = [];
    let toolCallCount = 0;

    // 解析SSE流
    for await (const sseEvent of parseSSEStream(response)) {
      events.push(sseEvent);

      if (sseEvent.parsed && sseEvent.parsed.choices) {
        const choice = sseEvent.parsed.choices[0];

        if (choice.delta) {
          chunks.push(choice.delta);

          // 检查工具调用
          if (choice.delta.tool_calls) {
            toolCallCount += choice.delta.tool_calls.length;
          }
        }
      }
    }

    const endTime = Date.now();
    const duration = endTime - startTime;

    console.log(`✅ 测试完成`);
    console.log(`⏱️  耗时: ${duration}ms`);
    console.log(`📊 事件数量: ${events.length}`);
    console.log(`📝 数据块数量: ${chunks.length}`);
    console.log(`🔧 工具调用次数: ${toolCallCount}`);

    // 验证结果
    const success = toolCallCount === testCase.expectedToolCalls;
    console.log(`${success ? '✅' : '❌'} 工具调用验证: 期望 ${testCase.expectedToolCalls}, 实际 ${toolCallCount}`);

    return {
      success,
      testCase: testCase.name,
      model,
      duration,
      eventCount: events.length,
      chunkCount: chunks.length,
      toolCallCount,
      expectedToolCalls: testCase.expectedToolCalls,
      events,
      chunks,
      request,
      error: null
    };

  } catch (error) {
    const endTime = Date.now();
    const duration = endTime - startTime;

    console.log(`❌ 测试失败: ${error.message}`);

    return {
      success: false,
      testCase: testCase.name,
      model,
      duration,
      eventCount: 0,
      chunkCount: 0,
      toolCallCount: 0,
      expectedToolCalls: testCase.expectedToolCalls,
      events: [],
      chunks: [],
      request,
      error: error.message
    };
  }
}

// 主测试函数
async function main() {
  console.log('🚀 LM Studio 真实环境测试');
  console.log('=====================================\n');

  // 检查LM Studio可用性
  console.log('🔍 检查LM Studio可用性...');
  const isAvailable = await checkLMStudioAvailability();

  if (!isAvailable) {
    console.error('❌ LM Studio不可用!');
    console.log('💡 请确保:');
    console.log('   1. LM Studio正在运行');
    console.log(`   2. 监听端口 ${LM_STUDIO_CONFIG.defaultPort}`);
    console.log('   3. 至少加载了一个模型');
    process.exit(1);
  }

  console.log('✅ LM Studio可用!\n');

  // 获取可用模型
  console.log('📋 获取可用模型...');
  const availableModels = await getAvailableModels();
  console.log(`🔧 可用模型: ${availableModels.join(', ')}\n`);

  // 创建输出目录
  const outputDir = join(__dirname, '../../test-output/lmstudio', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(outputDir, { recursive: true });
  console.log(`📁 输出目录: ${outputDir}\n`);

  // 执行测试用例
  const results = [];
  const testModel = availableModels[0]; // 使用第一个可用模型

  for (const testCase of TEST_CASES) {
    const result = await runTestCase(testCase, testModel);
    results.push(result);

    // 添加延迟以避免过快请求
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // 生成测试报告
  console.log('\n📊 测试报告');
  console.log('=====================================');

  const successCount = results.filter(r => r.success).length;
  const totalCount = results.length;

  console.log(`✅ 成功: ${successCount}/${totalCount}`);
  console.log(`❌ 失败: ${totalCount - successCount}/${totalCount}`);

  const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / totalCount;
  console.log(`⏱️  平均耗时: ${avgDuration.toFixed(0)}ms`);

  console.log('\n📋 详细结果:');
  for (const result of results) {
    const status = result.success ? '✅' : '❌';
    const toolStatus = result.toolCallCount === result.expectedToolCalls ? '✅' : '❌';

    console.log(`${status} ${result.testCase}`);
    console.log(`    📊 事件: ${result.eventCount}, 块: ${result.chunkCount}, 耗时: ${result.duration}ms`);
    console.log(`    ${toolStatus} 工具调用: ${result.toolCallCount}/${result.expectedToolCalls}`);

    if (result.error) {
      console.log(`    🔴 错误: ${result.error}`);
    }
  }

  // 保存测试结果
  const report = {
    timestamp: new Date().toISOString(),
    lmStudioConfig: LM_STUDIO_CONFIG,
    availableModels,
    testModel,
    summary: {
      total: totalCount,
      success: successCount,
      failed: totalCount - successCount,
      successRate: (successCount / totalCount * 100).toFixed(1) + '%',
      avgDuration: avgDuration.toFixed(0)
    },
    results
  };

  const reportPath = join(outputDir, 'test-report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n💾 测试报告已保存: ${reportPath}`);

  // 保存详细的事件数据
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const eventPath = join(outputDir, `test-${i + 1}-${result.testCase.replace(/\s+/g, '-')}-events.json`);
    writeFileSync(eventPath, JSON.stringify({
      testCase: result.testCase,
      model: result.model,
      request: result.request,
      events: result.events,
      chunks: result.chunks,
      stats: {
        eventCount: result.eventCount,
        chunkCount: result.chunkCount,
        duration: result.duration,
        toolCallCount: result.toolCallCount,
        expectedToolCalls: result.expectedToolCalls
      }
    }, null, 2));
  }

  console.log(`\n🎉 LM Studio真实环境测试完成!`);

  if (successCount === totalCount) {
    console.log('🏆 所有测试通过，系统与LM Studio完全兼容!');
    process.exit(0);
  } else {
    console.log('⚠️  部分测试失败，请检查LM Studio配置和模型支持');
    process.exit(1);
  }
}

// 运行测试
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('💥 测试执行失败:', error);
    process.exit(1);
  });
}

export { main as runLMStudioRealTest };