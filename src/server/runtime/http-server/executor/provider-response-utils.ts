import type { PipelineExecutionResult } from '../../../handlers/types.js';

const NON_BLOCKING_LOG_THROTTLE_MS = 60_000;
const nonBlockingLogState = new Map<string, number>();

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function logProviderResponseUtilsNonBlockingError(
  stage: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  const now = Date.now();
  const last = nonBlockingLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingLogState.set(stage, now);
  try {
    const detailSuffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(
      `[provider-response-utils] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`
    );
  } catch {
    // Never throw from non-blocking logging.
  }
}

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
  } catch (error) {
    logProviderResponseUtilsNonBlockingError('cloneRequestPayload', error);
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
    const normalizedKey = key.toLowerCase();
    const normalizedModel = modelId.toLowerCase();
    if (normalizedKey === normalizedModel || normalizedKey.endsWith(`.${normalizedModel}`)) {
      return key;
    }
    return `${key}.${modelId}`;
  }
  return key || modelId;
}

export function resolveRequestSemantics(
  processed?: Record<string, unknown>,
  standardized?: Record<string, unknown>
): Record<string, unknown> | undefined {
  const cloneRecord = (value: Record<string, unknown>): Record<string, unknown> => {
    try {
      return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    } catch (error) {
      logProviderResponseUtilsNonBlockingError('resolveRequestSemantics.cloneRecord', error);
      return { ...value };
    }
  };
  const cloneToolsArray = (value: unknown): unknown[] | undefined => {
    if (!Array.isArray(value) || value.length <= 0) {
      return undefined;
    }
    try {
      const cloned = JSON.parse(JSON.stringify(value));
      return Array.isArray(cloned) ? cloned : undefined;
    } catch (error) {
      logProviderResponseUtilsNonBlockingError('resolveRequestSemantics.cloneToolsArray', error);
      return value.slice();
    }
  };
  const resolveFallbackClientTools = (): unknown[] | undefined => (
    cloneToolsArray(processed?.tools) ?? cloneToolsArray(standardized?.tools)
  );
  const withFallbackClientTools = (
    semantics: Record<string, unknown> | undefined
  ): Record<string, unknown> | undefined => {
    const fallbackTools = resolveFallbackClientTools();
    if (!fallbackTools || fallbackTools.length <= 0) {
      return semantics;
    }
    const nextSemantics = semantics ? cloneRecord(semantics) : {};
    const toolsBagRaw = nextSemantics.tools;
    const toolsBag =
      toolsBagRaw && typeof toolsBagRaw === 'object' && !Array.isArray(toolsBagRaw)
        ? cloneRecord(toolsBagRaw as Record<string, unknown>)
        : {};
    const existingTools = Array.isArray(toolsBag.clientToolsRaw) ? toolsBag.clientToolsRaw : [];
    if (existingTools.length <= 0) {
      toolsBag.clientToolsRaw = fallbackTools;
    }
    nextSemantics.tools = toolsBag;
    return nextSemantics;
  };

  if (processed && typeof processed.semantics === 'object' && processed.semantics) {
    return withFallbackClientTools(processed.semantics as Record<string, unknown>);
  }
  if (standardized && typeof standardized.semantics === 'object' && standardized.semantics) {
    return withFallbackClientTools(standardized.semantics as Record<string, unknown>);
  }
  return withFallbackClientTools(undefined);
}
