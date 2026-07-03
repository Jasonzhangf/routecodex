import { Readable } from "node:stream";
import type { VirtualRouterConfig } from "../../../native/router-hotpath/virtual-router-contracts.js";
import {
  createVirtualRouterRuntime,
  type VirtualRouterRuntime
} from "../../../native/router-hotpath/native-virtual-router-runtime.js";
import {
  defaultSseCodecRegistry,
  type SseProtocol,
} from "../../../sse/registry/sse-codec-registry.js";
import { executeRequestStagePipeline } from "./hub-pipeline-execute-request-stage.js";
import { clearHubStageTiming } from "./hub-stage-timing.js";
import {
  buildHubPipelineMaterializedRequestPlanWithNative,
  extractModelHintFromMetadataWithNative,
  resolveHubPipelineRequestProviderProtocolWithNative,
  resolveSseProtocolWithNative,
} from "../../../native/router-hotpath/native-hub-pipeline-orchestration-semantics.js";
import { ensureRuntimeMetadata } from "../../runtime-metadata.js";
import { isRecord } from "../../../shared/common-utils.js";
import { readRuntimeControlFromAnyBoundMetadataCenter } from "../../../servertool/metadata-center-carrier.js";
import type {
  HubPipelineConfig,
  HubPipelineRequest,
  HubPipelineResult,
  NormalizedRequest,
  ProviderProtocol,
} from "./hub-pipeline-types.js";
import type { StageRecorder } from "../format-adapters/index.js";

// feature_id: hub.runtime_ingress_bridge
export type {
  HubPipelineConfig,
  HubPipelineNodeResult,
  HubPipelineRequest,
  HubPipelineResult,
  NormalizedRequest,
  ProviderProtocol,
} from "./hub-pipeline-types.js";

function registerHubPipelineRuntimeIngressBridge(args: { owner: unknown; routerEngine: VirtualRouterRuntime; }): void {
  void args.owner;
  args.routerEngine.registerProviderRuntimeIngress();
}

function unregisterHubPipelineRuntimeIngressBridge(routerEngine: VirtualRouterRuntime): void {
  routerEngine.unregisterProviderRuntimeIngress();
}

function updateHubPipelineRuntimeDepsBridge(args: {
  deps: { healthStore?: HubPipelineConfig["healthStore"] | null; routingStateStore?: HubPipelineConfig["routingStateStore"] | null; };
  config: HubPipelineConfig;
  routerEngine: VirtualRouterRuntime;
}): void {
  const { deps, config, routerEngine } = args;
  if (!deps || typeof deps !== "object") return;
  if ("healthStore" in deps) config.healthStore = deps.healthStore ?? undefined;
  if ("routingStateStore" in deps) config.routingStateStore = (deps.routingStateStore ?? undefined) as any;
  routerEngine.updateDeps({ healthStore: config.healthStore ?? null, routingStateStore: (config.routingStateStore ?? null) as any });
}

function createHubPipelineRouterEngine(config: HubPipelineConfig): VirtualRouterRuntime {
  const routerEngine = createVirtualRouterRuntime({
    healthStore: config.healthStore,
    routingStateStore: config.routingStateStore as any,
  });
  routerEngine.initialize(config.virtualRouter);
  return routerEngine;
}

function registerHubPipelineRuntime(args: { owner: unknown; routerEngine: VirtualRouterRuntime }): void {
  registerHubPipelineRuntimeIngressBridge(args);
}

function disposeHubPipelineRuntime(routerEngine: VirtualRouterRuntime): void {
  unregisterHubPipelineRuntimeIngressBridge(routerEngine);
}

function applyHubPipelineRuntimeDeps(args: {
  deps: {
    healthStore?: HubPipelineConfig["healthStore"] | null;
    routingStateStore?: HubPipelineConfig["routingStateStore"] | null;
  };
  config: HubPipelineConfig;
  routerEngine: VirtualRouterRuntime;
}): void {
  updateHubPipelineRuntimeDepsBridge(args);
}

