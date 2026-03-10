#!/usr/bin/env node

/**
 * SSE解析器测试套件
 *
 * 测试目标：
 * - 验证OpenAISSEParser的正确性
 * - 对比新旧解析器实现的差异
 * - 确保解析结果的准确性
 * - 测试错误处理和边界条件
 *
 * 使用方式：
 *   npm run test:sse-parsers
 *   node scripts/tests/sse-parsers-test.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// 测试配置
const TEST_CONFIG = {
  samplesDir: path.join(__dirname, '..', '..', 'payloads'),
  outputDir: path.join(__dirname, '..', '..', 'test-results'),
  maxSamples: 10,
  timeoutMs: 5000
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

  saveResults() {
    const resultsFile = path.join(TEST_CONFIG.outputDir, `sse-parsers-test-${Date.now()}.json`);
    fs.writeFileSync(resultsFile, JSON.stringify({
      config: TEST_CONFIG,
      summary: this.getSummary(),
      tests: this.tests
    }, null, 2));
    console.log(`测试结果已保存到: ${resultsFile}`);
    return resultsFile;
  }
}

// 创建测试用的SSE流
function createTestSSEStream(chunks) {
  const { Readable } = require('stream');

  return new Readable({
    read() {
      chunks.forEach((chunk, index) => {
        setTimeout(() => {
          this.push(chunk);
          if (index === chunks.length - 1) {
            this.push(null);
          }
        }, index * 10); // 10ms间隔模拟真实流
      });
    }
  });
}

// 传统OpenAI SSE解析器测试
async function testLegacyOpenAISSEParser(testResults) {
  console.log('🔍 测试传统OpenAI SSE解析器...');

  try {
    const { OpenAISSEParser } = require('../../src/conversion/streaming/openai-sse-parser.js');

    // 测试用例1: 基础Chat解析
    const testChunks1 = [
      'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1694268190,"model":"gpt-3.5-turbo-0613","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1694268190,"model":"gpt-3.5-turbo-0613","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n'
    ];

    const result1 = await new Promise((resolve, reject) => {
      const events = [];
      const parser = new OpenAISSEParser(
        createTestSSEStream(testChunks1),
        (chunk) => events.push(chunk),
        () => resolve({ events, count: events.length })
      );

      parser.start();
      setTimeout(() => reject(new Error('解析器超时')), TEST_CONFIG.timeoutMs);
    });

    testResults.addTest('Legacy OpenAI SSE Parser - 基础Chat解析',
      result1.count === 2 && result1.events[0].delta.role === 'assistant' && result1.events[1].delta.content === 'Hello',
      null,
      { eventsCount: result1.count, firstEvent: result1.events[0], secondEvent: result1.events[1] }
    );

    // 测试用例2: 工具调用解析
    const testChunks2 = [
      'data: {"id":"chatcmpl-456","object":"chat.completion.chunk","created":1694268190,"model":"gpt-3.5-turbo-0613","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-456","object":"chat.completion.chunk","created":1694268190,"model":"gpt-3.5-turbo-0613","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc123","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-456","object":"chat.completion.chunk","created":1694268190,"model":"gpt-3.5-turbo-0613","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"location\\""}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-456","object":"chat.completion.chunk","created":1694268190,"model":"gpt-3.5-turbo-0613","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"": \\"Tokyo\\"}}]},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n'
    ];

    const result2 = await new Promise((resolve, reject) => {
      const events = [];
      const parser = new OpenAISSEParser(
        createTestSSEStream(testChunks2),
        (chunk) => events.push(chunk),
        () => resolve({ events, count: events.length })
      );

      parser.start();
      setTimeout(() => reject(new Error('解析器超时')), TEST_CONFIG.timeoutMs);
    });

    const hasValidToolCall = result2.events.some(e =>
      e.delta?.tool_calls?.[0]?.function?.name === 'get_weather'
    );

    testResults.addTest('Legacy OpenAI SSE Parser - 工具调用解析',
      result2.count >= 3 && hasValidToolCall,
      null,
      { eventsCount: result2.count, hasValidToolCall }
    );

  } catch (error) {
    testResults.addTest('Legacy OpenAI SSE Parser', false, error.message);
    console.error('传统解析器测试失败:', error.message);
  }
}

// 新架构SSE解析器测试
async function testNewArchitectureParsers(testResults) {
  console.log('🔍 测试新架构SSE解析器...');

  try {
    const { ChatSseToJsonConverter } = require('../../src/sse/sse-to-json/chat-sse-to-json-converter.js');

    const converter = new ChatSseToJsonConverter();

    // 测试用例1: Chat SSE到JSON转换
    const testSSEStream = createTestSSEStream([
      'data: {"id":"chatcmpl-789","object":"chat.completion.chunk","created":1694268190,"model":"gpt-3.5-turbo-0613","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-789","object":"chat.completion.chunk","created":1694268190,"model":"gpt-3.5-turbo-0613","choices":[{"index":0,"delta":{"content":"Hi there!"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-789","object":"chat.completion.chunk","created":1694268190,"model":"gpt-3.5-turbo-0613","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n'
    ]);

    const result1 = await converter.convertSseToJson(
      testSSEStream,
      { requestId: 'test-123', model: 'gpt-3.5-turbo-0613' }
    );

    testResults.addTest('New Architecture Chat SSE到JSON转换',
      result1 && result1.id === 'chatcmpl-789' && result1.choices && result1.choices.length > 0,
      null,
      { resultId: result1?.id, hasChoices: !!(result1?.choices?.length) }
    );

  } catch (error) {
    testResults.addTest('New Architecture SSE Parsers', false, error.message);
    console.error('新架构解析器测试失败:', error.message);
  }
}

// 解析器性能对比测试
async function testParserPerformance(testResults) {
  console.log('🔍 测试解析器性能对比...');

  const largeChunk = Array(100).fill().map((_, i) =>
    `data: {"id":"test-${i}","object":"chat.completion.chunk","created":1694268190,"model":"gpt-3.5-turbo-0613","choices":[{"index":0,"delta":{"content":"word${i} "},"finish_reason":null}]}\n\n`
  ).join('') + 'data: [DONE]\n\n';

  try {
    // 测试传统解析器性能
    const legacyStart = Date.now();
    const legacyResult = await new Promise((resolve, reject) => {
      let eventCount = 0;
      const { OpenAISSEParser } = require('../../src/conversion/streaming/openai-sse-parser.js');
      const parser = new OpenAISSEParser(
        createTestSSEStream([largeChunk]),
        () => eventCount++,
        () => resolve({ eventCount, duration: Date.now() - legacyStart })
      );
      parser.start();
    });

    testResults.addTest('性能测试 - 传统解析器',
      legacyResult.eventCount === 100 && legacyResult.duration < 3000,
      null,
      { eventCount: legacyResult.eventCount, duration: legacyResult.duration }
    );

  } catch (error) {
    testResults.addTest('性能测试 - 传统解析器', false, error.message);
  }
}

// 错误处理和边界条件测试
async function testErrorHandling(testResults) {
  console.log('🔍 测试错误处理和边界条件...');

  try {
    const { OpenAISSEParser } = require('../../src/conversion/streaming/openai-sse-parser.js');

    // 测试无效JSON处理
    const invalidJsonChunks = [
      'data: {"invalid": json content}\n\n',
      'data: {"valid":"json"}\n\n',
      'data: [DONE]\n\n'
    ];

    const result1 = await new Promise((resolve) => {
      let validEvents = 0;
      const parser = new OpenAISSEParser(
        createTestSSEStream(invalidJsonChunks),
        (chunk) => validEvents++,
        () => resolve({ validEvents })
      );
      parser.start();
    });

    testResults.addTest('错误处理 - 无效JSON',
      result1.validEvents === 1, // 只有有效JSON被解析
      null,
      { validEvents: result1.validEvents }
    );

    // 测试空流处理
    const emptyStreamResult = await new Promise((resolve) => {
      let eventCount = 0;
      const parser = new OpenAISSEParser(
        createTestSSEStream([]),
        () => eventCount++,
        () => resolve({ eventCount })
      );
      parser.start();
    });

    testResults.addTest('错误处理 - 空流',
      emptyStreamResult.eventCount === 0,
      null,
      { eventCount: emptyStreamResult.eventCount }
    );

  } catch (error) {
    testResults.addTest('错误处理和边界条件', false, error.message);
  }
}

// 主测试函数
async function runSSEParserTests() {
  console.log('🚀 开始SSE解析器测试套件\n');

  // 确保输出目录存在
  if (!fs.existsSync(TEST_CONFIG.outputDir)) {
    fs.mkdirSync(TEST_CONFIG.outputDir, { recursive: true });
  }

  const testResults = new TestResults();

  try {
    // 执行所有测试
    await testLegacyOpenAISSEParser(testResults);
    await testNewArchitectureParsers(testResults);
    await testParserPerformance(testResults);
    await testErrorHandling(testResults);

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
      });
    }

    // 保存详细结果
    const resultsFile = testResults.saveResults();
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
  runSSEParserTests();
}

export { runSSEParserTests };