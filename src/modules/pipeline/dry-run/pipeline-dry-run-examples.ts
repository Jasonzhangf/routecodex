/**
 * Pipeline Dry-Run Examples and Usage Guide
 *
 * 展示如何在流水线中使用节点级dry-run功能
 */

import type { NodeDryRunConfig, OutputValidationRule } from './pipeline-dry-run-framework.js';
import { dryRunPipelineExecutor } from './dry-run-pipeline-executor.js';
import { pipelineDryRunManager } from './pipeline-dry-run-framework.js';

/**
 * 示例1: 基础节点级Dry-Run配置
 */
export const basicDryRunConfigs: Record<string, NodeDryRunConfig> = {
  'llm-switch': {
    enabled: true,
    mode: 'output-validation',
    breakpointBehavior: 'continue',
    verbosity: 'normal'
  },

  'compatibility': {
    enabled: true,
    mode: 'full-analysis',
    breakpointBehavior: 'pause',
    verbosity: 'detailed'
  },

  'provider': {
    enabled: false, // 正常执行
    mode: 'output-validation',
    breakpointBehavior: 'continue',
    verbosity: 'minimal'
  }
};

/**
 * 示例2: 带输出验证规则的配置
 */
export const validationDryRunConfigs: Record<string, NodeDryRunConfig> = {
  'llm-switch': {
    enabled: true,
    mode: 'output-validation',
    breakpointBehavior: 'continue',
    verbosity: 'normal',
    validationRules: [
      {
        id: 'schema-validation',
        type: 'schema',
        condition: {
          required: ['_metadata', 'switchType'],
          properties: {
            '_metadata': { type: 'object' },
            'switchType': { type: 'string' }
          }
        },
        errorMessage: 'LLM Switch output must contain metadata and switchType',
        severity: 'error'
      },
      {
        id: 'routing-validation',
        type: 'value-range',
        condition: {
          field: '_metadata.routing',
          allowedValues: ['default', 'longcontext', 'thinking', 'background']
        },
        errorMessage: 'Invalid routing category detected',
        severity: 'warning'
      }
    ]
  }
};

/**
 * 示例3: 错误模拟配置
 */
export const errorSimulationConfigs: Record<string, NodeDryRunConfig> = {
  'provider': {
    enabled: true,
    mode: 'error-simulation',
    breakpointBehavior: 'terminate',
    verbosity: 'detailed',
    errorSimulation: {
      enabled: true,
      errorType: 'timeout',
      probability: 0.3, // 30%概率模拟超时
      customError: {
        message: 'Simulated timeout error',
        code: 'TIMEOUT',
        timeout: 5000
      }
    }
  }
};

/**
 * 示例4: 复杂流水线调试配置
 */
export const complexDebugConfigs: Record<string, NodeDryRunConfig> = {
  'virtual-router': {
    enabled: true,
    mode: 'full-analysis',
    breakpointBehavior: 'pause',
    verbosity: 'detailed',
    validationRules: [
      {
        id: 'routing-decision',
        type: 'custom',
        condition: (output: any) => {
          return output && output._metadata && output._metadata.routing;
        },
        errorMessage: 'Virtual router must make routing decision',
        severity: 'error'
      }
    ]
  },

  'llm-switch': {
    enabled: true,
    mode: 'output-validation',
    breakpointBehavior: 'continue',
    verbosity: 'normal',
    validationRules: [
      {
        id: 'protocol-routing',
        type: 'schema',
        condition: {
          required: ['_metadata'],
          properties: {
            '_metadata': {
              type: 'object',
              properties: {
                'originalProtocol': { type: 'string' },
                'targetProtocol': { type: 'string' }
              }
            }
          }
        },
        errorMessage: 'LLM Switch must include protocol routing information',
        severity: 'error'
      }
    ]
  },

  'load-balancer': {
    enabled: true,
    mode: 'full-analysis',
    breakpointBehavior: 'pause',
    verbosity: 'detailed'
  },

  'compatibility': {
    enabled: false, // 正常执行以测试真实的协议转换
    mode: 'output-validation',
    breakpointBehavior: 'continue',
    verbosity: 'minimal'
  }
};

/**
 * 使用示例和API演示
 */
