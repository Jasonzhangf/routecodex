import { describe, expect, test } from '@jest/globals';

import { applyQwenRequestTransform } from '../../src/conversion/compat/actions/qwen-transform.js';

describe('qwen compat reasoning defaults', () => {
  test('defaults reasoning to true when not specified', () => {
    const payload: any = {
      model: 'qwen3.5-plus',
      messages: [{ role: 'user', content: 'hi' }]
    };

    const out = applyQwenRequestTransform(payload) as any;

    expect(out.parameters).toBeTruthy();
    expect(out.parameters.reasoning).toBe(true);
  });

  test('does not enable reasoning when effort is low', () => {
    const payload: any = {
      model: 'qwen3.5-plus',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
      reasoning: { effort: 'low' }
    };

    const out = applyQwenRequestTransform(payload) as any;

    expect(out.parameters).toBeTruthy();
    expect(out.parameters.temperature).toBe(0.2);
    expect(out.parameters.reasoning).toBeUndefined();
  });

  test('forces reasoning true when explicitly non-low', () => {
    const payload: any = {
      model: 'qwen3.5-plus',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning: { effort: 'high', summary: 'auto' }
    };

    const out = applyQwenRequestTransform(payload) as any;

    expect(out.parameters).toBeTruthy();
    expect(out.parameters.reasoning).toBe(true);
  });
});
