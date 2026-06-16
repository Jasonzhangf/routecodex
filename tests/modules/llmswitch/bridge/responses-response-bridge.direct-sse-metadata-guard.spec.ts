import { describe, expect, it, jest } from '@jest/globals';

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
  clearAllResponsesConversationState: jest.fn(),
  clearResponsesConversationByRequestId: jest.fn(),
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

const { assertDirectPassthroughResponsesSseMetadataIsolationForHttp } = await import(
  '../../../../src/modules/llmswitch/bridge/responses-response-bridge.ts'
);

describe('responses-response-bridge direct SSE metadata guard', () => {
  it('allows direct passthrough response.metadata SSE frames with ordinary provider metadata', () => {
    const frame = [
      'event: response.metadata',
      `data: ${JSON.stringify({
        type: 'response.metadata',
        metadata: {
          source: 'provider',
          trace_id: 'trace-upstream',
        },
      })}`,
      '',
      '',
    ].join('\n');

    expect(() => {
      assertDirectPassthroughResponsesSseMetadataIsolationForHttp(frame, 'req_direct_response_metadata_event');
    }).not.toThrow();
  });

  it('RED: rejects response.metadata SSE frames whose metadata contains internal control fields', () => {
    const frame = [
      'event: response.metadata',
      `data: ${JSON.stringify({
        type: 'response.metadata',
        metadata: {
          providerKey: 'openai.key1.gpt-5.4',
          __rt: { routeHint: 'thinking' },
        },
      })}`,
      '',
      '',
    ].join('\n');

    expect(() => {
      assertDirectPassthroughResponsesSseMetadataIsolationForHttp(frame, 'req_direct_response_metadata_leak');
    }).toThrow('direct passthrough SSE metadata contains internal control fields');
  });

  it('RED: rejects direct passthrough SSE frames whose metadata contains internal control fields', () => {
    const frame = [
      'event: response.output_item.done',
      `data: ${JSON.stringify({
        type: 'response.output_item.done',
        item: {
          id: 'msg_1',
          type: 'message',
          metadata: {
            providerKey: 'openai.key1.gpt-5.4',
            __rt: { routeHint: 'thinking' },
          },
        },
      })}`,
      '',
      '',
    ].join('\n');

    expect(() => {
      assertDirectPassthroughResponsesSseMetadataIsolationForHttp(frame, 'req_direct_meta_leak');
    }).toThrow('direct passthrough SSE metadata contains internal control fields');
  });

  it('allows direct passthrough SSE frames with ordinary provider metadata only', () => {
    const frame = [
      'event: response.output_item.done',
      `data: ${JSON.stringify({
        type: 'response.output_item.done',
        item: {
          id: 'msg_2',
          type: 'message',
          metadata: {
            source: 'provider',
            trace_id: 'trace-ok',
          },
        },
      })}`,
      '',
      '',
    ].join('\n');

    expect(() => {
      assertDirectPassthroughResponsesSseMetadataIsolationForHttp(frame, 'req_direct_meta_ok');
    }).not.toThrow();
  });
});
