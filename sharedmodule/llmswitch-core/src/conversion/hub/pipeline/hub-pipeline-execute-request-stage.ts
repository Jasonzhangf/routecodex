import type { VirtualRouterRuntime } from "../../../native/router-hotpath/native-virtual-router-runtime.js";
import type {
  HubPipelineConfig,
  HubPipelineNodeResult,
  HubPipelineResult,
  NormalizedRequest,
} from "./hub-pipeline.js";
import { runHubPipelineLibWithNative } from '../../../native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol.js';
import { attachHubStageTopSummary } from "./hub-stage-timing.js";

const METADATA_CENTER_SYMBOL = Symbol.for('routecodex.metadataCenter');

type MetadataCenterLike = {
  readRequestTruth: () => Record<string, unknown> | undefined;
  readContinuationContext: () => Record<string, unknown> | undefined;
  readRuntimeControl: () => Record<string, unknown> | undefined;
  writeRuntimeControl?: (
    key: string,
    value: unknown,
    writtenBy: { module: string; symbol: string; stage: string },
    reason?: string
  ) => void;
};

function isMetadataCenterLike(value: unknown): value is MetadataCenterLike {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { readRequestTruth?: unknown }).readRequestTruth === 'function'
    && typeof (value as { readContinuationContext?: unknown }).readContinuationContext === 'function'
    && typeof (value as { readRuntimeControl?: unknown }).readRuntimeControl === 'function'
  );
}

function readRuntimeControlPayload(metadata: Record<string, unknown>): Record<string, unknown> {
  return metadata.runtime_control && typeof metadata.runtime_control === 'object' && !Array.isArray(metadata.runtime_control)
    ? { ...(metadata.runtime_control as Record<string, unknown>) }
    : {};
}

function readRuntimeControlFromMetadataCenter(metadata: Record<string, unknown>): Record<string, unknown> {
  const symbolCenterCandidate = Reflect.get(metadata, METADATA_CENTER_SYMBOL);
  if (isMetadataCenterLike(symbolCenterCandidate)) {
    const runtimeControl = symbolCenterCandidate.readRuntimeControl();
    if (runtimeControl && typeof runtimeControl === 'object' && !Array.isArray(runtimeControl)) {
      return { ...runtimeControl };
    }
  }
  return {};
}

function readRequestTruthFromMetadataCenter(metadata: Record<string, unknown>): Record<string, unknown> {
  const symbolCenterCandidate = Reflect.get(metadata, METADATA_CENTER_SYMBOL);
  if (isMetadataCenterLike(symbolCenterCandidate)) {
    const requestTruth = symbolCenterCandidate.readRequestTruth();
    if (requestTruth && typeof requestTruth === 'object' && !Array.isArray(requestTruth)) {
      return { ...requestTruth };
    }
  }
  return {};
}

function readContinuationContextFromMetadataCenter(metadata: Record<string, unknown>): Record<string, unknown> {
  const symbolCenterCandidate = Reflect.get(metadata, METADATA_CENTER_SYMBOL);
  if (isMetadataCenterLike(symbolCenterCandidate)) {
    const continuationContext = symbolCenterCandidate.readContinuationContext();
    if (continuationContext && typeof continuationContext === 'object' && !Array.isArray(continuationContext)) {
      return { ...continuationContext };
    }
  }
  return {};
}

function projectNativeTopLevelRuntimeControl(runtimeControl: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (runtimeControl.stopless && typeof runtimeControl.stopless === 'object' && !Array.isArray(runtimeControl.stopless)) {
    out.stopless = runtimeControl.stopless;
  }
  return out;
}

function stripLegacyMetadataResidue(metadata: Record<string, unknown>): Record<string, unknown> {
  const omittedKeys = new Set([
    `__${'rt'}`,
    `__${'metadataCenter'}`,
  ]);
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !omittedKeys.has(key)),
  );
}

const REQUEST_STAGE_STOPLESS_RUNTIME_WRITER = {
  module: 'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts',
  symbol: 'syncRequestStageStoplessRuntimeControlToMetadataCenter',
  stage: 'HubReqChatProcess03Governed',
} as const;

function asFlatRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readBoundMetadataCenter(metadata: Record<string, unknown>): MetadataCenterLike | undefined {
  const candidate = Reflect.get(metadata, METADATA_CENTER_SYMBOL);
  return isMetadataCenterLike(candidate) ? candidate : undefined;
}

