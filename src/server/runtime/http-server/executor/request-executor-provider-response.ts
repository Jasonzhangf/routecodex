import type { PipelineExecutionResult } from '../../../handlers/types.js';
import type { UsageMetrics } from './usage-aggregator.js';
import type { StatsManager } from '../stats-manager.js';
import type { ProviderTrafficGovernorLike } from '../provider-traffic-governor.js';
import {
  detectAssistantSanitizationPlaceholder,
  detectRetryableEmptyAssistantResponse,
  persistPayloadContractProviderSnapshots
} from './request-executor-response-contract.js';
import { extractUsageFromResult, mergeUsageMetrics } from './usage-aggregator.js';
import { extractStatusCodeFromError } from './utils.js';
import { resolveSessionLogColorKey } from '../../../../utils/session-log-color.js';
import { readRuntimeRequestTruthIdentifiers } from '../metadata-center/request-truth-readers.js';

export type HubStageTopEntry = {
  stage: string;
  totalMs: number;
  count?: number;
  avgMs?: number;
  maxMs?: number;
};

export type HubDecodeBreakdown = {
  sseDecodeMs: number;
  codecDecodeMs: number;
};

function coalesceUsageMetrics(primary?: UsageMetrics, secondary?: UsageMetrics): UsageMetrics | undefined {
  if (!primary) {
    return secondary;
  }
  if (!secondary) {
    return primary;
  }
  return {
    prompt_tokens: primary.prompt_tokens ?? secondary.prompt_tokens,
    completion_tokens: primary.completion_tokens ?? secondary.completion_tokens,
    total_tokens: primary.total_tokens ?? secondary.total_tokens,
    cache_read_input_tokens: primary.cache_read_input_tokens ?? secondary.cache_read_input_tokens,
    cache_creation_input_tokens: primary.cache_creation_input_tokens ?? secondary.cache_creation_input_tokens
  };
}

