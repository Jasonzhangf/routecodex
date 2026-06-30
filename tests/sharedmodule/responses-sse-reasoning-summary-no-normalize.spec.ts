import { describe, expect, it } from '@jest/globals';

import { sequenceResponse } from '../../sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/responses-sequencer.js';
import { normalizeResponsesSseReasoningSummaryWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-responses-sse-event-payload.js';
import { buildResponsesSseReasoningSummaryPayloadWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-responses-sse-event-payload.js';
import { buildResponsesSseReasoningDeltaPayloadWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-responses-sse-event-payload.js';

async function collectEvents(response: any): Promise<any[]> {
  const events: any[] = [];
  const context = {
    requestId: 'req_reasoning_summary_no_normalize',
    sequenceNumber: 0,
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
    maxContentParts: 10
  } as any)) {
    events.push(event);
  }
  return events;
}

describe('responses SSE reasoning summary no-normalize boundary', () => {
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
