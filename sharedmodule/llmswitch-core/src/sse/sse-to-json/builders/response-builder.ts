/**
 * Responses响应构建器
 * 负责状态机和事件聚合，从SSE事件构建完整的Responses响应对象
 */

import type {
  ResponsesSseEvent,
  ResponsesResponse,
  ResponsesOutputItem,
  ResponsesMessageItem,
  ResponsesFunctionCallItem,
  ResponsesReasoningItem,
  ResponsesContent,
  ResponsesUsage,
  OutputItemBuilder,
  SseToResponsesJsonContext
} from '../../types/index.js';
import { normalizeResponsesMessageItem } from '../../shared/responses-output-normalizer.js';

// 构建器状态
export type ResponseBuilderState = 'initial' | 'building' | 'completed' | 'error';

// 构建器配置
export interface ResponseBuilderConfig {
  enableStrictValidation: boolean;
  enableEventRecovery: boolean;
  maxOutputItems: number;
  maxContentParts: number;
  maxSequenceGaps: number;
}

// 输出项状态
export interface OutputItemState {
  id: string;
  type: string;
  status: 'in_progress' | 'completed';
  contentParts: any[];
  currentContentIndex: number;
  accumulatedContent: any[];
  currentReasoningIndex: number;
  summaryByIndex: Map<number, string>;
  currentSummaryIndex: number;
  hasContentPartAdded: boolean;
  isTextInProgress: boolean;
  callId?: string;
  name?: string;
  arguments?: string;
  role?: string;
  encryptedContent?: string;
  startTime: number;
  lastEventTime: number;
}

// 默认配置
export const DEFAULT_RESPONSE_BUILDER_CONFIG: ResponseBuilderConfig = {
  enableStrictValidation: true,
  enableEventRecovery: true,
  maxOutputItems: 50,
  maxContentParts: 100,
  maxSequenceGaps: 10
};

/**
 * Responses响应构建器
 */
export class ResponsesResponseBuilder {
  private state: ResponseBuilderState = 'initial';
  private response: Partial<ResponsesResponse> = {};
  private outputItemBuilders = new Map<string, OutputItemState>();
  private lastSequenceNumber: number = -1;
  private config: ResponseBuilderConfig;
  private error?: Error;
  private hasExplicitReasoning: boolean = false;

  constructor(config?: Partial<ResponseBuilderConfig>) {
    this.config = { ...DEFAULT_RESPONSE_BUILDER_CONFIG, ...config };
  }

  /**
   * 处理SSE事件
   */
  processEvent(event: ResponsesSseEvent): boolean {
    try {
      // 验证序列号
      if (!this.validateSequenceNumber(event)) {
        if (this.config.enableStrictValidation) {
          throw new Error(`Invalid sequence number: ${event.sequenceNumber}`);
        }
      }

      // 更新状态
      this.state = 'building';
      this.lastSequenceNumber = event.sequenceNumber;

      // 根据事件类型处理
      switch (event.type) {
        case 'response.created':
          this.handleResponseCreated(event);
          break;

        case 'response.in_progress':
          this.handleResponseInProgress(event);
          break;

        case 'response.output_item.added':
          this.handleOutputItemStart(this.mapOutputItemAdded(event));
          break;
        case 'response.output_item.done':
          this.handleOutputItemDone(this.mapOutputItemDone(event));
          break;

        case 'response.content_part.added':
          this.handleContentPartStart(this.mapContentPartAdded(event));
          break;

        case 'response.output_text.delta':
          this.handleContentPartDelta(this.mapOutputTextDelta(event));
          break;

        case 'response.output_text.done':
          this.handleContentPartDone(this.mapContentPartDone(event));
          break;

        case 'response.function_call_arguments.delta':
          this.handleFunctionCallDelta(this.mapFunctionCallDelta(event));
          break;

        case 'response.function_call_arguments.done':
          this.handleFunctionCallDone(this.mapFunctionCallDone(event));
          break;

        case 'response.reasoning_text.delta':
        case 'response.reasoning_signature.delta':
        case 'response.reasoning_image.delta':
          this.handleReasoningDelta(this.mapReasoningDelta(event));
          break;
        case 'response.reasoning_summary_text.delta':
          this.handleReasoningSummaryDelta(event);
          break;
        case 'response.reasoning_summary_text.done':
          this.handleReasoningSummaryDone(event);
          break;
        case 'response.reasoning_summary_part.added':
          this.handleReasoningSummaryPartAdded(event);
          break;
        case 'response.reasoning_summary_part.done':
          this.handleReasoningSummaryPartDone(event);
          break;

        case 'response.reasoning_text.done':
          this.handleReasoningDone(this.mapReasoningDone(event));
          break;

        case 'response.completed':
          this.handleResponseCompleted(event);
          break;

        case 'response.start':
          this.handleResponseStart(event);
          break;

        case 'output_item.start':
          this.handleOutputItemStart(event);
          break;

        case 'content_part.start':
          this.handleContentPartStart(event);
          break;

        case 'content_part.delta':
          this.handleContentPartDelta(event);
          break;

        case 'content_part.done':
          this.handleContentPartDone(event);
          break;

        case 'function_call.start':
          this.handleFunctionCallStart(event);
          break;

        case 'function_call.delta':
          this.handleFunctionCallDelta(event);
          break;

        case 'function_call.done':
          this.handleFunctionCallDone(event);
          break;

        case 'reasoning.start':
          this.handleReasoningStart(event);
          break;

        case 'reasoning.delta':
          this.handleReasoningDelta(event);
          break;

        case 'reasoning.done':
          this.handleReasoningDone(event);
          break;

        case 'output_item.done':
          this.handleOutputItemDone(event);
          break;

        case 'required_action':
        case 'response.required_action':
          this.handleRequiredAction(event);
          break;

        case 'response.done':
          this.handleResponseDone(event);
          break;

        case 'response.content_part.done':
          this.handleContentPartDone(event);
          break;

        case 'error':
          this.handleError(event);
          break;

        default:
          if (this.config.enableStrictValidation) {
            throw new Error(`Unknown event type: ${event.type}`);
          }
      }

      return true;

    } catch (error) {
      this.error = error as Error;
      this.state = 'error';
      return false;
    }
  }

