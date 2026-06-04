import { describe, expect, it } from '@jest/globals';

import {
  applyMinimalDirectOverrides,
  assertDirectPayloadContract,
  resolveRawPayloadForDirect,
} from '../../../../src/server/runtime/http-server/direct-passthrough-payload.js';

describe('direct-passthrough-payload', () => {
  it('prefers metadata.__raw_request_body over mutated body', () => {
    const resolved = resolveRawPayloadForDirect(
      {
        model: 'gpt-5.3-codex',
        instructions: 'mutated',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'mutated' }] }],
      },
      {
        __raw_request_body: {
          model: 'gpt-5.4',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }],
          previous_response_id: 'resp_prev',
        },
      },
    );

    expect(resolved).toEqual({
      model: 'gpt-5.4',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }],
      previous_response_id: 'resp_prev',
    });
  });

  it('fails fast instead of stripping metadata from replay raw payload', () => {
    expect(() =>
      resolveRawPayloadForDirect(
        {
          model: 'gpt-5.3-codex',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'mutated' }] }],
        },
        {
          __raw_request_body: {
            model: 'gpt-5.4',
            metadata: {
              session_id: 'replay-session-must-not-leak',
              routeHint: 'internal'
            },
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }],
          },
        },
      )
    ).toThrow(/metadata is not allowed in direct passthrough provider body/);
  });

  it('only applies explicit direct routeParams model override', () => {
    const result = applyMinimalDirectOverrides(
      {
        model: 'gpt-5.4',
        previous_response_id: 'resp_prev',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }],
      },
      {
        routeParams: {
          model: 'dbittai-gpt.key1.gpt-5.3-codex',
          thinking: { type: 'enabled', budget_tokens: 1024 },
          instructions: 'must-not-copy',
        },
      },
    );

    expect(result).toEqual({
      model: 'dbittai-gpt.key1.gpt-5.3-codex',
      previous_response_id: 'resp_prev',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }],
    });
    expect((result as Record<string, unknown>).instructions).toBeUndefined();
    expect((result as Record<string, unknown>).thinking).toBeUndefined();
  });

  it('rejects historical chat-style function tools on responses direct', () => {
    expect(() => assertDirectPayloadContract({
      inboundProtocol: 'openai-responses',
      payload: {
        model: 'gpt-5.5',
        input: 'hello',
        tools: [{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } }],
      },
    })).toThrow(/missing name/);
  });

  it('rejects historical chat-style messages on responses direct', () => {
    expect(() => assertDirectPayloadContract({
      inboundProtocol: 'openai-responses',
      payload: {
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).toThrow(/chat-style messages/);
  });

  it('allows responses-native hosted tools without name', () => {
    expect(() => assertDirectPayloadContract({
      inboundProtocol: 'openai-responses',
      payload: {
        model: 'gpt-5.5',
        input: 'hello',
        tools: [{ type: 'web_search_preview' }],
      },
    })).not.toThrow();
  });
});
