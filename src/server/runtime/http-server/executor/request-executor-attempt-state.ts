import type { PipelineExecutionInput } from '../../../handlers/types.js';
// feature_id: hub.metadata_center_attempt_merge
import type { HubPipelineResult } from '../executor-pipeline.js';
import type { RetryPayloadSeed } from './retry-payload-snapshot.js';
import { registerRequestLogContext } from '../../../utils/request-log-color.js';
import { cloneClientHeaders, decorateMetadataForAttempt } from '../executor-metadata.js';
import { mergeMetadataPreservingDefined } from './request-executor-core-utils.js';
import { resolveClientAbortSignalFromCarrier } from './request-executor-client-abort-block.js';
import { restoreRequestPayloadFromRetrySeed } from './retry-payload-snapshot.js';
import { applyMetadataCenterRustWriteResult, type MetadataCenterRustSnapshot } from '../metadata-center/dualwrite-api.js';
import {
  attachRuntimeCarrier,
  bindSingleRuntimeCarrierFromSources,
  readRuntimeContinuationResponsesResume,
  readRuntimeControlProjection,
  writeRuntimeControlSlot
} from '../metadata-center/request-truth-readers.js';
import { propagatePipelineDryRunControl } from '../../../../debug/pipeline-dry-run.js';

const ATTEMPT_STATE_RUNTIME_CONTROL_WRITER = {
  module: 'src/server/runtime/http-server/executor/request-executor-attempt-state.ts',
  symbol: 'prepareRequestExecutorAttemptState',
  stage: 'request_executor_attempt_runtime_control'
} as const;

const ATTEMPT_STATE_PIPELINE_METADATA_WRITER = {
  module: 'src/server/runtime/http-server/executor/request-executor-attempt-state.ts',
  symbol: 'finalizeRequestExecutorAttemptMetadata',
  stage: 'request_executor_attempt_runtime_control'
} as const;

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function applyPipelineMetadataCenterSnapshot(args: {
  target: Record<string, unknown>;
  pipelineMetadata: Record<string, unknown> | undefined;
}): void {
  const snapshot = readRecord(args.pipelineMetadata?.metadataCenterSnapshot);
  if (!snapshot) {
    return;
  }
  applyMetadataCenterRustWriteResult({
    target: args.target,
    snapshot: snapshot as MetadataCenterRustSnapshot,
    writer: ATTEMPT_STATE_PIPELINE_METADATA_WRITER,
    reason: 'hub pipeline metadata center writeback'
  });
}

function resolveAttemptRetryProviderKey(args: {
  metadataForAttempt: Record<string, unknown>;
  explicitRetryProviderKey?: unknown;
}): string | undefined {
  const explicit = readTrimmedString(args.explicitRetryProviderKey);
  if (explicit) {
    return explicit;
  }
  const runtimeControl = readRuntimeControlProjection(args.metadataForAttempt);
  const existing = readTrimmedString(runtimeControl.retryProviderKey);
  if (existing) {
    return existing;
  }
  const responsesResume = readRecord(readRuntimeContinuationResponsesResume(args.metadataForAttempt));
  if (!responsesResume) {
    return undefined;
  }
  if (readTrimmedString(responsesResume.continuationOwner) === 'relay') {
    return undefined;
  }
  return readTrimmedString(responsesResume.providerKey);
}

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
  propagatePipelineDryRunControl(args.initialMetadata, metadataForAttempt);
  delete metadataForAttempt.__routecodexRetryProviderKey;
  attachRuntimeCarrier(metadataForAttempt);
  const retryProviderKey = resolveAttemptRetryProviderKey({
    metadataForAttempt,
    explicitRetryProviderKey: args.retryProviderKey
  });
  if (retryProviderKey) {
    delete metadataForAttempt.excludedProviderKeys;
    writeRuntimeControlSlot({
      target: metadataForAttempt,
      key: 'retryProviderKey',
      value: retryProviderKey,
      writer: ATTEMPT_STATE_RUNTIME_CONTROL_WRITER
    });
  }
  const clientAbortSignal = resolveClientAbortSignalFromCarrier(metadataForAttempt);
  args.throwIfClientAbortSignalAborted(clientAbortSignal);

  if (args.forcedRouteHint) {
    writeRuntimeControlSlot({
      target: metadataForAttempt,
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
  const pipelineMetadataRecord = pipelineMetadata && typeof pipelineMetadata === 'object' && !Array.isArray(pipelineMetadata)
    ? pipelineMetadata as Record<string, unknown>
    : undefined;
  const requestTruth = bindSingleRuntimeCarrierFromSources({
    target: mergedMetadata,
    sources: [args.metadataForAttempt, pipelineMetadataRecord],
    conflictMessage: 'request-executor attempt metadata violated single-center contract: pipeline result returned a second runtime carrier'
  });
  applyPipelineMetadataCenterSnapshot({
    target: mergedMetadata,
    pipelineMetadata: pipelineMetadataRecord
  });
  propagatePipelineDryRunControl(args.metadataForAttempt, mergedMetadata);
  propagatePipelineDryRunControl(pipelineMetadataRecord, mergedMetadata);
  if (requestTruth.requestId) {
    mergedMetadata.requestId = requestTruth.requestId;
  }
  if (requestTruth.clientRequestId) {
    mergedMetadata.clientRequestId = requestTruth.clientRequestId;
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
