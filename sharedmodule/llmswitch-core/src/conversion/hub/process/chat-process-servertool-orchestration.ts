import { applyHubOperations } from '../ops/operations.js';
import {
  buildContinueExecutionOperations,
  resolveHasActiveStopMessageForContinueExecution
} from './chat-process-continue-execution.js';
import { buildWebSearchOperations } from './chat-process-web-search.js';
import { buildClockOperationsWithPlan } from './chat-process-clock-tools.js';
import { buildReviewOperations } from './chat-process-review.js';
import { maybeInjectClockRemindersAndApplyDirectives } from './chat-process-clock-reminders.js';
import type { StandardizedRequest } from '../types/standardized.js';
import { readRuntimeMetadata } from '../../runtime-metadata.js';
import { tryPlanChatServerToolBundleWithNative } from '../../../router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js';

interface ServerToolOrchestrationOptions {
  request: StandardizedRequest;
  metadata: Record<string, unknown>;
  requestId: string;
}

export async function applyServerToolOrchestration(
  options: ServerToolOrchestrationOptions
): Promise<StandardizedRequest> {
  let request = options.request;
  const runtimeMetadata = (readRuntimeMetadata(options.metadata) ?? {}) as Record<string, unknown>;
  const hasActiveStopMessage = resolveHasActiveStopMessageForContinueExecution(options.metadata);
  const nativeBundle = tryPlanChatServerToolBundleWithNative(
    request,
    runtimeMetadata,
    hasActiveStopMessage
  );

  request = applyHubOperations(
    request,
    buildWebSearchOperations(request, options.metadata, nativeBundle?.webSearch)
  );
  request = applyHubOperations(
    request,
    buildClockOperationsWithPlan(options.metadata, nativeBundle?.clock)
  );
  request = applyHubOperations(
    request,
    buildContinueExecutionOperations(options.metadata, {
      hasActiveStopMessage,
      precomputedPlan: nativeBundle?.continueExecution
    })
  );
  request = applyHubOperations(
    request,
    buildReviewOperations(options.metadata)
  );
  return maybeInjectClockRemindersAndApplyDirectives(request, options.metadata, options.requestId);
}
