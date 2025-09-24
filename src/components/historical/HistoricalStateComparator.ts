/**
 * 历史状态对比分析器
 * 
 * 对比不同时间点的系统状态，识别变化和趋势
 */

import type { HistoricalNode, HistoricalConnection } from './HistoricalPipelineVisualizer.js';
import type { UnifiedLogEntry } from '../../logging/types.js';

/**
 * 状态对比选项
 */
export interface StateComparisonOptions {
  /** 对比的时间点 */
  timestamps: number[];
  /** 对比维度 */
  dimensions?: ('status' | 'performance' | 'errors' | 'data')[];
  /** 敏感度阈值 */
  sensitivity?: number;
  /** 是否包含详细分析 */
  includeDetails?: boolean;
  /** 是否自动识别变化 */
  autoDetectChanges?: boolean;
}

/**
 * 状态对比结果
 */
export interface StateComparisonResult {
  /** 对比的时间点 */
  timestamps: number[];
  /** 状态变化 */
  statusChanges: StatusChange[];
  /** 性能变化 */
  performanceChanges: PerformanceChange[];
  /** 错误变化 */
  errorChanges: ErrorChange[];
  /** 数据变化 */
  dataChanges: DataChange[];
  /** 总体统计 */
  statistics: ComparisonStatistics;
  /** 建议 */
  recommendations: string[];
  /** 对比耗时 */
  comparisonTime: number;
}

/**
 * 状态变化
 */
export interface StatusChange {
  /** 节点ID */
  nodeId: string;
  /** 节点名称 */
  nodeName: string;
  /** 之前状态 */
  previousStatus: string;
  /** 当前状态 */
  currentStatus: string;
  /** 变化类型 */
  changeType: 'improvement' | 'degradation' | 'fluctuation' | 'stable';
  /** 变化时间 */
  changeTime: number;
  /** 严重程度 */
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** 描述 */
  description: string;
  /** 影响范围 */
  impactScope: string[];
}

/**
 * 性能变化
 */
export interface PerformanceChange {
  /** 节点ID */
  nodeId: string;
  /** 节点名称 */
  nodeName: string;
  /** 性能指标 */
  metric: string;
  /** 之前值 */
  previousValue: number;
  /** 当前值 */
  currentValue: number;
  /** 变化百分比 */
  changePercentage: number;
  /** 变化类型 */
  changeType: 'improvement' | 'degradation' | 'stable';
  /** 变化时间 */
  changeTime: number;
  /** 是否显著 */
  isSignificant: boolean;
  /** 阈值 */
  threshold?: number;
}

/**
 * 错误变化
 */
export interface ErrorChange {
  /** 节点ID */
  nodeId: string;
  /** 节点名称 */
  nodeName: string;
  /** 错误类型 */
  errorType: string;
  /** 之前数量 */
  previousCount: number;
  /** 当前数量 */
  currentCount: number;
  /** 变化数量 */
  changeCount: number;
  /** 变化百分比 */
  changePercentage: number;
  /** 变化趋势 */
  trend: 'increasing' | 'decreasing' | 'stable';
  /** 变化时间 */
  changeTime: number;
  /** 错误详情 */
  errorDetails: ErrorDetail[];
}

/**
 * 错误详情
 */
export interface ErrorDetail {
  /** 错误代码 */
  errorCode?: string;
  /** 错误消息 */
  errorMessage: string;
  /** 错误次数 */
  count: number;
  /** 首次出现时间 */
  firstSeen: number;
  /** 最后出现时间 */
  lastSeen: number;
  /** 影响范围 */
  affectedModules: string[];
}

/**
 * 数据变化
 */
export interface DataChange {
  /** 节点ID */
  nodeId: string;
  /** 节点名称 */
  nodeName: string;
  /** 数据字段 */
  field: string;
  /** 之前值 */
  previousValue: any;
  /** 当前值 */
  currentValue: any;
  /** 变化类型 */
  changeType: 'added' | 'removed' | 'modified';
  /** 变化时间 */
  changeTime: number;
  /** 重要性 */
  importance: 'low' | 'medium' | 'high';
}

/**
 * 对比统计
 */
