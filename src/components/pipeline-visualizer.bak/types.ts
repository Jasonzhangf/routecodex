/**
 * 流水线可视化系统类型定义
 */

/**
 * 节点状态
 */
export type NodeStatus = 'running' | 'success' | 'error' | 'stopped';

/**
 * 连接状态
 */
export type ConnectionStatus = 'active' | 'inactive' | 'error';

/**
 * 流水线节点接口
 */
export interface PipelineNode {
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
  /** 节点描述 */
  description?: string;
  /** 输入输出数据 */
  io: {
    /** 输入数据 */
    input: any;
    /** 输出数据 */
    output: any;
    /** 时间戳 */
    timestamp: number;
    /** 处理时间（毫秒） */
    processingTime: number;
  };
  /** 节点配置 */
  config?: Record<string, any>;
  /** 错误信息 */
  error?: string;
}

/**
 * 流水线连接接口
 */
export interface PipelineConnection {
  /** 源节点ID */
  sourceId: string;
  /** 目标节点ID */
  targetId: string;
  /** 连接状态 */
  status: ConnectionStatus;
  /** 连接权重 */
  weight?: number;
  /** 连接类型 */
  type?: 'data' | 'control' | 'event';
  /** 数据流量 */
  throughput?: number;
}

/**
 * 流水线指标
 */
export interface PipelineMetrics {
  /** 总请求数 */
  totalRequests: number;
  /** 成功率 */
  successRate: number;
  /** 平均响应时间 */
  averageResponseTime: number;
  /** 时间戳 */
  timestamp: number;
  /** 错误数 */
  errorCount?: number;
  /** 并发数 */
  concurrentRequests?: number;
  /** 吞吐量 */
  throughput?: number;
}

/**
 * 流水线数据接口
 */
export interface PipelineData {
  /** 流水线ID */
  id: string;
  /** 流水线名称 */
  name: string;
  /** 整体状态 */
  overallStatus: NodeStatus;
  /** 节点列表 */
  nodes: PipelineNode[];
  /** 连接列表 */
  connections: PipelineConnection[];
  /** 指标数据 */
  metrics: PipelineMetrics;
  /** 创建时间 */
  createdAt?: number;
  /** 更新时间 */
  updatedAt?: number;
  /** 版本 */
  version?: string;
  /** 标签 */
  tags?: string[];
}

/**
 * JSON查看器节点
 */
export interface JsonViewerNode {
  /** 节点键 */
  key: string;
  /** 节点值 */
  value: any;
  /** 节点类型 */
  type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  /** 子节点 */
  children?: JsonViewerNode[];
  /** 是否展开 */
  isExpanded?: boolean;
  /** 路径 */
  path: string;
  /** 深度 */
  depth: number;
}

/**
 * 侧边栏状态
 */
export interface SidebarState {
  /** 是否显示 */
  isVisible: boolean;
  /** 选中的节点 */
  selectedNode: PipelineNode | null;
  /** 当前查看的数据类型 */
  currentView: 'input' | 'output' | 'config';
  /** JSON查看器数据 */
  jsonViewerData: JsonViewerNode[];
  /** 搜索关键词 */
  searchKeyword: string;
  /** 折叠的路径 */
  collapsedPaths: Set<string>;
}

/**
 * 主题配置
 */
export interface ThemeConfig {
  /** 背景颜色 */
  backgroundColor: string;
  /** 节点颜色 */
  nodeColors: {
    [key in NodeStatus]: {
      background: string;
      border: string;
      text: string;
    };
  };
  /** 连接线颜色 */
  connectionColors: {
    [key in ConnectionStatus]: string;
  };
  /** 文本颜色 */
  textColor: string;
  /** 选中颜色 */
  selectedColor: string;
  /** 悬停颜色 */
  hoverColor: string;
}

/**
 * 动画配置
 */
export interface AnimationConfig {
  /** 是否启用动画 */
  enabled: boolean;
  /** 动画持续时间 */
  duration: number;
  /** 缓动函数 */
  easing: string;
  /** 流动效果 */
  flowEffect: {
    enabled: boolean;
    speed: number;
    particleSize: number;
  };
}

