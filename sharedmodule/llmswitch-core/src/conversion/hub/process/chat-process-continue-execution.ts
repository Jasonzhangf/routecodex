import { readRuntimeMetadata } from '../../runtime-metadata.js';
import { loadRoutingInstructionStateSync } from '../../../router/virtual-router/sticky-session-store.js';
import { logContinueExecution } from '../../../servertool/continue-execution/log.js';
import {
  buildContinueExecutionOperationsWithNative,
  injectContinueExecutionDirectiveWithNative,
  planContinueExecutionOperationsWithNative,
  isStopMessageStateActiveWithNative,
  resolveStopMessageSessionScopeWithNative,
  type NativeContinueExecutionPlan
} from '../../../router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js';
import type { HubOperation } from '../ops/operations.js';
import type { StandardizedRequest } from '../types/standardized.js';
import { isClientInjectReady } from './client-inject-readiness.js';

const CONTINUE_EXECUTION_INJECTION_MARKER = '[routecodex:continue_execution_injection]';
const CONTINUE_EXECUTION_INJECTION_TEXT = '继续执行';

type ContinueExecutionBuildOptions = {
  hasActiveStopMessage?: boolean;
  precomputedPlan?: NativeContinueExecutionPlan;
};

export function buildContinueExecutionOperations(
  metadata: Record<string, unknown>,
  options?: ContinueExecutionBuildOptions
): HubOperation[] {
  const rt = (readRuntimeMetadata(metadata) ?? {}) as Record<string, unknown>;
  const sessionId = readString(metadata.sessionId);
  const hasSessionId = Boolean(sessionId && sessionId.trim());
  if (!isClientInjectReady(metadata)) {
    logContinueExecution('skip_schema_due_client_inject_unready', { hasSessionId });
    return [];
  }
  const hasActiveStopMessage =
    options && typeof options.hasActiveStopMessage === 'boolean'
      ? options.hasActiveStopMessage
      : hasActiveStopMessageStateForContinueExecution(metadata);
  const plan =
    options?.precomputedPlan ??
    planContinueExecutionOperationsWithNative(rt as Record<string, unknown>, hasActiveStopMessage);
  const operations = buildContinueExecutionOperationsWithNative(Boolean(plan.shouldInject)) as HubOperation[];

  if (operations.length === 0) {
    if (hasActiveStopMessage) {
      logContinueExecution('skip_schema_due_stopmessage', { hasSessionId });
    }
    return [];
  }

  logContinueExecution('inject_schema', { hasSessionId });
  return operations;
}

export function injectContinueExecutionDirectiveIntoUserMessage(
  request: StandardizedRequest,
  metadata: Record<string, unknown>
): StandardizedRequest {
  const rt = (readRuntimeMetadata(metadata) ?? {}) as Record<string, unknown>;
  if (!isClientInjectReady(metadata)) {
    return request;
  }
  if ((rt as any)?.serverToolFollowup === true) {
    return request;
  }
  if (hasActiveStopMessageStateForContinueExecution(metadata)) {
    const sessionId = readString(metadata.sessionId);
    const hasSessionId = Boolean(sessionId && sessionId.trim());
    logContinueExecution('skip_user_directive_due_stopmessage', { hasSessionId });
    return request;
  }

  const messages = Array.isArray(request.messages) ? request.messages : [];
  if (messages.length === 0) {
    return request;
  }

  const injected = injectContinueExecutionDirectiveWithNative(
    messages,
    CONTINUE_EXECUTION_INJECTION_MARKER,
    CONTINUE_EXECUTION_INJECTION_TEXT
  );
  if (!injected.changed) {
    return request;
  }

  const sessionId = readString(metadata.sessionId);
  const hasSessionId = Boolean(sessionId && sessionId.trim());
  logContinueExecution('inject_user_directive', { hasSessionId });

  return {
    ...request,
    messages: injected.messages as StandardizedRequest['messages']
  };
}

function hasActiveStopMessageStateForContinueExecution(metadata: Record<string, unknown>): boolean {
  if (!isClientInjectReady(metadata)) {
    return false;
  }
  const persistedState = resolvePersistedStopMessageState(metadata);
  return isStopMessageStateActiveWithNative(persistedState);
}

export function resolveHasActiveStopMessageForContinueExecution(metadata: Record<string, unknown>): boolean {
  return hasActiveStopMessageStateForContinueExecution(metadata);
}

function resolvePersistedStopMessageState(metadata: Record<string, unknown>): unknown {
  const sessionScope = resolveStopMessageSessionScope(metadata);
  if (!sessionScope) {
    return undefined;
  }
  return loadRoutingInstructionStateSync(sessionScope);
}

function resolveStopMessageSessionScope(metadata: Record<string, unknown>): string | undefined {
  return resolveStopMessageSessionScopeWithNative(metadata);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
