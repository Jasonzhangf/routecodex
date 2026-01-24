import { describe, it, expect, jest } from '@jest/globals';
import type { AdapterContext, ChatEnvelope } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';

jest.unstable_mockModule('../../sharedmodule/llmswitch-core/src/sse/types/index.js', () => ({}));

jest.unstable_mockModule('../../sharedmodule/llmswitch-core/src/sse/types/core-interfaces.js', () => ({
  BaseSseEvent: class {},
  BaseSseEventStream: class {},
  StreamProtocol: {},
  StreamDirection: {},
  SseProtocol: {},
  SseDirection: {}
}));

jest.unstable_mockModule('../../sharedmodule/llmswitch-core/src/conversion/codecs/anthropic-openai-codec.js', () => ({
  buildOpenAIChatFromAnthropic: (payload: any) => ({
    ...(payload || {}),
    messages: Array.isArray((payload as any)?.messages) ? (payload as any).messages : [],
    tools: Array.isArray((payload as any)?.tools) ? (payload as any).tools : []
  }),
  buildAnthropicRequestFromOpenAIChat: (request: any) => ({ ...(request || {}) })
}));

const { AnthropicSemanticMapper } = await import(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/semantic-mappers/anthropic-mapper.js'
);

const mapper = new AnthropicSemanticMapper();

const adapterContext: AdapterContext = {
  requestId: 'anthropic-sem-stage2',
  entryEndpoint: '/v1/messages',
  providerProtocol: 'anthropic-messages'
};

function buildFormatPayload() {
  return {
    protocol: 'anthropic-messages',
    direction: 'request',
    payload: {
      model: 'claude-3-haiku',
      system: [
        {
          type: 'text',
          text: 'act as tester'
        }
      ],
      tools: [
        {
          name: 'CallHTTP',
          description: 'demo tool'
        }
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'ping'
            }
          ]
        }
      ],
      metadata: {}
    }
  } as const;
}

function scrubMetadata(chat: ChatEnvelope) {
  delete (chat.metadata as Record<string, unknown>).extraFields;
  delete (chat.metadata as Record<string, unknown>).protocolState;
  delete (chat.metadata as Record<string, unknown>).toolsFieldPresent;
}

describe('Anthropic semantics stage 2', () => {
  it('captures system blocks / alias map / mirror semantics on inbound', async () => {
    const chat = await mapper.toChat(buildFormatPayload(), adapterContext);
    const semantics = chat.semantics as Record<string, unknown> | undefined;
    const system = (semantics?.system as Record<string, unknown> | undefined) ?? undefined;
    expect(system?.blocks).toBeDefined();
    const tools = (semantics?.tools as Record<string, unknown> | undefined) ?? undefined;
    const aliasMap = tools?.toolNameAliasMap as Record<string, string> | undefined;
    expect(aliasMap).toBeDefined();
    expect(Object.values(aliasMap ?? {})).toContain('CallHTTP');
    const providerExtras = (semantics?.providerExtras as Record<string, unknown> | undefined) ?? undefined;
    expect(providerExtras?.anthropicMirror).toBeDefined();
  });

  it('replays semantics when metadata/protocolState snapshots are missing', async () => {
    const format = buildFormatPayload();
    const chat = await mapper.toChat(format, adapterContext);
    scrubMetadata(chat);
    const outbound = await mapper.fromChat(chat, adapterContext);
    expect(outbound.payload).toHaveProperty('system');
    expect(Array.isArray((outbound.payload as Record<string, unknown>).tools)).toBe(true);
  });
});
