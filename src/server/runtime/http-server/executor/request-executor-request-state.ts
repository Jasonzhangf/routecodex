import type { PipelineExecutionInput } from '../../../handlers/types.js';
import { registerRequestLogContext } from '../../../utils/request-log-color.js';
import { buildRequestMetadata, cloneClientHeaders, resolveClientRequestId } from '../executor-metadata.js';
import { writeInboundClientSnapshot } from './request-executor-core-utils.js';

export type RequestExecutorInitialRequestState = {
  initialMetadata: Record<string, unknown>;
  inboundClientHeaders: Record<string, string> | undefined;
  providerRequestId: string;
  clientRequestId: string;
  projectPath?: string;
  sessionId?: string;
  conversationId?: string;
};

function resolveProjectPathFromMetadata(metadata: Record<string, unknown>): string | undefined {
  const candidates = [
    metadata.clientWorkdir,
    metadata.client_workdir,
    metadata.workdir,
    metadata.cwd
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

export async function initializeRequestExecutorRequestState(args: {
  input: PipelineExecutionInput;
  logStage: (stage: string, requestId: string, details?: Record<string, unknown>) => void;
  onRequestStart?: (args: { requestId: string; metadata: Record<string, unknown> }) => void | Promise<void>;
  logNonBlockingError: (stage: string, error: unknown, details?: Record<string, unknown>) => void;
}): Promise<RequestExecutorInitialRequestState> {
  const initialMetadata = buildRequestMetadata(args.input);
  await args.onRequestStart?.({ requestId: args.input.requestId, metadata: initialMetadata });

  const sessionId =
    typeof initialMetadata.sessionId === 'string' && initialMetadata.sessionId.trim()
      ? initialMetadata.sessionId.trim()
      : undefined;
  const conversationId =
    typeof initialMetadata.conversationId === 'string' && initialMetadata.conversationId.trim()
      ? initialMetadata.conversationId.trim()
      : undefined;
  registerRequestLogContext(args.input.requestId, {
    logSessionColorKey: initialMetadata.logSessionColorKey,
    clientTmuxSessionId: initialMetadata.clientTmuxSessionId,
    client_tmux_session_id: initialMetadata.client_tmux_session_id,
    tmuxSessionId: initialMetadata.tmuxSessionId,
    tmux_session_id: initialMetadata.tmux_session_id,
    sessionId,
    session_id: sessionId,
    conversationId,
    conversation_id: conversationId
  });

  const inboundClientHeaders = cloneClientHeaders(initialMetadata?.clientHeaders);
  const providerRequestId = args.input.requestId;
  const clientRequestId = resolveClientRequestId(initialMetadata, providerRequestId);
  const projectPath = resolveProjectPathFromMetadata(initialMetadata);

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
    projectPath,
    sessionId,
    conversationId
  };
}
