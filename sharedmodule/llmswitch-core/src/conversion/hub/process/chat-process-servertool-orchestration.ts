import { applyHubOperations } from '../ops/operations.js';
import { buildWebSearchOperations } from './chat-process-web-search.js';
import { buildClockOperationsWithPlan } from './chat-process-clock-tools.js';
import { buildReviewOperations } from './chat-process-review.js';
import { maybeInjectClockRemindersAndApplyDirectives } from './chat-process-clock-reminders.js';
import type { StandardizedRequest } from '../types/standardized.js';
import { readRuntimeMetadata } from '../../runtime-metadata.js';
import {
  planChatClockOperationsWithNative,
  planChatWebSearchOperationsWithNative
} from '../../../router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js';
import { sanitizeChatProcessRequest } from './chat-process-request-sanitizer.js';

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
  const webSearchPlan = planChatWebSearchOperationsWithNative(request, runtimeMetadata);
  const clockPlan = planChatClockOperationsWithNative(runtimeMetadata);

  request = applyHubOperations(
    request,
    buildWebSearchOperations(request, options.metadata, webSearchPlan)
  );
  request = applyHubOperations(
    request,
    buildClockOperationsWithPlan(options.metadata, clockPlan)
  );
  request = applyHubOperations(
    request,
    buildReviewOperations(options.metadata)
  );
  return sanitizeChatProcessRequest(
    await maybeInjectClockRemindersAndApplyDirectives(request, options.metadata, options.requestId)
  );
}
