import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import type { StageRecorder } from '../conversion/hub/format-adapters/index.js';
import type { ServerToolExecution } from './types.js';
import { applyHubFollowupPolicyShadow } from './backend-route-shadow.js';
import {
  applyClientInjectOnlyMetadata,
  applyFollowupRuntimeMetadata,
  assertAutoLimitNotExceeded,
  materializeFollowupInjectionPayload,
  planFollowupMaterialization,
  resolveFollowupRuntimeActionPlan,
  resolveFollowupExecutionMode,
  resolveLoopPayload
} from './backend-route-runtime-block.js';
import { evaluateStopMessageLoopGuard } from './stop-message-loop-guard-block.js';
import { runClientInjectOnlyFollowup } from './backend-route-client-inject-block.js';
import { runReenterFollowup } from './backend-route-reenter-block.js';
import { maybeRunTransparentBootstrapReplay } from './backend-route-bootstrap-replay-block.js';
import {
  decorateFinalChatWithServerToolContext,
  shouldShortCircuitRequiresActionFollowup
} from './backend-route-finalize-block.js';
import { buildServerToolLoopState } from './loop-state-block.js';
import { inspectStopGatewaySignal } from './stop-gateway-context.js';
import { applyStopMessageFinishReasonBudget } from './stop-message-counter.js';
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
} from './backend-route-response-block.js';
import {
  applyFollowupDeltaPlan,
  loadFollowupOriginSeed
} from './backend-route-origin-delta.js';
import { buildStopMessageLoopPayload } from './stop-message-loop-payload-block.js';
import {
  buildFollowupRequestIdWithNative,
  injectLoopWarningWithNative,
  decideBudgetResetWithNative
} from '../native/router-hotpath/native-followup-mainline-semantics.js';
import {
  compactFollowupErrorReason,
  normalizeClientInjectText
} from './orchestration-policy-block.js';
import { isAdapterClientDisconnected } from './timeout-error-block.js';
import { resolveFollowupFlowDecision } from './backend-route-flow-policy.js';
import { clearStopMessageState } from './handlers/stop-message-auto/routing-state.js';
import { resolveServertoolPersistentScopeKey } from './state-scope.js';
import {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateSync
} from '../native/router-hotpath/native-virtual-router-routing-state.js';

function recordServertoolFollowupStage(
  stageRecorder: StageRecorder | undefined,
  stage: string,
  payload: Record<string, unknown>,
  onError: (stage: string, error: unknown) => void
): void {
  if (!stageRecorder) {
    return;
  }
  try {
    stageRecorder.record(stage, payload);
  } catch (error) {
    onError(stage, error);
  }
}

type OrchestrationResult = {
  chat: JsonObject;
  executed: true;
  flowId?: string;
};

function buildFollowupRequestId(baseRequestId: string, suffix?: string): string {
  return buildFollowupRequestIdWithNative(baseRequestId, suffix ?? null);
}

