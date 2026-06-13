import { describe, expect, it } from '@jest/globals';

import {
  evaluateDirectRouteDecision,
  requireDirectPassthroughPayloadObject,
} from '../../../../src/server/runtime/http-server/direct-passthrough-payload.js';

describe('direct-passthrough-payload', () => {
  it('allows chat-style function tools on responses same-protocol direct', () => {
    const body = {
      model: 'gpt-5.5',
      stream_options: { include_usage: true },
      tools: [{ type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } }],
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    };

    const resolved = requireDirectPassthroughPayloadObject(body);
    const decision = evaluateDirectRouteDecision({
      payload: body,
      metadata: {},
      inboundProtocol: 'openai-responses',
      applyPatchMode: 'direct',
    });

    expect(resolved).toBe(body);
    expect(resolved).toEqual(body);
    expect(decision.providerWireValid).toBe(true);
    expect(decision.requiresHubRelay).toBe(false);
  });

  it('rejects historical responses tool input content on direct', () => {
    const body = {
      model: 'gpt-5.5',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'ok',
          content: [{ type: 'output_text', text: 'historical leak' }],
        }
      ],
    };

    const result = requireDirectPassthroughPayloadObject(body);
    const decision = evaluateDirectRouteDecision({
      payload: body,
      metadata: {},
      inboundProtocol: 'openai-responses',
      applyPatchMode: 'direct',
    });

    expect(result).toBe(body);
    expect(result).toEqual(body);
    expect(decision.providerWireValid).toBe(false);
    expect(decision.requiresHubRelay).toBe(false);
  });

  it('fails fast when direct payload is not an object', () => {
    expect(() => requireDirectPassthroughPayloadObject(null)).toThrow(
      'provider-runtime-error: direct passthrough payload must be an object',
    );
    expect(() => requireDirectPassthroughPayloadObject([])).toThrow(
      'provider-runtime-error: direct passthrough payload must be an object',
    );
  });
});
