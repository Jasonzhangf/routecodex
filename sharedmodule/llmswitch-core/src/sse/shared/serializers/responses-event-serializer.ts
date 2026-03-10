/**
 * Responses协议事件序列化适配器
 * 将内部ResponsesSseEvent对象转换为真实的SSE wire格式
 */

import type { ResponsesSseEvent } from '../../types/responses-types.js';
import type { EventSerializer } from './base-serializer.js';

/**
 * Responses协议SSE事件序列化器
 * 负责将内部事件对象转换为符合LMStudio/官方SDK习惯的SSE格式
 */
export class ResponsesEventSerializer implements EventSerializer<ResponsesSseEvent> {
  /**
   * 将Responses事件序列化为SSE wire格式
   */
  serializeToWire(event: ResponsesSseEvent): string {
    switch (event.type) {
      case 'response.created':
        return this.serializeResponseCreated(event);
      case 'response.in_progress':
        return this.serializeResponseInProgress(event);
      case 'response.reasoning_text.delta':
        return this.serializeReasoningTextDelta(event);
      case 'response.reasoning_text.done':
        return this.serializeReasoningTextDone(event);
      case 'response.content_part.added':
        return this.serializeContentPartAdded(event);
      case 'response.content_part.done':
        return this.serializeContentPartDone(event);
      case 'response.output_item.added':
        return this.serializeOutputItemAdded(event);
      case 'response.output_item.done':
        return this.serializeOutputItemDone(event);
      case 'response.output_text.delta':
        return this.serializeOutputTextDelta(event);
      case 'response.output_text.done':
        return this.serializeOutputTextDone(event);
      case 'response.function_call_arguments.delta':
        return this.serializeFunctionCallArgumentsDelta(event);
      case 'response.function_call_arguments.done':
        return this.serializeFunctionCallArgumentsDone(event);
      case 'response.required_action':
        return this.serializeRequiredAction(event);
      case 'response.completed':
        return this.serializeResponseCompleted(event);
      case 'response.done':
        return this.serializeResponseDone(event);
      case 'response.error':
        return this.serializeResponseError(event);
      case 'response.cancelled':
        return this.serializeResponseCancelled(event);
      default:
        if (typeof (event as any).type === 'string' && (event as any).type.startsWith('response.')) {
          return this.buildSSEEvent((event as any).type, event.data, event.timestamp, event.sequenceNumber);
        }
        throw new Error(`Unsupported ResponsesSseEvent type: ${(event as any).type}`);
    }
  }

