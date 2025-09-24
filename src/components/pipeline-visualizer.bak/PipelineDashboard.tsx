import React, { useState, useEffect, useCallback } from 'react';
import { PipelineVisualizer } from './PipelineVisualizer';
import { Sidebar } from './Sidebar';
import { PipelineData, PipelineNode } from './types';

export interface PipelineDashboardProps {
  /** 初始流水线数据 */
  initialData?: PipelineData;
  /** 容器宽度 */
  width?: number;
  /** 容器高度 */
  height?: number;
  /** 主题 */
  theme?: 'light' | 'dark';
  /** 是否启用实时更新 */
  enableRealTime?: boolean;
  /** 更新间隔（毫秒） */
  updateInterval?: number;
  /** 数据获取函数 */
  fetchData?: () => Promise<PipelineData>;
  /** 节点点击回调 */
  onNodeClick?: (node: PipelineNode) => void;
  /** 数据更新回调 */
  onDataUpdate?: (data: PipelineData) => void;
}

export const PipelineDashboard: React.FC<PipelineDashboardProps> = ({
  initialData,
  width = 1200,
  height = 800,
  theme = 'light',
  enableRealTime = true,
  updateInterval = 1000,
  fetchData,
  onNodeClick,
  onDataUpdate
}) => {
  const [data, setData] = useState<PipelineData>(initialData || getDefaultPipelineData());
  const [selectedNode, setSelectedNode] = useState<PipelineNode | null>(null);
  const [isSidebarVisible, setIsSidebarVisible] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 获取默认数据
  function getDefaultPipelineData(): PipelineData {
    return {
      id: 'pipeline-1',
      name: 'RCC4 Pipeline',
      overallStatus: 'running',
      nodes: [
        {
          id: 'llm-switch',
          name: 'LLM Switch',
          type: 'Dynamic Router',
          layer: '1',
          status: 'running',
          description: '动态路由分类模块，负责请求分析和路由选择',
          io: {
            input: {
              model: 'qwen3-4b-thinking-2507-mlx',
              messages: [{ role: 'user', content: 'Hello world' }],
              tools: []
            },
            output: {
              model: 'qwen3-4b-thinking-2507-mlx',
              messages: [{ role: 'user', content: 'Hello world' }],
              tools: [],
              _metadata: {
                switchType: 'openai-passthrough',
                timestamp: Date.now(),
                originalProtocol: 'openai',
                targetProtocol: 'openai'
              }
            },
            timestamp: Date.now(),
            processingTime: 150
          }
        },
        {
          id: 'compatibility',
          name: 'Compatibility',
          type: 'Format Transformer',
          layer: '2',
          status: 'running',
          description: '兼容性转换模块，负责协议格式转换',
          io: {
            input: {
              model: 'qwen3-4b-thinking-2507-mlx',
              messages: [{ role: 'user', content: 'Hello world' }],
              tools: [],
              _metadata: {
                switchType: 'openai-passthrough',
                timestamp: Date.now(),
                originalProtocol: 'openai',
                targetProtocol: 'openai'
              }
            },
            output: {
              model: 'qwen3-4b-thinking-2507-mlx',
              messages: [{ role: 'user', content: 'Hello world' }],
              tools: [],
              _metadata: {
                switchType: 'openai-passthrough',
                timestamp: Date.now(),
                originalProtocol: 'openai',
                targetProtocol: 'openai'
              }
            },
            timestamp: Date.now(),
            processingTime: 80
          }
        },
        {
          id: 'provider',
          name: 'Provider',
          type: 'HTTP Server',
          layer: '3',
          status: 'running',
          description: 'Provider模块，负责HTTP通信',
          io: {
            input: {
              model: 'qwen3-4b-thinking-2507-mlx',
              messages: [{ role: 'user', content: 'Hello world' }],
              tools: []
            },
            output: {
              id: 'chat-xxx',
              object: 'chat.completion',
              choices: [{
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'Hello! How can I help you today?'
                },
                finish_reason: 'stop'
              }],
              usage: {
                prompt_tokens: 25,
                completion_tokens: 10,
                total_tokens: 35
              }
            },
            timestamp: Date.now(),
            processingTime: 300
          }
        },
        {
          id: 'ai-service',
          name: 'AI Service',
          type: 'External Provider',
          layer: '4',
          status: 'success',
          description: '外部AI服务，负责模型推理',
          io: {
            input: {
              model: 'qwen3-4b-thinking-2507-mlx',
              messages: [{ role: 'user', content: 'Hello world' }],
              tools: []
            },
            output: {
              id: 'chat-xxx',
              object: 'chat.completion',
              choices: [{
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'Hello! How can I help you today?'
                },
                finish_reason: 'stop'
              }],
              usage: {
                prompt_tokens: 25,
                completion_tokens: 10,
                total_tokens: 35
              }
            },
            timestamp: Date.now(),
            processingTime: 500
          }
        }
      ],
      connections: [
        { sourceId: 'llm-switch', targetId: 'compatibility', status: 'active' },
        { sourceId: 'compatibility', targetId: 'provider', status: 'active' },
        { sourceId: 'provider', targetId: 'ai-service', status: 'active' }
      ],
      metrics: {
        totalRequests: 1250,
        successRate: 0.95,
        averageResponseTime: 350,
        timestamp: Date.now()
      }
    };
  }

  // 加载数据
  const loadData = useCallback(async () => {
    if (!fetchData) return;

    setIsLoading(true);
    setError(null);

    try {
      const newData = await fetchData();
      setData(newData);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载数据失败');
    } finally {
      setIsLoading(false);
    }
  }, [fetchData]);

  // 初始化加载数据
  useEffect(() => {
    if (fetchData) {
      loadData();
    }
  }, [fetchData, loadData]);

  // 实时更新
  useEffect(() => {
    if (!enableRealTime) return;

    const interval = setInterval(async () => {
      if (fetchData) {
        await loadData();
      } else {
        // 模拟数据更新
        setData(prev => simulateDataUpdate(prev));
      }
    }, updateInterval);

    return () => clearInterval(interval);
  }, [enableRealTime, updateInterval, fetchData, loadData]);

  // 模拟数据更新
  const simulateDataUpdate = (prevData: PipelineData): PipelineData => {
    return {
      ...prevData,
      nodes: prevData.nodes.map(node => ({
        ...node,
        status: Math.random() > 0.8 ? 'error' : Math.random() > 0.5 ? 'running' : 'success',
        io: {
          ...node.io,
          timestamp: Date.now(),
          processingTime: Math.floor(Math.random() * 1000) + 100
        }
      })),
      connections: prevData.connections.map(conn => ({
        ...conn,
        status: Math.random() > 0.8 ? 'error' : 'active'
      })),
      metrics: {
        totalRequests: prevData.metrics.totalRequests + Math.floor(Math.random() * 10),
        successRate: Math.max(0.7, Math.min(1.0, prevData.metrics.successRate + (Math.random() - 0.5) * 0.1)),
        averageResponseTime: Math.floor(Math.random() * 500) + 200,
        timestamp: Date.now()
      }
    };
  };

  // 处理节点点击
  const handleNodeClick = useCallback((node: PipelineNode) => {
    setSelectedNode(node);
    setIsSidebarVisible(true);
    onNodeClick?.(node);
  }, [onNodeClick]);

  // 处理数据更新
  const handleDataUpdate = useCallback((newData: PipelineData) => {
    setData(newData);
    onDataUpdate?.(newData);
  }, [onDataUpdate]);

  // 关闭侧边栏
  const handleCloseSidebar = useCallback(() => {
    setIsSidebarVisible(false);
    setSelectedNode(null);
  }, []);

  // 刷新数据
  const handleRefresh = useCallback(async () => {
    if (fetchData) {
      await loadData();
    } else {
      setData(prev => simulateDataUpdate(prev));
    }
  }, [fetchData, loadData]);

  return (
    <div className={`pipeline-dashboard pipeline-dashboard-${theme}`}>
      {/* 顶部工具栏 */}
      <div className="dashboard-toolbar">
        <div className="toolbar-left">
          <h1 className="dashboard-title">流水线可视化系统</h1>
          <div className="pipeline-status">
            <span className="status-indicator" style={{ backgroundColor: getStatusColor(data.overallStatus) }} />
            <span className="status-text">{data.name} - {data.overallStatus}</span>
          </div>
        </div>
        <div className="toolbar-right">
          <button
            onClick={handleRefresh}
            disabled={isLoading}
            className="toolbar-button"
          >
            {isLoading ? '⏳ 加载中...' : '🔄 刷新'}
          </button>
          <button
            onClick={() => setIsSidebarVisible(!isSidebarVisible)}
            className="toolbar-button"
          >
            {isSidebarVisible ? '📊 隐藏面板' : '📊 显示面板'}
          </button>
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="dashboard-error">
          <span className="error-icon">⚠️</span>
          <span className="error-message">{error}</span>
          <button onClick={() => setError(null)} className="error-close">
            ✕
          </button>
        </div>
      )}

      {/* 主要内容区域 */}
      <div className="dashboard-content">
        <div className="visualizer-container">
          <PipelineVisualizer
            pipelineData={data}
            width={width - (isSidebarVisible ? 400 : 0)}
            height={height - 120}
            onNodeClick={handleNodeClick}
            onDataUpdate={handleDataUpdate}
            enableRealTime={enableRealTime}
            updateInterval={updateInterval}
          />
        </div>

        {/* 侧边栏 */}
        <Sidebar
          isVisible={isSidebarVisible}
          selectedNode={selectedNode}
          width={400}
          theme={theme}
          onClose={handleCloseSidebar}
        />
      </div>

      {/* 底部状态栏 */}
      <div className="dashboard-footer">
        <div className="footer-left">
          <span className="footer-item">
            总请求: <strong>{data.metrics.totalRequests}</strong>
          </span>
          <span className="footer-item">
            成功率: <strong>{(data.metrics.successRate * 100).toFixed(1)}%</strong>
          </span>
          <span className="footer-item">
            平均响应时间: <strong>{data.metrics.averageResponseTime}ms</strong>
          </span>
        </div>
        <div className="footer-right">
          <span className="footer-item">
            更新时间: <strong>{new Date(data.metrics.timestamp).toLocaleTimeString()}</strong>
          </span>
        </div>
      </div>

      <style jsx>{`
        .pipeline-dashboard {
          width: 100%;
          height: 100vh;
          background: ${theme === 'dark' ? '#0d1117' : '#ffffff'};
          color: ${theme === 'dark' ? '#d4d4d4' : '#1f2937'};
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }

        .dashboard-toolbar {
          height: 60px;
          padding: 0 20px;
          border-bottom: 1px solid ${theme === 'dark' ? '#30363d' : '#e5e7eb'};
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: ${theme === 'dark' ? '#0d1117' : '#ffffff'};
        }

        .toolbar-left {
          display: flex;
          align-items: center;
          gap: 20px;
        }

        .dashboard-title {
          margin: 0;
          font-size: 20px;
          font-weight: 600;
          color: ${theme === 'dark' ? '#ffffff' : '#1f2937'};
        }

        .pipeline-status {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 14px;
        }

        .status-indicator {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          animation: pulse 2s infinite;
        }

        @keyframes pulse {
          0% { opacity: 1; }
          50% { opacity: 0.5; }
          100% { opacity: 1; }
        }

        .status-text {
          color: ${theme === 'dark' ? '#858585' : '#6b7280'};
        }

        .toolbar-right {
          display: flex;
          gap: 10px;
        }

        .toolbar-button {
          padding: 8px 16px;
          border: 1px solid ${theme === 'dark' ? '#30363d' : '#d1d5db'};
          border-radius: 6px;
          background: ${theme === 'dark' ? '#21262d' : '#f9fafb'};
          color: ${theme === 'dark' ? '#d4d4d4' : '#1f2937'};
          font-size: 14px;
          cursor: pointer;
          transition: all 0.2s;
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .toolbar-button:hover:not(:disabled) {
          background: ${theme === 'dark' ? '#30363d' : '#e5e7eb'};
        }

        .toolbar-button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .dashboard-error {
          height: 40px;
          padding: 0 20px;
          display: flex;
          align-items: center;
          gap: 10px;
          background: ${theme === 'dark' ? '#490202' : '#fef2f2'};
          color: ${theme === 'dark' ? '#f85149' : '#ef4444'};
          border-bottom: 1px solid ${theme === 'dark' ? '#490202' : '#fecaca'};
        }

        .error-message {
          flex: 1;
          font-size: 14px;
        }

        .error-close {
          background: none;
          border: none;
          color: ${theme === 'dark' ? '#f85149' : '#ef4444'};
          cursor: pointer;
          padding: 4px;
          border-radius: 4px;
        }

        .error-close:hover {
          background: ${theme === 'dark' ? '#490202' : '#fecaca'};
        }

        .dashboard-content {
          flex: 1;
          display: flex;
          position: relative;
          overflow: hidden;
        }

        .visualizer-container {
          flex: 1;
          overflow: hidden;
        }

        .dashboard-footer {
          height: 40px;
          padding: 0 20px;
          border-top: 1px solid ${theme === 'dark' ? '#30363d' : '#e5e7eb'};
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: ${theme === 'dark' ? '#0d1117' : '#ffffff'};
          font-size: 12px;
        }

        .footer-left, .footer-right {
          display: flex;
          gap: 20px;
        }

        .footer-item {
          color: ${theme === 'dark' ? '#858585' : '#6b7280'};
        }

        .footer-item strong {
          color: ${theme === 'dark' ? '#d4d4d4' : '#1f2937'};
        }
      `}</style>
    </div>
  );
};

// 获取状态颜色
function getStatusColor(status: string): string {
  switch (status) {
    case 'running':
      return '#3b82f6';
    case 'success':
      return '#10b981';
    case 'error':
      return '#ef4444';
    case 'stopped':
      return '#6b7280';
    default:
      return '#6b7280';
  }
}