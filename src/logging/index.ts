/**
 * 统一日志系统主入口 - 版本 0.0.1
 * 
 * 提供统一的日志系统接口和实现
 */

// 类型定义
export type {
  LogContext,
  UnifiedLogEntry,
  LogError,
  LoggerConfig,
  FileLogWriterConfig,
  LogStats,
  LogFilter,
  LogQueryResult,
  LogExportOptions,
  LogAnalysisResult
} from './types.js';

// 接口定义
export type {
  UnifiedLogger,
  LogWriter,
  LogWriterStatus,
  FileLogWriter,
  ConsoleLogWriter,
  DebugCenterLogWriter,
  ConsoleLogStyle,
  LogParser,
  LogQueryEngine,
  IndexStatus,
  LogAnalyzer,
  ErrorAnalysisResult,
  PerformanceAnalysisResult,
  ModuleBehaviorAnalysis,
  LoggerFactory,
  LoggerFactoryStatus
} from './interfaces.js';

// 常量定义
export { 
  DEFAULT_CONFIG,
  LOG_LEVEL_PRIORITY,
  FILE_LOG_CONSTANTS,
  CONSOLE_LOG_CONSTANTS,
  SENSITIVE_FIELDS,
  ERROR_CONSTANTS,
  MEMORY_CONSTANTS,
  QUERY_CONSTANTS,
  EXPORT_CONSTANTS,
  PERFORMANCE_CONSTANTS,
  ANALYSIS_CONSTANTS,
  FACTORY_CONSTANTS
} from './constants.js';

// 日志级别枚举
export { LogLevel } from './types.js';

// 主要实现类
export { UnifiedModuleLogger } from './UnifiedLogger.js';
export { LoggerFactoryImpl, getGlobalLoggerFactory, createLogger, getLogger, cleanupAllLoggers, CompatibilityLogger } from './LoggerFactory.js';