import type { AdapterContext } from '../../hub/types/chat-envelope.js';
import type { JsonObject } from '../../hub/types/json.js';
import { buildNativeReqOutboundCompatAdapterContext } from '../../hub/pipeline/compat/native-adapter-context.js';
import type {
  NativeReqOutboundCompatAdapterContextInput,
  NativeReqOutboundStage3CompatInput
} from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';
import { runReqOutboundStage3CompatWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';

const PROFILE = 'chat:gemini-cli';
const DEFAULT_PROVIDER_PROTOCOL = 'gemini-chat';
const DEFAULT_ENTRY_ENDPOINT = '/v1/chat/completions';

function buildGeminiCliCompatContext(adapterContext?: AdapterContext): NativeReqOutboundCompatAdapterContextInput {
  const nativeContext = buildNativeReqOutboundCompatAdapterContext(adapterContext);
  return {
    ...nativeContext,
    compatibilityProfile: PROFILE,
    providerProtocol: nativeContext.providerProtocol ?? adapterContext?.providerProtocol ?? DEFAULT_PROVIDER_PROTOCOL,
    entryEndpoint: nativeContext.entryEndpoint ?? adapterContext?.entryEndpoint ?? DEFAULT_ENTRY_ENDPOINT
  };
}

export function buildGeminiCliCompatInput(
  payload: JsonObject,
  adapterContext?: AdapterContext
): NativeReqOutboundStage3CompatInput {
  return {
    payload,
    adapterContext: buildGeminiCliCompatContext(adapterContext),
    explicitProfile: PROFILE
  };
}

export function wrapGeminiCliRequest(payload: JsonObject, adapterContext?: AdapterContext): JsonObject {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  return runReqOutboundStage3CompatWithNative(buildGeminiCliCompatInput(payload, adapterContext)).payload;
}
