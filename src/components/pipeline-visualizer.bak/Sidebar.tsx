import React, { useState, useEffect } from 'react';
import { PipelineNode, SidebarState } from './types';
import { JsonViewer } from './JsonViewer';

export interface SidebarProps {
  /** 侧边栏是否可见 */
  isVisible: boolean;
  /** 选中的节点 */
  selectedNode: PipelineNode | null;
  /** 侧边栏宽度 */
  width?: number;
  /** 主题 */
  theme?: 'light' | 'dark';
  /** 关闭回调 */
  onClose?: () => void;
  /** 数据更新回调 */
  onDataUpdate?: (nodeId: string, dataType: 'input' | 'output' | 'config', data: any) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  isVisible,
  selectedNode,
  width = 400,
  theme = 'light',
  onClose,
  onDataUpdate
}) => {
  const [currentView, setCurrentView] = useState<'input' | 'output' | 'config'>('input');
  const [searchTerm, setSearchTerm] = useState('');
  const [highlightedPath, setHighlightedPath] = useState<string>('');

  // 当选中节点改变时，重置视图
  useEffect(() => {
    if (selectedNode) {
      setCurrentView('input');
      setSearchTerm('');
      setHighlightedPath('');
    }
  }, [selectedNode]);

  if (!isVisible || !selectedNode) {
    return null;
  }

  // 获取当前显示的数据
  const getCurrentData = () => {
    switch (currentView) {
      case 'input':
        return selectedNode.io.input;
      case 'output':
        return selectedNode.io.output;
      case 'config':
        return selectedNode.config || {};
      default:
        return null;
    }
  };

  // 获取视图标题
  const getViewTitle = () => {
    switch (currentView) {
      case 'input':
        return '输入数据';
      case 'output':
        return '输出数据';
      case 'config':
        return '配置信息';
      default:
        return '';
    }
  };

  // 获取状态颜色
  const getStatusColor = (status: string) => {
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
  };

  // 格式化时间戳
  const formatTimestamp = (timestamp: number) => {
    return new Date(timestamp).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  // 处理搜索
  const handleSearch = (term: string) => {
    setSearchTerm(term);
    // 如果搜索到具体路径，可以高亮显示
    if (term && term.includes('.')) {
      setHighlightedPath(term);
    }
  };

  return (
    <div className={`sidebar sidebar-${theme} ${isVisible ? 'sidebar-visible' : ''}`}>
      {/* 侧边栏头部 */}
      <div className="sidebar-header">
        <div className="sidebar-title">
          <h3>{selectedNode.name}</h3>
          <span className="sidebar-subtitle">{selectedNode.type}</span>
        </div>
        <button className="sidebar-close" onClick={onClose}>
          ✕
        </button>
      </div>

      {/* 节点信息摘要 */}
      <div className="sidebar-summary">
        <div className="summary-item">
          <span className="summary-label">状态:</span>
          <span
            className="summary-value summary-status"
            style={{ color: getStatusColor(selectedNode.status) }}
          >
            {selectedNode.status}
          </span>
        </div>
        <div className="summary-item">
          <span className="summary-label">层级:</span>
          <span className="summary-value">{selectedNode.layer}</span>
        </div>
        <div className="summary-item">
          <span className="summary-label">处理时间:</span>
          <span className="summary-value">{selectedNode.io.processingTime}ms</span>
        </div>
        <div className="summary-item">
          <span className="summary-label">更新时间:</span>
          <span className="summary-value">{formatTimestamp(selectedNode.io.timestamp)}</span>
        </div>
        {selectedNode.error && (
          <div className="summary-item summary-error">
            <span className="summary-label">错误:</span>
            <span className="summary-value">{selectedNode.error}</span>
          </div>
        )}
      </div>

      {/* 视图切换 */}
      <div className="sidebar-tabs">
        <button
          className={`tab-button ${currentView === 'input' ? 'tab-active' : ''}`}
          onClick={() => setCurrentView('input')}
        >
          输入数据
        </button>
        <button
          className={`tab-button ${currentView === 'output' ? 'tab-active' : ''}`}
          onClick={() => setCurrentView('output')}
        >
          输出数据
        </button>
        <button
          className={`tab-button ${currentView === 'config' ? 'tab-active' : ''}`}
          onClick={() => setCurrentView('config')}
        >
          配置信息
        </button>
      </div>

      {/* 搜索栏 */}
      <div className="sidebar-search">
        <input
          type="text"
          placeholder="搜索键名或值..."
          value={searchTerm}
          onChange={(e) => handleSearch(e.target.value)}
          className="search-input"
        />
      </div>

      {/* JSON查看器 */}
      <div className="sidebar-content">
        <JsonViewer
          data={getCurrentData()}
          title={getViewTitle()}
          collapsible={true}
          defaultExpandDepth={2}
          showLineNumbers={true}
          searchable={false} // 使用自定义搜索
          copyable={true}
          theme={theme}
          highlightPath={highlightedPath}
          customRenderers={{
            'object': (value: any, path: string) => {
              if (path.includes('metadata') || path.includes('_metadata')) {
                return (
                  <span style={{ color: theme === 'dark' ? '#9cdcfe' : '#1f2937' }}>
                    {Object.keys(value).length === 0 ? '{}' : '{...}'}
                  </span>
                );
              }
              return null;
            },
            'array': (value: any, path: string) => {
              if (path.includes('messages')) {
                return (
                  <span style={{ color: theme === 'dark' ? '#ce9178' : '#059669' }}>
                    [{value.length} 条消息]
                  </span>
                );
              }
              if (path.includes('tools')) {
                return (
                  <span style={{ color: theme === 'dark' ? '#b5cea8' : '#2563eb' }}>
                    [{value.length} 个工具]
                  </span>
                );
              }
              return null;
            }
          }}
        />
      </div>

      {/* 底部工具栏 */}
      <div className="sidebar-footer">
        <button
          className="footer-button"
          onClick={() => {
            const data = getCurrentData();
            navigator.clipboard.writeText(JSON.stringify(data, null, 2));
          }}
        >
          📋 复制全部
        </button>
        <button
          className="footer-button"
          onClick={() => {
            // 下载为JSON文件
            const data = getCurrentData();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${selectedNode.name}_${currentView}_${Date.now()}.json`;
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          💾 下载文件
        </button>
      </div>

      <style jsx>{`
        .sidebar {
          position: fixed;
          top: 0;
          right: 0;
          height: 100vh;
          width: ${width}px;
          background: ${theme === 'dark' ? '#1e1e1e' : '#ffffff'};
          border-left: 1px solid ${theme === 'dark' ? '#404040' : '#e5e7eb'};
          box-shadow: -4px 0 20px rgba(0, 0, 0, 0.1);
          z-index: 1000;
          display: flex;
          flex-direction: column;
          transition: transform 0.3s ease;
        }

        .sidebar-visible {
          transform: translateX(0);
        }

        .sidebar-header {
          padding: 20px;
          border-bottom: 1px solid ${theme === 'dark' ? '#404040' : '#e5e7eb'};
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
        }

        .sidebar-title h3 {
          margin: 0 0 4px 0;
          font-size: 18px;
          font-weight: 600;
          color: ${theme === 'dark' ? '#ffffff' : '#1f2937'};
        }

        .sidebar-subtitle {
          font-size: 14px;
          color: ${theme === 'dark' ? '#858585' : '#6b7280'};
        }

        .sidebar-close {
          background: none;
          border: none;
          color: ${theme === 'dark' ? '#858585' : '#6b7280'};
          font-size: 18px;
          cursor: pointer;
          padding: 4px;
          border-radius: 4px;
          transition: all 0.2s;
        }

        .sidebar-close:hover {
          background: ${theme === 'dark' ? '#404040' : '#e5e7eb'};
        }

        .sidebar-summary {
          padding: 16px 20px;
          border-bottom: 1px solid ${theme === 'dark' ? '#404040' : '#e5e7eb'};
          background: ${theme === 'dark' ? '#2d2d2d' : '#f9fafb'};
        }

        .summary-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
          font-size: 14px;
        }

        .summary-item:last-child {
          margin-bottom: 0;
        }

        .summary-label {
          color: ${theme === 'dark' ? '#858585' : '#6b7280'};
        }

        .summary-value {
          color: ${theme === 'dark' ? '#d4d4d4' : '#1f2937'};
          font-weight: 500;
        }

        .summary-status {
          font-weight: 600;
          text-transform: uppercase;
        }

        .summary-error {
          color: ${theme === 'dark' ? '#e06c75' : '#ef4444'};
        }

        .sidebar-tabs {
          display: flex;
          border-bottom: 1px solid ${theme === 'dark' ? '#404040' : '#e5e7eb'};
        }

        .tab-button {
          flex: 1;
          padding: 12px 16px;
          background: none;
          border: none;
          color: ${theme === 'dark' ? '#858585' : '#6b7280'};
          font-size: 14px;
          cursor: pointer;
          transition: all 0.2s;
          border-bottom: 2px solid transparent;
        }

        .tab-button:hover {
          background: ${theme === 'dark' ? '#2d2d2d' : '#f9fafb'};
        }

        .tab-active {
          color: ${theme === 'dark' ? '#ffffff' : '#1f2937'};
          border-bottom-color: ${theme === 'dark' ? '#3b82f6' : '#2563eb'};
          background: ${theme === 'dark' ? '#2d2d2d' : '#f9fafb'};
        }

        .sidebar-search {
          padding: 12px 20px;
          border-bottom: 1px solid ${theme === 'dark' ? '#404040' : '#e5e7eb'};
        }

        .search-input {
          width: 100%;
          padding: 8px 12px;
          border: 1px solid ${theme === 'dark' ? '#404040' : '#d1d5db'};
          border-radius: 4px;
          background: ${theme === 'dark' ? '#2d2d2d' : '#f9fafb'};
          color: ${theme === 'dark' ? '#d4d4d4' : '#1f2937'};
          font-size: 12px;
        }

        .sidebar-content {
          flex: 1;
          overflow-y: auto;
          padding: 0;
        }

        .sidebar-footer {
          padding: 12px 20px;
          border-top: 1px solid ${theme === 'dark' ? '#404040' : '#e5e7eb'};
          display: flex;
          gap: 8px;
        }

        .footer-button {
          flex: 1;
          padding: 8px 12px;
          border: 1px solid ${theme === 'dark' ? '#404040' : '#d1d5db'};
          border-radius: 4px;
          background: ${theme === 'dark' ? '#2d2d2d' : '#f9fafb'};
          color: ${theme === 'dark' ? '#d4d4d4' : '#1f2937'};
          font-size: 12px;
          cursor: pointer;
          transition: all 0.2s;
        }

        .footer-button:hover {
          background: ${theme === 'dark' ? '#404040' : '#e5e7eb'};
        }

        @media (max-width: 768px) {
          .sidebar {
            width: 100%;
            max-width: 400px;
          }
        }
      `}</style>
    </div>
  );
};