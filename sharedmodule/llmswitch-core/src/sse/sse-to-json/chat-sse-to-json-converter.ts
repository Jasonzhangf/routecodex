/**
 * Chat SSE → JSON转换器
 * 将SSE事件流聚合为ChatCompletion响应
 */

import { DEFAULT_CHAT_CONVERSION_CONFIG, CHAT_CONVERSION_ERROR_CODES } from '../types/index.js';
import type {
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatSseEvent,
  ChatSseEventType,
  SseToChatJsonContext,
  SseToChatJsonOptions,
  ChatEventStats,
  ChatChoiceBuilder,
  ChatToolCallChunk,
  ChatMessage,
  ChatToolCall,
  ChatUsage
} from '../types/index.js';
import {
  TimeUtils,
  ErrorUtils
} from '../shared/utils.js';
import { normalizeMessageReasoningTools } from '../../conversion/shared/reasoning-tool-normalizer.js';
import { normalizeChatMessageContent } from '../../conversion/shared/chat-output-normalizer.js';
import { dispatchReasoning } from '../shared/reasoning-dispatcher.js';

type DeepSeekWebErrorInfo = {
  message: string;
  code: string;
  finishReason: string;
  raw: Record<string, unknown>;
};

type DeepSeekPatchAppendTarget = 'content' | 'reasoning';

const hasExplicitToolWrapperProgress = (text: string): boolean => {
  if (!text) {
    return false;
  }
  return (
    /<tool_call\b/i.test(text)
    || /<function_calls?\b/i.test(text)
    || /<<\s*RCC_TOOL_CALLS(?:_JSON)?/i.test(text)
    || /<use_mcp_tool\b/i.test(text)
  );
};

const DEFAULT_FIRST_FRAME_TIMEOUT_MS = 15_000;
const DEFAULT_NO_CONTENT_TIMEOUT_MS = 120_000;
const DEFAULT_PRE_ANCHOR_IDLE_TIMEOUT_MS = 45_000;
const DEFAULT_CONTENT_IDLE_TIMEOUT_MS = 300_000;

type DeepSeekWebPayloadAnalysis = {
  path: string;
  op: string;
  value: unknown;
  isStandardChunk: boolean;
  looksLikePatch: boolean;
  errorInfo: DeepSeekWebErrorInfo | null;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readTrimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function includesContextLengthHint(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes('context_length_exceeded')
    || normalized.includes('input_exceeds_limit')
    || normalized.includes('context too long')
    || normalized.includes('context window')
    || normalized.includes('内容超长')
    || normalized.includes('请删减后再试')
    || normalized.includes('达到对话长度上限')
    || normalized.includes('请开启新对话')
  );
}

function normalizeDeepSeekWebFinishReason(input: {
  code?: string;
  message?: string;
  finishReason?: string;
  status?: string;
}): string {
  const finishReason = readTrimmed(input.finishReason);
  const code = readTrimmed(input.code);
  const message = readTrimmed(input.message);
  const status = readTrimmed(input.status);
  if (
    includesContextLengthHint(finishReason)
    || includesContextLengthHint(code)
    || includesContextLengthHint(message)
    || status.toLowerCase().includes('context')
  ) {
    return 'context_length_exceeded';
  }
  if (
    code.toLowerCase().includes('rate_limit')
    || finishReason.toLowerCase().includes('rate_limit')
    || message.toLowerCase().includes('rate limit')
  ) {
    return 'rate_limit_exceeded';
  }
  return finishReason || code || status || 'SSE_ERROR';
}

function extractDeepSeekWebErrorInfo(payload: unknown): DeepSeekWebErrorInfo | null {
  const row = asRecord(payload);
  if (!row) {
    return null;
  }

  const path = readTrimmed(row.p);
  const op = readTrimmed(row.o).toUpperCase();
  const type = readTrimmed(row.type).toLowerCase();

  if (type !== 'error' && path !== 'response/error' && op !== 'ERROR') {
    if (path === 'response/status' && typeof row.v === 'string') {
      const sv = (row.v as string).trim().toUpperCase();
      if (!sv || sv === 'FINISHED') {
        return null;
      }
    } else {
      return null;
    }
  }

  const directError = asRecord(row.error);
  const valueNode = asRecord(row.v);
  const value = row.v;
  const responseNode = asRecord(valueNode?.response) || asRecord(row.response);
  const responseError = asRecord(responseNode?.error);
  const responseStatus = readTrimmed(responseNode?.status);
  const valueRecord = asRecord(value);

  const topLevelMessage =
    readTrimmed(row.message)
    || readTrimmed(row.error)
    || readTrimmed(row.content)
    || readTrimmed(row.msg);
  const topLevelCode =
    readTrimmed(row.code)
    || readTrimmed(row.finish_reason);

  const nestedMessage =
    readTrimmed(directError?.message)
    || readTrimmed(responseError?.message)
    || readTrimmed(responseNode?.message)
    || readTrimmed(valueRecord?.message)
    || readTrimmed(valueRecord?.error)
    || readTrimmed(valueRecord?.msg);
  const nestedCode =
    readTrimmed(directError?.code)
    || readTrimmed(responseError?.code)
    || readTrimmed(responseNode?.code)
    || readTrimmed(valueRecord?.code)
    || readTrimmed(valueRecord?.finish_reason);

  const rawStatus =
    responseStatus
    || readTrimmed(row.status)
    || (path === 'response/status' ? readTrimmed(value) : '');
  const rawMessage = topLevelMessage || nestedMessage;
  const rawCode = topLevelCode || nestedCode;
  const finishReason = normalizeDeepSeekWebFinishReason({
    code: rawCode,
    message: rawMessage,
    finishReason:
      readTrimmed(row.finish_reason)
      || readTrimmed(responseNode?.finish_reason)
      || readTrimmed(valueRecord?.finish_reason),
    status: rawStatus
  });

  const explicitErrorLike = type === 'error' || path === 'response/error' || op === 'ERROR';
  const failedStatusLike = ['FAILED', 'ERROR', 'REJECTED', 'ABORTED', 'CANCELLED'].includes(rawStatus.toUpperCase());
  const contextLengthLike = includesContextLengthHint(rawMessage) || includesContextLengthHint(rawCode) || finishReason === 'context_length_exceeded';

  if (!explicitErrorLike && !failedStatusLike && !contextLengthLike) {
    return null;
  }

  const message =
    rawMessage
    || (finishReason === 'context_length_exceeded'
      ? '达到对话长度上限，请开启新对话'
      : failedStatusLike
        ? `DeepSeek upstream status=${rawStatus}`
        : 'Unknown SSE error');

  return {
    message,
    code: rawCode || finishReason || 'SSE_ERROR',
    finishReason,
    raw: row
  };
}

function readNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.round(parsed);
    }
  }
  return undefined;
}

