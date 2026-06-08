import { describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge.js', () => ({
  evaluateResponsesDirectRouteDecisionNative: (input: {
    payload: Record<string, unknown>;
    inboundProtocol: string;
    applyPatchMode?: string;
  }) => {
    const hasDeclaredApplyPatchTool = Array.isArray(input.payload.tools) && input.payload.tools.some((tool) => {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return false;
      const row = tool as Record<string, unknown>;
      const functionName =
        row.function && typeof row.function === 'object' && !Array.isArray(row.function) && typeof (row.function as Record<string, unknown>).name === 'string'
          ? String((row.function as Record<string, unknown>).name).trim()
          : '';
      const directName = typeof row.name === 'string' ? row.name.trim() : '';
      return functionName === 'apply_patch' || directName === 'apply_patch';
    });
    const violation = Array.isArray(input.payload.input)
      ? input.payload.input.findIndex((item) => (
        item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        (item as Record<string, unknown>).type === 'function_call_output' &&
        Object.prototype.hasOwnProperty.call(item, 'content')
      ))
      : -1;
    if (input.inboundProtocol === 'openai-responses' && violation >= 0) {
      return {
        providerWireValid: false,
        requiresHubRelay: false,
        reason: `openai-responses provider wire input[${violation}] function_call_output must not include content; use output only`,
        hasDeclaredApplyPatchTool,
      };
    }
    return {
      providerWireValid: true,
      requiresHubRelay: false,
      reason: undefined,
      hasDeclaredApplyPatchTool,
    };
  },
  hasDeclaredApplyPatchToolNative: (body: unknown) => {
    const record = body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : undefined;
    const tools = Array.isArray(record?.tools) ? record.tools : [];
    return tools.some((tool) => {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return false;
      const row = tool as Record<string, unknown>;
      const functionName =
        row.function && typeof row.function === 'object' && !Array.isArray(row.function) && typeof (row.function as Record<string, unknown>).name === 'string'
          ? String((row.function as Record<string, unknown>).name).trim()
          : '';
      const directName = typeof row.name === 'string' ? row.name.trim() : '';
      return functionName === 'apply_patch' || directName === 'apply_patch';
    });
  }
}), { virtual: true });

const {
  applyMinimalDirectOverrides,
  assertDirectRouteDecision,
  resolveRawPayloadForDirect,
  evaluateDirectRouteDecision,
} = await import('../../../../src/server/runtime/http-server/direct-passthrough-payload.js');

