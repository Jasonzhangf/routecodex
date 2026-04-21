import { type StreamingPreference } from '../types.js';
import { asRecord } from './utils.js';

/**
 * Normalize model-level streaming preferences from provider config.
 */
export function normalizeModelStreaming(
  provider: Record<string, unknown>
): Record<string, StreamingPreference> | undefined {
  const modelsNode = asRecord(provider.models);
  if (!modelsNode) {
    return undefined;
  }
  const normalized: Record<string, StreamingPreference> = {};
  for (const [modelId, modelRaw] of Object.entries(modelsNode)) {
    if (!modelRaw || typeof modelRaw !== 'object') {
      continue;
    }
    const preference = resolveStreamingPreference(modelRaw as Record<string, unknown>);
    if (preference) {
      normalized[modelId] = preference;
    }
  }
  return Object.keys(normalized).length ? normalized : undefined;
}

/**
 * Resolve streaming preference from model config.
 */
function resolveStreamingPreference(model: Record<string, unknown>): StreamingPreference | undefined {
  return (
    coerceStreamingPreference(model.streaming) ??
    coerceStreamingPreference(model.stream) ??
    coerceStreamingCapability(model.supportsStreaming)
  );
}

/**
 * Coerce various value types to StreamingPreference.
 */
function coerceStreamingPreference(value: unknown): StreamingPreference | undefined {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'always' || normalized === 'auto' || normalized === 'never') {
      return normalized;
    }
    if (normalized === 'true') {
      return 'always';
    }
    if (normalized === 'false') {
      return 'never';
    }
  }
  if (typeof value === 'boolean') {
    return value ? 'always' : 'never';
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.mode !== undefined) {
      return coerceStreamingPreference(record.mode);
    }
    if (record.value !== undefined) {
      return coerceStreamingPreference(record.value);
    }
    if (record.enabled !== undefined) {
      return coerceStreamingPreference(record.enabled);
    }
  }
  return undefined;
}

function coerceStreamingCapability(value: unknown): StreamingPreference | undefined {
  if (typeof value === 'boolean') {
    return value ? 'auto' : 'never';
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.enabled !== undefined) {
      return coerceStreamingCapability(record.enabled);
    }
    if (record.value !== undefined) {
      return coerceStreamingCapability(record.value);
    }
    if (record.mode !== undefined) {
      return coerceStreamingCapability(record.mode);
    }
  }
  return coerceStreamingPreference(value);
}

/**
 * Normalize model-level context token limits.
 */
export function normalizeModelContextTokens(
  provider: Record<string, unknown>
): { modelContextTokens?: Record<string, number>; defaultContextTokens?: number } {
  const modelsNode = asRecord(provider.models);
  const normalized: Record<string, number> = {};
  for (const [modelId, modelRaw] of Object.entries(modelsNode)) {
    if (!modelRaw || typeof modelRaw !== 'object') {
      continue;
    }
    const candidate = readContextTokens(modelRaw as Record<string, unknown>);
    if (candidate) {
      normalized[modelId] = candidate;
    }
  }
  const configNode = asRecord(provider.config);
  const defaultsNode = asRecord(configNode?.userConfigDefaults);
  const defaultCandidate =
    readContextTokens(provider) ?? readContextTokens(configNode) ?? readContextTokens(defaultsNode);
  return {
    modelContextTokens: Object.keys(normalized).length ? normalized : undefined,
    defaultContextTokens: defaultCandidate
  };
}

/**
 * Normalize model-level output token limits (maxTokens / max_output_tokens).
 */
export function normalizeModelOutputTokens(
  provider: Record<string, unknown>
): { modelOutputTokens?: Record<string, number>; defaultOutputTokens?: number } {
  const modelsNode = asRecord(provider.models);
  const normalized: Record<string, number> = {};
  for (const [modelId, modelRaw] of Object.entries(modelsNode)) {
    if (!modelRaw || typeof modelRaw !== 'object') {
      continue;
    }
    const candidate = readOutputTokens(modelRaw as Record<string, unknown>);
    if (candidate) {
      normalized[modelId] = candidate;
    }
  }
  const configNode = asRecord(provider.config);
  const defaultsNode = asRecord(configNode?.userConfigDefaults);
  const defaultCandidate =
    readOutputTokens(provider) ?? readOutputTokens(configNode) ?? readOutputTokens(defaultsNode);
  return {
    modelOutputTokens: Object.keys(normalized).length ? normalized : undefined,
    defaultOutputTokens: defaultCandidate
  };
}

/**
 * Read context tokens from various field names.
 */
function readContextTokens(record?: Record<string, unknown>): number | undefined {
  if (!record) {
    return undefined;
  }
  const keys = [
    'maxContextTokens',
    'max_context_tokens',
    'maxContext',
    'max_context',
    'contextTokens',
    'context_tokens'
  ];
  for (const key of keys) {
    const value = (record as Record<string, unknown>)[key];
    const parsed = normalizePositiveInteger(value);
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

function readOutputTokens(record?: Record<string, unknown>): number | undefined {
  if (!record) {
    return undefined;
  }
  const keys = [
    'maxOutputTokens',
    'max_output_tokens',
    'maxTokens',
    'max_tokens',
    'outputTokens',
    'output_tokens'
  ];
  for (const key of keys) {
    const value = (record as Record<string, unknown>)[key];
    const parsed = normalizePositiveInteger(value);
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

/**
 * Normalize positive integer value.
 */
function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}
