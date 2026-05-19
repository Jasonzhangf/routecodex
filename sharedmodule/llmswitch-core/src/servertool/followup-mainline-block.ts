import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import type { StageRecorder } from '../conversion/hub/format-adapters/index.js';
import type { ServerToolExecution } from './types.js';
import { applyHubFollowupPolicyShadow } from './followup-shadow.js';
import {
  applyClientInjectOnlyMetadata,
  applyFollowupRuntimeMetadata,
  assertAutoLimitNotExceeded,
  materializeFollowupPayload,
  resolveFollowupExecutionMode,
  resolveFollowupAttemptCount,
  resolveFollowupEntryEndpoint,
  resolveLoopPayload
} from './followup-runtime-block.js';
import { evaluateStopMessageLoopGuard } from './stop-message-loop-guard-block.js';
import { runClientInjectOnlyFollowup } from './client-inject-followup-block.js';
import { runReenterFollowup } from './reenter-followup-block.js';
import { maybeRunTransparentBootstrapReplay } from './bootstrap-followup-replay-block.js';
import {
  decorateFinalChatWithServerToolContext,
  shouldShortCircuitRequiresActionFollowup
} from './finalize-followup-block.js';
import { buildServerToolLoopState } from './loop-state-block.js';
import {
  createClientDisconnectWatcher,
  createServerToolTimeoutError,
  createStopMessageFetchFailedError,
  isServerToolClientDisconnectedError,
  withTimeout
} from './timeout-error-block.js';
import {
  choosePreferredFinalChatResponse,
  coerceFollowupPayloadStream,
  createEmptyFollowupError,
  createMissingFollowupPayloadError,
  extractAppendUserTextFromFollowupPlan,
  hasRequiresActionShape,
  isEmptyClientResponsePayload
} from './followup-response-block.js';
import {
  applyFollowupDeltaPlan,
  loadFollowupOriginSeed
} from './followup-origin-delta.js';
import {
  appendStopMessageLoopWarning,
  buildStopMessageLoopPayload
} from './stop-message-loop-payload-block.js';
import {
  compactFollowupErrorReason,
  normalizeClientInjectText,
  readClientInjectOnly,
  resolveAdapterContextProviderKey
} from './orchestration-policy-block.js';
import { isAdapterClientDisconnected } from './timeout-error-block.js';
import { resolveFollowupFlowDecision } from './followup-flow-policy.js';
import { clearStopMessageState } from './handlers/stop-message-auto/routing-state.js';
import { resolveServertoolPersistentScopeKey } from './state-scope.js';
import {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateSync
} from '../router/virtual-router/sticky-session-store.js';

type OrchestrationResult = {
  chat: JsonObject;
  executed: true;
  flowId?: string;
};

function buildFollowupRequestId(baseRequestId: string, suffix?: string): string {
  const trimmedBase = typeof baseRequestId === 'string' && baseRequestId.trim() ? baseRequestId.trim() : 'servertool';
  const trimmedSuffix = typeof suffix === 'string' && suffix.trim() ? suffix.trim() : ':followup';
  return `${trimmedBase}${trimmedSuffix}`;
}

function appendLoopWarning(payload: JsonObject, repeatCountRaw: number, warnThreshold: number, failThreshold: number): void {
  appendStopMessageLoopWarning({
    payload,
    repeatCountRaw,
    warnThreshold,
    failThreshold
  });
}

function disableStopMessageAfterFailedFollowup(args: {
  adapterContext: AdapterContext;
  reservation: { stickyKey: string; previousState: Record<string, unknown> | null } | null;
  logNonBlocking: (stage: string, error: unknown) => void;
}): void {
  try {
    const key =
      args.reservation && typeof args.reservation.stickyKey === 'string' && args.reservation.stickyKey.trim()
        ? args.reservation.stickyKey.trim()
        : resolveServertoolPersistentScopeKey(args.adapterContext);
    if (!key) {
      return;
    }
    const state = loadRoutingInstructionStateSync(key);
    if (!state) {
      return;
    }
    clearStopMessageState(state, Date.now());
    state.stopMessageLastUsedAt = Date.now();
    saveRoutingInstructionStateSync(key, state);
  } catch (error) {
    args.logNonBlocking('disable_stop_message_after_failed_followup', error);
  }
}

