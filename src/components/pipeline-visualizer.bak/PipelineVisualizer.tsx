import React, { useState, useEffect, useRef } from 'react';
import { PipelineVisualization, PipelineNode, PipelineConnection, PipelineData } from './types';

export interface PipelineVisualizerProps {
  /** 流水线数据 */
  pipelineData?: PipelineData;
  /** 容器宽度 */
  width?: number;
  /** 容器高度 */
  height?: number;
  /** 节点点击回调 */
  onNodeClick?: (node: PipelineNode) => void;
  /** 数据更新回调 */
  onDataUpdate?: (data: PipelineData) => void;
  /** 是否启用实时更新 */
  enableRealTime?: boolean;
  /** 更新间隔（毫秒） */
  updateInterval?: number;
}

export const PipelineVisualizer: React.FC<PipelineVisualizerProps> = ({
  pipelineData,
  width = 800,
  height = 600,
  onNodeClick,
  onDataUpdate,
  enableRealTime = true,
  updateInterval = 1000
}) => {
  const [data, setData] = useState<PipelineData>(pipelineData || getInitialPipelineData());
  const [selectedNode, setSelectedNode] = useState<PipelineNode | null>(null);
  const [hoveredNode, setHoveredNode] = useState<PipelineNode | null>(null);
  const [isPlaying, setIsPlaying] = useState(enableRealTime);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();

  // 初始化数据
  useEffect(() => {
    if (pipelineData) {
      setData(pipelineData);
    }
  }, [pipelineData]);

  // 实时更新
  useEffect(() => {
    if (!enableRealTime || !isPlaying) return;

    const interval = setInterval(() => {
      const updatedData = simulateDataUpdate(data);
      setData(updatedData);
      onDataUpdate?.(updatedData);
    }, updateInterval);

    return () => clearInterval(interval);
  }, [enableRealTime, isPlaying, updateInterval, data, onDataUpdate]);

  // 渲染画布
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    renderPipeline(ctx, data);
  }, [data, width, height]);

  // 计算节点位置
  const calculateNodePositions = (nodes: PipelineNode[]) => {
    const positions: Record<string, { x: number; y: number }> = {};
    const nodeWidth = 180;
    const nodeHeight = 80;
    const horizontalSpacing = 250;
    const verticalSpacing = 120;

    // 按层级分组
    const layers: Record<string, PipelineNode[]> = {};
    nodes.forEach(node => {
      if (!layers[node.layer]) {
        layers[node.layer] = [];
      }
      layers[node.layer].push(node);
    });

    // 计算每层的位置
    Object.keys(layers).sort().forEach((layer, layerIndex) => {
      const layerNodes = layers[layer];
      const layerWidth = layerNodes.length * nodeWidth + (layerNodes.length - 1) * horizontalSpacing;
      const startX = (width - layerWidth) / 2;

      layerNodes.forEach((node, nodeIndex) => {
        positions[node.id] = {
          x: startX + nodeIndex * (nodeWidth + horizontalSpacing) + nodeWidth / 2,
          y: 100 + layerIndex * verticalSpacing
        };
      });
    });

    return positions;
  };

  // 渲染流水线
  const renderPipeline = (ctx: CanvasRenderingContext2D, data: PipelineData) => {
    // 清空画布
    ctx.clearRect(0, 0, width, height);

    // 计算节点位置
    const nodePositions = calculateNodePositions(data.nodes);

    // 绘制连接线
    data.connections.forEach(connection => {
      const sourcePos = nodePositions[connection.sourceId];
      const targetPos = nodePositions[connection.targetId];

      if (sourcePos && targetPos) {
        drawConnection(ctx, sourcePos, targetPos, connection.status);
      }
    });

    // 绘制节点
    data.nodes.forEach(node => {
      const position = nodePositions[node.id];
      if (position) {
        drawNode(ctx, node, position.x, position.y, node === selectedNode, node === hoveredNode);
      }
    });
  };

  // 绘制连接线
  const drawConnection = (
    ctx: CanvasRenderingContext2D,
    source: { x: number; y: number },
    target: { x: number; y: number },
    status: 'active' | 'inactive' | 'error'
  ) => {
    ctx.save();

    // 设置线条样式
    switch (status) {
      case 'active':
        ctx.strokeStyle = '#10b981';
        ctx.lineWidth = 3;
        ctx.setLineDash([]);
        break;
      case 'error':
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 3;
        ctx.setLineDash([5, 5]);
        break;
      case 'inactive':
        ctx.strokeStyle = '#6b7280';
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        break;
    }

    // 绘制曲线
    ctx.beginPath();
    ctx.moveTo(source.x, source.y + 40);

    const midX = (source.x + target.x) / 2;
    const midY = (source.y + target.y) / 2;

    ctx.quadraticCurveTo(midX, source.y + 40, midX, midY);
    ctx.quadraticCurveTo(midX, target.y - 40, target.x, target.y - 40);

    ctx.stroke();

    // 绘制箭头
    drawArrow(ctx, target.x, target.y - 40, Math.atan2(target.y - source.y - 80, target.x - source.x));

    ctx.restore();
  };

  // 绘制箭头
  const drawArrow = (ctx: CanvasRenderingContext2D, x: number, y: number, angle: number) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-15, -8);
    ctx.lineTo(-15, 8);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  };

  // 绘制节点
  const drawNode = (
    ctx: CanvasRenderingContext2D,
    node: PipelineNode,
    x: number,
    y: number,
    isSelected: boolean,
    isHovered: boolean
  ) => {
    ctx.save();

    const nodeWidth = 180;
    const nodeHeight = 80;
    const cornerRadius = 8;

    // 设置样式
    switch (node.status) {
      case 'running':
        ctx.fillStyle = '#dbeafe';
        ctx.strokeStyle = '#3b82f6';
        break;
      case 'success':
        ctx.fillStyle = '#d1fae5';
        ctx.strokeStyle = '#10b981';
        break;
      case 'error':
        ctx.fillStyle = '#fee2e2';
        ctx.strokeStyle = '#ef4444';
        break;
      case 'stopped':
        ctx.fillStyle = '#f3f4f6';
        ctx.strokeStyle = '#6b7280';
        break;
    }

    // 选中或悬停效果
    if (isSelected) {
      ctx.lineWidth = 3;
      ctx.shadowColor = '#3b82f6';
      ctx.shadowBlur = 15;
    } else if (isHovered) {
      ctx.lineWidth = 2;
      ctx.shadowColor = '#6b7280';
      ctx.shadowBlur = 8;
    } else {
      ctx.lineWidth = 2;
    }

    // 绘制圆角矩形
    ctx.beginPath();
    ctx.roundRect(x - nodeWidth / 2, y - nodeHeight / 2, nodeWidth, nodeHeight, cornerRadius);
    ctx.fill();
    ctx.stroke();

    // 绘制节点文本
    ctx.fillStyle = '#1f2937';
    ctx.font = 'bold 14px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(node.name, x, y - 10);

    // 绘制节点类型
    ctx.fillStyle = '#6b7280';
    ctx.font = '12px system-ui, -apple-system, sans-serif';
    ctx.fillText(node.type, x, y + 10);

    // 绘制状态指示器
    drawStatusIndicator(ctx, x + nodeWidth / 2 - 20, y - nodeHeight / 2 + 10, node.status);

    ctx.restore();
  };

  // 绘制状态指示器
  const drawStatusIndicator = (ctx: CanvasRenderingContext2D, x: number, y: number, status: string) => {
    ctx.save();

    ctx.beginPath();
    ctx.arc(x, y, 6, 0, 2 * Math.PI);

    switch (status) {
      case 'running':
        ctx.fillStyle = '#3b82f6';
        break;
      case 'success':
        ctx.fillStyle = '#10b981';
        break;
      case 'error':
        ctx.fillStyle = '#ef4444';
        break;
      case 'stopped':
        ctx.fillStyle = '#6b7280';
        break;
    }

    ctx.fill();

    // 运行动画效果
    if (status === 'running') {
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.5;
      ctx.stroke();
    }

    ctx.restore();
  };

  // 处理画布点击
  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // 检查是否点击了节点
    const nodePositions = calculateNodePositions(data.nodes);

    for (const node of data.nodes) {
      const pos = nodePositions[node.id];
      if (!pos) continue;

      const nodeWidth = 180;
      const nodeHeight = 80;

      if (
        x >= pos.x - nodeWidth / 2 &&
        x <= pos.x + nodeWidth / 2 &&
        y >= pos.y - nodeHeight / 2 &&
        y <= pos.y + nodeHeight / 2
      ) {
        setSelectedNode(node);
        onNodeClick?.(node);
        return;
      }
    }

    // 如果没有点击节点，取消选择
    setSelectedNode(null);
  };

  // 处理鼠标移动
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // 检查是否悬停在节点上
    const nodePositions = calculateNodePositions(data.nodes);

    let hoveredNode: PipelineNode | null = null;

    for (const node of data.nodes) {
      const pos = nodePositions[node.id];
      if (!pos) continue;

      const nodeWidth = 180;
      const nodeHeight = 80;

      if (
        x >= pos.x - nodeWidth / 2 &&
        x <= pos.x + nodeWidth / 2 &&
        y >= pos.y - nodeHeight / 2 &&
        y <= pos.y + nodeHeight / 2
      ) {
        hoveredNode = node;
        break;
      }
    }

    setHoveredNode(hoveredNode);

    // 设置鼠标样式
    canvas.style.cursor = hoveredNode ? 'pointer' : 'default';
  };

  return (
    <div className="pipeline-visualizer">
      <div className="pipeline-controls">
        <button
          onClick={() => setIsPlaying(!isPlaying)}
          className={`control-btn ${isPlaying ? 'playing' : 'paused'}`}
        >
          {isPlaying ? '⏸ 暂停' : '▶ 播放'}
        </button>
        <button
          onClick={() => {
            const updatedData = simulateDataUpdate(data);
            setData(updatedData);
            onDataUpdate?.(updatedData);
          }}
          className="control-btn"
        >
          🔄 刷新
        </button>
        <div className="pipeline-info">
          <span className="info-item">
            状态: <span className={`status ${data.overallStatus}`}>{data.overallStatus}</span>
          </span>
          <span className="info-item">
            请求总数: <span className="metric">{data.metrics.totalRequests}</span>
          </span>
          <span className="info-item">
            成功率: <span className="metric">{(data.metrics.successRate * 100).toFixed(1)}%</span>
          </span>
        </div>
      </div>

      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        onClick={handleCanvasClick}
        onMouseMove={handleMouseMove}
        className="pipeline-canvas"
      />
    </div>
  );
};

// 模拟数据更新
const simulateDataUpdate = (data: PipelineData): PipelineData => {
  return {
    ...data,
    nodes: data.nodes.map(node => ({
      ...node,
      status: Math.random() > 0.8 ? 'error' : Math.random() > 0.5 ? 'running' : 'success',
      io: {
        ...node.io,
        timestamp: Date.now(),
        processingTime: Math.floor(Math.random() * 1000) + 100
      }
    })),
    connections: data.connections.map(conn => ({
      ...conn,
      status: Math.random() > 0.8 ? 'error' : 'active'
    })),
    metrics: {
      totalRequests: data.metrics.totalRequests + Math.floor(Math.random() * 10),
      successRate: Math.max(0.7, Math.min(1.0, data.metrics.successRate + (Math.random() - 0.5) * 0.1)),
      averageResponseTime: Math.floor(Math.random() * 500) + 200,
      timestamp: Date.now()
    }
  };
};

// 获取初始数据
const getInitialPipelineData = (): PipelineData => {
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
};