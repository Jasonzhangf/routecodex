import type { ProviderHandle, ProviderProtocol } from '../types.js';
import { enhanceProviderRequestId } from '../../../utils/request-id-manager.js';
import { buildProviderLabel, extractProviderModel } from './provider-response-utils.js';

type ProviderTargetLike = {
  providerKey: string;
  outboundProfile?: ProviderProtocol;
};

export function resolveProviderRequestContext(options: {
  providerRequestId: string;
  entryEndpoint: string;
  target: ProviderTargetLike;
  handle: ProviderHandle;
  runtimeKey: string;
  providerPayload: unknown;
  mergedMetadata?: Record<string, unknown>;
}): {
  requestId: string;
  providerProtocol: ProviderProtocol;
  providerModel?: string;
  providerLabel?: string;
} {
  const {
    providerRequestId,
    entryEndpoint,
    target,
    handle,
    runtimeKey,
    providerPayload,
    mergedMetadata
  } = options;
  const providerProtocol = (target.outboundProfile as ProviderProtocol) || handle.providerProtocol;
  const metadataModel =
    mergedMetadata?.target && typeof mergedMetadata.target === 'object'
      ? (mergedMetadata.target as Record<string, unknown>).clientModelId
      : undefined;
  const payloadRecord =
    providerPayload && typeof providerPayload === 'object'
      ? (providerPayload as Record<string, unknown>)
      : undefined;
  const rawModel =
    extractProviderModel(payloadRecord) ||
    (typeof metadataModel === 'string' ? metadataModel : undefined);
  const providerAlias =
    typeof target.providerKey === 'string' && target.providerKey.includes('.')
      ? target.providerKey.split('.').slice(0, 2).join('.')
      : target.providerKey;
  const providerIdToken = providerAlias || handle.providerId || runtimeKey;
  if (!providerIdToken) {
    throw Object.assign(new Error('Provider identifier missing for request'), {
      code: 'ERR_PROVIDER_ID_MISSING',
      requestId: providerRequestId
    });
  }

  const enhancedRequestId = enhanceProviderRequestId(providerRequestId, {
    entryEndpoint,
    providerId: providerIdToken,
    model: rawModel
  });
  const providerModel = rawModel;
  const providerLabel = buildProviderLabel(target.providerKey, providerModel);

  return {
    requestId: enhancedRequestId,
    providerProtocol,
    providerModel,
    providerLabel
  };
}
