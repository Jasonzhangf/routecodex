import { describe, expect, it } from '@jest/globals';
import * as oldPath from '../../sharedmodule/llmswitch-core/dist/native/router-hotpath/native-servertool-core-semantics.js';
import * as newPath from '../../sharedmodule/llmswitch-core/dist/native/servertool-wrapper.js';

describe('servertool bridge equivalence (legacy native path vs package shim)', () => {
  it('exports every legacy servertool native wrapper through the package shim', () => {
    const missing = Object.entries(oldPath)
      .filter(([name, value]) => name.endsWith('WithNative') && typeof value === 'function')
      .filter(([name]) => typeof (newPath as Record<string, unknown>)[name] !== 'function')
      .map(([name]) => name)
      .sort();

    expect(missing).toEqual([]);
  });

  it('keeps package shim native wrappers as callable functions', () => {
    const nonFunctionExports = Object.entries(newPath)
      .filter(([name]) => name.endsWith('WithNative'))
      .filter(([, value]) => typeof value !== 'function')
      .map(([name]) => name)
      .sort();

    expect(nonFunctionExports).toEqual([]);
  });
});
