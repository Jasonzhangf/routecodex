/**
 * 共享常量定义
 * 定义JSON↔SSE双向转换中使用的常量
 */

// 协议常量
export const PROTOCOL_TYPES = {
  CHAT: 'chat',
  RESPONSES: 'responses'
} as const;

export const CONVERSION_DIRECTIONS = {
  JSON_TO_SSE: 'json_to_sse',
  SSE_TO_JSON: 'sse_to_json'
} as const;

// 超时常量
export const TIMEOUT_CONSTANTS = {
  DEFAULT_TIMEOUT_MS: 900000,
  HEARTBEAT_INTERVAL_MS: 15000,
  INACTIVITY_TIMEOUT_MS: 900000,
  EVENT_PROCESSING_TIMEOUT_MS: 5000,
  CHUNK_TIMEOUT_MS: 10000,
  TOTAL_TIMEOUT_MS: 900000 // 15分钟
} as const;

// 分块常量
export const CHUNK_CONSTANTS = {
  DEFAULT_CHUNK_SIZE: 12,
  DEFAULT_DELAY_MS: 8,
  REASONING_CHUNK_SIZE: 24,
  TEXT_CHUNK_SIZE: 12,
  FUNCTION_CALL_CHUNK_SIZE: 24,
  MAX_CHUNK_SIZE: 1024,
  MIN_CHUNK_SIZE: 1
} as const;

// 缓冲区常量
export const BUFFER_CONSTANTS = {
  DEFAULT_BUFFER_SIZE: 1000,
  MAX_BUFFER_SIZE: 10000,
  HIGH_WATER_MARK: 8000,
  LOW_WATER_MARK: 2000,
  BACKPRESSURE_THRESHOLD: 0.8
} as const;

// 重试常量
export const RETRY_CONSTANTS = {
  DEFAULT_MAX_RETRIES: 3,
  INITIAL_DELAY_MS: 1000,
  MAX_DELAY_MS: 30000,
  BACKOFF_MULTIPLIER: 2,
  JITTER_FACTOR: 0.1
} as const;

// 验证常量
export const VALIDATION_CONSTANTS = {
  MAX_SEQUENCE_NUMBER: 10000,
  MAX_OUTPUT_ITEMS: 100,
  MAX_CONTENT_PARTS: 1000,
  MAX_TOOL_CALLS: 50,
  MAX_MESSAGE_LENGTH: 1000000,
  MAX_ARGUMENTS_LENGTH: 100000
} as const;

// 错误代码常量
export const ERROR_CODES = {
  // 通用错误
  TIMEOUT: 'TIMEOUT',
  INVALID_INPUT: 'INVALID_INPUT',
  PARSE_ERROR: 'PARSE_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  STREAM_ERROR: 'STREAM_ERROR',

  // Chat协议错误
  CHAT_TIMEOUT: 'CHAT_TIMEOUT',
  CHAT_INVALID_CHUNK: 'CHAT_INVALID_CHUNK',
  CHAT_SEQUENCE_ERROR: 'CHAT_SEQUENCE_ERROR',
  CHAT_TOOL_CALL_ERROR: 'CHAT_TOOL_CALL_ERROR',
  CHAT_PARSE_ERROR: 'CHAT_PARSE_ERROR',
  CHAT_VALIDATION_ERROR: 'CHAT_VALIDATION_ERROR',
  CHAT_STREAM_ERROR: 'CHAT_STREAM_ERROR',

  // Responses协议错误
  RESPONSES_TIMEOUT: 'RESPONSES_TIMEOUT',
  RESPONSES_INVALID_EVENT: 'RESPONSES_INVALID_EVENT',
  RESPONSES_SEQUENCE_ERROR: 'RESPONSES_SEQUENCE_ERROR',
  RESPONSES_OUTPUT_ITEM_ERROR: 'RESPONSES_OUTPUT_ITEM_ERROR',
  RESPONSES_CONTENT_PART_ERROR: 'RESPONSES_CONTENT_PART_ERROR',
  RESPONSES_PARSE_ERROR: 'RESPONSES_PARSE_ERROR',
  RESPONSES_VALIDATION_ERROR: 'RESPONSES_VALIDATION_ERROR',
  RESPONSES_STREAM_ERROR: 'RESPONSES_STREAM_ERROR'
} as const;

