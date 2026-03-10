import { validateChatEnvelope } from '../../src/conversion/shared/chat-envelope-validator.js';
import type { ChatEnvelope } from '../../src/conversion/hub/types/chat-envelope.js';

const baseEnvelope: ChatEnvelope = {
  messages: [
    { role: 'system', content: 'You are validator.' },
    { role: 'user', content: 'ping' }
  ],
  parameters: { model: 'glm-4.6' },
  metadata: {
    context: {
      requestId: 'req_validator',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat'
    }
  }
};

describe('chat envelope validator', () => {
  test('accepts canonical envelopes', () => {
    expect(() =>
      validateChatEnvelope(structuredClone(baseEnvelope), { stage: 'req_inbound', direction: 'request' })
    ).not.toThrow();
  });

  test('rejects reserved fields outside metadata', () => {
    const invalid = structuredClone(baseEnvelope);
    (invalid.messages[0] as Record<string, unknown>).__rcc_raw_system = true;
    expect(() =>
      validateChatEnvelope(invalid, { stage: 'req_inbound', direction: 'request' })
    ).toThrow(/reserved field/);
  });

  test('requires metadata context object', () => {
    const invalid = structuredClone(baseEnvelope);
    delete (invalid.metadata as Record<string, unknown>).context;
    expect(() =>
      validateChatEnvelope(invalid, { stage: 'req_outbound', direction: 'request' })
    ).toThrow(/metadata\.context/);
  });
});
