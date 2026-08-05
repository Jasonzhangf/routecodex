/**
 * PipelineHealthManager - 流水线健康状态管理器
 *
 * 功能：
 * - 跟踪每个流水线的健康状态
 * - 处理流水线的健康状态变化
 * - 提供流水线健康状态查询
 * - 管理流水线的禁用和恢复
 */

export interface PipelineHealthStatus {
  pipelineId: string;
  isHealthy: boolean;
  lastCheckTime: number;
  consecutiveErrors: number;
  lastErrorTime?: number;
  lastError?: string;
  errorCount: number;
  successCount: number;
  disabled: boolean;
  disabledAt?: number;
  disabledReason?: string;
  recoveryTime?: number;
}

import { DEFAULT_PIPELINE_HEALTH } from '../constants/index.js';

export interface PipelineHealthConfig {
  maxConsecutiveErrors: number;
  healthCheckIntervalMs: number;
  errorThreshold: number;
  successThreshold: number;
  autoRecoveryEnabled: boolean;
  recoveryIntervalMs: number;
  healthCheckTimeoutMs: number;
}

export class PipelineHealthManager {
  private healthStatuses: Map<string, PipelineHealthStatus> = new Map();
  private config: PipelineHealthConfig;
  private healthCheckTimer?: NodeJS.Timeout;

  constructor(config?: Partial<PipelineHealthConfig>) {
    this.config = {
      maxConsecutiveErrors: DEFAULT_PIPELINE_HEALTH.MAX_CONSECUTIVE_ERRORS,
      healthCheckIntervalMs: DEFAULT_PIPELINE_HEALTH.CHECK_INTERVAL_MS,
      errorThreshold: DEFAULT_PIPELINE_HEALTH.ERROR_THRESHOLD,
      successThreshold: DEFAULT_PIPELINE_HEALTH.SUCCESS_THRESHOLD,
      autoRecoveryEnabled: true,
      recoveryIntervalMs: DEFAULT_PIPELINE_HEALTH.RECOVERY_INTERVAL_MS,
      healthCheckTimeoutMs: DEFAULT_PIPELINE_HEALTH.CHECK_TIMEOUT_MS,
      ...config,
    };

    this.startHealthCheckTimer();
  }

  /**
   * 记录流水线成功
   */
  recordSuccess(pipelineId: string): void {
    const status = this.getOrCreateStatus(pipelineId);

    status.isHealthy = true;
    status.lastCheckTime = Date.now();
    status.consecutiveErrors = 0;
    status.successCount++;
    status.lastError = undefined;
    status.lastErrorTime = undefined;

    // 如果之前被禁用且满足恢复条件，则恢复
    if (status.disabled && this.shouldRecover(status)) {
      this.recoverPipeline(pipelineId);
    }

    this.healthStatuses.set(pipelineId, status);
  }

  /**
   * 记录流水线错误
   */
  recordError(pipelineId: string, error: string): void {
    const status = this.getOrCreateStatus(pipelineId);

    status.isHealthy = false;
    status.lastCheckTime = Date.now();
    status.consecutiveErrors++;
    status.lastError = error;
    status.lastErrorTime = Date.now();
    status.errorCount++;

    // 检查是否需要禁用
    if (this.shouldDisable(status)) {
      this.disablePipeline(pipelineId, `连续错误次数达到阈值: ${status.consecutiveErrors}`);
    }

    this.healthStatuses.set(pipelineId, status);
  }

  /**
   * 记录429错误（特殊处理）
   */
  record429Error(pipelineId: string, key: string): void {
    const status = this.getOrCreateStatus(pipelineId);

    status.isHealthy = false;
    status.lastCheckTime = Date.now();
    status.consecutiveErrors++;
    status.lastError = `429错误 (key: ${key})`;
    status.lastErrorTime = Date.now();
    status.errorCount++;

    // 429错误特殊处理，可能需要立即禁用相关流水线
    if (status.consecutiveErrors >= 2) {
      // 429错误更严格
      this.disablePipeline(pipelineId, `429错误次数达到阈值: ${status.consecutiveErrors}`);
    }

    this.healthStatuses.set(pipelineId, status);
  }

  /**
   * 获取或创建状态记录
   */
  private getOrCreateStatus(pipelineId: string): PipelineHealthStatus {
    const existing = this.healthStatuses.get(pipelineId);
    if (existing) {
      return existing;
    }

    return {
      pipelineId,
      isHealthy: true,
      lastCheckTime: Date.now(),
      consecutiveErrors: 0,
      errorCount: 0,
      successCount: 0,
      disabled: false,
    };
  }

  /**
   * 检查是否需要禁用流水线
   */
  private shouldDisable(status: PipelineHealthStatus): boolean {
    if (status.disabled) {
      return false;
    }

    return (
      status.consecutiveErrors >= this.config.maxConsecutiveErrors ||
      status.errorCount >= this.config.errorThreshold
    );
  }

