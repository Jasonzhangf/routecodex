/**
 * 基础事件序列化器接口
 * 定义统一的序列化/反序列化规范
 */

/**
 * 通用事件序列化器接口
 * @template TEvent 事件类型
 */
export interface EventSerializer<TEvent> {
  /**
   * 将事件对象序列化为SSE wire格式字符串
   * @param event 要序列化的事件对象
   * @returns SSE wire格式的字符串
   */
  serializeToWire(event: TEvent): string;

  /**
   * 从SSE wire格式字符串反序列化为事件对象
   * @param wireData SSE wire格式的字符串
   * @returns 反序列化后的事件对象
   */
  deserializeFromWire(wireData: string): TEvent;

  /**
   * 验证SSE wire格式是否有效
   * @param wireData 要验证的SSE wire格式字符串
   * @returns 格式是否有效
   */
  validateWireFormat(wireData: string): boolean;
}

/**
 * 序列化选项配置
 */
export interface SerializationOptions {
  /**
   * 是否包含时间戳
   */
  includeTimestamp?: boolean;

  /**
   * 是否包含事件ID
   */
  includeEventId?: boolean;

  /**
   * 自定义事件ID生成器
   */
  eventIdGenerator?: () => string;

  /**
   * JSON序列化配置
   */
  jsonReplacer?: (key: string, value: any) => any;

  /**
   * JSON反序列化配置
   */
  jsonReviver?: (key: string, value: any) => any;
}

/**
 * 基础事件序列化器抽象类
 * 提供通用的序列化功能实现
 */
export abstract class BaseEventSerializer<TEvent> implements EventSerializer<TEvent> {
  protected options: SerializationOptions;

  constructor(options: SerializationOptions = {}) {
    this.options = {
      includeTimestamp: true,
      includeEventId: true,
      ...options
    };
  }

  /**
   * 序列化事件为SSE wire格式
   */
  serializeToWire(event: TEvent): string {
    const lines: string[] = [];

    // 添加事件类型
    const eventType = this.extractEventType(event);
    lines.push(`event: ${eventType}`);

    // 添加事件数据
    const data = this.extractEventData(event);
    if (data !== null && data !== undefined) {
      const dataStr = this.serializeData(data);
      lines.push(`data: ${dataStr}`);
    }

    // 添加时间戳
    if (this.options.includeTimestamp) {
      const timestamp = this.extractTimestamp(event) || this.generateTimestamp();
      lines.push(`id: ${timestamp}`);
    }

    // 添加事件ID（如果与时间戳不同）
    if (this.options.includeEventId && this.options.includeTimestamp) {
      const eventId = this.extractEventId(event) || this.options.eventIdGenerator?.();
      if (eventId) {
        lines.push(`id: ${eventId}`);
      }
    }

    // SSE事件以空行结束
    lines.push('');

    return lines.join('\n');
  }

  /**
   * 从SSE wire格式反序列化事件
   */
  deserializeFromWire(wireData: string): TEvent {
    const lines = wireData.trim().split('\n');
    let eventType: string | null = null;
    let eventData: any = null;
    let eventId: string | null = null;
    let timestamp: string | null = null;

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventType = line.substring(6).trim();
      } else if (line.startsWith('data:')) {
        const dataStr = line.substring(5).trim();
        eventData = this.deserializeData(dataStr);
      } else if (line.startsWith('id:')) {
        const idValue = line.substring(3).trim();
        // 第一个id通常是时间戳，第二个是事件ID
        if (!timestamp) {
          timestamp = idValue;
        } else {
          eventId = idValue;
        }
      }
    }

    if (!eventType) {
      throw new Error('Missing event type in SSE data');
    }

    return this.createEvent(eventType, eventData, timestamp, eventId);
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

  /**
   * 生成当前时间戳
   */
  protected generateTimestamp(): string {
    return new Date().toISOString();
  }

  /**
   * 序列化数据
   */
  protected serializeData(data: any): string {
    if (typeof data === 'string') {
      return data;
    }
    return JSON.stringify(data, this.options.jsonReplacer);
  }

  /**
   * 反序列化数据
   */
  protected deserializeData(dataStr: string): any {
    try {
      return JSON.parse(dataStr, this.options.jsonReviver);
    } catch {
      return dataStr;
    }
  }

  // 以下方法需要子类实现

  /**
   * 从事件对象中提取事件类型
   */
  protected abstract extractEventType(event: TEvent): string;

  /**
   * 从事件对象中提取事件数据
   */
  protected abstract extractEventData(event: TEvent): any;

  /**
   * 从事件对象中提取时间戳
   */
  protected extractTimestamp(event: TEvent): string | null {
    return null;
  }

  /**
   * 从事件对象中提取事件ID
   */
  protected extractEventId(event: TEvent): string | null {
    return null;
  }

  /**
   * 创建事件对象
   */
  protected abstract createEvent(
    eventType: string,
    eventData: any,
    timestamp?: string | null,
    eventId?: string | null
  ): TEvent;
}

/**
 * 序列化错误类
 */
export class SerializationError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error,
    public readonly eventData?: any
  ) {
    super(message);
    this.name = 'SerializationError';
  }
}

/**
 * 序列化结果
 */
export interface SerializationResult {
  /**
   * 序列化后的SSE wire格式字符串
   */
  wireData: string;

  /**
   * 序列化统计信息
   */
  stats: {
    /**
     * 序列化耗时（毫秒）
     */
    duration: number;

    /**
     * 序列化数据大小（字节）
     */
    size: number;

    /**
     * 是否成功
     */
    success: boolean;

    /**
     * 错误信息（如果有）
     */
    error?: string;
  };
}

/**
 * 批量序列化工具
 */
export class BatchSerializer<TEvent> {
  constructor(private serializer: EventSerializer<TEvent>) {}

  /**
   * 批量序列化事件
   */
  async serializeBatch(events: TEvent[]): Promise<SerializationResult[]> {
    const results: SerializationResult[] = [];

    for (const event of events) {
      const startTime = Date.now();
      let wireData: string;
      let error: string | undefined;

      try {
        wireData = this.serializer.serializeToWire(event);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        wireData = '';
      }

      results.push({
        wireData,
        stats: {
          duration: Date.now() - startTime,
          size: new Blob([wireData]).size,
          success: !error,
          error
        }
      });
    }

    return results;
  }

  /**
   * 批量反序列化事件
   */
  async deserializeBatch(wireDataArray: string[]): Promise<TEvent[]> {
    const events: TEvent[] = [];

    for (const wireData of wireDataArray) {
      try {
        if (this.serializer.validateWireFormat(wireData)) {
          const event = this.serializer.deserializeFromWire(wireData);
          events.push(event);
        }
      } catch (e) {
        // 跳过无法反序列化的事件，或者可以选择抛出错误
        console.warn('Failed to deserialize event:', e);
      }
    }

    return events;
  }
}