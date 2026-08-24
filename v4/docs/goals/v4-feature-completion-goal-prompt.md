# 当前可执行短提示词

```text
/goal
目标：以当前 V4 worktree 基准 tree `7557b8825ac829a436193ddf865568c9091eda5b`（及其后继）为基线，一次性完成 V4 当前生产执行层全部独立组件，全部 source-green 后再由单一 integration owner 接线，关闭 M1 + M2 P0 的生产 NodeContainer 断点。

说明：本任务不需要再写新的提示词，直接按实现文档第 28 章执行。

实现文档：
v4/docs/goals/v4-feature-completion-plan.md#28-runtime-007-后的分层批量开发与接线计划

执行规范：
- 基线必须从当前 V4 worktree 的 HEAD 解析，并以当前基准 tree 的可达 commit/tree hash 固定；后继 tree 只允许在 baseline drift audit 后登记。缺对象只同步，禁止重做 `V4-RUNTIME-007`。同步后先重放 R007 证据，并完成 `V4-RUNTIME-002` closure audit：证明同一 epoch owner 已覆盖其合同；有缺口则登记 epoch-owner lane 并纳入 source-green barrier，只补确证缺口。
- 先锁 P0 plugin ABI/immutable IDs 与 typed interfaces/owner，完成 `RUNTIME-003A/004A`、`PLUGIN-001..008`、`RUNTIME-005A/006A`、parity/harness/gates 全部独立红绿验证；同层未全绿禁止 production wiring。
- 接线只由一个 integration owner 完成 `003B/004B/005B/006B`，并显式分开 request、success response、Error Skeleton、client-drop terminal；禁止 fallback、重复 owner、V3 修改及控制面进入 payload。
- 不做逐 lane 交付 review；clean worktree 全绿后把 exact candidate 合入主 tree，完成 build/install/live/differential，再进入一个 batch-scoped DSH review loop。Review 不阻止无依赖独立开发或主树验证；FAIL 只回唯一 owner 修复并复验复审，未 PASS 禁止 final commit/push/promotion/freeze/完成声明。

验证：
- 定向正反测试、layer/production-path gates、R007 epoch 并发回归、V4 verify:ci 与 AppSDK admission。
- 仅安装 `rccv4` canary；验证 Responses/Chat JSON/SSE、并发 publish/drain/restart、错误/断线和 12 类差分 fixture。

完成标准：
- 同层独立任务 100% source-green 后才接线；production NodeContainer coverage=100%，`runtime-bin` direct business helper=0，mock/fallback production path=0，unexplained_diff=0；不得误删合法 Direct 同协议路径或尚未到 Layer 4 替换的唯一 canary transport。
- exact integration candidate 完成主树 live 证据、DSH PASS、定向 commit/push 及 clean-main 复验；不触达 V3。
```

## 历史展开版提示词（封存，不可执行）

以下长版只保留为历史范围说明，禁止作为 `/goal`、执行合同或状态真源；当前唯一可执行合同是上述短提示词和总计划第 28 章。

ARCHIVED_GOAL_DO_NOT_EXECUTE

目标：按照 `v4/docs/goals/v4-feature-completion-plan.md` 完成 RouteCodex V4 的全部产品功能闭环，使 V4 在保留新架构的前提下对齐当前选定的 V3 冻结行为基线，并达到可灰度接管、可发布、可回滚的生产准入状态。

历史审计基线：`main@2fda3f049190620511f2d2c6069a7bec0dd2871f`（仅作封存记录，不是当前执行基线）。执行基线必须从当前 V4 worktree 的 HEAD 与 tree hash 解析；若 HEAD/tree 已变化，先完成 V4 baseline drift 审计并登记差异，再继续执行。

本 goal 是长线分阶段目标，不是单个 slice，也不是要求一次提交完成。每个 milestone、每个任务必须独立计划、独立红测、独立实现、独立验证、独立 review、独立提交。前一 milestone 的硬退出条件未通过，不进入依赖它的后续 milestone。M3 fixture 提取可与 M1/M2 部分并行，但只有 production NodeContainer 路径接通后的 V4 差分结果才能作为产品完成证据。

## 一、必须读取的真源

开始前依次读取：

