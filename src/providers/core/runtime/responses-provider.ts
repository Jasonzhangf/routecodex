/**
 * ResponsesProvider - 真实 OpenAI Responses SSE 透传 Provider
 *
 * 最小实现：继承 HttpTransportProvider，覆写 ServiceProfile 与发送路径，
 * 在 /v1/responses 入口下一律走上游 /responses 并使用 SSE（Accept: text/event-stream）。
 */

import { PassThrough, Readable } from 'node:stream';

import { DEFAULT_TIMEOUTS } from '../../../constants/index.js';
import { HttpTransportProvider } from './http-transport-provider.js';
import { createProviderContext as createProviderContextFromRequest } from './base-provider-runtime-helpers.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { ServiceProfile, ProviderContext } from '../api/provider-types.js';
import type { UnknownObject } from '../../../types/common-types.js';
import {
  attachProviderSseSnapshotStream,
  shouldCaptureProviderStreamSnapshots,
  writeProviderSnapshot
} from '../utils/snapshot-writer.js';
import {
  buildResponsesJsonFromSseStreamWithNative,
} from '../../../modules/llmswitch/bridge/runtime-integrations.js';
import {
  normalizeResponsesDirectCurrentRequestPayload,
  sanitizeProviderOutboundPayload
} from '../../../modules/llmswitch/bridge/provider-outbound-sanitize-host.js';
import type { HttpClient } from '../utils/http-client.js';
import { ResponsesProtocolClient } from '../../../client/responses/responses-protocol-client.js';
import { extractProviderRuntimeMetadata, type ProviderRuntimeMetadata } from './provider-runtime-metadata.js';
import { resolveProviderFamilyProfile } from './provider-family-profile-utils.js';
import { emitProviderErrorAndWait, buildRuntimeFromProviderContext } from '../utils/provider-error-reporter.js';
import {
  buildSubmitToolOutputsEndpoint,
  buildTargetUrl,
  detectResponsesFailure,
  extractClientRequestId,
  extractEntryEndpoint,
  extractResponsesDirectPassthroughFlag,
  extractResponsesConfig,
  extractStreamFlagFromBody,
  extractSubmitToolOutputsPayload,
  normalizeUpstreamError,
  type ResponsesProviderConfig,
  type ResponsesStreamingMode,
  type SubmitToolOutputsPayload
} from './responses-provider-helpers.js';
import {
  buildResponsesSseIncompleteError,
  buildResponsesSseProviderError,
  inspectResponsesSseBlockForProviderRateLimit
} from './responses-sse-error-guard.js';
import { applyProviderConfiguredErrorMapping } from './provider-configured-error-mapping.js';
import type { ProviderErrorAugmented } from './provider-error-types.js';
import {
  bindRuntimeCarrierFromSource,
  readRuntimeRequestTruthPortNumber
} from '../../../server/runtime/http-server/metadata-center/request-truth-readers.js';
import {
  buildProviderRequestDryRunResponse,
  propagatePipelineDryRunControl,
  shouldRunProviderRequestDryRun,
  writeProviderRequestDryRunSnapshot
} from '../../../debug/pipeline-dry-run.js';
import type { PreparedHttpRequest } from './http-request-executor.js';

type ResponsesHttpClient = Pick<HttpClient, 'post' | 'postStream'> & Partial<Pick<HttpClient, 'postStreamOrResponse'>>;

const buildProviderSseStreamConfig = (context: ProviderContext): {
  idleTimeoutMs?: number;
  headersTimeoutMs?: number;
} => {
  const meta = context.metadata && typeof context.metadata === 'object'
    ? context.metadata as Record<string, unknown>
    : undefined;
  const runtimeMeta = context.runtimeMetadata && typeof context.runtimeMetadata === 'object'
    ? context.runtimeMetadata as Record<string, unknown>
    : undefined;
  const runtimeMetadataRecord =
    context.runtimeMetadata?.metadata && typeof context.runtimeMetadata.metadata === 'object' && !Array.isArray(context.runtimeMetadata.metadata)
      ? context.runtimeMetadata.metadata as Record<string, unknown>
      : undefined;
  const candidate =
    meta?.providerStreamNoContentTimeoutMs
    ?? meta?.streamNoContentTimeoutMs
    ?? meta?.noContentTimeoutMs
    ?? runtimeMetadataRecord?.providerStreamNoContentTimeoutMs
    ?? runtimeMetadataRecord?.streamNoContentTimeoutMs
    ?? runtimeMetadataRecord?.noContentTimeoutMs
    ?? runtimeMeta?.providerStreamNoContentTimeoutMs
    ?? runtimeMeta?.streamNoContentTimeoutMs
    ?? runtimeMeta?.noContentTimeoutMs;
  const headersCandidate =
    meta?.providerStreamHeadersTimeoutMs
    ?? meta?.streamHeadersTimeoutMs
    ?? meta?.headersTimeoutMs
    ?? runtimeMetadataRecord?.providerStreamHeadersTimeoutMs
    ?? runtimeMetadataRecord?.streamHeadersTimeoutMs
    ?? runtimeMetadataRecord?.headersTimeoutMs
    ?? runtimeMeta?.providerStreamHeadersTimeoutMs
    ?? runtimeMeta?.streamHeadersTimeoutMs
    ?? runtimeMeta?.headersTimeoutMs;
  const profileCandidate = context.profile?.extensions?.providerStreamNoContentTimeoutMs;
  const profileHeadersCandidate = context.profile?.extensions?.providerStreamHeadersTimeoutMs;
  const config: {
    idleTimeoutMs?: number;
    headersTimeoutMs?: number;
  } = {};
  if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
    config.idleTimeoutMs = Math.floor(candidate);
  } else if (typeof profileCandidate === 'number' && Number.isFinite(profileCandidate) && profileCandidate > 0) {
    config.idleTimeoutMs = Math.floor(profileCandidate);
  }
  if (typeof headersCandidate === 'number' && Number.isFinite(headersCandidate) && headersCandidate > 0) {
    config.headersTimeoutMs = Math.floor(headersCandidate);
  } else if (typeof profileHeadersCandidate === 'number' && Number.isFinite(profileHeadersCandidate) && profileHeadersCandidate > 0) {
    config.headersTimeoutMs = Math.floor(profileHeadersCandidate);
  }
  return config;
};

