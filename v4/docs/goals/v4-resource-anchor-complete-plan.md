# V4 资源锚定补齐与构建门禁统一计划（V4-RESOURCE-ANCHOR-COMPLETE-001）

## 1. 目标与验收标准

把 V4 资源注册表从"部分真源"收口为"全部真源"：49/49 资源 `binding_status=anchored`，
每个资源有唯一 owner crate + owner node + owner symbols + 机器 gate；此前 24 条 design
资源对应的 owner crate（`routecodex-v4-debug` / `routecodex-v4-router` /
`routecodex-v4-provider` / `routecodex-v4-server`）以 contract-bound 最小实现落库，
并按 active-link 模式接入 AppSDK 生命周期与 CI。

验收标准：

1. `v4-resource-operation-map.yml` 49 条全部 anchored，且 `v4/.appsdk/maps/resource-map.json`
   双源一致；`verify-v4-resource-binding.mjs` 对每一条校验 owner crate 存在、owner node
   在 node-graph contract 注册、owner symbols 在源码可解析、allowed/forbidden 与
   data-control-boundary contract 一致。
2. 新增 crate 全部通过 `appsdk verify --admission v4`（contract_bound），并登记
   project.json 模块、resource/function/mainline/verification maps、CI job。
3. 冻结基线不失效：base-node / edge / control / error 的 active artifact 未被修改；
   若新增资源确需由已冻结 crate 拥有（如 control 的 stopless/record_ledger），走完整
   begin-version -> re-freeze 生命周期，或按实现证据迁移 owner 到未冻结模块并记录偏差。
4. 构建门禁统一：`cargo test --workspace --manifest-path Cargo.toml` 覆盖全部
   workspace 成员；workspace 外 crate 全部经 build-link test-consumer 跑 L2 回归，
   verification-map 的 `v4_cargo_workspace_build` 与 CI `v4-build` job（macos-14，V4 canonical `verify:ci`）不遗漏任何模块。
5. 所有新 gate 先红后绿：红自测覆盖"资源缺 owner/缺 symbol/owner crate 不存在/
   node 未注册/双源漂移/控制资源进 payload"等负类。
6. DSH review（opencode-go/deepseek-v4-flash）语义 PASS，无 P0/P1、无"修复后再审"。

## 2. 范围与边界

### In scope

- 新建 `routecodex-v4-debug`（12 条 design 资源）、`routecodex-v4-router`
  （`v4.control.route_policy_live`）、`routecodex-v4-provider`
  （`v4.control.availability`）、`routecodex-v4-server`
  （`v4.console.terminal_output` / `v4.server.request_identity` /
  `v4.error.raw_wire_evidence`），均为 contract-bound 最小实现（typed API + 状态机 +
  正反 L2 测试），不做协议/网络/真实 provider 迁移。
- `routecodex-v4-runtime` 补齐 `v4.debug.dry_run_execution` /
  `v4.debug.observability` / `v4.debug.timing_observability`。
- `routecodex-v4-config` 补齐 `v4.debug.codex_sample_authorization`
  （ConfigManifestV2 发布面扩展）。
- 控制面新增资源（`v4.control.stopless_state` / `v4.control.record_ledger` /
  `v4.node.statistics`）：优先在未冻结 owner 落实现；确需 control crate 时执行
  active-v2 -> active-v3 re-freeze 生命周期（先获 Jason 批准）。
- resource/function/mainline/verification map、project.json、package.json、CI 同步；
- 构建门禁统一与目标模块 freeze（config/runtime 视资源收口证据决定，不强行 freeze）。

### Out of scope

- 修改 V3 任何源码、配置或已发布 runtime；
- 真实 provider 协议迁移、V3 runtime 接入、新 endpoint、网络请求；
- Cordis NodePlugin / WebUI 管理面（后续阶段）；
- 已冻结 active artifact 的静默改写；无批准不做 re-freeze；
- 不新增未登记资源、不重建等价 DTO / fallback / silent strip。

## 3. 设计原则

- 资源注册表是机器真源：每个资源 = owner crate + owner node + owner symbols + gate；
  四者互相锚定，禁止仅文档声明。
- 新增能力走 Rust + typed contract，TS 只留薄壳/桥接/诊断；控制语义只走
  typed side-channel / MetadataCenter，绝不进 provider/client 正常 payload。
