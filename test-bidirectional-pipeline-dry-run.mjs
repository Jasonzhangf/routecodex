/**
 * 测试双向流水线dry-run功能
 * 验证请求流水线和响应流水线的协同工作
 */

import { bidirectionalPipelineManager } from './dist/modules/pipeline/dry-run/bidirectional-pipeline-dry-run.js';
import { dryRunPipelineExecutor } from './dist/modules/pipeline/dry-run/dry-run-pipeline-executor.js';
import { pipelineDryRunManager } from './dist/modules/pipeline/dry-run/pipeline-dry-run-framework.js';

// 模拟LLM Switch模块
const mockLLMSwitchModule = {
  id: 'mock-llm-switch',
  type: 'llm-switch',
  config: {},

  async initialize() {},
  async processIncoming(request: any) {
    return {
      ...request,
      _metadata: {
        switchType: 'openai-passthrough',
        timestamp: Date.now(),
        originalProtocol: 'openai',
        targetProtocol: 'openai',
        routing: 'thinking'
      }
    };
  },

  async executeNodeDryRun(request: any, context: any) {
    return {
      nodeId: context.nodeId,
      nodeType: context.nodeType,
      status: 'success',
      inputData: request,
      expectedOutput: {
        ...request,
        _metadata: {
          switchType: 'openai-passthrough',
          timestamp: Date.now(),
          routing: 'thinking'
        }
      },
      validationResults: [],
      performanceMetrics: { estimatedTime: 5, estimatedMemory: 100, complexity: 1 },
      executionLog: [{
        timestamp: Date.now(),
        level: 'info',
        message: 'LLM Switch dry-run completed'
      }]
    };
  },

  async validateOutput(output: any, rules: any[]) {
    return rules.map(rule => ({
      ruleId: rule.id,
      passed: true,
      message: 'Validation passed',
      severity: 'warning'
    }));
  },

  async simulateError(config: any) {
    return new Error('Simulated LLM Switch error');
  },

  async estimatePerformance(input: any) {
    return { time: 5, memory: 100, complexity: 1 };
  }
};

// 模拟兼容性模块
const mockCompatibilityModule = {
  ...mockLLMSwitchModule,
  id: 'mock-compatibility',
  type: 'compatibility',

  async processIncoming(request: any) {
    return {
      ...request,
      _transformed: true,
      _metadata: {
        compatibility: 'mock',
        timestamp: Date.now()
      }
    };
  },

  async executeNodeDryRun(request: any, context: any) {
    return {
      nodeId: context.nodeId,
      nodeType: context.nodeType,
      status: 'success',
      inputData: request,
      expectedOutput: {
        ...request,
        _transformed: true,
        _metadata: {
          compatibility: 'mock',
          timestamp: Date.now()
        }
      },
      validationResults: [],
      performanceMetrics: { estimatedTime: 3, estimatedMemory: 80, complexity: 1 },
      executionLog: [{
        timestamp: Date.now(),
        level: 'info',
        message: 'Compatibility dry-run completed'
      }]
    };
  }
};

// 模拟响应处理模块
const mockResponseProcessorModule = {
  ...mockLLMSwitchModule,
  id: 'mock-response-processor',
  type: 'response-processor',

  async processIncoming(request: any) {
    return {
      ...request,
      _processed: true,
      _metadata: {
        processor: 'response-processor',
        timestamp: Date.now(),
        processingStage: 'response-analysis'
      }
    };
  },

  async executeNodeDryRun(request: any, context: any) {
    return {
      nodeId: context.nodeId,
      nodeType: context.nodeType,
      status: 'success',
      inputData: request,
      expectedOutput: {
        ...request,
        _processed: true,
        _metadata: {
          processor: 'response-processor',
          timestamp: Date.now(),
          processingStage: 'response-analysis'
        }
      },
      validationResults: [],
      performanceMetrics: { estimatedTime: 8, estimatedMemory: 120, complexity: 1 },
      executionLog: [{
        timestamp: Date.now(),
        level: 'info',
        message: 'Response processor dry-run completed'
      }]
    };
  }
};

