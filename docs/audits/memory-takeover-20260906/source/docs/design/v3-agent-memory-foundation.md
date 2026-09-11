# V3 Agent Memory Foundation

状态：`source_controlled_pending_live_matrix`

本阶段锁定 memory 的业务输出契约、soft admission、L0 Pending Index、Responses Direct 的 Req04 recall、Resp03 observation、compaction/Skill owner，以及 production durable store wiring。tool/summary observer 和真实短样本 replay 仍 pending；不得在 Provider、SSE、route policy 或 stopless 控制层复制实现。

## 边界

```text
Resp03/compaction observation (future caller)
  -> routecodex-v3-agent-memory::observe_memory_output
  -> strict local entry validation
  -> append-only PendingIndex (L0)
```

- `MemoryIndexEntryDraftV1` 是模型可见的业务字段：`schema`、`operation`、`targetMemoryId`、`scope`、`kind`、`title`、`summary`、`tags`、`entities`。
- `entry_id`、`content_hash`、`source`、`generation`、`admitted_sequence` 是 Host typed control/lineage 字段，只存在于 `PendingIndexEntry`，不会被序列化回 provider/client payload。
- `memory` 缺失、不可识别或局部 entry 无效时，parent response 仍按原语义完成；只写 `MemoryDiagnostic`，不 retry、不改写、不污染 tool arguments。
- Tool-call source window 只能指向工具执行前已经完成的 event refs；声称当前/未来 tool result 的 entry 不收集。
- Pending journal 使用 append-only JSONL。每一行是 `append`、`freeze` 或 `commit` event；重启通过重放 journal 恢复 active/frozen/committed 投影，按 canonical draft SHA-256 去重。

## Req04 接线（Memory Skill context operation）

- `MemoryRecallSnapshotV1` 由 memory crate 以 typed Skill projection 提供；generation、
  content hash 与 source 只留在 hook context，不进入 provider-visible 文本。
- memory enabled 时，Req04 同一尾部 user message 还携带固定 schema guidance：模型被强提示
  输出可选的顶层 `memory.entries[]`，Host 仍按 soft-admission 处理缺失或坏 schema。
- `MemoryRecallSnapshotV1::project` 输出 deterministic、bounded 的业务 recall；Runtime
  在现有 stopless/web-search/tool-thinking Req04 准备后、policy/wire 前挂载一次。
- 生产位置是当前轮尾部的 user message。Responses scalar `input` 先转 canonical
  message array；已有固定 marker 时不重复注入。
- 空快照是语义 no-op；不支持的 payload 形状显式返回 Req04 内部错误，不 retry、不
  reselect、不改变 provider health。
- 路由事实在该 projection 前已经计算；memory 不参与 route/provider selection。

Req04 由统一 startup hook plan 以 `operation_ids` 声明顺序调度；Memory Skill
只提供 typed recall projection，Runtime 只负责把它挂到协议 payload 的允许位置。
Direct 与 Relay 共用同一固定 skeleton，协议差异只能留在相邻 codec；缺少 startup
plan 的 production skeleton 必须 fail-closed。兼容、测试和 dry-run 入口可以保留
旧 API，但不得作为 production caller，也不得在 request path 编译 plan。

## Compaction 与 Skill source slice

- `MemoryOrganizationTransaction` 复用一个 incremental/full owner：先对
  `PendingIndex::preview_freeze` 做无副作用校验，再冻结精确 generation/watermark。
- durable `MemoryKnowledgeStore` 以 append-only prepare/commit journal 保存 raw
  knowledge、organization delta 和 epoch。prepared cut 在 commit marker 前不进入
  recall snapshot；重启通过 `recover_pending` 与 Pending 的 frozen/committed 状态对账，
  不发布 partial epoch，且重复恢复幂等。
- `MemoryLevelOneIndexV1` 将 Skill body 按 canonical manifest hash 单独持久化；一级
  index 只追加 `skill_ref`、`version`、`manifest_hash`，同一版本禁止 hash 替换。
- 以上是 memory crate 的 source-controlled 基础能力；store/profile 初始化、备份/迁移、
  跨进程 managed replay 不在本阶段宣称完成。

## Production runtime store

- `MemorySkillHandle::open` 是唯一 runtime store 初始化 owner：按 canonical
  `config.v3.toml` 父目录打开 `memory/pending`、`memory/knowledge` 和 `memory/index`，先
  调用 `MemoryKnowledgeStore::recover_pending`，再创建冻结 recall snapshot。
- `compile_v3_hub_hook_operation_plan_for_server` 只在 listener startup 读取已编译
  Manifest 的 `agent_memory` feature（默认关闭，server override 优先于 global），启用
  listener 共享一个 cloneable `MemorySkillHandle`；禁用 listener 不创建 memory 目录。
  缺失 canonical config path、任一 journal 损坏或恢复不一致都会显式阻止 startup，
  不回退到临时内存或空 store。
- `V3HubHookOperationPlan` 持有这个 typed Skill handle；Direct 与 Relay 的固定 skeleton
  只通过 plan 的 Req04/Resp03 operations 读取 snapshot/observer，server 不解释 entry、
  generation、hash、source 或 admission 结果。

## 后续接线

1. Req04：统一 operation plan 读取 typed frozen memory snapshot，仅在允许的 current-turn 位置追加 bounded recall；空 recall 时 provider-bound payload 保持 semantic identity。
2. Resp03：仅在 canonical completed terminal 后观察可选 `memory`；buffered JSON 要求真实 `completed + finish_reason=stop`，native Responses SSE 使用已登记的 `response.completed + response.status=completed` typed proof。admission 失败不得改变 parent output、stopless 状态或 provider health。
3. Tool/summary observer：在各自 canonical terminal/source-window owner 接入同一 Core admission；当前只有 Responses Direct end-turn/SSE source slice。
4. 真实样本：恢复用户点名的短/长四件套后，短样本先跑 A/B/C 注入矩阵，再跑长样本；当前没有完整短 stop fixture。实时复核确认当前 `.rcc/codex-samples` 没有完整 `completed + finish_reason=stop` 四件套；归档中仅有两份 245k/213k 的完整长/中长 stop 四件套，三者都不能冒充短样本。

## Foundation gates

- `CARGO_NET_OFFLINE=true cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-agent-memory --lib`
- `cargo fmt --manifest-path v3/Cargo.toml --all -- --check`
- `git diff --check`

后续 runtime wiring 必须增加短/长真实 stop-only 样本的 provider-bound payload byte/semantic diff、schema 遵从率、terminal 结果和 context ratio；短样本 A/B/C 未通过前不得执行长样本 replay。
