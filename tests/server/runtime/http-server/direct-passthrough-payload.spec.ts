import { describe, expect, it } from '@jest/globals';

import {
  applyMinimalDirectOverrides,
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

  it('keeps direct payload transparent on ingress side (no route/provider overrides)', () => {
    const result = applyMinimalDirectOverrides(
      {
        model: 'gpt-5.4',
        previous_response_id: 'resp_prev',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }],
      },
      {
        providerPayload: {
          model: 'dbittai-gpt.key1.gpt-5.3-codex',
          thinking: { type: 'enabled', budget_tokens: 2048 },
          reasoning_effort: 'low',
          instructions: 'must-not-copy',
          tools: [{ name: 'must-not-copy' }],
        },
        routeParams: {
          thinking: { type: 'enabled', budget_tokens: 1024 },
          reasoningEffort: 'medium',
          foo: 'must-not-copy',
        },
      },
    );

    expect(result).toEqual({
      model: 'gpt-5.4',
      previous_response_id: 'resp_prev',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }],
    });
    expect((result as Record<string, unknown>).instructions).toBeUndefined();
    expect((result as Record<string, unknown>).tools).toBeUndefined();
    expect((result as Record<string, unknown>).foo).toBeUndefined();
  });
});
