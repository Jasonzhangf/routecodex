# V4-Cordis 全局修复实施计划

## 1. 目标与验收标准

### 主目标

修复 `v4-cordis` 当前审计发现的协议回归、架构越界、主线/证据漂移和 V3 功能缺口，使 V4 的真实生产主线与 V3 语义对齐，并保证所有失败显式进入失败链路，不允许静默成功、静默丢帧、silent strip 或 fallback。

### 当前基线

- 审计分支：`v4-cordis`
- 审计基线：以开始执行时的实际 `HEAD` 为准，禁止把历史 evidence 的 commit 当作当前基线
- 已确认问题：
  1. `NodeExecutionInput` 增加必填 `information` 后，Cordis Host caller/test 未同步，`test:cordis-host` 为 32/37，通过 5 项失败。
  2. `verify-v4-infrastructure` 失败：runtime control digest 缺少明确 SHA-256 owner。
  3. foundation/feature-layer/CI gate 因过期 evidence、candidate/source hash drift、changed-path mismatch 失败。
  4. `verify-v4-node-container` 发现 NodeContainer 管理边界仍使用泛型 `serde_json::Value`。
  5. `verify-isolation` 发现 design mainline edges、未注册 owner/edge、active-index 缺失及 gate declared/executed 漂移。
  6. Responses relay/local continuation 被明确标记 unsupported，且存在在 request Chat Process/provider-wire 之后才检查 continuation 的路径。
  7. parity ledger 声明 active/pass/live/verified，但 evidence 绑定旧 commit，不能作为当前版本事实。

### 完成验收

以下条件必须全部满足：

- 所有受影响 Rust/Node caller 使用同一份已确认的执行 frame contract；Host 正向执行和所有反向失败测试全部通过。
- NodeContainer、Cordis bridge、runtime、provider、SSE、error chain 的 owner、边和资源关系与机器地图完全一致。
- 控制面、诊断面、业务 payload 物理隔离；任何越界输入在 owning boundary fail-fast，并进入明确错误链。
- V3 request、response、error、SSE、continuation、routing、provider compatibility、tool/servertool、config/manifest、observability、install/runtime 对齐项均有当前 HEAD 的正向/反向测试和 evidence。
- `verify:ci`、所有 required architecture gates、Rust/Node 定向测试、构建、全局安装、聚合重启、在线旧样本复测全部通过。
- parity ledger、function map、resource map、mainline call map、verification map、wiki/manifest 与真实代码和当前 artifact 同步。
- 修复后不允许保留被确认无用的旧分支、重复 owner、补偿路径或注释掉的错误实现。

## 2. 范围与边界

### In Scope

- `v4/crates/routecodex-v4-cordis-bridge`
- `v4/crates/routecodex-v4-node-container`
- `v4/cordis/routecodex-v4-cordis-host`
- `v4/crates/routecodex-v4-runtime`
- `v4/crates/routecodex-v4-runtime-bin`
- `v4/crates/routecodex-v4-provider`
- `v4/crates/routecodex-v4-standard-plugins`
- `v4/crates/routecodex-v4-error`
- `v4/crates/routecodex-v4-server`
- `v4/scripts/architecture`、`v4/scripts/verify*`
- V4 contracts/maps、verification map、feature-layer manifest、parity ledger、当前 goal/wiki 文档
- 与上述实现直接绑定的测试、fixture、当前 HEAD evidence

### Out of Scope

- 不改 V3 历史语义或历史对话/continuation 数据。
- 不通过改 V3、换 provider、换路由、关闭 thinking、裁剪 payload、fallback 或输出层补偿来“制造对齐”。
- 不删除用户未授权的 dirty 文件、runtime 产物、protected history 或其它 worker 的协作状态。
- 不执行全局 kill、权限清除、TCC 重置、宽范围 reset/restore/checkout。
- 不在本任务中新增与当前问题无关的抽象层、Manager/Factory/Adapter/Strategy 或新协议。

## 3. 设计原则与唯一 owner

### 固定主线

```text
ServerReqInbound
 -> HubReqInbound
 -> ReqChatProcess
 -> ReqExecution/Target
 -> ReqOutbound
 -> ProviderCompat
 -> ProviderWire/Transport
 -> ProviderRawResponse
 -> ProviderCompat
 -> RespInbound
 -> RespChatProcess
 -> ContinuationSave
 -> RespOutbound
 -> ServerClientFrame
```

### Owner 约束

