import type { ConversionContext, ConversionProfile } from '../types.js';
import { normalizeChatRequest } from './openai-message-normalize.js';
import { createSnapshotWriter } from '../snapshot-utils.js';
import { buildGovernedFilterPayloadWithNative } from '../../router/virtual-router/engine-selection/native-chat-request-filter-semantics.js';
import { pruneChatRequestPayloadWithNative } from '../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

/**
 * Native-primary Chat request filters.
 *
 * Historical TS FilterEngine implementation archived at:
 * - src/conversion/shared/archive/chat-request-filters.ts
 */
export async function runStandardChatRequestFilters(
  chatRequest: any,
  profile: ConversionProfile,
  context: ConversionContext
): Promise<any> {
  const existingMetadata = context.metadata ?? {};
  if (!context.metadata) {
    context.metadata = existingMetadata;
  }
  const inboundStreamFromContext =
    typeof existingMetadata.inboundStream === 'boolean' ? (existingMetadata.inboundStream as boolean) : undefined;
  const inboundStreamDetected =
    chatRequest && typeof chatRequest === 'object' && (chatRequest as any).stream === true ? true : undefined;
  const normalizedInboundStream = inboundStreamFromContext ?? inboundStreamDetected;
  if (typeof normalizedInboundStream === 'boolean') {
    existingMetadata.inboundStream = normalizedInboundStream;
  }

  const requestId = context.requestId ?? `req_${Date.now()}`;
  const endpoint = context.entryEndpoint || context.endpoint || '/v1/chat/completions';

  const snapshot = createSnapshotWriter({
    requestId,
    endpoint,
    folderHint: 'openai-chat'
  });
  const snapshotStage = (stage: string, payload: unknown) => {
    if (!snapshot) return;
    snapshot(stage, payload);
  };
  snapshotStage('req_process_filters_input', chatRequest);

  const incomingProtocol = (profile.incomingProtocol || '').toLowerCase();
  const entryEndpointLower = endpoint.toLowerCase();
  const originalToolCount =
    chatRequest && typeof chatRequest === 'object' && Array.isArray((chatRequest as any).tools)
      ? ((chatRequest as any).tools as any[]).length
      : 0;
  const isAnthropicProfile =
    incomingProtocol === 'anthropic-messages' ||
    entryEndpointLower.includes('/v1/messages');
  const skipAutoToolInjection = isAnthropicProfile && originalToolCount === 0;

  const nativeGovernedPayload = buildGovernedFilterPayloadWithNative(chatRequest);
  if (skipAutoToolInjection && nativeGovernedPayload && typeof nativeGovernedPayload === 'object') {
    if (!Array.isArray((nativeGovernedPayload as any).tools)) {
      (nativeGovernedPayload as Record<string, unknown>).tools = [];
    }
    (nativeGovernedPayload as Record<string, unknown>).__rcc_disable_mcp_tools = true;
  }
  snapshotStage('req_process_filters_native_payload', nativeGovernedPayload);

  let normalized = normalizeChatRequest(nativeGovernedPayload);
  snapshotStage('req_process_filters_normalized', normalized);

  if (skipAutoToolInjection && normalized && typeof normalized === 'object') {
    if (!Array.isArray((normalized as any).tools)) {
      (normalized as Record<string, unknown>).tools = [];
    }
    (normalized as Record<string, unknown>).__rcc_disable_mcp_tools = true;
  }

  const preserveStreamField =
    profile.incomingProtocol === 'openai-chat' && profile.outgoingProtocol === 'openai-chat';

  const pruned = pruneChatRequestPayloadWithNative(normalized, preserveStreamField);
  snapshotStage('req_process_filters_output', pruned);
  return pruned;
}
