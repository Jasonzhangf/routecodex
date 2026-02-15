/**
 * Provider Debug Hooks - 双向数据流监控系统
 *
 * 支持读取、写入数据和高级调试日志输出
 */

import type { UnknownObject } from '../../../types/common-types.js';
import type { ProviderContext } from '../api/provider-types.js';
import {
  formatDataForOutput,
  outputDebugInfo,
  outputFinalDebugInfo
} from './provider-debug-output-utils.js';

/**
 * Hook执行上下文 - 包含完整的执行信息
 */
export interface HookExecutionContext extends ProviderContext {
  /** Hook执行阶段 */
  stage: HookStage;

  /** 当前Hook名称 */
  hookName?: string;

  /** 数据变化次数 */
  changeCount: number;

  /** 开始时间戳 */
  startTime: number;

  /** 是否启用高级调试 */
  debugEnabled: boolean;

  /** Hook执行ID */
  executionId: string;
}

/**
 * Hook数据包 - 包含数据和元数据
 */
export interface HookDataPacket {
  /** 实际数据 */
  data: UnknownObject;

  /** 数据元信息 */
  metadata: {
    /** 数据类型 */
    dataType: 'request' | 'response' | 'headers' | 'config' | 'auth' | 'error' | 'all';

    /** 数据大小 */
    size: number;

    /** 数据变化摘要 */
    changes: DataChange[];

    /** 执行时间戳 */
    timestamp: number;

    /** Hook执行ID */
    executionId: string;
  };
}

/**
 * 数据变化记录
 */
export interface DataChange {
  /** 变化类型 */
  type: 'added' | 'modified' | 'removed' | 'unchanged';

  /** 字段路径 */
  path: string;

  /** 旧值 */
  oldValue?: unknown;

  /** 新值 */
  newValue?: unknown;

  /** 变化原因 */
  reason: string;
}

/**
 * Hook阶段
 */
export enum HookStage {
  INITIALIZATION = 'initialization',
  REQUEST_PREPROCESSING = 'request_preprocessing',
  REQUEST_VALIDATION = 'request_validation',
  AUTHENTICATION = 'authentication',
  HTTP_REQUEST = 'http_request',
  HTTP_RESPONSE = 'http_response',
  RESPONSE_VALIDATION = 'response_validation',
  RESPONSE_POSTPROCESSING = 'response_postprocessing',
  FINALIZATION = 'finalization',
  ERROR_HANDLING = 'error_handling'
}

/**
 * 双向Hook接口 - 支持读取和写入
 */
export interface BidirectionalHook {
  /** Hook名称 */
  name: string;

  /** Hook执行阶段 */
  stage: HookStage;

  /** 目标数据类型 */
  target: 'request' | 'response' | 'headers' | 'config' | 'auth' | 'error' | 'all';

  /** Hook优先级 */
  priority: number;

  /** 是否为调试Hook */
  isDebugHook?: boolean;

  /** 读取数据 - 可以读取但不能修改 */
  read?(data: HookDataPacket, context: HookExecutionContext): {
    observations: string[];
    metrics?: Record<string, unknown>;
    shouldContinue?: boolean;
  };

  /** 写入数据 - 可以修改数据 */
  write?(data: HookDataPacket, context: HookExecutionContext): {
    modifiedData: unknown;
    changes: DataChange[];
    observations: string[];
    metrics?: Record<string, unknown>;
  };

  /** 转换数据 - 可以读取、修改并返回新数据 */
  transform?(data: HookDataPacket, context: HookExecutionContext): {
    data: unknown;
    changes: DataChange[];
    observations: string[];
    metrics?: Record<string, unknown>;
  };
}

/**
 * Hook执行结果
 */
export interface HookExecutionResult {
  /** 处理后的数据 */
  data: UnknownObject;

  /** 所有变化记录 */
  changes: DataChange[];

  /** 所有观察记录 */
  observations: string[];

  /** 性能指标 */
  metrics: {
    executionTime: number;
    hookCount: number;
    readCount: number;
    writeCount: number;
    transformCount: number;
  };

  /** 调试信息 */
  debug: {
    hookExecutions: HookExecution[];
    dataFlow: DataFlowSnapshot[];
  };
}