// 状态常量
export const STREAM_STATUS = {
  IDLE: 'idle',
  STARTING: 'starting',
  ACTIVE: 'active',
  PAUSED: 'paused',
  COMPLETING: 'completing',
  COMPLETED: 'completed',
  ERROR: 'error',
  TIMEOUT: 'timeout',
  ABORTED: 'aborted'
} as const;

// 事件类型常量 - Chat协议
export const CHAT_EVENT_TYPES = {
  CHUNK: 'chat_chunk',
  DONE: 'chat.done',
  ERROR: 'error',
  PING: 'ping'
} as const;

// 事件类型常量 - Responses协议
export const RESPONSES_EVENT_TYPES = {
  // Response生命周期
  RESPONSE_CREATED: 'response.created',
  RESPONSE_IN_PROGRESS: 'response.in_progress',
  RESPONSE_COMPLETED: 'response.completed',
  RESPONSE_REQUIRED_ACTION: 'response.required_action',
  RESPONSE_DONE: 'response.done',

  // Output Item事件
  OUTPUT_ITEM_ADDED: 'response.output_item.added',
  OUTPUT_ITEM_DONE: 'response.output_item.done',

  // Content Part事件
  CONTENT_PART_ADDED: 'response.content_part.added',
  CONTENT_PART_DONE: 'response.content_part.done',

  // 内容增量事件
  OUTPUT_TEXT_DELTA: 'response.output_text.delta',
  OUTPUT_TEXT_DONE: 'response.output_text.done',
  REASONING_TEXT_DELTA: 'response.reasoning_text.delta',
  REASONING_TEXT_DONE: 'response.reasoning_text.done',
  FUNCTION_CALL_ARGUMENTS_DELTA: 'response.function_call_arguments.delta',
  FUNCTION_CALL_ARGUMENTS_DONE: 'response.function_call_arguments.done'
} as const;

// 输出项类型常量
export const OUTPUT_ITEM_TYPES = {
  REASONING: 'reasoning',
  MESSAGE: 'message',
  FUNCTION_CALL: 'function_call',
  SYSTEM_MESSAGE: 'system_message',
  FUNCTION_CALL_OUTPUT: 'function_call_output'
} as const;

// 内容部分类型常量
export const CONTENT_PART_TYPES = {
  REASONING_TEXT: 'reasoning_text',
  REASONING_SIGNATURE: 'reasoning_signature',
  REASONING_IMAGE: 'reasoning_image',
  OUTPUT_TEXT: 'output_text',
  INPUT_TEXT: 'input_text',
  INPUT_IMAGE: 'input_image',
  COMMENTARY: 'commentary'
} as const;

// 工具调用类型常量
export const TOOL_CALL_TYPES = {
  FUNCTION: 'function'
} as const;

// 响应状态常量
export const RESPONSE_STATUS = {
  IN_PROGRESS: 'in_progress',
  REQUIRES_ACTION: 'requires_action',
  COMPLETED: 'completed',
  FAILED: 'failed',
  INCOMPLETE: 'incomplete'
} as const;

// 完成原因常量
export const FINISH_REASONS = {
  STOP: 'stop',
  LENGTH: 'length',
  TOOL_CALLS: 'tool_calls',
  CONTENT_FILTER: 'content_filter',
  FUNCTION_CALL: 'function_call'
} as const;

// 必需动作类型常量
export const REQUIRED_ACTION_TYPES = {
  SUBMIT_TOOL_OUTPUTS: 'submit_tool_outputs',
  RUN_PARALLEL_TOOLS: 'run_parallel_tools'
} as const;

