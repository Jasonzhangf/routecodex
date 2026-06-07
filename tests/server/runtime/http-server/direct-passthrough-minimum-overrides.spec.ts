import { describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge.js', () => ({
  evaluateResponsesDirectRouteDecisionNative: () => ({
    providerWireValid: true,
    requiresHubRelay: false,
    hasDeclaredApplyPatchTool: false,
  }),
}), { virtual: true });

const { applyMinimalDirectOverrides } = await import('../../../../src/server/runtime/http-server/direct-passthrough-payload.js');

describe('direct passthrough minimum overrides', () => {
  it('overrides only model on the original ingress payload object', () => {
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

    expect(output).toBe(ingress);
    expect(output).toEqual({
      model: 'route-model',
      previous_response_id: 'resp_raw_prev',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw user' }] }],
      instructions: 'raw-instructions',
      tools: [{ type: 'function', function: { name: 'update_plan' } }],
    });
  });

  it('keeps ingress payload unchanged when providerPayload is absent', () => {
    const ingress = {
      model: 'raw-model',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw user' }] }],
    } as Record<string, unknown>;

    const output = applyMinimalDirectOverrides(ingress, {});
    expect(output).toBe(ingress);
    expect(output).toEqual(ingress);
  });

  it('keeps direct input history untouched (no request-side sanitization)', () => {
    const firstHistoryItem = {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<goal_context>internal planner prompt</goal_context>' }],
    };
    const toolHistoryItem = {
      type: 'function_call',
      name: 'update_plan',
      call_id: 'call_1',
      arguments: '{}',
    };
    const ingress = {
      model: 'raw-model',
      input: [firstHistoryItem, toolHistoryItem],
    } as Record<string, unknown>;
    const output = applyMinimalDirectOverrides(ingress, { routeParams: { model: 'route-model' } });
    expect(output).toBe(ingress);
    expect(output.model).toBe('route-model');
    expect((output.input as unknown[])[0]).toBe(firstHistoryItem);
    expect((output.input as unknown[])[1]).toBe(toolHistoryItem);
    expect(output.input).toBe(ingress.input);
  });
});
