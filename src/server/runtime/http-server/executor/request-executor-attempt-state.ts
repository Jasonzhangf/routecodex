import type { PipelineExecutionInput } from '../../../handlers/types.js';
// feature_id: hub.metadata_center_attempt_merge
import type { HubPipelineResult } from '../executor-pipeline.js';
import type { RetryPayloadSeed } from './retry-payload-snapshot.js';
import { registerRequestLogContext } from '../../../utils/request-log-color.js';
import { cloneClientHeaders, decorateMetadataForAttempt } from '../executor-metadata.js';
import { mergeMetadataPreservingDefined } from './request-executor-core-utils.js';
import { resolveClientAbortSignalFromCarrier } from './request-executor-client-abort-block.js';
import { restoreRequestPayloadFromRetrySeed } from './retry-payload-snapshot.js';
import { MetadataCenter } from '../metadata-center/metadata-center.js';
import { writeMetadataCenterSlot } from '../metadata-center/dualwrite-api.js';

const ATTEMPT_STATE_RUNTIME_CONTROL_WRITER = {
  module: 'src/server/runtime/http-server/executor/request-executor-attempt-state.ts',
  symbol: 'prepareRequestExecutorAttemptState',
  stage: 'request_executor_attempt_runtime_control'
} as const;

export type PreparedRequestExecutorAttemptState = {
  metadataForAttempt: Record<string, unknown>;
  clientAbortSignal: AbortSignal | undefined;
  clientHeadersForAttempt: Record<string, string> | undefined;
};

export function prepareRequestExecutorAttemptState(args: {
  input: PipelineExecutionInput;
  providerRequestId: string;
  retryPayloadSeed: RetryPayloadSeed;
  attempt: number;
  initialMetadata: Record<string, unknown>;
  excludedProviderKeys: Set<string>;
  inboundClientHeaders: Record<string, string> | undefined;
  clientRequestId: string;
  sessionId?: string;
  conversationId?: string;
  forcedRouteHint?: string;
  throwIfClientAbortSignalAborted: (abortSignal: AbortSignal | undefined) => void;
}): PreparedRequestExecutorAttemptState {
  args.input.requestId = args.providerRequestId;
  if (args.attempt > 1 && args.retryPayloadSeed.mode !== 'none') {
    const cloned = restoreRequestPayloadFromRetrySeed(args.retryPayloadSeed);
    if (cloned && typeof cloned === 'object') {
      args.input.body = cloned;
    }
  }

  const metadataForAttempt = decorateMetadataForAttempt(
    args.initialMetadata,
    args.attempt,
    args.excludedProviderKeys
  );
  const metadataCenter = MetadataCenter.attach(metadataForAttempt);
  const clientAbortSignal = resolveClientAbortSignalFromCarrier(metadataForAttempt);
  args.throwIfClientAbortSignalAborted(clientAbortSignal);

  if (args.forcedRouteHint) {
    writeMetadataCenterSlot({
      target: metadataForAttempt,
      family: 'runtime_control',
      key: 'routeHint',
      value: args.forcedRouteHint,
      writer: ATTEMPT_STATE_RUNTIME_CONTROL_WRITER,
      reason: 'request executor forced route hint'
    });
  }

  const loggerRecord =
    metadataForAttempt.logger &&
    typeof metadataForAttempt.logger === 'object' &&
    !Array.isArray(metadataForAttempt.logger)
      ? (metadataForAttempt.logger as Record<string, unknown>)
      : undefined;
  if (loggerRecord && typeof loggerRecord.logVirtualRouterHit === 'function') {
    metadataForAttempt.logger = {
      ...loggerRecord,
      logVirtualRouterHit: undefined
    };
  }

  const clientHeadersForAttempt =
    cloneClientHeaders(metadataForAttempt?.clientHeaders) || args.inboundClientHeaders;
  if (clientHeadersForAttempt) {
    metadataForAttempt.clientHeaders = clientHeadersForAttempt;
  }
  metadataForAttempt.clientRequestId = args.clientRequestId;

  return {
    metadataForAttempt,
    clientAbortSignal,
    clientHeadersForAttempt
  };
}

export function finalizeRequestExecutorAttemptMetadata(args: {
  requestId: string;
  metadataForAttempt: Record<string, unknown>;
  pipelineResult: HubPipelineResult;
  clientHeadersForAttempt: Record<string, string> | undefined;
  clientRequestId: string;
  sessionId?: string;
  conversationId?: string;
}): {
  mergedMetadata: Record<string, unknown>;
  mergedClientHeaders: Record<string, string> | undefined;
} {
  const pipelineMetadata = args.pipelineResult.metadata ?? {};
  const mergedMetadata = mergeMetadataPreservingDefined(args.metadataForAttempt, pipelineMetadata);
  const requestMetadataCenter = MetadataCenter.read(args.metadataForAttempt);
  const pipelineMetadataCenter =
    pipelineMetadata && typeof pipelineMetadata === 'object' && !Array.isArray(pipelineMetadata)
      ? MetadataCenter.read(pipelineMetadata as Record<string, unknown>)
      : undefined;
  if (
    requestMetadataCenter
    && pipelineMetadataCenter
    && requestMetadataCenter !== pipelineMetadataCenter
  ) {
    throw new Error(
      'request-executor attempt metadata violated single-center contract: pipeline result returned a second MetadataCenter'
    );
  }
  const metadataCenter = requestMetadataCenter ?? pipelineMetadataCenter;
  if (metadataCenter) {
    MetadataCenter.bind(mergedMetadata, metadataCenter);
    const requestTruth = metadataCenter.readRequestTruth();
    if (requestTruth.requestId) {
      mergedMetadata.requestId = requestTruth.requestId;
    }
    if (requestTruth.clientRequestId) {
      mergedMetadata.clientRequestId = requestTruth.clientRequestId;
    }
  }
  const sessionId =
    typeof args.sessionId === 'string' && args.sessionId.trim()
      ? args.sessionId.trim()
      : undefined;
  const conversationId =
    typeof args.conversationId === 'string' && args.conversationId.trim()
      ? args.conversationId.trim()
      : undefined;
  if (sessionId) {
    mergedMetadata.sessionId = sessionId;
    mergedMetadata.session_id = sessionId;
  } else {
    delete mergedMetadata.sessionId;
    delete mergedMetadata.session_id;
  }
  if (conversationId) {
    mergedMetadata.conversationId = conversationId;
    mergedMetadata.conversation_id = conversationId;
  } else {
    delete mergedMetadata.conversationId;
    delete mergedMetadata.conversation_id;
  }
  registerRequestLogContext(args.requestId, {
    logSessionColorKey: mergedMetadata.logSessionColorKey,
    clientTmuxSessionId: mergedMetadata.clientTmuxSessionId,
    client_tmux_session_id: mergedMetadata.client_tmux_session_id,
    tmuxSessionId: mergedMetadata.tmuxSessionId,
    tmux_session_id: mergedMetadata.tmux_session_id,
    sessionId,
    session_id: sessionId,
    conversationId,
    conversation_id: conversationId
  });
  const mergedClientHeaders =
    cloneClientHeaders(mergedMetadata?.clientHeaders) || args.clientHeadersForAttempt;
  if (mergedClientHeaders) {
    mergedMetadata.clientHeaders = mergedClientHeaders;
  }
  mergedMetadata.clientRequestId = args.clientRequestId;
  return {
    mergedMetadata,
    mergedClientHeaders
  };
}
