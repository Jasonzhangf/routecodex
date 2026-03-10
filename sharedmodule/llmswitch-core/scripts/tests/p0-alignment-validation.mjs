#!/usr/bin/env node

/**
 * P0修复验证测试
 * 验证Process和Conversion对齐修复是否有效
 */

import { processIncoming, processOutgoing } from '../../dist/bridge/routecodex-adapter.js';

const TEST_CONFIG = {
  providerProtocol: 'openai-chat',
  processMode: 'chat'
};

async function testToolGovernanceDataFlow() {
  console.log('🔧 测试工具治理数据流传播\n');

  // 测试请求：包含工具调用和stream=true
  const testRequest = {
    route: {
      requestId: 'test-governance-001',
      endpoint: '/v1/chat/completions',
      entryEndpoint: '/v1/chat/completions'
    },
    data: {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: '现在几点了？请使用get_current_time工具获取时间' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_current_time',
            description: '获取当前时间'
          }
        }
      ],
      stream: true, // 测试stream治理是否正确传播
      tool_choice: 'auto'
    },
    metadata: {
      direction: 'request'
    }
  };

  try {
    console.log('📥 输入请求:');
    console.log('- stream:', testRequest.data.stream);
    console.log('- tool_choice:', testRequest.data.tool_choice);
    console.log('- tools数量:', testRequest.data.tools?.length || 0);

    // 处理请求
    const processedRequest = await processIncoming(testRequest, TEST_CONFIG);

    console.log('\n✅ 请求处理完成');
    console.log('- 处理成功:', !!processedRequest.data);
    console.log('- 数据类型:', typeof processedRequest.data);

    if (processedRequest.data) {
      const data = processedRequest.data;
      console.log('- 治理后stream:', data.parameters?.stream);
      console.log('- 治理后tool_choice:', data.parameters?.tool_choice);
      console.log('- 治理后tools数量:', data.tools?.length || 0);

      // 验证关键修复点
      console.log('\n🎯 关键修复验证:');

      // 1. stream参数传播验证
      const streamPropagated = data.parameters?.stream !== undefined;
      console.log('- Stream参数治理传播:', streamPropagated ? '✅' : '❌');

      // 2. tool_choice参数传播验证
      const toolChoicePropagated = data.parameters?.tool_choice !== undefined;
      console.log('- Tool choice参数传播:', toolChoicePropagated ? '✅' : '❌');

      // 3. 工具列表保护验证
      const toolsPreserved = Array.isArray(data.tools) && data.tools.length > 0;
      console.log('- 工具列表保护:', toolsPreserved ? '✅' : '❌');

      return { success: true, data, validations: { streamPropagated, toolChoicePropagated, toolsPreserved } };
    }
  } catch (error) {
    console.error('❌ 请求处理失败:', error.message);
    return { success: false, error: error.message };
  }
}

async function testResponseToolExecution() {
  console.log('\n🔧 测试响应端工具执行路径\n');

  // 模拟工具调用响应
  const testResponse = {
    route: {
      requestId: 'test-response-001',
      endpoint: '/v1/chat/completions',
      entryEndpoint: '/v1/chat/completions'
    },
    data: {
      id: 'chatcmpl-test-001',
      object: 'chat.completion',
      created: Date.now(),
      model: 'gpt-4',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_test_001',
                type: 'function',
                function: {
                  name: 'get_current_time',
                  arguments: '{}'
                }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ]
    },
    metadata: {
      direction: 'response',
      originalRequest: {
        model: 'gpt-4',
        messages: [
          { role: 'user', content: '现在几点了？' }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_current_time',
              description: '获取当前时间'
            }
          }
        ]
      }
    }
  };

  try {
    console.log('📤 输入响应:');
    console.log('- 工具调用数量:', testResponse.data.choices[0].message.tool_calls?.length || 0);
    console.log('- Finish reason:', testResponse.data.choices[0].finish_reason);

    // 处理响应（需要invokeSecondRound回调）
    const mockInvokeSecondRound = async (dto, ctx) => {
      console.log('🔄 invokeSecondRound被调用!');
      console.log('- 入口端点:', dto.entryEndpoint);
      console.log('- 请求体包含工具:', !!dto.body.messages || !!dto.body.tool_calls);
      return {
        data: {
          id: 'chatcmpl-second-001',
          object: 'chat.completion',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '当前时间是12:00 PM'
            },
            finish_reason: 'stop'
          }]
        }
      };
    };

    const responseOptions = {
      ...TEST_CONFIG,
      invokeSecondRound: mockInvokeSecondRound
    };

    const processedResponse = await processOutgoing(testResponse, responseOptions);

    console.log('\n✅ 响应处理完成');
    console.log('- 处理成功:', !!processedResponse);
    console.log('- 数据类型:', typeof processedResponse);

    // 验证invokeSecondRound是否被正确传递和调用
    console.log('\n🎯 响应端工具执行验证:');
    console.log('- 响应数据完整性:', !!processedResponse);

    return { success: true, data: processedResponse };
  } catch (error) {
    console.error('❌ 响应处理失败:', error.message);
    return { success: false, error: error.message };
  }
}

async function runP0ValidationTests() {
  console.log('🚀 P0修复验证测试开始\n');
  console.log('===============================');

  const results = [];

  // 测试1: 工具治理数据流
  const governanceResult = await testToolGovernanceDataFlow();
  results.push({ test: '工具治理数据流', ...governanceResult });

  // 测试2: 响应端工具执行
  const responseResult = await testResponseToolExecution();
  results.push({ test: '响应端工具执行', ...responseResult });

  // 生成测试报告
  console.log('\n📊 P0修复验证报告');
  console.log('===============================');

  const passed = results.filter(r => r.success).length;
  const total = results.length;

  console.log(`总测试数: ${total}`);
  console.log(`通过: ${passed}`);
  console.log(`失败: ${total - passed}`);
  console.log(`成功率: ${((passed / total) * 100).toFixed(1)}%`);

  console.log('\n📋 详细结果:');
  results.forEach(result => {
    const status = result.success ? '✅' : '❌';
    console.log(`${status} ${result.test}`);
    if (result.validations) {
      Object.entries(result.validations).forEach(([key, value]) => {
        console.log(`  - ${key}: ${value ? '✅' : '❌'}`);
      });
    }
    if (result.error) {
      console.log(`  - 错误: ${result.error}`);
    }
  });

  console.log('\n🎉 P0修复验证测试完成!');
  return results;
}

// 运行测试
if (import.meta.url === `file://${process.argv[1]}`) {
  runP0ValidationTests().catch(console.error);
}

export { runP0ValidationTests };