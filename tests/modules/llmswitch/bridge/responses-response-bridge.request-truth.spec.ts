import { beforeAll, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/index.js', () => ({
  buildResponsesTerminalSseFramesFromProbeNative: jest.fn(),
  createResponsesJsonToSseConverter: jest.fn(),
  importCoreDist: jest.fn(),
  isToolCallContinuationResponseNative: jest.fn(),
  rebindResponsesConversationRequestId: jest.fn(),
  requireCoreDist: jest.fn(),
  updateResponsesContractProbeFromSseChunkNative: jest.fn(),
}));

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/runtime-integrations.js', () => ({
  captureResponsesRequestContextForRequest: jest.fn(),
  clearResponsesConversationByRequestId: jest.fn(),
  clearAllResponsesConversationState: jest.fn(),
  clearUnresolvedResponsesConversationRequests: jest.fn(),
  createResponsesJsonToSseConverter: jest.fn(),
  createResponsesSseToJsonConverter: jest.fn(),
  finalizeResponsesConversationRequestRetention: jest.fn(),
  lookupResponsesContinuationByResponseId: jest.fn(),
  materializeLatestResponsesContinuationByScope: jest.fn(),
  preloadCriticalBridgeRuntimeModules: jest.fn(async () => ({})),
  recordResponsesResponseForRequest: jest.fn(),
  rebindResponsesConversationRequestId: jest.fn(),
  reportProviderErrorToRouterPolicy: jest.fn(),
  reportProviderSuccessToRouterPolicy: jest.fn(),
  resetResponsesConversationStateForRestartSimulation: jest.fn(),
  resumeLatestResponsesContinuationByScope: jest.fn(),
  resumeResponsesConversation: jest.fn(),
  writeSnapshotViaHooks: jest.fn(),
}));

let buildResponsesRequestLogContextForHttp: any;
let persistResponsesConversationLifecycleForHttp: any;
let MetadataCenter: any;
let recordResponsesResponseForRequestMock: any;

beforeAll(async () => {
  ({
    buildResponsesRequestLogContextForHttp,
    persistResponsesConversationLifecycleForHttp,
  } = await import('../../../../src/modules/llmswitch/bridge/responses-response-bridge.ts'));
  ({ MetadataCenter } = await import(
    '../../../../src/server/runtime/http-server/metadata-center/metadata-center.ts'
  ));
  ({ recordResponsesResponseForRequest: recordResponsesResponseForRequestMock } = await import(
    '../../../../src/modules/llmswitch/bridge/runtime-integrations.js'
  ));
});

describe('responses-response-bridge request truth', () => {
  it('buildResponsesRequestLogContextForHttp prefers MetadataCenter request truth over flat metadata', () => {
    const metadata: Record<string, unknown> = {
      sessionId: 'flat-session',
      conversationId: 'flat-conversation',
    };
    const center = MetadataCenter.attach(metadata);
    center.writeRequestTruth(
      'sessionId',
      'center-session',
      {
        module: 'tests/modules/llmswitch/bridge/responses-response-bridge.request-truth.spec.ts',
        symbol: 'buildResponsesRequestLogContextForHttp prefers MetadataCenter request truth over flat metadata',
        stage: 'test',
      }
    );
    center.writeRequestTruth(
      'conversationId',
      'center-conversation',
      {
        module: 'tests/modules/llmswitch/bridge/responses-response-bridge.request-truth.spec.ts',
        symbol: 'buildResponsesRequestLogContextForHttp prefers MetadataCenter request truth over flat metadata',
        stage: 'test',
      }
    );

    expect(buildResponsesRequestLogContextForHttp({ metadata })).toMatchObject({
      sessionId: 'center-session',
      conversationId: 'center-conversation',
    });
  });

  it('buildResponsesRequestLogContextForHttp does not read flat metadata session fields without request truth', () => {
    expect(buildResponsesRequestLogContextForHttp({
      metadata: {
        sessionId: 'flat-session',
        session_id: 'flat-session-legacy',
        conversationId: 'flat-conversation',
        conversation_id: 'flat-conversation-legacy',
      },
    })).toMatchObject({
      sessionId: undefined,
      session_id: undefined,
      conversationId: undefined,
      conversation_id: undefined,
    });
  });

  it('persistResponsesConversationLifecycleForHttp falls back to MetadataCenter request truth when usageLogInfo is missing session identifiers', async () => {
    recordResponsesResponseForRequestMock.mockReset();
    recordResponsesResponseForRequestMock.mockResolvedValue(undefined);

    const metadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(metadata);
    center.writeRequestTruth(
      'sessionId',
      'center-session-2',
      {
        module: 'tests/modules/llmswitch/bridge/responses-response-bridge.request-truth.spec.ts',
        symbol: 'persistResponsesConversationLifecycleForHttp falls back to MetadataCenter request truth when usageLogInfo is missing session identifiers',
        stage: 'test',
      }
    );
    center.writeRequestTruth(
      'conversationId',
      'center-conversation-2',
      {
        module: 'tests/modules/llmswitch/bridge/responses-response-bridge.request-truth.spec.ts',
        symbol: 'persistResponsesConversationLifecycleForHttp falls back to MetadataCenter request truth when usageLogInfo is missing session identifiers',
        stage: 'test',
      }
    );

    await persistResponsesConversationLifecycleForHttp({
      entryEndpoint: '/v1/responses',
      requestLabel: 'req-center-truth-persist',
      usageLogInfo: {
        finishReason: 'tool_calls',
        routeName: 'thinking',
        timingRequestIds: ['req-center-truth-persist'],
      } as any,
      metadata,
      requestContext: {
        payload: { model: 'gpt-5.4', store: true, input: [], tools: [] },
        context: { input: [], toolsRaw: [] },
      } as any,
      body: {
        id: 'resp_center_truth_persist',
        object: 'response',
        status: 'requires_action',
        output: [
          { type: 'function_call', name: 'echo_tool', arguments: '{"text":"x"}', call_id: 'call_x' }
        ],
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [
              { id: 'call_x', type: 'function', name: 'echo_tool', arguments: '{"text":"x"}', tool_call_id: 'call_x' }
            ]
          }
        }
      },
    });

    expect(recordResponsesResponseForRequestMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'center-session-2',
      conversationId: 'center-conversation-2',
    }));
  });
});
