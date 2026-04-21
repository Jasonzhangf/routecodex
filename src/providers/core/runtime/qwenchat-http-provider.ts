import { HttpTransportProvider } from './http-transport-provider.js';
import { writeErrorsampleJson } from '../../../utils/errorsamples.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { UnknownObject } from '../../../types/common-types.js';
import type { ProviderContext } from '../api/provider-types.js';
import {
  attachProviderSseSnapshotStream,
  shouldCaptureProviderStreamSnapshots,
  writeProviderSnapshot
} from '../utils/snapshot-writer.js';
import {
  buildQwenChatSendPlan,
  collectQwenJsonAsOpenAiResult,
  collectQwenSseAsOpenAiResult,
  createOpenAiMappedSseStream,
  DEFAULT_QWENCHAT_BASE_URL,
  DEFAULT_QWENCHAT_COMPLETION_ENDPOINT,
  extractForwardAuthHeaders,
  extractQwenChatPayload,
  getQwenBaxiaTokens,
  inspectQwenUpstreamStreamPrelude,
  parseIncomingMessages,
  QWENCHAT_NONSTREAM_DELIVERY_KEY,
  QWENCHAT_SSE_PROBE_WRAPPER_KEY,
  shouldFallbackToQwenSseForJsonModeError
} from './qwenchat-http-provider-helpers.js';
import { extractClientRequestId, extractEntryEndpoint } from './responses-provider-helpers.js';

type BxCacheState = {
  tokenCache: {
    bxUa: string;
    bxUmidToken: string;
    bxV: string;
  } | null;
  tokenCacheTime: number;
};

const bxCacheState: BxCacheState = {
  tokenCache: null,
  tokenCacheTime: 0
};

const VIDEO_REQUEST_TIMEOUT_MS = 60 * 60 * 1000;
const QWENCHAT_TOOL_STOP_ERRORSAMPLE_MAX_RAW_CHARS = 24_000;
const QWENCHAT_TOOL_SEARCH_SUPPRESSION_ATTEMPTS = ['off', 'disable'] as const;

function collectDeclaredToolNames(payload: Record<string, unknown>): string[] {
  return Array.isArray(payload.tools)
    ? payload.tools
        .map((item) => {
          if (!item || typeof item !== 'object') return '';
          const row = item as Record<string, unknown>;
          const fn = row.function && typeof row.function === 'object'
            ? (row.function as Record<string, unknown>)
            : row;
          return typeof fn.name === 'string' ? fn.name : '';
        })
        .filter(Boolean)
    : [];
}

function isQwenHiddenNativeToolError(error: unknown): boolean {
  const code = String((error as { code?: string } | undefined)?.code || '').trim().toUpperCase();
  return code === 'QWENCHAT_HIDDEN_NATIVE_TOOL' || code === 'QWENCHAT_NATIVE_TOOL_CALL';
}

function hasExplicitRccToolCallsCarrier(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }
  const markerMatch = value.match(/<<RCC_TOOL_CALLS(?:_JSON)?/i);
  if (!markerMatch) {
    return false;
  }
  const tail = value.slice(markerMatch.index ?? 0);
  return /"tool_calls"\s*:/i.test(tail);
}

export class QwenChatHttpProvider extends HttpTransportProvider {
  constructor(config: OpenAIStandardConfig, dependencies: ModuleDependencies) {
    const rawConfig = config.config as Record<string, unknown>;
    const compatibilityProfile =
      typeof rawConfig.compatibilityProfile === 'string'
        ? rawConfig.compatibilityProfile.trim().toLowerCase()
        : '';
    const forceChatQwenBaseUrl = compatibilityProfile === 'chat:qwen';
    const configuredBaseUrl = String(config.config.baseUrl || '').trim();
    const cfg: OpenAIStandardConfig = {
      ...config,
      config: {
        ...config.config,
        providerType: 'openai',
        providerId: config.config.providerId || 'qwenchat',
        baseUrl:
          (forceChatQwenBaseUrl ? DEFAULT_QWENCHAT_BASE_URL : configuredBaseUrl)
          || DEFAULT_QWENCHAT_BASE_URL,
        overrides: {
          ...(config.config.overrides || {}),
          endpoint: String(config.config.overrides?.endpoint || DEFAULT_QWENCHAT_COMPLETION_ENDPOINT).trim() || DEFAULT_QWENCHAT_COMPLETION_ENDPOINT
        }
      }
    };
    super(cfg, dependencies, 'qwenchat-http-provider');
  }

