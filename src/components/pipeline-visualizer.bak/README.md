# RouteCodex 流水线可视化系统

为RouteCodex项目提供的完整流水线链条式可视化展示系统。

## 主要功能

### 1. 直观展示流水线模块节点和连接关系
- **节点类型**: LLM Switch → Compatibility → Provider → AI Service
- **连接线**: 表示数据流向，支持不同状态颜色
- **状态指示**: 运行中/停止/错误状态的实时显示
- **响应式布局**: 自动适应不同屏幕尺寸

### 2. 点击节点展开IO记录
- **侧边栏展示**: 点击节点后在右侧展开详细信息
- **数据分类**: 输入数据、输出数据、配置信息分别显示
- **实时更新**: 节点数据实时同步更新
- **搜索功能**: 支持在JSON数据中搜索特定内容

### 3. JSON数据支持折叠层级
- **层级展示**: 默认只显示数据结构层级关系
- **点击展开**: 支持点击展开查看详细内容
- **语法高亮**: 不同数据类型使用不同颜色
- **格式化显示**: 美观的JSON格式化展示

### 4. 实时数据更新
- **自动更新**: 支持定时自动更新数据
- **手动刷新**: 提供手动刷新按钮
- **状态监控**: 实时监控节点和连接状态
- **性能指标**: 显示请求总数、成功率、响应时间等

## 技术实现

### 核心组件架构

```
PipelineDashboard (主控制面板)
├── PipelineVisualizer (可视化组件)
│   ├── Canvas 渲染引擎
│   ├── 节点交互管理
│   └── 连接状态管理
├── Sidebar (侧边栏)
│   ├── JsonViewer (JSON查看器)
│   └── 数据展示管理
├── RealTimeMonitor (实时监控)
│   ├── 状态监控
│   ├── 告警系统
│   └── 性能统计
└── 数据管理模块
    ├── 数据源管理
    ├── 状态同步
    └── 事件处理
```

### 数据结构设计

#### PipelineNode
```typescript
interface PipelineNode {
  id: string;                    // 节点唯一标识
  name: string;                  // 节点显示名称
  type: string;                  // 节点类型
  layer: string;                 // 节点层级
  status: NodeStatus;            // 节点状态
  description?: string;          // 节点描述
  io: {                          // 输入输出数据
    input: any;                  // 输入数据
    output: any;                 // 输出数据
    timestamp: number;           // 时间戳
    processingTime: number;      // 处理时间
  };
  config?: Record<string, any>;   // 节点配置
  error?: string;                // 错误信息
}
```

#### PipelineConnection
```typescript
interface PipelineConnection {
  sourceId: string;             // 源节点ID
  targetId: string;             // 目标节点ID
  status: ConnectionStatus;      // 连接状态
  weight?: number;               // 连接权重
  type?: 'data' | 'control' | 'event';  // 连接类型
  throughput?: number;           // 数据流量
}
```

### 渲染技术

#### Canvas 渲染引擎
- **节点渲染**: 使用圆角矩形 + 状态指示器
- **连接线**: 贝塞尔曲线 + 箭头指示方向
- **动画效果**: 流动效果 + 状态切换动画
- **交互响应**: 鼠标悬停 + 点击反馈

#### 布局算法
- **层级布局**: 按节点层级自动排列
- **居中对齐**: 每层节点水平居中
- **自适应间距**: 根据节点数量调整间距
- **响应式**: 支持不同屏幕尺寸

## 使用方法

### 基本使用

```tsx
import { PipelineDashboard, createPipelineData } from './pipeline-visualizer';

// 创建流水线数据
const pipelineData = createPipelineData({
  id: 'my-pipeline',
  name: 'My Pipeline',
  nodes: [
    {
      id: 'llm-switch',
      name: 'LLM Switch',
      type: 'Dynamic Router',
      layer: '1',
      status: 'running',
      description: '动态路由分类模块',
      io: {
        input: { model: 'qwen3-4b', messages: [...] },
        output: { model: 'qwen3-4b', messages: [...], _metadata: {...} },
        timestamp: Date.now(),
        processingTime: 150
      }
    },
    // ... 其他节点
  ],
  connections: [
    { sourceId: 'llm-switch', targetId: 'compatibility', status: 'active' },
    // ... 其他连接
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
```

### 高级配置

```tsx
// 自定义主题
const customTheme = {
  backgroundColor: '#1a1a1a',
  nodeColors: {
    running: { background: '#2d3748', border: '#4299e1', text: '#ffffff' },
    success: { background: '#2f855a', border: '#48bb78', text: '#ffffff' },
    error: { background: '#742a2a', border: '#e53e3e', text: '#ffffff' },
    stopped: { background: '#4a5568', border: '#718096', text: '#ffffff' }
  }
};

// 实时数据获取
const fetchPipelineData = async () => {
  const response = await fetch('/api/pipeline/status');
  return response.json();
};

// 使用高级配置
function AdvancedApp() {
  return (
    <PipelineDashboard
      initialData={pipelineData}
      fetchData={fetchPipelineData}
      width={1400}
      height={900}
      theme="dark"
      enableRealTime={true}
      updateInterval={2000}
      thresholds={{
        errorRate: 0.05,
        responseTime: 1000,
        successRate: 0.95
      }}
      onNodeClick={(node) => {
        // 自定义节点点击处理
        console.log('Node details:', node);
      }}
      onDataUpdate={(data) => {
        // 数据更新处理
        updateMetrics(data.metrics);
      }}
    />
  );
}
```

