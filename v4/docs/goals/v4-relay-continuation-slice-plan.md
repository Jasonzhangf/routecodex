# V4 Relay / Continuation Slice Plan

Design ID: `V4-RELAY-CONTINUATION-001`
Date: 2026-08-15
Status: goal（foundation 9/9 闭环后进入）
Owner feature: `v4.slice.relay_continuation`

## 1. 目标与验收标准

在 V4 foundation（Skeleton / NodeContainer / NodePluginPlan / typed carrier /
error chain / MetadataCenter / Config v2 / Responses Direct compat 已闭环）之上，
实现 Relay + Continuation 的最小垂直切片：

- Relay：RouteCodex 本地治理路径，与 Direct 共用同一条 Hub 链，只通过
  typed facts（entry protocol、provider wire protocol、continuation owner）
  选择 relay operator；禁止 provider 特例、禁止第二条 pipeline。
- Continuation：响应链 `V4HubRespChatProcess03Governed` 是唯一 save 点，
  下一轮请求链 `V4ChatProcess04ContinuationRestore` 是唯一 restore 点；
  两点的不可变区间禁止任何语义转换；恢复键必须同时锁
  entry protocol/endpoint + continuationOwner + session/conversation(+port/group)。

验收标准：

1. 六面（request / response / error / streaming / lifecycle / audit）Relay +
   Continuation V3→V4 兼容证据，`unexplained_diff = 0`（新 gate 机器锁）。
2. Continuation 不可变区红测：resp_chatprocess save 之后、下一轮
   req_chatprocess restore 之前的任何语义转换、history/tool 修补、
   provider/client body 重建都必须红。
3. Direct/Relay 隔离红测：普通 chat/messages 入口命中 responses continuation
   scope 必须红；direct continuation 续到 relay、relay 伪装 remote/direct
   必须红；仅凭 session/scope 命中历史续接必须红。
4. 本 slice 涉及的 design 资源按证据升级为 anchored（至少：scope.session、
   lifecycle.payload_cycle、route_facts、target_selection、route_exit、
   provider_wire_payload、provider_raw、client_wire_payload），其余仍显式
   design；双源一致。
5. 全量验证绿：verify:v4-foundation + red、cargo test --workspace、
   test-consumer（runtime/config/control/error）、appsdk admission。
6. DSH review 语义 PASS（opencode-go/deepseek-v4-flash）。

## 2. 范围与边界

### In scope

- `routecodex-v4-runtime`：relay operator 选择与 continuation
  classify/restore、response continuation commit（Rust 真源）。
- `routecodex-v4-control`：scope.session 注册/绑定/释放、payload_cycle 生命周期、
  stopless_state 已登记 Req04/Resp03 当前轮投影。
- `routecodex-v4-error`：relay/continuation 错误进 ErrorErr01-06 链，
  错误不进入正常 payload。
- 新 gate：`verify-v4-relay-continuation.mjs`（六面 compat + 不可变区 +
  隔离红测），注册 verification-map + package.json + CI test.yml。
- 新 compat slice：`v4/docs/architecture/v4-relay-continuation-compatibility-slice.yml`
  （沿用 responses-direct 六面格式）。
- Config v2 若需要 relay/continuation 声明，走既有 config/selection_group/
  capabilities 扩展，不改 contract 已发布节点。

### Out of scope

- 完整 provider 迁移、新 provider、新协议、新 endpoint（后续阶段）。
- PluginManager / WebUI / runtime hot swap。
- V3 任何改动；`docs/architecture/function-map.yml` supersession 属 V3 侧，
  不在本 slice。
- 动态 plugin discovery、第二 pipeline、fallback/降级。

## 3. 设计原则（继承 foundation 硬约束）

- 控制面与 payload 物理隔离：route/continuation/stopless/error 状态只走
  typed carrier / MetadataCenter / Error 链；payload 不得重建控制状态。
- 禁止 fallback：Relay 或 Continuation 语义缺失、owner 不匹配、fullInput
  缺失时 fail-fast，不做请求侧 cleanup / handler/SSE/outbound 补偿。
- Rust 真源：chat process / continuation 判定 / relay operator 语义只在 Rust；
  TS 只留薄壳、桥接、IO、诊断。
- 链节点不可重排：save/restore 只能挂已发布 group 内部角色
  （RequestContinuationNode / ResponseContinuationNode）。
- 先红后绿：每个不变量先落红测再实现；绿化后跑旧样本/同入口复测。
- 只动 `v4/` + verify 脚本 + package.json + CI；commit 显式列路径，
  不裹带 V3 dirty 工作树。

## 4. 技术方案（文件清单）

### 现有真源（复用，不改语义）

- 链拓扑：`v4/docs/architecture/v4-standard-nodes-and-node-graph.md`
  （04 group 内部 04.1 continuation restore；03 group 内部 03.1
  continuation commit）。
- 节点合同：`v4/contracts/node-graph.contract.json`（request_continuation /
  response_continuation 角色、continuation_save_only_at、
  continuation_immutable_interval_semantics: forbidden）。
- 资源登记：`v4/docs/architecture/v4-resource-operation-map.yml`（32 条
  design 中本 slice 子集）+ `.appsdk/maps/resource-map.json`。
- feature 映射：`v4/docs/architecture/v4-v3-feature-mapping.yml`
  （relay/continuation feature 已逐条 mapped：remote_continuation_contract_store、
  responses_direct_remote_continuation_integration、anthropic_relay_local_
  continuation_integration、relay_runtime_core/shared 等）。
