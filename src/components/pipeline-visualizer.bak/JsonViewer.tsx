import React, { useState, useCallback, useMemo } from 'react';
import { JsonViewerNode } from './types';

export interface JsonViewerProps {
  /** 要显示的数据 */
  data: any;
  /** 标题 */
  title?: string;
  /** 是否可折叠 */
  collapsible?: boolean;
  /** 默认展开深度 */
  defaultExpandDepth?: number;
  /** 显示行号 */
  showLineNumbers?: boolean;
  /** 搜索功能 */
  searchable?: boolean;
  /** 复制功能 */
  copyable?: boolean;
  /** 主题 */
  theme?: 'light' | 'dark';
  /** 高亮路径 */
  highlightPath?: string;
  /** 自定义渲染器 */
  customRenderers?: Record<string, (value: any, path: string) => React.ReactNode>;
}

export const JsonViewer: React.FC<JsonViewerProps> = ({
  data,
  title,
  collapsible = true,
  defaultExpandDepth = 2,
  showLineNumbers = false,
  searchable = true,
  copyable = true,
  theme = 'light',
  highlightPath,
  customRenderers = {}
}) => {
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState('');
  const [copiedPath, setCopiedPath] = useState<string>('');

  // 将数据转换为树形结构
  const jsonTree = useMemo(() => {
    const convertToTree = (obj: any, key: string, path: string, depth: number): JsonViewerNode => {
      const node: JsonViewerNode = {
        key,
        value: obj,
        type: Array.isArray(obj) ? 'array' : typeof obj,
        path,
        depth
      };

      if (typeof obj === 'object' && obj !== null) {
        node.children = Object.entries(obj).map(([k, v]) =>
          convertToTree(v, k, `${path}.${k}`, depth + 1)
        );
      }

      return node;
    };

    return convertToTree(data, 'root', 'root', 0);
  }, [data]);

  // 初始化展开状态
  React.useEffect(() => {
    const initialExpanded = new Set<string>();
    const expandNode = (node: JsonViewerNode, depth: number) => {
      if (depth < defaultExpandDepth) {
        initialExpanded.add(node.path);
        if (node.children) {
          node.children.forEach(child => expandNode(child, depth + 1));
        }
      }
    };
    expandNode(jsonTree, 0);
    setExpandedNodes(initialExpanded);
  }, [jsonTree, defaultExpandDepth]);

  // 切换节点展开状态
  const toggleNode = useCallback((path: string) => {
    if (!collapsible) return;
    setExpandedNodes(prev => {
      const newSet = new Set(prev);
      if (newSet.has(path)) {
        newSet.delete(path);
      } else {
        newSet.add(path);
      }
      return newSet;
    });
  }, [collapsible]);

  // 复制到剪贴板
  const copyToClipboard = useCallback(async (text: string, path: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedPath(path);
      setTimeout(() => setCopiedPath(''), 2000);
    } catch (err) {
      console.error('复制失败:', err);
    }
  }, []);

  // 渲染节点值
  const renderValue = (node: JsonViewerNode): React.ReactNode => {
    const { value, type, path } = node;

    // 检查是否有自定义渲染器
    if (customRenderers[type]) {
      return customRenderers[type](value, path);
    }

    // 根据类型渲染
    switch (type) {
      case 'string':
        return (
          <span className="json-string">
            "{String(value)}"
          </span>
        );
      case 'number':
        return (
          <span className="json-number">
            {value}
          </span>
        );
      case 'boolean':
        return (
          <span className="json-boolean">
            {value ? 'true' : 'false'}
          </span>
        );
      case 'null':
        return (
          <span className="json-null">
            null
          </span>
        );
      case 'object':
        return (
          <span className="json-brace">
            {'{}'}
          </span>
        );
      case 'array':
        return (
          <span className="json-brace">
            {'[]'}
          </span>
        );
      default:
        return (
          <span className="json-unknown">
            {String(value)}
          </span>
        );
    }
  };

  // 渲染节点
  const renderNode = (node: JsonViewerNode, index: number, isRoot = false): React.ReactNode => {
    const { key, value, type, path, depth, children } = node;
    const isExpanded = expandedNodes.has(path);
    const isHighlighted = highlightPath?.startsWith(path);
    const isObjectOrArray = type === 'object' || type === 'array';
    const hasChildren = children && children.length > 0;

    // 搜索过滤
    if (searchTerm && !path.toLowerCase().includes(searchTerm.toLowerCase()) && !String(value).toLowerCase().includes(searchTerm.toLowerCase())) {
      return null;
    }

    return (
      <div
        key={path}
        className={`json-node ${depth > 0 ? 'json-nested' : ''} ${isHighlighted ? 'json-highlighted' : ''}`}
        style={{ marginLeft: `${depth * 20}px` }}
      >
        {/* 键名 */}
        {!isRoot && (
          <>
            {showLineNumbers && (
              <span className="json-line-number">
                {index + 1}
              </span>
            )}
            <span className="json-key">
              {key}
            </span>
            <span className="json-colon">
              {': '}
            </span>
          </>
        )}

        {/* 展开/折叠按钮 */}
        {hasChildren && collapsible && (
          <button
            className="json-toggle"
            onClick={() => toggleNode(path)}
            aria-label={isExpanded ? '折叠' : '展开'}
          >
            {isExpanded ? '▼' : '►'}
          </button>
        )}

        {/* 值 */}
        <span className="json-value">
          {renderValue(node)}
        </span>

        {/* 复制按钮 */}
        {copyable && (
          <button
            className="json-copy"
            onClick={() => copyToClipboard(JSON.stringify(value, null, 2), path)}
            title="复制值"
          >
            {copiedPath === path ? '✓' : '📋'}
          </button>
        )}

        {/* 子节点 */}
        {hasChildren && isExpanded && (
          <div className="json-children">
            <span className="json-bracket">
              {type === 'array' ? '[' : '{'}
            </span>
            {children.map((child, childIndex) =>
              renderNode(child, childIndex)
            )}
            <span className="json-bracket">
              {type === 'array' ? ']' : '}'}
            </span>
          </div>
        )}

        {/* 逗号分隔符 */}
        {!isRoot && !isExpanded && (
          <span className="json-comma">,</span>
        )}
      </div>
    );
  };

  return (
    <div className={`json-viewer json-viewer-${theme}`}>
      {title && (
        <div className="json-viewer-header">
          <h3 className="json-viewer-title">{title}</h3>
        </div>
      )}

      {searchable && (
        <div className="json-viewer-search">
          <input
            type="text"
            placeholder="搜索键名或值..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="json-search-input"
          />
        </div>
      )}

      <div className="json-viewer-content">
        {renderNode(jsonTree, 0, true)}
      </div>

      <style jsx>{`
        .json-viewer {
          font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
          font-size: 12px;
          line-height: 1.6;
          background: ${theme === 'dark' ? '#1e1e1e' : '#ffffff'};
          color: ${theme === 'dark' ? '#d4d4d4' : '#1f2937'};
          border-radius: 8px;
          padding: 16px;
          max-height: 600px;
          overflow-y: auto;
        }

        .json-viewer-header {
          margin-bottom: 12px;
          padding-bottom: 8px;
          border-bottom: 1px solid ${theme === 'dark' ? '#404040' : '#e5e7eb'};
        }

        .json-viewer-title {
          margin: 0;
          font-size: 14px;
          font-weight: 600;
          color: ${theme === 'dark' ? '#ffffff' : '#1f2937'};
        }

        .json-viewer-search {
          margin-bottom: 12px;
        }

        .json-search-input {
          width: 100%;
          padding: 6px 12px;
          border: 1px solid ${theme === 'dark' ? '#404040' : '#d1d5db'};
          border-radius: 4px;
          background: ${theme === 'dark' ? '#2d2d2d' : '#f9fafb'};
          color: ${theme === 'dark' ? '#d4d4d4' : '#1f2937'};
          font-size: 12px;
        }

        .json-node {
          position: relative;
          padding: 2px 0;
        }

        .json-nested {
          border-left: 1px solid ${theme === 'dark' ? '#404040' : '#e5e7eb'};
          padding-left: 8px;
        }

        .json-highlighted {
          background: ${theme === 'dark' ? '#264f78' : '#dbeafe'};
          border-radius: 2px;
        }

        .json-line-number {
          display: inline-block;
          width: 30px;
          color: ${theme === 'dark' ? '#858585' : '#9ca3af'};
          text-align: right;
          margin-right: 8px;
          user-select: none;
        }

        .json-key {
          color: ${theme === 'dark' ? '#9cdcfe' : '#1f2937'};
          font-weight: 500;
        }

        .json-colon {
          margin-right: 4px;
        }

        .json-toggle {
          background: none;
          border: none;
          color: ${theme === 'dark' ? '#858585' : '#6b7280'};
          cursor: pointer;
          padding: 2px 4px;
          margin-right: 4px;
          font-size: 10px;
          border-radius: 2px;
          transition: all 0.2s;
        }

        .json-toggle:hover {
          background: ${theme === 'dark' ? '#404040' : '#e5e7eb'};
        }

        .json-value {
          margin-left: 4px;
        }

        .json-string {
          color: ${theme === 'dark' ? '#ce9178' : '#059669'};
        }

        .json-number {
          color: ${theme === 'dark' ? '#b5cea8' : '#2563eb'};
        }

        .json-boolean {
          color: ${theme === 'dark' ? '#569cd6' : '#7c3aed'};
        }

        .json-null {
          color: ${theme === 'dark' ? '#569cd6' : '#6b7280'};
        }

        .json-brace {
          color: ${theme === 'dark' ? '#d4d4d4' : '#6b7280'};
        }

        .json-unknown {
          color: ${theme === 'dark' ? '#e06c75' : '#ef4444'};
        }

        .json-copy {
          background: none;
          border: none;
          color: ${theme === 'dark' ? '#858585' : '#6b7280'};
          cursor: pointer;
          padding: 2px 4px;
          margin-left: 4px;
          font-size: 10px;
          border-radius: 2px;
          transition: all 0.2s;
          opacity: 0;
        }

        .json-node:hover .json-copy {
          opacity: 1;
        }

        .json-copy:hover {
          background: ${theme === 'dark' ? '#404040' : '#e5e7eb'};
        }

        .json-children {
          margin-left: 16px;
        }

        .json-bracket {
          color: ${theme === 'dark' ? '#d4d4d4' : '#6b7280'};
          margin-right: 4px;
        }

        .json-comma {
          color: ${theme === 'dark' ? '#d4d4d4' : '#6b7280'};
          margin-left: 4px;
        }
      `}</style>
    </div>
  );
};