  /**
   * 验证序列号
   */
  private validateSequenceNumber(event: ResponsesSseEvent): boolean {
    if (event.sequenceNumber <= this.lastSequenceNumber) {
      return false;
    }

    const gap = event.sequenceNumber - this.lastSequenceNumber;
    if (gap > 1 && gap > this.config.maxSequenceGaps) {
      return false;
    }

    return true;
  }

  /**
   * 处理response.start事件
   */
  private handleResponseStart(event: ResponsesSseEvent): void {
    const data = event.data as any;
    this.response = {
      id: data.id ?? this.response.id,
      object: 'response',
      created_at: data.created_at ?? this.response.created_at,
      status: data.status ?? 'in_progress',
      model: data.model ?? this.response.model,
      user: data.user ?? this.response.user,
      temperature: data.temperature ?? this.response.temperature,
      top_p: data.top_p ?? this.response.top_p,
      max_output_tokens: data.max_output_tokens ?? this.response.max_output_tokens,
      metadata: data.metadata ?? this.response.metadata,
      output: this.response.output ?? []
    };
  }
  private handleResponseCreated(event: ResponsesSseEvent): void {
    const data = (event.data as any)?.response ?? event.data;
    this.handleResponseStart({
      ...event,
      type: 'response.start',
      data
    } as ResponsesSseEvent);
  }

  private handleResponseInProgress(event: ResponsesSseEvent): void {
    const data = event.data as any;
    if (!this.response) return;
    this.response.status = data.status ?? this.response.status ?? 'in_progress';
  }

  /**
   * 处理output_item.start事件
   */
  private handleOutputItemStart(event: ResponsesSseEvent): void {
    const data = event.data as any;

    if (this.outputItemBuilders.size >= this.config.maxOutputItems) {
      throw new Error('Maximum output items exceeded');
    }

    if (data.type === 'reasoning') {
      this.hasExplicitReasoning = true;
    }

    const outputItemState: OutputItemState = {
      id: data.item_id,
      type: data.type,
      status: 'in_progress',
      contentParts: data.content_index !== undefined ? [] : [],
      currentContentIndex: 0,
      accumulatedContent: [],
      currentReasoningIndex: 0,
      summaryByIndex: new Map<number, string>(),
      currentSummaryIndex: 0,
      hasContentPartAdded: false,
      isTextInProgress: false,
      role: data.role,
      callId: data.call_id,
      name: data.name,
      encryptedContent: typeof data.encrypted_content === 'string' ? data.encrypted_content : undefined,
      startTime: event.timestamp,
      lastEventTime: event.timestamp
    };

    this.outputItemBuilders.set(data.item_id, outputItemState);
  }
  private mapOutputItemAdded(event: ResponsesSseEvent): ResponsesSseEvent {
    const data = event.data as any;
    const item = data.item || {};
    const rawType = item.type ?? data.item_type ?? data.type;
    let normalizedType = typeof rawType === 'string'
      ? rawType.replace(/^response\./, '')
      : 'message';
    // 将 web_search_call 视为标准 function_call，便于统一作为 Chat 工具调用暴露给上层。
    if (normalizedType === 'web_search_call') {
      normalizedType = 'function_call';
    }
    return {
      ...event,
      type: 'output_item.start',
      data: {
        item_id: data.item_id ?? item.id,
        type: normalizedType,
        status: data.status ?? item.status ?? 'in_progress',
        role: data.role ?? item.role,
        call_id: data.call_id ?? item.call_id,
        name: data.name ?? item.name,
        encrypted_content: typeof item.encrypted_content === 'string' ? item.encrypted_content : undefined
      }
    };
  }

