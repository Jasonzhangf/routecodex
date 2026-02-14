import type { PipelineExecutionResult } from '../../../handlers/types.js';

export function extractResponseStatus(response: unknown): number | undefined {
  if (!response || typeof response !== 'object') {
    return undefined;
  }
  const candidate = (response as { status?: unknown }).status;
  return typeof candidate === 'number' ? candidate : undefined;
}

export function normalizeProviderResponse(response: unknown): PipelineExecutionResult {
  const status = extractResponseStatus(response);
  const headers = normalizeProviderResponseHeaders(
    response && typeof response === 'object' ? (response as Record<string, unknown>).headers : undefined
  );
  const body =
    response && typeof response === 'object' && 'data' in (response as Record<string, unknown>)
      ? (response as Record<string, unknown>).data
      : response;
  return { status, headers, body };
}

function normalizeProviderResponseHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== 'object') {
    return undefined;
  }
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value === 'string') {
      normalized[key.toLowerCase()] = value;
    }
  }
  return Object.keys(normalized).length ? normalized : undefined;
}

export function extractClientModelId(
  metadata: Record<string, unknown>,
  originalRequest?: Record<string, unknown>
): string | undefined {
  const candidates = [
    metadata.clientModelId,
    metadata.originalModelId,
    (metadata.target && typeof metadata.target === 'object'
      ? (metadata.target as Record<string, unknown>).clientModelId
      : undefined),
    originalRequest && typeof originalRequest === 'object'
      ? (originalRequest as Record<string, unknown>).model
      : undefined,
    originalRequest && typeof originalRequest === 'object'
      ? (originalRequest as Record<string, unknown>).originalModelId
      : undefined
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

export function cloneRequestPayload(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  try {
    return JSON.parse(JSON.stringify(payload));
  } catch {
    return undefined;
  }
}

export function extractProviderModel(payload?: Record<string, unknown>): string | undefined {
  if (!payload) {
    return undefined;
  }
  const source =
    payload.data && typeof payload.data === 'object'
      ? (payload.data as Record<string, unknown>)
      : payload;
  const raw = (source as Record<string, unknown>).model;
  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim();
  }
  return undefined;
}

export function buildProviderLabel(providerKey?: string, model?: string): string | undefined {
  const key = typeof providerKey === 'string' && providerKey.trim() ? providerKey.trim() : undefined;
  const modelId = typeof model === 'string' && model.trim() ? model.trim() : undefined;
  if (!key && !modelId) {
    return undefined;
  }
  if (key && modelId) {
    return `${key}.${modelId}`;
  }
  return key || modelId;
}

export function resolveRequestSemantics(
  processed?: Record<string, unknown>,
  standardized?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (processed && typeof processed.semantics === 'object' && processed.semantics) {
    return processed.semantics as Record<string, unknown>;
  }
  if (standardized && typeof standardized.semantics === 'object' && standardized.semantics) {
    return standardized.semantics as Record<string, unknown>;
  }
  return undefined;
}
