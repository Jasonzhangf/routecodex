import { describe, expect, it } from '@jest/globals';
import path from "path";
import fs from 'node:fs';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const nativeBinding = nodeRequire(
  path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node')
) as Record<string, unknown>;
const buildChatSseEventSequenceJson = nativeBinding.buildChatSseEventSequenceJson as (inputJson: string) => unknown;

type ChatCompletionResponse = Record<string, unknown> & {
  model: string;
};

function nativeEvents(response: ChatCompletionResponse): any[] {
  const raw = buildChatSseEventSequenceJson(JSON.stringify({
    response,
    model: response.model,
    request_id: 'req_chat_sse_parity',
    config: {
      enableTimestampGeneration: false,
      includeSequenceNumbers: true,
      chunkDelayMs: 0,
      reasoningMode: 'channel'
    },
  }));
  if (typeof raw === 'object' && raw !== null && 'message' in raw) {
    throw new Error(String((raw as { message: unknown }).message));
  }
  if (typeof raw === 'string' && raw.startsWith('Error: ')) {
    throw new Error(raw);
  }
  return JSON.parse(String(raw));
}

function parsePayloads(events: any[]): unknown[] {
  return events.map((event) => event.data === '[DONE]' ? '[DONE]' : JSON.parse(event.data));
}

describe('chat JSON to SSE Rust parity boundary', () => {
  it('projects text, reasoning, tool call, finish, and done frames through the native sequence owner', async () => {
    const response: ChatCompletionResponse = {
      id: 'chatcmpl_chat_sse_parity',
      object: 'chat.completion',
      created: 1781149537,
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: 'visible answer',
            reasoning_content: 'private plan',
            tool_calls: [
              {
                id: 'call_weather',
                type: 'function',
                function: {
                  name: 'get_weather',
                  arguments: '{"city":"SF"}'
                }
              }
            ]
          }
        }
      ],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
    };

    const rustEvents = nativeEvents(response);
    const payloads = parsePayloads(rustEvents) as any[];

    expect(rustEvents.map((event) => event.event)).toEqual([
      'chat_chunk',
      'chat_chunk',
      'chat_chunk',
      'chat_chunk',
      'chat_chunk',
      'chat_chunk',
      'chat.done'
    ]);
    expect(payloads[0].choices[0].delta).toEqual({ role: 'assistant' });
    expect(payloads[1].choices[0].delta).toEqual({
      reasoning: 'private plan',
      reasoning_content: 'private plan'
    });
    expect(payloads[2].choices[0].delta).toEqual({ content: 'visible answer' });
    expect(payloads[3].choices[0].delta.tool_calls[0]).toEqual({
      function: {
        arguments: '',
        name: 'get_weather'
      },
      id: 'call_weather',
      index: 0,
      type: 'function'
    });
    expect(payloads[4].choices[0].delta.tool_calls[0]).toEqual({
      function: {
        arguments: '{"city":"SF"}'
      },
      index: 0
    });
    expect(payloads[5].choices[0].finish_reason).toBe('tool_calls');
    expect(payloads[5].usage).toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
    expect(payloads[6]).toBe('[DONE]');
    expect(JSON.stringify(rustEvents)).not.toContain('metadata');
    expect(JSON.stringify(rustEvents)).not.toContain('__rt');
  });

  it('fails missing finish_reason instead of synthesizing terminal success', async () => {
    const response = {
      id: 'chatcmpl_chat_sse_missing_finish',
      object: 'chat.completion',
      created: 1781149537,
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'incomplete' }
        }
      ]
    } as unknown as ChatCompletionResponse;

    expect(() => nativeEvents(response)).toThrow('missing finish_reason');
  });

  it('keeps chat SSE projection on the Rust NAPI owner without the retired TS wrapper', () => {
    expect(typeof buildChatSseEventSequenceJson).toBe('function');
    expect(fs.existsSync(
      path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-sse-event-payload.ts')
    )).toBe(false);
  });
});