1. `v4/docs/goals/v4-feature-completion-plan.md`
2. `v4/docs/architecture/v4-cordis-node-plugin-architecture.md`
3. `v4/docs/architecture/v4-standard-nodes-and-node-graph.md`
4. `v4/docs/architecture/v4-data-control-plane-boundary.md`
5. `v4/docs/architecture/v3-v4-semantic-parity-map.yml`
6. `v4/docs/architecture/v4-resource-operation-map.yml`
7. `v4/contracts/node-graph.contract.json`
8. `v4/contracts/skeleton-plan.contract.json`
9. `v4/contracts/node-plugin.contract.json`
10. `v4/contracts/node-container.contract.json`
11. `v4/contracts/pipeline-abstraction.contract.json`
12. `v4/contracts/v3-baseline/manifest.json`
13. `v4/docs/goals/v4-real-runtime-admission-plan.md`
14. `v4/docs/goals/v4-relay-continuation-slice-plan.md`
15. `v4/docs/goals/v4-long-horizon-goal-prompt.md`，只作为历史目标参考
16. 当前 V4 Rust/Node/Cordis source、Cargo/package scripts、Active index、AppSDK maps 和 CI
17. V3 冻结 baseline artifacts；只有 baseline supersession 专项可以读取明确选定的 live V3 commit

真源冲突规则：

- 产品范围、完成定义和里程碑依赖以 `v4-feature-completion-plan.md` 为准；
- 节点内部组合以 Cordis NodePlugin architecture 为准；
- 跨节点拓扑以 node-graph/skeleton contract 为准；
- data/control/information/diagnostic 边界以 boundary contract 为准；
- 已冻结 crate 的公共合同不能被计划文档直接覆盖；
- 发现冲突时先写 `plan-deviation.md`，列出冲突、owner、影响和最小安全决策，不得静默选择一个实现继续。

## 二、最终完成条件

只有以下全部成立才完成本 goal：

```text
product_parity.features.completed == selected_v3_baseline.features.total
product_parity.unexplained_diff == 0
production_entrypoints.nodecontainer_coverage == 100%
runtime_bin.direct_business_helper_paths == 0
mock_or_canary_fallback_paths == 0
live_required_features.live_pass == 100%
active_artifacts.reproducible == true
release.rollback_verified == true
performance_budget.pass == true
canary.pass == true
dsh_review.p0 == 0
dsh_review.p1 == 0
```

`mapped`、`contracted`、`implemented`、`pluginized` 或 `production_integrated` 均不能单独计入产品完成；至少必须达到 `differential_pass`。需要真实 provider、并发、流、生命周期验证的 feature 必须达到 `live_pass`。

不得自动执行：

- 停止或替换 V3；
- 覆盖 `routecodex`、`rcc`、`rccv3` 默认生产命令；
- 迁移真实用户配置或 secret；
- 把 V4 设为默认路由；
- 删除 V3；
- 生产灰度或正式切流。

这些动作必须由 Jason 单独授权。

## 三、全局架构硬护栏

### A. 唯一生产执行路径

所有生产 request/response/error 必须经过：

```text
HTTP Admission
  -> immutable ExecutionBinding
  -> SkeletonRuntime
  -> adjacent NodeContainer
  -> immutable NodePluginPlan
  -> typed plugin/service handles
```

禁止保留或新增：

```text
new path fails -> old helper succeeds
plugin fails -> second semantic implementation succeeds
unknown protocol -> payload shape guess
provider failure -> handler/SSE/outbound cleanup compensation
```

### B. `runtime-bin` 只做 bootstrap 和 wiring

最终 `runtime-bin` 只能拥有：

- CLI dispatch；
- Config/Manifest 加载；
- lifecycle；
- listener/bootstrap；
- ActiveExecutionEpoch 装载；
- HTTP admission 到 typed entry；
- typed terminal 到 server projection。

不得直接拥有或调用产品业务：

```rust
project_chat_request_to_responses(...)
select_target(...)
send_responses(...)
send_responses_streaming(...)
parse_responses_provider_payload(...)
```

以及任何后续新增的协议、provider、route、continuation、tool、SSE 业务 helper。

### C. 单请求不可变执行绑定

请求进入时绑定：

