/**
 * Server V2 Hook Integration
 *
 * 按照现有的provider和llmswitch-core规范实现
 * 集成系统hooks模块和snapshot服务
 */

import type { UnknownObject } from '../../types/common-types.js';
import type {
  IBidirectionalHook,
  HookExecutionContext,
  HookExecutionResult,
  HookResult
} from '../../modules/hooks/types/hook-types.js';
import {
  UnifiedHookStage
} from '../../modules/hooks/types/hook-types.js';
import { writeServerV2Snapshot, type ServerV2SnapshotPhase } from '../utils/server-v2-snapshot-writer.js';

/**
 * Server V2 Hook阶段映射
 */
const SERVER_V2_HOOK_STAGE_MAP: Record<string, UnifiedHookStage> = {
  'server-entry': UnifiedHookStage.PIPELINE_PREPROCESSING,
  'server-pre-process': UnifiedHookStage.REQUEST_PREPROCESSING,
  'server-post-process': UnifiedHookStage.RESPONSE_POSTPROCESSING,
  'server-response': UnifiedHookStage.RESPONSE_VALIDATION,
  'server-error': UnifiedHookStage.ERROR_HANDLING,
  'server-final': UnifiedHookStage.FINALIZATION
} as const;

/**
 * Server V2 Hook执行上下文
 */
export interface ServerV2HookContext extends HookExecutionContext {
  serverVersion: 'v2';
  endpoint: string;
  requestId: string;
  originalRequest?: UnknownObject;
  metadata?: {
    [key: string]: unknown;
  };
}

/**
 * Server V2 Hook集成配置
 */
export interface ServerV2HookIntegrationConfig {
  enabled: boolean;
  snapshot: {
    enabled: boolean;
    level: 'verbose' | 'normal' | 'silent';
    phases: ServerV2SnapshotPhase[];
  };
  hooks: {
    enabled: boolean;
    timeout: number;
    parallel: boolean;
    retryAttempts: number;
  };
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: ServerV2HookIntegrationConfig = {
  enabled: true,
  snapshot: {
    enabled: true,
    level: 'normal',
    phases: ['server-entry', 'server-pre-process', 'server-post-process', 'server-response', 'server-final']
  },
  hooks: {
    enabled: true,
    timeout: 5000,
    parallel: false,
    retryAttempts: 2
  }
};

/**
 * Server V2 Hook集成管理器
 */
export class ServerV2HookIntegration {
  private config: ServerV2HookIntegrationConfig;
  private hooks: Map<string, IBidirectionalHook> = new Map();
  private hookStats: Map<string, { executions: number; errors: number; totalTime: number }> = new Map();

  constructor(config: Partial<ServerV2HookIntegrationConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    console.log('[ServerV2HookIntegration] Initialized with config:', {
      enabled: this.config.enabled,
      snapshotEnabled: this.config.snapshot.enabled,
      hooksEnabled: this.config.hooks.enabled,
      level: this.config.snapshot.level
    });
  }

  /**
   * 注册Hook
   */
  registerHook(hook: IBidirectionalHook): void {
    if (!this.config.hooks.enabled) {
      console.warn('[ServerV2HookIntegration] Hooks are disabled, skipping registration');
      return;
    }

    const hookKey = `${hook.stage}_${hook.name}`;
    this.hooks.set(hookKey, hook);
    this.hookStats.set(hookKey, { executions: 0, errors: 0, totalTime: 0 });

    console.log(`[ServerV2HookIntegration] Registered hook: ${hook.name} at stage ${hook.stage}`);
  }

  /**
   * 注销Hook
   */
  unregisterHook(stage: UnifiedHookStage, name: string): void {
    const hookKey = `${stage}_${name}`;
    const removed = this.hooks.delete(hookKey);
    this.hookStats.delete(hookKey);

    if (removed) {
      console.log(`[ServerV2HookIntegration] Unregistered hook: ${name} at stage ${stage}`);
    }
  }

