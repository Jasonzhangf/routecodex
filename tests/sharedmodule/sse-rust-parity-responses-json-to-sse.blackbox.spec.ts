import { describe, expect, it } from '@jest/globals';

import { ResponsesJsonToSseConverterRefactored } from '../../sharedmodule/llmswitch-core/src/sse/json-to-sse/responses-json-to-sse-converter.js';
import type { ResponsesResponse } from '../../sharedmodule/llmswitch-core/src/sse/types/index.js';

type ParsedSseFrame = {
  event: string;
  data: unknown;
};

async function collectWire(response: ResponsesResponse): Promise<string> {
  const converter = new ResponsesJsonToSseConverterRefactored();
  const stream = await converter.convertResponseToJsonToSse(response, {
    requestId: 'req_responses_sse_parity',
    model: response.model,
    chunkSize: 0
  });

  const chunks: string[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => chunks.push(String(chunk)));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return chunks.join('');
}

function parseFrames(wire: string): ParsedSseFrame[] {
  return wire
    .split(/\n\n/)
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => {
      const eventLine = frame.split('\n').find((line) => line.startsWith('event: '));
      const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
      if (!eventLine || !dataLine) {
        throw new Error(`Invalid SSE frame: ${frame}`);
      }
      return {
        event: eventLine.slice('event: '.length),
        data: JSON.parse(dataLine.slice('data: '.length))
      };
    });
}

async function collectFrames(response: ResponsesResponse): Promise<ParsedSseFrame[]> {
  return parseFrames(await collectWire(response));
}

function completedTextResponse(): ResponsesResponse {
  return {
    id: 'resp_text_parity',
    object: 'response',
    created_at: 1781149537,
    status: 'completed',
    model: 'gpt-test',
    output: [
      {
        id: 'msg_text_1',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: 'hello responses'
          }
        ]
      }
    ],
    usage: {
      input_tokens: 3,
      output_tokens: 2,
      total_tokens: 5,
      input_tokens_details: {
        cached_tokens: 0,
        audio_tokens: 0,
        text_tokens: 3,
        image_tokens: 0
      },
      output_tokens_details: {
        reasoning_tokens: 0,
        audio_tokens: 0,
        text_tokens: 2
      }
    }
  };
}

describe('Responses JSON to SSE Rust parity boundary', () => {
  it('projects completed output text with stable client-visible event order and no metadata leakage', async () => {
    const frames = await collectFrames(completedTextResponse());

    expect(frames.map((frame) => frame.event)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
      'response.done'
    ]);
    expect(frames[4].data).toMatchObject({
      type: 'response.output_text.delta',
      output_index: 0,
      item_id: 'msg_text_1',
      content_index: 0,
      delta: 'hello responses'
    });
    expect(JSON.stringify(frames)).not.toContain('metadata');
    expect(JSON.stringify(frames)).not.toContain('__rt');
  });

  it('projects function call arguments before terminal completion without synthesizing required_action', async () => {
    const frames = await collectFrames({
      id: 'resp_tool_parity',
      object: 'response',
      created_at: 1781149537,
      status: 'completed',
      model: 'gpt-test',
      output: [
        {
          id: 'fc_tool_1',
          type: 'function_call',
          status: 'completed',
          call_id: 'call_tool_1',
          name: 'exec_command',
          arguments: '{"cmd":"pwd"}'
        }
      ]
    });

    expect(frames.map((frame) => frame.event)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed',
      'response.done'
    ]);
    expect(JSON.stringify(frames)).toContain('"name":"exec_command"');
    expect(frames.map((frame) => frame.event)).not.toContain('response.required_action');
  });

  it('projects reasoning summary events from finalized reasoning truth', async () => {
    const frames = await collectFrames({
      id: 'resp_reasoning_parity',
      object: 'response',
      created_at: 1781149537,
      status: 'completed',
      model: 'gpt-test',
      output: [
        {
          id: 'rs_reason_1',
          type: 'reasoning',
          summary: [
            {
              type: 'summary_text',
              text: 'short reasoning summary'
            }
          ]
        }
      ]
    });

    expect(frames.map((frame) => frame.event)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.reasoning_summary_part.added',
      'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.done',
      'response.reasoning_summary_part.done',
      'response.output_item.done',
      'response.completed',
      'response.done'
    ]);
    expect(JSON.stringify(frames)).toContain('short reasoning summary');
  });

  it('fails fast when created_at is missing instead of emitting terminal success', async () => {
    const response = completedTextResponse() as unknown as Record<string, unknown>;
    delete response.created_at;

    await expect(collectWire(response as unknown as ResponsesResponse)).rejects.toThrow('missing created_at');
  });

  it('fails fast when response status is missing instead of emitting terminal success', async () => {
    const response = completedTextResponse() as unknown as Record<string, unknown>;
    delete response.status;

    await expect(collectWire(response as unknown as ResponsesResponse)).rejects.toThrow('missing status');
  });
});
