# Enhancement Module

模块增强工厂与模板集合。为现有模块（如 Pipeline/Provider）动态注入监控、日志、度量等能力，保持原有接口不变。

## 主要职责
- 增强注册与工厂创建（`ModuleEnhancementFactory`/`EnhancementRegistry`）
- 模板库（`templates/`）为不同模块提供可复用的增强外壳
- 全局增强配置管理（`EnhancementConfigManager`）

## 对外接口
- `ModuleEnhancementFactory`、`EnhancementRegistry`
- `EnhancementConfigManager`

## 用法
```ts
import { ModuleEnhancementFactory } from './module-enhancement-factory.js';
const factory = new ModuleEnhancementFactory();
const enhanced = factory.enhance(pipelineModule, { performanceTracking: true });
```

