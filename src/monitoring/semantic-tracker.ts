import type { NodeSnapshot } from '../debug/types.js';

export interface SemanticSnapshotInput
  extends Pick<NodeSnapshot, 'nodeId' | 'direction' | 'stage' | 'payload' | 'timestamp' | 'metadata'> {
  source?: string;
  protocol?: string;
  entryEndpoint?: string;
  providerKey?: string;
  providerType?: string;
}

export interface SemanticSummaryContext {
  snapshot: SemanticSnapshotInput;
  spec: SemanticFieldSpec;
}

export type SemanticSummaryFn = (value: unknown, context: SemanticSummaryContext) => string | null;
export type SemanticSelector = (payload: unknown, snapshot: SemanticSnapshotInput) => unknown;
export type SemanticValueResolver = (
  payload: unknown,
  snapshot: SemanticSnapshotInput
) => SemanticValueResolveResult;

export interface SemanticValueResolveResult {
  value: unknown;
  origin?: string;
}

export interface SemanticFieldSpec {
  id: string;
  label?: string;
  path?: string;
  selector?: SemanticSelector;
  computeValue?: SemanticValueResolver;
  summarize?: SemanticSummaryFn;
  normalize?: (value: unknown) => unknown;
  optional?: boolean;
  describeChange?: (args: { previous?: SemanticValueEntry; current?: SemanticValueEntry }) => string | null;
}

export interface SemanticValueEntry {
  specId: string;
  label?: string;
  value: unknown;
  summary: string | null;
  fingerprint: string;
  present: boolean;
  derivedPath?: string;
}

export interface SemanticTracePoint {
  stage: string;
  nodeId?: string;
  direction?: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
  source?: string;
  values: Record<string, SemanticValueEntry & { changed: boolean }>;
}

export interface SemanticChange {
  specId: string;
  label?: string;
  stage: string;
  index: number;
  previous?: SemanticValueEntry;
  current?: SemanticValueEntry;
  description?: string | null;
}

export interface SemanticReplayResult {
  points: SemanticTracePoint[];
  changes: SemanticChange[];
}

export interface SemanticTrackerOptions {
  fields: SemanticFieldSpec[];
  includeSnapshotsWithoutValues?: boolean;
}

const UNDEFINED_TOKEN = '__undefined__';

export class SemanticTracker {
  private readonly fields: SemanticFieldSpec[];
  private readonly includeAllSnapshots: boolean;

  constructor(options: SemanticTrackerOptions) {
    if (!options?.fields?.length) {
      throw new Error('SemanticTracker requires at least one field spec');
    }
    this.fields = options.fields;
    this.includeAllSnapshots = options.includeSnapshotsWithoutValues === true;
  }

  track(rawSnapshots: SemanticSnapshotInput[]): SemanticReplayResult {
    const snapshots = [...rawSnapshots].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    const points: SemanticTracePoint[] = [];
    const changes: SemanticChange[] = [];
    const lastStates = new Map<string, SemanticValueEntry>();

    snapshots.forEach((snapshot, index) => {
      const resolvedStage = resolveStageLabel(snapshot);
      const payload = unwrapSnapshotPayload(snapshot.payload);
      let hasValue = false;
      const values: SemanticTracePoint['values'] = {};
      for (const field of this.fields) {
        const { value: extracted, origin } = this.extractValue(payload, snapshot, field);
        const normalized = field.normalize ? field.normalize(extracted) : extracted;
        const fingerprint = buildFingerprint(normalized);
        const summary = field.summarize
          ? field.summarize(normalized, { snapshot, spec: field })
          : defaultSummary(normalized);
        const present = isValuePresent(normalized);
        const entry: SemanticValueEntry = {
          specId: field.id,
          label: field.label,
          value: normalized,
          summary,
          fingerprint,
          present,
          derivedPath: origin || field.path
        };
        const prev = lastStates.get(field.id);
        const changed = hasFingerprintChanged(prev, entry);
        values[field.id] = { ...entry, changed };
        if (present) {
          hasValue = true;
        }
        if (changed) {
          changes.push({
            specId: field.id,
            label: field.label,
            stage: resolvedStage,
            index,
            previous: prev,
            current: entry,
            description: field.describeChange ? field.describeChange({ previous: prev, current: entry }) : undefined
          });
        }
        lastStates.set(field.id, entry);
      }

      if (hasValue || this.includeAllSnapshots) {
        points.push({
          stage: resolvedStage,
          nodeId: snapshot.nodeId,
          direction: snapshot.direction,
          timestamp: snapshot.timestamp,
          metadata: snapshot.metadata,
          source: snapshot.source,
          values
        });
      }
    });

    return { points, changes };
  }

