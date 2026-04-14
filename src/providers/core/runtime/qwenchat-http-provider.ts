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
  collectQwenSseAsOpenAiResult,
  createOpenAiMappedSseStream,
  DEFAULT_QWENCHAT_BASE_URL,
  DEFAULT_QWENCHAT_COMPLETION_ENDPOINT,
  extractForwardAuthHeaders,
  extractQwenChatPayload,
  getQwenBaxiaTokens,
  inspectQwenUpstreamStreamPrelude,
  parseIncomingMessages
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

export class QwenChatHttpProvider extends HttpTransportProvider {
  constructor(config: OpenAIStandardConfig, dependencies: ModuleDependencies) {
    const cfg: OpenAIStandardConfig = {
      ...config,
      config: {
        ...config.config,
        providerType: 'openai',
        providerId: config.config.providerId || 'qwenchat',
        baseUrl: String(config.config.baseUrl || DEFAULT_QWENCHAT_BASE_URL).trim() || DEFAULT_QWENCHAT_BASE_URL,
        overrides: {
          ...(config.config.overrides || {}),
          endpoint: String(config.config.overrides?.endpoint || DEFAULT_QWENCHAT_COMPLETION_ENDPOINT).trim() || DEFAULT_QWENCHAT_COMPLETION_ENDPOINT
        }
      }
    };
    super(cfg, dependencies, 'qwenchat-http-provider');
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

    const sendPlan = await buildQwenChatSendPlan({
      baseUrl,
      payload,
      baxiaTokens,
      authHeaders
    });
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

    if (payload.stream) {
      const inspectedPrelude = await inspectQwenUpstreamStreamPrelude({
        upstreamStream: streamForProcessing
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
      const mappedStream = createOpenAiMappedSseStream({
        upstreamStream: inspectedPrelude.replayStream || streamForProcessing,
        model: payload.model,
        declaredToolNames: Array.isArray(payload.tools)
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
          : []
      });
      return {
        __sse_responses: mappedStream,
        status: 200
      };
    }

    const rawCaptureRef: { raw?: string } = {};
    let completion: Record<string, unknown>;
    try {
      completion = await collectQwenSseAsOpenAiResult({
        upstreamStream: streamForProcessing,
        model: payload.model,
        rawCaptureRef,
        declaredToolNames: Array.isArray(payload.tools)
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
          : []
      });
    } catch (error) {
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
    if (err?.code !== 'QWENCHAT_HIDDEN_NATIVE_TOOL') {
      return;
    }
    await writeErrorsampleJson({
      group: 'provider-error',
      kind: 'qwenchat-hidden-native-tool',
      payload: {
        kind: 'qwenchat_hidden_native_tool',
        timestamp: new Date().toISOString(),
        requestId: args.context.requestId,
        clientRequestId: extractClientRequestId(args.context),
        providerKey: args.context.providerKey,
        providerId: args.context.providerId,
        entryEndpoint: args.entryEndpoint,
        url: args.url,
        hiddenToolName: err.toolName || '',
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
