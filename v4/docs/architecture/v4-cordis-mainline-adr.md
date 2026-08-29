# ADR: V4 Cordis 主线与 Rust 数据面执行

状态：`accepted-for-m00`

## 决策

Cordis 是 V4 active plugin graph、插件组合、Context/Fiber 生命周期、candidate mount/validate/smoke、execution epoch 编译与发布的唯一编排真源。Rust 是唯一数据面执行器，负责 admission、immutable epoch lease、NodeExecutionFrame、节点链执行、HTTP/SSE/WebSocket、provider bytes、buffer/backpressure 和 request-local typed ControlFrame。

生产主线固定为：

```text
Cordis authoring/catalog
  -> validated graph + ExecutionEpochBundle
  -> Rust prepare/smoke
  -> Cordis commit
  -> Rust admission + immutable epoch lease
  -> ExecutionEngine node chain
  -> terminal / typed runtime facts
```

Cordis 不解释每个请求、节点或 SSE frame。业务 payload 不经过 Cordis event bus。request route/retry/continuation 等高频控制状态留在 Rust request-local typed side-channel，仅异步发布有界 RuntimeFact；管理生命周期使用 typed command/event。

## 所有权

| 领域 | 唯一 owner |
|---|---|
| 插件启用、禁用、版本、顺序、节点图、selection group | Cordis Host / compiler |
| Context、Fiber、Effect 生命周期 | Cordis Host |
| candidate mount、validate、smoke、publish 编排 | Cordis Host |
| active epoch 实际指针、admission、lease | Rust ActiveEpochStore |
| 节点执行与相邻输出接线 | Rust ExecutionEngine |
| HTTP、SSE、WebSocket、provider transport | Rust server/provider |
| plugin identity 到 Rust 实现解析 | Cordis bridge `HandleRegistry` / `PluginHandle` |
| route/error/health/continuation 高频请求控制 | Rust typed ControlFrame 对应唯一 service |
| 管理命令、生命周期事实、审计投影 | Cordis bridge + Rust facts |

## 不变量

1. Rust 不得自行创建生产 plugin graph、排序插件或切换 active plugin graph。
2. Rust `HandleRegistry` 只解析编译计划中的 plugin id；identity、版本、artifact hash 和编排策略仍由 catalog/plan owner 校验。
3. 每个请求 pin 一个 immutable epoch；发布、drain、rollback 不修改进行中的 lease。
4. 节点输出必须是下一相邻节点输入；丢弃输出属于架构错误。
5. control、debug、error、scope、routing、continuation 状态不得进入 normal/provider/client payload。
6. prepare 失败必须显式 abort 并保持旧 active epoch；禁止 fallback 或静默成功。
7. `v4.test.*` 只能存在于测试合同/fixture，不得进入 production active plan。

## 迁移策略

按 M00-M12 执行。每个 milestone 独立 worktree 完成并验证，精确合并 `main`，在 `main` 复验并同步后才创建下一 milestone。V3 只作行为基线和独立产品级 rollback，不作为单请求 fallback。

## 影响

现有 Rust 业务算法、NodePluginPlan、NodeContainer/epoch 生命周期基础和真实 Cordis Context/Fiber 尽量保留；迁移重点是调用所有权、不可变 epoch、typed bridge 和 runtime-bin 主线收缩。现有测试 binding 不等于生产实现，必须由 ratchet 逐项退役。
