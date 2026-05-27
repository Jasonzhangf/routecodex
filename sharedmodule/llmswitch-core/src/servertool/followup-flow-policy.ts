import { planServertoolFollowupRuntimeWithNative } from '../router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js';
import type { FollowupFlowDecision } from '../router/virtual-router/engine-selection/native-followup-mainline-semantics.js';
export type { FollowupFlowDecision } from '../router/virtual-router/engine-selection/native-followup-mainline-semantics.js';

function normalizeFlowId(flowId: unknown): string {
  return typeof flowId === 'string' ? flowId.trim() : '';
}

type FlowRuntimePlan = ReturnType<typeof planServertoolFollowupRuntimeWithNative>;

function resolveFlowRuntimePlan(flowId: unknown): FlowRuntimePlan | undefined {
  const normalized = normalizeFlowId(flowId);
  if (!normalized) {
    return undefined;
  }
  return planServertoolFollowupRuntimeWithNative(normalized);
}

export function resolveFollowupFlowDecision(flowId: unknown): FollowupFlowDecision {
  const normalized = normalizeFlowId(flowId);
  const plan = normalized ? resolveFlowRuntimePlan(normalized) : undefined;
  return {
    ...(normalized ? { flowId: normalized } : {}),
    outcomeMode: plan?.outcomeMode ?? 'reenter',
    noFollowup: plan?.noFollowup === true,
    autoLimit: plan?.autoLimit === true,
    flowOnlyLoopLimit: plan?.flowOnlyLoopLimit === true,
    stickyProvider: plan?.stickyProvider === true,
    clientInjectOnly: plan?.clientInjectOnly === true,
    clearStateOnFollowupFailure: plan?.clearStateOnFollowupFailure === true,
    seedLoopPayload: plan?.seedLoopPayload === true,
    retryEmptyFollowupOnce: plan?.retryEmptyFollowupOnce === true,
    ...(plan?.clientInjectSource ? { clientInjectSource: plan.clientInjectSource } : {}),
    ...(plan?.transparentReplayRequestSuffix
      ? { transparentReplayRequestSuffix: plan.transparentReplayRequestSuffix }
      : {}),
    ignoreRequiresActionFollowup: plan?.ignoreRequiresActionFollowup === true,
    ...(plan?.contextDecorationMode ? { contextDecorationMode: plan.contextDecorationMode } : {})
  };
}

export function isNoFollowupFlowId(flowId: unknown): boolean {
  return resolveFollowupFlowDecision(flowId).noFollowup;
}

export function isAutoLimitFlowId(flowId: unknown): boolean {
  return resolveFollowupFlowDecision(flowId).autoLimit;
}

export function isFlowOnlyLoopLimitFlowId(flowId: unknown): boolean {
  return resolveFollowupFlowDecision(flowId).flowOnlyLoopLimit;
}

export function isStickyProviderFollowupFlowId(flowId: unknown): boolean {
  return resolveFollowupFlowDecision(flowId).stickyProvider;
}

export function isClientInjectOnlyFollowupFlowId(flowId: unknown): boolean {
  return resolveFollowupFlowDecision(flowId).clientInjectOnly;
}

export function isSeedLoopPayloadFollowupFlowId(flowId: unknown): boolean {
  return resolveFollowupFlowDecision(flowId).seedLoopPayload;
}

export function shouldRetryEmptyFollowupOnce(flowId: unknown): boolean {
  return resolveFollowupFlowDecision(flowId).retryEmptyFollowupOnce;
}

export function resolveClientInjectSourceForFlowId(flowId: unknown): string | undefined {
  const source = resolveFollowupFlowDecision(flowId).clientInjectSource;
  return typeof source === 'string' && source.trim() ? source.trim() : undefined;
}

export function resolveTransparentReplayRequestSuffixForFlowId(flowId: unknown): string | undefined {
  const suffix = resolveFollowupFlowDecision(flowId).transparentReplayRequestSuffix;
  return typeof suffix === 'string' && suffix.trim() ? suffix.trim() : undefined;
}

export function shouldIgnoreRequiresActionFollowup(flowId: unknown): boolean {
  return resolveFollowupFlowDecision(flowId).ignoreRequiresActionFollowup;
}

export function resolveContextDecorationModeForFlowId(
  flowId: unknown
): 'continue_execution_summary' | 'web_search_summary' | undefined {
  const mode = resolveFollowupFlowDecision(flowId).contextDecorationMode;
  return mode === 'continue_execution_summary' || mode === 'web_search_summary' ? mode : undefined;
}