  private mapOutputItemDone(event: ResponsesSseEvent): ResponsesSseEvent {
    const data = event.data as any;
    const item = data.item || {};
    return {
      ...event,
      type: 'output_item.done',
      data: {
        item_id: data.item_id ?? item.id,
        item
      }
    };
  }

  /**
   * 处理content_part.start事件
   */
  private handleContentPartStart(event: ResponsesSseEvent): void {
    const data = event.data as any;
    const outputItemState = this.outputItemBuilders.get(data.item_id);

    if (!outputItemState) {
      throw new Error(`Output item not found: ${data.item_id}`);
    }

    if (outputItemState.contentParts.length >= this.config.maxContentParts &&
        data.content_index === undefined) {
      throw new Error('Maximum content parts exceeded');
    }

    const contentIndex = data.content_index ?? outputItemState.contentParts.length;
    const lookupKey = data[data.type] ? data.type :
      data.text ? 'text' :
      data.output_text ? 'output_text' :
      undefined;
    let contentPart: ResponsesContent = data[data.type];

    if (!contentPart && lookupKey === 'text') {
      const textValue = typeof data.text === 'string' ? data.text : data.text?.text;
      contentPart = { type: data.type ?? 'output_text', text: textValue ?? '' } as ResponsesContent;
    } else if (!contentPart && lookupKey === 'output_text') {
      const textValue = typeof data.output_text === 'string' ? data.output_text : data.output_text?.text;
      contentPart = { type: 'output_text', text: textValue ?? '' } as ResponsesContent;
    } else if (!contentPart && typeof data.text === 'string') {
      contentPart = { type: data.type ?? 'output_text', text: data.text } as ResponsesContent;
    }

    if (!contentPart) {
      contentPart = data[data.type === 'input_text' ? 'text' : data.type] || {
        type: data.type ?? 'output_text',
        text: ''
      };
    }

    if (data.content_index !== undefined && (contentPart as any).text !== undefined) {
      (contentPart as any)._initialText = (contentPart as any).text || '';
      (contentPart as any)._hasDelta = false;
      (contentPart as any).text = '';
    }

    outputItemState.contentParts[contentIndex] = contentPart;
    outputItemState.hasContentPartAdded = true;
    outputItemState.lastEventTime = event.timestamp;
    outputItemState.currentContentIndex = contentIndex;
  }
  private mapContentPartAdded(event: ResponsesSseEvent): ResponsesSseEvent {
    const data = event.data as any;
    const part = data.part || {};
    const normalizedType = part.type ?? data.type ?? 'output_text';
    const textValue =
      typeof part.text === 'string'
        ? part.text
        : (typeof data.text === 'string' ? data.text : '');

    return {
      ...event,
      type: 'content_part.start',
      data: {
        item_id: data.item_id ?? part.item_id,
        type: normalizedType,
        content_index: data.content_index,
        text: textValue,
        output_text: normalizedType === 'output_text' ? { type: 'output_text', text: textValue ?? '' } : undefined
      }
    };
  }

  /**
   * 处理content_part.delta事件
   */
  private handleContentPartDelta(event: ResponsesSseEvent): void {
    const data = event.data as any;
    const outputItemState = this.outputItemBuilders.get(data.item_id);

    if (!outputItemState) {
      throw new Error(`Output item not found: ${data.item_id}`);
    }

    const contentIndex = data.part_index ?? data.content_index ?? outputItemState.currentContentIndex;
    const contentPart = outputItemState.contentParts[contentIndex];
    if (!contentPart) {
      throw new Error(`Content part not found: ${contentIndex}`);
    }

    if ((contentPart.type === 'input_text' || contentPart.type === 'output_text')) {
      const deltaChunk = typeof data.delta === 'string'
        ? data.delta
        : data.delta?.text;
      if (deltaChunk) {
        (contentPart as any).text = ((contentPart as any).text || '') + deltaChunk;
        (contentPart as any)._hasDelta = true;
      }
    } else if (contentPart.type === 'function_call') {
      const argDelta = typeof data.delta === 'string'
        ? data.delta
        : data.delta?.arguments;
      if (argDelta) {
        (contentPart as any).arguments = ((contentPart as any).arguments || '') + argDelta;
      }
    }

    outputItemState.isTextInProgress = true;
    outputItemState.lastEventTime = event.timestamp;
  }
  private mapOutputTextDelta(event: ResponsesSseEvent): ResponsesSseEvent {
    const data = event.data as any;
    return {
      ...event,
      type: 'content_part.delta',
      data: {
        item_id: data.item_id,
        part_index: data.content_index,
        delta: {
          type: 'output_text',
          text: data.delta
        }
      }
    };
  }

