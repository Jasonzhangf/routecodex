/**
 * Responses协议事件生成器
 * 提供纯函数，将Responses响应数据转换为SSE事件对象，不处理流写入
 */

import type {
  ResponsesSseEvent,
  ResponsesResponse,
  ResponsesOutputItem,
  ResponsesMessageItem,
  ResponsesFunctionCallItem,
  ResponsesReasoningItem,
  ResponsesContent,
  ResponsesTool,
  ResponsesToolCall,
  ResponsesFunctionCallOutputItem
} from '../../types/index.js';
import { IdUtils, TimeUtils, StringUtils } from '../../shared/utils.js';

const TEXT_CHUNK_BOUNDARY = /[\n\r\t，。、“”‘’！？,.\-:\u3000\s]/;

function cloneRegex(source: RegExp): RegExp {
  return new RegExp(source.source, source.flags);
}

function getChunkSize(config: ResponsesEventGeneratorConfig): number | null {
  const size =
    typeof config.chunkSize === 'number'
      ? config.chunkSize
      : DEFAULT_RESPONSES_EVENT_GENERATOR_CONFIG.chunkSize;
  if (size !== undefined && size <= 0) {
    return null;
  }
  return Math.max(1, size || 1);
}

function chunkText(text: string, config: ResponsesEventGeneratorConfig): string[] {
  const size = getChunkSize(config);
  if (size === null) {
    // chunking explicitly disabled
    return [text];
  }
  try {
    return StringUtils.chunkString(text, size, cloneRegex(TEXT_CHUNK_BOUNDARY));
  } catch {
    return [text];
  }
}

function normalizeReasoningSummaryEntries(summary: ResponsesReasoningItem['summary'] | undefined): string[] {
  if (!Array.isArray(summary)) return [];
  const entries: string[] = [];
  for (const entry of summary) {
    if (typeof entry === 'string') {
      if (entry.length) entries.push(entry);
      continue;
    }
    if (entry && typeof entry === 'object') {
      const text = typeof (entry as any).text === 'string' ? (entry as any).text : '';
      if (text.length) entries.push(text);
    }
  }
  return entries;
}

function createResponsePayload(
  response: ResponsesResponse,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const raw = response as Record<string, any>;
  const usage = normalizeUsage(response.usage);
  const payload: Record<string, unknown> = {
    id: response.id,
    object: response.object ?? 'response',
    created_at: response.created_at ?? Math.floor(Date.now() / 1000),
    status: response.status ?? 'in_progress',
    model: response.model,
    output: response.output ?? [],
    usage,
    temperature: response.temperature,
    top_p: response.top_p,
    max_output_tokens: response.max_output_tokens,
    metadata: response.metadata,
    user: response.user,
    store: response.store,
    truncation: response.truncation,
    include: response.include,
    parallel_tool_calls: response.parallel_tool_calls,
    previous_response_id: response.previous_response_id
  };

  payload.background = raw.background ?? false;
  payload.error = Object.prototype.hasOwnProperty.call(raw, 'error') ? raw.error : null;
  payload.incomplete_details = Object.prototype.hasOwnProperty.call(raw, 'incomplete_details') ? raw.incomplete_details : null;

  if (Object.prototype.hasOwnProperty.call(raw, 'instructions')) {
    payload.instructions = raw.instructions;
  }

  if (Object.prototype.hasOwnProperty.call(raw, 'include')) {
    payload.include = raw.include;
  }

  Object.entries(overrides).forEach(([key, value]) => {
    if (value === undefined) {
      delete payload[key];
    } else {
      payload[key] = value;
    }
  });

  Object.keys(payload).forEach(key => {
    if (payload[key] === undefined) {
      delete payload[key];
    }
  });

  return payload;
}

