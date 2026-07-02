import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';

import { createChatSequencer } from '../../sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/chat-sequencer.js';
import type { ChatCompletionResponse } from '../../sharedmodule/llmswitch-core/src/sse/types/index.js';
import { buildChatSseEventSequenceWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-sse-event-payload.js';

async function collectEvents(response: ChatCompletionResponse): Promise<any[]> {
  const sequencer = createChatSequencer({
    enableTimestampGeneration: false,
    includeSequenceNumbers: true,
    chunkDelayMs: 0
  });
  const events: any[] = [];
  for await (const event of sequencer.sequenceResponse(response, response.model, 'req_chat_sse_parity')) {
    events.push(event);
  }
  return events;
}

function nativeEvents(response: ChatCompletionResponse): any[] {
  return buildChatSseEventSequenceWithNative({
    response,
    model: response.model,
    requestId: 'req_chat_sse_parity',
    config: {
      enableTimestampGeneration: false,
      includeSequenceNumbers: true,
      chunkDelayMs: 0,
      reasoningMode: 'channel'
    }
  });
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

    const tsEvents = await collectEvents(response);
    const rustEvents = nativeEvents(response);

    expect(parsePayloads(tsEvents)).toEqual(parsePayloads(rustEvents));
    expect(tsEvents.map((event) => event.event)).toEqual([
      'chat_chunk',
      'chat_chunk',
      'chat_chunk',
      'chat_chunk',
      'chat_chunk',
      'chat_chunk',
      'chat.done'
    ]);
    expect(JSON.stringify(tsEvents)).not.toContain('metadata');
    expect(JSON.stringify(tsEvents)).not.toContain('__rt');
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

    await expect(collectEvents(response)).rejects.toThrow('missing finish_reason');
    expect(() => nativeEvents(response)).toThrow('missing finish_reason');
  });

  it('keeps chat sequencer as a native wrapper instead of TS semantic owner', () => {
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/chat-sequencer.ts',
      'utf8'
    );

    expect(source).toContain('buildChatSseEventSequenceWithNative');
    expect(source).not.toContain('normalizeMessageReasoningTools(');
    expect(source).not.toContain('normalizeChatMessageContent(');
    expect(source).not.toContain('dispatchReasoning(');
  });
});
