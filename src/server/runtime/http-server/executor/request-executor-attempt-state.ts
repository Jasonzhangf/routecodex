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
import { readRuntimeRequestTruthIdentifiers } from '../metadata-center/request-truth-readers.js';

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
  retryProviderKey?: string;
  inboundClientHeaders: Record<string, string> | undefined;
  clientRequestId: string;
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
    metadataCenter.writeRuntimeControl(
      'routeHint',
      args.forcedRouteHint,
      ATTEMPT_STATE_RUNTIME_CONTROL_WRITER,
      'request executor forced route hint'
    );
  }
  if (Object.prototype.hasOwnProperty.call(metadataForAttempt, '__routecodexRetryProviderKey')) {
    delete metadataForAttempt.__routecodexRetryProviderKey;
  }
  const responsesResume =
    metadataCenter.readContinuationContext().responsesResume
    && typeof metadataCenter.readContinuationContext().responsesResume === 'object'
    && !Array.isArray(metadataCenter.readContinuationContext().responsesResume)
      ? (metadataCenter.readContinuationContext().responsesResume as Record<string, unknown>)
      : undefined;
  const resumeContinuationOwner =
    typeof responsesResume?.continuationOwner === 'string'
      ? responsesResume.continuationOwner.trim()
      : undefined;
  const resumeRetryProviderKey =
    resumeContinuationOwner === 'relay'
      ? undefined
      : typeof responsesResume?.providerKey === 'string' && responsesResume.providerKey.trim()
        ? responsesResume.providerKey.trim()
        : undefined;
  const effectiveRetryProviderKey = args.retryProviderKey?.trim() || resumeRetryProviderKey;
  if (effectiveRetryProviderKey) {
    metadataCenter.writeRuntimeControl(
      'retryProviderKey',
      effectiveRetryProviderKey,
      ATTEMPT_STATE_RUNTIME_CONTROL_WRITER,
      'request executor retry provider pin'
    );
    delete metadataForAttempt.excludedProviderKeys;
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
  delete mergedMetadata.sessionId;
  delete mergedMetadata.session_id;
  delete mergedMetadata.conversationId;
  delete mergedMetadata.conversation_id;
  const requestTruth = readRuntimeRequestTruthIdentifiers(mergedMetadata);
  registerRequestLogContext(args.requestId, {
    logSessionColorKey: mergedMetadata.logSessionColorKey,
    clientTmuxSessionId: mergedMetadata.clientTmuxSessionId,
    client_tmux_session_id: mergedMetadata.client_tmux_session_id,
    tmuxSessionId: mergedMetadata.tmuxSessionId,
    tmux_session_id: mergedMetadata.tmux_session_id,
    sessionId: requestTruth.sessionId,
    session_id: requestTruth.sessionId,
    conversationId: requestTruth.conversationId,
    conversation_id: requestTruth.conversationId
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
