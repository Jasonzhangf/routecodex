import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-responses-store-release-'));
process.env.ROUTECODEX_RESPONSES_CONVERSATION_STORE = path.join(
  storeDir,
  'responses-conversation-store.json',
);

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/index.js', () => ({
  buildResponsesTerminalSseFramesFromProbeNative: jest.fn(() => []),
  createResponsesJsonToSseConverter: jest.fn(),
  importCoreDist: jest.fn(),
  isToolCallContinuationResponseNative: jest.fn((body: unknown) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return false;
    }
    const record = body as Record<string, unknown>;
    const requiredAction =
      record.required_action && typeof record.required_action === 'object' && !Array.isArray(record.required_action)
        ? record.required_action as Record<string, unknown>
        : undefined;
    const submitToolOutputs =
      requiredAction?.submit_tool_outputs
      && typeof requiredAction.submit_tool_outputs === 'object'
      && !Array.isArray(requiredAction.submit_tool_outputs)
        ? requiredAction.submit_tool_outputs as Record<string, unknown>
        : undefined;
    if (Array.isArray(submitToolOutputs?.tool_calls) && submitToolOutputs.tool_calls.length > 0) {
      return true;
    }
    const output = Array.isArray(record.output) ? record.output : [];
    return output.some((item) => (
      item
      && typeof item === 'object'
      && !Array.isArray(item)
      && (item as Record<string, unknown>).type === 'function_call'
    ));
  }),
  rebindResponsesConversationRequestId: jest.fn(),
  requireCoreDist: jest.fn(),
  updateResponsesContractProbeFromSseChunkNative: jest.fn((_chunk, probe) => probe ?? {}),
}));

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/responses-sse-bridge.js', () => ({
  assertDirectPassthroughResponsesSseFrameForHttp: jest.fn(),
  assertDirectPassthroughResponsesSseMetadataIsolationForHttp: jest.fn(),
  buildClientSseKeepaliveFrameForHttp: jest.fn(() => ': keepalive\n\n'),
  buildResponsesMissingSseBridgeErrorPayloadForHttp: jest.fn(),
  buildResponsesPayloadFromChatForHttp: jest.fn(async (payload: unknown) => payload),
  buildResponsesRequestLogContextForHttp: jest.fn(() => ({})),
  buildResponsesSseErrorPayloadForHttp: jest.fn(),
  buildResponsesStructuredSseErrorPayloadForHttp: jest.fn(),
  createResponsesJsonToSseConverterForHttp: jest.fn(),
  importResponsesHandlerCoreDist: jest.fn(async () => ({})),
  isDirectPassthroughTransportKeepaliveFrameForHttp: jest.fn(() => false),
  normalizeClientVisibleResponsesSseFrameForHttp: jest.fn((frame: unknown) => frame),
  normalizeChatUsagePayloadForHttp: jest.fn((payload: unknown) => payload),
  normalizeResponsesSseFrameForClientForHttp: jest.fn((frame: unknown) => frame),
  prepareResponsesJsonBodyForSseBridgeForHttp: jest.fn((payload: unknown) => payload),
  prepareResponsesJsonClientDispatchPlanForHttp: jest.fn(),
  prepareResponsesJsonSseDispatchPlanForHttp: jest.fn(),
  projectResponsesSseFrameForClientForHttp: jest.fn(async (frame: unknown) => frame),
  requireResponsesHandlerCoreDist: jest.fn(),
  resolveRelayResponsesClientSseStreamForHttp: jest.fn(),
  resolveResponsesClientPayloadFinishReasonForHttp: jest.fn(),
  resolveResponsesProviderProtocolHintFromSseFrameForHttp: jest.fn(),
  resolveResponsesRequestContextForHttp: jest.fn(),
  shouldDispatchResponsesSseToClientForHttp: jest.fn(() => false),
  shouldDropClientSseFrameForHttp: jest.fn(() => false),
  shouldReprojectRelayResponsesSseForHttp: jest.fn(() => false),
  summarizeResponsesSseFrameForLogForHttp: jest.fn(() => ({})),
}));

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/runtime-integrations.js', async () => {
  const store = await import(
    '../../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js'
  );
  return {
    captureResponsesRequestContextForRequest: jest.fn(async (args: {
      requestId: string;
      payload: Record<string, unknown>;
      context: Record<string, unknown>;
      sessionId?: string;
      conversationId?: string;
      providerKey?: string;
      entryKind?: 'responses' | 'chat' | 'messages';
      routeHint?: string;
      matchedPort?: number;
      routingPolicyGroup?: string;
    }) => {
      store.captureResponsesRequestContext(args);
    }),
    clearResponsesConversationByRequestId: jest.fn(async (requestId?: string) => {
      store.clearResponsesConversationByRequestId(requestId);
    }),
    clearAllResponsesConversationState: jest.fn(async () => {
      store.clearAllResponsesConversationState();
    }),
    clearUnresolvedResponsesConversationRequests: jest.fn(async () => {
      return store.clearUnresolvedResponsesConversationRequests();
    }),
    createResponsesJsonToSseConverter: jest.fn(),
    createResponsesSseToJsonConverter: jest.fn(),
    finalizeResponsesConversationRequestRetention: jest.fn(async (
      requestId?: string,
      options?: { keepForSubmitToolOutputs?: boolean },
    ) => {
      store.finalizeResponsesConversationRequestRetention(requestId, options);
    }),
    lookupResponsesContinuationByResponseId: jest.fn(async (
      responseId: string,
      options?: {
        entryKind?: 'responses' | 'chat' | 'messages';
        continuationOwner?: 'direct' | 'relay';
        matchedPort?: number;
        routingPolicyGroup?: string;
      },
    ) => {
      return store.lookupResponsesContinuationByResponseId(responseId, options);
    }),
    materializeLatestResponsesContinuationByScope: jest.fn(),
    preloadCriticalBridgeRuntimeModules: jest.fn(async () => ({})),
    recordResponsesResponseForRequest: jest.fn(async (args: {
      requestId: string;
      response: Record<string, unknown>;
      sessionId?: string;
      conversationId?: string;
      providerKey?: string;
      continuationOwner?: 'direct' | 'relay';
      matchedPort?: number;
      routingPolicyGroup?: string;
      allowScopeContinuation?: boolean;
      entryKind?: 'responses' | 'chat' | 'messages';
      routeHint?: string;
    }) => {
      store.recordResponsesResponse(args);
    }),
    rebindResponsesConversationRequestId: jest.fn(async (oldId?: string, newId?: string) => {
      store.rebindResponsesConversationRequestId(oldId, newId);
    }),
    reportProviderErrorToRouterPolicy: jest.fn(),
    reportProviderSuccessToRouterPolicy: jest.fn(),
    resetResponsesConversationStateForRestartSimulation: jest.fn(async () => {
      store.resetResponsesConversationStateForRestartSimulation();
    }),
    resumeLatestResponsesContinuationByScope: jest.fn(),
    resumeResponsesConversation: jest.fn(),
    writeSnapshotViaHooks: jest.fn(),
  };
});

