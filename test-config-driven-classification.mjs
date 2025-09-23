/**
 * Configuration-Driven Classification System Test
 * 测试配置驱动的分类系统
 */

import { ConfigRequestClassifier } from './dist/modules/virtual-router/classifiers/config-request-classifier.js';

// 测试配置
const testConfig = {
  protocolMapping: {
    openai: {
      endpoints: ['/v1/chat/completions', '/v1/completions'],
      messageField: 'messages',
      modelField: 'model',
      toolsField: 'tools',
      maxTokensField: 'max_tokens'
    },
    anthropic: {
      endpoints: ['/v1/messages'],
      messageField: 'messages',
      modelField: 'model',
      toolsField: 'tools',
      maxTokensField: 'max_tokens'
    }
  },
  protocolHandlers: {
    openai: {
      tokenCalculator: {
        type: 'openai',
        tokenRatio: 0.25,
        toolOverhead: 50,
        messageOverhead: 10,
        imageTokenDefault: 255
      },
      toolDetector: {
        type: 'pattern',
        patterns: {
          webSearch: ['web_search', 'search', 'browse', 'internet'],
          codeExecution: ['code', 'execute', 'bash', 'python', 'javascript'],
          fileSearch: ['file', 'read', 'write', 'document', 'pdf'],
          dataAnalysis: ['data', 'analysis', 'chart', 'graph', 'statistics']
        }
      }
    },
    anthropic: {
      tokenCalculator: {
        type: 'anthropic',
        tokenRatio: 0.25,
        toolOverhead: 50,
        messageOverhead: 10
      },
      toolDetector: {
        type: 'pattern',
        patterns: {
          webSearch: ['web_search', 'search', 'browse'],
          codeExecution: ['code', 'execute', 'bash', 'python'],
          fileSearch: ['file', 'read', 'write'],
          dataAnalysis: ['data', 'analysis', 'chart']
        }
      }
    }
  },
  modelTiers: {
    basic: {
      description: 'Basic models for simple tasks',
      models: ['gpt-3.5-turbo', 'claude-3-haiku', 'qwen-turbo'],
      maxTokens: 16384,
      supportedFeatures: ['text_generation', 'conversation']
    },
    advanced: {
      description: 'Advanced models for complex tasks',
      models: ['gpt-4', 'claude-3-opus', 'claude-3-sonnet', 'deepseek-coder', 'qwen-max'],
      maxTokens: 262144,
      supportedFeatures: ['text_generation', 'reasoning', 'coding', 'tool_use']
    }
  },
  routingDecisions: {
    default: {
      description: 'Default routing for general requests',
      modelTier: 'basic',
      tokenThreshold: 8000,
      toolTypes: [],
      priority: 1
    },
    longContext: {
      description: 'Routing for long context requests',
      modelTier: 'advanced',
      tokenThreshold: 10000,
      toolTypes: [],
      priority: 90
    },
    thinking: {
      description: 'Routing for complex reasoning requests',
      modelTier: 'advanced',
      tokenThreshold: 16000,
      toolTypes: ['dataAnalysis', 'complex_reasoning'],
      priority: 85
    },
    coding: {
      description: 'Routing for code generation requests',
      modelTier: 'advanced',
      tokenThreshold: 24000,
      toolTypes: ['codeExecution', 'fileSearch'],
      priority: 80
    },
    webSearch: {
      description: 'Routing for web search requests',
      modelTier: 'advanced',
      tokenThreshold: 12000,
      toolTypes: ['webSearch'],
      priority: 95
    }
  },
  confidenceThreshold: 60
};