function appendLoopWarning(payload: JsonObject, repeatCountRaw: number, warnThreshold: number, failThreshold: number): void {
  const messages = Array.isArray((payload as Record<string, unknown>).messages)
    ? ((payload as Record<string, unknown>).messages as Array<{ role: string; content: string }>)
    : [];
  const result = injectLoopWarningWithNative({
    messages,
    repeat_count: repeatCountRaw,
    warn_threshold: warnThreshold,
    fail_threshold: failThreshold
  });
  (payload as Record<string, unknown>).messages = result as any;
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

function resetStopMessageBudgetAfterNonStopFollowup(args: {
  adapterContext: AdapterContext;
  followupBody: JsonObject;
}): void {
  const stopSignal = inspectStopGatewaySignal(args.followupBody);
  const decision = decideBudgetResetWithNative(
    stopSignal.observed,
    stopSignal.eligible,
    0  // currentUsed handled by applyStopMessageFinishReasonBudget internally
  );
  if (!decision.should_reset) {
    return;
  }
  applyStopMessageFinishReasonBudget({
    payload: args.followupBody,
    adapterContext: args.adapterContext
  });
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
  }) => Promise<{ body?: JsonObject; sseStream?: unknown; format?: string }>;
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

  const isStopMessageFlow = resolveFollowupRuntimeActionPlan({
    flowId: args.execution.flowId,
    decision,
    metadataClientInjectOnly: false,
    hasFollowupPayloadRaw: false
  }).isStopMessageFlow;
  const followupPlan = args.execution.followup;
  const followupMaterialization = planFollowupMaterialization({
    followupPlan,
    entryEndpoint: args.entryEndpoint
  });
  const followupEntryEndpoint = followupMaterialization.entryEndpoint;
  let followupPayloadRaw: JsonObject | null = (followupMaterialization.payload ?? null) as JsonObject | null;

  const loopPayload = resolveLoopPayload({
    flowId: args.execution.flowId,
    decision,
    followupPayloadRaw,
    buildSeedLoopPayload: () => buildStopMessageLoopPayload(args.adapterContext)
  });
  if (!followupPayloadRaw && loopPayload && decision.seedLoopPayload) {
    followupPayloadRaw = loopPayload;
  }
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
    throw Object.assign(new Error(`[servertool] client disconnected during followup${args.flowId ? ` flow=${args.flowId}` : ''}`), {
      code: 'SERVERTOOL_CLIENT_DISCONNECTED',
      details: { requestId: args.requestId, flowId: args.flowId }
    });
  }

  const metadata: JsonObject = {
    ...(args.execution.followup.metadata ?? {})
  };
  const followupInjectionPlan = (followupMaterialization.injection ?? null) as JsonObject | null;
  const forceTmuxClientInjectFollowup = applyClientInjectOnlyMetadata({
    flowId: args.execution.flowId,
    decision,
    metadata,
    defaultText: extractAppendUserTextFromFollowupPlan(followupPlan),
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
    adapterContext: args.adapterContext
  });
  const followupRequestId = buildFollowupRequestId(args.requestId, args.execution.followup.requestIdSuffix);
  const executionMode = resolveFollowupExecutionMode({
    flowId: args.execution.flowId,
    decision,
    metadata
  });
  if (followupInjectionPlan && executionMode === 'client_inject_only' && !followupPayloadRaw) {
    followupPayloadRaw = materializeFollowupInjectionPayload({
      injection: followupInjectionPlan,
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
    });
  }
  if (followupInjectionPlan && executionMode === 'reenter') {
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

  recordServertoolFollowupStage(
    args.stageRecorder,
    'servertool.followup.request',
    {
      flowId: args.execution.flowId,
      requestId: args.requestId,
      followupRequestId,
      executionMode,
      followupEntryEndpoint,
      metadata,
      payload: followupPayloadRaw,
      clientInjectOnly: executionMode === 'client_inject_only'
    },
    (stage, error) => args.logNonBlocking('record_' + stage.replace(/[^a-z0-9]+/gi, '_'), error)
  );

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
      clearStateOnFollowupFailure: decision.clearStateOnFollowupFailure,
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
      recordServertoolFollowupStage(
        args.stageRecorder,
        'servertool.followup.result',
        {
          flowId: args.execution.flowId,
          requestId: args.requestId,
          followupRequestId,
          executionMode,
          completed: true,
          result: clientInjectResult
        },
        (stage, error) => args.logNonBlocking('record_' + stage.replace(/[^a-z0-9]+/gi, '_'), error)
      );
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
    isStopMessageFlow,
    clearStateOnFollowupFailure: decision.clearStateOnFollowupFailure,
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
    recordServertoolFollowupStage(
      args.stageRecorder,
      'servertool.followup.result',
      {
        flowId: args.execution.flowId,
        requestId: args.requestId,
        followupRequestId,
        executionMode,
        completed: true,
        result: reenterResult.result
      },
      (stage, error) => args.logNonBlocking('record_' + stage.replace(/[^a-z0-9]+/gi, '_'), error)
    );
    return reenterResult.result;
  }
  const followupBody = reenterResult.followupBody;
  recordServertoolFollowupStage(
    args.stageRecorder,
    'hub_followup.response',
    {
      flowId: args.execution.flowId,
      requestId: args.requestId,
      followupRequestId,
      executionMode,
      followupEntryEndpoint,
      body: followupBody
    },
    (stage, error) => args.logNonBlocking('record_' + stage.replace(/[^a-z0-9]+/gi, '_'), error)
  );
  resetStopMessageBudgetAfterNonStopFollowup({
    adapterContext: args.adapterContext,
    followupBody
  });

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