/**
 * 单个Hook执行记录
 */
export interface HookExecution {
  hookName: string;
  stage: HookStage;
  executionTime: number;
  changes: DataChange[];
  observations: string[];
  hasError: boolean;
  errorMessage?: string;
}

/**
 * 数据流快照
 */
export interface DataFlowSnapshot {
  stage: HookStage;
  data: UnknownObject;
  changes: DataChange[];
  timestamp: number;
  dataSize: number;
}

/**
 * 高级调试Hook配置
 */
export interface DebugHookConfig {
  /** 是否启用 */
  enabled: boolean;

  /** 调试级别 */
  level: 'basic' | 'detailed' | 'verbose';

  /** 记录的数据大小限制 */
  maxDataSize: number;

  /** 保存数据流的阶段 */
  stages: HookStage[];

  /** 输出格式 */
  outputFormat: 'json' | 'structured' | 'pretty';

  /** 输出目标 */
  outputTargets: ('console' | 'file' | 'provider-log')[];

  /** 文件输出路径 */
  logFilePath?: string;

  /** 性能阈值 */
  performanceThresholds: {
    maxHookExecutionTime: number;
    maxTotalExecutionTime: number;
    maxDataSize: number;
  };
}

/**
 * 双向Hook管理器
 */
export class BidirectionalHookManager {
  private static hooks: Map<string, BidirectionalHook[]> = new Map();
  private static debugConfig: DebugHookConfig = {
    enabled: false,
    level: 'basic',
    maxDataSize: 1024 * 1024, // 1MB
    stages: Object.values(HookStage),
    outputFormat: 'structured',
    outputTargets: ['console'],
    performanceThresholds: {
      maxHookExecutionTime: 100, // 100ms
      maxTotalExecutionTime: 1000, // 1s
      maxDataSize: 1024 * 512 // 512KB
    }
  };

  private static executionIdCounter = 0;

  /**
   * 注册Hook
   */
  static registerHook(hook: BidirectionalHook): void {
    const stageHooks = this.hooks.get(hook.stage) || [];
    stageHooks.push(hook);
    stageHooks.sort((a, b) => b.priority - a.priority); // 高优先级先执行
    this.hooks.set(hook.stage, stageHooks);
  }

