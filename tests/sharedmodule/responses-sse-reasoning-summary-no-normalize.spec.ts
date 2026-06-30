import { describe, expect, it } from '@jest/globals';

import { sequenceResponse } from '../../sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/responses-sequencer.js';

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
    const summaryTextDone = events.find((event) => event.type === 'response.reasoning_summary_text.done');
    const payloadText = JSON.stringify(events);

    expect(outputItemDone?.data?.item?.summary).toEqual([{ type: 'summary_text', text: rawSummary }]);
    expect(summaryTextDone?.data?.text).toBe(rawSummary);
    expect(payloadText).not.toContain('**Thinking**');
    expect(payloadText).toContain('- inspect `file.ts`');
    expect(payloadText).toContain('> keep quoted detail');
  });
});
