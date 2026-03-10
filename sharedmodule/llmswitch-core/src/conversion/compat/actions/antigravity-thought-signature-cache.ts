import type { AdapterContext } from '../../hub/types/chat-envelope.js';
import type { JsonObject } from '../../hub/types/json.js';
import { runRespInboundStage3CompatWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';
import { buildGeminiCliCompatInput } from './gemini-cli-request.js';

export function cacheAntigravityThoughtSignatureFromGeminiResponse(
  payload: JsonObject,
  adapterContext?: AdapterContext
): JsonObject {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  return runRespInboundStage3CompatWithNative(
    buildGeminiCliCompatInput(payload, adapterContext)
  ).payload;
}