- `req_inbound`：只负责入口协议解析和非破坏性归一化。
- `req_chatprocess`：唯一负责请求治理、工具治理和 continuation restore。
- `virtual_router`：只负责 route facts/target selection，不修 payload。
- `req_outbound`/Provider runtime：唯一负责 provider semantic 到 provider wire 的编码；不读取 raw body 重建控制语义。
- `resp_inbound`：唯一负责 provider raw parse。
- `resp_chatprocess`：唯一负责响应治理、工具收割和 continuation save。
- `resp_outbound`/SSE/server：只做协议等价投影和传输，不恢复 history、不补工具、不猜 required_action。
- `routecodex-v4-error`：唯一错误链实现；所有错误必须经过 Error01→Error02→Error03→Error04→Error05→Error06。
- `routecodex-v4-node-container`：只拥有 immutable plan binding、epoch/lifecycle、execution lease，不拥有 Cordis Context/Fiber/Effect，不扫描插件目录，不选择插件顺序。
- Cordis Host：只拥有 Cordis fibers/context/effect 生命周期及 typed bridge transport，不重建 V3 治理语义。
- compiled manifest/active artifact：唯一 runtime 能力输入；authoring directory 不得被 runtime 宽松扫描。

## 4. 技术方案与文件清单

### A. 修复执行 frame 协议回归

目标：统一 `data`、`control`、`information`、`diagnostics` 的跨 JS/Rust contract，避免协议缺字段被错误投影成错误类型。

检查并按实际 owner 修改：

- `v4/crates/routecodex-v4-cordis-bridge/src/lib.rs`
- `v4/crates/routecodex-v4-node-container/src/bin/host_binding.rs`
- `v4/cordis/routecodex-v4-cordis-host/src/index.mjs`
- `v4/cordis/routecodex-v4-cordis-host/tests/host-binding.test.mjs`
- bridge/node-container/runtime 相关 L2 tests

要求：

- 先锁定一个 canonical `NodeExecutionInput/Output` schema；所有 caller 显式提供 information carrier。
- 如果字段必须存在，caller、fixture、测试和文档同一 change set 同步；如果字段可省略，必须由 owning parser 明确规定等价的空 information carrier，不能在协议层隐式吞掉缺失。
- lifecycle decode failure 与 execution failure 继续保持 typed、互不混淆。
- 先构造当前 5 个失败样本作为 red；修复后逐个恢复为预期 failure code/positive output。

### B. 修复 NodeContainer 管理边界

目标：NodeContainer 不承载泛型控制语义或 Cordis runtime。

检查并按 map owner 修改：

- `v4/crates/routecodex-v4-node-container/src/lib.rs`
- `v4/crates/routecodex-v4-node-container/src/bin/host_binding.rs`
- `v4/crates/routecodex-v4-cordis-bridge/src/lib.rs`
- `v4/scripts/architecture/verify-v4-node-container.mjs`

要求：

- `policies: Value` 等泛型管理面字段必须改为实际声明的 typed contract，或在确认其不属于 NodeContainer owner 后移出该边界。
- 不能把泛型 JSON 换一个名字继续保留；不能把 control/payload 重新合并为 metadata。
- Cordis Context/Fiber/Effect 仍只能在 Host；Rust NodeContainer 只消费 compiled plan 与 typed lifecycle/execution messages。
- 为边界增加正向和反向测试：合法 typed candidate 可发布；generic policy、未声明字段、错误 owner、非法资源访问全部 fail-fast。

### C. 修复 continuation 生命周期和 V3 parity

目标：恢复 V3 已有能力，或在确实不支持时让 ledger 明确标为 gap，禁止“文档 pass、代码 unsupported”。

检查并按 owner 修改：

- `v4/crates/routecodex-v4-runtime/src/lib.rs`
- `v4/crates/routecodex-v4-runtime-bin/src/main.rs`
- `v4/crates/routecodex-v4-standard-plugins/src/*continuation*`
- Responses continuation、scope、SSE、tool continuation tests
- `v4/docs/architecture/v3-v4-product-parity-ledger.yml`
- `v4/docs/architecture/v4-v3-feature-mapping.yml`

要求：

- restore 只能在 request Chat Process 入口；save 只能在 response Chat Process 出口。
- immutable interval 内的 resp_outbound、SSE、handler、adapter、store transport 不得恢复/修补/重排 history/tool/context。
- continuation key 必须同时包含 entry protocol、continuation owner、port/group、session scope、conversation scope。
- 普通 chat/messages 入口命中 Responses continuation 必须显式拒绝。
- 不得在已完成 provider request 后才判断 continuation 是否支持；所有 owner/protocol/scope admission 必须前置。
- 如果 V4 确实暂不支持某能力，必须删除伪装 active 的实现路径并在 parity ledger 明确 gap，不得保留“intentional_differences: []”的错误声明。

