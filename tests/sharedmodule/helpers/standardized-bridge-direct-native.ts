import type { AdapterContext, ChatEnvelope } from '../../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { StandardizedRequest } from '../../../sharedmodule/llmswitch-core/src/conversion/hub/types/standardized.js';
import { chatEnvelopeToStandardizedWithNative } from '../../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-inbound-semantics.js';
import path from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const nativeBinding = nodeRequire(
  path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node')
) as Record<string, unknown>;

function standardizedToChatEnvelopeDirectNativeBinding(
  request: Record<string, unknown>,
  adapterContext: Record<string, unknown>
): Record<string, unknown> {
  const fn = nativeBinding.standardizedToChatEnvelopeJson;
  if (typeof fn !== 'function') {
    throw new Error('standardizedToChatEnvelopeJson native export is required');
  }
  const raw = fn(JSON.stringify(request), JSON.stringify(adapterContext));
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('standardizedToChatEnvelopeJson returned invalid payload');
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('standardizedToChatEnvelopeJson returned non-object payload');
  }
  return parsed as Record<string, unknown>;
}

export function chatEnvelopeToStandardizedDirectNative(
  chat: ChatEnvelope,
  options: { adapterContext: AdapterContext; endpoint: string; requestId?: string },
): StandardizedRequest {
  return chatEnvelopeToStandardizedWithNative({
    chatEnvelope: chat as unknown as Record<string, unknown>,
    adapterContext: options.adapterContext as unknown as Record<string, unknown>,
    endpoint: options.endpoint,
    requestId: options.requestId,
  }) as unknown as StandardizedRequest;
}

export function standardizedToChatEnvelopeDirectNative(
  request: StandardizedRequest,
  options: { adapterContext: AdapterContext },
): ChatEnvelope {
  return standardizedToChatEnvelopeDirectNativeBinding(
    request as unknown as Record<string, unknown>,
    options.adapterContext as unknown as Record<string, unknown>,
  ) as unknown as ChatEnvelope;
}
