/**
 * Provider Debug Hooks - 双向数据流监控系统
 *
 * 支持读取、写入数据和高级调试日志输出
 */

import type { UnknownObject } from '../../../types/common-types.js';
import type { ProviderContext } from '../api/provider-types.js';

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
    dataType: 'request' | 'response' | 'headers' | 'config' | 'auth' | 'error';

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
    target: string,
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
            dataType: target as any,
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
          this.outputDebugInfo(hook, dataPacket, fullContext, hookChanges, hookObservations);
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
      this.outputFinalDebugInfo(stage, target, allChanges, allObservations, totalExecutionTime);
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

  /**
   * 输出调试信息
   */
  private static outputDebugInfo(
    hook: BidirectionalHook,
    dataPacket: HookDataPacket,
    context: HookExecutionContext,
    changes: DataChange[],
    observations: string[]
  ): void {
    console.log(`\n🔍 [DEBUG Hook] ${hook.name} (${hook.stage})`);
    console.log(`📊 数据大小: ${dataPacket.metadata.size} bytes`);
    console.log(`📝 变化数量: ${changes.length}`);
    console.log(`💭 观察记录: ${observations.length}`);

    if (this.debugConfig.level === 'detailed' || this.debugConfig.level === 'verbose') {
      console.log(`📋 数据快照:`, this.formatDataForOutput(dataPacket.data));
    }

    if (changes.length > 0) {
      console.log(`🔄 变化详情:`);
      changes.forEach(change => {
        console.log(`  ${change.type}: ${change.path} = ${JSON.stringify(change.newValue)}`);
      });
    }

    if (observations.length > 0 && this.debugConfig.level === 'verbose') {
      console.log(`👁️ 观察详情:`);
      observations.forEach(obs => console.log(`  - ${obs}`));
    }
  }

  /**
   * 输出最终调试信息
   */
  private static outputFinalDebugInfo(
    stage: HookStage,
    target: string,
    changes: DataChange[],
    observations: string[],
    executionTime: number
  ): void {
    console.log(`\n✅ [DEBUG Hook] ${stage} 阶段完成 (${target})`);
    console.log(`⏱️  总执行时间: ${executionTime}ms`);
    console.log(`🔄 总变化数量: ${changes.length}`);
    console.log(`💭 总观察记录: ${observations.length}`);

    if (changes.length > 0) {
      console.log(`📊 变化统计:`);
      const stats = changes.reduce((acc, change) => {
        acc[change.type] = (acc[change.type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      Object.entries(stats).forEach(([type, count]) => {
        console.log(`  ${type}: ${count}`);
      });
    }
  }

  /**
   * 格式化数据输出
   */
  private static formatDataForOutput(data: UnknownObject): UnknownObject {
    if (this.debugConfig.maxDataSize > 0 && this.calculateDataSize(data) > this.debugConfig.maxDataSize) {
      return {
        __truncated: true,
        __originalSize: this.calculateDataSize(data),
        __preview: `${JSON.stringify(data).substring(0, 200)  }...`
      };
    }
    return data;
  }
}

export default BidirectionalHookManager;