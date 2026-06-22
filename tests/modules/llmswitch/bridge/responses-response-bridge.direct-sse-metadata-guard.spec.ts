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

const {
  assertDirectPassthroughResponsesSseMetadataIsolationForHttp,
  normalizeResponsesSseFrameForClientForHttp
} = await import(
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

  it('RED: strips top-level metadata from non-response.metadata direct passthrough frames in outbound normalization', async () => {
    const frame = [
      'event: response.custom_tool_call_input.delta',
      `data: ${JSON.stringify({
        type: 'response.custom_tool_call_input.delta',
        delta: 'abc',
        metadata: {
          source: 'provider',
          trace_id: 'trace-ok',
        },
      })}`,
      '',
      '',
    ].join('\n');

    const sanitized = await normalizeResponsesSseFrameForClientForHttp({
      frame,
      entryEndpoint: '/v1/responses',
      directPassthrough: true,
      requestLabel: 'req_direct_custom_tool_input_metadata_strip',
    });

    expect(sanitized).toContain('event: response.custom_tool_call_input.delta');
    expect(sanitized).not.toContain('"metadata"');
    expect(() => {
      assertDirectPassthroughResponsesSseMetadataIsolationForHttp(
        sanitized,
        'req_direct_custom_tool_input_metadata_strip'
      );
    }).not.toThrow();
  });

  it('RED: rejects non-Responses direct passthrough SSE events', () => {
    const frame = [
      'event: codex.rate_limits',
      `data: ${JSON.stringify({
        type: 'codex.rate_limits',
        limit_reached: true,
      })}`,
      '',
      '',
    ].join('\n');

    try {
      assertDirectPassthroughResponsesSseMetadataIsolationForHttp(
        frame,
        'req_direct_non_responses_event'
      );
      throw new Error('expected protocol violation');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error & { code?: string }).code).toBe('RESPONSES_DIRECT_SSE_PROTOCOL_VIOLATION');
      expect((error as Error).message).toContain('must contain only Responses standard events');
    }
  });
});
