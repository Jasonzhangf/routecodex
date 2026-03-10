#!/usr/bin/env node

/**
 * LM Studio完整工具调用测试
 * 测试工具调用->执行->返回结果->二轮对话的完整流程
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// LM Studio配置
const LM_STUDIO_CONFIG = {
  baseURL: 'http://localhost:1234',
  model: 'qwen2.5-coder-7b-instruct'
};

console.log('🔧 LM Studio配置信息:');
console.log(`   - 基础URL: ${LM_STUDIO_CONFIG.baseURL}`);
console.log(`   - 模型: ${LM_STUDIO_CONFIG.model}`);

// 定义测试工具
const TEST_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: '获取当前时间',
      parameters: {
        type: 'object',
        properties: {
          format: {
            type: 'string',
            description: '时间格式，如 iso, readable, timestamp',
            enum: ['iso', 'readable', 'timestamp']
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '获取指定城市的天气信息',
      parameters: {
        type: 'object',
        properties: {
          city: {
            type: 'string',
            description: '城市名称'
          },
          unit: {
            type: 'string',
            description: '温度单位',
            enum: ['celsius', 'fahrenheit']
          }
        },
        required: ['city']
      }
    }
  }
];

// HTTP请求工具
async function lmStudioRequest(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

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

// 执行工具调用
async function executeToolCall(toolCall) {
  const toolName = toolCall.function.name;
  const toolArgs = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};

  console.log(`   🛠️ 执行工具: ${toolName}`);
  console.log(`   📋 参数:`, toolArgs);

  switch (toolName) {
    case 'get_current_time':
      const format = toolArgs.format || 'iso';
      let timeResult;

      switch (format) {
        case 'iso':
          timeResult = new Date().toISOString();
          break;
        case 'readable':
          timeResult = new Date().toLocaleString('zh-CN');
          break;
        case 'timestamp':
          timeResult = Date.now();
          break;
        default:
          timeResult = new Date().toISOString();
      }

      return {
        current_time: timeResult,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        format: format,
        executed_at: new Date().toISOString()
      };

    case 'get_weather':
      const city = toolArgs.city || '北京';
      const unit = toolArgs.unit || 'celsius';

      // 模拟天气数据
      const weatherData = {
        '北京': { temp: 15, weather: '晴', humidity: 45, wind: '北风3级' },
        '上海': { temp: 18, weather: '多云', humidity: 65, wind: '东风2级' },
        '广州': { temp: 25, weather: '小雨', humidity: 80, wind: '南风2级' }
      };

      const cityWeather = weatherData[city] || { temp: 20, weather: '未知', humidity: 60, wind: '微风' };

      return {
        city: city,
        temperature: cityWeather.temp,
        unit: unit,
        weather: cityWeather.weather,
        humidity: cityWeather.humidity,
        wind: cityWeather.wind,
        update_time: new Date().toISOString(),
        source: '模拟天气服务'
      };

    default:
      throw new Error(`未知工具: ${toolName}`);
  }
}

// 测试用例定义
const TEST_CASES = [
  {
    name: 'LM Studio简单工具调用',
    description: '测试单个工具调用的完整流程',
    messages: [
      { role: 'user', content: '请使用工具获取当前时间，使用iso格式' }
    ]
  },
  {
    name: 'LM Studio多工具调用',
    description: '测试多个工具调用的协调流程',
    messages: [
      { role: 'user', content: '请先获取当前时间，然后获取北京的天气信息' }
    ]
  }
];

// 执行完整工具调用测试
async function executeCompleteToolTest(testCase) {
  console.log(`\n🎯 开始测试: ${testCase.name}`);
  console.log(`📋 描述: ${testCase.description}`);

  const startTime = Date.now();
  let requestError = null;
  let finalResponse = null;

  try {
    // 第1轮：发送工具调用请求
    console.log('\n📤 第1轮: 发送工具调用请求');

    const firstRoundRequest = {
      model: LM_STUDIO_CONFIG.model,
      messages: testCase.messages,
      tools: TEST_TOOLS,
      tool_choice: 'auto',
      stream: false
    };

    console.log(`🌐 请求URL: ${LM_STUDIO_CONFIG.baseURL}/v1/chat/completions`);

    const firstRoundResponse = await lmStudioRequest(
      `${LM_STUDIO_CONFIG.baseURL}/v1/chat/completions`,
      {
        method: 'POST',
        body: JSON.stringify(firstRoundRequest)
      }
    );

    console.log(`✅ 第1轮响应成功`);
    console.log(`📝 响应ID: ${firstRoundResponse.id}`);

    // 检查是否有工具调用
    const toolCalls = firstRoundResponse.choices[0]?.message?.tool_calls || [];

    if (toolCalls.length === 0) {
      console.log(`ℹ️ 没有工具调用，直接返回响应`);
      return {
        success: true,
        testCase: testCase.name,
        duration: Date.now() - startTime,
        toolCallCount: 0,
        finalResponse: firstRoundResponse,
        request: firstRoundRequest,
        error: null
      };
    }

    console.log(`🛠️ 检测到 ${toolCalls.length} 个工具调用`);

    // 执行工具调用
    const toolResults = [];
    const conversationHistory = [
      ...testCase.messages,
      firstRoundResponse.choices[0].message // 添加assistant消息（包含tool_calls）
    ];

    for (const toolCall of toolCalls) {
      try {
        const toolResult = await executeToolCall(toolCall);

        // 按照OpenAI格式添加工具结果消息
        conversationHistory.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(toolResult)
        });

        toolResults.push({
          tool_call_id: toolCall.id,
          tool_name: toolCall.function.name,
          result: toolResult
        });

        console.log(`   ✅ 工具执行成功: ${toolCall.function.name}`);
      } catch (error) {
        console.log(`   ❌ 工具执行失败: ${toolCall.function.name} - ${error.message}`);

        // 添加错误结果
        conversationHistory.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({
            success: false,
            error: error.message
          })
        });
      }
    }

    console.log(`📊 工具执行完成: ${toolResults.length} 个结果`);

    // 第2轮：发送包含工具结果的请求
    console.log('\n📤 第2轮: 发送包含工具结果的请求');

    const secondRoundRequest = {
      model: LM_STUDIO_CONFIG.model,
      messages: conversationHistory,
      stream: false // 注意：第二轮不包含tools
    };

    const secondRoundResponse = await lmStudioRequest(
      `${LM_STUDIO_CONFIG.baseURL}/v1/chat/completions`,
      {
        method: 'POST',
        body: JSON.stringify(secondRoundRequest)
      }
    );

    console.log(`✅ 第2轮响应成功`);
    console.log(`📝 最终响应:`, secondRoundResponse.choices[0]?.message?.content?.substring(0, 100) + '...');

    finalResponse = secondRoundResponse;

  } catch (error) {
    requestError = error.message;
    console.log(`❌ 测试失败: ${error.message}`);
  }

  const endTime = Date.now();
  const duration = endTime - startTime;

  return {
    success: !requestError,
    testCase: testCase.name,
    duration,
    toolCallCount: finalResponse ? (finalResponse.choices[0]?.message?.tool_calls?.length || 0) : 0,
    finalResponse,
    request: null,
    error: requestError
  };
}

// 主测试函数
async function main() {
  console.log('🔧 LM Studio完整工具调用测试');
  console.log('测试工具调用->执行->返回结果->二轮对话的完整流程');
  console.log('='.repeat(60));

  // 检查LM Studio可用性
  console.log('\n🔍 检查LM Studio服务可用性...');
  try {
    const modelsResponse = await lmStudioRequest(`${LM_STUDIO_CONFIG.baseURL}/v1/models`);
    if (modelsResponse && Array.isArray(modelsResponse.data)) {
      console.log(`✅ LM Studio服务可用，发现 ${modelsResponse.data.length} 个模型`);
      console.log(`📋 可用模型: ${modelsResponse.data.map(m => m.id).join(', ')}`);
    } else {
      throw new Error('模型列表格式错误');
    }
  } catch (error) {
    console.error('❌ LM Studio服务不可用:', error.message);
    console.log('💡 请确保:');
    console.log('   1. LM Studio正在运行');
    console.log(`   2. 服务地址正确: ${LM_STUDIO_CONFIG.baseURL}`);
    process.exit(1);
  }

  console.log('✅ LM Studio服务可用!\n');

  // 创建输出目录
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = join(process.env.HOME || process.env.USERPROFILE || '~', '.routecodex', 'golden_samples', 'lmstudio-tools', timestamp);
  mkdirSync(outputDir, { recursive: true });
  console.log(`📁 输出目录: ${outputDir}\n`);

  // 执行测试
  const results = [];

  for (const testCase of TEST_CASES) {
    const result = await executeCompleteToolTest(testCase);
    results.push(result);

    // 测试间隔
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // 生成测试报告
  console.log('\n📊 LM Studio完整工具调用测试报告');
  console.log('='.repeat(60));

  const successCount = results.filter(r => r.success).length;
  const totalCount = results.length;

  console.log(`✅ 成功测试: ${successCount}/${totalCount}`);
  console.log(`❌ 失败测试: ${totalCount - successCount}/${totalCount}`);

  const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / totalCount;

  console.log(`⏱️ 平均耗时: ${Math.round(avgDuration)}ms`);

  console.log('\n📋 详细结果:');
  for (const result of results) {
    const status = result.success ? '✅' : '❌';

    console.log(`${status} ${result.testCase}`);
    console.log(`    📊 耗时: ${result.duration}ms`);
    console.log(`    🛠️ 工具调用: ${result.toolCallCount}个`);

    if (result.finalResponse) {
      const content = result.finalResponse.choices[0]?.message?.content || '';
      console.log(`    📄 最终响应: ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`);
    }

    if (result.error) {
      console.log(`    🔴 错误: ${result.error}`);
    }
  }

  // 保存测试结果
  const testResults = {
    timestamp: new Date().toISOString(),
    config: LM_STUDIO_CONFIG,
    testEnvironment: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch
    },
    summary: {
      total: totalCount,
      success: successCount,
      failed: totalCount - successCount,
      successRate: (successCount / totalCount * 100).toFixed(1) + '%',
      avgDuration: Math.round(avgDuration)
    },
    tests: results.map(result => ({
      name: result.testCase,
      success: result.success,
      duration: result.duration,
      toolCallCount: result.toolCallCount,
      request: result.request,
      response: result.finalResponse,
      error: result.error
    }))
  };

  const resultsPath = join(outputDir, 'lmstudio-tools-complete-results.json');
  writeFileSync(resultsPath, JSON.stringify(testResults, null, 2));
  console.log(`\n💾 测试结果已保存: ${resultsPath}`);

  console.log('\n🎉 LM Studio完整工具调用测试完成!');

  if (successCount === totalCount) {
    console.log('🏆 所有测试通过！LM Studio工具调用流程验证成功');
    process.exit(0);
  } else {
    console.log('⚠️ 部分测试失败，请检查LM Studio配置');
    process.exit(1);
  }
}

// 运行测试
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('💥 LM Studio工具调用测试失败:', error);
    process.exit(1);
  });
}