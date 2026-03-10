import type { AdapterContext } from '../../types/chat-envelope.js';
import { normalizeProviderProtocolTokenWithNative } from '../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

type UnknownRecord = Record<string, unknown>;

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

export function resolveCompatProfileForContext(adapterContext: AdapterContext): string | undefined {
  normalizeProviderProtocolTokenWithNative(adapterContext.providerProtocol);
  const context = adapterContext as unknown as UnknownRecord;
  const explicit = readNonEmptyString(context.compatibilityProfile);
  return explicit;
}
