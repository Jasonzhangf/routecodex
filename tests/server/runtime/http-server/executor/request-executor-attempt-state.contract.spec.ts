import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

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
  it('keeps remaining retry provider pin flat residue localized to the prepare step', () => {
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

    expect(prepareBlock).toContain(
      'metadataForAttempt.__routecodexRetryProviderKey = args.retryProviderKey;'
    );
    expect(prepareBlock).toContain(
      "Object.prototype.hasOwnProperty.call(metadataForAttempt, '__routecodexRetryProviderKey')"
    );
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
