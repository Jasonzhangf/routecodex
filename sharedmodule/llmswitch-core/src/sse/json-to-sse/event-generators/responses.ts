/**
 * Responses协议事件生成器
 * 提供纯函数，将Responses响应数据转换为SSE事件对象，不处理流写入
 */

import type {
  ResponsesSseEvent,
  ResponsesResponse,
  ResponsesOutputItem,
  ResponsesFunctionCallItem,
  ResponsesReasoningItem,
  ResponsesContent
} from '../../types/index.js';
import { TimeUtils, StringUtils } from '../../shared/utils.js';
import {
  buildResponsesSseFunctionCallArgumentsDeltaPayloadWithNative,
  buildResponsesSseFunctionCallArgumentsDonePayloadWithNative,
  buildResponsesSseErrorPayloadWithNative,
  buildResponsesSseContentPartDescriptorWithNative,
  buildResponsesSseOutputTextDeltaPayloadWithNative,
  buildResponsesSseOutputTextDonePayloadWithNative,
  buildResponsesSseOutputItemDescriptorWithNative,
  buildResponsesSseReasoningDeltaPayloadWithNative,
  buildResponsesSseReasoningSummaryPayloadWithNative,
  normalizeResponsesSseReasoningSummaryWithNative,
  normalizeResponsesSseResponsePayloadWithNative
} from '../../../native/router-hotpath/native-responses-sse-event-payload.js';

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
  return StringUtils.chunkString(text, size, cloneRegex(TEXT_CHUNK_BOUNDARY));
}

function buildResponsePayload(
  response: ResponsesResponse,
  status: string
): Record<string, unknown> {
  return normalizeResponsesSseResponsePayloadWithNative(response, status);
}