### D. 修复错误链和失败投影

目标：任何 provider/runtime/direct/executor/plugin/SSE 错误都显式进入统一错误链，不成功化、不静默丢失。

检查：

- `v4/crates/routecodex-v4-error/src/lib.rs`
- `v4/crates/routecodex-v4-runtime/src/lib.rs`
- `v4/crates/routecodex-v4-runtime-bin/src/main.rs`
- provider transport、SSE processor、Cordis Host decoder

要求：

- 明确验证 Error01→06 每一跳都有 typed fact/decision；禁止 message-only projection。
- client disconnect 保持 health-neutral；provider error 继续按 V3 policy 进入 reroute/cooldown/terminal decision。
- SSE EOF、malformed frame、provider failed event、client write failure、plugin failure 都必须有可观测错误结果。
- 禁止 `Ok(Vec::new())`、空成功响应、吞掉 `Result`、错误转 `completed`。
- 失败测试必须成对覆盖 success/failure、non-terminal/terminal、already-terminal/duplicate failure。

### E. 修复 digest、active artifact、地图和 gate

目标：机器地图、源码、运行 artifact、evidence 只允许一个当前事实。

检查：

- `v4/scripts/architecture/verify-v4-infrastructure.mjs`
- `v4/crates/routecodex-v4-config`
- `v4/crates/routecodex-v4-build-link`
- `v4/build-control`
- `v4/.appsdk/maps/*`（机器真源）
- `v4/docs/architecture/maps/*`（架构地图副本，需与机器真源一致）
- `v4/.appsdk/maps/*`
- `v4/contracts/feature-completion-layer-batches.manifest.json`
- `v4/docs/architecture/v3-v4-product-parity-ledger.yml`
- 对应 evidence、review records、wiki/manifest

要求：

- digest 计算必须有唯一 owner，输入不能包含业务 payload 内容，且 active binary、consumer package version、compiled manifest、artifact index 绑定同一身份。
- 修复 `active-index.json` 缺失和 build-link 绕过；runtime 只能加载 deterministic compiled manifest。
- 所有 function/resource/module/mainline/verification entries 必须绑定真实存在的 symbol/path；design/pending 不得参与 active claim。
- 修复 gate declared/executed drift，确保 `verify:ci` 真正执行 verification-map 要求的 gate。
- 基于修复后的当前 HEAD 重新生成 evidence；每份 evidence 必须含 source commit、输入 hash、changed paths、时间窗口和实际 command result。

### F. 更新 V3/V4 parity 和运行验证面

建立 feature→owner→required gates 的完整矩阵，至少覆盖：

- request normalization / request Chat Process / provider wire
- response raw parse / response Chat Process / client projection
- Error01-06
- SSE ingress/processor/egress/keepalive/EOF/error
- direct/relay routing and target binding
- remote/direct continuation and local relay continuation
- tool/servertool multi-turn semantics
- config compiler / model aliases / provider wire model
- active artifact / install / managed restart / health
- diagnostic isolation and control/data plane boundary

每项都必须同时有：

- positive test
- negative/red test
- boundary/isolation test
- current HEAD evidence
- required gate id
- mainline/resource/function binding

## 5. 风险与规避

### 高风险

- 重新引入 TS/Host 业务治理，造成 V3/V4 双 owner。规避：所有治理语义只改 Rust owner，Host 只传 typed bridge。
- 用字段默认值或 fallback 修复 `information` 缺失。规避：先锁 contract，再让所有 caller 显式满足 contract；不能静默补偿。
- 为了让 parity gate 通过而刷新旧 evidence，不修源码。规避：evidence 必须绑定当前 HEAD 和真实运行结果。
- 在 resp_outbound/SSE 层修 continuation、tool 或 response shape。规避：回到 req/resp Chat Process owner。
- 改动覆盖用户 dirty 文件或其它 worker claim。规避：先刷新 `.agent-collab`，使用独立 owner worktree，按 semantic claim 协作。

### 中风险

- NodeContainer typed contract 修改影响多个 Rust/Node caller。规避：先 red test，再一次性更新 canonical schema 的全部消费端。
- gate 之间存在旧 evidence/hash 级联。规避：先修源码和 map，再按 dependency order 重新生成 evidence，不手工改 hash。
- 当前生产入口尚未完成全局安装和在线复测。规避：源码/单测只算内部证据，最终必须使用全局安装版本、`routecodex restart` 和在线旧样本。

## 6. 测试与验证矩阵

### 代码级

- `cargo fmt --check`
- 受影响 crate 的 `cargo test --locked --offline`
- `npm --prefix v4 run test:cordis-host`
- Cordis bridge、NodeContainer、runtime、provider、standard plugins、SSE、error chain 的定向 L2 tests