let persistResponsesConversationLifecycleForHttp: typeof import('../../../../src/modules/llmswitch/bridge/responses-response-bridge.js').persistResponsesConversationLifecycleForHttp;
let clearAllResponsesConversationState: typeof import('../../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js').clearAllResponsesConversationState;
let captureResponsesRequestContext: typeof import('../../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js').captureResponsesRequestContext;
let lookupResponsesContinuationByResponseId: typeof import('../../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js').lookupResponsesContinuationByResponseId;
let responsesConversationStore: typeof import('../../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js').responsesConversationStore;
let resumeResponsesConversation: typeof import('../../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js').resumeResponsesConversation;

beforeAll(async () => {
  ({ persistResponsesConversationLifecycleForHttp } = await import(
    '../../../../src/modules/llmswitch/bridge/responses-response-bridge.ts'
  ));
  ({
    clearAllResponsesConversationState,
    captureResponsesRequestContext,
    lookupResponsesContinuationByResponseId,
    responsesConversationStore,
    resumeResponsesConversation,
  } = await import(
    '../../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js'
  ));
});

beforeEach(() => {
  clearAllResponsesConversationState();
});

afterAll(() => {
  if (typeof clearAllResponsesConversationState === 'function') {
    clearAllResponsesConversationState();
  }
  delete process.env.ROUTECODEX_RESPONSES_CONVERSATION_STORE;
  fs.rmSync(storeDir, { recursive: true, force: true });
});