## 组件API

### PipelineDashboard

| 属性 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| initialData | PipelineData | undefined | 初始流水线数据 |
| width | number | 1200 | 容器宽度 |
| height | number | 800 | 容器高度 |
| theme | 'light' \| 'dark' | 'light' | 主题模式 |
| enableRealTime | boolean | true | 是否启用实时更新 |
| updateInterval | number | 1000 | 更新间隔(毫秒) |
| fetchData | () => Promise<PipelineData> | undefined | 数据获取函数 |
| onNodeClick | (node: PipelineNode) => void | undefined | 节点点击回调 |
| onDataUpdate | (data: PipelineData) => void | undefined | 数据更新回调 |

### PipelineVisualizer

| 属性 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| pipelineData | PipelineData | undefined | 流水线数据 |
| width | number | 800 | 画布宽度 |
| height | number | 600 | 画布高度 |
| onNodeClick | (node: PipelineNode) => void | undefined | 节点点击回调 |
| onDataUpdate | (data: PipelineData) => void | undefined | 数据更新回调 |
| enableRealTime | boolean | true | 是否启用实时更新 |
| updateInterval | number | 1000 | 更新间隔(毫秒) |

### JsonViewer

| 属性 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| data | any | undefined | 要显示的数据 |
| title | string | undefined | 标题 |
| collapsible | boolean | true | 是否可折叠 |
| defaultExpandDepth | number | 2 | 默认展开深度 |
| showLineNumbers | boolean | false | 显示行号 |
| searchable | boolean | true | 搜索功能 |
| copyable | boolean | true | 复制功能 |
| theme | 'light' \| 'dark' | 'light' | 主题 |
| highlightPath | string | undefined | 高亮路径 |
| customRenderers | Record<string, Function> | {} | 自定义渲染器 |

## 样式定制

### CSS 变量

```css
.pipeline-visualizer {
  /* 主题颜色 */
  --primary-color: #3b82f6;
  --success-color: #10b981;
  --error-color: #ef4444;
  --warning-color: #f59e0b;

  /* 背景颜色 */
  --bg-primary: #ffffff;
  --bg-secondary: #f9fafb;
  --bg-tertiary: #f3f4f6;

  /* 文字颜色 */
  --text-primary: #1f2937;
  --text-secondary: #6b7280;
  --text-tertiary: #9ca3af;

  /* 边框颜色 */
  --border-primary: #e5e7eb;
  --border-secondary: #d1d5db;

  /* 阴影 */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
  --shadow-md: 0 4px 6px rgba(0, 0, 0, 0.1);
  --shadow-lg: 0 10px 15px rgba(0, 0, 0, 0.1);
}
```

### 自定义样式

```css
/* 节点样式 */
.pipeline-node {
  border-radius: 8px;
  box-shadow: var(--shadow-md);
  transition: all 0.3s ease;
}

.pipeline-node:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-lg);
}

/* 连接线样式 */
.pipeline-connection {
  stroke-width: 2;
  fill: none;
  stroke-linecap: round;
}

.pipeline-connection.active {
  stroke: var(--success-color);
  stroke-dasharray: none;
}

.pipeline-connection.error {
  stroke: var(--error-color);
  stroke-dasharray: 5, 5;
}
```

## 性能优化

### 渲染优化
- **虚拟滚动**: 大数据量时使用虚拟滚动
- **Canvas 缓存**: 静态内容使用缓存
- **节流更新**: 高频更新时使用节流
- **内存管理**: 及时清理不需要的数据

### 数据优化
- **数据压缩**: 使用紧凑的数据结构
- **增量更新**: 只更新变化的数据
- **缓存策略**: 合理使用缓存
- **懒加载**: 按需加载数据

## 浏览器兼容性

- **Chrome**: 80+
- **Firefox**: 75+
- **Safari**: 13+
- **Edge**: 80+

## 注意事项

1. **Canvas 绘制**: 确保浏览器支持 Canvas 2D API
2. **内存使用**: 大量节点时注意内存使用
3. **实时更新**: 合理设置更新间隔避免性能问题
4. **数据格式**: 确保数据格式符合接口定义
5. **样式冲突**: 注意 CSS 样式冲突

## 更新日志

### v1.0.0
- 初始版本发布
- 基础流水线可视化功能
- 节点交互和侧边栏
- 实时数据更新
- JSON 查看器

## 贡献指南

1. Fork 项目
2. 创建功能分支
3. 提交更改
4. 发起 Pull Request

## 许可证

MIT License