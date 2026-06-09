import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import { buildServertoolReq04FollowupPayloadWithNative } from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';

export function buildStopMessageLoopPayload(adapterContext: AdapterContext): JsonObject | null {
  const payload = buildServertoolReq04FollowupPayloadWithNative(adapterContext);
  if (!payload || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    return null;
  }
  return payload as JsonObject;
}
