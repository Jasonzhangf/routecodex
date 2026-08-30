# V3 SSE / client-provider decoupling full audit and repair plan

## 目标与验收标准

审计并修复整个 RouteCodex 项目的 SSE、HTTP client connection、Direct（全缓冲）和 Relay 生命周期，使 transport、client connection、provider codec、Hub/Chat Process、路由与错误链物理解耦。

验收标准：

- Direct 与 Relay 均经过明确的 transport/client lifecycle contract；Direct 全缓冲不绕过统一错误链。
- SSE 只处理 bytes、line、field、frame、data 拼接、limits、idle、backpressure、disconnect、EOF；`event:` 与 `[DONE]` 不产生业务成功、失败、terminal、切换或重试语义。
- provider JSON codec 是 provider 业务语义唯一入口；provider error、terminal、tool、continuation、usage 和 incomplete/failure 均由 typed outcome 表达。
- 所有错误单向进入 `ErrorErr01SourceRaised -> ErrorErr02HostCaptured -> ErrorErr03RuntimeClassified -> ErrorErr04RouterPolicyApplied -> ErrorErr05ExecutionDecision -> ErrorErr06ClientProjected`；provider 中间错误先进入 error/health/selection，只有候选池与 default 池同时为空才向客户端投影最终错误。
- client first-frame commit 前允许统一错误决策触发重选；commit 后不得对当前响应 reroute、rebuild、rewrite 或把 provider error 伪装成成功/EOF。连接关闭、健康更新和最终错误必须由 side-channel/error chain 表达。
- client disconnect、abort、close、timeout、half-close、backpressure、EOF、首帧超时、零输出、坏 frame、坏 JSON、provider 4xx/5xx、上游连接失败、Direct body 失败、Relay SSE 失败均有正反测试和真实入口证据。
- 报告能按文件、符号、节点、资源、调用边、错误链阶段、证据命令精确定位每个缺口；每个缺口有唯一 owner、最小修复、影响、风险和回归证据。
- 通过架构门禁、构建、安装、聚合重启、全部配置端口健康检查、Direct/Relay 同入口旧样本在线重放、AGY Review；仅在全部通过后精确合并到 `main` 并推送。

## 范围与边界

In scope：

- 所有 SSE decoder/encoder、HTTP response body/stream、client connection lifecycle、Direct full-buffer、Relay streaming、websocket-to-SSE 或 SSE-to-client bridge。
- OpenAI Chat、OpenAI Responses、Anthropic、Gemini 以及其他当前支持入口的请求/响应错误与 terminal 语义。
- provider transport、provider JSON codec、Hub inbound/chat-process/outbound、server frame、health/availability、route selection、retry/reroute、continuation 与 Error chain 的连接边界。
- 相关 function/resource/mainline/verification maps、manifest、wiki/HTML review surface、red fixtures、CI/build gate 和测试设计。

Out of scope：

- 不新增 provider-specific workaround、fallback、silent strip、请求侧 cleanup、handler/SSE/outbound 补偿或第二错误中心。
- 不修改历史不可变区，不从 metadata、snapshot、日志、旧 payload 或 session-only scope 重建控制状态。
- 不恢复已删除 provider，不顺手重构无关模块，不把真实 payload 语义裁剪为测试通过。

## 设计原则与目标拓扑

```text
client request
  -> server/client connection boundary
  -> ReqInbound -> ReqChatProcess -> route/target -> ReqOutbound
  -> provider transport request
  -> provider bytes
  -> SSE transport decoder (opaque frame/data)
  -> provider JSON codec (typed semantic outcome)
  -> RespInbound -> RespChatProcess -> RespOutbound
  -> client frame / buffered body
```

错误独立进入：

```text
source error
  -> ErrorErr01 source raised
  -> ErrorErr02 host captured
  -> ErrorErr03 runtime classified
  -> ErrorErr04 router policy applied
  -> ErrorErr05 execution decision
  -> ErrorErr06 client projected
```

