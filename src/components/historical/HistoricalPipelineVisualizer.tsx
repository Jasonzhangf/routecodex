/**
 * 历史数据可视化组件 - HistoricalPipelineVisualizer
 * 
 * 基于解析后的历史数据，提供静态的流水线可视化展示
 */

import React, { useState, useEffect, useCallback } from 'react';
import { UnifiedLogEntry, LogFilter } from '../../logging/types.js';
import { TimeSeriesIndexEngine } from '../../logging/indexer/TimeSeriesIndexer.js';
import { parseHistoricalLogs } from '../../logging/parser/index.js';

/**
 * 历史可视化属性
 */
export interface HistoricalPipelineVisualizerProps {
  /** 历史数据源 */
  historicalData?: UnifiedLogEntry[];
  /** 时间序列索引 */
  timeSeriesIndex?: TimeSeriesIndexEngine;
  /** 初始时间点 */
  initialTimestamp?: number;
  /** 时间范围 */
  timeRange?: { start: number; end: number };
  /** 模块过滤 */
  moduleFilter?: string[];
  /** 日志级别过滤 */
  levelFilter?: LogLevel[];
  /** 宽度 */
  width?: number;
  /** 高度 */
  height?: number;
  /** 主题 */
  theme?: 'light' | 'dark';
  /** 是否显示时间轴 */
  showTimeline?: boolean;
  /** 是否显示状态对比 */
  showComparison?: boolean;
  /** 是否显示详细信息 */
  showDetails?: boolean;
  /** 时间轴高度 */
  timelineHeight?: number;
  /** 详细信息面板宽度 */
  detailsPanelWidth?: number;
  /** 加载状态回调 */
  onLoadingChange?: (loading: boolean) => void;
  /** 时间点变化回调 */
  onTimestampChange?: (timestamp: number) => void;
  /** 节点选择回调 */
  onNodeSelect?: (nodeId: string, data: any) => void;
}

/**
 * 历史流水线状态
 */
export interface HistoricalPipelineState {
  /** 当前时间点 */
  currentTimestamp: number;
  /** 可用的数据点 */
  availableTimestamps: number[];
  /** 当前显示的节点 */
  nodes: HistoricalNode[];
  /** 当前显示的连接 */
  connections: HistoricalConnection[];
  /** 加载状态 */
  isLoading: boolean;
  /** 错误信息 */
  error?: string;
}

/**
 * 历史节点
 */
export interface HistoricalNode {
  /** 节点ID */
  id: string;
  /** 节点名称 */
  name: string;
  /** 节点类型 */
  type: string;
  /** 节点层级 */
  layer: string;
  /** 节点状态 */
  status: NodeStatus;
  /** 状态描述 */
  statusDescription?: string;
  /** 输入数据 */
  inputData?: any;
  /** 输出数据 */
  outputData?: any;
  /** 处理时间 */
  processingTime?: number;
  /** 错误信息 */
  error?: string;
  /** 时间戳 */
  timestamp: number;
  /** 原始日志条目 */
  logEntries: UnifiedLogEntry[];
}

/**
 * 历史连接
 */
export interface HistoricalConnection {
  /** 源节点ID */
  sourceId: string;
  /** 目标节点ID */
  targetId: string;
  /** 连接状态 */
  status: ConnectionStatus;
  /** 数据传输时间 */
  transferTime?: number;
  /** 数据大小 */
  dataSize?: number;
  /** 时间戳 */
  timestamp: number;
}

/**
 * 节点状态
 */
export type NodeStatus = 'running' | 'success' | 'error' | 'stopped' | 'unknown';

/**
 * 连接状态
 */
export type ConnectionStatus = 'active' | 'inactive' | 'error' | 'unknown';

/**
 * 历史流水线可视化组件
 */
