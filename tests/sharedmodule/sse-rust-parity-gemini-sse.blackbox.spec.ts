import { describe, expect, it } from '@jest/globals';

import { createGeminiSequencer } from '../../sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/gemini-sequencer.js';
import {
  buildGeminiJsonFromSseWithNative,
  buildGeminiSseEventSequenceWithNative
} from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-gemini-sse-event-payload.js';
import { GeminiSseToJsonConverter } from '../../sharedmodule/llmswitch-core/src/sse/sse-to-json/gemini-sse-to-json-converter.js';
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

describe('Gemini SSE to JSON Rust parity boundary', () => {
  it('materializes Gemini text and done frames through native decoder', async () => {
    const bodyText = [
      'event: gemini.data',
      'data: {"type":"gemini.data","protocol":"gemini-chat","direction":"json_to_sse","data":{"kind":"part","candidateIndex":0,"partIndex":0,"role":"model","part":{"text":"hello"}}}',
      '',
      'event: gemini.data',
      'data: {"type":"gemini.data","protocol":"gemini-chat","direction":"json_to_sse","data":{"kind":"part","candidateIndex":0,"partIndex":1,"role":"model","part":{"text":" world"}}}',
      '',
      'event: gemini.done',
      'data: {"type":"gemini.done","protocol":"gemini-chat","direction":"json_to_sse","data":{"kind":"done","usageMetadata":{"totalTokenCount":3},"modelVersion":"gemini-test","candidates":[{"index":0,"finishReason":"STOP"}]}}',
      '',
      ''
    ].join('\n');
    const converter = new GeminiSseToJsonConverter();

    const tsJson = await converter.convertSseToJson([bodyText], {
      requestId: 'req_gemini_decode_text',
      model: 'gemini-test'
    });
    const nativeJson = buildGeminiJsonFromSseWithNative({
      bodyText,
      requestId: 'req_gemini_decode_text',
      model: 'gemini-test'
    });

    expect(tsJson).toEqual(nativeJson);
    expect(tsJson).toEqual({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text: 'hello world' }]
          },
          finishReason: 'STOP'
        }
      ],
      promptFeedback: undefined,
      usageMetadata: { totalTokenCount: 3 },
      modelVersion: 'gemini-test'
    });
  });

  it('keeps Gemini SSE reasoning decode native-owned', async () => {
    const bodyText = [
      'event: gemini.data',
      'data: {"type":"gemini.data","protocol":"gemini-chat","direction":"json_to_sse","data":{"kind":"part","candidateIndex":0,"partIndex":0,"role":"model","part":{"reasoning":"hidden"}}}',
      '',
      'event: gemini.done',
      'data: {"type":"gemini.done","protocol":"gemini-chat","direction":"json_to_sse","data":{"kind":"done","candidates":[{"index":0,"finishReason":"STOP"}]}}',
      '',
      ''
    ].join('\n');
    const converter = new GeminiSseToJsonConverter();

    const tsJson = await converter.convertSseToJson([bodyText], {
      requestId: 'req_gemini_decode_reasoning',
      model: 'gemini-test',
      reasoningMode: 'text',
      reasoningTextPrefix: '[thought]'
    });
    const nativeJson = buildGeminiJsonFromSseWithNative({
      bodyText,
      requestId: 'req_gemini_decode_reasoning',
      model: 'gemini-test',
      config: {
        reasoningMode: 'text',
        reasoningTextPrefix: '[thought]'
      }
    });

    expect(tsJson).toEqual(nativeJson);
    expect(tsJson.candidates?.[0]?.content?.parts).toEqual([{ text: '[thought] hidden' }]);
  });

  it('fails fast through native when Gemini done frame is missing', async () => {
    const bodyText = [
      'event: gemini.data',
      'data: {"type":"gemini.data","protocol":"gemini-chat","direction":"json_to_sse","data":{"kind":"part","candidateIndex":0,"partIndex":0,"role":"model","part":{"text":"hello"}}}',
      '',
      ''
    ].join('\n');
    const converter = new GeminiSseToJsonConverter();

    await expect(converter.convertSseToJson([bodyText], {
      requestId: 'req_gemini_decode_missing_done',
      model: 'gemini-test'
    })).rejects.toThrow('Gemini SSE stream missing done event');
    expect(() => buildGeminiJsonFromSseWithNative({
      bodyText,
      requestId: 'req_gemini_decode_missing_done',
      model: 'gemini-test'
    })).toThrow('Gemini SSE stream missing done event');
  });
});
