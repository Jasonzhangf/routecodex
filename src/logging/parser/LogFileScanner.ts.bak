/**
 * 日志文件扫描器
 * 
 * 自动发现和扫描日志文件，支持按时间范围和模块类型筛选
 */

import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { createReadStream } from 'fs';
// import { createInterface } from 'readline';

// import type { LogFilter } from '../types.js';
// import { FILE_LOG_CONSTANTS, QUERY_CONSTANTS } from '../constants.js';

/**
 * 日志文件信息
 */
export interface LogFileInfo {
  /** 文件路径 */
  filePath: string;
  /** 文件大小 (bytes) */
  fileSize: number;
  /** 创建时间 */
  createdTime: number;
  /** 修改时间 */
  modifiedTime: number;
  /** 模块ID */
  moduleId: string;
  /** 文件类型 */
  fileType: 'log' | 'compressed';
  /** 预估日志条目数 */
  estimatedEntries: number;
  /** 时间范围 */
  timeRange?: {
    start: number;
    end: number;
  };
}

/**
 * 扫描选项
 */
export interface LogScannerOptions {
  /** 扫描目录 */
  scanDirectory?: string;
  /** 文件扩展名 */
  fileExtensions?: string[];
  /** 递归扫描 */
  recursive?: boolean;
  /** 模块ID过滤 */
  moduleIds?: string[];
  /** 时间范围过滤 */
  timeRange?: {
    start: number;
    end: number;
  };
  /** 最大文件大小 */
  maxFileSize?: number;
  /** 是否包含压缩文件 */
  includeCompressed?: boolean;
  /** 扫描深度限制 */
  maxDepth?: number;
}

/**
 * 扫描结果
 */
export interface LogScanResult {
  /** 发现的日志文件 */
  files: LogFileInfo[];
  /** 总文件数 */
  totalFiles: number;
  /** 总大小 (bytes) */
  totalSize: number;
  /** 扫描耗时 (ms) */
  scanTime: number;
  /** 时间范围 */
  timeRange: {
    start: number;
    end: number;
  };
  /** 模块统计 */
  moduleStats: Record<string, {
    fileCount: number;
    totalSize: number;
    timeRange: { start: number; end: number };
  }>;
}

/**
 * 日志文件扫描器
 */
export class LogFileScanner {
  private options: Required<LogScannerOptions>;

  constructor(options: LogScannerOptions = {}) {
    this.options = {
      scanDirectory: options.scanDirectory || './logs',
      fileExtensions: options.fileExtensions || ['.jsonl'],
      recursive: options.recursive ?? true,
      moduleIds: options.moduleIds || [],
      timeRange: options.timeRange || { start: 0, end: Date.now() },
      maxFileSize: options.maxFileSize || 2592000 * 10, // 默认30天数据 (30 * 24 * 60 * 60 * 1000 * 10)
      includeCompressed: options.includeCompressed ?? true,
      maxDepth: options.maxDepth ?? 10
    };
  }

  /**
   * 扫描日志文件
   */
  async scan(): Promise<LogScanResult> {
    const startTime = Date.now();
    
    console.log(`🔍 开始扫描日志文件，目录: ${this.options.scanDirectory}`);
    
    const files = await this.findLogFiles();
    const filteredFiles = await this.filterFiles(files);
    const enrichedFiles = await this.enrichFileInfo(filteredFiles);
    
    const scanTime = Date.now() - startTime;
    
    console.log(`✅ 扫描完成，发现 ${enrichedFiles.length} 个日志文件，耗时: ${scanTime}ms`);
    
    return this.buildScanResult(enrichedFiles, scanTime);
  }

  /**
   * 查找日志文件
   */
  private async findLogFiles(): Promise<string[]> {
    const files: string[] = [];
    
    try {
      await this.scanDirectory(this.options.scanDirectory, files, 0);
    } catch (error) {
      console.error('扫描目录失败:', error);
    }
    
    return files;
  }

  /**
   * 递归扫描目录
   */
  private async scanDirectory(dirPath: string, files: string[], depth: number): Promise<void> {
    if (depth > this.options.maxDepth) {
      return;
    }

    try {
      const entries = await promisify(fs.readdir)(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        
        if (entry.isDirectory() && this.options.recursive) {
          await this.scanDirectory(fullPath, files, depth + 1);
        } else if (entry.isFile()) {
          if (this.isLogFile(entry.name)) {
            files.push(fullPath);
          }
        }
      }
    } catch (error) {
      console.warn(`无法访问目录 ${dirPath}:`, error);
    }
  }

  /**
   * 判断是否为日志文件
   */
  private isLogFile(fileName: string): boolean {
    const ext = path.extname(fileName).toLowerCase();
    
    // 检查基本扩展名
    if (this.options.fileExtensions.includes(ext)) {
      return true;
    }
    
    // 检查压缩文件
    if (this.options.includeCompressed) {
      if (ext === '.gz' || ext === '.zip') {
        const baseName = path.basename(fileName, ext);
        const innerExt = path.extname(baseName).toLowerCase();
        return this.options.fileExtensions.includes(innerExt);
      }
    }
    
    return false;
  }

