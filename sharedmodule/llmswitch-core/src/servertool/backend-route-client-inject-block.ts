import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import { ProviderProtocolError } from '../conversion/provider-protocol-error.js';

type ClientInjectDispatch = (options: {
  entryEndpoint: string;
  requestId: string;
  body?: JsonObject;
  metadata?: JsonObject;
}) => Promise<{
  ok: boolean;
  reason?: string;
}>;

export async function runClientInjectOnlyFollowup(args: {
  adapterContext: AdapterContext;
  requestId: string;
  flowId: string | undefined;
  followupEntryEndpoint: string;
  followupRequestId: string;
  followupPayloadRaw: JsonObject | null;
  metadata: JsonObject;
  followupTimeoutMs: number;
  isStopMessageFlow: boolean;
  clearStateOnFollowupFailure: boolean;
  shouldInjectStopLoopWarning: boolean;
  stopLoopWarnThreshold: number;
  loopState: { stopPairRepeatCount?: number } | null;
  finalChatResponse: JsonObject;
  execution: { flowId: string; context?: JsonObject } | undefined;
  clientInjectDispatch?: ClientInjectDispatch;
  coerceFollowupPayloadStream: (payload: JsonObject, stream: boolean) => JsonObject;
  appendStopMessageLoopWarning: (payload: JsonObject, repeatCountRaw: number) => void;
  createClientDisconnectWatcher: (options: {
    adapterContext: AdapterContext;
    requestId: string;
    flowId?: string;
  }) => { promise: Promise<never>; cancel: () => void };
  withTimeout: <T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => Error) => Promise<T>;
  createServerToolTimeoutError: (options: {
    requestId: string;
    phase: 'engine' | 'followup';
    timeoutMs: number;
    flowId?: string;
  }) => Error;
  isServerToolClientDisconnectedError: (error: unknown) => boolean;
  isAdapterClientDisconnected: (adapterContext: AdapterContext) => boolean;
  decorateFinalChatWithServerToolContext: (
    chat: JsonObject,
    execution: { flowId: string; context?: JsonObject } | undefined
  ) => JsonObject;
  disableStopMessageAfterFailedFollowup: (
    adapterContext: AdapterContext,
    reservation: { stickyKey: string; previousState: Record<string, unknown> | null } | null
  ) => void;
  stopMessageReservation: { stickyKey: string; previousState: Record<string, unknown> | null } | null;
  onLogProgress: (step: number, total: number, message: string, extra?: Record<string, unknown>) => void;
}): Promise<{ chat: JsonObject; executed: true; flowId?: string } | null> {
  if (!args.clientInjectDispatch) {
    if (args.clearStateOnFollowupFailure) {
      args.disableStopMessageAfterFailedFollowup(args.adapterContext, args.stopMessageReservation);
      args.onLogProgress(5, 5, 'failed (client inject dispatcher unavailable; state cleared)', {
        flowId: args.flowId
      });
    }
    const wrapped = new ProviderProtocolError('[servertool] client inject dispatcher unavailable', {
      code: 'SERVERTOOL_FOLLOWUP_FAILED',
      category: 'INTERNAL_ERROR',
      details: {
        flowId: args.flowId,
        requestId: args.requestId,
        upstreamCode: 'client_inject_failed',
        reason: 'client_inject_dispatcher_unavailable'
      }
    }) as ProviderProtocolError & { status?: number };
    wrapped.status = 502;
    throw wrapped;
  }

  const disconnectWatcher = args.createClientDisconnectWatcher({
    adapterContext: args.adapterContext,
    requestId: args.requestId,
    flowId: args.flowId
  });
  try {
    const injectFollowupBody: JsonObject =
      args.isStopMessageFlow
        ? {}
        : (args.followupPayloadRaw && typeof args.followupPayloadRaw === 'object' && !Array.isArray(args.followupPayloadRaw)
          ? args.coerceFollowupPayloadStream(args.followupPayloadRaw, args.metadata.stream === true)
          : ({} as JsonObject));
    if (args.isStopMessageFlow && args.shouldInjectStopLoopWarning && args.loopState) {
      (injectFollowupBody as Record<string, unknown>).messages = [];
      args.appendStopMessageLoopWarning(
        injectFollowupBody,
        args.loopState.stopPairRepeatCount ?? args.stopLoopWarnThreshold
      );
    }
    const dispatchResult = await args.withTimeout(
      Promise.race([
        args.clientInjectDispatch({
          entryEndpoint: args.followupEntryEndpoint,
          requestId: args.followupRequestId,
          body: injectFollowupBody,
          metadata: args.metadata
        }),
        disconnectWatcher.promise
      ]),
      args.followupTimeoutMs,
      () =>
        args.createServerToolTimeoutError({
          requestId: args.requestId,
          phase: 'followup',
          timeoutMs: args.followupTimeoutMs,
          flowId: args.flowId
        })
    );
    if (!dispatchResult || dispatchResult.ok !== true) {
      const wrapped = new ProviderProtocolError('[servertool.inject] client injection failed', {
        code: 'SERVERTOOL_FOLLOWUP_FAILED',
        details: {
          flowId: args.flowId,
          requestId: args.requestId,
          upstreamCode: 'client_inject_failed',
          reason:
            dispatchResult && typeof dispatchResult.reason === 'string' && dispatchResult.reason.trim()
              ? dispatchResult.reason.trim()
              : 'client_inject_not_handled'
        }
      }) as ProviderProtocolError & { status?: number };
      wrapped.status = 502;
      throw wrapped;
    }
    disconnectWatcher.cancel();
    args.onLogProgress(5, 5, 'completed (client inject only)', { flowId: args.flowId });
    return {
      chat: args.decorateFinalChatWithServerToolContext(args.finalChatResponse, args.execution),
      executed: true,
      flowId: args.flowId
    };
  } catch (error) {
    disconnectWatcher.cancel();
    if (args.isServerToolClientDisconnectedError(error) || args.isAdapterClientDisconnected(args.adapterContext)) {
      throw error;
    }
    if (args.clearStateOnFollowupFailure) {
      args.disableStopMessageAfterFailedFollowup(args.adapterContext, args.stopMessageReservation);
      args.onLogProgress(5, 5, 'failed (stopMessage client inject failed; state cleared)', { flowId: args.flowId });
    }
    throw error;
  }
}