  /**
   * 处理content_part.done事件
   */
  private handleContentPartDone(event: ResponsesSseEvent): void {
    const data = event.data as any;
    const outputItemState = this.outputItemBuilders.get(data.item_id);

    if (!outputItemState) {
      throw new Error(`Output item not found: ${data.item_id}`);
    }

    const contentIndex = data.content_index ?? data.part_index ?? outputItemState.currentContentIndex;
    if (contentIndex !== undefined) {
      const contentPart = outputItemState.contentParts[contentIndex];
      if (contentPart &&
        (contentPart as any)._hasDelta !== true &&
        (contentPart as any)._initialText &&
        !(contentPart as any).text) {
        (contentPart as any).text = (contentPart as any)._initialText;
      }
      outputItemState.currentContentIndex = contentIndex + 1;
    } else {
      outputItemState.currentContentIndex++;
    }
    outputItemState.isTextInProgress = false;
    outputItemState.lastEventTime = event.timestamp;
  }
  private mapContentPartDone(event: ResponsesSseEvent): ResponsesSseEvent {
    const data = event.data as any;
    return {
      ...event,
      type: 'content_part.done',
      data: {
        item_id: data.item_id,
        part_index: data.content_index ?? data.part_index
      }
    };
  }

  /**
   * 处理function_call.start事件
   */
  private handleFunctionCallStart(event: ResponsesSseEvent): void {
    const data = event.data as any;
    const outputItemState = this.outputItemBuilders.get(data.item_id);

    if (!outputItemState) {
      throw new Error(`Output item not found: ${data.item_id}`);
    }

    outputItemState.callId = data.call_id;
    outputItemState.name = data.name;
    outputItemState.arguments = '';
    outputItemState.lastEventTime = event.timestamp;
  }

  private coerceArgumentsChunk(raw: unknown): string | undefined {
    if (typeof raw === 'string') {
      return raw;
    }
    if (raw && typeof raw === 'object') {
      try {
        return JSON.stringify(raw);
      } catch {
        return String(raw);
      }
    }
    return undefined;
  }

  private shouldOverrideArguments(current: string | undefined, incoming: string | undefined): boolean {
    if (!incoming) {
      return false;
    }
    const trimmed = incoming.trim();
    if (!current || !current.length) {
      return trimmed.length > 0;
    }
    if (!trimmed.length) {
      return false;
    }
    if (trimmed === '{}' || trimmed.toLowerCase() === 'null') {
      return false;
    }
    return true;
  }

  /**
   * 处理function_call.delta事件
   */
  private handleFunctionCallDelta(event: ResponsesSseEvent): void {
    const data = event.data as any;
    const outputItemState = this.outputItemBuilders.get(data.item_id);

    if (!outputItemState) {
      throw new Error(`Output item not found: ${data.item_id}`);
    }

    const chunk =
      this.coerceArgumentsChunk(data?.delta?.arguments) ??
      this.coerceArgumentsChunk(data?.delta) ??
      this.coerceArgumentsChunk(data?.arguments);
    if (chunk) {
      outputItemState.arguments = (outputItemState.arguments || '') + chunk;
    }

    outputItemState.lastEventTime = event.timestamp;
  }
  private mapFunctionCallDelta(event: ResponsesSseEvent): ResponsesSseEvent {
    const data = event.data as any;
    const deltaObj = (data.delta && typeof data.delta === 'object') ? data.delta : undefined;
    const argChunk = typeof data.delta === 'string'
      ? data.delta
      : (deltaObj && typeof (deltaObj as any).arguments === 'string' ? (deltaObj as any).arguments : (typeof data.arguments === 'string' ? data.arguments : undefined));
    return {
      ...event,
      type: 'function_call.delta',
      data: {
        item_id: data.item_id,
        delta: {
          arguments: argChunk,
          name: (deltaObj as any)?.name ?? data.name
        }
      }
    };
  }

  /**
   * 处理function_call.done事件
   */
  private handleFunctionCallDone(event: ResponsesSseEvent): void {
    const data = event.data as any;
    const outputItemState = this.outputItemBuilders.get(data.item_id);

    if (!outputItemState) {
      throw new Error(`Output item not found: ${data.item_id}`);
    }
    // 写入最终的 name/arguments（Responses: response.function_call_arguments.done）
    try {
      if (typeof data.name === 'string' && data.name) outputItemState.name = data.name;
      if (typeof data.call_id === 'string' && data.call_id) outputItemState.callId = data.call_id;
      const finalChunk =
        this.coerceArgumentsChunk(data?.arguments) ??
        this.coerceArgumentsChunk(data?.delta?.arguments) ??
        this.coerceArgumentsChunk(data?.delta);
      if (this.shouldOverrideArguments(outputItemState.arguments, finalChunk)) {
        outputItemState.arguments = finalChunk;
      } else if (!outputItemState.arguments && finalChunk) {
        // 没有任何累计增量时，保底写入 done 事件里的值
        outputItemState.arguments = finalChunk;
      }
    } catch { /* ignore */ }
    outputItemState.status = 'completed';
    outputItemState.lastEventTime = event.timestamp;
  }
  private mapFunctionCallDone(event: ResponsesSseEvent): ResponsesSseEvent {
    const data = event.data as any;
    const delta = (data.delta && typeof data.delta === 'object') ? data.delta : {};
    return {
      ...event,
      type: 'function_call.done',
      data: {
        item_id: data.item_id,
        call_id: data.call_id,
        name: data.name ?? delta.name,
        arguments: data.arguments ?? delta.arguments
      }
    };
  }