  /**
   * 过滤文件
   */
  private async filterFiles(filePaths: string[]): Promise<string[]> {
    const filtered: string[] = [];
    
    for (const filePath of filePaths) {
      try {
        const stats = await promisify(fs.stat)(filePath);
        
        // 检查文件大小
        if (stats.size > this.options.maxFileSize) {
          console.warn(`跳过大文件: ${filePath} (${stats.size} bytes)`);
          continue;
        }
        
        // 检查模块ID（从文件名提取）
        if (this.options.moduleIds.length > 0) {
          const moduleId = this.extractModuleId(filePath);
          if (!this.options.moduleIds.includes(moduleId)) {
            continue;
          }
        }
        
        filtered.push(filePath);
      } catch (error) {
        console.warn(`无法访问文件 ${filePath}:`, error);
      }
    }
    
    return filtered;
  }

  /**
   * 丰富文件信息
   */
  private async enrichFileInfo(filePaths: string[]): Promise<LogFileInfo[]> {
    const enriched: LogFileInfo[] = [];
    
    console.log(`🔍 正在分析 ${filePaths.length} 个日志文件...`);
    
    for (let i = 0; i < filePaths.length; i++) {
      const filePath = filePaths[i];
      
      if (i % 10 === 0) {
        console.log(`  进度: ${i}/${filePaths.length}`);
      }
      
      try {
        const fileInfo = await this.analyzeFile(filePath);
        if (fileInfo) {
          enriched.push(fileInfo);
        }
      } catch (error) {
        console.warn(`分析文件失败 ${filePath}:`, error);
      }
    }
    
    return enriched;
  }

  /**
   * 分析单个文件
   */
  private async analyzeFile(filePath: string): Promise<LogFileInfo | null> {
    try {
      const stats = await promisify(fs.stat)(filePath);
      const moduleId = this.extractModuleId(filePath);
      const fileType = this.getFileType(filePath);
      
      // 预估条目数和时间范围
      const analysis = await this.estimateFileContent(filePath);
      
      return {
        filePath,
        fileSize: stats.size,
        createdTime: stats.birthtime.getTime(),
        modifiedTime: stats.mtime.getTime(),
        moduleId,
        fileType,
        estimatedEntries: analysis.entryCount,
        timeRange: analysis.timeRange
      };
    } catch (error) {
      console.warn(`无法分析文件 ${filePath}:`, error);
      return null;
    }
  }

  /**
   * 从文件路径提取模块ID
   */
  private extractModuleId(filePath: string): string {
    const fileName = path.basename(filePath);
    
    // 格式: moduleId-timestamp.jsonl
    const match = fileName.match(/^([^-]+)-/);
    if (match) {
      return match[1];
    }
    
    // 如果没有匹配到，使用文件名（不含扩展名）
    return path.basename(fileName, path.extname(fileName));
  }

  /**
   * 获取文件类型
   */
  private getFileType(filePath: string): 'log' | 'compressed' {
    const ext = path.extname(filePath).toLowerCase();
    return ext === '.gz' || ext === '.zip' ? 'compressed' : 'log';
  }

  /**
   * 预估文件内容
   */
  private async estimateFileContent(filePath: string): Promise<{
    entryCount: number;
    timeRange?: { start: number; end: number };
  }> {
    try {
      const stats = await promisify(fs.stat)(filePath);
      
      // 简单的预估：假设平均每条日志约200字节
      const estimatedEntries = Math.floor(stats.size / 200);
      
      // 对于小文件，尝试读取样本进行更准确的分析
      if (stats.size < 1024 * 1024) { // 小于1MB
        return await this.analyzeFileSample(filePath);
      }
      
      return {
        entryCount: estimatedEntries
      };
    } catch (error) {
      return {
        entryCount: 0
      };
    }
  }

  /**
   * 分析文件样本
   */
  private async analyzeFileSample(filePath: string): Promise<{
    entryCount: number;
    timeRange?: { start: number; end: number };
  }> {
    const entryCount = await this.countLines(filePath);
    const timeRange = await this.extractTimeRange(filePath);
    
    return {
      entryCount,
      timeRange
    };
  }

