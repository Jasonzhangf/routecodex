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
  const clientAbortSignal = resolveClientAbortSignalFromCarrier(metadataForAttempt);
  args.throwIfClientAbortSignalAborted(clientAbortSignal);

  if (args.forcedRouteHint) {
    metadataForAttempt.routeHint = args.forcedRouteHint;
  }
  if (Object.prototype.hasOwnProperty.call(metadataForAttempt, '__routecodexRetryProviderKey')) {
    delete metadataForAttempt.__routecodexRetryProviderKey;
  }
  if (args.retryProviderKey) {
    MetadataCenter.attach(metadataForAttempt).writeRuntimeControl(
      'retryProviderKey',
      args.retryProviderKey,
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
  const metadataCenter = requestMetadataCenter ?? pipelineMetadataCenter;
  if (metadataCenter) {
    MetadataCenter.bind(mergedMetadata, metadataCenter);
    if (requestMetadataCenter && pipelineMetadataCenter && requestMetadataCenter !== pipelineMetadataCenter) {
      const mergedCenter = MetadataCenter.read(mergedMetadata);
      const continuationSnapshot = pipelineMetadataCenter.snapshot().continuationContext;
      for (const [key, slot] of Object.entries(continuationSnapshot)) {
        if (!slot) {
          continue;
        }
        mergedCenter?.writeContinuationContext(
          key as keyof ReturnType<typeof pipelineMetadataCenter.readContinuationContext>,
          slot.value as Record<string, unknown> | unknown[] | string | undefined,
          slot.writtenBy,
          'merged from pipeline result metadata center'
        );
      }
      const runtimeControlSnapshot = pipelineMetadataCenter.snapshot().runtimeControl;
      for (const [key, slot] of Object.entries(runtimeControlSnapshot)) {
        if (!slot) {
          continue;
        }
        mergedCenter?.writeRuntimeControl(
          key as keyof ReturnType<typeof pipelineMetadataCenter.readRuntimeControl>,
          slot.value as Record<string, unknown> | boolean | string | undefined,
          slot.writtenBy,
          'merged from pipeline result metadata center'
        );
      }
      const providerObservationSnapshot = pipelineMetadataCenter.snapshot().providerObservation;
      for (const [key, slot] of Object.entries(providerObservationSnapshot)) {
        if (!slot) {
          continue;
        }
        mergedCenter?.writeProviderObservation(
          key as keyof ReturnType<typeof pipelineMetadataCenter.readProviderObservation>,
          slot.value as Record<string, unknown> | string | undefined,
          slot.writtenBy,
          'merged from pipeline result metadata center'
        );
      }
    }
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