function normalizeUsage(usage: any): { input_tokens: number; output_tokens: number; total_tokens: number } {
  const fallback = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  if (!usage || typeof usage !== 'object') {
    return fallback;
  }

  const asAny = usage as Record<string, unknown>;
  const baseInputRaw = Number((asAny.input_tokens ?? asAny.prompt_tokens) as number);
  const baseInput = Number.isFinite(baseInputRaw) ? baseInputRaw : 0;
  let cachedRaw = Number(asAny.cache_read_input_tokens as number);
  if (!Number.isFinite(cachedRaw) && asAny.input_tokens_details && typeof asAny.input_tokens_details === 'object') {
    const details = asAny.input_tokens_details as Record<string, unknown>;
    cachedRaw = Number(details.cached_tokens as number);
  }
  const cached = Number.isFinite(cachedRaw) ? cachedRaw : 0;
  const input = baseInput + cached;
  const outputRaw = Number((asAny.output_tokens ?? asAny.completion_tokens) as number);
  const output = Number.isFinite(outputRaw) ? outputRaw : 0;
  const totalRaw = Number(asAny.total_tokens as number);
  const total = Number.isFinite(totalRaw) ? totalRaw : input + output;

  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total
  };
}

// 生成器配置
export interface ResponsesEventGeneratorConfig {
  chunkSize: number;
  chunkDelayMs: number;
  enableIdGeneration: boolean;
  enableTimestampGeneration: boolean;
  enableSequenceNumbers: boolean;
  enableDelay: boolean;
}

// 事件生成上下文
export interface ResponsesEventGeneratorContext {
  requestId: string;
  model: string;
  outputIndexCounter: number;
  contentIndexCounter: Map<string, number>;
  sequenceCounter: number;
}

// 默认配置
export const DEFAULT_RESPONSES_EVENT_GENERATOR_CONFIG: ResponsesEventGeneratorConfig = {
  // 默认关闭文本切片，让上游模型的分块行为原样透传
  chunkSize: 0,
  chunkDelayMs: 8,
  enableIdGeneration: true,
  enableTimestampGeneration: true,
  enableSequenceNumbers: true,
  enableDelay: false
};

/**
 * 创建默认上下文
 */
export function createDefaultResponsesContext(requestId: string, model: string): ResponsesEventGeneratorContext {
  return {
    requestId,
    model,
    outputIndexCounter: 0,
    contentIndexCounter: new Map(),
    sequenceCounter: 0
  };
}


/**
 * 生成下一个序列号
 */
function getNextSequenceNumber(context: ResponsesEventGeneratorContext, config: ResponsesEventGeneratorConfig): number {
  return config.enableSequenceNumbers ? context.sequenceCounter++ : 0;
}

/**
 * 创建基础事件数据
 */
function createBaseEvent(
  context: ResponsesEventGeneratorContext,
  config: ResponsesEventGeneratorConfig
): {
  requestId: string;
  timestamp: number;
  sequenceNumber: number;
  protocol: 'responses';
  direction: 'json_to_sse';
} {
  return {
    requestId: context.requestId,
    timestamp: config.enableTimestampGeneration ? TimeUtils.now() : 0,
    sequenceNumber: getNextSequenceNumber(context, config),
    protocol: 'responses' as const,
    direction: 'json_to_sse' as const
  };
}

/**
 * 构建response.created + response.in_progress事件
 * 映射：response.start → response.created + response.in_progress
 */
export function* buildResponseStartEvents(
  response: ResponsesResponse,
  context: ResponsesEventGeneratorContext,
  config: ResponsesEventGeneratorConfig = DEFAULT_RESPONSES_EVENT_GENERATOR_CONFIG
): Generator<ResponsesSseEvent> {
  // 第一个事件：response.created
  const createdEvent = createBaseEvent(context, config);
  yield {
    type: 'response.created',
    timestamp: createdEvent.timestamp,
    protocol: createdEvent.protocol,
    direction: createdEvent.direction,
    data: {
      response: createResponsePayload(response, { status: 'in_progress' })
    },
    sequenceNumber: createdEvent.sequenceNumber
  };

  // 第二个事件：response.in_progress
  const inProgressEvent = createBaseEvent(context, config);
  yield {
    type: 'response.in_progress',
    timestamp: inProgressEvent.timestamp,
    protocol: inProgressEvent.protocol,
    direction: inProgressEvent.direction,
    data: {
      response: createResponsePayload(response, { status: 'in_progress' })
    },
    sequenceNumber: inProgressEvent.sequenceNumber
  };
}

