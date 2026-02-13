import { describe, expect, it } from '@jest/globals';
import { ResponsesSemanticMapper } from '../../sharedmodule/llmswitch-core/src/conversion/hub/semantic-mappers/responses-mapper.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import { buildResponsesPayloadFromChat } from '../../sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.js';
import { registerResponsesPayloadSnapshot } from '../../sharedmodule/llmswitch-core/src/conversion/shared/responses-reasoning-registry.js';

describe('responses same-protocol field transparency', () => {
  it('preserves prompt_cache_key and reasoning through semantic mapper', async () => {
    const mapper = new ResponsesSemanticMapper();
    const ctx: AdapterContext = {
      requestId: 'req-responses-transparency-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    };

    const inboundPayload = {
      model: 'gpt-test',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      prompt_cache_key: 'cache-key-1',
      reasoning: { effort: 'high' },
      service_tier: 'default',
      truncation: 'disabled',
      include: ['output_text'],
      store: true,
      temperature: 0.4,
      top_p: 0.95
    };

    const chat = await mapper.toChat(
      {
        protocol: 'openai-responses',
        direction: 'request',
        payload: inboundPayload
      } as any,
      ctx
    );

    expect((chat.parameters as any).prompt_cache_key).toBe('cache-key-1');
    expect((chat.parameters as any).reasoning).toEqual({ effort: 'high' });
    expect((chat.parameters as any).service_tier).toBe('default');
    expect((chat.parameters as any).truncation).toBe('disabled');
    expect((chat.parameters as any).include).toEqual(['output_text']);
    expect((chat.parameters as any).store).toBe(true);

    const outbound = await mapper.fromChat(chat, ctx);
    expect((outbound.payload as any).prompt_cache_key).toBe('cache-key-1');
    expect((outbound.payload as any).reasoning).toEqual({ effort: 'high' });
    expect((outbound.payload as any).service_tier).toBe('default');
     expect((outbound.payload as any).truncation).toBe('disabled');
     expect((outbound.payload as any).include).toEqual(['output_text']);
     expect((outbound.payload as any).store).toBe(true);
      // temperature/top_p are filtered for openai-responses providers (HTTP 400 prevention)
      expect((outbound.payload as any).temperature).toBeUndefined();
      expect((outbound.payload as any).top_p).toBeUndefined();
   });

  it('retains responses top-level fields and output detail from snapshot', () => {
    const requestId = 'req-responses-transparency-2';
    registerResponsesPayloadSnapshot(requestId, {
      id: 'resp_source_1',
      object: 'response',
      model: 'gpt-test',
      status: 'completed',
      temperature: 0.3,
      top_p: 0.9,
      prompt_cache_key: 'cache-key-snapshot',
      reasoning: { effort: 'medium' },
      metadata: { tenant: 'alpha' },
      output: [
        {
          id: 'resp_source_1-message-0_reasoning',
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'summary-1' }],
          content: [{ type: 'reasoning_text', text: 'reasoning-1' }]
        },
        {
          id: 'resp_source_1-message-0',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '正文内容' }]
        }
      ]
    });

    const chatLikePayload = {
      id: 'resp_source_1',
      created: 123,
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: '正文内容',
            reasoning_content: 'reasoning-1'
          }
        }
      ]
    };

    const remapped = buildResponsesPayloadFromChat(chatLikePayload, {
      requestId
    } as any) as any;

    expect(remapped.object).toBe('response');
    expect(remapped.temperature).toBe(0.3);
    expect(remapped.top_p).toBe(0.9);
    expect(remapped.prompt_cache_key).toBe('cache-key-snapshot');
    expect(remapped.reasoning).toEqual({ effort: 'medium' });
    expect(remapped.metadata).toEqual({ tenant: 'alpha' });

    const messageItem = (remapped.output as any[]).find((item) => item?.type === 'message');
    expect(messageItem).toBeDefined();
    expect(Array.isArray(messageItem.content)).toBe(true);

    const reasoningItem = (remapped.output as any[]).find((item) => item?.type === 'reasoning');
    expect(reasoningItem).toBeDefined();
    expect(reasoningItem.summary).toEqual([{ type: 'summary_text', text: 'summary-1' }]);
  });
});