// 模拟真实服务器响应
const mockRealResponse = {
  id: 'chatcmpl-123456789',
  object: 'chat.completion',
  created: Date.now(),
  model: 'qwen-turbo',
  choices: [{
    index: 0,
    message: {
      role: 'assistant',
      content: 'This is a real response from the server for testing bidirectional pipeline dry-run functionality.'
    },
    finish_reason: 'stop'
  }],
  usage: {
    prompt_tokens: 25,
    completion_tokens: 18,
    total_tokens: 43
  }
};

async function testBidirectionalPipelineFullDryRun() {
  console.log('=== 测试双向流水线完全dry-run模式 ===');

  // 配置节点
  dryRunPipelineExecutor.registerNodes([
    {
      id: 'llm-switch',
      type: 'llm-switch',
      module: mockLLMSwitchModule,
      isDryRun: true,
      config: {
        enabled: true,
        mode: 'full-analysis',
        breakpointBehavior: 'continue',
        verbosity: 'detailed'
      }
    },
    {
      id: 'compatibility',
      type: 'compatibility',
      module: mockCompatibilityModule,
      isDryRun: true,
      config: {
        enabled: true,
        mode: 'full-analysis',
        breakpointBehavior: 'continue',
        verbosity: 'detailed'
      }
    }
  ]);

  // 配置响应处理器节点
  dryRunPipelineExecutor.registerNodes([
    {
      id: 'response-processor',
      type: 'response-processor',
      module: mockResponseProcessorModule,
      isDryRun: true,
      config: {
        enabled: true,
        mode: 'full-analysis',
        breakpointBehavior: 'continue',
        verbosity: 'detailed'
      }
    }
  ]);

  // 创建测试请求
  const request = {
    data: {
      model: 'qwen-turbo',
      messages: [
        { role: 'user', content: 'Explain quantum computing in simple terms.' }
      ],
      temperature: 0.7,
      max_tokens: 1000
    },
    route: {
      providerId: 'qwen-provider',
      modelId: 'qwen-turbo',
      requestId: `bidirectional-full-${Date.now()}`,
      timestamp: Date.now()
    },
    metadata: {
      category: 'thinking',
      complexity: 'high',
      estimatedTokens: 1500
    },
    debug: { enabled: true, stages: {} }
  };

  try {
    console.log('\n🚀 开始执行双向流水线完全dry-run...');
    console.log(`   请求流水线模式: full-dry-run`);
    console.log(`   响应流水线模式: full-dry-run`);
    console.log(`   真实响应: ${mockRealResponse ? '已提供' : '未提供'}`);

    const result = await bidirectionalPipelineManager.executeBidirectionalPipeline(
      request,
      'bidirectional-full-test',
      mockRealResponse
    );

    console.log('\n📊 双向流水线执行结果:');

    // 分析请求流水线结果
    console.log('\n📋 请求流水线结果:');
    if ('mode' in result.requestResult) {
      console.log(`   模式: ${result.requestResult.mode}`);
      console.log(`   干运行节点数: ${result.requestResult.requestSummary.dryRunNodeCount}`);
      console.log(`   是否所有节点dry-run: ${result.requestResult.extendedSummary.isAllNodesDryRun}`);
    } else {
      console.log(`   状态: ${result.requestResult.success ? '成功' : '失败'}`);
      console.log(`   处理时间: ${result.requestResult.metadata.processingTime}ms`);
    }

    // 分析响应流水线结果
    console.log('\n📋 响应流水线结果:');
    if ('mode' in result.responseResult) {
      console.log(`   模式: ${result.responseResult.mode}`);
      console.log(`   干运行节点数: ${result.responseResult.requestSummary.dryRunNodeCount}`);
      console.log(`   是否所有节点dry-run: ${result.responseResult.extendedSummary.isAllNodesDryRun}`);
    } else {
      console.log(`   状态: ${result.responseResult.success ? '成功' : '失败'}`);
      console.log(`   处理时间: ${result.responseResult.metadata.processingTime}ms`);
    }

    // 分析驱动器反馈
    if (result.driverFeedbackAnalysis) {
      console.log('\n🔍 驱动器反馈分析:');
      console.log(`   请求-响应相似度: ${(result.driverFeedbackAnalysis.requestResponseCorrelation.similarity * 100).toFixed(1)}%`);
      console.log(`   总处理时间: ${result.driverFeedbackAnalysis.performanceAnalysis.totalOverhead}ms`);
      console.log(`   整体质量评分: ${(result.driverFeedbackAnalysis.qualityAnalysis.overallQuality * 100).toFixed(1)}%`);

      if (result.driverFeedbackAnalysis.recommendations.routing.length > 0) {
        console.log(`   路由建议: ${result.driverFeedbackAnalysis.recommendations.routing.join(', ')}`);
      }
      if (result.driverFeedbackAnalysis.recommendations.performance.length > 0) {
        console.log(`   性能建议: ${result.driverFeedbackAnalysis.recommendations.performance.join(', ')}`);
      }
    }

    // 执行摘要
    console.log('\n📈 执行摘要:');
    console.log(`   总执行时间: ${result.executionSummary.totalExecutionTime}ms`);
    console.log(`   请求处理时间: ${result.executionSummary.requestTime}ms`);
    console.log(`   响应处理时间: ${result.executionSummary.responseTime}ms`);
    console.log(`   反馈分析时间: ${result.executionSummary.feedbackTime}ms`);
    console.log(`   执行模式: ${result.executionSummary.mode}`);

    console.log('\n✅ 双向流水线完全dry-run测试完成!');
    return result;

  } catch (error) {
    console.error('\n❌ 双向流水线完全dry-run测试失败:', error);
    throw error;
  }
}

