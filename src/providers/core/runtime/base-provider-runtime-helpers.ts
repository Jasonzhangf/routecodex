import type { ProviderContext, ProviderRuntimeProfile } from '../api/provider-types.js';
import type { UnknownObject } from '../../../types/common-types.js';
import {
  attachProviderRuntimeMetadata,
  extractProviderRuntimeMetadata,
  type ProviderRuntimeMetadata
} from './provider-runtime-metadata.js';
import {
  normalizeProviderFamily,
  normalizeProviderType
} from '../utils/provider-type-utils.js';
import { resolveProviderContextExtensions } from './provider-runtime-utils.js';
import { MetadataCenter } from '../../../server/runtime/http-server/metadata-center/metadata-center.js';

type RequestEnvelope = UnknownObject & { data?: UnknownObject };

export function hasDataEnvelope(value: UnknownObject): value is RequestEnvelope {
  return Boolean(value && typeof value === 'object' && 'data' in value);
}

export function unwrapRequestPayload(request: UnknownObject): Record<string, unknown> {
  if (hasDataEnvelope(request) && request.data && typeof request.data === 'object') {
    return request.data as Record<string, unknown>;
  }
  return request as Record<string, unknown>;
}

export function hasTools(payload: Record<string, unknown>): boolean {
  const tools = payload.tools;
  if (Array.isArray(tools)) {
    return tools.length > 0;
  }
  return Boolean(tools);
}

