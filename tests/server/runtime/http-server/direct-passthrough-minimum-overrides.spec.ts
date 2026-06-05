import { describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge.js', () => ({
  resolveResponsesDirectPayloadNative: (input: {
    body: unknown;
  }) => (input.body && typeof input.body === 'object' && !Array.isArray(input.body)
    ? structuredClone(input.body as Record<string, unknown>)
    : {}),
  applyResponsesDirectRouteParamsOverrideNative: (input: {
    payload: Record<string, unknown>;
    routeParams?: Record<string, unknown>;
  }) => {
    const next = structuredClone(input.payload);
    const routeModel = typeof input.routeParams?.model === 'string' ? input.routeParams.model.trim() : '';
    if (routeModel) {
      next.model = routeModel;
    }
    const routeReasoningEffort =
      typeof input.routeParams?.reasoningEffort === 'string' ? input.routeParams.reasoningEffort.trim() : '';
    if (routeReasoningEffort) {
      next.reasoning_effort = routeReasoningEffort;
      next.reasoning = { effort: routeReasoningEffort };
    }
    return next;
  },
  validateResponsesDirectToolShapeContractNative: () => ({ ok: true as const }),
}), { virtual: true });

const { applyMinimalDirectOverrides } = await import('../../../../src/server/runtime/http-server/direct-passthrough-payload.js');

describe('direct passthrough minimum overrides', () => {
  it('only overrides model/reasoning from routeParams and preserves ingress payload shape', () => {
    const ingress = {
      model: 'raw-model',
      previous_response_id: 'resp_raw_prev',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw user' }] }],
      instructions: 'raw-instructions',
      tools: [{ type: 'function', function: { name: 'update_plan' } }],
    } as Record<string, unknown>;

    const output = applyMinimalDirectOverrides(ingress, {
      routeParams: {
        model: 'route-model',
        reasoningEffort: 'high',
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
      reasoning_effort: 'high',
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
