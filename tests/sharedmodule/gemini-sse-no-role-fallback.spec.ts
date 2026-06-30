import { describe, expect, it } from '@jest/globals';

import { createGeminiSequencer } from '../../sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/gemini-sequencer.js';
import type { GeminiResponse } from '../../sharedmodule/llmswitch-core/src/sse/types/index.js';

async function collectEvents(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe('gemini SSE no-fallback boundary', () => {
  it('emits explicit Gemini data events for valid content parts', async () => {
    const response: GeminiResponse = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text: 'hello' }]
          },
          finishReason: 'STOP'
        }
      ]
    };

    const sequencer = createGeminiSequencer();
    const events = await collectEvents(sequencer.sequenceResponse(response));

    expect(events.every((event) => !Object.prototype.hasOwnProperty.call(event as object, 'sequenceNumber'))).toBe(true);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'gemini.data',
        data: expect.objectContaining({
          kind: 'part',
          candidateIndex: 0,
          partIndex: 0,
          role: 'model',
          part: { text: 'hello' }
        })
      }),
      expect.objectContaining({
        type: 'gemini.done',
        data: expect.objectContaining({
          kind: 'done',
          candidates: [expect.objectContaining({ index: 0, finishReason: 'STOP' })]
        })
      })
    ]));
  });

  it('throws when a candidate role is missing instead of defaulting to model', async () => {
    const response: GeminiResponse = {
      candidates: [
        {
          content: {
            parts: [{ text: 'hello' }]
          }
        }
      ]
    };

    const sequencer = createGeminiSequencer();
    const stream = sequencer.sequenceResponse(response);

    await expect(collectEvents(stream)).rejects.toThrow('Invalid Gemini candidate: missing role');
  });

  it('throws when a candidate content part is null instead of silently dropping it', async () => {
    const response: GeminiResponse = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [null as never]
          }
        }
      ]
    };

    const sequencer = createGeminiSequencer();
    const stream = sequencer.sequenceResponse(response);

    await expect(collectEvents(stream)).rejects.toThrow('Invalid Gemini candidate part at index 0');
  });
});
