/**
 * 测试所有节点dry-run功能
 * 验证输入模拟器与流水线dry-run执行器的集成
 */

// 由于TypeScript编译问题，直接导入模拟实现
import { dryRunPipelineExecutor } from './dist/modules/pipeline/dry-run/dry-run-pipeline-executor.js';
import { pipelineDryRunManager } from './dist/modules/pipeline/dry-run/pipeline-dry-run-framework.js';
import { inputSimulator } from './dist/modules/pipeline/dry-run/input-simulator.js';

// 模拟模块实现
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
          routing: 'thinking',
          isSimulated: context.metadata?.isSimulated || false
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
          timestamp: Date.now(),
          isSimulated: context.metadata?.isSimulated || false
        }
      },
      validationResults: [],
      performanceMetrics: { estimatedTime: 3, estimatedMemory: 80, complexity: 1 },
      executionLog: [{
        timestamp: Date.now(),
        level: 'info',
        message: 'Compatibility layer dry-run completed'
      }]
    };
  }
};

const mockProviderModule = {
  ...mockLLMSwitchModule,
  id: 'mock-provider',
  type: 'provider',

  async processIncoming(request: any) {
    return {
      id: 'chatcmpl-' + Math.random().toString(36).substr(2, 9),
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'Mock response from provider'
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 15,
        total_tokens: 25
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
        id: 'chatcmpl-' + Math.random().toString(36).substr(2, 9),
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'Mock response from dry-run provider'
          },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 15,
          total_tokens: 25
        },
        _metadata: {
          isSimulated: context.metadata?.isSimulated || false
        }
      },
      validationResults: [],
      performanceMetrics: { estimatedTime: 50, estimatedMemory: 200, complexity: 2 },
      executionLog: [{
        timestamp: Date.now(),
        level: 'info',
        message: 'Provider dry-run completed'
      }]
    };
  }
};

async function testAllNodesDryRun() {
  console.log('=== 测试所有节点dry-run功能 ===');

  // 配置所有节点为dry-run模式
  const allDryRunConfigs = {
    'llm-switch': {
      enabled: true,
      mode: 'full-analysis' as const,
      breakpointBehavior: 'continue' as const,
      verbosity: 'detailed' as const
    },
    'compatibility': {
      enabled: true,
      mode: 'full-analysis' as const,
      breakpointBehavior: 'continue' as const,
      verbosity: 'detailed' as const
    },
    'provider': {
      enabled: true,
      mode: 'full-analysis' as const,
      breakpointBehavior: 'continue' as const,
      verbosity: 'detailed' as const
    }
  };

  // 配置节点dry-run
  pipelineDryRunManager.configureNodesDryRun(allDryRunConfigs);

  // 注册所有节点为dry-run
  dryRunPipelineExecutor.registerNodes([
    {
      id: 'llm-switch',
      type: 'llm-switch',
      module: mockLLMSwitchModule,
      isDryRun: true,
      config: allDryRunConfigs['llm-switch']
    },
    {
      id: 'compatibility',
      type: 'compatibility',
      module: mockCompatibilityModule,
      isDryRun: true,
      config: allDryRunConfigs['compatibility']
    },
    {
      id: 'provider',
      type: 'provider',
      module: mockProviderModule,
      isDryRun: true,
      config: allDryRunConfigs['provider']
    }
  ]);

  // 设置执行顺序
  dryRunPipelineExecutor.setExecutionOrder(['llm-switch', 'compatibility', 'provider']);

  // 添加事件监听器
  dryRunPipelineExecutor.addEventHandler('breakpoint-hit', (event) => {
    console.log(`🔍 断点触发: ${event.nodeId}`);
    if (event.data.dryRunResult.inputData) {
      console.log(`   输入数据: ${JSON.stringify(event.data.dryRunResult.inputData).substring(0, 100)}...`);
    }
  });

  dryRunPipelineExecutor.addEventHandler('node-completed', (event) => {
    console.log(`✅ 节点完成: ${event.nodeId} (${event.data.nodeType})`);
  });

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
      requestId: `all-dryrun-${Date.now()}`,
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
    console.log('\n🚀 开始执行所有节点dry-run...');
    console.log(`   节点数量: 3`);
    console.log(`   执行模式: dry-run`);
    console.log(`   输入模拟器状态: ${inputSimulator ? '可用' : '不可用'}`);

    const result = await dryRunPipelineExecutor.executePipeline(
      request,
      'all-nodes-dry-run-test',
      'dry-run'
    );

    console.log('\n📊 所有节点dry-run执行结果:');

    if ('mode' in result && result.mode === 'dry-run') {
      console.log(`\n📋 执行摘要:`);
      console.log(`   模式: ${result.mode}`);
      console.log(`   流水线ID: ${result.requestSummary.pipelineId}`);
      console.log(`   干运行节点数: ${result.requestSummary.dryRunNodeCount}`);
      console.log(`   是否所有节点dry-run: ${result.requestSummary.isAllNodesDryRun}`);
      console.log(`   使用模拟上下文: ${result.requestSummary.hasSimulatedContext}`);
      console.log(`   总执行时间: ${result.totalDryRunTimeMs}ms`);

      console.log(`\n🔄 执行计划:`);
      result.executionPlan.forEach((step, index) => {
        console.log(`   ${index + 1}. ${step.step}`);
        console.log(`      模块: ${step.module}`);
        console.log(`      描述: ${step.description}`);
      });

      console.log(`\n🎯 路由决策:`);
      console.log(`   算法: ${result.routingDecision.loadBalancerDecision.algorithm}`);
      console.log(`   理由: ${result.routingDecision.loadBalancerDecision.reasoning}`);

      console.log(`\n💡 建议:`);
      console.log(`   策略: ${result.recommendations.strategy}`);
      console.log(`   扩展: ${result.recommendations.scaling}`);
      console.log(`   健康: ${result.recommendations.health}`);

      if (result.simulationSummary) {
        console.log(`\n🔬 模拟摘要:`);
        console.log(`   总节点数: ${result.simulationSummary.totalNodes}`);
        console.log(`   干运行节点数: ${result.simulationSummary.dryRunNodes}`);
        console.log(`   上下文传播: ${result.simulationSummary.contextPropagation ? '启用' : '禁用'}`);
      }
    }

    console.log('\n✅ 所有节点dry-run测试完成!');
    return result;

  } catch (error) {
    console.error('\n❌ 所有节点dry-run测试失败:', error);
    throw error;
  }
}

