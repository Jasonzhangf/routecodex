# RouteCodex 调试系统使用指南

## 概述

RouteCodex 提供了一个完整的可视化调试捕获系统，支持模块级、HTTP 服务器级和系统级的调试信息收集与展示。

## 系统架构

### 核心组件

1. **DebugSystemManager** - 调试系统总管理器
2. **ModuleDebugAdapter** - 模块调试适配器
3. **HttpServerDebugAdapter** - HTTP 服务器调试适配器
4. **WebSocketDebugServer** - 实时调试数据推送
5. **DebugAPIExtension** - REST API 调试接口

### 调试数据类型

- **模块执行数据** - 方法调用、参数、返回值、执行时间
- **HTTP 请求数据** - 请求头、响应状态、处理时间
- **错误信息** - 异常堆栈、错误类型、恢复信息
- **性能指标** - 内存使用、响应时间、并发数
- **状态快照** - 模块状态、系统健康度

## 获取模块记录信息的方法

### 方法1：使用模块调试适配器

```typescript
import { DebugSystemManager, ModuleDebugAdapterImpl } from 'routecodex/debug';

// 1. 初始化调试系统
const debugManager = DebugSystemManager.getInstance({
  enabled: true,
  logLevel: 'detailed',
  enablePerformanceMonitoring: true
});

await debugManager.initialize();

// 2. 创建模块调试适配器
const moduleAdapter = new ModuleDebugAdapterImpl(
  {
    id: 'my-module',
    type: 'module',
    enabled: true
  },
  debugUtils,
  {
    id: 'my-module',
    name: 'My Module',
    version: '1.0.0',
    type: 'processor'
  }
);

// 3. 获取模块记录信息
const moduleData = await moduleAdapter.getDebugData({
  id: 'my-module',
  type: 'module',
  timestamp: Date.now()
});

console.log('模块记录信息:', {
  总事件数: moduleData.length,
  方法调用: moduleData.filter(d => d.type === 'method-call').length,
  错误数: moduleData.filter(d => d.severity === 'error').length,
  平均响应时间: moduleData.filter(d => d.metrics?.responseTime)
    .reduce((acc, d) => acc + d.metrics.responseTime, 0) / moduleData.length
});
```

### 方法2：使用系统级调试管理器

```typescript
// 获取所有模块的调试数据
const allDebugData = await debugManager.getDebugData({
  type: 'all',
  timestamp: Date.now(),
  filters: {
    moduleTypes: ['processor', 'transformer'],
    severity: ['info', 'warning', 'error'],
    timeRange: {
      start: Date.now() - 3600000, // 最近1小时
      end: Date.now()
    }
  }
});

// 按模块分组
const moduleGroups = allDebugData.reduce((groups, item) => {
  const moduleId = item.moduleId || 'unknown';
  if (!groups[moduleId]) groups[moduleId] = [];
  groups[moduleId].push(item);
  return groups;
}, {});

Object.entries(moduleGroups).forEach(([moduleId, data]) => {
  console.log(`模块 ${moduleId}:`, {
    事件总数: data.length,
    错误率: (data.filter(d => d.severity === 'error').length / data.length * 100).toFixed(2) + '%',
    平均处理时间: data.filter(d => d.metrics?.processingTime)
      .reduce((acc, d) => acc + d.metrics.processingTime, 0) / data.filter(d => d.metrics?.processingTime).length
  });
});
```

### 方法3：实时 WebSocket 监控

```typescript
// 连接到 WebSocket 调试服务器
const ws = new WebSocket('ws://localhost:8081/debug');

ws.on('open', () => {
  console.log('✅ 连接到调试服务器');
  
  // 订阅特定模块的事件
  ws.send(JSON.stringify({
    type: 'subscribe',
    moduleId: 'my-module',
    eventTypes: ['method-call', 'error', 'state-change']
  }));
});

ws.on('message', (data) => {
  const event = JSON.parse(data.toString());
  
  if (event.type === 'debug-event' && event.moduleId === 'my-module') {
    console.log('🔄 实时模块事件:', {
      时间: new Date(event.timestamp).toLocaleTimeString(),
      类型: event.eventType,
      数据: event.data,
      性能: event.metrics
    });
  }
});
```

### 方法4：REST API 查询

```typescript
// 通过 REST API 获取模块信息
const response = await fetch('http://localhost:8080/debug/modules/my-module/data', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    timeRange: {
      start: Date.now() - 3600000,
      end: Date.now()
    },
    filters: {
      eventTypes: ['method-call', 'error'],
      severity: ['info', 'warning', 'error']
    },
    includeMetrics: true,
    includeStackTraces: true
  })
});

const moduleInfo = await response.json();
console.log('模块详细信息:', moduleInfo);
```

