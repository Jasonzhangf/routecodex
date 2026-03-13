/**
 * Responses协议事件编排器
 * 负责将Responses响应数据转换为有序的SSE事件流
 */

import type {
  ResponsesResponse,
  ResponsesOutputItem,
  ResponsesMessageItem,
  ResponsesFunctionCallItem,
  ResponsesReasoningItem,
  ResponsesFunctionCallOutputItem,
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
  buildReasoningStartEvent,
  buildReasoningSummaryEvents,
  buildReasoningDeltas,
  buildReasoningDoneEvent,
  buildRequiredActionEvent,
  buildResponseCompletedEvent,
  buildErrorEvent,
  DEFAULT_RESPONSES_EVENT_GENERATOR_CONFIG,
  createDefaultResponsesContext
} from '../event-generators/responses.js';
import type { ResponsesEventGeneratorContext, ResponsesEventGeneratorConfig } from '../event-generators/responses.js';
import { expandResponsesMessageItem } from '../../shared/responses-output-normalizer.js';

// 排列器配置
export interface ResponsesSequencerConfig extends ResponsesEventGeneratorConfig {
  enableValidation: boolean;
  enableRecovery: boolean;
  enableDelay: boolean;
  maxOutputItems: number;
  maxContentParts: number;
  submittedToolOutputs?: ResponsesFunctionCallOutputItem[];
}

// 默认配置
export const DEFAULT_RESPONSES_SEQUENCER_CONFIG: ResponsesSequencerConfig = {
  ...DEFAULT_RESPONSES_EVENT_GENERATOR_CONFIG,
  enableValidation: true,
  enableRecovery: true,
  enableDelay: false,
  maxOutputItems: 50,
  maxContentParts: 100,
  submittedToolOutputs: undefined
};

function normalizeResponseOutput(
  output: ResponsesOutputItem[] | undefined,
  requestId: string
): ResponsesOutputItem[] {
  if (!Array.isArray(output)) return [];
  const hasExplicitReasoning = output.some(
    (item) => item && typeof item === 'object' && (item as ResponsesOutputItem).type === 'reasoning'
  );
  const normalized: ResponsesOutputItem[] = [];
  output.forEach((item, index) => {
    if (item && typeof item === 'object' && (item as ResponsesOutputItem).type === 'message') {
      normalized.push(
        ...expandResponsesMessageItem(item as ResponsesMessageItem, {
          requestId,
          outputIndex: index,
          suppressReasoningFromContent: hasExplicitReasoning
        })
      );
    } else {
      normalized.push(item);
    }
  });
  return normalized;
}

/**
 * 验证响应格式
 */
function validateResponse(response: ResponsesResponse, config: ResponsesSequencerConfig): void {
  if (!config.enableValidation) return;

  if (!response.id || !response.model) {
    throw new Error('Invalid response: missing required fields');
  }

  if (!response.output || !Array.isArray(response.output)) {
    throw new Error('Invalid response: missing or invalid output array');
  }

  if (response.output.length > config.maxOutputItems) {
    throw new Error(`Too many output items: ${response.output.length} > ${config.maxOutputItems}`);
  }
}

/**
 * 异步生成器：为事件添加延迟
 */
async function* withDelay(
  events: Generator<ResponsesSseEvent> | AsyncGenerator<ResponsesSseEvent> | ResponsesSseEvent[],
  config: ResponsesSequencerConfig
): AsyncGenerator<ResponsesSseEvent> {
  for await (const event of events) {
    yield event;

    if (config.enableDelay && config.chunkDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, config.chunkDelayMs));
    }
  }
}

/**
 * 序列化消息输出项
 */