export interface ComparisonStatistics {
  /** 总节点数 */
  totalNodes: number;
  /** 变化节点数 */
  changedNodes: number;
  /** 状态改善数 */
  improvedNodes: number;
  /** 状态恶化数 */
  degradedNodes: number;
  /** 错误增加数 */
  errorIncreasedNodes: number;
  /** 性能提升数 */
  performanceImprovedNodes: number;
  /** 性能下降数 */
  performanceDegradedNodes: number;
  /** 总体趋势 */
  overallTrend: 'improving' | 'degrading' | 'stable' | 'mixed';
  /** 健康评分 */
  healthScore: number;
  /** 置信度 */
  confidence: number;
}

/**
 * 历史状态对比分析器
 */
export class HistoricalStateComparator {
  private options: Required<StateComparisonOptions>;

  constructor(options: StateComparisonOptions) {
    this.options = {
      timestamps: options.timestamps,
      dimensions: options.dimensions || ['status', 'performance', 'errors', 'data'],
      sensitivity: options.sensitivity || 0.1,
      includeDetails: options.includeDetails ?? true,
      autoDetectChanges: options.autoDetectChanges ?? true
    };
  }

  /**
   * 对比历史状态
   */
  async compareStates(
    states: Map<number, { nodes: HistoricalNode[]; connections: HistoricalConnection[] }>
  ): Promise<StateComparisonResult> {
    const startTime = Date.now();
    
    console.log(`🔍 开始对比 ${states.size} 个时间点的状态...`);

    const statusChanges: StatusChange[] = [];
    const performanceChanges: PerformanceChange[] = [];
    const errorChanges: ErrorChange[] = [];
    const dataChanges: DataChange[] = [];
    const recommendations: string[] = [];

    const timestamps = Array.from(states.keys()).sort();
    
    // 逐对对比状态
    for (let i = 0; i < timestamps.length - 1; i++) {
      const currentTime = timestamps[i];
      const nextTime = timestamps[i + 1];
      
      const currentState = states.get(currentTime)!;
      const nextState = states.get(nextTime)!;

      // 对比状态
      if (this.options.dimensions.includes('status')) {
        const statusChanges = this.compareStatus(currentState, nextState, currentTime);
        statusChanges.push(...statusChanges);
      }

      // 对比性能
      if (this.options.dimensions.includes('performance')) {
        const perfChanges = this.comparePerformance(currentState, nextState, currentTime);
        performanceChanges.push(...perfChanges);
      }

      // 对比错误
      if (this.options.dimensions.includes('errors')) {
        const errorChanges = this.compareErrors(currentState, nextState, currentTime);
        errorChanges.push(...errorChanges);
      }

      // 对比数据
      if (this.options.dimensions.includes('data')) {
        const dataChanges = this.compareData(currentState, nextState, currentTime);
        dataChanges.push(...dataChanges);
      }
    }

    // 生成统计信息
    const statistics = this.generateStatistics(statusChanges, performanceChanges, errorChanges, dataChanges);

    // 生成建议
    const recommendations = this.generateRecommendations(statistics, statusChanges, performanceChanges, errorChanges);

    const comparisonTime = Date.now() - startTime;

    console.log(`✅ 状态对比完成，发现 ${statusChanges.length} 个状态变化，${performanceChanges.length} 个性能变化`);

    return {
      timestamps: this.options.timestamps,
      statusChanges,
      performanceChanges,
      errorChanges,
      dataChanges,
      statistics,
      recommendations,
      comparisonTime
    };
  }

  /**
   * 对比状态
   */
  private compareStatus(
    currentState: { nodes: HistoricalNode[]; connections: HistoricalConnection[] },
    nextState: { nodes: HistoricalNode[]; connections: HistoricalConnection[] },
    changeTime: number
  ): StatusChange[] {
    const changes: StatusChange[] = [];
    const currentNodes = new Map(currentState.nodes.map(n => [n.id, n]));
    const nextNodes = new Map(nextState.nodes.map(n => [n.id, n]));

    // 对比节点状态
    for (const [nodeId, currentNode] of currentNodes) {
      const nextNode = nextNodes.get(nodeId);
      if (!nextNode) continue;

      if (currentNode.status !== nextNode.status) {
        const changeType = this.determineStatusChangeType(currentNode.status, nextNode.status);
        const severity = this.calculateSeverity(currentNode.status, nextNode.status);

        changes.push({
          nodeId,
          nodeName: currentNode.name,
          previousStatus: currentNode.status,
          currentStatus: nextNode.status,
          changeType,
          changeTime,
          severity,
          description: `${currentNode.name} 状态从 ${currentNode.status} 变为 ${nextNode.status}`,
          impactScope: this.determineImpactScope(currentNode, nextNode)
        });
      }
    }

    return changes;
  }

