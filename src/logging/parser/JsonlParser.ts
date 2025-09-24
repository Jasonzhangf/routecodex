/**
 * JSONL日志解析器
 * 
 * 高效解析JSON Lines格式的日志文件
 */

import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import * as path from 'path';

import type { UnifiedLogEntry } from '../types.js';
import { LogLevel } from '../types.js';

/**
 * JSONL解析器配置
 */
export interface JsonlParserConfig {
  /** 批处理大小 */
  batchSize?: number;
  /** 最大行长度 */
  maxLineLength?: number;
  /** 跳过大文件 */
  skipLargeFiles?: boolean;
  /** 大文件阈值 (bytes) */
  largeFileThreshold?: number;
  /** 错误处理策略 */
  errorHandling?: 'skip' | 'include' | 'strict';
  /** 时间戳验证 */
  validateTimestamps?: boolean;
  /** 并行处理 */
  parallel?: boolean;
  /** 最大并发数 */
  maxConcurrency?: number;
}

/**
 * 解析进度
 */
export interface ParseProgress {
  /** 已处理的文件数 */
  filesProcessed: number;
  /** 总文件数 */
  totalFiles: number;
  /** 已处理的日志条目 */
  entriesProcessed: number;
  /** 有效的日志条目 */
  validEntries: number;
  /** 无效/错误的日志条目 */
  invalidEntries: number;
  /** 当前文件路径 */
  currentFile?: string;
  /** 当前文件进度 (0-1) */
  currentFileProgress?: number;
}

/**
 * 解析结果
 */
export interface ParseResult {
  /** 解析的日志条目 */
  entries: UnifiedLogEntry[];
  /** 错误信息 */
  errors: ParseError[];
  /** 解析统计 */
  stats: ParseStats;
  /** 解析耗时 */
  parseTime: number;
}

/**
 * 解析错误
 */
export interface ParseError {
  /** 文件路径 */
  filePath: string;
  /** 行号 */
  lineNumber: number;
  /** 错误类型 */
  errorType: 'invalid_json' | 'missing_timestamp' | 'invalid_level' | 'schema_validation' | 'other';
  /** 错误消息 */
  message: string;
  /** 原始内容 */
  rawContent?: string;
  /** 时间戳 */
  timestamp: number;
}

/**
 * 解析统计
 */
export interface ParseStats {
  /** 总文件数 */
  totalFiles: number;
  /** 成功文件数 */
  successfulFiles: number;
  /** 失败文件数 */
  failedFiles: number;
  /** 总行数 */
  totalLines: number;
  /** 有效条目数 */
  validEntries: number;
  /** 无效条目数 */
  invalidEntries: number;
  /** 跳过的条目数 */
  skippedEntries: number;
  /** 时间范围 */
  timeRange?: {
    start: number;
    end: number;
  };
  /** 模块分布 */
  moduleDistribution: Record<string, number>;
  /** 级别分布 */
  levelDistribution: Record<LogLevel, number>;
}

/**
 * JSONL日志解析器
 */
export class JsonlLogParser {
  private config: Required<JsonlParserConfig>;

  constructor(config: JsonlParserConfig = {}) {
    this.config = {
      batchSize: config.batchSize || 1000,
      maxLineLength: config.maxLineLength || 10000,
      skipLargeFiles: config.skipLargeFiles ?? false,
      largeFileThreshold: config.largeFileThreshold || 100 * 1024 * 1024, // 100MB
      errorHandling: config.errorHandling || 'skip',
      validateTimestamps: config.validateTimestamps ?? true,
      parallel: config.parallel ?? false,
      maxConcurrency: config.maxConcurrency || 5
    };
  }

  /**
   * 解析日志文件
   */
  async parseFile(filePath: string): Promise<UnifiedLogEntry[]> {
    const result = await this.parseFiles([filePath]);
    return result.entries;
  }

