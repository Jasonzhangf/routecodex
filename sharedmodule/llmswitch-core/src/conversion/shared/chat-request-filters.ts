import type { ConversionContext, ConversionProfile } from '../types.js';
import { normalizeChatRequest } from './openai-message-normalize.js';
import { createSnapshotWriter } from '../snapshot-utils.js';
import { buildGovernedFilterPayloadWithNative } from '../../native/router-hotpath/native-chat-request-filter-semantics.js';
import { pruneChatRequestPayloadWithNative } from '../../native/router-hotpath/native-hub-pipeline-req-inbound-semantics.js';

/**
 * Native-primary Chat request filters.
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

  const nativeGovernedPayload = buildGovernedFilterPayloadWithNative(chatRequest, {
    incomingProtocol: profile.incomingProtocol,
    entryEndpoint: endpoint,
  });
  snapshotStage('req_process_filters_native_payload', nativeGovernedPayload);

  let normalized = normalizeChatRequest(nativeGovernedPayload);
  snapshotStage('req_process_filters_normalized', normalized);

  const preserveStreamField =
    profile.incomingProtocol === 'openai-chat' && profile.outgoingProtocol === 'openai-chat';

  const pruned = pruneChatRequestPayloadWithNative(normalized, preserveStreamField);
  snapshotStage('req_process_filters_output', pruned);
  return pruned;
}
