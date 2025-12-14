/**
 * ResponsesProvider - 真实 OpenAI Responses SSE 透传 Provider
 *
 * 最小实现：继承 ChatHttpProvider，覆写 ServiceProfile 与发送路径，
 * 在 /v1/responses 入口下一律走上游 /responses 并使用 SSE（Accept: text/event-stream）。
 */

import { HttpTransportProvider } from './http-transport-provider.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { ServiceProfile, ProviderContext } from '../api/provider-types.js';
import type { UnknownObject } from '../../../types/common-types.js';
import {
  attachProviderSseSnapshotStream,
  shouldCaptureProviderStreamSnapshots,
  writeProviderSnapshot
} from '../utils/snapshot-writer.js';
import { buildResponsesRequestFromChat } from '../../../modules/llmswitch/bridge.js';
import { importCoreModule } from '../../../modules/llmswitch/core-loader.js';
import type { HttpClient } from '../utils/http-client.js';
import { ResponsesProtocolClient } from '../../../client/responses/responses-protocol-client.js';

type EnsureResponsesInstructionsFn = typeof import('@jsonstudio/llms/dist/conversion/shared/responses-instructions.js')['ensureResponsesInstructions'];
let ensureResponsesInstructionsFn: EnsureResponsesInstructionsFn | null = null;

type ResponsesHttpClient = Pick<HttpClient, 'post' | 'postStream'>;
type ResponsesSseConverter = {
  convertSseToJson(stream: unknown, options: { requestId: string; model: string }): Promise<unknown>;
};
async function loadEnsureResponsesInstructions(): Promise<EnsureResponsesInstructionsFn> {
  if (ensureResponsesInstructionsFn) {
    return ensureResponsesInstructionsFn;
  }
  const mod = await importCoreModule<{ ensureResponsesInstructions?: EnsureResponsesInstructionsFn }>(
    'conversion/shared/responses-instructions'
  );
  if (!mod?.ensureResponsesInstructions) {
    throw new Error('[responses-provider] 无法加载 llmswitch-core ensureResponsesInstructions');
  }
  ensureResponsesInstructionsFn = mod.ensureResponsesInstructions;
  return ensureResponsesInstructionsFn;
}

export class ResponsesProvider extends HttpTransportProvider {
  private readonly responsesClient: ResponsesProtocolClient;

