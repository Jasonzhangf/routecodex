/**
 * 统一日志系统常量定义
 *
 * 定义日志系统中使用的所有常量
 */

import { LogLevel } from './types.js';

/**
 * 日志级别优先级
 */
export const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  [LogLevel.DEBUG]: 0,
  [LogLevel.INFO]: 1,
  [LogLevel.WARN]: 2,
  [LogLevel.ERROR]: 3,
};

/**
 * 默认配置常量
 */
export const DEFAULT_CONFIG = {
  /** 默认日志级别 */
  LOG_LEVEL: LogLevel.INFO,

  /** 默认最大历史记录数 */
  MAX_HISTORY: 10000,

  /** 默认最大文件大小 (100MB) */
  MAX_FILE_SIZE: 100 * 1024 * 1024,

  /** 默认最大文件数量 */
  MAX_FILES: 10,

  /** 默认日志目录 */
  LOG_DIRECTORY: './logs',

  /** 默认是否启用控制台输出 */
  ENABLE_CONSOLE: true,

  /** 默认是否启用文件日志 */
  ENABLE_FILE: true,

  /** 默认是否启用DebugCenter集成 */
  ENABLE_DEBUG_CENTER: false,

  /** 默认是否启用压缩 */
  ENABLE_COMPRESSION: true,

  /** 默认时间戳格式 */
  TIMESTAMP_FORMAT: 'iso' as const,

  /** 默认日志格式版本 */
  LOG_VERSION: '0.0.1',
} as const;

/**
 * 文件日志常量
 */
export const FILE_LOG_CONSTANTS = {
  /** 日志文件扩展名 */
  LOG_FILE_EXTENSION: '.jsonl',

  /** 压缩文件扩展名 */
  COMPRESSED_EXTENSION: '.gz',

  /** 临时文件扩展名 */
  TEMP_EXTENSION: '.tmp',

  /** 文件轮转检查间隔 (ms) */
  ROTATION_CHECK_INTERVAL: 60000, // 1分钟

  /** 文件清理检查间隔 (ms) */
  CLEANUP_CHECK_INTERVAL: 3600000, // 1小时

  /** 缓冲区刷新间隔 (ms) */
  BUFFER_FLUSH_INTERVAL: 5000, // 5秒

  /** 缓冲区大小限制 */
  BUFFER_SIZE_LIMIT: 1000, // 1000条日志

  /** 最大重试次数 */
  MAX_RETRY_ATTEMPTS: 3,

  /** 重试延迟 (ms) */
  RETRY_DELAY: 1000,
} as const;

/**
 * 控制台日志常量
 */
export const CONSOLE_LOG_CONSTANTS = {
  /** 默认控制台样式 */
  DEFAULT_STYLES: {
    enableColors: true,
    showTimestamp: true,
    showLevel: true,
    showModule: true,
    timestampFormat: 'short' as const,
    maxMessageLength: 200,
  },

  /** 颜色代码 */
  COLORS: {
    [LogLevel.DEBUG]: '\x1b[36m', // Cyan
    [LogLevel.INFO]: '\x1b[32m', // Green
    [LogLevel.WARN]: '\x1b[33m', // Yellow
    [LogLevel.ERROR]: '\x1b[31m', // Red
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
  },

  /** 日志级别显示名称 */
  LEVEL_NAMES: {
    [LogLevel.DEBUG]: 'DEBUG',
    [LogLevel.INFO]: 'INFO ',
    [LogLevel.WARN]: 'WARN ',
    [LogLevel.ERROR]: 'ERROR',
  },
} as const;

/**
 * 敏感字段过滤常量
 */
export const SENSITIVE_FIELDS = {
  /** 默认敏感字段列表 */
  DEFAULT: [
    'password',
    'pwd',
    'pass',
    'token',
    'apikey',
    'api_key',
    'secret',
    'privatekey',
    'private_key',
    'auth',
    'authorization',
    'cookie',
    'session',
    'credentials',
    'access_token',
    'refresh_token',
    'id_token',
    'client_secret',
    'client_id',
  ],

  /** 替换值 */
  REDACTED_VALUE: '[REDACTED]',

  /** 最大显示长度 */
  MAX_DISPLAY_LENGTH: 50,
} as const;

