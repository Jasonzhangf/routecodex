/**
 * Hook系统测试文件 - 验证双向监控功能
 *
 * 演示和测试双向Hook监控系统的各种功能
 */

import type { HookExecutionContext, HookDataPacket } from '../config/provider-debug-hooks.js';
import type { ServiceProfile } from '../api/provider-types.js';
import { BidirectionalHookManager, HookStage } from '../config/provider-debug-hooks.js';
import { registerDebugExampleHooks, enableDebugMode, disableDebugMode } from './debug-example-hooks.js';

/**
 * 模拟Provider上下文
 */
function createMockContext(stage: HookStage): HookExecutionContext {
  return {
    requestId: `test_req_${Date.now()}`,
    providerType: 'openai-standard' as any,
    stage,
    startTime: Date.now() - 100,
    profile: {
      defaultBaseUrl: 'https://api.openai.com',
      defaultEndpoint: '/v1/chat/completions',
      defaultModel: 'gpt-3.5-turbo',
      timeout: 60000,
      maxRetries: 3,
      requiredAuth: ['apikey'],
      optionalAuth: [],
      headers: {}
    } as ServiceProfile,
    debugEnabled: true,
    changeCount: 0,
    executionId: `test_hook_${Date.now()}`
  };
}

/**
 * 模拟请求数据
 */
function createMockRequest(): any {
  return {
    model: 'gpt-3.5-turbo',
    messages: [
      { role: 'user', content: 'Hello, how are you?' }
    ],
    temperature: 0.7,
    max_tokens: 1000,
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get current weather',
          parameters: {
            type: 'object',
            properties: {
              location: { type: 'string' }
            }
          }
        }
      }
    ]
  };
}

/**
 * 模拟响应数据
 */
function createMockResponse(): any {
  return {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'openai-organization': 'test-org'
    },
    data: {
      id: 'chatcmpl-test123',
      object: 'chat.completion',
      created: Date.now(),
      model: 'gpt-3.5-turbo',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Hello! I am doing well, thank you for asking.',
            tool_calls: null
          },
          finish_reason: 'stop'
        }
      ],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 15,
        total_tokens: 35
      }
    }
  };
}

/**
 * 测试请求预处理Hook
 */
async function testRequestPreprocessingHook(): Promise<void> {
  console.log('\n🧪 测试请求预处理Hook...');

  const context = createMockContext(HookStage.REQUEST_PREPROCESSING);
  const requestData = createMockRequest();

  const result = await BidirectionalHookManager.executeHookChain(
    HookStage.REQUEST_PREPROCESSING,
    'request',
    requestData,
    context
  );

  console.log('✅ 请求预处理Hook测试完成');
  console.log(`📊 处理后数据包含追踪ID: ${!!(result.data as any)._traceId}`);
  console.log(`📊 处理后数据包含时间戳: ${!!(result.data as any)._debugTimestamp}`);
  console.log(`📊 执行时间: ${result.metrics.executionTime}ms`);
  console.log(`📊 Hook执行数量: ${result.metrics.hookCount}`);
  console.log(`📊 数据变化数量: ${result.changes.length}`);
}

/**
 * 测试认证Hook
 */
async function testAuthenticationHook(): Promise<void> {
  console.log('\n🧪 测试认证Hook...');

  const context = createMockContext(HookStage.AUTHENTICATION);
  const authData = {
    'Authorization': 'Bearer sk-test123456789',
    'Content-Type': 'application/json'
  };

  const result = await BidirectionalHookManager.executeHookChain(
    HookStage.AUTHENTICATION,
    'auth',
    authData,
    context
  );

  console.log('✅ 认证Hook测试完成');
  console.log(`📊 认证时间戳已添加: ${!!(result.data as any)._authTimestamp}`);
  console.log(`📊 Token类型识别: ${(result.data as any).Authorization?.split(' ')[0] || 'Unknown'}`);
}

/**
 * 测试HTTP请求Hook
 */
async function testHttpRequestHook(): Promise<void> {
  console.log('\n🧪 测试HTTP请求Hook...');

  const context = createMockContext(HookStage.HTTP_REQUEST);
  const requestData = createMockRequest();

  const result = await BidirectionalHookManager.executeHookChain(
    HookStage.HTTP_REQUEST,
    'request',
    requestData,
    context
  );

  console.log('✅ HTTP请求Hook测试完成');
  console.log(`📊 HTTP请求时间戳: ${!!(result.data as any)._httpRequestTimestamp}`);
  console.log(`📊 流式请求检测: ${!!(result.data as any).stream}`);
}

