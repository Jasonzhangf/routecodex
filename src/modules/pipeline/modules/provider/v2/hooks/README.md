# Hooks双向监控系统

## 概述

Hook系统是Provider V2架构中的双向数据流监控组件，支持在请求/响应处理的每个关键节点读取、写入和监控数据变化。当启用最高优先级调试模式时，系统会输出详细的数据变化追踪信息，帮助开发者清晰了解数据从请求到响应的完整流转过程。

## 核心特性

### 🔍 双向数据流监控
- **读取监控**: 在不修改数据的情况下观察和记录数据状态
- **写入修改**: 允许在指定阶段注入或修改数据字段
- **数据转换**: 提供完整的数据读取、修改和返回新数据的能力

### 📊 全生命周期追踪
系统在以下9个关键阶段提供监控点：
1. **INITIALIZATION** - Provider初始化阶段
2. **REQUEST_PREPROCESSING** - 请求预处理阶段
3. **REQUEST_VALIDATION** - 请求验证阶段
4. **AUTHENTICATION** - 认证处理阶段
5. **HTTP_REQUEST** - HTTP请求发送阶段
6. **HTTP_RESPONSE** - HTTP响应接收阶段
7. **RESPONSE_VALIDATION** - 响应验证阶段
8. **RESPONSE_POSTPROCESSING** - 响应后处理阶段
9. **ERROR_HANDLING** - 错误处理阶段

### 🐛 高级调试功能
- **结构化日志输出**: 提供清晰的数据变化记录
- **性能指标监控**: 自动记录Hook执行时间和数据大小
- **阈值警告**: 超过性能阈值时自动告警
- **数据流快照**: 保存完整的数据变化历史

## 使用方法

### 基础用法

```typescript
import { BidirectionalHookManager, HookStage } from '../config/provider-debug-hooks.js';
import { registerDebugExampleHooks, enableDebugMode } from './debug-example-hooks.js';

// 1. 注册调试Hooks
registerDebugExampleHooks();

// 2. 启用调试模式
enableDebugMode('detailed');

// 3. 正常使用Provider，系统会自动输出调试信息
```

### 自定义Hook

```typescript
import { BidirectionalHook, HookStage } from '../config/provider-debug-hooks.js';

// 创建自定义监控Hook
const customMonitoringHook: BidirectionalHook = {
  name: 'custom-monitoring',
  stage: HookStage.REQUEST_PREPROCESSING,
  target: 'request',
  priority: 90,

  // 读取数据但不修改
  read(data, context) {
    console.log(`🔍 监控请求: ${JSON.stringify(data.data).substring(0, 100)}...`);
    return {
      observations: [`监控到请求大小: ${data.metadata.size} bytes`],
      shouldContinue: true
    };
  },

  // 写入/修改数据
  write(data, context) {
    const modifiedData = { ...data.data };
    modifiedData._customField = 'injected-by-hook';

    return {
      modifiedData,
      changes: [{
        type: 'added',
        path: '_customField',
        newValue: 'injected-by-hook',
        reason: '自定义字段注入'
      }],
      observations: ['注入自定义字段']
    };
  }
};

// 注册Hook
BidirectionalHookManager.registerHook(customMonitoringHook);
```

### 调试模式配置

```typescript
import { BidirectionalHookManager } from '../config/provider-debug-hooks.js';

// 配置调试模式
BidirectionalHookManager.setDebugConfig({
  enabled: true,
  level: 'verbose',        // basic | detailed | verbose
  maxDataSize: 2048,       // 最大记录数据大小
  stages: [                // 监控的阶段
    HookStage.REQUEST_PREPROCESSING,
    HookStage.HTTP_RESPONSE,
    HookStage.RESPONSE_POSTPROCESSING
  ],
  outputFormat: 'pretty',  // json | structured | pretty
  outputTargets: ['console'], // console | file | provider-log
  logFilePath: './debug-hooks.log',
  performanceThresholds: {
    maxHookExecutionTime: 50,    // Hook执行时间阈值(ms)
    maxTotalExecutionTime: 500,  // 总执行时间阈值(ms)
    maxDataSize: 1024 * 1024     // 数据大小阈值(bytes)
  }
});
```

## 数据结构