  /**
   * 执行指定阶段的Hook
   */
  async executeHooks(
    stage: UnifiedHookStage,
    data: UnknownObject,
    context: ServerV2HookContext
  ): Promise<{
    data: UnknownObject;
    results: HookExecutionResult[];
    executionTime: number;
  }> {
    if (!this.config.enabled || !this.config.hooks.enabled) {
      return {
        data,
        results: [],
        executionTime: 0
      };
    }

    const startTime = Date.now();
    const results: HookExecutionResult[] = [];
    let currentData = data;

    try {
      // 查找匹配的Hook
      const stageHooks = Array.from(this.hooks.entries())
        .filter(([_, hook]) => hook.stage === stage)
        .sort(([_, a], [__, b]) => a.priority - b.priority);

      console.log(`[ServerV2HookIntegration] Executing ${stageHooks.length} hooks for stage: ${stage}`);

      // 执行Hook
      for (const [hookKey, hook] of stageHooks) {
        const hookStartTime = Date.now();
        const stats = this.hookStats.get(hookKey)!;

        try {
          stats.executions++;

          // 执行Hook
          const result = await this.executeSingleHook(hook, currentData, context);

          if (result.success && result.data !== undefined && result.data !== null) {
            currentData = result.data as UnknownObject;
          }

          const hookExecutionTime = Date.now() - hookStartTime;
          stats.totalTime += hookExecutionTime;

          results.push({
            hookName: hook.name,
            stage: hook.stage,
            target: hook.target,
            success: true,
            executionTime: hookExecutionTime,
            data: result.data,
            // 保证 observations 始终为数组，避免下游对 undefined 调用数组方法（如 .map/.length）
            observations: (result && (result as any).observations && Array.isArray((result as any).observations))
              ? (result as any).observations as string[]
              : ((result && (result as any).metadata) ? [`${hook.name} executed successfully`] : []),
            metrics: result.metadata
          });

          console.log(`[ServerV2HookIntegration] Hook ${hook.name} completed in ${hookExecutionTime}ms`);

        } catch (error) {
          stats.errors++;
          const hookExecutionTime = Date.now() - hookStartTime;
          stats.totalTime += hookExecutionTime;

          const errorResult = {
            hookName: hook.name,
            stage: hook.stage,
            target: hook.target,
            success: false,
            executionTime: hookExecutionTime,
            error: error as Error,
            data: null,
            observations: [`${hook.name} failed: ${(error as Error).message}`]
          };

          results.push(errorResult);

          console.error(`[ServerV2HookIntegration] Hook ${hook.name} failed:`, error);

          // 根据配置决定是否继续执行
          if (this.shouldStopOnHookError(hook, error as Error)) {
            throw new Error(`Hook execution stopped at ${hook.name}: ${(error as Error).message}`);
          }
        }
      }

      const totalExecutionTime = Date.now() - startTime;

      return {
        data: currentData,
        results,
        executionTime: totalExecutionTime
      };

    } catch (error) {
      const totalExecutionTime = Date.now() - startTime;

      return {
        data: currentData,
        results,
        executionTime: totalExecutionTime
      };
    }
  }

  /**
   * 执行单个Hook
   */
  private async executeSingleHook(
    hook: IBidirectionalHook,
    data: UnknownObject,
    context: ServerV2HookContext
  ): Promise<HookResult> {
    // 使用可清理的超时，避免 Promise.race 残留的未处理拒绝
    return await new Promise<HookResult>((resolve, reject) => {
      const timeoutMs = Math.max(1, Number(this.config.hooks.timeout || 5000));
      const timer = setTimeout(() => {
        const err = new Error(`Hook ${hook.name} timed out after ${timeoutMs}ms`);
        try { clearTimeout(timer); } catch { /* ignore */ }
        reject(err);
      }, timeoutMs);

      const p = hook.execute(context, {
        data,
        metadata: {
          size: (() => { try { return JSON.stringify(data).length; } catch { return 0; } })(),
          timestamp: Date.now()
        }
      });

      Promise.resolve(p)
        .then(res => { try { clearTimeout(timer); } catch { /* ignore */ } resolve(res); })
        .catch(err => { try { clearTimeout(timer); } catch { /* ignore */ } reject(err); });
    });
  }

  /**
   * 执行Hook并记录快照
   */
  async executeHooksWithSnapshot(
    phase: ServerV2SnapshotPhase,
    data: UnknownObject,
    context: ServerV2HookContext
  ): Promise<{
    data: UnknownObject;
    results: HookExecutionResult[];
    executionTime: number;
  }> {
    const stage = SERVER_V2_HOOK_STAGE_MAP[phase];

    // 执行Hook
    const hookResult = await this.executeHooks(stage, data, context);

    // 记录快照
    if (this.config.snapshot.enabled && this.config.snapshot.phases.includes(phase)) {
      await this.writeSnapshot(phase, data, hookResult, context);
    }

    return hookResult;
  }

  /**
   * 执行错误Hook并记录快照
   */
  async executeErrorHooksWithSnapshot(
    data: UnknownObject,
    context: ServerV2HookContext
  ): Promise<void> {
    const stage = UnifiedHookStage.ERROR_HANDLING;

    try {
      // 执行错误处理Hook
      const hookResult = await this.executeHooks(stage, data, context);

      // 记录错误快照
      if (this.config.snapshot.enabled) {
        await this.writeErrorSnapshot(data, hookResult, context);
      }
    } catch (error) {
      console.error('[ServerV2HookIntegration] Error in error hooks:', error);
    }
  }

