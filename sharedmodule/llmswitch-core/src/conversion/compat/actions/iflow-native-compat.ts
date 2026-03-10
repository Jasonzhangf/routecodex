import type { AdapterContext } from '../../hub/types/chat-envelope.js';
import type { JsonObject } from '../../hub/types/json.js';
import { buildNativeReqOutboundCompatAdapterContext } from '../../hub/pipeline/compat/native-adapter-context.js';
import type {
  NativeReqOutboundCompatAdapterContextInput,
  NativeReqOutboundStage3CompatInput,
  NativeRespInboundStage3CompatInput
} from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';

const PROFILE = 'chat:iflow';
const DEFAULT_PROVIDER_PROTOCOL = 'openai-chat';
const DEFAULT_ENTRY_ENDPOINT = '/v1/chat/completions';

export function buildIflowCompatContext(
  adapterContext?: AdapterContext
): NativeReqOutboundCompatAdapterContextInput {
  const nativeContext = buildNativeReqOutboundCompatAdapterContext(adapterContext);
  const adapterProfile =
    adapterContext && typeof adapterContext['compatibilityProfile'] === 'string'
      ? String(adapterContext['compatibilityProfile']).trim() || undefined
      : undefined;
  return {
    ...nativeContext,
    compatibilityProfile:
      nativeContext.compatibilityProfile ??
      adapterProfile ??
      PROFILE,
    providerProtocol:
      nativeContext.providerProtocol ??
      adapterContext?.providerProtocol ??
      DEFAULT_PROVIDER_PROTOCOL,
    entryEndpoint:
      nativeContext.entryEndpoint ??
      adapterContext?.entryEndpoint ??
      DEFAULT_ENTRY_ENDPOINT
  };
}

export function buildIflowRequestCompatInput(
  payload: JsonObject,
  adapterContext?: AdapterContext
): NativeReqOutboundStage3CompatInput {
  return {
    payload,
    adapterContext: buildIflowCompatContext(adapterContext),
    explicitProfile: PROFILE
  };
}

export function buildIflowResponseCompatInput(
  payload: JsonObject,
  adapterContext?: AdapterContext
): NativeRespInboundStage3CompatInput {
  return {
    payload,
    adapterContext: buildIflowCompatContext(adapterContext),
    explicitProfile: PROFILE
  };
}
