/**
 * 历史数据可视化主组件
 * 
 * 整合所有历史数据可视化功能的主入口组件
 */

import React, { useState, useEffect, useCallback } from 'react';

import { HistoricalPipelineVisualizer } from './HistoricalPipelineVisualizer.js';
import { TimelineController } from './TimelineController.js';
import { HistoricalStateComparator, compareHistoricalStates } from './HistoricalStateComparator.js';
import { parseHistoricalLogs, TimeSeriesIndexEngine } from '../../logging/index.js';
import type { UnifiedLogEntry } from '../../logging/types.js';

/**
 * 历史数据仪表板属性
 */
export interface HistoricalDashboardProps {
  /** 日志目录 */
  logDirectory?: string;
  /** 时间范围 */
  timeRange?: { start: number; end: number };
  /** 模块过滤 */
  moduleFilter?: string[];
  /** 日志级别过滤 */
  levelFilter?: string[];
  /** 主题 */
  theme?: 'light' | 'dark';
  /** 宽度 */
  width?: number;
  /** 高度 */
  height?: number;
  /** 自动加载 */
  autoLoad?: boolean;
  /** 刷新间隔 */
  refreshInterval?: number;
  /** 是否显示时间轴 */
  showTimeline?: boolean;
  /** 是否显示状态对比 */
  showComparison?: boolean;
  /** 是否显示详细信息 */
  showDetails?: boolean;
  /** 是否启用自动播放 */
  enableAutoPlay?: boolean;
  /** 播放速度 */
  playSpeed?: number;
  /** 加载状态回调 */
  onLoadingChange?: (loading: boolean) => void;
  /** 数据加载回调 */
  onDataLoaded?: (data: UnifiedLogEntry[]) => void;
  /** 错误回调 */
  onError?: (error: Error) => void;
}

/**
 * 历史仪表板状态
 */
export interface HistoricalDashboardState {
  /** 历史数据 */
  historicalData: UnifiedLogEntry[];
  /** 时间序列索引 */
  timeSeriesIndex: TimeSeriesIndexEngine | null;
  /** 当前时间戳 */
  currentTimestamp: number;
  /** 可用时间戳 */
  availableTimestamps: number[];
  /** 加载状态 */
  isLoading: boolean;
  /** 错误信息 */
  error?: string;
  /** 对比结果 */
  comparisonResult?: any;
  /** 是否显示对比面板 */
  showComparisonPanel: boolean;
}

/**
 * 历史数据仪表板主组件
 */
