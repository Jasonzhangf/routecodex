# Provider管理系统增强方案

## 概述

Provider管理系统已显著增强，新增了智能负载均衡、动态Provider管理、故障转移和性能监控功能。

## 新增功能

### 1. 智能Provider选择

#### `getBestProviderForRequest()`
根据模型兼容性和负载情况智能选择最佳Provider：

```typescript
// 根据模型类型和请求类型选择Provider
const provider = providerManager.getBestProviderForRequest('gpt-4', 'chat');
```

**选择策略**：
- 健康状态优先 (healthy > unhealthy)
- 模型兼容性检查
- 负载均衡 (round-robin)
- 自动故障转移

#### `selectProviderByStrategy()`
内部Provider选择算法：

```typescript
private selectProviderByStrategy(providers: BaseProvider[]): BaseProvider {
  // 优先选择健康的Provider
  const healthyProviders = providers.filter(p => p.getHealth().status === 'healthy');

  if (healthyProviders.length > 0) {
    // 在健康Provider中使用round-robin
    const currentIndex = this.metrics.providerSwitches % providerIds.length;
    return healthyProviders[currentIndex];
  }

  // 如果没有健康的Provider，回退到任何可用Provider
  return providers[0];
}
```

### 2. 故障转移机制

#### `executeWithFailover()`
带自动故障转移的请求执行：

```typescript
const result = await providerManager.executeWithFailover(
  async (provider) => {
    return await provider.processChatCompletion(request);
  },
  {
    modelId: 'gpt-4',
    requestType: 'chat',
    maxRetries: 3,
    timeout: 30000
  }
);
```

**故障转移特性**：
- 自动重试机制
- 智能Provider切换
- 请求超时处理
- 详细错误日志

### 3. 动态Provider管理

#### `addDynamicProvider()`
运行时动态添加Provider：

```typescript
const result = await providerManager.addDynamicProvider(
  'new-openai-provider',
  {
    id: 'new-openai-provider',
    type: 'openai',
    enabled: true,
    models: {
      'gpt-3.5-turbo': { maxTokens: 4096 }
    }
  },
  {
    validateOnly: false,  // 完整初始化
    healthCheck: true     // 执行健康检查
  }
);
```

**功能特性**：
- 配置验证
- 健康检查
- 避免重复添加
- 详细的返回信息

### 4. 负载监控

#### `getProviderLoadStats()`
Provider负载统计：

```typescript
const loadStats = providerManager.getProviderLoadStats();
// 返回:
// [
//   {
//     providerId: 'openai-provider',
//     load: 25.5,
//     health: 'healthy',
//     requestsPerMinute: 45,
//     averageResponseTime: 1200
//   }
// ]
```

**负载计算**：
- 基于请求数量和响应时间
- 0-100的负载百分比
- 实时健康状态
- 按负载排序输出

### 5. 增强的配置管理

#### 现有功能增强
- **配置热更新**: `updateProviderConfig()` 支持运行时配置修改
- **状态重置**: `resetProvider()` 重置Provider状态
- **健康监控**: 自动健康检查和恢复

## 系统架构

### Provider生命周期管理

```
Provider创建 → 配置验证 → 初始化 → 健康检查 → 活跃状态
     ↓
  负载监控 → 故障检测 → 自动恢复 → 状态更新
     ↓
  请求处理 → 智能路由 → 故障转移 → 结果返回
```

### 错误处理流程

```
请求失败 → 记录错误 → 检查重试次数 → 切换Provider → 重试请求
     ↓
  重试成功 → 返回结果     重试失败 → 返回最终错误
```

## 使用示例

### 1. 基本使用

```typescript
// 获取最佳Provider处理请求
const provider = providerManager.getBestProviderForRequest('gpt-4', 'chat');
if (provider) {
  const response = await provider.processChatCompletion(request);
}
```

### 2. 带故障转移的请求

```typescript
try {
  const { result, providerId, attempts } = await providerManager.executeWithFailover(
    async (provider) => provider.processChatCompletion(request),
    { modelId: 'gpt-4', maxRetries: 3 }
  );

  console.log(`请求成功，使用Provider: ${providerId}，尝试次数: ${attempts}`);
} catch (error) {
  console.error('所有Provider尝试失败:', error);
}
```

### 3. 动态Provider管理

```typescript
// 添加新的Provider
const addResult = await providerManager.addDynamicProvider(
  'backup-provider',
  backupProviderConfig,
  { healthCheck: true }
);

if (addResult.success) {
  console.log('Provider添加成功:', addResult.message);
}

// 监控Provider状态
const loadStats = providerManager.getProviderLoadStats();
console.log('Provider负载状态:', loadStats);
```

## 性能优化

### 1. 连接池管理
- HTTP连接复用
- 自动连接清理
- 连接超时处理

### 2. 缓存机制
- Provider状态缓存
- 模型列表缓存
- 配置信息缓存

### 3. 并发控制
- 请求队列管理
- 并发限制
- 资源使用监控

## 监控和调试

### 1. 事件发布
所有重要操作都通过DebugEventBus发布事件：
- `provider_added`: Provider添加
- `provider_removed`: Provider移除
- `provider_health_check`: 健康检查
- `provider_switch`: Provider切换
- `provider_request_failed`: 请求失败
- `dynamic_provider_added`: 动态Provider添加

### 2. 指标收集
- 健康检查统计
- Provider切换次数
- 平均恢复时间
- 请求成功率

### 3. 错误处理
- 分级错误处理 (low/medium/high/critical)
- 上下文相关的错误信息
- 自动错误恢复机制

## 配置选项

### ProviderManagerOptions
```typescript
interface ProviderManagerOptions {
  healthCheckInterval?: number;      // 健康检查间隔 (默认30秒)
  autoRecoveryEnabled?: boolean;      // 自动恢复 (默认启用)
  maxConsecutiveFailures?: number;   // 最大连续失败次数 (默认3次)
  providerTimeout?: number;           // Provider超时 (默认30秒)
  enableMetrics?: boolean;            // 启用指标收集 (默认启用)
}
```

## 未来扩展

### 1. 高级路由策略
- 基于地理位置的路由
- 基于成本的路由
- 自定义路由算法

### 2. 高级监控
- Prometheus指标导出
- 分布式追踪
- 性能分析

### 3. 高可用性
- 多区域部署
- 灾难恢复
- 蓝绿部署

---

*Provider管理系统现已具备企业级特性，支持高可用、高性能和智能负载均衡*