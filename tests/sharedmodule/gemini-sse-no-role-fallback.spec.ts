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
});
