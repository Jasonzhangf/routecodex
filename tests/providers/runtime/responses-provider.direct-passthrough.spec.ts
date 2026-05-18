import { describe, expect, jest, test } from '@jest/globals';

jest.mock('../../../src/modules/llmswitch/bridge.js', () => ({
  getStatsCenterSafe: () => ({ recordProviderUsage: () => {} }),
  createResponsesSseToJsonConverter: async () => ({
    convertSseToJson: async () => ({ status: 'completed', output: [] })
  })
}), { virtual: true });

jest.mock('../../../src/modules/llmswitch/bridge/state-integrations.js', () => ({
  getStatsCenterSafe: () => ({ recordProviderUsage: () => {} })
}), { virtual: true });

import type { OpenAIStandardConfig } from '../../../src/providers/core/api/provider-config.js';
import type { ModuleDependencies } from '../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';
import { ResponsesProvider } from '../../../src/providers/core/runtime/responses-provider.js';

const emptyDeps: ModuleDependencies = {
  logger: {
    logModule: () => {},
    logProviderRequest: () => {}
  } as any
} as ModuleDependencies;

describe('ResponsesProvider direct passthrough', () => {
  test('preserves inbound responses payload without rebuilding input/history/model', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'test',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid/v1', endpoint: '/responses' }
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new ResponsesProvider(config, emptyDeps) as any;
    provider.isInitialized = true;
    provider.snapshotPhase = async () => {};
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;

    let capturedBody: any;
    let capturedHeaders: Record<string, string> | undefined;
    provider.httpClient = {
      postStream: async (_url: string, body: any, headers: Record<string, string>) => {
        capturedBody = body;
        capturedHeaders = headers;
        throw new Error('STOP_AFTER_CAPTURE');
      }
    };

    const inbound = {
      model: 'gpt-5.4',
      previous_response_id: 'resp_prev_turn',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello direct' }] }],
      tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } }],
      tool_choice: 'auto',
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'high' },
      store: false,
      stream: true,
      prompt_cache_key: 'cache-key-1',
      instructions: 'keep-original-instructions',
      metadata: { entryEndpoint: '/v1/responses' }
    } as any;

    inbound.metadata.__responsesDirectPassthrough = true;
    await expect(provider.sendRequestInternal(inbound)).rejects.toThrow('STOP_AFTER_CAPTURE');
    expect(capturedHeaders?.Accept).toBe('text/event-stream');
    expect(capturedBody.model).toBe('gpt-5.4');
    expect(capturedBody.previous_response_id).toBe('resp_prev_turn');
    expect(capturedBody.input).toEqual(inbound.input);
    expect(capturedBody.prompt_cache_key).toBe('cache-key-1');
    expect(capturedBody.tools).toEqual(inbound.tools);
    expect(capturedBody.tool_choice).toBe('auto');
    expect(capturedBody.instructions).toBe('keep-original-instructions');
    expect(capturedBody.metadata).toBeUndefined();
  });
});
