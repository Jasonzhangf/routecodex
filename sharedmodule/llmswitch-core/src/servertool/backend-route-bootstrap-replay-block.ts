import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import type { StageRecorder } from '../conversion/hub/format-adapters/index.js';
import { ProviderProtocolError } from '../conversion/provider-protocol-error.js';
import { applyFollowupRuntimeMetadata } from './backend-route-runtime-block.js';
import { resolveFollowupFlowDecision, type FollowupFlowDecision } from './backend-route-flow-policy.js';
import { extractCapturedChatSeed } from './backend-route-seed.js';
import { buildFollowupRequestIdWithNative } from '../native/router-hotpath/native-followup-mainline-semantics.js';
import {
  planBootstrapReplayWithNative,
  type ServertoolBootstrapReplayPlan
} from '../native/router-hotpath/native-servertool-core-semantics.js';

function buildFollowupRequestId(baseRequestId: string, suffix?: string): string {
  return buildFollowupRequestIdWithNative(baseRequestId, suffix ?? null);
}

export function createBootstrapPreflightFailedError(args: {
  requestId: string;
  flowId?: string;
  failure: NonNullable<ServertoolBootstrapReplayPlan['preflightFailure']>;
  compactFollowupErrorReason: (value: unknown) => string | undefined;
}): ProviderProtocolError & { status?: number; statusCode?: number; upstreamCode?: string } {
  const compactReason = args.compactFollowupErrorReason(args.failure.reason);
  const wrapped = new ProviderProtocolError('[servertool] bootstrap preflight failed', {
    code: 'SERVERTOOL_FOLLOWUP_FAILED',
    category: 'EXTERNAL_ERROR',
    details: {
      requestId: args.requestId,
      flowId: args.flowId,
      upstreamCode: args.failure.code,
      ...(typeof args.failure.status === 'number'
        ? { status: args.failure.status, statusCode: args.failure.status }
        : {}),
      ...(compactReason ? { reason: compactReason } : {})
    }
  }) as ProviderProtocolError & { status?: number; statusCode?: number; upstreamCode?: string };
  if (typeof args.failure.status === 'number') {
    wrapped.status = args.failure.status;
    wrapped.statusCode = args.failure.status;
  }
  wrapped.upstreamCode = args.failure.code;
  return wrapped;
}