  /**
   * 执行Hook链
   */
  static async executeHookChain(
    stage: HookStage,
    target: BidirectionalHook['target'],
    data: UnknownObject,
    context: Omit<HookExecutionContext, 'stage' | 'debugEnabled' | 'changeCount' | 'startTime' | 'executionId'>
  ): Promise<HookExecutionResult> {
    const startTime = Date.now();
    const executionId = `hook_${++this.executionIdCounter}_${Date.now()}`;
    const debugEnabled = this.debugConfig.enabled;
    const changeCount = 0;

    const fullContext: HookExecutionContext = {
      ...context,
      stage,
      debugEnabled,
      changeCount,
      startTime,
      executionId
    };

    const hooks = this.hooks.get(stage) || [];
    const relevantHooks = hooks.filter(hook =>
      hook.target === target || hook.target === 'all'
    );

    let currentData = data;
    const allChanges: DataChange[] = [];
    const allObservations: string[] = [];
    const hookExecutions: HookExecution[] = [];
    const dataFlow: DataFlowSnapshot[] = [];

    // 记录初始数据快照
    if (debugEnabled) {
      dataFlow.push({
        stage,
        data: this.cloneData(currentData),
        changes: [],
        timestamp: Date.now(),
        dataSize: this.calculateDataSize(currentData)
      });
    }

    for (const hook of relevantHooks) {
      const hookStartTime = Date.now();
      fullContext.hookName = hook.name;

      try {
        const dataPacket: HookDataPacket = {
          data: currentData,
          metadata: {
            dataType: target,
            size: this.calculateDataSize(currentData),
            changes: [],
            timestamp: Date.now(),
            executionId
          }
        };

        const hookChanges: DataChange[] = [];
        const hookObservations: string[] = [];
        let modifiedData = currentData;

        // 执行读取Hook
        if (hook.read) {
          const readResult = hook.read(dataPacket, fullContext);
          hookObservations.push(...readResult.observations);

          if (readResult.shouldContinue === false) {
            break;
          }
        }

        // 执行写入Hook
        if (hook.write) {
          const writeResult = hook.write(dataPacket, fullContext);
          modifiedData = writeResult.modifiedData as UnknownObject;
          hookChanges.push(...writeResult.changes);
          hookObservations.push(...writeResult.observations);
        }

        // 执行转换Hook
        if (hook.transform) {
          const transformResult = hook.transform(dataPacket, fullContext);
          modifiedData = transformResult.data as UnknownObject;
          hookChanges.push(...transformResult.changes);
          hookObservations.push(...transformResult.observations);
        }

        const hookExecutionTime = Date.now() - hookStartTime;

        // 检查性能阈值
        if (hookExecutionTime > this.debugConfig.performanceThresholds.maxHookExecutionTime) {
          hookObservations.push(`⚠️ Hook执行时间过长: ${hookExecutionTime}ms`);
        }

        // 记录Hook执行
        hookExecutions.push({
          hookName: hook.name,
          stage,
          executionTime: hookExecutionTime,
          changes: hookChanges,
          observations: hookObservations,
          hasError: false
        });

        // 更新数据
        if (modifiedData !== currentData) {
          currentData = modifiedData as UnknownObject;
          allChanges.push(...hookChanges);

          // 记录数据变化快照
          if (debugEnabled) {
            dataFlow.push({
              stage,
              data: this.cloneData(currentData),
              changes: hookChanges,
              timestamp: Date.now(),
              dataSize: this.calculateDataSize(currentData)
            });
          }
        }

        allObservations.push(...hookObservations);

        // 输出调试信息
        if (debugEnabled && hook.isDebugHook) {
          outputDebugInfo({
            hook,
            dataPacket,
            changes: hookChanges,
            observations: hookObservations,
            debugConfig: this.debugConfig,
            formatDataForOutput: (payload) => formatDataForOutput(payload, this.debugConfig, this.calculateDataSize)
          });
        }

      } catch (error) {
        const hookExecutionTime = Date.now() - hookStartTime;

        hookExecutions.push({
          hookName: hook.name,
          stage,
          executionTime: hookExecutionTime,
          changes: [],
          observations: [`❌ Hook执行失败: ${error instanceof Error ? error.message : String(error)}`],
          hasError: true,
          errorMessage: error instanceof Error ? error.message : String(error)
        });

        if (debugEnabled) {
          console.error(`[DEBUG Hook] ${hook.name} 在 ${stage} 阶段执行失败:`, error);
        }

        // 继续执行其他Hook，不中断流程
      }
    }

    const totalExecutionTime = Date.now() - startTime;

    // 最终调试输出
    if (debugEnabled && relevantHooks.length > 0) {
      outputFinalDebugInfo({
        stage,
        target,
        changes: allChanges,
        observations: allObservations,
        executionTime: totalExecutionTime
      });
    }

    return {
      data: currentData,
      changes: allChanges,
      observations: allObservations,
      metrics: {
        executionTime: totalExecutionTime,
        hookCount: relevantHooks.length,
        readCount: relevantHooks.filter(h => h.read).length,
        writeCount: relevantHooks.filter(h => h.write).length,
        transformCount: relevantHooks.filter(h => h.transform).length
      },
      debug: {
        hookExecutions,
        dataFlow
      }
    };
  }

  /**
   * 设置调试配置
   */
  static setDebugConfig(config: Partial<DebugHookConfig>): void {
    this.debugConfig = { ...this.debugConfig, ...config };
  }

  /**
   * 获取调试配置
   */
  static getDebugConfig(): DebugHookConfig {
    return { ...this.debugConfig };
  }

  /**
   * 计算数据大小
   */
  private static calculateDataSize(data: UnknownObject): number {
    return JSON.stringify(data).length;
  }

  /**
   * 克隆数据（深拷贝）
   */
  private static cloneData(data: UnknownObject): UnknownObject {
    return JSON.parse(JSON.stringify(data));
  }

}

export default BidirectionalHookManager;
