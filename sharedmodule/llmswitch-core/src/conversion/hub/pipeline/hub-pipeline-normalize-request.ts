import {
  normalizeHubEndpointWithNative,
  runHubPipelineOrchestrationWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import {
  resolveReadablePayload,
  materializePayloadRecord,
} from "./hub-pipeline-request-normalization-utils.js";
import type {
  HubPipelineRequest,
  NormalizedRequest,
} from "./hub-pipeline.js";
import { extractRequestMetadataOptions } from "./hub-pipeline-normalize-request-metadata-blocks.js";
import {
  buildPreOrchestrationRequestShape,
  finalizeNormalizedRequest,
} from "./hub-pipeline-normalize-request-finalize-blocks.js";

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
  const resolvedReadable = resolveReadablePayload(request.payload);
  const stream = Boolean(
    base.stream || resolvedReadable,
  );

  let payload = await materializePayloadRecord(
    request.payload,
    {
      requestId: id,
      entryEndpoint: base.entryEndpoint,
      providerProtocol: base.providerProtocol,
      metadata: metadataRecord,
    },
    resolvedReadable,
  );

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
  if (!orchestrationResult.success) {
    const code =
      orchestrationResult.error && typeof orchestrationResult.error.code === "string"
        ? orchestrationResult.error.code.trim()
        : "hub_pipeline_native_failed";
    const message =
      orchestrationResult.error &&
      typeof orchestrationResult.error.message === "string"
        ? orchestrationResult.error.message.trim()
        : "Native hub pipeline orchestration failed";
    throw new Error(`[${code}] ${message}`);
  }
  if (orchestrationResult.payload) {
    payload = orchestrationResult.payload;
  }

  const orchestrationMetadata =
    orchestrationResult.metadata &&
    typeof orchestrationResult.metadata === "object" &&
    !Array.isArray(orchestrationResult.metadata)
      ? (orchestrationResult.metadata as Record<string, unknown>)
      : {};
  return finalizeNormalizedRequest({
    id,
    endpoint,
    payload,
    metadataRecord,
    orchestrationMetadata,
    base: {
      ...base,
      stream,
    },
    extracted,
  });
}
