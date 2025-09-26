/**
 * UnifiedLogger 核心实现类 - 简化版本
 *
 * 提供统一的日志记录功能，支持多种输出方式和历史记录管理
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

import { LogLevel } from './types.js';

import type {
  LogContext,
  UnifiedLogEntry,
  LogError,
  LogFilter,
  LogQueryResult,
  LogExportOptions,
  LogStats,
  LogAnalysisResult,
  LoggerConfig,
} from './types.js';

import type { UnifiedLogger, LogWriterStatus } from './interfaces.js';

import {
  DEFAULT_CONFIG,
  LOG_LEVEL_PRIORITY,
  CONSOLE_LOG_CONSTANTS,
  FILE_LOG_CONSTANTS,
  SENSITIVE_FIELDS,
  ERROR_CONSTANTS,
} from './constants.js';

/**
 * UnifiedLogger 实现类
 */
export class UnifiedModuleLogger extends EventEmitter implements UnifiedLogger {
  private config: Required<LoggerConfig>;
  private context: LogContext = {};
  private history: UnifiedLogEntry[] = [];
  private flushTimer?: NodeJS.Timeout;
  private stats: LogStats;

  constructor(config: LoggerConfig) {
    super();

    // 合并默认配置
    this.config = {
      moduleId: config.moduleId,
      moduleType: config.moduleType,
      logLevel: config.logLevel || DEFAULT_CONFIG.LOG_LEVEL,
      enableConsole: config.enableConsole ?? DEFAULT_CONFIG.ENABLE_CONSOLE,
      enableFile: config.enableFile ?? DEFAULT_CONFIG.ENABLE_FILE,
      enableDebugCenter: config.enableDebugCenter ?? DEFAULT_CONFIG.ENABLE_DEBUG_CENTER,
      maxHistory: config.maxHistory || DEFAULT_CONFIG.MAX_HISTORY,
      logDirectory: config.logDirectory || DEFAULT_CONFIG.LOG_DIRECTORY,
      maxFileSize: config.maxFileSize || DEFAULT_CONFIG.MAX_FILE_SIZE,
      maxFiles: config.maxFiles || DEFAULT_CONFIG.MAX_FILES,
      enableCompression: config.enableCompression ?? DEFAULT_CONFIG.ENABLE_COMPRESSION,
      sensitiveFields: [...(config.sensitiveFields || SENSITIVE_FIELDS.DEFAULT)],
    };

    // 初始化统计信息
    this.stats = {
      totalLogs: 0,
      levelCounts: {
        [LogLevel.DEBUG]: 0,
        [LogLevel.INFO]: 0,
        [LogLevel.WARN]: 0,
        [LogLevel.ERROR]: 0,
      },
      errorCount: 0,
    };

    // 设置定时器
    this.setupTimers();

    this.emit('initialized', { moduleId: config.moduleId });
  }

  private setupTimers(): void {
    // 定期刷新缓冲区
    this.flushTimer = setInterval(() => {
      this.flush().catch(error => {
        console.error('Failed to flush logs:', error);
      });
    }, 10000); // 10秒
  }

  // UnifiedLogger接口实现
  debug(message: string, data?: any): void {
    this.writeLog(LogLevel.DEBUG, message, data);
  }

  info(message: string, data?: any): void {
    this.writeLog(LogLevel.INFO, message, data);
  }

  warn(message: string, data?: any): void {
    this.writeLog(LogLevel.WARN, message, data);
  }

  error(message: string, error?: Error, data?: any): void {
    this.writeLog(LogLevel.ERROR, message, data, error);
  }

  setContext(context: LogContext): void {
    this.context = { ...context };
  }

  updateContext(updates: Partial<LogContext>): void {
    this.context = { ...this.context, ...updates };
  }

  clearContext(): void {
    this.context = {};
  }

  getContext(): LogContext {
    return { ...this.context };
  }

  getHistory(limit?: number): UnifiedLogEntry[] {
    const logs = limit ? this.history.slice(-limit) : [...this.history];
    return logs.map(log => ({ ...log })); // 返回副本
  }

