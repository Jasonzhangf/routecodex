import type { AdapterContext, ChatEnvelope, ChatToolDefinition } from '../../../../types/chat-envelope.js';
import {
  selectToolCallIdStyleWithNative
} from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-inbound-outbound-semantics.js';
import {
  applyReqOutboundContextSnapshotWithNative
} from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';

export function applyToolCallIdStyleMetadata(
  chatEnvelope: ChatEnvelope,
  adapterContext: AdapterContext,
  snapshot?: Record<string, unknown>
): void {
  const metadata = chatEnvelope.metadata || (chatEnvelope.metadata = { context: adapterContext });
  const current =
    typeof (metadata as Record<string, unknown>).toolCallIdStyle === 'string'
      ? String((metadata as Record<string, unknown>).toolCallIdStyle).trim()
      : '';
  const resolved = selectToolCallIdStyleWithNative(
    adapterContext,
    snapshot ?? {},
    current || undefined
  );
  if (!resolved) {
    return;
  }
  // Always honor the route-selected AdapterContext toolCallIdStyle when present.
  // This prevents cross-provider leakage (e.g. LM Studio "preserve" contaminating OpenAI "fc").
  if (!current || current !== resolved) {
    (metadata as Record<string, unknown>).toolCallIdStyle = resolved;
  }
}

export function applyContextSnapshotToChatEnvelope(
  chatEnvelope: ChatEnvelope,
  snapshot: Record<string, unknown>
): void {
  const hasExistingTools = Array.isArray(chatEnvelope.tools) && chatEnvelope.tools.length > 0;
  const patch = applyReqOutboundContextSnapshotWithNative(
    {
      chatEnvelope: chatEnvelope as unknown as Record<string, unknown>,
      snapshot
    }
  );
  if (Array.isArray(patch.toolOutputs) && patch.toolOutputs.length) {
    chatEnvelope.toolOutputs = patch.toolOutputs;
  }
  if (!hasExistingTools && Array.isArray(patch.tools) && patch.tools.length) {
    chatEnvelope.tools = patch.tools as unknown as ChatToolDefinition[];
  }
}
