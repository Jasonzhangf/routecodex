import { describe, it, expect } from '@jest/globals';
import { createGeminiSequencer } from '../json-to-sse/sequencers/gemini-sequencer.js';
import { GeminiSseToJsonConverter } from '../sse-to-json/gemini-sse-to-json-converter.js';
import type { GeminiResponse } from '../types/gemini-types.js';

async function collectSequencerEvents(response: GeminiResponse, mode: 'channel' | 'text' | 'drop') {
  const sequencer = createGeminiSequencer({
    reasoningMode: mode,
    reasoningTextPrefix: mode === 'text' ? 'Thought:' : undefined
  });
  const events = [];
  for await (const event of sequencer.sequenceResponse(response)) {
    events.push(event);
  }
  return events;
}

async function convertSseChunks(chunks: string[], options: { reasoningMode: 'channel' | 'text' | 'drop' }) {
  const converter = new GeminiSseToJsonConverter();
  const stream = (async function* () {
    for (const chunk of chunks) {
      yield chunk;
    }
  })();
  return converter.convertSseToJson(stream, {
    requestId: 'req_gemini_reasoning',
    reasoningMode: options.reasoningMode
  });
}

describe('Gemini SSE reasoning dispatcher', () => {
  it('applies reasoning mode when streaming JSON→SSE', async () => {
    const response: GeminiResponse = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { reasoning: 'internal chain-of-thought' },
              { text: 'Final answer' }
            ]
          }
        }
      ]
    };

    const textModeEvents = await collectSequencerEvents(response, 'text');
    const reasoningEvent = textModeEvents.find((evt) => evt.type === 'gemini.data' && (evt.data as any)?.part?.text);
    expect(reasoningEvent).toBeDefined();
    expect((reasoningEvent!.data as any).part.text).toContain('internal chain-of-thought');

    const channelModeEvents = await collectSequencerEvents(response, 'channel');
    const channelEvent = channelModeEvents.find((evt) => evt.type === 'gemini.data' && (evt.data as any)?.part?.reasoning);
    expect(channelEvent).toBeDefined();
    expect((channelEvent!.data as any).part.reasoning).toBe('internal chain-of-thought');
  });

  it('applies reasoning mode when aggregating SSE→JSON', async () => {
    const ssePayload = `event: gemini.data
data: {"kind":"part","candidateIndex":0,"partIndex":0,"role":"model","part":{"reasoning":"plan answer"}}

event: gemini.done
data: {"kind":"done"}
`;

    const textResponse = await convertSseChunks([ssePayload], { reasoningMode: 'text' });
    expect(textResponse.candidates?.[0]?.content?.parts?.[0]).toEqual({ text: 'plan answer' });

    const channelResponse = await convertSseChunks([ssePayload], { reasoningMode: 'channel' });
    expect(channelResponse.candidates?.[0]?.content?.parts?.[0]).toEqual({ reasoning: 'plan answer' });
  });
});
