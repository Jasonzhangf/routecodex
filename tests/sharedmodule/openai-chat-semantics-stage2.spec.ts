import { describe, it, expect } from '@jest/globals';
import { ChatSemanticMapper } from '../../sharedmodule/llmswitch-core/src/conversion/hub/semantic-mappers/chat-mapper.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';

const mapper = new ChatSemanticMapper();

const adapterContext: AdapterContext = {
  requestId: 'req-openai-semantic-stage2',
  entryEndpoint: '/v1/chat/completions',
  providerProtocol: 'openai-chat'
};

function buildFormatPayload() {
  return {
    protocol: 'openai-chat',
    direction: 'request',
    payload: {
      messages: [
        { role: 'system', content: 'You are tester' },
        { role: 'user', content: 'ping' }
      ],
      tools: [],
      custom_field: {
        foo: 'bar'
      }
    }
  } as const;
}

describe('OpenAI Chat semantics stage 2', () => {
  it('captures system/extra/tool semantics on inbound payloads', async () => {
    const format = buildFormatPayload();
    const chat = await mapper.toChat(format, adapterContext);
    const semantics = chat.semantics ?? {};
    expect(semantics.system?.textBlocks).toEqual(['You are tester']);
    const providerExtras = semantics.providerExtras as Record<string, any> | undefined;
    expect(providerExtras?.openaiChat?.extraFields).toEqual({
      custom_field: { foo: 'bar' }
    });
    expect(semantics.tools?.explicitEmpty).toBe(true);

    // Metadata mirrors were removed; rely on semantics instead.
    expect((chat.metadata as Record<string, unknown> | undefined)?.systemInstructions).toBeUndefined();
    expect((chat.metadata as Record<string, unknown> | undefined)?.extraFields).toBeUndefined();
    expect((chat.metadata as Record<string, unknown> | undefined)?.toolsFieldPresent).toBeUndefined();
  });

  it('replays semantics when metadata mirror is absent', async () => {
    const format = buildFormatPayload();
    const chat = await mapper.toChat(format, adapterContext);
    delete (chat.metadata as Record<string, unknown>).systemInstructions;
    delete (chat.metadata as Record<string, unknown>).extraFields;
    delete (chat.metadata as Record<string, unknown>).toolsFieldPresent;
    chat.tools = undefined;
    const outbound = await mapper.fromChat(chat, adapterContext);
    const payload = outbound.payload as Record<string, unknown>;
    expect(Array.isArray(payload.tools)).toBe(true);
    expect((payload.tools as unknown[]).length).toBe(0);
    expect(payload.custom_field).toEqual({ foo: 'bar' });
  });
});
