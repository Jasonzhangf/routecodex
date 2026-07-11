import {
  buildRequestStageMetadataDispatchWithNative,
  buildRequestStageHubPipelineResultWithNative,
  buildRequestStageNativeResultPlanWithNative,
  buildRequestStageRuntimeControlWritePlanWithNative,
  runHubPipelineLibWithNative,
} from './hub-pipeline-orchestration-direct-native.js';

const REQUEST_STAGE_RUNTIME_CONTROL_WRITER = {
  module: 'tests/sharedmodule/helpers/request-stage-direct-native.ts',
  symbol: 'executeRequestStagePipelineDirectNative',
  stage: 'request_chatprocess_runtime_control',
} as const;
const METADATA_CENTER_SYMBOL = Symbol.for('routecodex.metadataCenter');
const RUST_SNAPSHOT_SYMBOL = Symbol.for('routecodex.metadataCenter.rustSnapshot');

type RuntimeControlWriter = typeof REQUEST_STAGE_RUNTIME_CONTROL_WRITER;
type MetadataCenterLike = {
  writeRuntimeControl?: (
    key: string,
    value: unknown,
    writtenBy: RuntimeControlWriter,
    reason?: string
  ) => void;
  readRuntimeControl?: () => Record<string, unknown>;
  readRequestTruth?: () => Record<string, unknown>;
  readContinuationContext?: () => Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readBoundMetadataCenterTarget(target: Record<string, unknown>): {
  target: Record<string, unknown>;
  center: MetadataCenterLike;
} | undefined {
  const direct = Reflect.get(target, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
  if (direct && typeof direct.writeRuntimeControl === 'function') {
    return { target, center: direct };
  }
  const nested = asRecord(target.metadata);
  if (!nested) {
    return undefined;
  }
  const nestedCenter = Reflect.get(nested, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
  return nestedCenter && typeof nestedCenter.writeRuntimeControl === 'function'
    ? { target: nested, center: nestedCenter }
    : undefined;
}

function readBoundMetadataCenter(target: Record<string, unknown>): MetadataCenterLike | undefined {
  return readBoundMetadataCenterTarget(target)?.center;
}

function readRuntimeControlFromBoundMetadataCenter(target: Record<string, unknown>): Record<string, unknown> {
  const runtimeControl = readBoundMetadataCenter(target)?.readRuntimeControl?.();
  return asRecord(runtimeControl) ? { ...runtimeControl } : {};
}

function readRequestTruthFromBoundMetadataCenter(target: Record<string, unknown>): Record<string, unknown> {
  const requestTruth = readBoundMetadataCenter(target)?.readRequestTruth?.();
  return asRecord(requestTruth) ? { ...requestTruth } : {};
}

function readContinuationContextFromBoundMetadataCenter(target: Record<string, unknown>): Record<string, unknown> {
  const continuationContext = readBoundMetadataCenter(target)?.readContinuationContext?.();
  return asRecord(continuationContext) ? { ...continuationContext } : {};
}

function applyNativeRuntimeControlWritePlan(args: {
  metadata: unknown;
  runtimeControl: Record<string, unknown>;
  writer: RuntimeControlWriter;
  reason: string;
}): void {
  const metadata = asRecord(args.metadata);
  const bound = metadata ? readBoundMetadataCenterTarget(metadata) : undefined;
  if (!bound) {
    throw new Error('MetadataCenter runtime_control write failed: bound MetadataCenter missing');
  }
  for (const [key, value] of Object.entries(args.runtimeControl)) {
    if (value === undefined) {
      continue;
    }
    bound.center.writeRuntimeControl?.(key, value, args.writer, args.reason);
    const currentSnapshot = asRecord(Reflect.get(bound.target, RUST_SNAPSHOT_SYMBOL));
    const nextSnapshot = currentSnapshot ? { ...currentSnapshot } : {};
    const runtimeControl = asRecord(nextSnapshot.runtimeControl) ?? {};
    runtimeControl[key] = structuredClone(value);
    nextSnapshot.runtimeControl = runtimeControl;
    Reflect.set(bound.target, RUST_SNAPSHOT_SYMBOL, nextSnapshot);
  }
}

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
