export const BRIDGE_RAW_SYSTEM_METADATA_KEY = '__rcc_raw_system';

import { normalizeProviderProtocolTokenWithNative } from '../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

export function resolveBridgeMetadataNativeProtocol(): string {
  return normalizeProviderProtocolTokenWithNative('openai-responses') ?? 'openai-responses';
}
