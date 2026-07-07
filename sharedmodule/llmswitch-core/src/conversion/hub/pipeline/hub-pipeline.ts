// feature_id: hub.route_selection_bridge
// feature_id: hub.runtime_ingress_bridge
// Thin TS shell: delegates all HubPipeline operations to native NAPI by opaque handle.
import { Readable } from "node:stream";
import {
  createHubPipelineEngineJson,
  hubPipelineExecuteJson,
  disposeHubPipelineEngineJson,
  updateHubPipelineVirtualRouterConfigJson,
  updateHubPipelineEngineDepsJson,
  resolveHubPipelineRequestProviderProtocolWithNative,
  buildHubPipelineMaterializedRequestPlanWithNative,
} from "../../../native/router-hotpath/native-hub-pipeline-orchestration-semantics.js";

function readJsonString(raw: unknown): string {
  if (typeof raw === "string") return raw;
  try { return JSON.stringify(raw); } catch { return String(raw); }
}

export type HubPipelineConfig = Record<string, unknown>;
export type HubPipelineResult = Record<string, unknown>;
export type HubPipelineNodeResult = Record<string, unknown>;
export type NormalizedRequest = Record<string, unknown>;

export interface HubPipelineRequest {
  id?: string;
  endpoint: string;
  payload: Record<string, unknown> | { readable?: Readable } | Readable;
  metadata?: Record<string, unknown>;
}

export class HubPipeline {
  private readonly handle: string;

  constructor(config: Record<string, unknown>) {
    const result = createHubPipelineEngineJson(readJsonString(config));
    const parsed = JSON.parse(result);
    if (typeof parsed.handle !== "string") {
      throw new Error("HubPipeline native constructor returned invalid handle");
    }
    this.handle = parsed.handle;
  }

  updateRuntimeDeps(deps: Record<string, unknown>): void {
    updateHubPipelineEngineDepsJson(this.handle, readJsonString(deps));
  }

  updateVirtualRouterConfig(config: unknown): void {
    updateHubPipelineVirtualRouterConfigJson(this.handle, readJsonString(config));
  }

  dispose(): void {
    disposeHubPipelineEngineJson(this.handle);
  }

  async execute(request: Record<string, unknown> & { endpoint: string; payload: unknown }): Promise<Record<string, unknown>> {
    const metadata = (request.metadata ?? {}) as Record<string, unknown>;
    const endpoint = request.endpoint;
    const metadataCenterSnapshot = metadata.metadataCenterSnapshot;
    const runtimeControl = metadataCenterSnapshot &&
      typeof metadataCenterSnapshot === "object" &&
      !Array.isArray(metadataCenterSnapshot)
      ? (metadataCenterSnapshot as Record<string, unknown>).runtimeControl
      : undefined;
    const providerProtocol = resolveHubPipelineRequestProviderProtocolWithNative({
      providerProtocol: metadata.providerProtocol,
      runtimeControl: runtimeControl && typeof runtimeControl === "object" && !Array.isArray(runtimeControl)
        ? runtimeControl as Record<string, unknown>
        : null,
    }).providerProtocol;

    const payload = request.payload instanceof Readable
      ? {}
      : (request.payload as Record<string, unknown>);
    const materialized = buildHubPipelineMaterializedRequestPlanWithNative({
      endpoint,
      providerProtocol,
      metadata,
      payload,
      payloadStream: request.payload instanceof Readable,
    });

    const requestJson = JSON.stringify({
      requestId: (request.id ?? "unknown") as string,
      endpoint: materialized.endpoint,
      entryEndpoint: materialized.entryEndpoint,
      providerProtocol: materialized.providerProtocol,
      payload,
      metadata: materialized.metadata,
      stream: materialized.stream,
      processMode: materialized.processMode,
      direction: materialized.direction,
      stage: materialized.stage,
    });

    const raw = hubPipelineExecuteJson(this.handle, requestJson);
    return JSON.parse(raw) as Record<string, unknown>;
  }
}
