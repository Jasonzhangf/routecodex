/**
 * Comprehensive Test Suite for LLMSwitch AJV Module
 * Includes test cases for various OpenAI <> Anthropic conversion scenarios
 */

import { LLMSwitchTestAdapter } from '../core/test-adapter.js';
import type { TestResult } from '../core/test-adapter.js';

/**
 * Test data for various conversion scenarios
 */
export const testCases = [
  // Basic text-only requests
  {
    name: 'simple-text-request-openai-to-anthropic',
    type: 'request',
    data: {
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello, how are you?' }
      ],
      temperature: 0.7,
      max_tokens: 100
    }
  },
  {
    name: 'simple-text-request-anthropic-to-openai',
    type: 'request',
    data: {
      model: 'claude-3',
      messages: [
        { role: 'user', content: 'Hello, how are you?' }
      ],
      system: 'You are a helpful assistant.',
      max_tokens: 100,
      temperature: 0.7
    }
  },

  // Tool call scenarios
  {
    name: 'single-tool-call-request-openai-to-anthropic',
    type: 'request',
    data: {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Read the file README.md' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_123',
              type: 'function',
              function: {
                name: 'read',
                arguments: '{"file_path": "README.md"}'
              }
            }
          ]
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read',
            description: 'Read a file',
            parameters: {
              type: 'object',
              required: ['file_path'],
              properties: {
                file_path: { type: 'string' }
              }
            }
          }
        }
      ],
      tool_choice: 'auto'
    }
  },
  {
    name: 'single-tool-use-request-anthropic-to-openai',
    type: 'request',
    data: {
      model: 'claude-3',
      messages: [
        { role: 'user', content: 'Read the file README.md' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_123',
              name: 'read',
              input: { file_path: 'README.md' }
            }
          ]
        }
      ],
      tools: [
        {
          name: 'read',
          description: 'Read a file',
          input_schema: {
            type: 'object',
            required: ['file_path'],
            properties: {
              file_path: { type: 'string' }
            }
          }
        }
      ],
      max_tokens: 1000
    }
  },

  // Multi-tool conversations
  {
    name: 'multi-tool-conversation-openai-to-anthropic',
    type: 'request',
    data: {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Read a file and search for content' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'read',
                arguments: '{"file_path": "test.txt"}'
              }
            },
            {
              id: 'call_2',
              type: 'function',
              function: {
                name: 'search',
                arguments: '{"pattern": "hello", "path": "."}'
              }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: 'File content here'
        },
        {
          role: 'tool',
          tool_call_id: 'call_2',
          content: 'Search results here'
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read',
            description: 'Read a file',
            parameters: {
              type: 'object',
              required: ['file_path'],
              properties: {
                file_path: { type: 'string' }
              }
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'search',
            description: 'Search for content',
            parameters: {
              type: 'object',
              required: ['pattern'],
              properties: {
                pattern: { type: 'string' },
                path: { type: 'string' }
              }
            }
          }
        }
      ]
    }
  },

  // Response conversions
  {
    name: 'text-response-openai-to-anthropic',
    type: 'response',
    data: {
      id: 'chat-123',
      object: 'chat.completion',
      created: 1234567890,
      model: 'gpt-4',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Hello! How can I help you today?'
          },
          finish_reason: 'stop'
        }
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 15,
        total_tokens: 25
      }
    }
  },
  {
    name: 'tool-calls-response-openai-to-anthropic',
    type: 'response',
    data: {
      id: 'chat-456',
      object: 'chat.completion',
      created: 1234567890,
      model: 'gpt-4',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_789',
                type: 'function',
                function: {
                  name: 'bash',
                  arguments: '{"command": "echo hello"}'
                }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 10,
        total_tokens: 30
      }
    }
  },
  {
    name: 'tool-use-response-anthropic-to-openai',
    type: 'response',
    data: {
      id: 'msg_123',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_456',
          name: 'bash',
          input: { command: 'echo hello' }
        }
      ],
      model: 'claude-3-sonnet',
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 20,
        output_tokens: 10
      }
    }
  },

  // Edge cases and special scenarios
  {
    name: 'empty-messages-openai-to-anthropic',
    type: 'request',
    data: {
      model: 'gpt-4',
      messages: []
    }
  },
  {
    name: 'complex-tool-parameters',
    type: 'request',
    data: {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Execute a complex command' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'bash',
            description: 'Execute bash command',
            parameters: {
              type: 'object',
              required: ['command'],
              properties: {
                command: {
                  oneOf: [
                    { type: 'string' },
                    { type: 'array', items: { type: 'string' } }
                  ]
                },
                timeout: { type: 'integer', minimum: 1 },
                description: { type: 'string' },
                run_in_background: { type: 'boolean' }
              }
            }
          }
        }
      ]
    }
  },

  // Transform method tests
  {
    name: 'transform-request-simple',
    type: 'transform-request',
    data: {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Simple test' }
      ]
    }
  },
  {
    name: 'transform-response-simple',
    type: 'transform-response',
    data: {
      id: 'msg_789',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Simple response' }
      ],
      model: 'claude-3-sonnet',
      stop_reason: 'end_turn'
    }
  }
];