function readEntryPortTruth(metadata?: Record<string, unknown>): number | undefined {
  if (!metadata) {
    return undefined;
  }
  const requestTruthPortScope = MetadataCenter.read(metadata)?.readRequestTruth().portScope;
  if (typeof requestTruthPortScope === 'string') {
    const parsed = Number.parseInt(requestTruthPortScope, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  for (const value of [
    metadata.entryPort,
    metadata.matchedPort,
    metadata.routecodexLocalPort,
    metadata.localPort,
    metadata.portScope
  ]) {
    const numeric = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.floor(numeric);
    }
  }
  return undefined;
}

export function createProviderContext(options: {
  request: UnknownObject;
  providerType: string;
  runtimeProfile?: ProviderRuntimeProfile;
  configProviderId?: string;
  configProviderType?: string;
  configExtensions?: Record<string, unknown>;
}): { context: ProviderContext; runtimeMetadata?: ProviderRuntimeMetadata } {
  const runtimeMetadata = extractProviderRuntimeMetadata(options.request);
  const payload = unwrapRequestPayload(options.request);
  const runtimeMetadataRecord = runtimeMetadata?.metadata && typeof runtimeMetadata.metadata === 'object' && !Array.isArray(runtimeMetadata.metadata)
    ? runtimeMetadata.metadata as Record<string, unknown>
    : undefined;
  const mergedMetadata = {
    ...(runtimeMetadataRecord ?? {})
  };
  const runtimeMetadataCenter = runtimeMetadataRecord ? MetadataCenter.read(runtimeMetadataRecord) : undefined;
  const entryPort = readEntryPortTruth(mergedMetadata);
  if (typeof entryPort === 'number') {
    mergedMetadata.entryPort = entryPort;
    mergedMetadata.matchedPort = entryPort;
    if (runtimeMetadataRecord) {
      runtimeMetadataRecord.entryPort = entryPort;
      runtimeMetadataRecord.matchedPort = entryPort;
    }
  }
  if (runtimeMetadataCenter) {
    MetadataCenter.bind(mergedMetadata, runtimeMetadataCenter);
  }
  const runtimeModel = typeof runtimeMetadata?.target?.modelId === 'string'
    ? runtimeMetadata.target.modelId
    : typeof runtimeMetadata?.target?.model === 'string'
      ? runtimeMetadata.target.model
      : typeof runtimeMetadata?.modelId === 'string'
        ? runtimeMetadata.modelId
        : undefined;
  const payloadModel = typeof payload.model === 'string' ? payload.model : undefined;
  const contextModel = runtimeModel ?? payloadModel;
  const providerType = normalizeProviderType(
    runtimeMetadata?.providerType ||
    options.runtimeProfile?.providerType ||
    options.providerType
  );
  const providerFamily = normalizeProviderFamily(
    runtimeMetadata?.providerFamily,
    runtimeMetadata?.providerId,
    runtimeMetadata?.providerKey,
    options.runtimeProfile?.providerFamily,
    options.runtimeProfile?.providerId,
    options.configProviderId,
    options.configProviderType
  );
  const providerProtocol = runtimeMetadata?.providerProtocol;

  const context: ProviderContext = {
    requestId: runtimeMetadata?.requestId || `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    providerType,
    providerFamily,
    startTime: Date.now(),
    model: contextModel,
    hasTools: hasTools(payload),
    metadata: mergedMetadata,
    providerId: runtimeMetadata?.providerId || runtimeMetadata?.providerKey || options.runtimeProfile?.providerId,
    providerKey: runtimeMetadata?.providerKey || options.runtimeProfile?.providerKey,
    providerProtocol,
    routeName: runtimeMetadata?.routeName,
    target: runtimeMetadata?.target,
    runtimeMetadata,
    extensions: resolveProviderContextExtensions({
      runtime: runtimeMetadata,
      runtimeProfileExtensions: options.runtimeProfile?.extensions,
      configExtensions: options.configExtensions
    }),
    pipelineId: runtimeMetadata?.pipelineId,
    abortSignal:
      runtimeMetadata?.abortSignal && typeof runtimeMetadata.abortSignal === 'object'
        ? (runtimeMetadata.abortSignal as AbortSignal)
        : undefined
  };
  if (runtimeMetadataCenter) {
    MetadataCenter.bind(context.metadata ?? mergedMetadata, runtimeMetadataCenter);
  }
  return { context, runtimeMetadata };
}

export function reattachRuntimeMetadata(payload: UnknownObject, metadata?: ProviderRuntimeMetadata): void {
  if (!metadata || !payload || typeof payload !== 'object') {
    return;
  }
  const target = hasDataEnvelope(payload) && payload.data && typeof payload.data === 'object'
    ? payload.data
    : payload;
  attachProviderRuntimeMetadata(target as Record<string, unknown>, metadata);
}

export function extractUsageTokensFromResponse(finalResponse: UnknownObject): {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
} {
  if (!finalResponse || typeof finalResponse !== 'object') {
    return {};
  }
  const container = finalResponse as { metadata?: unknown; usage?: unknown };
  const meta = (container.metadata && typeof container.metadata === 'object')
    ? (container.metadata as { usage?: unknown })
    : undefined;
  const usageNode = meta && meta.usage && typeof meta.usage === 'object'
    ? meta.usage as Record<string, unknown>
    : (container.usage && typeof container.usage === 'object'
      ? container.usage as Record<string, unknown>
      : undefined);

  if (!usageNode) {
    return {};
  }

  const readNumber = (value: unknown): number | undefined => {
    if (typeof value !== 'number') {
      return undefined;
    }
    if (!Number.isFinite(value)) {
      return undefined;
    }
    return value;
  };

  const basePromptTokens =
    readNumber(usageNode.prompt_tokens) ??
    readNumber(usageNode.promptTokens) ??
    readNumber(usageNode.input_tokens) ??
    readNumber(usageNode.inputTokens);
  const cacheReadTokens =
    readNumber(usageNode.cache_read_input_tokens) ??
    (usageNode.input_tokens_details && typeof usageNode.input_tokens_details === 'object'
      ? readNumber((usageNode.input_tokens_details as Record<string, unknown>).cached_tokens)
      : undefined);
  const promptTokens =
    basePromptTokens !== undefined || cacheReadTokens !== undefined
      ? (basePromptTokens ?? 0) + (cacheReadTokens ?? 0)
      : undefined;

  const completionTokens =
    readNumber(usageNode.completion_tokens) ??
    readNumber(usageNode.completionTokens) ??
    readNumber(usageNode.output_tokens) ??
    readNumber(usageNode.outputTokens);

  let totalTokens =
    readNumber(usageNode.total_tokens) ??
    readNumber(usageNode.totalTokens);

  if (promptTokens !== undefined && completionTokens !== undefined) {
    const expected = promptTokens + completionTokens;
    if (totalTokens === undefined || totalTokens < expected) {
      totalTokens = expected;
    }
  } else if (totalTokens === undefined && (promptTokens !== undefined || completionTokens !== undefined)) {
    totalTokens = (promptTokens ?? 0) + (completionTokens ?? 0);
  }

  return { promptTokens, completionTokens, totalTokens };
}

export function truncateLogMessage(value: string, maxLength: number = 400): string {
  if (!value || value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3)}...`;
}
