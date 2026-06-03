import { describe, expect, it } from '@jest/globals';
import { AnthropicProtocolClient } from '../../src/client/anthropic/anthropic-protocol-client.js';
import { OpenAIChatProtocolClient } from '../../src/client/openai/chat-protocol-client.js';
import { ResponsesProtocolClient } from '../../src/client/responses/responses-protocol-client.js';

describe('AnthropicProtocolClient', () => {
  it('fails fast on top-level metadata instead of stripping it from Anthropic provider body', () => {
    const client = new AnthropicProtocolClient();

    expect(() =>
      client.buildRequestBody({
        data: {
          model: 'glm-4.7',
          system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
          messages: [{ role: 'user', content: 'hi' }],
          metadata: { user_id: 'test-user', __internal: 'redacted' }
        }
      } as any)
    ).toThrow(/metadata is not allowed/);
  });

  it('fails fast on metadata in OpenAI chat provider body', () => {
    const client = new OpenAIChatProtocolClient();

    expect(() =>
      client.buildRequestBody({
        data: {
          model: 'gpt-5.4',
          messages: [{ role: 'user', content: 'hi' }],
          metadata: { routeHint: 'internal' }
        }
      } as any)
    ).toThrow(/metadata is not allowed/);
  });

  it('fails fast on metadata in OpenAI Responses provider body', () => {
    const client = new ResponsesProtocolClient();

    expect(() =>
      client.buildRequestBody({
        data: {
          model: 'gpt-5.4',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
          metadata: { routeHint: 'internal' }
        }
      } as any)
    ).toThrow(/metadata is not allowed/);
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