  /**
   * 处理reasoning.start事件
   */
  private handleReasoningStart(event: ResponsesSseEvent): void {
    const data = event.data as any;
    const outputItemState = this.outputItemBuilders.get(data.item_id);

    if (!outputItemState) {
      throw new Error(`Output item not found: ${data.item_id}`);
    }

    outputItemState.accumulatedContent = [];
    if (Array.isArray(data.summary)) {
      data.summary.forEach((entry: any, index: number) => {
        if (typeof entry === 'string') {
          outputItemState.summaryByIndex.set(index, entry);
          return;
        }
        if (entry && typeof entry === 'object' && typeof entry.text === 'string') {
          outputItemState.summaryByIndex.set(index, entry.text);
        }
      });
    }
    outputItemState.lastEventTime = event.timestamp;
  }

  /**
   * 处理reasoning.delta事件
   */
  private handleReasoningDelta(event: ResponsesSseEvent): void {
    const data = event.data as any;
    const outputItemState = this.outputItemBuilders.get(data.item_id);

    if (!outputItemState) {
      throw new Error(`Output item not found: ${data.item_id}`);
    }

    const delta = data.delta && typeof data.delta === 'object'
      ? data.delta
      : { type: 'reasoning_text', text: String(data.delta ?? '') };
    const rawIndex = typeof data.content_index === 'number' ? data.content_index : outputItemState.currentReasoningIndex;
    const contentIndex = Number.isFinite(rawIndex) ? rawIndex : outputItemState.currentReasoningIndex;
    outputItemState.currentReasoningIndex = contentIndex;

    if (typeof contentIndex === 'number' && Number.isFinite(contentIndex)) {
      const existing = outputItemState.accumulatedContent[contentIndex];
      if (delta.type === 'reasoning_text') {
        const nextText = typeof delta.text === 'string' ? delta.text : '';
        if (existing && typeof existing === 'object' && (existing as any).type === 'reasoning_text') {
          const prevText = typeof (existing as any).text === 'string' ? (existing as any).text : '';
          if (nextText.startsWith(prevText)) {
            outputItemState.accumulatedContent[contentIndex] = { ...existing, text: nextText };
          } else if (prevText.startsWith(nextText)) {
            outputItemState.accumulatedContent[contentIndex] = existing;
          } else {
            outputItemState.accumulatedContent[contentIndex] = { ...existing, text: `${prevText}${nextText}` };
          }
        } else {
          outputItemState.accumulatedContent[contentIndex] = { type: 'reasoning_text', text: nextText };
        }
      } else if (delta.type === 'reasoning_signature') {
        outputItemState.accumulatedContent[contentIndex] = {
          type: 'reasoning_signature',
          signature: delta.signature
        };
      } else if (delta.type === 'reasoning_image') {
        outputItemState.accumulatedContent[contentIndex] = {
          type: 'reasoning_image',
          image_url: delta.image_url
        };
      } else {
        outputItemState.accumulatedContent[contentIndex] = delta;
      }
    } else {
      outputItemState.accumulatedContent.push(delta);
    }
    outputItemState.lastEventTime = event.timestamp;
  }

  private handleReasoningSummaryDelta(event: ResponsesSseEvent): void {
    const data = event.data as any;
    const outputItemState = this.outputItemBuilders.get(data.item_id);

    if (!outputItemState) {
      throw new Error(`Output item not found: ${data.item_id}`);
    }

    const index = typeof data.summary_index === 'number'
      ? data.summary_index
      : outputItemState.currentSummaryIndex;
    const delta = typeof data.delta === 'string' ? data.delta : '';
    if (!delta) {
      return;
    }
    const previous = outputItemState.summaryByIndex.get(index) ?? '';
    outputItemState.summaryByIndex.set(index, `${previous}${delta}`);
    outputItemState.currentSummaryIndex = index;
    outputItemState.lastEventTime = event.timestamp;
  }

  private handleReasoningSummaryDone(event: ResponsesSseEvent): void {
    const data = event.data as any;
    const outputItemState = this.outputItemBuilders.get(data.item_id);

    if (!outputItemState) {
      throw new Error(`Output item not found: ${data.item_id}`);
    }

    const index = typeof data.summary_index === 'number'
      ? data.summary_index
      : outputItemState.currentSummaryIndex;
    const text = typeof data.text === 'string' ? data.text : '';
    if (!text) {
      return;
    }
    outputItemState.summaryByIndex.set(index, text);
    outputItemState.currentSummaryIndex = index;
    outputItemState.lastEventTime = event.timestamp;
  }

