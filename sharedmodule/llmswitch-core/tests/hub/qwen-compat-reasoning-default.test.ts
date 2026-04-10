import { describe, expect, test } from '@jest/globals';

import { applyQwenRequestTransform } from '../../src/conversion/compat/actions/qwen-transform.js';

describe('qwen compat reasoning defaults', () => {
  test('keeps request unchanged when reasoning is not specified', () => {
    const payload: any = {
      model: 'qwen3.5-plus',
      messages: [{ role: 'user', content: 'hi' }]
    };

    const out = applyQwenRequestTransform(payload) as any;

    expect(out.reasoning).toBeUndefined();
  });

  test('preserves low-effort reasoning and sibling top-level fields', () => {
    const payload: any = {
      model: 'qwen3.5-plus',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
      reasoning: { effort: 'low' }
    };

    const out = applyQwenRequestTransform(payload) as any;

    expect(out.temperature).toBe(0.2);
    expect(out.reasoning).toEqual({ effort: 'low' });
  });

  test('preserves structured reasoning when explicitly provided', () => {
    const payload: any = {
      model: 'qwen3.5-plus',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning: { effort: 'high', summary: 'auto' }
    };

    const out = applyQwenRequestTransform(payload) as any;

    expect(out.reasoning).toEqual({ effort: 'high', summary: 'auto' });
  });
});