## 关键 API 接口

### DebugSystemManager

```typescript
// 获取系统健康状态
const health = debugManager.getHealth();
console.log('系统健康度:', health.score, '状态:', health.status);

// 获取调试统计
const stats = debugManager.getStatistics();
console.log('调试统计:', {
  总事件数: stats.totalEvents,
  错误数: stats.totalErrors,
  活跃会话: stats.activeSessions,
  内存使用: stats.memoryUsage
});

// 获取特定模块的适配器
const moduleAdapter = debugManager.getAdapter('my-module');
const moduleStats = moduleAdapter.getStats();
console.log('模块统计:', moduleStats);
```

### ModuleDebugAdapter

```typescript
// 获取方法调用历史
const methodCalls = moduleAdapter.getMethodCalls('processData');
console.log('方法调用历史:', methodCalls);

// 获取错误信息
const errors = moduleAdapter.getErrors();
console.log('模块错误:', errors);

// 获取性能指标
const performance = moduleAdapter.getPerformanceMetrics();
console.log('性能指标:', {
  平均响应时间: performance.avgResponseTime,
  最大响应时间: performance.maxResponseTime,
  调用次数: performance.callCount
});
```

## 可视化界面

### Web 界面访问

1. **调试仪表板**: `http://localhost:8080/debug/dashboard`
2. **模块监控**: `http://localhost:8080/debug/modules`
3. **实时日志**: `http://localhost:8080/debug/logs`
4. **性能图表**: `http://localhost:8080/debug/performance`
5. **错误分析**: `http://localhost:8080/debug/errors`

### WebSocket 实时数据

连接地址: `ws://localhost:8081/debug`

订阅事件类型:
- `module-events` - 模块事件
- `http-requests` - HTTP 请求
- `errors` - 错误事件
- `performance` - 性能指标
- `system-health` - 系统健康状态

## 最佳实践

### 1. 选择性调试

```typescript
// 只在需要时启用调试
const debugManager = DebugSystemManager.getInstance({
  enabled: process.env.NODE_ENV === 'development',
  logLevel: 'detailed'
});
```

### 2. 性能考虑

```typescript
// 限制调试数据量
const debugManager = DebugSystemManager.getInstance({
  maxEntries: 1000, // 限制最大条目数
  enableMemoryProfiling: false, // 关闭内存分析（生产环境）
  enablePerformanceMonitoring: true // 保持性能监控
});
```

### 3. 数据清理

```typescript
// 定期清理旧数据
setInterval(async () => {
  await debugManager.cleanup({
    maxAge: 3600000, // 清理1小时前的数据
    maxSize: 10000   // 保持最多10000条记录
  });
}, 300000); // 每5分钟清理一次
```

### 4. 错误处理

```typescript
// 设置错误回调
debugManager.on('error', (error) => {
  console.error('调试系统错误:', error);
  // 发送告警通知
});

// 监控特定错误类型
debugManager.on('module-error', (error) => {
  if (error.severity === 'critical') {
    console.error('关键模块错误:', error);
  }
});
```

## 常见问题

### Q: 如何获取特定时间段的模块数据？

```typescript
const historicalData = await debugManager.getDebugData({
  filters: {
    timeRange: {
      start: Date.now() - 86400000, // 24小时前
      end: Date.now()
    }
  }
});
```

### Q: 如何导出模块数据？

```typescript
// 导出为 JSON
const exportData = await debugManager.exportData({
  format: 'json',
  modules: ['my-module'],
  timeRange: { start, end }
});

// 保存到文件
require('fs').writeFileSync('module-debug-data.json', JSON.stringify(exportData, null, 2));
```

### Q: 如何设置调试告警？

```typescript
// 设置错误率告警
debugManager.setAlert('error-rate', {
  threshold: 5, // 5% 错误率
  window: 300000, // 5分钟窗口
  callback: (metric) => {
    console.warn(`⚠️ 模块错误率过高: ${metric.value}%`);
  }
});
```

## 总结

RouteCodex 的调试系统提供了多层次、多维度的模块记录信息获取能力：

1. **编程接口** - 通过 API 直接获取数据
2. **实时推送** - WebSocket 实时事件
3. **REST 接口** - HTTP API 查询
4. **可视化界面** - Web 界面展示
5. **导出功能** - 数据导出和分析

这套系统能够满足从开发调试到生产监控的各种需求。