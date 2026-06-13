import { describe, expect, it } from '@jest/globals';

import {
  requireDirectPassthroughPayloadObject,
} from '../../../../src/server/runtime/http-server/direct-passthrough-payload.js';

describe('direct-passthrough-payload', () => {
  it('returns the original direct body object without rewriting it', () => {
    const body = {
      model: 'gpt-5.5',
      stream_options: { include_usage: true },
      tools: [{ type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } }],
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    };

    const result = requireDirectPassthroughPayloadObject(body);

    expect(result).toBe(body);
    expect(result).toEqual(body);
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
