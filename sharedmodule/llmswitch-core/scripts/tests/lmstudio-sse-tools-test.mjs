#!/usr/bin/env node

/**
 * LM Studio SSE 工具调用完整测试
 * 测试我们实现的 LM Studio 兼容性在工具调用场景下的表现
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// LM Studio 配置
const LM_STUDIO_CONFIG = {
  baseUrl: 'http://localhost:1234/v1',
  defaultModel: 'gpt-oss-20b-mlx',
  timeout: 60000,
  maxTokens: 4000
};

// 增强的工具调用测试用例
const TOOL_TEST_CASES = [
  {
    name: '基础工具调用测试',
    description: '测试基本的单个工具调用功能',
    messages: [
      { role: 'user', content: '请调用get_temperature函数获取当前温度' }
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_temperature',
          description: '获取当前温度',
          parameters: {
            type: 'object',
            properties: {},
            required: []
          }
        }
      }
    ],
    expectedToolCalls: 1,
    expectedFunctionName: 'get_temperature'
  },
  {
    name: '带参数的工具调用测试',
    description: '测试需要参数的复杂工具调用',
    messages: [
      { role: 'user', content: '请获取北京市的天气信息，城市参数是必需的' }
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
              city: {
                type: 'string',
                description: '城市名称'
              },
              units: {
                type: 'string',
                enum: ['celsius', 'fahrenheit'],
                description: '温度单位'
              }
            },
            required: ['city']
          }
        }
      }
    ],
    expectedToolCalls: 1,
    expectedFunctionName: 'get_weather',
    validateParameters: (toolCall) => {
      return toolCall.function.arguments &&
             JSON.parse(toolCall.function.arguments).city;
    }
  },
  {
    name: '多工具并行调用测试',
    description: '测试同时调用多个工具的能力',
    messages: [
      { role: 'user', content: '请同时获取当前天气、当前时间和用户位置信息' }
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: '获取天气信息',
          parameters: {
            type: 'object',
            properties: {
              location: { type: 'string', description: '位置' }
            },
            required: []
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
            properties: {},
            required: []
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_user_location',
          description: '获取用户位置',
          parameters: {
            type: 'object',
            properties: {},
            required: []
          }
        }
      }
    ],
    expectedToolCalls: 3,
    expectedFunctionNames: ['get_weather', 'get_current_time', 'get_user_location']
  },
  {
    name: '条件性工具调用测试',
    description: '测试根据上下文选择性调用工具',
    messages: [
      { role: 'user', content: '如果现在时间是下午6点以后，请打开灯光，否则告诉我现在的时间' }
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_current_time',
          description: '获取当前时间',
          parameters: {
            type: 'object',
            properties: {},
            required: []
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'turn_on_lights',
          description: '打开灯光',
          parameters: {
            type: 'object',
            properties: {
              brightness: { type: 'number', description: '亮度 (0-100)' }
            },
            required: []
          }
        }
      }
    ],
    expectedToolCalls: 1, // 至少应该调用时间检查
    expectedFunctionNames: ['get_current_time', 'turn_on_lights']
  },
  {
    name: '复杂嵌套参数工具调用测试',
    description: '测试复杂JSON参数结构的工具调用',
    messages: [
      { role: 'user', content: '请创建一个用户配置，包含姓名、邮箱和偏好设置' }
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'create_user_config',
          description: '创建用户配置',
          parameters: {
            type: 'object',
            properties: {
              user: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: '用户姓名' },
                  email: { type: 'string', description: '邮箱地址' },
                  preferences: {
                    type: 'object',
                    properties: {
                      theme: { type: 'string', enum: ['light', 'dark'] },
                      notifications: { type: 'boolean' },
                      language: { type: 'string' }
                    }
                  }
                },
                required: ['name', 'email']
              }
            },
            required: ['user']
          }
        }
      }
    ],
    expectedToolCalls: 1,
    expectedFunctionName: 'create_user_config',
    validateParameters: (toolCall) => {
      const args = JSON.parse(toolCall.function.arguments);
      return args.user && args.user.name && args.user.email;
    }
  }
];

// 增强的SSE解析器
class EnhancedSSEParser {
  constructor() {
    this.events = [];
    this.toolCalls = [];
    this.currentToolCalls = new Map();
  }

  async parseStream(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        while (buffer.includes('\n\n')) {
          const eventEnd = buffer.indexOf('\n\n');
          const eventData = buffer.substring(0, eventEnd);
          buffer = buffer.substring(eventEnd + 2);

          if (eventData.trim()) {
            const event = this.parseEvent(eventData);
            this.events.push(event);
            this.processToolCalls(event);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return this.finalizeToolCalls();
  }

  parseEvent(eventData) {
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
      return { event, data, parsed: null, error: error.message };
    }
  }

  processToolCalls(event) {
    if (!event.parsed?.choices?.[0]?.delta?.tool_calls) {
      return;
    }

    const toolCalls = event.parsed.choices[0].delta.tool_calls;

    for (const toolCall of toolCalls) {
      const index = toolCall.index || 0;

      if (!this.currentToolCalls.has(index)) {
        this.currentToolCalls.set(index, {
          index,
          id: toolCall.id,
          type: toolCall.type || 'function',
          function: {
            name: toolCall.function?.name || '',
            arguments: toolCall.function?.arguments || ''
          },
          complete: false
        });
      } else {
        const current = this.currentToolCalls.get(index);

        if (toolCall.function?.name) {
          current.function.name = toolCall.function.name;
        }

        if (toolCall.function?.arguments) {
          current.function.arguments += toolCall.function.arguments;
        }

        if (toolCall.id) {
          current.id = toolCall.id;
        }
      }
    }
  }

  finalizeToolCalls() {
    const completedCalls = [];

    for (const toolCall of this.currentToolCalls.values()) {
      if (toolCall.function.name) {
        toolCall.complete = true;
        completedCalls.push(toolCall);
      }
    }

    return completedCalls;
  }
}

// 检查LM Studio可用性
async function checkLMStudioAvailability() {
  try {
    const response = await fetch(`${LM_STUDIO_CONFIG.baseUrl}/models`);
    return response.ok;
  } catch (error) {
    return false;
  }
}

// 获取可用模型列表
async function getAvailableModels() {
  try {
    const response = await fetch(`${LM_STUDIO_CONFIG.baseUrl}/models`);
    const data = await response.json();
    return data.data?.map(model => model.id) || [LM_STUDIO_CONFIG.defaultModel];
  } catch (error) {
    console.warn('无法获取模型列表:', error.message);
    return [LM_STUDIO_CONFIG.defaultModel];
  }
}

// 创建工具调用测试请求
function createToolTestRequest(messages, tools, model) {
  return {
    model,
    messages,
    tools,
    stream: true,
    temperature: 0.7,
    max_tokens: LM_STUDIO_CONFIG.maxTokens
  };
}

// 执行单个工具测试用例
async function runToolTestCase(testCase, model) {
  console.log(`\n🔧 ${testCase.name}`);
  console.log(`📝 ${testCase.description}`);
  console.log(`🤖 模型: ${model}`);
  console.log(`🛠️  工具数量: ${testCase.tools.length}`);

  const request = createToolTestRequest(testCase.messages, testCase.tools, model);
  const startTime = Date.now();
  const parser = new EnhancedSSEParser();

  try {
    const response = await fetch(`${LM_STUDIO_CONFIG.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      throw new Error(`请求失败: ${response.status} ${response.statusText}`);
    }

    const toolCalls = await parser.parseStream(response);
    const endTime = Date.now();
    const duration = endTime - startTime;

    console.log(`✅ 测试完成 (${duration}ms)`);
    console.log(`📊 SSE事件: ${parser.events.length}`);
    console.log(`🔧 检测到的工具调用: ${toolCalls.length}`);

    // 详细分析工具调用
    let success = true;
    const issues = [];

    if (toolCalls.length !== testCase.expectedToolCalls) {
      success = false;
      issues.push(`工具调用数量不匹配: 期望 ${testCase.expectedToolCalls}, 实际 ${toolCalls.length}`);
    }

    // 验证函数名称
    if (testCase.expectedFunctionName) {
      const actualNames = toolCalls.map(tc => tc.function.name);
      if (!actualNames.includes(testCase.expectedFunctionName)) {
        success = false;
        issues.push(`期望函数名 ${testCase.expectedFunctionName}, 实际: ${actualNames.join(', ')}`);
      }
    }

    // 验证多个函数名称
    if (testCase.expectedFunctionNames) {
      const actualNames = toolCalls.map(tc => tc.function.name);
      const hasAllExpected = testCase.expectedFunctionNames.every(name => actualNames.includes(name));
      if (!hasAllExpected) {
        success = false;
        issues.push(`期望包含函数: ${testCase.expectedFunctionNames.join(', ')}, 实际: ${actualNames.join(', ')}`);
      }
    }

    // 验证参数
    if (testCase.validateParameters) {
      for (const toolCall of toolCalls) {
        if (!testCase.validateParameters(toolCall)) {
          success = false;
          issues.push(`参数验证失败: ${toolCall.function.name}`);
        }
      }
    }

    // 显示详细的工具调用信息
    if (toolCalls.length > 0) {
      console.log('\n📋 工具调用详情:');
      toolCalls.forEach((toolCall, index) => {
        console.log(`  ${index + 1}. ${toolCall.function.name}`);
        console.log(`     ID: ${toolCall.id}`);
        console.log(`     参数: ${toolCall.function.arguments}`);
        console.log(`     完整性: ${toolCall.complete ? '✅' : '❌'}`);
      });
    }

    for (const issue of issues) {
      console.log(`❌ ${issue}`);
    }

    return {
      success,
      testCase: testCase.name,
      model,
      duration,
      eventCount: parser.events.length,
      toolCallCount: toolCalls.length,
      expectedToolCalls: testCase.expectedToolCalls,
      toolCalls,
      events: parser.events.slice(0, 5), // 保存前5个事件用于分析
      issues
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
      toolCallCount: 0,
      expectedToolCalls: testCase.expectedToolCalls,
      toolCalls: [],
      events: [],
      issues: [error.message]
    };
  }
}

// 主测试函数
async function main() {
  console.log('🚀 LM Studio SSE 工具调用完整测试');
  console.log('==========================================\n');

  // 检查LM Studio可用性
  const isAvailable = await checkLMStudioAvailability();
  if (!isAvailable) {
    console.error('❌ LM Studio不可用!');
    console.log('💡 请确保 LM Studio 正在运行并监听端口 1234');
    process.exit(1);
  }

  console.log('✅ LM Studio 可用\n');

  // 获取可用模型
  const availableModels = await getAvailableModels();
  console.log(`🔧 可用模型: ${availableModels.slice(0, 3).join(', ')}...`);
  const testModel = availableModels[0];

  // 创建输出目录
  const outputDir = join(__dirname, '../../test-output/lmstudio-sse-tools', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(outputDir, { recursive: true });
  console.log(`📁 输出目录: ${outputDir}\n`);

  // 执行工具测试用例
  const results = [];
  for (const testCase of TOOL_TEST_CASES) {
    const result = await runToolTestCase(testCase, testModel);
    results.push(result);

    // 添加延迟以避免过快请求
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // 生成详细报告
  console.log('\n📊 测试报告');
  console.log('==========================================');

  const successCount = results.filter(r => r.success).length;
  const totalCount = results.length;

  console.log(`✅ 成功: ${successCount}/${totalCount}`);
  console.log(`❌ 失败: ${totalCount - successCount}/${totalCount}`);
  console.log(`📈 成功率: ${(successCount / totalCount * 100).toFixed(1)}%`);

  const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / totalCount;
  console.log(`⏱️  平均耗时: ${avgDuration.toFixed(0)}ms`);

  // 详细结果
  console.log('\n📋 详细结果:');
  for (const result of results) {
    const status = result.success ? '✅' : '❌';
    console.log(`${status} ${result.testCase}`);
    console.log(`    📊 事件: ${result.eventCount}, 工具: ${result.toolCallCount}/${result.expectedToolCalls}, 耗时: ${result.duration}ms`);

    if (result.issues.length > 0) {
      for (const issue of result.issues) {
        console.log(`    🔴 ${issue}`);
      }
    }
  }

  // 保存详细结果
  const report = {
    timestamp: new Date().toISOString(),
    model: testModel,
    config: LM_STUDIO_CONFIG,
    summary: {
      total: totalCount,
      success: successCount,
      failed: totalCount - successCount,
      successRate: (successCount / totalCount * 100).toFixed(1) + '%',
      avgDuration: avgDuration.toFixed(0)
    },
    results,
    toolCallAnalysis: {
      totalToolCalls: results.reduce((sum, r) => sum + r.toolCallCount, 0),
      successfulCalls: results.filter(r => r.success).reduce((sum, r) => sum + r.toolCallCount, 0),
      uniqueFunctions: [...new Set(results.flatMap(r => r.toolCalls.map(tc => tc.function.name)))]
    }
  };

  const reportPath = join(outputDir, 'sse-tools-test-report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n💾 详细报告已保存: ${reportPath}`);

  // 保存SSE事件样本
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const eventPath = join(outputDir, `test-${i + 1}-${result.testCase.replace(/\s+/g, '-')}-events.json`);
    writeFileSync(eventPath, JSON.stringify({
      testCase: result.testCase,
      model: result.model,
      eventCount: result.eventCount,
      toolCallCount: result.toolCallCount,
      duration: result.duration,
      events: result.events,
      toolCalls: result.toolCalls
    }, null, 2));
  }

  console.log('\n🎉 LM Studio SSE 工具调用测试完成!');

  if (successCount === totalCount) {
    console.log('🏆 所有工具调用测试通过，LM Studio 兼容性工作正常!');
  } else {
    console.log(`⚠️  ${totalCount - successCount} 个工具调用测试失败，请检查模型配置或兼容性逻辑`);
  }
}

// 运行测试
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('💥 测试执行失败:', error);
    process.exit(1);
  });
}

export { main as runLMStudioSSEToolsTest };