import React, { useState, useEffect, useCallback } from 'react';
import { PipelineData, PipelineNode, NodeStatus } from './types';

export interface RealTimeMonitorProps {
  /** 流水线数据 */
  pipelineData: PipelineData;
  /** 数据更新回调 */
  onDataUpdate: (data: PipelineData) => void;
  /** 监控间隔（毫秒） */
  interval?: number;
  /** 是否启用监控 */
  enabled?: boolean;
  /** 告警阈值 */
  thresholds?: {
    errorRate: number;
    responseTime: number;
    successRate: number;
  };
  /** 告警回调 */
  onAlert?: (alert: AlertData) => void;
}

export interface AlertData {
  /** 告警类型 */
  type: 'error' | 'warning' | 'info';
  /** 告警消息 */
  message: string;
  /** 节点ID */
  nodeId?: string;
  /** 时间戳 */
  timestamp: number;
  /** 严重程度 */
  severity: 'low' | 'medium' | 'high';
}

export const RealTimeMonitor: React.FC<RealTimeMonitorProps> = ({
  pipelineData,
  onDataUpdate,
  interval = 1000,
  enabled = true,
  thresholds = {
    errorRate: 0.1,
    responseTime: 1000,
    successRate: 0.9
  },
  onAlert
}) => {
  const [isMonitoring, setIsMonitoring] = useState(enabled);
  const [alerts, setAlerts] = useState<AlertData[]>([]);
  const [stats, setStats] = useState({
    totalNodes: 0,
    healthyNodes: 0,
    errorNodes: 0,
    avgResponseTime: 0,
    errorRate: 0
  });

  // 计算节点状态统计
  const calculateStats = useCallback((data: PipelineData) => {
    const nodes = data.nodes;
    const totalNodes = nodes.length;
    const healthyNodes = nodes.filter(n => n.status === 'success' || n.status === 'running').length;
    const errorNodes = nodes.filter(n => n.status === 'error').length;
    const avgResponseTime = nodes.reduce((sum, n) => sum + n.io.processingTime, 0) / totalNodes;
    const errorRate = errorNodes / totalNodes;

    return {
      totalNodes,
      healthyNodes,
      errorNodes,
      avgResponseTime: Math.round(avgResponseTime),
      errorRate: Math.round(errorRate * 100) / 100
    };
  }, []);

  // 生成模拟监控数据
  const generateMonitoringData = useCallback((data: PipelineData): PipelineData => {
    const updatedNodes = data.nodes.map(node => {
      // 模拟状态变化
      const random = Math.random();
      let newStatus: NodeStatus = node.status;

      if (random < 0.05) { // 5% 概率出现错误
        newStatus = 'error';
        node.error = '模拟错误: 处理超时';
      } else if (random < 0.15) { // 10% 概率变为运行状态
        newStatus = 'running';
        node.error = undefined;
      } else if (random < 0.25) { // 10% 概率变为成功状态
        newStatus = 'success';
        node.error = undefined;
      }

      return {
        ...node,
        status: newStatus,
        io: {
          ...node.io,
          timestamp: Date.now(),
          processingTime: Math.floor(Math.random() * 1000) + 100,
          // 模拟数据变化
          input: {
            ...node.io.input,
            _metadata: {
              ...node.io.input._metadata,
              timestamp: Date.now()
            }
          }
        }
      };
    });

    // 更新连接状态
    const updatedConnections = data.connections.map(conn => ({
      ...conn,
      status: Math.random() > 0.8 ? 'error' : 'active'
    }));

    // 更新指标
    const newMetrics = {
      ...data.metrics,
      totalRequests: data.metrics.totalRequests + Math.floor(Math.random() * 10),
      successRate: Math.max(0.7, Math.min(1.0, data.metrics.successRate + (Math.random() - 0.5) * 0.1)),
      averageResponseTime: Math.floor(Math.random() * 500) + 200,
      timestamp: Date.now()
    };

    return {
      ...data,
      nodes: updatedNodes,
      connections: updatedConnections,
      metrics: newMetrics,
      overallStatus: updatedNodes.some(n => n.status === 'error') ? 'error' : 'running'
    };
  }, []);

  // 检查告警条件
  const checkAlerts = useCallback((data: PipelineData, currentStats: any) => {
    const newAlerts: AlertData[] = [];

    // 检查错误率
    if (currentStats.errorRate > thresholds.errorRate) {
      newAlerts.push({
        type: 'error',
        message: `错误率过高: ${(currentStats.errorRate * 100).toFixed(1)}%`,
        timestamp: Date.now(),
        severity: 'high'
      });
    }

    // 检查响应时间
    if (currentStats.avgResponseTime > thresholds.responseTime) {
      newAlerts.push({
        type: 'warning',
        message: `平均响应时间过长: ${currentStats.avgResponseTime}ms`,
        timestamp: Date.now(),
        severity: 'medium'
      });
    }

    // 检查成功率
    if (data.metrics.successRate < thresholds.successRate) {
      newAlerts.push({
        type: 'warning',
        message: `成功率过低: ${(data.metrics.successRate * 100).toFixed(1)}%`,
        timestamp: Date.now(),
        severity: 'medium'
      });
    }

    // 检查节点状态
    data.nodes.forEach(node => {
      if (node.status === 'error') {
        newAlerts.push({
          type: 'error',
          message: `节点 ${node.name} 出现错误`,
          nodeId: node.id,
          timestamp: Date.now(),
          severity: 'high'
        });
      }
    });

    return newAlerts;
  }, [thresholds]);

  // 监控循环
  useEffect(() => {
    if (!isMonitoring) return;

    const monitoringInterval = setInterval(() => {
      const updatedData = generateMonitoringData(pipelineData);
      const currentStats = calculateStats(updatedData);
      const newAlerts = checkAlerts(updatedData, currentStats);

      // 更新统计数据
      setStats(currentStats);

      // 添加新告警
      if (newAlerts.length > 0) {
        setAlerts(prev => [...prev, ...newAlerts]);
        newAlerts.forEach(alert => onAlert?.(alert));
      }

      // 更新数据
      onDataUpdate(updatedData);
    }, interval);

    return () => clearInterval(monitoringInterval);
  }, [isMonitoring, interval, pipelineData, generateMonitoringData, calculateStats, checkAlerts, onDataUpdate, onAlert]);

  // 启动/停止监控
  const toggleMonitoring = useCallback(() => {
    setIsMonitoring(prev => !prev);
  }, []);

  // 清除告警
  const clearAlerts = useCallback(() => {
    setAlerts([]);
  }, []);

  // 清除单个告警
  const clearAlert = useCallback((index: number) => {
    setAlerts(prev => prev.filter((_, i) => i !== index));
  }, []);

  return (
    <div className="real-time-monitor">
      <div className="monitor-header">
        <div className="monitor-title">
          <h3>实时监控</h3>
          <div className="monitor-status">
            <span className={`status-indicator ${isMonitoring ? 'monitoring' : 'stopped'}`} />
            <span>{isMonitoring ? '监控中' : '已停止'}</span>
          </div>
        </div>
        <div className="monitor-controls">
          <button
            onClick={toggleMonitoring}
            className={`control-btn ${isMonitoring ? 'stop' : 'start'}`}
          >
            {isMonitoring ? '⏹ 停止监控' : '▶ 开始监控'}
          </button>
          <button onClick={clearAlerts} className="control-btn clear">
            🗑 清除告警
          </button>
        </div>
      </div>

      {/* 统计信息 */}
      <div className="monitor-stats">
        <div className="stat-item">
          <div className="stat-label">总节点数</div>
          <div className="stat-value">{stats.totalNodes}</div>
        </div>
        <div className="stat-item">
          <div className="stat-label">健康节点</div>
          <div className="stat-value healthy">{stats.healthyNodes}</div>
        </div>
        <div className="stat-item">
          <div className="stat-label">错误节点</div>
          <div className="stat-value error">{stats.errorNodes}</div>
        </div>
        <div className="stat-item">
          <div className="stat-label">平均响应时间</div>
          <div className="stat-value">{stats.avgResponseTime}ms</div>
        </div>
        <div className="stat-item">
          <div className="stat-label">错误率</div>
          <div className={`stat-value ${stats.errorRate > thresholds.errorRate ? 'error' : ''}`}>
            {(stats.errorRate * 100).toFixed(1)}%
          </div>
        </div>
      </div>

      {/* 告警列表 */}
      <div className="monitor-alerts">
        <h4>告警列表</h4>
        <div className="alerts-container">
          {alerts.length === 0 ? (
            <div className="no-alerts">暂无告警</div>
          ) : (
            alerts.map((alert, index) => (
              <div
                key={`${alert.timestamp}-${index}`}
                className={`alert-item alert-${alert.type} alert-${alert.severity}`}
              >
                <div className="alert-content">
                  <div className="alert-message">{alert.message}</div>
                  <div className="alert-time">
                    {new Date(alert.timestamp).toLocaleTimeString()}
                  </div>
                </div>
                <button
                  onClick={() => clearAlert(index)}
                  className="alert-close"
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* 监控日志 */}
      <div className="monitor-logs">
        <h4>监控日志</h4>
        <div className="logs-container">
          <div className="log-entry">
            <span className="log-time">{new Date().toLocaleTimeString()}</span>
            <span className="log-message">
              监控系统{isMonitoring ? '启动' : '停止'}，间隔: {interval}ms
            </span>
          </div>
          {alerts.slice(-5).map((alert, index) => (
            <div key={`log-${index}`} className="log-entry log-alert">
              <span className="log-time">{new Date(alert.timestamp).toLocaleTimeString()}</span>
              <span className="log-message">
                [{alert.type.toUpperCase()}] {alert.message}
              </span>
            </div>
          ))}
        </div>
      </div>

      <style jsx>{`
        .real-time-monitor {
          background: #1e1e1e;
          color: #d4d4d4;
          padding: 16px;
          border-radius: 8px;
          height: 100%;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .monitor-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding-bottom: 12px;
          border-bottom: 1px solid #404040;
        }

        .monitor-title {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .monitor-title h3 {
          margin: 0;
          font-size: 16px;
          font-weight: 600;
        }

        .monitor-status {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 12px;
          color: #858585;
        }

        .status-indicator {
          width: 8px;
          height: 8px;
          border-radius: 50%;
        }

        .status-indicator.monitoring {
          background: #10b981;
          animation: pulse 1s infinite;
        }

        .status-indicator.stopped {
          background: #6b7280;
        }

        @keyframes pulse {
          0% { opacity: 1; }
          50% { opacity: 0.5; }
          100% { opacity: 1; }
        }

        .monitor-controls {
          display: flex;
          gap: 8px;
        }

        .control-btn {
          padding: 6px 12px;
          border: 1px solid #404040;
          border-radius: 4px;
          background: #2d2d2d;
          color: #d4d4d4;
          font-size: 12px;
          cursor: pointer;
          transition: all 0.2s;
        }

        .control-btn:hover {
          background: #404040;
        }

        .control-btn.start {
          border-color: #10b981;
          color: #10b981;
        }

        .control-btn.stop {
          border-color: #ef4444;
          color: #ef4444;
        }

        .monitor-stats {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
          gap: 12px;
        }

        .stat-item {
          background: #2d2d2d;
          padding: 12px;
          border-radius: 6px;
          text-align: center;
        }

        .stat-label {
          font-size: 11px;
          color: #858585;
          margin-bottom: 4px;
        }

        .stat-value {
          font-size: 16px;
          font-weight: 600;
          color: #d4d4d4;
        }

        .stat-value.healthy {
          color: #10b981;
        }

        .stat-value.error {
          color: #ef4444;
        }

        .monitor-alerts {
          flex: 1;
          display: flex;
          flex-direction: column;
        }

        .monitor-alerts h4 {
          margin: 0 0 8px 0;
          font-size: 14px;
          font-weight: 600;
        }

        .alerts-container {
          flex: 1;
          overflow-y: auto;
          max-height: 200px;
        }

        .no-alerts {
          text-align: center;
          color: #858585;
          font-size: 12px;
          padding: 20px;
        }

        .alert-item {
          padding: 8px 12px;
          margin-bottom: 4px;
          border-radius: 4px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          animation: slideIn 0.3s ease;
        }

        @keyframes slideIn {
          from {
            opacity: 0;
            transform: translateX(-20px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }

        .alert-item.alert-error {
          background: #490202;
          border-left: 3px solid #ef4444;
        }

        .alert-item.alert-warning {
          background: #423502;
          border-left: 3px solid #f59e0b;
        }

        .alert-item.alert-info {
          background: #1e3a5f;
          border-left: 3px solid #3b82f6;
        }

        .alert-content {
          flex: 1;
        }

        .alert-message {
          font-size: 12px;
          font-weight: 500;
        }

        .alert-time {
          font-size: 10px;
          color: #858585;
          margin-top: 2px;
        }

        .alert-close {
          background: none;
          border: none;
          color: #858585;
          cursor: pointer;
          padding: 4px;
          border-radius: 2px;
          font-size: 10px;
        }

        .alert-close:hover {
          background: rgba(255, 255, 255, 0.1);
        }

        .monitor-logs {
          flex: 1;
          display: flex;
          flex-direction: column;
        }

        .monitor-logs h4 {
          margin: 0 0 8px 0;
          font-size: 14px;
          font-weight: 600;
        }

        .logs-container {
          flex: 1;
          overflow-y: auto;
          max-height: 150px;
          font-size: 11px;
          font-family: 'Monaco', 'Menlo', monospace;
        }

        .log-entry {
          padding: 4px 8px;
          margin-bottom: 2px;
          border-radius: 2px;
          display: flex;
          gap: 8px;
        }

        .log-entry.log-alert {
          background: rgba(239, 68, 68, 0.1);
        }

        .log-time {
          color: #858585;
          min-width: 80px;
        }

        .log-message {
          color: #d4d4d4;
        }
      `}</style>
    </div>
  );
};