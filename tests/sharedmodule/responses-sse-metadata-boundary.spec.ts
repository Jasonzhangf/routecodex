import { describe, expect, it } from '@jest/globals';

import { sequenceResponse } from '../../sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/responses-sequencer.js';
import { createResponseBuilder } from '../../sharedmodule/llmswitch-core/src/sse/sse-to-json/builders/response-builder.js';

async function collectEvents(response: any): Promise<any[]> {
  const events: any[] = [];
  const context = {
    requestId: 'req_metadata_response_boundary',
    sequenceNumber: 0,
    outputIndexCounter: 0,
    contentIndexCounter: new Map<string, number>()
  };
  for await (const event of sequenceResponse(response, context as any, {
    enableTimestampGeneration: false,
    chunkSize: 256,
    chunkDelayMs: 0,
    enableValidation: true,
    enableRecovery: false,
    enableDelay: false,
    maxOutputItems: 10,
    maxContentParts: 10
  } as any)) {
    events.push(event);
  }
  return events;
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
    for (const event of responseEvents) {
      expect(event.data.response.metadata).toBeUndefined();
      expect(JSON.stringify(event.data.response)).not.toContain('must-not-leak');
      expect(JSON.stringify(event.data.response)).not.toContain('__shadowCompareForcedProviderKey');
    }
  });

  it('does not project provider SSE metadata into reconstructed client JSON response', () => {
    const builder = createResponseBuilder();

    builder.processEvent({
      type: 'response.created',
      timestamp: 0,
      protocol: 'responses',
      direction: 'sse_to_json',
      sequenceNumber: 0,
      data: {
        response: {
          id: 'resp_sse_metadata_boundary',
          object: 'response',
          created_at: 1710000000,
          status: 'in_progress',
          model: 'gpt-test',
          metadata: { session_id: 'provider-event-metadata' }
        }
      }
    } as any);
    builder.processEvent({
      type: 'response.completed',
      timestamp: 0,
      protocol: 'responses',
      direction: 'sse_to_json',
      sequenceNumber: 1,
      data: {
        response: {
          id: 'resp_sse_metadata_boundary',
          object: 'response',
          status: 'completed',
          model: 'gpt-test',
          metadata: { routeHint: 'provider-completed-metadata' },
          output: []
        }
      }
    } as any);

    const result = builder.getResult();
    expect(result.success).toBe(true);
    expect((result.response as any).metadata).toBeUndefined();
    expect(JSON.stringify(result.response)).not.toContain('provider-event-metadata');
    expect(JSON.stringify(result.response)).not.toContain('provider-completed-metadata');
  });
});
