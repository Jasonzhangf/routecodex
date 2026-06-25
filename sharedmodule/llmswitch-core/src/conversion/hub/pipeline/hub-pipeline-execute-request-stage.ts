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

function readRuntimeMetadataControl(metadata: Record<string, unknown>): Record<string, unknown> {
  return metadata.__rt && typeof metadata.__rt === 'object' && !Array.isArray(metadata.__rt)
    ? { ...(metadata.__rt as Record<string, unknown>) }
    : {};
}

function readRuntimeControlPayload(metadata: Record<string, unknown>): Record<string, unknown> {
  return metadata.runtime_control && typeof metadata.runtime_control === 'object' && !Array.isArray(metadata.runtime_control)
    ? { ...(metadata.runtime_control as Record<string, unknown>) }
    : {};
}

function projectLegacyRuntimeControlWhitelist(runtimeControl: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (runtimeControl.serverToolFollowup !== undefined) {
    out.serverToolFollowup = runtimeControl.serverToolFollowup;
  }
  if (typeof runtimeControl.serverToolFollowupSource === 'string' && runtimeControl.serverToolFollowupSource.trim()) {
    out.serverToolFollowupSource = runtimeControl.serverToolFollowupSource.trim();
  }
  if (runtimeControl.stopless && typeof runtimeControl.stopless === 'object' && !Array.isArray(runtimeControl.stopless)) {
    out.stopless = runtimeControl.stopless;
  }
  if (typeof runtimeControl.stopMessageEnabled === 'boolean') {
    out.stopMessageEnabled = runtimeControl.stopMessageEnabled;
  }
  if (typeof runtimeControl.stopMessageExcludeDirect === 'boolean') {
    out.stopMessageExcludeDirect = runtimeControl.stopMessageExcludeDirect;
  }
  return out;
}

function readRuntimeControlFromMetadataCenter(metadata: Record<string, unknown>): Record<string, unknown> {
  const symbolCenterCandidate = Reflect.get(metadata, METADATA_CENTER_SYMBOL);
  if (isMetadataCenterLike(symbolCenterCandidate)) {
    const runtimeControl = symbolCenterCandidate.readRuntimeControl();
    if (runtimeControl && typeof runtimeControl === 'object' && !Array.isArray(runtimeControl)) {
      return { ...runtimeControl };
    }
  }
  const center = metadata.__metadataCenter && typeof metadata.__metadataCenter === 'object' && !Array.isArray(metadata.__metadataCenter)
    ? metadata.__metadataCenter as Record<string, unknown>
    : undefined;
  const runtimeControl = center?.runtimeControl && typeof center.runtimeControl === 'object' && !Array.isArray(center.runtimeControl)
    ? center.runtimeControl as Record<string, unknown>
    : undefined;
  if (!runtimeControl) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [key, slot] of Object.entries(runtimeControl)) {
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) {
      continue;
    }
    const value = (slot as Record<string, unknown>).value;
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function readRequestTruthFromMetadataCenter(metadata: Record<string, unknown>): Record<string, unknown> {
  const symbolCenterCandidate = Reflect.get(metadata, METADATA_CENTER_SYMBOL);
  if (isMetadataCenterLike(symbolCenterCandidate)) {
    const requestTruth = symbolCenterCandidate.readRequestTruth();
    if (requestTruth && typeof requestTruth === 'object' && !Array.isArray(requestTruth)) {
      return { ...requestTruth };
    }
  }
  const center = metadata.__metadataCenter && typeof metadata.__metadataCenter === 'object' && !Array.isArray(metadata.__metadataCenter)
    ? metadata.__metadataCenter as Record<string, unknown>
    : undefined;
  const requestTruth = center?.requestTruth && typeof center.requestTruth === 'object' && !Array.isArray(center.requestTruth)
    ? center.requestTruth as Record<string, unknown>
    : undefined;
  if (!requestTruth) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [key, slot] of Object.entries(requestTruth)) {
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) {
      continue;
    }
    const value = (slot as Record<string, unknown>).value;
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function readContinuationContextFromMetadataCenter(metadata: Record<string, unknown>): Record<string, unknown> {
  const symbolCenterCandidate = Reflect.get(metadata, METADATA_CENTER_SYMBOL);
  if (isMetadataCenterLike(symbolCenterCandidate)) {
    const continuationContext = symbolCenterCandidate.readContinuationContext();
    if (continuationContext && typeof continuationContext === 'object' && !Array.isArray(continuationContext)) {
      return { ...continuationContext };
    }
  }
  const center = metadata.__metadataCenter && typeof metadata.__metadataCenter === 'object' && !Array.isArray(metadata.__metadataCenter)
    ? metadata.__metadataCenter as Record<string, unknown>
    : undefined;
  const continuationContext = center?.continuationContext && typeof center.continuationContext === 'object' && !Array.isArray(center.continuationContext)
    ? center.continuationContext as Record<string, unknown>
    : undefined;
  if (!continuationContext) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [key, slot] of Object.entries(continuationContext)) {
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) {
      continue;
    }
    const value = (slot as Record<string, unknown>).value;
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function projectNativeTopLevelRuntimeControl(runtimeControl: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof runtimeControl.stopMessageEnabled === 'boolean') {
    out.stopMessageEnabled = runtimeControl.stopMessageEnabled;
    out.routecodexPortStopMessageEnabled = runtimeControl.stopMessageEnabled;
  }
  if (typeof runtimeControl.stopMessageExcludeDirect === 'boolean') {
    out.stopMessageExcludeDirect = runtimeControl.stopMessageExcludeDirect;
  }
  if (runtimeControl.stopless && typeof runtimeControl.stopless === 'object' && !Array.isArray(runtimeControl.stopless)) {
    out.stopless = runtimeControl.stopless;
  }
  return out;
}