function syncRequestStageStoplessRuntimeControlToMetadataCenter(args: {
  sourceMetadata: Record<string, unknown>;
  outputMetadata: Record<string, unknown>;
}): void {
  const runtimeControl = asFlatRecord(args.outputMetadata.runtime_control);
  const stopless = asFlatRecord(runtimeControl?.stopless);
  if (!stopless) {
    return;
  }
  const center = readBoundMetadataCenter(args.sourceMetadata);
  if (!center || typeof center.writeRuntimeControl !== 'function') {
    throw new Error('Rust request ChatProcess returned stopless runtime_control but MetadataCenter is not bound');
  }
  center.writeRuntimeControl(
    'stopless',
    stopless,
    REQUEST_STAGE_STOPLESS_RUNTIME_WRITER,
    'rust request chatprocess stopless runtime control'
  );
}

function buildMetadataCenterSnapshot(args: {
  requestTruth: Record<string, unknown>;
  continuationContext: Record<string, unknown>;
  runtimeControl: Record<string, unknown>;
  providerProtocol: string;
}): {
  requestTruth?: Record<string, unknown>;
  continuationContext?: Record<string, unknown>;
  runtimeControl?: Record<string, unknown>;
} | undefined {
  const requestTruth = Object.keys(args.requestTruth).length > 0 ? { ...args.requestTruth } : undefined;
  const continuationContext = Object.keys(args.continuationContext).length > 0
    ? { ...args.continuationContext }
    : undefined;
  const runtimeControl = Object.keys(args.runtimeControl).length > 0 ? { ...args.runtimeControl } : undefined;
  const providerProtocol = typeof args.providerProtocol === 'string' && args.providerProtocol.trim()
    ? args.providerProtocol.trim()
    : undefined;
  const runtimeControlSnapshot = runtimeControl || providerProtocol
    ? {
        ...(runtimeControl ?? {}),
        ...(providerProtocol ? { providerProtocol } : {}),
      }
    : undefined;
  if (!requestTruth && !continuationContext && !runtimeControlSnapshot) {
    return undefined;
  }
  return {
    ...(requestTruth ? { requestTruth } : {}),
    ...(continuationContext ? { continuationContext } : {}),
    ...(runtimeControlSnapshot ? { runtimeControl: runtimeControlSnapshot } : {}),
  };
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
  const runtimeControlPayload = readRuntimeControlPayload(normalized.metadata);
  const requestTruthPayload = readRequestTruthFromMetadataCenter(normalized.metadata);
  const continuationContextPayload = readContinuationContextFromMetadataCenter(normalized.metadata);
  const metadataCenterRuntimeControl = readRuntimeControlFromMetadataCenter(normalized.metadata);
  const nativeTopLevelRuntimeControl = projectNativeTopLevelRuntimeControl({
    ...runtimeControlPayload,
    ...metadataCenterRuntimeControl,
  });
  const mergedRuntimeControl = {
    ...runtimeControlPayload,
    ...metadataCenterRuntimeControl,
  };
  const metadataBase = stripLegacyMetadataResidue(normalized.metadata);
  const metadataCenterSnapshot = buildMetadataCenterSnapshot({
    requestTruth: requestTruthPayload,
    continuationContext: continuationContextPayload,
    runtimeControl: metadataCenterRuntimeControl,
    providerProtocol: normalized.providerProtocol,
  });
  const metadata = {
    ...metadataBase,
    runtime_control: {
      ...mergedRuntimeControl,
    },
    ...nativeTopLevelRuntimeControl,
  } as Record<string, unknown>;

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
      metadata,
      ...(metadataCenterSnapshot ? { metadataCenterSnapshot } : {}),
      stream: normalized.stream,
      processMode: normalized.processMode,
      direction: normalized.direction,
      stage: normalized.stage,
    },
  });
  if (nativePlan.success !== true) {
    const fallbackMessage = entryMode === "chat_process"
      ? "Rust HubPipeline chat_process path failed"
      : "Rust HubPipeline request path failed";
    const error = new Error(nativePlan.error?.message ?? fallbackMessage) as Error & {
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
  syncRequestStageStoplessRuntimeControlToMetadataCenter({
    sourceMetadata: normalized.metadata,
    outputMetadata,
  });
  const providerPayload = nativePlan.payload;
  if (!providerPayload || typeof providerPayload !== 'object' || Array.isArray(providerPayload)) {
    const fallbackMessage = entryMode === "chat_process"
      ? "Rust HubPipeline chat_process path returned invalid provider payload"
      : "Rust HubPipeline request path returned invalid provider payload";
    throw new Error(fallbackMessage);
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
    result.entryOriginRequest = nativePlan.entryOriginRequest as HubPipelineResult['entryOriginRequest'];
  }
  return result;
}
