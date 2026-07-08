import { describe, expect, it } from '@jest/globals';
import path from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const nativeBinding = nodeRequire(
  path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node')
) as Record<string, unknown>;
const buildGeminiSseEventSequenceJson = nativeBinding.buildGeminiSseEventSequenceJson as (inputJson: string) => unknown;

type GeminiResponse = {
  candidates?: unknown[];
};

describe('gemini SSE no-fallback boundary', () => {
  function directNativeGeminiEvents(input: { response: unknown }): unknown[] {
    const raw = buildGeminiSseEventSequenceJson(JSON.stringify(input));
    if (typeof raw === 'object' && raw !== null && 'message' in raw) {
      throw new Error(String((raw as { message: unknown }).message));
    }
    if (typeof raw === 'string' && raw.startsWith('Error: ')) {
      throw new Error(raw);
    }
    return JSON.parse(String(raw));
  }

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

    const events = directNativeGeminiEvents({response});

    expect(events.every((event) => !Object.prototype.hasOwnProperty.call(event as object, 'sequenceNumber'))).toBe(true);
    expect(events.every((event) => !Object.prototype.hasOwnProperty.call(event as object, 'timestamp'))).toBe(true);
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


    expect(() => directNativeGeminiEvents({ response })).toThrow('Invalid Gemini candidate: missing role');
  });

  it('throws when response candidates are missing instead of emitting an empty done event', async () => {
    const response: GeminiResponse = {
      candidates: undefined
    };


    expect(() => directNativeGeminiEvents({ response })).toThrow('Invalid Gemini response: missing candidates');
  });

  it('throws when a candidate is null instead of coercing it into an empty object', async () => {
    const response: GeminiResponse = {
      candidates: [null as never]
    };


    expect(() => directNativeGeminiEvents({ response })).toThrow('Invalid Gemini candidate at index 0');
  });

  it('throws when candidate parts are missing instead of emitting only a done event', async () => {
    const response: GeminiResponse = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: undefined
          }
        }
      ]
    };


    expect(() => directNativeGeminiEvents({ response })).toThrow('Invalid Gemini candidate: missing parts');
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


    expect(() => directNativeGeminiEvents({ response })).toThrow('Invalid Gemini candidate part at index 0');
  });

  it('throws when a candidate content part is scalar instead of emitting it as a part', async () => {
    const response: GeminiResponse = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: ['hello' as never]
          }
        }
      ]
    };


    expect(() => directNativeGeminiEvents({ response })).toThrow('Invalid Gemini candidate part at index 0');
  });
});
