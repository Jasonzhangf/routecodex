/**
 * Responses协议事件编排器
 * 负责将Responses响应数据转换为有序的SSE事件流
 */

// feature_id: sse.responses_encode_projection
import type {
  ResponsesResponse,
  ResponsesOutputItem,
  ResponsesMessageItem,
  ResponsesFunctionCallItem,
  ResponsesReasoningItem,
  ResponsesSseEvent
} from '../../types/index.js';
import {
  buildResponseStartEvents,
  buildResponseDoneEvent,
  buildOutputItemStartEvent,
  buildOutputItemDoneEvent,
  buildContentPartStartEvent,
  buildContentPartDeltas,
  buildContentPartDoneEvent,
  buildOutputTextDoneEvent,
  buildFunctionCallArgsDeltas,
  buildFunctionCallDoneEvent,
  buildReasoningSummaryEvents,
  buildReasoningDeltas,
  buildResponseCompletedEvent,
  DEFAULT_RESPONSES_EVENT_GENERATOR_CONFIG,
  createDefaultResponsesContext
} from '../event-generators/responses.js';
import type { ResponsesEventGeneratorContext, ResponsesEventGeneratorConfig } from '../event-generators/responses.js';
import { normalizeResponsesOutputItems } from '../../shared/responses-output-normalizer.js';
import { canonicalizeResponsesSseEventPayloadWithNative } from '../../../native/router-hotpath/native-responses-sse-event-payload.js';

// 默认配置
export const DEFAULT_RESPONSES_SEQUENCER_CONFIG: ResponsesEventGeneratorConfig = {
  ...DEFAULT_RESPONSES_EVENT_GENERATOR_CONFIG
};

/**
 * 验证响应格式
 */
function validateResponse(response: ResponsesResponse, config: ResponsesEventGeneratorConfig): void {
  if (!response.id || !response.model) {
    throw new Error('Invalid response: missing required fields');
  }

  if (typeof response.status !== 'string' || !response.status.trim()) {
    throw new Error('Invalid Responses response: missing status');
  }

  if (!response.output || !Array.isArray(response.output)) {
    throw new Error('Invalid response: missing or invalid output array');
  }
}

/**
 * 序列化消息输出项
 */
async function* sequenceMessageItem(
  item: ResponsesMessageItem,
  context: ResponsesEventGeneratorContext,
  config: ResponsesEventGeneratorConfig
): AsyncGenerator<ResponsesSseEvent> {
  // 1. 发送output_item.start事件
  yield buildOutputItemStartEvent(item, context, config);

  // 2. 发送content_part事件序列
  for (let contentIndex = 0; contentIndex < item.content.length; contentIndex++) {
    const content = item.content[contentIndex];
    context.contentIndexCounter.set(item.id, contentIndex);

    // 2a. 发送content_part.start事件
    yield buildContentPartStartEvent(item.id, contentIndex, content, context, config);

    // 2b. 发送content_part.delta事件流（仅对文本内容）
    const isTextContent = content.type === 'input_text' || content.type === 'output_text';
    if (isTextContent) {
      yield* buildContentPartDeltas(item.id, contentIndex, content.text, context, config);

      if (content.type === 'output_text') {
        yield buildOutputTextDoneEvent(item.id, contentIndex, content.text, context, config);
      }
    }

    // 2c. 发送content_part.done事件
    yield buildContentPartDoneEvent(item.id, contentIndex, content, context, config);
  }

  // 3. 发送output_item.done事件
  yield buildOutputItemDoneEvent(item, context, config);
}

/**
 * 序列化函数调用输出项
 */
async function* sequenceFunctionCallItem(
  item: ResponsesFunctionCallItem,
  context: ResponsesEventGeneratorContext,
  config: ResponsesEventGeneratorConfig
): AsyncGenerator<ResponsesSseEvent> {
  // 1. 发送output_item.start事件
  yield buildOutputItemStartEvent(item, context, config);

  // 2. 发送function_call.delta事件流（arguments）
  yield* buildFunctionCallArgsDeltas(item, context, config);

  // 3. 发送function_call.done事件
  yield buildFunctionCallDoneEvent(item, context, config);

  // 4. 发送output_item.done事件
  yield buildOutputItemDoneEvent(item, context, config);
}

