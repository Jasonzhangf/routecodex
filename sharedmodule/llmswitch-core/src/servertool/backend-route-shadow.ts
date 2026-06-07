import type { StageRecorder } from '../conversion/hub/format-adapters/index.js';
import type { JsonObject, JsonValue } from '../conversion/hub/types/json.js';
import { isJsonObject, jsonClone } from '../conversion/hub/types/json.js';

export type HubFollowupMode = 'off' | 'shadow' | 'enforce';

export interface HubFollowupConfig {
  mode: HubFollowupMode;
  sampleRate?: number;
}

function clampSampleRate(value: unknown): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? value : 1;
  if (num <= 0) return 0;
  if (num >= 1) return 1;
  return num;
}

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function shouldSample(config: HubFollowupConfig, requestId: string | undefined): boolean {
  const rate = clampSampleRate(config.sampleRate);
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  const key = typeof requestId === 'string' && requestId.trim().length ? requestId.trim() : 'no_request_id';
  const bucket = fnv1a32(key) / 0xffffffff;
  return bucket < rate;
}

function readMode(raw: string): HubFollowupMode | null {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'off' || normalized === '0' || normalized === 'false') return 'off';
  if (normalized === 'shadow') return 'shadow';
  if (normalized === 'enforce') return 'enforce';
  return null;
}

export function resolveHubFollowupConfigFromEnv(): HubFollowupConfig {
  const raw = String(process.env.ROUTECODEX_HUB_FOLLOWUP_MODE || '').trim();
  const mode = readMode(raw) ?? 'off';
  const sampleRateRaw = String(process.env.ROUTECODEX_HUB_FOLLOWUP_SAMPLE_RATE || '').trim();
  const sampleRate = sampleRateRaw ? Number(sampleRateRaw) : undefined;
  return {
    mode,
    ...(Number.isFinite(sampleRate) ? { sampleRate } : {})
  };
}

function dropKeyByPrefix(root: Record<string, unknown>, prefixes: string[]): void {
  for (const key of Object.keys(root)) {
    if (prefixes.some((p) => key.startsWith(p))) {
      try {
        delete (root as any)[key];
      } catch {
        (root as any)[key] = undefined;
      }
    }
  }
}

function normalizeFollowupPayload(payload: JsonObject): JsonObject {
  const out = jsonClone(payload as unknown as JsonValue) as JsonObject;
  const record = out as unknown as Record<string, unknown>;

  // Followup requests must be non-streaming and must not carry route hints.
  if (record.stream !== undefined) {
    record.stream = false;
  }
  if (record.routeHint !== undefined) {
    delete (record as any).routeHint;
  }
  if (record.route_hint !== undefined) {
    delete (record as any).route_hint;
  }

  // Remove internal/private carriers from the body (metadata belongs to request metadata, not body).
  dropKeyByPrefix(record, ['__']);

  const parameters = record.parameters;
  if (isJsonObject(parameters as JsonValue)) {
    const params = parameters as unknown as Record<string, unknown>;
    if (params.stream !== undefined) {
      delete (params as any).stream;
    }
  }
  return out;
}

type DiffItem = { path: string; baseline: unknown; candidate: unknown };

function diffPayloads(baseline: unknown, candidate: unknown, p = '<root>'): DiffItem[] {
  if (Object.is(baseline, candidate)) return [];
  if (typeof baseline !== typeof candidate) return [{ path: p, baseline, candidate }];
  if (Array.isArray(baseline) && Array.isArray(candidate)) {
    const max = Math.max(baseline.length, candidate.length);
    const diffs: DiffItem[] = [];
    for (let i = 0; i < max; i += 1) {
      diffs.push(...diffPayloads(baseline[i], candidate[i], `${p}[${i}]`));
    }
    return diffs;
  }
  if (baseline && typeof baseline === 'object' && candidate && typeof candidate === 'object') {
    const a = baseline as Record<string, unknown>;
    const b = candidate as Record<string, unknown>;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const diffs: DiffItem[] = [];
    for (const key of keys) {
      const next = p === '<root>' ? key : `${p}.${key}`;
      if (!(key in b)) diffs.push({ path: next, baseline: a[key], candidate: undefined });
      else if (!(key in a)) diffs.push({ path: next, baseline: undefined, candidate: b[key] });
      else diffs.push(...diffPayloads(a[key], b[key], next));
    }
    return diffs;
  }
  return [{ path: p, baseline, candidate }];
}

export function applyHubFollowupPolicyShadow(args: {
  config?: HubFollowupConfig;
  requestId?: string;
  entryEndpoint?: string;
  flowId?: string;
  payload: JsonObject;
  stageRecorder?: StageRecorder;
}): JsonObject {
  const cfg = args.config ?? resolveHubFollowupConfigFromEnv();
  if (!cfg || cfg.mode === 'off') {
    return args.payload;
  }
  if (!shouldSample(cfg, args.requestId)) {
    return args.payload;
  }
  const candidate = normalizeFollowupPayload(args.payload);
  const diffs = diffPayloads(args.payload, candidate);
  if (diffs.length > 0) {
    const stage = `hub_followup.${cfg.mode}.payload`;
    args.stageRecorder?.record(stage, {
      kind: 'hub_followup_payload_shadow',
      requestId: args.requestId,
      entryEndpoint: args.entryEndpoint,
      flowId: args.flowId,
      diffCount: diffs.length,
      diffPaths: diffs.slice(0, 50).map((d) => d.path),
      diffHead: diffs.slice(0, 50).map((d) => ({ path: d.path, baseline: d.baseline, candidate: d.candidate })),
      baseline: jsonClone(args.payload as unknown as JsonValue),
      candidate: jsonClone(candidate as unknown as JsonValue)
    });
  }
  if (cfg.mode === 'enforce') {
    return candidate;
  }
  return args.payload;
}