// 测试用例
const testCases = [
  {
    name: 'Simple OpenAI Request',
    request: {
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'user', content: 'Hello, how are you?' }
      ],
      max_tokens: 1000
    },
    endpoint: '/v1/chat/completions',
    expected: {
      route: 'default',
      modelTier: 'basic'
    }
  },
  {
    name: 'OpenAI Request with Code Tools',
    request: {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Write a Python function to calculate fibonacci' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'execute_python',
            description: 'Execute Python code'
          }
        }
      ],
      max_tokens: 2000
    },
    endpoint: '/v1/chat/completions',
    expected: {
      route: 'coding',
      modelTier: 'advanced'
    }
  },
  {
    name: 'OpenAI Request with Web Search',
    request: {
      model: 'claude-3-sonnet',
      messages: [
        { role: 'user', content: 'Search for the latest news about AI' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'web_search',
            description: 'Search the web for information'
          }
        }
      ],
      max_tokens: 3000
    },
    endpoint: '/v1/chat/completions',
    expected: {
      route: 'webSearch',
      modelTier: 'advanced'
    }
  },
  {
    name: 'Long Context Request',
    request: {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'A'.repeat(50000) } // 50k tokens
      ],
      max_tokens: 60000
    },
    endpoint: '/v1/chat/completions',
    expected: {
      route: 'longContext',
      modelTier: 'advanced'
    }
  },
  {
    name: 'Complex Reasoning Request',
    request: {
      model: 'claude-3-opus',
      messages: [
        { role: 'user', content: 'Analyze this complex dataset and provide insights' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'analyze_data',
            description: 'Analyze complex datasets'
          }
        }
      ],
      max_tokens: 15000
    },
    endpoint: '/v1/chat/completions',
    expected: {
      route: 'thinking',
      modelTier: 'advanced'
    }
  }
];

async function runTests() {
  console.log('🧪 Testing Configuration-Driven Classification System...\n');

  try {
    // 创建分类器
    const classifier = ConfigRequestClassifier.fromModuleConfig(testConfig);

    // 检查分类器状态
    const status = classifier.getStatus();
    console.log('📊 Classifier Status:', JSON.stringify(status, null, 2));

    if (!status.ready) {
      console.log('❌ Classifier not ready, aborting tests');
      return;
    }

    console.log('✅ Classifier is ready for testing\n');

    let passedTests = 0;
    let totalTests = testCases.length;

    for (const testCase of testCases) {
      console.log(`🔍 Testing: ${testCase.name}`);

      try {
        const result = await classifier.classify({
          request: testCase.request,
          endpoint: testCase.endpoint
        });

        console.log('  📝 Result:', {
          route: result.route,
          modelTier: result.modelTier,
          confidence: result.confidence,
          configBased: result.configBased,
          reasoning: result.reasoning
        });

        // 验证结果
        const routeMatch = result.route === testCase.expected.route;
        const tierMatch = result.modelTier === testCase.expected.modelTier;
        const confidenceOK = result.confidence >= 0.35;
        const configBased = result.configBased;

        const testPassed = routeMatch && tierMatch && confidenceOK && configBased;

        if (testPassed) {
          console.log('  ✅ PASSED');
          passedTests++;
        } else {
          console.log('  ❌ FAILED');
          console.log('    Expected:', testCase.expected);
          console.log('    Got:', {
            route: result.route,
            modelTier: result.modelTier,
            confidence: result.confidence,
            configBased: result.configBased
          });
        }

        console.log('  📊 Performance:', {
          classificationTime: result.performance.classificationTime + 'ms',
          steps: result.performance.steps.length
        });

      } catch (error) {
        console.log('  ❌ ERROR:', error.message);
      }

      console.log(''); // 空行分隔
    }

    // 输出测试结果
    console.log('📋 Test Summary:');
    console.log(`  Total Tests: ${totalTests}`);
    console.log(`  Passed: ${passedTests}`);
    console.log(`  Failed: ${totalTests - passedTests}`);
    console.log(`  Success Rate: ${((passedTests / totalTests) * 100).toFixed(1)}%`);

    if (passedTests === totalTests) {
      console.log('🎉 All tests passed!');
    } else {
      console.log('⚠️  Some tests failed');
    }

  } catch (error) {
    console.error('❌ Test failed with error:', error);
  }
}

// 运行测试
runTests().catch(console.error);