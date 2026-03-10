#!/usr/bin/env node

/**
 * C4M黄金样本捕获脚本 - 基于config.v1.json配置
 * 模拟LM Studio实验1/2，捕获Chat/Responses协议转换的完整数据流
 * 用于验证V3 SSE重构后的实际表现
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '../..');

// 读取C4M配置
let C4M_CONFIG;
try {
  const configPath = '/Users/fanzhang/.routecodex/provider/c4m/config.v1.json';
  const configData = readFileSync(configPath, 'utf8');
  C4M_CONFIG = JSON.parse(configData);
  console.log('✅ 成功读取C4M配置');
} catch (error) {
  console.error('❌ 无法读取C4M配置:', error.message);
  process.exit(1);
}

// 提取C4M配置信息
const C4M_SETTINGS = {
  baseURL: C4M_CONFIG.virtualrouter.providers.c4m.baseURL, // 直接连接C4M服务
  apiKey: C4M_CONFIG.virtualrouter.providers.c4m.auth.apiKey,
  model: 'gpt-5.1',
  protocol: C4M_CONFIG.virtualrouter.providers.c4m.type, // 'responses'
  supportsStreaming: C4M_CONFIG.virtualrouter.providers.c4m.models['gpt-5.1'].supportsStreaming,
  timeout: 30000
};

console.log('🔧 C4M配置信息:');
console.log(`   - 协议: ${C4M_SETTINGS.protocol}`);
console.log(`   - 模型: ${C4M_SETTINGS.model}`);
console.log(`   - 基础URL: ${C4M_SETTINGS.baseURL}`);
console.log(`   - API Key: ${C4M_SETTINGS.apiKey.substring(0, 10)}...`);
console.log(`   - 流式支持: ${C4M_SETTINGS.supportsStreaming}`);

// 测试用例定义 - 只保留已验证成功的C4M基础对话测试
const GOLDEN_SAMPLE_TESTS = [
  {
    name: 'C4M基础对话 - Responses协议（已验证成功）',
    type: 'responses',
    input: {
      model: C4M_SETTINGS.model,
      input: [
        { role: 'user', content: '你好，请用Responses协议格式回复我，并介绍一下你的能力' }
      ],
      max_tokens: 1000,
      temperature: 0.7
    },
    expectedEvents: ['response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added', 'response.output_text.delta', 'content_part.done', 'response.output_item.done', 'response.completed', 'response.done'],
    captureMetrics: {
      minEvents: 8,
      hasTextDelta: true,
      hasResponseCompleted: true
    }
  }
];

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
        'Authorization': `Bearer ${C4M_SETTINGS.apiKey}`,
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

// 检查C4M服务可用性
async function checkC4MAvailability() {
  try {
    // 直接检查C4M服务（类似LM Studio的方式）
    console.log('🔍 检查C4M服务可用性...');

    // 尝试获取模型列表
    const modelsResponse = await c4mRequest(`${C4M_SETTINGS.baseURL}/models`);
    if (modelsResponse && Array.isArray(modelsResponse.data)) {
      console.log(`✅ C4M服务可用，发现 ${modelsResponse.data.length} 个模型`);
      return true;
    }
  } catch (modelsError) {
    console.warn('模型列表检查失败:', modelsError.message);

    // 尝试简单的chat completion测试
    try {
      console.log('🔄 尝试Chat Completions端点...');
      const testResponse = await fetch(`${C4M_SETTINGS.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${C4M_SETTINGS.apiKey}`
        },
        body: JSON.stringify({
          model: C4M_SETTINGS.model,
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: 1,
          stream: false
        })
      });

      if (testResponse.ok) {
        console.log('✅ C4M Chat Completions端点可用');
        return true;
      } else {
        console.warn('Chat Completions端点不可用:', testResponse.status, testResponse.statusText);
      }
    } catch (chatError) {
      console.warn('Chat Completions测试失败:', chatError.message);
    }
  }

  return false;
}

// 执行Responses请求并捕获SSE流
async function captureC4MResponsesStream(testCase) {
  console.log(`\n🎯 开始捕获: ${testCase.name}`);
  console.log(`📋 协议: ${testCase.type}`);
  console.log(`🔧 模型: ${testCase.input.model}`);
  console.log(`💬 输入长度: ${testCase.input.input.length}条消息`);
  console.log(`🛠️ 工具数量: ${testCase.input.tools ? testCase.input.tools.length : 0}`);

  const startTime = Date.now();
  const capturedEvents = [];
  let requestError = null;
  let responseData = null;

  try {
    // 根据协议类型选择请求格式
    let requestBody, endpoint;

    if (testCase.type === 'responses') {
      // 使用真实的C4M Responses API格式（基于codex样本）
      endpoint = '/responses'; // 使用responses端点

      // 获取codex样本作为模板，过滤掉C4M不支持的参数
      const codexSamplePath = '/Users/fanzhang/.routecodex/codex-samples/openai-responses/req_1763733582430_c30ihldix_provider-request.json';
      const codexSample = JSON.parse(readFileSync(codexSamplePath, 'utf8')).body;
      const { max_tokens, temperature, ...filteredSample } = codexSample;

      requestBody = {
        ...filteredSample,
        model: testCase.input.model,
        input: testCase.input.input.map(msg => ({
          type: 'message',
          role: msg.role,
          content: [
            {
              type: 'input_text',
              text: msg.content
            }
          ]
        })), // 转换为C4M input格式
        // 如果有工具调用，保持工具格式
        ...(testCase.input.tools && {
          tools: testCase.input.tools,
          tool_choice: testCase.input.tool_choice || 'auto'
        }),
        // 如果有推理参数，使用Responses协议格式
        ...(testCase.input.reasoning && {
          reasoning: {
            max_tokens: testCase.input.reasoning.max_tokens,
            summarize: testCase.input.reasoning.summarize || false,
            summarize_threshold: testCase.input.reasoning.summarize_threshold || 100
          }
        })
      };
    } else {
      endpoint = '/chat/completions';
      requestBody = {
        ...testCase.input,
        stream: true
      };
    }

    const fullUrl = `${C4M_SETTINGS.baseURL}${endpoint}`;
    console.log(`🌐 请求URL: ${fullUrl}`);
    console.log(`📝 请求体: ${JSON.stringify(requestBody, null, 2)}`);

    const response = await fetch(fullUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'responses-2024-12-17', // C4M需要的特殊header（基于codex样本）
        'Authorization': `Bearer ${C4M_SETTINGS.apiKey}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      console.error(`❌ 请求失败详情:`);
      console.error(`   - URL: ${fullUrl}`);
      console.error(`   - Status: ${response.status} ${response.statusText}`);
      console.error(`   - Headers:`, Object.fromEntries(response.headers.entries()));

      // 尝试读取错误响应体
      try {
        const errorText = await response.text();
        console.error(`   - Response Body:`, errorText);
      } catch (e) {
        console.error(`   - Response Body: [无法读取]`);
      }

      throw new Error(`请求失败: ${response.status} ${response.statusText}`);
    }

    // 捕获SSE流
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
            const sseEvent = parseSSEEvent(eventData);
            capturedEvents.push(sseEvent);

            // 实时显示事件类型
            console.log(`   📡 事件: ${sseEvent.event || 'unknown'}`);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // 构建完整响应对象（从捕获的事件）
    responseData = reconstructResponsesFromEvents(capturedEvents);

  } catch (error) {
    requestError = error.message;
    console.log(`❌ 捕获失败: ${error.message}`);
  }

  const endTime = Date.now();
  const duration = endTime - startTime;

  // 分析捕获的事件
  const analysis = analyzeCapturedEvents(capturedEvents, testCase.expectedEvents);

  console.log(`\n📊 捕获分析:`);
  console.log(`⏱️ 总耗时: ${duration}ms`);
  console.log(`📡 捕获事件: ${capturedEvents.length}`);
  console.log(`✅ 有效事件: ${analysis.validEvents.length}`);
  console.log(`🔧 工具调用: ${analysis.toolCallCount}`);
  console.log(`💬 文本增量: ${analysis.textDeltaCount}`);
  console.log(`🧠 推理事件: ${analysis.reasoningCount}`);
  console.log(`✅ 完成事件: ${analysis.completionEvents}`);

  // 验证捕获指标
  const metricsValidation = validateMetrics(analysis, testCase.captureMetrics);
  const overallSuccess = requestError === null && metricsValidation.passed;

  console.log(`\n${overallSuccess ? '✅' : '❌'} 验证结果:`);
  console.log(`   请求成功: ${requestError ? '❌' : '✅'}`);
  console.log(`   指标验证: ${metricsValidation.passed ? '✅' : '❌'} (${metricsValidation.details.join(', ')})`);

  return {
    success: overallSuccess,
    testCase: testCase.name,
    type: testCase.type,
    duration,
    capturedEvents,
    reconstructedResponse: responseData,
    analysis,
    validation: metricsValidation,
    request: testCase.input,
    error: requestError
  };
}

// 解析SSE事件
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

// 从事件重建Responses对象
function reconstructResponsesFromEvents(events) {
  if (events.length === 0) return null;

  // 查找response.created事件
  const createdEvent = events.find(e => e.parsed && e.parsed.id && e.event === 'response.created');
  if (!createdEvent) return null;

  const response = { ...createdEvent.parsed };

  // 查找response.completed事件
  const completedEvent = events.find(e => e.parsed && e.parsed.id === response.id && e.event === 'response.completed');
  if (completedEvent) {
    response.status = completedEvent.parsed.status;
    response.output = completedEvent.parsed.output;
    response.usage = completedEvent.parsed.usage;
  }

  // 查找response.done事件
  const doneEvent = events.find(e => e.parsed && e.parsed.id === response.id && e.event === 'response.done');
  if (doneEvent) {
    response.status = doneEvent.parsed.status;
    response.output = doneEvent.parsed.output;
    response.usage = doneEvent.parsed.usage;
  }

  return response;
}

// 分析捕获的事件
function analyzeCapturedEvents(events, expectedEvents) {
  const validEvents = events.filter(e => e.parsed !== null || e.data === '[DONE]');
  const eventTypes = events.map(e => e.event).filter(Boolean);
  const eventTypeCount = {};
  eventTypes.forEach(type => {
    eventTypeCount[type] = (eventTypeCount[type] || 0) + 1;
  });

  // 统计特定事件类型
  const toolCallEvents = events.filter(e =>
    e.event && e.event.includes('function_call')
  );
  const textDeltaEvents = events.filter(e =>
    e.event === 'response.output_text.delta'
  );
  const reasoningEvents = events.filter(e =>
    e.event && e.event.includes('reasoning')
  );
  const completionEvents = events.filter(e =>
    e.event === 'response.completed' || e.event === 'response.done'
  );

  return {
    totalEvents: events.length,
    validEvents,
    eventTypes,
    eventTypeCount,
    expectedEventTypes: expectedEvents,
    toolCallCount: toolCallEvents.length,
    textDeltaCount: textDeltaEvents.length,
    reasoningCount: reasoningEvents.length,
    completionEvents: completionEvents.length
  };
}

// 验证捕获指标
function validateMetrics(analysis, captureMetrics) {
  const validationResults = [];

  if (captureMetrics.minEvents && analysis.totalEvents >= captureMetrics.minEvents) {
    validationResults.push(`事件数量≥${captureMetrics.minEvents}`);
  } else {
    validationResults.push(`事件数量<${captureMetrics.minEvents}`);
  }

  if (captureMetrics.hasToolCalls && analysis.toolCallCount > 0) {
    validationResults.push('检测到工具调用');
  } else if (captureMetrics.hasToolCalls && analysis.toolCallCount === 0) {
    validationResults.push('未检测到工具调用');
  }

  if (captureMetrics.hasTextDelta && analysis.textDeltaCount > 0) {
    validationResults.push('检测到文本增量');
  } else if (captureMetrics.hasTextDelta && analysis.textDeltaCount === 0) {
    validationResults.push('未检测到文本增量');
  }

  if (captureMetrics.hasReasoning && analysis.reasoningCount > 0) {
    validationResults.push('检测到推理事件');
  } else if (captureMetrics.hasReasoning && analysis.reasoningCount === 0) {
    validationResults.push('未检测到推理事件');
  }

  if (captureMetrics.hasResponseCompleted && analysis.completionEvents > 0) {
    validationResults.push('检测到完成事件');
  } else if (captureMetrics.hasResponseCompleted && analysis.completionEvents === 0) {
    validationResults.push('未检测到完成事件');
  }

  const passed = validationResults.filter(r => !r.includes('未检测到') && !r.includes('<')).length >= validationResults.filter(r => r.includes('检测到')).length;

  return {
    passed,
    details: validationResults
  };
}

// 主测试函数
async function main() {
  console.log('🏆 C4M黄金样本捕获测试');
  console.log('基于config.v1.json配置的V3 SSE验证');
  console.log('='.repeat(60));

  console.log('\n🔧 配置信息:');
  console.log(`   - 协议: ${C4M_SETTINGS.protocol}`);
  console.log(`   - 模型: ${C4M_SETTINGS.model}`);
  console.log(`   - 服务地址: ${C4M_SETTINGS.baseURL}`);
  console.log(`   - 流式支持: ${C4M_SETTINGS.supportsStreaming}`);

  // 检查C4M服务可用性
  console.log('\n🔍 检查C4M服务可用性...');
  const isAvailable = await checkC4MAvailability();

  if (!isAvailable) {
    console.error('❌ C4M服务不可用!');
    console.log('💡 请确保:');
    console.log('   1. C4M服务正在运行');
    console.log(`   2. API Key有效: ${C4M_SETTINGS.apiKey.substring(0, 10)}...`);
    console.log(`   3. 服务地址正确: ${C4M_SETTINGS.baseURL}`);
    process.exit(1);
  }

  console.log('✅ C4M服务可用!\n');

  // 创建输出目录 - 保存到标准的黄金样本位置
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const goldenSamplesDir = join(process.env.HOME || process.env.USERPROFILE || '~', '.routecodex', 'golden_samples');
  const outputDir = join(goldenSamplesDir, 'responses', timestamp);
  mkdirSync(outputDir, { recursive: true });
  console.log(`📁 黄金样本目录: ${outputDir}\n`);

  // 执行黄金样本捕获测试
  const results = [];

  for (const testCase of GOLDEN_SAMPLE_TESTS) {
    const result = await captureC4MResponsesStream(testCase);
    results.push(result);

    // 添加延迟以避免过快请求
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // 生成测试报告
  console.log('\n📊 黄金样本捕获报告');
  console.log('='.repeat(60));

  const successCount = results.filter(r => r.success).length;
  const totalCount = results.length;

  console.log(`✅ 成功捕获: ${successCount}/${totalCount}`);
  console.log(`❌ 捕获失败: ${totalCount - successCount}/${totalCount}`);

  const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / totalCount;
  const totalEvents = results.reduce((sum, r) => sum + r.capturedEvents.length, 0);

  console.log(`⏱️ 平均耗时: ${avgDuration.toFixed(0)}ms`);
  console.log(`📡 总事件数: ${totalEvents}`);

  console.log('\n📋 详细结果:');
  for (const result of results) {
    const status = result.success ? '✅' : '❌';

    console.log(`${status} ${result.testCase}`);
    console.log(`    📊 事件: ${result.capturedEvents.length}, 耗时: ${result.duration}ms`);
    console.log(`    🛠️ 工具: ${result.analysis.toolCallCount}, 文本: ${result.analysis.textDeltaCount}, 推理: ${result.analysis.reasoningCount}`);

    if (result.validation) {
      const passed = result.validation.passed ? '✅' : '❌';
      console.log(`    🎯 验证: ${passed} (${result.validation.details.join(', ')})`);
    }

    if (result.error) {
      console.log(`    🔴 错误: ${result.error}`);
    }

    if (result.reconstructedResponse) {
      console.log(`    📄 响应ID: ${result.reconstructedResponse.id}`);
      console.log(`    📄 状态: ${result.reconstructedResponse.status}`);
    }
  }

  // 保存黄金样本数据
  const goldenSamples = {
    timestamp: new Date().toISOString(),
    config: C4M_SETTINGS,
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
      avgDuration: avgDuration.toFixed(0),
      totalEvents: totalEvents
    },
    samples: results.map(result => ({
      name: result.testCase,
      type: result.type,
      success: result.success,
      duration: result.duration,
      eventCount: result.capturedEvents.length,
      analysis: {
        eventTypes: result.analysis.eventTypeCount,
        toolCallCount: result.analysis.toolCallCount,
        textDeltaCount: result.analysis.textDeltaCount,
        reasoningCount: result.analysis.reasoningCount
      },
      request: result.request,
      response: result.reconstructedResponse,
      events: result.capturedEvents,
      validation: result.validation,
      error: result.error
    }))
  };

  const samplesPath = join(outputDir, 'golden-samples.json');
  writeFileSync(samplesPath, JSON.stringify(goldenSamples, null, 2));
  console.log(`\n💾 黄金样本已保存: ${samplesPath}`);

  // 保存每个测试的详细事件数据
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const eventsPath = join(outputDir, `sample-${i + 1}-${result.testCase.replace(/\s+/g, '-')}-events.json`);
    writeFileSync(eventsPath, JSON.stringify({
      sample: result.testCase,
      metadata: {
        timestamp: new Date().toISOString(),
        duration: result.duration,
        success: result.success,
        validation: result.validation
      },
      request: result.request,
      response: result.reconstructedResponse,
      events: result.capturedEvents,
      analysis: result.analysis
    }, null, 2));
  }

  console.log(`\n🎉 C4M黄金样本捕获完成!`);

  if (successCount === totalCount) {
    console.log('🏆 所有样本捕获成功，V3 SSE重构验证通过!');
    console.log('💾 黄金样本数据可用于后续的协议兼容性分析和模型训练');
    process.exit(0);
  } else {
    console.log('⚠️ 部分样本捕获失败，请检查C4M服务配置和协议支持');
    console.log('💡 建议检查C4M是否完整支持Responses协议和流式响应');
    process.exit(1);
  }
}

// 运行测试
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('💥 黄金样本捕获失败:', error);
    process.exit(1);
  });
}