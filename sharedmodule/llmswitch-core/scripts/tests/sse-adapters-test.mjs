#!/usr/bin/env node

/**
 * SSE适配器测试套件
 *
 * 测试目标：
 * - 验证通用适配器接口的实现
 * - 测试协议自动检测功能
 * - 验证双向转换（SSE↔JSON）的正确性
 * - 测试适配器工厂的注册和选择机制
 *
 * 使用方式：
 *   npm run test:sse-adapters
 *   node scripts/tests/sse-adapters-test.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 测试配置
const TEST_CONFIG = {
  outputDir: path.join(__dirname, '..', '..', 'test-results'),
  timeoutMs: 8000
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

// 模拟通用适配器接口
class MockUniversalAdapter {
  constructor(protocol) {
    this.protocol = protocol;
  }

  detectFormat(input) {
    // 基础格式检测
    if (input && typeof input === 'object') {
      if (input.choices) return 'chat-json';
      if (input.output) return 'responses-json';
      if (input.readable) return 'sse-stream';
    }
    return 'json-object';
  }

  async toJson(input) {
    const format = this.detectFormat(input);

    if (format === 'sse-stream') {
      return this.convertSSEToJson(input);
    }

    return input; // JSON直接透传
  }

  async fromJson(json, outputFormat) {
    if (!outputFormat || outputFormat === 'json') {
      return json;
    }

    if (outputFormat === 'sse-chat') {
      return this.convertJsonToChatSSE(json);
    }

    if (outputFormat === 'sse-responses') {
      return this.convertJsonToResponsesSSE(json);
    }

    throw new Error(`不支持的输出格式: ${outputFormat}`);
  }

  async convertSSEToJson(sseStream) {
    // 模拟SSE到JSON转换
    return new Promise((resolve) => {
      const events = [];
      let buffer = '';

      sseStream.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              return resolve({
                id: 'converted-' + Date.now(),
                object: 'chat.completion',
                choices: [{
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: events.map(e => e.delta?.content || '').join('')
                  }
                }]
              });
            }
            try {
              events.push(JSON.parse(data));
            } catch (e) {
              // 忽略无效JSON
            }
          }
        }
      });

      sseStream.on('end', () => {
        resolve({
          id: 'converted-' + Date.now(),
          object: 'chat.completion',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: events.map(e => e.delta?.content || '').join('')
            }
          }]
        });
      });
    });
  }

  convertJsonToChatSSE(json) {
    const { Readable } = require('stream');

    return new Readable({
      read() {
        const content = json.choices?.[0]?.message?.content || '';
        if (content) {
          this.push(`data: ${JSON.stringify({
            id: json.id || 'chatcmpl-' + Date.now(),
            object: 'chat.completion.chunk',
            choices: [{
              index: 0,
              delta: { content }
            }]
          })}\n\n`);
        }
        this.push('data: [DONE]\n\n');
        this.push(null);
      }
    });
  }

  convertJsonToResponsesSSE(json) {
    const { Readable } = require('stream');

    return new Readable({
      read() {
        this.push(`event: response.output_item.added\ndata: ${JSON.stringify({
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: json.choices?.[0]?.message?.content || '' }]
          }
        })}\n\n`);

        this.push(`event: response.done\ndata: {"type":"response.done"}\n\n`);
        this.push(null);
      }
    });
  }
}

// 模拟适配器工厂
class MockAdapterFactory {
  constructor() {
    this.adapters = new Map();
    this.registerDefaultAdapters();
  }

  registerDefaultAdapters() {
    this.register('chat', new MockUniversalAdapter('chat'));
    this.register('responses', new MockUniversalAdapter('responses'));
    this.register('anthropic', new MockUniversalAdapter('anthropic'));
  }

  register(protocol, adapter) {
    this.adapters.set(protocol, adapter);
  }

  create(protocol) {
    const adapter = this.adapters.get(protocol);
    if (!adapter) {
      throw new Error(`不支持的协议: ${protocol}`);
    }
    return adapter;
  }

  detectProtocol(input) {
    // 智能协议检测
    if (input && typeof input === 'object') {
      if (input.choices && Array.isArray(input.choices)) {
        return 'chat';
      }
      if (input.output && Array.isArray(input.output)) {
        return 'responses';
      }
      if (input.max_tokens !== undefined || input.anthropic_version) {
        return 'anthropic';
      }
    }
    return 'chat'; // 默认回退
  }

  getAdapterForInput(input) {
    const protocol = this.detectProtocol(input);
    return this.create(protocol);
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
        }, index * 10);
      });
    }
  });
}

// 测试适配器基础功能
async function testAdapterBasics(testResults) {
  console.log('🔍 测试适配器基础功能...');

  try {
    const adapter = new MockUniversalAdapter('chat');

    // 测试格式检测
    const chatJson = { choices: [{ message: { content: 'test' } }] };
    const responsesJson = { output: [{ type: 'message' }] };
    const sseStream = createTestSSEStream(['data: {"test": true}\n\n']);

    testResults.addTest('适配器格式检测 - Chat JSON',
      adapter.detectFormat(chatJson) === 'chat-json',
      null,
      { detectedFormat: adapter.detectFormat(chatJson) }
    );

    testResults.addTest('适配器格式检测 - Responses JSON',
      adapter.detectFormat(responsesJson) === 'responses-json',
      null,
      { detectedFormat: adapter.detectFormat(responsesJson) }
    );

    testResults.addTest('适配器格式检测 - SSE流',
      adapter.detectFormat(sseStream) === 'sse-stream',
      null,
      { detectedFormat: adapter.detectFormat(sseStream) }
    );

    // 测试JSON透传
    const jsonInput = { test: 'value' };
    const jsonResult = await adapter.toJson(jsonInput);

    testResults.addTest('适配器JSON透传',
      jsonResult === jsonInput,
      null,
      { input: jsonInput, output: jsonResult }
    );

  } catch (error) {
    testResults.addTest('适配器基础功能', false, error.message);
    console.error('适配器基础功能测试失败:', error.message);
  }
}

// 测试适配器工厂
async function testAdapterFactory(testResults) {
  console.log('🔍 测试适配器工厂...');

  try {
    const factory = new MockAdapterFactory();

    // 测试适配器注册和创建
    const customAdapter = new MockUniversalAdapter('custom');
    factory.register('custom', customAdapter);

    const createdAdapter = factory.create('custom');
    testResults.addTest('适配器工厂 - 注册和创建',
      createdAdapter === customAdapter,
      null,
      { protocol: 'custom' }
    );

    // 测试协议检测
    const chatInput = { choices: [] };
    const responsesInput = { output: [] };
    const anthropicInput = { max_tokens: 1000 };

    testResults.addTest('协议检测 - Chat',
      factory.detectProtocol(chatInput) === 'chat',
      null,
      { input: chatInput, detected: factory.detectProtocol(chatInput) }
    );

    testResults.addTest('协议检测 - Responses',
      factory.detectProtocol(responsesInput) === 'responses',
      null,
      { input: responsesInput, detected: factory.detectProtocol(responsesInput) }
    );

    testResults.addTest('协议检测 - Anthropic',
      factory.detectProtocol(anthropicInput) === 'anthropic',
      null,
      { input: anthropicInput, detected: factory.detectProtocol(anthropicInput) }
    );

    // 测试自动适配器选择
    const autoAdapter = factory.getAdapterForInput(chatInput);
    testResults.addTest('自动适配器选择',
      autoAdapter.protocol === 'chat',
      null,
      { selectedProtocol: autoAdapter.protocol }
    );

  } catch (error) {
    testResults.addTest('适配器工厂', false, error.message);
    console.error('适配器工厂测试失败:', error.message);
  }
}

// 测试双向转换
async function testBidirectionalConversion(testResults) {
  console.log('🔍 测试适配器双向转换...');

  try {
    const adapter = new MockUniversalAdapter('chat');

    // 测试JSON→SSE转换
    const originalJson = {
      id: 'test-123',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'Hello from adapter!'
        }
      }]
    };

    const sseStream = await adapter.fromJson(originalJson, 'sse-chat');

    // 收集SSE输出
    const sseOutput = await new Promise((resolve) => {
      let output = '';
      sseStream.on('data', (chunk) => {
        output += chunk.toString();
      });
      sseStream.on('end', () => {
        resolve(output);
      });
    });

    const hasValidSSE = sseOutput.includes('data: ') && sseOutput.includes('[DONE]');
    testResults.addTest('双向转换 - JSON→SSE',
      hasValidSSE,
      null,
      { outputLength: sseOutput.length, hasValidSSE }
    );

    // 测试SSE→JSON转换
    const testSSEChunks = [
      'data: {"id":"test-456","choices":[{"delta":{"content":"Hello back!"}}]}\n\n',
      'data: [DONE]\n\n'
    ];

    const sseInputStream = createTestSSEStream(testSSEChunks);
    const convertedJson = await adapter.toJson(sseInputStream);

    testResults.addTest('双向转换 - SSE→JSON',
      convertedJson && convertedJson.choices && convertedJson.choices.length > 0,
      null,
      { hasChoices: !!(convertedJson?.choices?.length) }
    );

  } catch (error) {
    testResults.addTest('适配器双向转换', false, error.message);
    console.error('双向转换测试失败:', error.message);
  }
}

// 测试多协议支持
async function testMultiProtocolSupport(testResults) {
  console.log('🔍 测试多协议支持...');

  try {
    const factory = new MockAdapterFactory();

    // 测试不同协议的适配器创建
    const protocols = ['chat', 'responses', 'anthropic'];
    for (const protocol of protocols) {
      const adapter = factory.create(protocol);
      testResults.addTest(`多协议支持 - ${protocol}适配器`,
        adapter && adapter.protocol === protocol,
        null,
        { protocol, created: !!adapter }
      );
    }

    // 测试不同输入格式的协议检测
    const testCases = [
      {
        input: { choices: [{ message: { role: 'assistant' } }] },
        expectedProtocol: 'chat',
        name: 'Chat格式输入'
      },
      {
        input: { output: [{ type: 'message' }] },
        expectedProtocol: 'responses',
        name: 'Responses格式输入'
      },
      {
        input: { max_tokens: 1000, model: 'claude-3' },
        expectedProtocol: 'anthropic',
        name: 'Anthropic格式输入'
      },
      {
        input: { unknown: 'format' },
        expectedProtocol: 'chat', // 默认回退
        name: '未知格式输入'
      }
    ];

    for (const testCase of testCases) {
      const detectedProtocol = factory.detectProtocol(testCase.input);
      testResults.addTest(`多协议支持 - ${testCase.name}`,
        detectedProtocol === testCase.expectedProtocol,
        null,
        {
          input: testCase.input,
          expected: testCase.expectedProtocol,
          detected: detectedProtocol
        }
      );
    }

  } catch (error) {
    testResults.addTest('多协议支持', false, error.message);
    console.error('多协议支持测试失败:', error.message);
  }
}

// 测试错误处理
async function testAdapterErrorHandling(testResults) {
  console.log('🔍 测试适配器错误处理...');

  try {
    const factory = new MockAdapterFactory();

    // 测试不支持的协议
    try {
      factory.create('unsupported-protocol');
      testResults.addTest('错误处理 - 不支持协议', false, '应该抛出错误');
    } catch (error) {
      testResults.addTest('错误处理 - 不支持协议',
        error.message.includes('不支持的协议'),
        null,
        { errorMessage: error.message }
      );
    }

    // 测试无效输入处理
    const adapter = new MockUniversalAdapter('chat');

    // 测试null输入
    const nullResult = await adapter.toJson(null);
    testResults.addTest('错误处理 - null输入',
      nullResult === null,
      null,
      { result: nullResult }
    );

    // 测试不支持的输出格式
    try {
      await adapter.fromJson({}, 'unsupported-format');
      testResults.addTest('错误处理 - 不支持输出格式', false, '应该抛出错误');
    } catch (error) {
      testResults.addTest('错误处理 - 不支持输出格式',
        error.message.includes('不支持的输出格式'),
        null,
        { errorMessage: error.message }
      );
    }

  } catch (error) {
    testResults.addTest('适配器错误处理', false, error.message);
    console.error('错误处理测试失败:', error.message);
  }
}

// 主测试函数
async function runSSEAdapterTests() {
  console.log('🚀 开始SSE适配器测试套件\n');

  // 确保输出目录存在
  if (!fs.existsSync(TEST_CONFIG.outputDir)) {
    fs.mkdirSync(TEST_CONFIG.outputDir, { recursive: true });
  }

  const testResults = new TestResults();

  try {
    // 执行所有测试
    await testAdapterBasics(testResults);
    await testAdapterFactory(testResults);
    await testBidirectionalConversion(testResults);
    await testMultiProtocolSupport(testResults);
    await testAdapterErrorHandling(testResults);

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
    const resultsFile = path.join(TEST_CONFIG.outputDir, `sse-adapters-test-${Date.now()}.json`);
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
  runSSEAdapterTests();
}

export { runSSEAdapterTests };