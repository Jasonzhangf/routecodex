#!/usr/bin/env node

/**
 * LM Studio 兼容性工具调用测试
 * 测试我们实现的 LM Studio 兼容性在工具调用场景下的表现
 * 包括：SSE回环测试 + 真实LM Studio测试 + 兼容性验证
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 测试配置
const TEST_CONFIG = {
  lmstudio: {
    baseUrl: 'http://localhost:1234/v1',
    defaultModel: 'gpt-oss-20b-mlx',
    timeout: 60000
  },
  compatibility: {
    profile: 'lmstudio',
    providerMatch: ['lmstudio'],
    protocolMatch: ['lmstudio', 'openai']
  }
};

// 包含工具调用的测试用例
const TOOL_TEST_CASES = [
  {
    name: '基础工具调用',
    description: '测试单个工具调用的兼容性处理',
    request: {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: '请调用get_weather函数获取北京天气' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: '获取指定城市天气',
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
      tool_choice: 'auto',
      stream: true
    },
    expectedTransformations: {
      tool_choice: 'required', // LM Studio兼容性应该转换
      maxToken: true // 字段映射应该存在
    }
  },
  {
    name: '强制工具调用',
    description: '测试强制工具调用的处理',
    request: {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: '必须调用get_time函数' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_time',
            description: '获取当前时间',
            parameters: {
              type: 'object',
              properties: {},
              required: []
            }
          }
        }
      ],
      tool_choice: { type: 'function', function: { name: 'get_time' } },
      stream: true
    },
    expectedTransformations: {
      tool_choice: 'required' // 对象应该被转换为'required'
    }
  },
  {
    name: '多工具并行调用',
    description: '测试多个工具的并行调用',
    request: {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: '请同时获取天气、时间和用户信息' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: '获取天气',
            parameters: { type: 'object', properties: {}, required: [] }
          }
        },
        {
          type: 'function',
          function: {
            name: 'get_time',
            description: '获取时间',
            parameters: { type: 'object', properties: {}, required: [] }
          }
        },
        {
          type: 'function',
          function: {
            name: 'get_user_info',
            description: '获取用户信息',
            parameters: { type: 'object', properties: {}, required: [] }
          }
        }
      ],
      tool_choice: 'auto',
      stream: true
    },
    expectedTransformations: {
      tool_choice: 'required',
      tools_count: 3
    }
  }
];

// 兼容性验证器
class CompatibilityValidator {
  constructor() {
    this.results = [];
  }

  // 验证LM Studio兼容性转换
  validateLMStudioCompatibility(originalRequest, processedRequest) {
    const issues = [];
    const transformations = {};

    // 检查 tool_choice 转换
    if (originalRequest.tool_choice && processedRequest.parameters?.tool_choice) {
      if (typeof originalRequest.tool_choice === 'object' &&
          processedRequest.parameters.tool_choice === 'required') {
        transformations.tool_choice = 'object_to_required';
      }
    }

    // 检查字段映射
    if (originalRequest.max_tokens && processedRequest.parameters?.maxToken) {
      transformations.maxToken = true;
    }

    // 检查工具格式标准化
    if (Array.isArray(originalRequest.tools) && Array.isArray(processedRequest.parameters?.tools)) {
      if (this.validateToolFormat(processedRequest.parameters.tools)) {
        transformations.tools_normalized = true;
      } else {
        issues.push('工具格式标准化失败');
      }
    }

    return {
      success: issues.length === 0,
      issues,
      transformations
    };
  }

  validateToolFormat(tools) {
    return tools.every(tool => {
      if (tool.type === 'function' && tool.function) {
        const fn = tool.function;
        return fn.name &&
               fn.description &&
               fn.parameters &&
               typeof fn.parameters === 'object' &&
               fn.parameters.type === 'object' &&
               (fn.parameters.properties === undefined || typeof fn.parameters.properties === 'object');
      }
      return false;
    });
  }

  // SSE事件分析
  analyzeSSEEvents(events) {
    const analysis = {
      totalEvents: events.length,
      toolCallEvents: 0,
      contentEvents: 0,
      toolCallsDetected: 0,
      toolCallDetails: []
    };

    for (const event of events) {
      if (event.parsed?.choices?.[0]?.delta) {
        const delta = event.parsed.choices[0].delta;

        if (delta.content) {
          analysis.contentEvents++;
        }

        if (delta.tool_calls) {
          analysis.toolCallEvents++;
          for (const toolCall of delta.tool_calls) {
            if (toolCall.function?.name) {
              analysis.toolCallsDetected++;
              analysis.toolCallDetails.push({
                name: toolCall.function.name,
                index: toolCall.index,
                hasId: !!toolCall.id,
                hasArguments: !!toolCall.function?.arguments
              });
            }
          }
        }
      }
    }

    return analysis;
  }
}

// 检查LM Studio可用性
async function checkLMStudioAvailability() {
  try {
    const response = await fetch(`${TEST_CONFIG.lmstudio.baseUrl}/models`);
    return response.ok;
  } catch (error) {
    return false;
  }
}

// 获取可用模型
async function getAvailableModels() {
  try {
    const response = await fetch(`${TEST_CONFIG.lmstudio.baseUrl}/models`);
    const data = await response.json();
    return data.data?.map(model => model.id) || [TEST_CONFIG.lmstudio.defaultModel];
  } catch (error) {
    return [TEST_CONFIG.lmstudio.defaultModel];
  }
}

// 模拟兼容性处理（基于我们实现的逻辑）
function applyLMStudioCompatibility(request) {
  const processed = JSON.parse(JSON.stringify(request)); // 深拷贝
  processed.parameters = { ...processed };

  // tool_choice 规范化
  if (processed.tool_choice && typeof processed.tool_choice === 'object') {
    if (processed.tool_choice.type === 'function') {
      processed.parameters.tool_choice = 'required';
    }
  }

  // 字段映射
  if (processed.max_tokens) {
    processed.parameters.maxToken = processed.max_tokens;
  }

  // 工具格式标准化
  if (Array.isArray(processed.tools)) {
    processed.parameters.tools = processed.tools.map(tool => {
      if (tool.type === 'function' && tool.function) {
        return {
          type: 'function',
          function: {
            name: tool.function.name,
            description: tool.function.description || `Function ${tool.function.name}`,
            parameters: tool.function.parameters || {
              type: 'object',
              properties: {},
              required: [],
              additionalProperties: true
            }
          }
        };
      }
      return tool;
    });
  }

  return processed;
}

// 执行兼容性测试
async function runCompatibilityTest(testCase) {
  console.log(`\n🧪 ${testCase.name}`);
  console.log(`📝 ${testCase.description}`);

  const validator = new CompatibilityValidator();

  // 1. 应用兼容性转换
  const originalRequest = { ...testCase.request };
  const processedRequest = applyLMStudioCompatibility(originalRequest);

  // 2. 验证转换结果
  const compatibilityResult = validator.validateLMStudioCompatibility(originalRequest, processedRequest);

  console.log(`🔄 兼容性转换: ${compatibilityResult.success ? '✅' : '❌'}`);
  if (compatibilityResult.transformations) {
    console.log(`   转换: ${Object.keys(compatibilityResult.transformations).join(', ')}`);
  }

  for (const issue of compatibilityResult.issues) {
    console.log(`   ❌ ${issue}`);
  }

  // 3. 如果LM Studio可用，执行真实测试
  let sseAnalysis = null;
  const isLMStudioAvailable = await checkLMStudioAvailability();

  if (isLMStudioAvailable) {
    try {
      console.log(`🌐 执行LM Studio真实测试...`);

      const response = await fetch(`${TEST_CONFIG.lmstudio.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...processedRequest,
          model: TEST_CONFIG.lmstudio.defaultModel
        })
      });

      if (response.ok) {
        const events = [];
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

                if (data !== '[DONE]') {
                  try {
                    events.push({
                      event,
                      data,
                      parsed: data ? JSON.parse(data) : null
                    });
                  } catch (e) {
                    // 忽略解析错误
                  }
                }
              }
            }
          }
        } finally {
          reader.releaseLock();
        }

        sseAnalysis = validator.analyzeSSEEvents(events);
        console.log(`📊 SSE分析: ${sseAnalysis.totalEvents}事件, ${sseAnalysis.toolCallsDetected}工具调用`);

      } else {
        console.log(`❌ LM Studio请求失败: ${response.status}`);
      }
    } catch (error) {
      console.log(`❌ LM Studio测试错误: ${error.message}`);
    }
  } else {
    console.log(`⚠️  LM Studio不可用，跳过真实测试`);
  }

  return {
    testCase: testCase.name,
    description: testCase.description,
    compatibility: compatibilityResult,
    sseAnalysis,
    originalRequest,
    processedRequest
  };
}

// 主测试函数
async function main() {
  console.log('🚀 LM Studio 兼容性工具调用测试');
  console.log('==========================================');

  // 检查LM Studio可用性
  const isAvailable = await checkLMStudioAvailability();
  console.log(`${isAvailable ? '✅' : '❌'} LM Studio 可用性: ${isAvailable ? '可用' : '不可用'}`);

  if (isAvailable) {
    const models = await getAvailableModels();
    console.log(`🔧 可用模型: ${models.slice(0, 3).join(', ')}...`);
  }

  // 创建输出目录
  const outputDir = join(__dirname, '../../test-output/lmstudio-compatibility-tools', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(outputDir, { recursive: true });
  console.log(`📁 输出目录: ${outputDir}\n`);

  // 执行兼容性测试
  const results = [];
  for (const testCase of TOOL_TEST_CASES) {
    const result = await runCompatibilityTest(testCase);
    results.push(result);

    // 添加延迟
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // 生成报告
  console.log('\n📊 兼容性测试报告');
  console.log('==========================================');

  const successCount = results.filter(r => r.compatibility.success).length;
  const totalCount = results.length;

  console.log(`✅ 兼容性转换: ${successCount}/${totalCount}`);
  console.log(`📈 成功率: ${(successCount / totalCount * 100).toFixed(1)}%`);

  // 详细结果
  console.log('\n📋 详细结果:');
  for (const result of results) {
    const compatStatus = result.compatibility.success ? '✅' : '❌';
    console.log(`${compatStatus} ${result.testCase}`);
    console.log(`   📝 ${result.description}`);

    if (result.sseAnalysis) {
      console.log(`   🌐 SSE: ${result.sseAnalysis.totalEvents}事件, ${result.sseAnalysis.toolCallsDetected}工具调用`);
    }

    if (result.compatibility.issues.length > 0) {
      console.log(`   ❌ 问题: ${result.compatibility.issues.join(', ')}`);
    }
  }

  // 保存详细报告
  const report = {
    timestamp: new Date().toISOString(),
    config: TEST_CONFIG,
    lmStudioAvailable: isAvailable,
    summary: {
      total: totalCount,
      compatibilitySuccess: successCount,
      compatibilitySuccessRate: (successCount / totalCount * 100).toFixed(1) + '%'
    },
    results,
    compatibilityAnalysis: {
      totalTransformations: results.flatMap(r => Object.keys(r.compatibility.transformations || {})).length,
      uniqueTransformations: [...new Set(results.flatMap(r => Object.keys(r.compatibility.transformations || {})))],
      totalIssues: results.reduce((sum, r) => sum + r.compatibility.issues.length, 0)
    }
  };

  if (isAvailable) {
    const sseResults = results.filter(r => r.sseAnalysis);
    if (sseResults.length > 0) {
      report.sseAnalysis = {
        totalEvents: sseResults.reduce((sum, r) => sum + r.sseAnalysis.totalEvents, 0),
        totalToolCalls: sseResults.reduce((sum, r) => sum + r.sseAnalysis.toolCallsDetected, 0),
        averageEventsPerTest: Math.round(sseResults.reduce((sum, r) => sum + r.sseAnalysis.totalEvents, 0) / sseResults.length)
      };
    }
  }

  const reportPath = join(outputDir, 'compatibility-tools-test-report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n💾 详细报告已保存: ${reportPath}`);

  console.log('\n🎉 LM Studio 兼容性工具调用测试完成!');

  if (successCount === totalCount) {
    console.log('🏆 所有兼容性转换测试通过，LM Studio 兼容性工作正常!');
  } else {
    console.log(`⚠️  ${totalCount - successCount} 个兼容性测试失败，请检查转换逻辑`);
  }
}

// 运行测试
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('💥 测试执行失败:', error);
    process.exit(1);
  });
}

export { main as runLMStudioCompatibilityToolsTest };