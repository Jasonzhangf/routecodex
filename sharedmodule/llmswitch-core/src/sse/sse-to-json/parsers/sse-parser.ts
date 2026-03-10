/**
 * SSE事件解析器
 * 负责将SSE文本帧解析为标准化的SSE事件对象
 */

import type {
  ResponsesSseEvent,
  ResponsesSseEventType,
  ChatSseEvent,
  AnthropicSseEvent,
  GeminiSseEvent,
  BaseSseEvent
} from '../../types/index.js';

// 解析器配置
export interface SseParserConfig {
  enableStrictValidation: boolean;
  enableEventRecovery: boolean;
  maxEventSize: number;
  allowedEventTypes: Set<string>;
}

// 解析结果
export interface SseParseResult {
  success: boolean;
  event?: BaseSseEvent;
  error?: string;
  rawData: string;
}

// 默认配置
export const DEFAULT_SSE_PARSER_CONFIG: SseParserConfig = {
  enableStrictValidation: true,
  enableEventRecovery: true,
  // Responses 上游会在 response.completed 中携带整段 instructions，
  // 单个事件可能超过 64KB，因此放宽到 1MB 以避免误判。
  maxEventSize: 1024 * 1024,
  allowedEventTypes: new Set([
    // Chat事件类型
    'chunk',
    'done',
    'error',
    'heartbeat',

    // Responses事件类型 - canonical格式
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.done',
    'response.reasoning_text.delta',
    'response.reasoning_text.done',
    'response.reasoning_signature.delta',
    'response.reasoning_image.delta',
    'response.reasoning_summary_part.added',
    'response.reasoning_summary_part.done',
    'response.reasoning_summary_text.delta',
    'response.reasoning_summary_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.function_call_arguments.delta',
    'response.function_call_arguments.done',
    'response.required_action',
    'response.completed',
    'response.done',
    'response.error',
    'response.cancelled',

    // Legacy内部事件类型（向后兼容）
    'response.start',
    'output_item.start',
    'content_part.start',
    'content_part.delta',
    'function_call.start',
    'function_call.delta',
    'function_call.done',
    'reasoning.start',
    'reasoning.delta',
    'reasoning.done',
    'required_action',

    // Anthropic event types
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',

    // Gemini event types
    'gemini.data',
    'gemini.done'
  ])
};

/**
 * SSE原始事件数据
 */
export interface RawSseEvent {
  id?: string;
  event: string;
  data: string;
  retry?: string;
  timestamp?: number;
}

/**
 * 解析单行SSE数据
 */
function parseSseLine(line: string): { field?: string; value?: string } {
  if (!line || line.trim() === '') {
    return {};
  }

  const colonIndex = line.indexOf(':');
  if (colonIndex === -1) {
    return { field: line, value: '' };
  }

  const field = line.substring(0, colonIndex).trim();
  let value = line.substring(colonIndex + 1).trim();

  // 标准SSE：冒号后可选空格
  if (line[colonIndex + 1] === ' ') {
    value = line.substring(colonIndex + 2);
  }

  return { field, value };
}

/**
 * 将原始SSE行组装为事件
 */
export function assembleSseEvent(lines: string[]): RawSseEvent | null {
  if (lines.length === 0) {
    return null;
  }

  const event: RawSseEvent = {
    event: 'message', // 默认事件类型
    data: ''
  };

  for (const line of lines) {
    const { field, value } = parseSseLine(line);

    if (!field) {
      continue;
    }

    switch (field) {
      case 'id':
        event.id = value;
        break;
      case 'event':
        event.event = value;
        break;
      case 'data':
        event.data = event.data ? `${event.data}\n${value}` : value;
        break;
      case 'retry':
        event.retry = value;
        break;
      case 'timestamp':
        event.timestamp = parseInt(value, 10);
        break;
      // 忽略其他字段
    }
  }

  return event;
}

/**
 * 解析JSON数据
 */
