import { describe, expect, it } from '@jest/globals';
import { applyMinimalDirectOverrides } from '../../../../src/server/runtime/http-server/direct-passthrough-payload.js';

describe('direct passthrough minimum overrides', () => {
  it('only overrides model/reasoning-thinking from providerPayload and preserves ingress payload shape', () => {
    const ingress = {
      model: 'raw-model',
      previous_response_id: 'resp_raw_prev',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw user' }] }],
      instructions: 'raw-instructions',
      tools: [{ type: 'function', function: { name: 'update_plan' } }],
    } as Record<string, unknown>;

    const output = applyMinimalDirectOverrides(ingress, {
      providerPayload: {
        model: 'route-model',
        reasoning: { effort: 'high' },
        thinking: { type: 'enabled' },
        instructions: 'provider-side-guidance-must-not-leak',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'provider-mutated' }] }],
        tools: [{ type: 'function', function: { name: 'exec_command' } }],
      },
    });

    expect(output).toEqual({
      model: 'route-model',
      previous_response_id: 'resp_raw_prev',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw user' }] }],
      instructions: 'raw-instructions',
      tools: [{ type: 'function', function: { name: 'update_plan' } }],
      reasoning: { effort: 'high' },
      thinking: { type: 'enabled' },
    });
  });

  it('keeps ingress payload unchanged when providerPayload is absent', () => {
    const ingress = {
      model: 'raw-model',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw user' }] }],
    } as Record<string, unknown>;

    const output = applyMinimalDirectOverrides(ingress, {});
    expect(output).toEqual(ingress);
  });

  it('keeps direct input history untouched (no request-side sanitization)', () => {
    const ingress = {
      model: 'raw-model',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '<goal_context>internal planner prompt</goal_context>' }],
        },
        {
          type: 'function_call',
          name: 'update_plan',
          call_id: 'call_1',
          arguments: '{}',
        },
      ],
    } as Record<string, unknown>;
    const output = applyMinimalDirectOverrides(ingress, {});
    expect(output).toEqual(ingress);
  });
});
