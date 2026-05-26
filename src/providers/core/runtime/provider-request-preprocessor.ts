import type { UnknownObject } from '../../../types/common-types.js';
import type { ProviderRuntimeMetadata } from './provider-runtime-metadata.js';
import { attachProviderRuntimeMetadata } from './provider-runtime-metadata.js';
import { ProviderPayloadUtils } from './transport/provider-payload-utils.js';

type MetadataContainer = {
  metadata?: Record<string, unknown>;
  model?: unknown;
  entryEndpoint?: string;
  stream?: boolean;
};

export class ProviderRequestPreprocessor {
  static preprocess(request: UnknownObject, runtimeMetadata?: ProviderRuntimeMetadata): UnknownObject {
    const requestMetadata =
      request && typeof request === 'object' && (request as MetadataContainer).metadata && typeof (request as MetadataContainer).metadata === 'object'
        ? ((request as MetadataContainer).metadata as Record<string, unknown>)
        : undefined;
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
    const streamFlag = typeof requestMetadata?.stream === 'boolean'
      ? requestMetadata.stream
      : requestCarrier?.stream;
    const qwenWebSearch = requestMetadata?.qwenWebSearch === true;
    if (runtimeMetadata) {
      if (!runtimeMetadata.metadata || typeof runtimeMetadata.metadata !== 'object') {
        runtimeMetadata.metadata = {};
      }
      if (entryEndpoint) {
        (runtimeMetadata.metadata as Record<string, unknown>).entryEndpoint = entryEndpoint;
      }
      if (typeof streamFlag === 'boolean') {
        (runtimeMetadata.metadata as Record<string, unknown>).stream = !!streamFlag;
      }
      if (typeof inboundModel === 'string' && inboundModel.trim()) {
        (runtimeMetadata.metadata as Record<string, unknown>).__origModel = inboundModel;
      }
      if (qwenWebSearch) {
        runtimeMetadata.qwenWebSearch = true;
        (runtimeMetadata.metadata as Record<string, unknown>).qwenWebSearch = true;
      }
    }
    if (runtimeMetadata && processedRequest && typeof processedRequest === 'object') {
      attachProviderRuntimeMetadata(processedRequest as Record<string, unknown>, runtimeMetadata);
    }

    const processedMetadata = ((processedRequest as MetadataContainer).metadata ?? {}) as Record<string, unknown>;
    const {
      entryEndpoint: _dropEntryEndpoint,
      stream: _dropStream,
      clientHeaders: _dropClientHeaders,
      qwenWebSearch: _dropQwenWebSearch,
      __origModel: _dropOrigModel,
      ...restMetadata
    } = processedMetadata;
    if (Object.keys(restMetadata).length > 0) {
      (processedRequest as MetadataContainer).metadata = restMetadata;
    } else {
      delete (processedRequest as MetadataContainer).metadata;
    }

    return processedRequest;
  }
}
