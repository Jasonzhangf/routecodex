import { describe, expect, it } from '@jest/globals';

import {
  INTERNAL_ERROR_NUMBERING_FEATURE_ID,
  INTERNAL_ERROR_CODE_REGISTRY_ENTRIES,
  createInternalDebugErrorRegistry,
  resolveInternalDebugErrorCode,
  type InternalErrorCodeRegistryEntry,
} from '../../src/debug/internal-error/index.js';

describe('feature_id: debug.internal_error_numbering registry', () => {
  it('registers stable request/response/other internal debug error lanes', () => {
    const registry = createInternalDebugErrorRegistry();

    expect(INTERNAL_ERROR_NUMBERING_FEATURE_ID).toBe('feature_id: debug.internal_error_numbering');
    expect(resolveInternalDebugErrorCode('500-100', registry)).toEqual(expect.objectContaining({
      lane: 'request',
      moduleBlock: '500-10x',
    }));
    expect(resolveInternalDebugErrorCode('500-200', registry)).toEqual(expect.objectContaining({
      lane: 'response',
      moduleBlock: '500-20x',
    }));
    expect(resolveInternalDebugErrorCode('500-300', registry)).toEqual(expect.objectContaining({
      lane: 'other',
      moduleBlock: '500-30x',
    }));
  });

  it('[reverse] rejects duplicate internal debug error codes', () => {
    const duplicate = [
      ...INTERNAL_ERROR_CODE_REGISTRY_ENTRIES,
      { ...INTERNAL_ERROR_CODE_REGISTRY_ENTRIES[0] },
    ];

    expect(() => createInternalDebugErrorRegistry(duplicate)).toThrow(/duplicate internal debug error code/);
  });

  it('[reverse] rejects wrong lane and malformed range', () => {
    const wrongLane: InternalErrorCodeRegistryEntry = {
      ...INTERNAL_ERROR_CODE_REGISTRY_ENTRIES[0],
      code: '500-200',
      lane: 'request',
      title: 'wrong lane fixture',
    };
    expect(() => createInternalDebugErrorRegistry([wrongLane])).toThrow(/belongs to response, not request/);

    const malformed = {
      ...INTERNAL_ERROR_CODE_REGISTRY_ENTRIES[0],
      code: '500-999',
      title: 'malformed fixture',
    } as InternalErrorCodeRegistryEntry;
    expect(() => createInternalDebugErrorRegistry([malformed])).toThrow(/invalid internal debug error code format/);
  });
});
