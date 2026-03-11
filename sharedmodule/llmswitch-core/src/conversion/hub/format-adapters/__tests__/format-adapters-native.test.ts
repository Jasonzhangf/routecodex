import { describe, expect, it } from '@jest/globals';

import { ChatFormatAdapter } from '../chat-format-adapter.js';
import { ResponsesFormatAdapter } from '../responses-format-adapter.js';

describe('hub format adapters native reasoning entrypoints', () => {
  it('chat parseRequest normalizes non-canonical reasoning through req native helper', async () => {
    const adapter = new ChatFormatAdapter();
    const envelope = await adapter.parseRequest(
      {
        model: 'gpt-test',
        messages: [
          {
            role: 'assistant',
            content: '<think>internal</think> visible answer'
          }
        ]
      } as any,
      {
        requestId: 'format-adapter-chat-request',
        providerProtocol: 'openai-chat'
      } as any
    );

    expect(envelope.protocol).toBe('openai-chat');
    expect(envelope.direction).toBe('request');
    expect((envelope.payload as any).messages?.[0]?.content).toBe('visible answer');
  });

  it('responses parseResponse normalizes non-canonical reasoning through resp native helper', async () => {
    const adapter = new ResponsesFormatAdapter();
    const envelope = await adapter.parseResponse(
      {
        id: 'resp-test',
        object: 'response',
        model: 'gpt-test',
        output: [
          {
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: '<think>internal</think> visible answer'
              }
            ]
          }
        ]
      } as any,
      {
        requestId: 'format-adapter-responses-response',
        providerProtocol: 'openai-responses'
      } as any
    );

    expect(envelope.protocol).toBe('openai-responses');
    expect(envelope.direction).toBe('response');
    const outputItems = (envelope.payload as any).output ?? [];
    const messageItem = outputItems.find((item: any) => item?.type === 'message');
    const reasoningItem = outputItems.find((item: any) => item?.type === 'reasoning');

    expect(messageItem?.content?.[0]?.text).toBe('visible answer');
    expect(reasoningItem?.content?.[0]?.text).toBe('internal');
  });
});
