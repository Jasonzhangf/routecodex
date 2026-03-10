import { runChatRequestToolFilters } from '../../shared/tool-filter-pipeline.js';
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

  const governedPayload = await runChatRequestToolFilters(shaped, {
    entryEndpoint: options.entryEndpoint,
    requestId: options.requestId,
    model: request.model,
    profile: options.providerProtocol,
    stream: options.inboundStreamIntent,
    toolFilterHints: options.metadataToolHints,
    rawPayload: options.rawRequestBody && typeof options.rawRequestBody === 'object'
      ? options.rawRequestBody
      : undefined
  });
  return governedPayload as Record<string, unknown>;
}