  constructor(config: OpenAIStandardConfig, dependencies: ModuleDependencies) {
    const responsesClient = new ResponsesProtocolClient({
      streaming: extractResponsesConfig(config as unknown as UnknownObject).streaming ?? 'auto',
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

  /**
   * 覆写内部发送：/v1/responses 入口时按配置选择上游 SSE 或 JSON。
   * 根据架构约束：Responses 上游不支持 JSON，统一使用 SSE 与上游通信，
   * 但 Provider 必须将上游 SSE 解析为 JSON 再返回 Host（对内一律 JSON）。
   */
  protected override async sendRequestInternal(request: UnknownObject): Promise<unknown> {
    const endpoint = this.getEffectiveEndpoint();
    const baseHeaders = await this.buildRequestHeaders();
    const headers = await this.finalizeRequestHeaders(baseHeaders, request);

    const context = this.createProviderContext();
    const targetUrl = this.buildTargetUrl(this.getEffectiveBaseUrl(), endpoint);

    const settings = this.getResponsesSettings();
    const inboundClientStream = this.normalizeStreamFlag(this.extractStreamFlag(context));
    const finalBody = this.responsesClient.buildRequestBody(request);
    const entryEndpoint = this.extractEntryEndpoint(request) ?? this.extractEntryEndpoint(context);

    await this.ensureResponsesInstructions(finalBody);
    this.applyInstructionsMode(finalBody, settings.instructionsMode);

    const useSse = settings.streaming !== 'never';
    this.responsesClient.ensureStreamFlag(finalBody, useSse);
    const clientRequestedStream = this.resolveClientStreamPreference(settings.streaming, inboundClientStream);

    this.dependencies.logger?.logModule?.(this.id, 'responses-provider-stream-flag', {
      requestId: context.requestId,
      inboundClientStream,
      outboundStream: useSse
    });

    await this.maybeConvertChatPayload(finalBody);

    await this.snapshotPhase('provider-request', context, finalBody, headers, targetUrl, entryEndpoint);

    try {
      if (useSse) {
        return await this.sendSseRequest({
          endpoint,
          body: finalBody,
          headers,
          context,
          targetUrl,
          entryEndpoint,
          clientRequestedStream,
          httpClient: this.httpClient
        });
      }

      return await this.sendJsonRequest({
        endpoint,
        body: finalBody,
        headers,
        context,
        targetUrl,
        entryEndpoint,
        httpClient: this.httpClient
      });
    } catch (error) {
      const normalizedError = this.normalizeUpstreamError(error);
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

  private getResponsesSettings(): ResponsesSettings {
    const cfg = extractResponsesConfig(this.config as unknown as UnknownObject);
    return {
      streaming: cfg.streaming ?? 'auto',
      instructionsMode: cfg.instructionsMode ?? 'default'
    };
  }

  private normalizeStreamFlag(value: unknown): boolean | undefined {
    if (value === true || value === false) {
      return value;
    }
    if (typeof value === 'string') {
      const lowered = value.trim().toLowerCase();
      if (['true', '1', 'yes'].includes(lowered)) {
        return true;
      }
      if (['false', '0', 'no'].includes(lowered)) {
        return false;
      }
    }
    return undefined;
  }

  private buildTargetUrl(baseUrl: string, endpoint: string): string {
    const normalizedBase = baseUrl.replace(/\/$/, '');
    const normalizedEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
    return `${normalizedBase}/${normalizedEndpoint}`;
  }

  private extractStreamFlag(context: ProviderContext): unknown {
    const metadata = context.metadata;
    if (metadata && typeof metadata === 'object' && 'stream' in metadata) {
      return (metadata as Record<string, unknown>).stream;
    }
    return undefined;
  }

  private extractEntryEndpoint(source: unknown): string | undefined {
    if (!source || typeof source !== 'object') {
      return undefined;
    }
    const metadata = (source as { metadata?: unknown }).metadata;
    if (metadata && typeof metadata === 'object' && 'entryEndpoint' in metadata) {
      const value = (metadata as Record<string, unknown>).entryEndpoint;
      return typeof value === 'string' ? value : undefined;
    }
    return undefined;
  }

  private async ensureResponsesInstructions(body: Record<string, unknown>): Promise<void> {
    try {
      const ensureFn = await loadEnsureResponsesInstructions();
      ensureFn(body);
    } catch {
      // non-blocking
    }
  }

  private applyInstructionsMode(body: Record<string, unknown>, mode: InstructionsMode): void {
    if (mode === 'inline') {
      (body as Record<string, unknown>).__rcc_inline_system_instructions = true;
    }
  }

  private resolveClientStreamPreference(pref: StreamPref, inbound: boolean | undefined): boolean {
    if (pref === 'always') {
      return true;
    }
    if (pref === 'never') {
      return false;
    }
    return inbound === true;
  }

  private async maybeConvertChatPayload(body: Record<string, unknown>): Promise<void> {
    const looksResponses = Array.isArray(body.input as unknown[]) || typeof body.instructions === 'string';
    const looksChat = Array.isArray(body.messages as unknown[]);
    if (looksResponses || !looksChat) {
      return;
    }

    const conversion = await buildResponsesRequestFromChat(body);
    const requestObject = this.extractConvertedRequest(conversion);
    if (!requestObject) {
      throw new Error('buildResponsesRequestFromChat did not return a valid request object');
    }
    const currentModel = typeof body.model === 'string' ? body.model : undefined;
    for (const key of Object.keys(body)) {
      delete body[key];
    }
    Object.assign(body, requestObject);
    if (currentModel) {
      body.model = currentModel;
    }
  }

  private extractConvertedRequest(conversion: unknown): Record<string, unknown> | null {
    if (isRecord(conversion) && 'request' in conversion && isRecord((conversion as Record<string, unknown>).request)) {
      return { ...(conversion as Record<string, unknown>).request as Record<string, unknown> };
    }
    if (isRecord(conversion)) {
      return { ...conversion };
    }
    return null;
  }

  private async snapshotPhase(
    phase: 'provider-request' | 'provider-response' | 'provider-error',
    context: ProviderContext,
    data: unknown,
    headers: Record<string, string>,
    url: string,
    entryEndpoint?: string
  ): Promise<void> {
    try {
      const clientRequestId = this.extractClientRequestId(context);
      await writeProviderSnapshot({
        phase,
        requestId: context.requestId,
        data,
        headers,
        url,
        entryEndpoint,
        clientRequestId
      });
    } catch {
      // non-blocking
    }
  }

  private extractClientRequestId(context: ProviderContext): string | undefined {
    const metaValue = context.metadata && typeof context.metadata === 'object'
      ? (context.metadata as Record<string, unknown>).clientRequestId
      : undefined;
    if (typeof metaValue === 'string' && metaValue.trim().length) {
      return metaValue.trim();
    }
    const runtimeMeta = context.runtimeMetadata?.metadata;
    if (runtimeMeta && typeof runtimeMeta === 'object') {
      const candidate = (runtimeMeta as Record<string, unknown>).clientRequestId;
      if (typeof candidate === 'string' && candidate.trim().length) {
        return candidate.trim();
      }
    }
    return undefined;
  }

  private async sendSseRequest(options: {
    endpoint: string;
    body: Record<string, unknown>;
    headers: Record<string, string>;
    context: ProviderContext;
    targetUrl: string;
    entryEndpoint?: string;
    clientRequestedStream: boolean;
    httpClient: ResponsesHttpClient;
  }): Promise<unknown> {
    const { endpoint, body, headers, context, targetUrl, entryEndpoint, clientRequestedStream, httpClient } = options;
    const stream = await httpClient.postStream(endpoint, body, {
      ...headers,
      Accept: 'text/event-stream'
    });

    const captureSse = clientRequestedStream && shouldCaptureProviderStreamSnapshots();
    const streamForHost = captureSse
      ? attachProviderSseSnapshotStream(stream, {
        requestId: context.requestId,
        headers,
        url: targetUrl,
        entryEndpoint,
        clientRequestId: this.extractClientRequestId(context)
      })
      : stream;

    const converter = await this.loadResponsesSseConverter();
    const json = await converter.convertSseToJson(streamForHost, {
      requestId: context.requestId,
      model: typeof body.model === 'string' ? body.model : 'unknown'
    });
    await this.snapshotPhase(
      'provider-response',
      context,
      {
        mode: 'sse',
        clientStream: clientRequestedStream,
        payload: json ?? null
      },
      headers,
      targetUrl,
      entryEndpoint
    );
    return {
      data: json,
      status: 200,
      statusText: 'OK',
      headers: {
        'x-upstream-mode': 'sse',
        'x-provider-stream-requested': clientRequestedStream ? '1' : '0'
      },
      url: targetUrl
    };
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
    const response = await httpClient.post(endpoint, body, {
      ...headers,
      Accept: 'application/json'
    });
    await this.snapshotPhase('provider-response', context, response, headers, targetUrl, entryEndpoint);
    return response;
  }

  private normalizeUpstreamError(error: unknown): Error & {
    status?: number;
    statusCode?: number;
    code?: string;
    response?: {
      data?: {
        error?: Record<string, unknown>;
      };
    };
  } {
    const normalized = error instanceof Error ? error : new Error(String(error ?? 'Unknown error'));
    const err = normalized as Error & {
      status?: number;
      statusCode?: number;
      code?: string;
      response?: {
        data?: {
          error?: Record<string, unknown>;
        };
      };
    };
    const message = typeof err.message === 'string' ? err.message : String(err || '');
    const match = message.match(/HTTP\s+(\d{3})/i);
    const existing = typeof err.statusCode === 'number' ? err.statusCode : typeof err.status === 'number' ? err.status : undefined;
    const statusCode = existing ?? (match ? Number(match[1]) : undefined);
    if (typeof statusCode === 'number' && !Number.isNaN(statusCode)) {
      err.statusCode = statusCode;
      err.status = statusCode;
      if (!err.code) {
        err.code = `HTTP_${statusCode}`;
      }
    }
    if (!err.response) {
      err.response = {};
    }
    if (!err.response.data) {
      err.response.data = {};
    }
    if (!err.response.data.error) {
      err.response.data.error = {};
    }
    if (err.code && !err.response.data.error.code) {
      err.response.data.error.code = err.code;
    }
    return err;
  }

  private async loadResponsesSseConverter(): Promise<ResponsesSseConverter> {
    const modPath = path.join(
      PACKAGE_ROOT,
      'sharedmodule',
      'llmswitch-core',
      'dist',
      'sse',
      'sse-to-json',
      'index.js'
    );
    const moduleUrl = pathToFileURL(modPath).href;
    const { ResponsesSseToJsonConverter } = await import(moduleUrl);
    return new ResponsesSseToJsonConverter();
  }
}

export default ResponsesProvider;

type StreamPref = 'auto' | 'always' | 'never';
type InstructionsMode = 'default' | 'inline';

interface ResponsesSettings {
  streaming: StreamPref;
  instructionsMode: InstructionsMode;
}

function parseStreamPref(value: unknown): StreamPref {
  if (value === true) {
    return 'always';
  }
  if (value === false) {
    return 'never';
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'always') {
      return 'always';
    }
    if (normalized === 'never') {
      return 'never';
    }
    if (['true', '1', 'yes'].includes(normalized)) {
      return 'always';
    }
    if (['false', '0', 'no'].includes(normalized)) {
      return 'never';
    }
  }
  if (value === 'always' || value === 'never') {
    return value;
  }
  return 'auto';
}

function parseInstructionsMode(value: unknown): InstructionsMode {
  if (value === 'inline') {
    return 'inline';
  }
  return 'default';
}

function extractResponsesConfig(config: UnknownObject): Partial<ResponsesSettings> {
  const providerConfig = isRecord((config as Record<string, unknown>).config)
    ? ((config as Record<string, unknown>).config as Record<string, unknown>)
    : undefined;
  const responsesCfg = providerConfig && isRecord(providerConfig.responses)
    ? (providerConfig.responses as Record<string, unknown>)
    : undefined;
  if (!responsesCfg) {
    return {};
  }
  return {
    streaming: parseStreamPref(responsesCfg.streaming),
    instructionsMode: parseInstructionsMode(responsesCfg.instructionsMode)
  };
}
function hasSharedmodule(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, 'sharedmodule', 'llmswitch-core'));
  } catch {
    return false;
  }
}

function findPackageRoot(startDir: string): string {
  let dir = startDir;
  const root = path.parse(dir).root;
  while (true) {
    const hasPackageJson = fs.existsSync(path.join(dir, 'package.json'));
    if (hasPackageJson || hasSharedmodule(dir)) {
      return dir;
    }
    if (dir === root) {
      break;
    }
    dir = path.resolve(dir, '..');
  }
  return startDir;
}

function resolveModuleRoot(currentModuleUrl: string): string {
  const current = fileURLToPath(currentModuleUrl || import.meta.url);
  const dirname = path.dirname(current);
  return findPackageRoot(dirname);
}

const PACKAGE_ROOT = resolveModuleRoot(import.meta.url);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
