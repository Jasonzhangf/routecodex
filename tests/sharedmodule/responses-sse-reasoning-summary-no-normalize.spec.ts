import { describe, expect, it } from '@jest/globals';

import { sequenceResponse } from '../../sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/responses-sequencer.js';
import { normalizeResponsesSseReasoningSummaryWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-responses-sse-event-payload.js';
import { buildResponsesSseReasoningSummaryPayloadWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-responses-sse-event-payload.js';
import { buildResponsesSseReasoningDeltaPayloadWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-responses-sse-event-payload.js';
import { buildResponsesSseReasoningLifecyclePayloadWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-responses-sse-event-payload.js';
import { buildResponsesSseResponseEventPayloadWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-responses-sse-event-payload.js';
import { buildResponsesSseTextChunksWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-responses-sse-event-payload.js';
import { buildResponsesSseEventEnvelopeWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-responses-sse-event-payload.js';

async function collectEvents(response: any, overrides: Record<string, unknown> = {}): Promise<any[]> {
  const events: any[] = [];
  const context = {
    requestId: 'req_reasoning_summary_no_normalize',
    sequenceCounter: 0,
    outputIndexCounter: 0,
    contentIndexCounter: new Map<string, number>()
  };
  for await (const event of sequenceResponse(response, context as any, {
    enableTimestampGeneration: false,
    chunkSize: 0,
    chunkDelayMs: 0,
    enableValidation: true,
    enableRecovery: false,
    enableDelay: false,
    maxOutputItems: 10,
    maxContentParts: 10,
    ...overrides
  } as any)) {
    events.push(event);
  }
  return events;
}

describe('responses SSE reasoning summary no-normalize boundary', () => {
  it('builds event envelope timestamp and sequence through the native owner', () => {
    expect(buildResponsesSseEventEnvelopeWithNative({
      requestId: 'req_native_envelope',
      currentSequence: 7,
      enableTimestampGeneration: false,
      enableSequenceNumbers: true
    })).toEqual({
      requestId: 'req_native_envelope',
      timestamp: 0,
      sequenceNumber: 7,
      nextSequenceCounter: 8,
      protocol: 'responses',
      direction: 'json_to_sse'
    });

    expect(buildResponsesSseEventEnvelopeWithNative({
      requestId: 'req_native_envelope_no_seq',
      currentSequence: 7,
      enableTimestampGeneration: false,
      enableSequenceNumbers: false
    }).nextSequenceCounter).toBe(7);
  });

  it('builds text chunks through the native owner', () => {
    expect(buildResponsesSseTextChunksWithNative('hello world again', 8)).toEqual([
      'hello ',
      'world ',
      'again'
    ]);
    expect(buildResponsesSseTextChunksWithNative('hello world', 0)).toEqual(['hello world']);
  });

  it('builds response start payloads through native owner with empty output', async () => {
    const events = await collectEvents({
      id: 'resp_start_payload_native',
      object: 'response',
      created_at: 1710000000,
      status: 'completed',
      model: 'gpt-test',
      output: [{
        id: 'msg_1',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hello' }]
      }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    });

    const created = events.find((event) => event.type === 'response.created');
    const inProgress = events.find((event) => event.type === 'response.in_progress');

    expect(created?.data?.response?.status).toBe('in_progress');
    expect(created?.data?.response?.output).toEqual([]);
    expect(inProgress?.data?.response?.status).toBe('in_progress');
    expect(inProgress?.data?.response?.output).toEqual([]);
  });

  it('builds response event payloads through native owner directly', () => {
    const start = buildResponsesSseResponseEventPayloadWithNative(
      'start',
      {
        id: 'resp_direct_start',
        object: 'response',
        created_at: 1710000000,
        status: 'completed',
        model: 'gpt-test',
        output: [{ id: 'msg_1', type: 'message' }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      },
      'in_progress'
    );
    const requiredAction = buildResponsesSseResponseEventPayloadWithNative(
      'required_action',
      {
        id: 'resp_direct_required',
        object: 'response',
        created_at: 1710000000,
        status: 'requires_action',
        model: 'gpt-test',
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      },
      'requires_action',
      { type: 'submit_tool_outputs', submit_tool_outputs: { tool_calls: [] } }
    );

    expect(start.response).toMatchObject({
      id: 'resp_direct_start',
      status: 'in_progress',
      output: []
    });
    expect(requiredAction.required_action).toEqual({
      type: 'submit_tool_outputs',
      submit_tool_outputs: { tool_calls: [] }
    });
  });

  it('builds reasoning lifecycle payloads through native owner', () => {
    const start = buildResponsesSseReasoningLifecyclePayloadWithNative(
      'start',
      'rs_native_lifecycle',
      ['- keep `verbatim`']
    );
    const done = buildResponsesSseReasoningLifecyclePayloadWithNative(
      'done',
      'rs_native_lifecycle'
    );

    expect(start).toEqual({
      item_id: 'rs_native_lifecycle',
      summary: [{ type: 'summary_text', text: '- keep `verbatim`' }]
    });
    expect(done).toEqual({ item_id: 'rs_native_lifecycle' });
    expect(() => buildResponsesSseReasoningLifecyclePayloadWithNative('start', ' ', [])).toThrow(
      'Responses reasoning lifecycle payload item_id is required'
    );
  });

  it('builds output item and content part payload wrappers through native owner', async () => {
    const events = await collectEvents({
      id: 'resp_item_payload_native',
      object: 'response',
      created_at: 1710000000,
      status: 'completed',
      model: 'gpt-test',
      output: [{
        id: 'msg_1',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hello', annotations: [{ type: 'citation' }], logprobs: [] }]
      }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    });

    const itemAdded = events.find((event) => event.type === 'response.output_item.added');
    const partAdded = events.find((event) => event.type === 'response.content_part.added');
    const partDone = events.find((event) => event.type === 'response.content_part.done');
    const itemDone = events.find((event) => event.type === 'response.output_item.done');

    expect(itemAdded?.data).toMatchObject({
      output_index: 0,
      item: {
        id: 'msg_1',
        type: 'message',
        status: 'in_progress',
        content: []
      }
    });
    expect(partAdded?.data).toMatchObject({
      output_index: 0,
      item_id: 'msg_1',
      content_index: 0,
      part: {
        type: 'output_text',
        text: 'hello',
        annotations: [{ type: 'citation' }],
        logprobs: []
      }
    });
    expect(partDone?.data).toMatchObject({
      output_index: 0,
      item_id: 'msg_1',
      content_index: 0,
      part: {
        type: 'output_text',
        text: 'hello',
        annotations: [{ type: 'citation' }],
        logprobs: []
      }
    });
    expect(itemDone?.data).toMatchObject({
      output_index: 0,
      item: {
        id: 'msg_1',
        type: 'message',
        status: 'completed',
        content: [{ type: 'output_text', text: 'hello', annotations: [{ type: 'citation' }], logprobs: [] }]
      }
    });
  });

  it('sequences output text deltas using native text chunks', async () => {
    const events = await collectEvents({
      id: 'resp_text_chunks_native',
      object: 'response',
      created_at: 1710000000,
      status: 'completed',
      model: 'gpt-test',
      output: [{
        id: 'msg_1',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hello world again' }]
      }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    }, { chunkSize: 8 });

    const deltas = events
      .filter((event) => event.type === 'response.output_text.delta')
      .map((event) => event.data?.delta);
    expect(deltas).toEqual(['hello ', 'world ', 'again']);
  });

  it('normalizes reasoning summary entries through the native owner verbatim', () => {
    const summary = normalizeResponsesSseReasoningSummaryWithNative([
      '- inspect `file.ts`',
      { text: '> keep quoted detail' },
      { type: 'summary_text', text: '  spaced summary  ' },
      { type: 'other', text: 'still kept' }
    ] as any);

    expect(summary).toEqual([
      { type: 'summary_text', text: '- inspect `file.ts`' },
      { type: 'summary_text', text: '> keep quoted detail' },
      { type: 'summary_text', text: '  spaced summary  ' },
      { type: 'summary_text', text: 'still kept' }
    ]);
  });

  it('projects reasoning summary text without adding Thinking headers or compacting markdown', async () => {
    const rawSummary = '- inspect `file.ts`\n\n> keep quoted detail';
    const events = await collectEvents({
      id: 'resp_reasoning_summary_raw',
      object: 'response',
      created_at: 1710000000,
      status: 'completed',
      model: 'gpt-test',
      output: [{
        id: 'rs_1',
        type: 'reasoning',
        summary: [rawSummary],
        content: []
      }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    });

    const outputItemDone = events.find((event) => event.type === 'response.output_item.done');
    const summaryPartAdded = events.find((event) => event.type === 'response.reasoning_summary_part.added');
    const summaryTextDelta = events.find((event) => event.type === 'response.reasoning_summary_text.delta');
    const summaryTextDone = events.find((event) => event.type === 'response.reasoning_summary_text.done');
    const summaryPartDone = events.find((event) => event.type === 'response.reasoning_summary_part.done');
    const payloadText = JSON.stringify(events);

    expect(outputItemDone?.data?.item?.summary).toEqual([{ type: 'summary_text', text: rawSummary }]);
    expect(summaryPartAdded?.data?.part).toEqual({ type: 'summary_text', text: '' });
    expect(summaryTextDelta?.data?.delta).toBe(rawSummary);
    expect(summaryTextDone?.data?.text).toBe(rawSummary);
    expect(summaryPartDone?.data?.part).toEqual({ type: 'summary_text', text: rawSummary });
    expect(payloadText).not.toContain('**Thinking**');
    expect(payloadText).toContain('- inspect `file.ts`');
    expect(payloadText).toContain('> keep quoted detail');
  });

  it('fails missing reasoning summary text instead of synthesizing a response.error event', async () => {
    await expect(collectEvents({
      id: 'resp_reasoning_summary_missing_text',
      object: 'response',
      created_at: 1710000000,
      status: 'completed',
      model: 'gpt-test',
      output: [{
        id: 'rs_missing_summary_text',
        type: 'reasoning',
        summary: [{ type: 'summary_text' }],
        content: []
      }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    })).rejects.toThrow('Responses reasoning summary entry missing text');
  });

  it('builds reasoning summary payloads through the native owner', () => {
    expect(buildResponsesSseReasoningSummaryPayloadWithNative(
      'part_added',
      1,
      'rs_1',
      0,
      'summary text'
    )).toEqual({
      output_index: 1,
      item_id: 'rs_1',
      summary_index: 0,
      part: { type: 'summary_text', text: '' }
    });

    expect(buildResponsesSseReasoningSummaryPayloadWithNative(
      'part_done',
      1,
      'rs_1',
      0,
      'summary text'
    )).toEqual({
      output_index: 1,
      item_id: 'rs_1',
      summary_index: 0,
      part: { type: 'summary_text', text: 'summary text' }
    });
  });

  it('projects reasoning delta payloads through the native owner', async () => {
    const events = await collectEvents({
      id: 'resp_reasoning_delta_native',
      object: 'response',
      created_at: 1710000000,
      status: 'completed',
      model: 'gpt-test',
      output: [{
        id: 'rs_delta_1',
        type: 'reasoning',
        summary: [],
        content: [
          { type: 'reasoning_text', text: 'think' },
          { type: 'reasoning_signature', signature: { ciphertext: 'sig_1' } },
          { type: 'reasoning_image', image_url: 'https://example.test/reasoning.png' }
        ]
      }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    });

    const reasoningTextDelta = events.find((event) => event.type === 'response.reasoning_text.delta');
    const reasoningSignatureDelta = events.find((event) => event.type === 'response.reasoning_signature.delta');
    const reasoningImageDelta = events.find((event) => event.type === 'response.reasoning_image.delta');

    expect(reasoningTextDelta?.data).toMatchObject({
      output_index: 0,
      item_id: 'rs_delta_1',
      content_index: 0,
      delta: 'think'
    });
    expect(reasoningSignatureDelta?.data).toMatchObject({
      output_index: 0,
      item_id: 'rs_delta_1',
      content_index: 1,
      signature: { ciphertext: 'sig_1' }
    });
    expect(reasoningImageDelta?.data).toMatchObject({
      output_index: 0,
      item_id: 'rs_delta_1',
      content_index: 2,
      image_url: 'https://example.test/reasoning.png'
    });
  });

  it('fails missing reasoning_text text instead of synthesizing a response.error event', async () => {
    await expect(collectEvents({
      id: 'resp_reasoning_missing_text',
      object: 'response',
      created_at: 1710000000,
      status: 'completed',
      model: 'gpt-test',
      output: [{
        id: 'rs_missing_text',
        type: 'reasoning',
        summary: [],
        content: [{ type: 'reasoning_text' }]
      }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    })).rejects.toThrow('Responses reasoning delta payload missing value');
  });

  it('builds reasoning delta payloads through the native owner directly', () => {
    expect(buildResponsesSseReasoningDeltaPayloadWithNative(
      'text',
      1,
      'rs_1',
      0,
      'think'
    )).toEqual({
      output_index: 1,
      item_id: 'rs_1',
      content_index: 0,
      delta: 'think'
    });

    expect(buildResponsesSseReasoningDeltaPayloadWithNative(
      'signature',
      1,
      'rs_1',
      1,
      { ciphertext: 'sig' }
    )).toEqual({
      output_index: 1,
      item_id: 'rs_1',
      content_index: 1,
      signature: { ciphertext: 'sig' }
    });

    expect(buildResponsesSseReasoningDeltaPayloadWithNative(
      'image',
      1,
      'rs_1',
      2,
      'https://img'
    )).toEqual({
      output_index: 1,
      item_id: 'rs_1',
      content_index: 2,
      image_url: 'https://img'
    });
  });
});