  /**
   * 对比性能
   */
  private comparePerformance(
    currentState: { nodes: HistoricalNode[]; connections: HistoricalConnection[] },
    nextState: { nodes: HistoricalNode[]; connections: HistoricalConnection[] },
    changeTime: number
  ): PerformanceChange[] {
    const changes: PerformanceChange[] = [];
    const currentNodes = new Map(currentState.nodes.map(n => [n.id, n]));
    const nextNodes = new Map(nextState.nodes.map(n => [n.id, n]));

    // 对比处理时间
    for (const [nodeId, currentNode] of currentNodes) {
      const nextNode = nextNodes.get(nodeId);
      if (!nextNode) continue;

      if (currentNode.processingTime && nextNode.processingTime) {
        const changePercentage = ((nextNode.processingTime - currentNode.processingTime) / currentNode.processingTime) * 100;
        const isSignificant = Math.abs(changePercentage) > (this.options.sensitivity * 100);

        if (isSignificant) {
          const changeType = changePercentage > 0 ? 'degradation' : 'improvement';

          changes.push({
            nodeId,
            nodeName: currentNode.name,
            metric: 'processingTime',
            previousValue: currentNode.processingTime,
            currentValue: nextNode.processingTime,
            changePercentage,
            changeType,
            changeTime,
            isSignificant,
            threshold: 100 // 100ms阈值
          });
        }
      }
    }

    return changes;
  }

  /**
   * 对比错误
   */
  private compareErrors(
    currentState: { nodes: HistoricalNode[]; connections: HistoricalConnection[] },
    nextState: { nodes: HistoricalNode[]; connections: HistoricalConnection[] },
    changeTime: number
  ): ErrorChange[] {
    const changes: ErrorChange[] = [];
    const currentNodes = new Map(currentState.nodes.map(n => [n.id, n]));
    const nextNodes = new Map(nextState.nodes.map(n => [n.id, n]));

    for (const [nodeId, currentNode] of currentNodes) {
      const nextNode = nextNodes.get(nodeId);
      if (!nextNode) continue;

      const currentErrors = this.extractErrors(currentNode);
      const nextErrors = this.extractErrors(nextNode);

      if (currentErrors.length !== nextErrors.length) {
        const changeCount = nextErrors.length - currentErrors.length;
        const changePercentage = currentErrors.length > 0 ? (changeCount / currentErrors.length) * 100 : 100;
        const trend = changeCount > 0 ? 'increasing' : 'decreasing';

        changes.push({
          nodeId,
          nodeName: currentNode.name,
          errorType: 'general',
          previousCount: currentErrors.length,
          currentCount: nextErrors.length,
          changeCount,
          changePercentage,
          trend,
          changeTime,
          errorDetails: this.consolidateErrorDetails(currentErrors, nextErrors)
        });
      }
    }

    return changes;
  }

  /**
   * 对比数据
   */
  private compareData(
    currentState: { nodes: HistoricalNode[]; connections: HistoricalConnection[] },
    nextState: { nodes: HistoricalNode[]; connections: HistoricalConnection[] },
    changeTime: number
  ): DataChange[] {
    const changes: DataChange[] = [];
    const currentNodes = new Map(currentState.nodes.map(n => [n.id, n]));
    const nextNodes = new Map(nextState.nodes.map(n => [n.id, n]));

    for (const [nodeId, currentNode] of currentNodes) {
      const nextNode = nextNodes.get(nodeId);
      if (!nextNode) continue;

      // 对比输入数据
      if (JSON.stringify(currentNode.inputData) !== JSON.stringify(nextNode.inputData)) {
        changes.push({
          nodeId,
          nodeName: currentNode.name,
          field: 'inputData',
          previousValue: currentNode.inputData,
          currentValue: nextNode.inputData,
          changeType: 'modified',
          changeTime,
          importance: 'medium'
        });
      }

      // 对比输出数据
      if (JSON.stringify(currentNode.outputData) !== JSON.stringify(nextNode.outputData)) {
        changes.push({
          nodeId,
          nodeName: currentNode.name,
          field: 'outputData',
          previousValue: currentNode.outputData,
          currentValue: nextNode.outputData,
          changeType: 'modified',
          changeTime,
          importance: 'high'
        });
      }
    }

    return changes;
  }

