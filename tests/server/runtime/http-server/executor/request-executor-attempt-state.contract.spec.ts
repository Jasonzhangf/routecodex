import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { MetadataCenter } from '../../../../../src/server/runtime/http-server/metadata-center/metadata-center.js';
import { prepareRequestExecutorAttemptState } from '../../../../../src/server/runtime/http-server/executor/request-executor-attempt-state.js';

const ROOT = process.cwd();
const ATTEMPT_STATE_PATH = path.join(
  ROOT,
  'src/server/runtime/http-server/executor/request-executor-attempt-state.ts'
);

function sliceBetween(source: string, startMarker: string, endMarker?: string): string {
  const start = source.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  if (!endMarker) {
    return source.slice(start);
  }
  const end = source.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('request-executor attempt-state contract', () => {
  it('moves retry provider pin into MetadataCenter runtime_control at runtime', () => {
    const initialMetadata: Record<string, unknown> = {
      __routecodexRetryProviderKey: 'legacy.flat.should.be.deleted',
      excludedProviderKeys: ['first.provider'],
    };
    const input = {
      requestId: 'req-attempt-1',
      body: { model: 'gpt-5.5', input: [] },
    } as never;

    const result = prepareRequestExecutorAttemptState({
      input,
      providerRequestId: 'req-attempt-2',
      retryPayloadSeed: { mode: 'none' },
      attempt: 2,
      initialMetadata,
      excludedProviderKeys: new Set(['first.provider']),
      retryProviderKey: 'retry.provider.gpt-5.5',
      inboundClientHeaders: undefined,
      clientRequestId: 'client-req-1',
      throwIfClientAbortSignalAborted: () => {},
    });

    expect(result.metadataForAttempt).not.toHaveProperty('__routecodexRetryProviderKey');
    expect(result.metadataForAttempt).not.toHaveProperty('excludedProviderKeys');
    expect(MetadataCenter.read(result.metadataForAttempt)?.readRuntimeControl().retryProviderKey)
      .toBe('retry.provider.gpt-5.5');
  });

  it('writes retry provider pin to MetadataCenter runtime_control instead of flat metadata', () => {
    const source = fs.readFileSync(ATTEMPT_STATE_PATH, 'utf8');
    const prepareBlock = sliceBetween(
      source,
      `export function ${'prepareRequestExecutorAttemptState'}`,
      `export function ${'finalizeRequestExecutorAttemptMetadata'}`
    );
    const finalizeBlock = sliceBetween(
      source,
      `export function ${'finalizeRequestExecutorAttemptMetadata'}`
    );

    expect(prepareBlock).toContain('writeRuntimeControl(');
    expect(prepareBlock).toContain("'retryProviderKey'");
    expect(prepareBlock).not.toContain('metadataForAttempt.__routecodexRetryProviderKey =');
    expect(prepareBlock).toContain("delete metadataForAttempt.__routecodexRetryProviderKey;");
    expect(finalizeBlock).not.toContain('__routecodexRetryProviderKey');
    expect(source).not.toContain('__routecodexPreselectedRoute');
  });

  it('merges runtime-control carrier state without reviving flat route-control backfill on merged metadata', () => {
    const source = fs.readFileSync(ATTEMPT_STATE_PATH, 'utf8');
    const finalizeBlock = sliceBetween(
      source,
      `export function ${'finalizeRequestExecutorAttemptMetadata'}`
    );

    expect(finalizeBlock).toContain(
      'const runtimeControlSnapshot = pipelineMetadataCenter.snapshot().runtimeControl;'
    );
    expect(finalizeBlock).toContain('mergedCenter?.writeRuntimeControl(');
    expect(finalizeBlock).not.toContain('mergedMetadata.__routecodexRetryProviderKey');
    expect(finalizeBlock).not.toContain('mergedMetadata.__routecodexPreselectedRoute');
  });
});
