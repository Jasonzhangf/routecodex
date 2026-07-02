import { describe, expect, it } from '@jest/globals';

import { createGeminiSequencer } from '../../sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/gemini-sequencer.js';
import { buildGeminiSseEventSequenceWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-gemini-sse-event-payload.js';
import type { GeminiResponse } from '../../sharedmodule/llmswitch-core/src/sse/types/index.js';

async function collectEvents(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe('Gemini JSON to SSE Rust parity boundary', () => {
  it('matches native sequence for valid text response', async () => {
    const response: GeminiResponse = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text: 'hello' }, { text: ' world' }]
          },
          finishReason: 'STOP',
          safetyRatings: [{ category: 'HARM_CATEGORY_DEROGATORY', probability: 'NEGLIGIBLE' }]
        }
      ],
      usageMetadata: {
        promptTokenCount: 1,
        candidatesTokenCount: 2,
        totalTokenCount: 3
      },
      modelVersion: 'gemini-test'
    };

    const sequencer = createGeminiSequencer();
    const tsEvents = await collectEvents(sequencer.sequenceResponse(response));
    const nativeEvents = buildGeminiSseEventSequenceWithNative({
      response,
      config: {
        reasoningMode: 'channel'
      }
    });

    expect(tsEvents).toEqual(nativeEvents);
    expect(tsEvents).toEqual([
      expect.objectContaining({
        type: 'gemini.data',
        event: 'gemini.data',
        protocol: 'gemini-chat',
        direction: 'json_to_sse',
        data: {
          kind: 'part',
          candidateIndex: 0,
          partIndex: 0,
          role: 'model',
          part: { text: 'hello' }
        }
      }),
      expect.objectContaining({
        type: 'gemini.data',
        data: expect.objectContaining({
          partIndex: 1,
          part: { text: ' world' }
        })
      }),
      expect.objectContaining({
        type: 'gemini.done',
        data: expect.objectContaining({
          kind: 'done',
          usageMetadata: response.usageMetadata,
          modelVersion: 'gemini-test',
          candidates: [
            expect.objectContaining({
              index: 0,
              finishReason: 'STOP',
              safetyRatings: response.candidates?.[0]?.safetyRatings
            })
          ]
        })
      })
    ]);
  });

  it('keeps Gemini reasoning normalization native-owned', async () => {
    const response: GeminiResponse = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ reasoning: 'hidden chain' } as never]
          },
          finishReason: 'STOP'
        }
      ]
    };

    const sequencer = createGeminiSequencer({
      reasoningMode: 'text',
      reasoningTextPrefix: '[thought] '
    });
    const tsEvents = await collectEvents(sequencer.sequenceResponse(response));
    const nativeEvents = buildGeminiSseEventSequenceWithNative({
      response,
      config: {
        reasoningMode: 'text',
        reasoningTextPrefix: '[thought] '
      }
    });

    expect(tsEvents).toEqual(nativeEvents);
    expect(tsEvents[0]).toEqual(expect.objectContaining({
      type: 'gemini.data',
      data: expect.objectContaining({
        part: { text: '[thought] hidden chain' }
      })
    }));
  });

  it('fails fast through native when candidate role is missing', async () => {
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
    await expect(collectEvents(sequencer.sequenceResponse(response))).rejects.toThrow(
      'Invalid Gemini candidate: missing role'
    );
    expect(() => buildGeminiSseEventSequenceWithNative({ response })).toThrow(
      'Invalid Gemini candidate: missing role'
    );
  });
});
