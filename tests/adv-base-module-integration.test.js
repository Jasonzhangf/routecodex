import { describe, test, expect, beforeEach } from '@jest/globals';
import { AdvBaseModule } from '../sharedmodule/rcc-basemodule-adv/adv-base-module.js';

// Mock LLM Switch module for integration testing
class MockLLMSwitch extends AdvBaseModule {
  constructor() {
    super();
    this.id = 'llm-switch';
    this.type = 'llm-switch';
  }

  getModuleId() {
    return this.id;
  }

  getModuleType() {
    return this.type;
  }

  async processIncoming(request) {
    return this.runWithDryRun(
      { opName: 'processIncoming', phase: 'request', direction: 'incoming' },
      request,
      async () => {
        return {
          ...request,
          _metadata: {
            switchType: 'openai-passthrough',
            timestamp: Date.now(),
            routing: 'thinking'
          }
        };
      },
      { nodeId: this.id, nodeType: this.type }
    );
  }

  async processOutgoing(response) {
    return this.runWithDryRun(
      { opName: 'processOutgoing', phase: 'response', direction: 'outgoing' },
      response,
      async () => {
        return response;
      },
      { nodeId: this.id, nodeType: this.type }
    );
  }
}

// Mock Compatibility module
class MockCompatibility extends AdvBaseModule {
  constructor() {
    super();
    this.id = 'compatibility';
    this.type = 'compatibility';
  }

  getModuleId() {
    return this.id;
  }

  getModuleType() {
    return this.type;
  }

  async processIncoming(request) {
    return this.runWithDryRun(
      { opName: 'transformRequest', phase: 'request', direction: 'incoming' },
      request,
      async () => {
        return {
          ...request,
          _transformed: true,
          _metadata: {
            ...request._metadata,
            compatibility: 'mock',
            timestamp: Date.now()
          }
        };
      },
      { nodeId: this.id, nodeType: this.type }
    );
  }

  async processOutgoing(response) {
    return this.runWithDryRun(
      { opName: 'transformResponse', phase: 'response', direction: 'outgoing' },
      response,
      async () => {
        return response;
      },
      { nodeId: this.id, nodeType: this.type }
    );
  }
}

// Mock Provider module
class MockProvider extends AdvBaseModule {
  constructor() {
    super();
    this.id = 'provider';
    this.type = 'provider';
  }

  getModuleId() {
    return this.id;
  }

  getModuleType() {
    return this.type;
  }

  async processIncoming(request) {
    return this.runWithDryRun(
      { opName: 'sendRequest', phase: 'request', direction: 'outgoing' },
      request,
      async () => {
        // Simulate HTTP request to AI provider
        return {
          id: 'mock-response',
          object: 'chat.completion',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: 'Hello from mock provider'
            },
            finish_reason: 'stop'
          }],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 5,
            total_tokens: 10
          }
        };
      },
      { nodeId: this.id, nodeType: this.type }
    );
  }

  async processOutgoing(response) {
    return this.runWithDryRun(
      { opName: 'processResponse', phase: 'response', direction: 'incoming' },
      response,
      async () => {
        return response;
      },
      { nodeId: this.id, nodeType: this.type }
    );
  }
}

