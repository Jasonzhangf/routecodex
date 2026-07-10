import { describe, expect, it } from '@jest/globals';
import * as newPath from '../../sharedmodule/llmswitch-core/dist/native/servertool-wrapper.js';

describe('servertool bridge equivalence (package shim integrity)', () => {
  it('keeps package shim free of production per-capability wrappers', () => {
    const leakedWrapperExports = Object.keys(newPath)
      .filter((name) => name.endsWith('WithNative'))
      .sort();

    expect(leakedWrapperExports).toEqual([]);
  });
});