describe('direct-passthrough-payload', () => {
  it('ignores metadata.__raw_request_body and keeps current body as direct payload source', () => {
    const body = {
      model: 'gpt-5.3-codex',
      instructions: 'current',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'current' }] }],
    };
    const resolved = resolveRawPayloadForDirect(
      body,
      {
        __raw_request_body: {
          model: 'gpt-5.4',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }],
          previous_response_id: 'resp_prev',
        },
      },
    );

    expect(resolved).toBe(body);
    expect(resolved).toEqual({
      model: 'gpt-5.3-codex',
      instructions: 'current',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'current' }] }],
    });
  });

  it('lifts stream=true onto current body when direct metadata requests streaming', () => {
    const body = {
      model: 'gpt-5.3-codex',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'current' }] }],
    };
    const resolved = resolveRawPayloadForDirect(
      body,
      {
        stream: true,
        __raw_request_body: {
          model: 'gpt-5.4',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }],
        },
      },
    );

    expect(resolved).toBe(body);
    expect(resolved).toEqual({
      model: 'gpt-5.3-codex',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'current' }] }],
      stream: true,
    });
  });

  it('only applies explicit direct routeParams model override', () => {
    const body = {
      model: 'gpt-5.4',
      previous_response_id: 'resp_prev',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }],
    };
    const result = applyMinimalDirectOverrides(
      body,
      {
        routeParams: {
          model: 'dbittai-gpt.key1.gpt-5.3-codex',
          thinking: { type: 'enabled', budget_tokens: 1024 },
          instructions: 'must-not-copy',
        },
      },
    );

    expect(result).toBe(body);
    expect(result).toEqual({
      model: 'dbittai-gpt.key1.gpt-5.3-codex',
      previous_response_id: 'resp_prev',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }],
    });
    expect((result as Record<string, unknown>).instructions).toBeUndefined();
    expect((result as Record<string, unknown>).thinking).toBeUndefined();
  });

  it('keeps ingress payload unchanged when routeParams is absent', () => {
    const ingress = {
      model: 'raw-model',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw user' }] }],
    } as Record<string, unknown>;

    const output = applyMinimalDirectOverrides(ingress, {});
    expect(output).toEqual(ingress);
  });

  it('keeps responses tool declarations on direct path without Hub relay', () => {
    const decision = evaluateDirectRouteDecision({
      inboundProtocol: 'openai-responses',
      payload: {
        model: 'gpt-5.5',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
        tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object' } }],
      },
    });

    expect(decision.providerWireValid).toBe(true);
    expect(decision.requiresHubRelay).toBe(false);
    expect(decision.reason).toBeUndefined();
  });

  it('keeps responses reasoning content on same-protocol direct path', () => {
    const decision = evaluateDirectRouteDecision({
      inboundProtocol: 'openai-responses',
      payload: {
        model: 'gpt-5.5',
        input: [
          {
            type: 'reasoning',
            content: [{ type: 'reasoning_text', text: 'client-standard history' }],
          },
        ],
      },
    });

    expect(decision).toMatchObject({
      providerWireValid: true,
      requiresHubRelay: false,
    });
    expect(decision.reason).toBeUndefined();
  });

  it('does not runtime-reject chat-style function tools on responses direct', () => {
    expect(() => assertDirectRouteDecision({
      inboundProtocol: 'openai-responses',
      payload: {
        model: 'gpt-5.5',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
        tools: [{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } }],
      },
    })).not.toThrow();
  });

  it('does not runtime-reject mixed responses direct tool arrays', () => {
    for (const invalidIndex of [0, 3, 11]) {
      const tools = Array.from({ length: 12 }, (_, index) => (
        index === invalidIndex
          ? { type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } }
          : { type: 'function', name: `tool_${index}`, description: `tool ${index}`, parameters: { type: 'object' } }
      ));
      expect(() => assertDirectRouteDecision({
        inboundProtocol: 'openai-responses',
        payload: {
          model: 'gpt-5.5',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'sample lock' }] }],
          tools,
        },
      })).not.toThrow();
    }
  });

  it('does not runtime-reject chat-style messages on responses direct', () => {
    expect(() => assertDirectRouteDecision({
      inboundProtocol: 'openai-responses',
      payload: {
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).not.toThrow();
  });

  it('rejects historical responses tool output content on direct before provider transport', () => {
    expect(() => assertDirectRouteDecision({
      inboundProtocol: 'openai-responses',
      payload: {
        model: 'gpt-5.5',
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
          {
            type: 'function_call_output',
            call_id: 'call_1',
            output: 'ok',
            content: [{ type: 'output_text', text: 'historical leak' }],
          },
        ],
      },
    })).toThrow('function_call_output must not include content');
  });

  it('allows responses-native hosted tools without name', () => {
    expect(() => assertDirectRouteDecision({
      inboundProtocol: 'openai-responses',
      payload: {
        model: 'gpt-5.5',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
        tools: [{ type: 'web_search_preview' }],
      },
    })).not.toThrow();
  });

  it('detects legacy servertool apply_patch metadata without forcing Hub relay', () => {
    const result = evaluateDirectRouteDecision({
      inboundProtocol: 'openai-responses',
      applyPatchMode: 'servertool',
      payload: {
        model: 'gpt-5.5',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'edit' }] }],
        tools: [{ type: 'custom', name: 'apply_patch' }],
      },
    });
    expect(result).toMatchObject({
      providerWireValid: true,
      requiresHubRelay: false,
      hasDeclaredApplyPatchTool: true,
    });
    expect(result.reason).toBeUndefined();
  });
});
