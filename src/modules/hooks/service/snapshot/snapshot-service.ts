/**
 * Hook快照服务
 *
 * 负责Hook执行数据的快照记录、存储和管理
 * 支持文件存储、压缩、采样率控制和敏感数据遮蔽
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { createGzip } from 'zlib';
import { homedir } from 'os';
import type {
  SnapshotData,
  HookExecutionResult,
  HookExecutionContext,
  UnifiedHookStage
} from '../../types/hook-types.js';

/**
 * 快照服务配置
 */
export interface SnapshotServiceConfig {
  enabled: boolean;
  basePath: string;
  format: 'json' | 'structured' | 'compact';
  compression: 'none' | 'gzip' | 'lz4';
  retention: {
    maxFiles: number;
    maxAge: number; // 毫秒
  };
  organization: {
    byModule: boolean;
    byEndpoint: boolean;
    byDate: boolean;
  };
  sampling: {
    enabled: boolean;
    defaultRate: number;
    moduleRates: Record<string, number>;
    hotRoutes: Array<{
      pattern: string;
      rate: number;
    }>;
  };
  throttling: {
    maxWritesPerSecond: number;
    maxWritesPerRequest: number;
    timeWindowMs: number;
  };
  dataMasking: {
    enabled: boolean;
    sensitiveFields: Array<{
      path: string;
      type: 'header' | 'field' | 'cookie';
     保留长度: number;
    }>;
  };
  performance: {
    maxFileSize: number;
    maxWriteTime: number;
    batchSize: number;
    writeInterval: number;
  };
}

/**
 * 默认配置
 */
export const DEFAULT_SNAPSHOT_CONFIG: SnapshotServiceConfig = {
  enabled: true,
  basePath: '~/.routecodex/codex-samples',
  format: 'structured',
  compression: 'gzip',
  retention: {
    maxFiles: 1000,
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7天
  },
  organization: {
    byModule: true,
    byEndpoint: true,
    byDate: true
  },
  sampling: {
    enabled: true,
    defaultRate: 0.1,
    moduleRates: {
      'provider-v2': 0.2,
      'pipeline-compat': 0.05,
      'server-chat': 0.1
    },
    hotRoutes: [
      { pattern: '/v1/chat/completions', rate: 0.5 },
      { pattern: '/v1/responses', rate: 0.3 }
    ]
  },
  throttling: {
    maxWritesPerSecond: 10,
    maxWritesPerRequest: 3,
    timeWindowMs: 1000
  },
  dataMasking: {
    enabled: true,
    sensitiveFields: [
      { path: 'authorization', type: 'header', 保留长度: 8 },
      { path: 'apikey', type: 'field', 保留长度: 4 },
      { path: 'token', type: 'field', 保留长度: 6 },
      { path: 'cookie', type: 'header', 保留长度: 10 },
      { path: 'password', type: 'field', 保留长度: 0 },
      { path: 'secret', type: 'field', 保留长度: 0 }
    ]
  },
  performance: {
    maxFileSize: 1024 * 1024, // 1MB
    maxWriteTime: 100,
    batchSize: 10,
    writeInterval: 5000
  }
};

/**
 * 快照服务实现
 */
export class SnapshotService {
  private config: SnapshotServiceConfig;
  private writeQueue: Array<() => Promise<void>> = [];
  private writeTimer?: NodeJS.Timeout;
  private writeCounters = new Map<string, number>();
  private lastWriteTime = new Map<string, number>();
  private samplingCounters = new Map<string, number>();

  constructor(config: Partial<SnapshotServiceConfig> = {}) {
    this.config = { ...DEFAULT_SNAPSHOT_CONFIG, ...config };

    // 启动批量写入定时器
    if (this.config.enabled) {
      this.startBatchWriter();
    }
  }

  /**
   * 保存Hook执行快照
   */
  async saveSnapshot(
    moduleId: string,
    requestId: string,
    stage: UnifiedHookStage,
    executionResults: HookExecutionResult[],
    context: HookExecutionContext
  ): Promise<string | null> {
    if (!this.config.enabled) {
      return null;
    }

    // 采样检查
    if (!this.shouldSample(moduleId, requestId, stage)) {
      return null;
    }

    // 节流检查
    if (!this.shouldThrottle(moduleId, requestId)) {
      return null;
    }

    try {
      const snapshotData = this.createSnapshotData(
        moduleId,
        requestId,
        stage,
        executionResults,
        context
      );

      // 应用数据遮蔽
      const maskedData = this.applyDataMasking(snapshotData);

      // 格式化数据
      const formattedData = this.formatData(maskedData);

      // 生成文件路径
      const filePath = this.generateFilePath(moduleId, requestId, stage);

      // 压缩数据（如果需要）
      const finalData = await this.compressData(formattedData);

      // 异步写入文件
      await this.queueWrite(filePath, finalData);

      return filePath;
    } catch (error) {
      console.error('Failed to save snapshot:', error);
      return null;
    }
  }

