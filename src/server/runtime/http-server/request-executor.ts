import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { PipelineExecutionInput, PipelineExecutionResult } from '../../handlers/types.js';
import type { HubPipeline, ProviderProtocol } from './types.js';
import { writeClientSnapshot } from '../../../providers/core/utils/snapshot-writer.js';
import { asRecord } from './provider-utils.js';
import { attachProviderRuntimeMetadata } from '../../../providers/core/runtime/provider-runtime-metadata.js';
import { extractAnthropicToolAliasMap } from './anthropic-tool-alias.js';
import { enhanceProviderRequestId } from '../../utils/request-id-manager.js';
import type { ProviderRuntimeManager } from './runtime-manager.js';
import type { StatsManager, UsageMetrics } from './stats-manager.js';
import {
  buildRequestMetadata,
  cloneClientHeaders,
  decorateMetadataForAttempt,
  ensureClientHeadersOnPayload,
  resolveClientRequestId
} from './executor-metadata.js';
import { describeRetryReason, isNetworkTransportError, shouldRetryProviderError, waitBeforeRetry } from './executor-provider.js';
import {
  convertProviderResponse as bridgeConvertProviderResponse,
  createSnapshotRecorder as bridgeCreateSnapshotRecorder,
} from '../../../modules/llmswitch/bridge.js';
import { ensureHubPipeline, runHubPipeline } from './executor-pipeline.js';
import { buildInfo } from '../../../build-info.js';

export type RequestExecutorDeps = {
  runtimeManager: ProviderRuntimeManager;
  getHubPipeline(): HubPipeline | null;
  getModuleDependencies(): ModuleDependencies;
  logStage(stage: string, requestId: string, details?: Record<string, unknown>): void;
  stats: StatsManager;
};

export interface RequestExecutor {
  execute(input: PipelineExecutionInput): Promise<PipelineExecutionResult>;
}

const DEFAULT_MAX_PROVIDER_ATTEMPTS = 6;
const DEFAULT_ANTIGRAVITY_MAX_PROVIDER_ATTEMPTS = 20;

function resolveBoolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function isUsageLoggingEnabled(): boolean {
  return resolveBoolFromEnv(
    process.env.ROUTECODEX_USAGE_LOG ?? process.env.RCC_USAGE_LOG,
    buildInfo.mode !== 'release'
  );
}

function resolveMaxProviderAttempts(): number {
  const raw = String(
    process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS || process.env.RCC_MAX_PROVIDER_ATTEMPTS || ''
  )
    .trim()
    .toLowerCase();
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  const candidate = Number.isFinite(parsed) ? parsed : DEFAULT_MAX_PROVIDER_ATTEMPTS;
  return Math.max(1, Math.min(20, candidate));
}

function resolveAntigravityMaxProviderAttempts(): number {
  const raw = String(
    process.env.ROUTECODEX_ANTIGRAVITY_MAX_PROVIDER_ATTEMPTS || process.env.RCC_ANTIGRAVITY_MAX_PROVIDER_ATTEMPTS || ''
  )
    .trim()
    .toLowerCase();
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  const candidate = Number.isFinite(parsed) ? parsed : DEFAULT_ANTIGRAVITY_MAX_PROVIDER_ATTEMPTS;
  return Math.max(1, Math.min(60, candidate));
}

function isAntigravityProviderKey(providerKey: string | undefined): boolean {
  return typeof providerKey === 'string' && providerKey.startsWith('antigravity.');
}

function isGoogleAccountVerificationRequiredError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const messageRaw = (err as { message?: unknown }).message;
  const message = typeof messageRaw === 'string' ? messageRaw : '';
  if (!message) {
    return false;
  }
  const lowered = message.toLowerCase();
  return (
    lowered.includes('verify your account') ||
    // Antigravity-Manager alignment: 403 validation gating keywords.
    lowered.includes('validation_required') ||
    lowered.includes('validation required') ||
    lowered.includes('validation_url') ||
    lowered.includes('validation url') ||
    lowered.includes('accounts.google.com/signin/continue') ||
    lowered.includes('support.google.com/accounts?p=al_alert')
  );
}

function isAntigravityReauthRequired403(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const status = extractStatusCodeFromError(err);
  if (status !== 403) {
    return false;
  }
  if (isGoogleAccountVerificationRequiredError(err)) {
    return false;
  }
  const messageRaw = (err as { message?: unknown }).message;
  const message = typeof messageRaw === 'string' ? messageRaw : '';
  if (!message) {
    return false;
  }
  const lowered = message.toLowerCase();
  return (
    lowered.includes('please authenticate with google oauth first') ||
    lowered.includes('authenticate with google oauth') ||
    lowered.includes('missing required authentication credential') ||
    lowered.includes('request is missing required authentication') ||
    lowered.includes('unauthenticated') ||
    lowered.includes('invalid token') ||
    lowered.includes('invalid_grant') ||
    lowered.includes('unauthorized') ||
    lowered.includes('token expired') ||
    lowered.includes('expired token')
  );
}

