import type { PipelineExecutionResult } from '../../../handlers/types.js';
import { resolveProviderResponseRequestSemanticsNative } from '../../../../modules/llmswitch/bridge/native-exports.js';
import { readRuntimeProviderObservationProjection } from '../metadata-center/request-truth-readers.js';

export function extractResponseStatus(response: unknown): number | undefined {
  if (!response || typeof response !== 'object') {
    return undefined;
  }
  const candidate = (response as { status?: unknown }).status;
  return typeof candidate === 'number' ? candidate : undefined;
}

export function normalizeProviderResponse(response: unknown): PipelineExecutionResult {
  const status = extractResponseStatus(response);
  const metadata =
    response && typeof response === 'object' && 'metadata' in (response as Record<string, unknown>)
      && (response as Record<string, unknown>).metadata
      && typeof (response as Record<string, unknown>).metadata === 'object'
      && !Array.isArray((response as Record<string, unknown>).metadata)
      ? ((response as Record<string, unknown>).metadata as Record<string, unknown>)
      : undefined;
  const headers = normalizeProviderResponseHeaders(
    response && typeof response === 'object' ? (response as Record<string, unknown>).headers : undefined
  );
  const sseStream = extractProviderResponseSseStream(response);
  const body = normalizeProviderResponseBody(response);
  return { status, headers, body, metadata, ...(sseStream !== undefined ? { sseStream } : {}) };
}

function normalizeProviderResponseBody(response: unknown): unknown {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return response;
  }
  const record = response as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, 'data')) {
    return stripProviderResponseSideChannels(record.data);
  }
  if (
    Object.prototype.hasOwnProperty.call(record, 'body')
    && (
      Object.prototype.hasOwnProperty.call(record, 'status')
      || Object.prototype.hasOwnProperty.call(record, 'headers')
      || Object.prototype.hasOwnProperty.call(record, 'metadata')
      || Object.prototype.hasOwnProperty.call(record, 'sseStream')
    )
  ) {
    return stripProviderResponseSideChannels(record.body);
  }
  if (Object.prototype.hasOwnProperty.call(record, 'sseStream')) {
    const { sseStream: _sseStream, status: _status, statusText: _statusText, headers: _headers, metadata: _metadata, ...rest } = record;
    return Object.keys(rest).length ? rest : undefined;
  }
  return response;
}

function extractProviderResponseSseStream(response: unknown): unknown {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return undefined;
  }
  const record = response as Record<string, unknown>;
  if (record.sseStream !== undefined) {
    return record.sseStream;
  }
  const data = record.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const nested = data as Record<string, unknown>;
    if (nested.sseStream !== undefined) {
      return nested.sseStream;
    }
  }
  const body = record.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const nested = body as Record<string, unknown>;
    if (nested.sseStream !== undefined) {
      return nested.sseStream;
    }
  }
  return undefined;
}

function stripProviderResponseSideChannels(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'sseStream')) {
    return value;
  }
  const { sseStream: _sseStream, ...rest } = record;
  return Object.keys(rest).length ? rest : undefined;
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
  const centerObservation = readRuntimeProviderObservationProjection(metadata);
  const centerModelId = centerObservation.clientModelId ?? centerObservation.modelId;
  if (centerModelId) {
    return centerModelId;
  }
  const candidates = [
    metadata.clientModelId,
    metadata.originalModelId,
    centerObservation.target?.clientModelId,
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
  standardized?: Record<string, unknown>,
  requestMetadata?: Record<string, unknown>
): Record<string, unknown> | undefined {
  return resolveProviderResponseRequestSemanticsNative(processed, standardized, requestMetadata);
}

function countArrayItems(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function summarizeSemanticsNode(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { present: false };
  }
  const row = value as Record<string, unknown>;
  const toolsNode =
    row.tools && typeof row.tools === 'object' && !Array.isArray(row.tools)
      ? (row.tools as Record<string, unknown>)
      : undefined;
  return {
    present: true,
    keys: Object.keys(row),
    rootToolsCount: countArrayItems(row.tools),
    clientToolsRawCount: countArrayItems(toolsNode?.clientToolsRaw),
    baselineToolsCount: countArrayItems(toolsNode?.baselineTools),
    messagesCount: countArrayItems(row.messages),
    toolOutputsCount: countArrayItems(row.toolOutputs) || countArrayItems(row.tool_outputs)
  };
}

export function describeRequestSemanticsResolution(
  processed?: Record<string, unknown>,
  standardized?: Record<string, unknown>,
  requestMetadata?: Record<string, unknown>,
  resolved?: Record<string, unknown>
): Record<string, unknown> {
  const readRootTools = (value?: Record<string, unknown>): unknown[] | undefined =>
    Array.isArray(value?.tools) ? value.tools : undefined;
  const readMetadata = (value?: Record<string, unknown>): Record<string, unknown> | undefined =>
    value?.metadata && typeof value.metadata === 'object' && value.metadata
      ? (value.metadata as Record<string, unknown>)
      : undefined;

  const processedMetadata = readMetadata(processed);
  const standardizedMetadata = readMetadata(standardized);
  const requestMetadataRecord = requestMetadata && typeof requestMetadata === 'object' ? requestMetadata : undefined;
  const metadataRequestSemantics =
    processedMetadata?.requestSemantics && typeof processedMetadata.requestSemantics === 'object' && processedMetadata.requestSemantics
      ? (processedMetadata.requestSemantics as Record<string, unknown>)
      : standardizedMetadata?.requestSemantics && typeof standardizedMetadata.requestSemantics === 'object' && standardizedMetadata.requestSemantics
        ? (standardizedMetadata.requestSemantics as Record<string, unknown>)
        : requestMetadataRecord?.requestSemantics && typeof requestMetadataRecord.requestSemantics === 'object' && requestMetadataRecord.requestSemantics
          ? (requestMetadataRecord.requestSemantics as Record<string, unknown>)
          : undefined;
  const processedSemantics =
    processed?.semantics && typeof processed.semantics === 'object' && processed.semantics
      ? (processed.semantics as Record<string, unknown>)
      : undefined;
  const standardizedSemantics =
    standardized?.semantics && typeof standardized.semantics === 'object' && standardized.semantics
      ? (standardized.semantics as Record<string, unknown>)
      : undefined;
  const fallbackTools = readRootTools(processed) ?? readRootTools(standardized);

  return {
    metadataRequestSemantics: summarizeSemanticsNode(metadataRequestSemantics),
    processedSemantics: summarizeSemanticsNode(processedSemantics),
    standardizedSemantics: summarizeSemanticsNode(standardizedSemantics),
    fallbackToolsCount: countArrayItems(fallbackTools),
    resolved: summarizeSemanticsNode(resolved)
  };
}
import { MetadataCenter } from '../metadata-center/metadata-center.js';