async function* sequenceMessageItem(
  item: ResponsesMessageItem,
  context: ResponsesEventGeneratorContext,
  config: ResponsesSequencerConfig
): AsyncGenerator<ResponsesSseEvent> {
  // 1. 发送output_item.start事件
  yield buildOutputItemStartEvent(item, context, config);

  // 2. 发送content_part事件序列
  for (let contentIndex = 0; contentIndex < item.content.length; contentIndex++) {
    if (contentIndex >= config.maxContentParts) {
      if (config.enableValidation) {
        throw new Error(`Too many content parts: ${contentIndex} >= ${config.maxContentParts}`);
      }
      break;
    }

    const content = item.content[contentIndex];
    context.contentIndexCounter.set(item.id, contentIndex);

    // 2a. 发送content_part.start事件
    yield buildContentPartStartEvent(item.id, contentIndex, content, context, config);

    // 2b. 发送content_part.delta事件流（仅对文本内容）
    const isTextContent = (content.type === 'input_text' || content.type === 'output_text') && !!content.text;
    if (isTextContent && content.text) {
      yield* withDelay(
        buildContentPartDeltas(item.id, contentIndex, content.text, context, config),
        config
      );

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
  config: ResponsesSequencerConfig
): AsyncGenerator<ResponsesSseEvent> {
  // 1. 发送output_item.start事件
  yield buildOutputItemStartEvent(item, context, config);

  // 2. 发送function_call.delta事件流（arguments）
  if (item.arguments) {
    yield* withDelay(
      buildFunctionCallArgsDeltas(item, context, config),
      config
    );
  }

  // 3. 发送function_call.done事件
  yield buildFunctionCallDoneEvent(item, context, config);

  // 4. 发送output_item.done事件
  yield buildOutputItemDoneEvent(item, context, config);
}

/**
 * 序列化函数调用输出项
 */
async function* sequenceFunctionCallOutputItem(
  item: ResponsesFunctionCallOutputItem,
  context: ResponsesEventGeneratorContext,
  config: ResponsesSequencerConfig
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
  config: ResponsesSequencerConfig
): AsyncGenerator<ResponsesSseEvent> {
  // 1. 发送output_item.start事件
  yield buildOutputItemStartEvent(item, context, config);

  // 2. 发送reasoning.start事件
  yield buildReasoningStartEvent(item, context, config);

  // 3. 发送reasoning_summary事件流
  yield* withDelay(
    buildReasoningSummaryEvents(item, context, config),
    config
  );

  // 4. 发送reasoning.delta事件流
  yield* withDelay(
    buildReasoningDeltas(item, context, config),
    config
  );

  // 5. 发送reasoning.done事件
  yield buildReasoningDoneEvent(item, context, config);

  // 6. 发送output_item.done事件
  yield buildOutputItemDoneEvent(item, context, config);
}

/**
 * 序列化单个输出项
 */
async function* sequenceOutputItem(
  item: ResponsesOutputItem,
  context: ResponsesEventGeneratorContext,
  config: ResponsesSequencerConfig
): AsyncGenerator<ResponsesSseEvent> {
  try {
    switch (item.type) {
      case 'message':
        yield* sequenceMessageItem(item as ResponsesMessageItem, context, config);
        break;

      case 'function_call':
        yield* sequenceFunctionCallItem(item as ResponsesFunctionCallItem, context, config);
        break;

      case 'function_call_output':
        yield* sequenceFunctionCallOutputItem(item as ResponsesFunctionCallOutputItem, context, config);
        break;

      case 'reasoning':
        yield* sequenceReasoningItem(item as ResponsesReasoningItem, context, config);
        break;

      default:
        if (config.enableValidation) {
          throw new Error(`Unknown output item type: ${(item as any).type}`);
        }
    }
  } catch (error) {
    if (config.enableRecovery) {
      yield buildErrorEvent(error as Error, context, config);
    } else {
      throw error;
    }
  }
}

/**
 * 主编排器：将Responses响应转换为有序的SSE事件流
 */
export async function* sequenceResponse(
  response: ResponsesResponse,
  context: ResponsesEventGeneratorContext,
  config: ResponsesSequencerConfig = DEFAULT_RESPONSES_SEQUENCER_CONFIG
): AsyncGenerator<ResponsesSseEvent> {
  try {
    // 1. 验证响应格式
    validateResponse(response, config);

    // 2. 发送response.start事件
    yield* buildResponseStartEvents(response, context, config);

    const submittedOutputs = Array.isArray(config.submittedToolOutputs)
      ? config.submittedToolOutputs
      : [];

    for (let i = 0; i < submittedOutputs.length; i++) {
      context.outputIndexCounter = i;
      yield* sequenceFunctionCallOutputItem(submittedOutputs[i], context, config);
    }

    const normalizedOutput = normalizeResponseOutput(response.output, context.requestId);
    const outputOffset = submittedOutputs.length;

    // 3. 序列化所有输出项
    for (let outputIndex = 0; outputIndex < normalizedOutput.length; outputIndex++) {
      const item = normalizedOutput[outputIndex];
      context.outputIndexCounter = outputOffset + outputIndex;

      yield* sequenceOutputItem(item, context, config);

      // 输出项间添加小延迟（如果启用）
      if (config.enableDelay && config.chunkDelayMs > 0 && outputIndex < normalizedOutput.length - 1) {
        await new Promise(resolve => setTimeout(resolve, config.chunkDelayMs * 2));
      }
    }

    // 4. 发送required_action事件（如果有）
    if ((response as any).required_action) {
      yield buildRequiredActionEvent(response, (response as any).required_action, context, config);
    }

    // 5. 发送response.completed + response.done事件
    yield buildResponseCompletedEvent(response, context, config);
    yield buildResponseDoneEvent(response, context, config);

  } catch (error) {
    // 发送错误事件
    yield buildErrorEvent(error as Error, context, config);
  }
}

/**
 * 序列化Responses请求（用于请求→SSE转换）
 */
export async function* sequenceRequest(
  request: any,
  context: ResponsesEventGeneratorContext,
  config: ResponsesSequencerConfig = DEFAULT_RESPONSES_SEQUENCER_CONFIG
): AsyncGenerator<ResponsesSseEvent> {
  try {
    // 验证请求格式
    if (config.enableValidation && (!request.model || !request.input)) {
      throw new Error('Invalid request: missing required fields');
    }

    // 对于请求，我们主要回显输入内容
    yield* buildResponseStartEvents({
      id: context.requestId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'in_progress',
      model: request.model,
      output: [],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } as any
    }, context, config);

    // 回显输入消息作为输出项
    if (request.input && Array.isArray(request.input)) {
      let syntheticIndex = 0;
      for (let inputIndex = 0; inputIndex < request.input.length; inputIndex++) {
        const inputItem = request.input[inputIndex];

        // 将输入转换为输出项格式
        const outputItem: ResponsesMessageItem = {
          id: `${context.requestId}-input-${inputIndex}`,
          type: 'message',
          status: 'completed',
          role: inputItem.role,
          content: inputItem.content
        };

        const expandedItems = expandResponsesMessageItem(outputItem, {
          requestId: context.requestId,
          outputIndex: syntheticIndex
        });
        for (const expanded of expandedItems) {
          context.outputIndexCounter = syntheticIndex++;
          yield* sequenceOutputItem(expanded, context, config);
        }
      }
    }

    const syntheticResponse: ResponsesResponse = {
      id: context.requestId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'completed',
      model: request.model,
      output: [],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } as any
    };
    yield buildResponseCompletedEvent(syntheticResponse, context, config);
    yield buildResponseDoneEvent(syntheticResponse, context, config);

  } catch (error) {
    yield buildErrorEvent(error as Error, context, config);
  }
}

/**
 * 创建Responses事件序列化器工厂
 */
export function createResponsesSequencer(config?: Partial<ResponsesSequencerConfig>) {
  const finalConfig = { ...DEFAULT_RESPONSES_SEQUENCER_CONFIG, ...config };

  return {
    /**
     * 序列化响应
     */
    async *sequenceResponse(response: ResponsesResponse, requestId: string) {
      const context = createDefaultResponsesContext(requestId, response.model);
      yield* sequenceResponse(response, context, finalConfig);
    },

    /**
     * 序列化请求
     */
    async *sequenceRequest(request: any, requestId: string) {
      const context = createDefaultResponsesContext(requestId, request.model);
      yield* sequenceRequest(request, context, finalConfig);
    },

    /**
     * 获取当前配置
     */
    getConfig(): ResponsesSequencerConfig {
      return { ...finalConfig };
    }
  };
}