function normalizeReasoningSummaryFieldWithNative(
  summary: ResponsesReasoningItem['summary'] | undefined
): Array<{ type: 'summary_text'; text: string }> | undefined {
  return normalizeResponsesSseReasoningSummaryWithNative(summary);
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
  const basePayload = buildResponsePayload(response, 'in_progress');
  if (Object.prototype.hasOwnProperty.call(basePayload, 'output')) {
    basePayload.output = [];
  }
  // 第一个事件：response.created
  const createdEvent = createBaseEvent(context, config);
  yield {
    type: 'response.created',
    timestamp: createdEvent.timestamp,
    protocol: createdEvent.protocol,
    direction: createdEvent.direction,
    data: {
      response: basePayload
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
      response: basePayload
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
  const item = buildResponsesSseOutputItemDescriptorWithNative(outputItem, 'added');

  return {
    type: 'response.output_item.added',
    timestamp: baseEvent.timestamp,
    protocol: baseEvent.protocol,
    direction: baseEvent.direction,
    data: {
      output_index: context.outputIndexCounter,
      item
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
  const part = buildResponsesSseContentPartDescriptorWithNative(content, 'added');

  return {
    type: 'response.content_part.added',
    timestamp: baseEvent.timestamp,
    protocol: baseEvent.protocol,
    direction: baseEvent.direction,
    data: {
      output_index: context.outputIndexCounter,
      item_id: outputItemId,
      content_index: contentIndex,
      part
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
    const delta = buildResponsesSseOutputTextDeltaPayloadWithNative(
      context.outputIndexCounter,
      outputItemId,
      contentIndex,
      chunk
    );
    yield {
      type: 'response.output_text.delta',
      timestamp: baseEvent.timestamp,
      protocol: baseEvent.protocol,
      direction: baseEvent.direction,
      data: {
        ...delta
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
  const part = content
    ? buildResponsesSseContentPartDescriptorWithNative(content, 'done')
    : undefined;

  return {
    type: 'response.content_part.done',
    timestamp: baseEvent.timestamp,
    protocol: baseEvent.protocol,
    direction: baseEvent.direction,
    data: {
      output_index: context.outputIndexCounter,
      item_id: outputItemId,
      content_index: contentIndex,
      ...(part ? { part } : {})
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
  const textDone = buildResponsesSseOutputTextDonePayloadWithNative(
    context.outputIndexCounter,
    outputItemId,
    contentIndex,
    fullText
  );

  return {
    type: 'response.output_text.done',
    timestamp: baseEvent.timestamp,
    protocol: baseEvent.protocol,
    direction: baseEvent.direction,
    data: {
      ...textDone
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
    const delta = buildResponsesSseFunctionCallArgumentsDeltaPayloadWithNative(
      context.outputIndexCounter,
      functionCall.id,
      functionCall.call_id,
      chunk
    );
    yield {
      type: 'response.function_call_arguments.delta',
      timestamp: baseEvent.timestamp,
      protocol: baseEvent.protocol,
      direction: baseEvent.direction,
      data: {
        ...delta
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
  const done = buildResponsesSseFunctionCallArgumentsDonePayloadWithNative(
    context.outputIndexCounter,
    functionCall.id,
    functionCall.call_id,
    functionCall.name,
    functionCall.arguments
  );

  return {
    type: 'response.function_call_arguments.done',
    timestamp: baseEvent.timestamp,
    protocol: baseEvent.protocol,
    direction: baseEvent.direction,
    data: {
      ...done
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
      summary: normalizeReasoningSummaryFieldWithNative(reasoning.summary)
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
  let contentIndex = 0;
  for (const content of contents) {
    if (content.type === 'reasoning_text') {
      if (!content.text) continue;
      const baseEvent = createBaseEvent(context, config);
      const payload = buildResponsesSseReasoningDeltaPayloadWithNative(
        'text',
        context.outputIndexCounter,
        reasoning.id,
        contentIndex,
        content.text
      );

      yield {
        type: 'response.reasoning_text.delta',
        timestamp: baseEvent.timestamp,
        protocol: baseEvent.protocol,
        direction: baseEvent.direction,
        data: {
          ...payload
        },
        sequenceNumber: baseEvent.sequenceNumber
      };
    } else if (content.type === 'reasoning_signature') {
      const baseEvent = createBaseEvent(context, config);
      const payload = buildResponsesSseReasoningDeltaPayloadWithNative(
        'signature',
        context.outputIndexCounter,
        reasoning.id,
        contentIndex,
        content.signature
      );

      yield {
        type: 'response.reasoning_signature.delta',
        timestamp: baseEvent.timestamp,
        protocol: baseEvent.protocol,
        direction: baseEvent.direction,
        data: {
          ...payload
        },
        sequenceNumber: baseEvent.sequenceNumber
      };
    } else if (content.type === 'reasoning_image') {
      const baseEvent = createBaseEvent(context, config);
      const payload = buildResponsesSseReasoningDeltaPayloadWithNative(
        'image',
        context.outputIndexCounter,
        reasoning.id,
        contentIndex,
        content.image_url
      );

      yield {
        type: 'response.reasoning_image.delta',
        timestamp: baseEvent.timestamp,
        protocol: baseEvent.protocol,
        direction: baseEvent.direction,
        data: {
          ...payload
        },
        sequenceNumber: baseEvent.sequenceNumber
      };
    }
    contentIndex += 1;
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
  const summaries = normalizeReasoningSummaryFieldWithNative(reasoning.summary) ?? [];
  for (let summaryIndex = 0; summaryIndex < summaries.length; summaryIndex++) {
    const text = summaries[summaryIndex]?.text;
    if (!text) continue;

    const partAddedBase = createBaseEvent(context, config);
    const partAdded = buildResponsesSseReasoningSummaryPayloadWithNative(
      'part_added',
      context.outputIndexCounter,
      reasoning.id,
      summaryIndex,
      text
    );
    yield {
      type: 'response.reasoning_summary_part.added',
      timestamp: partAddedBase.timestamp,
      protocol: partAddedBase.protocol,
      direction: partAddedBase.direction,
      data: {
        ...partAdded
      },
      sequenceNumber: partAddedBase.sequenceNumber
    };

    const chunks = chunkText(text, config);
    for (const chunk of chunks) {
      if (!chunk) continue;
      const deltaBase = createBaseEvent(context, config);
      const delta = buildResponsesSseReasoningSummaryPayloadWithNative(
        'text_delta',
        context.outputIndexCounter,
        reasoning.id,
        summaryIndex,
        chunk
      );
      yield {
        type: 'response.reasoning_summary_text.delta',
        timestamp: deltaBase.timestamp,
        protocol: deltaBase.protocol,
        direction: deltaBase.direction,
        data: {
          ...delta
        },
        sequenceNumber: deltaBase.sequenceNumber
      };
    }

    const textDoneBase = createBaseEvent(context, config);
    const textDone = buildResponsesSseReasoningSummaryPayloadWithNative(
      'text_done',
      context.outputIndexCounter,
      reasoning.id,
      summaryIndex,
      text
    );
    yield {
      type: 'response.reasoning_summary_text.done',
      timestamp: textDoneBase.timestamp,
      protocol: textDoneBase.protocol,
      direction: textDoneBase.direction,
      data: {
        ...textDone
      },
      sequenceNumber: textDoneBase.sequenceNumber
    };

    const partDoneBase = createBaseEvent(context, config);
    const partDone = buildResponsesSseReasoningSummaryPayloadWithNative(
      'part_done',
      context.outputIndexCounter,
      reasoning.id,
      summaryIndex,
      text
    );
    yield {
      type: 'response.reasoning_summary_part.done',
      timestamp: partDoneBase.timestamp,
      protocol: partDoneBase.protocol,
      direction: partDoneBase.direction,
      data: {
        ...partDone
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
  const item = buildResponsesSseOutputItemDescriptorWithNative(outputItem, 'done');

  return {
    type: 'response.output_item.done',
    timestamp: baseEvent.timestamp,
    protocol: baseEvent.protocol,
    direction: baseEvent.direction,
    data: {
      output_index: context.outputIndexCounter,
      item
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
      response: buildResponsePayload(response, response.status ?? 'requires_action'),
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
      response: buildResponsePayload(response, response.status ?? 'completed')
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
    data: {
      response: buildResponsePayload(response, response.status ?? 'completed')
    },
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
    type: 'response.error',
    timestamp: baseEvent.timestamp,
    protocol: baseEvent.protocol,
    direction: baseEvent.direction,
    data: buildResponsesSseErrorPayloadWithNative(error.message),
    sequenceNumber: baseEvent.sequenceNumber
  };
}