export function buildProviderExecutionSuccessResult(args: {
  converted: PipelineExecutionResult;
  providerKey: string;
  providerModel?: string;
  routeName?: string;
  routingPoolId?: string;
  finishReason?: string;
  stoplessMode?: 'on' | 'off' | 'endless';
  stoplessArmed?: boolean;
  aggregatedUsage?: Record<string, unknown>;
  cumulativeExternalLatencyMs: number;
  cumulativeTrafficWaitMs: number;
  cumulativeClientInjectWaitMs: number;
  attempt: number;
  requestStartedAtMs: number;
  providerRequestId: string;
  inputRequestId: string;
  mergedMetadata: Record<string, unknown>;
  readString: (value: unknown) => string | undefined;
  readHubStageTop: (metadata: Record<string, unknown> | undefined) => HubStageTopEntry[] | undefined;
  readHubDecodeBreakdown: (hubStageTop: HubStageTopEntry[] | undefined) => HubDecodeBreakdown;
}): PipelineExecutionResult {
  const metadataHubStageTop = args.readHubStageTop(args.mergedMetadata);
  const hubDecodeBreakdown = args.readHubDecodeBreakdown(metadataHubStageTop);
  const requestTruth = readRuntimeRequestTruthIdentifiers(args.mergedMetadata);
  const decodeStats =
    args.converted.body && typeof args.converted.body === 'object' && !Array.isArray(args.converted.body)
      ? (args.converted.body as Record<string, any>).__rccDecodeStats
      : undefined;
  const rccFirstContentAtMs: number | undefined =
    decodeStats && typeof decodeStats.firstContentAtMs === 'number'
      ? decodeStats.firstContentAtMs
      : undefined;
  const rccLastContentAtMs: number | undefined =
    decodeStats && typeof decodeStats.lastContentAtMs === 'number'
      ? decodeStats.lastContentAtMs
      : undefined;
  return {
    ...args.converted,
    metadata: {
      ...(args.mergedMetadata ?? {}),
      ...(
        args.converted.metadata
        && typeof args.converted.metadata === 'object'
        && !Array.isArray(args.converted.metadata)
          ? args.converted.metadata
          : {}
      )
    },
    usageLogInfo: {
      providerKey: args.providerKey,
      model: args.providerModel,
      routeName: args.routeName,
      poolId: args.routingPoolId,
      finishReason: args.finishReason,
      stoplessMode: args.stoplessMode,
      stoplessArmed: args.stoplessArmed,
      usage: args.aggregatedUsage,
      externalLatencyMs: args.cumulativeExternalLatencyMs > 0 ? args.cumulativeExternalLatencyMs : undefined,
      trafficWaitMs: args.cumulativeTrafficWaitMs > 0 ? args.cumulativeTrafficWaitMs : undefined,
      clientInjectWaitMs: args.cumulativeClientInjectWaitMs > 0 ? args.cumulativeClientInjectWaitMs : undefined,
      sseDecodeMs: hubDecodeBreakdown.sseDecodeMs > 0 ? hubDecodeBreakdown.sseDecodeMs : undefined,
      codecDecodeMs: hubDecodeBreakdown.codecDecodeMs > 0 ? hubDecodeBreakdown.codecDecodeMs : undefined,
      providerAttemptCount: args.attempt,
      retryCount: Math.max(0, args.attempt - 1),
      hubStageTop: metadataHubStageTop,
      requestStartedAtMs: args.requestStartedAtMs,
      timingRequestIds: Array.from(
        new Set([args.providerRequestId, args.inputRequestId].filter((value): value is string => Boolean(value)))
      ),
      logSessionColorKey: resolveSessionLogColorKey(args.mergedMetadata),
      clientTmuxSessionId: args.mergedMetadata.clientTmuxSessionId,
      client_tmux_session_id: args.mergedMetadata.client_tmux_session_id,
      tmuxSessionId: args.mergedMetadata.tmuxSessionId,
      tmux_session_id: args.mergedMetadata.tmux_session_id,
      rccSessionClientTmuxSessionId: args.mergedMetadata.rccSessionClientTmuxSessionId,
      rcc_session_client_tmux_session_id: args.mergedMetadata.rcc_session_client_tmux_session_id,
      sessionId: requestTruth.sessionId,
      session_id: requestTruth.sessionId,
      conversationId: requestTruth.conversationId,
      conversation_id: requestTruth.conversationId,
      projectPath:
        args.readString(args.mergedMetadata.clientWorkdir)
        ?? args.readString(args.mergedMetadata.client_workdir)
        ?? args.readString(args.mergedMetadata.workdir)
        ?? args.readString(args.mergedMetadata.cwd),
      firstContentAtMs: rccFirstContentAtMs,
      lastContentAtMs: rccLastContentAtMs,
      providerRequestId: args.providerRequestId,
      inputRequestId: args.inputRequestId
    }
  };
}

type ObserveSuccessArgs = {
  governor: ProviderTrafficGovernorLike;
  runtimeKey: string;
  providerKey: string;
  requestId: string;
  statusCode?: number;
  activeInFlight?: number;
  configuredMaxInFlight?: number;
};

async function observeSuccessfulOutcome(args: ObserveSuccessArgs): Promise<void> {
  await args.governor.observeOutcome?.({
    runtimeKey: args.runtimeKey,
    providerKey: args.providerKey,
    requestId: args.requestId,
    success: true,
    statusCode: args.statusCode,
    activeInFlight: args.activeInFlight,
    configuredMaxInFlight: args.configuredMaxInFlight
  });
}