describe('responses-response-bridge store release closeout', () => {
  it('keeps canonical response-id continuation truth and clears stale router/provider request ids', async () => {
    const sessionId = 'sess-store-release-closeout';
    const routerRequestId = 'openai-responses-router-store-release-closeout';
    const providerRequestId = 'openai-responses-provider-store-release-closeout';
    const responseId = 'resp_store_release_closeout_1';

    captureResponsesRequestContext({
      requestId: providerRequestId,
      sessionId,
      payload: {
        model: 'gpt-5.4',
        store: true,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'run pwd' }],
          },
        ],
        tools: [{ type: 'function', name: 'exec_command' }],
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'run pwd' }],
          },
        ],
        toolsRaw: [{ type: 'function', name: 'exec_command' }],
      },
      routeHint: 'thinking',
    });

    const before = responsesConversationStore.getDebugStats();
    expect(before.requestMapSize).toBe(1);
    expect(before.requestEntriesWithoutLastResponseId).toBe(1);
    expect(before.retainedInputItems).toBeGreaterThan(0);

    const result = await persistResponsesConversationLifecycleForHttp({
      entryEndpoint: '/v1/responses',
      requestLabel: routerRequestId,
      usageLogInfo: {
        finishReason: 'tool_calls',
        routeName: 'thinking',
        timingRequestIds: [providerRequestId],
        sessionId,
      } as any,
      requestContext: {
        payload: {
          model: 'gpt-5.4',
          store: true,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'run pwd' }],
            },
          ],
          tools: [{ type: 'function', name: 'exec_command' }],
        },
        context: {
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'run pwd' }],
            },
          ],
          toolsRaw: [{ type: 'function', name: 'exec_command' }],
        },
        sessionId,
      } as any,
      body: {
        id: responseId,
        object: 'response',
        status: 'requires_action',
        output: [
          {
            type: 'function_call',
            call_id: 'call_store_release_closeout_1',
            name: 'exec_command',
            arguments: '{"cmd":"pwd"}',
          },
        ],
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [
              {
                id: 'call_store_release_closeout_1',
                type: 'function',
                name: 'exec_command',
                arguments: '{"cmd":"pwd"}',
                tool_call_id: 'call_store_release_closeout_1',
              },
            ],
          },
        },
      },
    });

    expect(result).toEqual({
      recorded: true,
      responseId,
    });

    const continuation = lookupResponsesContinuationByResponseId(responseId, {
      entryKind: 'responses',
    });
    expect(continuation).toEqual(
      expect.objectContaining({
        responseId,
        requestId: responseId,
        continuationOwner: 'relay',
        entryKind: 'responses',
      }),
    );

    const after = responsesConversationStore.getDebugStats();
    expect(after.requestMapSize).toBe(1);
    expect(after.responseIndexSize).toBe(1);
    expect(after.scopeIndexSize).toBe(1);
    expect(after.requestEntriesWithoutLastResponseId).toBe(0);
    expect(after.retainedInputItems).toBe(0);

    const resumed = resumeResponsesConversation(responseId, {
      response_id: responseId,
      tool_outputs: [
        {
          call_id: 'call_store_release_closeout_1',
          output: '{"ok":true,"pwd":"/tmp"}',
        },
      ],
    }, {
      requestId: 'req_store_release_closeout_resume_1',
      continuationOwner: 'relay',
    });

    expect(resumed.payload).toEqual(expect.objectContaining({
      previous_response_id: responseId,
    }));
    expect(resumed.payload.input).toEqual([
      expect.objectContaining({
        type: 'message',
        role: 'user',
      }),
      expect.objectContaining({
        type: 'function_call',
        call_id: 'call_store_release_closeout_1',
        name: 'exec_command',
      }),
      expect.objectContaining({
        type: 'function_call_output',
        call_id: 'call_store_release_closeout_1',
        output: '{"ok":true,"pwd":"/tmp"}',
      }),
    ]);
    expect(resumed.meta).toEqual(expect.objectContaining({
      restoredFromResponseId: responseId,
      previousRequestId: responseId,
      requestId: 'req_store_release_closeout_resume_1',
      restoredTools: [
        { type: 'function', name: 'exec_command' },
      ],
    }));
  });

  it('persists stopless exec_command truth through canonical save/release without leaking internal reasoningStop tool names', async () => {
    const sessionId = 'sess-store-release-stopless';
    const providerRequestId = 'openai-responses-provider-store-release-stopless';
    const responseId = 'resp_store_release_stopless_1';

    captureResponsesRequestContext({
      requestId: providerRequestId,
      sessionId,
      payload: {
        model: 'gpt-5.5',
        store: true,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '继续执行 stopless' }],
          },
        ],
        tools: [{ type: 'function', name: 'exec_command' }],
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '继续执行 stopless' }],
          },
        ],
        toolsRaw: [{ type: 'function', name: 'exec_command' }],
      },
      routeHint: 'thinking',
    });

    const result = await persistResponsesConversationLifecycleForHttp({
      entryEndpoint: '/v1/responses',
      requestLabel: 'openai-responses-router-store-release-stopless',
      usageLogInfo: {
        finishReason: 'tool_calls',
        routeName: 'thinking',
        timingRequestIds: [providerRequestId],
        sessionId,
      } as any,
      requestContext: {
        payload: {
          model: 'gpt-5.5',
          store: true,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: '继续执行 stopless' }],
            },
          ],
          tools: [{ type: 'function', name: 'exec_command' }],
        },
        context: {
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: '继续执行 stopless' }],
            },
          ],
          toolsRaw: [{ type: 'function', name: 'exec_command' }],
        },
        sessionId,
      } as any,
      body: {
        id: responseId,
        object: 'response',
        status: 'requires_action',
        output: [
          {
            type: 'function_call',
            call_id: 'call_store_release_stopless_1',
            name: 'exec_command',
            arguments: '{"cmd":"routecodex hook run reasoningStop --input-json \\"{\\\\\\"flowId\\\\\\":\\\\\\"stop_message_flow\\\\\\",\\\\\\"repeatCount\\\\\\":1,\\\\\\"maxRepeats\\\\\\":3,\\\\\\"triggerHint\\\\\\":\\\\\\"no_schema\\\\\\"}\\" --session-id \\"sess-store-release-stopless\\" --request-id \\"req-store-release-stopless\\""}',
          },
        ],
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [
              {
                id: 'call_store_release_stopless_1',
                type: 'function',
                name: 'exec_command',
                arguments: '{"cmd":"routecodex hook run reasoningStop --input-json \\"{\\\\\\"flowId\\\\\\":\\\\\\"stop_message_flow\\\\\\",\\\\\\"repeatCount\\\\\\":1,\\\\\\"maxRepeats\\\\\\":3,\\\\\\"triggerHint\\\\\\":\\\\\\"no_schema\\\\\\"}\\" --session-id \\"sess-store-release-stopless\\" --request-id \\"req-store-release-stopless\\""}',
                tool_call_id: 'call_store_release_stopless_1',
              },
            ],
          },
        },
      },
    });

    expect(result).toEqual({
      recorded: true,
      responseId,
    });

    const resumed = resumeResponsesConversation(responseId, {
      response_id: responseId,
      tool_outputs: [
        {
          call_id: 'call_store_release_stopless_1',
          output: '{"ok":true,"toolName":"stop_message_auto","repeatCount":2,"maxRepeats":3,"routeHint":"thinking"}',
        },
      ],
    }, {
      requestId: 'req_store_release_stopless_resume_1',
      continuationOwner: 'relay',
    });

    expect(resumed.meta.restoredTools).toEqual([
      { type: 'function', name: 'exec_command' },
    ]);
    expect(JSON.stringify(resumed.payload)).toContain('routecodex hook run reasoningStop');
    expect(JSON.stringify(resumed.payload)).not.toContain('"name":"reasoningStop"');
    expect(JSON.stringify(resumed.meta)).not.toContain('"name":"reasoningStop"');
  });

  it('keeps first-round tool history after a second relay continuation save/release', async () => {
    const sessionId = 'sess-store-release-stopless-roundtrip';
    const providerRequestId1 = 'openai-responses-provider-store-release-stopless-roundtrip-1';
    const providerRequestId2 = 'openai-responses-provider-store-release-stopless-roundtrip-2';
    const responseId1 = 'resp_store_release_stopless_roundtrip_1';
    const responseId2 = 'resp_store_release_stopless_roundtrip_2';

    captureResponsesRequestContext({
      requestId: providerRequestId1,
      sessionId,
      payload: {
        model: 'gpt-5.5',
        store: true,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '继续执行两轮 stopless continuation' }],
          },
        ],
        tools: [{ type: 'function', name: 'exec_command' }],
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '继续执行两轮 stopless continuation' }],
          },
        ],
        toolsRaw: [{ type: 'function', name: 'exec_command' }],
      },
      routeHint: 'thinking',
    });

    await persistResponsesConversationLifecycleForHttp({
      entryEndpoint: '/v1/responses',
      requestLabel: 'openai-responses-router-store-release-stopless-roundtrip-1',
      usageLogInfo: {
        finishReason: 'tool_calls',
        routeName: 'thinking',
        timingRequestIds: [providerRequestId1],
        sessionId,
      } as any,
      requestContext: {
        payload: {
          model: 'gpt-5.5',
          store: true,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: '继续执行两轮 stopless continuation' }],
            },
          ],
          tools: [{ type: 'function', name: 'exec_command' }],
        },
        context: {
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: '继续执行两轮 stopless continuation' }],
            },
          ],
          toolsRaw: [{ type: 'function', name: 'exec_command' }],
        },
        sessionId,
      } as any,
      body: {
        id: responseId1,
        object: 'response',
        status: 'requires_action',
        output: [
          {
            type: 'function_call',
            call_id: 'call_store_release_stopless_roundtrip_1',
            name: 'exec_command',
            arguments: '{"cmd":"routecodex hook run reasoningStop --input-json \\"{\\\\\\"flowId\\\\\\":\\\\\\"stop_message_flow\\\\\\",\\\\\\"repeatCount\\\\\\":1,\\\\\\"maxRepeats\\\\\\":3}\\""}',
          },
        ],
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [
              {
                id: 'call_store_release_stopless_roundtrip_1',
                type: 'function',
                name: 'exec_command',
                arguments: '{"cmd":"routecodex hook run reasoningStop --input-json \\"{\\\\\\"flowId\\\\\\":\\\\\\"stop_message_flow\\\\\\",\\\\\\"repeatCount\\\\\\":1,\\\\\\"maxRepeats\\\\\\":3}\\""}',
                tool_call_id: 'call_store_release_stopless_roundtrip_1',
              },
            ],
          },
        },
      },
    });

    const resumedRound1 = resumeResponsesConversation(responseId1, {
      response_id: responseId1,
      tool_outputs: [
        {
          call_id: 'call_store_release_stopless_roundtrip_1',
          output: '{"ok":true,"toolName":"stop_message_auto","repeatCount":2,"maxRepeats":3}',
        },
      ],
    }, {
      requestId: 'req_store_release_stopless_roundtrip_resume_1',
      continuationOwner: 'relay',
    });

    await persistResponsesConversationLifecycleForHttp({
      entryEndpoint: '/v1/responses',
      requestLabel: 'openai-responses-router-store-release-stopless-roundtrip-2',
      usageLogInfo: {
        finishReason: 'tool_calls',
        routeName: 'thinking',
        timingRequestIds: [providerRequestId2],
        sessionId,
      } as any,
      requestContext: {
        payload: {
          ...(resumedRound1.payload as Record<string, unknown>),
          tools: resumedRound1.meta.restoredTools,
        },
        context: {
          input: Array.isArray(resumedRound1.payload.input) ? resumedRound1.payload.input : [],
          toolsRaw: resumedRound1.meta.restoredTools,
        },
        sessionId,
      } as any,
      body: {
        id: responseId2,
        object: 'response',
        status: 'requires_action',
        output: [
          {
            type: 'function_call',
            call_id: 'call_store_release_stopless_roundtrip_2',
            name: 'exec_command',
            arguments: '{"cmd":"routecodex hook run reasoningStop --input-json \\"{\\\\\\"flowId\\\\\\":\\\\\\"stop_message_flow\\\\\\",\\\\\\"repeatCount\\\\\\":2,\\\\\\"maxRepeats\\\\\\":3}\\""}',
          },
        ],
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [
              {
                id: 'call_store_release_stopless_roundtrip_2',
                type: 'function',
                name: 'exec_command',
                arguments: '{"cmd":"routecodex hook run reasoningStop --input-json \\"{\\\\\\"flowId\\\\\\":\\\\\\"stop_message_flow\\\\\\",\\\\\\"repeatCount\\\\\\":2,\\\\\\"maxRepeats\\\\\\":3}\\""}',
                tool_call_id: 'call_store_release_stopless_roundtrip_2',
              },
            ],
          },
        },
      },
    });

    const resumedRound2 = resumeResponsesConversation(responseId2, {
      response_id: responseId2,
      tool_outputs: [
        {
          call_id: 'call_store_release_stopless_roundtrip_2',
          output: '{"ok":true,"toolName":"stop_message_auto","repeatCount":3,"maxRepeats":3}',
        },
      ],
    }, {
      requestId: 'req_store_release_stopless_roundtrip_resume_2',
      continuationOwner: 'relay',
    });

    expect(resumedRound2.payload).toEqual(expect.objectContaining({
      previous_response_id: responseId2,
    }));
    expect(resumedRound2.payload.input).toEqual([
      expect.objectContaining({
        type: 'message',
        role: 'user',
      }),
      expect.objectContaining({
        type: 'function_call',
        call_id: 'call_store_release_stopless_roundtrip_1',
        name: 'exec_command',
      }),
      expect.objectContaining({
        type: 'function_call_output',
        call_id: 'call_store_release_stopless_roundtrip_1',
        output: '{"ok":true,"toolName":"stop_message_auto","repeatCount":2,"maxRepeats":3}',
      }),
      expect.objectContaining({
        type: 'function_call',
        call_id: 'call_store_release_stopless_roundtrip_2',
        name: 'exec_command',
      }),
      expect.objectContaining({
        type: 'function_call_output',
        call_id: 'call_store_release_stopless_roundtrip_2',
        output: '{"ok":true,"toolName":"stop_message_auto","repeatCount":3,"maxRepeats":3}',
      }),
    ]);
    expect(JSON.stringify(resumedRound2.payload)).toContain('routecodex hook run reasoningStop');
    expect(JSON.stringify(resumedRound2.payload)).not.toContain('"name":"reasoningStop"');
  });
});