- 新 crate 全部走 active-link 模式：独立模块注册、build-consumer/test-consumer 构建、
  frozen 后仅 active artifact 消费，禁止源码 path 依赖 frozen crate。
- 冻结 crate 需扩展时，先查生命周期 owner；未获批准不 re-freeze。
- 每次改动只动 v4/ + verify 脚本 + package.json + CI；不裹 V3 dirty worktree。

## 4. 技术方案

### 4.1 资源归属与实施面（24 条 design -> anchored）

| owner crate | 资源 | 实施内容 |
| --- | --- | --- |
| routecodex-v4-debug（新建） | snapshot_ledger / module_switch / dry_run_chain / bus_subscription / snapshot_subscription / trace_context / event_ledger / raw_capture / snapshot_session / dry_run_fixture / payload_budget / codex_sample_filesystem | DebugRuntime typed API：trace/ledger/raw/snapshot/dry-run/budget/retention 状态机；debug-subscription.contract.json 已有基线，禁止放宽 |
| routecodex-v4-router（新建） | v4.control.route_policy_live | LivePolicyOverride：baseline_from_manifest + live_update + audit + immutable history，payload_patch forbidden |
| routecodex-v4-provider（新建） | v4.control.availability | V4Availability01SessionScoped：session 级 availability 状态机，禁进程全局 cooldown truth、禁 router 写 health |
| routecodex-v4-server（新建） | v4.console.terminal_output / v4.server.request_identity / v4.error.raw_wire_evidence | ConsoleProjection、V4RequestIdCounter（serverId+localDay+sequence）、terminal-failure 证据 flush |
| routecodex-v4-runtime（扩展） | v4.debug.dry_run_execution / v4.debug.observability / v4.debug.timing_observability | 仅干跑（no network terminal effect）、observability accumulator、timing summary，全部 diagnostic-only |
| routecodex-v4-config（扩展） | v4.debug.codex_sample_authorization | ManifestPublished 输出 codex samples 授权面，仅配置信息，进 payload 即红 |
| routecodex-v4-control（决策点） | v4.control.stopless_state / v4.control.record_ledger / v4.node.statistics | 优先在 runtime/debug 落实现并同步 owner；若证据指向 control，需批准 re-freeze |

### 4.2 Gate 扩展

- `verify-v4-resource-binding.mjs`：从"anchored 25"改为全量 49 校验，新增 owner symbol
  源码可解析（src 索引）、owner crate 模块注册、node 注册校验；红自测补齐
  "design 仍被引用"、"owner crate 不存在"、"symbol 缺失"、"node 未注册"、
  "双源漂移"。
- `verify-v4-execution-binding.mjs` / `verify-v4-capability-isolation.mjs`：
  覆盖新 crate 的 allowed/forbidden writer/reader 与 payload 隔离负类。
- verification-map：新 crate 各注册 `v4_*_l2_regression`（test-consumer）与
  `v4_*_resource_binding`；`v4_cargo_workspace_build.required_for` 扩展覆盖全部模块。
- package.json：`verify:v4-foundation` 与 `verify:v4-foundation-red` 追加对应 gate。
- CI：`v4-build` job（macos-14）安装 v4 依赖并调用 V4 canonical `verify:ci`，覆盖新 crate
  test-consumer 与资源全锚定 gate（root CI 不枚举 V4 内部矩阵）。

## 5. 风险与规避

| 风险 | 规避 |
| --- | --- |
| debug crate 一次锚 12 资源过大 | 分 3 批红测：ledger/trace/raw -> subscription/snapshot -> dry-run/budget/retention；每批独立 L2 绿后并入 |
| 冻结 control 需扩展导致 re-freeze | 先按实现证据选 owner；必须 re-freeze 时先报 Jason 批准，禁止静默改 active artifact |
| 新 crate 与 active-link 约束冲突 | 新 crate 走 build-consumer/test-consumer；不加入 workspace 成员（沿用 config/control/error 模式），workspace gate 统一为"workspace 成员 + 全量 test-consumer" |
| 资源 self-anchor（gate 用资源自身证明资源） | nodeIds 只来自 node-graph 三链 + skeleton checkpoints + registered_nodes，禁止把 resource.owner_node 并入校验集合 |
| 控制/诊断字段进 payload | plane-isolation + capability-isolation gate 负类覆盖新 crate 全部资源 |
| 只加文档不改实现 | 每条 anchored 必须能解析到真实 symbol 与测试；验证栈先行，先红后绿 |

