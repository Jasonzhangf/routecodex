import { describe, expect, it } from '@jest/globals';
import { GeminiSemanticMapper } from '../../sharedmodule/llmswitch-core/src/conversion/hub/semantic-mappers/gemini-mapper.js';
import type {
  AdapterContext,
  ChatEnvelope
} from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';

const mapper = new GeminiSemanticMapper();

const adapterContext: AdapterContext = {
  requestId: 'req-antigravity-claude-reasoning-tags',
  entryEndpoint: '/v1/responses',
  providerProtocol: 'gemini-chat',
  providerId: 'antigravity.test'
};

function buildChat(parameters: Record<string, unknown>): ChatEnvelope {
  return {
    messages: [
      {
        role: 'user',
        content: '<think>hidden chain</think><reflection>hidden notes</reflection>visible answer'
      }
    ],
    parameters,
    metadata: {
      context: adapterContext
    }
  };
}

function firstText(payload: Record<string, any>): string {
  const contents = Array.isArray(payload.contents) ? payload.contents : [];
  const first = contents[0] ?? {};
  const parts = Array.isArray(first.parts) ? first.parts : [];
  const part = parts.find((entry: any) => typeof entry?.text === 'string');
  return typeof part?.text === 'string' ? part.text : '';
}

describe('Antigravity Claude reasoning-tag policy', () => {
  it('strips <think>/<reflection> by default for antigravity claude models', async () => {
    const outbound = await mapper.fromChat(buildChat({ model: 'claude-sonnet-4-5-thinking' }), adapterContext);
    const payload = outbound.payload as Record<string, any>;
    const text = firstText(payload);

    expect(text).toBe('visible answer');
    expect(text).not.toContain('<think>');
    expect(text).not.toContain('<reflection>');
  });

  it('keeps reasoning tags when keep_thinking is enabled', async () => {
    const outbound = await mapper.fromChat(
      buildChat({ model: 'claude-sonnet-4-5-thinking', keep_thinking: true }),
      adapterContext
    );
    const payload = outbound.payload as Record<string, any>;
    const text = firstText(payload);

    expect(text).toContain('<think>hidden chain</think>');
    expect(text).toContain('<reflection>hidden notes</reflection>');
    expect(text).toContain('visible answer');
  });

  it('keeps reasoning tags when keep_reasoning is enabled', async () => {
    const outbound = await mapper.fromChat(
      buildChat({ model: 'claude-sonnet-4-5-thinking', keep_reasoning: true }),
      adapterContext
    );
    const payload = outbound.payload as Record<string, any>;
    const text = firstText(payload);

    expect(text).toContain('<think>hidden chain</think>');
    expect(text).toContain('<reflection>hidden notes</reflection>');
    expect(text).toContain('visible answer');
  });
});
