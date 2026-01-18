import { buildInfo } from '../../../build-info.js';
import { writeErrorsampleJson } from '../../../utils/errorsamples.js';

export type HubShadowCompareConfig = {
  enabled: boolean;
  sampleRate: number;
  baselineMode: 'off' | 'observe' | 'enforce';
};

function resolveBoolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function resolveNumberFromEnv(value: string | undefined, fallback: number): number {
  if (!value || !value.trim()) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 1;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

export function resolveHubShadowCompareConfig(): HubShadowCompareConfig {
  const defaultEnabled = buildInfo.mode !== 'release';
  const enabled = resolveBoolFromEnv(process.env.ROUTECODEX_UNIFIED_HUB_SHADOW_COMPARE, defaultEnabled);
  const sampleRate = clamp01(resolveNumberFromEnv(process.env.ROUTECODEX_UNIFIED_HUB_SHADOW_COMPARE_SAMPLE_RATE, 1));
  const baselineModeRaw = String(process.env.ROUTECODEX_UNIFIED_HUB_SHADOW_BASELINE_MODE || 'off').trim().toLowerCase();
  const baselineMode =
    baselineModeRaw === 'observe' || baselineModeRaw === 'enforce' ? baselineModeRaw : 'off';
  return { enabled, sampleRate, baselineMode };
}

export function shouldRunHubShadowCompare(config: HubShadowCompareConfig): boolean {
  if (!config.enabled) return false;
  if (config.sampleRate <= 0) return false;
  if (config.sampleRate >= 1) return true;
  return Math.random() < config.sampleRate;
}

function summarizeValue(value: unknown): unknown {
  if (value === undefined) return 'undefined';
  if (value === null) return null;
  if (typeof value === 'string') {
    return value.length > 240 ? `${value.slice(0, 200)}...(len=${value.length})` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return `[array length=${value.length}]`;
  if (value && typeof value === 'object') return `[object keys=${Object.keys(value as object).length}]`;
  return String(value);
}

function diffPayloads(expected: unknown, actual: unknown, p = '<root>'): Array<{ path: string; expected: unknown; actual: unknown }> {
  if (Object.is(expected, actual)) return [];
  if (typeof expected !== typeof actual) return [{ path: p, expected, actual }];
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const max = Math.max(expected.length, actual.length);
    const diffs: Array<{ path: string; expected: unknown; actual: unknown }> = [];
    for (let i = 0; i < max; i += 1) {
      diffs.push(...diffPayloads(expected[i], actual[i], `${p}[${i}]`));
    }
    return diffs;
  }
  if (expected && typeof expected === 'object' && actual && typeof actual === 'object') {
    const expectedObj = expected as Record<string, unknown>;
    const actualObj = actual as Record<string, unknown>;
    const keys = new Set([...Object.keys(expectedObj), ...Object.keys(actualObj)]);
    const diffs: Array<{ path: string; expected: unknown; actual: unknown }> = [];
    for (const key of keys) {
      const next = p === '<root>' ? key : `${p}.${key}`;
      if (!(key in actualObj)) diffs.push({ path: next, expected: expectedObj[key], actual: undefined });
      else if (!(key in expectedObj)) diffs.push({ path: next, expected: undefined, actual: actualObj[key] });
      else diffs.push(...diffPayloads(expectedObj[key], actualObj[key], next));
    }
    return diffs;
  }
  return [{ path: p, expected, actual }];
}

export async function recordHubShadowCompareDiff(options: {
  requestId: string;
  entryEndpoint: string;
  routeHint?: string;
  candidateMode?: string;
  baselineMode: string;
  baselineOut: unknown;
  candidateOut: unknown;
  excludedProviderKeys?: string[];
  attempt?: number;
}): Promise<void> {
  const diffs = diffPayloads(options.baselineOut, options.candidateOut);
  if (!diffs.length) return;

  const record = {
    kind: 'unified-hub-shadow-runtime-diff',
    timestamp: new Date().toISOString(),
    requestId: options.requestId,
    entryEndpoint: options.entryEndpoint,
    routeHint: options.routeHint,
    attempt: options.attempt,
    excludedProviderKeys: options.excludedProviderKeys || [],
    baselineMode: options.baselineMode,
    candidateMode: options.candidateMode,
    diffCount: diffs.length,
    diffPaths: diffs.slice(0, 200).map((d) => d.path),
    diffHead: diffs.slice(0, 200).map((d) => ({
      path: d.path,
      baseline: summarizeValue(d.expected),
      candidate: summarizeValue(d.actual)
    })),
    diffsTruncated: diffs.length > 200,
    baseline: options.baselineOut,
    candidate: options.candidateOut
  };
  const file = await writeErrorsampleJson({
    group: 'unified-hub-shadow-runtime',
    kind: 'diff',
    payload: record
  });
  // eslint-disable-next-line no-console
  console.error(`[unified-hub-shadow-runtime] wrote errorsample: ${file}`);
}