export async function maybeRunTransparentBootstrapReplay(args: {
  adapterContext: AdapterContext;
  requestId: string;
  flowId: string | undefined;
  decision?: FollowupFlowDecision;
  entryEndpoint: string;
  followupEntryEndpoint: string;
  followupTimeoutMs: number;
  followupBody?: JsonObject;
  finalChatResponse: JsonObject;
  execution: { flowId: string; context?: JsonObject } | undefined;
  stageRecorder?: StageRecorder;
  reenterPipeline?: (options: {
    entryEndpoint: string;
    requestId: string;
    body?: JsonObject;
    metadata?: JsonObject;
  }) => Promise<{ body?: JsonObject; __sse_responses?: unknown; format?: string }>;
  coerceFollowupPayloadStream: (payload: JsonObject, stream: boolean) => JsonObject;
  applyHubFollowupPolicyShadow: (args: {
    requestId: string;
    entryEndpoint: string;
    flowId?: string;
    payload: JsonObject;
    stageRecorder?: StageRecorder;
  }) => JsonObject;
  buildServerToolLoopState: (args: {
    adapterContext: AdapterContext;
    flowId: string | undefined;
    payload: JsonObject;
    response?: JsonObject;
    logNonBlocking: (stage: string, error: unknown) => void;
  }) => {
    startedAtMs?: number;
    stopPairRepeatCount?: number;
    repeatCount?: number;
    stopPairWarned?: boolean;
    flowId?: string;
    payloadHash?: string;
    stopPairHash?: string;
  } | null;
  withTimeout: <T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => Error) => Promise<T>;
  createServerToolTimeoutError: (options: {
    requestId: string;
    phase: 'engine' | 'followup';
    timeoutMs: number;
    flowId?: string;
    attempt?: number;
    maxAttempts?: number;
  }) => Error;
  choosePreferredFinalChatResponse: (args: {
    followupBody?: JsonObject;
    finalChatResponse: JsonObject;
  }) => JsonObject;
  decorateFinalChatWithServerToolContext: (
    chat: JsonObject,
    execution: { flowId: string; context?: JsonObject } | undefined
  ) => JsonObject;
  compactFollowupErrorReason: (value: unknown) => string | undefined;
  onLogProgress: (step: number, total: number, message: string, extra?: Record<string, unknown>) => void;
}): Promise<{ chat: JsonObject; executed: true; flowId?: string } | null> {
  const decision = args.decision ?? resolveFollowupFlowDecision(args.flowId);
  const replayRequestSuffix = decision.transparentReplayRequestSuffix;
  if (!replayRequestSuffix || !args.reenterPipeline || !args.execution?.flowId) {
    return null;
  }

  const preflight = args.followupBody;
  const replaySeed = extractCapturedChatSeed((args.adapterContext as any)?.capturedChatRequest);
  const replayPlan = planBootstrapReplayWithNative({
    preflightBody: preflight ?? null,
    replaySeed: replaySeed ?? null
  });
  if (replayPlan.preflightFailure) {
    throw createBootstrapPreflightFailedError({
      requestId: args.requestId,
      flowId: args.execution.flowId,
      failure: replayPlan.preflightFailure,
      compactFollowupErrorReason: args.compactFollowupErrorReason
    });
  }

  const replayPayload = replayPlan.replayPayload as JsonObject | null | undefined;
  if (!replayPayload) {
    return null;
  }

  const replayMetadata: JsonObject = { stream: false };
  const replayLoopState = args.buildServerToolLoopState({
    adapterContext: args.adapterContext,
    flowId: args.execution.flowId,
    payload: replayPayload,
    logNonBlocking: () => {}
  });
  applyFollowupRuntimeMetadata({
    metadata: replayMetadata,
    loopState: replayLoopState,
    originalEntryEndpoint: args.entryEndpoint,
    followupEntryEndpoint: args.followupEntryEndpoint,
    flowId: args.execution.flowId,
    decision,
    adapterContext: args.adapterContext
  });

  const replayRequestId = buildFollowupRequestId(args.requestId, replayRequestSuffix);
  const replayPayloadFinal = args.applyHubFollowupPolicyShadow({
    requestId: replayRequestId,
    entryEndpoint: args.followupEntryEndpoint,
    flowId: args.execution.flowId,
    payload: args.coerceFollowupPayloadStream(replayPayload, false),
    stageRecorder: args.stageRecorder
  });

  const replayResult = await args.withTimeout(
    args.reenterPipeline({
      entryEndpoint: args.followupEntryEndpoint,
      requestId: replayRequestId,
      body: replayPayloadFinal,
      metadata: replayMetadata
    }),
    args.followupTimeoutMs,
    () =>
      args.createServerToolTimeoutError({
        requestId: args.requestId,
        phase: 'followup',
        timeoutMs: args.followupTimeoutMs,
        flowId: args.execution.flowId
      })
  );

  const replayBody =
    replayResult && replayResult.body && typeof replayResult.body === 'object'
      ? (replayResult.body as JsonObject)
      : undefined;
  const decorated = args.decorateFinalChatWithServerToolContext(
    args.choosePreferredFinalChatResponse({
      followupBody: replayBody ?? preflight,
      finalChatResponse: args.finalChatResponse
    }),
    args.execution
  );
  args.onLogProgress(5, 5, 'completed (bootstrap replay)', { flowId: args.execution.flowId });
  return { chat: decorated, executed: true, flowId: args.execution.flowId };
}