  /**
   * 写入快照
   */
  private async writeSnapshot(
    phase: ServerV2SnapshotPhase,
    data: UnknownObject,
    hookResult: { data: UnknownObject; results: HookExecutionResult[]; executionTime: number },
    context: ServerV2HookContext
  ): Promise<void> {
    try {
      const snapshotData = {
        originalData: data,
        processedData: hookResult.data,
        hookResults: hookResult.results,
        hookExecutionTime: hookResult.executionTime,
        context: {
          requestId: context.requestId,
          endpoint: context.endpoint,
          serverVersion: context.serverVersion
        }
      };

      await writeServerV2Snapshot({
        phase,
        requestId: context.requestId,
        data: snapshotData,
        entryEndpoint: context.endpoint,
        metadata: {
          level: this.config.snapshot.level,
          hookCount: hookResult.results.length,
          successCount: hookResult.results.filter(r => r.success).length,
          errorCount: hookResult.results.filter(r => !r.success).length
        }
      });

    } catch (error) {
      console.error(`[ServerV2HookIntegration] Failed to write snapshot for phase ${phase}:`, error);
    }
  }

  /**
   * 写入错误快照
   */
  private async writeErrorSnapshot(
    data: UnknownObject,
    hookResult: { data: UnknownObject; results: HookExecutionResult[]; executionTime: number },
    context: ServerV2HookContext
  ): Promise<void> {
    try {
      const snapshotData = {
        originalData: data,
        processedData: hookResult.data,
        hookResults: hookResult.results,
        hookExecutionTime: hookResult.executionTime,
        context: {
          requestId: context.requestId,
          endpoint: context.endpoint,
          serverVersion: context.serverVersion
        }
      };

      await writeServerV2Snapshot({
        phase: 'server-entry' as ServerV2SnapshotPhase, // 使用一个有效的phase
        requestId: context.requestId,
        data: snapshotData,
        entryEndpoint: context.endpoint,
        metadata: {
          level: this.config.snapshot.level,
          hookCount: hookResult.results.length,
          successCount: hookResult.results.filter(r => r.success).length,
          errorCount: hookResult.results.filter(r => !r.success).length,
          isErrorSnapshot: true
        }
      });

    } catch (error) {
      console.error('[ServerV2HookIntegration] Failed to write error snapshot:', error);
    }
  }

  /**
   * 判断是否应该在Hook错误时停止执行
   */
  private shouldStopOnHookError(hook: IBidirectionalHook, _error: Error): boolean {
    // 对于debug hook，不停止执行
    if (hook.isDebugHook) {
      return false;
    }

    // 对于关键阶段，停止执行
    const criticalStages: UnifiedHookStage[] = [
      UnifiedHookStage.REQUEST_VALIDATION,
      UnifiedHookStage.AUTHENTICATION,
      UnifiedHookStage.HTTP_REQUEST
    ];

    return criticalStages.includes(hook.stage);
  }

  /**
   * 获取Hook统计信息
   */
  getHookStats(): Record<string, { executions: number; errors: number; avgTime: number; successRate: number }> {
    const stats: Record<string, any> = {};

    for (const [hookKey, stat] of this.hookStats.entries()) {
      const successRate = stat.executions > 0 ? ((stat.executions - stat.errors) / stat.executions) * 100 : 0;
      const avgTime = stat.executions > 0 ? stat.totalTime / stat.executions : 0;

      stats[hookKey] = {
        executions: stat.executions,
        errors: stat.errors,
        avgTime: Math.round(avgTime * 100) / 100,
        successRate: Math.round(successRate * 100) / 100
      };
    }

    return stats;
  }

  /**
   * 重置Hook统计信息
   */
  resetHookStats(): void {
    for (const stats of this.hookStats.values()) {
      stats.executions = 0;
      stats.errors = 0;
      stats.totalTime = 0;
    }

    console.log('[ServerV2HookIntegration] Hook statistics reset');
  }

  /**
   * 获取配置信息
   */
  getConfig(): ServerV2HookIntegrationConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(newConfig: Partial<ServerV2HookIntegrationConfig>): void {
    this.config = { ...this.config, ...newConfig };
    console.log('[ServerV2HookIntegration] Configuration updated:', {
      enabled: this.config.enabled,
      snapshotEnabled: this.config.snapshot.enabled,
      hooksEnabled: this.config.hooks.enabled
    });
  }
}
