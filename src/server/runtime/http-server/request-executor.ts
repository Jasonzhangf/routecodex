import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { PipelineExecutionInput, PipelineExecutionResult } from '../../handlers/types.js';
import type { HubPipeline, ProviderHandle, ProviderProtocol } from './types.js';
import { attachProviderRuntimeMetadata } from '../../../providers/core/runtime/provider-runtime-metadata.js';
import type { StatsManager } from './stats-manager.js';
import {
  buildRequestMetadata,
  cloneClientHeaders,
  decorateMetadataForAttempt,
  ensureClientHeadersOnPayload,
  resolveClientRequestId
} from './executor-metadata.js';
import {
  type ConvertProviderResponseOptions,
  convertProviderResponseIfNeeded as convertProviderResponseWithBridge
} from './executor/provider-response-converter.js';
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
  type SseWrapperErrorInfo
} from './executor/sse-error-handler.js';
import {
  type UsageMetrics,
  extractUsageFromResult,
  mergeUsageMetrics
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
  isSseDecodeRateLimitError,
  resolveAntigravityMaxProviderAttempts,
  shouldRotateAntigravityAliasOnRetry
} from './executor/request-retry-helpers.js';
import {
  cloneRequestPayload,
  extractProviderModel,
  extractResponseStatus,
  normalizeProviderResponse,
  resolveRequestSemantics
} from './executor/provider-response-utils.js';
import {
  isPoolExhaustedPipelineError,
  mergeMetadataPreservingDefined,
  resolvePoolCooldownWaitMs,
  writeInboundClientSnapshot
} from './executor/request-executor-core-utils.js';
import { resolveProviderRuntimeOrThrow } from './executor/provider-runtime-resolver.js';
import { resolveProviderRequestContext } from './executor/provider-request-context.js';
import { logUsageSummary } from './executor/usage-logger.js';
import { isServerToolEnabled } from './servertool-admin-state.js';
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
      let poolCooldownWaitBudgetMs = 3 * 60 * 1000;

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
          if (isPoolExhaustedPipelineError(pipelineError)) {
            const cooldownWaitMs = resolvePoolCooldownWaitMs(pipelineError);
            if (
              cooldownWaitMs &&
              attempt < maxAttempts &&
              poolCooldownWaitBudgetMs >= cooldownWaitMs
            ) {
              this.logStage('provider.route_pool_cooldown_wait', providerRequestId, {
                attempt,
                waitMs: cooldownWaitMs,
                waitBudgetMs: poolCooldownWaitBudgetMs,
                reason: 'provider_pool_cooling_down'
              });
              poolCooldownWaitBudgetMs -= cooldownWaitMs;
              await new Promise((resolve) => setTimeout(resolve, cooldownWaitMs));
              attempt = Math.max(0, attempt - 1);
              continue;
            }
            if (lastError) {
              throw lastError;
            }
          }
          throw pipelineError;
        }
        const pipelineMetadata = pipelineResult.metadata ?? {};
        const mergedMetadata = mergeMetadataPreservingDefined(metadataForAttempt, pipelineMetadata);
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
        } else if (Object.prototype.hasOwnProperty.call(mergedMetadata, 'compatibilityProfile')) {
          delete mergedMetadata.compatibilityProfile;
        }

        const { runtimeKey, handle } = await resolveProviderRuntimeOrThrow({
          requestId: input.requestId,
          target: {
            providerKey: target.providerKey,
            outboundProfile: String((target as any).outboundProfile || ''),
            providerType: String((target as any).providerType || '')
          },
          routeName: pipelineResult.routingDecision?.routeName,
          runtimeKeyHint: target.runtimeKey,
          runtimeManager: this.deps.runtimeManager,
          dependencies: this.deps.getModuleDependencies()
        });

        const providerContext = resolveProviderRequestContext({
          providerRequestId,
          entryEndpoint: input.entryEndpoint,
          target: {
            providerKey: target.providerKey,
            outboundProfile: target.outboundProfile as ProviderProtocol
          },
          handle,
          runtimeKey,
          providerPayload,
          mergedMetadata
        });
        if (providerContext.requestId !== input.requestId) {
          input.requestId = providerContext.requestId;
        }
        const { providerProtocol, providerModel, providerLabel } = providerContext;
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
          const requestSemantics = resolveRequestSemantics(
            pipelineResult.processedRequest as Record<string, unknown> | undefined,
            pipelineResult.standardizedRequest as Record<string, unknown> | undefined
          );
          const serverToolsEnabled = isServerToolEnabled();
          const converted = await this.convertProviderResponseIfNeeded({
            entryEndpoint: input.entryEndpoint,
            providerProtocol,
            providerType: handle.providerType,
            requestId: input.requestId,
            serverToolsEnabled,
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
          logUsageSummary(input.requestId, {
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
  private logStage(stage: string, requestId: string, details?: Record<string, unknown>): void {
    this.deps.logStage(stage, requestId, details);
  }

  private async convertProviderResponseIfNeeded(options: ConvertProviderResponseOptions): Promise<PipelineExecutionResult> {
    return convertProviderResponseWithBridge(options, { runtimeManager: this.deps.runtimeManager, executeNested: (nestedInput) => this.execute(nestedInput) });
  }

}

export function createRequestExecutor(deps: RequestExecutorDeps): RequestExecutor {
  return new HubRequestExecutor(deps);
}