export const HistoricalPipelineVisualizer: React.FC<HistoricalPipelineVisualizerProps> = ({
  historicalData,
  timeSeriesIndex,
  initialTimestamp,
  timeRange,
  moduleFilter,
  levelFilter,
  width = 1200,
  height = 800,
  theme = 'light',
  showTimeline = true,
  showComparison = false,
  showDetails = true,
  timelineHeight = 100,
  detailsPanelWidth = 400,
  onLoadingChange,
  onTimestampChange,
  onNodeSelect
}) => {
  const [state, setState] = useState<HistoricalPipelineState>({
    currentTimestamp: initialTimestamp || Date.now(),
    availableTimestamps: [],
    nodes: [],
    connections: [],
    isLoading: false
  });

  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedTimestamp, setSelectedTimestamp] = useState<number>(state.currentTimestamp);

  /**
   * 加载历史数据
   */
  const loadHistoricalData = useCallback(async () => {
    if (!timeSeriesIndex && !historicalData) return;

    setState(prev => ({ ...prev, isLoading: true }));
    onLoadingChange?.(true);

    try {
      let entries: UnifiedLogEntry[] = [];
      let availableTimestamps: number[] = [];

      if (historicalData) {
        entries = historicalData;
      } else if (timeSeriesIndex) {
        // 从时间序列索引查询数据
        const queryResult = await timeSeriesIndex.query({
          timeRange,
          moduleIds: moduleFilter,
          levels: levelFilter,
          limit: 10000
        });
        entries = queryResult.logs;
      }

      // 提取可用的时间戳
      availableTimestamps = [...new Set(entries.map(entry => entry.timestamp))].sort();

      // 构建当前时间点的流水线状态
      const currentState = buildPipelineState(entries, selectedTimestamp);

      setState({
        currentTimestamp: selectedTimestamp,
        availableTimestamps,
        nodes: currentState.nodes,
        connections: currentState.connections,
        isLoading: false
      });

      onLoadingChange?.(false);

    } catch (error) {
      console.error('加载历史数据失败:', error);
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : '未知错误'
      }));
      onLoadingChange?.(false);
    }
  }, [historicalData, timeSeriesIndex, timeRange, moduleFilter, levelFilter, selectedTimestamp, onLoadingChange]);

  /**
   * 构建指定时间点的流水线状态
   */
  const buildPipelineState = (entries: UnifiedLogEntry[], timestamp: number): {
    nodes: HistoricalNode[];
    connections: HistoricalConnection[];
  } => {
    // 过滤指定时间点附近的日志
    const timeWindow = 60 * 1000; // 1分钟时间窗口
    const relevantEntries = entries.filter(entry => 
      Math.abs(entry.timestamp - timestamp) <= timeWindow
    );

    // 按模块分组日志
    const moduleLogs = new Map<string, UnifiedLogEntry[]>();
    relevantEntries.forEach(entry => {
      const key = `${entry.moduleId}-${entry.moduleType}`;
      if (!moduleLogs.has(key)) {
        moduleLogs.set(key, []);
      }
      moduleLogs.get(key)!.push(entry);
    });

    // 构建节点
    const nodes: HistoricalNode[] = [];
    moduleLogs.forEach((logs, key) => {
      const [moduleId, moduleType] = key.split('-');
      const latestLog = logs.reduce((latest, current) => 
        current.timestamp > latest.timestamp ? current : latest
      );

      const node: HistoricalNode = {
        id: moduleId,
        name: moduleId,
        type: moduleType,
        layer: extractLayerFromModuleId(moduleId),
        status: determineNodeStatus(logs),
        inputData: logs.find(log => log.data)?.data,
        outputData: logs.find(log => log.level === 'info')?.data,
        processingTime: calculateAverageProcessingTime(logs),
        timestamp: latestLog.timestamp,
        logEntries: logs
      };

      nodes.push(node);
    });

    // 构建连接（基于模块间的调用关系）
    const connections = buildConnections(nodes, relevantEntries);

    return { nodes, connections };
  };

  /**
   * 从模块ID提取层级
   */
  const extractLayerFromModuleId = (moduleId: string): string => {
    // 简化的层级提取逻辑
    if (moduleId.includes('switch')) return '1';
    if (moduleId.includes('compatibility')) return '2';
    if (moduleId.includes('provider')) return '3';
    if (moduleId.includes('service')) return '4';
    return 'unknown';
  };

  /**
   * 确定节点状态
   */
  const determineNodeStatus = (logs: UnifiedLogEntry[]): NodeStatus => {
    // 检查是否有错误日志
    const hasError = logs.some(log => log.level === 'error');
    if (hasError) return 'error';

    // 检查最近的日志级别
    const latestLog = logs.reduce((latest, current) => 
      current.timestamp > latest.timestamp ? current : latest
    );

    switch (latestLog.level) {
      case 'info':
        return 'success';
      case 'warn':
        return 'running';
      case 'error':
        return 'error';
      default:
        return 'unknown';
    }
  };

  /**
   * 计算平均处理时间
   */
  const calculateAverageProcessingTime = (logs: UnifiedLogEntry[]): number => {
    const durations = logs.map(log => log.duration).filter(Boolean) as number[];
    if (durations.length === 0) return 0;
    return durations.reduce((sum, duration) => sum + duration, 0) / durations.length;
  };

  /**
   * 构建连接
   */
  const buildConnections = (nodes: HistoricalNode[], logs: UnifiedLogEntry[]): HistoricalConnection[] => {
    const connections: HistoricalConnection[] = [];

    // 简化的连接构建：基于时间顺序和模块依赖
    for (let i = 0; i < nodes.length - 1; i++) {
      const sourceNode = nodes[i];
      const targetNode = nodes[i + 1];

      const connection: HistoricalConnection = {
        sourceId: sourceNode.id,
        targetId: targetNode.id,
        status: determineConnectionStatus(sourceNode, targetNode),
        timestamp: Math.max(sourceNode.timestamp, targetNode.timestamp)
      };

      connections.push(connection);
    }

    return connections;
  };

  /**
   * 确定连接状态
   */
  const determineConnectionStatus = (sourceNode: HistoricalNode, targetNode: HistoricalNode): ConnectionStatus => {
    if (sourceNode.status === 'error' || targetNode.status === 'error') {
      return 'error';
    }
    if (sourceNode.status === 'success' && targetNode.status === 'success') {
      return 'active';
    }
    return 'inactive';
  };

  /**
   * 处理时间戳变化
   */
  const handleTimestampChange = (timestamp: number) => {
    setSelectedTimestamp(timestamp);
    onTimestampChange?.(timestamp);
  };

  /**
   * 处理节点选择
   */
  const handleNodeSelect = (nodeId: string) => {
    setSelectedNode(nodeId);
    const node = state.nodes.find(n => n.id === nodeId);
    if (node) {
      onNodeSelect?.(nodeId, node);
    }
  };

  // 加载数据
  useEffect(() => {
    loadHistoricalData();
  }, [loadHistoricalData]);

  // 更新时间戳变化
  useEffect(() => {
    if (selectedTimestamp !== state.currentTimestamp) {
      loadHistoricalData();
    }
  }, [selectedTimestamp, loadHistoricalData]);

  if (state.isLoading) {
    return (
      <div className={`historical-pipeline-visualizer historical-pipeline-visualizer-${theme}`}>
        <div className="loading-container">
          <div className="loading-spinner">⏳</div>
          <div className="loading-text">正在加载历史数据...</div>
        </div>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className={`historical-pipeline-visualizer historical-pipeline-visualizer-${theme}`}>
        <div className="error-container">
          <div className="error-icon">❌</div>
          <div className="error-text">加载失败: {state.error}</div>
        </div>
      </div>
    );
  }

  return (
    <div className={`historical-pipeline-visualizer historical-pipeline-visualizer-${theme}`}>
      {/* 时间轴控制器 */}
      {showTimeline && (
        <HistoricalTimeline
          timestamps={state.availableTimestamps}
          currentTimestamp={selectedTimestamp}
          onTimestampChange={handleTimestampChange}
          height={timelineHeight}
          theme={theme}
        />
      )}

      {/* 主可视化区域 */}
      <div className="visualization-container">
        <div className="pipeline-canvas" style={{ width: showDetails ? width - detailsPanelWidth : width, height }}>
          <HistoricalPipelineCanvas
            nodes={state.nodes}
            connections={state.connections}
            onNodeSelect={handleNodeSelect}
            selectedNode={selectedNode}
            theme={theme}
            width={showDetails ? width - detailsPanelWidth : width}
            height={height}
          />
        </div>

        {/* 详细信息面板 */}
        {showDetails && (
          <HistoricalDetailsPanel
            selectedNode={selectedNode ? state.nodes.find(n => n.id === selectedNode) : null}
            currentTimestamp={selectedTimestamp}
            width={detailsPanelWidth}
            theme={theme}
          />
        )}
      </div>

      {/* 状态对比面板 */}
      {showComparison && (
        <HistoricalComparisonPanel
          nodes={state.nodes}
          currentTimestamp={selectedTimestamp}
          theme={theme}
        />
      )}

      <style jsx>{`
        .historical-pipeline-visualizer {
          width: 100%;
          height: 100%;
          display: flex;
          flex-direction: column;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }

        .historical-pipeline-visualizer-light {
          background: #ffffff;
          color: #1f2937;
        }

        .historical-pipeline-visualizer-dark {
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
        }

        .visualization-container {
          flex: 1;
          display: flex;
          overflow: hidden;
        }

        .pipeline-canvas {
          position: relative;
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
 * 历史时间轴组件
 */
const HistoricalTimeline: React.FC<{
  timestamps: number[];
  currentTimestamp: number;
  onTimestampChange: (timestamp: number) => void;
  height: number;
  theme: 'light' | 'dark';
}> = ({ timestamps, currentTimestamp, onTimestampChange, height, theme }) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    const index = timestamps.findIndex(ts => ts === currentTimestamp);
    setSelectedIndex(index >= 0 ? index : 0);
  }, [timestamps, currentTimestamp]);

  const handleSliderChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const index = parseInt(event.target.value);
    setSelectedIndex(index);
    if (timestamps[index]) {
      onTimestampChange(timestamps[index]);
    }
  };

  const formatTimestamp = (timestamp: number): string => {
    return new Date(timestamp).toLocaleString();
  };

  return (
    <div className={`historical-timeline historical-timeline-${theme}`} style={{ height }}>
      <div className="timeline-header">
        <h3>时间轴导航</h3>
        <div className="current-time">
          {formatTimestamp(currentTimestamp)}
        </div>
      </div>
      
      <div className="timeline-controls">
        <input
          type="range"
          min="0"
          max={timestamps.length - 1}
          value={selectedIndex}
          onChange={handleSliderChange}
          className="timeline-slider"
        />
        
        <div className="timeline-labels">
          <span>{formatTimestamp(timestamps[0] || Date.now())}</span>
          <span>{formatTimestamp(timestamps[timestamps.length - 1] || Date.now())}</span>
        </div>
      </div>

      <style jsx>{`
        .historical-timeline {
          padding: 1rem;
          border-bottom: 1px solid ${theme === 'dark' ? '#30363d' : '#e5e7eb'};
        }

        .timeline-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 1rem;
        }

        .timeline-header h3 {
          margin: 0;
          font-size: 1.1rem;
          font-weight: 600;
        }

        .current-time {
          font-size: 0.9rem;
          opacity: 0.8;
        }

        .timeline-controls {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }

        .timeline-slider {
          width: 100%;
          height: 6px;
          background: ${theme === 'dark' ? '#30363d' : '#e5e7eb'};
          border-radius: 3px;
          outline: none;
          -webkit-appearance: none;
        }

        .timeline-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 20px;
          height: 20px;
          background: #3b82f6;
          border-radius: 50%;
          cursor: pointer;
        }

        .timeline-labels {
          display: flex;
          justify-content: space-between;
          font-size: 0.8rem;
          opacity: 0.7;
        }
      `}</style>
    </div>
  );
};

/**
 * 历史流水线画布
 */
const HistoricalPipelineCanvas: React.FC<{
  nodes: HistoricalNode[];
  connections: HistoricalConnection[];
  onNodeSelect: (nodeId: string) => void;
  selectedNode: string | null;
  theme: 'light' | 'dark';
  width: number;
  height: number;
}> = ({ nodes, connections, onNodeSelect, selectedNode, theme, width, height }) => {
  return (
    <div className={`historical-pipeline-canvas historical-pipeline-canvas-${theme}`}>
      {/* 渲染节点 */}
      {nodes.map(node => (
        <HistoricalNodeComponent
          key={node.id}
          node={node}
          isSelected={selectedNode === node.id}
          onSelect={() => onNodeSelect(node.id)}
          theme={theme}
        />
      ))}

      {/* 渲染连接 */}
      {connections.map((connection, index) => (
        <HistoricalConnectionComponent
          key={index}
          connection={connection}
          theme={theme}
        />
      ))}

      <style jsx>{`
        .historical-pipeline-canvas {
          position: relative;
          width: 100%;
          height: 100%;
          overflow: hidden;
        }

        .historical-pipeline-canvas-light {
          background: linear-gradient(45deg, #f8fafc 25%, transparent 25%),
                      linear-gradient(-45deg, #f8fafc 25%, transparent 25%),
                      linear-gradient(45deg, transparent 75%, #f8fafc 75%),
                      linear-gradient(-45deg, transparent 75%, #f8fafc 75%);
          background-size: 20px 20px;
          background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
        }

        .historical-pipeline-canvas-dark {
          background: linear-gradient(45deg, #161b22 25%, transparent 25%),
                      linear-gradient(-45deg, #161b22 25%, transparent 25%),
                      linear-gradient(45deg, transparent 75%, #161b22 75%),
                      linear-gradient(-45deg, transparent 75%, #161b22 75%);
          background-size: 20px 20px;
          background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
        }
      `}</style>
    </div>
  );
};

/**
 * 历史节点组件
 */
const HistoricalNodeComponent: React.FC<{
  node: HistoricalNode;
  isSelected: boolean;
  onSelect: () => void;
  theme: 'light' | 'dark';
}> = ({ node, isSelected, onSelect, theme }) => {
  const getNodeColor = () => {
    switch (node.status) {
      case 'success': return '#10b981';
      case 'error': return '#ef4444';
      case 'running': return '#3b82f6';
      case 'stopped': return '#6b7280';
      default: return '#9ca3af';
    }
  };

  return (
    <div 
      className={`historical-node historical-node-${theme} ${isSelected ? 'selected' : ''}`}
      onClick={onSelect}
      style={{
        position: 'absolute',
        left: `${(parseInt(node.layer) - 1) * 250 + 50}px`,
        top: `${50}px`,
        borderColor: getNodeColor()
      }}
    >
      <div className="node-header">
        <div className="node-status" style={{ backgroundColor: getNodeColor() }} />
        <div className="node-name">{node.name}</div>
      </div>
      
      <div className="node-info">
        <div className="node-type">{node.type}</div>
        <div className="node-timestamp">
          {new Date(node.timestamp).toLocaleTimeString()}
        </div>
        {node.processingTime && (
          <div className="node-processing-time">
            {node.processingTime}ms
          </div>
        )}
      </div>

      {node.error && (
        <div className="node-error">
          ⚠️ {node.error}
        </div>
      )}

      <style jsx>{`
        .historical-node {
          background: ${theme === 'dark' ? '#1f2937' : '#ffffff'};
          border: 2px solid;
          border-radius: 8px;
          padding: 12px;
          min-width: 200px;
          cursor: pointer;
          transition: all 0.2s ease;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        }

        .historical-node:hover {
          transform: translateY(-2px);
          box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
        }

        .historical-node.selected {
          box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.5);
        }

        .node-header {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;
        }

        .node-status {
          width: 12px;
          height: 12px;
          border-radius: 50%;
        }

        .node-name {
          font-weight: 600;
          font-size: 14px;
        }

        .node-info {
          font-size: 12px;
          opacity: 0.8;
        }

        .node-type {
          margin-bottom: 4px;
        }

        .node-timestamp {
          font-family: monospace;
          font-size: 11px;
        }

        .node-processing-time {
          font-size: 11px;
          color: #6b7280;
        }

        .node-error {
          margin-top: 8px;
          padding: 4px 8px;
          background: rgba(239, 68, 68, 0.1);
          border-radius: 4px;
          font-size: 11px;
          color: #ef4444;
        }
      `}</style>
    </div>
  );
};

/**
 * 历史连接组件
 */
const HistoricalConnectionComponent: React.FC<{
  connection: HistoricalConnection;
  theme: 'light' | 'dark';
}> = ({ connection, theme }) => {
  const getConnectionColor = () => {
    switch (connection.status) {
      case 'active': return '#10b981';
      case 'error': return '#ef4444';
      case 'inactive': return '#6b7280';
      default: return '#9ca3af';
    }
  };

  return (
    <div 
      className="historical-connection"
      style={{
        position: 'absolute',
        left: `${(parseInt(connection.sourceId.replace(/\D/g, '')) - 1) * 250 + 250}px`,
        top: '100px',
        width: '50px',
        height: '2px',
        backgroundColor: getConnectionColor()
      }}
    >
      <style jsx>{`
        .historical-connection {
          position: absolute;
          height: 2px;
          border-radius: 1px;
        }
      `}</style>
    </div>
  );
};

/**
 * 历史详细信息面板
 */
const HistoricalDetailsPanel: React.FC<{
  selectedNode: HistoricalNode | null;
  currentTimestamp: number;
  width: number;
  theme: 'light' | 'dark';
}> = ({ selectedNode, currentTimestamp, width, theme }) => {
  if (!selectedNode) {
    return (
      <div className={`historical-details-panel historical-details-panel-${theme}`} style={{ width }}>
        <div className="no-selection">
          选择一个节点查看详细信息
        </div>
      </div>
    );
  }

  return (
    <div className={`historical-details-panel historical-details-panel-${theme}`} style={{ width }}>
      <div className="details-header">
        <h3>{selectedNode.name}</h3>
        <div className="node-status-badge">
          {selectedNode.status}
        </div>
      </div>

      <div className="details-content">
        <div className="detail-section">
          <h4>基本信息</h4>
          <div className="detail-item">
            <span className="detail-label">类型:</span>
            <span className="detail-value">{selectedNode.type}</span>
          </div>
          <div className="detail-item">
            <span className="detail-label">层级:</span>
            <span className="detail-value">{selectedNode.layer}</span>
          </div>
          <div className="detail-item">
            <span className="detail-label">时间:</span>
            <span className="detail-value">
              {new Date(selectedNode.timestamp).toLocaleString()}
            </span>
          </div>
        </div>

        {selectedNode.processingTime && (
          <div className="detail-section">
            <h4>性能指标</h4>
            <div className="detail-item">
              <span className="detail-label">处理时间:</span>
              <span className="detail-value">{selectedNode.processingTime}ms</span>
            </div>
          </div>
        )}

        {selectedNode.inputData && (
          <div className="detail-section">
            <h4>输入数据</h4>
            <pre className="detail-data">
              {JSON.stringify(selectedNode.inputData, null, 2)}
            </pre>
          </div>
        )}

        {selectedNode.outputData && (
          <div className="detail-section">
            <h4>输出数据</h4>
            <pre className="detail-data">
              {JSON.stringify(selectedNode.outputData, null, 2)}
            </pre>
          </div>
        )}

        {selectedNode.error && (
          <div className="detail-section error-section">
            <h4>错误信息</h4>
            <div className="error-message">
              {selectedNode.error}
            </div>
          </div>
        )}

        <div className="detail-section">
          <h4>日志条目 ({selectedNode.logEntries.length})</h4>
          <div className="log-entries">
            {selectedNode.logEntries.slice(0, 5).map((log, index) => (
              <div key={index} className="log-entry">
                <div className="log-level">{log.level}</div>
                <div className="log-message">{log.message}</div>
                <div className="log-time">
                  {new Date(log.timestamp).toLocaleTimeString()}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <style jsx>{`
        .historical-details-panel {
          background: ${theme === 'dark' ? '#161b22' : '#f9fafb'};
          border-left: 1px solid ${theme === 'dark' ? '#30363d' : '#e5e7eb'};
          padding: 1rem;
          overflow-y: auto;
        }

        .no-selection {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100%;
          opacity: 0.6;
          font-style: italic;
        }

        .details-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 1rem;
          padding-bottom: 0.5rem;
          border-bottom: 1px solid ${theme === 'dark' ? '#30363d' : '#e5e7eb'};
        }

        .details-header h3 {
          margin: 0;
          font-size: 1.1rem;
        }

        .node-status-badge {
          padding: 4px 8px;
          border-radius: 4px;
          font-size: 0.8rem;
          font-weight: 500;
          text-transform: uppercase;
        }

        .details-content {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }

        .detail-section {
          background: ${theme === 'dark' ? '#1f2937' : '#ffffff'};
          padding: 0.75rem;
          border-radius: 6px;
          border: 1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'};
        }

        .detail-section h4 {
          margin: 0 0 0.5rem 0;
          font-size: 0.9rem;
          font-weight: 600;
        }

        .detail-item {
          display: flex;
          justify-content: space-between;
          margin-bottom: 0.25rem;
        }

        .detail-label {
          font-weight: 500;
          opacity: 0.8;
        }

        .detail-value {
          font-family: monospace;
          font-size: 0.85rem;
        }

        .detail-data {
          background: ${theme === 'dark' ? '#0d1117' : '#f8fafc'};
          padding: 0.5rem;
          border-radius: 4px;
          font-size: 0.8rem;
          overflow-x: auto;
          margin-top: 0.5rem;
        }

        .error-section {
          border-color: #ef4444;
          background: rgba(239, 68, 68, 0.05);
        }

        .error-message {
          color: #ef4444;
          font-size: 0.85rem;
          padding: 0.5rem;
          background: rgba(239, 68, 68, 0.1);
          border-radius: 4px;
        }

        .log-entries {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
          margin-top: 0.5rem;
        }

        .log-entry {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.25rem 0.5rem;
          background: ${theme === 'dark' ? '#0d1117' : '#f8fafc'};
          border-radius: 4px;
          font-size: 0.8rem;
        }

        .log-level {
          padding: 2px 6px;
          border-radius: 3px;
          font-size: 0.7rem;
          font-weight: 600;
          text-transform: uppercase;
        }

        .log-message {
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .log-time {
          font-family: monospace;
          font-size: 0.7rem;
          opacity: 0.7;
        }
      `}</style>
    </div>
  );
};

/**
 * 历史对比面板（占位符）
 */
const HistoricalComparisonPanel: React.FC<{
  nodes: HistoricalNode[];
  currentTimestamp: number;
  theme: 'light' | 'dark';
}> = ({ nodes, currentTimestamp, theme }) => {
  return (
    <div className={`historical-comparison-panel historical-comparison-panel-${theme}`}>
      <div className="comparison-header">
        <h3>状态对比</h3>
      </div>
      <div className="comparison-content">
        <p>状态对比功能开发中...</p>
      </div>

      <style jsx>{`
        .historical-comparison-panel {
          background: ${theme === 'dark' ? '#161b22' : '#f9fafb'};
          border-top: 1px solid ${theme === 'dark' ? '#30363d' : '#e5e7eb'};
          padding: 1rem;
        }

        .comparison-header h3 {
          margin: 0 0 1rem 0;
          font-size: 1.1rem;
        }

        .comparison-content {
          text-align: center;
          opacity: 0.6;
        }
      `}</style>
    </div>
  );
};

export default HistoricalPipelineVisualizer;