/**
 * 错误处理常量
 */
export const ERROR_CONSTANTS = {
  /** 最大错误堆栈深度 */
  MAX_STACK_DEPTH: 10,

  /** 最大错误消息长度 */
  MAX_ERROR_MESSAGE_LENGTH: 500,

  /** 未知错误代码 */
  UNKNOWN_ERROR_CODE: 'UNKNOWN_ERROR',

  /** 内部错误前缀 */
  INTERNAL_ERROR_PREFIX: 'LOGGING_INTERNAL_ERROR',
} as const;

/**
 * 内存管理常量
 */
export const MEMORY_CONSTANTS = {
  /** 默认内存采样间隔 (ms) */
  SAMPLING_INTERVAL: 60000, // 1分钟

  /** 最大内存历史记录数 */
  MAX_MEMORY_HISTORY: 1000,

  /** 内存警告阈值 (MB) */
  MEMORY_WARNING_THRESHOLD: 500,

  /** 内存清理阈值 (MB) */
  MEMORY_CLEANUP_THRESHOLD: 1000,
} as const;

/**
 * 查询和过滤常量
 */
export const QUERY_CONSTANTS = {
  /** 默认查询限制 */
  DEFAULT_LIMIT: 1000,

  /** 最大查询限制 */
  MAX_LIMIT: 10000,

  /** 默认查询超时 (ms) */
  DEFAULT_TIMEOUT: 30000, // 30秒

  /** 最大查询时间范围 (ms) */
  MAX_TIME_RANGE: 30 * 24 * 60 * 60 * 1000, // 30天

  /** 索引构建批大小 */
  INDEX_BATCH_SIZE: 1000,
} as const;

/**
 * 导出格式常量
 */
export const EXPORT_CONSTANTS = {
  /** JSON导出选项 */
  JSON: {
    indent: 2,
    includeMetadata: true,
  },

  /** JSONL导出选项 */
  JSONL: {
    lineSeparator: '\n',
    includeHeader: false,
  },

  /** CSV导出选项 */
  CSV: {
    delimiter: ',',
    quote: '"',
    escape: '\\',
    header: true,
    bom: true,
  },
} as const;

/**
 * 性能监控常量
 */
export const PERFORMANCE_CONSTANTS = {
  /** 性能采样间隔 (ms) */
  SAMPLING_INTERVAL: 10000, // 10秒

  /** 最大性能历史记录数 */
  MAX_PERFORMANCE_HISTORY: 10000,

  /** 性能警告阈值 (ms) */
  PERFORMANCE_WARNING_THRESHOLD: 1000,

  /** 慢查询阈值 (ms) */
  SLOW_QUERY_THRESHOLD: 5000,
} as const;

/**
 * 日志分析常量
 */
export const ANALYSIS_CONSTANTS = {
  /** 趋势分析窗口大小 */
  TREND_WINDOW_SIZE: 100,

  /** 异常检测阈值 */
  ANOMALY_THRESHOLD: 2.5, // 标准差倍数

  /** 相关性分析最小样本数 */
  MIN_CORRELATION_SAMPLES: 30,

  /** 聚类分析最大组数 */
  MAX_CLUSTERS: 10,
} as const;

/**
 * 工厂模式常量
 */
export const FACTORY_CONSTANTS = {
  /** 最大Logger实例数 */
  MAX_LOGGERS: 1000,

  /** Logger缓存清理间隔 (ms) */
  CACHE_CLEANUP_INTERVAL: 300000, // 5分钟

  /** 内存警告阈值 */
  FACTORY_MEMORY_WARNING: 100 * 1024 * 1024, // 100MB

  /** 工厂关闭超时 (ms) */
  SHUTDOWN_TIMEOUT: 30000, // 30秒
} as const;