/**
 * 构建response.output_item.added事件
 * 映射：output_item.start → response.output_item.added
 */
export function buildOutputItemStartEvent(
  outputItem: ResponsesOutputItem,
  context: ResponsesEventGeneratorContext,
  config: ResponsesEventGeneratorConfig = DEFAULT_RESPONSES_EVENT_GENERATOR_CONFIG
): ResponsesSseEvent {
  const baseEvent = createBaseEvent(context, config);
  const itemDescriptor: Record<string, unknown> = {
    id: outputItem.id,
    type: outputItem.type,
    status: 'in_progress'
  };

  if (outputItem.type === 'message') {
    const message = outputItem as ResponsesMessageItem;
    if (message.role) {
      itemDescriptor.role = message.role;
    }
    itemDescriptor.content = [];
  }

  if (outputItem.type === 'function_call') {
    const functionCall = outputItem as ResponsesFunctionCallItem;
    if (functionCall.name) {
      itemDescriptor.name = functionCall.name;
    }
    if (functionCall.call_id) {
      itemDescriptor.call_id = functionCall.call_id;
    }
    itemDescriptor.arguments = '';
  }

  if (outputItem.type === 'function_call_output') {
    const functionCallOutput = outputItem as ResponsesFunctionCallOutputItem;
    if (functionCallOutput.call_id) {
      itemDescriptor.call_id = functionCallOutput.call_id;
    }
    if (functionCallOutput.tool_call_id) {
      itemDescriptor.tool_call_id = functionCallOutput.tool_call_id;
    }
    itemDescriptor.output = functionCallOutput.output;
  }

  if (outputItem.type === 'reasoning') {
    const reasoning = outputItem as ResponsesReasoningItem;
    if (reasoning.summary) {
      itemDescriptor.summary = reasoning.summary;
    }
    if (typeof reasoning.encrypted_content === 'string' && reasoning.encrypted_content.length) {
      itemDescriptor.encrypted_content = reasoning.encrypted_content;
    }
  }

  return {
    type: 'response.output_item.added',
    timestamp: baseEvent.timestamp,
    protocol: baseEvent.protocol,
    direction: baseEvent.direction,
    data: {
      output_index: context.outputIndexCounter,
      item: itemDescriptor
    },
    sequenceNumber: baseEvent.sequenceNumber
  };
}

/**
 * 构建response.content_part.added事件
 * 映射：content_part.start → response.content_part.added
 */
export function buildContentPartStartEvent(
  outputItemId: string,
  contentIndex: number,
  content: ResponsesContent,
  context: ResponsesEventGeneratorContext,
  config: ResponsesEventGeneratorConfig = DEFAULT_RESPONSES_EVENT_GENERATOR_CONFIG
): ResponsesSseEvent {
  const baseEvent = createBaseEvent(context, config);
  const partDescriptor: Record<string, unknown> = { type: content.type };
  if (content.type === 'input_text') {
    partDescriptor.text = content.text ?? '';
  } else if (content.type === 'output_text') {
    partDescriptor.text = '';
    partDescriptor.annotations = (content as any).annotations ?? [];
    partDescriptor.logprobs = (content as any).logprobs ?? [];
  } else if (content.type === 'input_image') {
    partDescriptor.image_url = content.image_url;
    if (content.detail) {
      partDescriptor.detail = content.detail;
    }
  } else if (content.type === 'file_search') {
    partDescriptor.file_search = content.file_search;
  } else if (content.type === 'computer_use') {
    partDescriptor.computer_use = content.computer_use;
  } else if (content.type === 'function_call') {
    partDescriptor.name = content.name;
    partDescriptor.arguments = content.arguments;
  } else if (content.type === 'function_result') {
    partDescriptor.result = content.result;
    partDescriptor.tool_call_id = content.tool_call_id;
  } else if (content.type === 'conversation') {
    partDescriptor.conversation = content.conversation;
  }

  return {
    type: 'response.content_part.added',
    timestamp: baseEvent.timestamp,
    protocol: baseEvent.protocol,
    direction: baseEvent.direction,
    data: {
      output_index: context.outputIndexCounter,
      item_id: outputItemId,
      content_index: contentIndex,
      part: partDescriptor
    },
    sequenceNumber: baseEvent.sequenceNumber
  };
}

