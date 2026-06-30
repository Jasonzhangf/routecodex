import { describe, expect, it } from '@jest/globals';

import { ResponsesJsonToSseConverterRefactored } from '../../sharedmodule/llmswitch-core/src/sse/json-to-sse/responses-json-to-sse-converter.js';
import { planResponsesSseErrorRecoveryWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-responses-sse-event-payload.js';
import type { ResponsesResponse } from '../../sharedmodule/llmswitch-core/src/sse/types/index.js';

async function collectText(stream: AsyncIterable<unknown>): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
  }
  return chunks.join('');
}

describe('responses SSE usage no-fallback boundary', () => {
  it('plans response-level error projection through the native owner', () => {
    expect(planResponsesSseErrorRecoveryWithNative({
      scope: 'response',
      message: 'Invalid Responses usage.input_tokens'
    })).toEqual({ action: 'emit_response_error' });

    expect(planResponsesSseErrorRecoveryWithNative({
      scope: 'output_item',
      message: 'Unknown output item type'
    })).toEqual({ action: 'throw' });
  });

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

  it('rejects legacy prompt_tokens aliases instead of normalizing them', async () => {
    const converter = new ResponsesJsonToSseConverterRefactored();
    const response: ResponsesResponse = {
      id: 'resp_legacy_usage_alias',
      object: 'response',
      created_at: 1781149537,
      status: 'completed',
      model: 'gpt-5.5',
      output: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15
      } as unknown as ResponsesResponse['usage']
    } as ResponsesResponse;

    const stream = await converter.convertResponseToJsonToSse(response, {
      requestId: 'req_responses_legacy_usage_alias'
    });
    const text = await collectText(stream);

    expect(text).toContain('event: response.error');
    expect(text).toContain('Invalid Responses usage: missing token fields');
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

  it('fails missing status instead of synthesizing completed terminal status', async () => {
    const converter = new ResponsesJsonToSseConverterRefactored();
    const response: ResponsesResponse = {
      id: 'resp_missing_status',
      object: 'response',
      created_at: 1781149537,
      model: 'gpt-5.5',
      output: []
    } as ResponsesResponse;

    const stream = await converter.convertResponseToJsonToSse(response, {
      requestId: 'req_responses_missing_status'
    });
    const text = await collectText(stream);

    expect(text).toContain('event: response.error');
    expect(text).toContain('Invalid Responses response: missing status');
    expect(text).not.toContain('event: response.completed');
    expect(text).not.toContain('event: response.done');
  });

  it('does not recover an invalid output item and continue to completed', async () => {
    const converter = new ResponsesJsonToSseConverterRefactored();
    const response: ResponsesResponse = {
      id: 'resp_invalid_output_item',
      object: 'response',
      created_at: 1781149537,
      status: 'completed',
      model: 'gpt-5.5',
      output: [{ id: 'weird_1', type: 'unknown_item' }]
    } as unknown as ResponsesResponse;

    const stream = await converter.convertResponseToJsonToSse(response, {
      requestId: 'req_responses_invalid_output_item'
    });
    const text = await collectText(stream);

    expect(text).toContain('event: response.error');
    expect(text).toContain('Unknown output item type: unknown_item');
    expect(text).not.toContain('event: response.completed');
    expect(text).not.toContain('event: response.done');
  });
});
