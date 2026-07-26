# V3 巨型文件无痛拆解计划（新增模块 + 物理删除旧代码）

status: executing_phase3_live_snapshot_module_active
owner_feature_id: v3.module_decomposition
sop: docs/architecture/wiki/v3-module-decomposition-sop.md
function_map_entry: docs/architecture/v3-function-map.yml (feature_id v3.module_decomposition, status design_pending)
created: 2026-07-26

## 目标与验收

目标：消除 v3 三个巨型生产文件（`routecodex-v3-server/src/lib.rs` 8540 行、
`routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs` 7338 行、
`routecodex-v3-runtime/src/kernel.rs` 2969 行），全部拆为语义单一的模块文件；
收敛 wrapper 组合爆炸为唯一 ExecutionEnv 入口；行为零变化。

验收证据（每个 Phase 结束必须全绿，不绿不进下一 Phase）：

- `cargo fmt --manifest-path v3/Cargo.toml --all -- --check`
- `npm run test:v3-workspace`
- `verify:v3-module-boundaries` / `verify:v3-resource-map` / `verify:v3-rust-only`
- `npm run render:v3-mainline-caller-flow` + `verify:v3-mainline-caller-flow`
- `verify:v3-architecture-docs` / `test:v3-compile-fail` / `git diff --check`
- 全部 Phase 完成后一次性 live 闭环：`npm run install:v3` + `rccv3 restart` +
  4444/5555/10000 health + dry-run + JSON/SSE smoke（与既有 closeout 流程一致）。

## 无痛五原则

1. **只移动、不改写**：每个 Phase 只做代码搬移、入口收敛、死代码删除，不改任何
   业务语义。行为不变的证据 = 既有测试栈全绿（relay integration 26/26、
   direct continuation 16/16、multi_listener_server 37/37 等）。
2. **移动即删除**：代码从旧文件剪切到新模块，同一变更集内旧位置物理消失。
   禁止复制后保留旧副本"以防万一"（护栏 11）。
3. **门面不变**：crate 根 `lib.rs` 用 `pub mod x; pub use x::...;` 保持既有公共
   路径。这是 Rust 标准 crate facade，不是双路径 fallback——符号定义只有一处。
4. **map 同步是同一变更集**：涉及 `caller_file`/`callee_file` 变化的搬移，
   `docs/architecture/v3-mainline-call-map.yml` 在同一提交内更新并 re-render，
   由 `verify:v3-mainline-caller-flow` 强制。
5. **每 Phase 一个提交**：可独立回滚；在干净基线开始，不触碰当前 worktree 中
   其他 worker 的未提交文件（含 package.json 冲突标记文件）。开工前按护栏 35
   在 `.agent-collab/claims/` 占用 `v3.module_decomposition`。

## Phase 0 — 基线锁定 + 尺寸 gate（先立门，再拆墙）

1. 干净基线上跑一遍完整验证栈，记录 PASS 到 note.md。
2. 新增 `scripts/architecture/verify-v3-file-size.mjs`（或并入
   `verify-v3-module-boundaries.mjs`）：
   - 规则：v3 生产 `.rs`（排除 `tests/`）行数上限 **1500**。
   - 白名单：当前已超标文件的**当前行数快照**（server/lib.rs=8540、
     responses_relay_runtime.rs=7338、kernel.rs=2969、lifecycle/lib.rs=2795、
     anthropic_codec.rs=1712、config/validate.rs=1705）。
   - 棘轮语义：白名单文件只许变小或除名，任何文件不得超过自身快照；
     新文件一律 ≤1500。
   - 接线：挂进 `test:v3-workspace` 前置与 CI（护栏 22a，不接线不算 gate）。

产出：后续每个 Phase 的收缩都被机器锁定，拆完不会长回来。

## Phase 1 — 物理删除死 wrapper（纯删除，风险最低）

对象：`responses_relay_runtime.rs` 与 `kernel.rs` 中调用数为 0 的组合入口。
已核实 relay 侧至少 4 个外部零调用：

