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
    const headersFromRequest = ProviderPayloadUtils.normalizeClientHeaders((request as MetadataContainer)?.metadata?.clientHeaders);
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
    if (runtimeMetadata && processedRequest && typeof processedRequest === 'object') {
      attachProviderRuntimeMetadata(processedRequest as Record<string, unknown>, runtimeMetadata);
    }

    const requestCarrier = request as MetadataContainer;
    const inboundModel = typeof requestCarrier?.model === 'string' ? requestCarrier.model : undefined;
    const entryEndpoint =
      typeof requestCarrier?.metadata?.entryEndpoint === 'string'
        ? requestCarrier.metadata.entryEndpoint
        : requestCarrier?.entryEndpoint;
    const streamFlag = typeof requestCarrier?.metadata?.stream === 'boolean'
      ? requestCarrier.metadata.stream
      : requestCarrier?.stream;
    const processedMetadata = (processedRequest as MetadataContainer).metadata ?? {};
    (processedRequest as MetadataContainer).metadata = {
      ...processedMetadata,
      ...(entryEndpoint ? { entryEndpoint } : {}),
      ...(typeof streamFlag === 'boolean' ? { stream: !!streamFlag } : {}),
      ...(effectiveClientHeaders ? { clientHeaders: effectiveClientHeaders } : {}),
      __origModel: inboundModel
    };

    return processedRequest;
  }
}
