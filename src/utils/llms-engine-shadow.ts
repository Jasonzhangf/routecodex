import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildInfo } from '../build-info.js';
import { resolveLlmswitchCoreVersion } from './runtime-versions.js';

export type LlmsEngineShadowConfig = {
  enabled: boolean;
  sampleRate: number;
  shadowPrefixes: string[];
  dir: string;
};

function resolveBoolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function resolveNumberFromEnv(value: string | undefined, fallback: number): number {
  if (!value || !value.trim()) {
    return fallback;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) {
    return 1;
  }
  if (n <= 0) {
    return 0;
  }
  if (n >= 1) {
    return 1;
  }
  return n;
}

function parsePrefixList(raw: string | undefined): string[] {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^\/*/, '').replace(/\/+$/, ''));
}

function matchesPrefix(subpath: string, prefixes: string[]): boolean {
  if (!prefixes.length) {
    return false;
  }
  const normalized = subpath.replace(/^\/*/, '').replace(/\.js$/i, '');
  return prefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

export function resolveLlmsEngineShadowConfig(): LlmsEngineShadowConfig {
  const enabled = resolveBoolFromEnv(process.env.ROUTECODEX_LLMS_ENGINE_ENABLE, false);
  const sampleRate = clamp01(resolveNumberFromEnv(process.env.ROUTECODEX_LLMS_SHADOW_SAMPLE_RATE, 0.1));
  const shadowPrefixes = parsePrefixList(process.env.ROUTECODEX_LLMS_SHADOW_PREFIXES);
  const dir =
    (process.env.ROUTECODEX_LLMS_SHADOW_DIR && process.env.ROUTECODEX_LLMS_SHADOW_DIR.trim())
      ? process.env.ROUTECODEX_LLMS_SHADOW_DIR.trim()
      : path.join(os.homedir(), '.routecodex', 'llms-shadow');
  return { enabled, sampleRate, shadowPrefixes, dir };
}

export function shouldRunLlmsEngineShadowForSubpath(config: LlmsEngineShadowConfig, subpath: string): boolean {
  if (!config.enabled) {
    return false;
  }
  if (!matchesPrefix(subpath, config.shadowPrefixes)) {
    return false;
  }
  if (config.sampleRate <= 0) {
    return false;
  }
  if (config.sampleRate >= 1) {
    return true;
  }
  return Math.random() < config.sampleRate;
}

export function isLlmsEngineShadowEnabledForSubpath(config: LlmsEngineShadowConfig, subpath: string): boolean {
  return config.enabled && matchesPrefix(subpath, config.shadowPrefixes) && config.sampleRate > 0;
}

function diffPayloads(expected: unknown, actual: unknown, p = '<root>'): Array<{ path: string; expected: unknown; actual: unknown }> {
  if (Object.is(expected, actual)) {
    return [];
  }
  if (typeof expected !== typeof actual) {
    return [{ path: p, expected, actual }];
  }
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
      if (!(key in actualObj)) {
        diffs.push({ path: next, expected: expectedObj[key], actual: undefined });
      } else if (!(key in expectedObj)) {
        diffs.push({ path: next, expected: undefined, actual: actualObj[key] });
      } else {
        diffs.push(...diffPayloads(expectedObj[key], actualObj[key], next));
      }
    }
    return diffs;
  }
  return [{ path: p, expected, actual }];
}

function cloneJsonSafe<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function deletePath(root: unknown, pathExpr: string): void {
  if (!root || typeof root !== 'object') {
    return;
  }
  const parts = pathExpr.split('.').filter(Boolean);
  let cursor: any = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i]!;
    if (!cursor || typeof cursor !== 'object') {
      return;
    }
    cursor = cursor[key];
  }
  const last = parts[parts.length - 1];
  if (!last) {
    return;
  }
  if (cursor && typeof cursor === 'object' && Object.prototype.hasOwnProperty.call(cursor, last)) {
    delete cursor[last];
  }
}

const DEFAULT_EXCLUDED_COMPARE_PATHS = [
  // internal ids
  'providerPayload.requestId',
  'providerPayload.metadata.context.requestId',
  'providerPayload.metadata.responsesContext.requestId',
  'providerPayload.metadata.context.__disableHubSnapshots',
  // debug-only fields
  'providerPayload.stageExpectations',
  'providerPayload.stages',
  'providerPayload.anthropicMirror',
  'providerPayload.toolsFieldPresent'
];

export async function recordLlmsEngineShadowDiff(options: {
  group: 'hub-pipeline' | 'provider-response';
  requestId: string;
  subpath: string;
  baselineImpl: 'ts';
  candidateImpl: 'engine';
  baselineOut: unknown;
  candidateOut: unknown;
  excludedComparePaths?: string[];
}): Promise<void> {
  const excludedComparePaths = options.excludedComparePaths?.length
    ? options.excludedComparePaths
    : DEFAULT_EXCLUDED_COMPARE_PATHS;

  const prepareForDiff = (value: unknown): unknown => {
    if (!excludedComparePaths.length) {
      return value;
    }
    const cloned = cloneJsonSafe(value);
    for (const p of excludedComparePaths) {
      deletePath(cloned, p);
    }
    return cloned;
  };

  const diffs = diffPayloads(prepareForDiff(options.baselineOut), prepareForDiff(options.candidateOut));
  if (!diffs.length) {
    return;
  }

  const llmsVersion = resolveLlmswitchCoreVersion();
  const record = {
    kind: 'llms-engine-shadow-diff',
    timestamp: new Date().toISOString(),
    group: options.group,
    subpath: options.subpath,
    requestId: options.requestId,
    excludedComparePaths,
    runtime: {
      routecodex: {
        version: buildInfo.version,
        mode: buildInfo.mode
      },
      llmswitchCore: llmsVersion ? { version: llmsVersion } : undefined,
      node: { version: process.version }
    },
    baselineImpl: options.baselineImpl,
    candidateImpl: options.candidateImpl,
    diffCount: diffs.length,
    diffPaths: diffs.slice(0, 200).map((d) => d.path),
    baselineOut: options.baselineOut,
    candidateOut: options.candidateOut
  };

  const baseDir = options.group;
  const dir = path.join(options.subpath ? options.subpath.replace(/\//g, '__') : 'unknown');
  const outDir = path.join(baseDir, dir);
  const root = resolveLlmsEngineShadowConfig().dir;
  const fullDir = path.join(root, outDir);
  await fs.mkdir(fullDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(fullDir, `${stamp}-${options.requestId}.json`);
  await fs.writeFile(file, JSON.stringify(record, null, 2), 'utf8');
  // eslint-disable-next-line no-console
  console.error(`[llms-engine-shadow] wrote diff: ${file} (count=${diffs.length})`);
}
