import { describe, it, expect } from '@jest/globals';

import { UnifiedLLMSwitch } from '../../src/modules/pipeline/modules/llmswitch/llmswitch-unified.js';

// Minimal dependencies mock
const deps = {
  errorHandlingCenter: { handleError: async () => {}, createContext: () => ({}), getStatistics: () => ({}) },
  debugCenter: { processDebugEvent: () => {}, logDebug: () => {}, logError: () => {}, logModule: () => {}, getLogs: () => [] },
  logger: {
    logModule: () => {}, logError: () => {}, logDebug: () => {}, logPipeline: () => {}, logRequest: () => {}, logResponse: () => {},
    logTransformation: () => {}, logProviderRequest: () => {}, getRequestLogs: () => ({ general: [], transformations: [], provider: [] }),
    getPipelineLogs: () => ({ general: [], transformations: [], provider: [] }), getRecentLogs: () => [], getTransformationLogs: () => [], getProviderLogs: () => [],
    getStatistics: () => ({ totalLogs: 0, logsByLevel: {}, logsByCategory: {}, logsByPipeline: {}, transformationCount: 0, providerRequestCount: 0 }),
    clearLogs: () => {}, exportLogs: () => ({}), log: () => {}
  }
} as any;

describe('UnifiedLLMSwitch endpoint-based protocol switching', () => {
  it('converts Anthropic-style request (v1/messages) tools to OpenAI tools', async () => {
    const llm = new UnifiedLLMSwitch({ type: 'llmswitch-unified', config: {} } as any, deps);
    await llm.initialize();

    const anthropicReq = {
      system: 'You are helpful',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'use tool please' }] }
      ],
      tools: [ { name: 'search', description: 'web', input_schema: { type: 'object', properties: { q: { type: 'string' } } } } ],
      max_tokens: 256,
      _metadata: { endpoint: '/v1/messages' }
    };

    const converted = await llm.transformRequest(anthropicReq) as any;
    expect(Array.isArray(converted.tools)).toBe(true);
    expect(converted.tools[0].type).toBe('function');
    expect(converted.tools[0].function.name).toBe('search');
    expect(converted.messages?.[0]?.role).toBe('system');
    expect(converted.max_tokens).toBe(256);
  });

  it('converts OpenAI tool_calls to Anthropic tool_use for v1/messages response', async () => {
    const llm = new UnifiedLLMSwitch({ type: 'llmswitch-unified', config: {} } as any, deps);
    await llm.initialize();

    const openaiResp = {
      id: 'resp_1',
      model: 'gpt-test',
      choices: [ {
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [ { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"abc"}' } } ]
        },
        finish_reason: 'tool_calls'
      } ],
      _metadata: { endpoint: '/v1/messages' }
    };

    const converted = await llm.transformResponse(openaiResp) as any;
    expect(Array.isArray(converted.content)).toBe(true);
    const hasToolUse = converted.content.some((b: any) => b && b.type === 'tool_use');
    expect(hasToolUse).toBe(true);
    expect(converted.stop_reason).toBe('tool_use');
  });
});

