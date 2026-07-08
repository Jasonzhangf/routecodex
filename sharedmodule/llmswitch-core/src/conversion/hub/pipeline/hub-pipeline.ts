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
  hubPipelineVirtualRouterRouteJson,
  hubPipelineVirtualRouterDiagnoseRouteJson,
  hubPipelineVirtualRouterStatusJson,
  hubPipelineVirtualRouterMarkConcurrencyScopeBusyJson,
  buildHubPipelineMaterializedRequestPlanWithNative,
} from "../../../native/router-hotpath/native-hub-pipeline-orchestration-semantics.js";
import {
  readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter,
} from "../metadata-center-runtime-control-writer.js";

function readJsonString(raw: unknown): string {
  if (typeof raw === "string") return raw;
  try { return JSON.stringify(raw); } catch { return String(raw); }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export type HubPipelineConfig = Record<string, unknown>;
export type HubPipelineResult = Record<string, unknown>;
export type HubPipelineNodeResult = Record<string, unknown>;
export type NormalizedRequest = Record<string, unknown>;

export type HubPipelineVirtualRouterFacade = {
  route: (request: Record<string, unknown>, metadata?: Record<string, unknown>) => Record<string, unknown>;
  diagnoseRoute: (request: Record<string, unknown>, metadata?: Record<string, unknown>) => Record<string, unknown>;
  getStatus: () => Record<string, unknown>;
  markConcurrencyScopeBusy: (scopeKey: string) => void;
};

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

  getVirtualRouter(): HubPipelineVirtualRouterFacade {
    const handle = this.handle;
    return {
      route(request: Record<string, unknown>, metadata: Record<string, unknown> = {}): Record<string, unknown> {
        return JSON.parse(
          hubPipelineVirtualRouterRouteJson(handle, readJsonString(request), readJsonString(metadata))
        ) as Record<string, unknown>;
      },
      diagnoseRoute(request: Record<string, unknown>, metadata: Record<string, unknown> = {}): Record<string, unknown> {
        return JSON.parse(
          hubPipelineVirtualRouterDiagnoseRouteJson(handle, readJsonString(request), readJsonString(metadata))
        ) as Record<string, unknown>;
      },
      getStatus(): Record<string, unknown> {
        return JSON.parse(hubPipelineVirtualRouterStatusJson(handle)) as Record<string, unknown>;
      },
      markConcurrencyScopeBusy(scopeKey: string): void {
        hubPipelineVirtualRouterMarkConcurrencyScopeBusyJson(handle, String(scopeKey ?? ""));
      },
    };
  }

  dispose(): void {
    disposeHubPipelineEngineJson(this.handle);
  }

  async execute(request: Record<string, unknown> & { endpoint: string; payload: unknown }): Promise<Record<string, unknown>> {
    const metadata = (request.metadata ?? {}) as Record<string, unknown>;
    const endpoint = request.endpoint;
    const metadataCenterSnapshot =
      readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter(metadata)?.metadataCenterSnapshot
      ?? asRecord(metadata.metadataCenterSnapshot)
      ?? null;
    const payload = request.payload instanceof Readable
      ? {}
      : (request.payload as Record<string, unknown>);
    const materialized = buildHubPipelineMaterializedRequestPlanWithNative({
      endpoint,
      providerProtocol: typeof metadata.providerProtocol === "string" ? metadata.providerProtocol : "",
      metadata,
      metadataCenterSnapshot,
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
      ...(materialized.metadataCenterSnapshot ? { metadataCenterSnapshot: materialized.metadataCenterSnapshot } : {}),
      stream: materialized.stream,
      processMode: materialized.processMode,
      direction: materialized.direction,
      stage: materialized.stage,
    });

    const raw = hubPipelineExecuteJson(this.handle, requestJson);
    return JSON.parse(raw) as Record<string, unknown>;
  }
}
