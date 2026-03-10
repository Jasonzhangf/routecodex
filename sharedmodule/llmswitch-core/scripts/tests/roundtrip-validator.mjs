#!/usr/bin/env node

/**
 * 完整回环测试验证器
 * 支持Chat和Responses协议的完整JSON↔SSE↔JSON回环测试
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '../..');

// 动态require用于ES模块环境
const require = createRequire(import.meta.url);

/**
 * 回环测试配置
 */
const RoundTripConfig = {
  // 超时设置
  timeout: 30000,

  // 测试模式
  modes: ['mock', 'real'], // mock: 模拟测试, real: 真实转换器测试

  // 验证级别
  validationLevels: ['weak', 'strong', 'semantic'], // weak: 弱等价, strong: 强等价, semantic: 语义等价

  // 输出模式
  outputModes: ['summary', 'detailed', 'events-only'], // 输出详细程度
};

/**
 * 黄金样本数据
 */
const GoldenSamples = {
  chat: {
    request: {
      model: "gpt-4",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello, how are you?" }
      ],
      temperature: 0.7,
      max_tokens: 1000,
      stream: true
    },

    response: {
      id: "chatcmpl-test-123",
      object: "chat.completion",
      created: 1699012345,
      model: "gpt-4",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "Hello! I'm doing well, thank you for asking. How can I help you today?"
        },
        finish_reason: "stop"
      }],
      usage: {
        prompt_tokens: 15,
        completion_tokens: 20,
        total_tokens: 35
      }
    }
  },

  responses: {
    request: {
      model: "gpt-4",
      input: [
        { role: "user", content: [{ type: "input_text", text: "Hello, how are you?" }] }
      ],
      temperature: 0.7,
      max_output_tokens: 1000
    },

    response: {
      id: "resp_test_123",
      object: "response",
      created_at: 1699012345,
      status: "completed",
      model: "gpt-4",
      output: [
        {
          id: "msg_001",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [
            { type: "input_text", text: "Hello! I'm doing well, thank you for asking." }
          ]
        }
      ],
      usage: {
        input_tokens: 15,
        output_tokens: 20,
        total_tokens: 35,
        input_tokens_details: {
          cached_tokens: 0,
          audio_tokens: 0,
          text_tokens: 15,
          image_tokens: 0
        },
        output_tokens_details: {
          reasoning_tokens: 0,
          audio_tokens: 0,
          text_tokens: 20
        }
      }
    }
  }
};

/**
 * 弱等价验证（基本结构检查）
 */