  /**
   * 提取错误信息
   */
  private extractErrors(node: HistoricalNode): ErrorDetail[] {
    const errors: ErrorDetail[] = [];

    if (node.error) {
      errors.push({
        errorMessage: node.error,
        count: 1,
        firstSeen: node.timestamp,
        lastSeen: node.timestamp,
        affectedModules: [node.id]
      });
    }

    // 从日志中提取错误
    node.logEntries.forEach(log => {
      if (log.level === 'error' && log.error) {
        errors.push({
          errorCode: log.error.code,
          errorMessage: log.error.message,
          count: 1,
          firstSeen: log.timestamp,
          lastSeen: log.timestamp,
          affectedModules: [log.moduleId]
        });
      }
    });

    return errors;
  }

  /**
   * 合并错误详情
   */
  private consolidateErrorDetails(currentErrors: ErrorDetail[], nextErrors: ErrorDetail[]): ErrorDetail[] {
    const consolidated: ErrorDetail[] = [];
    const errorMap = new Map<string, ErrorDetail>();

    // 合并当前错误
    currentErrors.forEach(error => {
      const key = `${error.errorCode || ''}-${error.errorMessage}`;
      errorMap.set(key, { ...error, count: 0 }); // 设置为0表示旧错误
    });

    // 合并新错误
    nextErrors.forEach(error => {
      const key = `${error.errorCode || ''}-${error.errorMessage}`;
      if (errorMap.has(key)) {
        const existing = errorMap.get(key)!;
        existing.count = error.count;
        existing.lastSeen = error.lastSeen;
      } else {
        errorMap.set(key, error);
      }
    });

    return Array.from(errorMap.values());
  }

  /**
   * 确定状态变化类型
   */
  private determineStatusChangeType(previousStatus: string, currentStatus: string): 'improvement' | 'degradation' | 'fluctuation' | 'stable' {
    const statusHierarchy = {
      'error': 0,
      'stopped': 1,
      'unknown': 2,
      'running': 3,
      'success': 4
    };

    const prevLevel = statusHierarchy[previousStatus as keyof typeof statusHierarchy] ?? 2;
    const currLevel = statusHierarchy[currentStatus as keyof typeof statusHierarchy] ?? 2;

    if (currLevel > prevLevel) return 'improvement';
    if (currLevel < prevLevel) return 'degradation';
    return 'stable';
  }

  /**
   * 计算严重程度
   */
  private calculateSeverity(previousStatus: string, currentStatus: string): 'low' | 'medium' | 'high' | 'critical' {
    const criticalTransitions = [
      ['success', 'error'],
      ['running', 'error'],
      ['success', 'stopped']
    ];

    const isCritical = criticalTransitions.some(([from, to]) => 
      previousStatus === from && currentStatus === to
    );

    if (isCritical) return 'critical';
    if (previousStatus === 'error' && currentStatus !== 'error') return 'low';
    if (currentStatus === 'error') return 'high';
    return 'medium';
  }

  /**
   * 确定影响范围
   */
  private determineImpactScope(currentNode: HistoricalNode, nextNode: HistoricalNode): string[] {
    const impactScope: string[] = [currentNode.id];
    
    // 如果状态变为错误，可能影响下游模块
    if (nextNode.status === 'error') {
      impactScope.push('downstream-modules');
    }
    
    // 如果是关键模块，影响范围更大
    if (currentNode.layer === '1') {
      impactScope.push('entire-pipeline');
    }
    
    return impactScope;
  }

