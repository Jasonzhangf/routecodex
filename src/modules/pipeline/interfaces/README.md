# Pipeline Interfaces

`src/modules/pipeline` 目录仅保留类型、接口和桥接逻辑，以便 Host 可以与 `llmswitch-core` 的 Hub Pipeline 对齐。实际的节点/执行逻辑全部在 `@jsonstudio/llms` 中实现。

## 作用
- 提供 Host 与共享模块之间的类型声明。
- 供 `llmswitch/bridge.ts` 在编译时进行类型检查。
- 保持老版本插件的最小兼容（类型层面）。

## 维护规则
- 不在本目录添加实际节点实现。
- 任何接口变更需同步到 `sharedmodule/llmswitch-core` 中的对应类型。
- 更新后运行 `npm --prefix sharedmodule/llmswitch-core run build` 并重新链接。

详见：`../../../../sharedmodule/llmswitch-core/README.md`。
