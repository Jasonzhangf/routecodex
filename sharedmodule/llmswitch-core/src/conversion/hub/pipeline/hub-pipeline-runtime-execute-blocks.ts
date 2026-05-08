import type { HubPipelineRequest, HubPipelineResult } from "./hub-pipeline.js";
import type { RequestStageHooks } from "./hub-pipeline-stage-hooks.js";
import { executeChatProcessEntryPipeline } from "./hub-pipeline-execute-chat-process-entry.js";
import { executeRequestStagePipeline } from "./hub-pipeline-execute-request-stage.js";
import { normalizeHubPipelineRequest } from "./hub-pipeline-normalize-request.js";
import { clearHubStageTiming } from "./hub-stage-timing.js";
import { requireRequestStageHooks } from "./hub-pipeline-shared-guards.js";
import { VirtualRouterEngine } from "../../../router/virtual-router/engine.js";
import type { HubPipelineConfig } from "./hub-pipeline.js";

export async function executeHubPipelineRequest(args: {
  request: HubPipelineRequest;
  routerEngine: VirtualRouterEngine;
  config: HubPipelineConfig;
}): Promise<HubPipelineResult> {
  const normalized = await normalizeHubPipelineRequest(args.request);
  clearHubStageTiming(normalized.id);
  try {
    if (
      normalized.direction === "request" &&
      normalized.hubEntryMode === "chat_process"
    ) {
      return await executeChatProcessEntryPipeline({
        normalized,
        routerEngine: args.routerEngine,
        config: args.config,
      });
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
