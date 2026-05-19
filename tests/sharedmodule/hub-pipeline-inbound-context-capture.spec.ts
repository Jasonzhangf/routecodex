import { describe, expect, it, jest, beforeEach } from '@jest/globals';

const mockCaptureResponsesRequestContext = jest.fn();
const mockResolveHubClientProtocolWithNative = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_inbound/req_inbound_stage3_context_capture/cache-write.js',
  () => ({
    writeCacheEntryForRequest: jest.fn(),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js',
  () => ({
    captureResponsesRequestContext: mockCaptureResponsesRequestContext,
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js',
  () => ({
    buildReqInboundNodeResultWithNative: jest.fn(() => ({ stage: 'req_inbound' })),
    readResponsesResumeFromMetadataWithNative: jest.fn(() => undefined),
    resolveHubClientProtocolWithNative: mockResolveHubClientProtocolWithNative,
  }),
);

const { captureInboundContextSnapshot } = await import(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage-inbound-blocks.js'
);

describe('hub inbound context capture', () => {
  beforeEach(() => {
    mockCaptureResponsesRequestContext.mockReset();
    mockResolveHubClientProtocolWithNative.mockReset();
  });

  it('captures responses conversation context only for openai-responses protocol', async () => {
    mockResolveHubClientProtocolWithNative.mockReturnValue('openai-responses');

    await captureInboundContextSnapshot({
      inboundStage2ResponsesContext: { foo: 'bar' },
      rawRequest: { input: [{ role: 'user', content: 'hi' }] } as any,
      inboundAdapterContext: {
        requestId: 'req_capture_responses_only',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
      } as any,
      hooks: { captureContext: jest.fn() } as any,
    });

    expect(mockCaptureResponsesRequestContext).toHaveBeenCalledTimes(1);
    expect(mockCaptureResponsesRequestContext.mock.calls[0]?.[0]).toMatchObject({
      requestId: 'req_capture_responses_only',
    });
  });

  it('does not capture responses conversation context for non-responses protocol', async () => {
    mockResolveHubClientProtocolWithNative.mockReturnValue('openai-chat');

    await captureInboundContextSnapshot({
      inboundStage2ResponsesContext: { foo: 'bar' },
      rawRequest: { messages: [{ role: 'user', content: 'hi' }] } as any,
      inboundAdapterContext: {
        requestId: 'req_capture_chat',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
      } as any,
      hooks: { captureContext: jest.fn() } as any,
    });

    expect(mockCaptureResponsesRequestContext).not.toHaveBeenCalled();
  });
});

