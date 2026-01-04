import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { PipelineExecutionInput, PipelineExecutionResult } from '../../handlers/types.js';
import type { HubPipeline, ProviderProtocol } from './types.js';
import type { ProviderErrorRuntimeMetadata } from '@jsonstudio/llms/dist/router/virtual-router/types.js';
import { writeClientSnapshot } from '../../../providers/core/utils/snapshot-writer.js';
import { mapProviderProtocol, asRecord } from './provider-utils.js';
import { attachProviderRuntimeMetadata } from '../../../providers/core/runtime/provider-runtime-metadata.js';
import { extractAnthropicToolAliasMap } from './anthropic-tool-alias.js';
import { enhanceProviderRequestId } from '../../utils/request-id-manager.js';
import { emitProviderError } from '../../../providers/core/utils/provider-error-reporter.js';
import type { ProviderRuntimeManager } from './runtime-manager.js';
import type { StatsManager, UsageMetrics } from './stats-manager.js';
import { extractSessionIdentifiersFromMetadata } from '../../../../sharedmodule/llmswitch-core/dist/conversion/hub/pipeline/session-identifiers.js';
import {
  convertProviderResponse as bridgeConvertProviderResponse,
  createSnapshotRecorder as bridgeCreateSnapshotRecorder
} from '../../../modules/llmswitch/bridge.js';
import type { ProviderError } from '../../../providers/core/api/provider-types.js';

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

type HubPipelineResult = {
  providerPayload: Record<string, unknown>;
  target: {
    providerKey: string;
    providerType: string;
    outboundProfile: string;
    runtimeKey?: string;
    processMode?: string;
    compatibilityProfile?: string;
  };
  routingDecision?: { routeName?: string };
  processMode: string;
  metadata: Record<string, unknown>;
};

const MAX_PROVIDER_ATTEMPTS = 3;

export class HubRequestExecutor implements RequestExecutor {
  constructor(private readonly deps: RequestExecutorDeps) { }

