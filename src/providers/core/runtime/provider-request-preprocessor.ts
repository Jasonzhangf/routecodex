import type { UnknownObject } from '../../../types/common-types.js';
import type { ProviderRuntimeMetadata } from './provider-runtime-metadata.js';
import { attachProviderRuntimeMetadata } from './provider-runtime-metadata.js';
import { ProviderPayloadUtils } from './transport/provider-payload-utils.js';
import { MetadataCenter } from '../../../server/runtime/http-server/metadata-center/metadata-center.js';

type MetadataContainer = {
  metadata?: Record<string, unknown>;
  model?: unknown;
  entryEndpoint?: string;
  stream?: boolean;
};

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readStreamIntentFromMetadata(metadata: Record<string, unknown> | undefined): boolean | undefined {
  if (!metadata) {
    return undefined;
  }
  return readBoolean(metadata.stream)
    ?? readBoolean(metadata.outboundStream)
    ?? readBoolean(metadata.inboundStream);
}

function readHeaderCaseInsensitive(
  headers: Record<string, string> | undefined,
  target: string
): string | undefined {
  if (!headers) {
    return undefined;
  }
  const normalizedTarget = target.trim().toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.trim().toLowerCase() === normalizedTarget) {
      return value;
    }
  }
  return undefined;
}

export class ProviderRequestPreprocessor {
  static preprocess(request: UnknownObject, runtimeMetadata?: ProviderRuntimeMetadata): UnknownObject {
    const requestMetadata =
      request && typeof request === 'object' && (request as MetadataContainer).metadata && typeof (request as MetadataContainer).metadata === 'object'
        ? ((request as MetadataContainer).metadata as Record<string, unknown>)
        : undefined;
    if (runtimeMetadata && requestMetadata) {
      const requestMetadataCenter = MetadataCenter.read(requestMetadata);
      if (!runtimeMetadata.metadata || typeof runtimeMetadata.metadata !== 'object') {
        runtimeMetadata.metadata = {};
      }
      const runtimeCarrier = runtimeMetadata.metadata as Record<string, unknown>;
      Object.assign(runtimeCarrier, requestMetadata);
      if (requestMetadataCenter) {
        MetadataCenter.bind(runtimeCarrier, requestMetadataCenter);
      }
      for (const [key, value] of Object.entries(requestMetadata)) {
        if (key === 'clientHeaders' || key === 'entryEndpoint' || key === 'stream') {
          continue;
        }
        if ((runtimeMetadata as Record<string, unknown>)[key] === undefined) {
          (runtimeMetadata as Record<string, unknown>)[key] = value;
        }
      }
    }

    const headersFromRequest = ProviderPayloadUtils.normalizeClientHeaders(requestMetadata?.clientHeaders);
    const headersFromRuntime = ProviderPayloadUtils.normalizeClientHeaders(
      runtimeMetadata?.metadata && typeof runtimeMetadata.metadata === 'object'
        ? (runtimeMetadata.metadata as Record<string, unknown>).clientHeaders
        : undefined
    );
    const effectiveClientHeaders = headersFromRequest ?? headersFromRuntime;
    if (effectiveClientHeaders && runtimeMetadata) {
      if (!runtimeMetadata.metadata || typeof runtimeMetadata.metadata !== 'object') {
        runtimeMetadata.metadata = {};
      }
      (runtimeMetadata.metadata as Record<string, unknown>).clientHeaders = effectiveClientHeaders;
    }

    const processedRequest: UnknownObject = { ...request };
    const requestCarrier = request as MetadataContainer;
    const inboundModel = typeof requestCarrier?.model === 'string' ? requestCarrier.model : undefined;
    const entryEndpoint =
      typeof requestMetadata?.entryEndpoint === 'string'
        ? requestMetadata.entryEndpoint
        : requestCarrier?.entryEndpoint;
    const acceptHeader = readHeaderCaseInsensitive(effectiveClientHeaders, 'accept');
    const streamFromAcceptHeader =
      typeof acceptHeader === 'string' && acceptHeader.toLowerCase().includes('text/event-stream')
        ? true
        : undefined;
    const metadataStreamIntent = readStreamIntentFromMetadata(requestMetadata);
    const requestStreamIntent = readBoolean(requestCarrier?.stream);
    const streamFlag = streamFromAcceptHeader === true || metadataStreamIntent === true
      ? true
      : requestStreamIntent ?? metadataStreamIntent;
    if (runtimeMetadata) {
      if (!runtimeMetadata.metadata || typeof runtimeMetadata.metadata !== 'object') {
        runtimeMetadata.metadata = {};
      }
      const runtimeMetadataCenter = MetadataCenter.read(runtimeMetadata.metadata);
      if (entryEndpoint) {
        (runtimeMetadata.metadata as Record<string, unknown>).entryEndpoint = entryEndpoint;
      }
      if (typeof streamFlag === 'boolean') {
        (runtimeMetadata.metadata as Record<string, unknown>).stream = !!streamFlag;
      }
      if (typeof inboundModel === 'string' && inboundModel.trim()) {
        (runtimeMetadata.metadata as Record<string, unknown>).__origModel = inboundModel;
      }
      if (runtimeMetadataCenter) {
        MetadataCenter.bind(runtimeMetadata.metadata as Record<string, unknown>, runtimeMetadataCenter);
      }
    }
    if (runtimeMetadata && processedRequest && typeof processedRequest === 'object') {
      attachProviderRuntimeMetadata(processedRequest as Record<string, unknown>, runtimeMetadata);
    }

    delete (processedRequest as MetadataContainer).metadata;

    return processedRequest;
  }
}
