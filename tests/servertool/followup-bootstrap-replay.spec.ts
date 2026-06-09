import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-followup-mainline-semantics.js',
  () => ({
    buildFollowupRequestIdWithNative: jest.fn((base: string, suffix?: string | null) => `native:${base}${suffix ?? ''}`)
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/runtime-metadata.js',
  () => ({
    readRuntimeMetadata: jest.fn((carrier?: Record<string, unknown> | null) => {
      const candidate = carrier?.__rt;
      return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
        ? (candidate as Record<string, unknown>)
        : undefined;
    }),
    ensureRuntimeMetadata: jest.fn((carrier: Record<string, unknown>) => {
      const candidate = carrier.__rt;
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        carrier.__rt = {};
      }
      return carrier.__rt as Record<string, unknown>;
    }),
    cloneRuntimeMetadata: jest.fn((carrier?: Record<string, unknown> | null) => {
      const candidate = carrier?.__rt;
      return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
        ? { ...(candidate as Record<string, unknown>) }
        : undefined;
    })
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    planFollowupExecutionModeWithNative: jest.fn(() => ({
      executionMode: 'reenter'
    })),
    planFollowupMaterializationWithNative: jest.fn(() => ({
      entryEndpoint: '/v1/responses',
      payloadSource: 'none'
    })),
    planFollowupRuntimeActionWithNative: jest.fn(() => ({
      loopPayloadSource: 'none',
      autoLimit: { exceeded: false },
      clientInjectMetadata: { force: false }
    })),
    planFollowupRuntimeMetadataWithNative: jest.fn((input: any) => ({
      rootSet: {},
      rootDelete: [],
      runtimeSet: {
        originalEntryEndpoint: input.originalEntryEndpoint,
        followupEntryEndpoint: input.followupEntryEndpoint,
        ...(input.loopState ? { serverToolLoopState: input.loopState } : {})
      }
    })),
    planBootstrapReplayWithNative: jest.fn((input: any) => {
      const seed = input.replaySeed ?? input.adapterContext?.capturedChatRequest ?? null;
      return {
        preflightFailure: null,
        replayPayload: seed
        ? {
            ...(seed.model ? { model: seed.model } : {}),
            messages: Array.isArray(seed.messages) ? seed.messages : [],
            ...(Array.isArray(seed.tools) ? { tools: seed.tools } : {}),
            ...(seed.parameters ? { parameters: seed.parameters } : {}),
          }
        : null
      };
    }),
  })
);

const { maybeRunTransparentBootstrapReplay } = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/backend-route-bootstrap-replay-block.js'
);

describe('servertool bootstrap replay', () => {
  test('uses native followup request id builder for transparent replay', async () => {
    const reenterPipeline = jest.fn(async (options: any) => ({
      body: {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'replayed'
            }
          }
        ]
      }
    }));
    const applyHubFollowupPolicyShadow = jest.fn((args: any) => args.payload);

    const result = await maybeRunTransparentBootstrapReplay({
      adapterContext: {
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'continue' }]
        },
        routecodexPortMode: 'router',
        routeId: 'coding'
      } as any,
      requestId: 'req-base',
      flowId: 'bootstrap_flow',
      decision: {
        flowId: 'bootstrap_flow',
        outcomeMode: 'reenter',
        noFollowup: false,
        autoLimit: false,
        flowOnlyLoopLimit: false,
        clientInjectOnly: false,
        clearStateOnFollowupFailure: false,
        seedLoopPayload: false,
        transparentReplayRequestSuffix: ':replay',
        ignoreRequiresActionFollowup: false
      },
      entryEndpoint: '/v1/responses',
      followupEntryEndpoint: '/v1/responses',
      followupTimeoutMs: 1000,
      followupBody: {},
      finalChatResponse: { choices: [{ message: { role: 'assistant', content: 'original' } }] },
      execution: { flowId: 'bootstrap_flow' },
      reenterPipeline,
      coerceFollowupPayloadStream: (payload: any, stream: boolean) => ({ ...payload, stream }),
      applyHubFollowupPolicyShadow,
      buildServerToolLoopState: () => null,
      withTimeout: async (promise: Promise<unknown>) => promise,
      createServerToolTimeoutError: () => new Error('timeout'),
      choosePreferredFinalChatResponse: ({ followupBody, finalChatResponse }: any) => followupBody ?? finalChatResponse,
      decorateFinalChatWithServerToolContext: (chat: any) => chat,
      compactFollowupErrorReason: (value: unknown) => (typeof value === 'string' ? value : undefined),
      onLogProgress: jest.fn()
    });

    expect(result).toMatchObject({ executed: true, flowId: 'bootstrap_flow' });
    expect(applyHubFollowupPolicyShadow).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'native:req-base:replay'
      })
    );
    expect(reenterPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'native:req-base:replay',
        entryEndpoint: '/v1/responses'
      })
    );
  });
});
