# Pipeline Modules

Host 仓库不再实现独立的 pipeline 节点。该目录只保留类型/接口，方便与 `llmswitch-core` Hub Pipeline 对齐。

- `interfaces/`：模块接口类型。

所有实际模块、节点与流程均在 `rcc-llmswitch-core` 中，Host 只通过 `llmswitch/bridge.ts` 调用。