  /**
   * 解析多个日志文件
   */
  async parseFiles(filePaths: string[]): Promise<ParseResult> {
    const startTime = Date.now();
    const allEntries: UnifiedLogEntry[] = [];
    const allErrors: ParseError[] = [];
    let totalStats: ParseStats = this.createEmptyStats();

    console.log(`📖 开始解析 ${filePaths.length} 个日志文件...`);

    if (this.config.parallel) {
      // 并行处理
      const results = await this.parseFilesParallel(filePaths);
      
      for (const result of results) {
        allEntries.push(...result.entries);
        allErrors.push(...result.errors);
        totalStats = this.mergeStats(totalStats, result.stats);
      }
    } else {
      // 串行处理
      for (let i = 0; i < filePaths.length; i++) {
        const filePath = filePaths[i];
        
        console.log(`  解析文件 ${i + 1}/${filePaths.length}: ${path.basename(filePath)}`);
        
        try {
          const result = await this.parseSingleFile(filePath);
          allEntries.push(...result.entries);
          allErrors.push(...result.errors);
          totalStats = this.mergeStats(totalStats, result.stats);
        } catch (error) {
          console.error(`解析文件失败 ${filePath}:`, error);
          totalStats.failedFiles++;
        }
      }
    }

    // 排序（按时间戳）
    allEntries.sort((a, b) => a.timestamp - b.timestamp);

    const parseTime = Date.now() - startTime;
    
    console.log(`✅ 解析完成，处理 ${allEntries.length} 条日志，耗时: ${parseTime}ms`);
    console.log(`   有效条目: ${totalStats.validEntries}, 无效条目: ${totalStats.invalidEntries}`);

    return {
      entries: allEntries,
      errors: allErrors,
      stats: totalStats,
      parseTime
    };
  }

  /**
   * 解析日志内容
   */
  async parseContent(content: string): Promise<UnifiedLogEntry[]> {
    const lines = content.split('\n').filter(line => line.trim());
    const entries: UnifiedLogEntry[] = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const entry = this.parseLine(line, 'content', i + 1);
      
      if (entry) {
        entries.push(entry);
      }
    }
    
