#!/usr/bin/env node
// 虚拟路由模块分类功能dry-run测试
// 测试各种特征的请求是否被正确分类

import { VirtualRouterModule } from './dist/modules/virtual-router/virtual-router-module.js';

async function testVirtualRouterClassification() {
  console.log('🚀 Starting Virtual Router Classification Dry-Run Test...\n');

  // 创建虚拟路由模块实例
  const virtualRouter = new VirtualRouterModule();

  // 准备配置数据
  const config = {
    routeTargets: {
      default: [
        {
          providerId: 'lmstudio',
          modelId: 'gpt-4',
          keyId: 'lmstudio-key',
          actualKey: 'test-key',
          inputProtocol: 'openai',
          outputProtocol: 'openai'
        },
        {
          providerId: 'qwen',
          modelId: 'qwen-turbo',
          keyId: 'qwen-key',
          actualKey: 'test-key',
          inputProtocol: 'openai',
          outputProtocol: 'openai'
        },
        {
          providerId: 'iflow',
          modelId: 'kimi-k2-0905',
          keyId: 'iflow-key',
          actualKey: 'test-key',
          inputProtocol: 'openai',
          outputProtocol: 'openai'
        }
      ],
      longContext: [
        {
          providerId: 'qwen',
          modelId: 'qwen-max',
          keyId: 'qwen-long-key',
          actualKey: 'test-key',
          inputProtocol: 'openai',
          outputProtocol: 'openai'
        }
      ],
      thinking: [
        {
          providerId: 'qwen',
          modelId: 'qwen-turbo',
          keyId: 'qwen-thinking-key',
          actualKey: 'test-key',
          inputProtocol: 'openai',
          outputProtocol: 'openai'
        }
      ],
      background: [
        {
          providerId: 'lmstudio',
          modelId: 'gpt-3.5-turbo',
          keyId: 'lmstudio-bg-key',
          actualKey: 'test-key',
          inputProtocol: 'openai',
          outputProtocol: 'openai'
        }
      ],
      webSearch: [
        {
          providerId: 'qwen',
          modelId: 'qwen-turbo',
          keyId: 'qwen-search-key',
          actualKey: 'test-key',
          inputProtocol: 'openai',
          outputProtocol: 'openai'
        }
      ],
      vision: [
        {
          providerId: 'qwen',
          modelId: 'qwen-vl-plus',
          keyId: 'qwen-vision-key',
          actualKey: 'test-key',
          inputProtocol: 'openai',
          outputProtocol: 'openai'
        }
      ],
      coding: [
        {
          providerId: 'qwen',
          modelId: 'qwen3-coder',
          keyId: 'qwen-coder-key',
          actualKey: 'test-key',
          inputProtocol: 'openai',
          outputProtocol: 'openai'
        }
      ],
      vision: [
        {
          providerId: 'qwen',
          modelId: 'qwen-vl-plus',
          keyId: 'qwen-vision-key',
          actualKey: 'test-key',
          inputProtocol: 'openai',
          outputProtocol: 'openai'
        }
      ],
      background: [
        {
          providerId: 'lmstudio',
          modelId: 'gpt-3.5-turbo',
          keyId: 'lmstudio-bg-key',
          actualKey: 'test-key',
          inputProtocol: 'openai',
          outputProtocol: 'openai'
        }
      ]
    },
    pipelineConfigs: {
      'lmstudio.gpt-4.lmstudio-key': {
        provider: { type: 'lmstudio', baseURL: 'http://localhost:1234' },
        model: { maxContext: 128000, maxTokens: 32000 },
        keyConfig: { keyId: 'lmstudio-key', actualKey: 'test-key' },
        protocols: { input: 'openai', output: 'openai' }
      },
      'qwen.qwen-turbo.qwen-key': {
        provider: { type: 'qwen', baseURL: 'https://chat.qwen.ai' },
        model: { maxContext: 32000, maxTokens: 6000 },
        keyConfig: { keyId: 'qwen-key', actualKey: 'test-key' },
        protocols: { input: 'openai', output: 'openai' }
      },
      'iflow.kimi-k2-0905.iflow-key': {
        provider: { type: 'iflow', baseURL: 'https://apis.iflow.cn/v1' },
        model: { maxContext: 128000, maxTokens: 32000 },
        keyConfig: { keyId: 'iflow-key', actualKey: 'test-key' },
        protocols: { input: 'openai', output: 'openai' }
      }
    },
    inputProtocol: 'openai',
    outputProtocol: 'openai',
    defaultRoute: 'default',
    routes: {
      default: {
        pipelineId: 'default-pipeline',
        targets: [
          {
            providerId: 'lmstudio',
            modelId: 'gpt-4',
            keyId: 'lmstudio-key',
            actualKey: 'test-key',
            inputProtocol: 'openai',
            outputProtocol: 'openai'
          }
        ]
      },
      longContext: {
        pipelineId: 'longcontext-pipeline',
        targets: [
          {
            providerId: 'qwen',
            modelId: 'qwen-max',
            keyId: 'qwen-long-key',
            actualKey: 'test-key',
            inputProtocol: 'openai',
            outputProtocol: 'openai'
          }
        ]
      },
      thinking: {
        pipelineId: 'thinking-pipeline',
        targets: [
          {
            providerId: 'qwen',
            modelId: 'qwen-turbo',
            keyId: 'qwen-thinking-key',
            actualKey: 'test-key',
            inputProtocol: 'openai',
            outputProtocol: 'openai'
          }
        ]
      },
      background: {
        pipelineId: 'background-pipeline',
        targets: [
          {
            providerId: 'lmstudio',
            modelId: 'gpt-3.5-turbo',
            keyId: 'lmstudio-bg-key',
            actualKey: 'test-key',
            inputProtocol: 'openai',
            outputProtocol: 'openai'
          }
        ]
      },
      vision: {
        pipelineId: 'vision-pipeline',
        targets: [
          {
            providerId: 'qwen',
            modelId: 'qwen-vl-plus',
            keyId: 'qwen-vision-key',
            actualKey: 'test-key',
            inputProtocol: 'openai',
            outputProtocol: 'openai'
          }
        ]
      },
      webSearch: {
        pipelineId: 'websearch-pipeline',
        targets: [
          {
            providerId: 'qwen',
            modelId: 'qwen-turbo',
            keyId: 'qwen-search-key',
            actualKey: 'test-key',
            inputProtocol: 'openai',
            outputProtocol: 'openai'
          }
        ]
      },
      vision: {
        pipelineId: 'vision-pipeline',
        targets: [
          {
            providerId: 'qwen',
            modelId: 'qwen-vl-plus',
            keyId: 'qwen-vision-key',
            actualKey: 'test-key',
            inputProtocol: 'openai',
            outputProtocol: 'openai'
          }
        ]
      },
      coding: {
        pipelineId: 'coding-pipeline',
        targets: [
          {
            providerId: 'qwen',
            modelId: 'qwen3-coder',
            keyId: 'qwen-coder-key',
            actualKey: 'test-key',
            inputProtocol: 'openai',
            outputProtocol: 'openai'
          }
        ]
      }
    }
  };

  // 初始化虚拟路由模块
  console.log('📋 Initializing Virtual Router with configuration...');
  await virtualRouter.initialize(config);

  // 启用dry-run模式
  virtualRouter.setDryRunMode(true, {
    verbosity: 'detailed',
    includePerformanceEstimate: true,
    includeConfigValidation: true,
    maxOutputDepth: 5
  });

  console.log('📋 Virtual Router Dry-Run Mode Enabled\n');

  // 定义各种特征的测试请求
  const testRequests = [
    {
      name: '长文本处理请求',
      category: 'longContext',
      request: {
        model: 'gpt-4',
        messages: [
          { role: 'user', content: '请分析这篇很长的文章...' }
        ],
        // 长文本特征
        context_length: 100000,
        tokens: 95000
      }
    },
    {
      name: '复杂推理请求',
      category: 'thinking',
      request: {
        model: 'gpt-4',
        messages: [
          { role: 'user', content: '请详细分析这个复杂的逻辑问题...' }
        ],
        // 推理特征
        reasoning: true,
        complexity: 'high'
      }
    },
    {
      name: '后台处理请求',
      category: 'background',
      request: {
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'user', content: '请批量处理这些数据...' }
        ],
        // 后台处理特征
        batch: true,
        async: true
      }
    },
    {
      name: '网络搜索请求',
      category: 'webSearch',
      request: {
        model: 'gpt-4',
        messages: [
          { role: 'user', content: '请搜索最新的技术资讯...' }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'web_search',
              description: 'Search the web for current information'
            }
          }
        ]
      }
    },
    {
      name: '图像处理请求',
      category: 'vision',
      request: {
        model: 'gpt-4-vision',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '请描述这张图片...' },
              { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,...' } }
            ]
          }
        ]
      }
    },
    {
      name: '代码生成请求',
      category: 'coding',
      request: {
        model: 'gpt-4',
        messages: [
          { role: 'user', content: '请用Python编写一个快速排序算法...' }
        ],
        // 代码特征
        language: 'python',
        task_type: 'code_generation'
      }
    },
    {
      name: '工具调用请求',
      category: 'default',
      request: {
        model: 'gpt-4',
        messages: [
          { role: 'user', content: '请帮我列出当前目录的文件...' }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'list_directory',
              description: 'List files in directory'
            }
          }
        ]
      }
    },
    {
      name: '普通对话请求',
      category: 'default',
      request: {
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'user', content: '你好，今天天气怎么样？' }
        ]
      }
    }
  ];

  console.log('🧪 Testing Request Classification...\n');

  // 执行测试
  const results = [];
  for (const testCase of testRequests) {
    console.log(`📝 Testing: ${testCase.name}`);
    console.log(`   Expected Category: ${testCase.category}`);

    try {
      // 执行dry-run分析
      const result = await virtualRouter.executeDryRun(testCase.request, 'default');

      // 分析分类结果
      const actualCategory = result.routingDecision?.routeName || 'unknown';
      const confidence = result.routingDecision?.confidence || 0;
      const selectedTarget = result.routingDecision?.selectedTarget;

      console.log(`   Actual Category: ${actualCategory}`);
      console.log(`   Confidence: ${confidence.toFixed(2)}`);
      console.log(`   Selected Target: ${selectedTarget?.providerId || 'none'}.${selectedTarget?.modelId || 'none'}`);

      // 判断分类是否正确
      const isCorrect = actualCategory === testCase.category;
      console.log(`   Classification: ${isCorrect ? '✅ Correct' : '❌ Incorrect'}`);

      // 显示详细的路由信息
      if (result.routingDecision) {
        console.log(`   Route: ${result.routingDecision.routeName}`);
        console.log(`   Algorithm: ${result.routingDecision.loadBalancerDecision?.algorithm || 'none'}`);
        console.log(`   Available Targets: ${result.routingDecision.availableTargets?.length || 0}`);
      }

      // 显示性能估计
      if (result.performanceEstimate) {
        console.log(`   Estimated Time: ${result.performanceEstimate.estimatedTimeMs}ms`);
        console.log(`   Complexity: ${result.performanceEstimate.complexity}`);
      }

      results.push({
        name: testCase.name,
        expected: testCase.category,
        actual: actualCategory,
        confidence,
        correct: isCorrect,
        target: selectedTarget
      });

    } catch (error) {
      console.log(`   ❌ Error: ${error.message}`);
      results.push({
        name: testCase.name,
        expected: testCase.category,
        actual: 'error',
        confidence: 0,
        correct: false,
        error: error.message
      });
    }

    console.log('   ' + '='.repeat(60));
    console.log();
  }

  // 生成分类结果汇总
  console.log('📊 Classification Results Summary:');
  console.log('═════════════════════════════════════════════════════');

  const totalTests = results.length;
  const correctTests = results.filter(r => r.correct).length;
  const accuracy = (correctTests / totalTests * 100).toFixed(1);

  console.log(`📈 Overall Accuracy: ${accuracy}% (${correctTests}/${totalTests})`);
  console.log();

  // 按类别显示结果
  const categoryResults = {};
  results.forEach(result => {
    if (!categoryResults[result.expected]) {
      categoryResults[result.expected] = [];
    }
    categoryResults[result.expected].push(result);
  });

  Object.entries(categoryResults).forEach(([category, tests]) => {
    const categoryCorrect = tests.filter(t => t.correct).length;
    const categoryTotal = tests.length;
    const categoryAccuracy = categoryTotal > 0 ? (categoryCorrect / categoryTotal * 100).toFixed(1) : 0;

    console.log(`🎯 ${category.toUpperCase()}: ${categoryAccuracy}% (${categoryCorrect}/${categoryTotal})`);
    tests.forEach(test => {
      const status = test.correct ? '✅' : '❌';
      console.log(`   ${status} ${test.name} -> ${test.actual} (conf: ${test.confidence.toFixed(2)})`);
    });
    console.log();
  });

  // 显示错误分析
  const errors = results.filter(r => !r.correct && r.actual !== 'error');
  if (errors.length > 0) {
    console.log('❌ Misclassified Requests:');
    errors.forEach(error => {
      console.log(`   ${error.name}: Expected ${error.expected}, Got ${error.actual}`);
    });
    console.log();
  }

  // 显示统计信息
  const stats = virtualRouter.getDryRunStats();
  console.log('📈 Dry-Run Statistics:');
  console.log(`   Total Runs: ${stats.totalRuns}`);
  console.log(`   Successful Runs: ${stats.successfulRuns}`);
  console.log(`   Average Time: ${stats.averageTimeMs.toFixed(2)}ms`);
  console.log(`   Config Errors: ${stats.configErrors.routing + stats.configErrors.pipeline + stats.configErrors.target}`);

  if (stats.topRoutes.length > 0) {
    console.log(`   Top Routes: ${stats.topRoutes.slice(0, 3).map(r => `${r.route}(${r.count})`).join(', ')}`);
  }
  if (stats.topTargets.length > 0) {
    console.log(`   Top Targets: ${stats.topTargets.slice(0, 3).map(t => `${t.target}(${t.count})`).join(', ')}`);
  }

  console.log();

  // 结论
  if (accuracy >= 80) {
    console.log('🎉 Classification performance is GOOD!');
  } else if (accuracy >= 60) {
    console.log('⚠️  Classification performance is FAIR - room for improvement');
  } else {
    console.log('❌ Classification performance is POOR - needs attention');
  }

  console.log('✅ Virtual Router Classification Dry-Run Test Completed!');
}

// 运行测试
testVirtualRouterClassification().catch(console.error);