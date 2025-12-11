import fs from 'node:fs/promises';
import path from 'node:path';
import type { SemanticFieldSpec, SemanticSnapshotInput, SemanticSummaryFn } from './semantic-tracker.js';
import { getByPath } from './semantic-tracker.js';
import builtinSemanticMap from '../../config/semantic-map.json' assert { type: 'json' };
import { CHANGE_REGISTRY, NORMALIZER_REGISTRY, SELECTOR_REGISTRY, SUMMARY_REGISTRY, TRANSFORM_REGISTRY } from './semantic-registry.js';

export interface SemanticFieldSourceMatchConfig {
  protocols?: string[] | string;
  directions?: Array<'request' | 'response'> | 'request' | 'response';
  stageIncludes?: string[] | string;
  nodeIncludes?: string[] | string;
  entryEndpointIncludes?: string[] | string;
}

export interface SemanticFieldSourceConfig {
  id?: string;
  match?: SemanticFieldSourceMatchConfig;
  protocols?: string[] | string;
  path?: string;
  selector?: string;
  transform?: string;
}

export interface SemanticFieldConfig {
  id: string;
  label?: string;
  summary?: string;
  changeDescription?: string;
  normalize?: string;
  optional?: boolean;
  sources: SemanticFieldSourceConfig[];
}

export interface SemanticMapConfig {
  version: string;
  fields: SemanticFieldConfig[];
}

export interface SemanticMapLoadOptions {
  path?: string;
}

interface CompiledFieldSource {
  id?: string;
  protocols?: Set<string>;
  directions?: Set<string>;
  stageIncludes?: string[];
  nodeIncludes?: string[];
  entryEndpointIncludes?: string[];
  path?: string;
  selectorId?: string;
  selectorFn?: (payload: unknown, snapshot: SemanticSnapshotInput) => unknown;
  transformId?: string;
  transformFn?: (value: unknown, snapshot: SemanticSnapshotInput) => unknown;
}

export async function loadSemanticMapConfig(options: SemanticMapLoadOptions = {}): Promise<SemanticMapConfig> {
  if (options.path) {
    const file = path.resolve(options.path);
    const raw = await fs.readFile(file, 'utf-8');
    return JSON.parse(raw) as SemanticMapConfig;
  }
  const override = process.env.ROUTECODEX_SEMANTIC_MAP || process.env.RCC_SEMANTIC_MAP;
  if (override) {
    try {
      const file = path.resolve(override);
      const raw = await fs.readFile(file, 'utf-8');
      return JSON.parse(raw) as SemanticMapConfig;
    } catch (error) {
      console.warn('[semantic-map] Failed to load override config', error);
    }
  }
  return builtinSemanticMap as SemanticMapConfig;
}

export async function loadSemanticFieldSpecs(options: SemanticMapLoadOptions = {}): Promise<SemanticFieldSpec[]> {
  const config = await loadSemanticMapConfig(options);
  return compileSemanticFieldSpecs(config);
}

export function compileSemanticFieldSpecs(config: SemanticMapConfig): SemanticFieldSpec[] {
  if (!config?.fields?.length) {
    throw new Error('[semantic-map] Config missing fields');
  }
  return config.fields.map((field) => compileField(field));
}

export function inferSnapshotProtocol(snapshot: SemanticSnapshotInput): string | undefined {
  if (snapshot.protocol && snapshot.protocol.trim()) {
    return snapshot.protocol.trim().toLowerCase();
  }
  const metaProtocol = typeof snapshot.metadata?.protocol === 'string' ? snapshot.metadata.protocol.trim() : undefined;
  if (metaProtocol) {
    return metaProtocol.toLowerCase();
  }
  const stage = normalizeText(snapshot.stage);
  if (stage) {
    if (stage.includes('provider.response') || stage.includes('provider-response')) {
      return 'provider-response';
    }
    if (stage.includes('provider.request') || stage.includes('provider-request')) {
      return 'provider-request';
    }
    if (
      stage.includes('hub.') ||
      stage.includes('resp_inbound') ||
      stage.includes('resp_outbound') ||
      stage.includes('resp_process') ||
      stage.includes('compat-')
    ) {
      return 'hub';
    }
    if (stage.includes('client-request') || stage.includes('client.request')) {
      return 'client-request';
    }
    if (stage.includes('client-response') || stage.includes('client.response')) {
      return 'client-response';
    }
  }
  const entryEndpoint = normalizeText(
    snapshot.entryEndpoint ||
      (typeof snapshot.metadata?.entryEndpoint === 'string' ? snapshot.metadata.entryEndpoint : undefined) ||
      (typeof snapshot.metadata?.endpoint === 'string' ? snapshot.metadata.endpoint : undefined)
  );
  if (entryEndpoint) {
    if (entryEndpoint.includes('/v1/responses')) {
      return 'openai-responses';
    }
    if (entryEndpoint.includes('/v1/messages')) {
      return 'anthropic-messages';
    }
    if (entryEndpoint.includes('/v1/chat/completions')) {
      return 'openai-chat';
    }
  }
  const providerProtocol = typeof snapshot.metadata?.providerProtocol === 'string'
    ? snapshot.metadata.providerProtocol.trim().toLowerCase()
    : undefined;
  if (providerProtocol) {
    return `provider-${providerProtocol}`;
  }
  return undefined;
}