function throwProviderHttpError(converted: PipelineExecutionResult): never {
  const bodyForError = converted.body && typeof converted.body === 'object'
    ? (converted.body as Record<string, unknown>)
    : undefined;
  const errorNode =
    bodyForError && bodyForError.error && typeof bodyForError.error === 'object'
      ? (bodyForError.error as Record<string, unknown>)
      : undefined;
  const errMsg =
    errorNode
      ? String(errorNode.message || errorNode || '')
      : '';
  const statusCode = typeof converted.status === 'number' ? converted.status : 500;
  const errorToThrow: any = new Error(errMsg && errMsg.trim().length ? errMsg : `HTTP ${statusCode}`);
  errorToThrow.statusCode = statusCode;
  errorToThrow.status = statusCode;
  const errorCode =
    errorNode && typeof errorNode.code === 'string' && errorNode.code.trim().length
      ? errorNode.code.trim()
      : undefined;
  if (errorCode) {
    errorToThrow.code = errorCode;
    errorToThrow.upstreamCode = errorCode;
  }
  errorToThrow.response = { data: bodyForError };
  errorToThrow.requestExecutorProviderErrorStage = 'provider.http';
  throw errorToThrow;
}

function createResponseContractError(args: {
  message: string;
  code: 'EMPTY_ASSISTANT_RESPONSE' | 'MISSING_REQUIRED_TOOL_CALL';
  stage: 'host.response_contract';
  body?: Record<string, unknown>;
}): never {
  const errorToThrow: any = new Error(args.message);
  errorToThrow.statusCode = 502;
  errorToThrow.status = 502;
  errorToThrow.code = args.code;
  errorToThrow.retryable = true;
  errorToThrow.requestExecutorProviderErrorStage = args.stage;
  if (args.body) {
    errorToThrow.response = { data: args.body };
  }
  throw errorToThrow;
}

function isMissingRequiredToolCallMarker(marker: string): boolean {
  return marker === 'chat_missing_required_tool_call'
    || marker === 'responses_missing_required_tool_call'
    || marker === 'chat_textual_tool_registry_missing'
    || marker === 'responses_textual_tool_registry_missing';
}