连接事实（disconnect、timeout、EOF、backpressure、commit boundary）只能进入 typed transport/client side-channel；业务错误由 provider codec typed outcome 进入 Error chain。Direct full-buffer 只改变交付策略，不改变错误链、路由决策或响应语义。

## 必查真源与文件清单

先读并以实际内容为准：

- `AGENTS.md`
- `docs/agent-routing/05-foundation-contract.md`
- `docs/agent-routing/10-runtime-ssot-routing.md`
- `docs/agent-routing/20-build-test-release-routing.md`
- `docs/architecture/v3-resource-operation-map.yml`
- `docs/architecture/v3-function-map.yml`
- `docs/architecture/v3-mainline-call-map.yml`
- `docs/architecture/v3-verification-map.yml`
- `docs/architecture/v3-architecture-audit-locks.yml`
- `docs/architecture/wiki/v3-mainline-skeleton-sop.md` 及其 generated HTML
- `docs/goals/v3-sse-transport-json-semantic-decoupling-audit.md`
- `docs/goals/v3-sse-transport-core-extraction-plan.md`
- `docs/goals/v3-sse-hook-metadata-center-inventory.md`
- `.agents/skills/rcc-dev-skills/SKILL.md` 及 SSE、error-chain、provider failure、live replay 相关 references
- `.agent-collab/PROTOCOL.md`、当前 active runs/claims/handoff/merge-queue/KILL_SWITCH

然后从 map 的 `feature_id`、`resource_id`、`mainline_node_id`、`gate_id` 反查真实 caller/callee/source；不得只靠 grep 命中定位 owner。

## 审计报告要求

先只读审计，输出 `docs/goals/v3-sse-client-provider-decoupling-full-audit-report.md`，报告必须包含：

1. Executive summary：当前状态、是否存在 P0/P1、是否可修复交付。
2. 完整生命周期图：Direct full-buffer、Relay streaming、client connection、provider transport、SSE frame、JSON codec、response projection、Error chain 分开画图。
3. 逐入口矩阵：入口协议、Direct/Relay、stream/buffer、首帧 commit 点、连接 owner、provider codec owner、Error01 owner、Error06 owner、当前证据。
4. 错误矩阵：错误来源、首次偏离节点、当前错误处理、应有 Error chain 阶段、是否错误投影/吞 EOF/误判成功/错误 reroute、唯一修复 owner。
5. 连接矩阵：正常完成、provider failure、malformed SSE、malformed JSON、EOF without terminal、`[DONE]`、首帧超时、idle、backpressure、client disconnect、abort、half-close、body read failure、post-commit failure。
6. Direct/Relay 解耦差异表：允许差异、禁止差异、是否共享 typed contract；证明 Direct 全缓冲不是第二条错误路径。
7. map/manifest/wiki/gate 漂移：逐项列出现实 source 与文档绑定，不把 `design` 或 `binding_pending` 当 active truth。
8. 每个 finding：严重级别、证据路径/行号/符号、复现命令或样本、根因、唯一 owner、最小修复、正反测试、live 验证、剩余风险。
9. 不修复项：明确原因、越界依据、风险与后续 issue；不得把 blocker 静默改成通过。

## 实施顺序

