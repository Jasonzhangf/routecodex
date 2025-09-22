# RouteCodex Pipeline Module Documentation

## 目录

- [架构概述](./ARCHITECTURE.md)
- [配置指南](./CONFIGURATION.md)
- [开发指南](./DEVELOPMENT.md)
- [转换表规范](./TRANSFORMATION_TABLES.md)
- [错误处理](./ERROR_HANDLING.md)
- [调试支持](./DEBUGGING.md)
- [性能优化](./PERFORMANCE.md)
- [扩展开发](./EXTENSION.md)

## 快速开始

Pipeline模块是RouteCodex系统的核心组件，负责将路由后的请求通过可组合的处理流水线转换为Provider可处理的格式。

### 基本概念

```
源协议 + 目标Provider = 流水线组合
OpenAI + Qwen = LLMSwitch(透传) + Workflow(流控) + Compatibility(适配) + Provider(Qwen)
```

### 快速使用

```typescript
import { PipelineManager } from '../../src/modules/pipeline/index.js';

// 1. 初始化流水线管理器
const manager = new PipelineManager();
await manager.initialize({
  pipelines: [
    {
      id: 'qwen.qwen3-coder-plus',
      provider: qwenProviderConfig,
      modules: {
        llmSwitch: { type: 'openai-passthrough' },
        workflow: { type: 'streaming-control' },
        compatibility: { type: 'field-mapping' },
        provider: { type: 'qwen-http' }
      }
    }
  ]
});

// 2. 选择流水线处理请求
const pipeline = manager.selectPipeline({
  providerId: 'qwen',
  modelId: 'qwen3-coder-plus'
});

const response = await pipeline.processRequest(request);
```

## 核心特性

### 🔧 模块化架构
- **LLMSwitch**: 协议转换层
- **Workflow**: 流式控制层
- **Compatibility**: 字段适配层
- **Provider**: 服务实现层

### 🚀 预创建流水线
- 初始化时创建所有流水线
- 避免运行时创建开销
- 支持热重载配置

### 📋 配置驱动
- JSON配置转换规则
- Provider配置中指定Compatibility
- 统一的转换表格式

### 🛡️ 错误处理
- 集成ErrorHandlingCenter
- 无静默失败策略
- 认证自动恢复

## 学习路径

1. **架构概述**: 了解整体设计理念
2. **配置指南**: 学习如何配置流水线
3. **开发指南**: 掌握扩展开发方法
4. **转换表规范**: 理解数据转换规则
5. **错误处理**: 学习错误处理机制
6. **调试支持**: 掌握调试技巧
7. **性能优化**: 了解性能优化方法
8. **扩展开发**: 学习自定义模块开发

## 示例项目

参考 `examples/pipeline/` 目录中的完整示例：
- [基础流水线示例](../examples/pipeline/basic/)
- [自定义Provider示例](../examples/pipeline/custom-provider/)
- [转换表配置示例](../examples/pipeline/transformation-tables/)

## API文档

详细的API文档请参考：
- [TypeScript类型定义](../../src/modules/pipeline/types/)
- [接口文档](../../src/modules/pipeline/interfaces/)
- [配置类型](../../src/modules/pipeline/types/pipeline-types.ts)

## 常见问题

### Q: 如何添加新的Provider？
A: 参考[扩展开发](./EXTENSION.md)文档，继承BaseProvider类并实现必要方法。

### Q: 如何配置字段转换？
A: 在Provider配置的compatibility部分定义requestMappings和responseMappings。

### Q: 如何处理认证失败？
A: Pipeline模块已集成ErrorHandlingCenter，认证失败会自动触发恢复流程。

## 社区支持

- 问题反馈: [GitHub Issues](https://github.com/your-repo/issues)
- 功能请求: [GitHub Discussions](https://github.com/your-repo/discussions)
- 文档贡献: [CONTRIBUTING.md](../../CONTRIBUTING.md)

## 版本信息

- **当前版本**: 1.0.0
- **兼容性**: RouteCodex v0.2+
- **最后更新**: 2025-01-22