import type { JsonObject } from '../../../conversion/hub/types/json.js';
import { isGoalCapableAdapterContext } from '../../../conversion/hub/pipeline/hub-pipeline-goal-tools.js';
import { stripChatProcessHistoricalImages } from '../../../router/virtual-router/engine-selection/native-router-hotpath.js';
import { cloneJson } from '../../server-side-tools.js';
import type { ServerToolFollowupInjectionPlan } from '../../types.js';
import { hasManagedStoplessGoalState } from '../stopless-goal-state.js';
import {
  applyFollowupInjectionOps,
  hasReasoningStopTool,
  shouldIncludeReasoningStopToolFromOps,
  stripToolsByCanonicalName
} from './op-blocks.js';
import type { CapturedChatSeed } from './seed.js';
import {
  extractCapturedChatSeed,
  resolveFollowupModel,
  sanitizeFollowupParametersForResolvedModel
} from './seed.js';

export function buildChatFollowupPayloadFromInjection(args: {
  adapterContext: unknown;
  chatResponse: JsonObject;
  injection: ServerToolFollowupInjectionPlan;
}): JsonObject | null {
  const captured =
    args.adapterContext && typeof args.adapterContext === 'object'
      ? ((args.adapterContext as { capturedChatRequest?: unknown }).capturedChatRequest as unknown)
      : undefined;
  const seed = extractCapturedChatSeed(captured);
  if (!seed) {
    return null;
  }
  return materializeFollowupChatPayload({
    seed,
    adapterContext: args.adapterContext,
    chatResponse: args.chatResponse,
    injection: args.injection
  });
}

function materializeFollowupChatPayload(args: {
  seed: CapturedChatSeed;
  adapterContext: unknown;
  chatResponse: JsonObject;
  injection: ServerToolFollowupInjectionPlan;
}): JsonObject | null {
  const followupModel = resolveFollowupModel(args.seed.model, args.adapterContext);
  if (!followupModel) {
    return null;
  }

  let messages: JsonObject[] = Array.isArray(args.seed.messages) ? (cloneJson(args.seed.messages) as JsonObject[]) : [];
  messages = stripChatProcessHistoricalImages(messages, '[Image omitted]').messages as JsonObject[];
  const ops = Array.isArray(args.injection?.ops) ? args.injection.ops : [];
  const goalManagedContext =
    isGoalCapableAdapterContext(args.adapterContext as any)
    || hasManagedStoplessGoalState(args.adapterContext);
  const tools = Array.isArray(args.seed.tools) ? (cloneJson(args.seed.tools) as JsonObject[]) : undefined;
  const sanitizedTools = goalManagedContext
    ? stripToolsByCanonicalName(tools, ['reasoning.stop', 'reasoning_stop', 'reasoning-stop'])
    : tools;
  const result = applyFollowupInjectionOps({
    state: {
      messages,
      tools: sanitizedTools,
      parameters: sanitizeFollowupParametersForResolvedModel({
        parameters: args.seed.parameters ? (cloneJson(args.seed.parameters) as Record<string, unknown>) : undefined,
        seedModel: args.seed.model,
        followupModel
      })
    },
    ops,
    context: {
      chatResponse: args.chatResponse,
      includeReasoningStopTool:
        !goalManagedContext
        && (shouldIncludeReasoningStopToolFromOps(ops) || hasReasoningStopTool(sanitizedTools))
    }
  });
  if (!result) {
    return null;
  }

  return {
    model: followupModel,
    messages: result.messages,
    ...(result.tools ? { tools: result.tools } : {}),
    ...(result.parameters ? { parameters: result.parameters } : {})
  } as JsonObject;
}
