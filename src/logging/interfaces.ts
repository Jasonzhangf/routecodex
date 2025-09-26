/**
 * 统一日志系统接口定义
 *
 * 定义所有日志组件必须实现的接口契约
 */

import type {
  LogLevel,
  LogContext,
  UnifiedLogEntry,
  LoggerConfig,
  LogFilter,
  LogQueryResult,
  LogExportOptions,
  LogStats,
  LogAnalysisResult,
} from './types.js';

/**
 * 统一日志接口
 */
export interface UnifiedLogger {
  /**
   * 记录调试日志
   */
  debug(message: string, data?: any): void;

  /**
   * 记录信息日志
   */
  info(message: string, data?: any): void;

  /**
   * 记录警告日志
   */
  warn(message: string, data?: any): void;

  /**
   * 记录错误日志
   */
  error(message: string, error?: Error, data?: any): void;

  /**
   * 设置日志上下文
   */
  setContext(context: LogContext): void;

  /**
   * 更新日志上下文
   */
  updateContext(updates: Partial<LogContext>): void;

  /**
   * 清除日志上下文
   */
  clearContext(): void;

  /**
   * 获取当前日志上下文
   */
  getContext(): LogContext;

  /**
   * 获取日志历史记录
   */
  getHistory(limit?: number): UnifiedLogEntry[];

  /**
   * 查询日志
   */
  queryLogs(filter: LogFilter): Promise<LogQueryResult>;

  /**
   * 获取日志统计信息
   */
  getStats(): LogStats;

  /**
   * 导出日志
   */
  exportLogs(options: LogExportOptions): Promise<string>;

  /**
   * 分析日志
   */
  analyzeLogs(timeRange?: { start: number; end: number }): Promise<LogAnalysisResult>;

  /**
   * 刷新日志（写入磁盘）
   */
  flush(): Promise<void>;

  /**
   * 清理日志资源
   */
  cleanup(): Promise<void>;
}

/**
 * 日志写入器接口
 */
export interface LogWriter {
  /**
   * 写入日志条目
   */
  write(entry: UnifiedLogEntry): Promise<void>;

  /**
   * 批量写入日志条目
   */
  writeBatch(entries: UnifiedLogEntry[]): Promise<void>;

  /**
   * 刷新写入缓冲区
   */
  flush(): Promise<void>;

  /**
   * 关闭写入器
   */
  close(): Promise<void>;

  /**
   * 获取写入器状态
   */
  getStatus(): LogWriterStatus;
}

/**
 * 日志写入器状态
 */
export interface LogWriterStatus {
  /** 是否正在运行 */
  isActive: boolean;
  /** 已写入的日志数 */
  writtenCount: number;
  /** 错误数 */
  errorCount: number;
  /** 最后写入时间 */
  lastWriteTime?: number;
  /** 状态信息 */
  status: 'active' | 'error' | 'closed';
  /** 错误信息 */
  error?: string;
}

/**
 * 文件日志写入器接口
 */
export interface FileLogWriter extends LogWriter {
  /**
   * 获取当前日志文件路径
   */
  getCurrentFilePath(): string;

  /**
   * 获取所有日志文件列表
   */
  getLogFiles(): Promise<string[]>;

  /**
   * 轮转日志文件
   */
  rotate(): Promise<void>;

  /**
   * 清理旧日志文件
   */
  cleanup(maxAge?: number): Promise<void>;
}

/**
 * 控制台日志写入器接口
 */
export interface ConsoleLogWriter extends LogWriter {
  /**
   * 设置控制台输出样式
   */
  setStyle(style: ConsoleLogStyle): void;

  /**
   * 获取当前样式配置
   */
  getStyle(): ConsoleLogStyle;
}

/**
 * 控制台日志样式
 */
export interface ConsoleLogStyle {
  /** 是否启用颜色 */
  enableColors: boolean;
  /** 是否显示时间戳 */
  showTimestamp: boolean;
  /** 是否显示日志级别 */
  showLevel: boolean;
  /** 是否显示模块信息 */
  showModule: boolean;
  /** 时间格式 */
  timestampFormat: 'iso' | 'short' | 'unix';
  /** 最大消息长度 */
  maxMessageLength?: number;
}

/**
 * DebugCenter集成接口
 */
export interface DebugCenterLogWriter extends LogWriter {
  /**
   * 设置DebugCenter连接
   */
  setConnection(connection: any): void;

  /**
   * 获取连接状态
   */
  getConnectionStatus(): 'connected' | 'disconnected' | 'error';

  /**
   * 重新连接DebugCenter
   */
  reconnect(): Promise<void>;
}

/**
 * 日志解析器接口
 */
export interface LogParser {
  /**
   * 解析日志文件
   */
  parseFile(filePath: string): Promise<UnifiedLogEntry[]>;

  /**
   * 解析日志内容
   */
  parseContent(content: string): Promise<UnifiedLogEntry[]>;

