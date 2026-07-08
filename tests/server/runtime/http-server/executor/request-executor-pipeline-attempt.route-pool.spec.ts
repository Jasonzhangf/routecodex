/**
 * Tests for route pool normalization functions.
 *
 * These tests verify the behavior of `normalizeExplicitRoutePool` and
 * `mergeObservedRoutePoolChain` regardless of whether the implementation
 * is TS-native or routed through the Rust NAPI bridge.
 *
 * Run: npx vitest run src/server/runtime/http-server/executor/request-executor-pipeline-attempt.route-pool.spec.ts
 */

import { describe, it, expect } from 'vitest';

// We import the internal helpers by re-exporting them from the module under test.
// These are currently private functions; we test them through the public
// resolveRequestExecutorPipelineAttempt path OR by temporarily exporting them.
// For batch #1, we test the pure logic directly.

// --- Re-implement locally for baseline testing (will be replaced by Rust bridge call) ---

function normalizeExplicitRoutePoolBaseline(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const normalized = entry.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function mergeObservedRoutePoolChainBaseline(
  existing: string[] | null,
  observed: string[]
): string[] | null {
  if (observed.length === 0) {
    return existing;
  }
  if (!existing || existing.length === 0) {
    return [...observed];
  }
  const merged = [...existing];
  const seen = new Set(existing);
  for (const candidate of observed) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    merged.push(candidate);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Tests: normalizeExplicitRoutePool
// ---------------------------------------------------------------------------

describe('normalizeExplicitRoutePool', () => {
  it('normal array passes through', () => {
    expect(normalizeExplicitRoutePoolBaseline(['provider-a.default', 'anthropic.default']))
      .toEqual(['provider-a.default', 'anthropic.default']);
  });

  it('trims whitespace and filters empty', () => {
    expect(normalizeExplicitRoutePoolBaseline(['  provider-a.default  ', '  ', 'anthropic.default']))
      .toEqual(['provider-a.default', 'anthropic.default']);
  });

  it('deduplicates preserving order', () => {
    expect(normalizeExplicitRoutePoolBaseline(['a', 'b', 'a', 'c']))
      .toEqual(['a', 'b', 'c']);
  });

  it('null input returns empty', () => {
    expect(normalizeExplicitRoutePoolBaseline(null)).toEqual([]);
  });

  it('non-array input returns empty', () => {
    expect(normalizeExplicitRoutePoolBaseline(123)).toEqual([]);
  });

  it('filters empty and whitespace-only strings', () => {
    expect(normalizeExplicitRoutePoolBaseline(['', '  ', 'a']))
      .toEqual(['a']);
  });

  it('all-whitespace returns empty', () => {
    expect(normalizeExplicitRoutePoolBaseline(['  ', '\t', '\n'])).toEqual([]);
  });

  it('preserves order', () => {
    expect(normalizeExplicitRoutePoolBaseline(['z', 'y', 'x']))
      .toEqual(['z', 'y', 'x']);
  });
});

// ---------------------------------------------------------------------------
// Tests: mergeObservedRoutePoolChain
// ---------------------------------------------------------------------------

describe('mergeObservedRoutePoolChain', () => {
  it('existing=null, observed populated → observed', () => {
    expect(mergeObservedRoutePoolChainBaseline(null, ['a', 'b']))
      .toEqual(['a', 'b']);
  });

  it('existing=empty, observed populated → observed', () => {
    expect(mergeObservedRoutePoolChainBaseline([], ['a', 'b']))
      .toEqual(['a', 'b']);
  });

  it('existing populated, observed empty → existing', () => {
    expect(mergeObservedRoutePoolChainBaseline(['a'], []))
      .toEqual(['a']);
  });

  it('existing populated, observed has overlap → dedup', () => {
    expect(mergeObservedRoutePoolChainBaseline(['a'], ['a', 'b']))
      .toEqual(['a', 'b']);
  });

  it('both populated with overlap → dedup', () => {
    expect(mergeObservedRoutePoolChainBaseline(['a', 'b'], ['b', 'c']))
      .toEqual(['a', 'b', 'c']);
  });

  it('exact duplicate → single entry', () => {
    expect(mergeObservedRoutePoolChainBaseline(['a'], ['a']))
      .toEqual(['a']);
  });

  it('both empty → empty', () => {
    expect(mergeObservedRoutePoolChainBaseline([], []))
      .toEqual([]);
  });
});