  /**
   * 检查是否需要恢复流水线
   */
  private shouldRecover(status: PipelineHealthStatus): boolean {
    if (!status.disabled || !this.config.autoRecoveryEnabled) {
      return false;
    }

    const timeSinceDisabled = Date.now() - (status.disabledAt || 0);
    return timeSinceDisabled >= this.config.recoveryIntervalMs;
  }

  /**
   * 禁用流水线
   */
  private disablePipeline(pipelineId: string, reason: string): void {
    const status = this.healthStatuses.get(pipelineId);
    if (!status) {
      return;
    }

    status.disabled = true;
    status.disabledAt = Date.now();
    status.disabledReason = reason;
    status.recoveryTime = Date.now() + this.config.recoveryIntervalMs;

    this.healthStatuses.set(pipelineId, status);
  }

  /**
   * 恢复流水线
   */
  private recoverPipeline(pipelineId: string): void {
    const status = this.healthStatuses.get(pipelineId);
    if (!status) {
      return;
    }

    status.disabled = false;
    status.disabledAt = undefined;
    status.disabledReason = undefined;
    status.recoveryTime = undefined;
    status.consecutiveErrors = 0;

    this.healthStatuses.set(pipelineId, status);
  }

  /**
   * 获取流水线健康状态
   */
  getPipelineHealth(pipelineId: string): PipelineHealthStatus | null {
    return this.healthStatuses.get(pipelineId) || null;
  }

  /**
   * 检查流水线是否可用
   */
  isPipelineAvailable(pipelineId: string): boolean {
    const status = this.healthStatuses.get(pipelineId);
    if (!status) {
      return true; // 新流水线默认可用
    }

    return !status.disabled && status.isHealthy;
  }

  /**
   * 获取所有可用的流水线ID
   */
  getAvailablePipelines(): string[] {
    const available: string[] = [];
    for (const [pipelineId] of this.healthStatuses) {
      if (this.isPipelineAvailable(pipelineId)) {
        available.push(pipelineId);
      }
    }
    return available;
  }

  /**
   * 获取所有禁用的流水线ID
   */
  getDisabledPipelines(): string[] {
    const disabled: string[] = [];
    for (const [pipelineId, status] of this.healthStatuses) {
      if (status.disabled) {
        disabled.push(pipelineId);
      }
    }
    return disabled;
  }

  /**
   * 手动重置流水线状态
   */
  resetPipeline(pipelineId: string): void {
    const status = this.healthStatuses.get(pipelineId);
    if (status) {
      status.isHealthy = true;
      status.consecutiveErrors = 0;
      status.disabled = false;
      status.disabledAt = undefined;
      status.disabledReason = undefined;
      status.recoveryTime = undefined;
      this.healthStatuses.set(pipelineId, status);
    }
  }

  /**
   * 手动重置所有流水线状态
   */
  resetAll(): void {
    for (const status of this.healthStatuses.values()) {
      status.isHealthy = true;
      status.consecutiveErrors = 0;
      status.disabled = false;
      status.disabledAt = undefined;
      status.disabledReason = undefined;
      status.recoveryTime = undefined;
    }
  }

  /**
   * 启动健康检查定时器
   */
  private startHealthCheckTimer(): void {
    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck();
    }, this.config.healthCheckIntervalMs);
  }

  /**
   * 执行健康检查
   */
  private async performHealthCheck(): Promise<void> {
    for (const [pipelineId, status] of this.healthStatuses) {
      // 检查是否需要自动恢复
      if (status.disabled && this.shouldRecover(status)) {
        this.recoverPipeline(pipelineId);
      }
    }
  }

  /**
   * 停止健康检查定时器
   */
  stop(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalPipelines: number;
    healthyPipelines: number;
    disabledPipelines: number;
    averageSuccessRate: number;
    totalErrors: number;
    totalSuccesses: number;
  } {
    const statuses = Array.from(this.healthStatuses.values());
    const healthyCount = statuses.filter(s => this.isPipelineAvailable(s.pipelineId)).length;
    const disabledCount = statuses.filter(s => s.disabled).length;
    const totalErrors = statuses.reduce((sum, s) => sum + s.errorCount, 0);
    const totalSuccesses = statuses.reduce((sum, s) => sum + s.successCount, 0);
    const averageSuccessRate =
      totalSuccesses + totalErrors > 0 ? totalSuccesses / (totalSuccesses + totalErrors) : 0;

    return {
      totalPipelines: statuses.length,
      healthyPipelines: healthyCount,
      disabledPipelines: disabledCount,
      averageSuccessRate,
      totalErrors,
      totalSuccesses,
    };
  }

  /**
   * 获取调试信息
   */
  getDebugInfo(): {
    config: PipelineHealthConfig;
    stats: Record<string, unknown>;
    pipelineStatuses: PipelineHealthStatus[];
  } {
    return {
      config: this.config,
      stats: this.getStats(),
      pipelineStatuses: Array.from(this.healthStatuses.values()),
    };
  }
}
