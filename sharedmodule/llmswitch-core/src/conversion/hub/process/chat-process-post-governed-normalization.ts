import { normalizeApplyPatchToolCallsOnRequest } from '../../shared/tool-governor.js';
import { containsImageAttachment, stripHistoricalImageAttachments } from './chat-process-media.js';
import { maybeInjectPendingServerToolResultsAfterClientTools } from './chat-process-pending-tool-sync.js';
import type { StandardizedRequest } from '../types/standardized.js';
import { buildImageAttachmentMetadataWithNative } from '../../../router/virtual-router/engine-selection/native-chat-process-post-governed-normalization-semantics.js';

interface PostGovernedNormalizationOptions {
  request: StandardizedRequest;
  metadata: Record<string, unknown>;
  originalEndpoint?: string;
}

export async function applyPostGovernedNormalization(
  options: PostGovernedNormalizationOptions
): Promise<StandardizedRequest> {
  let request: StandardizedRequest = {
    ...options.request,
    messages: stripHistoricalImageAttachments(options.request.messages)
  };
  request = normalizeApplyPatchToolCallsOnRequest(
    request as unknown as Record<string, unknown>
  ) as unknown as StandardizedRequest;
  request = await maybeInjectPendingServerToolResultsAfterClientTools(request, options.metadata);

  if (containsImageAttachment(request.messages)) {
    request.metadata = buildImageAttachmentMetadataWithNative(
      request.metadata as Record<string, unknown> | undefined,
      options.originalEndpoint ?? '/v1/chat/completions'
    ) as StandardizedRequest['metadata'];
  }
  return request;
}