// 默认配置常量
export const DEFAULT_CONFIG = {
  // 通用默认值
  TIMEOUT_MS: TIMEOUT_CONSTANTS.DEFAULT_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS: TIMEOUT_CONSTANTS.HEARTBEAT_INTERVAL_MS,
  CHUNK_SIZE: CHUNK_CONSTANTS.DEFAULT_CHUNK_SIZE,
  DELAY_MS: CHUNK_CONSTANTS.DEFAULT_DELAY_MS,
  VALIDATION_MODE: 'basic' as const,
  DEBUG_MODE: false,

  // Chat协议默认值
  CHAT: {
    TIMEOUT_MS: TIMEOUT_CONSTANTS.DEFAULT_TIMEOUT_MS,
    HEARTBEAT_INTERVAL_MS: TIMEOUT_CONSTANTS.HEARTBEAT_INTERVAL_MS,
    CHUNK_DELAY_MS: 10,
    MAX_TOKENS_PER_CHUNK: 100,
    VALIDATE_CHUNKS: true,
    STRICT_MODE: false,
    VALIDATE_TOOL_CALLS: true,
    MAX_CONCURRENT_CHOICES: 10,
    MAX_CONCURRENT_TOOL_CALLS: 50
  },

  // Responses协议默认值
  RESPONSES: {
    TIMEOUT_MS: TIMEOUT_CONSTANTS.DEFAULT_TIMEOUT_MS,
    HEARTBEAT_INTERVAL_MS: TIMEOUT_CONSTANTS.HEARTBEAT_INTERVAL_MS,
    REASONING_CHUNK_SIZE: CHUNK_CONSTANTS.REASONING_CHUNK_SIZE,
    TEXT_CHUNK_SIZE: CHUNK_CONSTANTS.TEXT_CHUNK_SIZE,
    FUNCTION_CALL_CHUNK_SIZE: CHUNK_CONSTANTS.FUNCTION_CALL_CHUNK_SIZE,
    ENABLE_EVENT_VALIDATION: true,
    ENABLE_SEQUENCE_VALIDATION: true,
    STRICT_MODE: false,
    VALIDATE_OUTPUT_ITEMS: true,
    MAX_CONCURRENT_OUTPUT_ITEMS: 10,
    MAX_CONCURRENT_CONTENT_PARTS: 50
  }
} as const;

// 环境变量键名
export const ENV_KEYS = {
  // 超时配置
  SSE_DEFAULT_TIMEOUT_MS: 'SSE_DEFAULT_TIMEOUT_MS',
  SSE_HEARTBEAT_INTERVAL_MS: 'SSE_HEARTBEAT_INTERVAL_MS',
  SSE_INACTIVITY_TIMEOUT_MS: 'SSE_INACTIVITY_TIMEOUT_MS',
  SSE_EVENT_PROCESSING_TIMEOUT_MS: 'SSE_EVENT_PROCESSING_TIMEOUT_MS',

  // 分块配置
  SSE_DEFAULT_CHUNK_SIZE: 'SSE_DEFAULT_CHUNK_SIZE',
  SSE_DEFAULT_DELAY_MS: 'SSE_DEFAULT_DELAY_MS',
  SSE_REASONING_CHUNK_SIZE: 'SSE_REASONING_CHUNK_SIZE',
  SSE_TEXT_CHUNK_SIZE: 'SSE_TEXT_CHUNK_SIZE',
  SSE_ARGS_CHUNK_SIZE: 'SSE_ARGS_CHUNK_SIZE',
  SSE_ARGS_DELAY_MS: 'SSE_ARGS_DELAY_MS',

  // 缓冲区配置
  SSE_MAX_BUFFER_SIZE: 'SSE_MAX_BUFFER_SIZE',
  SSE_HIGH_WATER_MARK: 'SSE_HIGH_WATER_MARK',
  SSE_LOW_WATER_MARK: 'SSE_LOW_WATER_MARK',

  // 验证配置
  SSE_ENABLE_VALIDATION: 'SSE_ENABLE_VALIDATION',
  SSE_ENABLE_SEQUENCE_VALIDATION: 'SSE_ENABLE_SEQUENCE_VALIDATION',
  SSE_MAX_SEQUENCE_NUMBER: 'SSE_MAX_SEQUENCE_NUMBER',
  SSE_STRICT_MODE: 'SSE_STRICT_MODE',

  // 调试配置
  SSE_DEBUG_EVENTS: 'SSE_DEBUG_EVENTS',
  SSE_DEBUG_MODE: 'SSE_DEBUG_MODE',
  SSE_LOG_LEVEL: 'SSE_LOG_LEVEL',
  SSE_ENABLE_METRICS: 'SSE_ENABLE_METRICS',

  // 兼容性配置
  RCC_STREAM_HEARTBEAT: 'RCC_STREAM_HEARTBEAT',
  RCC_STREAM_PRE_HEARTBEAT: 'RCC_STREAM_PRE_HEARTBEAT',
  RCC_RESP_GENERIC_ONMESSAGE: 'RCC_RESP_GENERIC_ONMESSAGE',

  // LM Studio兼容
  LMSTUDIO_BASE_URL: 'LMSTUDIO_BASEURL',
  LMSTUDIO_API_KEY: 'LMSTUDIO_API_KEY'
} as const;