/**
 * 构建response.output_text.delta事件流
 * 映射：content_part.delta (input_text/output_text/…) → response.output_text.delta
 * 对于 reasoning 使用 response.reasoning_text.delta
 */
export function* buildContentPartDeltas(
  outputItemId: string,
  contentIndex: number,
  text: string,
  context: ResponsesEventGeneratorContext,
  config: ResponsesEventGeneratorConfig = DEFAULT_RESPONSES_EVENT_GENERATOR_CONFIG
): Generator<ResponsesSseEvent> {
  if (!text) return;
  const chunks = chunkText(text, config);

  for (const chunk of chunks) {
    const baseEvent = createBaseEvent(context, config);
    yield {
      type: 'response.output_text.delta',
      timestamp: baseEvent.timestamp,
      protocol: baseEvent.protocol,
      direction: baseEvent.direction,
      data: {
        output_index: context.outputIndexCounter,
        item_id: outputItemId,
        content_index: contentIndex,
        delta: chunk,
        logprobs: []
      },
      sequenceNumber: baseEvent.sequenceNumber
    };
  }
}

/**
 * 构建content_part.done事件
 */
export function buildContentPartDoneEvent(
  outputItemId: string,
  contentIndex: number,
  content: ResponsesContent | undefined,
  context: ResponsesEventGeneratorContext,
  config: ResponsesEventGeneratorConfig = DEFAULT_RESPONSES_EVENT_GENERATOR_CONFIG
): ResponsesSseEvent {
  const baseEvent = createBaseEvent(context, config);
  const partDescriptor: Record<string, unknown> = {};

  if (content) {
    partDescriptor.type = content.type;
    if (content.type === 'input_text' || content.type === 'output_text') {
      partDescriptor.text = content.text ?? '';
      if (content.type === 'output_text') {
        partDescriptor.annotations = (content as any).annotations ?? [];
        partDescriptor.logprobs = (content as any).logprobs ?? [];
      }
    } else if (content.type === 'input_image') {
      partDescriptor.image_url = content.image_url;
      if (content.detail) {
        partDescriptor.detail = content.detail;
      }
    } else if (content.type === 'function_call') {
      partDescriptor.name = content.name;
      partDescriptor.arguments = content.arguments;
    } else if (content.type === 'function_result') {
      partDescriptor.result = content.result;
      partDescriptor.tool_call_id = content.tool_call_id;
    } else if (content.type === 'conversation') {
      partDescriptor.conversation = content.conversation;
    }
  }

  return {
    type: 'response.content_part.done',
    timestamp: baseEvent.timestamp,
    protocol: baseEvent.protocol,
    direction: baseEvent.direction,
    data: {
      output_index: context.outputIndexCounter,
      item_id: outputItemId,
      content_index: contentIndex,
      ...(Object.keys(partDescriptor).length ? { part: partDescriptor } : {})
    },
    sequenceNumber: baseEvent.sequenceNumber
  };
}

export function buildOutputTextDoneEvent(
  outputItemId: string,
  contentIndex: number,
  fullText: string,
  context: ResponsesEventGeneratorContext,
  config: ResponsesEventGeneratorConfig = DEFAULT_RESPONSES_EVENT_GENERATOR_CONFIG
): ResponsesSseEvent {
  const baseEvent = createBaseEvent(context, config);

  return {
    type: 'response.output_text.done',
    timestamp: baseEvent.timestamp,
    protocol: baseEvent.protocol,
    direction: baseEvent.direction,
    data: {
      output_index: context.outputIndexCounter,
      item_id: outputItemId,
      content_index: contentIndex,
      text: fullText,
      logprobs: []
    },
    sequenceNumber: baseEvent.sequenceNumber
  };
}