function projectRouterInputMetadata(args: {
  metadata: Record<string, unknown>;
  requestTruth: Record<string, unknown>;
  runtimeControl: Record<string, unknown>;
  continuationContext: Record<string, unknown>;
}): Record<string, unknown> {
  const metadata = { ...args.metadata };
  const requestTruth = args.requestTruth;
  const runtimeControl = args.runtimeControl;
  const continuationContext = args.continuationContext;
  const routeHint = typeof runtimeControl.routeHint === 'string' && runtimeControl.routeHint.trim()
    ? runtimeControl.routeHint.trim()
    : typeof continuationContext.responsesResume === 'object'
      && continuationContext.responsesResume !== null
      && !Array.isArray(continuationContext.responsesResume)
      && typeof (continuationContext.responsesResume as Record<string, unknown>).routeHint === 'string'
      && String((continuationContext.responsesResume as Record<string, unknown>).routeHint).trim()
        ? String((continuationContext.responsesResume as Record<string, unknown>).routeHint).trim()
        : undefined;
  if (routeHint) {
    metadata.routeHint = routeHint;
  }
  const responsesResume =
    continuationContext.responsesResume
    && typeof continuationContext.responsesResume === 'object'
    && !Array.isArray(continuationContext.responsesResume)
      ? { ...(continuationContext.responsesResume as Record<string, unknown>) }
      : undefined;
  if (responsesResume) {
    metadata.responsesResume = responsesResume;
  }
  const resumeContinuationOwner =
    typeof responsesResume?.continuationOwner === 'string'
      ? responsesResume.continuationOwner.trim()
      : undefined;
  const retryProviderKey = typeof runtimeControl.retryProviderKey === 'string' && runtimeControl.retryProviderKey.trim()
    ? runtimeControl.retryProviderKey.trim()
    : resumeContinuationOwner !== 'relay'
      && responsesResume
      && typeof responsesResume.providerKey === 'string'
      && responsesResume.providerKey.trim()
      ? responsesResume.providerKey.trim()
      : undefined;
  if (retryProviderKey) {
    metadata.retryProviderKey = retryProviderKey;
  }
  return metadata;
}

