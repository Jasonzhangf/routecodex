import type { PipelineExecutionResult } from '../../../handlers/types.js';
import type { UsageMetrics } from './usage-aggregator.js';
import type { StatsManager } from '../stats-manager.js';
import type { ProviderTrafficGovernorLike } from '../provider-traffic-governor.js';
import {
  detectAssistantSanitizationPlaceholder,
  detectRetryableEmptyAssistantResponse,
  detectStoplessTerminationWithoutFinalization,
  persistPayloadContractProviderSnapshots
} from './request-executor-response-contract.js';
import { extractUsageFromResult, mergeUsageMetrics } from './usage-aggregator.js';
import { extractStatusCodeFromError } from './utils.js';

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
  return {
    ...args.converted,
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
      sessionId: args.mergedMetadata.sessionId,
      conversationId: args.mergedMetadata.conversationId,
      projectPath:
        args.readString(args.mergedMetadata.clientWorkdir)
        ?? args.readString(args.mergedMetadata.client_workdir)
        ?? args.readString(args.mergedMetadata.workdir)
        ?? args.readString(args.mergedMetadata.cwd)
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
  const errMsg =
    bodyForError && bodyForError.error && typeof bodyForError.error === 'object'
      ? String((bodyForError.error as any).message || bodyForError.error || '')
      : '';
  const statusCode = typeof converted.status === 'number' ? converted.status : 500;
  const errorToThrow: any = new Error(errMsg && errMsg.trim().length ? errMsg : `HTTP ${statusCode}`);
  errorToThrow.statusCode = statusCode;
  errorToThrow.status = statusCode;
  errorToThrow.response = { data: bodyForError };
  errorToThrow.requestExecutorProviderErrorStage = 'provider.http';
  throw errorToThrow;
}

function createResponseContractError(args: {
  message: string;
  code: 'EMPTY_ASSISTANT_RESPONSE' | 'STOPLESS_FINALIZATION_MISSING';
  stage: 'host.response_contract' | 'host.stopless_contract';
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
  stoplessMode?: 'on' | 'off' | 'endless';
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
    phase: 'provider-request' | 'provider-response';
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

  const emptyAssistantSignal = detectRetryableEmptyAssistantResponse(args.converted.body, args.requestSemantics);
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
      message: `Upstream returned empty assistant payload: ${emptyAssistantSignal.reason}`,
      code: 'EMPTY_ASSISTANT_RESPONSE',
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

  const stoplessTerminationSignal = detectStoplessTerminationWithoutFinalization(
    args.converted.body,
    args.stoplessMode
  );
  if (stoplessTerminationSignal) {
    const bodyForError =
      args.converted.body && typeof args.converted.body === 'object'
        ? (args.converted.body as Record<string, unknown>)
        : undefined;
    args.logStage('host.stopless_finalization_missing', args.inputRequestId, {
      providerKey: args.providerKey,
      marker: stoplessTerminationSignal.marker,
      reason: stoplessTerminationSignal.reason,
      stoplessMode: args.stoplessMode,
      attempt: args.attempt
    });
    createResponseContractError({
      message: `Stopless contract violated: ${stoplessTerminationSignal.reason}`,
      code: 'STOPLESS_FINALIZATION_MISSING',
      stage: 'host.stopless_contract',
      body: bodyForError
    });
  }

  args.logStage('provider.usage_extract.start', args.inputRequestId, {
    providerKey: args.providerKey,
    source: 'converted_response',
    attempt: args.attempt
  });
  const usage = extractUsageFromResult(args.converted, args.mergedMetadata) ?? args.providerUsageFallback;
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
  if (args.converted.body && typeof args.converted.body === 'object') {
    const body = args.converted.body as Record<string, unknown>;
    if (!('__sse_responses' in body)) {
      args.stats.recordToolUsage({ providerKey: args.providerKey, model: args.providerModel }, body);
    }
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