  protected override getEffectiveBaseUrl(): string {
    const runtimeProfile = this.getRuntimeProfile();
    const runtimeCompatibilityProfile =
      typeof runtimeProfile?.compatibilityProfile === 'string'
        ? runtimeProfile.compatibilityProfile.trim().toLowerCase()
        : '';
    if (runtimeCompatibilityProfile === 'chat:qwen') {
      return DEFAULT_QWENCHAT_BASE_URL;
    }
    return super.getEffectiveBaseUrl();
  }

  protected override async sendRequestInternal(request: UnknownObject): Promise<unknown> {
    const context = this.createProviderContext();
    const entryEndpoint = extractEntryEndpoint(request) ?? extractEntryEndpoint(context);
    const payload = extractQwenChatPayload(request);
    const parsedMessages = parseIncomingMessages(payload.messages);
    const isVideoRequest = parsedMessages.attachments.some((item) => item.explicitType === 'video');
    const baseUrl = this.getEffectiveBaseUrl().replace(/\/$/, '');
    const baxiaTokens = await getQwenBaxiaTokens(bxCacheState);
    const authHeaders = this.resolveForwardAuthHeaders();
    const declaredToolNames = collectDeclaredToolNames(payload);
    const suppressionAttempts =
      declaredToolNames.length > 0
        ? [...QWENCHAT_TOOL_SEARCH_SUPPRESSION_ATTEMPTS]
        : [undefined];

    if (payload.stream) {
      let lastStreamError: unknown;
      let lastRawCapture = '';
      let lastSendPlan:
        | {
            completionUrl: string;
            completionHeaders: Record<string, string>;
            completionBody: Record<string, unknown>;
          }
        | undefined;

      for (let attemptIndex = 0; attemptIndex < suppressionAttempts.length; attemptIndex += 1) {
        const sendPlan = await buildQwenChatSendPlan({
          baseUrl,
          payload,
          baxiaTokens,
          authHeaders,
          backoffKey: context.providerKey || context.providerId,
          toolSearchSuppressionMode: suppressionAttempts[attemptIndex]
        });
        lastSendPlan = sendPlan;
        await this.snapshotPhase(
          'provider-request',
          context,
          sendPlan.completionBody,
          sendPlan.completionHeaders,
          sendPlan.completionUrl,
          entryEndpoint
        );
        const upstreamStream = await this.httpClient.postStream(
          sendPlan.completionUrl,
          sendPlan.completionBody,
          sendPlan.completionHeaders,
          isVideoRequest
            ? {
                timeoutMs: VIDEO_REQUEST_TIMEOUT_MS,
                idleTimeoutMs: VIDEO_REQUEST_TIMEOUT_MS,
                headersTimeoutMs: VIDEO_REQUEST_TIMEOUT_MS
              }
            : undefined
        );
        const streamForProcessing =
          shouldCaptureProviderStreamSnapshots()
            ? attachProviderSseSnapshotStream(upstreamStream, {
                requestId: context.requestId,
                headers: sendPlan.completionHeaders,
                url: sendPlan.completionUrl,
                entryEndpoint,
                clientRequestId: extractClientRequestId(context),
                providerKey: context.providerKey,
                providerId: context.providerId
              })
            : upstreamStream;
        const inspectedPrelude = await inspectQwenUpstreamStreamPrelude({
          upstreamStream: streamForProcessing,
          declaredToolNames
        });
        if (inspectedPrelude.businessError) {
          await this.snapshotPhase(
            'provider-response',
            context,
            {
              mode: 'sse',
              raw: inspectedPrelude.rawCapture,
              error: {
                message: inspectedPrelude.businessError.message,
                code: inspectedPrelude.businessError.code,
                status: inspectedPrelude.businessError.statusCode
              }
            },
            sendPlan.completionHeaders,
            sendPlan.completionUrl,
            entryEndpoint
          );
          const err = new Error(inspectedPrelude.businessError.message) as Error & {
            code?: string;
            statusCode?: number;
            status?: number;
            retryable?: boolean;
          };
          err.code = inspectedPrelude.businessError.code;
          err.statusCode = inspectedPrelude.businessError.statusCode;
          err.status = inspectedPrelude.businessError.statusCode;
          err.retryable = inspectedPrelude.businessError.statusCode === 429;
          throw err;
        }
        if (inspectedPrelude.toolContractError) {
          lastStreamError = inspectedPrelude.toolContractError;
          lastRawCapture = inspectedPrelude.rawCapture;
          const hasRecoveryAttempt = attemptIndex + 1 < suppressionAttempts.length;
          if (isQwenHiddenNativeToolError(inspectedPrelude.toolContractError) && hasRecoveryAttempt) {
            continue;
          }
          throw inspectedPrelude.toolContractError;
        }
        const mappedStream = createOpenAiMappedSseStream({
          upstreamStream: inspectedPrelude.replayStream || streamForProcessing,
          model: payload.model,
          declaredToolNames
        });
        const qwenSseProbe =
          (mappedStream as NodeJS.ReadableStream & { [QWENCHAT_SSE_PROBE_WRAPPER_KEY]?: Record<string, unknown> })[
            QWENCHAT_SSE_PROBE_WRAPPER_KEY
          ];
        return {
          __sse_responses: mappedStream,
          ...(qwenSseProbe ? { [QWENCHAT_SSE_PROBE_WRAPPER_KEY]: qwenSseProbe } : {}),
          status: 200
        };
      }

      await this.maybeWriteHiddenNativeToolErrorsample({
        error: lastStreamError,
        payload,
        rawSse: lastRawCapture,
        context,
        entryEndpoint,
        url: lastSendPlan?.completionUrl || ''
      });
      throw lastStreamError instanceof Error ? lastStreamError : new Error('QwenChat streaming request failed');
    }

    let lastError: unknown;
    let lastRawCapture = '';
    let lastSendPlan:
      | {
          completionUrl: string;
          completionHeaders: Record<string, string>;
          completionBody: Record<string, unknown>;
        }
      | undefined;

    for (let attemptIndex = 0; attemptIndex < suppressionAttempts.length; attemptIndex += 1) {
      const sendPlan = await buildQwenChatSendPlan({
        baseUrl,
        payload,
        baxiaTokens,
        authHeaders,
        backoffKey: context.providerKey || context.providerId,
        toolSearchSuppressionMode: suppressionAttempts[attemptIndex]
      });
      lastSendPlan = sendPlan;
      await this.snapshotPhase(
        'provider-request',
        context,
        sendPlan.completionBody,
        sendPlan.completionHeaders,
        sendPlan.completionUrl,
        entryEndpoint
      );

      const rawCaptureRef: { raw?: string } = {};
      try {
        let completion: Record<string, unknown>;
        try {
          const jsonResponse = await this.httpClient.post(
            sendPlan.completionUrl,
            sendPlan.completionBody,
            sendPlan.completionHeaders
          );
          rawCaptureRef.raw =
            typeof jsonResponse.data === 'string'
              ? jsonResponse.data
              : JSON.stringify(jsonResponse.data);
          completion = collectQwenJsonAsOpenAiResult({
            payload: jsonResponse.data,
            model: payload.model,
            declaredToolNames
          });
          completion[QWENCHAT_NONSTREAM_DELIVERY_KEY] = 'json';
        } catch (error) {
          const errorCode = String((error as { code?: string } | undefined)?.code || '').trim().toUpperCase();
          const allowSseFallback =
            errorCode === 'UPSTREAM_SSE_NOT_ALLOWED'
            || shouldFallbackToQwenSseForJsonModeError(rawCaptureRef.raw || '', error);
          if (!allowSseFallback) {
            throw error;
          }
          const sseFallbackBody = {
            ...sendPlan.completionBody,
            stream: true,
            incremental_output: true
          };
          const upstreamStream = await this.httpClient.postStream(
            sendPlan.completionUrl,
            sseFallbackBody,
            sendPlan.completionHeaders,
            isVideoRequest
              ? {
                  timeoutMs: VIDEO_REQUEST_TIMEOUT_MS,
                  idleTimeoutMs: VIDEO_REQUEST_TIMEOUT_MS,
                  headersTimeoutMs: VIDEO_REQUEST_TIMEOUT_MS
                }
              : undefined
          );
          const streamForProcessing =
            shouldCaptureProviderStreamSnapshots()
              ? attachProviderSseSnapshotStream(upstreamStream, {
                  requestId: context.requestId,
                  headers: sendPlan.completionHeaders,
                  url: sendPlan.completionUrl,
                  entryEndpoint,
                  clientRequestId: extractClientRequestId(context),
                  providerKey: context.providerKey,
                  providerId: context.providerId
                })
              : upstreamStream;
          completion = await collectQwenSseAsOpenAiResult({
            upstreamStream: streamForProcessing,
            model: payload.model,
            rawCaptureRef,
            declaredToolNames
          });
          completion[QWENCHAT_NONSTREAM_DELIVERY_KEY] = 'sse_fallback';
        }
        await this.snapshotPhase(
          'provider-response',
          context,
          completion,
          sendPlan.completionHeaders,
          sendPlan.completionUrl,
          entryEndpoint
        );
        await this.maybeWriteSuspiciousToolStopErrorsample({
          payload,
          completion,
          rawSse: rawCaptureRef.raw,
          context,
          entryEndpoint,
          url: sendPlan.completionUrl
        });
        return {
          status: 200,
          data: completion
        };
      } catch (error) {
        lastError = error;
        lastRawCapture = rawCaptureRef.raw || '';
        const hasRecoveryAttempt = attemptIndex + 1 < suppressionAttempts.length;
        if (isQwenHiddenNativeToolError(error) && hasRecoveryAttempt) {
          continue;
        }
        await this.maybeWriteHiddenNativeToolErrorsample({
          error,
          payload,
          rawSse: rawCaptureRef.raw,
          context,
          entryEndpoint,
          url: sendPlan.completionUrl
        });
        throw error;
      }
    }

    await this.maybeWriteHiddenNativeToolErrorsample({
      error: lastError,
      payload,
      rawSse: lastRawCapture,
      context,
      entryEndpoint,
      url: lastSendPlan?.completionUrl || ''
    });
    throw lastError instanceof Error ? lastError : new Error('QwenChat request failed');
  }