### 架构级

- `npm --prefix v4 run verify:v4-active-link`
- `npm --prefix v4 run verify:v4-node-graph`
- `npm --prefix v4 run verify:v4-direct-relay-sse`
- `npm --prefix v4 run verify:v4-infrastructure`
- `npm --prefix v4 run verify:v4-feature-layer-batches`
- `npm --prefix v4 run verify:v4-cordis-concurrency-reconciliation`
- `npm --prefix v4 run verify:v4-foundation`
- `npm --prefix v4 run verify:isolation`
- `npm --prefix v4 run verify:ci`
- 所有 verification-map required red/self-test

### 真实运行级

- 通过 V4 build/link 产出 deterministic artifact。
- 完成 V4 全局安装并验证 installed hash、consumer package version、manifest digest。
- 按项目规则使用全局 `routecodex restart`，不使用 stop/start 组合，不逐端口循环重启。
- 验证配置中的全部 listener `/health`。
- 用同一用户入口复测：正常 Responses、Chat、SSE、tool continuation、provider error、malformed SSE、client disconnect、scope mismatch、plan drift。
- 检查运行版本与当前修复 HEAD/artifact 完全一致。

### 审计级

- 实现后先做 module/resource/function/mainline 越界自检。
- 对每个 P0/P1 形成“来源→首次偏离→唯一 owner→修复→正向证据→反向证据”。
- 主 tree 验证、安装、重启、在线旧样本全部通过后，才运行 AGY Review。
- AGY Review FAIL 必须新建 review 并修复，不能用 DSH/Codex 绕过。

## 7. 实施步骤

1. 创建本轮独立 run，刷新 `.agent-collab` runs/claims/handoff/merge-queue/KILL_SWITCH；读取 dirty 状态和当前 HEAD。
2. 读取 resource map、function map、mainline call map、module registry、verification map，列出每个受影响节点的 owner、allowed/forbidden paths 和相邻边。
3. 固化执行 frame 回归、continuation late-check、NodeContainer generic policy、digest/map drift 的最小 failing samples；确认 red。
4. 在独立 owner worktree 只修 canonical execution contract 与其全部 caller/test。
5. 修 NodeContainer/Cordis bridge 边界，增加 typed positive/negative tests。
6. 修 continuation admission/save/restore 唯一 owner；删除确认死掉的 late-check/重复路径。
7. 核对 error chain、SSE 和 provider error path，删除静默吞错或输出层补偿。
8. 修 digest/active artifact/build-link 和机器地图/gate 接线。
9. 根据当前 HEAD 重新建立 parity evidence 和 feature-layer evidence；不修改为“假通过”。
10. 在 owner worktree 运行定向测试、架构 gates、构建和 red suites；失败时回唯一 owner 修复。
11. 精确写入 evidence/handoff/merge queue；只合并本问题 change set 到主 tree。
12. 在主 tree 重新执行受影响验证、全局安装、聚合 `routecodex restart`、全部 `/health` 和在线旧样本复测。
13. 验证运行 artifact 与修复 HEAD 一致后运行 AGY Review；FAIL 则回到步骤 4，PASS 才允许定向 commit/push。
14. push 后证明远端 commit 与主 tree HEAD 一致，确认 worktree clean、分支无未合并唯一提交，再释放 claim 和清理已合并 worktree。

## 8. 完成定义（DoD）

- [ ] 当前 HEAD 的 `test:cordis-host` 全部通过，5 个已知失败均有正向/反向证据。
- [ ] `verify-v4-node-container`、`verify-v4-infrastructure`、`verify:v4-foundation`、`verify:ci` 全部通过。
- [ ] `verify-isolation` 无未注册 owner/edge、无 design edge 被 active 宣称、无 active-index 缺失、无 gate declared/executed drift。
- [ ] V4 parity ledger 的每条 active/pass/live/verified 均由当前 HEAD evidence 支撑；未实现能力显式标 gap，不能伪装 parity。
- [ ] V3 request/response/error/SSE/continuation/routing/provider/tool/config/install 功能逐项对齐并完成真实入口验证。
- [ ] 控制面、业务 payload、诊断面物理隔离；无 metadata 泄漏、payload reconstruction、silent strip、fallback 或重复 owner。
- [ ] 全局安装版本、重启后的运行版本、在线旧样本和修复 artifact 完全一致。
- [ ] 主 tree 验证通过，AGY Review controller 为 PASS。
- [ ] evidence.jsonl、handoff/merge-queue、项目 `note.md`/`MEMORY.md` 已记录确证结论；无未授权 dirty 文件被覆盖。
