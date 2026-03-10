import type { StandardizedRequest } from '../types/standardized.js';
import { resolveGovernanceContextWithNative } from '../../../router/virtual-router/engine-selection/native-chat-process-governance-semantics.js';

interface GovernanceContextSource {
  entryEndpoint: string;
  metadata: Record<string, unknown>;
}

export interface ResolvedGovernanceContext {
  entryEndpoint: string;
  metadata: Record<string, unknown>;
  providerProtocol: string;
  metadataToolHints: unknown;
  inboundStreamIntent: boolean;
  rawRequestBody?: Record<string, unknown>;
}

export function resolveGovernanceContext(
  request: StandardizedRequest,
  context: GovernanceContextSource
): ResolvedGovernanceContext {
  const nativeResolved = resolveGovernanceContextWithNative(request, context);
  return {
    ...nativeResolved
  };
}