```text
skeleton_version
manifest_hash
plan_epoch
execution_plan_hash
plugin_artifact_set_hash
```

从 entry 到 success/error/client-drop terminal 不变。节点间不得重新读取 active pointer、重新排序、重新选择插件版本或改变 selection group。

### D. Rust/Cordis 唯一职责

- Cordis Host 是 Context/Fiber/Effect、插件 mount/dispose、依赖和 plan 编译 owner；
- Rust 是业务语义和热路径 owner；
- Skeleton/Runtime 是跨节点 orchestrator；
- NodeContainer 是节点内 plan/in-flight/drain owner；
- 不得出现 Cordis-like Rust 第二容器或 JS 第二业务 runtime；
- 默认每个 NodeContainer 一次 native dispatch，不是每插件一次跨语言往返。

### E. typed capability

插件不得获得通用全局 Context 或任意 JSON metadata。只能获得 plan 编译允许的：

```text
DataRead<Input>
DataWrite<Output>
ControlCapability<AllowedFacts>
InformationView<AllowedResources>
DiagnosticPublisher
ErrorIntake
```

资源和 effect 越权必须有独立 typed error code，不得合并成通用错误。

### F. 数据、控制、信息、诊断、错误隔离

以下内容不能进入正常 provider/client payload：

```text
route
target
health
retry/reroute
continuation
scope
stopless
secret
debug/snapshot
manifest/plan hash
request identity
```

payload 也不能重建这些事实。不得通过“发送前删除字段”伪装隔离；泄漏必须在 owner boundary fail-fast。

### G. V3 隔离

普通 V4 build/test/verify 只能读取 reviewed frozen V3 baseline。禁止：

- live V3 source path dependency；
- V4 runtime 调用 V3；
- V4 启停 V3；
- V4 修改 V3 config/artifact/log/state；
- CI 为了更新 baseline 自动读取 V3 HEAD。

baseline supersession 必须是独立、显式、可 review 的任务。

### H. 冻结资产

若 base-node、edge、control、error、config 等 active artifact 公共合同需要扩展：

1. 先证明现有窄接口无法表达；
2. 写 plan deviation；
3. 获得 Jason 对 re-freeze 范围的明确批准；
4. 按 AppSDK begin-version/evidence/review/promotion/regression/compile/publish 流程；
5. 不直接改 protected/active source 伪装完成。

### I. 先红后绿

每个不变量：

1. 先写 red fixture；
2. 实际运行并证明红；
3. 修改唯一真源；
4. 原 fixture 转绿；
5. 再跑旧样本和同入口回归。

禁止写一个在旧实现上已经通过的“红测”。

## 四、工作方式

### 1. 分支和 worktree

- 每个任务使用独立 branch/worktree；
- branch 从干净、最新 main 创建；
- 不把 V3 dirty worktree 裹入提交；
- 不在一个任务中混入不相关 milestone；
- commit 显式列出路径；
- merge 后从 clean main 复验。

建议命名：

```text
codex/v4-m0-parity-ledger-<date>
codex/v4-m1-active-execution-epoch-<date>
codex/v4-m2-responses-plugin-slice-<date>
...
```

### 2. 修改方式

- 逐文件读取上下文；
- 使用最小 hunk；
- 禁止用 Python/Node/Perl/sed/awk/shell loop 做批量语义替换；
- formatter 和 canonical generator 只能生成其声明的机械产物；
- 不手工编辑 generator-owned hash/index；
- 不为通过测试复制第二份真源。

### 3. 任务证据

每个任务写：

```text
v4/docs/evidence/feature-completion/<milestone>/<task-id>/
  plan-deviation.md
  red-evidence.json
  positive-evidence.json
  differential-report.json
  live-report.json              # 需要时
  performance-report.json       # 需要时
  artifact-record.json
  review-record.md
  verification-summary.md
```

证据必须记录：

```text
source commit
binary hash
manifest hash
plan epoch/hash
plugin artifact set hash
commands
exit status
fixture ids
unexplained diffs
known intentional differences
```

不得提交 secret、token 或未经授权的完整敏感 payload。

### 4. 状态更新

每个 feature 状态只能逐级提升：

```text
mapped
contracted
implemented
pluginized
production_integrated
differential_pass
live_pass
frozen
```