  /**
   * 验证日志格式
   */
  validate(entry: any): entry is UnifiedLogEntry;

  /**
   * 获取解析器支持的格式
   */
  getSupportedFormats(): string[];
}

/**
 * 日志查询引擎接口
 */
export interface LogQueryEngine {
  /**
   * 查询日志
   */
  query(filter: LogFilter): Promise<LogQueryResult>;

  /**
   * 添加日志到索引
   */
  index(logs: UnifiedLogEntry[]): Promise<void>;

  /**
   * 从索引中移除日志
   */
  remove(index: string): Promise<void>;

  /**
   * 获取索引状态
   */
  getIndexStatus(): IndexStatus;

  /**
   * 优化索引
   */
  optimize(): Promise<void>;
}

/**
 * 索引状态
 */
export interface IndexStatus {
  /** 索引名称 */
  name: string;
  /** 文档数量 */
  documentCount: number;
  /** 索引大小 */
  size: number;
  /** 最后更新时间 */
  lastUpdate: number;
  /** 索引状态 */
  status: 'active' | 'optimizing' | 'error';
}

/**
 * 日志分析器接口
 */
export interface LogAnalyzer {
  /**
   * 分析日志统计信息
   */
  analyzeStats(logs: UnifiedLogEntry[]): LogStats;

  /**
   * 分析错误模式
   */
  analyzeErrors(logs: UnifiedLogEntry[]): ErrorAnalysisResult;

  /**
   * 分析性能趋势
   */
  analyzePerformance(logs: UnifiedLogEntry[]): PerformanceAnalysisResult;

  /**
   * 分析模块行为
   */
  analyzeModuleBehavior(logs: UnifiedLogEntry[], moduleId: string): ModuleBehaviorAnalysis;
}

/**
 * 错误分析结果
 */
export interface ErrorAnalysisResult {
  /** 总错误数 */
  totalErrors: number;
  /** 错误类型分布 */
  errorTypes: Record<string, number>;
  /** 错误趋势 */
  errorTrends: Array<{ time: number; count: number }>;
  /** 最常出错的模块 */
  topErrorModules: Array<{ moduleId: string; errorCount: number }>;
  /** 错误关联分析 */
  errorCorrelations: Array<{
    primaryError: string;
    relatedErrors: Array<{ error: string; correlation: number }>;
  }>;
}

/**
 * 性能分析结果
 */
export interface PerformanceAnalysisResult {
  /** 平均响应时间 */
  avgResponseTime: number;
  /** 响应时间分布 */
  responseTimeDistribution: Array<{ range: string; count: number; percentage: number }>;
  /** 响应时间趋势 */
  responseTimeTrends: Array<{ time: number; avgTime: number; p95Time: number; p99Time: number }>;
  /** 性能瓶颈 */
  bottlenecks: Array<{
    moduleId: string;
    avgDuration: number;
    maxDuration: number;
    impact: number;
    samples: number;
  }>;
  /** 内存使用趋势 */
  memoryTrends?: Array<{ time: number; avgUsage: number; maxUsage: number }>;
}

/**
 * 模块行为分析
 */
export interface ModuleBehaviorAnalysis {
  /** 模块ID */
  moduleId: string;
  /** 活跃度统计 */
  activityStats: {
    totalCalls: number;
    avgCallsPerHour: number;
    peakHours: number[];
    quietHours: number[];
  };
  /** 性能特征 */
  performanceProfile: {
    avgProcessingTime: number;
    reliability: number; // 0-1
    errorRate: number;
  };
  /** 依赖关系 */
  dependencies: Array<{
    dependentModule: string;
    callCount: number;
    avgLatency: number;
  }>;
  /** 异常行为检测 */
  anomalies: Array<{
    type: 'performance' | 'error' | 'pattern';
    description: string;
    severity: 'low' | 'medium' | 'high';
    timestamp: number;
  }>;
}

/**
 * Logger工厂接口
 */
export interface LoggerFactory {
  /**
   * 创建Logger实例
   */
  createLogger(config: LoggerConfig): UnifiedLogger;

  /**
   * 获取已创建的Logger
   */
  getLogger(moduleId: string): UnifiedLogger | undefined;

  /**
   * 获取所有已创建的Logger
   */
  getAllLoggers(): UnifiedLogger[];

  /**
   * 移除Logger
   */
  removeLogger(moduleId: string): void;

  /**
   * 清理所有Logger
   */
  cleanup(): Promise<void>;

  /**
   * 获取工厂状态
   */
  getFactoryStatus(): LoggerFactoryStatus;
}

/**
 * Logger工厂状态
 */
export interface LoggerFactoryStatus {
  /** 已创建的Logger数量 */
  loggerCount: number;
  /** 活跃Logger数量 */
  activeLoggers: number;
  /** 总日志条目数 */
  totalLogEntries: number;
  /** 内存使用量 */
  memoryUsage: number;
  /** 工厂状态 */
  status: 'active' | 'shutting_down' | 'shutdown';
}
