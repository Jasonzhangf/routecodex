import type { AdapterContext } from "../../hub/types/chat-envelope.js";
import type { JsonObject } from "../../hub/types/json.js";
import { buildNativeReqOutboundCompatAdapterContext } from "../../hub/pipeline/compat/native-adapter-context.js";
import type {
  NativeReqOutboundCompatAdapterContextInput,
  NativeRespInboundStage3CompatInput,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js";
import { runRespInboundStage3CompatWithNative } from "../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js";

const PROFILE = "chat:glm";
const DEFAULT_PROVIDER_PROTOCOL = "openai-chat";
const DEFAULT_ENTRY_ENDPOINT = "/v1/chat/completions";

function buildGlmCompatContext(
  adapterContext?: AdapterContext,
): NativeReqOutboundCompatAdapterContextInput {
  const nativeContext =
    buildNativeReqOutboundCompatAdapterContext(adapterContext);
  return {
    ...nativeContext,
    compatibilityProfile: PROFILE,
    providerProtocol:
      nativeContext.providerProtocol ??
      adapterContext?.providerProtocol ??
      DEFAULT_PROVIDER_PROTOCOL,
    entryEndpoint:
      nativeContext.entryEndpoint ??
      adapterContext?.entryEndpoint ??
      DEFAULT_ENTRY_ENDPOINT,
  };
}

function buildGlmResponseCompatInput(
  payload: JsonObject,
  adapterContext?: AdapterContext,
): NativeRespInboundStage3CompatInput {
  return {
    payload,
    adapterContext: buildGlmCompatContext(adapterContext),
    explicitProfile: PROFILE,
  };
}

export function extractGlmToolMarkup(
  root: JsonObject,
  adapterContext?: AdapterContext,
): void {
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return;
  }

  const normalized = runRespInboundStage3CompatWithNative(
    buildGlmResponseCompatInput(root, adapterContext),
  ).payload;
  Object.keys(root).forEach((key) => {
    delete (root as Record<string, unknown>)[key];
  });
  Object.assign(
    root as Record<string, unknown>,
    normalized as Record<string, unknown>,
  );
}
