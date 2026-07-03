import { describe, expect, it } from '@jest/globals';

import { buildResponsesSseContentPartDescriptorWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-responses-sse-event-payload.js';
import { buildContentPartDoneEvent, createDefaultResponsesContext } from '../../sharedmodule/llmswitch-core/src/sse/json-to-sse/event-generators/responses.js';
import { buildResponsesSseEventSequenceWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-responses-sse-event-payload.js';

async function collectEvents(response: any): Promise<any[]> {
  const events: any[] = [];
  const context = {
    requestId: 'req_content_part_descriptor_native',
    sequenceCounter: 0,
    outputIndexCounter: 0,
    contentIndexCounter: new Map<string, number>()
  };
  for await (const event of buildResponsesSseEventSequenceWithNative(response, context as any, {
    enableTimestampGeneration: false,
    chunkSize: 0,
    enableRecovery: false,
  } as any)) {
    events.push(event);
  }
  return events;
}

describe('responses SSE content part descriptor native owner', () => {
  it('builds added descriptors through the native owner', () => {
    const descriptor = buildResponsesSseContentPartDescriptorWithNative({
      type: 'output_text',
      text: 'final text',
      annotations: [{ type: 'file_citation' }],
      logprobs: [{ token: 'x' }]
    }, 'added');

    expect(descriptor).toEqual({
      type: 'output_text',
      text: 'final text',
      annotations: [{ type: 'file_citation' }],
      logprobs: [{ token: 'x' }]
    });
  });

  it('builds done descriptors through the native owner', () => {
    const descriptor = buildResponsesSseContentPartDescriptorWithNative({
      type: 'function_result',
      result: { ok: true },
      tool_call_id: 'call_1'
    }, 'done');

    expect(descriptor).toEqual({
      type: 'function_result',
      result: { ok: true },
      tool_call_id: 'call_1'
    });
  });

  it('fails missing content part type instead of synthesizing an unknown descriptor', () => {
    expect(() => buildResponsesSseContentPartDescriptorWithNative({
      text: 'missing type'
    }, 'added')).toThrow('Responses content part descriptor missing type');
  });

  it('projects content_part added and done events without TS descriptor synthesis', async () => {
    const events = await collectEvents({
      id: 'resp_content_part_descriptor_native',
      object: 'response',
      created_at: 1710000000,
      status: 'completed',
      model: 'gpt-test',
      output: [{
        id: 'msg_1',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{
          type: 'output_text',
          text: 'hello world',
          annotations: [{ type: 'file_citation' }],
          logprobs: [{ token: 'hello' }]
        }]
      }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    });

    const added = events.find((event) => event.type === 'response.content_part.added');
    const done = events.find((event) => event.type === 'response.content_part.done');

    expect(added?.data?.part).toEqual({
      type: 'output_text',
      text: 'hello world',
      annotations: [{ type: 'file_citation' }],
      logprobs: [{ token: 'hello' }]
    });
    expect(done?.data?.part).toEqual({
      type: 'output_text',
      text: 'hello world',
      annotations: [{ type: 'file_citation' }],
      logprobs: [{ token: 'hello' }]
    });
  });

  it('fails missing content_part on done instead of synthesizing a partless done event in TS', () => {
    const context = createDefaultResponsesContext('req_missing_done_content_part', 'gpt-test');

    expect(() => buildContentPartDoneEvent(
      'msg_missing_done_part',
      0,
      undefined as any,
      context,
      {
        enableTimestampGeneration: false,
        chunkSize: 0,
        enableIdGeneration: false,
        enableSequenceNumbers: true,
      }
    )).toThrow('Invalid Responses content_part.done: missing content part');
  });
});