## 6. 测试计划

1. 红测先行：对每条新增资源先写负类（缺 owner / 缺 symbol / 越权 writer /
   payload 泄漏 / 双源漂移 / 未注册 node），确认当前红。
2. L2 白盒/黑盒：每 crate 至少覆盖生命周期正向 + 反向（重复 register / 未注册
   consume / 已释放复用 / 越权写入 / 跨 session 复用），正反成对。
3. 构建/门禁矩阵：`cargo test --workspace --manifest-path Cargo.toml`、
   build-link test-consumer（全部模块）、`npm run verify:v4-foundation`、
   `npm run verify:v4-foundation-red`、`appsdk verify --admission v4`、
   gen/verify-index、fmt/release build。
4. 全量验证绿后 DSH review，语义 PASS 后交付。

## 7. 实施步骤（顺序）

1. 资源归属确认：核对 24 条 design 资源与 debug-subscription / data-control-boundary /
   node-graph contract 基线，锁 owner 与 gate；冻结 crate 冲突先记决策点。
2. Gate 先行：扩 `verify-v4-resource-binding.mjs`（49 全量 + 红自测），先红后绿；
   登记 verification-map / package.json / CI。
3. 新 crate 落库：debug -> router/provider -> server，逐 crate
   `contract_bound`（project.json + maps + L2 红测 + test-consumer 绿）。
4. 扩展 runtime/config 资源面（dry-run/observability/timing、codex_sample_authorization）。
5. 全量 49 anchored 双源同步；处理 control 决策点（owner 迁移或批准 re-freeze）。
6. 构建门禁统一：`v4_cargo_workspace_build` 覆盖全部模块，CI `v4-build` job（macos-14）经
   V4 canonical `verify:ci` 完整执行。
7. 全量验证矩阵绿；提交（显式路径，不裹 V3 dirty）。
8. DSH review PASS；更新 plan ledger / note / MEMORY。

## 8. 完成定义（DoD）

- 49/49 资源 anchored，双源一致，机器 gate 校验符号/节点/模块真实存在；
- 新 crate 全部 contract_bound 且 L2 回归挂入 CI；workspace 门禁不遗漏模块；
- 冻结基线未被静默修改；control 决策点有批准或证据记录；
- 先红后绿证据在案；全量验证矩阵绿；
- DSH review 语义 PASS（无 P0/P1、无"修复后再审"）。

## 9. 执行偏差记录（2026-08-16）

### 9.1 Control 决策点：owner 迁移到 routecodex-v4-runtime（明确不改 frozen control）

`v4.control.stopless_state` / `v4.control.record_ledger` / `v4.node.statistics`
注册表原 owner 为已冻结的 `routecodex-v4-control`（active-v2）。按本计划 §4.1
决策点与 goal 完成标准（"Control 决策点有批准记录或明确不改"），本 slice
**不改 frozen control**，按实现证据将三条资源 owner 迁移到
`routecodex-v4-runtime`：

- runtime 已拥有同一 control 邻域真源：`v4.scope.session`（V4ScopeRegistry）、
  `v4.lifecycle.payload_cycle`（V4PayloadCycleRegistry）、continuation 三键、
  relay operator 与 route_exit 派生；stopless/record/statistics 与这些
  control center 是同一层，不是 frozen control crate 的 MetadataCenter 面。
- `routecodex-v4-control` 已 frozen active-v2；给它加新能力必须完整
  re-freeze（begin-version -> evidence -> promote -> freeze -> publish），超出
  本 slice 且需 Jason 明确批准；owner 迁移后不再触发。
- 同步动作：`v4-resource-operation-map.yml` owner_crate/owner_node/owner_symbols、
  `.appsdk/maps/resource-map.json` owner、node-graph `registered_nodes` 目录
  三源一致；frozen control/error/edge/base-node Active artifact 零修改。

### 9.2 关系 validator 落点

`verify-v4-resource-binding.mjs` 从"owner crate/symbol 存在性"扩展为完整关系
validator：

