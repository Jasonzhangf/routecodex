import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { PipelineExecutionInput, PipelineExecutionResult } from '../../handlers/types.js';
import type { HubPipeline, ProviderHandle, ProviderProtocol } from './types.js';
import { asRecord } from './provider-utils.js';
import { attachProviderRuntimeMetadata } from '../../../providers/core/runtime/provider-runtime-metadata.js';
import { enhanceProviderRequestId } from '../../utils/request-id-manager.js';
import type { StatsManager } from './stats-manager.js';
import {
  buildRequestMetadata,
  cloneClientHeaders,
  decorateMetadataForAttempt,
  ensureClientHeadersOnPayload,
  resolveClientRequestId
} from './executor-metadata.js';
import {
  convertProviderResponse as bridgeConvertProviderResponse,
  createSnapshotRecorder as bridgeCreateSnapshotRecorder,
} from '../../../modules/llmswitch/bridge.js';
import { applyClientConnectionStateToContext } from '../../utils/client-connection-state.js';
import { injectClockClientPrompt } from './clock-client-registry.js';
import { ensureHubPipeline, runHubPipeline } from './executor-pipeline.js';

// Import from new executor submodules
import {
  isUsageLoggingEnabled,
  isVerboseErrorLoggingEnabled
} from './executor/env-config.js';
import {
  resolveMaxProviderAttempts,
  describeRetryReason,
  shouldRetryProviderError,
  waitBeforeRetry
} from './executor/retry-engine.js';
import {
  extractSseWrapperError,
  type SseWrapperErrorInfo
} from './executor/sse-error-handler.js';
import {
  type UsageMetrics,
  extractUsageFromResult,
  mergeUsageMetrics,
  buildUsageLogText
} from './executor/usage-aggregator.js';
import {
  type AntigravityRetrySignal,
  bindClockConversationSession,
  extractRetryErrorSignature,
  extractStatusCodeFromError,
  injectAntigravityRetrySignal,
  isAntigravityProviderKey,
  isAntigravityReauthRequired403,
  isGoogleAccountVerificationRequiredError,
  isRateLimitLikeError,
  isSseDecodeRateLimitError,
  resolveAntigravityMaxProviderAttempts,
  shouldRotateAntigravityAliasOnRetry
} from './executor/request-retry-helpers.js';
import {
  buildProviderLabel,
  cloneRequestPayload,
  extractClientModelId,
  extractProviderModel,
  extractResponseStatus,
  normalizeProviderResponse
} from './executor/provider-response-utils.js';
import {
  isPoolExhaustedPipelineError,
  writeInboundClientSnapshot
} from './executor/request-executor-core-utils.js';

export type RequestExecutorDeps = {
  runtimeManager: {
    resolveRuntimeKey(providerKey?: string, fallback?: string): string | undefined;
    getHandleByRuntimeKey(runtimeKey?: string): ProviderHandle | undefined;
  };
  getHubPipeline(): HubPipeline | null;
  getModuleDependencies(): ModuleDependencies;
  logStage(stage: string, requestId: string, details?: Record<string, unknown>): void;
  stats: StatsManager;
};

export interface RequestExecutor {
  execute(input: PipelineExecutionInput): Promise<PipelineExecutionResult>;
}

const DEFAULT_MAX_PROVIDER_ATTEMPTS = 6;
// Re-export for backward compatibility
export type { SseWrapperErrorInfo };

export class HubRequestExecutor implements RequestExecutor {
  constructor(private readonly deps: RequestExecutorDeps) { }

