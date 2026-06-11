import { describe, expect, it } from '@jest/globals';
import { ResponsesJsonToSseConverterRefactored } from '../../sharedmodule/llmswitch-core/src/sse/json-to-sse/responses-json-to-sse-converter.js';

async function readStreamBody(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function readCompletedUsage(sse: string): Record<string, unknown> | undefined {
  for (const block of sse.split('\n\n')) {
    if (!block.includes('event: response.completed')) {
      continue;
    }
    const dataLine = block
      .split('\n')
      .find((line) => line.startsWith('data: '));
    if (!dataLine) {
      continue;
    }
    const parsed = JSON.parse(dataLine.slice('data: '.length));
    return parsed?.response?.usage;
  }
  return undefined;
}

describe('Responses JSON to SSE usage projection', () => {
  it('projects upstream Responses usage into response.completed', async () => {
    const converter = new ResponsesJsonToSseConverterRefactored();
    const stream = await converter.convertResponseToJsonToSse({
      id: 'resp_1token_usage',
      object: 'response',
      created_at: 1781149537,
      status: 'completed',
      model: 'gpt-5.4-mini',
      output: [],
      usage: {
        input_tokens: 56863,
        input_tokens_details: { cached_tokens: 54272 },
        output_tokens: 608,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 57471
      }
    } as any, {
      requestId: 'req_1token_usage_projection',
      model: 'gpt-5.4-mini'
    });

    const body = await readStreamBody(stream);
    const usage = readCompletedUsage(body);

    expect(usage).toEqual({
      input_tokens: 56863,
      output_tokens: 608,
      total_tokens: 57471,
      input_tokens_details: { cached_tokens: 54272 }
    });
  });

  it('does not add cached_tokens into input_tokens or fabricate total_tokens', async () => {
    const converter = new ResponsesJsonToSseConverterRefactored();
    const stream = await converter.convertResponseToJsonToSse({
      id: 'resp_cached_not_added',
      object: 'response',
      created_at: 1781149537,
      status: 'completed',
      model: 'gpt-5.4-mini',
      output: [],
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 90 },
        output_tokens: 5,
        total_tokens: 105
      }
    } as any, {
      requestId: 'req_cached_not_added',
      model: 'gpt-5.4-mini'
    });

    const body = await readStreamBody(stream);
    const usage = readCompletedUsage(body);

    expect(usage?.input_tokens).toBe(100);
    expect(usage?.total_tokens).toBe(105);
    expect(usage?.input_tokens_details).toEqual({ cached_tokens: 90 });
  });
});
