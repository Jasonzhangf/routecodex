import {
  normalizeHubEndpointWithNative,
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
  buildNativeOrchestrationMetadataInput,
  finalizeNormalizedRequest,
} from "./hub-pipeline-normalize-request-finalize-blocks.js";
import { runNormalizedRequestOrchestration } from "./hub-pipeline-normalize-request-orchestration-blocks.js";

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

  const orchestration = runNormalizedRequestOrchestration({
    requestId: id,
    endpoint,
    entryEndpoint: base.entryEndpoint,
    providerProtocol: base.providerProtocol,
    payload,
    metadata: buildNativeOrchestrationMetadataInput({
      metadataRecord,
      entryEndpoint: base.entryEndpoint,
      providerProtocol: base.providerProtocol,
      processMode: base.processMode,
      direction: base.direction,
      stage: base.stage,
      stream,
      routeHint: base.routeHint,
    }),
    stream,
    processMode: base.processMode,
    direction: base.direction,
    stage: base.stage,
  });
  payload = orchestration.payload;
  return finalizeNormalizedRequest({
    id,
    endpoint,
    payload,
    metadataRecord,
    orchestrationMetadata: orchestration.orchestrationMetadata,
    base: {
      ...base,
      stream,
    },
    extracted,
  });
}
