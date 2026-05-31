import { describe, expect, it, jest } from '@jest/globals';
import { Readable } from 'node:stream';

const mockConvertProviderResponse = jest.fn(async () => ({
  body: { id: 'resp_direct_materialized', object: 'response', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], output_text: 'ok' }
}));
const mockCreateSnapshotRecorder = jest.fn(async () => ({ record: () => {} }));

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge.js', () => ({
  convertProviderResponse: mockConvertProviderResponse,
  createSnapshotRecorder: mockCreateSnapshotRecorder,
  syncReasoningStopModeFromRequest: () => 'off',
  syncStoplessGoalStateFromRequest: () => undefined,
  sanitizeFollowupText: async (raw: unknown) => (typeof raw === 'string' ? raw : '')
}));

describe('executor-response direct SSE materializer', () => {
  it('materializes direct __sse_responses before Rust bridge conversion', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockClear();

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../src/server/runtime/http-server/executor-response.js'
    );
    await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerType: 'anthropic',
        requestId: 'req_direct_sse_materializer',
        wantsStream: false,
        response: {
          body: {
            __sse_responses: Readable.from([
              'event: message_start\n',
              'data: {"type":"message_start","message":{"id":"msg_direct","type":"message","role":"assistant","model":"mimo-v2.5","content":[],"stop_reason":null}}\n\n',
              'event: content_block_start\n',
              'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
              'event: content_block_delta\n',
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
              'event: message_stop\n',
              'data: {"type":"message_stop"}\n\n'
            ])
          }
        } as any,
        pipelineMetadata: {}
      },
      {
        logStage: () => undefined,
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    );

    expect(mockConvertProviderResponse).toHaveBeenCalledTimes(1);
    const call = mockConvertProviderResponse.mock.calls[0][0] as Record<string, any>;
    expect(call.providerResponse.mode).toBe('sse');
    expect(call.providerResponse.bodyText).toContain('message_start');
    expect(call.providerResponse.__sse_responses).toBeDefined();
  });
});
