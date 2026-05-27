import { VirtualRouterEngine } from "../../../router/virtual-router/engine.js";
import type { VirtualRouterConfig } from "../../../router/virtual-router/types.js";
import { setHubPolicyRuntimePolicy } from "../policy/policy-engine.js";
import type {
  HubPipelineConfig,
  HubPipelineRequest,
  HubPipelineResult,
} from "./hub-pipeline.js";
import {
  executeHubPipelineRequest,
} from "./hub-pipeline-runtime-execute-blocks.js";
import {
  logHubPipelineNonBlockingError,
  registerProviderRuntimeHooks,
  unregisterProviderRuntimeHooks,
  updateRouterRuntimeDeps,
} from "./hub-pipeline-runtime-hooks-blocks.js";

export function createHubPipelineRouterEngine(
  config: HubPipelineConfig,
): VirtualRouterEngine {
  const routerEngine = new VirtualRouterEngine({
    healthStore: config.healthStore,
    routingStateStore: config.routingStateStore as any,
  });
  routerEngine.initialize(config.virtualRouter);
  setHubPolicyRuntimePolicy(config.policy);
  return routerEngine;
}

export function registerHubPipelineRuntime(args: {
  owner: unknown;
  routerEngine: VirtualRouterEngine;
}): void {
  registerProviderRuntimeHooks(args);
}

export function disposeHubPipelineRuntime(owner: unknown): void {
  unregisterProviderRuntimeHooks(owner);
}

export function applyHubPipelineRuntimeDeps(args: {
  deps: {
    healthStore?: HubPipelineConfig["healthStore"] | null;
    routingStateStore?: HubPipelineConfig["routingStateStore"] | null;
  };
  config: HubPipelineConfig;
  routerEngine: VirtualRouterEngine;
}): void {
  updateRouterRuntimeDeps(args);
}

export function updateHubPipelineVirtualRouterConfig(args: {
  nextConfig: VirtualRouterConfig;
  config: HubPipelineConfig;
  routerEngine: VirtualRouterEngine;
}): void {
  if (!args.nextConfig || typeof args.nextConfig !== "object") {
    throw new Error(
      "HubPipeline updateVirtualRouterConfig requires VirtualRouterConfig payload",
    );
  }
  args.config.virtualRouter = args.nextConfig;
  args.routerEngine.initialize(args.nextConfig);
}

export function executeHubPipeline(args: {
  request: HubPipelineRequest;
  routerEngine: VirtualRouterEngine;
  config: HubPipelineConfig;
}): Promise<HubPipelineResult> {
  return executeHubPipelineRequest(args);
}