/**
 * 布局配置
 */
export interface LayoutConfig {
  /** 布局方向 */
  direction: 'horizontal' | 'vertical' | 'circular';
  /** 节点间距 */
  nodeSpacing: {
    horizontal: number;
    vertical: number;
  };
  /** 层间距 */
  layerSpacing: number;
  /** 自动排列 */
  autoLayout: boolean;
  /** 对齐方式 */
  alignment: 'start' | 'center' | 'end';
}

/**
 * 可视化配置
 */
export interface VisualizationConfig {
  /** 主题配置 */
  theme: ThemeConfig;
  /** 动画配置 */
  animation: AnimationConfig;
  /** 布局配置 */
  layout: LayoutConfig;
  /** 显示选项 */
  displayOptions: {
    showLabels: boolean;
    showStatus: boolean;
    showMetrics: boolean;
    showConnections: boolean;
    showTooltips: boolean;
  };
}

/**
 * 工具提示数据
 */
export interface TooltipData {
  /** 节点ID */
  nodeId: string;
  /** 位置 */
  position: { x: number; y: number };
  /** 内容 */
  content: {
    title: string;
    description?: string;
    metrics?: Record<string, string>;
    status: NodeStatus;
    lastUpdate: string;
  };
  /** 是否显示 */
  visible: boolean;
}

/**
 * 事件类型
 */
export type VisualizerEventType =
  | 'nodeClick'
  | 'nodeHover'
  | 'connectionClick'
  | 'dataUpdate'
  | 'statusChange'
  | 'error';

/**
 * 事件处理器
 */
export type VisualizerEventHandler<T = any> = (event: {
  type: VisualizerEventType;
  data: T;
  timestamp: number;
}) => void;

/**
 * 流水线可视化器配置
 */
export interface PipelineVisualizerConfig {
  /** 容器尺寸 */
  container: {
    width: number;
    height: number;
  };
  /** 可视化配置 */
  visualization: VisualizationConfig;
  /** 数据源 */
  dataSource: {
    /** 数据获取函数 */
    fetchData: () => Promise<PipelineData>;
    /** 更新间隔 */
    updateInterval: number;
    /** 是否启用实时更新 */
    enableRealTime: boolean;
  };
  /** 事件处理器 */
  eventHandlers: {
    [K in VisualizerEventType]?: VisualizerEventHandler;
  };
  /** 调试模式 */
  debug: boolean;
}

/**
 * 默认主题配置
 */
export const defaultTheme: ThemeConfig = {
  backgroundColor: '#ffffff',
  nodeColors: {
    running: {
      background: '#dbeafe',
      border: '#3b82f6',
      text: '#1e40af'
    },
    success: {
      background: '#d1fae5',
      border: '#10b981',
      text: '#065f46'
    },
    error: {
      background: '#fee2e2',
      border: '#ef4444',
      text: '#991b1b'
    },
    stopped: {
      background: '#f3f4f6',
      border: '#6b7280',
      text: '#374151'
    }
  },
  connectionColors: {
    active: '#10b981',
    inactive: '#6b7280',
    error: '#ef4444'
  },
  textColor: '#1f2937',
  selectedColor: '#3b82f6',
  hoverColor: '#6b7280'
};

/**
 * 默认动画配置
 */
export const defaultAnimation: AnimationConfig = {
  enabled: true,
  duration: 300,
  easing: 'ease-in-out',
  flowEffect: {
    enabled: true,
    speed: 1,
    particleSize: 3
  }
};

/**
 * 默认布局配置
 */
export const defaultLayout: LayoutConfig = {
  direction: 'horizontal',
  nodeSpacing: {
    horizontal: 250,
    vertical: 120
  },
  layerSpacing: 100,
  autoLayout: true,
  alignment: 'center'
};

/**
 * 默认可视化配置
 */
export const defaultVisualizationConfig: VisualizationConfig = {
  theme: defaultTheme,
  animation: defaultAnimation,
  layout: defaultLayout,
  displayOptions: {
    showLabels: true,
    showStatus: true,
    showMetrics: true,
    showConnections: true,
    showTooltips: true
  }
};