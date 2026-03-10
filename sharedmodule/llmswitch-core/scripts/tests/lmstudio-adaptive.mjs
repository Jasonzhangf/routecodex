#!/usr/bin/env node

/**
 * LM Studio 自适应格式测试
 * 智能识别不同的响应格式并正确解析工具调用
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '../..');

// LM Studio配置
const LM_STUDIO_CONFIG = {
  defaultPort: 1234,
  baseUrl: 'http://localhost:1234/v1',
  defaultModel: 'gpt-oss-20b-mlx',
  timeout: 30000
};

// 改进的测试用例
const TEST_CASES = [
  {
    name: '基础对话测试',
    messages: [
      { role: 'user', content: '简单回答：2+2等于几？' }
    ],
    tools: null,
    type: 'basic'
  },
  {
    name: '简单工具调用测试',
    messages: [
      { role: 'user', content: '请调用函数get_temperature获取当前温度' }
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
    type: 'tool'
  }
];

// 解析SSE流的改进版本
async function* parseSSEStream(response) {
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
          yield parseSSEEvent(eventData);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

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
    return { event, data, parsed: null, error: error.message };
  }
}

// 智能工具调用检测器
class ToolCallDetector {
  constructor() {
    this.reset();
  }

  reset() {
    this.currentToolCalls = [];
    this.activeToolCall = null;
    this.detectedToolCalls = 0;
  }

  processChunk(chunk) {
    const choice = chunk.choices?.[0];
    if (!choice) return;

    const delta = choice.delta;

    // 检测标准OpenAI工具调用格式
    if (delta.tool_calls) {
      for (const toolCall of delta.tool_calls) {
        if (toolCall.index !== undefined) {
          // 新工具调用
          if (!this.currentToolCall || this.currentToolCall.index !== toolCall.index) {
            if (this.currentToolCall) {
              this.currentToolCall.complete = true;
            }
            this.currentToolCall = {
              index: toolCall.index,
              id: toolCall.id,
              type: toolCall.type || 'function',
              function: { ...toolCall.function },
              complete: false,
              arguments: toolCall.function?.arguments || ''
            };
            this.currentToolCalls.push(this.currentToolCall);
          } else {
            // 更新现有工具调用
            if (toolCall.function?.name) {
              this.currentToolCall.function.name = toolCall.function.name;
            }
            if (toolCall.function?.arguments) {
              this.currentToolCall.function.arguments = toolCall.function.arguments;
            }
            if (toolCall.id) {
              this.currentToolCall.id = toolCall.id;
            }
          }
        }
      }
    }

    // 检测其他可能的工具调用格式
    // 这里可以添加对特殊模型格式的检测逻辑
  }

  finish() {
    if (this.currentToolCall && !this.currentToolCall.complete) {
      this.currentToolCall.complete = true;
    }
    this.detectedToolCalls = this.currentToolCalls.filter(tc => tc.complete).length;
    return this.currentToolCalls;
  }
}

// 检查LM Studio可用性
async function checkLMStudioAvailability() {
  try {
    const response = await fetch(`${LM_STUDIO_CONFIG.baseUrl}/models`);
    return Array.isArray(response.data) && response.data.length > 0;
  } catch (error) {
    return false;
  }
}

// 获取可用模型
async function getAvailableModels() {
  try {
    const response = await fetch(`${LM_STUDIO_CONFIG.baseUrl}/models`);
    return response.data.map(model => model.id);
  } catch (error) {
    return [LM_STUDIO_CONFIG.defaultModel];
  }
}

// 执行测试用例
async function runTestCase(testCase, model) {
  console.log(`\n🧪 ${testCase.name}`);
  console.log(`📋 模型: ${model}`);

  const request = {
    model,
    messages: testCase.messages,
    ...(testCase.tools && { tools: testCase.tools }),
    stream: true,
    temperature: 0.7
  };

  const detector = new ToolCallDetector();
  const startTime = Date.now();
  const events = [];

  try {
    const response = await fetch(`${LM_STUDIO_CONFIG.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      throw new Error(`请求失败: ${response.status}`);
    }

    // 解析SSE流
    for await (const sseEvent of parseSSEStream(response)) {
      events.push(sseEvent);

      if (sseEvent.parsed && sseEvent.parsed.choices) {
        detector.processChunk(sseEvent.parsed);
      }
    }

    const endTime = Date.now();
    detector.finish();
    const duration = endTime - startTime;

    // 分析响应内容
    const contentChunks = [];
    const reasoningChunks = [];
    let hasContent = false;
    let hasReasoning = false;

    for (const event of events) {
      if (event.parsed?.choices?.[0]?.delta) {
        const delta = event.parsed.choices[0].delta;

        if (delta.content) {
          contentChunks.push(delta.content);
          hasContent = true;
        }

        if (delta.reasoning) {
          reasoningChunks.push(delta.reasoning);
          hasReasoning = true;
        }
      }
    }

    console.log(`✅ 完成 (${duration}ms)`);
    console.log(`📊 事件: ${events.length}`);
    console.log(`🔧 工具调用: ${detector.detectedToolCalls}`);
    console.log(`💬 内容块: ${contentChunks.length}`);
    console.log(`🧠 推理块: ${reasoningChunks.length}`);

    // 根据测试类型验证结果
    let success = true;
    let issues = [];

    if (testCase.type === 'basic') {
      // 基础测试：应该有内容响应
      if (!hasContent && !hasReasoning) {
        success = false;
        issues.push('没有检测到内容或推理响应');
      }
    } else if (testCase.type === 'tool') {
      // 工具测试：应该有工具调用
      if (detector.detectedToolCalls === 0) {
        success = false;
        issues.push('没有检测到工具调用');
      }
    }

    for (const issue of issues) {
      console.log(`❌ ${issue}`);
    }

    return {
      success,
      testCase: testCase.name,
      model,
      duration,
      eventCount: events.length,
      toolCallCount: detector.detectedToolCalls,
      hasContent,
      hasReasoning,
      contentLength: contentChunks.join('').length,
      reasoningLength: reasoningChunks.join('').length,
      events: events.slice(0, 10), // 只保存前10个事件用于分析
      issues
    };

  } catch (error) {
    const endTime = Date.now();
    const duration = endTime - startTime;

    console.log(`❌ 失败: ${error.message}`);
    return {
      success: false,
      testCase: testCase.name,
      model,
      duration,
      eventCount: 0,
      toolCallCount: 0,
      hasContent: false,
      hasReasoning: false,
      contentLength: 0,
      reasoningLength: 0,
      events: [],
      issues: [error.message]
    };
  }
}

// 主函数
async function main() {
  console.log('🚀 LM Studio 自适应格式测试');
  console.log('==========================================\n');

  // 检查可用性
  const isAvailable = await checkLMStudioAvailability();
  if (!isAvailable) {
    console.error('❌ LM Studio不可用！');
    process.exit(1);
  }

  console.log('✅ LM Studio可用\n');

  // 获取模型
  const availableModels = await getAvailableModels();
  console.log(`🔧 可用模型: ${availableModels.slice(0, 5).join(', ')}...\n`);

  const testModel = availableModels[0];
  const results = [];

  // 执行测试
  for (const testCase of TEST_CASES) {
    const result = await runTestCase(testCase, testModel);
    results.push(result);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // 生成报告
  console.log('\n📊 测试报告');
  console.log('==========================================');

  const successCount = results.filter(r => r.success).length;
  console.log(`✅ 成功: ${successCount}/${results.length}`);
  console.log(`📈 成功率: ${(successCount / results.length * 100).toFixed(1)}%`);

  const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / results.length;
  console.log(`⏱️  平均耗时: ${avgDuration.toFixed(0)}ms`);

  console.log('\n📋 详细结果:');
  for (const result of results) {
    const status = result.success ? '✅' : '❌';
    console.log(`${status} ${result.testCase}`);
    console.log(`    📊 事件: ${result.eventCount}, 耗时: ${result.duration}ms`);
    console.log(`    💬 内容: ${result.hasContent ? '✅' : '❌'} (${result.contentLength}字符)`);
    console.log(`    🧠 推理: ${result.hasReasoning ? '✅' : '❌'} (${result.reasoningLength}字符)`);
    console.log(`    🔧 工具: ${result.toolCallCount} 个`);

    if (result.issues.length > 0) {
      for (const issue of result.issues) {
        console.log(`    🔴 ${issue}`);
      }
    }
  }

  // 保存结果
  const outputDir = join(__dirname, '../../test-output/lmstudio', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(outputDir, { recursive: true });

  const report = {
    timestamp: new Date().toISOString(),
    model: testModel,
    results,
    summary: {
      total: results.length,
      success: successCount,
      successRate: (successCount / results.length * 100).toFixed(1) + '%',
      avgDuration: avgDuration.toFixed(0)
    }
  };

  writeFileSync(join(outputDir, 'adaptive-test-report.json'), JSON.stringify(report, null, 2));
  console.log(`\n💾 报告已保存: ${outputDir}/adaptive-test-report.json`);

  if (successCount === results.length) {
    console.log('\n🎉 所有测试通过！');
  } else {
    console.log(`\n⚠️  ${results.length - successCount} 个测试失败`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { main as runLMStudioAdaptiveTest };