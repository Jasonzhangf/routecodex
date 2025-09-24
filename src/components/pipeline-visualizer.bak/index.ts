/**
 * 流水线可视化系统
 *
 * 为RouteCodex项目提供完整的流水线链条式可视化展示系统
 *
 * 主要功能：
 * - 直观展示流水线模块节点和连接关系
 * - 点击节点展开IO记录侧边栏
 * - JSON数据支持折叠层级查看
 * - 实时数据更新和状态监控
 * - 错误处理和告警机制
 */

// 核心组件导出
export { PipelineVisualizer } from './PipelineVisualizer';
export { JsonViewer } from './JsonViewer';
export { Sidebar } from './Sidebar';
export { PipelineDashboard } from './PipelineDashboard';
export { RealTimeMonitor } from './RealTimeMonitor';

// 类型定义导出
export type {
  PipelineData,
  PipelineNode,
  PipelineConnection,
  PipelineMetrics,
  JsonViewerNode,
  SidebarState,
  ThemeConfig,
  VisualizationConfig,
  PipelineVisualizerConfig,
  AlertData
} from './types';

// 默认配置导出
export {
  defaultTheme,
  defaultAnimation,
  defaultLayout,
  defaultVisualizationConfig
} from './types';

// 便捷组件导出
export const PipelineVisualizationSystem = PipelineDashboard;

// 工具函数
export const createPipelineData = (config: Partial<PipelineData>): PipelineData => {
  return {
    id: config.id || 'pipeline-default',
    name: config.name || 'Default Pipeline',
    overallStatus: config.overallStatus || 'running',
    nodes: config.nodes || [],
    connections: config.connections || [],
    metrics: config.metrics || {
      totalRequests: 0,
      successRate: 0,
      averageResponseTime: 0,
      timestamp: Date.now()
    },
    createdAt: config.createdAt || Date.now(),
    updatedAt: config.updatedAt || Date.now(),
    version: config.version || '1.0.0',
    tags: config.tags || []
  };
};

export const createPipelineNode = (config: Partial<PipelineNode>): PipelineNode => {
  return {
    id: config.id || 'node-default',
    name: config.name || 'Default Node',
    type: config.type || 'Unknown',
    layer: config.layer || '1',
    status: config.status || 'running',
    description: config.description || '',
    io: config.io || {
      input: {},
      output: {},
      timestamp: Date.now(),
      processingTime: 0
    },
    config: config.config || {},
    error: config.error
  };
};

// 默认主题配置
export const lightTheme = {
  backgroundColor: '#ffffff',
  textColor: '#1f2937',
  borderColor: '#e5e7eb',
  nodeColors: {
    running: { background: '#dbeafe', border: '#3b82f6', text: '#1e40af' },
    success: { background: '#d1fae5', border: '#10b981', text: '#065f46' },
    error: { background: '#fee2e2', border: '#ef4444', text: '#991b1b' },
    stopped: { background: '#f3f4f6', border: '#6b7280', text: '#374151' }
  },
  connectionColors: {
    active: '#10b981',
    inactive: '#6b7280',
    error: '#ef4444'
  }
};

export const darkTheme = {
  backgroundColor: '#0d1117',
  textColor: '#d4d4d4',
  borderColor: '#30363d',
  nodeColors: {
    running: { background: '#1e3a5f', border: '#3b82f6', text: '#d4d4d4' },
    success: { background: '#064e3b', border: '#10b981', text: '#d4d4d4' },
    error: { background: '#490202', border: '#ef4444', text: '#d4d4d4' },
    stopped: { background: '#21262d', border: '#6b7280', text: '#d4d4d4' }
  },
  connectionColors: {
    active: '#10b981',
    inactive: '#6b7280',
    error: '#ef4444'
  }
};

// 使用示例
export const usageExample = `
import { PipelineDashboard, createPipelineData, createPipelineNode } from './pipeline-visualizer';

// 创建流水线数据
const pipelineData = createPipelineData({
  id: 'my-pipeline',
  name: 'My Pipeline',
  nodes: [
    createPipelineNode({
      id: 'node1',
      name: 'Input Processor',
      type: 'Processor',
      layer: '1',
      status: 'running',
      description: '输入处理节点'
    })
  ],
  connections: [
    { sourceId: 'node1', targetId: 'node2', status: 'active' }
  ]
});

// 使用组件
function App() {
  return (
    <PipelineDashboard
      initialData={pipelineData}
      width={1200}
      height={800}
      theme="light"
      enableRealTime={true}
      updateInterval={1000}
      onNodeClick={(node) => console.log('Node clicked:', node)}
      onDataUpdate={(data) => console.log('Data updated:', data)}
    />
  );
}
`;

// 版本信息
export const VERSION = '1.0.0';
export const COMPATIBILITY = {
  react: '>=16.8.0',
  typescript: '>=4.0.0'
};

// 默认导出
export default PipelineDashboard;