1. 创建 run_id，刷新协作视图；按语义 claim，确认 clean owner worktree、base commit、branch 和 dirty main 风险。
2. 完成上述 map/source/wiki 只读审计；补齐缺失 resource/function/mainline/verification contract，先让 owner、边和 gate 可查询。
3. 为每个 confirmed finding 固化最小 red test 或真实 failing sample；验证当前确实失败。
4. 在唯一 owner 修复：SSE transport 保持 opaque；provider JSON codec 产出 typed outcome；client lifecycle 只表达 transport/commit facts；所有错误进入统一 Error chain；Direct/Relay 共享错误语义，禁止第二实现。
5. 补齐正反测试：每个 success/failure、terminal/non-terminal、pre-commit/post-commit、connected/disconnected、stream/buffer 分支成对锁定。
6. 同步 machine manifest、maps、wiki/HTML、test design、CI/build gate；生成物只能由 canonical renderer 生成，不能手工修漂移。
7. 在 owner worktree 运行目标测试、Rust/TS 编译、架构 gates、red fixtures、workspace build；记录完整 evidence。
8. 合并前在当前 dirty main 做集成构建与受影响验证，不能用 clean worktree 结果替代主树真相。
9. 按项目规则执行全局安装、仅使用 `routecodex restart` 聚合重启，检查配置中的全部成员端口 `/health`，再做 Direct/Relay 同入口旧样本或真实样本在线重放；记录运行版本、PID/端口、requestId、样本路径和结果。
10. 全部验证通过后，使用默认 `agy-review` MCP 做只读架构 review。P0/P1 或坏 JSON/无明确 PASS 均视为失败；失败必须修复后新建 review。
11. review PASS 且无后续代码/测试/配置/运行变更后，检查 `git diff --cached --stat` 与 `git diff --cached --name-status`，只精确暂存本任务 change set，合并到 `main`，提交并推送；证明本地 HEAD 与待推送 commit 一致。不得覆盖或带入无关 dirty 文件。

## 验证矩阵

至少覆盖：

- transport：frame boundary、field/data 拼接、opaque `event:`、`[DONE]`、EOF、UTF-8、limits、idle、backpressure、disconnect。
- semantic：JSON authority、terminal/failure/incomplete/tool/continuation、provider codec typed outcome、未知事件 fail-fast。
- error：Error01-06 adjacency、provider 401/403/429/5xx、decode/transport/body error、候选池/default 池耗尽、client disconnect health-neutral、错误不进正常 payload/client SSE body。
- lifecycle：Direct buffer、Relay stream、first-frame pre/post commit、abort/close/timeout、no JSON terminal、post-commit failure 不 reroute/rebuild/rewrite。
- architecture：owner uniqueness、non-adjacent conversion、provider-specific leak、fallback denylist、metadata/payload isolation、error-chain bypass、thin wrapper、map/mainline/wiki/manifest sync。
- runtime：项目规定的 build/install、聚合 restart、所有配置端口 `/health`、Direct 与 Relay 同入口真实 replay。

## 风险与规避

- 现有 dirty main 含其他 worker 改动：只读核对、独立 worktree 实现、精确合并；不 reset/checkout/stash/覆盖无关变更。
- provider 错误可能在 commit 前后语义不同：用显式 typed commit state 测试，不从日志猜时间顺序。
- SSE EOF/[DONE] 容易被误判成功：要求 JSON terminal evidence；无 terminal 必须显式错误。
- map 与 source 可能漂移：先修 owner/map/gate 一致性，再宣称架构闭环。
- live replay 可能受配置、provider health、真实凭据影响：记录精确 blocker；不以 smoke、health 或 fallback 冒充成功。

## 完成定义（DoD）

只有以下全部成立才可交付：审计报告完整；每个 P0/P1 已修或明确授权延期；Direct/Relay/client/SSE/provider 边界与错误链有 source、map、测试、live 证据；目标测试、构建、架构 gates、安装、聚合重启、全部健康检查、同入口真实 replay 通过；AGY Review 明确 PASS；change set 已精确合并 `main`、commit、push，且报告给出 commit、远端分支、验证命令、未完成风险。
## 当前专项修复计划：Direct Hook 唯一 mutation owner 与错误链零旁路

### 目标