  async execute(input: PipelineExecutionInput): Promise<PipelineExecutionResult> {
    // Stats must remain stable across provider retries and requestId enhancements.
    const statsRequestId = input.requestId;
    this.deps.stats.recordRequestStart(statsRequestId);
    const requestStartedAt = Date.now();
    let recordedAnyAttempt = false;
    const recordAttempt = (options?: { usage?: UsageMetrics; error?: boolean }) => {
      this.deps.stats.recordCompletion(statsRequestId, options);
      recordedAnyAttempt = true;
    };
    try {
      const hubPipeline = ensureHubPipeline(this.deps.getHubPipeline);
      const initialMetadata = buildRequestMetadata(input);
      bindClockConversationSession(initialMetadata);
      const inboundClientHeaders = cloneClientHeaders(initialMetadata?.clientHeaders);
      const providerRequestId = input.requestId;
      const clientRequestId = resolveClientRequestId(initialMetadata, providerRequestId);

      this.logStage('request.received', providerRequestId, {
        endpoint: input.entryEndpoint,
        stream: initialMetadata.stream === true
      });

      await writeInboundClientSnapshot({ input, initialMetadata, clientRequestId });

      const pipelineLabel = 'hub';
      let aggregatedUsage: UsageMetrics | undefined;
      const excludedProviderKeys = new Set<string>();
      let maxAttempts = resolveMaxProviderAttempts();
      const originalRequestSnapshot = cloneRequestPayload(input.body);
      let attempt = 0;
      let lastError: unknown;
      let initialRoutePool: string[] | null = null;
      let antigravityRetrySignal: AntigravityRetrySignal | null = null;

      while (attempt < maxAttempts) {
        attempt += 1;
        if (originalRequestSnapshot && typeof originalRequestSnapshot === 'object') {
          const cloned =
            cloneRequestPayload(originalRequestSnapshot) ??
            ({ ...(originalRequestSnapshot as Record<string, unknown>) } as Record<string, unknown>);
          input.body = cloned;
        }
        const metadataForAttempt = decorateMetadataForAttempt(initialMetadata, attempt, excludedProviderKeys);
        const clientHeadersForAttempt =
          cloneClientHeaders(metadataForAttempt?.clientHeaders) || inboundClientHeaders;
        if (clientHeadersForAttempt) {
          metadataForAttempt.clientHeaders = clientHeadersForAttempt;
        }
        metadataForAttempt.clientRequestId = clientRequestId;
        injectAntigravityRetrySignal(metadataForAttempt, antigravityRetrySignal);
        this.logStage(`${pipelineLabel}.start`, providerRequestId, {
          endpoint: input.entryEndpoint,
          stream: metadataForAttempt.stream,
          attempt
        });

    let pipelineResult: Awaited<ReturnType<typeof runHubPipeline>>;
        try {
          pipelineResult = await runHubPipeline(hubPipeline, input, metadataForAttempt);
        } catch (pipelineError) {
          if (lastError && isPoolExhaustedPipelineError(pipelineError)) {
            throw lastError;
          }
          throw pipelineError;
        }
        const pipelineMetadata = pipelineResult.metadata ?? {};
        const mergedMetadata = { ...metadataForAttempt, ...pipelineMetadata };
        const mergedClientHeaders =
          cloneClientHeaders(mergedMetadata?.clientHeaders) || clientHeadersForAttempt;
        if (mergedClientHeaders) {
          mergedMetadata.clientHeaders = mergedClientHeaders;
        }
        mergedMetadata.clientRequestId = clientRequestId;
        this.logStage(`${pipelineLabel}.completed`, providerRequestId, {
          route: pipelineResult.routingDecision?.routeName,
          target: pipelineResult.target?.providerKey,
          attempt
        });
        if (!initialRoutePool && Array.isArray(pipelineResult.routingDecision?.pool)) {
          initialRoutePool = [...pipelineResult.routingDecision!.pool];
        }

        const providerPayload = pipelineResult.providerPayload;
        const target = pipelineResult.target;
        if (!providerPayload || !target?.providerKey) {
          throw Object.assign(new Error('Virtual router did not produce a provider target'), {
            code: 'ERR_NO_PROVIDER_TARGET',
            requestId: input.requestId
          });
        }
        // Ensure response-side conversion always uses the route-selected target metadata.
        // ServerTool followups may carry stale metadata from the previous hop; response compat
        // must follow the current target/provider, not the inherited request profile.
        mergedMetadata.target = target;
        if (typeof target.compatibilityProfile === 'string' && target.compatibilityProfile.trim()) {
          mergedMetadata.compatibilityProfile = target.compatibilityProfile.trim();
        }

        const runtimeKey = target.runtimeKey || this.deps.runtimeManager.resolveRuntimeKey(target.providerKey);
        if (!runtimeKey) {
          const runtimeResolveError = Object.assign(new Error(`Runtime for provider ${target.providerKey} not initialized`), {
            code: 'ERR_RUNTIME_NOT_FOUND',
            requestId: input.requestId,
            retryable: true
          });
          try {
            const { emitProviderError } = await import('../../../providers/core/utils/provider-error-reporter.js');
            emitProviderError({
              error: runtimeResolveError,
              stage: 'provider.runtime.resolve',
              runtime: {
                requestId: input.requestId,
                providerKey: target.providerKey,
                providerId: target.providerKey.split('.')[0],
                providerType: String((target as any).providerType || 'unknown'),
                providerProtocol: String((target as any).outboundProfile || ''),
                routeName: pipelineResult.routingDecision?.routeName,
                pipelineId: target.providerKey,
                target
              },
              dependencies: this.deps.getModuleDependencies(),
              recoverable: false,
              affectsHealth: true,
              details: {
                reason: 'runtime_not_initialized',
                providerKey: target.providerKey
              }
            });
          } catch {
            // best-effort
          }
          throw Object.assign(new Error(`Runtime for provider ${target.providerKey} not initialized`), {
            code: 'ERR_RUNTIME_NOT_FOUND',
            requestId: input.requestId
          });
        }

        const handle = this.deps.runtimeManager.getHandleByRuntimeKey(runtimeKey);
        if (!handle) {
          const runtimeMissingError = Object.assign(new Error(`Provider runtime ${runtimeKey} not found`), {
            code: 'ERR_PROVIDER_NOT_FOUND',
            requestId: input.requestId,
            retryable: true
          });
          try {
            const { emitProviderError } = await import('../../../providers/core/utils/provider-error-reporter.js');
            emitProviderError({
              error: runtimeMissingError,
              stage: 'provider.runtime.resolve',
              runtime: {
                requestId: input.requestId,
                providerKey: target.providerKey,
                providerId: target.providerKey.split('.')[0],
                providerType: String((target as any).providerType || 'unknown'),
                providerProtocol: String((target as any).outboundProfile || ''),
                routeName: pipelineResult.routingDecision?.routeName,
                pipelineId: target.providerKey,
                runtimeKey,
                target
              },
              dependencies: this.deps.getModuleDependencies(),
              recoverable: false,
              affectsHealth: true,
              details: {
                reason: 'runtime_handle_missing',
                providerKey: target.providerKey,
                runtimeKey
              }
            });
          } catch {
            // best-effort
          }
          throw Object.assign(new Error(`Provider runtime ${runtimeKey} not found`), {
            code: 'ERR_PROVIDER_NOT_FOUND',
            requestId: input.requestId
          });
        }

        const providerProtocol = (target.outboundProfile as ProviderProtocol) || handle.providerProtocol;
        const metadataModel =
          mergedMetadata?.target && typeof mergedMetadata.target === 'object'
            ? (mergedMetadata.target as Record<string, unknown>).clientModelId
            : undefined;
        const rawModel =
          extractProviderModel(providerPayload) ||
          (typeof metadataModel === 'string' ? metadataModel : undefined);
        const providerAlias =
          typeof target.providerKey === 'string' && target.providerKey.includes('.')
            ? target.providerKey.split('.').slice(0, 2).join('.')
            : target.providerKey;
        const providerIdToken = providerAlias || handle.providerId || runtimeKey;
        if (!providerIdToken) {
          throw Object.assign(new Error('Provider identifier missing for request'), {
            code: 'ERR_PROVIDER_ID_MISSING',
            requestId: providerRequestId
          });
        }

        const enhancedRequestId = enhanceProviderRequestId(providerRequestId, {
          entryEndpoint: input.entryEndpoint,
          providerId: providerIdToken,
          model: rawModel
        });
        if (enhancedRequestId !== input.requestId) {
          input.requestId = enhancedRequestId;
        }

        const providerModel = rawModel;
        const providerLabel = buildProviderLabel(target.providerKey, providerModel);
        if (clientHeadersForAttempt) {
          ensureClientHeadersOnPayload(providerPayload, clientHeadersForAttempt);
        }
        this.deps.stats.bindProvider(statsRequestId, {
          providerKey: target.providerKey,
          providerType: handle.providerType,
          model: providerModel
        });

        this.logStage('provider.prepare', input.requestId, {
          providerKey: target.providerKey,
          runtimeKey,
          protocol: providerProtocol,
          providerType: handle.providerType,
          providerFamily: handle.providerFamily,
          model: providerModel,
          providerLabel,
          attempt
        });

        attachProviderRuntimeMetadata(providerPayload, {
          requestId: input.requestId,
          providerId: handle.providerId,
          providerKey: target.providerKey,
          providerType: handle.providerType,
          providerFamily: handle.providerFamily,
          providerProtocol,
          pipelineId: target.providerKey,
          routeName: pipelineResult.routingDecision?.routeName,
          runtimeKey,
          target,
          metadata: mergedMetadata,
          compatibilityProfile: target.compatibilityProfile
        });

        this.logStage('provider.send.start', input.requestId, {
          providerKey: target.providerKey,
          runtimeKey,
          protocol: providerProtocol,
          providerType: handle.providerType,
          providerFamily: handle.providerFamily,
          model: providerModel,
          providerLabel,
          attempt
        });

        try {
          const providerResponse = await handle.instance.processIncoming(providerPayload);
          const responseStatus = extractResponseStatus(providerResponse);
          this.logStage('provider.send.completed', input.requestId, {
            providerKey: target.providerKey,
            status: responseStatus,
            providerType: handle.providerType,
            providerFamily: handle.providerFamily,
            model: providerModel,
            providerLabel,
            attempt
          });
          const wantsStreamBase = Boolean(input.metadata?.inboundStream ?? input.metadata?.stream);
          const normalized = normalizeProviderResponse(providerResponse);
          const pipelineProcessed = pipelineResult.processedRequest;
          const pipelineStandardized = pipelineResult.standardizedRequest;
          const requestSemantics =
            pipelineProcessed && typeof pipelineProcessed === 'object' && typeof (pipelineProcessed as any).semantics === 'object'
              ? ((pipelineProcessed as any).semantics as Record<string, unknown>)
              : pipelineStandardized && typeof pipelineStandardized === 'object' && typeof (pipelineStandardized as any).semantics === 'object'
                ? ((pipelineStandardized as any).semantics as Record<string, unknown>)
                : undefined;
          const converted = await this.convertProviderResponseIfNeeded({
            entryEndpoint: input.entryEndpoint,
            providerProtocol,
            providerType: handle.providerType,
            requestId: input.requestId,
            wantsStream: wantsStreamBase,
            originalRequest: originalRequestSnapshot,
            requestSemantics,
            processMode: pipelineResult.processMode,
            response: normalized,
            pipelineMetadata: mergedMetadata
          });
          // Treat upstream 429 as provider failure across protocols to avoid
          // silently returning success and to let Virtual Router failover to other candidates.
          // Keep existing Gemini compatibility behavior for 400/4xx thoughtSignature-like failures.
          const convertedStatus = typeof converted.status === 'number' ? converted.status : undefined;
          const isGlobalRetryable429 = convertedStatus === 429;
          const isGeminiCompatFailure =
            typeof convertedStatus === 'number' &&
            convertedStatus >= 400 &&
            (isAntigravityProviderKey(target.providerKey) ||
              (typeof target.providerKey === 'string' && target.providerKey.startsWith('gemini-cli.'))) &&
            providerProtocol === 'gemini-chat';

          if (isGlobalRetryable429 || isGeminiCompatFailure) {
            const bodyForError = converted.body && typeof converted.body === 'object' ? (converted.body as Record<string, unknown>) : undefined;
            const errMsg =
              bodyForError && bodyForError.error && typeof bodyForError.error === 'object'
                ? String((bodyForError.error as any).message || bodyForError.error || '')
                : '';
            const statusCode = typeof convertedStatus === 'number' ? convertedStatus : 500;
            const errorToThrow: any = new Error(errMsg && errMsg.trim().length ? errMsg : `HTTP ${statusCode}`);
            errorToThrow.statusCode = statusCode;
            errorToThrow.status = statusCode;
            errorToThrow.response = { data: bodyForError };
            try {
              const { emitProviderError } = await import('../../../providers/core/utils/provider-error-reporter.js');
              emitProviderError({
                error: errorToThrow,
                stage: 'provider.http',
                runtime: {
                  requestId: input.requestId,
                  providerKey: target.providerKey,
                  providerId: handle.providerId,
                  providerType: handle.providerType,
                  providerFamily: handle.providerFamily,
                  providerProtocol,
                  routeName: pipelineResult.routingDecision?.routeName,
                  pipelineId: target.providerKey,
                  target,
                  runtimeKey
                },
                dependencies: this.deps.getModuleDependencies(),
                statusCode,
                recoverable: statusCode === 429,
                affectsHealth: true,
                details: {
                  source: 'converted_response_status',
                  convertedStatus: statusCode,
                  wrappedErrorResponse: true
                }
              });
            } catch {
              // best-effort; never block retry/failover path
            }
            throw errorToThrow;
          }
          const usage = extractUsageFromResult(converted, mergedMetadata);
          aggregatedUsage = mergeUsageMetrics(aggregatedUsage, usage);
          if (converted.body && typeof converted.body === 'object') {
            const body = converted.body as Record<string, unknown>;
            if (!('__sse_responses' in body)) {
              this.deps.stats.recordToolUsage(
                { providerKey: target.providerKey, model: providerModel },
                body
              );
            }
          }

          recordAttempt({ usage: aggregatedUsage, error: false });
          this.logUsageSummary(input.requestId, {
            providerKey: target.providerKey,
            model: providerModel,
            usage: aggregatedUsage,
            latencyMs: Date.now() - requestStartedAt
          });
          return converted;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error ?? 'Unknown error');
          this.logStage('provider.send.error', input.requestId, {
            providerKey: target.providerKey,
            message: errorMessage,
            providerType: handle.providerType,
            providerFamily: handle.providerFamily,
            model: providerModel,
            providerLabel,
            attempt
          });
          lastError = error;
          if (isAntigravityProviderKey(target.providerKey)) {
            const signature = extractRetryErrorSignature(error);
            const consecutive: number =
              antigravityRetrySignal && antigravityRetrySignal.signature === signature
                ? antigravityRetrySignal.consecutive + 1
                : 1;
            antigravityRetrySignal = { signature, consecutive };
          } else {
            antigravityRetrySignal = null;
          }
          const status = extractStatusCodeFromError(error);
          if (isSseDecodeRateLimitError(error, status)) {
            try {
              const { emitProviderError } = await import('../../../providers/core/utils/provider-error-reporter.js');
              emitProviderError({
                error,
                stage: 'provider.sse_decode',
                runtime: {
                  requestId: input.requestId,
                  providerKey: target.providerKey,
                  providerId: handle.providerId,
                  providerType: handle.providerType,
                  providerFamily: handle.providerFamily,
                  providerProtocol,
                  routeName: pipelineResult.routingDecision?.routeName,
                  pipelineId: target.providerKey,
                  target,
                  runtimeKey
                },
                dependencies: this.deps.getModuleDependencies(),
                statusCode: 429,
                recoverable: true,
                affectsHealth: true,
                details: {
                  source: 'sse_decode_rate_limit',
                  errorCode: typeof (error as any)?.code === 'string' ? String((error as any).code) : undefined,
                  upstreamCode: typeof (error as any)?.upstreamCode === 'string' ? String((error as any).upstreamCode) : undefined,
                  message: errorMessage
                }
              });
            } catch {
              // best-effort; never block retry/failover path
            }
          }
          const isVerify = status === 403 && isGoogleAccountVerificationRequiredError(error);
          const isReauth = status === 403 && isAntigravityReauthRequired403(error);
          const shouldRetry =
            attempt < maxAttempts &&
            (shouldRetryProviderError(error) ||
              (isAntigravityProviderKey(target.providerKey) && (isVerify || isReauth)));
          if (!shouldRetry) {
            recordAttempt({ error: true });
            throw error;
          }
          // Record this failed provider attempt even if the overall request succeeds later via failover.
          recordAttempt({ error: true });
          const singleProviderPool =
            Boolean(initialRoutePool && initialRoutePool.length === 1 && initialRoutePool[0] === target.providerKey);
          if (singleProviderPool) {
            await waitBeforeRetry(error);
          }
          if (!singleProviderPool && target.providerKey) {
            const is429 = status === 429;
            if (isAntigravityProviderKey(target.providerKey) && (isVerify || is429)) {
              // For Antigravity 403 verify / 429 states:
              // - exclude the current providerKey so we don't immediately retry the same account
              // - avoid ALL other Antigravity aliases on retry (prefer non-Antigravity fallbacks)
              excludedProviderKeys.add(target.providerKey);
              if (antigravityRetrySignal) {
                antigravityRetrySignal.avoidAllOnRetry = true;
              } else {
                antigravityRetrySignal = { signature: extractRetryErrorSignature(error), consecutive: 1, avoidAllOnRetry: true };
              }
            } else if (isAntigravityProviderKey(target.providerKey) && isReauth) {
              // Antigravity OAuth reauth-required 403:
              // - exclude the current providerKey so router can pick another alias
              // - DO NOT avoid all Antigravity on retry; switching aliases is the intended recovery path.
              excludedProviderKeys.add(target.providerKey);
            } else if (!isAntigravityProviderKey(target.providerKey) || shouldRotateAntigravityAliasOnRetry(error)) {
              excludedProviderKeys.add(target.providerKey);
            }
          }
          this.logStage('provider.retry', input.requestId, {
            providerKey: target.providerKey,
            attempt,
            nextAttempt: attempt + 1,
            excluded: Array.from(excludedProviderKeys),
            reason: describeRetryReason(error)
          });
          continue;
        }
      }

      throw lastError ?? new Error('Provider execution failed without response');
    } catch (error: unknown) {
      // If we failed before selecting a provider (no bindProvider/recordAttempt),
      // at least record one error sample for this request.
      if (!recordedAnyAttempt) {
        recordAttempt({ error: true });
      }
      throw error;
    }

  }

  private async convertProviderResponseIfNeeded(options: {
    entryEndpoint?: string;
    providerProtocol: string;
    providerType?: string;
    requestId: string;
    wantsStream: boolean;
    originalRequest?: Record<string, unknown> | undefined;
    requestSemantics?: Record<string, unknown> | undefined;
    processMode?: string;
    response: PipelineExecutionResult;
    pipelineMetadata?: Record<string, unknown>;
  }): Promise<PipelineExecutionResult> {
    const body = options.response.body;
    if (body && typeof body === 'object') {
      const wrapperError = extractSseWrapperError(body as Record<string, unknown>);
      if (wrapperError) {
        const codeSuffix = wrapperError.errorCode ? ` [${wrapperError.errorCode}]` : '';
        const error = new Error(`Upstream SSE error event${codeSuffix}: ${wrapperError.message}`) as Error & {
          code?: string;
          status?: number;
          statusCode?: number;
          retryable?: boolean;
          upstreamCode?: string;
        };
        error.code = 'SSE_DECODE_ERROR';
        if (wrapperError.errorCode) {
          error.upstreamCode = wrapperError.errorCode;
        }
        error.retryable = wrapperError.retryable;
        if (isRateLimitLikeError(wrapperError.message, wrapperError.errorCode)) {
          error.code = 'HTTP_429';
          error.status = 429;
          error.statusCode = 429;
          error.retryable = true;
        } else if (wrapperError.retryable) {
          error.status = 503;
          error.statusCode = 503;
        }
        throw error;
      }
    }
    if (options.processMode === 'passthrough' && !options.wantsStream) {
      return options.response;
    }
    const entry = (options.entryEndpoint || '').toLowerCase();
    const needsAnthropicConversion = entry.includes('/v1/messages');
    const needsResponsesConversion = entry.includes('/v1/responses');
    const needsChatConversion = entry.includes('/v1/chat/completions');
    if (!needsAnthropicConversion && !needsResponsesConversion && !needsChatConversion) {
      return options.response;
    }
    if (!body || typeof body !== 'object') {
      return options.response;
    }
    try {
      const metadataBag = asRecord(options.pipelineMetadata);
      const originalModelId = extractClientModelId(metadataBag, options.originalRequest);
      const assignedModelId =
        typeof (metadataBag as Record<string, unknown> | undefined)?.assignedModelId === 'string'
          ? String((metadataBag as Record<string, unknown>).assignedModelId)
          : metadataBag &&
              typeof metadataBag === 'object' &&
              metadataBag.target &&
              typeof metadataBag.target === 'object' &&
              typeof (metadataBag.target as Record<string, unknown>).modelId === 'string'
            ? ((metadataBag.target as Record<string, unknown>).modelId as string)
            : typeof (metadataBag as Record<string, unknown> | undefined)?.modelId === 'string'
              ? String((metadataBag as Record<string, unknown>).modelId)
              : undefined;
      const baseContext: Record<string, unknown> = {
        ...(metadataBag ?? {})
      };
      if (
        baseContext.capturedChatRequest === undefined &&
        options.originalRequest &&
        typeof options.originalRequest === 'object' &&
        !Array.isArray(options.originalRequest)
      ) {
        baseContext.capturedChatRequest = options.originalRequest;
      }
      if (typeof (metadataBag as Record<string, unknown> | undefined)?.routeName === 'string') {
        baseContext.routeId = (metadataBag as Record<string, unknown>).routeName as string;
      }
      baseContext.requestId = options.requestId;
      baseContext.entryEndpoint = options.entryEndpoint || entry;
      baseContext.providerProtocol = options.providerProtocol;
      baseContext.originalModelId = originalModelId;
      if (assignedModelId && assignedModelId.trim()) {
        baseContext.modelId = assignedModelId.trim();
      }
      applyClientConnectionStateToContext(metadataBag, baseContext);
      const adapterContext = baseContext;
      const compatProfile =
        metadataBag &&
        typeof metadataBag === 'object' &&
        metadataBag.target &&
        typeof metadataBag.target === 'object' &&
        typeof (metadataBag.target as Record<string, unknown>).compatibilityProfile === 'string'
          ? ((metadataBag.target as Record<string, unknown>).compatibilityProfile as string)
          : typeof (metadataBag as Record<string, unknown> | undefined)?.compatibilityProfile === 'string'
            ? String((metadataBag as Record<string, unknown>).compatibilityProfile)
            : undefined;
      if (compatProfile && compatProfile.trim()) {
        adapterContext.compatibilityProfile = compatProfile.trim();
      }
      const stageRecorder = await bridgeCreateSnapshotRecorder(
        adapterContext,
        typeof (adapterContext as Record<string, unknown>).entryEndpoint === 'string'
          ? ((adapterContext as Record<string, unknown>).entryEndpoint as string)
          : options.entryEndpoint || entry
      );

      const providerInvoker = async (invokeOptions: {
        providerKey: string;
        providerType?: string;
        modelId?: string;
        providerProtocol: string;
        payload: Record<string, unknown>;
        entryEndpoint: string;
        requestId: string;
        routeHint?: string;
      }): Promise<{ providerResponse: Record<string, unknown> }> => {
        // 将 server-side 工具的 routeHint 注入到内部 payload 的 metadata，
        // 以便后续在标准 HubPipeline 中保持路由上下文一致（例如强制 web_search）。
        if (invokeOptions.routeHint) {
          const carrier = invokeOptions.payload as { metadata?: Record<string, unknown> };
          const existingMeta =
            carrier.metadata && typeof carrier.metadata === 'object'
              ? (carrier.metadata as Record<string, unknown>)
              : {};
          carrier.metadata = {
            ...existingMeta,
            routeHint: existingMeta.routeHint ?? invokeOptions.routeHint
          };
        }

        // Delegate to existing runtimeManager / Provider V2 stack.
        const runtimeKey = this.deps.runtimeManager.resolveRuntimeKey(invokeOptions.providerKey);
        if (!runtimeKey) {
          throw new Error(`Runtime for provider ${invokeOptions.providerKey} not initialized`);
        }
        const handle = this.deps.runtimeManager.getHandleByRuntimeKey(runtimeKey);
        if (!handle) {
          throw new Error(`Provider runtime ${runtimeKey} not found`);
        }
        const providerResponse = await handle.instance.processIncoming(invokeOptions.payload);
        const normalized = normalizeProviderResponse(providerResponse);
        const bodyPayload =
          normalized.body && typeof normalized.body === 'object'
            ? (normalized.body as Record<string, unknown>)
            : (normalized as unknown as Record<string, unknown>);
        return { providerResponse: bodyPayload };
      };

      const reenterPipeline = async (reenterOpts: {
        entryEndpoint: string;
        requestId: string;
        body: Record<string, unknown>;
        metadata?: Record<string, unknown>;
      }): Promise<{ body?: Record<string, unknown>; __sse_responses?: unknown; format?: string }> => {
        const nestedEntry = reenterOpts.entryEndpoint || options.entryEndpoint || entry;
        const nestedExtra = asRecord(reenterOpts.metadata) ?? {};

        // 基于首次 HubPipeline metadata + 调用方注入的 metadata 构建新的请求 metadata。
        // 不在 Host 层编码 servertool/web_search 等语义，由 llmswitch-core 负责。
        const nestedMetadata: Record<string, unknown> = {
          ...(metadataBag ?? {}),
          ...nestedExtra,
          entryEndpoint: nestedEntry,
          direction: 'request',
          stage: 'inbound'
        };
        // E1: merge internal runtime metadata carrier (`__rt`) instead of clobbering it.
        // ServerTool followup metadata always adds fields under __rt, while the base pipeline
        // metadata may already contain runtime configs (webSearch/clock/etc).
        try {
          const baseRt = asRecord((metadataBag as any)?.__rt) ?? {};
          const extraRt = asRecord((nestedExtra as any)?.__rt) ?? {};
          if (Object.keys(baseRt).length || Object.keys(extraRt).length) {
            (nestedMetadata as any).__rt = { ...baseRt, ...extraRt };
          }
        } catch {
          // best-effort
        }

        // servertool followup 是内部二跳请求：不应继承客户端 headers 偏好（尤其是 Accept），
        // 否则会导致上游返回非 SSE 响应而被当作 SSE 解析，出现“空回复”。
        if (asRecord((nestedMetadata as any).__rt)?.serverToolFollowup === true) {
          delete nestedMetadata.clientHeaders;
          delete nestedMetadata.clientRequestId;
        }

        bindClockConversationSession(nestedMetadata);

        const nestedInput: PipelineExecutionInput = {
          entryEndpoint: nestedEntry,
          method: 'POST',
          requestId: reenterOpts.requestId,
          headers: {},
          query: {},
          body: reenterOpts.body,
          metadata: nestedMetadata
        };

        try {
          const requestBody = reenterOpts.body as Record<string, unknown>;
          const messages = Array.isArray(requestBody.messages) ? (requestBody.messages as unknown[]) : [];
          const lastUser = [...messages]
            .reverse()
            .find((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).role === 'user') as
            | Record<string, unknown>
            | undefined;
          const text = typeof lastUser?.content === 'string' ? String(lastUser.content) : '';
          if (text.includes('<**clock:{') && text.includes('}**>')) {
            await injectClockClientPrompt({
              tmuxSessionId: typeof nestedMetadata.tmuxSessionId === 'string' ? nestedMetadata.tmuxSessionId : undefined,
              sessionId: typeof nestedMetadata.sessionId === 'string' ? nestedMetadata.sessionId : undefined,
              text,
              requestId: reenterOpts.requestId,
              source: 'servertool.reenter'
            });
          }
        } catch {
          // best-effort only
        }

        const nestedResult = await this.execute(nestedInput);
        const nestedBody =
          nestedResult.body && typeof nestedResult.body === 'object'
            ? (nestedResult.body as Record<string, unknown>)
            : undefined;
        return { body: nestedBody };
      };

      const converted = await bridgeConvertProviderResponse({
        providerProtocol: options.providerProtocol,
        providerResponse: body as Record<string, unknown>,
        context: adapterContext,
        entryEndpoint: options.entryEndpoint || entry,
        wantsStream: options.wantsStream,
        requestSemantics: options.requestSemantics,
        providerInvoker,
        stageRecorder,
        reenterPipeline
      });
      if (converted.__sse_responses) {
        return {
          ...options.response,
          body: { __sse_responses: converted.__sse_responses }
        };
      }
      return {
        ...options.response,
        body: converted.body ?? body
      };
    } catch (error) {
      const err = error as Error | unknown;
      const message = err instanceof Error ? err.message : String(err ?? 'Unknown error');

      // 对于 SSE 解码失败（含上游终止），直接抛出错误并透传到 HTTP 层。
      // 否则回退到原始 payload 会让客户端挂起，无法感知失败。
      const errRecord = err as Record<string, unknown>;
      const errCode = typeof errRecord.code === 'string' ? errRecord.code : undefined;
      const upstreamCode = typeof errRecord.upstreamCode === 'string' ? errRecord.upstreamCode : undefined;
      const errName = typeof errRecord.name === 'string' ? errRecord.name : undefined;
      const isSseDecodeError =
        errCode === 'SSE_DECODE_ERROR' ||
        (errName === 'ProviderProtocolError' && message.toLowerCase().includes('sse'));
      const isServerToolFollowupError =
        errCode === 'SERVERTOOL_FOLLOWUP_FAILED' ||
        errCode === 'SERVERTOOL_EMPTY_FOLLOWUP' ||
        (typeof errCode === 'string' && errCode.startsWith('SERVERTOOL_'));

      if (isSseDecodeError || isServerToolFollowupError) {
        if (isSseDecodeError && isRateLimitLikeError(message, errCode, upstreamCode)) {
          (errRecord as any).status = 429;
          (errRecord as any).statusCode = 429;
          (errRecord as any).retryable = true;
          if (typeof errRecord.code !== 'string' || !String(errRecord.code).trim()) {
            (errRecord as any).code = 'HTTP_429';
          }
        }
        if (isVerboseErrorLoggingEnabled()) {
          console.error(
            '[RequestExecutor] Fatal conversion error, bubbling as HTTP error',
            error
          );
        }
        throw error;
      }

      if (isVerboseErrorLoggingEnabled()) {
        console.error('[RequestExecutor] Failed to convert provider response via llmswitch-core', error);
      }
      return options.response;
    }
  }

  private logStage(stage: string, requestId: string, details?: Record<string, unknown>): void {
    this.deps.logStage(stage, requestId, details);
  }

  private logUsageSummary(
    requestId: string,
    info: { providerKey?: string; model?: string; usage?: UsageMetrics; latencyMs: number }
  ): void {
    if (!isUsageLoggingEnabled()) {
      return;
    }
    const providerLabel = buildProviderLabel(info.providerKey, info.model) ?? '-';
    const usageText = buildUsageLogText(info.usage);
    const latency = info.latencyMs.toFixed(1);
    console.log(`[usage] request ${requestId} provider=${providerLabel} latency=${latency}ms (${usageText})`);
  }

}

export function createRequestExecutor(deps: RequestExecutorDeps): RequestExecutor {
  return new HubRequestExecutor(deps);
}