  /**
   * 生成统计信息
   */
  private generateStatistics(
    statusChanges: StatusChange[],
    performanceChanges: PerformanceChange[],
    errorChanges: ErrorChange[],
    dataChanges: DataChange[]
  ): ComparisonStatistics {
    const totalNodes = new Set([
      ...statusChanges.map(c => c.nodeId),
      ...performanceChanges.map(c => c.nodeId),
      ...errorChanges.map(c => c.nodeId),
      ...dataChanges.map(c => c.nodeId)
    ]).size;

    const changedNodes = new Set([
      ...statusChanges.map(c => c.nodeId),
      ...performanceChanges.filter(c => c.isSignificant).map(c => c.nodeId),
      ...errorChanges.filter(c => c.changeCount !== 0).map(c => c.nodeId),
      ...dataChanges.map(c => c.nodeId)
    ]).size;

    const improvedNodes = statusChanges.filter(c => c.changeType === 'improvement').length +
                         performanceChanges.filter(c => c.changeType === 'improvement').length;

    const degradedNodes = statusChanges.filter(c => c.changeType === 'degradation').length +
                         performanceChanges.filter(c => c.changeType === 'degradation').length;

    const errorIncreasedNodes = errorChanges.filter(c => c.changeCount > 0).length;
    const performanceImprovedNodes = performanceChanges.filter(c => c.changeType === 'improvement').length;
    const performanceDegradedNodes = performanceChanges.filter(c => c.changeType === 'degradation').length;

    // 计算总体趋势
    let overallTrend: 'improving' | 'degrading' | 'stable' | 'mixed' = 'stable';
    
    if (improvedNodes > degradedNodes * 2) {
      overallTrend = 'improving';
    } else if (degradedNodes > improvedNodes * 2) {
      overallTrend = 'degrading';
    } else if (improvedNodes > 0 || degradedNodes > 0) {
      overallTrend = 'mixed';
    }

    // 计算健康评分 (0-100)
    const healthScore = Math.max(0, 100 - (degradedNodes * 10) + (improvedNodes * 5));
    
    // 计算置信度
    const confidence = Math.min(1, Math.max(0, 1 - (errorIncreasedNodes / Math.max(totalNodes, 1))));

    return {
      totalNodes,
      changedNodes,
      improvedNodes,
      degradedNodes,
      errorIncreasedNodes,
      performanceImprovedNodes,
      performanceDegradedNodes,
      overallTrend,
      healthScore,
      confidence
    };
  }

  /**
   * 生成建议
   */
  private generateRecommendations(
    statistics: ComparisonStatistics,
    statusChanges: StatusChange[],
    performanceChanges: PerformanceChange[],
    errorChanges: ErrorChange[]
  ): string[] {
    const recommendations: string[] = [];

    // 基于统计信息生成建议
    if (statistics.degradedNodes > 5) {
      recommendations.push('系统有多个模块状态恶化，建议立即进行故障排查');
    }

    if (statistics.errorIncreasedNodes > 3) {
      recommendations.push('错误数量显著增加，建议检查相关模块的日志和配置');
    }

    if (statistics.performanceDegradedNodes > statistics.performanceImprovedNodes * 2) {
      recommendations.push('性能普遍下降，建议检查系统负载和资源使用情况');
    }

    if (statistics.healthScore < 70) {
      recommendations.push('系统健康评分较低，建议进行全面系统检查');
    }

    // 基于具体变化生成建议
    const criticalErrors = errorChanges.filter(c => c.changeCount > 5);
    if (criticalErrors.length > 0) {
      recommendations.push(`关键模块 ${criticalErrors.map(c => c.nodeName).join(', ')} 错误数量激增，需要重点关注`);
    }

    const criticalStatusChanges = statusChanges.filter(c => c.severity === 'critical');
    if (criticalStatusChanges.length > 0) {
      recommendations.push(`关键状态变化: ${criticalStatusChanges.map(c => c.nodeName).join(', ')}，建议立即处理`);
    }

    // 如果没有发现问题，给出正面建议
    if (recommendations.length === 0) {
      if (statistics.improvedNodes > statistics.degradedNodes) {
        recommendations.push('系统整体状态良好，继续保持当前配置');
      } else {
        recommendations.push('系统状态稳定，建议持续监控');
      }
    }

    return recommendations;
  }
}

/**
 * 便捷的状态对比函数
 */
