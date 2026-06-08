import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import type { StageRecorder } from '../conversion/hub/format-adapters/index.js';
import { ProviderProtocolError } from '../conversion/provider-protocol-error.js';
import { applyFollowupRuntimeMetadata } from './backend-route-runtime-block.js';
import { resolveFollowupFlowDecision, type FollowupFlowDecision } from './backend-route-flow-policy.js';
import { extractCapturedChatSeed } from './backend-route-seed.js';
import { buildFollowupRequestIdWithNative } from '../native/router-hotpath/native-followup-mainline-semantics.js';

function buildFollowupRequestId(baseRequestId: string, suffix?: string): string {
  return buildFollowupRequestIdWithNative(baseRequestId, suffix ?? null);
}

export function createBootstrapPreflightFailedError(args: {
  requestId: string;
  flowId?: string;
  status?: number;
  code?: string;
  reason?: string;
  compactFollowupErrorReason: (value: unknown) => string | undefined;
}): ProviderProtocolError & { status?: number; statusCode?: number; upstreamCode?: string } {
  const compactReason = args.compactFollowupErrorReason(args.reason);
  const code =
    typeof args.code === 'string' && args.code.trim()
      ? args.code.trim()
      : (typeof args.status === 'number' ? `HTTP_${args.status}` : 'SERVERTOOL_FOLLOWUP_FAILED');
  const wrapped = new ProviderProtocolError('[servertool] bootstrap preflight failed', {
    code: 'SERVERTOOL_FOLLOWUP_FAILED',
    category: 'EXTERNAL_ERROR',
    details: {
      requestId: args.requestId,
      flowId: args.flowId,
      upstreamCode: code,
      ...(typeof args.status === 'number' ? { status: args.status, statusCode: args.status } : {}),
      ...(compactReason ? { reason: compactReason } : {})
    }
  }) as ProviderProtocolError & { status?: number; statusCode?: number; upstreamCode?: string };
  if (typeof args.status === 'number') {
    wrapped.status = args.status;
    wrapped.statusCode = args.status;
  }
  wrapped.upstreamCode = code;
  return wrapped;
}

function readPreflightStatus(preflightError: unknown): number | undefined {
  if (!preflightError || typeof preflightError !== 'object' || Array.isArray(preflightError)) {
    return undefined;
  }
  const statusRaw = (preflightError as any).status ?? (preflightError as any).statusCode;
  if (typeof statusRaw === 'number' && Number.isFinite(statusRaw)) {
    return Math.floor(statusRaw);
  }
  const codeRaw = (preflightError as any).code;
  const code = typeof codeRaw === 'string' ? codeRaw.trim() : typeof codeRaw === 'number' ? String(codeRaw) : '';
  if (code && /^HTTP_\d{3}$/i.test(code)) {
    return Number(code.split('_')[1]);
  }
  if (code && /^\d{3}$/.test(code)) {
    return Number(code);
  }
  return undefined;
}

function buildReplayPayload(seed: ReturnType<typeof extractCapturedChatSeed>): JsonObject | null {
  if (!seed) {
    return null;
  }
  return {
    ...(seed.model ? { model: seed.model } : {}),
    messages: Array.isArray(seed.messages) ? (seed.messages as JsonObject[]) : [],
    ...(Array.isArray(seed.tools) ? { tools: seed.tools as JsonObject[] } : {}),
    ...(seed.parameters && typeof seed.parameters === 'object' && !Array.isArray(seed.parameters)
      ? { parameters: seed.parameters as JsonObject }
      : {})
  };
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
  resolveProviderKey: (adapterContext: AdapterContext) => string;
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
  const preflightError = preflight && typeof (preflight as any).error === 'object' ? (preflight as any).error : null;
  const preflightStatus = readPreflightStatus(preflightError);
  if (preflightError && (preflightStatus === 429 || preflightStatus === 400)) {
    const preflightCodeRaw = (preflightError as any).code;
    const preflightCode =
      typeof preflightCodeRaw === 'string' && preflightCodeRaw.trim()
        ? preflightCodeRaw.trim()
        : (typeof preflightStatus === 'number' ? `HTTP_${preflightStatus}` : undefined);
    const preflightReasonRaw = (preflightError as any).message;
    const preflightReason =
      typeof preflightReasonRaw === 'string' && preflightReasonRaw.trim()
        ? preflightReasonRaw.trim()
        : undefined;
    throw createBootstrapPreflightFailedError({
      requestId: args.requestId,
      flowId: args.execution.flowId,
      status: preflightStatus,
      code: preflightCode,
      reason: preflightReason,
      compactFollowupErrorReason: args.compactFollowupErrorReason
    });
  }

  const replaySeed = extractCapturedChatSeed((args.adapterContext as any)?.capturedChatRequest);
  const replayPayload = buildReplayPayload(replaySeed);
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
    adapterContext: args.adapterContext,
    resolveProviderKey: args.resolveProviderKey
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