    return entries;
  }

  /**
   * 验证日志格式
   */
  validate(entry: any): entry is UnifiedLogEntry {
    if (!entry || typeof entry !== 'object') {
      return false;
    }
    
    // 检查必需字段
    if (!entry.timestamp || !entry.level || !entry.moduleId || !entry.moduleType) {
      return false;
    }
    
    // 检查日志级别
    if (!Object.values(LogLevel).includes(entry.level)) {
      return false;
    }
    
    // 检查时间戳
    if (this.config.validateTimestamps) {
      if (typeof entry.timestamp !== 'number' || entry.timestamp <= 0) {
        return false;
      }
      
      // 时间戳应该在合理范围内（过去1年到未来1小时）
      const now = Date.now();
      const oneYearAgo = now - 365 * 24 * 60 * 60 * 1000;
      const oneHourLater = now + 60 * 60 * 1000;
      
      if (entry.timestamp < oneYearAgo || entry.timestamp > oneHourLater) {
        return false;
      }
    }
    
    return true;
  }

  /**
   * 解析单个文件
   */
  private async parseSingleFile(filePath: string): Promise<ParseResult> {
    const startTime = Date.now();
    const entries: UnifiedLogEntry[] = [];
    const errors: ParseError[] = [];
    const stats = this.createEmptyStats();
    
    stats.totalFiles++;
    
    try {
      // 检查文件大小
      const fileStats = await this.getFileStats(filePath);
      if (!fileStats) {
        throw new Error('无法获取文件信息');
      }
      
      if (this.config.skipLargeFiles && fileStats.size > this.config.largeFileThreshold) {
        console.warn(`跳过文件: ${filePath} (大小: ${fileStats.size} bytes)`);
        stats.skippedEntries += Math.floor(fileStats.size / 200); // 估算
        return { entries, errors, stats, parseTime: Date.now() - startTime };
      }
      
      // 读取并解析文件
      await this.parseFileStream(filePath, entries, errors, stats);
      
      stats.successfulFiles++;
      
    } catch (error) {
      console.error(`解析文件失败 ${filePath}:`, error);
      stats.failedFiles++;
      errors.push({
        filePath,
        lineNumber: 0,
        errorType: 'other',
        message: error instanceof Error ? error.message : String(error),
        timestamp: Date.now()
      });
    }
    
    const parseTime = Date.now() - startTime;
    return { entries, errors, stats, parseTime };
  }

  /**
   * 解析文件流
   */
  private async parseFileStream(
    filePath: string,
    entries: UnifiedLogEntry[],
    errors: ParseError[],
    stats: ParseStats
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const fileStream = createReadStream(filePath, { encoding: 'utf8' });
      const rl = createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });

      let lineNumber = 0;
      let batch: string[] = [];

      rl.on('line', (line) => {
        lineNumber++;
        stats.totalLines++;

        // 跳过空行
        if (!line.trim()) {
          return;
        }

        // 检查行长度
        if (line.length > this.config.maxLineLength) {
          if (this.config.errorHandling === 'skip') {
            stats.invalidEntries++;
            return;
          } else if (this.config.errorHandling === 'strict') {
            errors.push({
              filePath,
              lineNumber,
              errorType: 'other',
              message: `Line too long: ${line.length} > ${this.config.maxLineLength}`,
              rawContent: line.substring(0, 100),
              timestamp: Date.now()
            });
            return;
          }
        }

        batch.push(line);

        // 批量处理
        if (batch.length >= this.config.batchSize) {
          this.processBatch(batch, filePath, lineNumber - batch.length + 1, entries, errors, stats);
          batch = [];
        }
      });

      rl.on('close', () => {
        // 处理剩余的批次
        if (batch.length > 0) {
          this.processBatch(batch, filePath, lineNumber - batch.length + 1, entries, errors, stats);
        }
        resolve();
      });

      rl.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * 处理批次
   */
  private processBatch(
    lines: string[],
    filePath: string,
    startLineNumber: number,
    entries: UnifiedLogEntry[],
    errors: ParseError[],
    stats: ParseStats
  ): void {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = startLineNumber + i;
      
      const entry = this.parseLine(line, filePath, lineNumber);
      
      if (entry) {
        entries.push(entry);
        stats.validEntries++;
        
        // 更新统计信息
        this.updateStats(entry, stats);
      } else {
        stats.invalidEntries++;
      }
    }
  }

  /**
   * 解析单行
   */
  private parseLine(line: string, filePath: string, lineNumber: number): UnifiedLogEntry | null {
    try {
      const parsed = JSON.parse(line);
      
      if (!this.validate(parsed)) {
        this.handleValidationError(line, filePath, lineNumber, 'schema_validation');
        return null;
      }
      
      return parsed as UnifiedLogEntry;
      
    } catch (error) {
      // JSON解析错误
      if (error instanceof SyntaxError) {
        this.handleValidationError(line, filePath, lineNumber, 'invalid_json', error.message);
      } else {
        this.handleValidationError(line, filePath, lineNumber, 'other', String(error));
      }
      return null;
    }
  }

  /**
   * 处理验证错误
   */
  private handleValidationError(
    line: string,
    filePath: string,
    lineNumber: number,
    errorType: ParseError['errorType'],
    message?: string
  ): void {
    const error: ParseError = {
      filePath,
      lineNumber,
      errorType,
      message: message || `Validation failed for ${errorType}`,
      rawContent: line.substring(0, 200),
      timestamp: Date.now()
    };

    if (this.config.errorHandling === 'strict') {
      throw new Error(`Parse error at ${filePath}:${lineNumber} - ${error.message}`);
    } else if (this.config.errorHandling === 'include') {
      // 在严格模式下会抛出错误，这里简化处理
      console.warn(`解析错误: ${filePath}:${lineNumber} - ${error.message}`);
    }
  }

  /**
   * 更新统计信息
   */
  private updateStats(entry: UnifiedLogEntry, stats: ParseStats): void {
    // 模块分布
    if (!stats.moduleDistribution[entry.moduleId]) {
      stats.moduleDistribution[entry.moduleId] = 0;
    }
    stats.moduleDistribution[entry.moduleId]++;
    
    // 级别分布
    stats.levelDistribution[entry.level]++;
    
    // 时间范围
    if (!stats.timeRange) {
      stats.timeRange = {
        start: entry.timestamp,
        end: entry.timestamp
      };
    } else {
      stats.timeRange.start = Math.min(stats.timeRange.start, entry.timestamp);
      stats.timeRange.end = Math.max(stats.timeRange.end, entry.timestamp);
    }
  }

  /**
   * 并行解析多个文件
   */
  private async parseFilesParallel(filePaths: string[]): Promise<ParseResult[]> {
    const chunks = this.chunkArray(filePaths, this.config.maxConcurrency);
    const results: ParseResult[] = [];
    
    for (const chunk of chunks) {
      const chunkPromises = chunk.map(filePath => this.parseSingleFile(filePath));
      const chunkResults = await Promise.all(chunkPromises);
      results.push(...chunkResults);
    }
    
    return results;
  }

  /**
   * 分块数组
   */
  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  /**
   * 创建空的统计信息
   */
  private createEmptyStats(): ParseStats {
    return {
      totalFiles: 0,
      successfulFiles: 0,
      failedFiles: 0,
      totalLines: 0,
      validEntries: 0,
      invalidEntries: 0,
      skippedEntries: 0,
      moduleDistribution: {},
      levelDistribution: {
        [LogLevel.DEBUG]: 0,
        [LogLevel.INFO]: 0,
        [LogLevel.WARN]: 0,
        [LogLevel.ERROR]: 0
      }
    };
  }

  /**
   * 合并统计信息
   */
  private mergeStats(stats1: ParseStats, stats2: ParseStats): ParseStats {
    const merged: ParseStats = {
      totalFiles: stats1.totalFiles + stats2.totalFiles,
      successfulFiles: stats1.successfulFiles + stats2.successfulFiles,
      failedFiles: stats1.failedFiles + stats2.failedFiles,
      totalLines: stats1.totalLines + stats2.totalLines,
      validEntries: stats1.validEntries + stats2.validEntries,
      invalidEntries: stats1.invalidEntries + stats2.invalidEntries,
      skippedEntries: stats1.skippedEntries + stats2.skippedEntries,
      moduleDistribution: { ...stats1.moduleDistribution },
      levelDistribution: {
        [LogLevel.DEBUG]: stats1.levelDistribution[LogLevel.DEBUG] + stats2.levelDistribution[LogLevel.DEBUG],
        [LogLevel.INFO]: stats1.levelDistribution[LogLevel.INFO] + stats2.levelDistribution[LogLevel.INFO],
        [LogLevel.WARN]: stats1.levelDistribution[LogLevel.WARN] + stats2.levelDistribution[LogLevel.WARN],
        [LogLevel.ERROR]: stats1.levelDistribution[LogLevel.ERROR] + stats2.levelDistribution[LogLevel.ERROR]
      }
    };

    // 合并模块分布
    for (const [moduleId, count] of Object.entries(stats2.moduleDistribution)) {
      merged.moduleDistribution[moduleId] = (merged.moduleDistribution[moduleId] || 0) + count;
    }

    // 合并时间范围
    if (stats1.timeRange && stats2.timeRange) {
      merged.timeRange = {
        start: Math.min(stats1.timeRange.start, stats2.timeRange.start),
        end: Math.max(stats1.timeRange.end, stats2.timeRange.end)
      };
    } else if (stats1.timeRange) {
      merged.timeRange = stats1.timeRange;
    } else if (stats2.timeRange) {
      merged.timeRange = stats2.timeRange;
    }

    return merged;
  }

  /**
   * 获取文件统计信息
   */
  private async getFileStats(filePath: string): Promise<{
    size: number;
    isFile: boolean;
  } | null> {
    try {
      const fs = await import('fs');
      const stats = await fs.promises.stat(filePath);
      return {
        size: stats.size,
        isFile: stats.isFile()
      };
    } catch (error) {
      return null;
    }
  }
}

/**
 * 便捷的解析函数
 */
export async function parseLogFiles(
  filePaths: string[],
  config?: JsonlParserConfig
): Promise<ParseResult> {
  const parser = new JsonlLogParser(config);
  return parser.parseFiles(filePaths);
}

/**
 * 解析单个日志文件
 */
export async function parseLogFile(
  filePath: string,
  config?: JsonlParserConfig
): Promise<UnifiedLogEntry[]> {
  const parser = new JsonlLogParser(config);
  return parser.parseFile(filePath);
}