import { describe, expect, it } from '@jest/globals';

import {
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

    expect(resolved).toBe(body);
    expect(resolved).toEqual(body);
  });

  it('keeps historical responses tool input content on direct without wire-shape preflight', () => {
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

    expect(result).toBe(body);
    expect(result).toEqual(body);
  });

  it('does not evaluate stopless relay decisions in direct payload helper', () => {
    const body = {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    };

    expect(requireDirectPassthroughPayloadObject(body)).toBe(body);
  });

  it('keeps cyclic metadata out of direct payload helper', () => {
    const body = {
      model: 'gpt-5.5',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'describe this image' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
          ],
        },
      ],
    };
    const metadata: Record<string, unknown> = {
      stopMessageEnabled: true,
    };
    metadata.self = metadata;

    expect(requireDirectPassthroughPayloadObject(body)).toBe(body);
  });

  it('keeps non-JSON internal carriers out of payload helper decisions', () => {
    const body: Record<string, unknown> = {
      model: 'gpt-5.5',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'describe this image' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
          ],
        },
      ],
      tools: [{ type: 'function', name: 'apply_patch', parameters: { type: 'object' } }],
    };
    body.__rt = body;

    expect(requireDirectPassthroughPayloadObject(body)).toBe(body);
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