function buildMetadataCenterSnapshot(args: {
  requestTruth: Record<string, unknown>;
  continuationContext: Record<string, unknown>;
  runtimeControl: Record<string, unknown>;
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
  if (!requestTruth && !continuationContext && !runtimeControl) {
    return undefined;
  }
  return {
    ...(requestTruth ? { requestTruth } : {}),
    ...(continuationContext ? { continuationContext } : {}),
    ...(runtimeControl ? { runtimeControl } : {}),
  };
}

// feature_id: hub.request_stage_pipeline_bridge
export async function executeRequestStagePipeline<TContext = Record<string, unknown>>(args: {
  normalized: NormalizedRequest;
  routerEngine: VirtualRouterRuntime;
  config: HubPipelineConfig;
  entryMode?: "request_stage" | "chat_process";
}): Promise<HubPipelineResult> {
  const { normalized, config, routerEngine } = args;
  const entryMode = args.entryMode ?? "request_stage";
  const legacyRuntimeProjection = readRuntimeMetadataControl(normalized.metadata);
  const runtimeControlPayload = readRuntimeControlPayload(normalized.metadata);
  const requestTruthPayload = readRequestTruthFromMetadataCenter(normalized.metadata);
  const continuationContextPayload = readContinuationContextFromMetadataCenter(normalized.metadata);
  const metadataCenterRuntimeControl = readRuntimeControlFromMetadataCenter(normalized.metadata);
  const nativeTopLevelRuntimeControl = projectNativeTopLevelRuntimeControl({
    ...legacyRuntimeProjection,
    ...runtimeControlPayload,
    ...metadataCenterRuntimeControl,
  });
  const mergedRuntimeControl = {
    ...runtimeControlPayload,
    ...metadataCenterRuntimeControl,
  };
  const legacyRuntimeProjectionWhitelist =
    projectLegacyRuntimeControlWhitelist(legacyRuntimeProjection);
  const metadataBase = {
    ...normalized.metadata,
    ...(typeof requestTruthPayload.sessionId === 'string' && requestTruthPayload.sessionId.trim()
      ? { sessionId: requestTruthPayload.sessionId.trim() }
      : {}),
    ...(typeof requestTruthPayload.conversationId === 'string' && requestTruthPayload.conversationId.trim()
      ? { conversationId: requestTruthPayload.conversationId.trim() }
      : {}),
    ...(typeof mergedRuntimeControl.routeHint === 'string' && mergedRuntimeControl.routeHint.trim()
      ? { routeHint: mergedRuntimeControl.routeHint.trim() }
      : {}),
    ...(continuationContextPayload.responsesResume
      && typeof continuationContextPayload.responsesResume === 'object'
      && !Array.isArray(continuationContextPayload.responsesResume)
      ? { responsesResume: continuationContextPayload.responsesResume }
      : {}),
  } as Record<string, unknown>;
  const routerMetadata = projectRouterInputMetadata({
    metadata: metadataBase,
    requestTruth: requestTruthPayload,
    runtimeControl: mergedRuntimeControl,
    continuationContext: continuationContextPayload,
  });
  const route = mergedRuntimeControl.preselectedRoute
    ?? routerEngine.route(normalized.payload as never, routerMetadata as never);
  const metadata = {
    ...metadataBase,
    runtime_control: {
      ...mergedRuntimeControl,
      preselectedRoute: route,
    },
    ...nativeTopLevelRuntimeControl,
  } as Record<string, unknown>;
  if (Object.keys(legacyRuntimeProjectionWhitelist).length > 0) {
    metadata.__rt = legacyRuntimeProjectionWhitelist;
  } else {
    delete metadata.__rt;
  }
  const metadataCenterSnapshot = buildMetadataCenterSnapshot({
    requestTruth: requestTruthPayload,
    continuationContext: continuationContextPayload,
    runtimeControl: metadataCenterRuntimeControl,
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