describe('AdvBaseModule Integration Tests', () => {
  let llmSwitch, compatibility, provider;

  beforeEach(() => {
    llmSwitch = new MockLLMSwitch();
    compatibility = new MockCompatibility();
    provider = new MockProvider();
  });

  describe('Pipeline Dry-Run Flow', () => {
    test('should execute full pipeline with dry-run disabled', async () => {
      // Disable dry-run for all modules
      [llmSwitch, compatibility, provider].forEach(module => {
        module.setDryRunMode(false);
      });

      const request = {
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }]
      };

      // Execute pipeline
      const result1 = await llmSwitch.processIncoming(request);
      const result2 = await compatibility.processIncoming(result1);
      const result3 = await provider.processIncoming(result2);

      // Verify results
      expect(result1).toHaveProperty('_metadata.switchType', 'openai-passthrough');
      expect(result2).toHaveProperty('_transformed', true);
      expect(result3).toHaveProperty('id', 'mock-response');
      expect(result3).toHaveProperty('choices');
    });

    test('should execute pipeline with dry-run enabled (continue mode)', async () => {
      // Enable dry-run for all modules with continue behavior
      [llmSwitch, compatibility, provider].forEach(module => {
        module.setDryRunMode(true);
        module.setNodeDryRunConfig(module.id, {
          enabled: true,
          mode: 'full-analysis',
          breakpointBehavior: 'continue',
          verbosity: 'normal'
        });
      });

      const request = {
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }]
      };

      // Execute pipeline
      const result1 = await llmSwitch.processIncoming(request);
      const result2 = await compatibility.processIncoming(result1);
      const result3 = await provider.processIncoming(result2);

      // With continue behavior, should execute real operations
      expect(result1).toHaveProperty('_metadata.switchType', 'openai-passthrough');
      expect(result2).toHaveProperty('_transformed', true);
      expect(result3).toHaveProperty('id', 'mock-response');
    });

    test('should execute pipeline with dry-run (no-propagation mode)', async () => {
      // Enable dry-run with no-propagation behavior
      [llmSwitch, compatibility, provider].forEach(module => {
        module.setDryRunMode(true);
        module.setNodeDryRunConfig(module.id, {
          enabled: true,
          mode: 'full-analysis',
          breakpointBehavior: 'no-propagation',
          verbosity: 'normal'
        });
      });

      const request = {
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }]
      };

      // Execute pipeline
      const result1 = await llmSwitch.processIncoming(request);
      const result2 = await compatibility.processIncoming(result1);
      const result3 = await provider.processIncoming(result2);

      // With no-propagation, should return dry-run results
      expect(result1).toHaveProperty('status');
      expect(result1).toHaveProperty('inputData');
      expect(result1).toHaveProperty('expectedOutput');
      
      expect(result2).toHaveProperty('status');
      expect(result2).toHaveProperty('inputData');
      expect(result2).toHaveProperty('expectedOutput');
      
      expect(result3).toHaveProperty('status');
      expect(result3).toHaveProperty('inputData');
      expect(result3).toHaveProperty('expectedOutput');
    });

    test('should collect performance metrics across pipeline', async () => {
      // Enable dry-run with performance estimation
      [llmSwitch, compatibility, provider].forEach(module => {
        module.setDryRunMode(true);
        module.setNodeDryRunConfig(module.id, {
          enabled: true,
          mode: 'full-analysis',
          breakpointBehavior: 'no-propagation',
          verbosity: 'normal'
        });
      });

      const request = {
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }]
      };

      // Execute pipeline
      const result1 = await llmSwitch.processIncoming(request);
      const result2 = await compatibility.processIncoming(result1);
      const result3 = await provider.processIncoming(result2);

      // Verify performance metrics
      expect(result1.performanceMetrics).toBeDefined();
      expect(result1.performanceMetrics).toHaveProperty('estimatedTime');
      expect(result1.performanceMetrics).toHaveProperty('estimatedMemory');
      expect(result1.performanceMetrics).toHaveProperty('complexity');

      expect(result2.performanceMetrics).toBeDefined();
      expect(result3.performanceMetrics).toBeDefined();
    });
  });

  describe('Mixed Dry-Run Modes', () => {
    test('should handle different dry-run modes per module', async () => {
      // Configure different modes for each module
      llmSwitch.setDryRunMode(true);
      llmSwitch.setNodeDryRunConfig('llm-switch', {
        enabled: true,
        mode: 'output-validation',
        breakpointBehavior: 'continue',
        verbosity: 'normal'
      });

      compatibility.setDryRunMode(true);
      compatibility.setNodeDryRunConfig('compatibility', {
        enabled: true,
        mode: 'full-analysis',
        breakpointBehavior: 'no-propagation',
        verbosity: 'normal'
      });

      provider.setDryRunMode(true);
      provider.setNodeDryRunConfig('provider', {
        enabled: true,
        mode: 'error-simulation',
        breakpointBehavior: 'terminate',
        verbosity: 'normal',
        errorSimulation: {
          enabled: false, // Disable error simulation for this test
          probability: 0
        }
      });

      const request = {
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }]
      };

      // Execute pipeline
      const result1 = await llmSwitch.processIncoming(request);
      const result2 = await compatibility.processIncoming(result1);
      
      // LLM Switch should continue (real operation)
      expect(result1).toHaveProperty('_metadata.switchType', 'openai-passthrough');
      
      // Compatibility should return dry-run result
      expect(result2).toHaveProperty('status');
      expect(result2).toHaveProperty('inputData');
      expect(result2).toHaveProperty('expectedOutput');
    });
  });

  describe('Error Handling in Pipeline', () => {
    test('should handle errors in dry-run mode', async () => {
      // Enable error simulation for provider
      provider.setDryRunMode(true);
      provider.setNodeDryRunConfig('provider', {
        enabled: true,
        mode: 'error-simulation',
        breakpointBehavior: 'no-propagation',
        verbosity: 'normal',
        errorSimulation: {
          enabled: true,
          probability: 1.0 // Force error
        }
      });

      // Other modules in normal dry-run mode
      llmSwitch.setDryRunMode(true);
      llmSwitch.setNodeDryRunConfig('llm-switch', {
        enabled: true,
        mode: 'full-analysis',
        breakpointBehavior: 'no-propagation',
        verbosity: 'normal'
      });

      compatibility.setDryRunMode(true);
      compatibility.setNodeDryRunConfig('compatibility', {
        enabled: true,
        mode: 'full-analysis',
        breakpointBehavior: 'no-propagation',
        verbosity: 'normal'
      });

      const request = {
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }]
      };

      // Execute pipeline
      const result1 = await llmSwitch.processIncoming(request);
      const result2 = await compatibility.processIncoming(result1);
      const result3 = await provider.processIncoming(result2);

      // Provider should return simulated error
      expect(result3.status).toBe('simulated-error');
      expect(result3).toHaveProperty('error');
    });
  });
});