- node catalog 真源 = node-graph 三链 nodes + skeleton-plan checkpoints +
  node-graph `registered_nodes`（35 条 side/control/diagnostic/legacy 节点）；
- anchored 资源 owner_node 必须命中 catalog 或 owner_symbols；
- allowed/forbidden writer/reader 的 `V4*` 引用必须命中 catalog（方法引用
  按基节点校验；developer_/incident_/replay_/appsdk::/crate 名称为显式非节点
  引用白名单）；
- allowed writer/reader 与 forbidden writer 冲突即红；
- design 资源在 owner crate 已存在时必须有 owner_symbols 且可解析，禁止
  用 design 状态冒充 truth；
- .appsdk owner 符号必须声明在 YAML owner_symbols/owner_node 中；
- 红自测 12 类负例，先红后绿。

### 9.3 appsdk verify 阻塞修复与红自测适配（2026-08-16 收口）

收口期实际证据与修复：

1. **ARTIFACT_MODULE_SET_MISMATCH 根因**：`v4/.appsdk/project.json` 中
   skeleton build 命令 `cp target/release/deps/libroutecodex_v4_skeleton-*.rlib`
   在 deps 目录存在多个 hash rlib 时 cp 多源到单文件报
   `Not a directory`，compile 中断导致 verify 的 module set 不一致。
   修复：拷贝 `target/release/libroutecodex_v4_skeleton.rlib`（release 根目录
   无 hash 产物）；四个新模块 build 命令从 `--manifest-path v4/Cargo.toml` /
   `--root v4`（仓库根假设）改为与 config/runtime 一致的 `-p` / `--root .`
   （project root 假设），compile 全量 13 模块通过。
2. **红自测适配全 anchored 状态**：49/49 全 anchored 后，原
   `anchored/drift` 用例（翻转 design -> anchored）与
   `design with implemented crate lacks owner_symbols` 用例（依赖 design
   资源存在）失去样本；改为 `anchored flipped to design drifts from .appsdk
   active`（anchored -> design 与 .appsdk active 冲突必红）与
   `anchored resource with empty owner_symbols`（anchored 资源空 symbols 必红），
   红自测仍 12/12。
3. **门禁接线**：verification-map 注册 `v4_debug_l2_regression` /
   `v4_router_l2_regression` / `v4_provider_l2_regression` /
   `v4_server_l2_regression`（module-registry 已引用，此前缺失）；package.json
   `verify:v4-foundation` 10 -> 14 gates、`verify:v4-foundation-red` 追加
   resource-binding 红自测；CI `v4-build` job（macos-14）经 V4 canonical `verify:ci` 覆盖
   4 个 test-consumer
   步骤；active-link frozen-consumer-registry 登记 debug/router/provider/server
   -> base-node（active_artifact），mainline-call-map 补 4 条
   active_artifact_link 边；function-map 补 4 个新 crate function 条目。

验证证据（收口矩阵全绿）：
- `appsdk compile v4` / `appsdk verify v4` / `appsdk verify --admission v4`：
  `{"ok":true,"stage":"contract_bound"}`；
- `verify:v4-foundation` 14 gates 绿（含新 4 个 L2 test-consumer）；
- `verify:v4-foundation-red` 绿（resource-binding 12/12）；
- test-consumer：edge 15、config 11、control 15、error 23、runtime 21、
  debug 5、router 1、provider 1、server 3 全绿；
- `cargo test --workspace --manifest-path Cargo.toml`、release build、
  `cargo fmt --check`、gen/verify-index 全绿。

### 9.4 DSH review 两轮 FAIL 修复与干净 checkout 证据（2026-08-16）

第一轮 DSH review（commit `3ce6f36a0`）FAIL findings 与修复：

1. **P0 control_resources.rs 未入 VCS**：runtime `lib.rs` 声明
   `mod control_resources` 但文件被本地 `.git/info/exclude` 排除、从未提交，
   干净 checkout 编译失败。修复：`git add -f` 纳入版本控制（366 行），
   并从本地 exclude 移除 runtime 目录条目；resource-map 6 个 runtime
   owner_symbols 因此全部可解析。