  private handleReasoningSummaryPartAdded(event: ResponsesSseEvent): void {
    const data = event.data as any;
    const outputItemState = this.outputItemBuilders.get(data.item_id);

    if (!outputItemState) {
      throw new Error(`Output item not found: ${data.item_id}`);
    }

    let index: number;
    if (typeof data.summary_index === 'number') {
      index = data.summary_index;
    } else if (outputItemState.summaryByIndex.size) {
      let maxIndex = -1;
      for (const key of outputItemState.summaryByIndex.keys()) {
        if (key > maxIndex) maxIndex = key;
      }
      index = maxIndex + 1;
    } else {
      index = 0;
    }
    if (!outputItemState.summaryByIndex.has(index)) {
      outputItemState.summaryByIndex.set(index, '');
    }
    outputItemState.currentSummaryIndex = index;
    outputItemState.lastEventTime = event.timestamp;
  }

  private handleReasoningSummaryPartDone(event: ResponsesSseEvent): void {
    const data = event.data as any;
    const outputItemState = this.outputItemBuilders.get(data.item_id);

    if (!outputItemState) {
      throw new Error(`Output item not found: ${data.item_id}`);
    }

    const index = typeof data.summary_index === 'number'
      ? data.summary_index
      : outputItemState.currentSummaryIndex;
    const part = data.part && typeof data.part === 'object' ? data.part : undefined;
    const text = part && typeof part.text === 'string' ? part.text : '';
    if (!text) {
      return;
    }
    outputItemState.summaryByIndex.set(index, text);
    outputItemState.currentSummaryIndex = index;
    outputItemState.lastEventTime = event.timestamp;
  }
  private mapReasoningDelta(event: ResponsesSseEvent): ResponsesSseEvent {
    const data = event.data as any;
    return {
      ...event,
      type: 'reasoning.delta',
      data: {
        item_id: data.item_id,
        content_index: data.content_index,
        delta: {
          type: event.type === 'response.reasoning_signature.delta'
            ? 'reasoning_signature'
            : event.type === 'response.reasoning_image.delta'
              ? 'reasoning_image'
              : 'reasoning_text',
          text: data.delta,
          signature: data.signature,
          image_url: data.image_url
        }
      }
    };
  }

  private mapReasoningDone(event: ResponsesSseEvent): ResponsesSseEvent {
    return {
      ...event,
      type: 'reasoning.done'
    };
  }

  /**
   * 处理reasoning.done事件
   */
  private handleReasoningDone(event: ResponsesSseEvent): void {
    const data = event.data as any;
    const outputItemState = this.outputItemBuilders.get(data.item_id);

    if (!outputItemState) {
      throw new Error(`Output item not found: ${data.item_id}`);
    }

    const text = typeof data.text === 'string' ? data.text : '';
    if (text && outputItemState.accumulatedContent.length === 0) {
      outputItemState.accumulatedContent.push({ type: 'reasoning_text', text });
    }

    outputItemState.status = 'completed';
    outputItemState.lastEventTime = event.timestamp;
  }

  /**
   * 处理output_item.done事件
   */
  private handleOutputItemDone(event: ResponsesSseEvent): void {
    const data = event.data as any;
    const outputItemState = this.outputItemBuilders.get(data.item_id);

    if (!outputItemState) {
      throw new Error(`Output item not found: ${data.item_id}`);
    }

    // 若为 custom_tool_call 变体（已在 start 阶段重命名为 function_call），尝试提取 name/arguments
    try {
      const item = (data as any).item || {};
      if (outputItemState.type === 'reasoning' && item && typeof item === 'object') {
        if (!outputItemState.encryptedContent && typeof (item as any).encrypted_content === 'string') {
          outputItemState.encryptedContent = (item as any).encrypted_content as string;
        }
        const summary = Array.isArray(item.summary) ? item.summary : [];
        if (summary.length && outputItemState.summaryByIndex.size === 0) {
          summary.forEach((entry: any, index: number) => {
            if (typeof entry === 'string') {
              outputItemState.summaryByIndex.set(index, entry);
              return;
            }
            if (entry && typeof entry === 'object' && typeof entry.text === 'string') {
              outputItemState.summaryByIndex.set(index, entry.text);
            }
          });
        }
      }
      if (outputItemState.type === 'function_call') {
        if (!outputItemState.name && typeof item.name === 'string') outputItemState.name = item.name;
        if (!outputItemState.callId && typeof item.call_id === 'string') (outputItemState as any).callId = item.call_id;
        if (!outputItemState.arguments) {
          const input = (item as any).input;
          if (typeof input === 'string') {
            try { outputItemState.arguments = JSON.stringify({ input }); }
            catch { outputItemState.arguments = JSON.stringify({ input: String(input) }); }
          } else if (input && typeof input === 'object') {
            try { outputItemState.arguments = JSON.stringify(input); }
            catch { outputItemState.arguments = '{}'; }
          }
        }
      }
    } catch { /* ignore */ }

    outputItemState.status = 'completed';
    outputItemState.lastEventTime = event.timestamp;
  }