  async queryLogs(filter: LogFilter): Promise<LogQueryResult> {
    const startTime = Date.now();
    let filteredLogs = [...this.history];

    // 应用过滤器
    if (filter.timeRange) {
      filteredLogs = filteredLogs.filter(
        log => log.timestamp >= filter.timeRange!.start && log.timestamp <= filter.timeRange!.end
      );
    }

    if (filter.levels && filter.levels.length > 0) {
      filteredLogs = filteredLogs.filter(log => filter.levels!.includes(log.level));
    }

    if (filter.moduleIds && filter.moduleIds.length > 0) {
      filteredLogs = filteredLogs.filter(log => filter.moduleIds!.includes(log.moduleId));
    }

    if (filter.keyword) {
      const keyword = filter.keyword.toLowerCase();
      filteredLogs = filteredLogs.filter(
        log =>
          log.message.toLowerCase().includes(keyword) ||
          (log.data && JSON.stringify(log.data).toLowerCase().includes(keyword))
      );
    }

    if (filter.hasError !== undefined) {
      filteredLogs = filteredLogs.filter(log => (filter.hasError ? !!log.error : !log.error));
    }

    // 分页
    const total = filteredLogs.length;
    const offset = filter.offset || 0;
    const limit = filter.limit || total;
    const logs = filteredLogs.slice(offset, offset + limit);

    return {
      logs,
      total,
      filter,
      queryTime: Date.now() - startTime,
    };
  }

  /**
   * 获取模块ID
   */
  getModuleId(): string {
    return this.config.moduleId;
  }

  /**
   * 更新日志级别
   */
  updateLogLevel(newLevel: LogLevel): void {
    const oldLevel = this.config.logLevel;
    this.config.logLevel = newLevel;

    this.emit('log_level_changed', {
      moduleId: this.config.moduleId,
      oldLevel,
      newLevel,
      timestamp: Date.now(),
    });

    console.log(`📝 Logger [${this.config.moduleId}] 日志级别已从 ${oldLevel} 更新为 ${newLevel}`);
  }

  /**
   * 获取Logger统计信息
   */
  getStats(): LogStats {
    return { ...this.stats };
  }

  async exportLogs(options: LogExportOptions): Promise<string> {
    // 实现导出逻辑
    const filter = options.filter || {};
    const result = await this.queryLogs(filter);

    switch (options.format) {
      case 'json':
        return JSON.stringify(result.logs, null, 2);
      case 'jsonl':
        return result.logs.map(log => JSON.stringify(log)).join('\n');
      case 'csv':
        return this.convertToCSV(result.logs, options.fields);
      default:
        throw new Error(`Unsupported export format: ${options.format}`);
    }
  }

  async analyzeLogs(timeRange?: { start: number; end: number }): Promise<LogAnalysisResult> {
    const filter: LogFilter = {};
    if (timeRange) {
      filter.timeRange = timeRange;
    }

    const result = await this.queryLogs(filter);

    return {
      timeRange: {
        start: Math.min(...result.logs.map(log => log.timestamp)),
        end: Math.max(...result.logs.map(log => log.timestamp)),
      },
      overallStats: this.calculateStats(result.logs),
      moduleStats: this.calculateModuleStats(result.logs),
      errorAnalysis: this.analyzeErrors(result.logs),
      performanceAnalysis: this.analyzePerformance(result.logs),
    };
  }

  async flush(): Promise<void> {
    this.emit('flushed');
  }

  async cleanup(): Promise<void> {
    // 清除定时器
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }

    await this.flush();
    this.emit('cleanup_completed');
  }

  private writeLog(level: LogLevel, message: string, data?: any, error?: Error): void {
    // 检查日志级别
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.config.logLevel]) {
      return;
    }

    const sanitizedData = this.sanitizeData(data);
    const formattedError = error ? this.formatError(error) : undefined;

    // 添加性能指标和内存使用
    const memUsage = process.memoryUsage();
    const currentMemoryUsage = memUsage.heapUsed;

    let duration: number | undefined;
    if (data && typeof data === 'object' && data.duration) {
      duration = data.duration;
    }

    const entry: UnifiedLogEntry = {
      timestamp: Date.now(),
      level,
      moduleId: this.config.moduleId,
      moduleType: this.config.moduleType,
      ...this.context,
      message: this.standardizeMessage(message),
      data: sanitizedData,
      error: formattedError,
      duration,
      memoryUsage: currentMemoryUsage,
      tags: this.generateTags(level, message, sanitizedData),
      version: '0.0.1',
    };

    // 添加到内存历史
    this.history.push(entry);
    if (this.history.length > this.config.maxHistory) {
      this.history.shift();
    }

    // 更新统计信息
    this.updateStats(entry);

    // 写入控制台
    if (this.config.enableConsole) {
      this.writeToConsole(entry);
    }

    this.emit('log_written', entry);
  }

  private sanitizeData(data: any): any {
    if (!data) {
      return data;
    }

    try {
      const sanitized = JSON.parse(JSON.stringify(data));
      return this.removeSensitiveData(sanitized);
    } catch (error) {
      return { error: 'Failed to sanitize data', originalType: typeof data };
    }
  }

  private removeSensitiveData(obj: any): any {
    if (typeof obj !== 'object' || obj === null) {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.removeSensitiveData(item));
    }

    const sanitized: any = {};
    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      if (this.config.sensitiveFields.some(field => lowerKey.includes(field.toLowerCase()))) {
        sanitized[key] = SENSITIVE_FIELDS.REDACTED_VALUE;
      } else {
        sanitized[key] = this.removeSensitiveData(value);
      }
    }

    return sanitized;
  }

  private formatError(error: Error): LogError {
    return {
      name: error.name,
      message: error.message.substring(0, 500),
      stack: error.stack?.substring(0, 2000),
      code: (error as any).code,
    };
  }

  private standardizeMessage(message: string): string {
    return message.trim().substring(0, 10000);
  }

  private generateTags(level: LogLevel, message: string, data?: any): string[] {
    const tags: string[] = [level];

    // 基于消息内容生成标签
    const lowerMessage = message.toLowerCase();
    if (lowerMessage.includes('error') || lowerMessage.includes('failed')) {
      tags.push('error');
    }
    if (lowerMessage.includes('timeout')) {
      tags.push('timeout');
    }
    if (lowerMessage.includes('retry')) {
      tags.push('retry');
    }

    return tags;
  }

  private updateStats(entry: UnifiedLogEntry): void {
    this.stats.totalLogs++;
    this.stats.levelCounts[entry.level]++;
    if (entry.error) {
      this.stats.errorCount++;
    }

    this.stats.earliestLog = Math.min(this.stats.earliestLog || entry.timestamp, entry.timestamp);
    this.stats.latestLog = Math.max(this.stats.latestLog || entry.timestamp, entry.timestamp);
  }

  private writeToConsole(entry: UnifiedLogEntry): void {
    const timestamp = new Date(entry.timestamp).toISOString();
    const levelStr = entry.level.toUpperCase().padEnd(5);
    const moduleInfo = `[${entry.moduleId}]`;

    let output = `${timestamp} [${levelStr}] ${moduleInfo} ${entry.message}`;

    if (entry.data) {
      output += ` ${JSON.stringify(entry.data)}`;
    }

    if (entry.error) {
      output += ` ERROR: ${entry.error.message}`;
    }

    console.log(output);
  }

  private convertToCSV(logs: UnifiedLogEntry[], fields?: string[]): string {
    const headers = fields || ['timestamp', 'level', 'moduleId', 'message', 'data'];
    const rows = [headers.join(',')];

    for (const log of logs) {
      const row = headers.map(field => {
        const value = (log as any)[field];
        if (value === undefined || value === null) {
          return '';
        }
        if (typeof value === 'object') {
          return JSON.stringify(value);
        }
        return String(value);
      });
      rows.push(row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(','));
    }

    return rows.join('\n');
  }

  private calculateStats(logs: UnifiedLogEntry[]): LogStats {
    const stats: LogStats = {
      totalLogs: logs.length,
      levelCounts: {
        [LogLevel.DEBUG]: 0,
        [LogLevel.INFO]: 0,
        [LogLevel.WARN]: 0,
        [LogLevel.ERROR]: 0,
      },
      errorCount: 0,
    };

    for (const log of logs) {
      stats.levelCounts[log.level]++;
      if (log.error) {
        stats.errorCount++;
      }
    }

    return stats;
  }

  private calculateModuleStats(logs: UnifiedLogEntry[]): Record<string, LogStats> {
    const moduleStats: Record<string, LogStats> = {};

    for (const log of logs) {
      if (!moduleStats[log.moduleId]) {
        moduleStats[log.moduleId] = {
          totalLogs: 0,
          levelCounts: {
            [LogLevel.DEBUG]: 0,
            [LogLevel.INFO]: 0,
            [LogLevel.WARN]: 0,
            [LogLevel.ERROR]: 0,
          },
          errorCount: 0,
        };
      }

      const stats = moduleStats[log.moduleId];
      stats.totalLogs++;
      stats.levelCounts[log.level]++;
      if (log.error) {
        stats.errorCount++;
      }
    }

    return moduleStats;
  }

  private analyzeErrors(logs: UnifiedLogEntry[]) {
    const errors = logs.filter(log => log.error);
    const errorTypes: Record<string, number> = {};

    for (const log of errors) {
      const errorType = log.error!.code || log.error!.name;
      errorTypes[errorType] = (errorTypes[errorType] || 0) + 1;
    }

    return {
      totalErrors: errors.length,
      errorTypes,
      errorTrends: [], // 简化实现
    };
  }

  private analyzePerformance(logs: UnifiedLogEntry[]) {
    const perfLogs = logs.filter(log => log.duration);

    if (perfLogs.length === 0) {
      return undefined;
    }

    const avgResponseTime =
      perfLogs.reduce((sum, log) => sum + (log.duration || 0), 0) / perfLogs.length;

    return {
      avgResponseTime,
      responseTimeTrends: [], // 简化实现
      bottlenecks: [], // 简化实现
    };
  }
}
