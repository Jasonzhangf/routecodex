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

describe('responses cross-protocol reasoning mapping', () => {
  it('maps responses.reasoning to anthropic.thinking', async () => {
    const responsesMapper = new ResponsesSemanticMapper();
    const anthropicMapper = new AnthropicSemanticMapper();
    const ctx = createResponsesContext('req-resp-anthropic-reasoning');

    const chat = await responsesMapper.toChat(
      {
        protocol: 'openai-responses',
        direction: 'request',
        payload: {
          model: 'claude-sonnet-4-5',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
          reasoning: { effort: 'high' }
        }
      } as any,
      ctx
    );

    const outbound = await anthropicMapper.fromChat(chat, {
      requestId: 'req-resp-anthropic-out',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages'
    } as AdapterContext);

    const payload = outbound.payload as any;
    expect(payload.thinking).toBeDefined();
    expect(payload.thinking.type).toBe('enabled');
    expect(typeof payload.thinking.budget_tokens).toBe('number');
    expect(payload.thinking.budget_tokens).toBeGreaterThan(0);
  });

  it('maps responses.reasoning to gemini generationConfig.thinkingConfig', async () => {
    const responsesMapper = new ResponsesSemanticMapper();
    const geminiMapper = new GeminiSemanticMapper();
    const ctx = createResponsesContext('req-resp-gemini-reasoning');

    const chat = await responsesMapper.toChat(
      {
        protocol: 'openai-responses',
        direction: 'request',
        payload: {
          model: 'gemini-2.5-pro',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
          reasoning: { effort: 'medium' }
        }
      } as any,
      ctx
    );

    const outbound = await geminiMapper.fromChat(chat, {
      requestId: 'req-resp-gemini-out',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'gemini-chat',
      providerId: 'gemini-cli'
    } as AdapterContext);

    const payload = outbound.payload as any;
    expect(payload.generationConfig).toBeDefined();
    expect(payload.generationConfig.thinkingConfig).toBeDefined();
    expect(payload.generationConfig.thinkingConfig.includeThoughts).toBe(true);
    expect(typeof payload.generationConfig.thinkingConfig.thinkingBudget).toBe('number');
    expect(payload.generationConfig.thinkingConfig.thinkingBudget).toBeGreaterThan(0);
  });
});