function buildDirectResponsesProviderSseStreamConfig(
  context: ProviderContext,
  semanticTimeouts: {
    noContentTimeoutMs?: number;
    contentIdleTimeoutMs?: number;
  }
): {
  idleTimeoutMs?: number;
  headersTimeoutMs?: number;
} {
  const config = buildProviderSseStreamConfig(context);
  const semanticCandidates = [
    semanticTimeouts.noContentTimeoutMs,
    semanticTimeouts.contentIdleTimeoutMs
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
  const semanticCeilingMs = semanticCandidates.length > 0 ? Math.max(...semanticCandidates) : undefined;
  if (typeof semanticCeilingMs !== 'number') {
    return config;
  }
  const minimumTransportIdleMs = Math.floor(semanticCeilingMs + 5_000);
  if (
    typeof config.idleTimeoutMs !== 'number'
    || !Number.isFinite(config.idleTimeoutMs)
    || config.idleTimeoutMs <= minimumTransportIdleMs
  ) {
    config.idleTimeoutMs = minimumTransportIdleMs;
  }
  return config;
}

function readProviderSnapshotEntryPort(metadata: unknown): number | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined;
  }
  const record = metadata as Record<string, unknown>;
  const requestTruthPort = readRuntimeRequestTruthPortNumber(record);
  if (typeof requestTruthPort === 'number') {
    return requestTruthPort;
  }
  for (const value of [
    record.entryPort,
    record.matchedPort,
    record.routecodexLocalPort,
    record.localPort,
    record.portScope
  ]) {
    const numeric = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.floor(numeric);
    }
  }
  return undefined;
}

function readProviderContextSnapshotEntryPort(context: ProviderContext): number | undefined {
  const runtimeMetadata = context.runtimeMetadata;
  const runtimeMetadataRecord =
    runtimeMetadata?.metadata && typeof runtimeMetadata.metadata === 'object' && !Array.isArray(runtimeMetadata.metadata)
      ? runtimeMetadata.metadata as Record<string, unknown>
      : undefined;
  return readProviderSnapshotEntryPort(runtimeMetadataRecord) ?? readProviderSnapshotEntryPort(context.metadata);
}

function applyRequestRuntimeMetadataToProviderContext(
  context: ProviderContext,
  runtimeMetadata: ProviderRuntimeMetadata | undefined
): void {
  if (!runtimeMetadata) {
    return;
  }
  const runtimeMetadataRecord =
    runtimeMetadata.metadata && typeof runtimeMetadata.metadata === 'object' && !Array.isArray(runtimeMetadata.metadata)
      ? runtimeMetadata.metadata as Record<string, unknown>
      : undefined;
  const existingMetadata =
    context.metadata && typeof context.metadata === 'object' && !Array.isArray(context.metadata)
      ? context.metadata
      : undefined;
  const mergedMetadata = runtimeMetadataRecord
    ? { ...(existingMetadata ?? {}), ...runtimeMetadataRecord }
    : existingMetadata;
  const entryPort =
    readProviderSnapshotEntryPort(runtimeMetadataRecord)
    ?? readProviderSnapshotEntryPort(runtimeMetadata as Record<string, unknown>)
    ?? readProviderSnapshotEntryPort(mergedMetadata);
  if (mergedMetadata) {
    if (typeof entryPort === 'number') {
      mergedMetadata.entryPort = entryPort;
      mergedMetadata.matchedPort = entryPort;
      if (runtimeMetadataRecord) {
        runtimeMetadataRecord.entryPort = entryPort;
        runtimeMetadataRecord.matchedPort = entryPort;
      }
    }
    bindRuntimeCarrierFromSource({ target: mergedMetadata, source: runtimeMetadataRecord });
    propagatePipelineDryRunControl(runtimeMetadataRecord, mergedMetadata);
    context.metadata = mergedMetadata;
  }
  context.runtimeMetadata = {
    ...(context.runtimeMetadata ?? {}),
    ...runtimeMetadata,
    ...(mergedMetadata ? { metadata: mergedMetadata } : {})
  };
  if (typeof runtimeMetadata.requestId === 'string' && runtimeMetadata.requestId.trim()) {
    context.requestId = runtimeMetadata.requestId;
  }
  context.providerId = runtimeMetadata.providerId ?? runtimeMetadata.providerKey ?? context.providerId;
  context.providerKey = runtimeMetadata.providerKey ?? context.providerKey;
  context.providerProtocol = runtimeMetadata.providerProtocol ?? context.providerProtocol;
  context.routeName = runtimeMetadata.routeName ?? context.routeName;
  context.target = runtimeMetadata.target ?? context.target;
  context.pipelineId = runtimeMetadata.pipelineId ?? context.pipelineId;
}

function buildDirectResponsesSemanticTimeoutError(code: 'UPSTREAM_STREAM_NO_CONTENT_TIMEOUT' | 'UPSTREAM_STREAM_CONTENT_IDLE_TIMEOUT'): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function computeSemanticTimeoutRemainingMs(
  timeoutMs: number | undefined,
  lastSemanticActivityAt: number
): number | undefined {
  if (!Number.isFinite(timeoutMs) || (timeoutMs ?? 0) <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor((timeoutMs as number) - (Date.now() - lastSemanticActivityAt)));
}

