import type { VirtualRouterRuntime } from "../../../native/router-hotpath/native-virtual-router-runtime.js";
import type {
  HubPipelineConfig,
  HubPipelineNodeResult,
  HubPipelineResult,
  NormalizedRequest,
} from "./hub-pipeline.js";
import {
  buildRequestStageMetadataDispatchWithNative,
  buildRequestStageRuntimeControlWritePlanWithNative,
  runHubPipelineLibWithNative
} from '../../../native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol.js';
import { attachHubStageTopSummary } from "./hub-stage-timing.js";
import { applyNativeRuntimeControlWritePlan, readRuntimeControlFromBoundMetadataCenter, readRequestTruthFromBoundMetadataCenter, readContinuationContextFromBoundMetadataCenter } from "../metadata-center-runtime-control-writer.js";




const REQUEST_STAGE_RUNTIME_CONTROL_WRITER = {
  module: 'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts',
  symbol: 'syncRequestStageRuntimeControlToMetadataCenter',
  stage: 'HubReqChatProcess03Governed',
} as const;

function syncRequestStageRuntimeControlToMetadataCenter(args: {
  sourceMetadata: Record<string, unknown>;
  outputMetadata: Record<string, unknown>;
}): void {
  const writePlan = buildRequestStageRuntimeControlWritePlanWithNative({
    outputMetadata: args.outputMetadata,
  });
  if (!writePlan.runtimeControl) {
    return;
  }
  applyNativeRuntimeControlWritePlan({
    metadata: args.sourceMetadata,
    runtimeControl: writePlan.runtimeControl,
    writer: REQUEST_STAGE_RUNTIME_CONTROL_WRITER,
    reason: 'rust request chatprocess runtime control'
  });
}

// feature_id: hub.request_stage_pipeline_bridge
export async function executeRequestStagePipeline<TContext = Record<string, unknown>>(args: {
  normalized: NormalizedRequest;
  routerEngine: VirtualRouterRuntime;
  config: HubPipelineConfig;
  entryMode?: "request_stage" | "chat_process";
}): Promise<HubPipelineResult> {
  const { normalized, config } = args;
  const entryMode = args.entryMode ?? "request_stage";
  const requestTruthPayload = readRequestTruthFromBoundMetadataCenter(normalized.metadata);
  const continuationContextPayload = readContinuationContextFromBoundMetadataCenter(normalized.metadata);
  const metadataCenterRuntimeControl = readRuntimeControlFromBoundMetadataCenter(normalized.metadata);
  const metadataDispatch = buildRequestStageMetadataDispatchWithNative({
    sourceMetadata: normalized.metadata,
    requestTruth: requestTruthPayload,
    continuationContext: continuationContextPayload,
    runtimeControl: metadataCenterRuntimeControl,
    providerProtocol: normalized.providerProtocol,
    excludedProviderKeys: normalized.metadata.excludedProviderKeys,
  });

  const nativePlan = runHubPipelineLibWithNative({
    config: {
      virtualRouter: config.virtualRouter as unknown as Record<string, unknown>,
      ...(config.policy ? { policy: config.policy as unknown as Record<string, unknown> } : {}),
      ...(config.toolSurface ? { toolSurface: config.toolSurface as unknown as Record<string, unknown> } : {}),
    },
    request: {
      requestId: normalized.id,
      endpoint: normalized.endpoint,
      entryEndpoint: normalized.entryEndpoint,
      providerProtocol: normalized.providerProtocol,
      payload: normalized.payload,
      metadata: metadataDispatch.metadata,
      ...(metadataDispatch.metadataCenterSnapshot ? { metadataCenterSnapshot: metadataDispatch.metadataCenterSnapshot } : {}),
      stream: normalized.stream,
      processMode: normalized.processMode,
      direction: normalized.direction,
      stage: normalized.stage,
    },
  });
  if (nativePlan.success !== true) {
    const errorMessage = entryMode === "chat_process"
      ? "Rust HubPipeline chat_process path failed"
      : "Rust HubPipeline request path failed";
    const error = new Error(nativePlan.error?.message ?? errorMessage) as Error & {
      code?: string;
      status?: number;
      statusCode?: number;
      details?: unknown;
    };
    error.code = nativePlan.error?.code;
    error.details = nativePlan.error?.details;
    if (nativePlan.error?.code === 'MALFORMED_REQUEST') {
      error.status = 400;
      error.statusCode = 400;
    }
    throw error;
  }
  const outputMetadata = nativePlan.metadata ?? {};
  syncRequestStageRuntimeControlToMetadataCenter({
    sourceMetadata: normalized.metadata,
    outputMetadata,
  });
  const providerPayload = nativePlan.payload;
  if (!providerPayload || typeof providerPayload !== 'object' || Array.isArray(providerPayload)) {
    const errorMessage = entryMode === "chat_process"
      ? "Rust HubPipeline chat_process path returned invalid provider payload"
      : "Rust HubPipeline request path returned invalid provider payload";
    throw new Error(errorMessage);
  }

  attachHubStageTopSummary({
    requestId: normalized.id,
    metadata: outputMetadata,
  });

  const result: HubPipelineResult = {
    requestId: normalized.id,
    providerPayload,
    target: outputMetadata.target as HubPipelineResult['target'],
    routingDecision: outputMetadata.routingDecision as HubPipelineResult['routingDecision'],
    routingDiagnostics: outputMetadata.routingDiagnostics as HubPipelineResult['routingDiagnostics'],
    metadata: outputMetadata,
    nodeResults: nativePlan.diagnostics as unknown as HubPipelineNodeResult[],
  };
  if (entryMode !== "chat_process") {
    result.standardizedRequest = nativePlan.standardizedRequest as unknown as HubPipelineResult['standardizedRequest'];
  }
  return result;
}
