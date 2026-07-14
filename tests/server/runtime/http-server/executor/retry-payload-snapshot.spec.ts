import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  prepareRequestPayloadRetrySeed,
  resetRetrySnapshotStateForTests,
  resolveOriginalRequestForResponseConversion,
  restoreRequestPayloadFromRetrySeed
} from '../../../../../src/server/runtime/http-server/executor/retry-payload-snapshot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const retryPayloadSnapshotSourcePath = path.resolve(
  __dirname,
  '../../../../../src/server/runtime/http-server/executor/retry-payload-snapshot.ts'
);

describe('retry payload snapshot cleanup', () => {
  it('does not keep unused fallback payload restore path', () => {
    const source = fs.readFileSync(retryPayloadSnapshotSourcePath, 'utf8');

    expect(source).not.toContain('fallbackPayload');
    expect(source).not.toContain('serializeRequestPayloadForRetry');
    expect(source).not.toContain('restoreRequestPayloadFromRetrySnapshot');
    expect(source).not.toContain("mode: 'serialized'");
  });

  it('borrows object payloads without eager JSON serialization or structured clone', () => {
    resetRetrySnapshotStateForTests();
    const originalStringify = JSON.stringify;
    const originalStructuredClone = globalThis.structuredClone;
    let stringifyCalls = 0;
    let structuredCloneCalls = 0;
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
      stringifyCalls += 1;
      return originalStringify(...args);
    }) as typeof JSON.stringify;
    globalThis.structuredClone = ((value: unknown) => {
      structuredCloneCalls += 1;
      return originalStructuredClone(value);
    }) as typeof structuredClone;
    try {
      const payload = {
        model: 'gpt-test',
        input: [{ role: 'user', content: 'hello' }]
      };
      const seed = prepareRequestPayloadRetrySeed(payload);

      expect(seed).toEqual({ mode: 'borrowed', sourcePayload: payload });
      expect(stringifyCalls).toBe(0);
      expect(structuredCloneCalls).toBe(0);
      expect(resolveOriginalRequestForResponseConversion(seed)).toBe(payload);
    } finally {
      JSON.stringify = originalStringify;
      globalThis.structuredClone = originalStructuredClone;
    }
  });

  it('materializes a borrowed retry payload only when restore is requested', () => {
    const payload = {
      model: 'gpt-test',
      input: [{ role: 'user', content: 'hello' }]
    };
    const seed = prepareRequestPayloadRetrySeed(payload);
    const restored = restoreRequestPayloadFromRetrySeed(seed);

    expect(restored).toEqual(payload);
    expect(restored).not.toBe(payload);
    expect((restored?.input as Array<Record<string, unknown>>)[0]).not.toBe(payload.input[0]);
  });

  it('fails explicitly instead of JSON serializing when borrowed retry restore cannot clone', () => {
    const payload = {
      model: 'gpt-test',
      input: [{ role: 'user', content: 'hello' }]
    };
    const seed = prepareRequestPayloadRetrySeed(payload);
    const originalStructuredClone = globalThis.structuredClone;
    const originalStringify = JSON.stringify;
    let stringifyCalls = 0;
    globalThis.structuredClone = (() => undefined) as typeof structuredClone;
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
      stringifyCalls += 1;
      return originalStringify(...args);
    }) as typeof JSON.stringify;
    try {
      expect(restoreRequestPayloadFromRetrySeed(seed)).toBeUndefined();
      expect(stringifyCalls).toBe(0);
    } finally {
      globalThis.structuredClone = originalStructuredClone;
      JSON.stringify = originalStringify;
    }
  });
});
