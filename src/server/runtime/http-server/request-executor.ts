import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { PipelineExecutionInput, PipelineExecutionResult } from '../../handlers/types.js';
import type { HubPipeline, ProviderProtocol } from './types.js';
import type { ProviderErrorRuntimeMetadata } from '@jsonstudio/llms/dist/router/virtual-router/types.js';
import { importCoreModule } from '../../../modules/llmswitch/core-loader.js';
import { writeClientSnapshot } from '../../../providers/core/utils/snapshot-writer.js';
import { mapProviderProtocol, asRecord } from './provider-utils.js';
import { attachProviderRuntimeMetadata } from '../../../providers/core/runtime/provider-runtime-metadata.js';
import { extractAnthropicToolAliasMap } from './anthropic-tool-alias.js';
import { enhanceProviderRequestId } from '../../utils/request-id-manager.js';
import { emitProviderError } from '../../../providers/core/utils/provider-error-reporter.js';
import type { ProviderRuntimeManager } from './runtime-manager.js';
import type { StatsManager, UsageMetrics } from './stats-manager.js';

type ConvertProviderResponseFn = (options: {
  providerProtocol: string;
  providerResponse: Record<string, unknown>;
  context: Record<string, unknown>;
  entryEndpoint: string;
  wantsStream: boolean;
  providerInvoker?: (options: {
    providerKey: string;
    providerType?: string;
    modelId?: string;
    providerProtocol: string;
    payload: Record<string, unknown>;
    entryEndpoint: string;
    requestId: string;
  }) => Promise<{ providerResponse: Record<string, unknown> }>;
  stageRecorder?: unknown;
}) => Promise<Record<string, unknown> & { __sse_responses?: unknown; body?: unknown }>;
type SnapshotRecorderFactory = (context: Record<string, unknown>, entryEndpoint: string) => unknown;
type ConvertProviderModule = {
  convertProviderResponse?: ConvertProviderResponseFn;
};
type SnapshotRecorderModule = {
  createSnapshotRecorder?: SnapshotRecorderFactory;
};

let convertProviderResponseFn: ConvertProviderResponseFn | null = null;
async function loadConvertProviderResponse(): Promise<ConvertProviderResponseFn> {
  if (convertProviderResponseFn) {
    return convertProviderResponseFn;
  }
  const mod = await importCoreModule<ConvertProviderModule>('conversion/hub/response/provider-response');
  if (!mod?.convertProviderResponse) {
    throw new Error('[RequestExecutor] llmswitch-core 缺少 convertProviderResponse 实现');
  }
  convertProviderResponseFn = mod.convertProviderResponse;
  return convertProviderResponseFn;
}

let createSnapshotRecorderFn: SnapshotRecorderFactory | null = null;
async function loadSnapshotRecorderFactory(): Promise<SnapshotRecorderFactory> {
  if (createSnapshotRecorderFn) {
    return createSnapshotRecorderFn;
  }
  const mod = await importCoreModule<SnapshotRecorderModule>('conversion/hub/snapshot-recorder');
  if (!mod?.createSnapshotRecorder) {
    throw new Error('[RequestExecutor] llmswitch-core 缺少 createSnapshotRecorder 实现');
  }
  createSnapshotRecorderFn = mod.createSnapshotRecorder;
  return createSnapshotRecorderFn;
}

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

export class HubRequestExecutor implements RequestExecutor {
  constructor(private readonly deps: RequestExecutorDeps) {}

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
      const metadata = this.buildRequestMetadata(input);
      const inboundClientHeaders = this.cloneClientHeaders(metadata?.clientHeaders);
      const providerRequestId = input.requestId;
      const clientRequestId = this.resolveClientRequestId(metadata, providerRequestId);

      this.logStage('request.received', providerRequestId, {
        endpoint: input.entryEndpoint,
        stream: metadata.stream === true
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
            ...metadata,
            userAgent: headerUa,
            clientOriginator: headerOriginator
          }
        });
      } catch {
        /* snapshot failure should not block request path */
      }

      const pipelineLabel = 'hub';
      this.logStage(`${pipelineLabel}.start`, providerRequestId, {
        endpoint: input.entryEndpoint,
        stream: metadata.stream
      });
      const originalRequestSnapshot = this.cloneRequestPayload(input.body);
      const pipelineResult = await this.runHubPipeline(hubPipeline, input, metadata);
      const pipelineMetadata = pipelineResult.metadata ?? {};
      const mergedMetadata = { ...metadata, ...pipelineMetadata };
      const mergedClientHeaders = this.cloneClientHeaders(mergedMetadata?.clientHeaders) || inboundClientHeaders;
      if (mergedClientHeaders) {
        mergedMetadata.clientHeaders = mergedClientHeaders;
      }
      this.logStage(`${pipelineLabel}.completed`, providerRequestId, {
        route: pipelineResult.routingDecision?.routeName,
        target: pipelineResult.target?.providerKey
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
      const providerAlias = typeof target.providerKey === 'string' && target.providerKey.includes('.')
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

      mergedMetadata.clientRequestId = clientRequestId;
      const providerModel = rawModel;
      const providerLabel = this.buildProviderLabel(target.providerKey, providerModel);
      if (inboundClientHeaders) {
        this.ensureClientHeadersOnPayload(providerPayload, inboundClientHeaders);
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
        providerLabel
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
        providerLabel
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
          providerLabel
        });
        const normalized = this.normalizeProviderResponse(providerResponse);
        const converted = await this.convertProviderResponseIfNeeded({
          entryEndpoint: input.entryEndpoint,
          providerType: handle.providerType,
          requestId: input.requestId,
          wantsStream: Boolean(input.metadata?.inboundStream ?? input.metadata?.stream),
          originalRequest: originalRequestSnapshot,
          processMode: pipelineResult.processMode,
          response: normalized,
          pipelineMetadata: mergedMetadata
        });
        const usage = this.extractUsageFromResult(converted, mergedMetadata);
        finalizeStats({ usage, error: false });
        this.logUsageSummary(input.requestId, {
          providerKey: target.providerKey,
          model: providerModel,
          usage,
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
          providerLabel
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
        throw error;
      }
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
    return {
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
    if (!headers || typeof headers !== 'object') {return undefined;}
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
      baseContext.requestId = options.requestId;
      baseContext.entryEndpoint = options.entryEndpoint || entry;
      baseContext.providerProtocol = providerProtocol;
      baseContext.originalModelId = originalModelId;
      const adapterContext = baseContext;
      if (aliasMap) {
        (adapterContext as Record<string, unknown>).anthropicToolNameMap = aliasMap;
      }
      const [convertProviderResponse, createSnapshotRecorder] = await Promise.all([
        loadConvertProviderResponse(),
        loadSnapshotRecorderFactory()
      ]);
      const stageRecorder = createSnapshotRecorder(
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
      }): Promise<{ providerResponse: Record<string, unknown> }> => {
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

      const converted = await convertProviderResponse({
        providerProtocol,
        providerResponse: body as Record<string, unknown>,
        context: adapterContext,
        entryEndpoint: options.entryEndpoint || entry,
        wantsStream: options.wantsStream,
        providerInvoker,
        stageRecorder
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
    if (!payload || typeof payload !== 'object') {return undefined;}
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
}

export function createRequestExecutor(deps: RequestExecutorDeps): RequestExecutor {
  return new HubRequestExecutor(deps);
}