async function testMixedModeDryRun() {
  console.log('\n=== 测试混合模式dry-run功能 ===');

  // 混合模式：部分节点dry-run，部分正常执行
  const mixedConfigs = {
    'llm-switch': {
      enabled: true,
      mode: 'output-validation' as const,
      breakpointBehavior: 'continue' as const,
      verbosity: 'normal' as const
    },
    'compatibility': {
      enabled: false, // 正常执行
      mode: 'output-validation' as const,
      breakpointBehavior: 'continue' as const,
      verbosity: 'minimal' as const
    },
    'provider': {
      enabled: true,
      mode: 'output-validation' as const,
      breakpointBehavior: 'continue' as const,
      verbosity: 'normal' as const
    }
  };

  // 配置节点
  pipelineDryRunManager.configureNodesDryRun(mixedConfigs);

  // 注册混合模式节点
  dryRunPipelineExecutor.registerNodes([
    {
      id: 'llm-switch',
      type: 'llm-switch',
      module: mockLLMSwitchModule,
      isDryRun: true,
      config: mixedConfigs['llm-switch']
    },
    {
      id: 'compatibility',
      type: 'compatibility',
      module: mockCompatibilityModule,
      isDryRun: false, // 正常执行
      config: mixedConfigs['compatibility']
    },
    {
      id: 'provider',
      type: 'provider',
      module: mockProviderModule,
      isDryRun: true,
      config: mixedConfigs['provider']
    }
  ]);

  const request = {
    data: {
      model: 'qwen-turbo',
      messages: [{ role: 'user', content: 'Hello world' }]
    },
    route: {
      providerId: 'qwen-provider',
      modelId: 'qwen-turbo',
      requestId: `mixed-${Date.now()}`,
      timestamp: Date.now()
    },
    metadata: {},
    debug: { enabled: false, stages: {} }
  };

  try {
    console.log('\n🚀 开始执行混合模式dry-run...');
    console.log(`   干运行节点: llm-switch, provider`);
    console.log(`   正常执行节点: compatibility`);

    const result = await dryRunPipelineExecutor.executePipeline(
      request,
      'mixed-mode-test',
      'mixed'
    );

    console.log('\n📊 混合模式执行结果:');
    if ('mode' in result) {
      console.log(`   模式: ${result.mode}`);
      console.log(`   干运行节点数: ${result.requestSummary.dryRunNodeCount}`);
      console.log(`   是否所有节点dry-run: ${result.requestSummary.isAllNodesDryRun}`);
    }

    console.log('\n✅ 混合模式dry-run测试完成!');
    return result;

  } catch (error) {
    console.error('\n❌ 混合模式dry-run测试失败:', error);
    throw error;
  }
}

// 主测试函数
async function runAllTests() {
  try {
    console.log('开始测试流水线dry-run执行器的输入模拟器集成...\n');

    // 测试1: 所有节点dry-run
    await testAllNodesDryRun();

    // 测试2: 混合模式
    await testMixedModeDryRun();

    console.log('\n🎉 所有测试完成! 输入模拟器集成正常工作。');

  } catch (error) {
    console.error('\n💥 测试失败:', error);
    process.exit(1);
  }
}

// 运行测试
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests();
}

export { testAllNodesDryRun, testMixedModeDryRun };