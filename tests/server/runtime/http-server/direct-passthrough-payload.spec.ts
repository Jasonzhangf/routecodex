import { describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge.js', () => ({
  resolveResponsesDirectPayloadNative: (input: {
    body: unknown;
    rawRequestBody?: Record<string, unknown>;
    bodyStream?: boolean;
    metadataStream?: boolean;
    outboundStream?: boolean;
  }) => {
    const source =
      input.rawRequestBody && typeof input.rawRequestBody === 'object' && !Array.isArray(input.rawRequestBody)
        ? structuredClone(input.rawRequestBody)
        : (input.body && typeof input.body === 'object' && !Array.isArray(input.body)
          ? structuredClone(input.body as Record<string, unknown>)
          : {});
    if (Object.prototype.hasOwnProperty.call(source, 'metadata')) {
      throw new Error('provider-runtime-error: metadata is not allowed in direct passthrough provider body');
    }
    if ((input.bodyStream === true || input.metadataStream === true || input.outboundStream === true) && source.stream !== true) {
      source.stream = true;
    }
    return source;
  },
  applyResponsesDirectRouteParamsOverrideNative: (input: {
    payload: Record<string, unknown>;
    routeParams?: Record<string, unknown>;
  }) => {
    const next = structuredClone(input.payload);
    const routeModel = typeof input.routeParams?.model === 'string' ? input.routeParams.model.trim() : '';
    if (routeModel) {
      next.model = routeModel;
    }
    return next;
  },
  validateResponsesDirectToolShapeContractNative: (payload: Record<string, unknown>) => {
    if (Array.isArray(payload.messages)) {
      throw new Error(
        'provider-runtime-error: responses provider received chat-style "messages". This indicates a HubPipeline bypass; provider must receive Responses wire payload (input/instructions).'
      );
    }
    const hasInput = Array.isArray(payload.input);
    const hasInstructions = typeof payload.instructions === 'string' && payload.instructions.trim().length > 0;
    if (!hasInput && !hasInstructions) {
      throw new Error('provider-runtime-error: responses payload missing "input" or "instructions"');
    }
    if (Array.isArray(payload.tools)) {
      payload.tools.forEach((tool, index) => {
        if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
          throw new Error(`provider-runtime-error: responses payload tools[${index}] must be an object`);
        }
        const type = typeof (tool as { type?: unknown }).type === 'string' ? String((tool as { type?: unknown }).type).trim() : '';
        if (type === 'function') {
          const name = typeof (tool as { name?: unknown }).name === 'string' ? String((tool as { name?: unknown }).name).trim() : '';
          if (!name) {
            throw new Error(
              `provider-runtime-error: responses payload tools[${index}] is chat-style function tool; Responses wire requires top-level tool.name`
            );
          }
        }
      });
    }
    if (Array.isArray(payload.input)) {
      payload.input.forEach((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return;
        }
        const type = typeof (item as { type?: unknown }).type === 'string' ? String((item as { type?: unknown }).type).trim() : '';
        if ((type === 'function_call' || type === 'function_call_output') && Object.prototype.hasOwnProperty.call(item, 'content')) {
          throw new Error(
            `provider-runtime-error: responses payload input[${index}] ${type} must not carry content; tool call data belongs in arguments/output fields`
          );
        }
      });
    }
    return { ok: true as const };
  },
  evaluateResponsesDirectRouteDecisionNative: (input: {
    payload: Record<string, unknown>;
    inboundProtocol: string;
    applyPatchMode?: string;
  }) => {
    if (input.inboundProtocol === 'openai-responses') {
      const payload = input.payload;
      if (Array.isArray(payload.messages)) {
        throw new Error(
          'provider-runtime-error: responses provider received chat-style "messages". This indicates a HubPipeline bypass; provider must receive Responses wire payload (input/instructions).'
        );
      }
      const hasInput = Array.isArray(payload.input);
      const hasInstructions = typeof payload.instructions === 'string' && payload.instructions.trim().length > 0;
      if (!hasInput && !hasInstructions) {
        throw new Error('provider-runtime-error: responses payload missing "input" or "instructions"');
      }
      if (Array.isArray(payload.tools)) {
        payload.tools.forEach((tool, index) => {
          if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
            throw new Error(`provider-runtime-error: responses payload tools[${index}] must be an object`);
          }
          const type = typeof (tool as { type?: unknown }).type === 'string' ? String((tool as { type?: unknown }).type).trim() : '';
          if (type === 'function') {
            const name = typeof (tool as { name?: unknown }).name === 'string' ? String((tool as { name?: unknown }).name).trim() : '';
            if (!name) {
              throw new Error(`provider-runtime-error: responses payload tools[${index}] is chat-style function tool; Responses wire requires top-level tool.name`);
            }
          }
        });
      }
      if (Array.isArray(payload.input)) {
        payload.input.forEach((item, index) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return;
          }
          const type = typeof (item as { type?: unknown }).type === 'string' ? String((item as { type?: unknown }).type).trim() : '';
          if ((type === 'function_call' || type === 'function_call_output') && Object.prototype.hasOwnProperty.call(item, 'content')) {
            throw new Error(
              `provider-runtime-error: responses payload input[${index}] ${type} must not carry content; tool call data belongs in arguments/output fields`
            );
          }
        });
      }
    }
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

  it('lifts stream=true onto replay raw payload when direct metadata requests streaming', () => {
    const resolved = resolveRawPayloadForDirect(
      {
        model: 'gpt-5.3-codex',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'mutated' }] }],
      },
      {
        stream: true,
        __raw_request_body: {
          model: 'gpt-5.4',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }],
        },
      },
    );

    expect(resolved).toEqual({
      model: 'gpt-5.4',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }],
      stream: true,
    });
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

  it('keeps ingress payload unchanged when routeParams is absent', () => {
    const ingress = {
      model: 'raw-model',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw user' }] }],
    } as Record<string, unknown>;

    const output = applyMinimalDirectOverrides(ingress, {});
    expect(output).toEqual(ingress);
  });

  it('rejects historical chat-style function tools on responses direct', () => {
    expect(() => assertDirectRouteDecision({
      inboundProtocol: 'openai-responses',
      payload: {
        model: 'gpt-5.5',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
        tools: [{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } }],
      },
    })).toThrow(/Responses wire requires top-level tool\.name/);
  });

  it('rejects any responses direct tool array that mixes chat-style function tools without top-level name', () => {
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
      })).toThrow(new RegExp(`tools\\[${invalidIndex}\\].*top-level tool\\.name`));
    }
  });

  it('rejects historical chat-style messages on responses direct', () => {
    expect(() => assertDirectRouteDecision({
      inboundProtocol: 'openai-responses',
      payload: {
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).toThrow(/chat-style "messages"/);
  });

  it('rejects historical responses tool input content on responses direct', () => {
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
    })).toThrow(/function_call_output must not carry content/);
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

  it('does not force relay for legacy servertool apply_patch metadata', () => {
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
      reason: undefined,
      hasDeclaredApplyPatchTool: true,
    });
  });
});