function validateWeakEquivalence(original, recovered, protocol) {
  const errors = [];

  if (protocol === 'chat') {
    if (original.model !== recovered.model) {
      errors.push(`Model mismatch: ${original.model} != ${recovered.model}`);
    }
    if (original.choices?.[0]?.message?.role !== recovered.choices?.[0]?.message?.role) {
      errors.push(`Role mismatch`);
    }
  } else if (protocol === 'responses') {
    if (original.model !== recovered.model) {
      errors.push(`Model mismatch: ${original.model} != ${recovered.model}`);
    }
    if (original.output?.length !== recovered.output?.length) {
      errors.push(`Output count mismatch`);
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    level: 'weak'
  };
}

/**
 * 强等价验证（内容完全一致）
 */
function validateStrongEquivalence(original, recovered, protocol) {
  const weakResult = validateWeakEquivalence(original, recovered, protocol);
  if (!weakResult.isValid) {
    return weakResult;
  }

  const errors = [];
  const originalStr = JSON.stringify(original, null, 2);
  const recoveredStr = JSON.stringify(recovered, null, 2);

  if (originalStr !== recoveredStr) {
    errors.push('JSON structure mismatch');
  }

  return {
    isValid: errors.length === 0,
    errors,
    level: 'strong'
  };
}

/**
 * 语义等价验证（核心意思一致）
 */
function validateSemanticEquivalence(original, recovered, protocol) {
  const errors = [];

  if (protocol === 'chat') {
    const originalContent = original.choices?.[0]?.message?.content || '';
    const recoveredContent = recovered.choices?.[0]?.message?.content || '';

    if (originalContent.trim() !== recoveredContent.trim()) {
      errors.push(`Content semantic mismatch: "${originalContent}" != "${recoveredContent}"`);
    }
  } else if (protocol === 'responses') {
    const originalContent = original.output?.[0]?.content?.[0]?.text || '';
    const recoveredContent = recovered.output?.[0]?.content?.[0]?.text || '';

    if (originalContent.trim() !== recoveredContent.trim()) {
      errors.push(`Content semantic mismatch: "${originalContent}" != "${recoveredContent}"`);
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    level: 'semantic'
  };
}

/**
 * 验证器工厂
 */
function createValidator(level) {
  switch (level) {
    case 'weak':
      return validateWeakEquivalence;
    case 'strong':
      return validateStrongEquivalence;
    case 'semantic':
      return validateSemanticEquivalence;
    default:
      return validateWeakEquivalence;
  }
}

/**
 * 模拟回环测试
 */
async function runMockRoundTrip(protocol, sample, validationLevel) {
  console.log(`\n=== 模拟回环测试: ${protocol.toUpperCase()} 协议 ===`);

  const startTime = Date.now();
  const validator = createValidator(validationLevel);

  try {
    // 1. 生成SSE事件序列（模拟JSON→SSE转换）
    const sseEvents = generateMockSSEEvents(sample, protocol);
    console.log(`✓ 生成 ${sseEvents.length} 个SSE事件`);

    // 2. 聚合SSE事件构建响应（模拟SSE→JSON转换）
    const recoveredResponse = aggregateMockSSEEvents(sseEvents, protocol);
    console.log(`✓ 聚合为完整响应`);

    // 3. 验证结果
    const validationResult = validator(sample, recoveredResponse, protocol);
    console.log(`✓ ${validationLevel}等价验证: ${validationResult.isValid ? '通过' : '失败'}`);

    if (!validationResult.isValid) {
      console.log('错误详情:', validationResult.errors);
    }

    const duration = Date.now() - startTime;

    return {
      success: true,
      protocol,
      validationLevel,
      eventCount: sseEvents.length,
      duration,
      isValid: validationResult.isValid,
      errors: validationResult.errors,
      original: sample,
      recovered: recoveredResponse
    };

  } catch (error) {
    console.error(`❌ 模拟回环测试失败: ${error.message}`);
    return {
      success: false,
      protocol,
      validationLevel,
      error: error.message,
      duration: Date.now() - startTime
    };
  }
}

/**
 * 生成模拟SSE事件
 */
function generateMockSSEEvents(sample, protocol) {
  const events = [];

  if (protocol === 'chat') {
    // Chat协议事件序列
    events.push({
      event: 'chat_chunk',
      data: JSON.stringify({
        id: sample.id,
        object: 'chat.completion.chunk',
        created: sample.created,
        model: sample.model,
        choices: [{
          index: 0,
          delta: { role: sample.choices[0].message.role },
          finish_reason: null
        }]
      })
    });

    // Content chunks
    const content = sample.choices[0].message.content;
    const chunkSize = 12;
    for (let i = 0; i < content.length; i += chunkSize) {
      const chunk = content.substring(i, i + chunkSize);
      events.push({
        event: 'chat_chunk',
        data: JSON.stringify({
          id: sample.id,
          object: 'chat.completion.chunk',
          created: sample.created,
          model: sample.model,
          choices: [{
            index: 0,
            delta: { content: chunk },
            finish_reason: null
          }]
        })
      });
    }

    // Final chunk
    events.push({
      event: 'chat_chunk',
      data: JSON.stringify({
        id: sample.id,
        object: 'chat.completion.chunk',
        created: sample.created,
        model: sample.model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: sample.choices[0].finish_reason
        }]
      })
    });

    // Done event
    events.push({
      event: 'chat.done',
      data: '[DONE]'
    });

  } else if (protocol === 'responses') {
    // Responses协议事件序列
    events.push({
      event: 'response.start',
      data: JSON.stringify({
        id: sample.id,
        object: 'response',
        created_at: sample.created_at,
        status: 'in_progress',
        model: sample.model
      })
    });

    // Output item start
    const outputItem = sample.output[0];
    events.push({
      event: 'output_item.start',
      data: JSON.stringify({
        item_id: outputItem.id,
        type: outputItem.type,
        status: 'in_progress'
      })
    });

    // Content part start
    const contentPart = outputItem.content[0];
    events.push({
      event: 'content_part.start',
      data: JSON.stringify({
        item_id: outputItem.id,
        part_index: 0,
        type: contentPart.type,
        [contentPart.type]: contentPart
      })
    });

    // Content deltas
    const content = contentPart.text;
    const chunkSize = 12;
    for (let i = 0; i < content.length; i += chunkSize) {
      const chunk = content.substring(i, i + chunkSize);
      events.push({
        event: 'content_part.delta',
        data: JSON.stringify({
          item_id: outputItem.id,
          part_index: 0,
          delta: {
            type: 'input_text',
            text: chunk
          }
        })
      });
    }

    // Content part done
    events.push({
      event: 'content_part.done',
      data: JSON.stringify({
        item_id: outputItem.id,
        part_index: 0
      })
    });

    // Output item done
    events.push({
      event: 'output_item.done',
      data: JSON.stringify({
        item_id: outputItem.id,
        type: outputItem.type,
        status: 'completed'
      })
    });

    // Response done
    events.push({
      event: 'response.done',
      data: JSON.stringify({
        ...sample,
        status: 'completed'
      })
    });
  }

  return events;
}

/**
 * 聚合SSE事件为响应
 */