依据 \`v3-sse-client-provider-decoupling-full-audit-report.md\`，只修复已确认的两类问题：

1. Direct 的 request/response payload 改写必须由已登记的 typed Hook/semantic projection owner 统一拥有；SSE consumer、Direct kernel、server handler 不得保留未登记的业务 payload mutation。
2. client disconnect、post-commit transport error、Error06 serialization/projection failure、panic/expect、observation/timing failure 都必须进入统一 ErrorErr01→ErrorErr06 或明确的 client-suppressed/health-neutral typed disposition；禁止 \`let _ = error\`、普通 \`return\`、ad hoc \`front_json_error\` 和无 owner 的二次错误路径。

### 现已确认的 source anchors

- Direct kernel mutation：\`v3/crates/routecodex-v3-runtime/src/kernel.rs\` 的响应 projection block。
- Direct SSE consumer mutation：\`v3/crates/routecodex-v3-runtime/src/kernel/direct_sse_consumers.rs\` 的 semantic consumer。
- Direct post-commit error 丢弃：\`v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers_stream.rs\` 的 \`client_released\` 分支。
- client channel disconnect：\`v3/crates/routecodex-v3-server/src/endpoint_handlers.rs\` 的 \`tx.send(...).await.is_err()\` 分支。
- ad hoc Error06 body replacement：\`v3/crates/routecodex-v3-server/src/endpoint_handlers.rs\` 的 \`v3_front_json_body_to_sse_frame\`。
- panic/expect projection：同文件的 Front SSE worker panic、body failure、empty response projection 分支。
- observation error swallowing：\`relay_runtime_core.rs\`、\`responses_sse_tree.rs\` 及 Direct timing closeout。

### 修复边界

- 先根据 resource/function/mainline/verification map 重新确认每个 anchor 的唯一 owner；若 owner 已被其他 claim 占用，建立 handoff，不在错误层或 transport 层越权修补。
- 先为每类旁路建立最小 red test；测试必须先在当前实现失败，记录首次偏离节点。
- Hook 收口只迁移真实 payload mutation，不把 routing、health、retry、continuation 或错误控制状态写入 payload。
- post-commit 错误仍不得重新发送客户端业务 frame、reroute 或 rebuild；只允许记录 typed closeout error，并由 Error06 disposition 标记 client-suppressed。
- client disconnect 必须 health-neutral，不得被计为 provider failure；但必须有 Error01 source 与完整 typed decision/receipt。
- Error06 projection 失败必须暴露为统一 internal response-stage error，禁止重新拼接 \`front_json_error\`。
- 不把所有 \`expect\` 测试辅助代码机械迁移；只处理生产路径中的 panic/expect，并为不可达 invariant 提供 typed Result 或 owning boundary fail-fast 证据。
- observation/timing 错误不得进入正常业务 payload；通过 typed side-channel 进入 health-neutral、client-suppressed error disposition。

### 专项验证矩阵

- Direct mutation：正向证明 Hook 改写仍生效；反向证明 consumer/kernel/server 直接 mutation 会被架构 red gate 拒绝。
- post-commit：正向证明 late transport error 不 reroute、不追加业务 frame 但保留 Error receipt；反向证明 clean EOF 不制造伪造 Error06。
- disconnect：正向证明 client disconnect 进入 ClientDisconnect Error01 并保持 health-neutral；反向证明 provider 失败不会被误判为 client disconnect。
- projection：正向证明合法 typed Error06 生成目标协议 frame；反向证明非法/不可序列化错误不生成 \`front_json_error\`，而是进入统一内部错误链。
- panic/expect：正向证明 worker/body failure 可投影 typed error；反向证明 projection 二次失败不会 panic 或静默 EOF。
- observation/timing：正向证明成功路径保持原业务响应；反向证明观测失败有 typed side-channel receipt，不影响/污染业务 payload。
- Direct/Relay parity：相同 provider semantic failure 在两条路径进入同一 ErrorErr04/05 policy；仅交付策略不同。

### 专项实施顺序

1. 读取当前 claims、worktree、maps 和 mainline source，锁定每个 anchor 的 owner 与允许边。
2. 建立最小红测并保存真实失败样本/错误链证据。
3. 逐 owner 修复 Direct mutation registry、client lifecycle 和 Error06 projection；禁止跨层补偿。
4. 补齐 maps、manifest、wiki、verification map、CI/build gate 和正反测试。
5. 在 owner worktree 完成定向测试、架构 gate、workspace build；再在最新 \`main\` 集成验证。
6. 全局安装、\`routecodex restart\`、全部 listener health、Direct/Relay 同入口旧样本回放。
7. 仅在 Relay semantic replay 闭环后运行 AGY Review；PASS 后精确 stage、检查 cached stat/name-status、commit/push 并验证远端 HEAD。
