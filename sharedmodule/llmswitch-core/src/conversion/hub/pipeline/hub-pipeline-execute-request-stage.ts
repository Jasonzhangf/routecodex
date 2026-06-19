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
  readRuntimeControl: () => Record<string, unknown> | undefined;
};

function isMetadataCenterLike(value: unknown): value is MetadataCenterLike {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { readRuntimeControl?: unknown }).readRuntimeControl === 'function'
  );
}

function readRuntimeMetadataControl(metadata: Record<string, unknown>): Record<string, unknown> {
  return metadata.__rt && typeof metadata.__rt === 'object' && !Array.isArray(metadata.__rt)
    ? { ...(metadata.__rt as Record<string, unknown>) }
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
  if (typeof runtimeControl.stoplessGoalStatus === 'string' && runtimeControl.stoplessGoalStatus.trim()) {
    out.stoplessGoalStatus = runtimeControl.stoplessGoalStatus.trim();
  }
  return out;
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
  const runtimeControl = readRuntimeMetadataControl(normalized.metadata);
  const metadataCenterRuntimeControl = readRuntimeControlFromMetadataCenter(normalized.metadata);
  const nativeTopLevelRuntimeControl = projectNativeTopLevelRuntimeControl({
    ...runtimeControl,
    ...metadataCenterRuntimeControl,
  });
  const route = metadataCenterRuntimeControl.preselectedRoute
    ?? runtimeControl.preselectedRoute
    ?? routerEngine.route(normalized.payload as never, normalized.metadata as never);
  const metadata = {
    ...normalized.metadata,
    ...nativeTopLevelRuntimeControl,
    __rt: {
      ...runtimeControl,
      ...metadataCenterRuntimeControl,
      preselectedRoute: route,
    },
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
