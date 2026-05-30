import { Readable } from "node:stream";
import type { SseProtocol } from "../../../sse/index.js";
import { defaultSseCodecRegistry } from "../../../sse/index.js";
import {
  extractModelHintFromMetadataWithNative,
  normalizeHubEndpointWithNative,
  resolveSseProtocolWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import type {
  HubPipelineRequest,
  NormalizedRequest,
  ProviderProtocol,
} from "./hub-pipeline.js";
import type { HubPolicyConfig } from "../policy/policy-engine.js";
import type { StageRecorder } from "../format-adapters/index.js";
import type { HubShadowCompareRequestConfig } from "./hub-pipeline.js";
import { formatUnknownError } from "../../../shared/common-utils.js";
import {
  resolveHubPolicyOverrideFromMetadataWithNative,
  resolveHubShadowCompareConfigWithNative,
  resolveHubProviderProtocolWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import { runHubPipelineOrchestrationWithNative } from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";

type HubPipelineProviderProtocol =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "gemini-chat";

type HubNormalizedRouteShape = {
  entryEndpoint: string;
  providerProtocol: ProviderProtocol;
  processMode: NormalizedRequest["processMode"];
  direction: NormalizedRequest["direction"];
  stage: NormalizedRequest["stage"];
  stream: boolean;
  routeHint?: string;
};

function resolveProviderProtocolOrThrow(value: unknown): ProviderProtocol {
  try {
    return resolveHubProviderProtocolWithNative(value) as ProviderProtocol;
  } catch (error) {
    throw new Error(`[HubPipeline] Unsupported providerProtocol "${value}". native resolver failed: ${formatUnknownError(error)}`);
  }
}

function resolveNormalizedRouteShape(args: {
  orchestrationMetadata: Record<string, unknown>;
  base: HubNormalizedRouteShape;
}): HubNormalizedRouteShape {
  const normalizedEntryEndpoint = typeof args.orchestrationMetadata.entryEndpoint === "string" && args.orchestrationMetadata.entryEndpoint.trim().length > 0
    ? normalizeHubEndpointWithNative(args.orchestrationMetadata.entryEndpoint)
    : args.base.entryEndpoint;
  const normalizedProviderProtocol = resolveProviderProtocolOrThrow(args.orchestrationMetadata.providerProtocol);
  const normalizedProcessMode: NormalizedRequest["processMode"] = (() => {
    const raw = typeof args.orchestrationMetadata.processMode === "string" ? args.orchestrationMetadata.processMode.trim() : undefined;
    if (raw === "passthrough") { throw new Error(`[HubPipeline] processMode='passthrough' is no longer supported. (requestId=${args.orchestrationMetadata.requestId ?? "unknown"})`); }
    return "chat" as const;
  })();
  const normalizedDirection: NormalizedRequest["direction"] = args.orchestrationMetadata.direction === "response" ? "response" : "request";
  const normalizedStage: NormalizedRequest["stage"] = args.orchestrationMetadata.stage === "outbound" ? "outbound" : "inbound";
  const normalizedStream = Boolean(typeof args.orchestrationMetadata.stream === "boolean" ? args.orchestrationMetadata.stream : args.base.stream);
  const normalizedRouteHint = typeof args.orchestrationMetadata.routeHint === "string" && args.orchestrationMetadata.routeHint.trim().length > 0
    ? args.orchestrationMetadata.routeHint.trim()
    : args.base.routeHint;
  return {
    entryEndpoint: normalizedEntryEndpoint,
    providerProtocol: normalizedProviderProtocol,
    processMode: normalizedProcessMode,
    direction: normalizedDirection,
    stage: normalizedStage,
    stream: normalizedStream,
    ...(normalizedRouteHint ? { routeHint: normalizedRouteHint } : {}),
  };
}

function buildNormalizedMetadataRecord(args: {
  metadataRecord: Record<string, unknown>;
  orchestrationMetadata: Record<string, unknown>;
  routeShape: HubNormalizedRouteShape;
}): Record<string, unknown> {
  return {
    ...args.metadataRecord,
    entryEndpoint: args.routeShape.entryEndpoint,
    providerProtocol: args.routeShape.providerProtocol,
    processMode: args.routeShape.processMode,
    direction: args.routeShape.direction,
    stage: args.routeShape.stage,
    stream: args.routeShape.stream,
    ...(args.routeShape.routeHint ? { routeHint: args.routeShape.routeHint } : {}),
    ...args.orchestrationMetadata,
  };
}

function buildNormalizedRequestResult(args: {
  id: string;
  endpoint: string;
  routeShape: HubNormalizedRouteShape;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  policyOverride?: HubPolicyConfig;
  shadowCompare?: HubShadowCompareRequestConfig;
  disableSnapshots: boolean;
  hubEntryMode?: NormalizedRequest["hubEntryMode"];
  externalStageRecorder?: StageRecorder;
}): NormalizedRequest {
  return {
    id: args.id,
    endpoint: args.endpoint,
    entryEndpoint: args.routeShape.entryEndpoint,
    providerProtocol: args.routeShape.providerProtocol,
    payload: args.payload,
    metadata: args.metadata,
    policyOverride: args.policyOverride,
    shadowCompare: args.shadowCompare,
    disableSnapshots: args.disableSnapshots,
    ...(args.externalStageRecorder ? { externalStageRecorder: args.externalStageRecorder } : {}),
    processMode: args.routeShape.processMode,
    direction: args.routeShape.direction,
    stage: args.routeShape.stage,
    stream: args.routeShape.stream,
    routeHint: args.routeShape.routeHint,
    ...(args.hubEntryMode ? { hubEntryMode: args.hubEntryMode } : {}),
  };
}

function buildPreOrchestrationRequestShape(args: {
  request: HubPipelineRequest;
  endpoint: string;
  metadataRecord: Record<string, unknown>;
}): {
  entryEndpoint: string;
  providerProtocol: ProviderProtocol;
  processMode: NormalizedRequest["processMode"];
  direction: NormalizedRequest["direction"];
  stage: NormalizedRequest["stage"];
  stream: boolean;
  routeHint?: string;
} {
  const { request, endpoint, metadataRecord } = args;
  const entryEndpoint =
    typeof metadataRecord.entryEndpoint === "string"
      ? normalizeHubEndpointWithNative(metadataRecord.entryEndpoint)
      : endpoint;
  const providerProtocol = resolveProviderProtocolOrThrow(
    metadataRecord.providerProtocol,
  );
  const processMode = (() => {
    if (metadataRecord.processMode === "passthrough") { throw new Error(`[HubPipeline] processMode='passthrough' is no longer supported. (requestId=${metadataRecord.requestId ?? "unknown"})`); }
    return "chat" as const;
  })();
  const direction =
    metadataRecord.direction === "response" ? "response" : "request";
  const stage = metadataRecord.stage === "outbound" ? "outbound" : "inbound";
  const stream = Boolean(
    metadataRecord.stream ||
      (request.payload &&
        typeof request.payload === "object" &&
        (request.payload as Record<string, unknown>).stream),
  );
  const routeHint =
    typeof metadataRecord.routeHint === "string"
      ? metadataRecord.routeHint
      : undefined;
  return {
    entryEndpoint,
    providerProtocol,
    processMode,
    direction,
    stage,
    stream,
    ...(routeHint ? { routeHint } : {}),
  };
}

function finalizeNormalizedRequest(args: {
  id: string;
  endpoint: string;
  payload: Record<string, unknown>;
  metadataRecord: Record<string, unknown>;
  orchestrationMetadata: Record<string, unknown>;
  base: HubNormalizedRouteShape;
  extracted: {
    policyOverride?: HubPolicyConfig;
    shadowCompare?: HubShadowCompareRequestConfig;
    disableSnapshots: boolean;
    hubEntryMode?: NormalizedRequest["hubEntryMode"];
    externalStageRecorder?: StageRecorder;
  };
}): NormalizedRequest {
  const routeShape = resolveNormalizedRouteShape({
    orchestrationMetadata: args.orchestrationMetadata,
    base: args.base,
  });
  const normalizedMetadata = buildNormalizedMetadataRecord({
    metadataRecord: args.metadataRecord,
    orchestrationMetadata: args.orchestrationMetadata,
    routeShape,
  });

  return buildNormalizedRequestResult({
    id: args.id,
    endpoint: args.endpoint,
    routeShape,
    payload: args.payload,
    metadata: normalizedMetadata,
    policyOverride: args.extracted.policyOverride,
    shadowCompare: args.extracted.shadowCompare,
    disableSnapshots: args.extracted.disableSnapshots,
    hubEntryMode: args.extracted.hubEntryMode,
    externalStageRecorder: args.extracted.externalStageRecorder,
  });
}

function extractRequestMetadataOptions(metadataRecord: Record<string, unknown>): {
  policyOverride?: HubPolicyConfig;
  shadowCompare?: HubShadowCompareRequestConfig;
  disableSnapshots: boolean;
  hubEntryMode?: NormalizedRequest["hubEntryMode"];
  externalStageRecorder?: StageRecorder;
} {
  const policyOverride = resolveHubPolicyOverrideFromMetadataWithNative(
    metadataRecord,
  ) as HubPolicyConfig | undefined;
  delete metadataRecord.__hubPolicyOverride;

  const shadowCompare = resolveHubShadowCompareConfigWithNative(
    metadataRecord,
  ) as HubShadowCompareRequestConfig | undefined;
  delete metadataRecord.__hubShadowCompare;

  const disableSnapshots = metadataRecord.__disableHubSnapshots === true;
  delete metadataRecord.__disableHubSnapshots;

  const hubEntryRaw =
    typeof metadataRecord.__hubEntry === "string"
      ? String(metadataRecord.__hubEntry).trim().toLowerCase()
      : "";
  const hubEntryMode: NormalizedRequest["hubEntryMode"] =
    hubEntryRaw === "chat_process" ||
    hubEntryRaw === "chat-process" ||
    hubEntryRaw === "chatprocess"
      ? "chat_process"
      : undefined;
  delete metadataRecord.__hubEntry;

  const externalStageRecorder =
    metadataRecord.__hubStageRecorder &&
    typeof (metadataRecord.__hubStageRecorder as StageRecorder).record === "function"
      ? (metadataRecord.__hubStageRecorder as StageRecorder)
      : undefined;
  delete metadataRecord.__hubStageRecorder;

  return {
    policyOverride: policyOverride ?? undefined,
    shadowCompare: shadowCompare ?? undefined,
    disableSnapshots,
    ...(hubEntryMode ? { hubEntryMode } : {}),
    ...(externalStageRecorder ? { externalStageRecorder } : {}),
  };
}



async function convertSsePayloadToJson(
  stream: Readable,
  context: {
    requestId: string;
    providerProtocol: HubPipelineProviderProtocol;
    metadata: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  const protocol = resolveSseProtocolWithNative(
    context.metadata,
    context.providerProtocol,
  ) as SseProtocol;
  const codec = defaultSseCodecRegistry.get(protocol);
  const result = await codec.convertSseToJson(stream, {
    requestId: context.requestId,
    model: extractModelHintFromMetadataWithNative(context.metadata),
    direction: "request",
  });
  if (!result || typeof result !== "object") {
    throw new Error("SSE conversion returned empty payload");
  }
  return result as Record<string, unknown>;
}





export async function normalizeHubPipelineRequest(
  request: HubPipelineRequest,
): Promise<NormalizedRequest> {
  if (!request || typeof request !== "object") {
    throw new Error("HubPipeline requires request payload");
  }
  const id = request.id || `req_${Date.now()}`;
  const endpoint = normalizeHubEndpointWithNative(request.endpoint);
  const metadataRecord: Record<string, unknown> = {
    ...(request.metadata ?? {}),
  };
  const extracted = extractRequestMetadataOptions(metadataRecord);
  const base = buildPreOrchestrationRequestShape({
    request,
    endpoint,
    metadataRecord,
  });
  const streamCandidate = (() => {
    const raw = request.payload;
    if (!raw) return null;
    if (raw instanceof Readable) return raw;
    if (raw && typeof raw === "object" && "readable" in raw) {
      const candidate = (raw as Record<string, unknown>).readable;
      if (candidate instanceof Readable) return candidate;
    }
    return null;
  })();
  const stream = Boolean(base.stream || streamCandidate);

  let payload: Record<string, unknown>;
  if (streamCandidate) {
    payload = await convertSsePayloadToJson(streamCandidate, {
      requestId: id,
      providerProtocol: base.providerProtocol,
      metadata: metadataRecord,
    });
  } else {
    if (!request.payload || typeof request.payload !== "object") {
      throw new Error("HubPipeline requires JSON object payload");
    }
    payload = request.payload as Record<string, unknown>;
  }

  const orchestrationResult = runHubPipelineOrchestrationWithNative({
    requestId: id,
    endpoint,
    entryEndpoint: base.entryEndpoint,
    providerProtocol: base.providerProtocol,
    payload,
    metadata: {
      ...metadataRecord,
      entryEndpoint: base.entryEndpoint,
      providerProtocol: base.providerProtocol,
      processMode: base.processMode,
      direction: base.direction,
      stage: base.stage,
      stream,
      ...(base.routeHint ? { routeHint: base.routeHint } : {}),
    },
    stream,
    processMode: base.processMode,
    direction: base.direction,
    stage: base.stage,
  });
  payload = orchestrationResult.payload;
  return finalizeNormalizedRequest({
    id,
    endpoint,
    payload,
    metadataRecord,
    orchestrationMetadata: orchestrationResult.metadata && typeof orchestrationResult.metadata === "object" && !Array.isArray(orchestrationResult.metadata)
      ? (orchestrationResult.metadata as Record<string, unknown>)
      : {},
    base: {
      ...base,
      stream,
    },
    extracted,
  });
}
