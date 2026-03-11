import { describe, expect, it } from '@jest/globals';

import { runReqInboundStage1FormatParse } from '../index.js';

describe('req-inbound-stage1-format-parse native wrapper', () => {
  it('normalizes non-canonical chat reasoning before native format parse', async () => {
    const envelope = await runReqInboundStage1FormatParse({
      rawRequest: {
        model: 'gpt-test',
        messages: [
          {
            role: 'assistant',
            content: '<think>internal</think> visible answer'
          }
        ]
      } as any,
      adapterContext: {
        requestId: 'req-inbound-stage1-reasoning',
        providerProtocol: 'openai-chat'
      } as any,
    });

    expect(envelope.format).toBe('openai-chat');
    expect((envelope.payload as any).messages?.[0]?.content).toBe('visible answer');
  });
});