  /**
   * 创建快照数据
   */
  private createSnapshotData(
    moduleId: string,
    requestId: string,
    stage: UnifiedHookStage,
    executionResults: HookExecutionResult[],
    context: HookExecutionContext
  ): SnapshotData {
    const totalExecutionTime = executionResults.reduce((sum, result) => sum + result.executionTime, 0);
    const successfulHooks = executionResults.filter(r => r.success).length;
    const failedHooks = executionResults.filter(r => !r.success).length;

    return {
      metadata: {
        moduleId,
        requestId,
        stage,
        timestamp: Date.now(),
        snapshotId: this.generateSnapshotId(),
        format: this.config.format,
        compression: this.config.compression
      },
      executionContext: context,
      hooks: executionResults,
      summary: {
        totalHooks: executionResults.length,
        successfulHooks,
        failedHooks,
        totalExecutionTime,
        dataSize: JSON.stringify(executionResults).length
      }
    };
  }

  /**
   * 生成快照ID
   */
  private generateSnapshotId(): string {
    return `snapshot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 生成文件路径
   */
  private generateFilePath(moduleId: string, requestId: string, stage: UnifiedHookStage): string {
    const pathParts: string[] = [];

    // 展开用户路径
    const basePath = this.config.basePath.replace('~', homedir());

    if (this.config.organization.byModule) {
      pathParts.push(moduleId);
    }

    if (this.config.organization.byEndpoint) {
      // 从requestId或context中提取端点信息
      const endpoint = this.extractEndpoint(requestId, stage);
      pathParts.push(endpoint);
    }

    if (this.config.organization.byDate) {
      const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      pathParts.push(date);
    }

    const fileName = `${requestId}_${stage}.json`;
    if (this.config.compression !== 'none') {
      return join(basePath, ...pathParts, `${fileName}.${this.config.compression}`);
    }

    return join(basePath, ...pathParts, fileName);
  }

  /**
   * 提取端点信息
   */
  private extractEndpoint(requestId: string, stage: UnifiedHookStage): string {
    // 根据stage推断端点类型
    const stageEndpointMap: Record<UnifiedHookStage, string> = {
      'initialization': 'system',
      'request_preprocessing': 'openai-chat',
      'request_validation': 'openai-chat',
      'authentication': 'openai-chat',
      'http_request': 'openai-chat',
      'http_response': 'openai-chat',
      'response_validation': 'openai-chat',
      'response_postprocessing': 'openai-chat',
      'finalization': 'system',
      'error_handling': 'system',
      'pipeline_preprocessing': 'pipeline-compat',
      'pipeline_processing': 'pipeline-compat',
      'pipeline_postprocessing': 'pipeline-compat',
      'server_request_receiving': 'server-chat',
      'server_response_sending': 'server-responses',
      'llm_switch_processing': 'llmswitch-core'
    };

    return stageEndpointMap[stage] || 'unknown';
  }

  /**
   * 采样检查
   */
  private shouldSample(moduleId: string, requestId: string, _stage: UnifiedHookStage): boolean {
    if (!this.config.sampling.enabled) {
      return true;
    }

    // 计算采样键
    // const samplingKey = `${moduleId}:${stage}`;

    // 获取采样率
    let sampleRate = this.config.sampling.defaultRate;
    if (this.config.sampling.moduleRates[moduleId]) {
      sampleRate = this.config.sampling.moduleRates[moduleId];
    }

    // 检查热点路由
    for (const hotRoute of this.config.sampling.hotRoutes) {
      if (requestId.includes(hotRoute.pattern)) {
        sampleRate = Math.max(sampleRate, hotRoute.rate);
        break;
      }
    }

    // 基于hash的一致性采样
    const hash = this.hashString(requestId);
    const normalizedHash = hash / 0xFFFFFFFF;
    return normalizedHash < sampleRate;
  }

  /**
   * 节流检查
   */
  private shouldThrottle(moduleId: string, requestId: string): boolean {
    const now = Date.now();
    const requestKey = `${moduleId}:${requestId}`;

    // 检查每请求写入限制
    const requestCount = this.writeCounters.get(requestKey) || 0;
    if (requestCount >= this.config.throttling.maxWritesPerRequest) {
      return false;
    }

    // 检查每秒写入限制
    const timeKey = `${moduleId}:${Math.floor(now / 1000)}`;
    const timeCount = this.writeCounters.get(timeKey) || 0;
    if (timeCount >= this.config.throttling.maxWritesPerSecond) {
      return false;
    }

    // 更新计数器
    this.writeCounters.set(requestKey, requestCount + 1);
    this.writeCounters.set(timeKey, timeCount + 1);
    this.lastWriteTime.set(moduleId, now);

    return true;
  }

  /**
   * 字符串hash函数
   */
  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // 转换为32位整数
    }
    return Math.abs(hash);
  }

  /**
   * 应用数据遮蔽
   */
  private applyDataMasking(data: SnapshotData): SnapshotData {
    if (!this.config.dataMasking.enabled) {
      return data;
    }

    const maskedData = JSON.parse(JSON.stringify(data)); // 深拷贝

    // 遮蔽敏感字段
    for (const field of this.config.dataMasking.sensitiveFields) {
      this.maskField(maskedData, field.path, field.保留长度);
    }

    return maskedData;
  }

  /**
   * 遮蔽指定字段
   */
  private maskField(obj: unknown, path: string, 保留长度: number): void {
    const keys = path.split('.');
    let current = obj;

    // 导航到目标字段
    for (let i = 0; i < keys.length - 1; i++) {
      if (current[keys[i]] === undefined) {
        return;
      }
      current = current[keys[i]];
    }

    const finalKey = keys[keys.length - 1];
    if (current[finalKey] !== undefined) {
      const value = String(current[finalKey]);
      if (value.length > 保留长度) {
        current[finalKey] = `${value.substring(0, 保留长度)  }***`;
      }
    }
  }

  /**
   * 格式化数据
   */
  private formatData(data: SnapshotData): string {
    switch (this.config.format) {
      case 'json':
        return JSON.stringify(data, null, 2);

      case 'structured':
        return this.formatStructured(data);

      case 'compact':
        return this.formatCompact(data);

      default:
        return JSON.stringify(data);
    }
  }

  /**
   * 结构化格式化
   */
  private formatStructured(data: SnapshotData): string {
    const formatted = {
      snapshot: {
        id: data.metadata.snapshotId,
        module: data.metadata.moduleId,
        request: data.metadata.requestId,
        stage: data.metadata.stage,
        timestamp: new Date(data.metadata.timestamp).toISOString()
      },
      summary: data.summary,
      execution: {
        hooks: data.hooks.map(hook => ({
          name: hook.hookName,
          stage: hook.stage,
          target: hook.target,
          success: hook.success,
          executionTime: hook.executionTime,
          hasData: hook.data !== undefined,
          hasChanges: hook.changes && hook.changes.length > 0,
          observations: hook.observations || []
        }))
      },
      context: {
        executionId: data.executionContext.executionId,
        startTime: new Date(data.executionContext.startTime).toISOString(),
        moduleId: data.executionContext.moduleId
      }
    };

    return JSON.stringify(formatted, null, 2);
  }

  /**
   * 紧凑格式化
   */
  private formatCompact(data: SnapshotData): string {
    const compact = {
      id: data.metadata.snapshotId,
      m: data.metadata.moduleId,
      r: data.metadata.requestId,
      s: data.metadata.stage,
      t: data.metadata.timestamp,
      summary: data.summary,
      hooks: data.hooks.map(h => ({
        n: h.hookName,
        st: h.stage,
        tg: h.target,
        ok: h.success,
        time: h.executionTime
      }))
    };

    return JSON.stringify(compact);
  }

  /**
   * 压缩数据
   */
  private async compressData(data: string): Promise<Buffer> {
    if (this.config.compression === 'none') {
      return Buffer.from(data);
    }

    if (this.config.compression === 'gzip') {
      return this.compressGzip(data);
    }

    if (this.config.compression === 'lz4') {
      // LZ4压缩需要额外的库，这里简化处理
      console.warn('LZ4 compression not implemented, falling back to gzip');
      return this.compressGzip(data);
    }

    return Buffer.from(data);
  }

  /**
   * Gzip压缩
   */
  private async compressGzip(data: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const gzip = createGzip();

      gzip.on('data', (chunk) => chunks.push(chunk));
      gzip.on('end', () => resolve(Buffer.concat(chunks)));
      gzip.on('error', reject);

      gzip.write(data);
      gzip.end();
    });
  }

  /**
   * 队列写入操作
   */
  private async queueWrite(filePath: string, data: Buffer): Promise<void> {
    const writeOperation = async () => {
      try {
        await this.writeFile(filePath, data);
      } catch (error) {
        console.error(`Failed to write snapshot to ${filePath}:`, error);
      }
    };

    this.writeQueue.push(writeOperation);

    // 如果队列达到批量大小，立即执行
    if (this.writeQueue.length >= this.config.performance.batchSize) {
      this.processWriteQueue();
    }
  }

  /**
   * 写入文件
   */
  private async writeFile(filePath: string, data: Buffer): Promise<void> {
    const startTime = Date.now();

    // 确保目录存在
    await fs.mkdir(dirname(filePath), { recursive: true });

    // 检查文件大小限制
    if (data.length > this.config.performance.maxFileSize) {
      console.warn(`Snapshot file too large (${data.length} bytes), truncating: ${filePath}`);
      data = data.slice(0, this.config.performance.maxFileSize);
    }

    // 写入文件
    await fs.writeFile(filePath, data);

    const writeTime = Date.now() - startTime;
    if (writeTime > this.config.performance.maxWriteTime) {
      console.warn(`Slow snapshot write (${writeTime}ms): ${filePath}`);
    }
  }

  /**
   * 启动批量写入器
   */
  private startBatchWriter(): void {
    this.writeTimer = setInterval(() => {
      this.processWriteQueue();
    }, this.config.performance.writeInterval);
  }

  /**
   * 处理写入队列
   */
  private async processWriteQueue(): Promise<void> {
    if (this.writeQueue.length === 0) {
      return;
    }

    const operations = this.writeQueue.splice(0);

    try {
      await Promise.all(operations.map(op => op()));
    } catch (error) {
      console.error('Error processing write queue:', error);
    }
  }

  /**
   * 清理过期文件
   */
  async cleanup(): Promise<number> {
    if (!this.config.enabled) {
      return 0;
    }

    const basePath = this.config.basePath.replace('~', homedir());
    const now = Date.now();
    let cleanedCount = 0;

    try {
      const files = await this.scanSnapshotFiles(basePath);

      for (const file of files) {
        const fileAge = now - file.mtime;
        if (fileAge > this.config.retention.maxAge) {
          try {
            await fs.unlink(file.path);
            cleanedCount++;
          } catch (error) {
            console.error(`Failed to delete old snapshot file ${file.path}:`, error);
          }
        }
      }

      // 如果文件数量超过限制，删除最旧的文件
      if (files.length > this.config.retention.maxFiles) {
        const sortedFiles = files.sort((a, b) => a.mtime - b.mtime);
        const filesToDelete = sortedFiles.slice(0, files.length - this.config.retention.maxFiles);

        for (const file of filesToDelete) {
          try {
            await fs.unlink(file.path);
            cleanedCount++;
          } catch (error) {
            console.error(`Failed to delete excess snapshot file ${file.path}:`, error);
          }
        }
      }

      if (cleanedCount > 0) {
        console.log(`Cleaned up ${cleanedCount} old snapshot files`);
      }
    } catch (error) {
      console.error('Error during snapshot cleanup:', error);
    }

    return cleanedCount;
  }

  /**
   * 扫描快照文件
   */
  private async scanSnapshotFiles(basePath: string): Promise<Array<{ path: string; mtime: number }>> {
    const files: Array<{ path: string; mtime: number }> = [];

    try {
      const entries = await fs.readdir(basePath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(basePath, entry.name);

        if (entry.isDirectory()) {
          // 递归扫描子目录
          const subFiles = await this.scanSnapshotFiles(fullPath);
          files.push(...subFiles);
        } else if (entry.isFile() && this.isSnapshotFile(entry.name)) {
          const stats = await fs.stat(fullPath);
          files.push({
            path: fullPath,
            mtime: stats.mtime.getTime()
          });
        }
      }
    } catch (error) {
      // 目录可能不存在，忽略错误
    }

    return files;
  }

  /**
   * 检查是否为快照文件
   */
  private isSnapshotFile(fileName: string): boolean {
    return fileName.endsWith('.json') ||
           fileName.endsWith('.json.gz') ||
           fileName.endsWith('.json.lz4');
  }

  /**
   * 关闭快照服务
   */
  async shutdown(): Promise<void> {
    if (this.writeTimer) {
      clearInterval(this.writeTimer);
      this.writeTimer = undefined;
    }

    // 处理剩余的写入队列
    await this.processWriteQueue();
  }

  /**
   * 获取服务统计信息
   */
  getStats(): {
    enabled: boolean;
    queueSize: number;
    writeCounters: number;
    samplingCounters: number;
    config: SnapshotServiceConfig;
  } {
    return {
      enabled: this.config.enabled,
      queueSize: this.writeQueue.length,
      writeCounters: this.writeCounters.size,
      samplingCounters: this.samplingCounters.size,
      config: this.config
    };
  }
}