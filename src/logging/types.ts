/**
 * 统一日志系统类型定义
 * 
 * 为RouteCodex项目提供标准化的日志格式和接口定义
 */

/**
 * 日志级别枚举
 */
export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error'
}

/**
 * 日志上下文信息
 */
export interface LogContext {
  /** 管道ID */
  pipelineId?: string;
  /** 请求ID */
  requestId?: string;
  /** 会话ID */
  sessionId?: string;
  /** 模块ID */
  moduleId?: string;
  /** 模块类型 */
  moduleType?: string;
  /** 额外的上下文数据 */
  [key: string]: any;
}

/**
 * 统一日志条目接口
 */
export interface UnifiedLogEntry {
  /** 时间戳 (ISO 8601) */
  timestamp: number;
  /** 日志级别 */
  level: LogLevel;
  /** 模块ID */
  moduleId: string;
  /** 模块类型 */
  moduleType: string;
  /** 管道ID (可选) */
  pipelineId?: string;
  /** 请求ID (可选) */
  requestId?: string;
  /** 会话ID (可选) */
  sessionId?: string;
  /** 日志消息 */
  message: string;
  /** 结构化数据 (可选) */
  data?: any;
  /** 错误信息 (可选) */
  error?: LogError;
  /** 性能指标 */
  duration?: number;
  /** 内存使用 (bytes) */
  memoryUsage?: number;
  /** 分类标签 */
  tags: string[];
  /** 日志格式版本 - 默认 0.0.1 */
  version: string;
}

/**
 * 日志错误信息
 */
export interface LogError {
  /** 错误名称 */
  name: string;
  /** 错误消息 */
  message: string;
  /** 错误堆栈 (可选) */
  stack?: string;
  /** 错误代码 (可选) */
  code?: string;
  /** 额外的错误数据 (可选) */
  [key: string]: any;
}

/**
 * Logger配置接口
 */
export interface LoggerConfig {
  /** 模块ID */
  moduleId: string;
  /** 模块类型 */
  moduleType: string;
  /** 日志级别 (默认: info) */
  logLevel?: LogLevel;
  /** 是否启用控制台输出 (默认: true) */
  enableConsole?: boolean;
  /** 是否启用文件日志 (默认: true) */
  enableFile?: boolean;
  /** 是否启用DebugCenter集成 (默认: false) */
  enableDebugCenter?: boolean;
  /** 最大历史记录数 (默认: 10000) */
  maxHistory?: number;
  /** 日志目录 (默认: ./logs) */
  logDirectory?: string;
  /** 最大文件大小 (默认: 100MB) */
  maxFileSize?: number;
  /** 最大文件数量 (默认: 10) */
  maxFiles?: number;
  /** 是否启用压缩 (默认: true) */
  enableCompression?: boolean;
  /** 敏感字段过滤 */
  sensitiveFields?: string[];
}

/**
 * 文件日志写入器配置
 */
export interface FileLogWriterConfig {
  /** 日志目录 */
  directory: string;
  /** 最大文件大小 (bytes) */
  maxFileSize: number;
  /** 最大文件数量 */
  maxFiles: number;
  /** 是否启用压缩 */
  enableCompression: boolean;
  /** 日志文件扩展名 (默认: .jsonl) */
  fileExtension?: string;
}

/**
 * 日志统计信息
 */
export interface LogStats {
  /** 总日志数 */
  totalLogs: number;
  /** 各级别日志数 */
  levelCounts: Record<LogLevel, number>;
  /** 错误日志数 */
  errorCount: number;
  /** 最早日志时间 */
  earliestLog?: number;
  /** 最新日志时间 */
  latestLog?: number;
  /** 内存使用统计 */
  memoryStats?: {
    avgUsage: number;
    maxUsage: number;
    minUsage: number;
  };
  /** 性能统计 */
  performanceStats?: {
    avgDuration: number;
    maxDuration: number;
    minDuration: number;
  };
}

/**
 * 日志查询过滤器
 */
export interface LogFilter {
  /** 时间范围 */
  timeRange?: {
    start: number;
    end: number;
  };
  /** 日志级别 */
  levels?: LogLevel[];
  /** 模块ID */
  moduleIds?: string[];
  /** 模块类型 */
  moduleTypes?: string[];
  /** 管道ID */
  pipelineIds?: string[];
  /** 请求ID */
  requestIds?: string[];
  /** 标签过滤 */
  tags?: string[];
  /** 关键词搜索 */
  keyword?: string;
  /** 是否有错误 */
  hasError?: boolean;
  /** 最大返回数量 */
  limit?: number;
  /** 偏移量 */
  offset?: number;
}

/**
 * 日志查询结果
 */
export interface LogQueryResult {
  /** 日志条目 */
  logs: UnifiedLogEntry[];
  /** 总数 */
  total: number;
  /** 过滤条件 */
  filter: LogFilter;
  /** 查询耗时 (ms) */
  queryTime: number;
}

/**
 * 日志导出选项
 */
export interface LogExportOptions {
  /** 导出格式 */
  format: 'json' | 'jsonl' | 'csv';
  /** 过滤器 */
  filter?: LogFilter;
  /** 是否包含头部信息 */
  includeHeader?: boolean;
  /** 字段选择 */
  fields?: string[];
}

/**
 * 日志分析结果
 */
export interface LogAnalysisResult {
  /** 时间范围 */
  timeRange: {
    start: number;
    end: number;
  };
  /** 总体统计 */
  overallStats: LogStats;
  /** 模块统计 */
  moduleStats: Record<string, LogStats>;
  /** 错误分析 */
  errorAnalysis?: {
    totalErrors: number;
    errorTypes: Record<string, number>;
    errorTrends: Array<{
      time: number;
      count: number;
    }>;
  };
  /** 性能分析 */
  performanceAnalysis?: {
    avgResponseTime: number;
    responseTimeTrends: Array<{
      time: number;
      avgTime: number;
    }>;
    bottlenecks: Array<{
      moduleId: string;
      avgDuration: number;
      impact: number;
    }>;
  };
}

/**
 * 常量定义
 */
export const LOGGING_CONSTANTS = {
  /** 默认日志格式版本 */
  DEFAULT_VERSION: '0.0.1',
  
  /** 默认日志级别 */
  DEFAULT_LOG_LEVEL: LogLevel.INFO,
  
  /** 默认最大历史记录数 */
  DEFAULT_MAX_HISTORY: 10000,
  
  /** 默认最大文件大小 (100MB) */
  DEFAULT_MAX_FILE_SIZE: 100 * 1024 * 1024,
  
  /** 默认最大文件数量 */
  DEFAULT_MAX_FILES: 10,
  
  /** 敏感字段默认列表 */
  DEFAULT_SENSITIVE_FIELDS: [
    'password',
    'token',
    'apiKey',
    'secret',
    'privateKey',
    'auth',
    'authorization',
    'cookie',
    'session'
  ],
  
  /** 日志文件扩展名 */
  LOG_FILE_EXTENSION: '.jsonl',
  
  /** 压缩文件扩展名 */
  COMPRESSED_EXTENSION: '.gz'
} as const;