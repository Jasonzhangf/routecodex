import { Readable } from "node:stream";
import { VirtualRouterEngine } from "../../../router/virtual-router/engine.js";
import type { VirtualRouterConfig } from "../../../router/virtual-router/types.js";
import type { SseProtocol } from "../../../sse/index.js";
import { defaultSseCodecRegistry } from "../../../sse/index.js";
import { setHubPolicyRuntimePolicy } from "../policy/policy-engine.js";
import { executeChatProcessEntryPipeline } from "./hub-pipeline-execute-chat-process-entry.js";
import { executeRequestStagePipeline } from "./hub-pipeline-execute-request-stage.js";
import { clearHubStageTiming } from "./hub-stage-timing.js";
import { setVirtualRouterPolicyRuntimeRouterHooks } from "../../../router/virtual-router/provider-runtime-ingress.js";
import {
  extractModelHintFromMetadataWithNative,
  resolveSseProtocolWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import { runHubPipelineLibWithNative } from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics-protocol.js";
import { isRecord } from "../../../shared/common-utils.js";
import type {
  HubPipelineConfig,
  HubPipelineRequest,
  HubPipelineResult,
  NormalizedRequest,
  ProviderProtocol,
} from "./hub-pipeline-types.js";
import type { StageRecorder } from "../format-adapters/index.js";
export type {
  HubPipelineConfig,
  HubPipelineNodeResult,
  HubPipelineRequest,
  HubPipelineRequestMetadata,
  HubPipelineResult,
  HubShadowCompareRequestConfig,
  NormalizedRequest,
  ProviderProtocol,
} from "./hub-pipeline-types.js";






function logHubPipelineNonBlockingError(stage: string, error: unknown, details?: Record<string, unknown>): void {
  const detailText = details && Object.keys(details).length > 0
    ? ` details=${JSON.stringify(details)}`
    : "";
  const reason = error instanceof Error ? error.message : String(error ?? "unknown");
  console.warn(`[hub-pipeline] ${stage} failed (non-blocking): ${reason}${detailText}`);
}

function registerProviderRuntimeHooks(args: { owner: unknown; routerEngine: VirtualRouterEngine; }): void {
  try {
    setVirtualRouterPolicyRuntimeRouterHooks(args.owner, {
      handleProviderError: (event) => {
        try { args.routerEngine.handleProviderError(event); }
        catch (subscriberError) { logHubPipelineNonBlockingError("provider-runtime-ingress.handleProviderError", subscriberError); }
      },
      handleProviderSuccess: (event) => {
        try { args.routerEngine.handleProviderSuccess(event); }
        catch (subscriberError) { logHubPipelineNonBlockingError("provider-runtime-ingress.handleProviderSuccess", subscriberError); }
      },
    });
  } catch (hookError) {
    logHubPipelineNonBlockingError("provider-runtime-ingress.register", hookError);
  }
}

function unregisterProviderRuntimeHooks(owner: unknown): void {
  try { setVirtualRouterPolicyRuntimeRouterHooks(owner, undefined); }
  catch (disposeError) { logHubPipelineNonBlockingError("dispose.provider-runtime-ingress.unregister", disposeError); }
}

function updateRouterRuntimeDeps(args: {
  deps: { healthStore?: HubPipelineConfig["healthStore"] | null; routingStateStore?: HubPipelineConfig["routingStateStore"] | null; };
  config: HubPipelineConfig;
  routerEngine: VirtualRouterEngine;
}): void {
  const { deps, config, routerEngine } = args;
  if (!deps || typeof deps !== "object") return;
  if ("healthStore" in deps) config.healthStore = deps.healthStore ?? undefined;
  if ("routingStateStore" in deps) config.routingStateStore = (deps.routingStateStore ?? undefined) as any;
  try {
    routerEngine.updateDeps({ healthStore: config.healthStore ?? null, routingStateStore: (config.routingStateStore ?? null) as any });
  } catch (updateDepsError) {
    logHubPipelineNonBlockingError("updateRuntimeDeps.routerEngine.updateDeps", updateDepsError);
  }
}

function createHubPipelineRouterEngine(config: HubPipelineConfig): VirtualRouterEngine {
  const routerEngine = new VirtualRouterEngine({
    healthStore: config.healthStore,
    routingStateStore: config.routingStateStore as any,
  });
  routerEngine.initialize(config.virtualRouter);
  setHubPolicyRuntimePolicy(config.policy);
  return routerEngine;
}

function registerHubPipelineRuntime(args: { owner: unknown; routerEngine: VirtualRouterEngine }): void {
  registerProviderRuntimeHooks(args);
}

function disposeHubPipelineRuntime(owner: unknown): void {
  unregisterProviderRuntimeHooks(owner);
}

function applyHubPipelineRuntimeDeps(args: {
  deps: {
    healthStore?: HubPipelineConfig["healthStore"] | null;
    routingStateStore?: HubPipelineConfig["routingStateStore"] | null;
  };
  config: HubPipelineConfig;
  routerEngine: VirtualRouterEngine;
}): void {
  updateRouterRuntimeDeps(args);
}

function updateHubPipelineVirtualRouterConfig(args: { nextConfig: VirtualRouterConfig; config: HubPipelineConfig; routerEngine: VirtualRouterEngine; }): void {
  if (!args.nextConfig || typeof args.nextConfig !== "object") {
    throw new Error("HubPipeline updateVirtualRouterConfig requires VirtualRouterConfig payload");
  }
  args.config.virtualRouter = args.nextConfig;
  args.routerEngine.initialize(args.nextConfig);
}

type HubPipelineProviderProtocol =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "gemini-chat";

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readProviderProtocol(metadata: Record<string, unknown>): HubPipelineProviderProtocol {
  return (readString(metadata.providerProtocol) ?? "openai-chat") as HubPipelineProviderProtocol;
}

function readStageRecorder(metadata: Record<string, unknown>): StageRecorder | undefined {
  const recorder = metadata.__hubStageRecorder;
  delete metadata.__hubStageRecorder;
  return recorder && typeof (recorder as StageRecorder).record === "function"
    ? recorder as StageRecorder
    : undefined;
}

function readJsonPayload(payload: HubPipelineRequest["payload"]): Record<string, unknown> | null {
  if (!payload) return null;
  if (payload instanceof Readable) return null;
  if (isRecord(payload) && payload.readable instanceof Readable) return null;
  return isRecord(payload) ? payload : null;
}

function readStreamCandidate(payload: HubPipelineRequest["payload"]): Readable | null {
  if (!payload) return null;
  if (payload instanceof Readable) return payload;
  if (isRecord(payload) && payload.readable instanceof Readable) return payload.readable;
  return null;
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
  if (!isRecord(result)) {
    throw new Error("SSE conversion returned empty payload");
  }
  return result;
}

function buildNormalizedRequestFromNative(args: {
  id: string;
  endpoint: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  externalStageRecorder?: StageRecorder;
}): NormalizedRequest {
  const endpoint = readString(args.metadata.endpoint) ?? args.endpoint;
  const entryEndpoint = readString(args.metadata.entryEndpoint) ?? endpoint;
  const providerProtocol = (readString(args.metadata.providerProtocol) ?? "openai-chat") as ProviderProtocol;
  const direction = args.metadata.direction === "response" ? "response" : "request";
  const stage = args.metadata.stage === "outbound" ? "outbound" : "inbound";
  const routeHint = readString(args.metadata.routeHint);
  const hubEntryRaw = readString(args.metadata.__hubEntry);
  const hubEntryMode = hubEntryRaw && ["chat_process", "chat-process", "chatprocess"].includes(hubEntryRaw.toLowerCase())
    ? "chat_process" as const
    : undefined;
  const policyOverride = isRecord(args.metadata.__hubPolicyOverride)
    ? args.metadata.__hubPolicyOverride
    : undefined;
  const shadowCompare = isRecord(args.metadata.__hubShadowCompare)
    ? args.metadata.__hubShadowCompare
    : undefined;
  const disableSnapshots = args.metadata.__disableHubSnapshots === true;
  const metadata = { ...args.metadata };
  delete metadata.__hubEntry;
  delete metadata.__hubPolicyOverride;
  delete metadata.__hubShadowCompare;
  delete metadata.__disableHubSnapshots;
  return {
    id: args.id,
    endpoint,
    entryEndpoint,
    providerProtocol,
    payload: args.payload,
    metadata,
    ...(policyOverride ? { policyOverride: policyOverride as NormalizedRequest["policyOverride"] } : {}),
    ...(shadowCompare ? { shadowCompare: shadowCompare as NormalizedRequest["shadowCompare"] } : {}),
    disableSnapshots,
    ...(args.externalStageRecorder ? { externalStageRecorder: args.externalStageRecorder } : {}),
    processMode: "chat",
    direction,
    stage,
    stream: args.metadata.stream === true,
    ...(routeHint ? { routeHint } : {}),
    ...(hubEntryMode ? { hubEntryMode } : {}),
  };
}

async function materializeHubPipelineRequest(request: HubPipelineRequest): Promise<NormalizedRequest> {
  if (!request || typeof request !== "object") {
    throw new Error("HubPipeline requires request payload");
  }
  const id = request.id || `req_${Date.now()}`;
  const metadataRecord: Record<string, unknown> = { ...(request.metadata ?? {}) };
  const externalStageRecorder = readStageRecorder(metadataRecord);
  const providerProtocol = readProviderProtocol(metadataRecord);
  const streamCandidate = readStreamCandidate(request.payload);
  const payload = streamCandidate
    ? await convertSsePayloadToJson(streamCandidate, { requestId: id, providerProtocol, metadata: metadataRecord })
    : readJsonPayload(request.payload);
  if (!payload) {
    throw new Error("HubPipeline requires JSON object payload");
  }
  const stream = Boolean(metadataRecord.stream === true || payload.stream === true || streamCandidate);
  const nativePlan = runHubPipelineLibWithNative({
    request: {
      requestId: id,
      endpoint: request.endpoint,
      entryEndpoint: readString(metadataRecord.entryEndpoint) ?? request.endpoint,
      providerProtocol,
      payload,
      metadata: metadataRecord,
      stream,
      processMode: "chat",
      direction: metadataRecord.direction === "response" ? "response" : "request",
      stage: metadataRecord.stage === "outbound" ? "outbound" : "inbound",
    },
  });
  if (nativePlan.success !== true) {
    throw new Error(nativePlan.error?.message ?? "Rust HubPipeline request materialization failed");
  }
  if (!isRecord(nativePlan.payload) || !isRecord(nativePlan.metadata)) {
    throw new Error("Rust HubPipeline request materialization returned invalid envelope");
  }
  return buildNormalizedRequestFromNative({
    id: nativePlan.requestId || id,
    endpoint: request.endpoint,
    payload: nativePlan.payload,
    metadata: nativePlan.metadata,
    externalStageRecorder,
  });
}



async function executeHubPipelineRequest(args: {
  request: HubPipelineRequest;
  routerEngine: VirtualRouterEngine;
  config: HubPipelineConfig;
}): Promise<HubPipelineResult> {
  const normalized = await materializeHubPipelineRequest(args.request);
  clearHubStageTiming(normalized.id);
  try {
    if (normalized.direction === "request" && normalized.hubEntryMode === "chat_process") {
      return await executeChatProcessEntryPipeline({ normalized, routerEngine: args.routerEngine, config: args.config });
    }
    return await executeRequestStagePipeline({
      normalized,
      routerEngine: args.routerEngine,
      config: args.config,
    });
  } finally {
    clearHubStageTiming(normalized.id);
  }
}

function executeHubPipeline(args: { request: HubPipelineRequest; routerEngine: VirtualRouterEngine; config: HubPipelineConfig; }): Promise<HubPipelineResult> {
  return executeHubPipelineRequest(args);
}

export class HubPipeline {
  private readonly routerEngine: VirtualRouterEngine;
  private config: HubPipelineConfig;

  constructor(config: HubPipelineConfig) {
    this.config = config;
    this.routerEngine = createHubPipelineRouterEngine(config);
    registerHubPipelineRuntime({
      owner: this,
      routerEngine: this.routerEngine,
    });
  }

  updateRuntimeDeps(deps: {
    healthStore?: HubPipelineConfig["healthStore"] | null;
    routingStateStore?: HubPipelineConfig["routingStateStore"] | null;
  }): void {
    applyHubPipelineRuntimeDeps({
      deps,
      config: this.config,
      routerEngine: this.routerEngine,
    });
  }

  updateVirtualRouterConfig(nextConfig: VirtualRouterConfig): void {
    updateHubPipelineVirtualRouterConfig({
      nextConfig,
      config: this.config,
      routerEngine: this.routerEngine,
    });
  }

  dispose(): void {
    disposeHubPipelineRuntime(this);
  }

  getVirtualRouter(): VirtualRouterEngine {
    return this.routerEngine;
  }

  async execute(request: HubPipelineRequest): Promise<HubPipelineResult> {
    return executeHubPipeline({
      request,
      routerEngine: this.routerEngine,
      config: this.config,
    });
  }

}
