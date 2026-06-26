import { buildResponsesPayloadFromChat } from '../../sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge/response-payload.js';

describe('responses-openai bridge metadata boundary', () => {
  it('does not project source retention metadata into client Responses payload', () => {
    const result = buildResponsesPayloadFromChat(
      {
        id: 'chatcmpl_metadata_boundary',
        object: 'chat.completion',
        metadata: { requestId: 'internal_req', routeHint: 'tools' },
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'done' },
        }],
      },
      {
        requestId: 'req_metadata_boundary',
        metadata: { routeHint: 'tools', __rt: { internalRuntimeMarker: true } },
      } as any
    ) as Record<string, unknown>;

    expect(result.object).toBe('response');
    expect(result.metadata).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('internalRuntimeMarker');
  });
});
