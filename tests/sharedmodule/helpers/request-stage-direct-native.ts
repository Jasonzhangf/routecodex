import {
  buildRequestStageMetadataDispatchWithNative,
  buildRequestStageHubPipelineResultWithNative,
  buildRequestStageNativeResultPlanWithNative,
  buildRequestStageRuntimeControlWritePlanWithNative,
  runHubPipelineLibWithNative,
} from '../../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol.js';
import {
  applyNativeRuntimeControlWritePlan,
  readContinuationContextFromBoundMetadataCenter,
  readRequestTruthFromBoundMetadataCenter,
  readRuntimeControlFromBoundMetadataCenter,
} from '../../../sharedmodule/llmswitch-core/src/conversion/hub/metadata-center-runtime-control-writer.js';

const REQUEST_STAGE_RUNTIME_CONTROL_WRITER = {
  module: 'tests/sharedmodule/helpers/request-stage-direct-native.ts',
  symbol: 'executeRequestStagePipelineDirectNative',
  stage: 'HubReqChatProcess03Governed',
} as const;

// feature_id: hub.request_stage_pipeline_bridge
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
    reason: 'rust request chatprocess runtime control',
  });
}

export async function executeRequestStagePipelineDirectNative(args: any): Promise<any> {
  const normalized = args.normalized;
  const config = args.config;
  const entryMode = args.entryMode ?? 'request_stage';
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
      runtimeRouterRequired: args.runtimeRouterRequired ?? true,
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
  const resultPlan = buildRequestStageNativeResultPlanWithNative({
    nativePlan,
    entryMode,
  });
  if (!resultPlan.ok) {
    const error = new Error(resultPlan.error?.message ?? 'Rust HubPipeline request path failed') as Error & {
      code?: string;
      status?: number;
      statusCode?: number;
      details?: unknown;
    };
    error.code = resultPlan.error?.code;
    error.details = resultPlan.error?.details;
    error.status = resultPlan.error?.status;
    error.statusCode = resultPlan.error?.statusCode;
    throw error;
  }
  const outputMetadata = resultPlan.metadata ?? {};
  syncRequestStageRuntimeControlToMetadataCenter({
    sourceMetadata: normalized.metadata,
    outputMetadata,
  });
  return buildRequestStageHubPipelineResultWithNative({
    requestId: normalized.id,
    resultPlan,
    entryMode,
  });
}