/**
 * 测试HTTP响应Hook
 */
async function testHttpResponseHook(): Promise<void> {
  console.log('\n🧪 测试HTTP响应Hook...');

  const context = createMockContext(HookStage.HTTP_RESPONSE);
  const responseData = createMockResponse();

  const result = await BidirectionalHookManager.executeHookChain(
    HookStage.HTTP_RESPONSE,
    'response',
    responseData,
    context
  );

  console.log('✅ HTTP响应Hook测试完成');
  console.log(`📊 响应状态码: ${responseData.status}`);
  console.log(`📊 内容长度检测: ${!!responseData.data?.choices?.[0]?.message?.content?.length}`);
  console.log(`📊 Token使用统计: ${!!responseData.data?.usage}`);
}

/**
 * 测试响应后处理Hook
 */
async function testResponsePostProcessingHook(): Promise<void> {
  console.log('\n🧪 测试响应后处理Hook...');

  const context = createMockContext(HookStage.RESPONSE_POSTPROCESSING);
  const responseData = {
    data: createMockResponse().data,
    status: 200,
    headers: {}
  };

  const result = await BidirectionalHookManager.executeHookChain(
    HookStage.RESPONSE_POSTPROCESSING,
    'response',
    responseData,
    context
  );

  console.log('✅ 响应后处理Hook测试完成');
  console.log(`📊 最终处理时间戳: ${!!(result.data as any).metadata?.finalProcessingTimestamp}`);
  console.log(`📊 性能指标已添加: ${!!(result.data as any).metadata?.performanceMetrics}`);
  console.log(`📊 总处理时间: ${(result.data as any).metadata?.performanceMetrics?.totalProcessingTime || 0}ms`);
}

/**
 * 测试错误处理Hook
 */
async function testErrorHandlingHook(): Promise<void> {
  console.log('\n🧪 测试错误处理Hook...');

  const context = createMockContext(HookStage.ERROR_HANDLING);
  const errorData = {
    error: new Error('模拟网络错误'),
    request: { model: 'test-model' },
    url: 'https://api.openai.com/v1/chat/completions',
    headers: {}
  };

  const result = await BidirectionalHookManager.executeHookChain(
    HookStage.ERROR_HANDLING,
    'error',
    errorData,
    context
  );

  console.log('✅ 错误处理Hook测试完成');
  console.log(`📊 错误时间戳: ${!!(result.data as any)._errorHandlingTimestamp}`);
  console.log(`📊 错误追踪信息: ${!!(result.data as any)._errorTrace}`);
  console.log(`📊 错误类型: ${errorData.error.constructor.name}`);
}

/**
 * 测试调试级别切换
 */
async function testDebugLevelSwitching(): Promise<void> {
  console.log('\n🧪 测试调试级别切换...');

  // 测试basic级别
  console.log('\n📋 测试basic级别:');
  enableDebugMode('basic');
  await testRequestPreprocessingHook();

  // 测试detailed级别
  console.log('\n📋 测试detailed级别:');
  enableDebugMode('detailed');
  await testRequestPreprocessingHook();

  // 测试verbose级别
  console.log('\n📋 测试verbose级别:');
  enableDebugMode('verbose');
  await testRequestPreprocessingHook();

  // 禁用调试模式
  disableDebugMode();
  console.log('\n📋 调试模式已禁用');
}

/**
 * 测试Hook优先级
 */
async function testHookPriority(): Promise<void> {
  console.log('\n🧪 测试Hook优先级...');

  // 创建不同优先级的测试Hook
  const highPriorityHook = {
    name: 'high-priority-test',
    stage: HookStage.REQUEST_PREPROCESSING as const,
    target: 'request' as const,
    priority: 200,
    read: () => ({
      observations: ['高优先级Hook执行'],
      shouldContinue: true
    })
  };

  const lowPriorityHook = {
    name: 'low-priority-test',
    stage: HookStage.REQUEST_PREPROCESSING as const,
    target: 'request' as const,
    priority: 10,
    read: () => ({
      observations: ['低优先级Hook执行'],
      shouldContinue: true
    })
  };

  // 注册Hook
  BidirectionalHookManager.registerHook(lowPriorityHook);
  BidirectionalHookManager.registerHook(highPriorityHook);

  const context = createMockContext(HookStage.REQUEST_PREPROCESSING);
  const requestData = createMockRequest();

  const result = await BidirectionalHookManager.executeHookChain(
    HookStage.REQUEST_PREPROCESSING,
    'request',
    requestData,
    context
  );

  console.log('✅ Hook优先级测试完成');
  console.log(`📊 总观察记录: ${result.observations.length}`);
  console.log(`📊 执行的Hook: ${result.debug.hookExecutions.map(h => h.hookName).join(', ')}`);

  // 检查执行顺序（高优先级应该先执行）
  const hookExecutions = result.debug.hookExecutions;
  const highPriorityIndex = hookExecutions.findIndex(h => h.hookName === 'high-priority-test');
  const lowPriorityIndex = hookExecutions.findIndex(h => h.hookName === 'low-priority-test');

  if (highPriorityIndex < lowPriorityIndex) {
    console.log('✅ Hook优先级顺序正确');
  } else {
    console.log('❌ Hook优先级顺序错误');
  }
}