export class PipelineDryRunExamples {
  /**
   * 示例: 基础的节点级dry-run测试
   */
  async exampleBasicNodeDryRun() {
    console.log('=== 基础节点级Dry-Run示例 ===');

    // 1. 配置节点dry-run
    pipelineDryRunManager.configureNodesDryRun(basicDryRunConfigs);

    // 2. 注册流水线节点
    dryRunPipelineExecutor.registerNodes([
      {
        id: 'llm-switch',
        type: 'llm-switch',
        module: mockLLMSwitchModule,
        isDryRun: true,
        config: basicDryRunConfigs['llm-switch']
      },
      {
        id: 'compatibility',
        type: 'compatibility',
        module: mockCompatibilityModule,
        isDryRun: true,
        config: basicDryRunConfigs['compatibility']
      },
      {
        id: 'provider',
        type: "start",
        module: mockProviderModule,
        isDryRun: false // 正常执行
      }
    ]);

    // 3. 设置执行顺序
    dryRunPipelineExecutor.setExecutionOrder(['llm-switch', 'compatibility', 'provider']);

    // 4. 添加事件监听器
    dryRunPipelineExecutor.addEventHandler('breakpoint-hit', (event: any) => {
      console.log(`🔍 断点触发: ${event.nodeId}`, event.data);
    });

    dryRunPipelineExecutor.addEventHandler('node-completed', (event: any) => {
      console.log(`✅ 节点完成: ${event.nodeId}`);
    });

    // 5. 执行流水线
    const request = {
      data: { model: 'test-model', messages: [{ role: 'user', content: 'Hello' }] },
      route: {
        providerId: 'test-provider',
        modelId: 'test-model',
        requestId: 'test-001',
        timestamp: Date.now()
      },
      metadata: {},
      debug: { enabled: false, stages: {} }
    };

    try {
      const result = await dryRunPipelineExecutor.executePipeline(
        request,
        'test-pipeline',
        'mixed' // 混合模式：部分dry-run，部分正常执行
      );

      console.log('📊 执行结果:', result);
    } catch (error) {
      console.error('❌ 执行失败:', error);
    }
  }

  /**
   * 示例: 带验证规则的dry-run
   */
  async exampleValidationDryRun() {
    console.log('=== 验证规则Dry-Run示例 ===');

    // 配置验证规则
    pipelineDryRunManager.configureNodesDryRun(validationDryRunConfigs);

    // 执行并获取详细验证结果
    const result = await dryRunPipelineExecutor.executePipeline(
      createTestRequest(),
      'validation-test',
      'dry-run'
    );

    // 分析验证结果
    if ('dryRunResults' in result) {
      (result as any).dryRunResults.forEach((nodeResult: any, nodeId: any) => {
        console.log(`\n📋 ${nodeId} 验证结果:`);
        console.log(`   状态: ${nodeResult.status}`);

        nodeResult.validationResults.forEach((validation: any) => {
          const status = validation.passed ? '✅' : '❌';
          console.log(`   ${status} ${validation.ruleId}: ${validation.message}`);
        });

        if (nodeResult.validationResults.length === 0) {
          console.log('   ℹ️  无验证规则');
        }
      });
    }
  }

