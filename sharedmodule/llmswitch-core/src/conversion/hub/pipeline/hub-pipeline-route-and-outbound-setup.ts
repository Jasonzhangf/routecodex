import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";
import type { RouterMetadataInput } from "../../../router/virtual-router/types.js";
import type {
  HubPipelineResult,
  NormalizedRequest,
} from "./hub-pipeline.js";
import { buildAdapterContextFromNormalized } from "./hub-pipeline-adapter-context.js";
import { extractSessionIdentifiersFromMetadata } from "./session-identifiers.js";
import { applyMaxTokensPolicyForRequest } from "./hub-pipeline-max-tokens-policy.js";
import {
  applyOutboundStreamPreferenceWithNative,
  resolveOutboundStreamIntentWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import {
  buildRouteMetadataInput,
  readRouteRuntimeDirectives,
  syncNormalizedSessionMetadata,
} from "./hub-pipeline-route-and-outbound-blocks.js";

export function prepareRouteSelectionContext(args: {
  normalized: NormalizedRequest;
  workingRequest: StandardizedRequest | ProcessedRequest;
  serverToolRequired: boolean;
}): {
  metadataInput: RouterMetadataInput;
} {
  const sessionIdentifiers = extractSessionIdentifiersFromMetadata(
    args.normalized.metadata as Record<string, unknown> | undefined,
  );
  const normalizedMetadata =
    args.normalized.metadata as Record<string, unknown> | undefined;
  const routeRuntimeDirectives = readRouteRuntimeDirectives(normalizedMetadata);
  syncNormalizedSessionMetadata({
    normalizedMetadata,
    sessionId: sessionIdentifiers.sessionId,
    conversationId: sessionIdentifiers.conversationId,
  });
  return {
    metadataInput: buildRouteMetadataInput({
      normalized: args.normalized,
      requestSemantics: (args.workingRequest as { semantics?: Record<string, unknown> })
        .semantics,
      serverToolRequired: args.serverToolRequired === true,
      sessionId: sessionIdentifiers.sessionId,
      conversationId: sessionIdentifiers.conversationId,
      normalizedMetadata,
      routeRuntimeDirectives,
    }) as unknown as RouterMetadataInput,
  };
}

export function prepareOutboundExecutionContext(args: {
  normalized: NormalizedRequest;
  routingTarget: HubPipelineResult["target"];
  workingRequest: StandardizedRequest | ProcessedRequest;
  activeProcessMode: "chat" | "passthrough";
  routerEngine: { updateDeps?: unknown };
}): {
  workingRequest: StandardizedRequest | ProcessedRequest;
  outboundStream: boolean;
  outboundAdapterContext: ReturnType<typeof buildAdapterContextFromNormalized>;
  outboundProtocol: NormalizedRequest["providerProtocol"];
} {
  const outboundStream = resolveOutboundStreamIntentWithNative(
    args.routingTarget?.streaming,
  );
  const workingRequest = applyOutboundStreamPreferenceWithNative(
    args.workingRequest as unknown as Record<string, unknown>,
    outboundStream,
    args.activeProcessMode,
  ) as unknown as StandardizedRequest | ProcessedRequest;
  applyMaxTokensPolicyForRequest(
    workingRequest,
    args.routingTarget,
    args.routerEngine as any,
  );
  const outboundAdapterContext = buildAdapterContextFromNormalized(
    args.normalized,
    args.routingTarget,
  );
  if (args.routingTarget?.compatibilityProfile) {
    outboundAdapterContext.compatibilityProfile =
      args.routingTarget.compatibilityProfile;
  }
  const outboundProtocol = String(
    outboundAdapterContext.providerProtocol || "",
  ) as NormalizedRequest["providerProtocol"];
  if (
    args.activeProcessMode === "passthrough" &&
    outboundProtocol !== args.normalized.providerProtocol
  ) {
    throw new Error(
      `[HubPipeline] passthrough requires matching protocols: entry=${args.normalized.providerProtocol}, target=${outboundProtocol}`,
    );
  }
  return {
    workingRequest,
    outboundStream,
    outboundAdapterContext,
    outboundProtocol,
  };
}
