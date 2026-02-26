import { describe, it, expect } from '@jest/globals';
import { GeminiSemanticMapper } from '../../sharedmodule/llmswitch-core/src/conversion/hub/semantic-mappers/gemini-mapper.js';
import type {
  AdapterContext,
  ChatEnvelope
} from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';

const mapper = new GeminiSemanticMapper();

const adapterContext: AdapterContext = {
  requestId: 'req-antigravity-websearch-tools',
  entryEndpoint: '/v1/responses',
  providerProtocol: 'gemini-chat',
  providerId: 'antigravity.test'
};

function buildBaseChatEnvelope(model: string): ChatEnvelope {
  return {
    messages: [
      {
        role: 'user',
        content: 'search latest routecodex updates'
      }
    ],
    parameters: {
      model
    },
    metadata: {
      context: adapterContext
    }
  };
}

function collectDeclarationNames(payload: Record<string, unknown>): string[] {
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const names: string[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') {
      continue;
    }
    const declarations = Array.isArray((tool as any).functionDeclarations)
      ? ((tool as any).functionDeclarations as Array<Record<string, unknown>>)
      : [];
    for (const declaration of declarations) {
      if (typeof declaration?.name === 'string' && declaration.name.trim()) {
        names.push(declaration.name.trim().toLowerCase());
      }
    }
  }
  return names;
}

describe('Antigravity Gemini web search tools alignment', () => {
  it('injects googleSearch and sets requestType=web_search for online model with no tools', async () => {
    const chat = buildBaseChatEnvelope('gemini-3-pro-high-online');
    const outbound = await mapper.fromChat(chat, adapterContext);
    const payload = outbound.payload as Record<string, unknown>;

    expect(payload.requestType).toBe('web_search');
    expect(payload.model).toBe('gemini-3-pro-high');
    expect(Array.isArray(payload.tools)).toBe(true);
    expect((payload.tools as Array<Record<string, unknown>>).length).toBe(1);
    expect((payload.tools as Array<Record<string, unknown>>)[0]).toHaveProperty('googleSearch');
  });

  it('drops networking functionDeclarations and injects googleSearch for antigravity web_search requests', async () => {
    const chat = buildBaseChatEnvelope('gemini-3-pro-high-online');
    chat.tools = [
      {
        type: 'function',
        function: {
          name: 'web_search',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string' }
            }
          }
        }
      } as any
    ];

    const outbound = await mapper.fromChat(chat, adapterContext);
    const payload = outbound.payload as Record<string, unknown>;
    const tools = payload.tools as Array<Record<string, unknown>>;

    expect(payload.requestType).toBe('web_search');
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBe(1);
    expect(tools[0]).toHaveProperty('googleSearch');
    expect(collectDeclarationNames(payload)).toEqual([]);
  });

  it('keeps non-networking tool declarations (no googleSearch mixing) when mixed tools are present', async () => {
    const chat = buildBaseChatEnvelope('gemini-3-pro-high-online');
    chat.tools = [
      {
        type: 'function',
        function: {
          name: 'web_search',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string' }
            }
          }
        }
      } as any,
      {
        type: 'function',
        function: {
          name: 'exec_command',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string' }
            }
          }
        }
      } as any
    ];

    const outbound = await mapper.fromChat(chat, adapterContext);
    const payload = outbound.payload as Record<string, unknown>;
    const tools = payload.tools as Array<Record<string, unknown>>;
    const declNames = collectDeclarationNames(payload);

    expect(payload.requestType).toBe('web_search');
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.some((tool) => tool.googleSearch)).toBe(false);
    expect(declNames.includes('exec_command')).toBe(true);
    expect(declNames.includes('web_search')).toBe(false);
    expect(declNames.includes('websearch')).toBe(false);
  });
});