状态提升必须引用 evidence。发现回归时允许机器降级状态，不得只更新说明维持绿色。

## 五、Milestone 执行顺序

# M0：产品真值与 baseline supersession

目标：建立产品级 parity ledger，让完成率来自机器证据，而不是 semantic map。

必须完成：

1. 新增 `v3-v4-product-parity-ledger.yml`；
2. 新增 schema 和正反验证；
3. 登记 frozen baseline 的全部 feature；
4. 引用 103 resource baseline，不复制第二份资源真源；
5. 实现 `mapped` 不计完成率；
6. 实现证据驱动状态提升；
7. 实现独立 V3 delta/supersession；
8. 把当前 V3 与 frozen baseline 的已知差异列入报告，至少包括：
   - cooldown recovery 必须经过 probe；
   - dynamic provider probe backoff；
   - provider/model/auth/session health scope；
   - SSE EOF/post-commit errors；
   - tool schema 保真；
   - empty assistant content/tool calls；
   - Responses input text parts；
9. 统一历史文档状态语义。

M0 红测：

- 少一个 feature；
-重复 feature；
-非法状态；
-跳级提升；
-无 fixture 标 differential_pass；
-无 live evidence 标 live_pass；
-无 artifact 标 frozen；
- baseline digest 漂移；
-同步删除 feature/map/coverage 伪造闭环；
- canonical verify 读取 live V3。

M0 退出：

- ledger 64/64；
-完成率机器生成；
- baseline delta 可重复；
- verify:ci、AppSDK admission、DSH review PASS。

# M1：生产 NodeContainer 执行平面

目标：真实 `rccv4` 所有当前 endpoint 经过新架构。

按顺序：

1. `ExecutionBinding` typed contract；
2. `ActiveExecutionEpoch`；
3. `NodeContainerRegistry`；
4. Config 输出 exact NodePluginPlan；
5. real Cordis graph/Fiber mount；
6. graph/manifest/loaded/plan/artifact hashes 绑定；
7. request admission 固定 epoch；
8. request-local ExecutionContext；
9. request chain 接入；
10. response chain 接入；
11. error intake/decision 接入；
12. JSON terminal；
13. SSE terminal；
14. in-flight/drain/dispose；
15. epoch 并发与被动 failure 记录；
16. restart identity / manifest digest stability；
17. production path gate；
18. 删除 direct helper fallback；
19. 移除全局串行 runtime mutex。

M1 必须证明：

```text
/v1/responses JSON -> production NodeContainer path
/v1/responses SSE -> production NodeContainer path
/v1/chat/completions JSON -> production NodeContainer path
/v1/chat/completions SSE -> production NodeContainer path
```

诊断必须包含 visited nodes/plugins，但不得进入正常响应。

M1 红测：

- plan hash drift；
- active pointer 中途改变；
- publish 影响在途请求；
- drain in-flight 非零；
- lifecycle success 携带业务 output；
- runtime-bin 直接协议/route/provider/response helper；
- plugin cross-node dispatcher；
-旧 helper fallback；
- candidate 失败污染 active；
- published failure 自动 rollback。

M1 退出：

- production NodeContainer coverage 100%；
- direct business helper path 0；
-并发不由全局 mutex 串行；
-完整验证与 review PASS。

# M2：真实插件迁移和 Runtime 拆解

目标：NodePlugin 不再是 descriptor/keyless 示例，而是生产语义 owner。

第一批必须迁移：

1. Responses parse/normalize/input validate；
2. Chat→Responses semantic projection；
3. request governance/basic tool governance；
4. provider-neutral semantic projection；
5. Responses wire codec；
6. provider raw JSON/SSE decode；
7. response governance/tool harvest；
8. client semantic/frame projection；
9. terminal validate；
10. typed fault intake。

模块按稳定业务域拆分，不按每个微插件建 crate。`routecodex-v4-standard-plugins` 作为 bundle/catalog，不成为全部业务代码 monolith。

必须补齐：

```text
plugin_abi_version
descriptor_hash
contract_schema_hash
artifact_hash
capability_set_hash
selection_group
failure_mode
upgrade compatibility
required fixture ids
```

M2 红测：

