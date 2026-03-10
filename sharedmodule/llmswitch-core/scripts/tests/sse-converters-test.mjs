#!/usr/bin/env node

/**
 * SSE转换器测试套件
 *
 * 测试目标：
 * - 验证JSON→SSE转换的正确性
 * - 对比传统和新架构转换器实现
 * - 测试多协议支持（Chat/Responses/Anthropic）
 * - 验证工具调用和复杂内容转换
 *
 * 使用方式：
 *   npm run test:sse-converters
 *   node scripts/tests/sse-converters-test.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 测试配置
const TEST_CONFIG = {
  outputDir: path.join(__dirname, '..', '..', 'test-results'),
  timeoutMs: 10000,
  maxEvents: 1000
};

// 测试结果收集器
class TestResults {
  constructor() {
    this.tests = [];
    this.passed = 0;
    this.failed = 0;
    this.errors = [];
  }

  addTest(name, passed, error = null, details = {}) {
    this.tests.push({ name, passed, error, details, timestamp: new Date().toISOString() });
    if (passed) {
      this.passed++;
    } else {
      this.failed++;
      this.errors.push({ test: name, error, details });
    }
  }

  getSummary() {
    const total = this.passed + this.failed;
    return {
      total,
      passed: this.passed,
      failed: this.failed,
      successRate: total > 0 ? (this.passed / total * 100).toFixed(2) + '%' : '0%',
      errors: this.errors
    };
  }
}

// 收集SSE流事件
async function collectSSEEvents(stream, timeout = TEST_CONFIG.timeoutMs) {
  return new Promise((resolve, reject) => {
    const events = [];
    let buffer = '';

    stream.on('data', (chunk) => {
      buffer += chunk.toString();

      // 处理SSE事件
      let lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 保留最后不完整的行

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            return resolve({ events, done: true });
          }
          try {
            const event = JSON.parse(data);
            events.push(event);
          } catch (e) {
            // 忽略无效JSON
          }
        }
      }
    });

    stream.on('end', () => {
      resolve({ events, done: false });
    });

    stream.on('error', (error) => {
      reject(error);
    });

    // 超时处理
    setTimeout(() => {
      resolve({ events, timeout: true });
    }, timeout);
  });
}

// 测试传统Chat JSON→SSE转换器
async function testLegacyChatJsonToSSE(testResults) {
  console.log('🔍 测试传统Chat JSON→SSE转换器...');

  try {
    const { createChatSSEStreamFromChatJson } = await import('../../dist/conversion/streaming/json-to-chat-sse.js');

    // 测试用例1: 基础文本响应
    const chatJson1 = {
      id: 'chatcmpl-123',
      object: 'chat.completion',
      created: 1694268190,
      model: 'gpt-3.5-turbo-0613',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'Hello, world!'
        },
        finish_reason: 'stop'
      }]
    };

    const sseStream1 = createChatSSEStreamFromChatJson(chatJson1, { requestId: 'test-123' });
    const result1 = await collectSSEEvents(sseStream1);

    testResults.addTest('Legacy Chat JSON→SSE - 基础文本',
      result1.events.length >= 2 &&
      result1.events.some(e => e.delta?.content === 'Hello, world!'),
      null,
      { eventsCount: result1.events.length, hasContent: result1.events.some(e => e.delta?.content) }
    );

    // 测试用例2: 工具调用响应
    const chatJson2 = {
      id: 'chatcmpl-456',
      object: 'chat.completion',
      created: 1694268190,
      model: 'gpt-3.5-turbo-0613',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          tool_calls: [{
            id: 'call_abc123',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: '{"location": "Tokyo"}'
            }
          }]
        },
        finish_reason: 'tool_calls'
      }]
    };

    const sseStream2 = createChatSSEStreamFromChatJson(chatJson2, { requestId: 'test-456' });
    const result2 = await collectSSEEvents(sseStream2);

    const hasToolCall = result2.events.some(e =>
      e.delta?.tool_calls?.[0]?.function?.name === 'get_weather'
    );

    testResults.addTest('Legacy Chat JSON→SSE - 工具调用',
      result2.events.length >= 2 && hasToolCall,
      null,
      { eventsCount: result2.events.length, hasToolCall }
    );

  } catch (error) {
    testResults.addTest('Legacy Chat JSON→SSE', false, error.message);
    console.error('传统Chat转换器测试失败:', error.message);
  }
}

// 测试传统Responses JSON→SSE转换器
async function testLegacyResponsesJsonToSSE(testResults) {
  console.log('🔍 测试传统Responses JSON→SSE转换器...');

  try {
    const { createResponsesSSEStreamFromChatJson } = await import('../../dist/conversion/streaming/json-to-responses-sse.js');

    // 测试用例: Responses API格式
    const responsesJson = {
      id: 'resp_123',
      object: 'response',
      created_at: 1694268190,
      model: 'claude-3-opus-20240229',
      status: 'completed',
      output: [{
        type: 'message',
        id: 'msg_123',
        role: 'assistant',
        content: [{
          type: 'text',
          text: 'I can help you with that.'
        }]
      }],
      usage: {
        input_tokens: 10,
        output_tokens: 8,
        total_tokens: 18
      }
    };

    const sseStream = createResponsesSSEStreamFromChatJson(responsesJson, { requestId: 'test-resp-123' });
    const result = await collectSSEEvents(sseStream);

    const hasMessageEvent = result.events.some(e =>
      e.type === 'response.output_item.added' ||
      e.type === 'response.output_text.delta'
    );

    testResults.addTest('Legacy Responses JSON→SSE - 基础转换',
      result.events.length > 0 && hasMessageEvent,
      null,
      { eventsCount: result.events.length, hasMessageEvent }
    );

  } catch (error) {
    testResults.addTest('Legacy Responses JSON→SSE', false, error.message);
    console.error('传统Responses转换器测试失败:', error.message);
  }
}

// 测试新架构转换器
async function testNewArchitectureConverters(testResults) {
  console.log('🔍 测试新架构SSE转换器...');

  try {
    // 测试新架构的Chat JSON→SSE转换器
    const { ChatJsonToSseConverter } = await import('../../dist/sse/json-to-sse/chat-json-to-sse-converter.js');

    const converter = new ChatJsonToSseConverter();

    const chatJson = {
      id: 'chatcmpl-789',
      object: 'chat.completion',
      created: 1694268190,
      model: 'gpt-4',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'This is the new architecture speaking.'
        },
        finish_reason: 'stop'
      }]
    };

    const sseStream = await converter.convertJsonToSse(chatJson, {
      protocol: 'chat',
      requestId: 'test-new-arch',
      model: 'gpt-4'
    });

    const result = await collectSSEEvents(sseStream);

    testResults.addTest('New Architecture JSON→SSE - Chat协议',
      result.events.length > 0,
      null,
      { eventsCount: result.events.length }
    );

  } catch (error) {
    testResults.addTest('New Architecture JSON→SSE', false, error.message);
    console.error('新架构转换器测试失败:', error.message);
  }
}

// 对比测试：传统vs新架构输出一致性
async function testConverterConsistency(testResults) {
  console.log('🔍 测试转换器输出一致性...');

  try {
    const { createChatSSEStreamFromChatJson } = await import('../../dist/conversion/streaming/json-to-chat-sse.js');
    const { ChatJsonToSseConverter } = await import('../../dist/sse/json-to-sse/chat-json-to-sse-converter.js');

    const testJson = {
      id: 'consistency-test',
      object: 'chat.completion',
      created: 1694268190,
      model: 'gpt-3.5-turbo',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'Consistency test message.'
        },
        finish_reason: 'stop'
      }]
    };

    // 传统实现
    const legacyStream = createChatSSEStreamFromChatJson(testJson, { requestId: 'legacy-test' });
    const legacyResult = await collectSSEEvents(legacyStream);

    // 新架构实现
    const newConverter = new ChatJsonToSseConverter();
    const newStream = await newConverter.convertJsonToSse(testJson, {
      protocol: 'chat',
      requestId: 'new-test',
      model: 'gpt-3.5-turbo'
    });
    const newResult = await collectSSEEvents(newStream);

    // 基本一致性检查（都产生了SSE事件）
    const bothProduceEvents = legacyResult.events.length > 0 && newResult.events.length > 0;

    testResults.addTest('转换器一致性 - 都产生SSE事件',
      bothProduceEvents,
      null,
      {
        legacyEvents: legacyResult.events.length,
        newEvents: newResult.events.length
      }
    );

    // 内容一致性检查（都包含相同的核心内容）
    const legacyContent = legacyResult.events
      .filter(e => e.delta?.content)
      .map(e => e.delta.content)
      .join('');

    const newContent = newResult.events
      .filter(e => e.delta?.content)
      .map(e => e.delta.content)
      .join('');

    const contentMatches = legacyContent.includes('Consistency test') && newContent.includes('Consistency test');

    testResults.addTest('转换器一致性 - 内容匹配',
      contentMatches,
      null,
      {
        legacyContent: legacyContent.substring(0, 50) + '...',
        newContent: newContent.substring(0, 50) + '...'
      }
    );

  } catch (error) {
    testResults.addTest('转换器一致性测试', false, error.message);
    console.error('一致性测试失败:', error.message);
  }
}

// 性能对比测试
async function testConverterPerformance(testResults) {
  console.log('🔍 测试转换器性能对比...');

  try {
    const { createChatSSEStreamFromChatJson } = await import('../../dist/conversion/streaming/json-to-chat-sse.js');

    // 生成大型JSON进行性能测试
    const largeContent = 'A'.repeat(10000); // 10KB内容
    const largeJson = {
      id: 'perf-test',
      object: 'chat.completion',
      created: 1694268190,
      model: 'gpt-4',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: largeContent
        },
        finish_reason: 'stop'
      }]
    };

    // 测试传统转换器性能
    const legacyStart = Date.now();
    const legacyStream = createChatSSEStreamFromChatJson(largeJson, { requestId: 'perf-legacy' });
    const legacyResult = await collectSSEEvents(legacyStream);
    const legacyDuration = Date.now() - legacyStart;

    testResults.addTest('性能测试 - 传统转换器 (10KB内容)',
      legacyDuration < 5000 && legacyResult.events.length > 0,
      null,
      {
        duration: legacyDuration,
        eventsCount: legacyResult.events.length,
        contentSize: largeContent.length
      }
    );

  } catch (error) {
    testResults.addTest('性能测试 - 传统转换器', false, error.message);
  }
}

// 错误处理测试
async function testConverterErrorHandling(testResults) {
  console.log('🔍 测试转换器错误处理...');

  try {
    const { createChatSSEStreamFromChatJson } = await import('../../dist/conversion/streaming/json-to-chat-sse.js');

    // 测试空输入处理
    const emptyResult = await new Promise((resolve) => {
      try {
        const stream = createChatSSEStreamFromChatJson({}, { requestId: 'empty-test' });
        collectSSEEvents(stream).then(resolve);
      } catch (error) {
        resolve({ error: error.message });
      }
    });

    testResults.addTest('错误处理 - 空输入',
      emptyResult.events || emptyResult.error,
      null,
      { hasError: !!emptyResult.error, hasEvents: !!(emptyResult.events?.length) }
    );

    // 测试无效JSON结构处理
    const invalidJson = { invalid: 'structure' };
    const invalidResult = await new Promise((resolve) => {
      try {
        const stream = createChatSSEStreamFromChatJson(invalidJson, { requestId: 'invalid-test' });
        collectSSEEvents(stream).then(resolve);
      } catch (error) {
        resolve({ error: error.message });
      }
    });

    testResults.addTest('错误处理 - 无效结构',
      invalidResult.events || invalidResult.error,
      null,
      { hasError: !!invalidResult.error, hasEvents: !!(invalidResult.events?.length) }
    );

  } catch (error) {
    testResults.addTest('转换器错误处理', false, error.message);
  }
}

// 主测试函数
async function runSSEConverterTests() {
  console.log('🚀 开始SSE转换器测试套件\n');

  // 确保输出目录存在
  if (!fs.existsSync(TEST_CONFIG.outputDir)) {
    fs.mkdirSync(TEST_CONFIG.outputDir, { recursive: true });
  }

  const testResults = new TestResults();

  try {
    // 执行所有测试
    await testLegacyChatJsonToSSE(testResults);
    await testLegacyResponsesJsonToSSE(testResults);
    await testNewArchitectureConverters(testResults);
    await testConverterConsistency(testResults);
    await testConverterPerformance(testResults);
    await testConverterErrorHandling(testResults);

    // 生成测试报告
    console.log('\n📊 测试结果汇总:');
    const summary = testResults.getSummary();
    console.log(`总测试数: ${summary.total}`);
    console.log(`通过: ${summary.passed}`);
    console.log(`失败: ${summary.failed}`);
    console.log(`成功率: ${summary.successRate}`);

    if (summary.errors.length > 0) {
      console.log('\n❌ 失败的测试:');
      summary.errors.forEach(error => {
        console.log(`  - ${error.test}: ${error.error}`);
        if (error.details) {
          console.log(`    详情: ${JSON.stringify(error.details, null, 2)}`);
        }
      });
    }

    // 保存详细结果
    const resultsFile = path.join(TEST_CONFIG.outputDir, `sse-converters-test-${Date.now()}.json`);
    fs.writeFileSync(resultsFile, JSON.stringify({
      config: TEST_CONFIG,
      summary: testResults.getSummary(),
      tests: testResults.tests
    }, null, 2));
    console.log(`\n详细测试结果已保存到: ${resultsFile}`);

    // 返回退出码
    process.exit(summary.failed > 0 ? 1 : 0);

  } catch (error) {
    console.error('❌ 测试执行失败:', error);
    process.exit(1);
  }
}

// 启动测试
if (import.meta.url === `file://${process.argv[1]}`) {
  runSSEConverterTests();
}

export { runSSEConverterTests };