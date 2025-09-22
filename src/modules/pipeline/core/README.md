# Core Pipeline Implementation

核心流水线实现，包含基础流水线类、流水线管理器和OpenAI专用流水线。

## 文件清单

- **base-pipeline.ts**: 所有流水线的基础抽象类，定义统一的流水线接口
- **pipeline-manager.ts**: 流水线管理器，负责预创建和管理所有流水线实例
- **openai-pipeline.ts**: OpenAI专用流水线实现，针对OpenAI协议优化
- **openai-pipeline-factory.ts**: OpenAI流水线工厂，负责创建OpenAI流水线实例

## 核心设计

### BasePipeline
所有流水线的基础类，提供：
- 统一的请求处理接口
- Debug日志记录集成
- 错误处理框架
- 模块生命周期管理

### PipelineManager
流水线管理器，实现：
- 初始化时预创建所有流水线
- 基于provider.model组合选择流水线
- 流水线实例的生命周期管理

### OpenAIPipeline
OpenAI专用流水线，特性：
- OpenAI透传LLMSwitch
- 流式/非流式转换Workflow
- 配置驱动的Compatibility
- 统一的Provider接口

## 使用模式

```typescript
// 1. 创建流水线管理器
const manager = new PipelineManager();
await manager.initialize(config);

// 2. 选择流水线
const pipeline = manager.selectPipeline({
  providerId: 'qwen',
  modelId: 'qwen3-coder-plus'
});

// 3. 处理请求
const response = await pipeline.processRequest(request);
```