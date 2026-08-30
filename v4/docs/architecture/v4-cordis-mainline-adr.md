# ADR: V4 Cordis 主线与 Rust 数据面执行

状态：`accepted-for-m00`

## 决策

Cordis 是 V4 active plugin graph、插件组合、Context/Fiber 生命周期、candidate mount/validate/smoke、execution epoch 编译与发布的唯一编排真源。Rust 是唯一数据面执行器，负责 admission、immutable epoch lease、NodeExecutionFrame、节点链执行、HTTP/SSE/WebSocket、provider bytes、buffer/backpressure 和 request-local typed ControlFrame。

Direct、Relay 与 SSE 使用不同的生产节点边界：

```text
Direct request/response
  client protocol payload
    -> DirectRelay NodeContainer node
    -> Direct request/response hook queue
    -> same-protocol provider/client payload

Relay request
  client entry codec -> canonical Hub -> request Chat Process
    -> Relay provider hook/codec -> provider protocol payload

Relay response
  provider protocol codec -> canonical Hub -> response Chat Process
    -> Relay client hook/codec -> client protocol payload

SSE transport plugin
  bytes <-> frames, ordering, bounded buffering, backpressure, timeout,
  keepalive and closeout only
```

`DirectRelay` 是独立 NodeContainer 节点，不是 handler/runtime-bin 旁路。它只执行 Cordis 编译并由 epoch lease 固定的 Direct hook queue。SSE 是独立 transport plugin；provider/client codec 或 Direct/Relay hook 可以消费已解帧的 data payload，但 SSE plugin 不解释或修改 payload。

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
| Direct 两端中继节点与 Direct hook queue 执行 | Cordis graph + Rust NodeContainer `DirectRelay` 节点 |
| Direct/Relay 请求与响应 payload 修改 | 对应方向的 registered hook plugin |
| SSE framing、顺序、buffer、backpressure、timeout、keepalive、closeout | 独立 SSE transport plugin |
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
8. Direct 必须保持入口协议与 provider 协议一致；协议不匹配 fail-fast，禁止自动转 Relay。
9. Direct request/response hook 与 Relay request/response hook 必须由 typed execution lane 分离，禁止同一 plan 混装或从 payload 推断 lane、entry protocol、provider protocol、model。
10. 所有 model/field/tool/protocol payload 修改只允许发生在对应 Direct/Relay hook 或相邻 codec；runtime、runtime-bin、server、provider transport 不得补偿。
11. SSE plugin 只拥有 transport framing；不得做模型映射、字段改写、协议投影、terminal 语义判断、continuation、retry、route 或 provider/client payload 修复。
12. 客户端协议与 provider 协议分别由 typed information/control carrier 传递并独立校验；payload 不得用于重建任一协议身份。

## 迁移策略

按 M00-M12 执行。每个 milestone 独立 worktree 完成并验证，精确合并 `main`，在 `main` 复验并同步后才创建下一 milestone。V3 只作行为基线和独立产品级 rollback，不作为单请求 fallback。

## 影响

现有 Rust 业务算法、NodePluginPlan、NodeContainer/epoch 生命周期基础和真实 Cordis Context/Fiber 尽量保留；迁移重点是调用所有权、不可变 epoch、typed bridge 和 runtime-bin 主线收缩。现有测试 binding 不等于生产实现，必须由 ratchet 逐项退役。