/**
 * 构建response.function_call_arguments.delta/done的start部分
 * 映射：function_call.start → 隐含在第一个 delta 中
 */
/**
 * 构建response.function_call_arguments.delta事件流
 * 映射：function_call.delta → response.function_call_arguments.delta
 */
export function* buildFunctionCallArgsDeltas(
  functionCall: ResponsesFunctionCallItem,
  context: ResponsesEventGeneratorContext,
  config: ResponsesEventGeneratorConfig = DEFAULT_RESPONSES_EVENT_GENERATOR_CONFIG
): Generator<ResponsesSseEvent> {
  if (!functionCall.arguments) return;
  const chunks = chunkText(functionCall.arguments, config);

  for (const chunk of chunks) {
    const baseEvent = createBaseEvent(context, config);
    yield {
      type: 'response.function_call_arguments.delta',
      timestamp: baseEvent.timestamp,
      protocol: baseEvent.protocol,
      direction: baseEvent.direction,
      data: {
        output_index: context.outputIndexCounter,
        item_id: functionCall.id,
        call_id: functionCall.call_id,
        delta: chunk
      },
      sequenceNumber: baseEvent.sequenceNumber
    };
  }
}

/**
 * 构建response.function_call_arguments.done事件
 * 映射：function_call.done → response.function_call_arguments.done
 */
export function buildFunctionCallDoneEvent(
  functionCall: ResponsesFunctionCallItem,
  context: ResponsesEventGeneratorContext,
  config: ResponsesEventGeneratorConfig = DEFAULT_RESPONSES_EVENT_GENERATOR_CONFIG
): ResponsesSseEvent {
  const baseEvent = createBaseEvent(context, config);

  return {
    type: 'response.function_call_arguments.done',
    timestamp: baseEvent.timestamp,
    protocol: baseEvent.protocol,
    direction: baseEvent.direction,
    data: {
      output_index: context.outputIndexCounter,
      item_id: functionCall.id,
      call_id: functionCall.call_id,
      name: functionCall.name,
      arguments: functionCall.arguments  // done 时包含完整 arguments
    },
    sequenceNumber: baseEvent.sequenceNumber
  };
}

/**
 * 构建reasoning.start事件
 */
export function buildReasoningStartEvent(
  reasoning: ResponsesReasoningItem,
  context: ResponsesEventGeneratorContext,
  config: ResponsesEventGeneratorConfig = DEFAULT_RESPONSES_EVENT_GENERATOR_CONFIG
): ResponsesSseEvent {
  const baseEvent = createBaseEvent(context, config);

  return {
    type: 'reasoning.start',
    timestamp: baseEvent.timestamp,
    protocol: baseEvent.protocol,
    direction: baseEvent.direction,
    data: {
      item_id: reasoning.id,
      summary: reasoning.summary
    },
    sequenceNumber: baseEvent.sequenceNumber
  };
}

/**
 * 构建response.reasoning_text.delta事件流
 * 映射：reasoning.delta → response.reasoning_text.delta
 */
export function* buildReasoningDeltas(
  reasoning: ResponsesReasoningItem,
  context: ResponsesEventGeneratorContext,
  config: ResponsesEventGeneratorConfig = DEFAULT_RESPONSES_EVENT_GENERATOR_CONFIG
): Generator<ResponsesSseEvent> {
  const contents = Array.isArray(reasoning.content) ? reasoning.content : [];
  for (const content of contents) {
    if (content.type === 'reasoning_text') {
      if (!content.text) continue;
      const baseEvent = createBaseEvent(context, config);

      yield {
        type: 'response.reasoning_text.delta',
        timestamp: baseEvent.timestamp,
        protocol: baseEvent.protocol,
        direction: baseEvent.direction,
        data: {
          output_index: context.outputIndexCounter,
          item_id: reasoning.id,
          delta: content.text
        },
        sequenceNumber: baseEvent.sequenceNumber
      };
    } else if (content.type === 'reasoning_signature') {
      const baseEvent = createBaseEvent(context, config);

      yield {
        type: 'response.reasoning_signature.delta',
        timestamp: baseEvent.timestamp,
        protocol: baseEvent.protocol,
        direction: baseEvent.direction,
        data: {
          output_index: context.outputIndexCounter,
          item_id: reasoning.id,
          signature: content.signature
        },
        sequenceNumber: baseEvent.sequenceNumber
      };
    } else if (content.type === 'reasoning_image') {
      const baseEvent = createBaseEvent(context, config);

      yield {
        type: 'response.reasoning_image.delta',
        timestamp: baseEvent.timestamp,
        protocol: baseEvent.protocol,
        direction: baseEvent.direction,
        data: {
          output_index: context.outputIndexCounter,
          item_id: reasoning.id,
          image_url: content.image_url
        },
        sequenceNumber: baseEvent.sequenceNumber
      };
    }
  }
}

