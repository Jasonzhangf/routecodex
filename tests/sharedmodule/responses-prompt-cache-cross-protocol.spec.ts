import { describe, expect, it } from '@jest/globals';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import { ResponsesSemanticMapper } from '../../sharedmodule/llmswitch-core/src/conversion/hub/semantic-mappers/responses-mapper.js';
import { AnthropicSemanticMapper } from '../../sharedmodule/llmswitch-core/src/conversion/hub/semantic-mappers/anthropic-mapper.js';
import { GeminiSemanticMapper } from '../../sharedmodule/llmswitch-core/src/conversion/hub/semantic-mappers/gemini-mapper.js';

function createResponsesContext(requestId: string): AdapterContext {
  return {
    requestId,
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses'
  };
}

describe('responses prompt_cache_key cross protocol policy', () => {
  it('drops prompt_cache_key for anthropic and writes mapping audit', async () => {
    const responsesMapper = new ResponsesSemanticMapper();
    const anthropicMapper = new AnthropicSemanticMapper();
    const ctx = createResponsesContext('req-resp-anthropic-pcache');

    const chat = await responsesMapper.toChat(
      {
        protocol: 'openai-responses',
        direction: 'request',
        payload: {
          model: 'claude-sonnet-4-5',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
          prompt_cache_key: 'cache-key-123'
        }
      } as any,
      ctx
    );

    const outbound = await anthropicMapper.fromChat(chat, {
      requestId: 'req-resp-anthropic-out-pcache',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages'
    } as AdapterContext);

    const payload = outbound.payload as any;
    expect(payload.prompt_cache_key).toBeUndefined();

    const audit = (chat.metadata as any)?.mappingAudit;
    expect(audit).toBeDefined();
    expect(Array.isArray(audit.dropped)).toBe(true);
    expect(
      (audit.dropped as any[]).some(
        (entry) =>
          entry?.field === 'prompt_cache_key' &&
          entry?.targetProtocol === 'anthropic-messages' &&
          entry?.reason === 'unsupported_semantics_no_equivalent'
      )
    ).toBe(true);
  });

  it('drops prompt_cache_key for gemini and writes mapping audit', async () => {
    const responsesMapper = new ResponsesSemanticMapper();
    const geminiMapper = new GeminiSemanticMapper();
    const ctx = createResponsesContext('req-resp-gemini-pcache');

    const chat = await responsesMapper.toChat(
      {
        protocol: 'openai-responses',
        direction: 'request',
        payload: {
          model: 'gemini-2.5-pro',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
          prompt_cache_key: 'cache-key-456'
        }
      } as any,
      ctx
    );

    const outbound = await geminiMapper.fromChat(chat, {
      requestId: 'req-resp-gemini-out-pcache',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'gemini-chat',
      providerId: 'gemini-cli'
    } as AdapterContext);

    const payload = outbound.payload as any;
    expect(payload.prompt_cache_key).toBeUndefined();
    expect(payload.generationConfig?.prompt_cache_key).toBeUndefined();
    expect(payload.metadata?.prompt_cache_key).toBeUndefined();

    const audit = (chat.metadata as any)?.mappingAudit;
    expect(audit).toBeDefined();
    expect(Array.isArray(audit.dropped)).toBe(true);
    expect(
      (audit.dropped as any[]).some(
        (entry) =>
          entry?.field === 'prompt_cache_key' &&
          entry?.targetProtocol === 'gemini-chat' &&
          entry?.reason === 'unsupported_semantics_no_equivalent'
      )
    ).toBe(true);
  });
});