- unregistered handle；
- keyless/mock handle 进入 production；
- tie/cycle/missing dependency/version conflict；
- selection group 0 或 >1 active；
- wrong node/role/position；
- resource read/write 越权；
- effect 越权；
- diagnostic 写 data/control；
- control 写 normal payload；
- provider/model/payload 猜测 selection；
-一个实现失败后尝试同组另一个。

M2 退出：

- Runtime 仅 orchestrate；
-每个真实 plugin 有 artifact/contract/fixture；
- production bundle 无 mock；
-每 NodeContainer 默认一次 native dispatch；
- M1 当前功能不回退。

# M3：产品差分 Harness

可以在 M0 后开始提取 fixture，但 V4 production 结果必须来自 M1 路径。

产物：

```text
routecodex-v4-parity-harness
v4/tests/parity-corpus
parity-normalization.contract.json
verify-v4-product-differential.mjs
```

第一批 fixture：

1. Responses JSON；
2. Responses SSE；
3. Chat JSON；
4. Chat SSE；
5. provider 400；
6. provider 401；
7. provider 429/retry-after；
8. provider 500；
9. malformed SSE；
10. EOF before terminal；
11. EOF after partial client commit；
12. client disconnect；
13. route unavailable；
14. tool call/result；
15. continuation second turn。

比较：

```text
client JSON
SSE event sequence/terminal
provider semantic/wire
route facts/plan
selected provider/model/auth
health/action
continuation binding
tool identity/schema
Error01-06
session admission
diagnostic/lifecycle side effects
copy/serialize/native-dispatch counters
```

归一化必须由合同逐字段定义。禁止忽略整个 object、排序 event、丢 tool/reasoning/continuation 或只比较 HTTP status。

M3 退出：

-报告可作为 CI artifact；
- `unexplained_diff=0` 才提升状态；
- intentional difference 有 owner/理由/批准；
- normalization 红测 PASS。

# M4：生产 Transport、协议和 Provider

先实现 Rust async transport，后迁协议：

1. Responses Direct；
2. OpenAI Chat Relay；
3. Anthropic Messages Relay；
4. Gemini Relay；
5. provider-side OpenAI Chat；
6. baseline 复核确认需要时实现 Responses inbound WebSocket。

Transport 必须支持：

```text
HTTP/TLS
connection pool
keepalive
DNS/proxy
deadlines
first byte/frame timeout
streaming
backpressure
cancel
client drop propagation
size limits
retry-after
raw failure evidence budget
secret redaction
```

新 transport 通过后删除 `curl` canary，不保留 fallback。

协议每个必须覆盖：

```text
JSON
SSE
tool schema/calls/results
reasoning/thinking
images/multimodal
usage
finish reason
errors
continuation fields
unknown-field policy
```

Provider config 必须支持 multi-provider/model/auth-alias/key/capability/protocol/transport/health/error policy。

M4 退出：

-所有协议 characterization 差分；
-无 provider/model 猜测；
- selection group exactly-one；
-无 shell transport；
- secret 零泄漏；
-真实 provider success/failure/stream/drop 通过。

# M5：Router、Target、Health 和 Error Action

实现完整 typed route facts：

```text
server/route group
entry protocol/endpoint
client model
hard capabilities
soft signals
continuation owner
required provider protocol
tool/image/reasoning
session/conversation
token estimate
```

实现：

- route match/default；
- pool；
- priority tier；
-同 tier SWRR；
- deterministic candidate plan；
- opaque target；
- provider/model/auth exact binding；
- continuation pin；
- availability read；
- route exit。

Health scope 至少：

```text
provider
provider+auth
provider+model
provider+auth+model
provider+session
global subscription
```

Health 行为：

```text
consecutive failures
cooldown
quota
invalid subscription
retry-after
probe lease
single-flight probe
dynamic backoff
success recovery
restart reset
session/model isolation
rescue sampling
```

Error Action 唯一输出：

```text
retry_same_target
retry_next_auth
reroute_next_candidate
wait_probe
fail_client
```

Router 不写 health；Provider/Error owner 记录；Executor 唯一消费 action。

M5 退出：