function normalizeChatUsage(usage: unknown): ChatUsage | null {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    return null;
  }
  const record = usage as Record<string, unknown>;
  const promptTokens = readNonNegativeInteger(
    record.prompt_tokens ?? record.input_tokens ?? record.promptTokens ?? record.inputTokens
  );
  const completionTokens = readNonNegativeInteger(
    record.completion_tokens ?? record.output_tokens ?? record.completionTokens ?? record.outputTokens
  );
  const totalTokens = readNonNegativeInteger(
    record.total_tokens ??
      record.totalTokens ??
      ((promptTokens ?? 0) + (completionTokens ?? 0) > 0
        ? (promptTokens ?? 0) + (completionTokens ?? 0)
        : undefined)
  );
  if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) {
    return null;
  }
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens
  };
}

function resolveDeepSeekFragmentTarget(fragmentType: unknown): DeepSeekPatchAppendTarget {
  const normalized = readTrimmed(fragmentType).toUpperCase();
  if (normalized === 'THINK' || normalized === 'THINKING' || normalized === 'REASONING') {
    return 'reasoning';
  }
  return 'content';
}

function isDeepSeekFragmentStatusPath(path: string): boolean {
  if (!path.startsWith('response/fragments/') || !path.endsWith('/status')) {
    return false;
  }
  const middle = path.slice('response/fragments/'.length, path.length - '/status'.length).trim();
  if (!middle) {
    return false;
  }
  const normalized = middle.startsWith('-') ? middle.slice(1) : middle;
  return normalized.length > 0 && /^[0-9]+$/.test(normalized);
}

function analyzeDeepSeekWebPayload(
  payload: Record<string, unknown> | undefined,
  hasPatchAppendTarget: boolean
): DeepSeekWebPayloadAnalysis | null {
  if (!payload) {
    return null;
  }

  const path = typeof payload.p === 'string' ? payload.p : '';
  const op = typeof payload.o === 'string' ? payload.o : '';
  const value = payload.v;
  const isStandardChunk = Array.isArray(payload.choices) || payload.object === 'chat.completion.chunk';
  const isBareContinuation = hasPatchAppendTarget && !path && typeof value === 'string';
  const looksLikePatch = !isStandardChunk && (
    path.startsWith('response/')
    || typeof payload.request_message_id === 'number'
    || typeof payload.response_message_id === 'number'
    || typeof payload.updated_at === 'number'
    || (value !== null && typeof value === 'object' && !Array.isArray(value))
    || isBareContinuation
  );

  return {
    path,
    op,
    value,
    isStandardChunk,
    looksLikePatch,
    errorInfo: extractDeepSeekWebErrorInfo(payload)
  };
}

/**
 * Chat SSE到JSON转换器
 */
export class ChatSseToJsonConverter {
  private config = DEFAULT_CHAT_CONVERSION_CONFIG;
  private contexts = new Map<string, SseToChatJsonContext>();

