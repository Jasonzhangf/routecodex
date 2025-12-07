# Pipeline Type Definitions

流水线类型定义仅用于 Host 与 `llmswitch-core` 之间的接口对齐，不参与实际节点实现。

## 文件说明
- `base-types.ts`：与 Hub Pipeline 共享的基础 DTO。
- `external-types.ts`：第三方库或 provider 类型声明。
- `transformation-types.ts`：转换相关类型（兼容层映射规则）。
- `provider-types.ts`：Provider runtime 元数据。

## 维护原则
- 与 `sharedmodule/llmswitch-core/dist/types` 保持一致。
- 类型变更需同步到共享模块并重新构建。
- 不在本目录添加业务实现或运行时逻辑。