  /**
   * 处理required_action事件
   */
  private handleRequiredAction(event: ResponsesSseEvent): void {
    const payload = (event.data as any) ?? {};
    const responsePayload = payload.response ?? payload;
    const requiredAction =
      responsePayload.required_action ??
      payload.required_action ??
      undefined;
    const usage =
      responsePayload.usage ??
      payload.usage ??
      this.response.usage;

    const nextResponse: ResponsesResponse = {
      ...(this.response as ResponsesResponse),
      object: 'response',
      id: responsePayload.id ?? (this.response as ResponsesResponse).id,
      status: responsePayload.status ?? 'requires_action',
      output: Array.isArray(responsePayload.output) && responsePayload.output.length
        ? responsePayload.output
        : this.buildOutputItems(),
      required_action: requiredAction ?? (this.response as ResponsesResponse).required_action,
      usage
    };

    if (responsePayload.metadata) {
      (nextResponse as any).metadata = responsePayload.metadata;
    }

    this.response = nextResponse;
    this.state = 'completed';
  }

  /**
   * 处理response.done事件
   */
  private handleResponseDone(event: ResponsesSseEvent): void {
    const data = (event.data as any)?.response ?? event.data;
    const usage = data?.usage ?? (event.data as any)?.usage;

    this.response = {
      ...this.response,
      id: data?.id ?? this.response.id,
      status: data?.status ?? 'completed',
      output: this.buildOutputItems(),
      usage: usage ?? this.response.usage
    };

    this.state = 'completed';
  }

  /**
   * 处理错误事件
   */
  private handleError(event: ResponsesSseEvent): void {
    const payload = event.data as { error?: { message?: string } } | undefined;
    const msg = typeof payload?.error?.message === 'string' ? payload.error.message : undefined;
    // 容错：若无有效错误消息或当前响应已标记 completed，则将错误降级为非致命告警
    const status: string | undefined = (this.response as any)?.status;
    if (!msg || status === 'completed' || this.config.enableEventRecovery) {
      // keep building; do not flip to error state
      return;
    }
    this.error = new Error(msg || 'Unknown error');
    this.state = 'error';
  }

  private handleResponseCompleted(event: ResponsesSseEvent): void {
    const payload = (event.data as any)?.response ?? event.data;
    const usage = (payload && (payload as any).usage)
      ? (payload as any).usage
      : (event.data as any)?.usage;
    if (usage) {
      this.response.usage = usage as ResponsesUsage;
    }
    // 标准化完成态：部分上游的 response.completed 不包含 status 字段
    // 若未提供明确的完成状态，统一标记为 'completed'，而不是沿用之前的 in_progress。
    this.response.status = (payload && (payload as any).status != null)
      ? (payload as any).status
      : 'completed';
    // 将已聚合的输出写回并标记完成（若为空数组也重建）
    try {
      const cur = (this.response as any).output;
      if (!Array.isArray(cur) || cur.length === 0) {
        (this.response as any).output = this.buildOutputItems();
      }
    } catch {
      (this.response as any).output = this.buildOutputItems();
    }
    this.state = 'completed';
  }

