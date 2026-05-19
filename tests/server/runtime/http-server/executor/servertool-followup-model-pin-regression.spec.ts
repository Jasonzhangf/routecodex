import { describe, expect, jest, test } from '@jest/globals';

describe('servertool followup model pin regression', () => {
  test('forced MiniMax followup must preserve model id and never degrade to minimax alias', async () => {
    const executeNested = jest.fn(async (input: any) => ({
      status: 200,
      body: { ok: true, seenBody: input.body, seenMetadata: input.metadata }
    }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    await executeServerToolReenterPipeline({
      entryEndpoint: '/v1/responses',
      fallbackEntryEndpoint: '/v1/responses',
      requestId: 'req_followup_model_pin_minimax_case',
      body: {
        model: 'MiniMax-M2.7',
        input: [{ role: 'user', content: [{ type: 'input_text', text: '继续执行' }] }]
      },
      metadata: {
        __shadowCompareForcedProviderKey: 'mini27.key1.MiniMax-M2.7',
        providerKey: 'mini27.key1.MiniMax-M2.7',
        targetProviderKey: 'mini27.key1.MiniMax-M2.7',
        modelId: 'MiniMax-M2.7',
        assignedModelId: 'MiniMax-M2.7',
        routeHint: 'search',
        routeName: 'search',
        routecodexPortMode: 'router',
        __rt: {
          serverToolFollowup: true
        }
      },
      executeNested
    });

    const nestedInput = executeNested.mock.calls[0]?.[0] as Record<string, any>;
    expect(nestedInput?.metadata?.__shadowCompareForcedProviderKey).toBe('mini27.key1.MiniMax-M2.7');
    expect(nestedInput?.metadata?.providerKey).toBe('mini27.key1.MiniMax-M2.7');
    expect(nestedInput?.metadata?.targetProviderKey).toBe('mini27.key1.MiniMax-M2.7');
    expect(nestedInput?.body?.model).toBe('MiniMax-M2.7');
    expect(String(nestedInput?.body?.model ?? '').toLowerCase()).not.toBe('minimax');
  });
});
