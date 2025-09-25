/**
 * Key429Tracker - 基于 key 的 429 错误追踪和黑名单管理
 *
 * 功能：
 * - 记录每个 key/token 的 429 错误时间和连续错误次数
 * - 实现黑名单机制：连续 3 次 429 且间隔 > 1 分钟的 key 会被拉黑
 * - 提供 key 健康状态查询和管理
 * - 自动清理过期的错误记录
 */

export interface Key429ErrorRecord {
  key: string;
  timestamp: number;
  consecutiveCount: number;
  lastErrorTime: number;
  isBlacklisted: boolean;
  blacklistedAt?: number;
  pipelineIds: string[];
}

export interface Key429TrackerConfig {
  maxConsecutiveErrors: number;
  minIntervalMs: number;
  blacklistDurationMs: number;
  cleanupIntervalMs: number;
  maxRecordAgeMs: number;
}

export class Key429Tracker {
  private errorRecords: Map<string, Key429ErrorRecord> = new Map();
  private config: Key429TrackerConfig;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(config?: Partial<Key429TrackerConfig>) {
    this.config = {
      maxConsecutiveErrors: 3,
      minIntervalMs: 60 * 1000, // 1 分钟
      blacklistDurationMs: 30 * 60 * 1000, // 30 分钟
      cleanupIntervalMs: 5 * 60 * 1000, // 5 分钟
      maxRecordAgeMs: 2 * 60 * 60 * 1000, // 2 小时
      ...config
    };

    this.startCleanupTimer();
  }

  /**
   * 记录 429 错误
   * @param key 产生错误的 key
   * @param pipelineIds 受影响的流水线 ID 列表
   * @returns 错误记录和是否触发黑名单
   */
  record429Error(key: string, pipelineIds: string[]): {
    record: Key429ErrorRecord;
    blacklisted: boolean;
    shouldRetry: boolean;
  } {
    const now = Date.now();
    const existing = this.errorRecords.get(key);

    let record: Key429ErrorRecord;

    if (existing) {
      // 计算与上次错误的时间间隔
      const interval = now - existing.lastErrorTime;

      // 检查是否是连续错误（间隔大于配置的最小间隔）
      const isConsecutive = interval >= this.config.minIntervalMs;

      if (isConsecutive) {
        // 连续错误，增加计数
        record = {
          ...existing,
          timestamp: now,
          consecutiveCount: existing.consecutiveCount + 1,
          lastErrorTime: now,
          pipelineIds: [...new Set([...existing.pipelineIds, ...pipelineIds])]
        };
      } else {
        // 间隔太短，重置计数
        record = {
          ...existing,
          timestamp: now,
          consecutiveCount: 1,
          lastErrorTime: now,
          pipelineIds: [...new Set([...existing.pipelineIds, ...pipelineIds])]
        };
      }
    } else {
      // 新错误记录
      record = {
        key,
        timestamp: now,
        consecutiveCount: 1,
        lastErrorTime: now,
        isBlacklisted: false,
        pipelineIds
      };
    }

    // 检查是否需要拉黑
    const blacklisted = this.shouldBlacklist(record);
    if (blacklisted) {
      record.isBlacklisted = true;
      record.blacklistedAt = now;
    }

    this.errorRecords.set(key, record);

    return {
      record,
      blacklisted,
      shouldRetry: !blacklisted && record.consecutiveCount < this.config.maxConsecutiveErrors
    };
  }

  /**
   * 检查 key 是否需要被拉黑
   */
  private shouldBlacklist(record: Key429ErrorRecord): boolean {
    if (record.isBlacklisted) {
      return true;
    }

    return record.consecutiveCount >= this.config.maxConsecutiveErrors;
  }

  /**
   * 检查 key 是否可用
   */
  isKeyAvailable(key: string): boolean {
    const record = this.errorRecords.get(key);
    if (!record) {
      return true;
    }

    // 检查是否在黑名单中且黑名单未过期
    if (record.isBlacklisted && record.blacklistedAt) {
      const blacklistExpired = Date.now() - record.blacklistedAt > this.config.blacklistDurationMs;
      if (blacklistExpired) {
        // 黑名单过期，移除黑名单状态
        record.isBlacklisted = false;
        record.blacklistedAt = undefined;
        record.consecutiveCount = 0;
        this.errorRecords.set(key, record);
        return true;
      }
      return false;
    }

    // 检查是否在冷却期
    const timeSinceLastError = Date.now() - record.lastErrorTime;
    if (timeSinceLastError < this.config.minIntervalMs) {
      return false;
    }

    return true;
  }

  /**
   * 获取 key 的冷却时间（毫秒）
   */
  getKeyCooldownTime(key: string): number {
    const record = this.errorRecords.get(key);
    if (!record) {
      return 0;
    }

    const timeSinceLastError = Date.now() - record.lastErrorTime;
    if (timeSinceLastError >= this.config.minIntervalMs) {
      return 0;
    }

    return this.config.minIntervalMs - timeSinceLastError;
  }

  /**
   * 获取所有受影响的流水线 ID
   */
  getAffectedPipelineIds(key: string): string[] {
    const record = this.errorRecords.get(key);
    return record?.pipelineIds || [];
  }

  /**
   * 获取所有被拉黑的 key
   */
  getBlacklistedKeys(): string[] {
    const blacklisted: string[] = [];
    for (const [key, record] of this.errorRecords) {
      if (record.isBlacklisted) {
        blacklisted.push(key);
      }
    }
    return blacklisted;
  }

  /**
   * 获取 key 的错误统计
   */
  getKeyStats(key: string): {
    totalErrors: number;
    consecutiveErrors: number;
    isBlacklisted: boolean;
    lastErrorTime: number;
    blacklistedAt?: number;
  } | null {
    const record = this.errorRecords.get(key);
    if (!record) {
      return null;
    }

    return {
      totalErrors: record.consecutiveCount,
      consecutiveErrors: record.consecutiveCount,
      isBlacklisted: record.isBlacklisted,
      lastErrorTime: record.lastErrorTime,
      blacklistedAt: record.blacklistedAt
    };
  }

  /**
   * 重置 key 的错误记录
   */
  resetKey(key: string): void {
    this.errorRecords.delete(key);
  }

  /**
   * 重置所有错误记录
   */
  resetAll(): void {
    this.errorRecords.clear();
  }

  /**
   * 启动清理定时器
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupIntervalMs);
  }

  /**
   * 清理过期的错误记录
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, record] of this.errorRecords) {
      // 删除过期的记录
      if (now - record.timestamp > this.config.maxRecordAgeMs) {
        this.errorRecords.delete(key);
      }
    }
  }

  /**
   * 停止清理定时器
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /**
   * 获取调试信息
   */
  getDebugInfo(): {
    totalRecords: number;
    blacklistedKeys: string[];
    config: Key429TrackerConfig;
    records: Array<{
      key: string;
      consecutiveCount: number;
      isBlacklisted: boolean;
      lastErrorTime: number;
    }>;
  } {
    const records = Array.from(this.errorRecords.values()).map(record => ({
      key: record.key,
      consecutiveCount: record.consecutiveCount,
      isBlacklisted: record.isBlacklisted,
      lastErrorTime: record.lastErrorTime
    }));

    return {
      totalRecords: this.errorRecords.size,
      blacklistedKeys: this.getBlacklistedKeys(),
      config: this.config,
      records
    };
  }
}