/**
 * 构建response.reasoning_summary_*事件流
 */
export function* buildReasoningSummaryEvents(
  reasoning: ResponsesReasoningItem,
  context: ResponsesEventGeneratorContext,
  config: ResponsesEventGeneratorConfig = DEFAULT_RESPONSES_EVENT_GENERATOR_CONFIG
): Generator<ResponsesSseEvent> {
  const summaries = normalizeReasoningSummaryEntries(reasoning.summary);
  for (let summaryIndex = 0; summaryIndex < summaries.length; summaryIndex++) {
    const text = summaries[summaryIndex];
    if (!text) continue;

    const partAddedBase = createBaseEvent(context, config);
    yield {
      type: 'response.reasoning_summary_part.added',
      timestamp: partAddedBase.timestamp,
      protocol: partAddedBase.protocol,
      direction: partAddedBase.direction,
      data: {
        output_index: context.outputIndexCounter,
        item_id: reasoning.id,
        summary_index: summaryIndex,
        part: { type: 'summary_text', text: '' }
      },
      sequenceNumber: partAddedBase.sequenceNumber
    };

    const chunks = chunkText(text, config);
    for (const chunk of chunks) {
      if (!chunk) continue;
      const deltaBase = createBaseEvent(context, config);
      yield {
        type: 'response.reasoning_summary_text.delta',
        timestamp: deltaBase.timestamp,
        protocol: deltaBase.protocol,
        direction: deltaBase.direction,
        data: {
          output_index: context.outputIndexCounter,
          item_id: reasoning.id,
          summary_index: summaryIndex,
          delta: chunk
        },
        sequenceNumber: deltaBase.sequenceNumber
      };
    }

    const textDoneBase = createBaseEvent(context, config);
    yield {
      type: 'response.reasoning_summary_text.done',
      timestamp: textDoneBase.timestamp,
      protocol: textDoneBase.protocol,
      direction: textDoneBase.direction,
      data: {
        output_index: context.outputIndexCounter,
        item_id: reasoning.id,
        summary_index: summaryIndex,
        text
      },
      sequenceNumber: textDoneBase.sequenceNumber
    };

    const partDoneBase = createBaseEvent(context, config);
    yield {
      type: 'response.reasoning_summary_part.done',
      timestamp: partDoneBase.timestamp,
      protocol: partDoneBase.protocol,
      direction: partDoneBase.direction,
      data: {
        output_index: context.outputIndexCounter,
        item_id: reasoning.id,
        summary_index: summaryIndex,
        part: { type: 'summary_text', text }
      },
      sequenceNumber: partDoneBase.sequenceNumber
    };
  }
}

/**
 * 构建reasoning.done事件
 */
export function buildReasoningDoneEvent(
  reasoning: ResponsesReasoningItem,
  context: ResponsesEventGeneratorContext,
  config: ResponsesEventGeneratorConfig = DEFAULT_RESPONSES_EVENT_GENERATOR_CONFIG
): ResponsesSseEvent {
  const baseEvent = createBaseEvent(context, config);

  return {
    type: 'reasoning.done',
    timestamp: baseEvent.timestamp,
    protocol: baseEvent.protocol,
    direction: baseEvent.direction,
    data: {
      item_id: reasoning.id
    },
    sequenceNumber: baseEvent.sequenceNumber
  };
}