- V3 语义参考（只读，不修改）：`docs/architecture/v3-mainline-call-map.yml`、
  `docs/goals/v3-responses-direct-mvp-test-design.md`。
- Direct compat 模板：`v4/docs/architecture/v4-responses-direct-compatibility-slice.yml`。

### 新增/修改

- 新增 `v4/docs/architecture/v4-relay-continuation-compatibility-slice.yml`：
  六面条目，每面 v3_stage -> v4_container -> v4_checkpoint -> v4_resource ->
  验证 gate -> evidence -> diff_status；unexplained_diff=0。
- 新增 `scripts/architecture/verify-v4-relay-continuation.mjs`：
  1) 六面 compat 机器锁（missing/extra/duplicate/unexplained）；
  2) continuation 不可变区红测（save 后 restore 前语义转换必红）；
  3) Direct/Relay 隔离红测（协议/owner/session 三键）；
  4) 资源双源一致（本 slice 资源 anchored 准入与 .appsdk 一致）；
  `--red-self-test` 全负类覆盖。
- `v4/.appsdk/maps/verification-map.json`：注册
  `v4_compat_gate_relay_continuation`。
- `package.json`：`verify:v4-foundation`（现 9 gates -> 10）与
  `verify:v4-foundation-red`（现 2 -> 3 gate）追加。
- `.github/workflows/test.yml`：追加 gate step（绿 + 红各一步）。
- Rust（按红测后实现）：
  - `routecodex-v4-runtime`：relay operator（request_governance.relay.v1 /
    response 侧 relay 处理）、ContinuationClassify/Restore、ContinuationCommit；
  - `routecodex-v4-control`：ScopeRegistry 三键恢复、PayloadCycleRegistry
    terminal 判定、Stopless 当前轮投影（仅已登记例外）；
  - `routecodex-v4-error`：relay/continuation 错误链接线（如需要）。

## 5. 风险与规避

- 风险：把 continuation 语义放进 SSE/handler/outbound 补偿。
  规避：不可变区红测 + 唯一 owner 自检；发现越界物理删除再回 Chat Process。
- 风险：direct/relay 隔离只靠 session 命中。
  规避：恢复键三锁（entry protocol + continuationOwner + scope(+port/group)）
  机器红测；缺 fullInput 或 owner 不匹配 fail-fast。
- 风险：把 control 字段混入 provider/client body。
  规避：plane-isolation gate + 新 slice gate 的 body 泄漏负类。
- 风险：workspace gate 仍不统一（config/control/error/runtime 未入
  cargo test --workspace）。规避：本 slice 继续走 test-consumer 验证矩阵；
  workspace 统一属独立 freeze 设计项，不在本 slice 内擅自改 active-link。
- 风险：旧 DSH PASS 失效。规避：实现 + 全量验证后统一重审。

## 6. 测试计划

1. 白盒：continuation save/restore 生命周期（normal、non-terminal、
   already-terminal、scope mismatch、owner mismatch、fullInput missing）。
2. 红测（先红）：不可变区语义转换、direct→relay 串续、chat/messages 命中
   responses continuation、仅 session 续接、控制字段进 body。
3. 黑盒：relay request/response/error/streaming/lifecycle/audit 六面样本；
  直接沿用 Responses Direct slice 的模板与样本构造（不带 reasoning 回传的
    continuation miss 是测试构造错误）。
4. 构建/门禁：cargo test --workspace、test-consumer（runtime/config/control/
   error）、verify:v4-foundation（10 gates）、verify:v4-foundation-red
   （3 gates）、appsdk verify --admission v4。
5. DSH review：实现 + 验证绿后 `dsh_review_start` 只读 review，
   语义 PASS 后交付。

## 7. 实施步骤（顺序）

1. 落 compat slice 六面条目（基于 V3 mainline/function map，只读 V3）。
2. 写 `verify-v4-relay-continuation.mjs` 与红测（先红后绿）；接入
   verification-map / package.json / CI。
3. 实现 Rust：scope.session 三键恢复 + payload_cycle + relay operator +
   continuation save/restore（逐红测转绿）。
4. 资源状态升级 anchored（本 slice 子集），双源一致。
5. 全量验证矩阵跑绿。
6. DSH review PASS；更新 plan ledger / note / MEMORY。

## 8. DoD

- `v4_relay_continuation_compat` 六面 unexplained_diff=0；
- 不可变区 + 隔离红测全绿（先红证据在案）；
- 本 slice 资源 anchored 且双源一致，其余保持显式 design；
- verify:v4-foundation 10/10、verify:v4-foundation-red 3/3、cargo workspace、
  test-consumer、appsdk admission 全绿；
- DSH review 语义 PASS（无 P0/P1、无“修复后再审”）。

## 9. 执行偏差记录（2026-08-15）

- §2 In scope 原把 ScopeRegistry / PayloadCycleRegistry 划给
  `routecodex-v4-control`；control 已 freeze 至 active-v2，源码修改需完整
  re-freeze 生命周期（本 slice 明确 out of scope，且 active-link 禁 frozen
  path dep）。实现按唯一 owner 证据落在 `routecodex-v4-runtime`
  （ScopeRegistry / PayloadCycleRegistry / ExecutionPlan / WireBuild /
  RawParse / FrameBuild 为顶层 anchor symbol），resource map 双源同步
  anchored（8 条本 slice 资源，含 route_exit 由 ExecutionPlan 产出控制事实）。
  其余设计原则不变。