- `execute_v3_responses_relay_runtime_with_default_transport_and_local_continuation`
- `execute_v3_responses_relay_runtime_with_default_transport_health_and_local_continuation`
- `execute_v3_responses_relay_runtime_with_transport_health_and_local_continuation`
- `execute_v3_responses_relay_runtime_with_transport_health_local_continuation_stopless_control_and_initial_target`

步骤：以全仓 caller 图（含 wrapper 相互调用）为准，自叶向根迭代删除，直到
每个保留入口都有真实调用者。kernel 侧同法。

验证：cargo build + relay/direct 全部测试 + 固定验证栈。

## Phase 2 — Wrapper 收敛为唯一 ExecutionEnv 入口

现状：其余 wrapper 每个只有 1 个调用点，收敛成本一次性最低。

1. 新增 `hub_v1/relay_execution_env.rs`：

   ```rust
   pub struct V3ResponsesRelayExecutionEnv<'a, T: ResponsesTransport> {
       pub transport: &'a T,
       pub retry_policy: V3ResponsesRelayRetryPolicy,
       pub health: Option<&'a V3ResponsesRelayProviderHealthHandle>,
       pub local_continuation: Option<&'a mut V3ResponsesRelayLocalContinuationState>,
       pub stopless_control: Option<&'a mut V3ResponsesRelayStoplessControlState>,
       pub provider_snapshots: Option<&'a V3ResponsesRelayProviderSnapshotCapture>,
       pub initial_target: Option<V3SelectedTarget>,
   }
   ```

   唯一入口 `execute_v3_responses_relay_runtime(env, input)` +
   `execute_v3_responses_relay_dry_run_runtime(env, input)`，内部直连现
   `_inner`。默认 transport 由 `V3ResponsesRelayExecutionEnv::with_default_transport()`
   构造器提供，不再为每种组合造函数名。
2. 逐个迁移真实调用点（server/lib.rs 与各测试文件，各 1 处），随后**物理删除
   全部旧组合 wrapper**（约 15 个）。
3. `kernel.rs` 同构：`V3ResponsesDirectExecutionEnv` + 唯一入口，删除 8 个组合
   wrapper。
4. call map：涉及这些 symbol 的边改指唯一入口，re-render。

反模式锁：在 module-boundaries gate 增加一条正则红线——v3 生产源禁止新增
`execute_v3_.*_with_.*_and_.*` 形态的三段以上组合入口命名。

## Phase 3 — Server crate 拆模块（纯移动 + 门面）

`routecodex-v3-server/src/lib.rs` 按语义域切成模块，lib.rs 保留 listener/
router/startup 编排 + `pub use` 门面（外部消费者只有 lifecycle crate 与 bin，
公共路径不变即零改动）。

搬移顺序按耦合从低到高，**每个模块一个子步骤，搬完即编译即测**：

| 步骤 | 新模块 | 内容（现 lib.rs 中的块） | 约行数 |
|---|---|---|---|
| 3.1 | `request_id.rs` | `V3RequestIdCounter/Clock/Tm`、counter file、format_v3_request_id_* | ~300 |
| 3.2 | `console/mod.rs`（可再分 `format.rs`/`emit.rs`/`finalize.rs`） | 全部 `emit_v3_*`、`format_v3_*`、宽度对齐、着色、`V3SseConsoleFinalizer`、`V3DirectSseConsoleFinalizer`、`V3ConsoleEmissionContext` | ~1100 |
| 3.3 | `live_snapshot.rs` | `V3LiveSnap*`、`capture_v3_*`、`persist_v3_codex_sample_*`、snapshot session | ~500 |
| 3.4 | `websocket.rs` | `responses_websocket_*` 全部会话/帧/SSE 桥接 | ~550 |
| 3.5 | `endpoints.rs` | health、models、virtual_router_status/dry_run、pending | ~400 |
| 3.6 | `direct_frame.rs` | `execute_responses_direct_server_frame` 及直连帧辅助 | ~150 |
| 3.7 | `error_projection.rs` | `record_and_emit_v3_error_projection`、projection header | ~100 |
| 3.8 | lib.rs 收口 | 剩 listener state、router 搭建、aggregate spawn/shutdown、`pub use` 门面 | 目标 ≤1500 |

