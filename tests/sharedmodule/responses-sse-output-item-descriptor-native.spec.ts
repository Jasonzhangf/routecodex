import { describe, expect, it } from '@jest/globals';

import { buildResponsesSseFunctionCallArgumentsDeltaPayloadWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-responses-sse-event-payload.js';
import { buildResponsesSseFunctionCallArgumentsDonePayloadWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-responses-sse-event-payload.js';
import { buildResponsesSseOutputItemDescriptorWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-responses-sse-event-payload.js';
import { buildResponsesSseOutputTextDeltaPayloadWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-responses-sse-event-payload.js';
import { buildResponsesSseOutputTextDonePayloadWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-responses-sse-event-payload.js';
import { buildGeminiSseEventSequenceWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-responses-sse-event-payload.js';

async function collectEvents(response: any): Promise<any[]> {
  const events: any[] = [];
  const context = {
    requestId: 'req_output_item_descriptor_native',
    sequenceCounter: 0,
    outputIndexCounter: 0,
    contentIndexCounter: new Map<string, number>()
  };
  for await (const event of buildGeminiSseEventSequenceWithNative(response, context as any, {
    enableTimestampGeneration: false,
    chunkSize: 0,
    enableRecovery: false,
  } as any)) {
    events.push(event);
  }
  return events;
}

describe('responses SSE output item descriptor native owner', () => {
  it('builds added descriptors through the native owner', () => {
    const descriptor = buildResponsesSseOutputItemDescriptorWithNative({
      id: 'fc_1',
      type: 'function_call',
      status: 'completed',
      name: 'search',
      call_id: 'call_1',
      arguments: '{"q":"rust"}'
    }, 'added');

    expect(descriptor).toEqual({
      id: 'fc_1',
      type: 'function_call',
      status: 'in_progress',
      name: 'search',
      call_id: 'call_1',
      arguments: ''
    });
  });

  it('builds done descriptors through the native owner with verbatim reasoning summary', () => {
    const descriptor = buildResponsesSseOutputItemDescriptorWithNative({
      id: 'rs_1',
      type: 'reasoning',
      summary: ['- inspect `file.ts`'],
      content: [],
      encrypted_content: 'enc_1'
    }, 'done');

    expect(descriptor).toEqual({
      id: 'rs_1',
      type: 'reasoning',
      status: 'completed',
      summary: [{ type: 'summary_text', text: '- inspect `file.ts`' }],
      content: [],
      encrypted_content: 'enc_1'
    });
  });

  it('fails missing output item type instead of synthesizing an unknown descriptor', () => {
    expect(() => buildResponsesSseOutputItemDescriptorWithNative({
      id: 'item_missing_type'
    }, 'added')).toThrow('Responses output item descriptor missing type');
  });

  it('fails malformed reasoning content instead of serializing non-array content', () => {
    expect(() => buildResponsesSseOutputItemDescriptorWithNative({
      id: 'rs_malformed_content',
      type: 'reasoning',
      summary: [],
      content: { type: 'reasoning_text', text: 'think' }
    }, 'done')).toThrow('Invalid Responses reasoning content: expected array');
  });

  it('builds output_text.done payloads through the native owner', () => {
    const payload = buildResponsesSseOutputTextDonePayloadWithNative(3, 'msg_1', 1, 'final text');

    expect(payload).toEqual({
      output_index: 3,
      item_id: 'msg_1',
      content_index: 1,
      text: 'final text',
      logprobs: []
    });
  });

  it('builds output_text.delta payloads through the native owner', () => {
    const payload = buildResponsesSseOutputTextDeltaPayloadWithNative(3, 'msg_1', 1, 'delta text');

    expect(payload).toEqual({
      output_index: 3,
      item_id: 'msg_1',
      content_index: 1,
      delta: 'delta text',
      logprobs: []
    });
  });

  it('builds function_call_arguments payloads through the native owner', () => {
    const delta = buildResponsesSseFunctionCallArgumentsDeltaPayloadWithNative(
      2,
      'fc_1',
      'call_1',
      '{"q"'
    );
    const done = buildResponsesSseFunctionCallArgumentsDonePayloadWithNative(
      2,
      'fc_1',
      'call_1',
      'search',
      '{"q":"rust"}'
    );

    expect(delta).toEqual({
      output_index: 2,
      item_id: 'fc_1',
      call_id: 'call_1',
      delta: '{"q"'
    });
    expect(done).toEqual({
      output_index: 2,
      item_id: 'fc_1',
      call_id: 'call_1',
      name: 'search',
      arguments: '{"q":"rust"}'
    });
  });

  it('projects output_item added and done events without TS descriptor synthesis', async () => {
    const events = await collectEvents({
      id: 'resp_output_item_descriptor_native',
      object: 'response',
      created_at: 1710000000,
      status: 'completed',
      model: 'gpt-test',
      output: [{
        id: 'fc_1',
        type: 'function_call',
        status: 'completed',
        name: 'search',
        call_id: 'call_1',
        arguments: '{"q":"rust"}'
      }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    });

    const added = events.find((event) => event.type === 'response.output_item.added');
    const done = events.find((event) => event.type === 'response.output_item.done');

    expect(added?.data?.item).toEqual({
      id: 'fc_1',
      type: 'function_call',
      status: 'in_progress',
      name: 'search',
      call_id: 'call_1',
      arguments: ''
    });
    expect(done?.data?.item).toEqual({
      id: 'fc_1',
      type: 'function_call',
      status: 'completed',
      name: 'search',
      call_id: 'call_1',
      arguments: '{"q":"rust"}'
    });
  });

  it('projects output_text.done events through the native payload owner', async () => {
    const events = await collectEvents({
      id: 'resp_output_text_done_native',
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
          text: 'final text',
          annotations: [{ type: 'file_citation' }],
          logprobs: [{ token: 'x' }]
        }]
      }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    });

    const outputTextDone = events.find((event) => event.type === 'response.output_text.done');
    const outputTextDelta = events.find((event) => event.type === 'response.output_text.delta');

    expect(outputTextDelta?.data).toEqual({
      type: 'response.output_text.delta',
      sequence_number: outputTextDelta?.sequenceNumber,
      output_index: 0,
      item_id: 'msg_1',
      content_index: 0,
      delta: 'final text',
      logprobs: []
    });

    expect(outputTextDone?.data).toEqual({
      type: 'response.output_text.done',
      sequence_number: outputTextDone?.sequenceNumber,
      output_index: 0,
      item_id: 'msg_1',
      content_index: 0,
      text: 'final text',
      logprobs: []
    });
  });

  it('fails missing output_text text instead of synthesizing a response.error event', async () => {
    await expect(collectEvents({
      id: 'resp_output_text_missing_text',
      object: 'response',
      created_at: 1710000000,
      status: 'completed',
      model: 'gpt-test',
      output: [{
        id: 'msg_missing_text',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{
          type: 'output_text'
        }]
      }]
    } as any)).rejects.toThrow('Invalid Responses message: missing content text');
  });

  it('projects function_call_arguments events through the native payload owner', async () => {
    const events = await collectEvents({
      id: 'resp_function_call_arguments_native',
      object: 'response',
      created_at: 1710000000,
      status: 'completed',
      model: 'gpt-test',
      output: [{
        id: 'fc_1',
        type: 'function_call',
        status: 'completed',
        name: 'search',
        call_id: 'call_1',
        arguments: '{"q":"rust"}'
      }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    });

    const delta = events.find((event) => event.type === 'response.function_call_arguments.delta');
    const done = events.find((event) => event.type === 'response.function_call_arguments.done');

    expect(delta?.data).toEqual({
      type: 'response.function_call_arguments.delta',
      sequence_number: delta?.sequenceNumber,
      output_index: 0,
      item_id: 'fc_1',
      call_id: 'call_1',
      delta: '{"q":"rust"}'
    });
    expect(done?.data).toEqual({
      type: 'response.function_call_arguments.done',
      sequence_number: done?.sequenceNumber,
      output_index: 0,
      item_id: 'fc_1',
      call_id: 'call_1',
      name: 'search',
      arguments: '{"q":"rust"}'
    });
  });

  it('fails missing function_call arguments instead of synthesizing a response.error event', async () => {
    await expect(collectEvents({
      id: 'resp_function_call_missing_arguments',
      object: 'response',
      created_at: 1710000000,
      status: 'completed',
      model: 'gpt-test',
      output: [{
        id: 'fc_missing_args',
        type: 'function_call',
        status: 'completed',
        name: 'search',
        call_id: 'call_missing_args'
      }]
    } as any)).rejects.toThrow('Responses SSE text chunk payload missing text');
  });
});