async function readDirectResponsesChunkWithSemanticTimeout(
  iterator: AsyncIterator<unknown>,
  timeoutMs: number | undefined,
  lastSemanticActivityAt: number,
  timeoutCode: 'UPSTREAM_STREAM_NO_CONTENT_TIMEOUT' | 'UPSTREAM_STREAM_CONTENT_IDLE_TIMEOUT'
): Promise<IteratorResult<unknown>> {
  const remainingMs = computeSemanticTimeoutRemainingMs(timeoutMs, lastSemanticActivityAt);
  if (remainingMs === undefined) {
    return await iterator.next();
  }
  let timeoutId: NodeJS.Timeout | null = null;
  const timeoutError = buildDirectResponsesSemanticTimeoutError(timeoutCode);
  try {
    const result = await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<unknown>>((_, reject) => {
        timeoutId = setTimeout(() => reject(timeoutError), remainingMs);
        timeoutId.unref?.();
      })
    ]);
    return result;
  } catch (error) {
    if (error === timeoutError) {
      await iterator.return?.();
    }
    throw error;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function takeNextSseBlock(buffer: string): {
  block: string;
  rawFrame: string;
  rest: string;
} | undefined {
  const match = /\r?\n\r?\n/.exec(buffer);
  if (!match) {
    return undefined;
  }
  const endIndex = match.index + match[0].length;
  return {
    block: buffer.slice(0, match.index),
    rawFrame: buffer.slice(0, endIndex),
    rest: buffer.slice(endIndex),
  };
}

async function prepareDirectResponsesSsePassthroughStream(
  stream: NodeJS.ReadableStream,
  options?: {
    noContentTimeoutMs?: number;
    contentIdleTimeoutMs?: number;
  }
): Promise<NodeJS.ReadableStream> {
  const iterator = stream[Symbol.asyncIterator]();
  const bufferedFrames: string[] = [];
  let pending = '';
  let sawSemanticFrame = false;
  let lastSemanticActivityAt = Date.now();

  const processBlock = async (part: string): Promise<boolean> => {
    const trimmed = part.trim();
    if (!trimmed || trimmed.startsWith(':')) {
      return false;
    }
    const rateLimitPayload = inspectResponsesSseBlockForProviderRateLimit(part);
    if (rateLimitPayload) {
      if (typeof iterator.return === 'function') {
        await iterator.return().catch(() => undefined);
      }
      throw buildResponsesSseProviderError(rateLimitPayload);
    }
    sawSemanticFrame = true;
    lastSemanticActivityAt = Date.now();
    return true;
  };

  const startStreamingRemainder = (output: PassThrough): void => {
    let closed = false;
    output.once('close', () => {
      closed = true;
      void iterator.return?.().catch(() => undefined);
    });
    void (async () => {
      try {
        while (true) {
          const next = await readDirectResponsesChunkWithSemanticTimeout(
            iterator,
            sawSemanticFrame ? options?.contentIdleTimeoutMs : options?.noContentTimeoutMs,
            lastSemanticActivityAt,
            sawSemanticFrame ? 'UPSTREAM_STREAM_CONTENT_IDLE_TIMEOUT' : 'UPSTREAM_STREAM_NO_CONTENT_TIMEOUT'
          );
          if (next.done) {
            break;
          }
          const chunk = Buffer.isBuffer(next.value)
            ? next.value
            : Buffer.from(String(next.value));
          pending += chunk.toString('utf8');
          while (true) {
            const nextFrame = takeNextSseBlock(pending);
            if (!nextFrame) {
              break;
            }
            await processBlock(nextFrame.block);
            pending = nextFrame.rest;
            if (!closed) {
              output.write(nextFrame.rawFrame);
            }
          }
        }
        if (pending) {
          await processBlock(pending);
          const tail = pending;
          pending = '';
          if (!closed) {
            output.write(tail);
          }
        }
        if (!closed) {
          output.end();
        }
      } catch (error) {
        output.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  };

  while (true) {
    const next = await readDirectResponsesChunkWithSemanticTimeout(
      iterator,
      sawSemanticFrame ? options?.contentIdleTimeoutMs : options?.noContentTimeoutMs,
      lastSemanticActivityAt,
      sawSemanticFrame ? 'UPSTREAM_STREAM_CONTENT_IDLE_TIMEOUT' : 'UPSTREAM_STREAM_NO_CONTENT_TIMEOUT'
    );
    if (next.done) {
      break;
    }
    const chunk = Buffer.isBuffer(next.value)
      ? next.value
      : Buffer.from(String(next.value));
    pending += chunk.toString('utf8');
    while (true) {
      const nextFrame = takeNextSseBlock(pending);
      if (!nextFrame) {
        break;
      }
      const semantic = await processBlock(nextFrame.block);
      bufferedFrames.push(nextFrame.rawFrame);
      pending = nextFrame.rest;
      if (semantic) {
        const output = new PassThrough();
        for (const frame of bufferedFrames) {
          output.write(frame);
        }
        startStreamingRemainder(output);
        return output;
      }
    }
  }
  if (pending) {
    const semantic = await processBlock(pending);
    const tail = pending;
    pending = '';
    bufferedFrames.push(tail);
    if (semantic) {
      const output = new PassThrough();
      for (const frame of bufferedFrames) {
        output.write(frame);
      }
      output.end();
      return output;
    }
  }
  throw buildResponsesSseIncompleteError();
}

// feature_id: responses.direct_tool_shape_contract

export class ResponsesProvider extends HttpTransportProvider {
  private readonly responsesClient: ResponsesProtocolClient;

  constructor(config: OpenAIStandardConfig, dependencies: ModuleDependencies) {
    const cfg = extractResponsesConfig(config as unknown as UnknownObject);
    const streamingPref: ResponsesStreamingMode = cfg.streaming ?? 'auto';
    const responsesClient = new ResponsesProtocolClient({
      streaming: streamingPref,
      betaVersion: 'responses-2024-12-17'
    });
    super(config, dependencies, 'responses-http-provider', responsesClient);
    this.responsesClient = responsesClient;
  }

  /**
   * 使用 OpenAI 基础档案，但将默认 endpoint 改为 /responses。
   */
  protected override getServiceProfile(): ServiceProfile {
    const base = super.getServiceProfile();
    return {
      ...base,
      defaultEndpoint: '/responses'
    } as ServiceProfile;
  }

  private normalizeConfiguredUpstreamError(error: unknown, context: ProviderContext): ProviderErrorAugmented {
    const normalizedError = normalizeUpstreamError(error) as ProviderErrorAugmented;
    const statusCode = normalizedError.statusCode ?? normalizedError.status;
    applyProviderConfiguredErrorMapping({
      normalized: normalizedError,
      context,
      statusCode
    });
    return normalizedError;
  }

  /**
   * 覆写内部发送：/v1/responses 入口时按配置选择上游 SSE 或 JSON。
   * stream 标志主要影响 Host -> Client 是否用 SSE，上游传输模式由 ResponsesStreamingMode 控制。
   * 对于 SSE 模式，Provider 必须将上游 SSE 解析为 JSON 再返回 Host（对内一律 JSON）。
   */
  protected override async sendRequestInternal(request: UnknownObject): Promise<unknown> {
    if (extractResponsesDirectPassthroughFlag(request)) {
      return await this.processIncomingDirect(request);
    }

    const endpoint = this.getEffectiveEndpoint();
    const baseHeaders = await this.buildRequestHeaders();
    const headers = await this.finalizeRequestHeaders(baseHeaders, request);

    const context = this.createProviderContext();
    applyRequestRuntimeMetadataToProviderContext(context, extractProviderRuntimeMetadata(request));
    const entryEndpoint = extractEntryEndpoint(request) ?? extractEntryEndpoint(context);

    const submitPayload =
      typeof entryEndpoint === 'string' && entryEndpoint.trim().toLowerCase() === '/v1/responses.submit_tool_outputs'
        ? extractSubmitToolOutputsPayload(request)
        : null;
    if (submitPayload) {
      const submitEndpoint = buildSubmitToolOutputsEndpoint(endpoint, submitPayload.responseId);
      const submitTargetUrl = buildTargetUrl(this.getEffectiveBaseUrl(), submitEndpoint);
      return await this.sendSubmitToolOutputsRequest({
        endpoint: submitEndpoint,
        body: submitPayload.body,
        headers,
        context,
        targetUrl: submitTargetUrl,
        entryEndpoint,
        providerStream: extractStreamFlagFromBody(submitPayload.body),
        httpClient: this.httpClient
      });
    }

    const targetUrl = buildTargetUrl(this.getEffectiveBaseUrl(), endpoint);
    const builtBody = extractResponsesDirectPassthroughFlag(request)
      ? this.buildPassthroughResponsesBody(request)
      : this.responsesClient.buildRequestBody(request);
    const finalBody = await this.sanitizeResponsesProviderOutboundBody(builtBody, context);

    const explicitStream = extractStreamFlagFromBody(finalBody);
    const streamingPreference = this.responsesClient.getStreamingPreference();
    const useSse: boolean =
      streamingPreference === 'always'
        ? true
        : streamingPreference === 'never'
          ? false
          : explicitStream === true;

    const providerStream = explicitStream === true;
    this.responsesClient.ensureStreamFlag(finalBody, useSse);
    this.dependencies.logger?.logModule?.(this.id, 'responses-provider-stream-flag', {
      requestId: context.requestId,
      outboundStream: useSse,
      streamingPreference,
      explicitStream: explicitStream ?? null
    });

    const transportHeaders = {
      ...headers,
      Accept: useSse ? 'text/event-stream' : 'application/json'
    };

    try {
      if (useSse) {
        return await this.sendSseRequest({
          endpoint,
          body: finalBody,
          headers: transportHeaders,
          context,
          targetUrl,
          entryEndpoint,
          providerStream,
          httpClient: this.httpClient
        });
      }

      return await this.sendJsonRequest({
        endpoint,
        body: finalBody,
        headers: transportHeaders,
        context,
        targetUrl,
        entryEndpoint,
        httpClient: this.httpClient
      });
    } catch (error) {
      const normalizedError = this.normalizeConfiguredUpstreamError(error, context);
      await this.snapshotPhase(
        'provider-error',
        context,
        {
          status: normalizedError.statusCode ?? normalizedError.status ?? null,
          code: normalizedError.code ?? null,
          error: normalizedError.message
        },
        headers,
        targetUrl,
        entryEndpoint
      );
      throw normalizedError;
    }
  }

  async processIncomingDirect(request: UnknownObject): Promise<UnknownObject> {
    const directRequest = request as Record<string, unknown>;
    const endpoint = this.getEffectiveEndpoint();
    const baseHeaders = await this.buildRequestHeaders();
    const headers = await this.finalizeRequestHeaders(baseHeaders, directRequest);
    const { context } = createProviderContextFromRequest({
      request: directRequest,
      providerType: this.providerType,
      runtimeProfile: this.getRuntimeProfile(),
      configProviderId: this.config.config.providerId,
      configProviderType: this.config.config.providerType,
      configExtensions:
        this.config.config.extensions && typeof this.config.config.extensions === 'object'
          ? this.config.config.extensions as Record<string, unknown>
          : undefined
    });
    const entryEndpoint = extractEntryEndpoint(directRequest) ?? '/v1/responses';
    const targetUrl = buildTargetUrl(this.getEffectiveBaseUrl(), endpoint);
    const builtBody = this.buildPassthroughResponsesBody(directRequest);
    const runtimeMetadata = extractProviderRuntimeMetadata(directRequest);
    applyRequestRuntimeMetadataToProviderContext(context, runtimeMetadata);
    const metadata = runtimeMetadata?.metadata && typeof runtimeMetadata.metadata === 'object' && !Array.isArray(runtimeMetadata.metadata)
      ? runtimeMetadata.metadata as Record<string, unknown>
      : undefined;
    const routeParams =
      metadata?.routeParams && typeof metadata.routeParams === 'object' && !Array.isArray(metadata.routeParams)
        ? (metadata.routeParams as Record<string, unknown>)
        : undefined;
    const targetModel = typeof runtimeMetadata?.target?.modelId === 'string'
      ? runtimeMetadata.target.modelId.trim()
      : '';
    const runtimeModelId = typeof runtimeMetadata?.modelId === 'string'
      ? runtimeMetadata.modelId.trim()
      : '';
    const routeModel = typeof routeParams?.model === 'string' ? routeParams.model.trim() : '';
    const defaultModel = typeof this.serviceProfile?.defaultModel === 'string'
      ? this.serviceProfile.defaultModel.trim()
      : '';
    const directRequestModel = typeof builtBody.model === 'string' ? builtBody.model.trim() : '';
    const model = directRequestModel || targetModel || runtimeModelId || routeModel || defaultModel;
    if (model) {
      builtBody.model = model;
    }
    const normalizedDirectBodyResult = normalizeResponsesDirectCurrentRequestPayload(builtBody);
    let directBody = normalizedDirectBodyResult.changed ? normalizedDirectBodyResult.payload : builtBody;
    // Provider-family wire compat (e.g. grok ModelInput mapping) must also run on direct.
    const familyProfile = resolveProviderFamilyProfile({
      runtimeMetadata,
      runtimeProfile: this.getRuntimeProfile(),
      configProviderId: (this.config?.config as { providerId?: unknown } | undefined)?.providerId,
      configProviderType: (this.config?.config as { providerType?: unknown } | undefined)?.providerType,
      providerType: this.providerType
    });
    const profileBody = familyProfile?.buildRequestBody?.({
      request: directRequest,
      defaultBody: directBody,
      runtimeMetadata
    });
    if (profileBody && typeof profileBody === 'object' && !Array.isArray(profileBody)) {
      directBody = profileBody as Record<string, unknown>;
    }
    const submitPayload =
      typeof entryEndpoint === 'string' && entryEndpoint.trim().toLowerCase() === '/v1/responses.submit_tool_outputs'
        ? extractSubmitToolOutputsPayload(directBody)
        : null;
    if (submitPayload) {
      const submitEndpoint = buildSubmitToolOutputsEndpoint(endpoint, submitPayload.responseId);
      const submitTargetUrl = buildTargetUrl(this.getEffectiveBaseUrl(), submitEndpoint);
      const providerStream = extractStreamFlagFromBody(submitPayload.body);

      try {
        return await this.sendSubmitToolOutputsRequest({
          endpoint: submitEndpoint,
          body: submitPayload.body,
          headers,
          context,
          targetUrl: submitTargetUrl,
          entryEndpoint,
          providerStream,
          httpClient: this.httpClient,
          skipSanitize: true,
        }) as UnknownObject;
      } catch (error) {
        const normalizedError = this.normalizeConfiguredUpstreamError(error, context);
        await this.snapshotPhase(
          'provider-error',
          context,
          {
            status: normalizedError.statusCode ?? normalizedError.status ?? null,
            code: normalizedError.code ?? null,
            error: normalizedError.message
          },
          headers,
          submitTargetUrl,
          entryEndpoint
        );
        throw normalizedError;
      }
    }
    const explicitStream = extractStreamFlagFromBody(directBody);

    try {
      if (explicitStream === true) {
        return await this.sendDirectSsePassthroughRequest({
          endpoint,
          body: directBody,
          headers,
          context,
          targetUrl,
          entryEndpoint,
          httpClient: this.httpClient
        }) as UnknownObject;
      }

      return await this.sendJsonRequest({
        endpoint,
        body: directBody,
        headers,
        context,
        targetUrl,
        entryEndpoint,
        httpClient: this.httpClient
      }) as UnknownObject;
    } catch (error) {
      const normalizedError = this.normalizeConfiguredUpstreamError(error, context);
      await this.snapshotPhase(
        'provider-error',
        context,
        {
          status: normalizedError.statusCode ?? normalizedError.status ?? null,
          code: normalizedError.code ?? null,
          error: normalizedError.message
        },
        headers,
        targetUrl,
        entryEndpoint
      );
      throw normalizedError;
    }
  }

  /**
   * Direct mode SSE passthrough:
   * keep upstream SSE stream as-is for client bridge (no provider-side SSE->JSON conversion).
   */
  private async sendDirectSsePassthroughRequest(options: {
    endpoint: string;
    body: Record<string, unknown>;
    headers: Record<string, string>;
    context: ProviderContext;
    targetUrl: string;
    entryEndpoint?: string;
    httpClient: ResponsesHttpClient;
  }): Promise<unknown> {
    const { endpoint, body, headers, context, targetUrl, entryEndpoint, httpClient } = options;
    const dryRunResponse = await this.maybeBuildProviderRequestDryRunResponse({
      endpoint,
      body,
      headers: {
        ...headers,
        Accept: 'text/event-stream'
      },
      context,
      targetUrl,
      entryEndpoint,
      wantsSse: true
    });
    if (dryRunResponse) {
      return dryRunResponse;
    }
    const semanticTimeouts = {
      noContentTimeoutMs: this.resolveNoContentTimeoutMs(context),
      contentIdleTimeoutMs: this.resolveContentIdleTimeoutMs(context)
    };
    const upstreamResult = await this.postStreamOrResponse(httpClient, targetUrl, body, {
      ...headers,
      Accept: 'text/event-stream'
    }, buildDirectResponsesProviderSseStreamConfig(context, semanticTimeouts));
    if (upstreamResult.kind === 'response') {
      await this.snapshotPhase(
        'provider-response',
        context,
        {
          mode: upstreamResult.responseKind,
          clientStream: true,
          payload: upstreamResult.response.data ?? null
        },
        headers,
        targetUrl,
        entryEndpoint
      );
      await this.reportResponsesFailureIfNeeded(upstreamResult.response.data, context, {
        expectedMode: 'sse',
        responseKind: upstreamResult.responseKind,
        contentType: upstreamResult.response.headers['content-type'] ?? upstreamResult.response.headers['Content-Type'],
        statusCode: upstreamResult.response.status
      });
      return upstreamResult.response;
    }
    const stream = upstreamResult.stream;

    const preparedStream = await prepareDirectResponsesSsePassthroughStream(stream, semanticTimeouts);

    const streamForHost = shouldCaptureProviderStreamSnapshots()
      ? attachProviderSseSnapshotStream(preparedStream, {
        requestId: context.requestId,
        headers,
        url: targetUrl,
        entryEndpoint,
        entryPort: readProviderContextSnapshotEntryPort(context),
        clientRequestId: extractClientRequestId(context),
        providerKey: context.providerKey,
        providerId: context.providerId,
        metadata: context.metadata
      })
      : preparedStream;

    await this.snapshotPhase(
      'provider-response',
      context,
      {
        mode: 'sse_passthrough',
        clientStream: true
      },
      headers,
      targetUrl,
      entryEndpoint
    );

    // Client-facing transport headers only (not upstream auth/provider wire headers).
    return {
      sseStream: streamForHost,
      status: 200,
      statusText: 'OK',
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'x-upstream-mode': 'sse',
        'x-provider-stream-requested': '1'
      },
      url: targetUrl
    };
  }

  private buildPassthroughResponsesBody(request: UnknownObject): Record<string, unknown> {
    return request;
  }

  private async snapshotPhase(
    phase: 'provider-response' | 'provider-error',
    context: ProviderContext,
    data: unknown,
    headers: Record<string, string>,
    url: string,
    entryEndpoint?: string
  ): Promise<void> {
    try {
      const clientRequestId = extractClientRequestId(context);
      await writeProviderSnapshot({
        phase,
        requestId: context.requestId,
        data,
        headers,
        url,
        entryEndpoint,
        entryPort: readProviderContextSnapshotEntryPort(context),
        clientRequestId,
        providerKey: context.providerKey,
        providerId: context.providerId,
        metadata: context.metadata
      });
    } catch {
      // non-blocking
    }
  }

  /**
   * Shared SSE stream execution block.
   * Opens upstream SSE stream, converts to JSON, captures snapshots, reports failures.
   */
  private async executeSseStream(options: {
    endpoint: string;
    body: Record<string, unknown>;
    headers: Record<string, string>;
    context: ProviderContext;
    targetUrl: string;
    entryEndpoint?: string;
    providerStream: boolean | undefined;
    httpClient: ResponsesHttpClient;
  }): Promise<unknown> {
    const { endpoint, body, headers, context, targetUrl, entryEndpoint, providerStream, httpClient } = options;
    const dryRunResponse = await this.maybeBuildProviderRequestDryRunResponse({
      endpoint,
      body,
      headers: {
        ...headers,
        Accept: 'text/event-stream'
      },
      context,
      targetUrl,
      entryEndpoint,
      wantsSse: true
    });
    if (dryRunResponse) {
      return dryRunResponse;
    }
    const upstreamResult = await this.postStreamOrResponse(httpClient, targetUrl, body, {
      ...headers,
      Accept: 'text/event-stream'
    }, buildProviderSseStreamConfig(context));
    if (upstreamResult.kind === 'response') {
      await this.snapshotPhase(
        'provider-response',
        context,
        {
          mode: upstreamResult.responseKind,
          clientStream: providerStream === true,
          payload: upstreamResult.response.data ?? null
        },
        headers,
        targetUrl,
        entryEndpoint
      );
      await this.reportResponsesFailureIfNeeded(upstreamResult.response.data, context, {
        expectedMode: 'sse',
        responseKind: upstreamResult.responseKind,
        contentType: upstreamResult.response.headers['content-type'] ?? upstreamResult.response.headers['Content-Type'],
        statusCode: upstreamResult.response.status
      });
      return upstreamResult.response;
    }
    const stream = upstreamResult.stream;

    const captureSse = providerStream === true && shouldCaptureProviderStreamSnapshots();
    const streamForHost = captureSse
      ? attachProviderSseSnapshotStream(stream, {
        requestId: context.requestId,
        headers,
        url: targetUrl,
        entryEndpoint,
        entryPort: readProviderContextSnapshotEntryPort(context),
        clientRequestId: extractClientRequestId(context),
        providerKey: context.providerKey,
        providerId: context.providerId,
        metadata: context.metadata
      })
      : stream;

    const json = await buildResponsesJsonFromSseStreamWithNative({
      stream: streamForHost,
      requestId: context.requestId,
      model: typeof body.model === 'string' ? body.model : 'unknown',
      config: {
        noContentTimeoutMs: this.resolveNoContentTimeoutMs(context),
        contentIdleTimeoutMs: this.resolveContentIdleTimeoutMs(context)
      }
    });
    if (!captureSse) {
      await this.snapshotPhase(
        'provider-response',
        context,
        {
          mode: 'sse',
          clientStream: providerStream === true,
          payload: json ?? null
        },
        headers,
        targetUrl,
        entryEndpoint
      );
    }
    await this.reportResponsesFailureIfNeeded(json, context);
    return {
      data: json,
      status: 200,
      statusText: 'OK',
      headers: {
        'x-upstream-mode': 'sse',
        'x-provider-stream-requested': providerStream === true ? '1' : '0'
      },
      url: targetUrl
    };
  }

  private async sendSseRequest(options: {
    endpoint: string;
    body: Record<string, unknown>;
    headers: Record<string, string>;
    context: ProviderContext;
    targetUrl: string;
    entryEndpoint?: string;
    providerStream: boolean | undefined;
    httpClient: ResponsesHttpClient;
  }): Promise<unknown> {
    return this.executeSseStream(options);
  }

  private async postStreamOrResponse(
    httpClient: ResponsesHttpClient,
    targetUrl: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
    streamConfig: {
      timeoutMs?: number;
      idleTimeoutMs?: number;
      headersTimeoutMs?: number;
    }
  ): Promise<Awaited<ReturnType<HttpClient['postStreamOrResponse']>>> {
    if (typeof httpClient.postStreamOrResponse === 'function') {
      return await httpClient.postStreamOrResponse(targetUrl, body, headers, streamConfig);
    }
    return {
      kind: 'stream' as const,
      stream: await httpClient.postStream(targetUrl, body, headers, streamConfig),
      status: 200,
      statusText: 'OK',
      headers: {},
      url: targetUrl
    };
  }

  private buildPreparedRequestForDryRun(options: {
    endpoint: string;
    body: Record<string, unknown>;
    headers: Record<string, string>;
    context: ProviderContext;
    targetUrl: string;
    entryEndpoint?: string;
    wantsSse: boolean;
  }): PreparedHttpRequest {
    return {
      endpoint: options.endpoint,
      headers: options.headers,
      targetUrl: options.targetUrl,
      body: options.body,
      entryEndpoint: options.entryEndpoint,
      clientRequestId: extractClientRequestId(options.context),
      wantsSse: options.wantsSse,
      abortSignal: options.context.abortSignal
    };
  }

  private async maybeBuildProviderRequestDryRunResponse(options: {
    endpoint: string;
    body: Record<string, unknown>;
    headers: Record<string, string>;
    context: ProviderContext;
    targetUrl: string;
    entryEndpoint?: string;
    wantsSse: boolean;
  }): Promise<unknown | undefined> {
    if (!shouldRunProviderRequestDryRun(options.context)) {
      return undefined;
    }
    const requestInfo = this.buildPreparedRequestForDryRun(options);
    await writeProviderRequestDryRunSnapshot({
      requestInfo,
      context: options.context
    });
    return buildProviderRequestDryRunResponse({
      requestInfo,
      context: options.context
    });
  }

  private async sendSubmitToolOutputsRequest(options: {
    endpoint: string;
    body: Record<string, unknown>;
    headers: Record<string, string>;
    context: ProviderContext;
    targetUrl: string;
    entryEndpoint?: string;
    providerStream: boolean | undefined;
    httpClient: ResponsesHttpClient;
    skipSanitize?: boolean;
  }): Promise<unknown> {
    const { context, headers, targetUrl, entryEndpoint } = options;
    const body = options.skipSanitize === true
      ? options.body
      : await this.sanitizeResponsesProviderOutboundBody(options.body, context);
    const dryRunResponse = await this.maybeBuildProviderRequestDryRunResponse({
      endpoint: options.endpoint,
      body,
      headers,
      context,
      targetUrl,
      entryEndpoint,
      wantsSse: options.providerStream === true
    });
    if (dryRunResponse) {
      return dryRunResponse;
    }
    try {
      return await this.executeSseStream({ ...options, body });
    } catch (error) {
      const normalizedError = this.normalizeConfiguredUpstreamError(error, context);
      await this.snapshotPhase(
        'provider-error',
        context,
        {
          status: normalizedError.statusCode ?? normalizedError.status ?? null,
          code: normalizedError.code ?? null,
          error: normalizedError.message
        },
        headers,
        targetUrl,
        entryEndpoint
      );
      throw normalizedError;
    }
  }

  private async sendJsonRequest(options: {
    endpoint: string;
    body: Record<string, unknown>;
    headers: Record<string, string>;
    context: ProviderContext;
    targetUrl: string;
    entryEndpoint?: string;
    httpClient: ResponsesHttpClient;
  }): Promise<unknown> {
    const { endpoint, body, headers, context, targetUrl, entryEndpoint, httpClient } = options;
    const dryRunResponse = await this.maybeBuildProviderRequestDryRunResponse({
      endpoint,
      body,
      headers: {
        ...headers,
        Accept: 'application/json'
      },
      context,
      targetUrl,
      entryEndpoint,
      wantsSse: false
    });
    if (dryRunResponse) {
      return dryRunResponse;
    }
    const response = await httpClient.post(endpoint, body, {
      ...headers,
      Accept: 'application/json'
    });
    await this.snapshotPhase('provider-response', context, response, headers, targetUrl, entryEndpoint);
    await this.reportResponsesFailureIfNeeded(response, context);
    return response;
  }

  private resolveCompatibilityProfile(context: ProviderContext): string | undefined {
    const target = context.target && typeof context.target === 'object'
      ? context.target as Record<string, unknown>
      : undefined;
    const metadata = context.metadata && typeof context.metadata === 'object'
      ? context.metadata as Record<string, unknown>
      : undefined;
    const runtimeMetadata = context.runtimeMetadata && typeof context.runtimeMetadata === 'object'
      ? context.runtimeMetadata as Record<string, unknown>
      : undefined;
    for (const candidate of [
      target?.compatibilityProfile,
      metadata?.compatibilityProfile,
      runtimeMetadata?.compatibilityProfile,
      (this.config.config as { compatibilityProfile?: unknown }).compatibilityProfile,
    ]) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim().toLowerCase();
      }
    }
    return undefined;
  }

  private async sanitizeResponsesProviderOutboundBody(
    body: Record<string, unknown>,
    context: ProviderContext,
    options?: { enforceLayout?: boolean },
  ): Promise<Record<string, unknown>> {
    return await sanitizeProviderOutboundPayload({
      protocol: 'openai-responses',
      compatibilityProfile: this.resolveCompatibilityProfile(context),
      enforceLayout: options?.enforceLayout,
      payload: body,
    });
  }

  private resolveNoContentTimeoutMs(context: ProviderContext): number | undefined {
    const meta = context.metadata && typeof context.metadata === 'object'
      ? context.metadata as Record<string, unknown>
      : undefined;
    const runtimeMeta = context.runtimeMetadata && typeof context.runtimeMetadata === 'object'
      ? context.runtimeMetadata as Record<string, unknown>
      : undefined;
    const runtimeMetadataRecord =
      context.runtimeMetadata?.metadata && typeof context.runtimeMetadata.metadata === 'object' && !Array.isArray(context.runtimeMetadata.metadata)
        ? context.runtimeMetadata.metadata as Record<string, unknown>
        : undefined;
    const candidate =
      meta?.providerStreamNoContentTimeoutMs
      ?? meta?.streamNoContentTimeoutMs
      ?? meta?.noContentTimeoutMs
      ?? runtimeMetadataRecord?.providerStreamNoContentTimeoutMs
      ?? runtimeMetadataRecord?.streamNoContentTimeoutMs
      ?? runtimeMetadataRecord?.noContentTimeoutMs
      ?? runtimeMeta?.providerStreamNoContentTimeoutMs
      ?? runtimeMeta?.streamNoContentTimeoutMs
      ?? runtimeMeta?.noContentTimeoutMs;
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      return Math.floor(candidate);
    }
    const profileCandidate = context.profile?.extensions?.providerStreamNoContentTimeoutMs;
    if (typeof profileCandidate === 'number' && Number.isFinite(profileCandidate) && profileCandidate > 0) {
      return Math.floor(profileCandidate);
    }
    return DEFAULT_TIMEOUTS.PROVIDER_STREAM_NO_CONTENT_TIMEOUT_MS;
  }

  private resolveContentIdleTimeoutMs(context: ProviderContext): number | undefined {
    const meta = context.metadata && typeof context.metadata === 'object'
      ? context.metadata as Record<string, unknown>
      : undefined;
    const runtimeMeta = context.runtimeMetadata && typeof context.runtimeMetadata === 'object'
      ? context.runtimeMetadata as Record<string, unknown>
      : undefined;
    const runtimeMetadataRecord =
      context.runtimeMetadata?.metadata && typeof context.runtimeMetadata.metadata === 'object' && !Array.isArray(context.runtimeMetadata.metadata)
        ? context.runtimeMetadata.metadata as Record<string, unknown>
        : undefined;
    const candidate =
      meta?.providerStreamContentIdleTimeoutMs
      ?? meta?.streamContentIdleTimeoutMs
      ?? meta?.contentIdleTimeoutMs
      ?? runtimeMetadataRecord?.providerStreamContentIdleTimeoutMs
      ?? runtimeMetadataRecord?.streamContentIdleTimeoutMs
      ?? runtimeMetadataRecord?.contentIdleTimeoutMs
      ?? runtimeMeta?.providerStreamContentIdleTimeoutMs
      ?? runtimeMeta?.streamContentIdleTimeoutMs
      ?? runtimeMeta?.contentIdleTimeoutMs;
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      return Math.floor(candidate);
    }
    const profileCandidate = context.profile?.extensions?.providerStreamContentIdleTimeoutMs;
    if (typeof profileCandidate === 'number' && Number.isFinite(profileCandidate) && profileCandidate > 0) {
      return Math.floor(profileCandidate);
    }
    return DEFAULT_TIMEOUTS.PROVIDER_STREAM_CONTENT_IDLE_TIMEOUT_MS;
  }

  private async reportResponsesFailureIfNeeded(
    payload: unknown,
    context: ProviderContext,
    transport?: {
      expectedMode?: 'sse';
      responseKind?: 'json' | 'text';
      contentType?: string;
      statusCode?: number;
    }
  ): Promise<void> {
    const failure = detectResponsesFailure(payload, context, transport);
    if (!failure) {
      return;
    }
    const err = failure.normalizedError as Error & { code?: string; status?: number; statusCode?: number };
    await emitProviderErrorAndWait({
      error: err,
      stage: 'provider.responses',
      runtime: buildRuntimeFromProviderContext(context),
      dependencies: this.dependencies,
      statusCode: failure.statusCode,
      recoverable: failure.recoverable,
      affectsHealth: failure.affectsHealth,
      details: {
        status: failure.status,
        code: failure.code,
        error: failure.rawError
      }
    });
    throw err;
  }
}

export default ResponsesProvider;
