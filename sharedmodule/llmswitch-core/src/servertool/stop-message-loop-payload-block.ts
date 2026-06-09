import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import { buildServertoolReq04FollowupPayloadWithNative } from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';

export const SERVERTOOL_LOOP_WARNING_FEATURE_ID = 'feature_id: hub.servertool_loop_warning';

export function buildStopMessageLoopPayload(adapterContext: AdapterContext): JsonObject | null {
  const payload = buildServertoolReq04FollowupPayloadWithNative(adapterContext);
  if (!payload || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    return null;
  }
  return payload as JsonObject;
}