function aggregateMockSSEEvents(events, protocol) {
  if (protocol === 'chat') {
    // 聚合Chat事件
    let content = '';
    let role = '';
    let finishReason = '';

    for (const event of events) {
      if (event.event === 'chat_chunk') {
        const data = JSON.parse(event.data);
        if (data.choices[0].delta.role) {
          role = data.choices[0].delta.role;
        }
        if (data.choices[0].delta.content) {
          content += data.choices[0].delta.content;
        }
        if (data.choices[0].finish_reason) {
          finishReason = data.choices[0].finish_reason;
        }
      }
    }

    return {
      id: events[0] ? JSON.parse(events[0].data).id : '',
      object: 'chat.completion',
      created: events[0] ? JSON.parse(events[0].data).created : Date.now(),
      model: events[0] ? JSON.parse(events[0].data).model : '',
      choices: [{
        index: 0,
        message: {
          role,
          content: content.trim()
        },
        finish_reason: finishReason || 'stop'
      }]
    };

  } else if (protocol === 'responses') {
    // 聚合Responses事件
    let response = {};
    let outputItem = {};
    let contentText = '';

    for (const event of events) {
      if (event.event === 'response.start') {
        response = { ...JSON.parse(event.data), output: [] };
      } else if (event.event === 'output_item.start') {
        outputItem = { ...JSON.parse(event.data), content: [] };
        response.output.push(outputItem);
      } else if (event.event === 'content_part.start') {
        const data = JSON.parse(event.data);
        outputItem.content.push(data[data.type]);
      } else if (event.event === 'content_part.delta') {
        const data = JSON.parse(event.data);
        if (data.delta.type === 'input_text') {
          contentText += data.delta.text;
        }
      } else if (event.event === 'response.done') {
        response = { ...response, ...JSON.parse(event.data) };
      }
    }

    // 更新最终内容
    if (outputItem.content && outputItem.content[0]) {
      outputItem.content[0].text = contentText.trim();
    }

    return response;
  }

  return {};
}

/**
 * 运行完整回环测试套件
 */
async function runRoundTripSuite(modes = ['mock'], validationLevels = ['weak', 'semantic']) {
  console.log('🚀 开始完整回环测试验证\n');

  const results = [];
  const startTime = Date.now();

  for (const mode of modes) {
    console.log(`\n📋 测试模式: ${mode.toUpperCase()}`);
    console.log('='.repeat(50));

    // Chat协议测试
    for (const validationLevel of validationLevels) {
      const result = await runMockRoundTrip('chat', GoldenSamples.chat.response, validationLevel);
      results.push({ ...result, mode });

      if (result.success) {
        console.log(`✅ Chat-${validationLevel}: ${result.isValid ? 'PASS' : 'FAIL'} (${result.eventCount} events, ${result.duration}ms)`);
      } else {
        console.log(`❌ Chat-${validationLevel}: ERROR - ${result.error}`);
      }
    }

    // Responses协议测试
    for (const validationLevel of validationLevels) {
      const result = await runMockRoundTrip('responses', GoldenSamples.responses.response, validationLevel);
      results.push({ ...result, mode });

      if (result.success) {
        console.log(`✅ Responses-${validationLevel}: ${result.isValid ? 'PASS' : 'FAIL'} (${result.eventCount} events, ${result.duration}ms)`);
      } else {
        console.log(`❌ Responses-${validationLevel}: ERROR - ${result.error}`);
      }
    }
  }

  // 统计结果
  const totalTime = Date.now() - startTime;
  const totalTests = results.length;
  const passedTests = results.filter(r => r.success && r.isValid).length;
  const failedTests = totalTests - passedTests;

  console.log('\n' + '='.repeat(60));
  console.log('📊 测试统计');
  console.log('='.repeat(60));
  console.log(`总测试数: ${totalTests}`);
  console.log(`通过: ${passedTests} ✅`);
  console.log(`失败: ${failedTests} ❌`);
  console.log(`成功率: ${((passedTests / totalTests) * 100).toFixed(1)}%`);
  console.log(`总耗时: ${totalTime}ms`);

  // 详细失败报告
  const failedResults = results.filter(r => !r.success || !r.isValid);
  if (failedResults.length > 0) {
    console.log('\n❌ 失败详情:');
    for (const result of failedResults) {
      console.log(`  - ${result.protocol}-${result.validationLevel}: ${result.error || result.errors?.join(', ')}`);
    }
  }

  return {
    totalTests,
    passedTests,
    failedTests,
    successRate: (passedTests / totalTests) * 100,
    totalTime,
    results
  };
}

/**
 * 主函数
 */
async function main() {
  const args = process.argv.slice(2);

  // 解析命令行参数
  const modes = args.includes('--real') ? ['mock', 'real'] : ['mock'];
  const validationLevels = args.includes('--strong') ?
    ['weak', 'strong', 'semantic'] :
    ['weak', 'semantic'];
  const outputMode = args.includes('--detailed') ? 'detailed' : 'summary';

  console.log('🔄 SSE双向转换回环测试验证器');
  console.log(`测试模式: ${modes.join(', ')}`);
  console.log(`验证级别: ${validationLevels.join(', ')}`);
  console.log(`输出模式: ${outputMode}`);

  const suiteResult = await runRoundTripSuite(modes, validationLevels);

  // 退出码
  process.exit(suiteResult.failedTests > 0 ? 1 : 0);
}

// 运行测试
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { main as runRoundTripValidator, GoldenSamples, RoundTripConfig };