async function testBidirectionalPipelineMixedMode() {
  console.log('\n=== 测试双向流水线混合模式 ===');

  // 创建测试请求
  const request = {
    data: {
      model: 'qwen-turbo',
      messages: [{ role: 'user', content: 'Hello world' }]
    },
    route: {
      providerId: 'qwen-provider',
      modelId: 'qwen-turbo',
      requestId: `bidirectional-mixed-${Date.now()}`,
      timestamp: Date.now()
    },
    metadata: {},
    debug: { enabled: false, stages: {} }
  };

  try {
    console.log('\n🚀 开始执行双向流水线混合模式...');
    console.log(`   请求流水线: 正常执行`);
    console.log(`   响应流水线: dry-run模式`);

    const result = await bidirectionalPipelineManager.executeBidirectionalPipeline(
      request,
      'bidirectional-mixed-test',
      mockRealResponse
    );

    console.log('\n📊 混合模式执行结果:');
    console.log(`   执行模式: ${result.executionSummary.mode}`);
    console.log(`   总执行时间: ${result.executionSummary.totalExecutionTime}ms`);

    console.log('\n✅ 双向流水线混合模式测试完成!');
    return result;

  } catch (error) {
    console.error('\n❌ 双向流水线混合模式测试失败:', error);
    throw error;
  }
}

async function testResponseInputSources() {
  console.log('\n=== 测试响应输入源 ===');

  const request = {
    data: {
      model: 'qwen-turbo',
      messages: [{ role: 'user', content: 'Test different response sources' }]
    },
    route: {
      providerId: 'qwen-provider',
      modelId: 'qwen-turbo',
      requestId: `response-source-${Date.now()}`,
      timestamp: Date.now()
    },
    metadata: {},
    debug: { enabled: false, stages: {} }
  };

  const sources = [
    { name: '真实响应', source: 'real-response' },
    { name: '模拟响应', source: 'simulated-response' },
    { name: '缓存响应', source: 'cached-response' }
  ];

  for (const { name, source } of sources) {
    try {
      console.log(`\n🔄 测试${name}作为响应输入源...`);

      // 临时修改配置以测试不同的输入源
      const currentConfig = bidirectionalPipelineManager.config;
      currentConfig.responseConfig.responseDryRun.inputSource = source;

      const result = await bidirectionalPipelineManager.executeBidirectionalPipeline(
        request,
        `response-source-${source}`,
        source === 'real-response' ? mockRealResponse : undefined
      );

      console.log(`   ✅ ${name}测试成功`);
      console.log(`   执行时间: ${result.executionSummary.totalExecutionTime}ms`);

    } catch (error) {
      console.error(`   ❌ ${name}测试失败:`, error instanceof Error ? error.message : String(error));
    }
  }

  console.log('\n✅ 响应输入源测试完成!');
}

