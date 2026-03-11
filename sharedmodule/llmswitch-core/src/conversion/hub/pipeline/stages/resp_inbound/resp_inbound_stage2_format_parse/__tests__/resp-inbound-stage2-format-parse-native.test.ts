import { describe, expect, it } from '@jest/globals';

import { runRespInboundStage2FormatParse } from '../index.js';

describe('resp-inbound-stage2-format-parse native wrapper', () => {
  it('normalizes non-canonical chat reasoning before native format parse', async () => {
    const envelope = await runRespInboundStage2FormatParse({
      payload: {
        id: 'chatcmpl-test',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '<think>internal</think> visible answer'
            }
          }
        ]
      } as any,
      adapterContext: {
        requestId: 'resp-inbound-stage2-reasoning',
        providerProtocol: 'openai-chat'
      } as any
    });

    expect(envelope.protocol).toBe('openai-chat');
    expect(envelope.direction).toBe('response');
    expect((envelope.payload as any).choices?.[0]?.message?.content).toBe('visible answer');
  });
});
