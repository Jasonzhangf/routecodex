import type { PipelineExecutionInput } from '../../../handlers/types.js';
import { registerRequestLogContext } from '../../../utils/request-log-color.js';
import { getClientConnectionAbortSignal } from '../../../utils/client-connection-state.js';
import { buildRequestMetadata, cloneClientHeaders, resolveClientRequestId } from '../executor-metadata.js';
import { readRuntimeRequestTruthIdentifiers } from '../metadata-center/request-truth-readers.js';
import { bindSessionConversationSession } from './request-retry-helpers.js';
import { writeInboundClientSnapshot } from './request-executor-core-utils.js';
import {
  peekSessionStormBackoffWaitMs,
  resolveSessionStormBackoffScopes,
  waitSessionStormBackoffWithGate
} from './request-executor-retry-planner.js';

export type RequestExecutorInitialRequestState = {
  initialMetadata: Record<string, unknown>;
  inboundClientHeaders: Record<string, string> | undefined;
  providerRequestId: string;
  clientRequestId: string;
  sessionStormBackoffScopes?: string[];
};

export async function initializeRequestExecutorRequestState(args: {
  input: PipelineExecutionInput;
  logStage: (stage: string, requestId: string, details?: Record<string, unknown>) => void;
  onRequestStart?: (args: { requestId: string; metadata: Record<string, unknown> }) => void | Promise<void>;
  logNonBlockingError: (stage: string, error: unknown, details?: Record<string, unknown>) => void;
}): Promise<RequestExecutorInitialRequestState> {
  const initialMetadata = buildRequestMetadata(args.input);
  await args.onRequestStart?.({ requestId: args.input.requestId, metadata: initialMetadata });

  bindSessionConversationSession(initialMetadata);
  const requestTruth = readRuntimeRequestTruthIdentifiers(initialMetadata);
  registerRequestLogContext(args.input.requestId, {
    logSessionColorKey: initialMetadata.logSessionColorKey,
    clientTmuxSessionId: initialMetadata.clientTmuxSessionId,
    client_tmux_session_id: initialMetadata.client_tmux_session_id,
    tmuxSessionId: initialMetadata.tmuxSessionId,
    tmux_session_id: initialMetadata.tmux_session_id,
    sessionId: requestTruth.sessionId,
    session_id: requestTruth.sessionId,
    conversationId: requestTruth.conversationId,
    conversation_id: requestTruth.conversationId
  });

  const inboundClientHeaders = cloneClientHeaders(initialMetadata?.clientHeaders);
  const providerRequestId = args.input.requestId;
  const clientRequestId = resolveClientRequestId(initialMetadata, providerRequestId);
  const sessionStormBackoffScopes = resolveSessionStormBackoffScopes(initialMetadata);
  for (const scope of sessionStormBackoffScopes) {
    const pendingSessionStormWaitMs = peekSessionStormBackoffWaitMs(scope);
    if (!(pendingSessionStormWaitMs > 0)) {
      continue;
    }
    args.logStage('request.session_storm_backoff_wait', providerRequestId, {
      scope,
      waitMs: pendingSessionStormWaitMs
    });
    await waitSessionStormBackoffWithGate(
      scope,
      pendingSessionStormWaitMs,
      getClientConnectionAbortSignal(initialMetadata),
      args.logNonBlockingError
    );
    args.logStage('request.session_storm_backoff_wait.completed', providerRequestId, {
      scope,
      waitMs: pendingSessionStormWaitMs
    });
  }

  args.logStage('request.received', providerRequestId, {
    endpoint: args.input.entryEndpoint,
    stream: initialMetadata.stream === true
  });
  args.logStage('request.snapshot.start', providerRequestId, {
    endpoint: args.input.entryEndpoint
  });
  await writeInboundClientSnapshot({ input: args.input, initialMetadata, clientRequestId });
  args.logStage('request.snapshot.completed', providerRequestId, {
    endpoint: args.input.entryEndpoint
  });

  return {
    initialMetadata,
    inboundClientHeaders,
    providerRequestId,
    clientRequestId,
    ...(sessionStormBackoffScopes.length ? { sessionStormBackoffScopes } : {})
  };
}
