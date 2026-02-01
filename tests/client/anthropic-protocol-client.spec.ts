import { describe, expect, it } from '@jest/globals';
import { AnthropicProtocolClient } from '../../src/client/anthropic/anthropic-protocol-client.js';

describe('AnthropicProtocolClient', () => {
  it('preserves top-level metadata (required by Claude-Code-gated proxies)', () => {
    const client = new AnthropicProtocolClient();

    const body = client.buildRequestBody({
      data: {
        model: 'glm-4.7',
        system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
        messages: [{ role: 'user', content: 'hi' }],
        metadata: { user_id: 'test-user', __internal: 'redacted' }
      }
    } as any);

    expect(body.metadata).toEqual({ user_id: 'test-user' });
  });
});