export const HistoricalDashboard: React.FC<HistoricalDashboardProps> = ({
  logDirectory = './logs',
  timeRange,
  moduleFilter,
  levelFilter,
  theme = 'light',
  width = 1400,
  height = 900,
  autoLoad = true,
  refreshInterval,
  showTimeline = true,
  showComparison = true,
  showDetails = true,
  enableAutoPlay = false,
  playSpeed = 2000,
  onLoadingChange,
  onDataLoaded,
  onError
}) => {
  const [state, setState] = useState<HistoricalDashboardState>({
    historicalData: [],
    timeSeriesIndex: null,
    currentTimestamp: Date.now(),
    availableTimestamps: [],
    isLoading: false,
    showComparisonPanel: false
  });

  /**
   * 加载历史数据
   */
  const loadHistoricalData = useCallback(async () => {
    setState(prev => ({ ...prev, isLoading: true }));
    onLoadingChange?.(true);

    try {
      console.log('🚀 开始加载历史数据...');

      const result = await parseHistoricalLogs({
        scanDirectory: logDirectory,
        timeRange,
        moduleIds: moduleFilter,
        validationOptions: {
          validationLevel: 'moderate',
          autoFix: true
        },
        cleaningOptions: {
          deduplicate: true,
          sortByTimestamp: true,
          normalizeTimestamps: true
        },
        indexOptions: {
          name: 'historical-dashboard-index',
          shardInterval: 60 * 60 * 1000, // 1小时
          enableCompression: true
        }
      });

      console.log(`✅ 历史数据加载完成，共 ${result.entries.length} 条记录`);

      // 提取可用时间戳
      const availableTimestamps = [...new Set(result.entries.map(entry => entry.timestamp))].sort();
      
      // 设置当前时间为最新的数据点
      const currentTimestamp = availableTimestamps[availableTimestamps.length - 1] || Date.now();

      setState({
        historicalData: result.entries,
        timeSeriesIndex: result.index,
        currentTimestamp,
        availableTimestamps,
        isLoading: false,
        showComparisonPanel: false
      });

      onDataLoaded?.(result.entries);
      onLoadingChange?.(false);

    } catch (error) {
      console.error('❌ 加载历史数据失败:', error);
      
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : '未知错误'
      }));
      
      onError?.(error instanceof Error ? error : new Error(String(error)));
      onLoadingChange?.(false);
    }
  }, [logDirectory, timeRange, moduleFilter, levelFilter, onLoadingChange, onDataLoaded, onError]);

  /**
   * 处理时间戳变化
   */
  const handleTimestampChange = useCallback((timestamp: number) => {
    setState(prev => ({ ...prev, currentTimestamp: timestamp }));
  }, []);

  /**
   * 执行状态对比
   */
  const performStateComparison = useCallback(async () => {
    if (state.historicalData.length < 2) {
      console.warn('⚠️  数据不足，无法进行状态对比');
      return;
    }

    try {
      console.log('🔍 开始执行状态对比分析...');

      // 按时间戳分组数据
      const statesByTimestamp = new Map<number, { nodes: any[], connections: any[] }>();
      
      // 简化：创建模拟的节点和连接状态
      const timestamps = [...new Set(state.historicalData.map(entry => entry.timestamp))].sort();
      
      timestamps.forEach(timestamp => {
        const timestampData = state.historicalData.filter(entry => entry.timestamp === timestamp);
        
        // 按模块分组创建节点状态
        const moduleGroups = new Map<string, any[]>();
        timestampData.forEach(entry => {
          if (!moduleGroups.has(entry.moduleId)) {
            moduleGroups.set(entry.moduleId, []);
          }
          moduleGroups.get(entry.moduleId)!.push(entry);
        });

        const nodes = Array.from(moduleGroups.entries()).map(([moduleId, entries]) => {
          const latestEntry = entries.reduce((latest, current) => 
            current.timestamp > latest.timestamp ? current : latest
          );

          return {
            id: moduleId,
            name: moduleId,
            type: latestEntry.moduleType,
            layer: this.extractLayerFromModuleId(moduleId),
            status: this.determineNodeStatus(entries),
            timestamp: latestEntry.timestamp,
            processingTime: entries.find(e => e.duration)?.duration || 0,
            logEntries: entries
          };
        });

        statesByTimestamp.set(timestamp, {
          nodes,
          connections: [] // 简化：不处理连接
        });
      });

      // 执行状态对比
      const comparisonResult = await compareHistoricalStates(statesByTimestamp, {
        dimensions: ['status', 'performance', 'errors'],
        includeDetails: true,
        autoDetectChanges: true
      });

      console.log(`✅ 状态对比完成，发现 ${comparisonResult.statusChanges.length} 个状态变化`);

      setState(prev => ({
        ...prev,
        comparisonResult,
        showComparisonPanel: true
      }));

    } catch (error) {
      console.error('❌ 状态对比失败:', error);
    }
  }, [state.historicalData]);

  /**
   * 提取层级信息
   */
  private extractLayerFromModuleId(moduleId: string): string {
    if (moduleId.includes('switch')) return '1';
    if (moduleId.includes('compatibility')) return '2';
    if (moduleId.includes('provider')) return '3';
    if (moduleId.includes('service')) return '4';
    return 'unknown';
  }

  /**
   * 确定节点状态
   */
  private determineNodeStatus(entries: any[]): string {
    const hasError = entries.some(entry => entry.level === 'error');
    if (hasError) return 'error';

    const latestEntry = entries.reduce((latest, current) => 
      current.timestamp > latest.timestamp ? current : latest
    );

    switch (latestEntry.level) {
      case 'info': return 'success';
      case 'warn': return 'running';
      case 'error': return 'error';
      default: return 'unknown';
    }
  }

  /**
   * 导出对比报告
   */
  const exportComparisonReport = useCallback(async () => {
    if (!state.comparisonResult) {
      console.warn('⚠️  没有对比结果可导出');
      return;
    }

    try {
      const { generateStateComparisonReport } = await import('./HistoricalStateComparator.js');
      const report = generateStateComparisonReport(state.comparisonResult);
      
      // 创建并下载报告
      const blob = new Blob([report], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `状态对比报告-${new Date().toISOString().split('T')[0]}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      console.log('✅ 对比报告导出成功');
      
    } catch (error) {
      console.error('❌ 导出对比报告失败:', error);
    }
  }, [state.comparisonResult]);

  // 自动加载数据
  useEffect(() => {
    if (autoLoad) {
      loadHistoricalData();
    }
  }, [autoLoad, loadHistoricalData]);

  // 定期刷新
  useEffect(() => {
    if (refreshInterval && refreshInterval > 0) {
      const interval = setInterval(() => {
        loadHistoricalData();
      }, refreshInterval);

      return () => clearInterval(interval);
    }
  }, [refreshInterval, loadHistoricalData]);

  if (state.isLoading) {
    return (
      <div className={`historical-dashboard historical-dashboard-${theme}`}>
        <div className="loading-container">
          <div className="loading-spinner">⏳</div>
          <div className="loading-text">正在加载历史数据...</div>
        </div>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className={`historical-dashboard historical-dashboard-${theme}`}>
        <div className="error-container">
          <div className="error-icon">❌</div>
          <div className="error-text">加载失败: {state.error}</div>
          <button onClick={loadHistoricalData} className="retry-button">
            重试
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`historical-dashboard historical-dashboard-${theme}`}>
      {/* 控制面板 */}
      <div className="dashboard-header">
        <div className="dashboard-title">
          <h2>历史数据仪表板</h2>
          <div className="dashboard-info">
            数据点: {state.availableTimestamps.length} | 
            当前: {new Date(state.currentTimestamp).toLocaleString()}
          </div>
        </div>
        
        <div className="dashboard-controls">
          <button 
            onClick={performStateComparison} 
            className="control-button"
            disabled={state.historicalData.length < 2}
          >
            🔍 状态对比
          </button>
          
          <button 
            onClick={exportComparisonReport} 
            className="control-button"
            disabled={!state.comparisonResult}
          >
            📄 导出报告
          </button>
          
          <button 
            onClick={loadHistoricalData} 
            className="control-button"
          >
            🔄 刷新数据
          </button>
        </div>
      </div>

      {/* 时间轴控制器 */}
      {showTimeline && (
        <TimelineController
          timestamps={state.availableTimestamps}
          currentTimestamp={state.currentTimestamp}
          onTimestampChange={handleTimestampChange}
          autoPlay={enableAutoPlay}
          playSpeed={playSpeed}
          theme={theme}
          height={120}
        />
      )}

      {/* 主可视化区域 */}
      <div className="visualization-area">
        <HistoricalPipelineVisualizer
          historicalData={state.historicalData}
          timeSeriesIndex={state.timeSeriesIndex}
          currentTimestamp={state.currentTimestamp}
          timeRange={timeRange}
          moduleFilter={moduleFilter}
          levelFilter={levelFilter}
          width={width}
          height={height - 200}
          theme={theme}
          showTimeline={false} // 我们已经在仪表板中显示了
          showComparison={showComparison}
          showDetails={showDetails}
        />
      </div>

      {/* 对比结果面板 */}
      {state.showComparisonPanel && state.comparisonResult && (
        <div className="comparison-panel">
          <HistoricalStateComparator
            comparisonResult={state.comparisonResult}
            theme={theme}
          />
        </div>
      )}

      <style jsx>{`
        .historical-dashboard {
          width: 100%;
          height: 100%;
          display: flex;
          flex-direction: column;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }

        .historical-dashboard-light {
          background: #ffffff;
          color: #1f2937;
        }

        .historical-dashboard-dark {
          background: #0d1117;
          color: #d4d4d4;
        }

        .loading-container,
        .error-container {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 100%;
          padding: 2rem;
        }

        .loading-spinner {
          font-size: 2rem;
          animation: spin 1s linear infinite;
          margin-bottom: 1rem;
        }

        .error-icon {
          font-size: 2rem;
          margin-bottom: 1rem;
        }

        .loading-text,
        .error-text {
          font-size: 1.1rem;
          text-align: center;
          margin-bottom: 1rem;
        }

        .retry-button {
          padding: 0.5rem 1rem;
          background: #3b82f6;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 0.9rem;
        }

        .retry-button:hover {
          background: #2563eb;
        }

        .dashboard-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 1rem 1.5rem;
          border-bottom: 1px solid ${theme === 'dark' ? '#30363d' : '#e5e7eb'};
        }

        .dashboard-title h2 {
          margin: 0;
          font-size: 1.5rem;
          font-weight: 600;
        }

        .dashboard-info {
          font-size: 0.9rem;
          opacity: 0.8;
          margin-top: 0.25rem;
        }

        .dashboard-controls {
          display: flex;
          gap: 0.5rem;
        }

        .control-button {
          padding: 0.5rem 1rem;
          border: 1px solid ${theme === 'dark' ? '#374151' : '#d1d5db'};
          border-radius: 6px;
          background: ${theme === 'dark' ? '#1f2937' : '#ffffff'};
          color: ${theme === 'dark' ? '#d4d4d4' : '#1f2937'};
          cursor: pointer;
          font-size: 0.85rem;
          font-weight: 500;
          transition: all 0.2s ease;
          display: flex;
          align-items: center;
          gap: 0.25rem;
        }

        .control-button:hover:not(:disabled) {
          background: ${theme === 'dark' ? '#374151' : '#f3f4f6'};
          transform: translateY(-1px);
        }

        .control-button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .visualization-area {
          flex: 1;
          overflow: hidden;
        }

        .comparison-panel {
          height: 300px;
          border-top: 1px solid ${theme === 'dark' ? '#30363d' : '#e5e7eb'};
          overflow: hidden;
        }

        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};

/**
 * 历史状态对比组件（简化版）
 */
const HistoricalStateComparator: React.FC<{
  comparisonResult: any;
  theme: 'light' | 'dark';
}> = ({ comparisonResult, theme }) => {
  if (!comparisonResult) return null;

  const { statusChanges, performanceChanges, errorChanges, statistics, recommendations } = comparisonResult;

  return (
    <div className={`state-comparator state-comparator-${theme}`}>
      <div className="comparator-header">
        <h3>状态对比分析</h3>
        <div className="comparator-stats">
          <span className="health-score">
            健康评分: {statistics.healthScore}/100
          </span>
          <span className="overall-trend">
            趋势: {statistics.overallTrend}
          </span>
        </div>
      </div>

      <div className="comparator-content">
        {/* 状态变化 */}
        {statusChanges.length > 0 && (
          <div className="change-section">
            <h4>状态变化 ({statusChanges.length})</h4>
            <div className="change-list">
              {statusChanges.slice(0, 3).map((change, index) => (
                <div key={index} className={`change-item change-${change.severity}`}>
                  <div className="change-header">
                    <span className="node-name">{change.nodeName}</span>
                    <span className="change-type">{change.changeType}</span>
                  </div>
                  <div className="change-details">
                    {change.previousStatus} → {change.currentStatus}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 性能变化 */}
        {performanceChanges.length > 0 && (
          <div className="change-section">
            <h4>性能变化 ({performanceChanges.length})</h4>
            <div className="change-list">
              {performanceChanges.slice(0, 3).map((change, index) => (
                <div key={index} className="change-item">
                  <div className="change-header">
                    <span className="node-name">{change.nodeName}</span>
                    <span className="change-percentage">
                      {change.changePercentage > 0 ? '+' : ''}{change.changePercentage.toFixed(1)}%
                    </span>
                  </div>
                  <div className="change-details">
                    {change.metric}: {change.previousValue} → {change.currentValue}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 建议 */}
        {recommendations.length > 0 && (
          <div className="recommendations-section">
            <h4>建议</h4>
            <ul className="recommendations-list">
              {recommendations.map((rec, index) => (
                <li key={index} className="recommendation-item">
                  {rec}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <style jsx>{`
        .state-comparator {
          padding: 1rem;
          height: 100%;
          overflow-y: auto;
        }

        .state-comparator-light {
          background: #f9fafb;
          color: #1f2937;
        }

        .state-comparator-dark {
          background: #161b22;
          color: #d4d4d4;
        }

        .comparator-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 1rem;
          padding-bottom: 0.5rem;
          border-bottom: 1px solid ${theme === 'dark' ? '#30363d' : '#e5e7eb'};
        }

        .comparator-header h3 {
          margin: 0;
          font-size: 1.1rem;
        }

        .comparator-stats {
          display: flex;
          gap: 1rem;
          font-size: 0.9rem;
        }

        .health-score {
          color: #3b82f6;
          font-weight: 500;
        }

        .overall-trend {
          color: #6b7280;
        }

        .comparator-content {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }

        .change-section {
          background: ${theme === 'dark' ? '#1f2937' : '#ffffff'};
          padding: 0.75rem;
          border-radius: 6px;
          border: 1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'};
        }

        .change-section h4 {
          margin: 0 0 0.5rem 0;
          font-size: 0.9rem;
          font-weight: 600;
        }

        .change-list {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }

        .change-item {
          padding: 0.5rem;
          border-radius: 4px;
          border-left: 3px solid;
        }

        .change-low {
          background: rgba(34, 197, 94, 0.1);
          border-left-color: #22c55e;
        }

        .change-medium {
          background: rgba(59, 130, 246, 0.1);
          border-left-color: #3b82f6;
        }

        .change-high {
          background: rgba(245, 158, 11, 0.1);
          border-left-color: #f59e0b;
        }

        .change-critical {
          background: rgba(239, 68, 68, 0.1);
          border-left-color: #ef4444;
        }

        .change-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 0.25rem;
        }

        .node-name {
          font-weight: 500;
          font-size: 0.85rem;
        }

        .change-type,
        .change-percentage {
          font-size: 0.8rem;
          font-weight: 500;
          padding: 2px 6px;
          border-radius: 3px;
        }

        .change-details {
          font-size: 0.8rem;
          opacity: 0.8;
        }

        .recommendations-section {
          background: rgba(59, 130, 246, 0.05);
          border: 1px solid rgba(59, 130, 246, 0.2);
        }

        .recommendations-list {
          margin: 0;
          padding-left: 1.5rem;
        }

        .recommendation-item {
          margin-bottom: 0.25rem;
          font-size: 0.85rem;
          line-height: 1.4;
        }
      `}</style>
    </div>
  );
};

export default HistoricalDashboard;