  /**
   * 示例: 错误模拟测试
   */
  async exampleErrorSimulation() {
    console.log('=== 错误模拟示例 ===');

    // 配置错误模拟
    pipelineDryRunManager.configureNodesDryRun(errorSimulationConfigs);

    // 多次执行以观察随机错误
    for (let i = 0; i < 5; i++) {
      console.log(`\n--- 执行 #${i + 1} ---`);

      try {
        const result = await dryRunPipelineExecutor.executePipeline(
          createTestRequest(),
          'error-test',
          'dry-run'
        );

        if ('dryRunResults' in result) {
          const providerResult = result.dryRunResults.get('provider');
          if (providerResult) {
            console.log(`Provider状态: ${providerResult.status}`);
            if (providerResult.status === 'simulated-error') {
              console.log('⚠️  模拟错误:', providerResult.error);
            }
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.log('💥 执行错误:', msg);
      }
    }
  }

  /**
   * 示例: 复杂调试场景
   */
  async exampleComplexDebugging() {
    console.log('=== 复杂调试场景 ===');

    // 配置复杂的调试设置
    pipelineDryRunManager.configureNodesDryRun(complexDebugConfigs);

    // 设置断点处理器
    dryRunPipelineExecutor.addEventHandler('breakpoint-hit', (event) => {
      console.log(`\n🛑 调试断点: ${event.nodeId}`);
      console.log('   可以在这里检查状态、修改变量或继续执行');

      // 可以在这里添加调试逻辑，比如：
      // - 检查节点的输入输出
      // - 验证数据格式
      // - 模拟不同的执行路径
    });

    // 执行复杂流水线
    const result = await dryRunPipelineExecutor.executePipeline(
      createComplexTestRequest(),
      'complex-debug',
      'mixed'
    );

    // 生成调试报告
    if ('dryRunResults' in result) {
      this.generateDebugReport((result as any).dryRunResults);
    }
  }

  /**
   * 生成调试报告
   */
  private generateDebugReport(results: Map<string, any>) {
    console.log('\n📊 调试报告:');
    console.log('='.repeat(50));

    results.forEach((result: any, nodeId: any) => {
      console.log(`\n🔧 ${nodeId} (${result.nodeType}):`);
      console.log(`   状态: ${result.status}`);
      console.log(`   预估时间: ${result.performanceMetrics.estimatedTime}ms`);
      console.log(`   预估内存: ${result.performanceMetrics.estimatedMemory}KB`);

      if (result.validationResults.length > 0) {
        const errors = result.validationResults.filter((r: any) => r.severity === 'error');
        const warnings = result.validationResults.filter((r: any) => r.severity === 'warning');
        console.log(`   验证结果: ${errors.length} 错误, ${warnings.length} 警告`);
      }

      if (result.executionLog.length > 0) {
        console.log(`   执行日志: ${result.executionLog.length} 条`);
        result.executionLog.slice(0, 3).forEach((log: any) => {
          console.log(`     [${log.level.toUpperCase()}] ${log.message}`);
        });
      }
    });
  }
}

/**
 * 辅助函数: 创建测试请求
 */
function createTestRequest() {
  return {
    data: { model: 'test-model', messages: [{ role: 'user', content: 'Hello' }] },
    route: {
      providerId: 'test-provider',
      modelId: 'test-model',
      requestId: `test-${Date.now()}`,
      timestamp: Date.now()
    },
    metadata: {},
    debug: { enabled: false, stages: {} }
  };
}

/**
 * 辅助函数: 创建复杂测试请求
 */
function createComplexTestRequest() {
  return {
    data: {
      model: 'qwen-turbo',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Explain quantum computing in simple terms.' }
      ],
      temperature: 0.7,
      max_tokens: 1000
    },
    route: {
      providerId: 'qwen-provider',
      modelId: 'qwen-turbo',
      requestId: `complex-${Date.now()}`,
      timestamp: Date.now()
    },
    metadata: {
      category: 'thinking',
      complexity: 'high',
      estimatedTokens: 1500
    },
    debug: { enabled: true, stages: {} }
  };
}

/**
 * 模拟模块实现
 */
const mockLLMSwitchModule = {
  id: 'mock-llm-switch',
  type: 'llm-switch',
  config: { type: 'mock', config: {} },

  async initialize() {},
  async processIncoming(request: any) {
    return {
      ...request.data,
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
    // 简化的验证逻辑
    return rules.map(rule => ({
      ruleId: rule.id,
      passed: true,
      message: 'Validation passed',
      severity: 'warning' as const
    }));
  },

  async simulateError(config: any) {
    return new Error('Simulated LLM Switch error');
  },

  async estimatePerformance(input: any) {
    return { time: 5, memory: 100, complexity: 1 };
  },
  async processOutgoing(response: any) {
    return response;
  },
  async cleanup() {}
};

const mockCompatibilityModule = {
  ...mockLLMSwitchModule,
  id: 'mock-compatibility',
  type: 'compatibility'
};

const mockProviderModule = {
  ...mockLLMSwitchModule,
  id: 'mock-provider',
  type: "start"
};

// 导出使用示例
export const pipelineDryRunExamples = new PipelineDryRunExamples();
