import type { ProviderContext, ProviderRuntimeProfile } from '../api/provider-types.js';
import type { UnknownObject } from '../../../types/common-types.js';
import {
  attachProviderRuntimeMetadata,
  extractProviderRuntimeMetadata,
  type ProviderRuntimeMetadata
} from './provider-runtime-metadata.js';
import {
  normalizeProviderFamily,
  normalizeProviderType,
  providerTypeToProtocol
} from '../utils/provider-type-utils.js';

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

export function createProviderContext(options: {
  request: UnknownObject;
  providerType: string;
  runtimeProfile?: ProviderRuntimeProfile;
  configProviderId?: string;
  configProviderType?: string;
}): { context: ProviderContext; runtimeMetadata?: ProviderRuntimeMetadata } {
  const runtimeMetadata = extractProviderRuntimeMetadata(options.request);
  const payload = unwrapRequestPayload(options.request);
  const runtimeModel = typeof runtimeMetadata?.target?.model === 'string'
    ? runtimeMetadata.target.model
    : undefined;
  const payloadModel = typeof payload.model === 'string' ? payload.model : undefined;
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
  const providerProtocol =
    runtimeMetadata?.providerProtocol ||
    providerTypeToProtocol(providerType);

  const context: ProviderContext = {
    requestId: runtimeMetadata?.requestId || `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    providerType,
    providerFamily,
    startTime: Date.now(),
    model: payloadModel ?? runtimeModel,
    hasTools: hasTools(payload),
    metadata: runtimeMetadata?.metadata || {},
    providerId: runtimeMetadata?.providerId || runtimeMetadata?.providerKey || options.runtimeProfile?.providerId,
    providerKey: runtimeMetadata?.providerKey || options.runtimeProfile?.providerKey,
    providerProtocol,
    routeName: runtimeMetadata?.routeName,
    target: runtimeMetadata?.target,
    runtimeMetadata,
    pipelineId: runtimeMetadata?.pipelineId
  };
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

  const promptTokens =
    readNumber(usageNode.prompt_tokens) ??
    readNumber(usageNode.promptTokens) ??
    readNumber(usageNode.input_tokens) ??
    readNumber(usageNode.inputTokens);

  const completionTokens =
    readNumber(usageNode.completion_tokens) ??
    readNumber(usageNode.completionTokens) ??
    readNumber(usageNode.output_tokens) ??
    readNumber(usageNode.outputTokens);

  let totalTokens =
    readNumber(usageNode.total_tokens) ??
    readNumber(usageNode.totalTokens);

  if (totalTokens === undefined && (promptTokens !== undefined || completionTokens !== undefined)) {
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