function compileField(field: SemanticFieldConfig): SemanticFieldSpec {
  const sources = (field.sources || []).map((source) => compileSource(source));
  return {
    id: field.id,
    label: field.label,
    optional: field.optional === true,
    summarize: wrapSummary(field.summary),
    describeChange: wrapChangeDescriptor(field.changeDescription),
    normalize: wrapNormalizer(field.normalize),
    computeValue: (payload, snapshot) => {
      const resolved = pickSource(sources, snapshot);
      if (!resolved) {
        return { value: undefined };
      }
      let rawValue: unknown;
      if (resolved.selectorFn) {
        rawValue = resolved.selectorFn(payload, snapshot);
      } else if (resolved.path) {
        rawValue = getByPath(payload, resolved.path);
      }
      if (resolved.transformFn) {
        rawValue = resolved.transformFn(rawValue, snapshot);
      }
      return {
        value: rawValue,
        origin: resolved.selectorId || resolved.path
      };
    }
  } satisfies SemanticFieldSpec;
}

function compileSource(source: SemanticFieldSourceConfig): CompiledFieldSource {
  const match = source.match ?? {};
  const protocols = normalizeList(source.protocols || match.protocols);
  const directions = normalizeList(match.directions);
  const stageIncludes = normalizeList(match.stageIncludes);
  const nodeIncludes = normalizeList(match.nodeIncludes);
  const entryEndpointIncludes = normalizeList(match.entryEndpointIncludes);
  let selectorFn: ((payload: unknown, snapshot: SemanticSnapshotInput) => unknown) | undefined;
  if (source.selector) {
    selectorFn = SELECTOR_REGISTRY[source.selector];
    if (!selectorFn) {
      console.warn(`[semantic-map] Selector ${source.selector} not found`);
    }
  }
  let transformFn: ((value: unknown, snapshot: SemanticSnapshotInput) => unknown) | undefined;
  if (source.transform) {
    const transform = TRANSFORM_REGISTRY[source.transform];
    if (!transform) {
      console.warn(`[semantic-map] Transform ${source.transform} not registered`);
    } else {
      transformFn = transform;
    }
  }
  return {
    id: source.id,
    protocols: protocols ? new Set(protocols) : undefined,
    directions: directions ? new Set(directions.map((dir) => dir.toLowerCase())) : undefined,
    stageIncludes: stageIncludes?.map((s) => s.toLowerCase()),
    nodeIncludes: nodeIncludes?.map((s) => s.toLowerCase()),
    entryEndpointIncludes: entryEndpointIncludes?.map((s) => s.toLowerCase()),
    path: source.path,
    selectorId: source.selector,
    selectorFn,
    transformId: source.transform,
    transformFn
  } satisfies CompiledFieldSource;
}

function pickSource(sources: CompiledFieldSource[], snapshot: SemanticSnapshotInput): CompiledFieldSource | undefined {
  const protocol = inferSnapshotProtocol(snapshot);
  const direction = snapshot.direction ? snapshot.direction.toLowerCase() : undefined;
  const entryEndpoint = normalizeText(
    snapshot.entryEndpoint ||
      (typeof snapshot.metadata?.entryEndpoint === 'string' ? snapshot.metadata.entryEndpoint : undefined)
  );
  for (const source of sources) {
    if (source.protocols && (!protocol || !source.protocols.has(protocol))) {
      continue;
    }
    if (source.directions && (!direction || !source.directions.has(direction))) {
      continue;
    }
    if (source.stageIncludes?.length) {
      const stage = normalizeText(snapshot.stage) || '';
      if (!source.stageIncludes.some((needle) => stage.includes(needle))) {
        continue;
      }
    }
    if (source.nodeIncludes?.length) {
      const node = normalizeText(snapshot.nodeId) || '';
      if (!source.nodeIncludes.some((needle) => node.includes(needle))) {
        continue;
      }
    }
    if (source.entryEndpointIncludes?.length) {
      if (!entryEndpoint || !source.entryEndpointIncludes.some((needle) => entryEndpoint.includes(needle))) {
        continue;
      }
    }
    return source;
  }
  return sources.find((src) => !src.protocols && !src.directions && !src.stageIncludes && !src.entryEndpointIncludes);
}

function wrapSummary(key?: string): SemanticSummaryFn | undefined {
  if (!key) {
    return undefined;
  }
  const fn = SUMMARY_REGISTRY[key];
  if (!fn) {
    console.warn(`[semantic-map] Summary ${key} not registered`);
    return undefined;
  }
  return (value) => fn(value);
}

function wrapChangeDescriptor(key?: string) {
  if (!key) {
    return undefined;
  }
  const fn = CHANGE_REGISTRY[key];
  if (!fn) {
    console.warn(`[semantic-map] Change descriptor ${key} not registered`);
    return undefined;
  }
  return (args: { previous?: { value: unknown }; current?: { value: unknown } }) =>
    fn({
      previous: args.previous ? { value: args.previous.value } : undefined,
      current: args.current ? { value: args.current.value } : undefined
    });
}

function wrapNormalizer(key?: string) {
  if (!key) {
    return undefined;
  }
  const fn = NORMALIZER_REGISTRY[key];
  if (!fn) {
    console.warn(`[semantic-map] Normalizer ${key} not registered`);
    return undefined;
  }
  return (value: unknown) => fn(value);
}

function normalizeList(value?: string[] | string | Array<string | undefined> | null) {
  if (!value) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const mapped = value
      .map((item) => (typeof item === 'string' ? item.trim() : undefined))
      .filter((item): item is string => Boolean(item));
    return mapped.length ? mapped : undefined;
  }
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }
  return undefined;
}

function normalizeText(value?: string | null): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed || undefined;
}