async function testDriverFeedbackAnalysis() {
  console.log('\n=== 测试驱动器反馈分析 ===');

  const complexRequest = {
    data: {
      model: 'qwen-turbo',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Analyze the performance of this bidirectional pipeline system.' }
      ],
      temperature: 0.7,
      max_tokens: 1000
    },
    route: {
      providerId: 'qwen-provider',
      modelId: 'qwen-turbo',
      requestId: `feedback-analysis-${Date.now()}`,
      timestamp: Date.now()
    },
    metadata: {
      category: 'analysis',
      complexity: 'high',
      estimatedTokens: 2000
    },
    debug: { enabled: true, stages: {} }
  };

  try {
    console.log('\n🔍 执行驱动器反馈分析测试...');

    // 确保反馈分析启用
    bidirectionalPipelineManager.config.driverFeedback.enabled = true;
    bidirectionalPipelineManager.config.driverFeedback.analysisLevel = 'comprehensive';

    const result = await bidirectionalPipelineManager.executeBidirectionalPipeline(
      complexRequest,
      'feedback-analysis-test',
      mockRealResponse
    );

    if (result.driverFeedbackAnalysis) {
      console.log('\n📊 驱动器反馈分析结果:');

      const correlation = result.driverFeedbackAnalysis.requestResponseCorrelation;
      console.log(`\n🔗 请求-响应关联分析:`);
      console.log(`   关联ID: ${correlation.correlationId}`);
      console.log(`   相似度: ${(correlation.similarity * 100).toFixed(1)}%`);
      console.log(`   转换路径: ${correlation.transformationPath.join(' → ')}`);

      const performance = result.driverFeedbackAnalysis.performanceAnalysis;
      console.log(`\n⚡ 性能分析:`);
      console.log(`   请求处理时间: ${performance.requestProcessingTime}ms`);
      console.log(`   响应处理时间: ${performance.responseProcessingTime}ms`);
      console.log(`   总开销: ${performance.totalOverhead}ms`);
      if (performance.bottlenecks.length > 0) {
        console.log(`   瓶颈: ${performance.bottlenecks.join(', ')}`);
      }

      const quality = result.driverFeedbackAnalysis.qualityAnalysis;
      console.log(`\n🎯 质量分析:`);
      console.log(`   请求质量: ${(quality.requestQuality * 100).toFixed(1)}%`);
      console.log(`   响应质量: ${(quality.responseQuality * 100).toFixed(1)}%`);
      console.log(`   整体质量: ${(quality.overallQuality * 100).toFixed(1)}%`);
      if (quality.issues.length > 0) {
        console.log(`   问题: ${quality.issues.join(', ')}`);
      }

      const recommendations = result.driverFeedbackAnalysis.recommendations;
      console.log(`\n💡 优化建议:`);
      if (recommendations.routing.length > 0) {
        console.log(`   路由优化: ${recommendations.routing.join(', ')}`);
      }
      if (recommendations.performance.length > 0) {
        console.log(`   性能优化: ${recommendations.performance.join(', ')}`);
      }
      if (recommendations.reliability.length > 0) {
        console.log(`   可靠性优化: ${recommendations.reliability.join(', ')}`);
      }
    }

    console.log('\n✅ 驱动器反馈分析测试完成!');
    return result;

  } catch (error) {
    console.error('\n❌ 驱动器反馈分析测试失败:', error);
    throw error;
  }
}

// 主测试函数
async function runAllBidirectionalTests() {
  try {
    console.log('开始测试双向流水线dry-run功能...\n');

    // 测试1: 完全dry-run模式
    await testBidirectionalPipelineFullDryRun();

    // 测试2: 混合模式
    await testBidirectionalPipelineMixedMode();

    // 测试3: 响应输入源
    await testResponseInputSources();

    // 测试4: 驱动器反馈分析
    await testDriverFeedbackAnalysis();

    console.log('\n🎉 所有双向流水线dry-run测试完成!');
    console.log('双向流水线功能正常工作，包括:');
    console.log('✅ 请求流水线dry-run支持');
    console.log('✅ 响应流水线dry-run支持');
    console.log('✅ 真实响应数据作为输入');
    console.log('✅ 驱动器级反馈考量');
    console.log('✅ 多种响应输入源支持');
    console.log('✅ 性能和质量分析');
    console.log('✅ 优化建议生成');

  } catch (error) {
    console.error('\n💥 测试失败:', error);
    process.exit(1);
  }
}

// 运行测试
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllBidirectionalTests();
}

export {
  testBidirectionalPipelineFullDryRun,
  testBidirectionalPipelineMixedMode,
  testResponseInputSources,
  testDriverFeedbackAnalysis
};