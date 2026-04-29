import { normalizeChatRequest } from '../../sharedmodule/llmswitch-core/src/conversion/shared/openai-message-normalize.js';

describe('normalizeChatRequest', () => {
  it('fails fast when chat messages contain synthetic RouteCodex local control text', () => {
    const payload = {
      model: 'gpt-test',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '[RouteCodex] assistant response became empty after response sanitization.' }
      ]
    };

    expect(() => normalizeChatRequest(payload)).toThrow(/synthetic RouteCodex local control text/i);
  });
});
