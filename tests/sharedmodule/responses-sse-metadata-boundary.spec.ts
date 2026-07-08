import { describe, expect, it } from '@jest/globals';

import { buildResponsesSseEventSequenceDirectNative } from './helpers/responses-sse-direct-native.js';

async function collectEvents(response: any): Promise<any[]> {
  return buildResponsesSseEventSequenceDirectNative({
    response,
    requestId: 'req_metadata_response_boundary',
    config: {
      enableTimestampGeneration: false,
      chunkSize: 256,
      enableRecovery: false,
    }
  });
}

describe('responses SSE metadata boundary', () => {
  it('does not project internal response metadata into client SSE response payloads', async () => {
    const events = await collectEvents({
      id: 'resp_metadata_boundary',
      object: 'response',
      created_at: 1710000000,
      status: 'completed',
      model: 'gpt-test',
      metadata: {
        session_id: 'must-not-leak',
        routeHint: 'internal',
        __shadowCompareForcedProviderKey: 'provider.key'
      },
      output: [
        {
          id: 'msg_1',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok' }]
        }
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    });

    const responseEvents = events.filter((event) => event.data?.response);
    expect(responseEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining(['response.created', 'response.in_progress', 'response.completed', 'response.done'])
    );
    expect(JSON.stringify(events)).not.toContain('message_placeholder_');
    for (const event of responseEvents) {
      expect(event.data.response.metadata).toBeUndefined();
      expect(JSON.stringify(event.data.response)).not.toContain('must-not-leak');
      expect(JSON.stringify(event.data.response)).not.toContain('__shadowCompareForcedProviderKey');
    }
  });
});
