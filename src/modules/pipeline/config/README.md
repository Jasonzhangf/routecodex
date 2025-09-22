# Pipeline Configuration

流水线配置管理，负责配置的加载、验证和管理。

## 文件清单

- **pipeline-config-manager.ts**: 流水线配置管理器

## 功能特性

### 配置管理
- 从多种源加载配置
- 配置验证和类型检查
- 配置热重载支持
- 配置版本管理

### 验证机制
- JSON Schema验证
- 业务逻辑验证
- 依赖关系检查
- 默认值处理

### 缓存优化
- 配置缓存机制
- 增量更新支持
- 内存使用优化
- 性能监控

## 配置格式

```typescript
interface PipelineManagerConfig {
  pipelines: PipelineConfig[];
}

interface PipelineConfig {
  id: string;
  provider: ProviderConfig;
  modules: {
    llmSwitch: ModuleConfig;
    workflow: ModuleConfig;
    compatibility: ModuleConfig;
    provider: ModuleConfig;
  };
}
```

## 使用示例

```typescript
const configManager = new PipelineConfigManager();
await configManager.loadConfig('./config/pipelines.json');

const config = configManager.getPipelineConfig('qwen.qwen3-coder-plus');
const isValid = await configManager.validateConfig(config);
```