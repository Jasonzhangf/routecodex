/**
 * 紧凑格式化器
 *
 * 提供极简的格式化输出，优化存储空间和处理性能
 */

import type { SnapshotData, HookExecutionResult } from '../../../types/hook-types.js';
import type { SnapshotFormatter } from './json-formatter.js';

/**
 * 紧凑格式化器实现
 */
export class CompactFormatter implements SnapshotFormatter {
  private includeDetails: boolean;
  private maxStringLength: number;

  constructor(options: {
    includeDetails?: boolean;
    maxStringLength?: number;
  } = {}) {
    this.includeDetails = options.includeDetails !== false;
    this.maxStringLength = options.maxStringLength || 100;
  }

  /**
   * 格式化快照数据为紧凑格式
   */
  format(data: SnapshotData): string {
    const compact = this.createCompactView(data);
    return JSON.stringify(compact);
  }

  /**
   * 获取文件扩展名
   */
  getFileExtension(): string {
    return 'compact.json';
  }

  /**
   * 获取MIME类型
   */
  getMimeType(): string {
    return 'application/json';
  }

  /**
   * 创建紧凑视图
   */
  private createCompactView(data: SnapshotData): unknown {
    return {
      // 核心元信息（短字段名）
      id: data.metadata.snapshotId,
      m: data.metadata.moduleId,
      r: data.metadata.requestId,
      s: this.stageToShortCode(data.metadata.stage),
      t: data.metadata.timestamp,

      // 执行摘要
      sum: {
        total: data.summary.totalHooks,
        ok: data.summary.successfulHooks,
        fail: data.summary.failedHooks,
        time: data.summary.totalExecutionTime,
        size: data.summary.dataSize
      },

      // Hook执行结果
      hooks: this.formatHooksCompact(data.hooks),

      // 详细信息（可选）
      ctx: this.includeDetails ? {
        execId: data.executionContext.executionId,
        start: data.executionContext.startTime,
        moduleId: data.executionContext.moduleId
      } : undefined
    };
  }

  /**
   * 将阶段转换为短代码
   */
  private stageToShortCode(stage: string): string {
    const stageMap: Record<string, string> = {
      'initialization': 'init',
      'request_preprocessing': 'req_pre',
      'request_validation': 'req_val',
      'authentication': 'auth',
      'http_request': 'http_req',
      'http_response': 'http_res',
      'response_validation': 'res_val',
      'response_postprocessing': 'res_post',
      'finalization': 'final',
      'error_handling': 'error',
      'pipeline_preprocessing': 'pipe_pre',
      'pipeline_processing': 'pipe_proc',
      'pipeline_postprocessing': 'pipe_post',
      'server_request_receiving': 'srv_req',
      'server_response_sending': 'srv_res',
      'llm_switch_processing': 'llm_sw'
    };

    return stageMap[stage] || stage;
  }

  /**
   * 紧凑格式化Hook执行结果
   */
  private formatHooksCompact(hooks: HookExecutionResult[]): unknown[] {
    return hooks.map(hook => {
      const compact: unknown = {
        n: hook.hookName,
        s: this.stageToShortCode(hook.stage),
        tg: this.targetToShortCode(hook.target),
        ok: hook.success,
        time: hook.executionTime
      };

      // 可选详细信息
      if (this.includeDetails) {
        if (hook.changes && hook.changes.length > 0) {
          compact.ch = {
            cnt: hook.changes.length,
            types: [...new Set(hook.changes.map(c => c.type[0]))]
          };
        }

        if (hook.observations && hook.observations.length > 0) {
          compact.obs = hook.observations.length;
        }

        if (hook.metrics && Object.keys(hook.metrics).length > 0) {
          compact.metrics = Object.keys(hook.metrics).length;
        }

        if (hook.error) {
          compact.err = hook.error.constructor?.name?.substring(0, 4) || 'ERR';
        }

        if (hook.data !== undefined) {
          compact.hasData = true;
          const dataSize = JSON.stringify(hook.data).length;
          if (dataSize > 0) {
            compact.dataSize = dataSize;
          }
        }
      }

      return compact;
    });
  }

  /**
   * 将目标转换为短代码
   */
  private targetToShortCode(target: string): string {
    const targetMap: Record<string, string> = {
      'request': 'req',
      'response': 'res',
      'headers': 'hdr',
      'config': 'cfg',
      'auth': 'auth',
      'error': 'err',
      'pipeline-data': 'pipe',
      'http-request': 'http_req',
      'http-response': 'http_res',
      'all': 'all'
    };

    return targetMap[target] || target;
  }

  /**
   * 创建默认紧凑格式化器
   */
  static createDefault(): CompactFormatter {
    return new CompactFormatter();
  }

  /**
   * 创建极简紧凑格式化器
   */
  static createMinimal(): CompactFormatter {
    return new CompactFormatter({
      includeDetails: false,
      maxStringLength: 50
    });
  }

  /**
   * 创建详细紧凑格式化器
   */
  static createDetailed(): CompactFormatter {
    return new CompactFormatter({
      includeDetails: true,
      maxStringLength: 200
    });
  }
}