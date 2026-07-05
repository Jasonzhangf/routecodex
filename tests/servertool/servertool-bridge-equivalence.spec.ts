import { describe, expect, it } from '@jest/globals';
import * as newPath from '../../sharedmodule/llmswitch-core/dist/native/servertool-wrapper.js';

describe('servertool bridge equivalence (package shim integrity)', () => {
  it('keeps package shim native wrappers as callable functions', () => {
    const nonFunctionExports = Object.entries(newPath)
      .filter(([name]) => name.endsWith('WithNative'))
      .filter(([, value]) => typeof value !== 'function')
      .map(([name]) => name)
      .sort();

    expect(nonFunctionExports).toEqual([]);
  });
});
