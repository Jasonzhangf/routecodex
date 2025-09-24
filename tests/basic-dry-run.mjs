#!/usr/bin/env node
// Basic dry-run test using mock modules only (no network), plain JS.

import { dryRunPipelineExecutor } from '../dist/modules/pipeline/dry-run/dry-run-pipeline-executor.js';
import { pipelineDryRunManager } from '../dist/modules/pipeline/dry-run/pipeline-dry-run-framework.js';

const mockSwitch = {
  id: 'mock-llm-switch',
  type: 'llm-switch',
  config: { type: 'mock', config: {} },
  async initialize() {},
  async processIncoming(request) {
    return {
      ...request,
      _metadata: { switchType: 'openai-passthrough', timestamp: Date.now(), routing: 'default' }
    };
  },
  async executeNodeDryRun(request, context) {
    return {
      nodeId: context.nodeId,
      nodeType: context.nodeType,
      status: 'success',
      inputData: request,
      expectedOutput: {
        ...request,
        _metadata: { switchType: 'openai-passthrough', timestamp: Date.now(), routing: 'default' }
      },
      validationResults: [],
      performanceMetrics: { estimatedTime: 3, estimatedMemory: 50, complexity: 1 },
      executionLog: [{ timestamp: Date.now(), level: 'info', message: 'switch dry-run' }]
    };
  },
  async validateOutput() { return []; },
  async simulateError() { return null; },
  async estimatePerformance() { return { time: 3, memory: 50, complexity: 1 }; },
  async processOutgoing(resp) { return resp; },
  async cleanup() {}
};

const mockCompat = {
  ...mockSwitch,
  id: 'mock-compatibility',
  type: 'compatibility',
  async processIncoming(request) {
    return { ...request, _transformed: true, _metadata: { compatibility: 'mock', timestamp: Date.now() } };
  },
  async executeNodeDryRun(request, context) {
    return {
      nodeId: context.nodeId,
      nodeType: context.nodeType,
      status: 'success',
      inputData: request,
      expectedOutput: { ...request, _transformed: true, _metadata: { compatibility: 'mock', timestamp: Date.now() } },
      validationResults: [],
      performanceMetrics: { estimatedTime: 4, estimatedMemory: 60, complexity: 1 },
      executionLog: [{ timestamp: Date.now(), level: 'info', message: 'compat dry-run' }]
    };
  }
};

const mockProvider = {
  ...mockSwitch,
  id: 'mock-provider',
  type: 'provider',
  async processIncoming(request) {
    return {
      id: 'mock-response',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from provider mock' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      _request: request
    };
  },
  async executeNodeDryRun(request, context) {
    return {
      nodeId: context.nodeId,
      nodeType: context.nodeType,
      status: 'success',
      inputData: request,
      expectedOutput: {
        id: 'mock-response',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from provider mock (dry-run)' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }
      },
      validationResults: [],
      performanceMetrics: { estimatedTime: 6, estimatedMemory: 80, complexity: 1 },
      executionLog: [{ timestamp: Date.now(), level: 'info', message: 'provider dry-run' }]
    };
  }
};

async function main() {
  // Configure nodes as dry-run
  pipelineDryRunManager.clear();
  pipelineDryRunManager.configureNodesDryRun({
    'llm-switch': { enabled: true, mode: 'full-analysis', breakpointBehavior: 'continue', verbosity: 'normal' },
    'compatibility': { enabled: true, mode: 'full-analysis', breakpointBehavior: 'continue', verbosity: 'normal' },
    'provider': { enabled: true, mode: 'full-analysis', breakpointBehavior: 'continue', verbosity: 'normal' }
  });

  dryRunPipelineExecutor.cleanup();
  dryRunPipelineExecutor.registerNodes([
    { id: 'llm-switch', type: 'llm-switch', module: mockSwitch, isDryRun: true, config: pipelineDryRunManager.getNodeConfig('llm-switch') },
    { id: 'compatibility', type: 'compatibility', module: mockCompat, isDryRun: true, config: pipelineDryRunManager.getNodeConfig('compatibility') },
    { id: 'provider', type: 'provider', module: mockProvider, isDryRun: true, config: pipelineDryRunManager.getNodeConfig('provider') }
  ]);
  dryRunPipelineExecutor.setExecutionOrder(['llm-switch', 'compatibility', 'provider']);

  const request = {
    data: { model: 'test-model', messages: [{ role: 'user', content: 'Hi' }] },
    route: { providerId: 'mock', modelId: 'test-model', requestId: `req_${Date.now()}`, timestamp: Date.now() },
    metadata: {},
    debug: { enabled: true, stages: {} }
  };

  const result = await dryRunPipelineExecutor.executePipeline(request, 'basic-dry-run', 'dry-run');
  console.log('\n✓ Basic dry-run completed');
  console.log('Mode:', result.mode);
  console.log('Dry-run nodes:', result.requestSummary.dryRunNodeCount);
  console.log('Breakpoint status:', result.breakpointStatus);
}

main().catch(e => { console.error('Basic dry-run failed:', e?.stack || String(e)); process.exit(1); });