-最新 reviewed V3 health 语义差分；
- priority/SWRR/capability/health/continuation 决策确定性；
-并发 probe/race；
-无 session/model/auth 污染；
-所有错误进入 Error01–06；
- retry/reroute 不修改 normal payload。

# M6：Continuation、Session Admission、SSE

Direct remote continuation：

- previous_response_id；
- provider/auth/model/route exact pin；
- remote binding；
- incompatible reroute 红；
- terminal unique commit；
- next request unique restore。

Relay/local continuation：

- history/materialization；
- entry protocol/owner/scope 锁；
- tool/reasoning state；
- immutable save→restore interval；
- fullInput missing fail-fast；
-跨协议/owner/session-only hit 红。

Session admission：

- overlap policy；
- lease；
- client drop/timeout/error/terminal release；
- conversation isolation；
-幂等 release；
-无全局 mutex。

SSE：

- first-frame；
- heartbeat；
- partial frame；
- malformed；
- duplicate/missing terminal；
- pre/post-commit EOF；
- upstream/downstream drop；
- backpressure；
- cancel；
- post-commit error；
- health-neutral client drop；
- terminal failure raw evidence。

M6 退出：

- Direct/Relay 多轮差分；
-所有 lease 释放路径；
-事件顺序/终态等价；
-无 SSE/handler continuation 补偿。

# M7：Tool、Servertool、Stopless、Web Search

Tool Governance：

- schema 保真；
- identity；
- duplicate；
- empty content；
- parallel；
- tool choice；
- result history；
-跨协议；
- reasoning/tool event 顺序；
- response harvest；
- invalid tool policy。

Servertool：

-真实 registry；
- typed schema；
- backend；
- timeout/cancel；
-状态机；
- hook；
- flow/session/request；
-结果投影；
-多轮；
- dry-run；
- ErrorChain；
- audit。

Stopless：

- current-turn typed state；
- terminal/tool/continuation pending；
- MetadataCenter lifecycle；
-无 payload 泄漏。

Web Search：

- backend binding；
- execution mode；
-状态机；
-超时/错误；
-多轮；
-复用 Tool Center。

M7 退出：

- Servertool 不再 echo/projection；
-多协议工具 fixture；
- duplicate/empty/schema 回归；
-产品语义 Rust-only；
- tool/stopless/web-search 多轮差分。

# M8：Diagnostics、Admin、WebUI、配置迁移、Release

Diagnostics 接入真实 production path，但只读：

```text
trace/raw/event/snapshot/dry-run/timing/count/budget/sse-dump/raw-error/console/retention
```

Admin：

```text
HTTP/BFF
authn/authz
actor/audit
idempotency
optimistic concurrency
candidate persistence
compile/validate/smoke
publish/drain/discard/rollback
RuntimeInspector
secret-safe DTO
```

WebUI：

-先只读；
-后 candidate 变更；
-不拥有排序、权限、业务语义、active pointer。

配置迁移：

- V3 import；
- semantic diff；
- V4 authoring；
- secret handle 引用；
- provider validation；
- dry-run；
- preview；
- rollback；
- unsupported 显式错误。

Release：

- macOS arm64/x64；
- Linux x64/arm64（若支持）；
- reproducible；
- hash/sign/SBOM；
- GitHub Release；
- install/upgrade/uninstall/rollback；
- ABI/Manifest/Active compatibility。

M8 退出：

- Admin 不影响在途 binding；
- actor/audit 完整；
- rollback 恢复旧 epoch；
- UI/hash 黑盒一致；
-正式可安装产物；
-诊断/control/secret 零 payload 泄漏。

# M9：性能、Canary、切换准备

测 V3/V4：

```text
throughput
p50/p95/p99
TTFT
SSE frame latency
memory/allocation
copy/serialize/native dispatch
pool reuse
long-stream concurrency
drop reclamation
restart/drain
publish/rollback
```

预算：

- 每 NodeContainer 一次 native dispatch；
-无 control/diagnostic payload copy；
- streaming 不整流；
-无全局 mutex；
- debug/snapshot 有预算；
-退化需批准。

Canary：

-独立 identity/port；
- V3 zero-call/zero-restart/zero-modify；
- shadow replay；
- route/target/wire/client diff；
- route-group 灰度；
-错误/限流/断线；
- restart/drain/rollback。

M9 退出：