2. **P1 function-map 伪造 symbol**：`v4.debug.observer` /
   `v4.router.live_policy` / `v4.provider.availability` /
   `v4.server.console_identity_evidence` 的 entry_symbols 与实际源码不符。
   修复：逐符号核对 `DebugRuntime` / `V4Router08LivePolicyOverride` /
   `V4Availability01SessionScoped` / server 四类型真实方法后重写；同时修正
   resource-operation-map 中 4 处 `V4DebugRuntime::*` 伪符号
   （`enabled_for_module`、`register_dry_run_chain`、
   `execute_dry_run_no_network_effect` x2）与 debug-subscription.contract.json
   对应 writer/reader。
3. **P2 codex-sample 授权真源漂移**：debug 的
   `should_capture_snapshot_stage` 读 module_switch 而非 config manifest 授权。
   修复：物理删除该伪读取点；授权发布/消费全部收口到 config crate
   （`CodexSampleAuthorization` 查询 + `ConfigManifestV2` 新增
   `should_capture_codex_sample_stage` 决策入口），resource map 与
   debug-subscription contract 的 allowed_readers 同步为 config 符号；
   `l2_config_v2.rs` 增补 disabled 反向断言。

第二轮 DSH review（commit `39a610fe8`）FAIL findings 与修复：

1. **P1 tracked contract JSON 残留旧符号**：`debug-subscription.contract.json`
   第 17/18 行仍写已删除的 `V4DebugRuntime::execute_dry_run_no_network_effect`
   与 `V4DebugRuntime::should_capture_snapshot_stage`。修复：更新为
   `V4Debug09DryRunNoNetworkTerminalEffect::execute` /
   `CodexSampleAuthorization::should_capture_snapshot_stage`。
2. **P2 授权无消费点**：将 manifest 决策入口
   `ConfigManifestV2::should_capture_codex_sample_stage` 接入正反测试，
   授权 truth 的"发布 -> manifest 查询"链路成为真实代码路径。
3. **P2 死 import**：删除 `control_resources.rs` 未使用的
   `use std::slice::Iter;`。
4. **P2 缺 runtime 编译/测试证据**：在 `39a610fe8` 干净 worktree
   （临时 git worktree，fixture 恢复 active artifact 后）重放
   `test-consumer --consumer routecodex-v4-runtime`（21/21 绿）、
   `routecodex-v4-debug`（5/5 绿）、`routecodex-v4-config`（26/26 绿），
   证明无本地未提交文件即可编译运行。

第三轮验证证据（两轮修复合入前全量重跑）：
- `verify:v4-foundation` 14 gates 绿、`verify:v4-foundation-red` 54 绿；
- config 26 / runtime 21 / debug 5 / router 1 / provider 1 / server 3
  test-consumer 绿；workspace cargo test/build/fmt 绿；
- appsdk 0.1.2（digest 锁定 `sha256:3685149e…`，临时 PATH 隔离运行，
  不覆盖并行 worker 的 0.1.3 全局二进制）compile/verify/admission 绿；
- gen-index/verify-index/active-link 绿。

### 9.5 第三轮 DSH review 与骨架消费链闭环（2026-08-16）

第三轮 DSH review（commit `356a25727`）FAIL 剩余 findings：

1. **P2 contract reader 漂移（已修复）**：`debug-subscription.contract.json`
   `v4.debug.codex_sample_authorization` readers 缺 `V4Config05ManifestPublished`
   （resource map allowed_readers 已含）。已补上，两源一致。
2. **P1（blocking）修复——骨架捕获门消费链闭环**：
   - `DebugRuntime` 增加 `codex_sample_authorizer`（`Option<Arc<dyn Fn(&str)
     -> bool>>`）与 `bind_codex_sample_authorizer` 注入点；
   - `record_snapshot` / `persist` 生产代码强制咨询授权（fail-closed：
     未绑定 authorizer 或 stage 未授权 -> 显式
     `DebugError::SnapshotStageNotAuthorized`，无 silent strip）；
   - 授权决策由 config manifest API `should_capture_codex_sample_stage`
     提供（调用方以闭包注入），资源 map / debug-subscription contract /
     function-map 的 readers/entry_symbols 同步登记消费点；
   - `l2_debug.rs` 新增正反测试：未绑定 fail-closed、已授权 stage 成功、
     未授权 stage 拒绝、persist 同一门控。
   - 保持 49/49 anchored；真实 HTTP capture 调用方仍属长线 Phase 5，
     但骨架捕获门（生产代码）已真实消费授权决策。
