import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
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
    expect(payload.thinking).toEqual({ type: 'adaptive' });
    expect(payload.output_config).toEqual({ effort: 'high' });
  });

  it('applies configured anthropic thinking budget for effort', async () => {
    const responsesMapper = new ResponsesSemanticMapper();
    const anthropicMapper = new AnthropicSemanticMapper();
    const ctx = createResponsesContext('req-resp-anthropic-budget');

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
      requestId: 'req-resp-anthropic-budget-out',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages',
      anthropicThinkingBudgets: { high: 4096 }
    } as AdapterContext);

    const payload = outbound.payload as any;
    expect(payload.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
    expect(payload.output_config).toEqual({ effort: 'high' });
  });

  it('maps adaptive reasoning to anthropic adaptive thinking', async () => {
    const responsesMapper = new ResponsesSemanticMapper();
    const anthropicMapper = new AnthropicSemanticMapper();
    const ctx = createResponsesContext('req-resp-anthropic-reasoning-adaptive');

    const chat = await responsesMapper.toChat(
      {
        protocol: 'openai-responses',
        direction: 'request',
        payload: {
          model: 'claude-sonnet-4-5',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
          reasoning: { type: 'adaptive' }
        }
      } as any,
      ctx
    );

    const outbound = await anthropicMapper.fromChat(chat, {
      requestId: 'req-resp-anthropic-out-adaptive',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages'
    } as AdapterContext);

    const payload = outbound.payload as any;
    expect(payload.thinking).toEqual({ type: 'adaptive' });
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

  const realSamplePath = path.join(
    process.env.HOME || '',
    '.rcc',
    'codex-samples',
    'openai-responses',
    '__pending__',
    'req_1773586755245_81d74128',
    'client-request.json'
  );

  (fs.existsSync(realSamplePath) ? it : it.skip)(
    'replays real codex sample: responses reasoning survives into anthropic thinking request',
    async () => {
      const sample = JSON.parse(fs.readFileSync(realSamplePath, 'utf8')).body.body;
      const responsesMapper = new ResponsesSemanticMapper();
      const anthropicMapper = new AnthropicSemanticMapper();

      const chat = await responsesMapper.toChat(
        {
          protocol: 'openai-responses',
          direction: 'request',
          payload: sample
        } as any,
        createResponsesContext('req-real-codex-sample-anthropic')
      );

      expect(chat.parameters).toMatchObject({
        reasoning: { effort: 'high', summary: 'detailed' },
        include: ['reasoning.encrypted_content'],
        text: { verbosity: 'high' },
        prompt_cache_key: '019cdff4-1bd5-7b70-97fd-32e04f9d702d',
        stream: true
      });

      const outbound = await anthropicMapper.fromChat(chat, {
        requestId: 'req-real-codex-sample-anthropic-out',
        entryEndpoint: '/v1/messages',
        providerProtocol: 'anthropic-messages'
      } as AdapterContext);

      const payload = outbound.payload as any;
      expect(payload.thinking).toEqual({ type: 'adaptive' });
      expect(payload.output_config).toEqual({ effort: 'high' });
    }
  );
});