### HookExecutionContext
```typescript
interface HookExecutionContext {
  requestId: string;        // 请求ID
  providerType: string;     // Provider类型
  stage: HookStage;         // 当前阶段
  startTime: number;        // 开始时间戳
  profile: ServiceProfile;  // 服务配置档案
  debugEnabled: boolean;    // 调试是否启用
  changeCount: number;      // 数据变化次数
  executionId: string;      // 执行ID
}
```

### HookDataPacket
```typescript
interface HookDataPacket {
  data: UnknownObject;      // 实际数据
  metadata: {
    dataType: 'request' | 'response' | 'headers' | 'config' | 'auth' | 'error';
    size: number;           // 数据大小
    changes: DataChange[];  // 变化记录
    timestamp: number;      // 时间戳
    executionId: string;    // 执行ID
  };
}
```

### DataChange
```typescript
interface DataChange {
  type: 'added' | 'modified' | 'removed' | 'unchanged';
  path: string;             // 字段路径
  oldValue?: unknown;       // 旧值
  newValue?: unknown;       // 新值
  reason: string;           // 变化原因
}
```

## 调试输出示例

### 启用调试模式后的输出示例

```
🔍 [DEBUG Hook] request-monitoring (request_preprocessing)
📊 数据大小: 1024 bytes
📝 变化数量: 2
💭 观察记录: 3

🔄 变化详情:
  added: _debugTimestamp = 1703123456789
  added: _traceId = hook_1_1703123456789

📋 数据快照: {
  "model": "gpt-3.5-turbo",
  "messages": [...],
  "_debugTimestamp": 1703123456789,
  "_traceId": "hook_1_1703123456789"
}

✅ [DEBUG Hook] request_preprocessing 阶段完成 (request)
⏱️  总执行时间: 15ms
🔄 总变化数量: 2
💭 总观察记录: 5

📊 变化统计:
  added: 2
```

### 性能警告示例

```
⚠️ Hook执行时间过长: 150ms
⚠️ 处理时间过长: 5200ms
⚠️ 数据大小超限: 2048KB > 1024KB
```

## 最佳实践

### 1. Hook设计原则
- **单一职责**: 每个Hook只负责一个明确的功能
- **无副作用**: read操作不应修改原始数据
- **性能考虑**: 避免在Hook中执行耗时操作
- **错误处理**: Hook内部应妥善处理异常

### 2. 调试级别选择
- **basic**: 仅记录关键信息和错误
- **detailed**: 记录完整的数据变化和观察
- **verbose**: 记录所有细节，包括数据快照

### 3. 性能优化
- 合理设置数据大小限制，避免内存占用过高
- 使用性能阈值及时发现性能问题
- 在生产环境中谨慎使用verbose级别

### 4. 安全考虑
- 避免在日志中记录敏感信息（如API密钥）
- 使用数据脱敏处理敏感字段
- 合理设置日志文件访问权限

## 内置示例Hooks

### 监控类Hooks
- **requestMonitoringHook**: 监控请求数据和基本信息
- **authenticationMonitoringHook**: 监控认证过程
- **httpRequestMonitoringHook**: 监控HTTP请求发送
- **httpResponseMonitoringHook**: 监控HTTP响应接收
- **responsePostProcessingMonitoringHook**: 监控最终响应处理
- **errorHandlingMonitoringHook**: 监控错误处理过程

### 工具函数
- **registerDebugExampleHooks()**: 注册所有示例Hooks
- **enableDebugMode(level)**: 启用调试模式
- **disableDebugMode()**: 禁用调试模式

## 故障排除

### 常见问题

1. **Hook没有执行**
   - 检查Hook是否正确注册
   - 确认target参数与实际数据类型匹配
   - 验证stage参数是否正确

2. **调试信息没有输出**
   - 确认调试模式已启用
   - 检查debugEnabled配置
   - 验证输出目标设置

3. **性能问题**
   - 降低调试级别
   - 减少监控阶段
   - 调整数据大小限制

4. **数据修改不生效**
   - 检查Hook的优先级设置
   - 确认返回的modifiedData正确
   - 验证changes数组格式

### 调试技巧

1. **使用唯一标识**: 为每个Hook设置唯一的name
2. **详细观察记录**: 在observations中记录详细信息
3. **性能监控**: 利用metrics收集性能数据
4. **错误追踪**: 在错误Hook中记录完整的错误上下文

这个双向监控系统为Provider V2提供了强大的调试和监控能力，帮助开发者深入理解数据流转过程，快速定位和解决问题。