  constructor(config?: Partial<typeof DEFAULT_CHAT_CONVERSION_CONFIG>) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
  }

  /**
   * 将SSE流转换为Chat Completion响应
   */
  async convertSseToJson(
    sseStream: AsyncIterable<ChatSseEvent> | AsyncIterable<string | Buffer>,
    options: SseToChatJsonOptions
  ): Promise<ChatCompletionResponse> {
    const context = this.createContext(options);
    this.contexts.set(options.requestId, context);

    try {
      // 处理SSE流
      for await (const event of this.ensureEventStream(sseStream, context)) {
        await this.processSseEvent(event, context);
      }

      // 验证并返回最终响应
      return this.finalizeResponse(context);

    } catch (error) {
      context.eventStats.errorCount++;
      if (this.isTerminatedError(error)) {
        const salvaged = this.trySalvageResponse(context);
        if (salvaged) {
          context.isCompleted = true;
          context.eventStats.endTime = TimeUtils.now();
          context.eventStats.duration = (context.eventStats.endTime - context.eventStats.startTime) / 1000;
          options.onCompletion?.(salvaged);
          return salvaged;
        }
      }
      options.onError?.(error as Error);
      throw this.wrapSseError(error, 'SSE to JSON conversion failed');
    } finally {
      this.cleanup(options.requestId);
    }
  }

  /**
   * 将SSE流转换为流式响应
   */
  async *aggregateSseStream(
    sseStream: AsyncIterable<ChatSseEvent> | AsyncIterable<string | Buffer>,
    options: SseToChatJsonOptions
  ): AsyncGenerator<ChatCompletionResponse> {
    const context = this.createContext(options);
    this.contexts.set(options.requestId, context);

    try {
      for await (const event of this.ensureEventStream(sseStream, context)) {
        await this.processSseEvent(event, context);

        // 每处理完一个chunk就生成部分响应
        const partialResponse = this.buildPartialResponse(context);
        if (partialResponse) {
          options.onPartialResponse?.(partialResponse);
          yield partialResponse;
        }
      }

      // 返回最终响应
      const finalResponse = this.finalizeResponse(context);
      options.onCompletion?.(finalResponse);
      yield finalResponse;

    } catch (error) {
      context.eventStats.errorCount++;
      if (this.isTerminatedError(error)) {
        const salvaged = this.trySalvageResponse(context);
        if (salvaged) {
          context.isCompleted = true;
          context.eventStats.endTime = TimeUtils.now();
          context.eventStats.duration = (context.eventStats.endTime - context.eventStats.startTime) / 1000;
          options.onCompletion?.(salvaged);
          yield salvaged;
          return;
        }
      }
      options.onError?.(error as Error);
      throw this.wrapSseError(error, 'SSE stream aggregation failed');
    } finally {
      this.cleanup(options.requestId);
    }
  }

  /**
   * 确保输入流转换为 ChatSseEvent 流
   */
  private async *ensureEventStream(
    source: AsyncIterable<ChatSseEvent> | AsyncIterable<string | Buffer>,
    context?: SseToChatJsonContext
  ): AsyncGenerator<ChatSseEvent> {
    let tailBuffer = '';
    const iterator = source[Symbol.asyncIterator]() as AsyncIterator<ChatSseEvent | string | Buffer>;
    while (true) {
      const next = await this.readNextStreamChunk(iterator, context);
      if (next.done) {
        break;
      }
      const chunk = next.value;
      if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) {
        const raw = typeof chunk === 'string' ? chunk : chunk.toString();
        const normalized = raw.replace(/\r\n/g, '\n');
        const combined = tailBuffer + normalized;
        const segments = combined.split('\n\n');
        tailBuffer = segments.pop() ?? '';

        for (const segment of segments) {
          const trimmed = segment.trim();
          if (trimmed) {
            const parsed = this.parseSseChunk(trimmed);
            if (parsed) {
              yield parsed;
            }
          }
        }
      } else if ((chunk as ChatSseEvent)?.event) {
        yield chunk as ChatSseEvent;
      } else {
        throw ErrorUtils.createError(
          'Unsupported SSE chunk format',
          CHAT_CONVERSION_ERROR_CODES.PARSE_ERROR,
          { chunk }
        );
      }
    }

    const trailing = tailBuffer.trim();
    if (trailing) {
      const parsed = this.parseSseChunk(trailing);
      if (parsed) {
        yield parsed;
      }
    }
  }

  private async readNextStreamChunk<T>(
    iterator: AsyncIterator<T>,
    context?: SseToChatJsonContext
  ): Promise<IteratorResult<T>> {
    if (!context) {
      return iterator.next();
    }
    return this.raceWithTimeoutState(iterator.next(), context);
  }

  private resolveTimeoutState(context: SseToChatJsonContext): {
    timeoutMs: number;
    anchorMs: number;
    code: 'UPSTREAM_STREAM_NO_FRAME_TIMEOUT' | 'UPSTREAM_STREAM_PRE_ANCHOR_IDLE_TIMEOUT' | 'UPSTREAM_STREAM_CONTENT_IDLE_TIMEOUT';
  } {
    if (context.eventStats.firstFrameAtMs === undefined) {
      const configured = Number(context.options.firstFrameTimeoutMs);
      return {
        timeoutMs: Number.isFinite(configured) && configured > 0
          ? Math.floor(configured)
          : DEFAULT_FIRST_FRAME_TIMEOUT_MS,
        anchorMs: context.startTime,
        code: 'UPSTREAM_STREAM_NO_FRAME_TIMEOUT'
      };
    }
    if (context.eventStats.firstContentAtMs === undefined) {
      const configured = Number(context.options.preAnchorIdleTimeoutMs ?? context.options.noContentTimeoutMs);
      return {
        timeoutMs: Number.isFinite(configured) && configured > 0
          ? Math.floor(configured)
          : DEFAULT_PRE_ANCHOR_IDLE_TIMEOUT_MS,
        anchorMs: context.eventStats.lastFrameAtMs ?? context.eventStats.firstFrameAtMs ?? context.startTime,
        code: 'UPSTREAM_STREAM_PRE_ANCHOR_IDLE_TIMEOUT'
      };
    }
    const configured = Number(context.options.contentIdleTimeoutMs);
    return {
      timeoutMs: Number.isFinite(configured) && configured > 0
        ? Math.floor(configured)
        : DEFAULT_CONTENT_IDLE_TIMEOUT_MS,
      anchorMs: context.eventStats.lastContentAtMs ?? context.eventStats.firstContentAtMs ?? context.startTime,
      code: 'UPSTREAM_STREAM_CONTENT_IDLE_TIMEOUT'
    };
  }

  private markSemanticContentSeen(context: SseToChatJsonContext): void {
    const now = TimeUtils.now();
    context.eventStats.firstContentAtMs ??= now;
    context.eventStats.lastContentAtMs = now;
  }

  private async raceWithTimeoutState<T>(
    pending: Promise<IteratorResult<T>>,
    context: SseToChatJsonContext
  ): Promise<IteratorResult<T>> {
    let timer: NodeJS.Timeout | null = null;
    const timeoutState = this.resolveTimeoutState(context);
    const remainingTimeoutMs = Math.max(1, timeoutState.anchorMs + Math.max(1, timeoutState.timeoutMs) - TimeUtils.now());
    try {
      return await Promise.race([
        pending,
        new Promise<IteratorResult<T>>((_, reject) => {
          timer = setTimeout(() => {
            reject(this.createSemanticTimeoutError(timeoutState));
          }, remainingTimeoutMs);
          timer.unref?.();
        })
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private createSemanticTimeoutError(timeoutState: {
    timeoutMs: number;
    code: 'UPSTREAM_STREAM_NO_FRAME_TIMEOUT' | 'UPSTREAM_STREAM_PRE_ANCHOR_IDLE_TIMEOUT' | 'UPSTREAM_STREAM_CONTENT_IDLE_TIMEOUT';
  }): Error & {
    code?: string;
    status?: number;
    statusCode?: number;
    retryable?: boolean;
    upstreamCode?: string;
    requestExecutorProviderErrorStage?: string;
  } {
    const { code, timeoutMs } = timeoutState;
    const message =
      code === 'UPSTREAM_STREAM_NO_FRAME_TIMEOUT'
        ? `Upstream stream produced no frame within ${timeoutMs}ms`
        : code === 'UPSTREAM_STREAM_PRE_ANCHOR_IDLE_TIMEOUT'
          ? `Upstream stream produced frames but no semantic progress within ${timeoutMs}ms`
          : `Upstream stream idle after semantic content for ${timeoutMs}ms`;
    const error = new Error(message) as Error & {
      code?: string;
      status?: number;
      statusCode?: number;
      retryable?: boolean;
      upstreamCode?: string;
      requestExecutorProviderErrorStage?: string;
    };
    error.code = code;
    error.status = 504;
    error.statusCode = 504;
    error.retryable = true;
    error.upstreamCode = code;
    error.requestExecutorProviderErrorStage = 'provider.sse_decode';
    return error;
  }

  /**
   * 将SSE文本块解析为Chat事件
   */
  private parseSseChunk(chunk: string): ChatSseEvent | null {
    const lines = chunk.trim().split('\n');
    let rawEventType: string | undefined;
    const dataLines: string[] = [];
    let hasCommentOnlyLines = false;

    for (const line of lines) {
      if (line.startsWith('event:')) {
        rawEventType = line.substring(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.substring(5).trim());
      } else if (line.startsWith(':')) {
        hasCommentOnlyLines = true;
      }
    }
    const dataValue = dataLines.join('\n');
    const parsedData = (() => {
      if (!dataValue) {
        return undefined;
      }
      try {
        const parsed = JSON.parse(dataValue);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // best effort
      }
      return undefined;
    })();
    const deepseekErrorInfo = extractDeepSeekWebErrorInfo(parsedData);

    const normalizeEventType = (
      candidate: string | undefined,
      payload?: Record<string, unknown>,
      payloadErrorInfo?: DeepSeekWebErrorInfo | null
    ): ChatSseEventType | undefined => {
      if (payloadErrorInfo) {
        return 'error';
      }
      if (!candidate) return undefined;
      const v = candidate.trim().toLowerCase();
      if (!v) return undefined;
      // OpenAI Chat Completions SSE does not include `event:` lines; we infer types elsewhere.
      // When upstream does include `event:`, accept common aliases for compatibility.
      if (v === 'chat_chunk') return 'chat_chunk';
      if (v === 'chat.done' || v === 'chat_done') return 'chat.done';
      if (v === 'ping' || v === 'heartbeat') return 'ping';
      if (v === 'error') return 'error';
      // DeepSeek-web style control events (non-content).
      if (v === 'ready' || v === 'update_session' || v === 'title') return 'ping';
      if (v === 'finish' || v === 'close') return 'chat.done';
      if (v === 'toast') {
        const toastType = typeof payload?.type === 'string' ? payload.type.trim().toLowerCase() : '';
        const finishReason = deepseekErrorInfo?.finishReason || (
          typeof payload?.finish_reason === 'string'
            ? payload.finish_reason.trim().toLowerCase()
            : ''
        );
        if (toastType === 'error' || finishReason === 'context_length_exceeded' || finishReason === 'rate_limit_exceeded') {
          return 'error';
        }
        return 'ping';
      }
      // Legacy aliases
      if (v === 'chunk') return 'chat_chunk';
      if (v === 'done') return 'chat.done';
      return undefined;
    };

    let eventType = normalizeEventType(rawEventType, parsedData, deepseekErrorInfo);
    if (!eventType) {
      // OpenAI-compatible streams often omit `event:`; use `[DONE]` sentinel to mark completion.
      if (dataValue) {
        eventType = dataValue === '[DONE]' ? 'chat.done' : 'chat_chunk';
      }
    }

    if (!eventType && !dataValue && hasCommentOnlyLines) {
      return null;
    }

    if (!eventType) {
      throw ErrorUtils.createError(
        'SSE event type is required',
        CHAT_CONVERSION_ERROR_CODES.VALIDATION_ERROR,
        { chunk }
      );
    }

    return {
      event: eventType,
      type: eventType,
      timestamp: TimeUtils.now(),
      data: dataValue,
      protocol: 'chat',
      direction: 'sse_to_json',
      parsedData,
      _errorInfo: deepseekErrorInfo
    } as ChatSseEvent & { _errorInfo?: DeepSeekWebErrorInfo | null };
  }

  /**
   * 创建转换上下文
   */
  private createContext(options: SseToChatJsonOptions): SseToChatJsonContext {
    return {
      requestId: options.requestId,
      model: options.model,
      options: { ...DEFAULT_CHAT_CONVERSION_CONFIG, ...options },
      startTime: TimeUtils.now(),
      currentResponse: {
        id: '',
        object: 'chat.completion',
        created: 0,
        model: options.model,
        choices: []
      },
      choiceIndexMap: new Map(),
      toolCallIndexMap: new Map(),
      eventStats: {
        totalChunks: 0,
        totalTokens: 0,
        totalChoices: 0,
        totalToolCalls: 0,
        startTime: TimeUtils.now(),
        tokenRate: 0,
        chunkRate: 0,
        errorCount: 0,
        retryCount: 0
      },
      isCompleted: false
    };
  }

  /**
   * 处理SSE事件
   */
  private async processSseEvent(
    event: ChatSseEvent,
    context: SseToChatJsonContext
  ): Promise<void> {
    try {
      // 验证事件格式
      if (context.options.validateChunks) {
        this.validateSseEvent(event);
      }

      context.eventStats.totalChunks++;
      const now = TimeUtils.now();
      context.eventStats.firstFrameAtMs ??= now;
      context.eventStats.lastFrameAtMs = now;
      context.options.onEvent?.(event);

      switch (event.event) {
        case 'chat_chunk':
          await this.processChatChunk(event, context);
          break;

        case 'chat.done':
          await this.processDoneEvent(event, context);
          break;

        case 'error':
          await this.processErrorEvent(event, context);
          break;

        case 'ping':
          // 心跳事件，忽略处理
          break;

        default:
          throw ErrorUtils.createError(
            `Unknown SSE event type: ${event.event}`,
            CHAT_CONVERSION_ERROR_CODES.PARSE_ERROR,
            { event }
          );
      }


    } catch (error) {
      context.eventStats.errorCount++;
      throw ErrorUtils.wrapError(error, `Failed to process SSE event: ${event.event}`);
    }
  }

  /**
   * 处理chat_chunk事件
   */
  private async processChatChunk(
    event: ChatSseEvent,
    context: SseToChatJsonContext
  ): Promise<void> {
    try {
      const parsedEntries = event.parsedData !== undefined
        ? [event.parsedData]
        : [JSON.parse(typeof event.data === 'string' ? event.data : '{}')];

      for (const parsed of parsedEntries) {
        const parsedRecord = asRecord(parsed);
        const deepseekState = this.getDeepSeekPatchState(context);
        const cachedErrorInfo = (event as unknown as Record<string, unknown>)._errorInfo as DeepSeekWebErrorInfo | null | undefined;
        if (cachedErrorInfo) {
          const typedError = new Error(cachedErrorInfo.message) as Error & { code?: string };
          typedError.code = cachedErrorInfo.code;
          throw ErrorUtils.createError(
            typedError.message,
            CHAT_CONVERSION_ERROR_CODES.STREAM_ERROR,
            {
              errorData: {
                ...cachedErrorInfo.raw,
                code: cachedErrorInfo.code,
                finish_reason: cachedErrorInfo.finishReason,
                message: cachedErrorInfo.message
              },
              parsed
            }
          );
        }
        const deepseekAnalysis = analyzeDeepSeekWebPayload(parsedRecord, Boolean(deepseekState.patchAppendTarget));
        if (this.tryProcessDeepSeekWebPatchEvent(parsed, context, deepseekAnalysis)) {
          continue;
        }

        const chunk = parsed as ChatCompletionChunk;

        // 验证chunk格式
        if (context.options.validateChunks) {
          this.validateChatChunk(chunk);
        }


        // 初始化响应结构（如果是第一个chunk）
        if (!context.currentResponse.id && chunk.id) {
          context.currentResponse.id = chunk.id;
          context.currentResponse.object = 'chat.completion';
          context.currentResponse.created = chunk.created;
          context.currentResponse.model = chunk.model;
        }

        const normalizedUsage = normalizeChatUsage(chunk.usage);
        if (normalizedUsage) {
          context.currentResponse.usage = normalizedUsage;
          context.eventStats.totalTokens = normalizedUsage.total_tokens;
        }

        // 处理choices
        if (chunk.choices && Array.isArray(chunk.choices)) {
          for (const choice of chunk.choices) {
            await this.processChoice(choice, context);
          }
        }
      }
    } catch (error) {
      throw ErrorUtils.wrapError(error, 'Failed to parse chat_chunk');
    }
  }

  private parseChatChunkPayload(payload: string): unknown[] {
    try {
      return [JSON.parse(payload) as unknown];
    } catch (primaryError) {
      const segments = payload
        .split('\n')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      if (segments.length <= 1) {
        throw primaryError;
      }

      const parsed: unknown[] = [];
      for (const segment of segments) {
        try {
          parsed.push(JSON.parse(segment) as unknown);
        } catch {
          // Ignore non-JSON lines so valid partial frames can still be recovered.
        }
      }
      if (!parsed.length) {
        throw primaryError;
      }
      return parsed;
    }
  }

  private ensureChoiceBuilder(
    context: SseToChatJsonContext,
    choiceIndex: number
  ): ChatChoiceBuilder {
    let choiceBuilder = context.choiceIndexMap.get(choiceIndex);
    if (!choiceBuilder) {
      choiceBuilder = this.createChoiceBuilder(choiceIndex);
      context.choiceIndexMap.set(choiceIndex, choiceBuilder);
      context.currentResponse.choices?.push({
        index: choiceIndex,
        message: {
          role: 'assistant',
          content: ''
        },
        finish_reason: 'stop'
      });
    }
    return choiceBuilder;
  }

  private tryProcessDeepSeekWebPatchEvent(
    parsed: unknown,
    context: SseToChatJsonContext,
    analysis?: DeepSeekWebPayloadAnalysis | null
  ): boolean {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return false;
    }
    const payload = parsed as Record<string, unknown>;
    const deepseekState = this.getDeepSeekPatchState(context);
    const resolvedAnalysis = analysis ?? analyzeDeepSeekWebPayload(payload, Boolean(deepseekState.patchAppendTarget));
    if (!resolvedAnalysis) {
      return false;
    }
    if (resolvedAnalysis.isStandardChunk || !resolvedAnalysis.looksLikePatch) {
      return false;
    }
    const { path, op, value } = resolvedAnalysis;

    if (path === 'response/accumulated_token_usage' && typeof value === 'number') {
      context.eventStats.totalTokens = value;
      return true;
    }

    if (isDeepSeekFragmentStatusPath(path)) {
      return true;
    }

    if (path === 'response/status' && typeof value === 'string') {
      const normalizedStatus = value.trim().toUpperCase();
      if (normalizedStatus !== 'FINISHED') {
        return true;
      }
      context.isCompleted = true;
      const existingChoice = context.choiceIndexMap.get(0);
      if (existingChoice) {
        deepseekState.patchAppendTarget = undefined;
        existingChoice.finishReason = 'stop';
        existingChoice.isCompleted = true;
      }
      return true;
    }

    if (!context.currentResponse.id) {
      context.currentResponse.id = `chat_${context.requestId}`;
    }
    if (!context.currentResponse.object) {
      context.currentResponse.object = 'chat.completion';
    }
    if (!context.currentResponse.created) {
      context.currentResponse.created = Math.floor(Date.now() / 1000);
    }
    if (!context.currentResponse.model) {
      context.currentResponse.model = context.model;
    }

    const choiceBuilder = this.ensureChoiceBuilder(context, 0);
    choiceBuilder.messageBuilder.role = choiceBuilder.messageBuilder.role || 'assistant';

    const appendToTarget = (target: DeepSeekPatchAppendTarget, text: string): void => {
      if (!text) {
        return;
      }
      if (target === 'content' || hasExplicitToolWrapperProgress(text)) {
        this.markSemanticContentSeen(context);
      }
      deepseekState.patchAppendTarget = target;
      if (target === 'reasoning') {
        choiceBuilder.messageBuilder.reasoningContent =
          (choiceBuilder.messageBuilder.reasoningContent || '') + text;
      } else {
        choiceBuilder.messageBuilder.content = (choiceBuilder.messageBuilder.content || '') + text;
      }
      choiceBuilder.accumulatedContent += text;
    };

    const processFragmentRecord = (fragment: Record<string, unknown>): void => {
      const target = resolveDeepSeekFragmentTarget(fragment.type);
      deepseekState.fragmentTargets.push(target);
      deepseekState.patchAppendTarget = target;
      if (typeof fragment.content === 'string' && fragment.content.length > 0) {
        appendToTarget(target, fragment.content);
      }
    };

    const processFragmentsArray = (items: unknown[]): void => {
      for (const item of items) {
        const fragment = asRecord(item);
        if (!fragment) {
          continue;
        }
        processFragmentRecord(fragment);
      }
    };

    const resolveFragmentTargetFromPath = (): DeepSeekPatchAppendTarget | undefined => {
      const prefix = 'response/fragments/';
      const suffix = '/content';
      if (!path.startsWith(prefix) || !path.endsWith(suffix)) {
        return undefined;
      }
      const rawIndex = path.slice(prefix.length, path.length - suffix.length).trim();
      if (!rawIndex) {
        return undefined;
      }
      if (rawIndex === '-1') {
        return deepseekState.fragmentTargets.at(-1);
      }
      const index = Number(rawIndex);
      if (!Number.isInteger(index) || index < 0) {
        return undefined;
      }
      return deepseekState.fragmentTargets[index];
    };

    const fragmentTargetFromPath = resolveFragmentTargetFromPath();

    if (path === 'response/content' && typeof value === 'string') {
      appendToTarget('content', value);
    } else if (path === 'response/thinking_content' && typeof value === 'string') {
      appendToTarget('reasoning', value);
    } else if (path === 'response/content') {
      deepseekState.patchAppendTarget = 'content';
    } else if (path === 'response/thinking_content') {
      deepseekState.patchAppendTarget = 'reasoning';
    } else if (path === 'response/fragments' && op === 'APPEND' && Array.isArray(value)) {
      processFragmentsArray(value);
    } else if (fragmentTargetFromPath && typeof value === 'string') {
      appendToTarget(fragmentTargetFromPath, value);
    } else if (op === 'APPEND' && typeof value === 'string' && deepseekState.patchAppendTarget === 'reasoning') {
      appendToTarget('reasoning', value);
    } else if (op === 'APPEND' && typeof value === 'string' && deepseekState.patchAppendTarget === 'content') {
      appendToTarget('content', value);
    } else if (!path && typeof value === 'string' && value.length > 0) {
      // DeepSeek sometimes continues APPEND content/reasoning via bare {"v":"..."} frames.
      if (deepseekState.patchAppendTarget === 'reasoning') {
        appendToTarget('reasoning', value);
      } else {
        appendToTarget('content', value);
      }
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const inner = value as Record<string, unknown>;
      const responseNode = inner.response;
      if (responseNode && typeof responseNode === 'object' && !Array.isArray(responseNode)) {
        const responseRecord = responseNode as Record<string, unknown>;
        if (typeof responseRecord.content === 'string' && responseRecord.content.length > 0) {
          appendToTarget('content', responseRecord.content);
        }
        if (typeof responseRecord.thinking_content === 'string' && responseRecord.thinking_content.length > 0) {
          appendToTarget('reasoning', responseRecord.thinking_content);
        }
        if (Array.isArray(responseRecord.fragments)) {
          processFragmentsArray(responseRecord.fragments);
        }
        if (typeof responseRecord.status === 'string' && responseRecord.status.toUpperCase() === 'FINISHED') {
          choiceBuilder.finishReason = 'stop';
          choiceBuilder.isCompleted = true;
        }
      }
    }

    if (path === 'response/status' && typeof value === 'string' && value.toUpperCase() === 'FINISHED') {
      deepseekState.patchAppendTarget = undefined;
      choiceBuilder.finishReason = 'stop';
      choiceBuilder.isCompleted = true;
      context.isCompleted = true;
    }

    return true;
  }

  private getDeepSeekPatchState(
    context: SseToChatJsonContext
  ): { patchAppendTarget?: DeepSeekPatchAppendTarget; fragmentTargets: DeepSeekPatchAppendTarget[] } {
    const carrier = context as SseToChatJsonContext & {
      deepseekPatchState?: {
        patchAppendTarget?: DeepSeekPatchAppendTarget;
        fragmentTargets?: DeepSeekPatchAppendTarget[];
      };
    };
    if (!carrier.deepseekPatchState) {
      carrier.deepseekPatchState = { fragmentTargets: [] };
    } else if (!Array.isArray(carrier.deepseekPatchState.fragmentTargets)) {
      carrier.deepseekPatchState.fragmentTargets = [];
    }
    return carrier.deepseekPatchState as { patchAppendTarget?: DeepSeekPatchAppendTarget; fragmentTargets: DeepSeekPatchAppendTarget[] };
  }

  /**
   * 处理choice
   */
  private async processChoice(
    choice: ChatCompletionChunk['choices'][number],
    context: SseToChatJsonContext
  ): Promise<void> {
    const choiceIndex = choice.index || 0;

    // 获取或创建choice构建器
    let choiceBuilder = context.choiceIndexMap.get(choiceIndex);
    if (!choiceBuilder) {
      choiceBuilder = this.createChoiceBuilder(choiceIndex);
      context.choiceIndexMap.set(choiceIndex, choiceBuilder);
      context.currentResponse.choices?.push({
        index: choiceIndex,
        message: {
          role: 'assistant',
          content: ''
        },
        finish_reason: 'stop',
        logprobs: choice.logprobs
      });
    }

    // 处理delta
    if (choice.delta) {
      await this.processDelta(choice.delta, choiceBuilder, context);
    }

    // 处理finish_reason
    if (choice.finish_reason) {
      choiceBuilder.finishReason = choice.finish_reason;
      choiceBuilder.isCompleted = true;
    }

    // 更新响应中的choice
    this.updateResponseChoice(choiceIndex, choiceBuilder, context);
  }

  /**
   * 创建choice构建器
   */
  private createChoiceBuilder(index: number): ChatChoiceBuilder {
    return {
      index,
      delta: {},
      finishReason: undefined,
      logprobs: undefined,
      messageBuilder: {
        role: undefined,
        content: '',
        reasoningContent: '',
        name: undefined,
        functionCall: undefined,
        toolCalls: [],
        toolCallId: undefined,
        isCompleted: false
      },
      isCompleted: false,
      accumulatedContent: '',
      toolCallBuilders: new Map()
    };
  }

  /**
   * 将reasoning文本附加到消息内容
   */
  private appendReasoningToMessageContent(message: ChatMessage, reasoningText: string): void {
    const trimmed = typeof reasoningText === 'string' ? reasoningText.trim() : '';
    if (!trimmed) {
      return;
    }
    const current = typeof message.content === 'string' ? message.content : '';
    const needsSeparator = current.length > 0;
    const separator = !needsSeparator ? '' : current.endsWith('\n') ? '\n' : '\n\n';
    message.content = `${current}${separator}${trimmed}`;
  }

  /**
   * 处理delta
   */
  private async processDelta(
    delta: NonNullable<ChatCompletionChunk['choices'][number]['delta']>,
    choiceBuilder: ChatChoiceBuilder,
    context: SseToChatJsonContext
  ): Promise<void> {
    const messageBuilder = choiceBuilder.messageBuilder;

    // 处理role
    if (delta.role) {
      messageBuilder.role = delta.role;
    }

    // 处理reasoning
    if (delta.reasoning_content || delta.reasoning) {
      const chunk = delta.reasoning_content || delta.reasoning || '';
      if (hasExplicitToolWrapperProgress(chunk)) {
        this.markSemanticContentSeen(context);
      }
      messageBuilder.reasoningContent = (messageBuilder.reasoningContent || '') + chunk;
      choiceBuilder.accumulatedContent += chunk;
    }

    // 处理content
    if (delta.content) {
      this.markSemanticContentSeen(context);
      messageBuilder.content += delta.content;
      choiceBuilder.accumulatedContent += delta.content;
    }

    // 处理function_call
    if (delta.function_call) {
      if (delta.function_call.name) {
        messageBuilder.functionCall = {
          ...messageBuilder.functionCall,
          name: delta.function_call.name
        };
      }
      if (delta.function_call.arguments) {
        messageBuilder.functionCall = {
          ...messageBuilder.functionCall,
          arguments: (messageBuilder.functionCall?.arguments || '') + delta.function_call.arguments
        };
      }
    }

    // 处理tool_calls
    if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
      for (const toolCallDelta of delta.tool_calls) {
        await this.processToolCallDelta(toolCallDelta, choiceBuilder);
      }
    }

    // 合并delta到choiceBuilder
    choiceBuilder.delta = { ...choiceBuilder.delta, ...delta };
  }

  /**
   * 处理tool_call delta
   */
  private async processToolCallDelta(
    toolCallDelta: ChatToolCallChunk,
    choiceBuilder: ChatChoiceBuilder
  ): Promise<void> {
    const toolCallIndex = toolCallDelta.index;

    // 获取或创建tool_call构建器
    let toolCallBuilder = choiceBuilder.toolCallBuilders.get(toolCallIndex);
    if (!toolCallBuilder) {
      toolCallBuilder = {
        index: toolCallIndex,
        id: '',
        type: 'function',
        function: {
          name: '',
          arguments: ''
        },
        isCompleted: false,
        accumulatedArguments: ''
      };
      choiceBuilder.toolCallBuilders.set(toolCallIndex, toolCallBuilder);
    }

    // 更新tool_call构建器
    if (toolCallDelta.id) {
      toolCallBuilder.id = toolCallDelta.id;
    }

    if (toolCallDelta.type) {
      toolCallBuilder.type = toolCallDelta.type;
    }

    if (toolCallDelta.function) {
      if (toolCallDelta.function.name) {
        toolCallBuilder.function!.name = toolCallDelta.function.name;
      }
      if (toolCallDelta.function.arguments) {
        toolCallBuilder.function!.arguments += toolCallDelta.function.arguments;
        toolCallBuilder.accumulatedArguments += toolCallDelta.function.arguments;
      }
    }

    // 标记完成（当arguments不为空且id存在时）
    if (toolCallBuilder.id && toolCallBuilder.function!.arguments) {
      toolCallBuilder.isCompleted = true;
    }
  }

  /**
   * 更新响应中的choice
   */
  private updateResponseChoice(
    choiceIndex: number,
    choiceBuilder: ChatChoiceBuilder,
    context: SseToChatJsonContext
  ): void {
    const responseChoice = context.currentResponse.choices?.[choiceIndex];
    if (!responseChoice) {
      return;
    }

    const messageBuilder = choiceBuilder.messageBuilder;

    // 构建message
    const message: ChatMessage = {
      role: messageBuilder.role || 'assistant'
    };

    const normalizedContent = normalizeChatMessageContent(messageBuilder.content);
    if (normalizedContent.contentText !== undefined) {
      message.content = normalizedContent.contentText;
    } else if (messageBuilder.content) {
      message.content = messageBuilder.content;
    }
    const reasoningCandidate =
      messageBuilder.reasoningContent && messageBuilder.reasoningContent.length
        ? messageBuilder.reasoningContent
        : normalizedContent.reasoningText;
    if (reasoningCandidate) {
      (message as any).reasoning_content = reasoningCandidate;
    }

    if (messageBuilder.functionCall) {
      message.function_call = messageBuilder.functionCall;
    }

    // 构建tool_calls
    const toolCalls: ChatToolCall[] = [];
    for (const toolCallBuilder of choiceBuilder.toolCallBuilders.values()) {
      if (toolCallBuilder.id && toolCallBuilder.function) {
        toolCalls.push({
          id: toolCallBuilder.id,
          type: toolCallBuilder.type || 'function',
          function: {
            name: toolCallBuilder.function.name ?? '',
            arguments: toolCallBuilder.function.arguments ?? ''
          }
        });
      }
    }

    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }

    this.normalizeReasoning(choiceBuilder, message, context);

    responseChoice.message = message;
    responseChoice.finish_reason =
      Array.isArray(message.tool_calls) && message.tool_calls.length > 0
        ? 'tool_calls'
        : (choiceBuilder.finishReason ?? responseChoice.finish_reason);

    context.eventStats.totalToolCalls += toolCalls.length;
  }

  /**
   * 将reasoning内容规范化为独立字段并抽取工具调用
   */
  private normalizeReasoning(
    choiceBuilder: ChatChoiceBuilder,
    message: ChatMessage,
    context: SseToChatJsonContext
  ): void {
    if (!(message as any).reasoning_content && !(message as any).reasoning) {
      return;
    }

    const target = message as unknown as Record<string, unknown>;
    const normalization = normalizeMessageReasoningTools(target, {
      idPrefix: `chat_sse_reasoning_${choiceBuilder.index + 1}`
    });

    const reasoningSource =
      typeof normalization.cleanedReasoning === 'string'
        ? normalization.cleanedReasoning
        : typeof (target as any).reasoning_content === 'string'
        ? (target as any).reasoning_content
        : typeof (target as any).reasoning === 'string'
          ? (target as any).reasoning
          : undefined;

    const reasoningText = typeof reasoningSource === 'string' ? reasoningSource.trim() : '';
    if (!reasoningText) {
      if ('reasoning_content' in target) delete (target as any).reasoning_content;
      if ('reasoning' in target) delete (target as any).reasoning;
      return;
    }

    const dispatchResult = dispatchReasoning(reasoningText, {
      mode: context.options.reasoningMode ?? this.config.reasoningMode,
      prefix: context.options.reasoningTextPrefix ?? this.config.reasoningTextPrefix
    });

    if (dispatchResult.appendToContent) {
      this.appendReasoningToMessageContent(message, dispatchResult.appendToContent);
      if ('reasoning_content' in target) delete (target as any).reasoning_content;
      if ('reasoning' in target) delete (target as any).reasoning;
      return;
    }

    if (dispatchResult.channel) {
      (target as any).reasoning_content = dispatchResult.channel;
      if ('reasoning' in target) delete (target as any).reasoning;
      return;
    }

    if ('reasoning_content' in target) delete (target as any).reasoning_content;
    if ('reasoning' in target) delete (target as any).reasoning;
  }

  /**
   * 处理done事件
   */
  private async processDoneEvent(
    event: ChatSseEvent,
    context: SseToChatJsonContext
  ): Promise<void> {
    context.isCompleted = true;

    // 解析done事件数据（如果有的话）
    try {
      const doneData = event.parsedData && typeof event.parsedData === 'object' && !Array.isArray(event.parsedData)
        ? event.parsedData as { totalTokens?: number }
        : typeof event.data === 'string'
          ? JSON.parse(event.data) as { totalTokens?: number }
          : undefined;
      if (doneData) {
        if (typeof doneData.totalTokens === 'number') {
          context.eventStats.totalTokens = doneData.totalTokens;
        }
      }
    } catch (e) {
      // 忽略解析错误
    }
  }

  /**
   * 处理error事件
   */
  private async processErrorEvent(
    event: ChatSseEvent,
    _context: SseToChatJsonContext
  ): Promise<void> {
    const rawPayload = typeof event.data === 'string' ? event.data : JSON.stringify(event.data ?? {});
    let errorData: Record<string, unknown> | undefined;
    try {
      const parsed = event.parsedData !== undefined
        ? event.parsedData
        : JSON.parse(rawPayload);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        errorData = parsed as Record<string, unknown>;
      }
    } catch {
      // keep raw payload only
    }

    const deepseekErrorInfo = extractDeepSeekWebErrorInfo(errorData);
    if (deepseekErrorInfo) {
      errorData = {
        ...deepseekErrorInfo.raw,
        code: deepseekErrorInfo.code,
        finish_reason: deepseekErrorInfo.finishReason,
        message: deepseekErrorInfo.message
      };
    }

    const errorMessage = errorData
      ? (typeof errorData.error === 'string'
          ? errorData.error
          : typeof errorData.message === 'string'
            ? errorData.message
            : typeof errorData.content === 'string'
              ? errorData.content
              : 'Unknown SSE error')
      : `SSE error event: ${event.data}`;
    const code = errorData
      ? (typeof errorData.code === 'string'
          ? errorData.code
          : typeof errorData.finish_reason === 'string'
            ? errorData.finish_reason
            : 'SSE_ERROR')
      : 'SSE_ERROR';
    const typedError = new Error(errorMessage) as Error & { code?: string };
    typedError.code = code;

    throw ErrorUtils.createError(
      typedError.message,
      CHAT_CONVERSION_ERROR_CODES.STREAM_ERROR,
      { errorData, event }
    );
  }

  /**
   * 构建部分响应
   */
  private buildPartialResponse(context: SseToChatJsonContext): ChatCompletionResponse | null {
    const choices = context.currentResponse.choices || [];
    if (choices.length === 0) {
      return null;
    }

    return {
      id: context.currentResponse.id || '',
      object: 'chat.completion',
      created: context.currentResponse.created || 0,
      model: context.currentResponse.model,
      usage: this.buildUsageInfo(context) || undefined,
      choices: choices.map(choice => ({
        ...choice,
        // 确保message对象存在
        message: choice.message || { role: 'assistant', content: '' }
      }))
    };
  }

  /**
   * 完成响应构建
   */
  private finalizeResponse(context: SseToChatJsonContext): ChatCompletionResponse {
    for (const [choiceIndex, choiceBuilder] of context.choiceIndexMap.entries()) {
      this.updateResponseChoice(choiceIndex, choiceBuilder, context);
    }

    const choices = context.currentResponse.choices || [];

    // 确保所有choices都已完成
    for (const choice of choices) {
      if (!choice.finish_reason) {
        choice.finish_reason = 'stop';
      }
    }

    // 构建usage信息
    const usage = this.buildUsageInfo(context);

    context.eventStats.totalChoices = choices.length;
    context.eventStats.endTime = TimeUtils.now();
    context.eventStats.duration = (context.eventStats.endTime - context.eventStats.startTime) / 1000;
    if (context.eventStats.duration > 0) {
      context.eventStats.chunkRate = context.eventStats.totalChunks / context.eventStats.duration;
      context.eventStats.tokenRate = context.eventStats.totalTokens / context.eventStats.duration;
    }

    const response: ChatCompletionResponse = {
      id: context.currentResponse.id || `chat_${context.requestId}`,
      object: 'chat.completion',
      created: context.currentResponse.created || Math.floor(Date.now() / 1000),
      model: context.currentResponse.model,
      choices,
      usage: usage || undefined
    };

    // Attach decode stats for TTFT tracking
    Object.defineProperty(response, '__rccDecodeStats', {
      value: {
        chunkCount: context.eventStats.totalChunks,
        totalEvents: context.eventStats.totalChunks,
        contentBlocks: context.eventStats.totalChoices,
        firstFrameAtMs: context.eventStats.firstFrameAtMs,
        lastFrameAtMs: context.eventStats.lastFrameAtMs,
        firstContentAtMs: context.eventStats.firstContentAtMs,
        lastContentAtMs: context.eventStats.lastContentAtMs,
        streamMs:
          context.eventStats.firstContentAtMs !== undefined && context.eventStats.lastContentAtMs !== undefined
            ? Math.max(0, context.eventStats.lastContentAtMs - context.eventStats.firstContentAtMs)
            : undefined,
        totalTokens: context.eventStats.totalTokens,
        tokenRate: context.eventStats.tokenRate
      },
      configurable: true,
      enumerable: false,
      writable: false
    });
    return response;
  }

  private isTerminatedError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const message = (error as { message?: unknown }).message;
    const code = (error as { code?: unknown }).code;
    const normalizedMessage = typeof message === 'string' ? message.toLowerCase() : '';
    const normalizedCode = typeof code === 'string' ? code.toLowerCase() : '';
    return (
      normalizedCode.includes('terminated') ||
      normalizedMessage.includes('terminated') ||
      normalizedCode.includes('upstream_stream_idle_timeout') ||
      normalizedMessage.includes('upstream_stream_idle_timeout') ||
      normalizedCode.includes('upstream_stream_content_idle_timeout') ||
      normalizedMessage.includes('upstream_stream_content_idle_timeout') ||
      normalizedCode.includes('upstream_stream_no_content_timeout') ||
      normalizedMessage.includes('upstream_stream_no_content_timeout') ||
      normalizedCode.includes('upstream_stream_timeout') ||
      normalizedMessage.includes('upstream_stream_timeout')
    );
  }

  private wrapSseError(error: unknown, contextMessage: string): Error {
    const wrapped = ErrorUtils.wrapError(error, contextMessage) as Error & {
      code?: string;
      status?: number;
      statusCode?: number;
      retryable?: boolean;
      upstreamCode?: string;
      requestExecutorProviderErrorStage?: string;
    };
    const source = error as Record<string, unknown> | undefined;
    const code = typeof source?.code === 'string' ? source.code : undefined;
    const statusCode =
      typeof source?.statusCode === 'number'
        ? source.statusCode
        : typeof source?.status === 'number'
          ? source.status
          : undefined;
    const retryable = typeof source?.retryable === 'boolean' ? source.retryable : undefined;
    const upstreamCode =
      typeof source?.upstreamCode === 'string'
        ? source.upstreamCode
        : code;
    if (code) {
      wrapped.code = code === 'CHAT_STREAM_ERROR' ? 'SSE_DECODE_ERROR' : code;
    }
    if (typeof statusCode === 'number') {
      wrapped.status = statusCode;
      wrapped.statusCode = statusCode;
    }
    if (typeof retryable === 'boolean') {
      wrapped.retryable = retryable;
    }
    if (upstreamCode) {
      wrapped.upstreamCode = upstreamCode;
    }
    wrapped.requestExecutorProviderErrorStage = 'provider.sse_decode';
    return wrapped;
  }

  private trySalvageResponse(context: SseToChatJsonContext): ChatCompletionResponse | null {
    const choices = context.currentResponse.choices || [];
    const hasMaterializedChoice = choices.some((choice) => {
      const message = choice?.message as unknown as Record<string, unknown> | undefined;
      const content = typeof message?.content === 'string' ? message.content.trim() : '';
      const reasoning = typeof (message as any)?.reasoning_content === 'string'
        ? String((message as any).reasoning_content).trim()
        : '';
      const functionCall = message?.function_call;
      const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
      return Boolean(content || reasoning || functionCall || toolCalls.length > 0);
    });

    if (!hasMaterializedChoice) {
      return null;
    }

    for (const choice of choices) {
      if (!choice.finish_reason) {
        choice.finish_reason = 'stop';
      }
    }

    return this.finalizeResponse(context);
  }

  /**
   * 构建使用量信息
   */
  private buildUsageInfo(_context: SseToChatJsonContext): ChatCompletionResponse['usage'] | null {
    const directUsage = normalizeChatUsage(_context.currentResponse.usage);
    return directUsage || null;
  }

  /**
   * 验证SSE事件
   */
  private validateSseEvent(event: ChatSseEvent): void {
    if (!event.event) {
      throw ErrorUtils.createError(
        'SSE event type is required',
        CHAT_CONVERSION_ERROR_CODES.VALIDATION_ERROR,
        { event }
      );
    }

    if (!event.data) {
      throw ErrorUtils.createError(
        'SSE event data is required',
        CHAT_CONVERSION_ERROR_CODES.VALIDATION_ERROR,
        { event }
      );
    }

    const validEvents: ChatSseEventType[] = ['chat_chunk', 'chat.done', 'error', 'ping'];
    if (!validEvents.includes(event.event as ChatSseEventType)) {
      throw ErrorUtils.createError(
        `Invalid SSE event type: ${event.event}`,
        CHAT_CONVERSION_ERROR_CODES.VALIDATION_ERROR,
        { event }
      );
    }
  }

  /**
   * 验证Chat chunk
   */
  private validateChatChunk(chunk: ChatCompletionChunk): void {
    if (!chunk.object || chunk.object !== 'chat.completion.chunk') {
      throw ErrorUtils.createError(
        'Invalid chat completion chunk object',
        CHAT_CONVERSION_ERROR_CODES.PARSE_ERROR,
        { chunk }
      );
    }

    if (!Array.isArray(chunk.choices)) {
      throw ErrorUtils.createError(
        'Chunk choices must be an array',
        CHAT_CONVERSION_ERROR_CODES.PARSE_ERROR,
        { chunk }
      );
    }
  }


  /**
   * 获取转换统计
   */
  getStats(requestId: string): ChatEventStats | undefined {
    const context = this.contexts.get(requestId);
    return context?.eventStats;
  }

  /**
   * 清理上下文
   */
  cleanup(requestId: string): void {
    this.contexts.delete(requestId);
  }

  /**
   * 清理所有上下文
   */
  cleanupAll(): void {
    this.contexts.clear();
  }
}

// 创建默认转换器实例
export const defaultChatSseToJsonConverter = new ChatSseToJsonConverter();
