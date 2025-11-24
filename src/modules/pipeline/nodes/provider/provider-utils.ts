import type { SharedPipelineRequest, SharedPipelineResponse } from '../../../../types/shared-dtos.js';
import type { UnknownObject } from '../../../../types/common-types.js';
import type { PipelineMetadata } from '../../orchestrator/pipeline-context.js';

export interface BuildProviderResponseOptions {
  rawPayload: UnknownObject;
  request: SharedPipelineRequest;
  metadata: PipelineMetadata;
  pipelineId: string;
  providerModuleType?: string;
}

export interface ProviderResponseArtifacts {
  providerPayload: UnknownObject;
  response: SharedPipelineResponse;
}

export async function buildProviderResponseArtifacts(options: BuildProviderResponseOptions): Promise<ProviderResponseArtifacts> {
  const normalizedPayload = await normalizeProviderPayload(
    options.rawPayload,
    options.providerModuleType,
    options.request,
    options.metadata.requestId
  );

  const response: SharedPipelineResponse = {
    data: normalizedPayload,
    metadata: {
      pipelineId: options.pipelineId,
      processingTime: 0,
      stages: [],
      requestId: options.request.route?.requestId || options.metadata.requestId,
      ...deriveStreamFlag(options.request, options.metadata),
      ...deriveEndpoints(options.request, options.metadata),
      ...deriveProtocol(options.request, options.metadata)
    }
  };

  return {
    providerPayload: normalizedPayload,
    response
  };
}

async function normalizeProviderPayload(
  rawPayload: UnknownObject,
  providerModuleType: string | undefined,
  request: SharedPipelineRequest,
  requestId: string
): Promise<UnknownObject> {
  if (!rawPayload || typeof rawPayload !== 'object') {
    return rawPayload;
  }

  const payload = rawPayload as Record<string, unknown>;
  const upstream = payload['__sse_stream'];
  if (!upstream) {
    return rawPayload;
  }

  const moduleType = String(providerModuleType || '').toLowerCase();
  if (moduleType.includes('responses')) {
    return { __sse_responses: upstream } as UnknownObject;
  }

  try {
    const { createResponsesSSEStreamFromOpenAI } = await import('../../../llmswitch/bridge.js');
    if (typeof createResponsesSSEStreamFromOpenAI === 'function') {
      const tools = ((request.data as Record<string, unknown> | undefined)?.['tools']) as unknown;
      const upstreamRecord = upstream as Record<string, unknown>;
      const sse = createResponsesSSEStreamFromOpenAI(upstreamRecord, {
        requestId,
        model: String(((request.data as Record<string, unknown> | undefined)?.['model']) || 'unknown'),
        tools
      });
      return { __sse_responses: sse } as UnknownObject;
    }
  } catch (error) {
    try {
      console.warn('[ProviderNode] SSE conversion failed, fallback to upstream stream:', (error as Error)?.message || String(error));
    } catch {
      // ignore logging failures
    }
  }

  return rawPayload;
}

function deriveStreamFlag(request: SharedPipelineRequest, metadata: PipelineMetadata): Record<string, boolean> | {} {
  const streamFlag =
    typeof request.metadata?.stream === 'boolean'
      ? request.metadata.stream
      : typeof metadata.streaming === 'string'
        ? metadata.streaming === 'always'
          ? true
          : metadata.streaming === 'never'
            ? false
            : undefined
        : undefined;
  return typeof streamFlag === 'boolean' ? { stream: streamFlag } : {};
}

function deriveEndpoints(request: SharedPipelineRequest, metadata: PipelineMetadata): Record<string, string> | {} {
  const entry =
    pickString((request.metadata as Record<string, unknown> | undefined)?.['entryEndpoint']) ||
    pickString((request.metadata as Record<string, unknown> | undefined)?.['endpoint']) ||
    metadata.entryEndpoint;
  const endpoint =
    pickString((request.metadata as Record<string, unknown> | undefined)?.['endpoint']) || entry;

  const result: Record<string, string> = {};
  if (entry) result.entryEndpoint = entry;
  if (endpoint) result.endpoint = endpoint;
  return result;
}

function deriveProtocol(request: SharedPipelineRequest, metadata: PipelineMetadata): Record<string, string> | {} {
  const protocol =
    pickString((request.metadata as Record<string, unknown> | undefined)?.['protocol']) ||
    metadata.providerProtocol;
  return protocol ? { protocol } : {};
}

function pickString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  return undefined;
}
