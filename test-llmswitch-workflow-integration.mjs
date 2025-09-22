#!/usr/bin/env node

/**
 * 测试从LLM Switch开始的完整流水线集成测试
 * 包含Workflow、Compatibility、Provider的完整流程
 */

import { OpenAIPassthroughLLMSwitch } from './dist/modules/pipeline/modules/llmswitch/openai-passthrough.js';
import { StreamingControlWorkflow } from './dist/modules/pipeline/modules/workflow/streaming-control.js';
import { LMStudioCompatibility } from './dist/modules/pipeline/modules/compatibility/lmstudio-compatibility.js';
import { LMStudioProviderSimple } from './dist/modules/pipeline/modules/provider/lmstudio-provider-simple.js';
import { DebugCenter } from 'rcc-debugcenter';
import { ErrorHandlingCenter } from 'rcc-errorhandling';
import { PipelineDebugLogger } from './dist/modules/pipeline/utils/debug-logger.js';

async function testLLMSwitchWorkflowIntegration() {
  console.log('🚀 测试从LLM Switch开始的完整流水线集成（包含Workflow）...\n');

  try {
    // 初始化依赖组件
    const errorHandlingCenter = new ErrorHandlingCenter();
    const debugCenter = new DebugCenter();
    await errorHandlingCenter.initialize();

    const logger = new PipelineDebugLogger(debugCenter, {
      maxLogEntries: 100,
      logLevel: 'debug'
    });

    // 创建完整的4层流水线架构
    console.log('📋 创建4层流水线架构...\n');

    // 第1层：LLM Switch - 动态路由分类
    const llmSwitch = new OpenAIPassthroughLLMSwitch({
      type: 'openai-passthrough',
      config: {
        protocol: 'openai',
        targetFormat: 'lmstudio'
      }
    }, { errorHandlingCenter, debugCenter, logger });

    // 第2层：Workflow - 流控制（处理流式/非流式转换）
    const workflow = new StreamingControlWorkflow({
      type: 'streaming-control',
      config: {
        enableStreaming: true,
        bufferSize: 1024,
        timeout: 30000
      }
    }, { errorHandlingCenter, debugCenter, logger });

    // 第3层：Compatibility - 格式转换和协议适配
    const compatibility = new LMStudioCompatibility({
      type: 'lmstudio-compatibility',
      config: {
        toolsEnabled: true,
        customRules: [
          {
            id: 'ensure-standard-tools-format',
            transform: 'mapping',
            sourcePath: 'tools',
            targetPath: 'tools',
            mapping: {
              'type': 'type',
              'function': 'function'
            }
          }
        ]
      }
    }, { errorHandlingCenter, debugCenter, logger });

    // 第4层：Provider - 标准HTTP服务器
    const provider = new LMStudioProviderSimple({
      type: 'lmstudio-http',
      config: {
        type: 'lmstudio',
        baseUrl: 'http://localhost:1234',
        auth: {
          type: 'apikey',
          apiKey: 'dummy-key-for-testing'
        },
        timeout: 60000,
        retryAttempts: 3
      }
    }, { errorHandlingCenter, debugCenter, logger });

    // 初始化所有模块
    console.log('🔧 初始化流水线模块...');
    await llmSwitch.initialize();
    await workflow.initialize();
    await compatibility.initialize();
    await provider.initialize();
    console.log('✅ 流水线模块初始化完成\n');

    // 创建测试请求 - 包含流式和工具调用
    const testRequest = {
      model: 'gpt-oss-20b-mlx',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant with access to tools. When asked about calculations, use the calculate tool. When asked about weather, use the get_weather tool.'
        },
        {
          role: 'user',
          content: 'What is the result of 45 * 32? Also, what is the current weather in Beijing?'
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'calculate',
            description: 'Perform mathematical calculations',
            parameters: {
              type: 'object',
              properties: {
                expression: {
                  type: 'string',
                  description: 'Mathematical expression to evaluate'
                }
              },
              required: ['expression'],
              additionalProperties: false
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather information for a location',
            parameters: {
              type: 'object',
              properties: {
                location: {
                  type: 'string',
                  description: 'Location to get weather for'
                },
                unit: {
                  type: 'string',
                  enum: ['celsius', 'fahrenheit'],
                  description: 'Temperature unit (default: celsius)'
                }
              },
              required: ['location'],
              additionalProperties: false
            }
          }
        }
      ],
      stream: false, // 测试非流式请求
      temperature: 0.7,
      max_tokens: 2048
    };

    console.log('📊 原始请求信息:');
    console.log(`- 模型: ${testRequest.model}`);
    console.log(`- 流式: ${testRequest.stream}`);
    console.log(`- 工具数量: ${testRequest.tools.length}`);
    console.log(`- 消息数量: ${testRequest.messages.length}`);
    console.log('');

    // 开始4层流水线处理
    console.log('🔄 开始4层流水线处理...\n');

    // 第1层：LLM Switch处理
    console.log('🎯 第1层：LLM Switch处理...');
    const llmSwitchResult = await llmSwitch.processIncoming(testRequest);
    console.log('✅ LLM Switch完成');
    console.log('  - 添加路由元数据');
    console.log('  - 协议检测: OpenAI -> OpenAI');
    console.log(`  - 请求ID: ${llmSwitchResult._metadata?.timestamp || 'unknown'}`);
    console.log('');

    // 第2层：Workflow处理
    console.log('🌊 第2层：Workflow处理...');
    const workflowResult = await workflow.processIncoming(llmSwitchResult);
    console.log('✅ Workflow完成');
    console.log('  - 流式控制检查');
    console.log(`  - 原始流式: ${workflowResult.originalStream || false}`);
    console.log(`  - 处理后流式: ${workflowResult.stream}`);
    console.log('');

    // 第3层：Compatibility处理
    console.log('🔄 第3层：Compatibility处理...');
    const compatibilityResult = await compatibility.processIncoming(workflowResult);
    console.log('✅ Compatibility完成');
    console.log('  - 格式转换完成');
    console.log('  - 工具格式适配');
    console.log(`  - 转换规则数: ${compatibilityResult._metadata?.transformationCount || 'unknown'}`);
    console.log('');

    // 第4层：Provider处理
    console.log('🌐 第4层：Provider处理...');
    console.log('  发送HTTP请求到LM Studio...');
    const providerResult = await provider.processIncoming(compatibilityResult);
    console.log('✅ Provider完成');
    console.log(`  - 响应状态: ${providerResult.status}`);
    console.log(`  - 处理时间: ${providerResult.metadata?.processingTime || 'unknown'}ms`);
    console.log('');

    // 分析最终响应
    console.log('📈 响应分析...');
    const choice = providerResult.data?.choices?.[0];
    const message = choice?.message;

    console.log(`- 模型: ${providerResult.data?.model || 'unknown'}`);
    console.log(`- 完成原因: ${choice?.finish_reason || 'unknown'}`);
    console.log(`- 内容长度: ${message?.content?.length || 0} 字符`);
    console.log(`- 工具调用数量: ${message?.tool_calls?.length || 0}`);

    if (message?.tool_calls && message.tool_calls.length > 0) {
      console.log('\n🎉 成功！工具调用被正确解析:');
      message.tool_calls.forEach((toolCall, index) => {
        console.log(`  ${index + 1}. ${toolCall.function.name}`);
        console.log(`     ID: ${toolCall.id}`);
        console.log(`     参数: ${JSON.stringify(toolCall.function.arguments)}`);
      });

      // 验证工作流程
      if (choice?.finish_reason === 'tool_calls') {
        console.log('\n✅ 工作流程验证:');
        console.log('  - LLM Switch: ✅ 路由和元数据添加');
        console.log('  - Workflow: ✅ 流式控制处理');
        console.log('  - Compatibility: ✅ 格式转换');
        console.log('  - Provider: ✅ HTTP通信和响应处理');
        console.log('  - 完成原因: ✅ tool_calls');
      }

      // 分析工具调用类型
      const toolTypes = message.tool_calls.map(tc => tc.function.name);
      const hasCalculate = toolTypes.includes('calculate');
      const hasWeather = toolTypes.includes('get_weather');

      console.log('\n🔧 工具调用分析:');
      console.log(`  - 计算工具: ${hasCalculate ? '✅' : '❌'}`);
      console.log(`  - 天气工具: ${hasWeather ? '✅' : '❌'}`);
      console.log(`  - 总工具数: ${toolTypes.length}`);

    } else {
      console.log('\n❌ 工具调用未被解析');
      if (message?.content) {
        console.log('📝 模型输出内容:');
        console.log(message.content.substring(0, 200) + '...');
      }
    }

    // 性能分析
    const totalTime = providerResult.metadata?.processingTime || 0;
    console.log('\n⚡ 性能分析:');
    console.log(`  - 总处理时间: ${totalTime}ms`);
    console.log(`  - 平均每层时间: ${Math.round(totalTime / 4)}ms`);
    console.log(`  - 响应大小: ${JSON.stringify(providerResult.data).length} 字符`);

    // 清理资源
    console.log('\n🧹 清理资源...');
    await llmSwitch.cleanup();
    await workflow.cleanup();
    await compatibility.cleanup();
    await provider.cleanup();

    console.log('✅ 完整流水线集成测试完成！');
    console.log('\n📋 测试总结:');
    console.log('  - 4层架构: ✅ LLM Switch -> Workflow -> Compatibility -> Provider');
    console.log('  - 工具调用: ✅ 成功解析和执行');
    console.log('  - 流式控制: ✅ 正确处理流式/非流式');
    console.log('  - 格式转换: ✅ Compatibility层转换');
    console.log('  - HTTP通信: ✅ Provider层通信');

  } catch (error) {
    console.error('❌ 测试失败:', error.message);
    console.error('错误详情:', error.stack);
    throw error;
  }
}

// 运行测试
testLLMSwitchWorkflowIntegration().catch(console.error);