export async function processSuccessfulProviderResponse(args: {
  inputRequestId: string;
  entryEndpoint: string;
  providerKey: string;
  providerId: string;
  providerModel?: string;
  providerProtocol: string;
  providerPayload: Record<string, unknown>;
  normalized: PipelineExecutionResult;
  converted: PipelineExecutionResult;
  requestSemantics?: Record<string, unknown>;
  mergedMetadata: Record<string, unknown>;
  bypassTrafficGovernor: boolean;
  trafficGovernor: ProviderTrafficGovernorLike;
  runtimeKey: string;
  trafficActiveInFlightAtAcquire?: number;
  trafficPolicyMaxInFlight?: number;
  stats: StatsManager;
  aggregatedUsage?: UsageMetrics;
  providerUsageFallback?: UsageMetrics;
  attempt: number;
  logStage: (stage: string, requestId: string, details?: Record<string, unknown>) => void;
  logNonBlockingError: (stage: string, error: unknown, details?: Record<string, unknown>) => void;
  queuePayloadContractErrorsample: (args: {
    phase: 'provider-response';
    requestId: string;
    entryEndpoint?: string;
    providerKey?: string;
    providerId?: string;
    marker: string;
    reason: string;
    observation: unknown;
  }) => void;
  writeProviderSnapshot: (args: {
    phase:
      | 'provider-request'
      | 'provider-response'
      | 'provider-request-contract'
      | 'provider-response-contract';
    requestId: string;
    data: unknown;
    headers?: Record<string, unknown>;
    url?: string;
    entryEndpoint?: string;
    clientRequestId?: string;
    providerKey?: string;
    providerId?: string;
    forceLocalDiskWriteWhenDisabled?: boolean;
  }) => Promise<void>;
  clearProviderTransportBackoff: () => void;
}): Promise<{
  aggregatedUsage?: UsageMetrics;
  convertedStatus?: number;
}> {
  const convertedStatus = typeof args.converted.status === 'number' ? args.converted.status : undefined;
  args.logStage('provider.response_status_check.start', args.inputRequestId, {
    providerKey: args.providerKey,
    convertedStatus,
    attempt: args.attempt
  });

  const isGlobalRetryableStatus =
    typeof convertedStatus === 'number' &&
    (convertedStatus === 401 ||
      convertedStatus === 402 ||
      convertedStatus === 403 ||
      convertedStatus === 429 ||
      convertedStatus === 408 ||
      convertedStatus === 425 ||
      convertedStatus >= 500);
  if (isGlobalRetryableStatus) {
    throwProviderHttpError(args.converted);
  }

  args.logStage('provider.response_status_check.completed', args.inputRequestId, {
    providerKey: args.providerKey,
    convertedStatus,
    attempt: args.attempt
  });

  args.clearProviderTransportBackoff();

  if (!args.bypassTrafficGovernor) {
    try {
      await observeSuccessfulOutcome({
        governor: args.trafficGovernor,
        runtimeKey: args.runtimeKey,
        providerKey: args.providerKey,
        requestId: args.inputRequestId,
        statusCode: convertedStatus,
        activeInFlight: args.trafficActiveInFlightAtAcquire,
        configuredMaxInFlight: args.trafficPolicyMaxInFlight || undefined
      });
    } catch (observeError) {
      args.logStage('provider.traffic.observe_outcome.error', args.inputRequestId, {
        providerKey: args.providerKey,
        runtimeKey: args.runtimeKey,
        message:
          observeError instanceof Error
            ? observeError.message
            : String(observeError ?? 'Unknown observe outcome error'),
        attempt: args.attempt
      });
    }
  }

  const buildContractObservation = () => ({
    providerRequestPayload: args.providerPayload,
    normalizedResponse: {
      status: args.normalized.status ?? null,
      headers: args.normalized.headers ?? null,
      body: args.normalized.body ?? null
    },
    convertedResponse: {
      status: args.converted.status ?? null,
      headers: args.converted.headers ?? null,
      body: args.converted.body ?? null
    }
  });

  const emptyAssistantSignal = await detectRetryableEmptyAssistantResponse(args.converted.body, args.requestSemantics);
  if (emptyAssistantSignal) {
    const bodyForError = args.converted.body as Record<string, unknown>;
    args.queuePayloadContractErrorsample({
      phase: 'provider-response',
      requestId: args.inputRequestId,
      entryEndpoint: args.entryEndpoint,
      providerKey: args.providerKey,
      providerId: args.providerId,
      marker: emptyAssistantSignal.marker,
      reason: emptyAssistantSignal.reason,
      observation: buildContractObservation()
    });
    try {
      await persistPayloadContractProviderSnapshots({
        requestId: args.inputRequestId,
        entryEndpoint: args.entryEndpoint,
        providerKey: args.providerKey,
        providerId: args.providerId,
        providerRequestPayload: args.providerPayload,
        providerRequestHeaders: args.providerPayload.headers as Record<string, unknown> | undefined,
        providerRequestUrl: typeof args.providerPayload.url === 'string' ? args.providerPayload.url : undefined,
        normalizedResponse: args.normalized,
        convertedResponse: args.converted,
        payloadContractSignal: emptyAssistantSignal,
        writeProviderSnapshot: args.writeProviderSnapshot
      });
    } catch (snapshotError) {
      args.logNonBlockingError('host.response_contract.empty_assistant.snapshot', snapshotError, {
        requestId: args.inputRequestId,
        providerKey: args.providerKey,
        marker: emptyAssistantSignal.marker
      });
    }
    args.logStage('host.response_contract.empty_assistant', args.inputRequestId, {
      providerKey: args.providerKey,
      marker: emptyAssistantSignal.marker,
      reason: emptyAssistantSignal.reason,
      attempt: args.attempt
    });
    createResponseContractError({
      message: isMissingRequiredToolCallMarker(emptyAssistantSignal.marker)
        ? `Upstream omitted required structured tool call: ${emptyAssistantSignal.reason}`
        : `Upstream returned empty assistant payload: ${emptyAssistantSignal.reason}`,
      code: isMissingRequiredToolCallMarker(emptyAssistantSignal.marker)
        ? 'MISSING_REQUIRED_TOOL_CALL'
        : 'EMPTY_ASSISTANT_RESPONSE',
      stage: 'host.response_contract',
      body: bodyForError
    });
  }

  const assistantSanitizationPlaceholderSignal = detectAssistantSanitizationPlaceholder(args.converted.body);
  if (assistantSanitizationPlaceholderSignal) {
    const bodyForError =
      args.converted.body && typeof args.converted.body === 'object'
        ? (args.converted.body as Record<string, unknown>)
        : undefined;
    args.queuePayloadContractErrorsample({
      phase: 'provider-response',
      requestId: args.inputRequestId,
      entryEndpoint: args.entryEndpoint,
      providerKey: args.providerKey,
      providerId: args.providerId,
      marker: assistantSanitizationPlaceholderSignal.marker,
      reason: assistantSanitizationPlaceholderSignal.reason,
      observation: buildContractObservation()
    });
    try {
      await persistPayloadContractProviderSnapshots({
        requestId: args.inputRequestId,
        entryEndpoint: args.entryEndpoint,
        providerKey: args.providerKey,
        providerId: args.providerId,
        providerRequestPayload: args.providerPayload,
        providerRequestHeaders: args.providerPayload.headers as Record<string, unknown> | undefined,
        providerRequestUrl: typeof args.providerPayload.url === 'string' ? args.providerPayload.url : undefined,
        normalizedResponse: args.normalized,
        convertedResponse: args.converted,
        payloadContractSignal: assistantSanitizationPlaceholderSignal,
        writeProviderSnapshot: args.writeProviderSnapshot
      });
    } catch (snapshotError) {
      args.logNonBlockingError('host.response_contract.assistant_sanitize_placeholder.snapshot', snapshotError, {
        requestId: args.inputRequestId,
        providerKey: args.providerKey,
        marker: assistantSanitizationPlaceholderSignal.marker
      });
    }
    args.logStage('host.response_contract.assistant_sanitize_placeholder', args.inputRequestId, {
      providerKey: args.providerKey,
      marker: assistantSanitizationPlaceholderSignal.marker,
      reason: assistantSanitizationPlaceholderSignal.reason,
      attempt: args.attempt
    });
    createResponseContractError({
      message: `Upstream returned assistant placeholder payload: ${assistantSanitizationPlaceholderSignal.reason}`,
      code: 'EMPTY_ASSISTANT_RESPONSE',
      stage: 'host.response_contract',
      body: bodyForError
    });
  }

  args.logStage('provider.usage_extract.start', args.inputRequestId, {
    providerKey: args.providerKey,
    source: 'converted_response',
    attempt: args.attempt
  });
  const convertedUsage = extractUsageFromResult(args.converted, {
    ...args.mergedMetadata,
    providerProtocol: args.providerProtocol,
    providerKey: args.providerKey
  });
  const usage = coalesceUsageMetrics(args.providerUsageFallback, convertedUsage);
  const aggregatedUsage = mergeUsageMetrics(args.aggregatedUsage, usage);
  args.logStage('provider.usage_extract.completed', args.inputRequestId, {
    providerKey: args.providerKey,
    source: 'converted_response',
    hasUsage: Boolean(usage),
    attempt: args.attempt
  });

  args.logStage('provider.tool_usage_record.start', args.inputRequestId, {
    providerKey: args.providerKey,
    attempt: args.attempt
  });
  if (!args.converted.sseStream && args.converted.body && typeof args.converted.body === 'object') {
    const body = args.converted.body as Record<string, unknown>;
    args.stats.recordToolUsage({ providerKey: args.providerKey, model: args.providerModel }, body);
  }
  args.logStage('provider.tool_usage_record.completed', args.inputRequestId, {
    providerKey: args.providerKey,
    attempt: args.attempt
  });

  return {
    aggregatedUsage,
    convertedStatus
  };
}
