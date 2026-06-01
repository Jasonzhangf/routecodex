import { describe, expect, it } from '@jest/globals';
import { AnthropicProtocolClient } from '../../src/client/anthropic/anthropic-protocol-client.js';

describe('AnthropicProtocolClient', () => {
  it('does not leak top-level metadata into Anthropic provider body', () => {
    const client = new AnthropicProtocolClient();

    const body = client.buildRequestBody({
      data: {
        model: 'glm-4.7',
        system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
        messages: [{ role: 'user', content: 'hi' }],
        metadata: { user_id: 'test-user', __internal: 'redacted' }
      }
    } as any);

    expect(body.metadata).toBeUndefined();
  });

  it('normalizes string tool_choice into Anthropic object form', () => {
    const client = new AnthropicProtocolClient();

    const body = client.buildRequestBody({
      data: {
        model: 'glm-4.7',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'echo', parameters: { type: 'object', properties: {} } } }],
        tool_choice: 'required'
      }
    } as any);

    expect(body.tool_choice).toEqual({ type: 'any' });
  });

  it('fails fast on invalid tool_choice instead of silently dropping it', () => {
    const client = new AnthropicProtocolClient();

    expect(() =>
      client.buildRequestBody({
        data: {
          model: 'glm-4.7',
          messages: [{ role: 'user', content: 'hi' }],
          tool_choice: 123
        }
      } as any)
    ).toThrow(/Invalid Anthropic tool_choice/);
  });
});
