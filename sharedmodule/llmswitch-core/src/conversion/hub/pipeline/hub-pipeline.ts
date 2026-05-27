import { VirtualRouterEngine } from "../../../router/virtual-router/engine.js";
import type { VirtualRouterConfig } from "../../../router/virtual-router/types.js";
import { setHubPolicyRuntimePolicy } from "../policy/policy-engine.js";
import type { RequestStageHooks } from "./hub-pipeline-stage-hooks.js";
import { executeChatProcessEntryPipeline } from "./hub-pipeline-execute-chat-process-entry.js";
import { executeRequestStagePipeline } from "./hub-pipeline-execute-request-stage.js";
import { normalizeHubPipelineRequest } from "./hub-pipeline-normalize-request.js";
import { clearHubStageTiming } from "./hub-stage-timing.js";
import { requireRequestStageHooks } from "./hub-pipeline-shared-guards.js";
import { setVirtualRouterPolicyRuntimeRouterHooks } from "../../../router/virtual-router/provider-runtime-ingress.js";
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



async function executeHubPipelineRequest(args: {
  request: HubPipelineRequest;
  routerEngine: VirtualRouterEngine;
  config: HubPipelineConfig;
}): Promise<HubPipelineResult> {
  const normalized = await normalizeHubPipelineRequest(args.request);
  clearHubStageTiming(normalized.id);
  try {
    if (normalized.direction === "request" && normalized.hubEntryMode === "chat_process") {
      return await executeChatProcessEntryPipeline({ normalized, routerEngine: args.routerEngine, config: args.config });
    }
    const hooks = requireRequestStageHooks(normalized.providerProtocol);
    return await executeRequestStagePipeline({
      normalized,
      hooks: hooks as RequestStageHooks<Record<string, unknown>>,
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