  async execute(input: PipelineExecutionInput): Promise<PipelineExecutionResult> {
    this.deps.stats.recordRequestStart(input.requestId);
    const requestStartedAt = Date.now();
    let statsRecorded = false;
    const finalizeStats = (options?: { usage?: UsageMetrics; error?: boolean }) => {
      if (statsRecorded) {
        return;
      }
      this.deps.stats.recordCompletion(input.requestId, options);
      statsRecorded = true;
    };
    try {
      const hubPipeline = this.ensureHubPipeline();
      const initialMetadata = this.buildRequestMetadata(input);
      const inboundClientHeaders = this.cloneClientHeaders(initialMetadata?.clientHeaders);
      const providerRequestId = input.requestId;
      const clientRequestId = this.resolveClientRequestId(initialMetadata, providerRequestId);

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
      const maxAttempts = MAX_PROVIDER_ATTEMPTS;
      const originalRequestSnapshot = this.cloneRequestPayload(input.body);
      let attempt = 0;
      let lastError: unknown;

      while (attempt < maxAttempts) {
        attempt += 1;
        const metadataForAttempt = this.decorateMetadataForAttempt(
          initialMetadata,
          attempt,
          excludedProviderKeys
        );
        const clientHeadersForAttempt =
          this.cloneClientHeaders(metadataForAttempt?.clientHeaders) || inboundClientHeaders;
        if (clientHeadersForAttempt) {
          metadataForAttempt.clientHeaders = clientHeadersForAttempt;
        }
        metadataForAttempt.clientRequestId = clientRequestId;
        this.logStage(`${pipelineLabel}.start`, providerRequestId, {
          endpoint: input.entryEndpoint,
          stream: metadataForAttempt.stream,
          attempt
        });

        const pipelineResult = await this.runHubPipeline(hubPipeline, input, metadataForAttempt);
        const pipelineMetadata = pipelineResult.metadata ?? {};
        const mergedMetadata = { ...metadataForAttempt, ...pipelineMetadata };
        const mergedClientHeaders =
          this.cloneClientHeaders(mergedMetadata?.clientHeaders) || clientHeadersForAttempt;
        if (mergedClientHeaders) {
          mergedMetadata.clientHeaders = mergedClientHeaders;
        }
        mergedMetadata.clientRequestId = clientRequestId;
        this.logStage(`${pipelineLabel}.completed`, providerRequestId, {
          route: pipelineResult.routingDecision?.routeName,
          target: pipelineResult.target?.providerKey,
          attempt
        });

        const providerPayload = pipelineResult.providerPayload;
        const target = pipelineResult.target;
        if (!providerPayload || !target?.providerKey) {
          throw Object.assign(new Error('Virtual router did not produce a provider target'), {
            code: 'ERR_NO_PROVIDER_TARGET',
            requestId: input.requestId
          });
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
          this.ensureClientHeadersOnPayload(providerPayload, clientHeadersForAttempt);
        }
        this.deps.stats.bindProvider(input.requestId, {
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
          const converted = await this.convertProviderResponseIfNeeded({
            entryEndpoint: input.entryEndpoint,
            providerType: handle.providerType,
            requestId: input.requestId,
            wantsStream: wantsStreamBase,
            originalRequest: originalRequestSnapshot,
            processMode: pipelineResult.processMode,
            response: normalized,
            pipelineMetadata: mergedMetadata
          });
          const usage = this.extractUsageFromResult(converted, mergedMetadata);
          aggregatedUsage = this.mergeUsageMetrics(aggregatedUsage, usage);

          finalizeStats({ usage: aggregatedUsage, error: false });
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
          const runtimeMetadata: ProviderErrorRuntimeMetadata & { providerFamily?: string } = {
            requestId: input.requestId,
            providerKey: target.providerKey,
            providerId: handle.providerId,
            providerType: handle.providerType,
            providerProtocol,
            routeName: pipelineResult.routingDecision?.routeName,
            pipelineId: target.providerKey,
            runtimeKey,
            target
          };
          runtimeMetadata.providerFamily = handle.providerFamily;
          emitProviderError({
            error,
            stage: 'provider.send',
            runtime: runtimeMetadata,
            dependencies: this.deps.getModuleDependencies()
          });
          lastError = error;
          const shouldRetry = attempt < maxAttempts && this.shouldRetryProviderError(error);
          if (!shouldRetry) {
            throw error;
          }
          if (target.providerKey) {
            excludedProviderKeys.add(target.providerKey);
          }
          this.logStage('provider.retry', input.requestId, {
            providerKey: target.providerKey,
            attempt,
            nextAttempt: attempt + 1,
            excluded: Array.from(excludedProviderKeys),
            reason: this.describeRetryReason(error)
          });
          continue;
        }
      }

      throw lastError ?? new Error('Provider execution failed without response');
    } catch (error: unknown) {
      finalizeStats({ error: true });
      throw error;
    }

  }

  private ensureHubPipeline(): HubPipeline {
    const pipeline = this.deps.getHubPipeline();
    if (!pipeline) {
      throw new Error('Hub pipeline runtime is not initialized');
    }
    return pipeline;
  }

  private async runHubPipeline(
    hubPipeline: HubPipeline,
    input: PipelineExecutionInput,
    metadata: Record<string, unknown>
  ): Promise<HubPipelineResult> {
    const payload = asRecord(input.body);
    const pipelineInput: PipelineExecutionInput & {
      payload: Record<string, unknown>;
      endpoint: string;
      id: string;
    } = {
      ...input,
      id: input.requestId,
      endpoint: input.entryEndpoint,
      metadata,
      payload
    };
    const result = await hubPipeline.execute(pipelineInput);
    if (!result.providerPayload || !result.target?.providerKey) {
      throw Object.assign(new Error('Virtual router did not produce a provider target'), {
        code: 'ERR_NO_PROVIDER_TARGET',
        requestId: input.requestId
      });
    }
    const processMode = (result.metadata?.processMode as string | undefined) ?? 'chat';
    return {
      providerPayload: result.providerPayload,
      target: result.target,
      routingDecision: result.routingDecision ?? undefined,
      processMode,
      metadata: result.metadata ?? {}
    };
  }

  private cloneClientHeaders(source: unknown): Record<string, string> | undefined {
    if (!source || typeof source !== 'object') {
      return undefined;
    }
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim()) {
        normalized[key] = value;
      }
    }
    return Object.keys(normalized).length ? normalized : undefined;
  }

  private ensureClientHeadersOnPayload(payload: unknown, headers: Record<string, string>): void {
    if (!payload || typeof payload !== 'object') {
      return;
    }
    const carrier = payload as { metadata?: Record<string, unknown> };
    const existing = carrier.metadata && typeof carrier.metadata === 'object'
      ? carrier.metadata
      : {};
    carrier.metadata = {
      ...existing,
      clientHeaders: existing.clientHeaders ?? headers
    };
  }

  private resolveClientRequestId(metadata: Record<string, unknown>, fallback: string): string {
    const clientRequestId = typeof metadata.clientRequestId === 'string' && metadata.clientRequestId.trim()
      ? metadata.clientRequestId.trim()
      : undefined;
    return clientRequestId || fallback;
  }

  private buildRequestMetadata(input: PipelineExecutionInput): Record<string, unknown> {
    const userMeta = asRecord(input.metadata);
    const headers = asRecord(input.headers);
    const inboundUserAgent = this.extractHeaderValue(headers, 'user-agent');
    const inboundOriginator = this.extractHeaderValue(headers, 'originator');
    const normalizedClientHeaders =
      this.cloneClientHeaders((userMeta as { clientHeaders?: unknown }).clientHeaders) ||
      this.cloneClientHeaders(
        (headers?.['clientHeaders'] as Record<string, unknown> | undefined) ?? undefined
      );
    const resolvedUserAgent =
      typeof userMeta.userAgent === 'string' && userMeta.userAgent.trim()
        ? userMeta.userAgent.trim()
        : inboundUserAgent;
    const resolvedOriginator =
      typeof userMeta.clientOriginator === 'string' && userMeta.clientOriginator.trim()
        ? userMeta.clientOriginator.trim()
        : inboundOriginator;
    const routeHint = this.extractRouteHint(input) ?? userMeta.routeHint;
    const processMode = (userMeta.processMode as string) || 'chat';
    const metadata: Record<string, unknown> = {
      ...userMeta,
      entryEndpoint: input.entryEndpoint,
      processMode,
      direction: 'request',
      stage: 'inbound',
      routeHint,
      stream: userMeta.stream === true,
      ...(resolvedUserAgent ? { userAgent: resolvedUserAgent } : {}),
      ...(resolvedOriginator ? { clientOriginator: resolvedOriginator } : {})
    };

    if (normalizedClientHeaders) {
      metadata.clientHeaders = normalizedClientHeaders;
    }

    const sessionIdentifiers = extractSessionIdentifiersFromMetadata(metadata);
    if (sessionIdentifiers.sessionId) {
      metadata.sessionId = sessionIdentifiers.sessionId;
    }
    if (sessionIdentifiers.conversationId) {
      metadata.conversationId = sessionIdentifiers.conversationId;
    }

    return metadata;
  }

  private extractHeaderValue(
    headers: Record<string, unknown> | undefined,
    name: string
  ): string | undefined {
    if (!headers) {
      return undefined;
    }
    const target = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== target) {
        continue;
      }
      if (typeof value === 'string') {
        return value.trim() || undefined;
      }
      if (Array.isArray(value) && value.length) {
        return String(value[0]).trim() || undefined;
      }
      return undefined;
    }
    return undefined;
  }

  private extractRouteHint(input: PipelineExecutionInput): string | undefined {
    const header = (input.headers as Record<string, unknown>)?.['x-route-hint'];
    if (typeof header === 'string' && header.trim()) {
      return header.trim();
    }
    if (Array.isArray(header) && header[0]) {
      return String(header[0]);
    }
    return undefined;
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
    providerType?: string;
    requestId: string;
    wantsStream: boolean;
    originalRequest?: Record<string, unknown> | undefined;
    processMode?: string;
    response: PipelineExecutionResult;
    pipelineMetadata?: Record<string, unknown>;
  }): Promise<PipelineExecutionResult> {
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
    const body = options.response.body;
    if (!body || typeof body !== 'object') {
      return options.response;
    }
    try {
      const providerProtocol = mapProviderProtocol(options.providerType);
      const metadataBag = asRecord(options.pipelineMetadata);
      const aliasMap = extractAnthropicToolAliasMap(metadataBag);
      const originalModelId = this.extractClientModelId(metadataBag, options.originalRequest);
      const baseContext: Record<string, unknown> = {
        ...(metadataBag ?? {})
      };
      if (typeof (metadataBag as Record<string, unknown> | undefined)?.routeName === 'string') {
        baseContext.routeId = (metadataBag as Record<string, unknown>).routeName as string;
      }
      baseContext.requestId = options.requestId;
      baseContext.entryEndpoint = options.entryEndpoint || entry;
      baseContext.providerProtocol = providerProtocol;
      baseContext.originalModelId = originalModelId;
      const adapterContext = baseContext;
      if (aliasMap) {
        (adapterContext as Record<string, unknown>).anthropicToolNameMap = aliasMap;
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
        const nestedEntryLower = nestedEntry.toLowerCase();

        // 基于首次 HubPipeline metadata + 调用方注入的 metadata 构建新的请求 metadata。
        // 不在 Host 层编码 servertool/web_search 等语义，由 llmswitch-core 负责。
        const nestedMetadata: Record<string, unknown> = {
          ...(metadataBag ?? {}),
          ...nestedExtra,
          entryEndpoint: nestedEntry,
          direction: 'request',
          stage: 'inbound'
        };

        // 针对 reenterPipeline 的入口端点，纠正 providerProtocol，避免沿用外层协议。
        if (nestedEntryLower.includes('/v1/chat/completions')) {
          nestedMetadata.providerProtocol = 'openai-chat';
        } else if (nestedEntryLower.includes('/v1/responses')) {
          nestedMetadata.providerProtocol = 'openai-responses';
        } else if (nestedEntryLower.includes('/v1/messages')) {
          nestedMetadata.providerProtocol = 'anthropic-messages';
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
        providerProtocol,
        providerResponse: body as Record<string, unknown>,
        context: adapterContext,
        entryEndpoint: options.entryEndpoint || entry,
        wantsStream: options.wantsStream,
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
      const providerProtocol = mapProviderProtocol(options.providerType);

      // 对于 Gemini 等基于 SSE 的 provider，如果 llmswitch-core 报告
      // “Failed to convert SSE payload ...” 之类错误，说明上游流式响应已异常
      // 终止（如 Cloud Code 终止/上下文超限），继续回退到原始 SSE 只会让
      // 客户端挂起。因此在此类场景下直接抛出错误，让 HTTP 层返回明确的
      // 5xx/4xx，而不是静默退回原始 payload。
      const isSseConvertFailure =
        typeof message === 'string' &&
        message.toLowerCase().includes('failed to convert sse payload');

      if (providerProtocol === 'gemini-chat' && isSseConvertFailure) {
        console.error(
          '[RequestExecutor] Fatal SSE decode error for Gemini provider, bubbling as HTTP error',
          error
        );
        throw error;
      }

      console.error('[RequestExecutor] Failed to convert provider response via llmswitch-core', error);
      return options.response;
    }
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
    if (process.env.ROUTECODEX_USAGE_LOG === '0') {
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
        return normalized;
      }
    }
    return undefined;
  }

  private normalizeUsage(value: unknown): UsageMetrics | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const prompt =
      typeof record.prompt_tokens === 'number'
        ? record.prompt_tokens
        : typeof record.input_tokens === 'number'
          ? record.input_tokens
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

  private buildVisionFollowupPayload(options: {
    originalPayload?: Record<string, unknown>;
    visionResponse: PipelineExecutionResult;
  }): Record<string, unknown> | null {
    const { originalPayload, visionResponse } = options;
    if (!originalPayload || typeof originalPayload !== 'object') {
      return null;
    }
    const clone = this.cloneRequestPayload(originalPayload) ?? { ...(originalPayload as Record<string, unknown>) };
    if (!clone) {
      return null;
    }
    const visionText = this.extractVisionDescription(visionResponse?.body);
    if (!visionText) {
      return null;
    }
    if (this.rewriteResponsesInput(clone, visionText)) {
      return clone;
    }
    if (this.rewriteChatMessages(clone, visionText)) {
      return clone;
    }
    return null;
  }

  private rewriteResponsesInput(payload: Record<string, unknown>, visionText: string): boolean {
    const inputList = (payload as { input?: unknown }).input;
    if (!Array.isArray(inputList)) {
      return false;
    }
    for (let i = inputList.length - 1; i >= 0; i -= 1) {
      const item = inputList[i];
      if (!item || typeof item !== 'object') {
        continue;
      }
      const role = typeof (item as Record<string, unknown>).role === 'string'
        ? ((item as Record<string, unknown>).role as string)
        : '';
      if (role !== 'user') {
        continue;
      }
      const contentBlocks = Array.isArray((item as Record<string, unknown>).content)
        ? ([...(item as { content: unknown[] }).content] as unknown[])
        : [];
      const originalText = this.extractTextFromContentBlocks(contentBlocks, ['input_text', 'text']);
      const textType = this.detectContentTextType(contentBlocks, 'input_text');
      const composed = this.composeVisionUserText(visionText, originalText);
      (item as Record<string, unknown>).content = [
        {
          type: textType,
          text: composed
        }
      ];
      inputList[i] = item;
      return true;
    }
    return false;
  }

  private rewriteChatMessages(payload: Record<string, unknown>, visionText: string): boolean {
    const messages = (payload as { messages?: unknown }).messages;
    if (!Array.isArray(messages)) {
      return false;
    }
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (!message || typeof message !== 'object') {
        continue;
      }
      const role = typeof (message as Record<string, unknown>).role === 'string'
        ? ((message as Record<string, unknown>).role as string)
        : '';
      if (role !== 'user') {
        continue;
      }
      const contentBlocks = Array.isArray((message as Record<string, unknown>).content)
        ? ([...(message as { content: unknown[] }).content] as unknown[])
        : [];
      const originalText = this.extractTextFromContentBlocks(contentBlocks, ['text']);
      const textType = this.detectContentTextType(contentBlocks, 'text');
      const composed = this.composeVisionUserText(visionText, originalText);
      (message as Record<string, unknown>).content = [
        {
          type: textType,
          text: composed
        }
      ];
      messages[i] = message;
      return true;
    }
    return false;
  }

  private extractTextFromContentBlocks(content: unknown, allowedTypes: string[]): string {
    if (typeof content === 'string') {
      return content;
    }
    if (!Array.isArray(content)) {
      return '';
    }
    const collected: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') {
        continue;
      }
      const typeValue = typeof (block as Record<string, unknown>).type === 'string'
        ? ((block as Record<string, unknown>).type as string)
        : '';
      if (allowedTypes.length && !allowedTypes.includes(typeValue)) {
        continue;
      }
      const textValue = (block as Record<string, unknown>).text;
      if (typeof textValue === 'string' && textValue.trim()) {
        collected.push(textValue.trim());
      }
    }
    return collected.join('\n');
  }

  private detectContentTextType(content: unknown, fallback: 'text' | 'input_text'): string {
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') {
          continue;
        }
        const typeValue = (block as Record<string, unknown>).type;
        if (typeof typeValue === 'string' && (typeValue === 'text' || typeValue === 'input_text')) {
          return typeValue;
        }
      }
    }
    return fallback;
  }

  private composeVisionUserText(visionText: string, originalText?: string): string {
    const sections: string[] = [];
    const cleanedVision = (visionText || '').trim();
    if (cleanedVision) {
      sections.push(`【图片分析】\n${cleanedVision}`);
    }
    const cleanedOriginal = (originalText || '').trim();
    if (cleanedOriginal) {
      sections.push(`【用户原始请求】\n${cleanedOriginal}`);
    }
    return sections.join('\n\n');
  }

  private extractVisionDescription(body: unknown): string | null {
    if (!body) {
      return null;
    }
    if (typeof body === 'string') {
      const trimmed = body.trim();
      return trimmed.length ? trimmed : null;
    }
    if (typeof body !== 'object') {
      return null;
    }
    const record = body as Record<string, unknown>;
    const direct = this.extractTextCandidate(record);
    if (direct) {
      return direct;
    }
    if (record.response && typeof record.response === 'object') {
      const responseNode = record.response as Record<string, unknown>;
      const nested = this.extractTextCandidate(responseNode);
      if (nested) {
        return nested;
      }
      const output = responseNode.output;
      if (Array.isArray(output)) {
        for (const entry of output) {
          if (entry && typeof entry === 'object') {
            const nestedText = this.extractTextCandidate(entry as Record<string, unknown>);
            if (nestedText) {
              return nestedText;
            }
          }
        }
      }
    }
    if (Array.isArray(record.output)) {
      for (const entry of record.output) {
        if (entry && typeof entry === 'object') {
          const nested = this.extractTextCandidate(entry as Record<string, unknown>);
          if (nested) {
            return nested;
          }
        }
      }
    }
    const choices = record.choices;
    if (Array.isArray(choices)) {
      for (const choice of choices) {
        if (!choice || typeof choice !== 'object') {
          continue;
        }
        const message = (choice as Record<string, unknown>).message;
        if (message && typeof message === 'object') {
          const msg = message as Record<string, unknown>;
          const content = msg.content;
          if (typeof content === 'string' && content.trim()) {
            return content.trim();
          }
          if (Array.isArray(content)) {
            for (const part of content) {
              if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') {
                const textValue = ((part as Record<string, unknown>).text as string).trim();
                if (textValue) {
                  return textValue;
                }
              }
            }
          }
        }
      }
    }
    return null;
  }

  private extractTextCandidate(record: Record<string, unknown>): string | null {
    const candidates: Array<{ key: string; allowJson?: boolean }> = [
      { key: 'output_text', allowJson: true },
      { key: 'text' },
      { key: 'content' }
    ];
    for (const candidate of candidates) {
      if (!(candidate.key in record)) {
        continue;
      }
      const text = this.normalizeTextCandidateValue(
        record[candidate.key],
        candidate.allowJson === true
      );
      if (text) {
        return text;
      }
    }
    return null;
  }

  private normalizeTextCandidateValue(value: unknown, allowJsonStringify = false): string | null {
    if (!value) {
      return null;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length ? trimmed : null;
    }
    if (Array.isArray(value)) {
      const collected: string[] = [];
      for (const entry of value) {
        const nested = this.normalizeTextCandidateValue(entry, allowJsonStringify);
        if (nested) {
          collected.push(nested);
        }
      }
      return collected.length ? collected.join('\n') : null;
    }
    if (typeof value === 'object') {
      const bag = value as Record<string, unknown>;
      const textField = bag.text;
      if (typeof textField === 'string' && textField.trim()) {
        return textField.trim();
      }
      const summaryField = bag.summary;
      if (typeof summaryField === 'string' && summaryField.trim()) {
        return summaryField.trim();
      }
      if ('content' in bag) {
        const nested = this.normalizeTextCandidateValue(bag.content, allowJsonStringify);
        if (nested) {
          return nested;
        }
      }
      if (allowJsonStringify) {
        try {
          const serialized = JSON.stringify(value, null, 2);
          return serialized.trim() || null;
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  private decorateMetadataForAttempt(
    base: Record<string, unknown>,
    attempt: number,
    excludedProviderKeys: Set<string>
  ): Record<string, unknown> {
    const clone = this.cloneMetadata(base);
    clone.retryAttempt = attempt;
    if (excludedProviderKeys.size > 0) {
      clone.excludedProviderKeys = Array.from(excludedProviderKeys);
    } else if (clone.excludedProviderKeys) {
      delete clone.excludedProviderKeys;
    }
    return clone;
  }

  private cloneMetadata(source: Record<string, unknown>): Record<string, unknown> {
    const structuredCloneFn = (globalThis as { structuredClone?: <T>(value: T) => T }).structuredClone;
    if (typeof structuredCloneFn === 'function') {
      try {
        return structuredCloneFn(source);
      } catch {
        // fall through to JSON fallback
      }
    }
    try {
      return JSON.parse(JSON.stringify(source));
    } catch {
      return { ...source };
    }
  }

  private shouldRetryProviderError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const providerError = error as ProviderError;
    if (providerError.retryable === true) {
      return true;
    }
    const status = this.extractErrorStatusCode(error);
    if (status === 429 || status === 408 || status === 425) {
      return true;
    }
    if (typeof status === 'number' && status >= 500) {
      return true;
    }
    return false;
  }

  private extractErrorStatusCode(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') {
      return undefined;
    }
    const statusCandidates: Array<number | undefined> = [];
    const directStatus = (error as { statusCode?: unknown }).statusCode;
    if (typeof directStatus === 'number') {
      statusCandidates.push(directStatus);
    }
    const secondaryStatus = (error as { status?: unknown }).status;
    if (typeof secondaryStatus === 'number') {
      statusCandidates.push(secondaryStatus);
    }
    const detailStatus = (error as { details?: unknown }).details;
    if (detailStatus && typeof detailStatus === 'object') {
      const nestedStatus = (detailStatus as { status?: unknown }).status;
      if (typeof nestedStatus === 'number') {
        statusCandidates.push(nestedStatus);
      }
    }
    const response = (error as { response?: unknown }).response;
    if (response && typeof response === 'object') {
      const respStatus = (response as { status?: unknown }).status;
      if (typeof respStatus === 'number') {
        statusCandidates.push(respStatus);
      }
      const respStatusCode = (response as { statusCode?: unknown }).statusCode;
      if (typeof respStatusCode === 'number') {
        statusCandidates.push(respStatusCode);
      }
    }
    const explicit = statusCandidates.find((candidate): candidate is number => typeof candidate === 'number');
    if (typeof explicit === 'number') {
      return explicit;
    }
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      const match = message.match(/HTTP\s+(\d{3})/i);
      if (match) {
        const parsed = Number.parseInt(match[1], 10);
        if (!Number.isNaN(parsed)) {
          return parsed;
        }
      }
    }
    return undefined;
  }

  private describeRetryReason(error: unknown): string {
    if (!error) {
      return 'unknown';
    }
    if (error instanceof Error && error.message) {
      return error.message;
    }
    if (typeof (error as { message?: unknown }).message === 'string') {
      return (error as { message: string }).message;
    }
    return String(error);
  }
}

export function createRequestExecutor(deps: RequestExecutorDeps): RequestExecutor {
  return new HubRequestExecutor(deps);
}
