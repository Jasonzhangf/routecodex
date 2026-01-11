import { describe, it, expect } from '@jest/globals';
import { GeminiSemanticMapper } from '../../sharedmodule/llmswitch-core/src/conversion/hub/semantic-mappers/gemini-mapper.js';
import type {
  AdapterContext,
  ChatEnvelope
} from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';

const mapper = new GeminiSemanticMapper();

const adapterContext: AdapterContext = {
  requestId: 'req-gemini-semantic-stage2',
  entryEndpoint: '/v1/models/gemini:generatecontent',
  providerProtocol: 'gemini-chat',
  providerId: 'gemini-cli.test'
};

function buildFormatPayload() {
  return {
    protocol: 'gemini-chat',
    direction: 'request',
    payload: {
      contents: [
        {
          role: 'user',
          parts: [{ text: 'ping' }]
        }
      ],
      tools: [],
      systemInstruction: {
        role: 'system',
        parts: [{ text: 'act as tester' }]
      },
      safetySettings: [
        {
          category: 'HARM_CATEGORY_UNSPECIFIED',
          threshold: 'BLOCK_NONE'
        }
      ],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 1024
      },
      toolConfig: {
        mode: 'auto'
      },
      metadata: {
        keep: 'diagnostic',
        __rcc_tools_field_present: '1'
      }
    }
  } as const;
}

function scrubMetadata(chat: ChatEnvelope) {
  delete (chat.metadata as Record<string, unknown>).systemInstructions;
  delete (chat.metadata as Record<string, unknown>).providerMetadata;
  delete (chat.metadata as Record<string, unknown>).safetySettings;
  delete (chat.metadata as Record<string, unknown>).toolsFieldPresent;
  delete (chat.metadata as Record<string, unknown>).protocolState;
  if (chat.parameters) {
    delete (chat.parameters as Record<string, unknown>).temperature;
    delete (chat.parameters as Record<string, unknown>).top_p;
    delete (chat.parameters as Record<string, unknown>).max_output_tokens;
    delete (chat.parameters as Record<string, unknown>).tool_config;
  }
}

describe('Gemini semantics stage 2', () => {
  it('captures Gemini specific semantics on inbound payloads', async () => {
    const chat = await mapper.toChat(buildFormatPayload(), adapterContext);
    const semantics = (chat.semantics?.gemini ?? {}) as Record<string, unknown>;
    expect(semantics.systemInstruction).toEqual({
      role: 'system',
      parts: [{ text: 'act as tester' }]
    });
    expect(semantics.safetySettings).toEqual([
      {
        category: 'HARM_CATEGORY_UNSPECIFIED',
        threshold: 'BLOCK_NONE'
      }
    ]);
    expect(semantics.generationConfig).toEqual({
      temperature: 0.3,
      maxOutputTokens: 1024
    });
    expect(semantics.toolConfig).toEqual({ mode: 'auto' });
    expect(semantics.providerMetadata).toEqual({ keep: 'diagnostic' });
    expect(chat.semantics?.tools?.explicitEmpty).toBe(true);
    expect(chat.semantics?.system?.textBlocks).toEqual(['act as tester']);
  });

  it('replays semantics when metadata mirrors are removed', async () => {
    const format = buildFormatPayload();
    const chat = await mapper.toChat(format, adapterContext);
    scrubMetadata(chat);
    const outbound = await mapper.fromChat(chat, adapterContext);
    const payload = outbound.payload as Record<string, unknown>;
    expect(payload.systemInstruction).toEqual({
      role: 'system',
      parts: [{ text: 'act as tester' }]
    });
    expect(payload.safetySettings).toEqual([
      {
        category: 'HARM_CATEGORY_UNSPECIFIED',
        threshold: 'BLOCK_NONE'
      }
    ]);
    expect(payload.generationConfig).toEqual({
      temperature: 0.3,
      maxOutputTokens: 1024
    });
    expect(payload.toolConfig).toEqual({ mode: 'auto' });
    const metadata = payload.metadata as Record<string, unknown>;
    expect(metadata.keep).toBe('diagnostic');
    expect(metadata.__rcc_tools_field_present).toBe('1');
  });
});