配套动作：

- **resource map 登记**：`console` 与 `live_snapshot` 显式登记为
  debug/projection side-channel resource（护栏 27），声明禁止边：业务
  request/response 链不得读取二者产出。
- **call map**：33 个锚定 `routecodex-v3-server/src/lib.rs` 的边逐步改到新
  文件路径，随搬移同提交更新。
- **checklist**：grep 所有 verify 脚本中硬编码的
  `routecodex-v3-server/src/lib.rs` 路径特判，随搬移同步（已查
  module-boundaries 主体无此特判，逐步搬前再全量 grep 一次）。
- 尺寸 gate 白名单中 server/lib.rs 的快照随每步下调。

## Phase 4 — Relay/Kernel 主函数节点化（阶段函数抽取）

对象：`execute_v3_responses_relay_runtime_inner`（~744 行）与
`execute_v3_responses_direct_runtime_kernel_core`（~740 行）。

1. 新增 `hub_v1/relay_exec/` 目录，把隐式段落抽成显式阶段函数，每函数
   签名即相邻转换：
   - `candidate_select.rs` — 重试循环内候选目标选取
   - `transport_round.rs` — 单轮 provider transport 请求/响应
   - `failure_policy_round.rs` — provider failure 观察 + 策略判定
   - `continuation_commit.rs` — `commit_or_release_responses_local_continuation` 及 direct locator commit
   - `stopless_gate.rs` — stopless summary gate（relay/direct 共用语义各自 owner，不做共享双版本）
   `_inner` 退化为 ≤200 行编排循环，只按序调用阶段函数。
2. `kernel.rs` 同构拆 `direct_exec/`；`V3Execution11ProtocolDecision` 保持
   现有 owner 位置不动（本 Phase 不碰协议决策语义）。
3. call map：为每个阶段函数补相邻边（`from_node`/`to_node` 沿用既有
   V3 节点名，如 `V3Target10ConcreteProviderSelected` →
   `V3Execution11ProtocolDecision` → transport 节点），status=anchored。
4. 测试：不新增语义，既有 relay integration / direct continuation /
   failure policy 正反测试即回归证据；若抽取暴露出无法独立测试的段落，
   补最小白盒测试后再搬。

## Phase 5（可选，独立排期）— lifecycle 与 codec

- `lifecycle/src/lib.rs`（2795 行）→ `declaration.rs` / `operation_lock.rs` /
  `spawn.rs` / `control.rs` / `restart.rs` / `stop.rs`，lib.rs 留门面。
  注意 call map `v3.server.managed_lifecycle` 链 7 条边全部锚定此文件，
  需同步。
- `anthropic_codec.rs`（1712 行）→ `anthropic_codec/{request,response,tools}.rs`。
  27/27 characterization + 11 red fixtures 是现成回归网。

## 明确不做（防跑偏）

- 不改任何节点语义、错误码、重试/健康策略、continuation owner 判定。
- 不引入兼容 shim 双实现：旧函数名一旦迁移即物理删除，不留 deprecated 转发。
- 不在本计划内解决 direct continuation 对 cc 的 provider 400 live gap
  （那是独立语义问题，见 note.md 2026-07-26T18:20）。

## 风险与回滚

- 最大风险是 call map/gate 与源码搬移不同步 → 由"同一提交 + verify 全绿才
  提交"消除；gate 红即回滚该 Phase 单提交。
- worktree 现存其他 worker 的脏文件 → 全程 `git add` 仅限本计划触碰路径，
  禁止批量 add/checkout（护栏 12）。