function shouldRotateAntigravityAliasOnRetry(error: unknown): boolean {
  // Antigravity safety: do not rotate between Antigravity aliases within a single request.
  // Multi-account switching (especially during 4xx/429 states) can cascade into cross-account reauth (403 verify) events.
  return false;
}

function extractStatusCodeFromError(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const direct = (err as any).statusCode;
  if (typeof direct === 'number') return direct;
  const nested = (err as any).status;
  if (typeof nested === 'number') return nested;
  return undefined;
}

function extractRetryErrorSignature(err: unknown): string {
  if (!err || typeof err !== 'object') {
    return 'unknown';
  }
  const status = extractStatusCodeFromError(err);
  if (status === 403 && isGoogleAccountVerificationRequiredError(err)) {
    return '403:GOOGLE_VERIFY';
  }
  if (status === 403 && isAntigravityReauthRequired403(err)) {
    return '403:OAUTH_REAUTH';
  }
  const codeRaw = (err as { code?: unknown }).code;
  const upstreamCodeRaw = (err as { upstreamCode?: unknown }).upstreamCode;
  const upstreamCode =
    typeof upstreamCodeRaw === 'string' && upstreamCodeRaw.trim() ? upstreamCodeRaw.trim() : undefined;
  const code = typeof codeRaw === 'string' && codeRaw.trim() ? codeRaw.trim() : undefined;
  const parts = [
    typeof status === 'number' && Number.isFinite(status) ? String(status) : '',
    upstreamCode || '',
    code || ''
  ].filter((p) => p.length > 0);
  return parts.length ? parts.join(':') : 'unknown';
}