export async function runFollowupMainline(args: {
  adapterContext: AdapterContext;
  requestId: string;
  entryEndpoint: string;
  followupTimeoutMs: number;
  execution: ServerToolExecution;
  finalChatResponse: JsonObject;
  flowId: string;
  totalSteps: number;
  stopMessageLoopWarnThreshold: number;
  stopMessageLoopFailThreshold: number;
  stageRecorder?: StageRecorder;
  reenterPipeline?: (options: {
    entryEndpoint: string;
    requestId: string;
    body?: JsonObject;
    metadata?: JsonObject;
  }) => Promise<{ body?: JsonObject; __sse_responses?: unknown; format?: string }>;
  clientInjectDispatch?: (options: {
    entryEndpoint: string;
    requestId: string;
    body?: JsonObject;
    metadata?: JsonObject;
  }) => Promise<{ ok: boolean; reason?: string }>;
  onLogProgress: (step: number, total: number, message: string, extra?: Record<string, unknown>) => void;
  logNonBlocking: (stage: string, error: unknown, details?: Record<string, unknown>) => void;
}): Promise<OrchestrationResult> {
  const decision = resolveFollowupFlowDecision(args.execution.flowId);
  if (decision.outcomeMode === 'skip' || decision.noFollowup || !args.execution.followup) {
    args.onLogProgress(5, args.totalSteps, 'completed (no followup)', { flowId: args.flowId });
    return {
      chat: args.finalChatResponse,
      executed: true,
      flowId: args.execution.flowId
    };
  }

  const isStopMessageFlow = args.execution.flowId === 'stop_message_flow';
  const followupPlan = args.execution.followup;
  const followupEntryEndpoint = resolveFollowupEntryEndpoint(args.execution.followup, args.entryEndpoint);
  let followupPayloadRaw: JsonObject | null =
    followupPlan && typeof followupPlan === 'object' && !Array.isArray(followupPlan) && 'payload' in followupPlan
      ? (((followupPlan as { payload?: unknown }).payload && typeof (followupPlan as { payload?: unknown }).payload === 'object' && !Array.isArray((followupPlan as { payload?: unknown }).payload))
        ? ((followupPlan as { payload: JsonObject }).payload)
        : null)
      : null;

  const loopPayload = resolveLoopPayload({
    flowId: args.execution.flowId,
    decision,
    followupPayloadRaw,
    buildSeedLoopPayload: () => buildStopMessageLoopPayload(args.adapterContext)
  });
  const loopState = loopPayload
    ? buildServerToolLoopState({
        adapterContext: args.adapterContext,
        flowId: args.execution.flowId,
        decision,
        payload: loopPayload,
        response: args.finalChatResponse,
        logNonBlocking: (stage, error) => args.logNonBlocking(stage, error)
      })
    : null;
  const disableStopMessageAfterFailedFollowupCompat = (
    adapterContext: AdapterContext,
    reservation: { stickyKey: string; previousState: Record<string, unknown> | null } | null
  ): void =>
    disableStopMessageAfterFailedFollowup({
      adapterContext,
      reservation,
      logNonBlocking: (stage, error) => args.logNonBlocking(stage, error)
    });

  try {
    assertAutoLimitNotExceeded({
      flowId: args.execution.flowId,
      decision,
      loopState,
      requestId: args.requestId
    });
  } catch (error) {
    args.onLogProgress(5, args.totalSteps, 'failed (auto limit hit; fail-fast)', { flowId: args.flowId });
    throw error;
  }

  let shouldInjectStopLoopWarning = false;
  if (isStopMessageFlow && loopState) {
    shouldInjectStopLoopWarning = evaluateStopMessageLoopGuard({
      loopState,
      warnThreshold: args.stopMessageLoopWarnThreshold,
      failThreshold: args.stopMessageLoopFailThreshold,
      onLoopLimit: (elapsedMs, repeatCount) => {
        throw createStopMessageFetchFailedError({
          requestId: args.requestId,
          reason: 'loop_limit',
          elapsedMs,
          repeatCount
        });
      }
    }).shouldInjectWarning;
    if (shouldInjectStopLoopWarning) {
      args.onLogProgress(2, args.totalSteps, 'loop warning armed', { flowId: args.flowId });
    }
  }

  if (isAdapterClientDisconnected(args.adapterContext)) {
    args.onLogProgress(5, args.totalSteps, 'completed (client disconnected)', { flowId: args.flowId });
    return {
      chat: args.finalChatResponse,
      executed: true,
      flowId: args.execution.flowId
    };
  }

  const metadata: JsonObject = {
    stream: false,
    ...(args.execution.followup.metadata ?? {})
  };
  const followupInjectionPlan =
    followupPlan && typeof followupPlan === 'object' && !Array.isArray(followupPlan) && 'injection' in followupPlan
      ? (((followupPlan as { injection?: unknown }).injection && typeof (followupPlan as { injection?: unknown }).injection === 'object' && !Array.isArray((followupPlan as { injection?: unknown }).injection))
        ? ((followupPlan as { injection: JsonObject }).injection)
        : null)
      : null;
  const forceTmuxClientInjectFollowup = applyClientInjectOnlyMetadata({
    flowId: args.execution.flowId,
    decision,
    metadata,
    defaultText: extractAppendUserTextFromFollowupPlan(followupPlan) ?? 'continue',
    readClientInjectOnly,
    normalizeClientInjectText
  }).forced;
  if (forceTmuxClientInjectFollowup) {
    followupPayloadRaw = null;
  }
  applyFollowupRuntimeMetadata({
    metadata,
    loopState,
    originalEntryEndpoint: args.entryEndpoint,
    followupEntryEndpoint,
    flowId: args.execution.flowId,
    decision,
    adapterContext: args.adapterContext,
    resolveProviderKey: resolveAdapterContextProviderKey
  });
  const maxAttempts = resolveFollowupAttemptCount(args.execution.flowId, decision);
  const retryEmptyFollowupOnce = maxAttempts > 1;
  const followupRequestId = buildFollowupRequestId(args.requestId, args.execution.followup.requestIdSuffix);
  const executionMode = resolveFollowupExecutionMode({
    flowId: args.execution.flowId,
    decision,
    metadata,
    readClientInjectOnly
  });
  if (followupInjectionPlan && executionMode === 'client_inject_only' && !followupPayloadRaw) {
    followupPayloadRaw = materializeFollowupPayload({
      followupPlan,
      buildInjectionPayload: (injection) => {
        const seed = loadFollowupOriginSeed(args.adapterContext);
        if (!seed) {
          return null;
        }
        return applyFollowupDeltaPlan({
          adapterContext: args.adapterContext,
          finalChatResponse: args.finalChatResponse,
          seed,
          injection: injection as any
        });
      }
    }).payload;
  }
  if (followupInjectionPlan && executionMode === 'reenter' && !followupPayloadRaw) {
    const seed = loadFollowupOriginSeed(args.adapterContext);
    const injection = JSON.parse(JSON.stringify(followupInjectionPlan)) as Record<string, unknown>;
    if (seed && shouldInjectStopLoopWarning) {
      const ops = Array.isArray(injection.ops) ? (injection.ops as Array<Record<string, unknown>>) : [];
      ops.push({
        op: 'inject_system_text',
        text: [
          `检测到 stopMessage 请求/响应参数已连续 ${loopState?.stopPairRepeatCount ?? args.stopMessageLoopWarnThreshold} 轮一致。`,
          '请立即尝试跳出循环（换路径、换验证方法、或直接给结论）。',
          `若继续达到 ${args.stopMessageLoopFailThreshold} 轮一致，将返回 fetch failed 网络错误并停止自动续跑。`
        ].join('\n')
      });
      injection.ops = ops;
    }
    if (seed) {
      followupPayloadRaw = applyFollowupDeltaPlan({
        adapterContext: args.adapterContext,
        finalChatResponse: args.finalChatResponse,
        seed,
        injection: injection as any
      });
    }
  }
  if (!followupPayloadRaw && executionMode === 'reenter' && !followupInjectionPlan) {
    args.onLogProgress(5, args.totalSteps, 'failed (missing followup payload; fail-fast)', { flowId: args.flowId });
    throw createMissingFollowupPayloadError({
      flowId: args.execution.flowId,
      requestId: args.requestId,
      followupPlan,
      adapterContext: args.adapterContext
    });
  }

  if (executionMode === 'client_inject_only') {
    const clientInjectResult = await runClientInjectOnlyFollowup({
      adapterContext: args.adapterContext,
      requestId: args.requestId,
      flowId: args.execution.flowId,
      followupEntryEndpoint,
      followupRequestId,
      followupPayloadRaw,
      metadata,
      followupTimeoutMs: args.followupTimeoutMs,
      isStopMessageFlow,
      shouldInjectStopLoopWarning,
      stopLoopWarnThreshold: args.stopMessageLoopWarnThreshold,
      loopState,
      finalChatResponse: args.finalChatResponse,
      execution: args.execution,
      clientInjectDispatch: args.clientInjectDispatch,
      coerceFollowupPayloadStream,
      appendStopMessageLoopWarning: (payload, repeatCountRaw) =>
        appendLoopWarning(
          payload,
          repeatCountRaw,
          args.stopMessageLoopWarnThreshold,
          args.stopMessageLoopFailThreshold
        ),
      createClientDisconnectWatcher,
      withTimeout,
      createServerToolTimeoutError,
      isServerToolClientDisconnectedError,
      isAdapterClientDisconnected,
      decorateFinalChatWithServerToolContext: (chat, execution) =>
        decorateFinalChatWithServerToolContext(chat, execution, decision),
      disableStopMessageAfterFailedFollowup: disableStopMessageAfterFailedFollowupCompat,
      stopMessageReservation: args.execution.stopMessageReservation ?? null,
      onLogProgress: (step, total, message, extra) => args.onLogProgress(step, total, message, extra)
    });
    if (clientInjectResult) {
      return clientInjectResult;
    }
  }

  const reenterResult = await runReenterFollowup({
    adapterContext: args.adapterContext,
    requestId: args.requestId,
    flowId: args.execution.flowId,
    followupEntryEndpoint,
    followupRequestId,
    followupPayloadRaw,
    metadata,
    followupTimeoutMs: args.followupTimeoutMs,
    maxAttempts,
    retryEmptyFollowupOnce,
    isStopMessageFlow,
    shouldInjectStopLoopWarning,
    stopLoopWarnThreshold: args.stopMessageLoopWarnThreshold,
    loopState,
    finalChatResponse: args.finalChatResponse,
    execution: args.execution,
    reenterPipeline: args.reenterPipeline,
    coerceFollowupPayloadStream,
    appendStopMessageLoopWarning: (payload, repeatCountRaw) =>
      appendLoopWarning(
        payload,
        repeatCountRaw,
        args.stopMessageLoopWarnThreshold,
        args.stopMessageLoopFailThreshold
      ),
    applyHubFollowupPolicyShadow,
    stageRecorder: args.stageRecorder,
    createClientDisconnectWatcher,
    withTimeout,
    createServerToolTimeoutError,
    createStopMessageFetchFailedError,
    isServerToolClientDisconnectedError,
    isAdapterClientDisconnected,
    disableStopMessageAfterFailedFollowup: disableStopMessageAfterFailedFollowupCompat,
    stopMessageReservation: args.execution.stopMessageReservation ?? null,
    compactFollowupErrorReason,
    isEmptyClientResponsePayload,
    createEmptyFollowupError,
    onLogProgress: (step, total, message, extra) => args.onLogProgress(step, total, message, extra)
  });
  if (reenterResult.kind === 'completed') {
    return reenterResult.result;
  }
  const followupBody = reenterResult.followupBody;

  if (shouldShortCircuitRequiresActionFollowup({
    flowId: args.execution.flowId,
    decision,
    followupBody,
    hasRequiresActionShape
  })) {
    const decorated = decorateFinalChatWithServerToolContext(args.finalChatResponse, args.execution, decision);
    args.onLogProgress(5, args.totalSteps, 'completed (stopMessage ignore requires_action reenter)', {
      flowId: args.flowId
    });
    return {
      chat: decorated,
      executed: true,
      flowId: args.execution.flowId
    };
  }

  const transparentReplayResult = await maybeRunTransparentBootstrapReplay({
    adapterContext: args.adapterContext,
    requestId: args.requestId,
    flowId: args.execution.flowId,
    decision,
    entryEndpoint: args.entryEndpoint,
    followupEntryEndpoint,
    followupTimeoutMs: args.followupTimeoutMs,
    followupBody,
    finalChatResponse: args.finalChatResponse,
    execution: args.execution,
    stageRecorder: args.stageRecorder,
    reenterPipeline: args.reenterPipeline,
    coerceFollowupPayloadStream,
    applyHubFollowupPolicyShadow,
    buildServerToolLoopState,
    resolveProviderKey: resolveAdapterContextProviderKey,
    withTimeout,
    createServerToolTimeoutError,
    choosePreferredFinalChatResponse,
    decorateFinalChatWithServerToolContext: (chat, execution) =>
      decorateFinalChatWithServerToolContext(chat, execution, decision),
    compactFollowupErrorReason,
    onLogProgress: (step, total, message, extra) => args.onLogProgress(step, total, message, extra)
  });
  if (transparentReplayResult) {
    return transparentReplayResult;
  }

  const decorated = decorateFinalChatWithServerToolContext(
    choosePreferredFinalChatResponse({
      followupBody,
      finalChatResponse: args.finalChatResponse
    }),
    args.execution,
    decision
  );

  args.onLogProgress(5, args.totalSteps, 'completed', { flowId: args.flowId });
  return {
    chat: decorated,
    executed: true,
    flowId: args.execution.flowId
  };
}