function safeJsonParse(data: string): unknown {
  try {
    // 处理特殊的[DONE]标记
    if (data === '[DONE]') {
      return '[DONE]';
    }

    return JSON.parse(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON data: ${message}`);
  }
}

/**
 * 验证事件类型
 */
function validateEventType(eventType: string, config: SseParserConfig): boolean {
  if (!config.enableStrictValidation) {
    return true;
  }

  return config.allowedEventTypes.has(eventType);
}

function inferEventTypeFromData(rawEvent: RawSseEvent, config: SseParserConfig): string | null {
  // LM Studio (and some other OpenAI-compatible servers) may omit the SSE `event:` line and only
  // send JSON payloads like: `data: {"type":"response.output_item.added", ...}`.
  // Per SSE spec the default event type becomes "message", but for our protocol converters we
  // need the real OpenAI event type to pass strict validation and builder logic.
  if (rawEvent.event && rawEvent.event !== 'message') {
    return null;
  }
  if (!rawEvent.data) {
    return null;
  }
  try {
    const parsed = safeJsonParse(rawEvent.data);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const candidate = (parsed as { type?: unknown }).type;
    if (typeof candidate !== 'string' || !candidate.trim()) {
      return null;
    }
    const normalized = candidate.trim();
    if (!validateEventType(normalized, config)) {
      return null;
    }
    return normalized;
  } catch {
    return null;
  }
}

/**
 * 创建基础事件对象
 */
function createBaseEvent(
  rawEvent: RawSseEvent,
  config: SseParserConfig,
  _rawData: string
): BaseSseEvent {
  const baseEvent: BaseSseEvent = {
    type: rawEvent.event,
    timestamp: rawEvent.timestamp ?? Date.now(),
    data: null,
    sequenceNumber: typeof rawEvent.id === 'string' ? Number(rawEvent.id) : 0
  };

  // 解析数据字段
  try {
    if (rawEvent.data) {
      const parsedData = safeJsonParse(rawEvent.data);
      baseEvent.data = parsedData;
      if (
        parsedData &&
        typeof parsedData === 'object' &&
        'sequence_number' in parsedData &&
        typeof (parsedData as { sequence_number?: number }).sequence_number === 'number'
      ) {
        baseEvent.sequenceNumber = (parsedData as { sequence_number: number }).sequence_number;
      }
    }
  } catch (error) {
    if (config.enableEventRecovery) {
      baseEvent.data = { error: 'Invalid JSON', raw: rawEvent.data };
      baseEvent.type = 'error';
    } else {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  return baseEvent;
}

/**
 * 创建Chat特定事件
 */
function createChatEvent(baseEvent: BaseSseEvent): ChatSseEvent {
  return {
    type: baseEvent.type,
    event: baseEvent.type as ChatSseEvent['event'],
    timestamp: baseEvent.timestamp,
    data: baseEvent.data,
    sequenceNumber: baseEvent.sequenceNumber,
    protocol: 'chat' as const,
    direction: 'sse_to_json' as const
  };
}

/**
 * 创建Responses特定事件
 */
function createResponsesEvent(baseEvent: BaseSseEvent): ResponsesSseEvent {
  return {
    type: baseEvent.type as ResponsesSseEventType,
    timestamp: baseEvent.timestamp,
    data: baseEvent.data,
    sequenceNumber: baseEvent.sequenceNumber,
    protocol: 'responses' as const,
    direction: 'sse_to_json' as const
  };
}

function createAnthropicEvent(baseEvent: BaseSseEvent): AnthropicSseEvent {
  return {
    type: baseEvent.type as AnthropicSseEvent['type'],
    timestamp: baseEvent.timestamp,
    data: baseEvent.data,
    sequenceNumber: baseEvent.sequenceNumber,
    protocol: 'anthropic-messages',
    direction: 'sse_to_json'
  } as AnthropicSseEvent;
}

function createGeminiEvent(baseEvent: BaseSseEvent): GeminiSseEvent {
  return {
    type: baseEvent.type as GeminiSseEvent['type'],
    event: baseEvent.type as GeminiSseEvent['type'],
    timestamp: baseEvent.timestamp,
    data: baseEvent.data,
    sequenceNumber: baseEvent.sequenceNumber,
    protocol: 'gemini-chat',
    direction: 'sse_to_json'
  };
}

/**
 * 检测事件协议类型
 */
function detectEventType(eventType: string): 'chat' | 'responses' | 'anthropic' | 'gemini' {
  // Chat协议事件类型
  const chatEventTypes = new Set(['chunk', 'done', 'error', 'heartbeat']);
  const anthropicEventTypes = new Set([
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop'
  ]);
  const geminiEventTypes = new Set(['gemini.data', 'gemini.done']);

  if (chatEventTypes.has(eventType)) {
    return 'chat';
  }
  if (anthropicEventTypes.has(eventType)) {
    return 'anthropic';
  }
  if (geminiEventTypes.has(eventType)) {
    return 'gemini';
  }

  // Responses协议事件类型（以点分隔或特定关键词）
  if (eventType.includes('.') ||
      eventType.startsWith('response') ||
      eventType.startsWith('output') ||
      eventType.startsWith('content') ||
      eventType.startsWith('function') ||
      eventType.startsWith('reasoning')) {
    return 'responses';
  }

  // 默认为Responses协议
  return 'responses';
}

/**
 * 解析SSE事件文本为标准化事件对象
 */
export function parseSseEvent(
  sseText: string,
  config: SseParserConfig = DEFAULT_SSE_PARSER_CONFIG
): SseParseResult {
  const result: SseParseResult = {
    success: false,
    rawData: sseText
  };

  try {
    // 分割为行
    const lines = sseText.split('\n').map(line => line.trim()).filter(line => line !== '');

    // 组装原始事件
    const rawEvent = assembleSseEvent(lines);
    if (!rawEvent) {
      result.error = 'Invalid SSE event format';
      return result;
    }

    const inferred = inferEventTypeFromData(rawEvent, config);
    if (inferred) {
      rawEvent.event = inferred;
    }

    // 验证事件大小
    if (config.enableStrictValidation && sseText.length > config.maxEventSize) {
      result.error = `Event size ${sseText.length} exceeds maximum ${config.maxEventSize}`;
      return result;
    }

    // 验证事件类型
    if (!validateEventType(rawEvent.event, config)) {
      result.error = `Invalid event type: ${rawEvent.event}`;
      return result;
    }

    // 创建基础事件
    const baseEvent = createBaseEvent(rawEvent, config, sseText);

    // 创建协议特定事件
    const protocol = detectEventType(rawEvent.event);
    if (protocol === 'chat') {
      result.event = createChatEvent(baseEvent);
    } else if (protocol === 'anthropic') {
      result.event = createAnthropicEvent(baseEvent);
    } else if (protocol === 'gemini') {
      result.event = createGeminiEvent(baseEvent);
    } else {
      result.event = createResponsesEvent(baseEvent);
    }

    result.success = true;

  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}

/**
 * 解析SSE流（处理多事件数据）
 */
export function* parseSseStream(
  sseData: string,
  config: SseParserConfig = DEFAULT_SSE_PARSER_CONFIG
): Generator<SseParseResult> {
  // SSE事件由双换行分隔
  const events = sseData.split('\n\n').filter(event => event.trim() !== '');

  for (const eventData of events) {
    const result = parseSseEvent(eventData, config);

    if (result.success || config.enableEventRecovery) {
      yield result;
    }
  }
}

/**
 * 流式解析SSE数据
 */
export async function* parseSseStreamAsync(
  asyncSseData: AsyncIterable<string>,
  config: SseParserConfig = DEFAULT_SSE_PARSER_CONFIG
): AsyncGenerator<SseParseResult> {
  let buffer = '';

  for await (const chunk of asyncSseData) {
    buffer += chunk;

    // 查找完整的事件边界
    while (true) {
      const eventEnd = buffer.indexOf('\n\n');
      if (eventEnd === -1) {
        break;
      }

      const eventData = buffer.substring(0, eventEnd);
      buffer = buffer.substring(eventEnd + 2);

      const result = parseSseEvent(eventData, config);

      if (result.success || config.enableEventRecovery) {
        yield result;
      }
    }
  }

  // 处理剩余数据
  if (buffer.trim() !== '') {
    const result = parseSseEvent(buffer, config);
    if (result.success || config.enableEventRecovery) {
      yield result;
    }
  }
}

/**
 * 创建SSE解析器工厂
 */
export function createSseParser(config?: Partial<SseParserConfig>) {
  const finalConfig = { ...DEFAULT_SSE_PARSER_CONFIG, ...config };

  return {
    /**
     * 解析单个事件
     */
    parseEvent(sseText: string): SseParseResult {
      return parseSseEvent(sseText, finalConfig);
    },

    /**
     * 解析多事件流
     */
    *parseStream(sseData: string): Generator<SseParseResult> {
      yield* parseSseStream(sseData, finalConfig);
    },

    /**
     * 异步解析流
     */
    async *parseStreamAsync(asyncSseData: AsyncIterable<string>): AsyncGenerator<SseParseResult> {
      yield* parseSseStreamAsync(asyncSseData, finalConfig);
    },

    /**
     * 获取当前配置
     */
    getConfig(): SseParserConfig {
      return { ...finalConfig };
    },

    /**
     * 添加允许的事件类型
     */
    addEventType(eventType: string): void {
      finalConfig.allowedEventTypes.add(eventType);
    },

    /**
     * 移除允许的事件类型
     */
    removeEventType(eventType: string): void {
      finalConfig.allowedEventTypes.delete(eventType);
    }
  };
}