/**
 * 序列化函数调用输出项
 */
async function* sequenceFunctionCallOutputItem(
  item: Extract<ResponsesOutputItem, { type: 'function_call_output' }>,
  context: ResponsesEventGeneratorContext,
  config: ResponsesEventGeneratorConfig
): AsyncGenerator<ResponsesSseEvent> {
  yield buildOutputItemStartEvent(item as ResponsesOutputItem, context, config);
  yield buildOutputItemDoneEvent(item as ResponsesOutputItem, context, config);
}

/**
 * 序列化推理输出项
 */
async function* sequenceReasoningItem(
  item: ResponsesReasoningItem,
  context: ResponsesEventGeneratorContext,
  config: ResponsesEventGeneratorConfig
): AsyncGenerator<ResponsesSseEvent> {
  // 1. 发送output_item.start事件
  yield buildOutputItemStartEvent(item, context, config);

  // 2. 发送reasoning_summary事件流
  yield* buildReasoningSummaryEvents(item, context, config);

  // 3. 发送reasoning.delta事件流
  yield* buildReasoningDeltas(item, context, config);

  // 4. 发送output_item.done事件
  yield buildOutputItemDoneEvent(item, context, config);
}

/**
 * 序列化单个输出项
 */
async function* sequenceOutputItem(
  item: ResponsesOutputItem,
  context: ResponsesEventGeneratorContext,
  config: ResponsesEventGeneratorConfig
): AsyncGenerator<ResponsesSseEvent> {
  switch (item.type) {
    case 'message':
      yield* sequenceMessageItem(item as ResponsesMessageItem, context, config);
      break;

    case 'function_call':
      yield* sequenceFunctionCallItem(item as ResponsesFunctionCallItem, context, config);
      break;

    case 'function_call_output':
      yield* sequenceFunctionCallOutputItem(item as Extract<ResponsesOutputItem, { type: 'function_call_output' }>, context, config);
      break;

    case 'reasoning':
      yield* sequenceReasoningItem(item as ResponsesReasoningItem, context, config);
      break;

    default:
      throw new Error(`Unknown output item type: ${(item as any).type}`);
  }
}

/**
 * 主编排器：将Responses响应转换为有序的SSE事件流
 */
async function* sequenceResponseCore(
  response: ResponsesResponse,
  context: ResponsesEventGeneratorContext,
  config: ResponsesEventGeneratorConfig = DEFAULT_RESPONSES_SEQUENCER_CONFIG
): AsyncGenerator<ResponsesSseEvent> {
  // 1. 验证响应格式
  validateResponse(response, config);

  // 2. 发送response.start事件
  yield* buildResponseStartEvents(response, context, config);

  const normalizedOutput = normalizeResponsesOutputItems(response.output);

  // 3. 序列化所有输出项
  for (let outputIndex = 0; outputIndex < normalizedOutput.length; outputIndex++) {
    const item = normalizedOutput[outputIndex];
    context.outputIndexCounter = outputIndex;

    yield* sequenceOutputItem(item, context, config);
  }

  // 4. 发送终止事件；工具调用已通过标准 output_item/function_call_arguments 事件表达。
  yield buildResponseCompletedEvent(response, context, config);
  yield buildResponseDoneEvent(response, context, config);
}

export async function* sequenceResponse(
  response: ResponsesResponse,
  context: ResponsesEventGeneratorContext,
  config: ResponsesEventGeneratorConfig = DEFAULT_RESPONSES_SEQUENCER_CONFIG
): AsyncGenerator<ResponsesSseEvent> {
  for await (const event of sequenceResponseCore(response, context, config)) {
    yield canonicalizeResponsesSseEventPayloadWithNative(event) as unknown as ResponsesSseEvent;
  }
}