  /**
   * 构建输出项列表
   */
  private buildOutputItems(): ResponsesOutputItem[] {
    const outputItems: ResponsesOutputItem[] = [];

    for (const [itemId, state] of this.outputItemBuilders) {
      let outputItem: ResponsesOutputItem | undefined;

      switch (state.type) {
        case 'message':
          {
            const { message, reasoning } = this.buildMessageItem(state);
            if (reasoning) {
              outputItems.push(reasoning);
            }
            outputItem = message;
            break;
          }
        case 'function_call':
          // Terminated SSE salvage may end before `function_call.done` / `output_item.done`.
          // In that case the builder state remains `in_progress` and arguments are usually partial/empty.
          // Do not promote such incomplete tool calls into a completed output item.
          if (state.status !== 'completed') {
            continue;
          }
          outputItem = this.buildFunctionCallItem(state);
          break;
        case 'reasoning':
          outputItem = this.buildReasoningItem(state);
          break;
        default:
          throw new Error(`Unknown output item type: ${state.type}`);
      }

      if (outputItem) {
        outputItems.push(outputItem);
      }
    }

    const hasMessage = outputItems.some(item => (item as any).type === 'message');
    const hasReasoning = outputItems.some(item => (item as any).type === 'reasoning');
    if (!hasMessage && hasReasoning) {
      outputItems.push({
        id: `message_placeholder_${outputItems.length + 1}`,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: '' }]
      });
    }

    return outputItems;
  }

  /**
   * 构建消息项并根据需要拆分reasoning
   */
  private buildMessageItem(state: OutputItemState): { message: ResponsesMessageItem; reasoning?: ResponsesReasoningItem } {
    return normalizeResponsesMessageItem(
      {
        id: state.id,
        type: 'message',
        status: 'completed',
        role: (state.role as 'assistant') || 'assistant',
        content: state.contentParts
      },
      {
        requestId: state.id || 'message',
        outputIndex: 0,
        suppressReasoningFromContent: this.hasExplicitReasoning
      }
    );
  }

  /**
   * 构建函数调用项
   */
  private buildFunctionCallItem(state: OutputItemState): ResponsesFunctionCallItem {
    return {
      id: state.id,
      type: 'function_call',
      status: 'completed',
      call_id: state.callId || '',
      name: state.name || '',
      arguments: state.arguments || ''
    };
  }

  /**
   * 构建推理项
   */
  private buildReasoningItem(state: OutputItemState): ResponsesReasoningItem {
    const summaryEntries = state.summaryByIndex.size > 0
      ? Array.from(state.summaryByIndex.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([, text]) => text)
          .filter(item => typeof item === 'string')
      : (Array.isArray(state.accumulatedContent)
          ? state.accumulatedContent.filter(item => typeof item === 'string')
          : []);
    const summaryParts = summaryEntries
      .map((text) => typeof text === 'string' && text.length ? ({ type: 'summary_text', text }) : null)
      .filter((entry): entry is { type: 'summary_text'; text: string } => Boolean(entry));
    const item: ResponsesReasoningItem = {
      id: state.id,
      type: 'reasoning',
      summary: summaryParts,
      content: state.accumulatedContent.filter(item => typeof item === 'object')
    };
    if (typeof state.encryptedContent === 'string' && state.encryptedContent.length) {
      (item as any).encrypted_content = state.encryptedContent;
    }
    return item;
  }

  /**
   * 获取构建结果
   */
  getResult(): { success: boolean; response?: ResponsesResponse; error?: Error } {
    if (this.state === 'error') {
      return { success: false, error: this.error };
    }

    if (this.state === 'completed') {
      return { success: true, response: this.response as ResponsesResponse };
    }
    // 容错：部分上游以 response.completed 作为终结事件，不再发送 response.done。
    // 若状态仍为 building 但已收到 response.completed 且 response.status=completed，视为成功聚合。
    try {
      const status: string | undefined = (this.response as any)?.status;
      if (status === 'completed') {
        // 确保输出结构完整
        try {
          const cur = (this.response as any).output;
          if (!Array.isArray(cur) || cur.length === 0) {
            (this.response as any).output = this.buildOutputItems();
          }
        } catch {
          (this.response as any).output = this.buildOutputItems();
        }
        return { success: true, response: this.response as ResponsesResponse };
      }
      // 进一步容错：有些上游不发送 response.completed/response.done，仅发送 output_item.done 后直接结束流。
      // 若至少存在一个已完成的输出项，则按 completed 视为成功。
      let anyCompleted = false;
      for (const [, st] of this.outputItemBuilders) {
        if (st.status === 'completed') { anyCompleted = true; break; }
      }
      if (anyCompleted) {
        (this.response as any).status = 'completed';
        try {
          const cur = (this.response as any).output;
          if (!Array.isArray(cur) || cur.length === 0) {
            (this.response as any).output = this.buildOutputItems();
          }
        } catch {
          (this.response as any).output = this.buildOutputItems();
        }
        return { success: true, response: this.response as ResponsesResponse };
      }
      // Further salvage: some upstreams end the stream without any terminal events
      // (no output_item.done/response.completed/response.done) but still materialize
      // output_item.added + content deltas. Use current aggregated items as completed.
      if (this.outputItemBuilders.size > 0) {
        (this.response as any).status = 'completed';
        try {
          const cur = (this.response as any).output;
          if (!Array.isArray(cur) || cur.length === 0) {
            (this.response as any).output = this.buildOutputItems();
          }
        } catch {
          (this.response as any).output = this.buildOutputItems();
        }
        return { success: true, response: this.response as ResponsesResponse };
      }
    } catch { /* ignore */ }

    return { success: false, error: new Error('Building not completed') };
  }

  /**
   * 获取当前状态
   */
  getState(): ResponseBuilderState {
    return this.state;
  }

  /**
   * 重置构建器
   */
  reset(): void {
    this.state = 'initial';
    this.response = {};
    this.outputItemBuilders.clear();
    this.lastSequenceNumber = -1;
    this.error = undefined;
  }

  /**
   * 获取输出项构建器
   */
  getOutputItemBuilders(): Map<string, OutputItemState> {
    return new Map(this.outputItemBuilders);
  }

  /**
   * 获取最后序列号
   */
  getLastSequenceNumber(): number {
    return this.lastSequenceNumber;
  }
}

/**
 * 创建响应构建器工厂
 */
export function createResponseBuilder(config?: Partial<ResponseBuilderConfig>): ResponsesResponseBuilder {
  return new ResponsesResponseBuilder(config);
}