function injectAntigravityRetrySignal(
  metadata: Record<string, unknown>,
  signal: { signature: string; consecutive: number; avoidAllOnRetry?: boolean } | null
): void {
  if (!signal || !signal.signature || signal.consecutive <= 0) {
    return;
  }
  const carrier = metadata as { __rt?: unknown };
  const existing = carrier.__rt && typeof carrier.__rt === 'object' && !Array.isArray(carrier.__rt) ? carrier.__rt : {};
  carrier.__rt = {
    ...(existing as Record<string, unknown>),
    antigravityRetryErrorSignature: signal.signature,
    antigravityRetryErrorConsecutive: signal.consecutive,
    ...(signal.avoidAllOnRetry === true ? { antigravityAvoidAllOnRetry: true } : {})
  };
}

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
      const inboundClientHeaders = cloneClientHeaders(initialMetadata?.clientHeaders);
      const providerRequestId = input.requestId;
      const clientRequestId = resolveClientRequestId(initialMetadata, providerRequestId);

      this.logStage('request.received', providerRequestId, {
        endpoint: input.entryEndpoint,
        stream: initialMetadata.stream === true
      });

      try {
        const headerUa =
          (typeof input.headers?.['user-agent'] === 'string' && input.headers['user-agent']) ||
          (typeof input.headers?.['User-Agent'] === 'string' && input.headers['User-Agent']);
        const headerOriginator =
          (typeof input.headers?.['originator'] === 'string' && input.headers['originator']) ||
          (typeof input.headers?.['Originator'] === 'string' && input.headers['Originator']);
        await writeClientSnapshot({
          entryEndpoint: input.entryEndpoint,
          requestId: input.requestId,
          headers: asRecord(input.headers),
          body: input.body,
          metadata: {
            ...initialMetadata,
            clientRequestId,
            userAgent: headerUa,
            clientOriginator: headerOriginator
          }
        });
      } catch {
        /* snapshot failure should not block request path */
      }

      const pipelineLabel = 'hub';
      let aggregatedUsage: UsageMetrics | undefined;
      const excludedProviderKeys = new Set<string>();
      let maxAttempts = resolveMaxProviderAttempts();
      const originalRequestSnapshot = this.cloneRequestPayload(input.body);
      let attempt = 0;
      let lastError: unknown;
      let initialRoutePool: string[] | null = null;
      let antigravityRetrySignal: { signature: string; consecutive: number; avoidAllOnRetry?: boolean } | null = null;

      while (attempt < maxAttempts) {
        attempt += 1;
        if (originalRequestSnapshot && typeof originalRequestSnapshot === 'object') {
          const cloned =
            this.cloneRequestPayload(originalRequestSnapshot) ??
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

    const pipelineResult = await runHubPipeline(hubPipeline, input, metadataForAttempt);
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
        // Ensure response-side conversion has access to route-selected target metadata (compat profiles, etc.).
        // This is an execution metadata carrier only; tool/routing semantics still live in llmswitch-core.
        if (!mergedMetadata.target) {
          mergedMetadata.target = target;
        }
        if (!mergedMetadata.compatibilityProfile && typeof target.compatibilityProfile === 'string' && target.compatibilityProfile.trim()) {
          mergedMetadata.compatibilityProfile = target.compatibilityProfile.trim();
        }

        const runtimeKey = target.runtimeKey || this.deps.runtimeManager.resolveRuntimeKey(target.providerKey);
        if (!runtimeKey) {
          throw Object.assign(new Error(`Runtime for provider ${target.providerKey} not initialized`), {
            code: 'ERR_RUNTIME_NOT_FOUND',
            requestId: input.requestId
          });
        }

        const handle = this.deps.runtimeManager.getHandleByRuntimeKey(runtimeKey);
        if (!handle) {
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
          this.extractProviderModel(providerPayload) ||
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
        const providerLabel = this.buildProviderLabel(target.providerKey, providerModel);
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
          const responseStatus = this.extractResponseStatus(providerResponse);
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
          const normalized = this.normalizeProviderResponse(providerResponse);
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
          const usage = this.extractUsageFromResult(converted, mergedMetadata);
          aggregatedUsage = this.mergeUsageMetrics(aggregatedUsage, usage);
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
          this.logStage('provider.send.error', input.requestId, {
            providerKey: target.providerKey,
            message: error instanceof Error ? error.message : String(error ?? 'Unknown error'),
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
            if (isNetworkTransportError(error)) {
              await waitBeforeRetry(error);
            }
          } else if (target.providerKey) {
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

  private extractResponseStatus(response: unknown): number | undefined {
    if (!response || typeof response !== 'object') {
      return undefined;
    }
    const candidate = (response as { status?: unknown }).status;
    return typeof candidate === 'number' ? candidate : undefined;
  }

  private normalizeProviderResponse(response: unknown): PipelineExecutionResult {
    const status = this.extractResponseStatus(response);
    const headers = this.normalizeProviderResponseHeaders(
      response && typeof response === 'object' ? (response as Record<string, unknown>).headers : undefined
    );
    const body =
      response && typeof response === 'object' && 'data' in (response as Record<string, unknown>)
        ? (response as Record<string, unknown>).data
        : response;
    return { status, headers, body };
  }

  private normalizeProviderResponseHeaders(headers: unknown): Record<string, string> | undefined {
    if (!headers || typeof headers !== 'object') { return undefined; }
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (typeof value === 'string') {
        normalized[key.toLowerCase()] = value;
      }
    }
    return Object.keys(normalized).length ? normalized : undefined;
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
      const wrapperError = this.extractSseWrapperError(body as Record<string, unknown>);
      if (wrapperError) {
        const error = new Error(`[RequestExecutor] Upstream SSE terminated: ${wrapperError}`) as Error & { code?: string };
        error.code = 'SSE_DECODE_ERROR';
        throw error;
      }
    }
    if (options.processMode === 'passthrough') {
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
      const originalModelId = this.extractClientModelId(metadataBag, options.originalRequest);
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
      const adapterContext = baseContext;
      const compatProfile =
        typeof (metadataBag as Record<string, unknown> | undefined)?.compatibilityProfile === 'string'
          ? String((metadataBag as Record<string, unknown>).compatibilityProfile)
          : metadataBag &&
              typeof metadataBag === 'object' &&
              metadataBag.target &&
              typeof metadataBag.target === 'object' &&
              typeof (metadataBag.target as Record<string, unknown>).compatibilityProfile === 'string'
            ? ((metadataBag.target as Record<string, unknown>).compatibilityProfile as string)
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
        const normalized = this.normalizeProviderResponse(providerResponse);
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

        const nestedInput: PipelineExecutionInput = {
          entryEndpoint: nestedEntry,
          method: 'POST',
          requestId: reenterOpts.requestId,
          headers: {},
          query: {},
          body: reenterOpts.body,
          metadata: nestedMetadata
        };
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
      const errName = typeof errRecord.name === 'string' ? errRecord.name : undefined;
      const isSseDecodeError =
        errCode === 'SSE_DECODE_ERROR' ||
        (errName === 'ProviderProtocolError' && message.toLowerCase().includes('sse'));
      const isServerToolFollowupError =
        errCode === 'SERVERTOOL_FOLLOWUP_FAILED' ||
        errCode === 'SERVERTOOL_EMPTY_FOLLOWUP' ||
        (typeof errCode === 'string' && errCode.startsWith('SERVERTOOL_'));

      if (isSseDecodeError || isServerToolFollowupError) {
        console.error(
          '[RequestExecutor] Fatal conversion error, bubbling as HTTP error',
          error
        );
        throw error;
      }

      console.error('[RequestExecutor] Failed to convert provider response via llmswitch-core', error);
      return options.response;
    }
  }

  private extractSseWrapperError(payload: Record<string, unknown> | undefined): string | undefined {
    return this.findSseWrapperError(payload, 2);
  }

  private findSseWrapperError(
    record: Record<string, unknown> | undefined,
    depth: number
  ): string | undefined {
    if (!record || typeof record !== 'object' || depth < 0) {
      return undefined;
    }
    const mode = record.mode;
    const errVal = record.error;
    if (mode === 'sse' && typeof errVal === 'string' && errVal.trim()) {
      return errVal.trim();
    }
    const nestedKeys = ['body', 'data', 'payload', 'response'];
    for (const key of nestedKeys) {
      const nested = record[key];
      if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
        continue;
      }
      const found = this.findSseWrapperError(nested as Record<string, unknown>, depth - 1);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  private extractClientModelId(
    metadata: Record<string, unknown>,
    originalRequest?: Record<string, unknown>
  ): string | undefined {
    const candidates = [
      metadata.clientModelId,
      metadata.originalModelId,
      (metadata.target && typeof metadata.target === 'object'
        ? (metadata.target as Record<string, unknown>).clientModelId
        : undefined),
      originalRequest && typeof originalRequest === 'object'
        ? (originalRequest as Record<string, unknown>).model
        : undefined,
      originalRequest && typeof originalRequest === 'object'
        ? (originalRequest as Record<string, unknown>).originalModelId
        : undefined
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }
    return undefined;
  }

  private cloneRequestPayload(payload: unknown): Record<string, unknown> | undefined {
    if (!payload || typeof payload !== 'object') { return undefined; }
    try {
      return JSON.parse(JSON.stringify(payload));
    } catch {
      return undefined;
    }
  }

  private extractProviderModel(payload?: Record<string, unknown>): string | undefined {
    if (!payload) {
      return undefined;
    }
    const source =
      payload.data && typeof payload.data === 'object'
        ? (payload.data as Record<string, unknown>)
        : payload;
    const raw = (source as Record<string, unknown>).model;
    if (typeof raw === 'string' && raw.trim()) {
      return raw.trim();
    }
    return undefined;
  }

  private buildProviderLabel(providerKey?: string, model?: string): string | undefined {
    const key = typeof providerKey === 'string' && providerKey.trim() ? providerKey.trim() : undefined;
    const modelId = typeof model === 'string' && model.trim() ? model.trim() : undefined;
    if (!key && !modelId) {
      return undefined;
    }
    if (key && modelId) {
      return `${key}.${modelId}`;
    }
    return key || modelId;
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
    const providerLabel = this.buildProviderLabel(info.providerKey, info.model) ?? '-';
    const prompt = info.usage?.prompt_tokens;
    const completion = info.usage?.completion_tokens;
    const total = info.usage?.total_tokens ?? (prompt !== undefined && completion !== undefined ? prompt + completion : undefined);
    const usageText = `prompt=${prompt ?? 'n/a'} completion=${completion ?? 'n/a'} total=${total ?? 'n/a'}`;
    const latency = info.latencyMs.toFixed(1);
    console.log(`[usage] request ${requestId} provider=${providerLabel} latency=${latency}ms (${usageText})`);
  }

  private extractUsageFromResult(
    result: PipelineExecutionResult,
    metadata?: Record<string, unknown>
  ): UsageMetrics | undefined {
    const estimatedInput = this.extractEstimatedInputTokens(metadata);
    const candidates: unknown[] = [];
    if (metadata && typeof metadata === 'object') {
      const bag = metadata as Record<string, unknown>;
      if (bag.usage) {
        candidates.push(bag.usage);
      }
    }
    if (result.body && typeof result.body === 'object') {
      const body = result.body as Record<string, unknown>;
      if (body.usage) {
        candidates.push(body.usage);
      }
      if (body.response && typeof body.response === 'object') {
        const responseNode = body.response as Record<string, unknown>;
        if (responseNode.usage) {
          candidates.push(responseNode.usage);
        }
      }
    }
    for (const candidate of candidates) {
      const normalized = this.normalizeUsage(candidate);
      if (normalized) {
        const reconciled = this.reconcileUsageWithEstimate(normalized, estimatedInput, candidate);
        return reconciled;
      }
    }
    return undefined;
  }

  private normalizeUsage(value: unknown): UsageMetrics | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const basePrompt =
      typeof record.prompt_tokens === 'number'
        ? record.prompt_tokens
        : typeof record.input_tokens === 'number'
          ? record.input_tokens
          : undefined;
    let cacheRead: number | undefined =
      typeof record.cache_read_input_tokens === 'number' ? record.cache_read_input_tokens : undefined;
    if (cacheRead === undefined && record.input_tokens_details && typeof record.input_tokens_details === 'object') {
      const details = record.input_tokens_details as Record<string, unknown>;
      if (typeof details.cached_tokens === 'number') {
        cacheRead = details.cached_tokens;
      }
    }
    const prompt =
      basePrompt !== undefined || cacheRead !== undefined
        ? (basePrompt ?? 0) + (cacheRead ?? 0)
        : undefined;
    const completion =
      typeof record.completion_tokens === 'number'
        ? record.completion_tokens
        : typeof record.output_tokens === 'number'
          ? record.output_tokens
          : undefined;
    let total =
      typeof record.total_tokens === 'number'
        ? record.total_tokens
        : undefined;
    if (total === undefined && prompt !== undefined && completion !== undefined) {
      total = prompt + completion;
    }
    if (prompt === undefined && completion === undefined && total === undefined) {
      return undefined;
    }
    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: total
    };
  }

  private extractEstimatedInputTokens(metadata?: Record<string, unknown>): number | undefined {
    if (!metadata || typeof metadata !== 'object') {
      return undefined;
    }
    const bag = metadata as Record<string, unknown>;
    const raw =
      (bag.estimatedInputTokens as unknown) ??
      (bag.estimated_tokens as unknown) ??
      (bag.estimatedTokens as unknown);
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      return undefined;
    }
    return value;
  }

  private reconcileUsageWithEstimate(
    usage: UsageMetrics,
    estimatedInput?: number,
    candidate?: unknown
  ): UsageMetrics {
    if (!estimatedInput || !Number.isFinite(estimatedInput) || estimatedInput <= 0) {
      return usage;
    }
    const upstreamPrompt = usage.prompt_tokens ?? usage.total_tokens ?? undefined;
    const completion = usage.completion_tokens ?? 0;

    // 若上游缺失 prompt/total，直接使用我们估算的输入 token。
    if (upstreamPrompt === undefined || upstreamPrompt <= 0) {
      const total = estimatedInput + completion;
      this.patchUsageCandidate(candidate, estimatedInput, completion, total);
      return {
        prompt_tokens: estimatedInput,
        completion_tokens: completion,
        total_tokens: total
      };
    }

    const ratio = upstreamPrompt > 0 ? upstreamPrompt / estimatedInput : 1;
    // 差异过大（数量级不一致）时，优先采用本地估算值。
    if (ratio > 5 || ratio < 0.2) {
      const total = estimatedInput + completion;
      this.patchUsageCandidate(candidate, estimatedInput, completion, total);
      return {
        prompt_tokens: estimatedInput,
        completion_tokens: completion,
        total_tokens: total
      };
    }

    return usage;
  }

  private patchUsageCandidate(
    candidate: unknown,
    prompt: number,
    completion: number,
    total: number
  ): void {
    if (!candidate || typeof candidate !== 'object') {
      return;
    }
    const record = candidate as Record<string, unknown>;
    record.prompt_tokens = prompt;
    record.input_tokens = prompt;
    record.completion_tokens = completion;
    record.output_tokens = completion;
    record.total_tokens = total;
  }

  private mergeUsageMetrics(base?: UsageMetrics, delta?: UsageMetrics): UsageMetrics | undefined {
    if (!delta) {
      return base;
    }
    if (!base) {
      return { ...delta };
    }
    const merged: UsageMetrics = {
      prompt_tokens: (base.prompt_tokens ?? 0) + (delta.prompt_tokens ?? 0),
      completion_tokens: (base.completion_tokens ?? 0) + (delta.completion_tokens ?? 0)
    };
    const total = (base.total_tokens ?? 0) + (delta.total_tokens ?? 0);
    merged.total_tokens = total || undefined;
    return merged;
  }

}

export function createRequestExecutor(deps: RequestExecutorDeps): RequestExecutor {
  return new HubRequestExecutor(deps);
}
