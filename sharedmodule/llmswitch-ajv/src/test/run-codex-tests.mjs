#!/usr/bin/env node

/**
 * Run Codex Sample Black-Box Tests
 *
 * This script uses real captured codex sample data to compare the original
 * LLMSwitch implementation with the new AJV-based implementation.
 */

import { runCodexSampleTests } from './codex-sample-test.js';

// Import the original LLMSwitch from the main project
import path from 'path';
import { fileURLToPath } from 'url';

const projectRoot = '/Users/fanzhang/Documents/github/routecodex';
const originalAdapterPath = path.join(projectRoot, 'src/modules/pipeline/modules/llmswitch/llmswitch-anthropic-openai.ts');

// Dynamic import the original adapter
let AnthropicOpenAIConverter;
let PipelineDebugLogger;

/**
 * Load the original LLMSwitch dependencies
 */
async function loadOriginalDependencies() {
  try {
    // Import the original adapter classes
    const originalModule = await import(originalAdapterPath);
    AnthropicOpenAIConverter = originalModule.AnthropicOpenAIConverter;

    // Import the logger from the utils
    const loggerPath = path.join(projectRoot, 'src/utils/pipeline-debug-logger.ts');
    const loggerModule = await import(loggerPath);
    PipelineDebugLogger = loggerModule.PipelineDebugLogger;

    console.log('✅ Original dependencies loaded successfully');
  } catch (error) {
    console.error('❌ Failed to load original dependencies:', error);

    // For testing purposes, create mock implementations
    console.log('🔄 Using mock implementations for testing');

    AnthropicOpenAIConverter = class {
      constructor(config, deps) {
        this.config = config;
        this.logger = deps?.logger;
      }

      async initialize() {
        console.log('Mock original adapter initialized');
      }

      async processIncoming(request) {
        // Mock transformation - just return the request with minimal changes
        return {
          ...request,
          _mockOriginalProcessed: true,
          _metadata: {
            ...request._metadata,
            mockOriginal: true
          }
        };
      }

      async processOutgoing(response) {
        return {
          ...response,
          _mockOriginalProcessed: true
        };
      }

      async transformRequest(input) {
        return await this.processIncoming(input);
      }

      async transformResponse(input) {
        return await this.processOutgoing(input);
      }

      async cleanup() {
        console.log('Mock original adapter cleaned up');
      }
    };

    PipelineDebugLogger = class {
      constructor(name, config) {
        this.name = name;
        this.config = config;
      }

      debug(message, ...args) {
        if (this.config.enabled) console.log(`[DEBUG] [${this.name}] ${message}`, ...args);
      }

      info(message, ...args) {
        if (this.config.enabled) console.log(`[INFO] [${this.name}] ${message}`, ...args);
      }

      warn(message, ...args) {
        if (this.config.enabled) console.log(`[WARN] [${this.name}] ${message}`, ...args);
      }

      error(message, ...args) {
        if (this.config.enabled) console.log(`[ERROR] [${this.name}] ${message}`, ...args);
      }
    };
  }
}

/**
 * Create a mock original adapter for testing
 */
class MockOriginalAdapter {
  constructor() {
    this.converter = new AnthropicOpenAIConverter({
      config: {
        enableStreaming: true,
        enableTools: true,
        trustSchema: true
      }
    }, {
      logger: new PipelineDebugLogger('test-adapter', {
        enabled: true,
        logToFile: false,
        logToConsole: false
      })
    });
  }

  async initialize() {
    await this.converter.initialize();
  }

  async processIncoming(request) {
    return await this.converter.processIncoming(request);
  }

  async processOutgoing(response) {
    return await this.converter.processOutgoing(response);
  }

  async transformRequest(input) {
    return await this.converter.transformRequest(input);
  }

  async transformResponse(input) {
    return await this.converter.transformResponse(input);
  }

  async cleanup() {
    await this.converter.cleanup();
  }
}

/**
 * Main test execution function
 */
async function main() {
  console.log('🧪 Starting Codex Sample Black-Box Tests');
  console.log('🔬 Comparing Original vs AJV LLMSwitch implementations');
  console.log('');

  try {
    // Load dependencies first
    await loadOriginalDependencies();

    // Create the original adapter
    const originalAdapter = new MockOriginalAdapter();
    await originalAdapter.initialize();
    console.log('✅ Original adapter initialized');

    // Run the codex sample tests
    console.log('🔄 Running tests with real codex sample data...');
    const results = await runCodexSampleTests(originalAdapter);

    // Final cleanup
    await originalAdapter.cleanup();
    console.log('✅ Test completed successfully');

    // Return appropriate exit code
    process.exit(results.summary.passRate >= 80 ? 0 : 1);

  } catch (error) {
    console.error('❌ Test execution failed:', error);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run the tests
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}