// HTTP状态码常量
export const HTTP_STATUS_CODES = {
  OK: 200,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  TIMEOUT: 408,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504
} as const;

// Content-Type常量
export const CONTENT_TYPES = {
  JSON: 'application/json',
  SSE: 'text/event-stream',
  TEXT: 'text/plain',
  HTML: 'text/html'
} as const;

// SSE标准字段
export const SSE_FIELDS = {
  EVENT: 'event',
  DATA: 'data',
  ID: 'id',
  RETRY: 'retry'
} as const;

// 标准SSE事件
export const STANDARD_SSE_EVENTS = {
  OPEN: 'open',
  MESSAGE: 'message',
  ERROR: 'error',
  CLOSE: 'close'
} as const;

// 缓存键前缀
export const CACHE_PREFIXES = {
  CONVERSION: 'conversion:',
  VALIDATION: 'validation:',
  METRICS: 'metrics:',
  CONFIG: 'config:'
} as const;

// 指标名称常量
export const METRIC_NAMES = {
  // 计数器指标
  CONVERSION_REQUESTS_TOTAL: 'conversion_requests_total',
  CONVERSION_ERRORS_TOTAL: 'conversion_errors_total',
  EVENTS_PROCESSED_TOTAL: 'events_processed_total',
  TIMEOUTS_TOTAL: 'timeouts_total',

  // 直方图指标
  CONVERSION_DURATION_SECONDS: 'conversion_duration_seconds',
  EVENT_PROCESSING_DURATION_SECONDS: 'event_processing_duration_seconds',
  BUFFER_SIZE_BYTES: 'buffer_size_bytes',

  // 仪表盘指标
  ACTIVE_CONVERSIONS: 'active_conversions',
  BUFFER_UTILIZATION_RATIO: 'buffer_utilization_ratio',
  ERROR_RATE: 'error_rate'
} as const;

// 日志级别常量
export const LOG_LEVELS = {
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error'
} as const;

// 正则表达式常量
export const REGEX_PATTERNS = {
  // 文本分词边界
  WORD_BOUNDARY: /[\n\r\t，。、"''！？,.\-:\u3000\s]/,
  SENTENCE_BOUNDARY: /[。！？.!?]/,
  PARAGRAPH_BOUNDARY: /[\n\r]{2,}/,

  // JSON验证
  JSON_STRING: /^[\s\S]*$/,
  SSE_LINE: /^(\w+):\s*(.*)$/,
  SSE_DATA_LINE: /^data:\s*(.*)$/,

  // ID验证
  REQUEST_ID: /^req_\d+$/,
  RESPONSE_ID: /^resp_[a-f0-9]+$/,
  ITEM_ID: /^[a-z]{2}_[a-z0-9]+$/,
  CALL_ID: /^call_[a-z0-9]+$/
} as const;
