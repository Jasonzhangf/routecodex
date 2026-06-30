/**
 * Responses协议事件序列化适配器
 * 将内部ResponsesSseEvent对象转换为真实的SSE wire格式
 */

// feature_id: sse.responses_encode_projection
import type { ResponsesSseEvent } from '../../types/responses-types.js';

const SUPPORTED_RESPONSES_EVENT_TYPES = new Set<string>([
  'response.created',
  'response.in_progress',
  'response.reasoning_text.delta',
  'response.reasoning_text.done',
  'response.reasoning_signature.delta',
  'response.reasoning_image.delta',
  'response.reasoning_summary_part.added',
  'response.reasoning_summary_part.done',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done',
  'response.content_part.added',
  'response.content_part.done',
  'response.output_item.added',
  'response.output_item.done',
  'response.output_text.delta',
  'response.output_text.done',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
  'response.required_action',
  'response.completed',
  'response.done',
  'response.error',
  'response.cancelled',
  'response.failed',
  'response.incomplete'
]);

/**
 * Responses协议SSE事件序列化器
 * 负责将内部事件对象转换为客户端协议SSE格式
 */
export class ResponsesEventSerializer {
  /**
   * 将Responses事件序列化为SSE wire格式
   */
  serializeToWire(event: ResponsesSseEvent): string {
    if (!SUPPORTED_RESPONSES_EVENT_TYPES.has((event as any).type)) {
      throw new Error(`Unsupported ResponsesSseEvent type: ${(event as any).type}`);
    }
    return this.buildSSEEvent(event.type, event.data, event.timestamp);
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
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
          throw new Error(`Invalid Responses SSE data payload: ${dataStr}; ${reason}`);
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
  }

  private decorate(event: Omit<ResponsesSseEvent, 'protocol' | 'direction'>): ResponsesSseEvent {
    return {
      ...event,
      protocol: 'responses',
      direction: 'sse_to_json'
    };
  }

  /**
   * 构建标准SSE事件格式
   */
  private buildSSEEvent(eventType: string, data: any, timestamp?: number): string {
    if (data === '[DONE]') {
      throw new Error('Responses SSE must terminate with response.done, not [DONE]');
    }
    let wireEvent = `event: ${eventType}\n`;
    const finalData = this.readCanonicalEventPayload(eventType, data);
    wireEvent += `data: ${JSON.stringify(finalData)}\n`;

    if (timestamp) {
      wireEvent += `id: ${timestamp}\n`;
    }

    wireEvent += `\n`;
    return wireEvent;
  }

  private readCanonicalEventPayload(eventType: string, data: any): Record<string, unknown> {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`Responses SSE payload must be an object for ${eventType}`);
    }
    const payload = data as Record<string, unknown>;
    if (payload.type !== eventType) {
      throw new Error(`Responses SSE payload missing canonical type for ${eventType}`);
    }
    return { ...payload };
  }

  /**
   * 解析 wire 中的时间戳字符串
   */
  private parseTimestamp(source: string | null): number {
    if (!source) {
      throw new Error('Missing Responses SSE timestamp');
    }
    const numeric = Number(source);
    if (!Number.isNaN(numeric)) {
      return numeric;
    }
    const parsed = Date.parse(source);
    if (Number.isNaN(parsed)) {
      throw new Error(`Invalid Responses SSE timestamp: ${source}`);
    }
    return parsed;
  }
}

/**
 * 默认Responses事件序列化器实例
 */
export const defaultResponsesEventSerializer = new ResponsesEventSerializer();
