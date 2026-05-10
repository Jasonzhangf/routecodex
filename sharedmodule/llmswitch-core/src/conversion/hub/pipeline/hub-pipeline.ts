import { VirtualRouterEngine } from "../../../router/virtual-router/engine.js";
import type { VirtualRouterConfig } from "../../../router/virtual-router/types.js";
import {
  applyHubPipelineRuntimeDeps,
  createHubPipelineRouterEngine,
  disposeHubPipelineRuntime,
  executeHubPipeline,
  registerHubPipelineRuntime,
  updateHubPipelineVirtualRouterConfig,
} from "./hub-pipeline-class-runtime-blocks.js";
import type {
  HubPipelineConfig,
  HubPipelineRequest,
  HubPipelineResult,
} from "./hub-pipeline-types.js";
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
export { __unsafeBuildAdapterContextForTest } from "./hub-pipeline-test-seams.js";

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
    quotaView?: HubPipelineConfig["quotaView"] | null;
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
