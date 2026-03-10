import type { AdapterContext } from '../../hub/types/chat-envelope.js';
import type { JsonObject } from '../../hub/types/json.js';
import { buildNativeReqOutboundCompatAdapterContext } from '../../hub/pipeline/compat/native-adapter-context.js';
import type {
  NativeReqOutboundCompatAdapterContextInput,
  NativeReqOutboundStage3CompatInput,
  NativeRespInboundStage3CompatInput
} from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';
import {
  runReqOutboundStage3CompatWithNative,
  runRespInboundStage3CompatWithNative
} from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';

const PROFILE = 'chat:qwen';
const DEFAULT_PROVIDER_PROTOCOL = 'openai-chat';
const DEFAULT_ENTRY_ENDPOINT = '/v1/chat/completions';

function buildQwenCompatContext(adapterContext?: AdapterContext): NativeReqOutboundCompatAdapterContextInput {
  const nativeContext = buildNativeReqOutboundCompatAdapterContext(adapterContext);
  return {
    ...nativeContext,
    compatibilityProfile: PROFILE,
    providerProtocol: nativeContext.providerProtocol ?? adapterContext?.providerProtocol ?? DEFAULT_PROVIDER_PROTOCOL,
    entryEndpoint: nativeContext.entryEndpoint ?? adapterContext?.entryEndpoint ?? DEFAULT_ENTRY_ENDPOINT
  };
}

function buildQwenRequestCompatInput(
  payload: JsonObject,
  adapterContext?: AdapterContext
): NativeReqOutboundStage3CompatInput {
  return {
    payload,
    adapterContext: buildQwenCompatContext(adapterContext),
    explicitProfile: PROFILE
  };
}

function buildQwenResponseCompatInput(
  payload: JsonObject,
  adapterContext?: AdapterContext
): NativeRespInboundStage3CompatInput {
  return {
    payload,
    adapterContext: buildQwenCompatContext(adapterContext),
    explicitProfile: PROFILE
  };
}

export function applyQwenRequestTransform(payload: JsonObject, adapterContext?: AdapterContext): JsonObject {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  return runReqOutboundStage3CompatWithNative(buildQwenRequestCompatInput(payload, adapterContext)).payload;
}

export function applyQwenResponseTransform(payload: JsonObject, adapterContext?: AdapterContext): JsonObject {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  return runRespInboundStage3CompatWithNative(buildQwenResponseCompatInput(payload, adapterContext)).payload;
}