  /**
   * 从SSE wire格式反序列化为Responses事件
   */
  deserializeFromWire(wireData: string): ResponsesSseEvent {
    const lines = wireData.trim().split('\n');
    let eventType: string | null = null;
    let eventData: any = null;
    let eventId: string | null = null;

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventType = line.substring(6).trim();
      } else if (line.startsWith('data:')) {
        const dataStr = line.substring(5).trim();
        try {
          eventData = dataStr ? JSON.parse(dataStr) : null;
        } catch {
          eventData = dataStr;
        }
      } else if (line.startsWith('id:')) {
        eventId = line.substring(3).trim();
      }
    }

    if (!eventType) {
      throw new Error('Missing event type in SSE data');
    }

    const timestampValue = this.parseTimestamp(eventId);

    return this.decorate({
      type: eventType as ResponsesSseEvent['type'],
      timestamp: timestampValue,
      data: eventData
    });
  }

  /**
   * 验证SSE wire格式
   */
  validateWireFormat(wireData: string): boolean {
    try {
      const lines = wireData.trim().split('\n');
      let hasEvent = false;
      let hasData = false;

      for (const line of lines) {
        if (line.startsWith('event:')) {
          hasEvent = true;
        } else if (line.startsWith('data:')) {
          hasData = true;
        }
      }

      return hasEvent && hasData;
    } catch {
      return false;
    }
  }

  private decorate(event: Omit<ResponsesSseEvent, 'protocol' | 'direction'>): ResponsesSseEvent {
    return {
      ...event,
      protocol: 'responses',
      direction: 'sse_to_json'
    };
  }

  /**
   * 序列化response.created事件
   * 格式: event: response.created\ndata: {"response": {...}}\n\n
   */
  private serializeResponseCreated(event: ResponsesSseEvent): string {
    return this.buildSSEEvent('response.created', event.data, event.timestamp, event.sequenceNumber);
  }

  /**
   * 序列化response.in_progress事件
   */
  private serializeResponseInProgress(event: ResponsesSseEvent): string {
    return this.buildSSEEvent('response.in_progress', event.data, event.timestamp, event.sequenceNumber);
  }

  /**
   * 序列化response.reasoning_text.delta事件
   */
  private serializeReasoningTextDelta(event: ResponsesSseEvent): string {
    return this.buildSSEEvent('response.reasoning_text.delta', event.data, event.timestamp, event.sequenceNumber);
  }

  /**
   * 序列化response.reasoning_text.done事件
   */
  private serializeReasoningTextDone(event: ResponsesSseEvent): string {
    return this.buildSSEEvent('response.reasoning_text.done', event.data, event.timestamp, event.sequenceNumber);
  }

  /**
   * 序列化response.content_part.added事件
   */
  private serializeContentPartAdded(event: ResponsesSseEvent): string {
    return this.buildSSEEvent('response.content_part.added', event.data, event.timestamp, event.sequenceNumber);
  }

  /**
   * 序列化response.content_part.done事件
   */
  private serializeContentPartDone(event: ResponsesSseEvent): string {
    return this.buildSSEEvent('response.content_part.done', event.data, event.timestamp, event.sequenceNumber);
  }

  /**
   * 序列化response.output_item.added事件
   */
  private serializeOutputItemAdded(event: ResponsesSseEvent): string {
    return this.buildSSEEvent('response.output_item.added', event.data, event.timestamp, event.sequenceNumber);
  }

  /**
   * 序列化response.output_item.done事件
   */
  private serializeOutputItemDone(event: ResponsesSseEvent): string {
    return this.buildSSEEvent('response.output_item.done', event.data, event.timestamp, event.sequenceNumber);
  }

  /**
   * 序列化response.output_text.delta事件
   */
  private serializeOutputTextDelta(event: ResponsesSseEvent): string {
    return this.buildSSEEvent('response.output_text.delta', event.data, event.timestamp, event.sequenceNumber);
  }

  /**
   * 序列化response.output_text.done事件
   */
  private serializeOutputTextDone(event: ResponsesSseEvent): string {
    return this.buildSSEEvent('response.output_text.done', event.data, event.timestamp, event.sequenceNumber);
  }

  /**
   * 序列化response.function_call_arguments.delta事件
   */
  private serializeFunctionCallArgumentsDelta(event: ResponsesSseEvent): string {
    return this.buildSSEEvent('response.function_call_arguments.delta', event.data, event.timestamp, event.sequenceNumber);
  }

  /**
   * 序列化response.function_call_arguments.done事件
   */
  private serializeFunctionCallArgumentsDone(event: ResponsesSseEvent): string {
    return this.buildSSEEvent('response.function_call_arguments.done', event.data, event.timestamp, event.sequenceNumber);
  }

  /**
   * 序列化response.required_action事件
   */
  private serializeRequiredAction(event: ResponsesSseEvent): string {
    return this.buildSSEEvent('response.required_action', event.data, event.timestamp, event.sequenceNumber);
  }

  /**
   * 序列化response.completed事件
   */
  private serializeResponseCompleted(event: ResponsesSseEvent): string {
    return this.buildSSEEvent('response.completed', event.data, event.timestamp, event.sequenceNumber);
  }

  /**
   * 序列化response.done事件
   */
  private serializeResponseDone(event: ResponsesSseEvent): string {
    return this.buildSSEEvent('response.done', event.data, event.timestamp, event.sequenceNumber);
  }

  /**
   * 序列化response.error事件
   */
  private serializeResponseError(event: ResponsesSseEvent): string {
    return this.buildSSEEvent('response.error', event.data, event.timestamp, event.sequenceNumber);
  }

  /**
   * 序列化response.cancelled事件
   */
  private serializeResponseCancelled(event: ResponsesSseEvent): string {
    return this.buildSSEEvent('response.cancelled', event.data, event.timestamp, event.sequenceNumber);
  }

  /**
   * 构建标准SSE事件格式
   */
  private buildSSEEvent(eventType: string, data: any, timestamp?: number, sequenceNumber?: number): string {
    let wireEvent = `event: ${eventType}\n`;

    if (data === '[DONE]') {
      wireEvent += 'data: [DONE]\n';
    } else {
      const finalData = this.buildEventPayload(eventType, data, sequenceNumber);
      wireEvent += `data: ${JSON.stringify(finalData)}\n`;
    }

    if (timestamp) {
      wireEvent += `id: ${timestamp}\n`;
    }

    wireEvent += `\n`;
    return wireEvent;
  }

  /**
   * 创建标准response.created事件
   */
  static createResponseCreatedEvent(response: any, timestamp?: number): ResponsesSseEvent {
    return {
      type: 'response.created',
      timestamp: timestamp ?? Date.now(),
      data: { response },
      protocol: 'responses',
      direction: 'json_to_sse'
    };
  }

  /**
   * 创建标准response.in_progress事件
   */
  static createResponseInProgressEvent(timestamp?: number): ResponsesSseEvent {
    return {
      type: 'response.in_progress',
      timestamp: timestamp ?? Date.now(),
      data: {},
      protocol: 'responses',
      direction: 'json_to_sse'
    };
  }

  /**
   * 创建标准response.completed事件
   */
  static createResponseCompletedEvent(responseId: string, status: string, usage?: any, timestamp?: number): ResponsesSseEvent {
    return {
      type: 'response.completed',
      timestamp: timestamp ?? Date.now(),
      data: {
        response: {
          id: responseId,
          status,
          ...(usage && { usage })
        }
      },
      protocol: 'responses',
      direction: 'json_to_sse'
    };
  }

  /**
   * 创建标准response.required_action事件
   */
  static createRequiredActionEvent(toolCalls: any[], timestamp?: number): ResponsesSseEvent {
    return {
      type: 'response.required_action',
      timestamp: timestamp ?? Date.now(),
      data: {
        type: 'submit_tool_outputs',
        submit_tool_outputs: {
          tool_calls: toolCalls
        }
      },
      protocol: 'responses',
      direction: 'json_to_sse'
    };
  }

  /**
   * 创建标准response.done事件
   */
  static createResponseDoneEvent(requestId: string, totalEvents: number, timestamp?: number): ResponsesSseEvent {
    return {
      type: 'response.done',
      timestamp: timestamp ?? Date.now(),
      data: {
        type: 'done',
        requestId,
        totalEvents
      },
      protocol: 'responses',
      direction: 'json_to_sse'
    };
  }

  /**
   * 创建标准response.error事件
   */
  static createResponseErrorEvent(error: Error, requestId: string, timestamp?: number): ResponsesSseEvent {
    return {
      type: 'response.error',
      timestamp: timestamp ?? Date.now(),
      data: {
        type: 'error',
        requestId,
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack
        }
      },
      protocol: 'responses',
      direction: 'json_to_sse'
    };
  }

  private buildEventPayload(eventType: string, data: any, sequenceNumber?: number): Record<string, unknown> {
    let payload: Record<string, unknown>;

    if (data === null || data === undefined) {
      payload = { type: eventType };
    } else if (typeof data === 'object') {
      const existing = data as Record<string, unknown>;
      payload = {
        ...(existing || {})
      };
      if (!Object.prototype.hasOwnProperty.call(payload, 'type')) {
        payload.type = eventType;
      }
    } else {
      payload = { type: eventType, value: data };
    }

    if (sequenceNumber !== undefined && !Object.prototype.hasOwnProperty.call(payload, 'sequence_number')) {
      payload.sequence_number = sequenceNumber;
    }

    return payload;
  }

  /**
   * 解析 wire 中的时间戳字符串
   */
  private parseTimestamp(source: string | null): number {
    if (!source) return Date.now();
    const numeric = Number(source);
    if (!Number.isNaN(numeric)) {
      return numeric;
    }
    const parsed = Date.parse(source);
    return Number.isNaN(parsed) ? Date.now() : parsed;
  }
}

/**
 * 默认Responses事件序列化器实例
 */
export const defaultResponsesEventSerializer = new ResponsesEventSerializer();