-所有 selected baseline feature 至少 differential_pass；
- live-required 全部 live_pass；
- performance pass；
- canary pass；
- rollback pass；
-等待 Jason 的独立切换授权。

# M10：Freeze 和收口

-冻结全部 product crates；
- Active/source/contract/ABI/hash/index 对齐；
-删除 canary/mock/direct fallback/stale gate；
-统一 active 文档；
- operations/runbook；
- V3/V4 并行维护政策；
- retirement checklist；
-全量 DSH review。

不得自动停 V3 或切换默认命令。

## 六、每个任务的固定执行循环

对每个 task：

```text
A. Audit
  - read source/contracts/maps/tests
  - identify unique owner
  - identify frozen boundaries
  - identify dependencies
  - write plan-deviation

B. Red
  - add negative fixture
  - run it
  - save failing evidence

C. Implement
  - change unique source of truth
  - no fallback
  - no duplicate implementation
  - no V3 modification

D. Local Verify
  - crate L2
  - compile-fail/red
  - affected build-link consumer
  - affected architecture gate

E. Product Verify
  - production entrypoint
  - differential fixture
  - live/perf when required
  - payload/control leak scan

F. Global Verify
  - npm --prefix v4 run test
  - npm --prefix v4 run verify
  - npm --prefix v4 run verify:red
  - npm --prefix v4 run verify:ci
  - appsdk verify v4
  - appsdk verify --admission v4
  - Active gen/verify index

G. Review
  - DSH review
  - no P0/P1
  - no ambiguous/fix-then-review

H. Close
  - update ledger/evidence
  - commit exact paths
  - merge
  - clean-main rerun
```

若某命令因平台、凭据、真实 provider 或外部服务不可用，不能伪造成功。完成其余可验证部分，并在 `verification-summary.md` 精确记录未执行项、原因、所需输入和状态保持在哪一级。不得把未运行的 live test 标为 `live_pass`。

## 七、首个执行批次

开始时只执行以下 P0 批次，不先扩 Anthropic/Gemini/WebUI：

1. `V4-PARITY-001`
2. `V4-PARITY-002`
3. `V4-RUNTIME-001`
4. `V4-RUNTIME-002`
5. `V4-RUNTIME-003`
6. `V4-RUNTIME-004`
7. `V4-RUNTIME-005`
8. `V4-RUNTIME-006`
9. `V4-RUNTIME-007`
10. `V4-GATE-001`
11. `V4-PLUGIN-001`
12. `V4-PLUGIN-002`
13. `V4-PLUGIN-005`
14. `V4-PLUGIN-006`
15. `V4-PLUGIN-007`
16. `V4-PLUGIN-008`
17. 第一版 product differential harness

每个任务单独提交。完成后汇总 M0/M1/M2 第一切片状态，再进入 M4。

## 八、禁止的“完成”方式

以下一律不算完成：

- 只新增计划、合同、map 或 descriptor；
- 只通过 mock/keyless 测试；
- production binary 未实际执行插件；
- 通过删除 baseline feature 获得 100%；
- 通过大范围 ignore 获得 diff=0；
- provider 失败后走旧 runtime；
- streaming 先缓存完整响应再伪装 SSE；
- request handler 修补 continuation/tool/error；
- router 写 health；
- UI 直接改 active；
- secret 进入 manifest/log/snapshot；
-冻结 source 直接 path dependency；
-自动 rollback 掩盖发布失败；
-在一个大提交中混合多个 milestone；
-未运行 live/perf 就写 PASS。

## 九、每轮进度输出

每完成一个 task，输出：

```text
Task:
Baseline:
Owner:
Changed paths:
Red evidence:
Implementation:
Positive verification:
Differential/live/performance:
Architecture gates:
AppSDK/Active:
Review:
Ledger state transitions:
Remaining blockers:
Commit:
```

每完成一个 milestone，输出：

```text
Milestone:
Completed task IDs:
Feature state counts:
Production NodeContainer coverage:
Unexplained diff:
Live pass count:
Mock/direct fallback count:
Performance status:
Artifact/freeze status:
P0/P1:
Next milestone:
```

目标是实际完成代码、合同、测试、证据、artifact 和验证，不是重复生成另一份计划。
