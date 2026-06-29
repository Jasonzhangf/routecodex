import { describe, expect, it } from '@jest/globals';

import { ResponsesJsonToSseConverterRefactored } from '../../sharedmodule/llmswitch-core/src/sse/json-to-sse/responses-json-to-sse-converter.js';
import type { ResponsesResponse } from '../../sharedmodule/llmswitch-core/src/sse/types/index.js';

async function collectText(stream: AsyncIterable<unknown>): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
  }
  return chunks.join('');
}

describe('responses SSE usage no-fallback boundary', () => {
  it('omits missing usage instead of synthesizing zero-token usage', async () => {
    const converter = new ResponsesJsonToSseConverterRefactored();
    const response: ResponsesResponse = {
      id: 'resp_missing_usage',
      object: 'response',
      created_at: 1781149537,
      status: 'completed',
      model: 'gpt-5.5',
      output: []
    } as ResponsesResponse;

    const stream = await converter.convertResponseToJsonToSse(response, {
      requestId: 'req_responses_missing_usage'
    });
    const text = await collectText(stream);

    expect(text).toContain('event: response.completed');
    expect(text).toContain('event: response.done');
    expect(text).not.toContain('"usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}');
  });

  it('fails invalid usage instead of silently converting it to zero tokens', async () => {
    const converter = new ResponsesJsonToSseConverterRefactored();
    const response: ResponsesResponse = {
      id: 'resp_invalid_usage',
      object: 'response',
      created_at: 1781149537,
      status: 'completed',
      model: 'gpt-5.5',
      output: [],
      usage: {
        input_tokens: 'not-a-number',
        output_tokens: 1,
        total_tokens: 1
      }
    } as unknown as ResponsesResponse;

    const stream = await converter.convertResponseToJsonToSse(response, {
      requestId: 'req_responses_invalid_usage'
    });
    const text = await collectText(stream);

    expect(text).toContain('event: response.error');
    expect(text).toContain('Invalid Responses usage.input_tokens');
    expect(text).not.toContain('event: response.completed');
    expect(text).not.toContain('event: response.done');
  });

  it('fails missing created_at instead of synthesizing the current time', async () => {
    const converter = new ResponsesJsonToSseConverterRefactored();
    const response: ResponsesResponse = {
      id: 'resp_missing_created_at',
      object: 'response',
      status: 'completed',
      model: 'gpt-5.5',
      output: []
    } as ResponsesResponse;

    const stream = await converter.convertResponseToJsonToSse(response, {
      requestId: 'req_responses_missing_created_at'
    });
    const text = await collectText(stream);

    expect(text).toContain('event: response.error');
    expect(text).toContain('Invalid Responses response: missing created_at');
    expect(text).not.toContain('event: response.completed');
    expect(text).not.toContain('event: response.done');
  });
});