/**
 * 构建output_item.done事件
 */
export function buildOutputItemDoneEvent(
  outputItem: ResponsesOutputItem,
  context: ResponsesEventGeneratorContext,
  config: ResponsesEventGeneratorConfig = DEFAULT_RESPONSES_EVENT_GENERATOR_CONFIG
): ResponsesSseEvent {
  const baseEvent = createBaseEvent(context, config);
  // NOTE: Codex CLI expects `output_item.done` to contain a fully-formed output item
  // (e.g. message includes role/content). A minimal `{id,type,status}` breaks parsing.
  const itemDescriptor: Record<string, unknown> = {
    ...(outputItem as any),
    status: 'completed'
  };

  return {
    type: 'response.output_item.done',
    timestamp: baseEvent.timestamp,
    protocol: baseEvent.protocol,
    direction: baseEvent.direction,
    data: {
      output_index: context.outputIndexCounter,
      item: itemDescriptor
    },
    sequenceNumber: baseEvent.sequenceNumber
  };
}

/**
 * 构建required_action事件
 */
export function buildRequiredActionEvent(
  response: ResponsesResponse,
  requiredAction: any,
  context: ResponsesEventGeneratorContext,
  config: ResponsesEventGeneratorConfig = DEFAULT_RESPONSES_EVENT_GENERATOR_CONFIG
): ResponsesSseEvent {
  const baseEvent = createBaseEvent(context, config);

  return {
    type: 'response.required_action',
    timestamp: baseEvent.timestamp,
    protocol: baseEvent.protocol,
    direction: baseEvent.direction,
    data: {
      response: createResponsePayload(response, { status: response.status ?? 'requires_action' }),
      required_action: requiredAction
    },
    sequenceNumber: baseEvent.sequenceNumber
  };
}

/**
 * 构建response.completed事件
 * 新增：在 done 之前增加 response.completed
 */
export function buildResponseCompletedEvent(
  response: ResponsesResponse,
  context: ResponsesEventGeneratorContext,
  config: ResponsesEventGeneratorConfig = DEFAULT_RESPONSES_EVENT_GENERATOR_CONFIG
): ResponsesSseEvent {
  const baseEvent = createBaseEvent(context, config);

  return {
    type: 'response.completed',
    timestamp: baseEvent.timestamp,
    protocol: baseEvent.protocol,
    direction: baseEvent.direction,
    data: {
      response: createResponsePayload(response, { status: response.status ?? 'completed' })
    },
    sequenceNumber: baseEvent.sequenceNumber
  };
}

/**
 * 构建response.done事件
 */
export function buildResponseDoneEvent(
  response: ResponsesResponse,
  context: ResponsesEventGeneratorContext,
  config: ResponsesEventGeneratorConfig = DEFAULT_RESPONSES_EVENT_GENERATOR_CONFIG
): ResponsesSseEvent {
  const baseEvent = createBaseEvent(context, config);

  return {
    type: 'response.done',
    timestamp: baseEvent.timestamp,
    protocol: baseEvent.protocol,
    direction: baseEvent.direction,
    data: '[DONE]',
    sequenceNumber: baseEvent.sequenceNumber
  };
}

/**
 * 构建error事件
 */
export function buildErrorEvent(
  error: Error,
  context: ResponsesEventGeneratorContext,
  config: ResponsesEventGeneratorConfig = DEFAULT_RESPONSES_EVENT_GENERATOR_CONFIG
): ResponsesSseEvent {
  const baseEvent = createBaseEvent(context, config);

  return {
    type: 'error',
    timestamp: baseEvent.timestamp,
    protocol: baseEvent.protocol,
    direction: baseEvent.direction,
    data: {
      error: {
        message: error.message,
        type: 'internal_error',
        code: 'generation_error'
      }
    },
    sequenceNumber: baseEvent.sequenceNumber
  };
}