/**
 * Run comprehensive test suite
 */
export async function runComprehensiveTestSuite(originalAdapter: any): Promise<{
  report: any;
  results: TestResult[];
  metrics: any;
}> {
  const testAdapter = new LLMSwitchTestAdapter();
  testAdapter.setOriginalAdapter(originalAdapter);

  try {
    // Initialize adapters
    await testAdapter.initialize();

    console.log('Running comprehensive LLMSwitch AJV test suite...');
    console.log(`Total test cases: ${testCases.length}`);

    // Run all test cases
    const results = await testAdapter.runTestSuite(testCases);

    // Generate report
    const report = testAdapter.generateReport(results);

    // Get AJV metrics
    const metrics = testAdapter.getAjvMetrics();

    // Print summary
    console.log('\n=== Test Suite Results ===');
    console.log(`Total: ${report.summary.total}`);
    console.log(`Passed: ${report.summary.passed}`);
    console.log(`Failed: ${report.summary.failed}`);
    console.log(`Pass Rate: ${report.summary.passRate.toFixed(2)}%`);

    console.log('\n=== Performance Summary ===');
    console.log(`Average Performance Improvement: ${report.performance.averageImprovement.toFixed(2)}%`);
    console.log(`Fastest Test: ${report.performance.fastest}`);
    console.log(`Slowest Test: ${report.performance.slowest}`);

    if (report.commonDifferences.length > 0) {
      console.log('\n=== Common Differences ===');
      report.commonDifferences.slice(0, 5).forEach(diff => {
        console.log(`${diff.path}: ${diff.frequency} occurrences`);
        diff.examples.forEach((example, i) => {
          console.log(`  Example ${i + 1}:`);
          console.log(`    Original: ${JSON.stringify(example.original)}`);
          console.log(`    AJV: ${JSON.stringify(example.ajv)}`);
        });
      });
    }

    // Print failed tests
    const failedTests = results.filter(r => !r.passed);
    if (failedTests.length > 0) {
      console.log('\n=== Failed Tests ===');
      failedTests.forEach(test => {
        console.log(`❌ ${test.testName}`);
        test.errors.forEach(error => {
          console.log(`   Error: ${error}`);
        });
        test.differences.forEach(diff => {
          console.log(`   ${diff.path}: ${diff.type}`);
        });
      });
    }

    return {
      report,
      results,
      metrics
    };

  } finally {
    // Cleanup
    await testAdapter.cleanup();
  }
}

/**
 * Run quick smoke test
 */
export async function runSmokeTest(originalAdapter: any): Promise<boolean> {
  const testAdapter = new LLMSwitchTestAdapter();
  testAdapter.setOriginalAdapter(originalAdapter);

  try {
    await testAdapter.initialize();

    // Run a few basic test cases
    const smokeTestCases = testCases.slice(0, 3); // First 3 test cases
    const results = await testAdapter.runTestSuite(smokeTestCases);

    const passed = results.every(r => r.passed);
    console.log(`Smoke test ${passed ? 'PASSED' : 'FAILED'}: ${results.filter(r => r.passed).length}/${results.length} tests passed`);

    return passed;

  } catch (error) {
    console.error('Smoke test failed with error:', error);
    return false;

  } finally {
    await testAdapter.cleanup();
  }
}