  /**
   * 计算文件行数
   */
  private async countLines(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      let count = 0;
      const stream = createReadStream(filePath);
      
      stream.on('data', (chunk) => {
        for (let i = 0; i < chunk.length; i++) {
          if (chunk[i] === 10) {count++;} // 

        }
      });
      
      stream.on('end', () => resolve(count));
      stream.on('error', reject);
    });
  }

  /**
   * 提取时间范围
   */
  private async extractTimeRange(filePath: string): Promise<{ start: number; end: number } | undefined> {
    try {
      // 读取文件的前几行和最后几行来提取时间范围
      const firstLines = await this.readLines(filePath, 5);
      const lastLines = await this.readLinesFromEnd(filePath, 5);
      
      const firstTimestamp = this.extractTimestampFromLines(firstLines);
      const lastTimestamp = this.extractTimestampFromLines(lastLines);
      
      if (firstTimestamp && lastTimestamp) {
        return {
          start: Math.min(firstTimestamp, lastTimestamp),
          end: Math.max(firstTimestamp, lastTimestamp)
        };
      }
    } catch (error) {
      console.warn(`提取时间范围失败 ${filePath}:`, error);
    }
    
    return undefined;
  }

  /**
   * 读取文件的前几行
   */
  private async readLines(filePath: string, count: number): Promise<string[]> {
    const lines: string[] = [];
    
    return new Promise((resolve, reject) => {
      const stream = createReadStream(filePath, { encoding: 'utf8' });
      let buffer = '';
      
      stream.on('data', (chunk) => {
        buffer += chunk;
        const newLines = buffer.split('\n');
        
        for (let i = 0; i < newLines.length - 1 && lines.length < count; i++) {
          lines.push(newLines[i]);
        }
        
        buffer = newLines[newLines.length - 1];
        
        if (lines.length >= count) {
          stream.destroy();
          resolve(lines.slice(0, count));
        }
      });
      
      stream.on('end', () => {
        if (buffer && lines.length < count) {
          lines.push(buffer);
        }
        resolve(lines);
      });
      
      stream.on('error', reject);
    });
  }

  /**
   * 从文件末尾读取几行
   */
  private async readLinesFromEnd(filePath: string, count: number): Promise<string[]> {
    // 简化实现：读取整个文件（适用于小文件）
    try {
      const content = await promisify(fs.readFile)(filePath, 'utf8');
      const allLines = content.split('\n').filter(line => line.trim());
      return allLines.slice(-count);
    } catch (error) {
      console.warn(`读取文件末尾失败 ${filePath}:`, error);
      return [];
    }
  }

  /**
   * 从行中提取时间戳
   */
  private extractTimestampFromLines(lines: string[]): number | null {
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.timestamp && typeof parsed.timestamp === 'number') {
          return parsed.timestamp;
        }
      } catch (error) {
        // 忽略解析错误
      }
    }
    return null;
  }

  /**
   * 构建扫描结果
   */
  private buildScanResult(files: LogFileInfo[], scanTime: number): LogScanResult {
    const totalFiles = files.length;
    const totalSize = files.reduce((sum, file) => sum + file.fileSize, 0);
    
    // 计算整体时间范围
    const allTimestamps = files
      .map(file => file.timeRange)
      .filter(range => range !== undefined)
      .flatMap(range => [range!.start, range!.end]);
    
    const timeRange = allTimestamps.length > 0 ? {
      start: Math.min(...allTimestamps),
      end: Math.max(...allTimestamps)
    } : {
      start: Date.now() - 24 * 60 * 60 * 1000, // 默认24小时前
      end: Date.now()
    };

    // 构建模块统计
    const moduleStats: Record<string, any> = {};
    for (const file of files) {
      if (!moduleStats[file.moduleId]) {
        moduleStats[file.moduleId] = {
          fileCount: 0,
          totalSize: 0,
          timeRange: { start: Infinity, end: -Infinity }
        };
      }
      
      const stats = moduleStats[file.moduleId];
      stats.fileCount++;
      stats.totalSize += file.fileSize;
      
      if (file.timeRange) {
        stats.timeRange.start = Math.min(stats.timeRange.start, file.timeRange.start);
        stats.timeRange.end = Math.max(stats.timeRange.end, file.timeRange.end);
      }
    }

    return {
      files,
      totalFiles,
      totalSize,
      scanTime,
      timeRange,
      moduleStats
    };
  }

  /**
   * 获取文件统计信息
   */
  async getFileStats(filePath: string): Promise<{
    lineCount: number;
    size: number;
    firstTimestamp?: number;
    lastTimestamp?: number;
  } | null> {
    try {
      const stats = await promisify(fs.stat)(filePath);
      const lines = await this.readLines(filePath, 1000); // 读取足够多行来获取时间范围
      
      const firstTimestamp = this.extractTimestampFromLines(lines.slice(0, 10));
      const lastTimestamp = this.extractTimestampFromLines(lines.slice(-10));
      
      return {
        lineCount: lines.length,
        size: stats.size,
        firstTimestamp: firstTimestamp || undefined,
        lastTimestamp: lastTimestamp || undefined
      };
    } catch (error) {
      console.warn(`获取文件统计失败 ${filePath}:`, error);
      return null;
    }
  }
}

/**
 * 便捷的扫描函数
 */
export async function scanLogFiles(options?: LogScannerOptions): Promise<LogScanResult> {
  const scanner = new LogFileScanner(options);
  return scanner.scan();
}

/**
 * 获取默认日志目录
 */
export function getDefaultLogDirectory(): string {
  return './logs';
}