  protected override async performHealthCheck(_url: string): Promise<boolean> {
    const base = this.getEffectiveBaseUrl().replace(/\/$/, '');
    try {
      const response = await fetch(`${base}/api/models`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        }
      });
      return response.ok || response.status === 401 || response.status === 403;
    } catch {
      return false;
    }
  }

  private resolveForwardAuthHeaders(): Record<string, string> | undefined {
    const buildHeaders = this.authProvider?.buildHeaders;
    if (typeof buildHeaders !== 'function') {
      return undefined;
    }
    const rawHeaders = buildHeaders.call(this.authProvider);
    if (!rawHeaders || typeof rawHeaders !== 'object') {
      return undefined;
    }
    const filtered = extractForwardAuthHeaders(rawHeaders as Record<string, string>);
    return Object.keys(filtered).length > 0 ? filtered : undefined;
  }

  private async snapshotPhase(
    phase: 'provider-request' | 'provider-response',
    context: ProviderContext,
    data: unknown,
    headers: Record<string, string>,
    url: string,
    entryEndpoint?: string
  ): Promise<void> {
    try {
      await writeProviderSnapshot({
        phase,
        requestId: context.requestId,
        data,
        headers,
        url,
        entryEndpoint,
        clientRequestId: extractClientRequestId(context),
        providerKey: context.providerKey,
        providerId: context.providerId
      });
    } catch {
      // non-blocking
    }
  }

  private async maybeWriteSuspiciousToolStopErrorsample(args: {
    payload: ReturnType<typeof extractQwenChatPayload>;
    completion: Record<string, unknown>;
    rawSse?: string;
    context: ProviderContext;
    entryEndpoint?: string;
    url: string;
  }): Promise<void> {
    if (!Array.isArray(args.payload.tools) || args.payload.tools.length === 0) {
      return;
    }
    const choices = Array.isArray(args.completion.choices) ? args.completion.choices : [];
    const firstChoice =
      choices.length > 0 && choices[0] && typeof choices[0] === 'object'
        ? (choices[0] as Record<string, unknown>)
        : undefined;
    const finishReason =
      typeof firstChoice?.finish_reason === 'string'
        ? firstChoice.finish_reason.trim().toLowerCase()
        : '';
    if (finishReason && finishReason !== 'stop') {
      return;
    }
    const message =
      firstChoice?.message && typeof firstChoice.message === 'object'
        ? (firstChoice.message as Record<string, unknown>)
        : undefined;
    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    const functionCall =
      message?.function_call && typeof message.function_call === 'object'
        ? message.function_call
        : undefined;
    if (toolCalls.length > 0 || functionCall) {
      return;
    }
    const content = typeof message?.content === 'string' ? message.content : '';
    const reasoning = typeof message?.reasoning_content === 'string' ? message.reasoning_content : '';
    if (
      hasExplicitRccToolCallsCarrier(content)
      || hasExplicitRccToolCallsCarrier(reasoning)
      || hasExplicitRccToolCallsCarrier(args.rawSse)
    ) {
      return;
    }
    const rawPreview = typeof args.rawSse === 'string'
      ? args.rawSse.slice(0, QWENCHAT_TOOL_STOP_ERRORSAMPLE_MAX_RAW_CHARS)
      : '';
    await writeErrorsampleJson({
      group: 'provider-error',
      kind: 'qwenchat-tool-stop-no-call',
      payload: {
        kind: 'qwenchat_tool_stop_no_call',
        timestamp: new Date().toISOString(),
        requestId: args.context.requestId,
        clientRequestId: extractClientRequestId(args.context),
        providerKey: args.context.providerKey,
        providerId: args.context.providerId,
        entryEndpoint: args.entryEndpoint,
        url: args.url,
        finishReason: finishReason || 'stop',
        message: {
          content,
          reasoning_content: reasoning
        },
        toolNames: (args.payload.tools as Array<Record<string, unknown>>)
          .map((item) => {
            const fn = item && typeof item === 'object' && item.function && typeof item.function === 'object'
              ? (item.function as Record<string, unknown>)
              : item;
            return typeof fn?.name === 'string' ? fn.name : '';
          })
          .filter(Boolean),
        rawSsePreview: rawPreview,
        rawSseTruncated:
          typeof args.rawSse === 'string' && args.rawSse.length > QWENCHAT_TOOL_STOP_ERRORSAMPLE_MAX_RAW_CHARS,
        completion: args.completion
      }
    });
  }

  private async maybeWriteHiddenNativeToolErrorsample(args: {
    error: unknown;
    payload: ReturnType<typeof extractQwenChatPayload>;
    rawSse?: string;
    context: ProviderContext;
    entryEndpoint?: string;
    url: string;
  }): Promise<void> {
    const err = args.error as { code?: string; toolName?: string; phase?: string; message?: string } | undefined;
    const isToolContractError =
      err?.code === 'QWENCHAT_HIDDEN_NATIVE_TOOL' || err?.code === 'QWENCHAT_NATIVE_TOOL_CALL';
    if (!isToolContractError) {
      return;
    }
    const isHiddenNativeTool = err?.code === 'QWENCHAT_HIDDEN_NATIVE_TOOL';
    await writeErrorsampleJson({
      group: 'provider-error',
      kind: isHiddenNativeTool ? 'qwenchat-hidden-native-tool' : 'qwenchat-native-tool-call',
      payload: {
        kind: isHiddenNativeTool ? 'qwenchat_hidden_native_tool' : 'qwenchat_native_tool_call',
        timestamp: new Date().toISOString(),
        requestId: args.context.requestId,
        clientRequestId: extractClientRequestId(args.context),
        providerKey: args.context.providerKey,
        providerId: args.context.providerId,
        entryEndpoint: args.entryEndpoint,
        url: args.url,
        toolName: err.toolName || '',
        phase: err.phase || '',
        message: err.message || '',
        toolNames: (args.payload.tools as Array<Record<string, unknown>> | undefined || [])
          .map((item) => {
            const fn = item && typeof item === 'object' && item.function && typeof item.function === 'object'
              ? (item.function as Record<string, unknown>)
              : item;
            return typeof fn?.name === 'string' ? fn.name : '';
          })
          .filter(Boolean),
        rawSsePreview: typeof args.rawSse === 'string'
          ? args.rawSse.slice(0, QWENCHAT_TOOL_STOP_ERRORSAMPLE_MAX_RAW_CHARS)
          : '',
        rawSseTruncated:
          typeof args.rawSse === 'string' && args.rawSse.length > QWENCHAT_TOOL_STOP_ERRORSAMPLE_MAX_RAW_CHARS
      }
    });
  }
}
