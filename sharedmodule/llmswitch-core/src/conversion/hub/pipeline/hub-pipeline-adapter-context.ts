import type { AdapterContext } from "../types/chat-envelope.js";
import type { TargetMetadata } from "../../../router/virtual-router/types.js";
import { normalizeReqInboundToolCallIdStyleWithNative } from "../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js";
import {
  applyMetadataAdapterContextFields,
  applyTargetAdapterContextFields,
} from "./hub-pipeline-adapter-context-blocks.js";

export interface HubPipelineAdapterContextRequestLike {
  id: string;
  entryEndpoint: string;
  providerProtocol: string;
  stream: boolean;
  metadata: Record<string, unknown>;
}

export function buildAdapterContextFromNormalized(
  normalized: HubPipelineAdapterContextRequestLike,
  target?: TargetMetadata,
): AdapterContext {
  const metadata = normalized.metadata || {};
  const providerProtocol =
    (target?.outboundProfile as string | undefined) ||
    normalized.providerProtocol;
  const providerKey = (target?.providerKey || metadata.providerKey) as
    | string
    | undefined;
  const providerId = providerKey as
    | string
    | undefined;
  const routeId = metadata.routeName as string | undefined;
  const profileId = (target?.providerKey || metadata.pipelineId) as
    | string
    | undefined;
  const targetCompatProfile =
    typeof target?.compatibilityProfile === "string" &&
    target.compatibilityProfile.trim()
      ? target.compatibilityProfile.trim()
      : undefined;
  const metadataCompatProfile =
    typeof (metadata as Record<string, unknown>).compatibilityProfile ===
    "string"
      ? String((metadata as Record<string, unknown>).compatibilityProfile).trim()
      : undefined;
  const compatibilityProfile = target ? targetCompatProfile : metadataCompatProfile;
  const streamingHint =
    normalized.stream === true
      ? "force"
      : normalized.stream === false
        ? "disable"
        : "auto";
  const toolCallIdStyle = normalizeReqInboundToolCallIdStyleWithNative(
    metadata.toolCallIdStyle,
  );
  const adapterContext: AdapterContext = {
    requestId: normalized.id,
    entryEndpoint: normalized.entryEndpoint || "/v1/chat/completions",
    providerProtocol,
    providerId,
    ...(providerKey ? { providerKey, targetProviderKey: providerKey } : {}),
    routeId,
    profileId,
    streamingHint,
    toolCallIdStyle,
    ...(compatibilityProfile ? { compatibilityProfile } : {}),
  };
  applyTargetAdapterContextFields({ adapterContext, target });
  applyMetadataAdapterContextFields({
    adapterContext,
    metadata: metadata as Record<string, unknown>,
  });
  return adapterContext;
}