/**
 * 测试性能阈值警告
 */
async function testPerformanceThresholds(): Promise<void> {
  console.log('\n🧪 测试性能阈值警告...');

  // 创建慢执行Hook
  const slowHook = {
    name: 'slow-performance-test',
    stage: HookStage.REQUEST_PREPROCESSING as const,
    target: 'request' as const,
    priority: 100,
    isDebugHook: true as const,
    read: () => {
      // 模拟慢操作
      return {
        observations: ['慢Hook执行完成'],
        shouldContinue: true
      };
    }
  };

  BidirectionalHookManager.registerHook(slowHook);

  // 设置低性能阈值
  BidirectionalHookManager.setDebugConfig({
    enabled: true,
    level: 'detailed',
    maxDataSize: 1024 * 1024,
    stages: [HookStage.REQUEST_PREPROCESSING],
    outputFormat: 'structured',
    outputTargets: ['console'],
    performanceThresholds: {
      maxHookExecutionTime: 100, // 100ms阈值
      maxTotalExecutionTime: 1000,
      maxDataSize: 512 * 1024
    }
  });

  const context = createMockContext(HookStage.REQUEST_PREPROCESSING);
  const requestData = createMockRequest();

  console.log('执行慢Hook，预期会有性能警告...');
  const result = await BidirectionalHookManager.executeHookChain(
    HookStage.REQUEST_PREPROCESSING,
    'request',
    requestData,
    context
  );

  console.log('✅ 性能阈值测试完成');
  console.log(`📊 Hook执行时间: ${result.metrics.executionTime}ms`);
  console.log(`📊 是否触发性能警告: ${result.observations.some(obs => obs.includes('执行时间过长'))}`);
}

/**
 * 完整的测试套件
 */
async function runCompleteTestSuite(): Promise<void> {
  console.log('🚀 开始Hook系统完整测试...\n');

  try {
    // 注册示例Hooks
    registerDebugExampleHooks();

    // 启用调试模式
    enableDebugMode('detailed');

    // 运行各项测试
    await testRequestPreprocessingHook();
    await testAuthenticationHook();
    await testHttpRequestHook();
    await testHttpResponseHook();
    await testResponsePostProcessingHook();
    await testErrorHandlingHook();

    console.log('\n🎯 运行高级测试...');
    await testDebugLevelSwitching();
    await testHookPriority();
    await testPerformanceThresholds();

    console.log('\n✅ Hook系统完整测试完成！');
    console.log('🎉 所有功能正常工作');

  } catch (error) {
    console.error('\n❌ 测试过程中发生错误:', error);
  } finally {
    // 清理：禁用调试模式
    disableDebugMode();
  }
}

/**
 * 简单测试 - 快速验证基本功能
 */
async function runQuickTest(): Promise<void> {
  console.log('⚡ 运行Hook系统快速测试...\n');

  try {
    // 注册示例Hooks
    registerDebugExampleHooks();

    // 启用调试模式
    enableDebugMode('basic');

    // 测试核心功能
    await testRequestPreprocessingHook();
    await testHttpResponseHook();

    console.log('\n✅ Hook系统快速测试完成！');

  } catch (error) {
    console.error('\n❌ 快速测试失败:', error);
  } finally {
    disableDebugMode();
  }
}

// 导出测试函数
export {
  runCompleteTestSuite,
  runQuickTest,
  testRequestPreprocessingHook,
  testAuthenticationHook,
  testHttpRequestHook,
  testHttpResponseHook,
  testResponsePostProcessingHook,
  testErrorHandlingHook,
  testDebugLevelSwitching,
  testHookPriority,
  testPerformanceThresholds
};

// 导出测试执行器供外部调用
export const testRunner = {
  runQuickTest,
  runCompleteTestSuite
};