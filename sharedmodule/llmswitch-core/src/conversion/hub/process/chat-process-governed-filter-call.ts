import type { StandardizedRequest } from '../types/standardized.js';
import {
  buildGovernedFilterPayloadWithNative
} from '../../../router/virtual-router/engine-selection/native-chat-process-governed-filter-semantics.js';

interface GovernedFilterCallOptions {
  request: StandardizedRequest;
  entryEndpoint: string;
  requestId: string;
  providerProtocol: string;
  inboundStreamIntent: boolean;
  metadataToolHints: unknown;
  rawRequestBody?: Record<string, unknown>;
}

export async function runGovernedChatRequestFilters(
  options: GovernedFilterCallOptions
): Promise<Record<string, unknown>> {
  const { request } = options;
  const shaped = buildGovernedFilterPayloadWithNative(request) as Record<string, unknown>;
  return shaped;
}