function updateHubPipelineVirtualRouterConfig(args: { nextConfig: VirtualRouterConfig; config: HubPipelineConfig; routerEngine: VirtualRouterRuntime; }): void {
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

import { METADATA_CENTER_SYMBOL } from '../metadata-center-runtime-control-writer.js';

function preserveMetadataCenterBinding(source: Record<string, unknown>, target: Record<string, unknown>): void {
  const center = Reflect.get(source, METADATA_CENTER_SYMBOL);
  if (center !== undefined) {
    Reflect.set(target, METADATA_CENTER_SYMBOL, center);
  }
}

function readProviderProtocol(metadata: Record<string, unknown>): HubPipelineProviderProtocol {
  return resolveHubPipelineRequestProviderProtocolWithNative({
    providerProtocol: metadata.providerProtocol,
    runtimeControl: readRuntimeControlFromAnyBoundMetadataCenter(metadata) ?? null,
  }).providerProtocol as HubPipelineProviderProtocol;
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

function buildMaterializedRequest(args: {
  id: string;
  endpoint: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  providerProtocol: HubPipelineProviderProtocol;
  payloadStream: boolean;
  externalStageRecorder?: StageRecorder;
}): NormalizedRequest {
  const plan = buildHubPipelineMaterializedRequestPlanWithNative({
    endpoint: args.endpoint,
    providerProtocol: args.providerProtocol,
    metadata: args.metadata,
    payload: args.payload,
    payloadStream: args.payloadStream,
  });
  const metadata = { ...plan.metadata };
  preserveMetadataCenterBinding(args.metadata, metadata);
  ensureRuntimeMetadata(metadata);
  return {
    id: args.id,
    endpoint: plan.endpoint,
    entryEndpoint: plan.entryEndpoint,
    providerProtocol: plan.providerProtocol as ProviderProtocol,
    payload: args.payload,
    metadata,
    ...(plan.policyOverride ? { policyOverride: plan.policyOverride as NormalizedRequest["policyOverride"] } : {}),
    ...(plan.shadowCompare ? { shadowCompare: plan.shadowCompare as NormalizedRequest["shadowCompare"] } : {}),
    disableSnapshots: plan.disableSnapshots,
    ...(args.externalStageRecorder ? { externalStageRecorder: args.externalStageRecorder } : {}),
    processMode: plan.processMode,
    direction: plan.direction,
    stage: plan.stage,
    stream: plan.stream,
    ...(plan.hubEntryMode ? { hubEntryMode: plan.hubEntryMode } : {}),
  };
}

async function materializeHubPipelineRequest(request: HubPipelineRequest): Promise<NormalizedRequest> {
  if (!request || typeof request !== "object") {
    throw new Error("HubPipeline requires request payload");
  }
  const id = request.id || `req_${Date.now()}`;
  const metadataRecord: Record<string, unknown> = { ...(request.metadata ?? {}) };
  if (request.metadata && typeof request.metadata === 'object' && !Array.isArray(request.metadata)) {
    preserveMetadataCenterBinding(request.metadata as Record<string, unknown>, metadataRecord);
  }
  const externalStageRecorder = readStageRecorder(metadataRecord);
  const providerProtocol = readProviderProtocol(metadataRecord);
  const streamCandidate = readStreamCandidate(request.payload);
  const payload = streamCandidate
    ? await convertSsePayloadToJson(streamCandidate, { requestId: id, providerProtocol, metadata: metadataRecord })
    : readJsonPayload(request.payload);
  if (!payload) {
    throw new Error("HubPipeline requires JSON object payload");
  }
  const materializedMetadata: Record<string, unknown> = { ...metadataRecord };
  preserveMetadataCenterBinding(metadataRecord, materializedMetadata);
  return buildMaterializedRequest({
    id,
    endpoint: request.endpoint,
    payload,
    metadata: materializedMetadata,
    providerProtocol,
    payloadStream: Boolean(streamCandidate),
    externalStageRecorder,
  });
}



async function executeHubPipelineRequest(args: {
  request: HubPipelineRequest;
  routerEngine: VirtualRouterRuntime;
  config: HubPipelineConfig;
}): Promise<HubPipelineResult> {
  const normalized = await materializeHubPipelineRequest(args.request);
  clearHubStageTiming(normalized.id);
  try {
    if (normalized.direction === "request" && normalized.hubEntryMode === "chat_process") {
      return await executeRequestStagePipeline({
        normalized,
        routerEngine: args.routerEngine,
        config: args.config,
        entryMode: "chat_process",
      });
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

function executeHubPipeline(args: { request: HubPipelineRequest; routerEngine: VirtualRouterRuntime; config: HubPipelineConfig; }): Promise<HubPipelineResult> {
  return executeHubPipelineRequest(args);
}

export class HubPipeline {
  private readonly routerEngine: VirtualRouterRuntime;
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
    disposeHubPipelineRuntime(this.routerEngine);
  }

  getVirtualRouter(): VirtualRouterRuntime {
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
