import {
  buildDirectProviderRuntimeMetadataNative,
  buildRouterDirectRouteMetadataNative,
} from '../../../modules/llmswitch/bridge/direct-runtime-metadata-host.js';

export function buildRouterDirectRouteMetadata(input: {
  metadata?: Record<string, unknown>;
  metadataCenterSnapshot?: Record<string, unknown>;
  requestId?: string;
  entryEndpoint?: string;
}): Record<string, unknown> {
  return buildRouterDirectRouteMetadataNative(input);
}

export function buildDirectProviderRuntimeMetadata(input: {
  metadata?: Record<string, unknown>;
  entryEndpoint?: string;
  localPort?: number;
  providerProtocol?: string;
}): Record<string, unknown> {
  return buildDirectProviderRuntimeMetadataNative(input);
}