export async function compareHistoricalStates(
  states: Map<number, { nodes: HistoricalNode[]; connections: HistoricalConnection[] }>,
  options?: Partial<StateComparisonOptions>
): Promise<StateComparisonResult> {
  const comparator = new HistoricalStateComparator({
    timestamps: Array.from(states.keys()),
    ...options
  });

  return comparator.compareStates(states);
}

/**
 * 快速状态对比函数
 */
export function quickCompareStates(
  currentNodes: HistoricalNode[],
  previousNodes: HistoricalNode[]
): {
  hasChanges: boolean;
  criticalChanges: number;
  summary: string;
} {
  const comparator = new HistoricalStateComparator({
    timestamps: [Date.now() - 1000, Date.now()],
    dimensions: ['status'],
    includeDetails: false
  });

  const states = new Map([
    [Date.now() - 1000, { nodes: previousNodes, connections: [] }],
    [Date.now(), { nodes: currentNodes, connections: [] }]
  ]);

  const result = comparator.compareStates(states);

  const criticalChanges = result.statusChanges.filter(c => c.severity === 'critical').length;
  const hasChanges = result.statusChanges.length > 0 || result.performanceChanges.length > 0;

  let summary = '状态无显著变化';
  if (criticalChanges > 0) {
    summary = `发现 ${criticalChanges} 个关键状态变化`;
  } else if (result.statusChanges.length > 0) {
    summary = `发现 ${result.statusChanges.length} 个状态变化`;
  }

  return {
    hasChanges,
    criticalChanges,
    summary
  };
}

/**
 * 生成状态变化报告
 */
export function generateStateComparisonReport(result: StateComparisonResult): string {
  const lines: string[] = [];
  
  lines.push('# 历史状态对比报告');
  lines.push('');
  lines.push(`对比时间: ${new Date().toLocaleString()}`);
  lines.push(`对比时间点: ${result.timestamps.length} 个`);
  lines.push(`对比耗时: ${result.comparisonTime}ms`);
  lines.push('');
  
  // 总体统计
  lines.push('## 总体统计');
  lines.push(`- 总节点数: ${result.statistics.totalNodes}`);
  lines.push(`- 变化节点数: ${result.statistics.changedNodes}`);
  lines.push(`- 改善节点数: ${result.statistics.improvedNodes}`);
  lines.push(`- 恶化节点数: ${result.statistics.degradedNodes}`);
  lines.push(`- 健康评分: ${result.statistics.healthScore}/100`);
  lines.push(`- 总体趋势: ${result.statistics.overallTrend}`);
  lines.push('');
  
  // 状态变化
  if (result.statusChanges.length > 0) {
    lines.push('## 状态变化');
    result.statusChanges.forEach(change => {
      lines.push(`### ${change.nodeName}`);
      lines.push(`- 变化: ${change.previousStatus} → ${change.currentStatus}`);
      lines.push(`- 类型: ${change.changeType}`);
      lines.push(`- 严重程度: ${change.severity}`);
      lines.push(`- 时间: ${new Date(change.changeTime).toLocaleString()}`);
      lines.push(`- 描述: ${change.description}`);
      lines.push('');
    });
  }
  
  // 性能变化
  if (result.performanceChanges.length > 0) {
    lines.push('## 性能变化');
    result.performanceChanges.forEach(change => {
      lines.push(`### ${change.nodeName} - ${change.metric}`);
      lines.push(`- 变化: ${change.previousValue} → ${change.currentValue} (${change.changePercentage.toFixed(1)}%)`);
      lines.push(`- 类型: ${change.changeType}`);
      lines.push(`- 显著性: ${change.isSignificant ? '显著' : '不显著'}`);
      lines.push('');
    });
  }
  
  // 错误变化
  if (result.errorChanges.length > 0) {
    lines.push('## 错误变化');
    result.errorChanges.forEach(change => {
      lines.push(`### ${change.nodeName}`);
      lines.push(`- 错误数量: ${change.previousCount} → ${change.currentCount} (${change.changePercentage.toFixed(1)}%)`);
      lines.push(`- 趋势: ${change.trend}`);
      lines.push('');
    });
  }
  
  // 建议
  if (result.recommendations.length > 0) {
    lines.push('## 建议');
    result.recommendations.forEach((rec, index) => {
      lines.push(`${index + 1}. ${rec}`);
    });
    lines.push('');
  }
  
  return lines.join('\n');
}