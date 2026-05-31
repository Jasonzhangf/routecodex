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
  const body = normalizeProviderResponseBody(response);
  return { status, headers, body, metadata };
}

function normalizeProviderResponseBody(response: unknown): unknown {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return response;
  }
  const record = response as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, 'data')) {
    return record.data;
  }
  if (
    Object.prototype.hasOwnProperty.call(record, 'body')
    && (
      Object.prototype.hasOwnProperty.call(record, 'status')
      || Object.prototype.hasOwnProperty.call(record, 'headers')
      || Object.prototype.hasOwnProperty.call(record, 'metadata')
    )
  ) {
    return record.body;
  }
  return response;
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
  const mergeUniqueTools = (primary?: unknown[], secondary?: unknown[]): unknown[] | undefined => {
    const out: unknown[] = [];
    const seen = new Set<string>();
    const append = (tool: unknown) => {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
        return;
      }
      const record = tool as Record<string, unknown>;
      const fn =
        record.function && typeof record.function === 'object' && !Array.isArray(record.function)
          ? (record.function as Record<string, unknown>)
          : undefined;
      const rawName =
        (typeof fn?.name === 'string' ? fn.name : undefined)
        ?? (typeof record.name === 'string' ? record.name : undefined)
        ?? '';
      const normalizedName = rawName.trim().toLowerCase();
      if (!normalizedName || seen.has(normalizedName)) {
        return;
      }
      seen.add(normalizedName);
      out.push(tool);
    };
    for (const tool of primary ?? []) {
      append(tool);
    }
    for (const tool of secondary ?? []) {
      append(tool);
    }
    return out.length ? out : undefined;
  };
  const readRootTools = (value?: Record<string, unknown>): unknown[] | undefined =>
    Array.isArray(value?.tools) ? value.tools : undefined;
  const readMetadata = (value?: Record<string, unknown>): Record<string, unknown> | undefined =>
    value?.metadata && typeof value.metadata === 'object' && value.metadata
      ? (value.metadata as Record<string, unknown>)
      : undefined;
  const readRt = (metadata?: Record<string, unknown>): Record<string, unknown> | undefined =>
    metadata?.__rt && typeof metadata.__rt === 'object' && metadata.__rt
      ? (metadata.__rt as Record<string, unknown>)
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
  const fallbackTools = readRootTools(processed) ?? readRootTools(standardized);
  const base =
    metadataRequestSemantics
      ?? (processed && typeof processed.semantics === 'object' && processed.semantics
        ? (processed.semantics as Record<string, unknown>)
        : standardized && typeof standardized.semantics === 'object' && standardized.semantics
          ? (standardized.semantics as Record<string, unknown>)
          : undefined);
  if (!base && !fallbackTools?.length) {
    return undefined;
  }
  const baseTools =
    base?.tools && typeof base.tools === 'object' && !Array.isArray(base.tools)
      ? (base.tools as Record<string, unknown>)
      : undefined;
  const existingClientToolsRaw = Array.isArray(baseTools?.clientToolsRaw)
    ? baseTools.clientToolsRaw
    : Array.isArray(base?.tools)
      ? base.tools
      : undefined;
  const normalizedBase =
    !base
      ? { tools: { clientToolsRaw: fallbackTools } }
      : existingClientToolsRaw?.length || !fallbackTools?.length
        ? base
        : {
            ...base,
            tools: {
              ...baseTools,
              clientToolsRaw: fallbackTools
            }
          };

  const processedRt = readRt(processedMetadata);
  const standardizedRt = readRt(standardizedMetadata);
  const requestMetadataRt = readRt(requestMetadataRecord);

  const followupRaw =
    processedRt?.serverToolFollowup
    ?? standardizedRt?.serverToolFollowup
    ?? requestMetadataRt?.serverToolFollowup
    ?? processedMetadata?.serverToolFollowup
    ?? standardizedMetadata?.serverToolFollowup
    ?? requestMetadataRecord?.serverToolFollowup;
  const serverToolFollowup =
    followupRaw === true
    || (typeof followupRaw === 'string' && followupRaw.trim().toLowerCase() === 'true');
  const followupSourceCandidate =
    processedRt?.clientInjectSource
    ?? standardizedRt?.clientInjectSource
    ?? requestMetadataRt?.clientInjectSource
    ?? processedMetadata?.clientInjectSource
    ?? standardizedMetadata?.clientInjectSource
    ?? requestMetadataRecord?.clientInjectSource;
  const followupSource =
    typeof followupSourceCandidate === 'string' && followupSourceCandidate.trim()
      ? followupSourceCandidate.trim()
      : undefined;

  if (!serverToolFollowup && !followupSource) {
    return normalizedBase;
  }

  const mergedFollowupClientToolsRaw = mergeUniqueTools(
    Array.isArray(
      normalizedBase.tools && typeof normalizedBase.tools === 'object' && !Array.isArray(normalizedBase.tools)
        ? (normalizedBase.tools as Record<string, unknown>).clientToolsRaw
        : undefined
    )
      ? (
          (normalizedBase.tools as Record<string, unknown>).clientToolsRaw as unknown[]
        )
      : undefined,
    fallbackTools
  );

  return {
    ...normalizedBase,
    ...(mergedFollowupClientToolsRaw
      ? {
          tools: {
            ...(normalizedBase.tools && typeof normalizedBase.tools === 'object' && !Array.isArray(normalizedBase.tools)
              ? (normalizedBase.tools as Record<string, unknown>)
              : {}),
            clientToolsRaw: mergedFollowupClientToolsRaw
          }
        }
      : {})
  };
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
