import type { StandardizedRequest } from '../types/standardized.js';
import { finalizeGovernedRequestWithNative } from '../../../router/virtual-router/engine-selection/native-chat-process-governance-semantics.js';

export interface ToolGovernanceLike {
  governRequest(
    request: StandardizedRequest,
    providerProtocol: string
  ): { request: StandardizedRequest; summary: { applied?: boolean } };
}

interface GovernanceFinalizeOptions {
  request: StandardizedRequest;
  providerProtocol: string;
  governanceEngine: ToolGovernanceLike;
}

export function finalizeGovernedRequest(options: GovernanceFinalizeOptions): StandardizedRequest {
  const { request, providerProtocol, governanceEngine } = options;
  const { request: sanitized, summary } = governanceEngine.governRequest(request, providerProtocol);
  if (summary.applied !== true) {
    return sanitized;
  }

  const finalized = finalizeGovernedRequestWithNative(
    sanitized as unknown as Record<string, unknown>,
    summary as unknown as Record<string, unknown>
  ) as unknown as StandardizedRequest;
  sanitized.metadata = finalized.metadata;
  return sanitized;
}