  private extractValue(
    payload: unknown,
    snapshot: SemanticSnapshotInput,
    field: SemanticFieldSpec
  ): SemanticValueResolveResult {
    if (typeof field.computeValue === 'function') {
      try {
        return field.computeValue(payload, snapshot) ?? { value: undefined };
      } catch {
        return { value: undefined };
      }
    }
    if (typeof field.selector === 'function') {
      try {
        return { value: field.selector(payload, snapshot) };
      } catch {
        return { value: undefined };
      }
    }
    if (field.path) {
      return { value: getByPath(payload, field.path), origin: field.path };
    }
    return { value: payload };
  }
}

function hasFingerprintChanged(previous: SemanticValueEntry | undefined, current: SemanticValueEntry): boolean {
  if (!previous) {
    return true;
  }
  return previous.fingerprint !== current.fingerprint;
}

export function unwrapSnapshotPayload(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return value;
  }
  const payload = value as Record<string, unknown>;
  if (payload.body && typeof payload.body === 'object') {
    return payload.body;
  }
  if (payload.data && typeof payload.data === 'object') {
    const data = payload.data as Record<string, unknown>;
    if (data.payload && typeof data.payload === 'object') {
      return data.payload;
    }
    return data;
  }
  if (payload.bodyText && typeof payload.bodyText === 'string') {
    try {
      return JSON.parse(payload.bodyText);
    } catch {
      return { bodyText: payload.bodyText };
    }
  }
  return payload;
}

function resolveStageLabel(snapshot: SemanticSnapshotInput): string {
  const explicit = typeof snapshot.stage === 'string' && snapshot.stage.trim() ? snapshot.stage.trim() : null;
  if (explicit) {
    return explicit;
  }
  const metaStage = typeof snapshot.metadata?.stage === 'string' && snapshot.metadata.stage.trim()
    ? snapshot.metadata.stage.trim()
    : null;
  if (metaStage) {
    return metaStage;
  }
  return 'unknown-stage';
}

export function getByPath(value: unknown, path: string): unknown {
  if (!path) {
    return undefined;
  }
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);
  let current: unknown = value;
  for (const segment of segments) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (Array.isArray(current)) {
      const idx = Number(segment);
      if (Number.isNaN(idx)) {
        return undefined;
      }
      current = current[idx];
      continue;
    }
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment];
      continue;
    }
    return undefined;
  }
  return current;
}

function buildFingerprint(value: unknown): string {
  if (value === undefined) {
    return UNDEFINED_TOKEN;
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return `${typeof value}:${String(value)}`;
  }
  return `json:${stableStringify(value)}`;
}

export function stableStringify(value: unknown): string {
  const cache = new WeakSet();
  const replacer = (_key: string, val: unknown) => {
    if (val && typeof val === 'object') {
      if (cache.has(val as object)) {
        return undefined;
      }
      cache.add(val as object);
      if (Array.isArray(val)) {
        return val.map((item) => item);
      }
      const record = val as Record<string, unknown>;
      return Object.keys(record)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = record[key];
          return acc;
        }, {});
    }
    return val;
  };
  try {
    return JSON.stringify(value, replacer);
  } catch {
    return '[unserializable]';
  }
}

export function defaultSummary(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    if (!value.trim()) {
      return '(empty string)';
    }
    return value.length > 140 ? `${value.slice(0, 120)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }
  if (typeof value === 'object') {
    return `object(${Object.keys(value as Record<string, unknown>).length} keys)`;
  }
  return String(value);
}

function isValuePresent(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  return true;
}
