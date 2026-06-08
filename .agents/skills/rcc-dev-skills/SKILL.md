---
name: rcc-dev-skills
description: RouteCodex/llmswitch-core 的 PipeDebug 与架构索引技能。用于定位请求在 Hub Pipeline / Virtual Router / Provider Runtime 各阶段的问题，并快速落到唯一功能块与改动文件。
---

# RCC Dev Skills

## Hub Pipeline 工具边界审计硬规则（最醒目）

- 审计/修复 Hub Pipeline 工具问题前，先读 `docs/goals/hubpipeline-tool-boundary-audit-goal.md`。
- stopless/servertool CLI projection 固定契约：`HubRespChatProcess03Governed -> stopless gate -> buildServertoolCliProjectionForAutoFlow -> exec_command CLI projection -> client`。`stop_message_auto` 不 reenter Hub Pipeline，不走 followup 编排，不调用 `reenterPipeline`。TS 只调用 Rust native gate + 构建 CLI projection JSON，禁止判断工具语义、拼装 messages/tools、清洗工具列表、从 `rawBody` 正常构造请求、用 provider raw/client outbound/SSE payload 判定 stopless。
- Servertool 响应职责锁：`stop_message_auto` CLI projection 是唯一 stopless 执行路径。其他 servertool（vision、web_search）走 backend route reenter，各有独立 outcome contract。禁止在 stopless 路径手写 Responses wrapper、直接写 SSE/client frame。
- Servertool 命名真相：CLI projection 投影为 `exec_command` 工具调用；客户端通过 exec_command 执行 CLI 后，结果作为工具返回进入下一轮请求。禁止在 CLI output 恢复内部 servertool tool identity，禁止使用 `followup` / `reenter` / `ServertoolReq04FollowupBuilt` 旧契约。
- 请求/响应转换必须是唯一语义链：`req_inbound -> req_chatprocess -> req_outbound -> provider_runtime -> resp_inbound -> resp_chatprocess -> resp_outbound`；`req_inbound/resp_inbound` 只解析入口协议和捕获上下文，所有字段的唯一语义映射必须发生在 `req_chatprocess/resp_chatprocess`，再由 outbound 只编码目标协议 wire，禁止绕过 chatprocess 直接重建上下文。
- 字段守恒规则：正常传输链路不得丢字段、不得把工具语义/`thinking`/`reasoning`/`tool_use`/`tool_result` 降级成普通文本；协议不支持的字段必须进入明确 canonical carrier 或 fail-fast，不允许静默删除、合并、清理、fallback。
- Anthropic reasoning 映射规则：入口 Anthropic `thinking` block / `reasoning_content` 必须先由 `req_inbound` 保留原始语义，再在 `req_chatprocess` 唯一映射为 Hub Chat canonical reasoning part；`req_outbound` 只编码为 provider wire 的 Anthropic `thinking` block / 合法字段；响应链同构在 `resp_chatprocess` 映射回 canonical reasoning，再由 `resp_outbound` 投影到 Responses reasoning，provider runtime 不得补做 reasoning/history 转换。
- `rawBody` 只能用于 snapshot/debug/errorsample 取证，不能作为正常请求/响应构造输入；provider runtime 只能发送 `req_outbound` 已生成的 provider wire payload，不能读取 `rawBody.messages`、不能从 raw history restore/coalesce/sanitize/prune/rebuild 上下文。
- stopless/servertool CLI projection（2026-06-06）：迁移后的 servertool 不走私有 server-side execution + followup/reenter，而是投影为客户端可见 `exec_command: routecodex servertool run <toolName> --input-json <json>`；`stop_message_auto` 必须把被拦截 stop 文本映射到 reasoning，并在 CLI input 中带 `repeatCount/maxRepeats/continuationPrompt`。`continuationPrompt` 必须是启发式多段核对（目标、已完成、完成/阻塞状态、下一步、证据、根因、排除项、排查顺序、learned），禁止只注入固定“继续执行”。
- stopless CLI projection reasoning（2026-06-07）：reasoning 真源顺序必须是 `execution.context.assistantStopText -> current finalChatResponse assistant text -> explicit default`；continuationPrompt/stop schema guidance 只放 CLI `--input-json`，不得替换可见 reasoning。测试 repeatCount/prompt 层级前必须清理对应 session/tmux state，避免旧 `stopMessageUsed` 残留伪造后续轮次。
- stopless goal 状态判定（2026-06-06）：captured request 中出现 `<goal_context>` / `Continue working toward the active thread goal` 只能用于重复 stop loop 检测，不能覆盖真实 `stoplessGoalState.status`；`completed/paused/stopped` 必须保持非 active，否则会误跳过 stopless CLI projection。
- 定位线上/黑盒工具错误时，第一步必须按 requestId / provider request_id / tool_call_id / 时间段读取 `~/.rcc/codex-samples/**` 与 `~/.rcc/diag/error-*.json`；先还原真实 client input、provider payload、provider response、contextSnapshot，再看代码，禁止跳过样本凭日志表象脑补。
- 图片/多模态被吞排障（2026-06-08）：先对比 `~/.rcc/codex-samples/**` 的 client-request/provider-request，区分当前轮真实 `input_image/image_url/data:image` 与历史 `[Image #N]` 文本占位；再查 Rust VR target 的 `supportsMultimodal` 与 `supportsVision`。`supportsMultimodal=false` 不等于非视觉；vision-only target 必须保留最新图片。禁止通过改配置逃避；只有完全没有 multimodal target 且没有 vision route 时，req_outbound 才允许占位最新图片。
- 若怀疑“工具调用进文本”，先对照 provider raw response 与 client-response snapshot：确认原始内容到底是结构化 tool_call/tool_use 还是文本；不得从客户端渲染结果反推解析器结论。`--snap` 必须能抓客户端最终 SSE 文本，包括 stream chunk 与 direct `res.write` repair 帧。
- 若 provider raw response 本身把工具调用吐成文本，继续查 provider-request 是否已带 native `tools`、文本 wrapper 是否属于已知 XML/namespace 形态、resp_chatprocess 是否已结构化 harvest；不得先假设上游改变，也不得从 UI 渲染反推。
- 样本最小证据包：`requestId`、端口/route/provider、`contextSnapshot.input`、`contextSnapshot.chatMessages`、provider wire payload、上游 error/message、相关 `tool_call_id` 前后 3-5 条历史。
- 架构命名按 `inbound / chatprocess / outbound` 三段：`req_inbound` 只解析入口协议和捕获上下文；`req_chatprocess` 是请求侧工具治理唯一入口；`req_outbound` 只做 Hub 语义到 provider 协议编码，禁止把工具语义降级成普通文本。
- 响应同构：`resp_inbound` 只解析 provider 响应；`resp_chatprocess` 是响应侧工具治理唯一入口；`resp_outbound` 只做客户端协议投影，禁止修补请求侧历史污染。
- 工具声明、文本工具 harvest、apply_patch、servertool、MCP/native 工具治理、sanitize、tool list 注入/裁剪必须 Rust-only；TS 只能是 JSON parse/serialize + native 调用薄壳。
- OpenAI Responses prebuilt SSE stopless 边界：TS 只能把 upstream `__sse_responses` 读成 provider `bodyText` 并在 stopless 条件下禁止 passthrough；SSE terminal events 必须在 Rust `RespInbound` materialize 成 Responses JSON 后进入 `RespChatProcess`。禁止把 `__routecodex_stream_contract_probe_body` / snapshot/debug probe 当正常 provider response 语义输入。
- Snapshot/errorsample 里的工具失败识别也属于工具语义：`messages/input/tool_call_id/call_id` 扫描、工具名归一、apply_patch/exec/shell 错误分类必须 Rust-only；TS 只能调用 native 并写样本。
- Virtual Router 只路由，不修 payload；Provider 只 transport/auth/provider 内部兼容，不做 Hub 工具治理；direct/provider passthrough 禁止进入 Hub Pipeline conversion。
- Phase 0 generated artifact cleanup：`sharedmodule/llmswitch-core/src/**/*.js` / `.d.ts` / `.js.map` 是 ignored TS emit，不是 runtime source truth；Hub/VR/servertool source truth 目录（`src/conversion/hub`、`src/router/virtual-router`、`src/servertool`）不应保留 side-by-side emit。清理前必须用 `git check-ignore` 证明候选是 ignored artifact，再物理删除并用 residue gate 锁住；禁止把 side-by-side JS 当语义修复点。不要把该规则直接套到 `conversion/shared`，该目录仍有测试 `.js` import 依赖，需单独迁移/证明。
- Phase 0 zero-consumer wrapper cleanup：Hub Pipeline 下无 live import、无 public barrel export、无同名 JS shadow、且 native capability 仍在 Rust/native truth 的 TS thin wrapper/helper 必须物理删除；不要把“薄壳”当保留理由。
- Phase 0 zero-consumer shared adapter cleanup：若 shared adapter 只是转发 live bridge/native owner 且无 source/test/script importer，必须删除并更新 active docs；禁止用“统一入口/避免分叉”的旧文案保留 0-consumer 中转层。
- Phase 0 静态 0-consumer 误报边界：删除前必须查 `importCoreDist(...)` / native dynamic loader；`conversion/hub/snapshot-recorder.ts` 和 `native-failure-policy.ts` 这类动态入口不能仅因无静态 import 删除，除非先迁移动态 importer。
- 本地生成物清理边界（2026-06-07）：`~/.rcc/install/releases/.staging-routecodex-*` 是失败/未完成安装 staging，确认 `install/current` 不指向后可删；`~/.rcc/diag` / `codex-samples` 是线上取证真源，禁止整目录删除，只能按 TTL/采样策略清理。仓库 `tmp/`、`.install-pack/`、test-results、旧 `.tgz`、`.DS_Store`、src-side `.js.map` 可按 `git check-ignore` 证据清理；`.js/.d.ts` 需先确认无动态 import / dist 依赖。
- 废弃清理脚本反模式（2026-06-07）：若脚本批量 `sed` 修改源码、依赖过期 `dead-code-analysis-report.json`、或生成 TODO 型 cleanup 脚本且无 package 入口，应视为死代码物理删除；禁止执行这类脚本冒充审计。
- 根目录生成物治理（2026-06-07）：根目录清理要先按 `docs/goals/root-generated-artifacts-governance-plan.md` 分类，区分 tracked source、ignored generated、local tool state、runtime evidence。`git check-ignore` 只能证明 ignored，不能单独证明可删；`webui/` 这种被 `.git/info/exclude` 本地隐藏但被 package/test/build 使用的源码必须保留。`package/`、`nested/`、`rcc` 是 tracked 历史例外，需按迁移文档单独处理，不能当 ignored 垃圾删。
- 根目录生成物治理（2026-06-08）：pack/install 输出唯一 approved repo root 是 `artifacts/pack/`，禁止 root `*.tgz` / `.install-pack`；`package/` qodercli residue 与 root `rcc` symlink 已删除，禁止恢复为 legacy exception；agent/index/cache state 只允许在 `.agent-state/`、`.local-index/`、`.cache/model-cache/`，repo-sanity 必须扫描 ignored root entries，防止 `.gitignore` 把根目录散件藏起来。
- 根目录生成物治理（2026-06-08 补充）：tracked report 默认输出必须写 `docs/reports/`，不是 root `reports/`；repo-local debug log 可写 `logs/<feature>/`；`artifacts/` 只允许 `pack/`，`.cache/` 只允许 `model-cache/`。发现脚本用 `path.join(process.cwd(), 'reports')`、非 pack `artifacts/*`、非 model-cache `.cache/*` 时，先改唯一写入真源并补 `repo-sanity` gate。
- 发现违规必须先写红测，红测要覆盖真实 Hub Pipeline stage 或 HTTP 黑盒入口；禁止 mock 私有方法冒充黑盒。
- quota 控制面真源：`QuotaManagerModule.getControlSurface()` 是 daemon-admin / control plane 唯一入口；`quota-handler.ts`、`control-handler.ts` 禁止自建 `createQuotaManagerAdapter(...)`，禁止直连 Rust mutator。
- quota 初始化硬规则：启动时只能按当前 `config.toml` materialized `virtualrouter.providers` 初始化 quota；未配置 provider 禁止 hydrate/persist/参与本轮 quota 生命周期。
- “路由不能空” 属于 Rust Virtual Router selection owner；禁止在 handler / executor / quota adapter / provider runtime TS 层补 fallback、补 recover、补第二套 candidate 逻辑。
- route availability floor 细则：命中顺序固定为高优先级池 → 低优先级池 → `default` 池；只要 `default` 池有 provider，就不能返回空池，且 default 最后一跳只能由 Rust selection 保留。

## 标准契约流水线定位法（先看 AGENTS.md 图）

遇到请求/响应/工具/路由/metadata 问题时，先按 `AGENTS.md` 的“标准接口契约流水线图”定位出错节点，再改唯一 owner；禁止直接跨层补丁。

```text
ServerReqInbound01 -> HubReqInbound02 -> HubReqChatProcess03 -> VrRoute04
  -> HubReqOutbound05 -> ProviderReqOutbound06/07 -> ProviderRespInbound01
  -> HubRespInbound02 -> HubRespChatProcess03 -> HubRespOutbound04 -> ServerRespOutbound05
```

| 现象 / 证据 | 先查节点 | 唯一修改对象 | 禁止动作 |
|---|---|---|---|
| client input / headers / endpoint / port scope 丢失 | `ServerReqInbound01ClientRaw` / `HubReqInbound02Standardized` | HTTP route adapter、Rust `req_inbound` context capture | 在 provider runtime 补 header/body |
| metadata 泄到 provider body / SDK options | `HubReqInbound02` 到 `HubReqOutbound05` 的 Meta carrier 边界 | metadata carrier / outbound fail-fast guard | 静默删除 metadata 当修复 |
| tool declarations、tool_choice、reasoning/history 请求侧错误 | `HubReqChatProcess03Governed` | Rust req_chatprocess / tool governance / canonical reasoning | provider-specific Hub patch、rawBody restore |
| 选错 provider / route reason 错 | `VrRoute04SelectedTarget` | Rust Virtual Router selection / health/quota input | 修改 payload 影响路由 |
| provider request wire shape 错、tool_result 顺序错 | `HubReqOutbound05ProviderSemantic` / `ProviderReqOutbound06WirePayload` | Rust req_outbound codec 或 provider runtime transport/auth | 在 req_inbound/resp_outbound 回补 provider wire |
| upstream raw response 解析错 | `ProviderRespInbound01Raw` / `HubRespInbound02Parsed` | provider response parser / Rust resp_inbound | 从 client render 反推解析 |
| tool_call 进入文本、servertool followup、internal tool 剥离错误 | `HubRespChatProcess03Governed` | Rust resp_chatprocess / text harvest / servertool followup | 在 client SSE frame 修工具语义 |
| client JSON/SSE frame、required_action、done 事件错误 | `HubRespOutbound04ClientSemantic` / `ServerRespOutbound05ClientFrame` | resp_outbound projection / server frame writer | 修改 provider raw 或 request history |
| 错误 status/code/retry/backoff 错 | `ErrorErr01..05` | provider error catalog / failure policy / retry plan | fallback 成成功响应、message-only 分叉 |
| snapshot/errorsample/stats 跨端口污染 | `Meta*` / `Snapshot*` carrier + server port scope | snapshot writer、errorsamples、stats/traffic scope key | 共享 singleton 不带 `entryPort/serverId` |

定位流程：
1. 先用 requestId 找 `codex-samples`：`client-request`、`provider-request`、`provider-response`、`client-response`。
2. 判断污染首次出现在哪个契约节点；只改该节点 owner 或相邻 builder/parser。
3. 新增红测必须锁同一节点边界：非相邻 shortcut、metadata 泄漏、旧 stage shell、required export 扩展、owner-pair 扩展。
4. 修改后跑对应节点定向测试，再跑 Phase residue/API contract 门禁。

## 错误链定位法（direct / 5xx / cooldown）

遇到 provider 502/503/524/429、死打同一 provider、cooldown 不生效、direct path 无 `[provider-switch]` 时，先按 `AGENTS.md` 的“标准错误链契约图”定位，禁止在现场调用点补第二套策略。

```text
ErrorErr01SourceRaised -> ErrorErr02HostCaptured -> ErrorErr03RuntimeClassified
  -> ErrorErr04RouterPolicyApplied -> ErrorErr05ExecutionDecision -> ErrorErr06ClientProjected
```

| 现象 / 证据 | 先查节点 | 唯一修改对象 | 禁止动作 |
|---|---|---|---|
| direct 502/524 没有 provider health/cooldown | `ErrorErr02HostCaptured` | `src/providers/core/utils/provider-error-reporter.ts` + `router-direct-pipeline.ts` hook | 在 direct 本地写 cooldown |
| provider error event 字段不完整 | `ErrorErr02HostCaptured` | `capture_error_err_02_host_from_error_err_01_source` | 调用点手拼 `reportProviderErrorToRouterPolicy({ ... })` |
| recoverable/unrecoverable 判错 | `ErrorErr03RuntimeClassified` | `provider-error-catalog.ts` / `provider-failure-policy-impl.ts` | message-only 特例分叉 |
| health/cooldown/reroute 状态错误 | `ErrorErr04RouterPolicyApplied` | Rust `virtual_router_engine` / `provider-runtime-ingress.ts` | executor/provider runtime 直接写 health |
| 请求内 retry/reroute 执行错误 | `ErrorErr05ExecutionDecision` | request/direct executor consumer | 重新分类 provider error |
| client 错误输出格式问题 | `ErrorErr06ClientProjected` | HTTP/server error projection | 回写 provider policy 或修 payload |

取证顺序：先读 `~/.rcc/diag/error-*.json` / `~/.rcc/codex-samples/**` 确认 runtime stack；如果 stack 是 `executeRouterDirectPipeline`，必须验证 direct 错误是否进入 `ErrorErr02HostCaptured`，不能只改 `RequestExecutor`。

## Metadata 请求/响应闭环隔离硬规则（2026-06-01，强制）

- metadata 是无状态、短生命周期、单个 request/response 闭环内的内部控制语义 carrier；不是 provider request/response 的一部分。
- 允许读取位置：入口 adapter / Hub Pipeline / Virtual Router / Provider Runtime 的 runtime carrier 或 context side-channel；用途限 routeHint、entryEndpoint、stream intent、servertool/web_search、snapshot 标签、同闭环响应处理。
- HTTP handler 入口可读取当前 request body metadata 并放入 carrier，但 handoff 给 Hub Pipeline 的 body 必须剥离 top-level `metadata`；禁止 `payload.metadata` / `pipelineBody.metadata` 再作为 mock、session、route、resume 等控制真源。
- 禁止出口：provider HTTP body、provider SDK request/options、direct passthrough body、client response body、provider health/quota/runtime 持久状态、port/session/global cache。
- Responses JSON/SSE 转换和 direct replay 是高风险边界：禁止 `response.metadata` / provider SSE `data.metadata` / `metadata.__raw_request_body.metadata` 进入 client response payload 或 provider wire body；snapshot metadata 只能留在 snapshot root，不能被 normal live path 恢复。
- 隔离维度：requestId、pipelineId、port/serverId、sessionId、conversationId 必须互相隔离；闭环完成后 metadata 必须释放，不能跨请求、跨响应、跨端口、跨 session 复用。
- 明确错误模式：`body.metadata -> provider options`、`rawBody.metadata -> SDK request`、`payload.metadata.context -> provider wire payload`、`snapshot.metadata -> live runtime metadata`、`metadata.user_id/session_id/conversation_id -> upstream body/options` 全部违规。
- 修复原则：在唯一真源出站构造点移除违规语义并加 fail-fast invariant；禁止 fallback sanitizer、静默 delete、provider-specific 旁路、双路径兼容。
- 验证要求：红测至少覆盖 protocol client、SDK transport、Rust outbound format build、provider-request snapshot、连续请求/端口/session 隔离。

## Hub/VR 节点 runtime contract help（2026-06-03，强制）

- 修改 Hub Pipeline / Virtual Router 节点前，先查 Rust runtime 在线 contract help；入口为 native `describeHubPipelineContractsJson`、`describeVirtualRouterContractsJson`、`describeMetaCarrierContractsJson`、`describePipelineContractJson(nodeId)`，TS 薄壳为 `describeHubPipelineContractsNative` 等。
- 每个节点修改必须对齐 contract 中的 `dataIn` / `dataOut` / `metaRead` / `metaWrite` / `effects` / `forbiddenPaths` / `ownerBuilder`；只改唯一 owner builder/parser。
- 控制语义只能进入 `Meta*` carrier；观测/计时/dataProcessed 只能进入 `Snapshot*` / NodeObservation；错误只能进入 `Error*` chain；禁止把这些写回 data payload。
- 修改后至少跑 Rust contract 定向测试和对应 node boundary/red test；新增 contract violation 必须 fail-fast，不允许 fallback/silent sanitizer。

## 索引概要
- L1-L20 `purpose`: RouteCodex/llmswitch-core 开发技能索引
- L21-L55 `closed-loop-refactor`: 标准重构/修复闭环（分步→修改→编译→构建→验证→下一步）
- L56-L75 `chat-process`: Chat Process 定义与阶段说明
- L76-L95 `tool-governance`: 工具治理唯一真源位置
- L96-L115 `heredoc`: Heredoc 工具引导/收割架构
- L116-L135 `diagnosis`: PipeDebug 诊断流程
- L136-L195 `restart`: 服务器重启与热加载（SIGUSR2）
- L196-L275 `snapshot-startup`: Snapshot 启动策略（默认轻量 + 显式 stage）
- L276-L375 `stopless-skeleton`: servertool stopless CLI projection 骨架、契约、测试矩阵（2026-06-06 reenter/followup 旧契约已废弃）
- L376+ `hard-guard`: fallback / 静默失败治理硬规则

## 标准重构 / 修复闭环（强制顺序）
## RCC 配置真源（新增，强制）

1. RouteCodex 运行时 provider/router 配置真源优先看 `~/.rcc/`，不是仓库内 `config/`、不是 `~/.codex/config.toml`。
2. 排查“某 provider 是否已配置/当前 targets 是什么/某端口命中什么路由”时，先读：
   - `~/.rcc/config.toml`
   - `~/.rcc/config.<provider>.toml`（如 `config.windsurf.toml`）
3. 只有在需要核对运行时合并结果时，才把 `~/config/merged-config.<port>.json` 当作派生快照；它不是首要真源。
4. 若本次任务暴露出 agent 先查错配置源，必须先纠正到 `~/.rcc`，再继续分析 provider/token/router 问题。

## Provider 自动重试 (Auto-Retry) 配置（2026-05-27）

## 2026-05-28 错误处理收敛硬规则（新增）

1. Provider 执行期错误只允许三分类：`recoverable` / `unrecoverable` / `special_400`；禁止新增第四类。
2. 网络错误（含 HTTP_502 / timeout / transport）属于“可恢复错误”的普通成员，不能做专门旁路策略。
3. 分类入口唯一：`resolveProviderFailureClassification(...)`；执行出口唯一：`resolveProviderFailureActionPlan(...)` + Virtual Router policy。
4. 任何模块（RequestExecutor / Converter / Followup）发现新错误样本时，只能补“归一映射”，不能新增“该错误独有处理流程”。
5. 可恢复错误统一遵循：请求内指数退避（1s 起）+ 连续 3 次失败进入 provider 冷却池；冷却阶梯按 10m -> 30m -> 5h 循环；重启后首命中允许一次被动探测。

### 功能说明
每个 Provider 可以在内部自动重试某些可恢复错误，不触发 health impact 上报。
- 错误码匹配 `autoRetry.codes` 列表 → 静默重试 + `console.warn` 打印
- 连续失败次数 ≥ `threshold` → 放行到正常错误上报（`handleRequestError`）
- 中间有一次成功 → 连续计数清零

### Provider 配置目录
所有 Provider 的 `config.v2.toml` 文件存储在 `~/.rcc/provider/<providerId>/config.v2.toml`。

```
~/.rcc/provider/
├── mini27/
│   └── config.v2.toml          # MiniMax 配置（含 autoRetry 示例）
├── windsurf/
│   └── config.v2.toml
├── deepseek/
│   └── config.v2.toml
└── ...
```

### TOML 配置格式
在 `[provider]` 下增加 `[provider.autoRetry]` 段：

```toml
[provider.autoRetry]
threshold = 5
codes = ["429.1000", "500.1000", "503.1000", "0.1000", "0.6000", "0.8200"]
```

参数说明：
- `threshold`（可选，默认 3）：连续失败次数阈值。达到此值后才上报 health impact。
- `codes`（必选，非空数组才生效）：全局统一错误码列表，只有匹配的错误码才参与自动重试。

### 全局错误码表（src/providers/core/runtime/auto-retry-error-codes.ts）

| 错误码 | 常量名 | 语义 |
|---|---|---|
| `429.1000` | AUTO_RETRY_429_SHORT_LIVED | 短期 Rate Limit |
| `429.2000` | AUTO_RETRY_429_DAILY_LIMIT | 日额度耗尽（一般不建议配置） |
| `429.3000` | AUTO_RETRY_429_SATURATED | 流量饱和 |
| `408.1000` | AUTO_RETRY_408_TIMEOUT | 请求超时 |
| `425.1000` | AUTO_RETRY_425_TOO_EARLY | Too Early |
| `500.1000` | AUTO_RETRY_500_INTERNAL | Internal Server Error |
| `502.1000` | AUTO_RETRY_502_BAD_GATEWAY | Bad Gateway |
| `503.1000` | AUTO_RETRY_503_UNAVAILABLE | Service Unavailable |
| `504.1000` | AUTO_RETRY_504_GATEWAY_TIMEOUT | Gateway Timeout |
| `520.1000` | AUTO_RETRY_520_UNKNOWN | Cloudflare / upstream unknown error |
| `0.1000` | AUTO_RETRY_NET_CONNECT | 连接失败 (ECONNRESET/ECONNREFUSED/ENOTFOUND) |
| `0.2000` | AUTO_RETRY_NET_TIMEOUT | 网络超时 (ETIMEDOUT) |
| `0.3000` | AUTO_RETRY_NET_PIPE | 管道断开 (EPIPE) |
| `0.4000` | AUTO_RETRY_NET_DNS | DNS 解析失败 (EAI_AGAIN) |
| `0.5000` | AUTO_RETRY_NET_ABORT | AbortError（非客户端主动取消） |
| `0.6000` | AUTO_RETRY_NET_CANCEL | HTTP2 流取消 (ERR_HTTP2_STREAM_CANCEL) |
| `0.7100` | AUTO_RETRY_PROTO_SSE_DECODE | SSE 解码失败 |
| `0.7200` | AUTO_RETRY_PROTO_EMPTY_RESPONSE | 上游空响应 |
| `0.7300` | AUTO_RETRY_PROTO_SSE_TO_JSON | SSE→JSON 转换失败 |
| `0.8000` | AUTO_RETRY_UPSTREAM_GLM_514 | GLM 业务错误 514 |
| `0.8100` | AUTO_RETRY_UPSTREAM_STATUS_1000 | 上游状态码 1000 |
| `0.8200` | AUTO_RETRY_UPSTREAM_STATUS_2056 | 上游状态码 2056（用量超限） |

### 2056 内部消化流程（MiniMax 偶发上游轮询）

2056 不是真正的配额超限，而是 MiniMax 上游偶发轮询切换。必须由 **provider 内部 auto-retry** 吸收，不能暴露到客户端。

完整链路：
```
MiniMax 返 base_resp.status_code=2056
  → resolveProviderBusinessResponseError 抛 MALFORMED_RESPONSE（code=MALFORMED, upstream=PROVIDER_STATUS_2056）
  → base-provider.ts auto-retry 拦截
  → resolveAutoRetryErrorCode → '0.8200'
  → autoRetryConfig.codes.includes('0.8200') → 命中
  → provider 内部重试（不经过 request 级重试引擎）
  → 重试成功 → 吸收 | 全部失败 → 自然走 error 上报
```

关键依赖：
- `provider-request-shaping-utils.ts:87-99` — `resolveProviderBusinessResponseError` 检测 `base_resp.status_code`
- `auto-retry-error-codes.ts:128-129` — `resolveAutoRetryErrorCode` 返回 `'0.8200'`（⚠️ 必须在 catalog 之前检查）
- `base-provider.ts:249-266` — `sendRequest()` catch 块中的 auto-retry 逻辑
- 该 provider 的 `config.v2.toml` 必须有 `codes = ["0.8200"]`

### 常见场景配置

**MiniMax 用量超限（2056）+ 5 次阈值**（已配置在 mini27）：
```toml
[provider.autoRetry]
threshold = 5
codes = ["429.1000", "500.1000", "503.1000", "0.1000", "0.6000", "0.8200"]
```

**通用网络瞬断 + 3 次默认阈值**：
```toml
[provider.autoRetry]
codes = ["0.1000", "0.2000", "0.6000"]
```

### 调试日志特征
自动重试命中时打印 `[auto-retry]` 前缀的 warn 日志：
```
[auto-retry] provider:openai-responses-mini27 code=0.8200 attempt=1/5 - retrying
[auto-retry] provider:openai-responses-mini27 code=0.8200 attempt=2/5 - retrying
```
超过阈值后不再出现 `[auto-retry]`，转为正常 `request-error` 上报。

### 实现文件
- `src/providers/core/runtime/auto-retry-error-codes.ts` — 错误码枚举 + `resolveAutoRetryErrorCode()` 映射函数
- `src/providers/core/api/provider-types.ts` — `ProviderRuntimeProfile.autoRetry` 类型定义
- `src/providers/core/runtime/base-provider.ts` — `sendRequest()` catch 块中自动重试拦截逻辑

### ⚠️ resolveAutoRetryErrorCode 查找顺序（踩坑记录）
`resolveAutoRetryErrorCode()` 内部先调 `normalizeKnownProviderError()`（查 error catalog），再走精确匹配。
**catalog 对 PROVIDER_STATUS_2056 返回 `'429.2056'`**（来自 `provider-error-catalog.ts` 第 23 行）。
但 auto-retry 配置只认得 `'0.8200'`（`AUTO_RETRY_UPSTREAM_STATUS_2056`）。

**修复**：2026-05-27 将 `PROVIDER_STATUS_2056` 的精确匹配移到 `normalizeKnownProviderError` 之前。
否则 2056 永远命中 `'429.2056'` → 不在 `autoRetry.codes` 中 → auto-retry 静默失效。

```typescript
// 正确顺序：先精确匹配 2056，再查 catalog
if (upstreamCode === 'PROVIDER_STATUS_2056' || code === 'PROVIDER_STATUS_2056') {
  return AUTO_RETRY_UPSTREAM_STATUS_2056;  // '0.8200'
}
const known = normalizeKnownProviderError({...});  // catalog 返回 '429.2056'
```

同类的 `PROVIDER_STATUS_1000` 也需注意（目前 `0.8100` 不在 catalog 中，无冲突）。

## 2026-05-27 调试精华（5555 主备/health/stopless）

- stopless schema-missing：CLI projection 后客户端发回 tool result；查断流/不触发时先确认客户端是否正确执行了 `exec_command` 并返回 tool result，而非只看日志 `trigger`。

## 2026-05-29 调试精华（CompatProfileRegistry）

- `/v1/responses` 报 `[CompatProfileRegistry] profile not found: "chat:openai"` 时，先查被选 provider 的 `compatibilityProfile` 是否为 registry JSON 真 id；通用 OpenAI-compatible provider 使用 `compat:passthrough`，不要新增 `chat:openai`/`chat:deepseek` 影子 profile。

## 2026-05-29 架构硬规则（Hub/VR 与 Provider 边界）

- Hub Pipeline / Virtual Router 永远不写 provider 特例：不得在 hub/VR 中加入 Windsurf、Cascade、某账号、某模型、某 provider shape 的分支、补偿、fallback 或上下文修补。
- Windsurf 的云端 Cascade 自带上下文记忆；Windsurf Provider 发送层应按 WindsurfAPI/Cascade 形状只发送当前 delta，并在 provider runtime 内处理 native/MCP 映射，不能要求 Hub Pipeline 为 Windsurf 改 continuation 语义。
- Windsurf resume/已有 cascade 时，`additionalSteps` 只能包含当轮新完成的 native/MCP tool result；历史 tool result 不得 replay。MCP result 对应 Cascade `CortexTrajectoryStep` field 47 `mcp_tool`，native result 走对应 native step field。
- Windsurf native tool config 必须保留 protobuf zero-length message 字段（如 `run_command` field 8 空子消息）；生成 CascadeToolConfig 时禁止用“空 buffer 跳过字段”的 helper，否则二跳 additional_steps 可能触发 gRPC status 2。
- Windsurf poll 看到 tool_calls 不能立即返回给 Hub；必须像 WindsurfAPI 一样继续 `GetCascadeTrajectory` 轮询到 Cascade IDLE 后再返回，否则下一跳会撞上 `executor is not idle: CASCADE_RUN_STATUS_RUNNING` 并变成 503/upstreamCode=2。
- Windsurf 单本地 Cascade executor 同时只能处理一个发送链路；同 provider/账号请求必须在 provider 内串行化，禁止并发 close/reuse 同一 local gRPC session，否则 warmup/SendUserCascadeMessage 会互相污染并表现为卡住或 status 2。
- Windsurf warmup 必须 bounded：每个 stage 都有 provider 内 timeout；`AddTrackedWorkspace` / `UpdateWorkspaceTrust` / `Heartbeat` 非 transport 错误只记录并继续；transport/timeout 必须 reset local gRPC session + 清 warmup promise，禁止永久占住真实请求。

## 2026-05-28 回归测试新增硬规则（Jason）

1. 任何功能修复/错误修复，**红测必须包含 HTTP/请求级黑盒红测**。
2. 黑盒定义：必须从真实入口发请求（如 `fetch http://127.0.0.1:<port>/v1/responses` 或测试内真实 listener），断言真实 HTTP status/body；不得用直接调用 private method、mock `executePipeline`、mock handler 返回值冒充黑盒。
3. 黑盒必须模拟/捕获线上真实失败形态：如果线上是 provider `throw`，测试也必须 `throw`；如果线上是 SSE/stream，测试也要走对应 HTTP/SSE 入口；只测 `{status: 503}` 返回不等于覆盖 throw 形态。
4. 白盒/单元测试只能补充定位，不可替代黑盒红测；若先写了白盒，仍必须补 HTTP 黑盒红测后才能修复。
5. 标准顺序固定为：HTTP 黑盒红测（先红）→ 必要白盒红测（可选）→ 修唯一真源 → HTTP 黑盒变绿 → 构建/安装/运行态 smoke。
6. 汇报必须单列证据：`HTTP 黑盒红测` / `白盒红测(如有)` / `唯一修复点` / `HTTP 黑盒绿测` / `运行态证据`。
7. 若黑盒红测没有经过真实请求入口和真实响应断言，不得宣称“已完成修复”。

0. TS→Rust JSON 序列化铁律：Rust enum 若要从 TS 接收小写值（如 `"idle"`、`"on"`、`"trigger"`），必须加 `#[serde(rename_all = "camelCase")]`，否则 serde 默认等 PascalCase（`"Idle"`、`"On"`、`"Trigger"`），反序列化直接炸。
   - 2026-05-27 踩坑：`stop-message-core` 的 `StageMode`、`SnapshotSource`、`GoalStatus`、`SkipReason`、`Action` 五个枚举都缺这个 derive 属性。后果：`decideStopMessageActionWithNative` 每一次都悄无声息地 fallback skip（`native_returned_non_string: object`），stopless 完全不工作。
   - 红测: `tests/servertool/stop-message-native-decision.spec.ts`（9 用例，不 mock native）

1. 先黑盒后改代码（强制）
- 先用 Rust 真源黑盒测试锁语义，再改实现；不要先在线乱试。
- 本次有效黑盒：
  - `persisted_503_daily_cooldown_is_cleared_by_provider_success_and_not_reimported`
  - `priority_pool_picks_primary_provider_when_both_available`
  - `priority_pool_falls_back_to_backup_when_primary_in_health_cooldown`
- 结论：VR priority 选择器语义正常；“主不命中”先查外部状态（health/quota/runtime init），不是先改 selection。

2. 503 持久冷却语义（已验证）
- `provider-health.json` 的 `__http_503_daily_cooldown__` 是 persisted 状态，按 provider canonical key（`key1 -> 1`）生效。
- 启动时必须重新校验：允许先恢复；若首个真实请求仍是不可恢复错误（如 503），再次进入冷却（重新拉黑），而不是沿用旧状态直接永封。

3. 启动重探测（startup reprobe）排障顺序
- 先区分三类分支再下结论：
  1) `checkHealth()` 返回 false；
  2) `handleProviderSuccess` hook 不可用（VR 未就绪）；
  3) success 已发出但被后续错误重新写回冷却。
- 未分支前，禁止把“仍命中备份”直接归因到路由器。

4. 会话目录与 health 文件定位
- server-scoped session dir 是主真源：`ROUTECODEX_SESSION_DIR` / `sessions/<serverId>/provider-health.json`。
- 排障必须同时核对 server-scoped 与根 `sessions/provider-health.json`，避免误删错路径或读错文件。

5. 配置与路由池排查要点（5555）
- 先核对 `routingPolicyGroup` 实际 targets 顺序，再核对 provider runtime 可用集与初始化结果。
- 若“第一跳直接备份”，先查：
  - provider health 持久态；
  - provider init/health probe 失败；
  - runtime key 映射是否命中可用 handle；
  - quota/blacklist 是否把主 provider 挡掉。
- 带图请求被 `[Image omitted]` 吞掉时，先用 `~/.rcc/codex-samples/**/provider-request.json` 与 `~/.rcc/logs/server-5520.log` 确认 VR 是否出现 `multimodal:visual-content` 或 media route；当前用户 turn 的 `<image ...>` / `[Image omitted]` / `[Image #n]` 仍是 media intent，必须在 Rust VR feature 层识别。路由顺序固定为 `multimodal -> vision -> 原文本/默认路由`：只要配置里存在 vision 路由，就必须保留为 multimodal 之后的视觉后备；只有两者都无视觉可用目标时才允许落到 default/text route 后做 placeholder/阻断。禁止用改配置或提前裁剪真实 payload 解决。

6. stopless/stop_message 约束（复盘）
- 默认开启不等于无条件触发；必须有 CLI projection 执行上下文且 finish_reason 条件正确。
- 禁止任何“把非 stop 改成 stop”的语义改写（仅允许既定例外：text harvest；stop -> tool_calls）。
- 2026-06-06 更新：`stop_message_flow` 只走 CLI projection，禁止 reenter/followup 编排；`used/max_repeats` 防循环；其他 servertool（vision/web_search）走 backend route reenter。
- 2026-06-06 更新：stopless schema 的 `learned` 字段属于 Rust `stop-message-core` 默认 schema；只有 `schemaGate.action=allow_stop` 且 `learned` 非空时，TS IO 薄壳才可写入项目 `note.md`。invalid schema / missing schema / budget exhausted 不得写入记忆。
- 2026-06-04 更新：stopless/servertool gateway 只能检查 `HubRespChatProcess03Governed` chat 标准态；禁止用 provider raw `stop_reason` 或 client outbound/SSE payload 判定。Rust effect 必须携带 chat-process payload，TS shell 缺 payload 必须 fail-fast。


## Windsurf 对齐固定参考（2026-05-21，强制）

1. **不要再全盘搜索参考仓。** Windsurf 相关任务固定先看以下路径：
   - 主参考仓入口：`/Volumes/extension/code/WindsurfAPI`
   - 鉴权 / PostAuth 真源：`/Volumes/extension/code/WindsurfAPI/src/dashboard/windsurf-login.js`
   - RouteCodex 当前实现：`src/providers/core/runtime/windsurf-chat-provider.ts`

2. **鉴权已确认真源（且只允许 cascade 主线）**
   - 所有 Windsurf 认证最终都收敛为：`devin-session-token$...`
   - provider 最终使用的凭证就是这个 session token
   - 若 provider 配置里直接给了 devin session token：**优先直接用 token，不走账密登录**
   - 若只有账号密码：直接走 `/_devin-auth/password/login` 拿 `auth1_token`，再调用 `WindsurfPostAuth` 换 `session_token`
   - 登录成功后，**必须持久化 session token**；下次优先读持久化 token，失败再按规则刷新
   - Windsurf 本地实现只允许：`chat -> windsurf-chat-provider -> cascade`；禁止再引回任何第二实现文件、脚本、文档或测试锚点
   - **发送主链已黑盒证伪旧 JSON 路径**：`GetChatCompletions` 不是当前 WindsurfAPI / app 真发送主线；后续调试/实现/测试必须只围绕 `StartCascade -> SendUserCascadeMessage -> GetCascadeTrajectorySteps/poll`。若文档、测试或代码仍把 `GetChatCompletions` 当主线，必须先纠正并物理删除该错误叙事/实现。
   - 调试与实现中，默认先检查 `~/.rcc/codex-samples/**` 的 same-shape 样本，再看代码；不要跳过样本直接脑补
   - 当前仓内只允许单一路径实现；后续禁止把任何已删除旧链路写回 Windsurf 文档、测试和实现

3. **WindsurfPostAuth 对齐规则**
   - **不能**把 `WindsurfPostAuth` 当普通 JSON 接口调用
   - 参考真源要求：
     - body：`application/proto`
     - body 为空（`Buffer.alloc(0)`）
     - header 必须带：`X-Devin-Auth1-Token: <auth1_token>`
   - 响应按 `WindsurfAPI/src/dashboard/windsurf-login.js::parsePostAuthResponseData()` 的观察真源解析：
     - `sessionToken`
     - `accountId`
     - `primaryOrgId`

4. **排查优先级**
   - 先判定问题是否仍在“鉴权链”：
     - `password/login` 是否拿到 `auth1_token`
     - `WindsurfPostAuth` 是否按 proto + header 正确发送
     - 是否成功落到 `devin-session-token$...`
   - 若以上已通，再看工具调用 / 历史 / continuity；不要把工具问题误判成认证问题
   - **调试顺序强制追加**：
     1. 先看 `~/.rcc/codex-samples/**` 里与当前 requestId / 时间段 / 端口命中的 sample / snapshot / same-shape 输入；
     2. 先比对 sample 中的 `messages / tools / tool results / stream / model / request body delta` 是否合理；
     3. 再去看实现代码；**禁止跳过 codex samples 直接凭日志表象改代码**。

5. **调试优先看固定参考目标（新增，强制）**
   - Windsurf 任务不要先全仓乱搜；固定先看：
     - `/Volumes/extension/code/WindsurfAPI`
     - `src/dashboard/windsurf-login.js`
     - `src/conversation-pool.js`
     - `src/cascade-native-bridge.js`
     - `src/windsurf.js`
     - `src/handlers/responses.js`
   - 先从这些目标提取锚点函数/shape，再回到 RouteCodex 对应实现。
   - **禁止先脱离参考仓自造边界解释。**

6. **Windsurf 调试先看固定参考与 codex samples（强制）**
   - 先看 `~/.rcc/codex-samples/**` 的同 requestId / 同时间段样本，先核对 request body、messages、tools、tool results、stream、model delta。
   - 再看固定参考：`/Volumes/extension/code/WindsurfAPI`，禁止先全仓乱搜或凭日志表象脑补。
   - 对 Windsurf，只允许围绕 `chat -> provider -> cascade` 真源排查；不得回到任何旧 transport 叙事。
- 调试 Windsurf 前，固定先看两个目标：`~/.rcc/codex-samples/**` 与 `/Volumes/extension/code/WindsurfAPI`；先对样本和参考锚点，再动代码。

6. **Cascade 语义测试真源（新增，强制）**
   - Windsurf 的 assistant/tool_result/history/continuity 测试，**必须先对齐参考仓锚点，再写测试**；禁止先凭主观推边界再补 case。
   - 固定语义锚点文件：
     - `/Volumes/extension/code/WindsurfAPI/src/handlers/responses.js`
       - `responsesToChat()`
       - `chatToResponse()`
       - 这是 Responses ↔ Chat 结构语义锚点
     - `/Volumes/extension/code/WindsurfAPI/src/windsurf.js`
       - `parseTrajectorySteps()`
       - 这是 Cascade trajectory step → assistant/tool/tool-result 观察面的锚点
     - `/Volumes/extension/code/WindsurfAPI/src/cascade-native-bridge.js`
       - `buildAdditionalStepsFromHistory()`
       - 这是 assistant tool_calls + tool results 历史如何注入 cascade additional_steps 的锚点
     - `/Volumes/extension/code/WindsurfAPI/src/conversation-pool.js`
       - `projectAssistantToolCalls()`
       - `projectMessage()`
       - 这是 continuity / digest / assistant text + tool_calls 投影锚点

7. **Windsurf 测试编写规则（新增，强制）**
   - 每补一条 `tests/providers/core/runtime/windsurf-chat-provider.spec.ts`：
     1. 先指出参考锚点文件 + 函数名；
     2. 说明该测试是在锁哪个 reference 语义；
     3. 如果 reference 里没有直接证据，只能先记入 `note.md` 为“待证伪/待证实假设”，**不能直接当真源测试**。
   - 允许写“RouteCodex 本地 fail-fast 真源”测试，但前提是：
     - 该 case 必须能从参考仓已有 shape/投影/trajectory family 合理推出；
     - 且在 `note.md` 明确标注“derived from reference anchor”，不能伪装成 reference 直接明文行为。

8. **Windsurf provider / cascade 实现禁止假设（新增，强制）**
   - Windsurf provider 的 cascade 实现，**不得脑补 endpoint / body / response / 轮询协议 / tool shape / history shape**。
   - 固定参考真源只有：`/Volumes/extension/code/WindsurfAPI`。
   - **实现、测试、调试都必须先对齐参考仓，再动本仓代码；不允许伪造，不允许假设，不允许自己编协议。**
   - 对齐目标是 **WindsurfAPI 的 cascade 观察真相**：鉴权链、tool call、tool result、history continuity、trajectory steps、additional_steps 注入方式。
   - 任何“我觉得应该是这样”的判断都不算证据；必须能指回 `WindsurfAPI` 的具体文件、函数、shape 或实机请求样本。
   - 如果参考仓没有直接证据：
     1. 先记入 `note.md` 为待证实假设；
     2. 不能写成正式测试真源；
     3. 不能写进 provider 主线实现。
   - 排查与实现顺序强制为：
     1. 先看 `WindsurfAPI` 对应锚点文件与函数；
     2. 再看 `~/.rcc/codex-samples/**` 的 same-shape 样本；
     3. 再写/改 RouteCodex 测试；
     4. 最后才改实现。
   - **禁止伪造 happy-path 测试**：如果 reference 没证明某条 send-path / poll-path / tool-path / history-path 存在，就不能写成“已验证主线”测试。

9. **Windsurf 工具真相（2026-05-23，强制）**
   - 已确认 native-equivalent：`exec_command` / `shell_command` 只能映射到 Cascade `run_command` 的 one-shot blocking shell 子集。
   - `apply_patch` 不是已确认 native-equivalent。Windsurf.app 仅确认 `write_to_file` / `propose_code` 是 trajectory/proto step，不能确认它们是可控 executor，也不能表达 Codex `apply_patch` 的 multi-file patch 与失败/aborted 语义。
   - 禁止把不完全兼容工具伪装成 native tool。此类工具只能二选一：显式配置打开 RouteCodex servertool 由 RCC 执行，或走 RCC 文本引导/收割。
   - Windsurf provider 当前 `apply_patch` 必须走 RCC 文本收割；不得再恢复 `apply_patch -> write_to_file/propose_code` native 伪装。
   - **禁止把未验证 cloud endpoint 当真源**：没有 reference 或实机证据的路径，不得作为实现前提，不得作为测试锚点。
   - 若 reference 未覆盖，而本地又必须处理，只能：
     - 明确标成 `derived from reference anchor` 或 `local fail-fast invariant`
     - 写入 `note.md`
     - 不能冒充成 WindsurfAPI 已证实行为。
   - **UA / app version 也不得脑补**：先对齐本机 `Windsurf.app` 真值；当前已验证版本为 `2.3.9`，所以 provider 内所有 auth/login/probe/send header builder 必须统一为 `User-Agent: windsurf/2.3.9`，禁止混入 `Mozilla/...` 浏览器指纹。
> 适用于 Hub Pipeline / Virtual Router / servertool / provider runtime / Rust 化收口。  
> 必须按顺序推进；没有上一步证据，不允许跳下一步。

### R0. 分步拆解（先定边界，不写代码）
1. 先把问题拆成最小阶段：入口、归一、治理、路由、provider payload、response contract、servertool orchestration。
2. 先确认唯一真源文件，再决定改动范围；禁止“先改一圈再看”。
3. 若改动跨多个阶段，必须显式说明每一段为什么必要；否则视为散改。

### R1. 先复现 / 先补测试（不改实现）
0.001 **用户已明确：遇到问题直接补红测，这件事不需要询问。** 若本技能缺该规则，必须立即写入本技能后再继续。
0. **遇到问题默认直接补红测，不询问是否要先写测试。** 只有用户明确禁止时才例外。
0.005 **先看 codex samples，再看代码。** 对线上/实机问题，优先读取：
   - `~/.rcc/codex-samples/**`
   - requestId 对应 snapshot
   - 同时间段 same-shape 请求
   若没有 sample，再明确记录“未捕获到 sample”，之后才进入代码分析。
0.01 **若运行/安装报错，先审请求/配置 shape 是否在入口被重建、丢字段或错路由。** 先确认输入真形，再看响应/错误分类；禁止先修 handler 或错误映射。
0.1 **若现有测试 helper 自带 fallback / 兼容桥 / 双路径补偿，先把 helper 清成 fail-fast 真相，再补红测；禁止让测试夹带 fallback 掩盖设计错误。**
0.2 **贴出响应报错时，先审请求 shape，再审响应处理。** 强制顺序：
   - 先抓 `provider-request` / outbound payload / same-shape fixture，确认请求字段、协议主形、历史消息、tools/tool_choice/stream 等是否已坏；
   - 只有在请求 shape 被证明确实正确后，才允许继续查看响应分类、contract、错误映射与处理分支；
   - 禁止看到 `502`、`EMPTY_ASSISTANT_RESPONSE`、`HTTP_502`、`completed+output=[]` 之类响应表象后，直接去修 response handler / error mapper / fallback。
0.22 **若问题属于 apply_patch，请先确认 chat process 真入口是否真的接线。**
   - 先确认真实请求主链命中的是哪一个入口函数，而不是只看 helper 是否存在；
   - 当前 RouteCodex 若是 chat process 问题，优先核对 `processChatRequestTools()` / 对应 request governance 主入口有没有真正串上 request-side normalization；
   - 禁止只测孤立 helper（如单独的 normalize 函数）就宣称主链已修复。
0.21 **apply_patch 专项：先锁“请求 shape 命中了哪条归一链”，再看结果。**
   - direct/provider-direct same-protocol 必须 payload identity passthrough；
   - relay/chat-process 才能把 schema 改成 internal line-edit；
   - response/outbound 才能把 internal line-edit 映射回 canonical apply_patch；
   - 任何额外 prompt/guidance/provider alias 都是污染点，必须先移除。
0.3 **mem-observer 先看 retention 指标，不先猜 GC。** 若 `requestMap` / `pendingNoResponseId` / `retainedInputItems` 同步增长，优先排查“capture 后是否漏了唯一收口（record/finalize/clear）”；对定向测试也先确认 `requestId` 等请求 shape 已带齐，否则会伪装成清理失败。
1. 先拿原 requestId / codex-sample / errorsample / 最小 fixture 复现。
2. 先补会红的测试：
   - shape / sanitize / compat：单测或 same-shape replay
   - followup / stopless / 路由：黑盒 replay 或样本回放
3. 没有“先红”证据，不进入修改阶段。

### R2. 最小修改（只改唯一真源）
1. 只改命中的唯一阶段文件。
2. 禁止顺手修 unrelated 逻辑。
3. 禁止 fallback / 降级 / 双路径补偿。
4. 若发现旧错误实现、重复设计、死代码，确认替代真源后物理删除。

### R3. 编译（先过最小静态门禁）
1. 先跑目标模块最小测试。
2. 再跑最小编译门禁：
   - Rust 侧：`cargo test` / native build（若命中 rust-core）
   - TS 侧：目标路径 jest / ts build
3. 编译不过，不进入构建安装。

### R4. 构建 / 安装
1. 需要落到真实运行时的改动，必须执行：
   - `build`
   - `install:global`
   - 受管 `restart --port 5555`（必要时 5520 / 10000）
2. 禁止把“源码测试通过”当成“运行态已修复”。
3. **用户已明确：以后重启服务器统一使用 `routecodex restart --port <port>`；禁止用 `routecodex stop --port <port> && routecodex start --port <port>` 或单独 `routecodex start --port <port>` 伪装重启。**
4. Responses + Windsurf 工具续接回归必须覆盖“streamed tool_calls 记录 provider context + 后续 `function_call_output` + restored tools 同时存在”，避免只测 previous_response_id 或只测 tools 的半链路绿。

### R5. 验证（必须包含原错误形状）
1. 必须复测原错误请求或 same-shape 样本。
2. 至少包含：
   - 1 条 failing-shape replay
   - 1 条 control replay
   - 1 次真实入口 smoke（如 `/v1/responses`）
3. **开发中修改后，必须先由 agent 自己完成真实入口 smoke，再允许让用户测试。**
   - 禁止在“仅单测/回归通过、未做本机真实入口验证”的状态下让用户先测。
   - 若本机真实入口 smoke 失败，必须继续由 agent 自己排查，不能把首轮验证责任转嫁给用户。
   - 只有 agent 已完成至少一次真实入口 smoke，并给出结果证据后，才可以请求用户做进一步复测或更复杂场景验证。
4. 验证内容包括：
   - 返回码 / finish_reason
   - provider-request / provider-response 形状
   - 日志阶段是否变成目标形态

### R6. 再做下一步
1. 只有 R5 完成后，才允许继续下一个问题或下一阶段重构。
2. 若 R5 失败，回到 R0，重新判定真源；禁止在错误假设上连续打补丁。
3. 汇报格式固定为：
   - 复现证据
   - 唯一修改点
   - 编译 / 构建 / 安装结果
   - 回归 / 实机验证结果
   - 下一步

## 开发与重构统一流程（强制 5 步，新增）

> 适用于所有功能开发、重构、Rust 化迁移。必须严格串行，禁止跳步。

1. **先对齐测试**
   - 先明确本次改动的测试边界：单测、定向回放、回归集、E2E。
   - 先准备“会红/可证明”的测试或样本，再进入实现。

2. **分片修改**
   - 每次只做一个最小可验证切片（单阶段、单真源、单责任）。
   - 禁止跨阶段大杂烩修改；禁止顺手改 unrelated 逻辑。

3. **每片后过单测与回归**
   - 每个切片完成后必须立即运行：目标单测 + 对应回归。
   - 未通过不得进入下一片；必须先在当前片内修复。

4. **端到端验证**
   - 切片级测试通过后，必须做真实入口 E2E 验证（含关键日志与形状断言）。
   - 对 Rust 化任务，必须补充 deterministic / rustification 审计门禁。

5. **再做下一步开发**
   - 只有在第 4 步证据完备后，才允许进入下一开发片。
   - 汇报必须包含：测试对齐结果、切片改动点、单测/回归结果、E2E 结果、下一步。

## Servertool Stopless/Followup 骨架（唯一改动导航）

### 2026-05-21 SSE 断流纠偏（新增硬规则）

1. **不要把"链路中存在 SSE"本身当成 bug**
   - 对 `/v1/responses`：即使客户端请求 `stream=false`，内部 upstream/provider 仍可使用 SSE；这属于实现细节，不是故障。
   - 真正要验证的是**客户端出站契约**：
     - `stream=false` → 客户端最终必须拿到 JSON，而不是可见 SSE。
     - `stream=true` → 客户端最终必须稳定收到完整 SSE，直到 `response.done`（**不是** `response.completed`）。

2. **看到客户端 SSE 反馈，不得误判为断流根因**
   - Codex/TUI/调试客户端在流式阶段显示 SSE 反馈是正常现象。
   - 只有在缺失 `response.done`、过早 close、或 JSON/SSE 收口契约错误时，才算真 bug。
   - Responses `requires_action` 工具调用态必须只有 `response.required_action` + `response.done`，禁止同时发 `response.completed`；否则 Codex UI 可能把工具调用回合判成完成而不执行/提交 tool output。

3. **5555/5520 断流排查优先级**
   - 先查公共层的 response contract / handler dispatch / SSE->JSON 或 JSON->SSE 收口。
   - 禁止先把 provider 内部使用 SSE 定性为错误，更禁止为此把 provider 强行改成懂 SSE 的耦合实现。
   - decoder terminal event 只认 `response.done` / `response.error` / `response.cancelled`；`response.completed` 不是 terminal。
   - `buildResponseDoneEvent` 必须发完整 `{ response: {...} }` 对象，禁止发 `data: [DONE]`（Chat API 格式）。
   - client disconnect detection：Symbol-keyed AbortSignal 不可序列化，只能轮询 `clientConnectionState.disconnected` 布尔值。

### 最近一次多轮事故修复沉淀（2026-05-19）

> 目的：把这次“反复改错位置/线上报新错”的经验固化为**唯一路径**，下次按图索骥，禁止散改。

#### A. 问题簇与唯一修复点映射
1. **followup payload 被强制 `stream:false`，上游仍回 SSE，导致 empty followup**
   - 现象：
     - `SERVERTOOL_EMPTY_FOLLOWUP`
     - 样本中 `payload.stream=false` + `body.__sse_responses`
   - 唯一修复点：
     - `sharedmodule/llmswitch-core/src/servertool/backend-route-mainline-block.ts`
     - `sharedmodule/llmswitch-core/src/servertool/backend-route-backend.ts`
     - `sharedmodule/llmswitch-core/src/servertool/backend-route-response-block.ts`
   - 修复原则：
     - followup 不强制改 stream；
     - SSE wrapper 不能被空响应判定误杀。

2. **把 SSE wrapper 当 canonical body 继续流转，触发 `MALFORMED_RESPONSE`**
   - 现象：
     - `[hub_response] Non-canonical response payload at chat_process.response.entry`
   - 唯一修复点：
     - `sharedmodule/llmswitch-core/src/servertool/backend-route-reenter-block.ts`
   - 修复原则：
     - 不得把 wrapper 当 body；
     - 只允许 canonical `followup.body` 进入后续 contract 检查。

3. **`/goal active` 时仍被标记为 servertool followup（错误参与）**
   - 现象：
     - goal active 场景下仍进入 followup 参与路径
   - 唯一修复点：
     - `src/server/runtime/http-server/executor/servertool-followup-dispatch.ts`
   - 修复原则：
     - goal active 时必须清除 `serverToolFollowup/serverToolFollowupSource` 标记；
     - 仅保留 `stoplessGoalStatus=active`，不参与 followup 标记链。

4. **Hub pipeline 运行时函数名错误导致全局 502**
   - 现象：
     - `createHubSnapshotStageRecorder is not defined`
   - 唯一修复点：
     - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-route-and-outbound-payload-blocks.ts`
   - 修复原则：
     - 使用当前模块真实导出的 recorder API（`createOutboundSnapshotStageRecorder`）；
     - 修编译时必须同时过运行时 smoke。

#### B. 本次确认后的“功能归属边界”
1. **followup stream / empty / retry 判定**：只在 `servertool/*followup*` 系列文件处理。
2. **canonical response contract**：只在 `conversion/hub/response/*` 与 reenter 出口对接，不跨层补丁。
3. **goal active 是否参与 followup**：只在 `server/runtime/http-server/executor/servertool-followup-dispatch.ts` 判定。
4. **pipeline 组装函数引用**：只在 `conversion/hub/pipeline/*route-and-outbound*` 处理，不在 servertool 兜底。

#### C. 强制执行流程（这类问题专用）
1. 先抓失败样本（`tmp/servertool-followup-empty/*.json` 或 requestId 同形样本）。
2. 先补回归测试（至少 1 条会红）。
3. 只改命中阶段唯一文件。
4. 本地定向测试转绿后，才允许 `build:min -> install:global -> restart 5555/5520`。
5. 线上复测 requestId 同类日志，不再出现原始错误码才可宣称完成。

#### D. 禁止事项（本次教训）
1. 禁止在一个回合里同时改 stream 语义、canonical contract、goal 路由三层以上逻辑。
2. 禁止“编译通过=修复完成”；必须看运行时日志是否变更为目标形态。
3. 禁止把 wrapper 直接塞进 canonical payload。
4. 禁止在 `/goal active` 下保留 followup 标记。

### 0) 目标
- stopless/followup 的请求必须“从同一入口进、同一入口出”：
  `HTTP /v1/responses -> Hub Pipeline -> servertool orchestration -> reenter /v1/responses`
- 禁止在半路手工造第二套 payload 语义；只允许基于 origin snapshot 做 delta。

### 1) 分层骨架（按阶段）
1. **Origin 捕获层（请求进入时）**
   - 文件：`sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-adapter-context-metadata-blocks.ts`
   - 职责：保存 `capturedChatRequest` 到 `adapterContext` + `origin-request-store`
   - 改这里的触发：followup origin clone 缺历史/模型/tools

2. **Origin 存储层（生命周期）**
   - 文件：`sharedmodule/llmswitch-core/src/servertool/origin-request-store.ts`
   - 职责：按 scope 存取 origin snapshot（TTL + 容量）
   - 改这里的触发：缓存泄漏、生命周期、跨轮丢 seed

3. **Delta 组装层（唯一构建 followup payload）**
   - 文件：`sharedmodule/llmswitch-core/src/servertool/backend-route-origin-delta.ts`
   - 职责：`seed + injection ops -> followup payload(messages)`，统一 tool/text/system/vision 增量函数
   - 改这里的触发：tool_call/tool_result 配对错误、文本增量错误、附件/vision 增量错误

4. **Shape 归一层（responses 入口合法化）**
   - 文件：`sharedmodule/llmswitch-core/src/servertool/backend-route-shape-guard.ts`
   - 职责：`messages -> input`、assistant.tool_calls -> function_call、tool -> function_call_output
   - 改这里的触发：`bodyHasMessages=true bodyHasInput=false`、shape 非法 400

5. **Reenter 执行层（重入 + 重试 + client disconnect）**
   - 文件：`sharedmodule/llmswitch-core/src/servertool/backend-route-reenter-block.ts`
   - 职责：统一 followup 重入、超时、终止条件、失败落盘证据
   - 改这里的触发：重试风暴、client 断开后仍重试、orphan_tool_result 证据采集

6. **编排层（策略入口）**
   - 文件：`sharedmodule/llmswitch-core/src/servertool/backend-route-mainline-block.ts`
   - 职责：选择 executionMode（reenter/client inject）、拼装 metadata、调用 reenter block
   - 改这里的触发：不触发 stopless、触发次数策略错误、/goal active 行为错误

### 2) 改动规则（防乱改）
1. 先判定故障阶段，再改对应唯一层；禁止跨层散改。
2. payload 语义问题优先查 1-4 层，不要先改 retry/router/provider。
3. 重试/超时/断开问题只改第 5 层。
4. stopless 触发策略只改第 6 层（不要在 handler、provider、router 各写一份）。

### 3) 测试矩阵（新增位置固定）
1. **shape 单元回放**  
   - `sharedmodule/llmswitch-core/scripts/tests/servertool-followup-shape-replay.mjs`  
   - 覆盖：text/tool_call/tool_result/multimodal/dedupe
2. **样本审计（日志+fixture）**  
   - `scripts/tests/stopless-delta-shape-audit.mjs`  
   - 覆盖：真实日志里 bodyHasInput/bodyHasMessages 合法性
3. **黑盒 e2e（当前构建物）**  
   - `scripts/tests/stopless-followup-blackbox.mjs`  
   - 覆盖：是否真实触发 followup、是否真正重入 /v1/responses
4. **故障重放（orphan）**  
   - `scripts/tests/replay-orphan-followup-sample.mjs`  
   - 覆盖：已捕获失败样本的 deterministic replay
5. **origin store 合约测试**  
   - `tests/servertool/origin-request-store.spec.ts`

### 4) 失败证据固化（必须保留）
- 文件：`sharedmodule/llmswitch-core/src/servertool/backend-route-reenter-block.ts`
- 规则：仅在 `orphan_tool_result` 失败时落盘
  `tmp/servertool-followup-failures/<followupRequestId>.json`
- 用途：线上失败 -> 本地 1:1 replay；禁止“凭感觉修”。

## 标准错误处理流程（强制顺序，先测后改）

> 任何 servertool/stopless/followup 问题，一律按以下顺序执行；顺序错误视为流程违规。

### S0. 先定错误类别（不改代码）
1. shape 错误：`bodyHasMessages=true && bodyHasInput=false`、400 invalid request shape
2. 配对错误：`orphan_tool_result` / tool_call_id 不匹配
3. 空响应错误：`SERVERTOOL_EMPTY_FOLLOWUP`
4. 路由/配额错误：`PROVIDER_NOT_AVAILABLE` / `context_length_exceeded` 等

### S1. 先补测试（不改代码）
1. **复现测试先红**：必须先新增或更新对应回放测试，让当前问题稳定失败。
2. 测试入口优先级：
   - shape/配对：`sharedmodule/llmswitch-core/scripts/tests/servertool-followup-shape-replay.mjs`
   - 真样本审计：`scripts/tests/stopless-delta-shape-audit.mjs`
   - 黑盒触发：`scripts/tests/stopless-followup-blackbox.mjs`
   - 故障回放：`scripts/tests/replay-orphan-followup-sample.mjs` 或新建等价 replay
3. 没有“先红”的测试证据，不允许进入改代码阶段。

### S2. 固化回归样本（不改业务逻辑）
1. 把失败请求最小样本固化到可重放位置（request/response/payload）。
2. 若线上样本难捕获，先加**最小诊断落盘**（仅失败分支）再复现一次抓样本。
3. 样本必须可由脚本一键重放，不允许人工口头复现。

### S3. 最小修改代码（唯一阶段点）
1. 只改命中阶段的唯一文件（按上文 1~6 层映射）。
2. 禁止跨层扩散修复；禁止加 fallback；禁止“顺手优化无关代码”。
3. 修改后先跑 S1 的红用例，必须转绿。

### S4. 回归闭环（必须）
1. 定向回归：新补测试 + 相关历史回归全部绿。
2. 构建链路：`build -> install:global -> restart --port 5555`
3. 黑盒复验：`stopless-followup-blackbox` 必跑，确认 followup 真实触发。
4. 日志验收：必须有 `payload_normalized`、`bodyHasInput=true`、`stage=final result=completed` 或明确失败分类。

### S5. 交付报告格式（固定）
1. 复现证据（哪条测试先红）
2. 样本固化位置（路径）
3. 唯一修改点（文件+原因）
4. 回归结果（哪些测试转绿）
5. 线上/黑盒验证结论

### 反模式（禁止）
1. 先改代码再补测试
2. 没有样本就“猜修复”
3. 单测绿就宣称线上修复
4. 一次改多个阶段文件导致真源不清

## 本技能硬护栏（fallback / 静默失败）

1. **严禁一切 fallback / 静默失败**：禁止吞错、禁止无声降级、禁止“看起来成功”的伪成功路径。
2. **发现即修（最小切片）**：在当前任务触达范围内发现 fallback/静默失败，必须顺手修复并给出验证证据。
3. **best-effort 边界**：仅允许用于观测/清理等非主链动作；即使 non-blocking 也必须可观测（日志/事件/节流），不得吞掉主链失败信号。
4. **proxy payload 语义边界**：主传输链 payload 必须完整翻译/转发、保持语义等价；禁止用 budget/history/media placeholder/自动续接 去裁切或改写真实主链。仅允许内部派生 followup 链做显式桥接（附件仅当前请求存在、不入历史；非视觉模型可注入 vision summary），且不得冒充主链 payload，也不得作为 fallback/静默补偿。
5. **错误路径改动必须复测原错误请求**：凡是修复错误请求、空响应、工具配对、servertool、兼容、重试/回退、history/payload 相关问题，**必须先复测原 requestId / 原 errorsample / 原 codex-sample**；禁止“只跑编译/单测绿”就宣称修好。
6. **不复测=未完成**：如果还没对原失败样本做 same-shape replay、实机复现或等价历史回放，就不能汇报“已修复”，最多只能说“已改代码，待复测”。
7. **servertool/stopless/followup 必须有 live-sample matrix 门禁**：凡触达 `reasoning_stop_guard_flow`、tool history 配对、responses→anthropic 出口、或 stopless contract，至少补 1 条“真实坏样本 same-shape 回放”回归；只写局部单测不足以宣称修复。

## Chat Process 定义

**Chat Process = `HubReqChatProcess03Governed` + `HubRespChatProcess03Governed`**

这是 Hub 请求/响应链中 inbound/outbound 之间的**核心处理阶段**，负责：
1. 输入输出协议归一化
2. 工具调用归一化（工具治理、兼容处理）
3. servertool 编排

**全局唯一的地方**，所有工具相关的处理都在这里。

### 当前拓扑节点

| 节点 | Rust 迁移遗留入口 | 功能 |
|---|---|---|
| **HubReqChatProcess03Governed** | `req_process_stage1_tool_governance.rs` / `req_process_stage2_route_select.rs` | 请求侧工具治理、history/tool 归一、路由前治理 |
| **VrRoute04SelectedTarget** | `req_process_stage2_route_select.rs` / `virtual_router_engine` | 路由分类与目标选择，不修 payload |
| **HubRespChatProcess03Governed** | `resp_process_stage1_tool_governance.rs` / `resp_process_stage2_finalize.rs` / servertool orchestration | 响应侧工具收割、finalize、servertool followup 编排 |

**注意**：`req_outbound_stage3_compat` 和 `resp_inbound_stage3_compat` 是 **provider 格式转换层**，不是工具治理的位置。
- 旧 `req_process_*` / `resp_process_*` 只能作为 Rust 文件迁移遗留名或历史排障关键词；当前文档、运行标签、红测和对外说明必须使用 `HubReqChatProcess03Governed` / `HubRespChatProcess03Governed` 等拓扑节点名。
- continuation/state 统一补丁（2026-04-17）：**非 Responses 协议的 response continuity 也必须在 `chat_process.resp` 恢复到 `chat.semantics.continuation`**；不要把 session/conversation 状态恢复留给 outbound remap。可复用动作：先看 `response-mappers.ts` 是否把 request-side `semantics.continuation` 回填到 chat response，再看 `buildProcessedRequestFromChatResponse` / outbound 是否只做映射消费。
- Responses continuation 路由模型护栏（2026-04-21）：若 `/v1/responses` 已在 `req_process_stage2_route_select` 命中过目标模型，后续 **route-aware continuation materialize** 只能恢复 history/messages/tools，**不得用 store 里的原始 responses `payload.model` 覆盖当前 workingRequest.model**；排查 5555/5520 出现“virtual-router-hit 是 A，providerRequestId/上游报错却是 B”时，先看 `route-aware-responses-continuation.ts` 是否把模型翻回 client/original model。
- Anthropic alias fidelity（2026-04-19）：`Bash/Glob/...` 这类客户端原始工具名必须同时落盘到 `semantics.tools.toolNameAliasMap + clientToolsRaw`，必要时再镜像到 `semantics.anthropic.*`；response-side client remap 只能消费这些 semantics 恢复原始 tool name，不能回读 metadata。

## 工具治理唯一真源

- Hub Pipeline Rust-only 铁律（2026-05-16）：`llmswitch-core Hub Pipeline / chat process / req_process / resp_process / servertool followup orchestration` 已经是 **Rust-only** 责任域；凡发现 TS 里还残留语义判定、followup tools sanitize、兼容修复、注入裁剪等第二实现，必须立即迁回 `rust-core/crates/router-hotpath-napi/`，TS 只保留薄壳调用。
- apply_patch 配置门控单一路径（2026-05-23）：client-facing 只暴露 `apply_patch`；默认 `[servertool.apply_patch].mode=client` 时 request/response 都透传 client 原生 schema/tool_call，servertool dispatch 必须跳过。显式 `mode=servertool` 时，唯一请求侧改写点是 Rust `req_process_stage1_tool_governance.rs`，upstream schema 为 `filePath + fileContent + patch(-/+ internal line-edit)`，response 由 Hub/servertool 本地执行并通过标准 followup 骨架回模型。TS/guidance/provider/system prompt 不得再注入第二套 apply_patch authoring 文本。
- req inbound tool normalize 唯一入口（2026-05-17）：`messages[].assistant.tool_calls` 与 `/v1/responses input.function_call` 的 ingress shape 修复必须共用 Rust `hub_req_inbound_tool_call_normalization`；至少统一三类工具：`exec_command -> {cmd,workdir}`、`apply_patch -> {patch,input}`、`write_stdin -> {session_id,chars}`。`req_inbound stage2 record`、`standardizedRequest`、followup/history 必须吃同一份归一结果，禁止 TS 再补第二语义面。
- Virtual Router shell 读写判定护栏（2026-05-17）：`virtual_router_engine/features/tools.rs::classify_shell_command()` 里，**read-only python/node 文件读取脚本必须归 thinking，不得掉进 tools/other，更不能因路径/正文含 write/patch 词误进 coding**；最小证据形状是 `python -c "print(Path(...).read_text())"` 与 `node -e "console.log(fs.readFileSync(...))"`。
- Responses tool-args scope 边界（2026-05-16）：`/v1/responses required_action/output function_call` 的 client args 归一（如 `exec_command command -> cmd`）必须先走 Rust `hub_resp_outbound_client_semantics` 的 schema-based SSOT；Host/TS 若在此之前直接校验并报 `CLIENT_TOOL_ARGS_INVALID`，属于 scope 越权。唯一修复点是在 Host validator 前复用该 Rust normalize，而不是放宽 TS validator。
- MiniMax fresh-session 2013 排查（2026-05-16）：如果新 session 一开始写文件就报 `provider_status_2013 invalid function arguments json string`，先抓 `provider-request.json` 看 assistant `tool_calls[].function.arguments`；若已是坏 JSON（常见于 `write_stdin` 只有巨大 `chars`、缺 `session_id`），唯一修复点在 Rust `hub_req_inbound_tool_call_normalization`，必须在 followup/request-history 入治理前做 shape-only 归一或物理删除坏 call+orphan output，禁止把坏历史再次发给 upstream。
- stopless non-goal followup 判定（2026-05-16）：`clientInjectSource=servertool.stopless_goal_continue` 只是**非 /goal bootstrap followup**，即使 adapterContext 持有 `stoplessGoalState=active`，也**绝不能**按 goal-managed followup 清洗 tools；这条判定必须落在 Rust goal/followup 真源，禁止 TS builder 再拼第二判断面。
- Codex namespace/deferred tools（2026-04-27）：`type="namespace"` + child `tools[]` + `defer_loading` 必须先在 **ingress/canonical** 原样保真；**只允许**在 non-responses outbound compat/request-build 侧做 namespace child flatten，responses-capable upstream 禁止提前 flatten。
- namespace tool 闭环（2026-04-27）：若 non-responses provider 需要 function-only tools，flatten alias 后**必须**在 client remap 用 `clientToolsRaw` 恢复成 `name + namespace` 客户端语义；禁止靠 provider capability 猜测或 host 侧硬编码补 computer-use。

### 请求引导（注入 heredoc）

| 文件 | 作用 |
|---|---|
| `req_process_stage1_tool_governance.rs` → `apply_unified_tool_text_guidance` | **统一入口** |
| `shared_tool_text_guidance.rs` → `build_tool_text_instruction` | **SSOT** 构建引导文本 |

### 响应收割（剥离 heredoc → function call）

| 文件 | 作用 |
|---|---|
| `resp_process_stage1_tool_governance.rs` → `strip_heredoc_wrapper` | 剥离 heredoc wrapper |
| `resp_process_stage1_tool_governance.rs` → `collect_harvest_text_variants` | 收割工具调用 |

**注意**：`hub_reasoning_tool_normalizer.rs` 的 heredoc 收割逻辑不在 chat process pipeline 中，是下游 conversion 层的二次清洗。

## Heredoc 协议

### 两种变体

1. `<<RCC_TOOL_CALLS_JSON\n{...}\nRCC_TOOL_CALLS_JSON`
2. `<<RCC_TOOL_CALLS\n{...}\nRCC_TOOL_CALLS`

### 收割流程

```
文本 → strip_heredoc_wrapper() → 剥离 wrapper → 内部 JSON →
       后续收割逻辑（extract_json_candidates_from_text 等）→ function call
```

**关键点**：heredoc 只是 wrapper，剥离后内部 JSON 格式和正常 function call 一样，收割方式也一样。
- DeepSeek-Web 收敛规则（2026-04-11）：响应侧工具收割优先用 **RCC heredoc 容器唯一来源**；容器外 prose/patch/quote/bullet 一律不得参与 tool 解析，避免把正文噪声误收成调用。
- DeepSeek-Web 边界修复只允许 **容器边界补闭合**（如缺尾标记时按容器尾部收束）；JSON 无法直接解析、tool 不在 allowlist、或缺必需字段时，按无效调用处理，不转正文启发式。
- DeepSeek-Web wrapper 白名单升级（2026-05-02）：deepseek-web 响应 compat 现走 **explicit-wrapper-only** 收割，白名单仅 `<tool_call>...</tool_call>`、`<function_calls>...</function_calls>`、`RCC_TOOL_CALLS(_JSON)`；quote/bullet/top-level JSON/generic `<command>` 外层一律不 harvest。shape 修复只允许容器内 JSON 补闭合 + allowlist 归一，不猜正文语义。
- DeepSeek-Web request/response 工具必出判定对齐（2026-05-02）：response 侧 `strict tools missing` 必须复用与 request 侧 `should_force_tool_required` **同一语义**；`coding` 路由即使声明了 tools，也允许 plain-text final + `finish_reason=stop`。但若出现 hidden tool-transport markup（如 `<use_mcp_tool>`）且无合法 wrapper/tool_call，仍必须 fail-fast。
- 收割命中后的内容清理规则（2026-04-11）：**只剥离 tool marker / heredoc wrapper，本轮剩余 prose 要保留**；禁止成功 harvest 后无条件 `content=""`，否则会吞掉容器外解释文本并让 provider 兼容行为漂移。
- XML 兼容收割补充（2026-04-11）：若上游仍吐出 `<execute_command>...<command>...` / `<apply_patch>...` 这类**反面教材**，只能在 `resp_process_stage1_tool_governance` 统一入口做兼容收割；禁止新增旁路入口。只要标签残缺但仍能恢复出足够参数，就按 allowlist + 参数 mask 归一为结构化 `tool_calls`。
- `execute_command` 兼容别名（2026-04-11）：响应侧必须归一到 `exec_command`，且 `cmd/command/workdir` 等已恢复字段尽量保全，不得靠“删字段/删工具调用”规避兼容问题。
- 文本工具收割边界（2026-04-12）：**要解析顶层工具壳，不要解析 shell 正文**。`apply_patch / execute_command / exec_command` 这类顶层 tag/name/wrapper/field alias 要兼容恢复；但 `bash -lc '...'` 里面的 body 一律只当字符串透传，禁止根据正文内容猜工具、拆命令、改引号或修空格。
- 缺 name 的 shell/apply_patch 负样本（2026-04-12）：如果响应只有 `{"input":{"cmd":"..."}}`、patch body、或类似 sentinel payload，但**没有明确顶层工具名/tag/wrapper**，不得推断成 `exec_command` / `apply_patch`；这类内容保留为正文或无效调用，让模型自己看到失败上下文。
- malformed 显式容器保留规则（2026-04-14）：若响应命中了 **RCC heredoc / 显式 wrapper**，但内部仍**恢复不出合法 tool_call**（如缺 `name`），**不得把 wrapper 清洗成空回复**；只能在“成功 harvest 合法调用”时剥离容器，否则保留原文交给客户端显式报错。
- shell text-tool canonical shape（2026-04-11）：请求引导统一要求 shell 只用 `exec_command + input.cmd`，且 `cmd` 必须是单字符串 `bash -lc '...'`；禁止再引导 `shell/command/workdir/cwd` 形状。
- shell 收割硬规则（2026-04-11）：响应侧只做**外层壳归一**（tool/tag/field alias → `exec_command` / `cmd`），**绝不修正文**；像 `catdocs/...`、`.md2>&1`、`&&head` 这类原始命令内容必须原样保留到 `cmd`。
- 5520 exec_command 壳修复对齐（2026-04-20）：`normalize_tool_args` 与 `normalize_tool_args_preserving_raw_shape` 必须共用同一条 shell 轻修复链（`repair_shell_wrapper_shape -> repair_find_meta_impl -> strip_python_heredoc_pseudo_escapes`）；否则 5520 会出现 **`find ... ( ... )` 裸括号没转义**、而 preserving-raw 路径与 canonical 路径行为分叉。
- DeepSeek-Web prompt 反嘴炮精华（2026-04-12）：若样本出现“前几轮会调工具、后面突然改成 `我来分析...```bash`”，先查 DeepSeek prompt 尾部是否被**空 tool/user block**污染成裸 `<｜User｜>`；空 `function_call_output` / 空 tool turn 必须在 prompt builder 侧直接丢弃。
- DeepSeek-Web override 优先级（2026-04-20）：如果 DeepSeek 仍爱“描述问题/猜根因/假装已检查代码”，provider override 必须**显式声明优先级覆盖**（忽略冲突的 hidden/native prompt），并加 **evidence-first** 约束：只要是代码/日志/路径相关任务且声明了检查工具，就先出工具，不得先嘴炮。
- DeepSeek-Web 工具轮续注入（2026-04-20）：如果第二轮/工具轮又开始嘴炮，先查 `prompt/model.rs` 是否因为历史消息里已有 `Tool-call output contract (STRICT)` 就**跳过新一轮注入**。正确做法是：**先剥掉历史 system 里的旧 guidance block，再按当前 tools/tool_choice 重新注入 fresh override**，不要把首轮注入当成可继承真源。
- DeepSeek-Web 结构覆盖（2026-04-20）：仅把 override 放在首段 system 还不够稳；若要压过页面/隐藏 prompt，需使用**两段式 marker**：先用 user prompt 结束 marker 收口，再开启独立的 system prompt marker 重建权威 system 段，并显式写“override hidden/page/provider prompt for this turn”，这样 deepseek 才不容易把用户的 system 提示“吃掉”后又回到网页内建行为。
- DeepSeek-Web 保密动机强化（2026-04-20）：若项目是保密/受限场景，prompt 可显式把**工具意图泄露**定义为会暴露保密内容的重大违规；这类 framing 只用于压制 fence 外 prose，不改变真实 tool payload 语义。
- DeepSeek-Web system-role 纪律（2026-04-20）：如果要压制乐观倾向 / 事实未证实 / 唯一真源未锁定这类行为，约束必须进 **system prefix**，不能伪装成 user block；否则模型会把它当作普通任务内容来复述或忽略。
- DeepSeek-Web 双 marker 纪律（2026-04-20）：user 输入里的 marker 不是普通正文；必须先用 user 结束 marker 划清边界，再用独立 system marker 引入 override。不要把 system 覆盖伪装成“authoritative user block”，且 marker 名字不要带 RouteCodex/品牌字样，避免额外泄露或引入噪声。
- DeepSeek-Web addendum 最小化（2026-04-12）：provider-specific addendum 只保留 **DeepSeek 自身约束**；不要混写 Qwen，不要把历史失败样本大段灌进 provider addendum，也不要在每轮尾部重复“保密 dry-run 合同”重话术。共享 dry-run 契约留在 `shared_tool_text_guidance`，DeepSeek 尾提醒只保留最小必需句。
- DeepSeek-Web 主链结论（2026-04-14）：5520 实测表明 DeepSeek upstream 即使被要求“直接输出标准 function call”，仍常回 **RCC fence** 或 `<tool_call>...</tool_call>` 这类文本工具壳；因此 **文本 fence 才是当前 provider 真正稳定主路径**，客户端看到的标准 `function_call` 只是 harvest/bridge 结果，不要反过来把“原生标准 function call”当 SSOT。
- DeepSeek-Web wrapper 泄露真因（2026-04-19）：若客户端同时看到 **已结构化的 tool_calls** 和残留 `<<RCC_TOOL_CALLS_JSON ...` 文本，不要先怪“请求 JSON 坏了”；高概率是真实链路里 **responses→chat 已先产出 structured tool_calls，但 `output_text/message.content` 里的 raw wrapper 没被二次清理**。修复铁律：**只要 tool_calls 已存在，也必须继续 sanitize `content/output_text/__responses_output_text_meta`**，否则就会出现“工具已执行 + raw wrapper 仍回显”的双写假象。
- DeepSeek-Web SSE 判定边界（2026-04-19）：**不要只用 `payload.tools[]` 判断 tool 请求。** `chat:deepseek-web` 的 text-tool compat 会把 `tools` 收进 `prompt`，runtime 只剩 `prompt + metadata.deepseek.textToolFallback/toolProtocol=text`；若 5520 出现 `UPSTREAM_SSE_NOT_ALLOWED`，先按这个 transformed payload 形状强制 upstream SSE。
- DeepSeek-Web runtime 装配边界（2026-04-30）：provider profile 的 `type: openai` 只是**协议提示**，不能在 `applyProviderProfileOverrides(...)` 里把 runtime `providerModule` 覆写成 `openai/openai-http-provider`；对 `chat:deepseek-web` 这类特殊 compat，必须保留 implicit module 推断，让 `ProviderFactory` 继续落到 `DeepSeekHttpProvider`，否则 `/v1/responses` 会先本地炸成 `missing model from virtual router`，还没到上游 429。
- DeepSeek-Web 路由护栏（2026-04-19）：若目标是**文本工具收割**，`thinking` 池也必须指向 `deepseek-chat`，不要把 `thinking` 绑到 `deepseek-reasoner`；否则当前轮 `thinking:user-input|tools:tool-request-detected` 会稳定落到 reasoner，表现为长时间 `finish_reason=stop` 且不出工具。`deepseek-reasoner` 只留给 `longcontext`。
- DeepSeek-Web context upload 判定（2026-05-12）：若日志出现 `DEEPSEEK_FILE_UPLOAD_FAILED` / `upload succeeded without file id`，先看 `~/.rcc/logs/server-*.log` 中 `[deepseek-file-upload] ... payload=...`；若 payload 是 `code=0 + data.biz_code!=0`（本轮实证是 `biz_code=9, biz_msg=unsupported file type`），真因是**上游业务拒绝**，不是 session 坏也不是 file-id shape 漏解析。修法只落在 upload contract：**text context 文件名必须显式带扩展名（`context.txt`）**，且 success 判断必须同时检查 `code` 与 `biz_code/biz_msg`。
- Virtual Router bootstrap 真源（2026-05-12，2026-06-07 修正）：若 live 日志出现 `Provider runtime <provider>.key1 not found`，先查 **native Rust bootstrap** `virtual_router_engine/provider_bootstrap.rs`；不要复活已删 TS `bootstrap/auth-utils.ts`。V2 `auth.entries` 里的空记录必须在 Rust `push_auth_entry_from_record` 入口直接忽略，否则会被默认 alias 规则物化成幽灵 `key1` runtime。
- llmswitch-core bridge 启动炸点（2026-05-12）：若 5520/CLI 启动期出现 `[llmswitch-bridge] Unable to load core module ... (Unexpected token ':')`，先用 `node --check sharedmodule/llmswitch-core/dist/...` 逐个验证 **dist 产物**，不要先怀疑 loader/bridge；这类错误高概率是 **坏的 llmswitch-core dist 被运行时加载**，唯一正确止血点是重建并替换对应 `sharedmodule/llmswitch-core/dist` 文件。
- DeepSeek-Web 文本工具硬护栏（2026-04-19）：**收割只认白名单 wrapper/mask**（优先 `RCC_TOOL_CALLS_JSON` / `<function_calls>`）；如果声明了 tools 却只输出“步骤/我先检查/命令列表”这类口嗨正文，没有命中白名单容器，就必须按“未产生有效 tool_call”直接报错重试，不能把 narrative tool intent 当成功响应放回客户端。
- DeepSeek / 文本工具 mask 白名单（2026-04-19）：高层收割入口只放行**显式壳**：`RCC_TOOL_CALLS(_JSON)`、`<function_calls>/<tool_call>`、Qwen marker、顶层 `{"tool_calls":...}`、以及声明工具后的 `Tool: <name> + Arguments:` 对；**`Calling:` / `exec_command(...)` 这类 function-style 口嗨一律不算合法 tool 容器**。
- RCC fence-first harvest（2026-04-20）：若现场样本是 `<<RCC_TOOL_CALLS(_JSON) ... RCC_TOOL_CALLS(_JSON)` 且内部 JSON 已坏，不要先赌 `serde_json`；必须先按 **fence/mask 裁边界**，只在 fence 内恢复 `tool_calls` 语义，wrapper 外 prose 原样保留。
- RCC nested-name 恢复边界（2026-04-20）：如果 `name` 只是错层级落在 `input.name / args.name / payload.name / function.name`，可以按 allowlisted tool 名恢复；但如果显式容器内仍没有安全 tool name，必须保留原文，**禁止猜成 `exec_command/apply_patch`**。
- allowlist 命中前置条件（2026-04-20）：对 bullet/prose/escaped transcript 中嵌着的 `{"tool_calls":...}`，可以先抽出**显式 tool_calls 容器**再恢复，但只有当**恢复出的至少一个 tool name 命中本轮 requested allowlist**时才允许进入清洗；若容器里只有未声明工具，必须保留原 wrapper 正文，不能因为“看见 tool_calls”就把现场抹掉。
- tool:exec_command 参数壳容错（2026-04-20）：`tool:exec_command (...)` + `<parameter name="command">...` 这种显式 tool label，即使 closing tag 残缺/错配，也应按**顶层 label 先锁容器**，再把内部 `<parameter>` 映射回 canonical `cmd`；禁止回退到从 shell 正文猜工具。
- RCC public TS surface 只做薄壳（2026-04-20）：`text-markup-normalizer` / `tool-harvester` 这类 TS 入口只允许转发 native 真源；不要在 TS 里另写一套 fence / JSON / name 推断逻辑，否则 public surface 会和 Rust 真源再次分叉。
- Responses submit_tool_outputs 真因（2026-04-20）：若 5520 现场首轮 `/v1/responses` 正常返回 `requires_action`，但 `POST /v1/responses/:id/submit_tool_outputs` 立刻报 `Responses conversation expired or not found`，先查 `executeRequestStageInbound`：**当 stage2 已生成 `responsesContext` 时，不要只写 CACHE 后直接短路返回；仍必须补做 `responses conversation store capture`**，否则 responseId 根本没入 store。
- Responses scope materialize 膨胀（2026-05-31）：若 `/v1/responses` 报 `orphan_tool_result ... already-consumed call_id: call_1` 且 mem-observer `pendingNoResponseId/retainedInputItems` 增长，先查 `shared_responses_conversation_utils.rs::materialize_responses_continuation_payload` 是否把完整 incoming history 当 delta 拼到 store prefix；纯 delta 才能 materialize，重放已完成 call_id 必须返回 Null 走原 payload。
- Responses submit_tool_outputs / Mimo thinking 400（2026-05-13）：若 `/v1/responses` 首轮 client payload 已有 `reasoning` item、continuation resume 也已恢复出 `assistant.reasoning_content`，但第二轮 `provider-request` 仍缺 thinking history 并报 `The reasoning_content in the thinking mode must be passed back`，先断在 **`chatEnvelope -> standardizedRequest`**：`router-hotpath-napi/src/hub_standardized_bridge.rs::normalize_chat_message()` 必须保留 `reasoning_content/reasoning`。不要去误改 continuation store、chat bridge 或 provider transport——一旦字段在 standardized owner 被吃掉，下游没有任何正确位置能补回来。
- DeepSeek-Web resume 续轮边界（2026-04-20）：若第二跳明明拿到了 tool result，却继续 `tool_calls` 循环或报“declared tools present but no valid tool call”，先分两层查：**请求侧** `tools/*` 路由在最新消息角色为 `tool` 时**不得再强塞 `tool-required` 尾提醒**；**响应侧** `strictToolRequired` 只应在 `tool_choice=required/function` 时生效，tool result 之后允许模型直接返回最终文本完成。
- QwenChat tools 边界（2026-04-12）：**qwenchat 不要改全局 system prompt**。当前 Jason 允许的最小方案是：**仅在声明 tools 时**做 request-side 最小 override（头部 prepend 一条极短 system 提示），再配合 `tools` schema/description；消息正文语义保持原样，响应 harvest 继续走统一 `resp_process_stage1_tool_governance`。
- QwenChat tool 实战结论（2026-04-13）：tool 场景要关闭 qwenchat upstream `thinking_*`，否则会放大嘴炮；关闭后它可能吐 **顶层函数样式文本壳**（如 `apply_patch(path=\"...\", content=\"...\")`），响应侧要在 `resp_process_stage1_tool_governance` 用**顶层壳 shape**收割，不解析 shell 正文。
- QwenChat tool follow-up 实测（2026-04-13）：5520 真实 `/v1/responses` 回放显示，最小 override 可以把 `tool_code_interpreter(...)` 这类内建工具幻觉压成“file inaccessible”式拒绝，但**仍可能不出 declared tool call**。若 `tool_choice=required` 下 qwenchat 继续返回 `completed + plain text refusal`，优先判定为**上游隐藏系统提示词压过最小覆盖**；下一步应只加强 **qwenchat 专属头部 override / tool descriptions**，不要回灌到 DeepSeek 共享层。
- QwenChat provider override 强化命中（2026-04-13）：若 qwenchat 仍报 “tool not found / file inaccessible”，provider 层头部覆盖要明确三件事：**declared tools 确实存在**、**external runtime 会执行**、**输出这类抱怨文本视为失败**。5520 live 验证后，qwenchat 已可从 plain-text complaint 转成 `finish_reason=tool_calls`。
- QwenChat malformed 新分支（2026-04-13）：若 5520 最新 `provider-response.json` 只吐出 `<<RCC_TOOL_CALLS_JSON` 或半截 dry-run 容器，先**直接从 SSE `delta.content` 拼回 assistant 文本**；能从半截 JSON/`cmd`/`patch` 恢复 declared tool call 就恢复，恢复不了就从 fence 开头整段切掉并显式报 **retryable** 错误，禁止继续糊成通用 `MALFORMED_RESPONSE`。
- QwenChat override 回归边界（2026-04-19）：**禁词/反诱导断言只检查 provider 注入的 override block**，不要扫描整段消息内容；用户/历史正文允许出现这些词。真正的上线验收仍看**模型实际输出**：若仍吐原生 `function_call` / 非预期工具壳，说明 override 目标未达成，不能投入使用。
- QwenChat live/source 不一致排查（2026-04-19）：若单测里的 `src/*qwenchat*` override 已更新，但 **5520 实测仍回 “unlock / capability verification / bypass safety”**，先直接检查 `dist/providers/core/runtime/qwenchat-http-provider-helpers.js`；qwenchat live 行为以 **dist 实际注入 prompt** 为准，build 前不要拿 src 文本当证据。
- QwenChat schema-first override（2026-04-19）：5520 实测表明，仅写“只用 declared tools”还不够；要在 provider override 里显式写 **tool 名 + 精确 input key schema + 最小 JSON example**（如 `exec_command => input { cmd:string }`，且明确 `cmd` 不能写成 `command`），这样 qwenchat 的文本 harvest 才能稳定对回原始工具列表。
- QwenChat create-session 高频 404（2026-04-19）：`/api/v2/chats/new` 的瞬时 404 在高频 burst 下可能可恢复；正确修法是 **provider 内部串行化同 alias create-session + 指数回退**，不要把一次可恢复的 404 立即上升成外层 provider 风暴。
- QwenChat create-session 404 日志边界（2026-04-19）：若 5520 实测里 qwenchat 最终请求都成功，但日志仍刷 `[provider-switch] ... QWENCHAT_CREATE_SESSION_FAILED 404`，应在 `request-executor` 把这类 **qwenchat provider.send 404** 降为内部 stage log；对用户侧/顶层日志，恢复成功的瞬时 create-session 404 应视为**已吸收的 provider 内部抖动**。
- QwenChat tools × webSearch 冲突（2026-04-19）：若请求里 **已声明 client tools**，即使 metadata/route 带了 `webSearch=true` / `chat_type=search`，provider request 也必须把 **`feature_config.auto_search=false` 且 `research_mode` 关严（默认 `off`）**；否则 upstream 会把“禁止原生搜索”的 prompt 与 `auto_search=true` 的 body 冲突解释成原生 `web_search`。
- QwenChat hidden-native-tool 止损顺序（2026-04-19）：非流式 `/v1/responses` 若仍遇到 `QWENCHAT_HIDDEN_NATIVE_TOOL`，要先在 **aggregate SSE reader 增量解析并即时中止**，不要等整条 upstream SSE 结束后才报错；随后在 provider 内部做 **同请求静默二次尝试**（如 `off -> disable`），优先把问题吸收到 provider 层，减少外层 provider-switch 噪音与长 `decode.sse` 假象。
- QwenChat non-stream 观测铁律（2026-04-19）：5520 live 若已确认 `stream:false` 正常、`decode.sse=0ms`，但日志仍看不到 `json/sse_fallback`，**不要脑补成功路径**；要么打真实 `qwen.nonstream=json|sse_fallback`，要么明确记成 `qwen.nonstream=missing`，把“marker 丢失”当成独立链路问题继续追。
- QwenChat false-positive tool-stop sample（2026-04-19）：若 `finish_reason=stop` 但 `message.content/reasoning/rawSse` 已出现显式 `<<RCC_TOOL_CALLS(_JSON)` 且带 `"tool_calls"`，provider 层**不要再写 `qwenchat-tool-stop-no-call` errorsample**；这类显式 RCC 容器应交给下游 harvest/recover，继续打样本只会制造噪声。
- QwenChat declared native tool absorb（2026-04-19）：若 upstream 直接走 provider-native `function_call/tool_calls`，但 **tool 名属于本轮 declared allowlist**（如真实 5520 样本 `exec_command`），provider 层应**直接吸收并映射成标准 tool_calls**，不要再报 `QWENCHAT_NATIVE_TOOL_CALL`；只有**未声明/已知隐藏原生工具**（`web_search/web_extractor/...`）才继续 fail-fast。
- QwenChat malformed 再分流（2026-04-13）：若最新真实样本里 `provider-response.raw` 出现 `phase=function_call.name=web_extractor` / `tool_code_interpreter` 等 **qwen 内建 native tool**，即使 bridge fallback context 丢了 declared-tool allowlist，也要在 `provider-response-converter` 直接 remap 成 `QWENCHAT_HIDDEN_NATIVE_TOOL`；不要继续落成通用 `MALFORMED_RESPONSE`。
- QwenChat hidden-native-tool 前置止血（2026-04-13）：`qwenchat-http-provider-helpers` 里对 `web_search / web_extractor / tool_code_interpreter` 这类**已知隐藏原生工具**的拦截，**不能依赖 declaredToolNames 非空**；否则一旦请求侧没把 allowlist 透传进 helper，live SSE 会先掉进 bridge malformed，再表现成 `finish_reason=unknown` 或空回复。
- 主链策略（2026-04-13）：**真实工具调用优先，文本 dry-run/harvest 只做兼容补救**。不要再把“彻底禁止模型原生工具”当硬前提；我们的职责是 RouteCodex 自己不依赖它，并在模型偷跑到隐藏原生工具、半截容器、或 malformed wrapper 时给出显式错误/恢复，而不是静默吞掉。
- QwenChat auth 透传闭环（2026-04-13）：`qwenchat-http-provider-helpers` 虽支持 `authHeaders`，但 **provider 本体也必须把 `authProvider.buildHeaders()` 过滤后的 `Authorization/Cookie` 传进去**；否则所有 qwenchat runtime 都会退化成 guest 语义，出现“同一组 runtime 一会儿能用、一会儿无权限/没资源”的假随机问题。
- Qwen Camoufox goto timeout 边界（2026-04-18）：`camo goto` 的 `page.goto timeout` 可能是**非致命**（页面已在 portal/qwen/google/callback）；处理要点是用 `list-pages` 判定是否已进入 OAuth 相关页并继续自动流程，同时抑制原始 Playwright 堆栈直出，避免把自动鉴权误判成“必须手动”。
- Qwen OAuth 浏览器边界（2026-04-18）：调试 **qwen code** 鉴权时，**禁止走默认浏览器/Chrome 路径做登录或取证**；只允许使用 camoufox 已录制的隔离 profile（如 `rc-auth.<alias>` / `rc-qwen.<alias>`）执行授权与验证，否则会把错误状态写进另一套浏览器会话，污染结论。
- Qwen / QwenChat 排查隔离（2026-04-19）：**调 qwen 时禁止查看、引用、推导 qwenchat 的实现/样本/结论；调 qwenchat 时也禁止反向引用 qwen。** 两者是不同 provider，只能各自沿本链真源排查，不能因为域名/页面相似就混用证据。
- Qwen transport 真相纠偏（2026-04-19）：`qwen` 必须沿 **Qwen Code / qwen-oauth / official `resource_url`** 链路走 `openai-http-provider`；`qwenchat-http-provider` 只属于 `qwenchat` / `chat:qwenchat-web`。若看到 `chat:qwen` 被隐式归到 qwenchat transport，这是错误分类，必须先修 `classifyQwenChatProviderIdentity` / provider-factory，再谈鉴权。
- QwenChat Uint8Array 边界（2026-04-13）：若 qwen upstream 经过 `Readable.fromWeb()` 后发出 `Uint8Array`，**不止 prelude inspect**，后续 `createOpenAiMappedSseStream / collectQwenSseAsOpenAiResult` 也必须统一用 UTF-8 decoder；只修 prelude 会让前置 business rejection 好转，但后段仍可能掉进 malformed/空回复。
- 文本 harvest mask 策略（2026-04-13）：当上游经常吐半截 fence / bullet / XML wrapper / heredoc wrapper 时，**先 mask 关键 wrapper，再只解析容器内顶层工具壳**，成功率会显著高于直接在全正文里做 JSON/regex 猜测。核心动作：1）识别 wrapper 起止与 bullet 噪声；2）只剥 wrapper，不吞容器外 prose；3）无明确 name/tag/container 时宁可报 invalid/retryable，也不要从 shell/patch 正文反推工具。
- 文本 harvest 可恢复性设计（2026-04-13）：请求侧引导要故意把工具调用放在**输出末尾、独立容器、参数保持肌肉记忆原形**（`exec_command.input.cmd` 单字符串 shell、`apply_patch` 原始 patch 字符串）。这样响应侧即使只拿到半截，也能按“容器开头以后整段切掉 / 局部补闭合 / 明确 retryable”稳定处理，避免正文污染。
- 空容器边界（2026-04-13）：`{"tool_calls":[]}`、只有 opener/closer、或 wrapper 内无有效 name/arguments 的内容，都**不算 harvest 成功**。处理规则应是“保留为正文或显式 retryable/invalid”，禁止把空容器当成工具轮完成信号，否则会制造 `finish_reason=stop` / 空回复 / 假成功。
- DeepSeek/Qwen 共用边界（2026-04-13）：**响应侧 harvest/mask 框架应共用**，因为稳定性来自统一容器边界与 wrapper-only 解析；但**请求侧 guidance 强度不要完全共用**。DeepSeek 保持共享 dry-run 契约 + 最小 provider addendum 即可，Qwen 才需要更强的“不要 native function call、只吐 RCC 容器”覆盖。
- XML exec wrapper 语义护栏（2026-04-14）：`<command>` / `<grep_command>` 这类 wrapper 只有在 body **明显像 shell 命令**时才能恢复成 `exec_command`；像 `<command-line>继续</command-line>` 这种 prose/控制词，哪怕 tag 名里带 `command` 也必须保留为正文，不能猜工具。
- QwenChat fence 设计边界（2026-04-13）：qwen 专属 override 要强约束“**不要只吐 opener**”，同时参数形状继续贴近模型肌肉记忆：`exec_command.input.cmd` 保持**单字符串 shell 原形**，不要拆 argv；`apply_patch` 保持 patch/string 原形，便于半截时做最小恢复。
- 5520 鉴权实查（2026-04-13）：5520 inbound auth 先看**进程环境变量** `ROUTECODEX_HTTP_APIKEY`，不要去配 `target`/config 绕路；本轮 live 验证已经确认 5520 不带 key 会直接 `Unauthorized`。
- QwenChat apply_patch 兼容（2026-04-13）：若上游吐 `apply_patch(path=..., content=...)` 这类可安全恢复的 shape，可在 harvest 阶段**仅合成 `*** Add File:` patch**；这样现有文件只会安全失败，不会被“自动修坏”。
- Qwen / QwenChat 共享工具定义强化（2026-04-12）：若 qwen-family 仍然嘴炮、不肯直接调工具，先不要碰 system prompt；优先把修复收敛到**共享的 tools schema/description**，明确“直接调用，不要先口头列计划”，并对 `exec_command.cmd` / `apply_patch.patch` 强化单字符串 canonical shape。
- DeepSeek-Web 历史工具示例对齐（2026-04-12）：历史 assistant `tool_calls` 进入 DeepSeek prompt 时，必须用**同一个 RCC heredoc 容器**包起来；不要一边要求“唯一正确格式是 heredoc”，一边在历史上下文里喂裸 `{\"tool_calls\":...}`，否则会削弱强约束并诱发模型改回 prose/code fence。
- DeepSeek-Web 历史 shell 示例 canonicalize（2026-04-12）：历史 assistant `exec_command` 示例进入 DeepSeek prompt 前，必须先做**外层壳 canonicalize**：只保留 `input.cmd` 与必要的 `justification`，并把 `command -> cmd`；`command/cwd/workdir` 这类 alias 绝不能继续喂回 prompt，否则模型会在后续 turn 里继续模仿坏字段。
- apply_patch native compat 边界（2026-04-12）：若 `*** Update File:` envelope 内仍是 legacy context hunk（如 `*** 123,4 ****` / `--- 123,4 ----`）且**没有现代 `@@` hunk**，native compat **不得先把旧 hunk 头剥掉**；要么原样保留给下游 normalizer，要么直接转成 `@@`。否则会制造新的 `unsupported_patch_format` 假失败。
- apply_patch shape-repair 边界（2026-05-09）：只要 wrapper/object 已经给出**足够完整的 patch 语义**（如 exact heredoc、`cmd/command + workdir + patch body`、nested result/payload/data 明确包裹），就应在 Rust compat 真源做**形状修复并回收成 canonical apply_patch**；但一旦需要解释额外 shell 命令、推断工具名、补 hunk 或补文件语义，就必须 fail-fast，禁止语义猜测。
- apply_patch schema-only 收口（2026-05-14）：移除旧 raw-tool-input 设计，工具定义必须用结构化 schema `{ patch: string, input?: string }` 引导；`patch` 内容仍是 `*** Begin Patch` / `*** End Patch` grammar。apply_patch 的 shape normalize / validate / guard 必须收口到 Rust `resp_process_stage1_tool_governance` 唯一入口；TS 只允许薄壳调用，不得保留独立 validator、guard patch builder、raw-tool hint、`raw_patch/raw` 猜测或 pre/post-governance 第二实现。
- apply_patch raw-string 恢复边界（2026-05-16）：如果响应里没有 `{patch,input}` 包装，但**整段参数本身已明确是 patch 文本**（如 `*** Begin Patch ...` 原文），应在 Rust `resp_process_stage1_tool_governance` 直接回收成 canonical `{patch,input}`；但若仍需要从 prose/shell 正文猜 patch 语义，必须 fail-fast，禁止扩成语义猜测器。
- native binding 完整性铁律（2026-05-16）：`native-router-hotpath-loader` 对自动发现的 `.node` 候选必须要求**完整 required exports**；禁止“先接受残缺 binding、再让 capability wrapper 运行时炸 `... is required but unavailable`”。新增 native capability 时，要同步补 `native-router-hotpath-required-exports.ts` 门禁并加回归。
- 响应工具 allowlist 闭环（2026-04-11）：`resp_process_stage1_tool_governance` 必须以 **requestSemantics / capturedChatRequest 派生的请求工具集合** 为唯一允许集；文本 harvest 要先按 allowlist 过滤再落 `tool_calls`，否则会误吞正文并把未声明工具透传到客户端。
- helper 对齐规则（2026-04-12）：若 TS/client helper（如 `processChatResponseTools`）与 chat pipeline 行为漂移，优先检查它是否绕开 `resp_process_stage1_tool_governance`。helper 必须先复用 unified resp-process native entry；旧 `hub_reasoning_tool_normalizer` 只能做**显式 name 的 malformed 文本 salvage**，不得恢复缺 name 的 shell/apply_patch 调用。
- Provider snapshot 背压精华（2026-04-13）：**provider snapshot 不要在请求路径直接 await 写盘**；必须走**有界异步队列**，并在队列满或内存预算超限时**丢弃最旧 pending item**。仅靠“本地最近 N 条保留”不能阻止慢磁盘/失败写盘把待写 payload 长时间堆在内存里。
- Anthropic multimodal 排查铁律（2026-05-05）：若请求已命中 `multimodal` 路由但 provider 仍在 `provider.send` 早期 `fetch failed`，**先验证 `input_image / image_url` 是否已在 anthropic transport 里规范化成 `type=image + source.{url|base64}`**；在确认标准图片 shape 已被消费前，禁止先改 remote-image/inline 策略。
- Errorsamples 背压精华（2026-04-13）：**errorsamples 也不能同步直写**；必须和 snapshot 一样走**有界异步队列 + drop oldest pending**。`429/502` 这类瞬时上游错误默认**直接跳过写盘**，否则最容易在重试风暴里把磁盘和内存一起打爆。
- 空 payload/空响应取证精华（2026-04-27 / 2026-04-28）：即使未开启 `--snap`，凡是命中**provider request 空消息/空 input**、**empty assistant**、或 **assistant sanitize 后变空**，都要**默认写 `errorsamples/payload-contract-error` + 强制保留 `provider-request/provider-response` 本地原始样本**；只留 errorsample 不足以做根因回放。
- `--snap` errorsample 真相保留（2026-05-07）：只要开启 `--snap`（或 full snapshot），`errorsamples` 就必须写**完整 payload**；禁止再落 `truncated/payload_too_large` 占位样本，否则会直接破坏故障复盘价值。
- tool history 配对铁律（2026-04-28）：`assistant tool_call/function_call` 与 `tool/tool_result/function_call_output` 必须**显式 id 一一配对**；禁止补 `fallback id`、禁止拿“最近一个 tool_call”隐式配对、禁止 orphan/dangling 继续上游，命中即 `MALFORMED_REQUEST/RESPONSE` fail-fast。
- Responses input seed 对齐（2026-04-29）：`/v1/responses` 历史 seed 里 `function_call` 的合法 id 来源是 **`call_id / tool_call_id / id` 同权**；任何只认其中一个字段的 sanitize/filter 都会把后续 `function_call_output` 错删，现场表现为 `dangling_tool_call`。
- servertool tool_call id 真源（2026-04-28）：internal servertool（如 `web_search` / `reasoning.stop` / `continue_execution`）若需要自有 `tool_call_id`，必须在 **servertool 抽取真源** 当场生成正式 `call_servertool_*` id，并让 assistant tool_call / tool_output / pending injection 全链复用同一个 id；禁止后续 bridge/history 层再 canonicalize 或补写。
- pending 污染清理铁律（2026-04-28）：`~/.rcc/sessions/**/servertool-pending/*.json` 属于可回灌真状态；一旦出现 `call_servertool_fallback_*` 或 tool-history 合约破坏，必须在 **load 边界直接丢弃并清文件**，不能继续注回请求，更不能在 bridge 层“兼容放行”。
- synthetic local control text 铁律（2026-04-28）：`[RouteCodex] assistant response became empty...` / `request timed out...` / `tool result unknown...` 这类**本地诊断文本**在 `chat messages`、`bridge input`、`responses conversation store` 三个入口都**禁止静默 filter/drop**；必须直接 `MALFORMED_REQUEST` fail-fast，防止旧污染被“清洗后继续跑”。
- 本地 control-plane 文本防污染（2026-04-28）：`[RouteCodex] request timed out...` / `assistant response became empty...` 这类**本地超时/降级/诊断提示**绝不能物化成 assistant 历史再回传上游；bridge input / chat normalize 入口必须剔除，命中 sanitize-placeholder 时必须转为显式错误，不得继续返给客户端。
- Token/usage 观测热路径精华（2026-04-27）：`usage` / token 累计这类**纯观测统计**禁止在请求主链同步写盘；请求路径只允许**内存累加**，落盘必须走**后台异步 flush + 原子 rename**，rollup 日志只打 **top N**，避免磁盘抖动和日志风暴反噬主链。
- 503/502 路由健康处理唯一改动位（2026-05-18）：遇到“503 连续命中同 provider/重启后又命中”时，**只查并只改三处**，禁止散改：
  1) `src/providers/core/runtime/provider-failure-policy-impl.ts`
     - `resolveProviderFailureExclusionDecision`：`HTTP_503` 必须 `excludeCurrentProvider=true + reroute_explicit_alternative`。
     - `isProviderFailureHealthNeutral`：`HTTP_503` 必须 `false`（允许上报影响健康）。
  2) `src/server/runtime/http-server/executor/request-executor-retry-decision.ts`
     - `resolveProviderRetryExclusionPlan`：必须把 `statusCode/errorCode/upstreamCode` 透传给 exclusion decision。
  3) `rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/events.rs`
     - `apply_classified_provider_error(Recoverable)`：`status==503` 必须走 `cooldown_provider_until_midnight_persisted`；
     - `extract_recoverable_cooldown_ms` 必须使用 `extract_status_code(event)`（不能只读 `event.status`）。
  验证门禁：日志必须出现 `switch=exclude_and_reroute`，且 `~/.rcc/sessions/provider-health.json` 出现该 provider 的 `state=tripped + cooldownExpiresAt>now`；重启后依然生效。
- 5555 ban 不生效真源补充（2026-05-18）：如果 **5555/quota 路由**上出现“`provider-switch` 已显示 exclude，但下一轮仍继续命中同 provider”，先看 Rust `virtual_router_engine/engine/events.rs::handle_provider_error()` 是否在 `quota_view.is_some()` 时提前 `return`。这会导致 **provider error 事件根本没进 health_manager / provider-health.json**，表现成“从来没 ban 过”。唯一真修复点就是移除这条 quota 短路，不能去 TS/Host 补第二套 ban。
- 503 ban 黑盒回归真源（2026-05-18）：这类问题不能只看 unit。必须重放真实链：`/v1/responses -> 5555 router relay -> request-executor -> upstream 503 -> provider-health.json persist -> restart -> 再次请求`。固定回归入口：`node scripts/tests/provider-503-ban-blackbox.mjs`；通过标准是 **第 1 次 hit dbittai 后 reroute 到 crs，第 2 次直接跳过 dbittai，重启后仍跳过 dbittai**。
- provider failure 黑盒入口更新（2026-05-18）：503/502 统一黑盒入口已收敛为 `node scripts/tests/provider-failure-ban-blackbox.mjs`。默认 gate 503；需要继续追 502 时追加 `--include-502`。
- 非多模态目标媒体泄漏排查（2026-05-19）：若 forced text-only provider 仍收到 `input_image/image_url`，先查 `hub-pipeline-adapter-context-metadata-blocks.ts` 是否把 metadata `__rt` 整体覆盖掉 target 注入的 `supportsMultimodal=false`。唯一正确修复点是 **adapterContext.__rt 合并且保留 target 派生字段优先级**；不要在 router-direct 或 provider shell 再补第二次 strip。
- 502 冷却排查门禁（2026-05-18）：若 502 风暴看起来“不进 3 次冷却”，先查 `src/providers/core/runtime/provider-failure-policy-impl.ts::isProviderFailureHealthNeutral()`；这里**绝不能**再把 `classification==='recoverable'` 整体当成 health-neutral，否则 502/500/504 全部不会进入 health_manager。若去掉后仍提前切 backup，则继续追“重复计数/第二 cooldown 面”，不要在别处补 ban。
- Snapshot 固定文件并发写精华（2026-04-18）：`__runtime.json` 这类**固定文件名**若会被 Rust hook 与 TS mirror 共同落盘，必须使用**create-if-missing / 原子链接或 rename**；禁止对同一路径直接 `fs::write` 覆盖，否则会出现“前半段旧 JSON + 后半段新尾巴”的拼接坏样本。
- Snapshot 双实现扫描动作（2026-04-18）：排查样本坏文件时，先 grep 同名文件是否同时存在 **native hook 写盘** 与 **host mirror 写盘** 两套实现；如果两边都写同一路径，只允许一边 `create_new`，另一边只能幂等跳过。
- DeepSeek 静默失败排查（2026-04-12）：若日志出现 `finish_reason=stop` + `no assistant content`，先查 `resp_process_stage1_tool_governance::sanitize_reasoning_fields_after_tool_harvest`。**ChunkingError / 沙箱失败正文只有在 message 已成功带上非空 `tool_calls` 后才允许去噪；无 tool_calls 时必须保留原始失败正文。**
- finish_reason 对齐铁律（2026-04-12）：**只要最终 payload 里有非空 `tool_calls`，`finish_reason` 必须是 `tool_calls`**；不允许让 `metadata.finish_reason=stop` 或其它旧字段覆盖它。排查点先看 `shared_responses_response_utils::resolve_finish_reason_impl` 与 `resp_process_stage2_finalize::normalize_choices`。
- provider-local text harvest fail-fast（2026-04-30）：像 `mimoweb` 这类 provider 兼容若做本地文本工具收割，命中**tool marker 存在但 harvest=0** 或 **assistant 原始输出为空** 时必须**直接抛错**；禁止回传空 assistant、禁止把原始 JSON/tool wrapper 当正常文本继续放行。
- mimoweb 工具续轮排查（2026-04-30）：若 `tool_result` 后上游重复同一 `tool_call` 或声称“没有这个工具”，先查两点：**(1)** provider 是否错误地每轮新建 `conversationId`，导致上游失去同会话上下文；**(2)** request serializer / loop detector 是否同时支持 **Anthropic blocks** 和 **OpenAI chat 原始 `assistant.tool_calls + role=tool` 历史形状**。这两点任一缺失，都会表现成“历史看似在，mimoweb 实际没吃到”。
- Mimo save/restore 自循环排查（2026-05-13）：若 `provider-request.json` 仍带完整 tools，但模型持续输出“我将调用工具/继续执行”这类 mirror assistant 文本且不真调工具，**先不要怀疑 tools 定义丢失**；先检查 save/restore 历史里是否出现重复 `assistant` 纯文本镜像轮次：`reasoning_content === content`、无 `tool_calls`。唯一修复点在 `chat-process-request-sanitizer`，并且只能做**shape-only** 清理。
- Mirror assistant 清理边界（2026-05-13）：清理必须按 **每个 tool boundary segment** 去重 mirror assistant cluster，不能只看最后一个 tool boundary；同时必须保留 Anthropic `assistant.content[].type=tool_use/tool_result` 真实工具块，不能把它们当 empty assistant 删掉。
- 反模式（2026-05-13）：禁止在 `request-executor-response-contract` 或 save/restore 清理链里加“句子像自言自语/像计划语句就删”的语义规则；这会制造第二实现面。这里只允许基于字段形状做归一和去重。
- mimoweb 空响应取证（2026-04-30）：若 `fullText=''` 且 `harvested=0`，除了 fail-fast，还要把 **`routeName / sessionId / queryLength / messageCount / toolDefinitionCount / assistantToolCalls`** 直接打进日志与错误文案；本轮实测 `queryLength≈200k+` 已可稳定触发空响应，先把真相返回给上游闭环，禁止继续黑箱重试。
- 上下文能力测试铁律（2026-05-01）：**只允许用完整显式历史重放**来测试 provider 的可用上下文与历史保真；**禁止**用 `conversationId/sessionId` 原生续聊模式来宣称上下文能力，因为那无法证明上游实际记录了哪段历史，也不等价于主链可控记忆。
- Web provider 隐藏会话污染（2026-05-01）：对 `mimoweb` / `deepseek-web` / `qwenchat-web` 这类 web 形态 provider，若复用 `conversationId/sessionId`，上游可能已缓存未知轮次、摘要或截断历史，导致**实际已占用上下文预算不可见**，现场表现就是同 payload 上下文测试忽大忽小、成功/超限/裁切随机漂移；因此上下文测试必须**每次新建会话 + 完整显式历史重放**，否则测到的是产品态隐藏记忆，不是主链可控上下文。

- 2026-05-16（Jason 约束）：新增且必要的文档与代码，默认直接纳入 track（git add）；不再为“是否加入跟踪”单独询问。
## PipeDebug 诊断流程

### 回归样本抽取与自动化（2026-05-17）

#### 何时必须抽样（触发条件）
满足任一条件就必须抽取真实样本进入 `tests/fixtures/` 并接入 matrix：
1. 同类错误出现第 2 次（例如重复 `400 tool_choice requires tools`、`EMPTY_ASSISTANT_RESPONSE`）。
2. 命中工具链关键失败（tools 丢失、tool_choice 形状异常、tool_call/tool_result 配对断裂）。
3. 命中跨协议 roundtrip 失败（responses<>chat<>anthropic/gemini/openai-chat 首尾语义不等价）。
4. 命中 servertool/stopless/followup 链路异常（必须有 live sample 回放）。

#### 抽取来源与最小文件集
优先从真实运行样本目录抽取（不要手造）：
- `~/.rcc/codex-samples/**/req_*/provider-request*.json`
- `~/.rcc/codex-samples/**/req_*/provider-response*.json`
- 必要时补 `__runtime.json`（用于 route/tool gating 证据）

每条 fixture 至少包含：
1. `request`（上游发送前真实 payload）
2. `response`（上游返回真实 payload）
3. `expectation`（要验证的 shape 断言，不写业务语义猜测）

#### 目录与命名规范（强制）
- 目录：`tests/fixtures/conversion-matrix/<yyyy-mm-dd>-<case-slug>/`
- 文件：
  - `provider-request.json`
  - `provider-response.json`
  - `assertions.json`（仅写 shape contract）
- case-slug 必须包含错误关键字：如 `tool-choice-without-tools` / `empty-assistant-output`。

#### 自动抽取执行步骤（固定流程）
1. 用 requestId 在 `~/.rcc/codex-samples`/`~/.rcc/errorsamples` 定位原始目录。
2. 执行自动抽取脚本复制最小文件集到 `tests/fixtures/conversion-matrix/...`：
   `node scripts/tests/extract-conversion-matrix-fixture.mjs --source-dir="<req_dir>" --case="<case-slug>"`
3. 在 `tests/sharedmodule/responses-cross-protocol-audit-matrix.spec.ts` 增加 `it.each(fixtures)` 驱动用例：
   - request roundtrip 断言
   - response roundtrip 断言
   - tools/tool_choice/tool_call_id 连续性断言
4. 运行定向回归；失败即阻断，不允许“先合并后补样本”。

#### 边界规则
- 只做 **shape contract** 断言：字段存在性、类型、配对关系、首尾协议等价。
- 禁止把“模型内容质量”写进该 matrix（避免把非确定性内容当回归门禁）。
- 样本若含敏感信息，做最小脱敏（key/token/path），但不得改动结构与字段关系。

### 错误请求复测铁律（先复测，再结论）

1. **先抓原样本，不准盲改**
   - 先用 `requestId` 在 `~/.rcc/errorsamples/`、`~/.rcc/codex-samples/`、`~/.rcc/logs/`（含 `/Volumes/extension/.rcc/...`）定位：
     - 原请求
     - provider-request
     - provider-response
     - 对应阶段快照
   - 如果是 `assistant sanitize 后变空`、`tool history contract violated`、`missing_tool_call_id`、`request timed out before a response was received`、`429/风暴` 这类问题，**必须优先找历史真样本**，而不是只看代码猜。

2. **修复后先打原错误请求**
   - 优先级固定：
     1. **原 requestId / 原样本 same-shape replay**
     2. **原问题的实机复现请求**
     3. **未受影响的 control/provider 对照回放**
   - 没有第 1 步证据，不得说“根因已解决”。

3. **空响应/空请求必须做 payload 二分**
   - 如果 provider 原始响应为空，先检查原始请求是否不规范。
   - 必须按“从最新一轮历史/最新 tool result 开始逐条减掉”的方式二分，确认到底是哪一轮 shape/tool 配对/history 污染触发了空响应或幻觉。
- 结论要区分清楚：
  - **请求形状有问题导致空响应**
  - **上游原始响应就是空**
  - **我们本地 sanitize/cleanup 变空**
- 2026-05-16 经验铁律：**空响应 = 请求有问题（shape/history/tool-pairing）优先判定，与 `finish_reason` 无关**。禁止用 `finish_reason=stop/tool_calls` 去否定“空响应问题”；先按 same-shape 样本做历史二分（从最后一轮 append/tool_result 开始）并锁定触发轮次。

4. **工具/结果配对必须复测真实链**
   - 任何 `tool_call_id` / `function_call_output` / servertool 相关修改，复测时必须验证：
     - assistant tool_call id
     - tool result id
     - pending/session 回灌 id
     - followup request 中的历史配对
   - 不能只看单点函数测试；必须确认**真实请求链里同一个 id 贯穿到底**。

5. **最小验收报告格式**
   - `原失败样本`：哪个 requestId / 文件
   - `修复前现象`：原错误
   - `修复后复测`：same-shape replay / 实机结果
   - `control`：是否未回归
   - `结论`：已修复 / 仅代码已改待复测

### 问题定位

1. 检查样本目录：`~/.rcc/codex-samples/openai-responses/`
2. 关键文件：
   - `req_process_stage1_tool_governance.json` — 看引导是否注入
   - `resp_process_stage1_tool_governance.json` — 看收割是否成功
   - `req_outbound_stage3_compat.json` — 看 provider 格式转换

### 常见问题

| 问题 | 原因 | 检查点 |
|---|---|---|
| `prompt is empty` | 请求格式转换丢失 messages | `req_outbound_stage3_compat` 的 payload |
| `finish_reason=stop` 无 tool_calls | heredoc 未被收割 | `resp_process_stage1_tool_governance.json` |
| 工具列表缺失 | snapshot summary 压缩了 tools | 检查 `req_process_stage1` 的原始 payload |
| qwen `invalid_parameter_error: bad request` | qwen-oauth 缺少首条 system envelope（`content:[{type:text,cache_control:ephemeral}]`） | provider `qwen-profile.buildRequestBody` 是否注入并合并 system messages |
| 路由池未耗尽却直接把 `429` 漏给客户端 | `request-executor` 把 `routingDecision.pool`（当前命中 tier）误当成整条 route 已耗尽，错误未进入 `exclude_and_reroute` | 先看 `request-executor` 的 `excludedProviderKeys` 是否累计当前 provider；**singleton pool 不能证明没有低优先级 fallback pool** |
| 想做“全局错误中心”收口 | 独立 center/event bus 只会形成第二中心，真正策略真源应在 Router | 先看 `docs/error-handling-v2.md` 与 `Virtual Router policy`；若某层只有 `emit/subscribe/normalize` 而不掌握 retry/reroute/backoff/fail，就应删除而不是升格 |

## 禁止事项

1. **禁止在 `req_outbound_stage3_compat` 或 `resp_inbound_stage3_compat` 中做工具治理**
2. **禁止静默吞错误** — 所有错误必须 propagate 或显式失败
3. **禁止重复处理** — 工具引导/收割只在 chat process 阶段，全局唯一

## 性能与预算精华（2026-04-06）

- 触发信号：`--snap` / retry 场景出现 OOM，同时日志窗口里 `provider-switch`、`ServerTool followup failed`、`SERVERTOOL_TIMEOUT` 密集共现。
- 可复用动作：先把根因锁到“风暴链 + 等待队列 + 大 payload retry/snapshot 放大”三件套；不要先怀疑 `~/.rcc/errorsamples` 这类小文件目录。
- 可复用动作：429 / concurrency / recoverable followup 一律保持“阻塞 + 指数回退”，但必须给 **recoverable backoff queue** 和 **provider traffic acquire queue** 都加 waiter 上限；否则只是把重试风暴改成排队堆内存。
- 可复用动作：本地盘 snapshot gate 要在 `provider.send.start` 之后、`processIncoming` 之前放行；如果等 provider 返回后才放行，`provider-request / provider-response / provider-error` 的本地 mirror 会整段丢失。
- 可复用动作：查 5555/5520 的 SSE snapshot 缺口时，不要只看 generic `postStream` 分支；`executePreparedRequest`（SDK transport）返回的 `__sse_responses` 也必须走同一套 `wrapUpstreamSseResponse + provider-response snapshot` 收口。
- 可复用动作：`client-response` / `client-response.error` snapshot 只能由 `SnapshotStageKind`（`shouldCaptureSnapshotStage(stage)`）控制；`ROUTECODEX_CAPTURE_STREAM_SNAPSHOTS` 只允许影响 provider stream capture，不能作为 client final response 的 env bypass。
- 触发信号：`SSE timeout after 1000000ms`、`PROVIDER_TRAFFIC_SATURATED` 高频、WindowServer watchdog/panic。
- 可复用动作：优先排查“深拷贝 + 双写落盘 + 超长超时”三件套；请求/响应大历史块一律走**零拷贝摘要（mmap-hint）**，禁止在热路径做全量 JSON 深拷贝。
- 日志口径边界（2026-04-12）：`[session-request][rt] internal` **不应包含 SSE decode**。若要看真正核心内耗，口径应为 `total - external - sseDecode`; rollup 的 `avg.core_internal` 只能再扣 `codec` 超出 `sse` 的残余，不能把 SSE 重复减两次。
- 反模式：在 handler / retry 路径对完整 payload 执行 `JSON.parse(JSON.stringify(...))`，会放大内存与 GC 抖动。
- 触发信号：`restoreRequestPayloadFromRetrySnapshot.oversized_skip` 频发（>2MB payload）。
- 可复用动作：重试种子优先保留 `structuredClone` 的对象快照；字符串快照仅作小体积辅助，超限直接弃用，避免“大 payload 无 seed”与 parse 噪声。
- client disconnect / timeout hint 续跑真因（2026-04-20）：若 5520/5555 已出现 `CLIENT_TIMEOUT_HINT_EXPIRED` / `CLIENT_RESPONSE_CLOSED`，但请求仍继续 provider-switch / backoff，先查 **attempt metadata clone** 是否把 `clientConnectionState` 上的**非枚举 abort signal**丢了；`decorateMetadataForAttempt` 这类 clone 步骤必须回填原始 state 引用。另一个高频坑是 **不要在 `req.close` 提前清掉 timeout hint watcher**，否则 `x-stainless-timeout` 会表面存在、实际失效。
- 触发信号：`SERVERTOOL_TIMEOUT` 出现 `followup timeout after 500000ms`，且伴随多 provider 重试风暴。
- 可复用动作：把 servertool/followup 默认超时收敛到 120s/90s（并设上限），并对 `reasoning_only_continue/ reasoning_stop_guard/ reasoning_stop_continue` 启用 auto-limit，避免无限续轮卡死。
- 触发信号：`429`（含 `insufficient_quota`）后立刻连刷 `provider-switch` / `PROVIDER_NOT_AVAILABLE` / `unknown-unknown-*` 新请求。
- 可复用动作：`429` 必须先按 **provider 维度阻塞 + 指数 backoff**；只有**已确认存在显式替代候选**时才允许 reroute。若无显式替代候选（尤其单 provider / singleton pool / routePool 缺证据），必须 **hold 当前 provider 等待**，禁止先自杀式 exclude 再把请求打成 `PROVIDER_NOT_AVAILABLE`。
- 触发信号：日志出现 `PROVIDER_TRAFFIC_SATURATED` + `exclude_and_reroute` + `PROVIDER_NOT_AVAILABLE` 连锁风暴。
- 可复用动作：对 `PROVIDER_TRAFFIC_SATURATED` 统一走 **same-provider 阻塞指数 backoff**（不排除当前 provider、不做 runtime-scope exclusion），并标记为 provider health-neutral；并发自适应只在“满并发样本”上做 **5 次无429升 / 5 次429降**，避免被短时抖动打到 `concurrency=1`。
- 触发信号：`provider.send` 命中 `fetch failed` / `ECONNRESET` / `socket hang up` / `network timeout` 后，下一批请求立刻出现 `PROVIDER_NOT_AVAILABLE`。
- 可复用动作：这类 **网络传输层错误** 必须按 **same-provider 阻塞 backoff + health-neutral** 处理；禁止把当前 provider 打进 reroute exclusion / router cooldown，否则单 provider 路由会被瞬时毒化成跨请求不可用。
- 触发信号：某个请求已经进入 recoverable backoff，但并发里的**新 sibling 请求**仍直接冲到同一 provider，继续刷 429 / fetch failed。
- 可复用动作：不要只做 session/request 内 backoff；必须额外加 **provider-scoped 全局等待闸门**，让 fresh requests 在 `provider.send` 前先阻塞，避免匿名请求或 `unknown-unknown` 会话绕过 session backoff 继续打风暴。
- 触发信号：recoverable 失败后，fresh requests 还没到 `provider.send` 就直接连刷 `unknown-unknown + PROVIDER_NOT_AVAILABLE`。
- 可复用动作：先查 **Rust virtual-router hotpath** 是否把 `minRecoverableCooldownMs / recoverableCooldownHints` 通过 `VirtualRouterError.details` 回传给 host；如果 native 只回 bare `PROVIDER_NOT_AVAILABLE` 字符串，host 就拿不到 `route_pool_cooldown_wait` 线索，前门一定会空池风暴。
- 全局判定铁律（2026-04-27）：**不可恢复错误 = 直接返回，不得 retry / reroute；可恢复错误 = 只能 block + 指数 backoff。** 先判断 recoverability，再决定是否等待；禁止把“所有错误都先切 provider 试试”当默认策略。
- 触发信号：Node 进程 **虚拟内存/常驻内存随运行时间单调上涨**，但 FD / TCP 连接数基本平稳，同时日志里长期存在 `429` / timeout / aborted / provider error。
- 可复用动作：优先排查 **requestId → meta/context** 的内存 Map（如 codec `ctxMap`、v2 pipeline `requestMetaStore`）；凡是“只在 `convertResponse` 删除、错误路径不清理”的，都必须补 **TTL + 容量上限 + 写入前 prune**，否则失败/中断请求会永久滞留并把 VM 慢慢顶高。
- 触发信号：热路径里的“仅供观测/调度”的 request Map（如 `StatsManager.inflight`、`RequestActivityTracker.byRequestId`）在长时间运行后缓慢变大，且正常路径理论上应在 `finally/end` 删除。
- 可复用动作：这类 Map 不要只信 happy-path 清理；统一补 **TTL + max entries + 每次读写前/后 prune**，并确保 prune 时同步回收派生计数（如 tmux active counts），避免长挂请求把非关键状态常驻在内存里。
- 触发信号：Responses/OpenAI bridge 出现 **registry Map + inline `__responses_*` 字段** 双保留，且同一 payload 还会按 `id/request_id` 多 key 缓存。
- 可复用动作：优先让 **registry 有 TTL/max/prune**，并让多 key 共享**同一份已克隆 snapshot 引用**；不要对同一个大 response 在 registry / inline / alias key 上重复 deep clone。
- 触发信号：session/tmux 相关路径出现频繁 `tmux has-session` 子进程调用（QPS 高时放大为进程风暴）。
- 可复用动作：对 `isTmuxSessionAlive`/`resolveTmuxSessionWorkingDirectory` 增加短 TTL 缓存 + 容量上限（默认 1.2s / 256 项），并在 kill/注入结果点做缓存失效或回写，避免每次 metadata/cleanup 都 spawnSync。
- 触发信号：heartbeat 周期内重复调用 `isTmuxSessionIdleForInject`，导致 `list-panes/capture-pane` 高频子进程创建。
- 可复用动作：对 idle 探针同样做短 TTL 缓存（仅缓存 true/false，异常不缓存），把缓存失效点放在注入前与注入后，确保性能和准确性平衡。
- 触发信号：session startup cleanup / registry cleanup 一轮内对同一 tmuxSession 多次活性探测。
- 可复用动作：在 cleanup 函数内部增加“单轮 memoized liveness cache”，与 probe TTL 缓存叠加，进一步降低重复探测开销。

- 触发信号：日志出现 `web_search-auto-capability`、`session=unknown project=-`，并伴随 `provider traffic lock acquire timed out` / `recoverable retry waiters overloaded`。
- 可复用动作：`web_search` 只能由**显式工具链**续写命中；禁止根据用户意图关键词或 `serverToolRequired` 自动切到 `web_search` 路由，否则匿名联网请求会绕开工具显式边界并放大成 provider 风暴。
- Rust/TS classifier 对齐（2026-04-12）：若线上仍出现 `web_search:servertool-required`，先查 **Rust hotpath** `virtual_router_engine/classifier.rs` 是否还保留旧分支；TS classifier 修好了但 Rust 没同步，5520/5555 仍会继续误命中。
- servertool → client remap 闭环（2026-04-12）：若日志出现 `CLIENT_TOOL_NAME_MISMATCH unknown=[review|clock|...]`，不要去放宽 client allowlist；先查 `strip-servertool-calls.ts` 是否按 **`tool_outputs.tool_call_id`** 剥掉所有已执行 servertool 调用，避免 internal servertool 泄露到客户端工具集合校验。
- followup 剥离护栏（2026-04-14）：若 `reasoning.stop` / `review` 这类 internal servertool 在 **followup** 样本里出现在 `required_action.submit_tool_outputs` 或 `output.function_call`，优先检查 `resp_process.stage2_finalize` 是否错误跳过 `filterOutExecutedServerToolCalls`；servertool followup 也必须剥离已执行 internal tool_call，不能因为 `serverToolFollowup` 标记而放行。
- followup 编排顺序（2026-04-14）：若 followup 样本里 internal RCC tool_call 只在 `resp_process.stage1_tool_governance` 后才出现，但 `resp_process.stage3_servertool_orchestration` 仍在 governance 之前且对 `serverToolFollowup` 直接 bypass，就会出现“统一请求注入了、统一响应收割却没吃到”的假象；要补 **post-governance servertool pass**，不能只靠 pre-governance orchestration。
- reasoning.stop 单一真源（2026-06-04 更新）：`reasoning.stop` 的 schema/注入只能以 **chat-process request tooling** 为真源；guard/followup 禁止再用 `preserve_tools` / `ensure_standard_tools` / `append_tool_if_missing` / `replace_tools` / `force_tool_choice` 等 DSL 补工具，followup 必须作为正常请求重新进入 ReqInbound -> ReqChatProcess。
- stopless 越界修复（2026-06-04 更新）：**不要为了逼模型调用 `reasoning.stop` 而砍掉、替换、补回或伪造工具面。** 正确动作是让 followup 走同一请求链，由 chat process 统一治理工具；若线上出现“exec_command 不存在”式自造阻塞，先查是否仍有 raw/context/metadata 或 followup DSL 回填工具。
- stopless 只读任务边界（2026-04-15）：若任务本身就是 **plan mode / audit / 其它有意只读交付**，`reasoning.stop` 说明与 schema 里要显式提供 `stop_reason=plan_mode`，并要求同时给 `is_completed=true + completion_evidence`；不要把这类任务误判成“必须继续写动作”或硬塞成 blocked reason。
- tool-call reject 可观测性（2026-04-14）：`provider-response-converter` 对 canonical client tool args 的拒绝，必须同时上浮 **toolName + validationReason + validationMessage + missingFields**，并继续映射到 HTTP error body；只报内部 reason code 会让模型/客户端都不知道到底缺了什么。

## 静默失败治理精华（2026-04-07）

- 触发信号：`catch {}` / `.catch(() => {})` 出现在 runtime 热路径（tmux probe、SSE write/end、startup cleanup、provider init/reporter）。
- 可复用动作：保持 best-effort 语义不变，但统一升级为“非阻断 + 可观测”：记录 `stage + requestId/providerKey/tmuxSessionId`，并对高频路径做节流日志。
- 重点补位：`provider-runtime-resolver`、`oauth-recovery-handler`、`daemon-admin/control`、`http-client` 这类“异常分支才触发”的路径，优先打点 non-blocking 日志，避免无声丢线索。
- 触发信号：每请求路径的 best-effort 注入（如 middleware header hint）若直接 `console.warn`，会在异常风暴时放大日志。
- 可复用动作：这类高频非关键路径必须加 stage 级节流（建议 60s），避免“修复静默失败”反向引入日志风暴。
- health probe / guardian / restart 判断精华（2026-04-16）：`fetch/json/auth` 异常若统一塌缩成 `false/null/status=n/a`，调用方会把“网络错 / 401 / 响应非法 / 服务真离线”误判成同一种离线；正确做法是返回结构化 probe result（`kind + status + parseOk + bodySnippet`），并只在最外层决定是否 fallback。
- 状态持久化 best-effort 精华（2026-04-16）：`cooldown` / `leader-lock` / `pending-tool-sync.clear` 这类“允许不中断主链”的状态写失败，也必须至少打一次节流日志并带 `operation + key/sessionId/providerKey + filepath`；否则线上只会看到重复 followup、冷却丢失、锁竞争异常，却没有第一现场。
- 2026-05-17 quota snapshot 归因补充：跨重启持久化只适用于 restart-stable 的容量/传输型 backoff（如 `E429`/`ENET`/`E5XX`/`quotaDepleted`/`blacklist`）；`EFATAL + auth/config`（含 `NEW_API_ERROR` / `AUTH*` / `UNAUTHORIZED*` / `CONFIG*` / `authVerify`）绝不能持久化，否则修好 token 后仍会被旧 cooldown 毒化成 `PROVIDER_NOT_AVAILABLE`。唯一正确修改点是 quota snapshot save/load sanitize，不是路由层或 provider fallback。
- 静默失败门禁精华（2026-04-16）：审计脚本不能只抓 `catch {}`；还要覆盖 `catch { return null/false }` 与 `.catch(() => null/false)`。固定证据入口：`scripts/ci/silent-failure-audit.mjs` + `tests/scripts/silent-failure-audit.spec.ts`。
- followup/blocked 辅助链阻塞精华（2026-05-09）：凡是 `stop-message` / `blocked-report` / followup sidecar 中的 `spawnSync(...)` 如果不在主链唯一路径且无实调用点，必须直接物理删除；这类同步子进程即使包了 timeout，也会卡事件循环，表现成 client 不断、请求静默挂住。
- 错误收口主链（2026-04-16）：排查 provider 执行期错误时，先确认主路径是否仍是 **`provider-error-reporter -> reportProviderErrorToRouterPolicy -> Virtual Router policy`**；如果又看到 `providerErrorCenter` + `RouteErrorHub` 双上报、或 HubPipeline 重新直接订阅 legacy center，优先判定为“第二中心回流”。
- stopless 硬校验（2026-04-16）：若 `stopless=on/endless` 但响应已 `completed/stop` 且缺 `[app.finished:reasoning.stop]` finalized marker，Host `RequestExecutor` 必须抛 `STOPLESS_FINALIZATION_MISSING`；不要把这种“完成但未 finalize”的响应当成功，避免客户端静默停住。
- provider-switch 退避边界（2026-04-16）：若 retry 已经决定 `exclude_and_reroute`，generic 401/403/非 blocking 错误的 backoff 也必须按 **provider 维度**计数，不能沿用全请求 `attempt` 指数增长；否则不同 provider 会被无端抬高 backoff，看起来像调度在“全局连坐”。
- provider-switch 观测口径（2026-04-16，2026-06-06 修订）：provider 错误不得同 provider retry；日志只允许 `switch=exclude_and_reroute`，`decisionLabel + backoffScope + stage` 至少要能证明是 `provider_backoff_then_reroute`，不得再出现 `retry_same_provider` / `*_same_provider` 标签。
- provider-switch 执行边界（2026-06-06）：`exclude_and_reroute` 后若路由池已耗尽，必须 fail-fast 返回最后一个 provider error；禁止在同一请求内 `provider.route_pool_cooldown_wait` 等待冷却，否则会表现为客户端 60s 超时 / `CLIENT_RESPONSE_CLOSED`。
- provider-switch 装配真源（2026-04-16）：`switchAction + decisionLabel + runtimeScopeExcludedCount` 不要在 `runtime_resolve`、`provider.send`、followup 各自手拼；优先收口到单点 helper（当前 `resolveProviderRetrySwitchPlan(...)`），否则日志口径和 reroute 排除策略会再次分叉。
- provider exclusion 真源（2026-04-16）：`promptTooLong`、Antigravity `verify/429`、`reauth`、alias rotate 这些“是否排除当前 provider / 是否把 antigravity 标成 `avoidAllOnRetry`”的规则，也要单点 helper 化（当前 `resolveProviderRetryExclusionPlan(...)`）；否则 reroute 行为会在 send/followup 边界重新分叉。
- provider retry 资格真源（2026-04-16）：`attempt/maxAttempts`、blocking recoverable、`promptTooLong` budget、Antigravity `verify/reauth` 的 retry 条件，也要单点 helper 化（当前 `resolveProviderRetryEligibilityPlan(...)`）；不要让 `runtime_resolve` 和 `provider.send` 各自维护一份 shouldRetry 分支。
- provider retry orchestrator（2026-04-16）：当 `eligibility / exclusion / switch / backoff` 都已有 helper 后，不要停在“四段手工串接”；继续把 `recordAttempt -> eligibility -> exclusion -> backoff -> switch` 收口成单一 async orchestrator（当前 `resolveProviderRetryExecutionPlan(...)`），让 `runtime_resolve` / `provider.send` 退化为 thin shell。
- provider retry telemetry（2026-04-16）：当 `executionPlan` 已存在后，`provider-switch` warn 和 `provider.retry` stage payload 也不要分支手拼；继续收口到 telemetry helper（当前 `buildProviderRetryTelemetryPlan(...)`），否则日志字段又会在 `runtime_resolve` / `provider.send` 间漂移。
- provider error reporting 装配真源（2026-04-16）：`errorCode/upstreamCode/statusCode/stageHint` 不要在 `runtime_resolve`、`provider.send`、followup 边界各自手拼；统一先过单点 helper（当前 `resolveRequestExecutorProviderErrorReportPlan(...)`），再交给 `reportRequestExecutorProviderError(...)`，否则 `provider.sse_decode` / `provider.followup` / `provider.runtime_resolve` 的阶段口径又会漂。
- provider error reporting marker 真源（2026-04-16）：`resolveRequestExecutorProviderErrorReportPlan(...)` 自己就要先读 `requestExecutorProviderErrorStage`（含 `details`）；不要要求调用方先手动 resolve fallback stage，否则“谁负责读显式 marker”会再次分叉。
- provider.http 单报规则（2026-04-16）：`converted` 出来的 retryable HTTP 401/429/5xx 不能先在 try 内 `emitProviderError('provider.http')`，再被外层 catch 二次上报；只允许打一个 `provider.http` stage marker，然后统一走 `reportRequestExecutorProviderError(...)`。
- provider.followup 健康边界（2026-04-16）：servertool/client-inject/followup payload 这类 `provider.followup` 错误本质是 orchestration/internal error，不得污染 provider 健康；`RequestExecutor` 要按 stage 直接判 `affectsHealth=false`，`emitProviderError(...)` 也必须尊重显式 `affectsHealth=false`，不能再用“non-recoverable 一律健康受损”覆盖。
- provider.followup 外层 fail-fast（2026-04-16）：**inner followup 可以在它自己的请求链内重试/切 provider，但 outer 主请求一旦拿到显式 `provider.followup` stage，必须停止继续 reroute。** 否则会把 followup 编排失败再次放大成主请求 provider 风暴。
- followup stage marker 前移（2026-04-16）：不要只靠 `SERVERTOOL_*` code 在 request-executor 外层猜 `provider.followup`；在 `provider-response-converter` 源头就给 followup 错误打 `requestExecutorProviderErrorStage='provider.followup'`，外层优先读 marker。
- sse-decode stage marker 前移（2026-04-16）：不要只靠 `SSE_DECODE_ERROR/HTTP_502/message contains sse` 在外层猜 `provider.sse_decode`；SSE wrapper / bridge remap 一旦确认来源于解码链路，就直接在源头打 `requestExecutorProviderErrorStage='provider.sse_decode'`，legacy `executor-response` 也要同步。
- host followup 源头 marker（2026-04-16）：`client-injection-flow` 这类 host 内部直接创建 followup/inject 失败错误的地方，也要直接打 `requestExecutorProviderErrorStage='provider.followup'`；不要把“已知是 followup 的 host 错误”继续留给 converter / request-executor 外层按 code 前缀猜。
- host followup dispatch 单点化（2026-04-16）：`executor-response.ts` / `provider-response-converter.ts` 里的 `reenterPipeline` / `clientInjectDispatch` 不能各自手拼 nested metadata、clientInjectOnly、nested execute；统一先过 `servertool-followup-dispatch.ts`，否则 followup 看似“回到普通请求链”，实际 host 壳层还是双实现。
- host followup error 单点化（2026-04-16）：`SERVERTOOL_*` → `provider.followup` 的 stage marker、compact reason、默认 502 不要分散在多个 converter/catch 里重复写；统一压到 `servertool-followup-error.ts`，这样 request-executor 才能稳定读到唯一口径。
- followup 最终可见日志单出口（2026-04-16）：`markServerToolFollowupError(...)` 只负责打 `provider.followup` marker 和默认状态，不要自己再 `console.warn`；真正面向运行日志的最终错误出口统一走 `convert.bridge.error`，否则同一次 followup 失败会出现“warn 一条 + stage log 一条”的双出口。
- recoverable SSE decode 日志边界（2026-05-13）：若 `provider.sse_decode` 错误已被分类为 `retryable=true`，`provider-response-converter` 不得再打红色 `convert.bridge.error`；这类中间态只允许记为 `convert.bridge.recoverable`（或等价非 error stage），真正的最终失败由外层 request 失败/`provider-switch` 决定。否则同一个 requestId 会出现“先红错、后 200 completed”的误导日志。
- executor non-blocking 日志 helper 单点化（2026-04-16）：`request-retry`、`provider-response-converter` 这类 executor 壳层的 non-blocking 日志，不要再各自维护 `formatUnknownError + throttle Map`；统一复用一个 stackless + throttled helper（当前 `servertool-runtime-log.ts`），否则日志口径会再次分叉。
- reasoning_stop_continue provider pin（2026-04-16）：若 servertool followup 需要保持原 provider/alias，**不要只读 `adapterContext.providerKey`**；真实线上常只有 `adapterContext.target.providerKey`。缺这层 fallback 时，`reasoning_stop_guard/continue` 会掉回默认路由池，表现为 followup 串到别的模型。
- router metadata builder 不可裁指令（2026-04-16）：如果 followup metadata 明明带了 `__shadowCompareForcedProviderKey`，但线上仍串 provider，先查 Rust `build_router_metadata_input` / TS `buildRouterMetadataInputWithNative`。这个 native builder 若不把 `__shadowCompareForcedProviderKey`、`disabledProviderKeyAliases` 从 metadata 根透传到 RouterMetadataInput，Virtual Router 根本看不到 pin/disable 指令。
- `thinking/forced` 快速定位（2026-04-16）：如果普通用户轮日志出现 `thinking/forced` / `tools/forced`，先查 `~/.rcc/sessions/.../session-*.json` 是否已落盘 `forcedTarget`；真源优先看 Rust `virtual_router_engine/engine/route.rs` 是否把 **metadata force/disableSticky** 误持久化进 session state。
- Provider v2 多文件约定（2026-04-16）：若 `provider/<id>/config.v2.<suffix>.json` 新 provider “加了但不生效”，先查 `src/config/provider-v2-loader.ts` 是否只加载 base `config.v2.json`；这类 suffixed 文件应被视为**独立 provider 文件**，且必须显式声明 `providerId/provider.id`。
- weighted 路由被锁首组（2026-04-16）：若 v2 路由只有 `loadBalancing.weights`、没有显式 `targets/order`，而线上总是只打第一个 provider/model，先查 Rust `engine/selection.rs` 是否把 **TS bootstrap 合成出来的 `mode=priority + strategy=weighted`** 当真优先级执行；Rust 真源必须让 `strategy=weighted` 胜出，不能让 synthetic priority 锁死首组。
- virtual-router bootstrap 真源（2026-04-17）：若路由配置已改但展开结果仍旧像“读缓存/认旧 provider”，先查 **Rust `routing/bootstrap.rs`** 而不是 TS `bootstrap/routing-config.ts`。现在 `normalizeRouting/expandRoutingTable` 已由 native `bootstrapVirtualRouterRoutingJson` 产出，TS 只保留 provider runtime/webSearch 薄壳；排查 weights/order/model 校验时以 Rust 输出为准。
- multimodal 实机验图边界（2026-04-18）：若 5555/5520 带图请求命中 `multimodal:media-detected`，但上游返回 `The image length and width do not meet the model restrictions [height:1 or width:1 must be larger than 10]`，先判定为 **测试图本身是 1x1/过小占位图**，不是 multimodal 路由失效。先对照 `provider-request.json` 看图片是否已变成 anthropic `image/base64`，live 验证必须改用 `>=16x16` 的真实 PNG/JPG。
- Auth 排查硬护栏（2026-04-18）：**除非 Jason 明确要求并授权当前轮触发认证，否则排查 qwen/gemini/antigravity auth 问题时一律只做静态审计（代码、日志、token 文件、官方实现对照）**；禁止主动拉起 `oauth`/browser/camoufox/device-flow，先证明“为什么现有 token / refresh 链路失效”。
- qwen daemon auto 边界（2026-04-18）：`token-daemon` 的 qwen 自动鉴权失败后**禁止自动回退 headful manual**；应直接失败并交给 auto-suspend/noRefresh 节流，否则 5555 会反复打印 device-code + manual fallback，形成“无限 OAuth”假象。
- qwen auto OAuth 收口（2026-04-19）：`qwen` 的 **auto OAuth 已整体移除**；background repair、token-daemon、root `oauth <selector>` 自动探测都不得再注入 `ROUTECODEX_CAMOUFOX_AUTO_MODE=qwen`。这类 provider 只允许显式手动 OAuth，不允许请求期/守护进程自动拉起浏览器。
- qwen 主配置隔离（2026-04-22）：`token-daemon` 会按 **当前 config 的 active routing providers** 决定是否扫描/刷新 token；若 `/Volumes/extension/.rcc/config.json` 仍引用 `qwen/qwenchat`，5555 主 lane 就会把所有 qwen alias 纳入 refresh 评估。可复用动作：把 qwen/qwenchat 全部移到独立 `config.qwen-5520.json`，主配置只保留非 qwen provider，避免 `Auto-refresh failed for qwen (...)` 多账号风暴。
- qwen 风暴判型（2026-04-22）：若日志先出现**同一个 request id** 的 `provider-switch attempt=...`，随后又刷出一串 **`openai-responses-unknown-unknown-*` 新 request id**，要先判定为“首个请求失败后，上游 client/session 在重发”，不是 `RequestExecutor` 单请求内部重试风暴；前者先查主配置是否仍把不稳定 provider 暴露给主 lane。
- virtual-router responses 当前轮边界（2026-04-19）：Responses `context.input` 判断 `latestMessageFromUser` 时，**不能只找最后一个 user message**；必须先看**最后一个有效 entry 的角色**（`message/function_call/function_call_output`），并只统计**latest user boundary 之后**的当前轮 tool 信号。否则会把 `user -> function_call -> function_call_output` 的续轮误判成 `thinking:user-input`。
- responses request replay 保参补口（2026-04-19）：若 `/v1/responses` 出站请求明明带了 `text/modalities` 等参数，但最终 wire 丢失，先查 `responses-mapper-from-chat.ts` 与 `responses-openai-bridge.ts`。**`chat.semantics.responses.requestParameters + 显式字段` 必须先回填到 chat/context，再在 `prepareResponsesRequestEnvelopeWithNative(...)` 之后补一次 missing request params**；否则 native prepare 只保留部分 host-managed 字段，看起来像“语义落盘了但出站没回放”。
- 协议兼容收口验收（2026-04-19）：**不要只跑 synthetic mapper/unit test。** 若要宣称协议映射“完备/兼容”，至少拿一份真实 `codex-samples` 的 `provider-request.json + provider-response.json`，分别走当前代码的 request replay / response replay，再对比 **hub canonical 输入** 与 **重放后的 outbound/client 输出** 关键字段；这一步会直接暴露像 Anthropic `system` 重复这类纸面测试看不出的真缺口。
- responses → Codex client 兼容点（2026-04-19）：对照 `~/code/codex` 时，**真正被消费的是 `output[*]` item 结构，不是顶层 `output_text` 摘要**。可复用规则：`message.content[*].type=output_text` 文本必须原样保留（禁止 trim / join 注入换行）；`reasoning` 若由 raw content 回填 summary，也必须**继续保留 `content`**，并显式带 `encrypted_content: null`，否则 Codex raw reasoning 模式会丢语义。
- Responses SSE 顶层 `output_text` 唯一真源（2026-05-09）：若 `/v1/responses` 的 SSE→JSON roundtrip 里 `output[*].content[].type=output_text` 文本存在，但顶层 `response.output_text` 缺失，不要在 bridge/test script/servertool 外层补洞；唯一正确修复点是 `sharedmodule/llmswitch-core/src/sse/sse-to-json/builders/response-builder.ts` 的 completed/required_action/incomplete/failed/salvage 完成态聚合，由该 owner 从 message output items 派生顶层 `output_text`。
- 多模态语义保真（2026-04-19）：协议经过 chat canonical 时，**图片块不能丢**；Anthropic `image` / OpenAI `image_url` / Responses `input_image` 都必须保持可逆映射，禁止被 `flatten_text` 或纯文本 normalize 吃掉。验收直接看真实样本 `provider-request.json` 的 request roundtrip compare。
- servertool compare 边界（2026-04-19）：`review/reasoning.stop` 这类 **servertool injected tools** 属于内部 feature，**不回客户端**；做协议矩阵 compare 时不要把它们当成客户端协议字段缺口，只比较真实 wire 可见的 client input/output 字段。
- qwen token 诊断优先级（2026-04-19）：若 qwen 出现反复 OAuth / refresh 失败，先分别验证三件事：`userinfo` 是否 401、runtime `/chat/completions` 是否 401、`/oauth2/token` refresh 是否回 JSON。若 refresh 直接回 **Aliyun WAF HTML** 或 access token 同时打不通 `userinfo + runtime`，应优先判定为**上游 credential / anti-bot blocker**，不是本地 header/UA 小差异。
- qwen official CLI 对照法（2026-04-19）：若已经把 `resource_url`、UA、DashScope headers 对齐官方实现，但 RouteCodex 仍报 `401 invalid_api_key / invalid access token`，下一步要直接用**官方全局 `qwen` CLI** 在临时 HOME 复现同一 token。若官方 CLI 也同样 401，则优先判定为**token/profile/upstream** 问题，不再把锅甩给 RouteCodex transport。

## qwen OAuth 精华（2026-04-07）

### 触发信号
- qwen provider 返回 `insufficient_quota` 或 `bad request` 错误
- qwen OAuth token enrichment 失败（`Invalid token payload for OAuth device code flow`）
- qwen vs qwenchat 配置混淆（两者是**不同 provider**）

### 关键区分：qwen vs qwenchat（不可混淆！）

| Provider | Endpoint | 模型名 | 认证方式 |
|----------|----------|--------|----------|
| **qwen** | `dashscope.aliyuncs.com/compatible-mode/v1` | `coder-model` / `vision-model` | OAuth access_token + `X-DashScope-*` headers |
| **qwenchat** | `chat.qwen.ai/api/v2` | `coder-model` | baxia tokens + web session |

### qwen OAuth Token 处理要点
- **位置**：`src/providers/auth/oauth-lifecycle.ts` → `prepareTokenForStorage`
- **必须处理**：
  - `expires_in` 必须是有效数字（从 `expires_at` 计算，或默认 21600 秒）
  - `access_token` 规范化为 string
  - `apiKey` 和 `api_key` 字段同步
- **失败表现**：token enrichment 报错 → 请求用错误格式 → compatible-mode 返回 `invalid_api_key`，旧 portal 常见 `invalid access token or token expired`

### qwen compatible-mode 请求格式要求
- **System message** 必须是 array + `cache_control`：
  ```json
  [{"role": "system", "content": [{"type": "text", "text": "...", "cache_control": {"type": "ephemeral"}}]}]
  ```
- **Headers** 必须完整：
  ```
  X-DashScope-AuthType: qwen-oauth
  X-DashScope-SSE: enable
  Authorization: Bearer <token>
  ```

### 常见错误与解决方案

| 错误 | 真实原因 | 解决方案 |
|------|----------|----------|
| `insufficient_quota` | token 格式错误，非真实 quota | 检查 `prepareTokenForStorage` 的 qwen 处理 |
| `bad request` | 缺少 X-DashScope headers | 检查 `qwenFamilyProfile` header injection |
| `model not supported` | 模型名错误 | 映射为 `coder-model` 或 `vision-model` |
| OAuth enrichment 失败 | `expires_in` 不是有效数字 | 在 `prepareTokenForStorage` 添加 qwen block |

### 调试流程
1. 确认 provider 类型：qwen vs qwenchat（**不可混淆**）
2. 检查 OAuth token：`~/.rcc/oauth/qwen/*.json` → 看 `expires_in` 是否为数字
3. 检查请求格式：system message array + X-DashScope headers
4. 检查 `prepareTokenForStorage` 是否有 qwen 专用 block
5. 参考 CLIProxyAPI：`/Users/fanzhang/Documents/github/CLIProxyAPI`（qwen CLI 真实实现）

### 反模式
- ❌ 混淆 qwen 和 qwenchat（endpoint/认证完全不同）
- ❌ 让 token 里的 `resource_url=portal.qwen.ai` / `chat.qwen.ai` 覆盖 qwen runtime baseUrl
- ❌ 忽略 OAuth enrichment 错误（token 格式错误会导致请求失败）
- ❌ 在 config.v2.json 中使用 v1 格式字段（`defaultRoutingPolicyGroup` 等）
- ❌ 把 Responses 原始 `input_text`/`input_image`/`input_video` 原样透传到 qwen upstream（会触发 400 `invalid_value`）

### 边界条件
- qwen OAuth token 默认有效期 6 小时（21600 秒）
- `expires_at` 是毫秒级 timestamp，计算 `expires_in` 时需除以 1000
- qwen OAuth 推理真源应对齐 `dashscope.aliyuncs.com/compatible-mode/v1`；`portal/chat.qwen.ai` 只可视为旧 auth/userinfo 痕迹，不能反向覆盖 runtime
- compatible-mode 的 system message **必须**带 `cache_control: ephemeral`

### 内容类型兼容精华（2026-04-07）
- 触发信号：qwen 返回 `Invalid value: input_text`（或同类 `input_*` 类型错误）。
- 可复用动作：在 `req_outbound_stage3_compat/chat:qwen` 统一归一化 `messages + input`：`input_text/output_text/commentary → text`，`input_image → image_url`，`input_video → video_url`，避免在 provider 请求层再分叉修补。

### Qwen Code 对齐精华（2026-04-10）
- 触发信号：provider-request 已有 `session_id/conversation_id`，但 response/servertool 侧 sticky scope 仍拿不到，表现为 stopless/stopMessage 失效。
- 可复用动作：不要在 transport 末端“header 倒灌 metadata”；正确修复是 **先在 metadata/runtime mapping 真层生成或归一 `sessionId/conversationId`，再映射到 provider header**。同时检查 raw metadata 提取链：JSON 字符串必须先 parse 再 regex，避免把 `codex_cli_conversation_*` 截成半截 token。

- 触发信号：portal.qwen.ai 可用但工具场景更容易 `finish_reason=stop`、且源码里的 qwen provider 头部/系统 envelope 与真实 Qwen CLI 漂移。
- 可复用动作：对 `chat:qwen` 先对齐 **非提示词形状**：保留首条 system envelope 的 `cache_control: ephemeral` 结构、补齐 `X-Stainless-*` 头、并把 `reasoning.effort` 同步镜像为 `reasoning_effort`；同时对齐 Qwen CLI 的 header 习惯，`User-Agent / X-DashScope-UserAgent / session_id / conversation_id / originator` 都不要透传客户端值，统一按 qwen-cli 指纹重建。未经授权不要改 system/prompt 文本。

- 触发信号：qwen provider 配的是 DashScope compatible base，但日志/错误样本仍漂到 `https://portal.qwen.ai/v1`，token 文件里同时出现 `resource_url=portal.qwen.ai`、`api_key==access_token`、`norefresh=true`。
- 可复用动作：把这组字段视为 **legacy 污染**：qwen runtime 必须忽略 `portal/chat.qwen.ai` 的 `resource_url` 覆盖；token 落盘时必须丢弃 fake `api_key=access_token` 与随之产生的 `norefresh`，只保留真实 `access_token/refresh_token`，若 userinfo 返回独立稳定 apiKey 才写回 `api_key + norefresh`。

- 触发信号：qwen 的 `User-Agent / X-DashScope-* / X-Stainless-*` 已与 Qwen CLI 对齐，但工具场景仍更容易 `finish_reason=stop`。
- 可复用动作：不要继续怀疑 header；优先检查 `chat:qwen` 是否像当前历史回归那样改写了**非 system messages**（删除空 assistant/tool turn、回填 `tool_call_id`、重写 tool call id 等）。Qwen CLI 真实现只做 system envelope 注入/合并；最小正确修复是保留非 system history 原样透传，响应侧继续按客户端语义对称恢复。

- 触发信号：`/v1/responses` 的 Qwen 样本里 upstream 明明已有 1 个 native `tool_calls`，但客户端返回出现重复 `function_call` 或额外空参数 `{}` 调用；同时 `reasoning_content` 里常带 XML/JSON 形式的工具片段。
- 可复用动作：优先检查 **response-side reasoning normalizer**，不要只盯 provider request/header。若 assistant 已经有结构化 `tool_calls/function_call`，必须禁止再从 `reasoning_content` 二次 harvest；否则会把 reasoning 里的示例/XML/JSON 再抽成第二个工具调用，污染后续多轮上下文并放大成莫名其妙的 `stop`。

- 触发信号：`stopless` 明明已开启，但在线表现仍像完全没生效；`reasoning-stop-guard.spec` 同时从 “tool_flow” 退化成 “passthrough”。
- 可复用动作：先查 `reasoning-stop-guard` 这类 **post-hook** 是否误从 `ctx.base`（响应）读取 request-only 字段（如 `tools`）；在 servertool auto hook 里，`ctx.base` 默认是模型响应，不是原始请求。请求级判定应改读 `capturedChatRequest` / sticky session state，而不是 response payload。
- 触发信号：直连 `/v1/responses` 或 direct-model 场景里，request 已带 `<**stopless:on**>`，但 response 侧 followup 没触发，sticky state 里也没有 `reasoningStopMode`。
- 可复用动作：先查 response converter 是否在 `bridgeConvertProviderResponse` 前**回填 `capturedChatRequest + sessionId/conversationId` 并立刻调用 `syncReasoningStopModeFromRequest`**；其次检查 `reasoning-stop-guard` followup 是否仍通过 raw/context/metadata 或 followup DSL 补回 `reasoning.stop` 工具，发现即删，避免续轮工具面漂移。
- 触发信号：router、stop_message、sticky state 对同一轮 continuation 给出不同 sticky key，或只有 Responses 能续轮而 openai-chat / anthropic / gemini 走回 session/request fallback。
- 可复用动作：先查 `sharedmodule/llmswitch-core/src/router/virtual-router/engine/routing-state/keys.ts` 是否仍被旁路；`request_chain/session/conversation/request` 必须都从统一 continuation helper 解析，`stop-message-auto/runtime-utils.ts` 之类 sidecar 只能复用该 helper，`responsesResume.previousRequestId` 只允许保留为 migration fallback。
- 触发信号：`stopless:endless` 文案说“绝不停止”，但真实需求是“完成可停、不可抗阻塞也可停”，线上表现出现文档/提示词/validator/finalize 四处语义打架。
- 可复用动作：把 **停止条件** 固化成单一真源：`completed + completion_evidence`，或 `attempts_exhausted=true + cannot_complete_reason + blocking_evidence + next_step 为空`（若需用户参与再加 `user_input_required + user_question`）；同步检查 tool schema、validator、summary parser、finalize gate 与设计文档是否完全一致。

### Qwen OAuth 多账号实操精华（2026-04-10）
- 触发信号：`qwen-auto`/device-code 已打开浏览器，但页面 selector 漂移、Google/Qwen 跳转链变长，导致自动点击卡在 `element_not_found:qwen_authorization` 或长时间 timeout。
- 可复用动作：**保留原 device-code 框架，不改提示词**；对每个 alias 只使用其隔离 profile（`rc-auth.<alias>` / `rc-qwen.<alias>`），先在 `rc-auth.<alias>` 完成 `chat.qwen.ai/auth?user_code=...` → Google account chooser → Qwen 已登录首页，再重新访问 `authorize?user_code=...` 并点击 `.qwen-confirm-btn`；成功后立即 `camo stop` 关闭该 alias 浏览器，避免串号/泄露。
- 触发信号：portal `Continue` 后并不直接跳 Google/`/authorize`，而是**先停在 `https://chat.qwen.ai/auth?...` 登录页**，随后 device-code 长时间 timeout。
- 可复用动作：qwen auto 必须把 **portal → qwen `/auth` 登录页 → Google OAuth** 当成合法链路；不要只等 Google/confirm。若 `/auth` 是晚到页面，也要继续点击 `.qwenchat-auth-pc-other-login-button` 把流程推进到 Google，否则会出现“浏览器已打开但自动化提前停住”的假成功。
- 反模式：在不同 alias 间复用浏览器；账号已成功还留着 session；在 Google consent 页用宽泛 selector（如 `button:last-of-type`），容易点到无关按钮而不是“Continue/继续”。
- 触发信号：qwen 明明已有多个 token 文件，但线上 provider 仍只像在用一个账号，且主配置里只有 `tokenFile: "default"`。
- 可复用动作：qwen 多 token 的**主真源**是 `~/.rcc/provider/qwen/config.v2.json` 的 `provider.auth.entries[]`；不要再拆多份 `config.v2.<alias>.json` 企图替代主配置。修完后先用 bootstrap 真源确认展开出 `qwen.<alias>.<model>` 多 runtime，再 `SIGUSR2` 热重载并用在线请求/日志验证。

### OpenAI-compatible chat reasoning outbound 精华（2026-04-11）
- 触发信号：`/v1/chat/completions` 客户端在 `reasoning_details` 上报 `sequence item 0: expected str instance, dict found`，或 Python `''.join(message['reasoning_details'])` 直接崩溃。
- 可复用动作：**不要删除 `reasoning_details` 逃避兼容问题**；保留结构化真源在 `message.reasoning`，保留主文本在 `message.reasoning_content`，同时把兼容投影 `message.reasoning_details` 规范为 `Array<string>`（例如 `[type] text`），做到信息不丢、客户端可 join。
- 验证：Rust outbound 单测 + `tests/monitoring/resp-outbound-stage.test.ts` 断言 `reasoning_details.join('')` 可用 + 5555 live chat 验证 `reasoning/reasoning_content/reasoning_details` 三者同时存在。
- 本地 DeepSeek thinking 历史形状短路（2026-05-10）：若 `omlx/rapidmlx` 的 `DeepSeek-V4-Flash-mxfp8` 在 `/v1/responses` 或 openai-chat thinking 链上报 `ThinkingMode: thinking, invalid message without reasoning_content/tool_calls`，先查 `req_outbound_stage3_compat/request_stage.rs` 是否被某个 **未知 request-stage profile**（如 `search/omlx-search`）短路；`assistant history -> reasoning_content` 补齐必须挂在 provider/model/protocol 判定上统一执行，不能再受 `profile.is_none()` 之类条件限制。

- apply_patch 三段透明桥接事实（2026-05-23）：relay/chat-process 请求侧 schema 由 Rust `req_process_stage1_tool_governance.rs` 改为 internal line-edit；响应侧由 Rust `resp_process_stage1_tool_governance.rs`/`hub_resp_outbound_client_semantics.rs` 转回 canonical `*** Begin Patch`；下一轮工具结果由 Rust `hub_req_inbound_tool_call_normalization.rs` 把 executor 成功/失败转成 `APPLY_PATCH_RESULT`/`APPLY_PATCH_ERROR` internal line-edit 语义。模型不能看 canonical schema，client 不能看 internal schema。

## 服务器重启与热加载（合并自 rcc-server-restart）

### Jason 重启固定动作（2026-04-14）
- 触发信号：Jason 直接要求“编译 / 全局安装 / 重启 5555 和 5520”，或用户明确要让**运行中的端口吃到本地新代码**。
- 固定顺序：**先 build，再 install，再 restart，再验活**；不要现场猜是 `SIGUSR2`、`start` 还是别的路径。
- 默认动作补充（2026-05-17）：除非 Jason 明确要求“不全局安装”，凡执行 build/dev/restart 流程都默认包含 `npm run install:global`（rcc/routecodex 全局可执行刷新）再做重启验活。
- Jason 原地重启纠正规则（2026-04-30）：**优先直接用 `restart`，禁止把 `stop + start` 当成等价替代**；某些端口/child 链路只有 `restart` 才能正确原地重启并吃到本地新代码，`stop` 后再 `start` 会破坏原地续接语义。
- Release snapshot 精华（2026-04-27）：**release 运行时绝不能直接吃 repo `dist/` 或 npm 全局 symlink**；必须先 `npm run install:release` 生成 `~/.rcc/install/current` 不可变快照，再让端口进程切到该 snapshot。若现网进程仍是 repo 路径，优先 `rcc start --config <cfg> --port <port>` 让 CLI 接管端口并重启到 snapshot，不要继续信任旧进程自重启。
- Launcher auto-start 生命周期精华（2026-04-27）：`rcc codex/claude` 自动拉起 server 时，必须使用**config-scoped lock + lease**，并在 **ready 超时/启动失败** 时对**本次 spawn 的明确 PID**做主动回收；不能只靠 parent guard 被动善后，否则会留下短时孤儿与启动竞争风暴。
- 当前项目已验证可复用命令：
  1. `npm run build:min`
  2. `npm run install:global`
  3. `npm run install:release`
  4. `rcc start --config /Volumes/extension/.rcc/config.mimo.json --port 5555`
  5. `routecodex restart --port 5520`
  6. `curl -s http://127.0.0.1:5555/health && curl -s http://127.0.0.1:5520/health`
  7. `lsof -nP -iTCP:5555 -sTCP:LISTEN && lsof -nP -iTCP:5520 -sTCP:LISTEN`
  8. `ps -p <PID> -o pid=,ppid=,command=`
  9. `tail -n 30 ~/.rcc/logs/process-lifecycle.jsonl && tail -n 30 ~/.rcc/logs/server-5555.log && tail -n 30 ~/.rcc/logs/server-5520.log`
- 成功信号：`/health.version` 等于新版本、PID 发生变化、日志出现 `Server started on 0.0.0.0:<PORT>`。
- 反模式：没 build/install 就猜“为什么线上还是旧代码”；或者 5520 又切回 `start` / 手动 kill / broad kill。

### 标准流程（推荐）
1. 读取端口 PID 文件：`cat ~/.rcc/server-<PORT>.pid`
2. 对该 PID 发 SIGUSR2：`kill -SIGUSR2 <PID>`
3. 验证：`curl -s http://127.0.0.1:<PORT>/health`

### 何时使用
- 修改 `~/.rcc/config.json` 后
- 修改 `~/.rcc/provider/<provider>/config.v2.json` 后
- 需要最小扰动热加载，不做 stop/start

### 认证与边界
- `routecodex restart --port <PORT>` 若返回 401（daemon 管理口认证），使用 PID+SIGUSR2 路径。
- 禁止 broad kill（`pkill`/`killall`/`xargs kill`/`kill $(...)`）。
- SIGUSR2 后以日志 “Server started on 0.0.0.0:<PORT>” 作为成功信号。

### 5520 tooltext-isolated 实操真经（2026-04-11）

#### 1. 鉴权怎么拿
- 5520 若绑定非 loopback/public host，`/v1/*` 需要 **HTTP apikey**。
- 先查环境变量：
  - `printenv | rg 'ROUTECODEX_HTTP_APIKEY|RCC_HTTP_APIKEY'`
- 当前这套 5520（`/Volumes/extension/.rcc/config.tooltext-isolated.json`）实测使用：
  - `ROUTECODEX_HTTP_APIKEY`
- 发请求时带：
  - `Authorization: Bearer $ROUTECODEX_HTTP_APIKEY`
- 先看配置真源，别猜：
  - `jq '.server // .httpserver // {}' /Volumes/extension/.rcc/config.tooltext-isolated.json`
  - 当前可见：`server.apikey = "${ROUTECODEX_HTTP_APIKEY}"`

#### 2. 怎么确认配置里的鉴权来源
- 先看配置本身：
  - `jq '.server // .httpserver // {}' /Volumes/extension/.rcc/config.tooltext-isolated.json`
- 若配置里没显式 apikey，不代表没鉴权；还要再看环境变量：
  - `printenv | rg 'ROUTECODEX_HTTP_APIKEY|RCC_HTTP_APIKEY'`
- 结论规则：
  - **config 明写** → 用 config
  - **config 为空但环境变量存在** → 用 env
  - **两边都空** → 本地 loopback 通常可免鉴权；若仍 401，再查运行时 merge/config loader

#### 3. 5520 精确重启方式
- **唯一允许命令**：`routecodex restart --port 5520`
- **禁止**用 `routecodex start --port 5520 ...` 代替重启；`start` 会先抢占端口，可能对现有 child 发 `SIGTERM`，破坏用户自己拉起的长期进程链。
- **禁止**在 5520 上改走 `SIGUSR2`、PID 定位、手动 kill 等替代路径；Jason 已明确要求这里**只能**用 `restart`。
- 执行前必须先核对**配置 + 源码**，不要凭印象：
  - 配置：`/Volumes/extension/.rcc/config.tooltext-isolated.json`
  - restart CLI：`src/cli/commands/restart.ts`
  - daemon-admin auth：`src/server/runtime/http-server/daemon-admin-routes.ts`
- 当前源码实情（2026-04-11）：
  - 5520 的 server 配置里虽然有 `apikey`
  - 但 `routecodex restart` **当前没有像 heartbeat/session-admin 那样解析并附带该 apikey**
  - 且 `daemon-admin` 注释已声明“**不再使用 apikey 鉴权（改为密码登录）**”
  - 所以 `routecodex restart --port 5520` 在这套环境里可能直接 `401 unauthorized`
- 经验规则：
  - **先看配置，再看 restart 源码，再执行 restart**
  - 如果看到 `401 unauthorized`，先判定为“restart auth 模型与 server apikey 配置漂移”，不要再现场瞎猜“是不是没带 key”

#### 4. 5520 重启后怎么健全校验
- 健康检查：
  - `curl -s http://127.0.0.1:5520/health`
- 期望看到：
  - `ready=true`
  - `pipelineReady=true`
  - `version=<新版本>`
- 进程校验：
  - child PID 变化（说明确实换了新进程）
- 生命周期日志校验：
  - `tail -n 20 ~/.rcc/logs/process-lifecycle.jsonl`
  - 期望看到：与 `restart` 对应的重启链条事件，以及新的 child/session 生命周期事件；不要再把 `SIGUSR2` 当成 5520 的手工操作指令
- 服务日志校验：
  - `tail -n 80 ~/.rcc/logs/server-5520.log`
  - 期望看到：`Server started on 0.0.0.0:5520`

#### 5. 5520 真实请求健全方式
- 带鉴权请求：
  - `Authorization: Bearer $ROUTECODEX_HTTP_APIKEY`
- 目标不是只看 200，而是看：
  - 返回里 `required_action.submit_tool_outputs.tool_calls`
  - `metadata.deepseek.toolCallState = text_tool_calls`
  - `cmd` shape 是否已被修正（例如 `cat docs/...`，而不是 `catdocs/...`）

#### 6. 本轮已验证的在线事实（写入 skill，避免重复搜）
- 纠偏补充（2026-04-11）：**Jason 自己拉起的 5520 长驻进程只能用 `routecodex restart --port 5520`**；不要再用 `routecodex start --port 5520 ...`、`SIGUSR2`、PID kill 等替代方式。
- 纠偏补充（2026-04-11）：下次遇到 5520 restart / health / auth 问题，**先读配置文件和对应源码**，把“鉴权来源、restart 路径、health 校验方式”一次性写进 skill；不要每次重新问、重新试错。
- 纠偏补充（2026-04-12）：**5520 的 `/v1/*` apikey** 现在也应作为 **daemon-admin `/daemon/*` 的共享鉴权** 使用；不要再把它们当成完全割裂的两套。正确目标是：同一个 `server.apikey` 既能打业务入口，也能打 `daemon/restart(-process)`。
- 纠偏补充（2026-04-12）：当前修复真相要点：
  - `src/cli/commands/restart.ts` 走的是 `POST /daemon/restart-process`
  - CLI 现在要从 `ROUTECODEX_HTTP_APIKEY` / `RCC_HTTP_APIKEY` 或 config 解析出同一个 key，并附带到 restart 请求
  - `src/server/runtime/http-server/daemon-admin-routes.ts` 需要把解析后的 `server.apikey` 挂到 daemon-admin 守卫上
  - `src/server/runtime/http-server/daemon-admin/auth-handler.ts` 的 `authenticated` 也要接受同一个 apikey
- 纠偏补充（2026-04-12）：如果 `routecodex restart --port 5520` 仍报 `401 unauthorized`，先用同一个 apikey 直打：
  - `curl -i -H "x-api-key: $ROUTECODEX_HTTP_APIKEY" http://127.0.0.1:5520/daemon/auth/status`
  - 若返回 `apiKeyConfigured=true` 但 `authenticated=false`，说明 **线上 5520 仍是旧代码**，不是新逻辑失败。
- 纠偏补充（2026-04-12）：对 5520 的正确动作仍然是：
  - **只能继续用** `routecodex restart --port 5520`
  - **不能**因为线上还是旧代码就切到 `SIGUSR2` / `start` / kill / 其他旁路
  - 先完成代码修复、build/install；再等线上实例吃到一次新代码后，用同一条 restart 命令闭环验证
- 纠偏补充（2026-04-12）：5520 文本工具问题调试时，默认先看三处：
  - `~/.rcc/logs/server-5520.log`
  - `src/server/runtime/http-server/executor/provider-response-converter.ts`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance.rs`
- 纠偏补充（2026-04-19）：**5520 不一定读 `/Volumes/extension/.rcc/config.json`**。若线上路由/provider 行为与该文件不一致，先以启动日志里的 `User config:` 为真源；本机 qwen lane 当前实际读的是 `/Volumes/extension/.rcc/config.qwen-5520.json`。

## Snapshot 启动策略（默认轻量，防爆炸）

### 默认只抓这些 stage
- `client-request`
- `http-request`
- `provider-request`
- `provider-response`
- `provider-error`
- `provider-request.retry`
- `provider-response.retry`

### 启动方式
- 轻量默认（推荐）
  - `node dist/cli.js start --port 5555 --snap`
- 显式增加某些 stage（支持前缀通配 `*`）
  - `node dist/cli.js start --port 5555 --snap --snap-stages "client-request,provider-request,provider-response,provider-error,chat_process.req.*"`
- 全量分析（高开销）
  - `node dist/cli.js start --port 5555 --mode analysis`

### 环境变量
- `ROUTECODEX_SNAPSHOT_STAGES` / `RCC_SNAPSHOT_STAGES`
  - 逗号分隔
  - 支持 `chat_process.req.*`
  - `*` / `all` = 全量抓取

### 反模式
- 常规压测直接全量抓取（`*`）导致 IO/CPU/内存放大。
- 修改了 snapshot stage 选择但未重启就判定“不生效”。

### 子代理审计报告 vs 代码真源不一致的反模式（2026-04-26）

- **触发信号**：子代理报告 N 项 MAIN_PATH_RISK，但逐条读代码时发现全部已修正。
- **根因**：子代理基于 grep 的文本快照做分类，但代码在上一轮已被修复；或者子代理的代码行号/版本引用已经过期。
- **可复用动作**：收到审计报告后，先对每条 MAIN_PATH_RISK 做**逐条读取验证**（读实际 catch body，而非信任行号描述），再决定是否修改。禁止"信任报告 → 直接修"的跳步骤。
- **反模式**：直接按审计报告修代码，不先核对代码是否已经符合要求；会导致"重复修"或引入无意义变更。
- **边界条件**：如果审计报告基于的历史 commit 确实存在该问题，但最新代码已修复（例如前一轮会话已修复），则直接跳过并记录"已修正"。
- **验证铁律**：每条 MAIN_PATH_RISK 必须有三段证据：(1) catch body 原文、(2) 错误传播路径（throw/return+status/console.error）、(3) 调用方如何感知错误。缺一不可。
- Port-mode /admin/ports 真源排查：若 listener 明明已在 runtime port 启动，但 `/admin/ports` 仍显示磁盘旧端口，先对照 `RouteCodexHttpServer.getPortConfigs()` 的 **src/dist 产物**与 `userConfig.httpserver.port` 覆盖顺序；不要去 PortRegistry 或 handler 层补“显示修复”，那会制造第二真源。
- Provider-direct relay 边界：`provider-direct-pipeline.ts::convertProtocolForRelay()` 是跨协议 relay 的唯一 owner。若只实现了某几个协议对（当前 `openai-chat ↔ anthropic-messages`），其余组合必须在这里 fail-fast；只改文档或在 transport 末端兜底都不算收口。
- `/goal` 历史实现拆除边界（2026-05-19）：旧 `goal-capable` 判定链、`hub_goal_tools.rs`、Host 侧 `create_goal/update_goal` 投影与 followup 专用分支都已删除。现在 `/goal` 只允许保留**状态面**（如 `stoplessGoalState` / `/goal active` 检查）与**历史污染 scrub**；若再看到 `goal-capable`、`hub_goal_tools.rs`、`create_goal/update_goal` 执行面，直接按残留旧实现处理并物理删除。
- managed stopless goal 边界（2026-05-19）：`managed stopless goal` 只表示会话里已有 `stoplessGoalState`，**永远不再**代表某种特殊 tool surface。恢复 followup root tools 时，一律按普通 followup 规则恢复真实 client tools（如 `exec_command/apply_patch/...`）；禁止再走任何 `/goal` 专用 followup 分支。
- validator shape-only 铁律（2026-05-14）：`provider-response-tool-validation-blocks.ts` 只能做 **object + required fields + primitive type** 校验；禁止在这里做 declared-tool 审计、shell wrapper 修复、apply_patch 多形态兼容猜测、completion evidence 质量判断。若需要连续错误停机/无进展收敛，唯一正确落点是 goal state / runtime owner，不是 validator。

- stopless-goal 边界（2026-05-19）：`provider-response-tool-validation-blocks.ts` 只负责 tool args 最小 shape；`provider-response-converter.ts` 不再承接旧 `/goal` 生命周期投影。**连续错误/无进展/forced stopped 不得塞进 validator 或 converter**，必须留给独立 runtime/stopless state owner。
- apply_patch 引导优先级（2026-05-16）：`exec_command` 文案必须把“禁止通过 shell/bash -lc/heredoc 调 apply_patch（含 `apply_patch <<PATCH`）”放在最前面；否则模型会继续把文件编辑塞回 shell。
- apply_patch shape 一致性铁律（2026-05-16）：请求文案可继续“prefer patch, input alias accepted”，但 Host validator / Rust resp governance / tool validator 的**归一输出必须统一镜像成 `{patch,input}` 同值**；任何一层只吐 `patch`，都会把下游 `missing field input` 假错误重新注回历史。
- malformed shell-like message history 清理铁律（2026-05-16）：若 `messages[].assistant.tool_calls[*].function.arguments` 对 `exec_command/shell_command` 已不是有效 JSON，且配对 tool 输出已落 `failed to parse function arguments...`，必须在 Rust inbound history normalize **物理删除该 assistant tool_call 与配对 tool message**；只清理 `responses input` 不清理 `messages`，MiniMax 会直接报 `provider_status_2013 invalid function arguments json string`。
- builtin `web_search` 透传门禁：默认必须过滤；只有 runtime `__rt.webSearch.engines[*]` 明确命中 `executionMode=direct + directActivation=builtin` 时，才能把 canonical `web_search` 变成 provider builtin。遇到 llmgate/deepseek `tools[i] 不支持的类型: web_search`，唯一先查两层：Rust `hub_bridge_actions/history.rs`（bridge 注入）和 Rust `hub_pipeline.rs::apply_direct_builtin_web_search_tool()`（provider outbound 最后一跳剥离/转换）。
- tool-route fallback 铁律（2026-05-17）：`search/read/write/web_search` 这类专用工具 route 若本 route 无 targets，但 `tools` route 有 targets，Rust `virtual_router_engine/routing/config.rs::build_route_queue()` 必须生成 `专用 route -> tools -> default`；禁止直接 `专用 route -> default`，否则会绕过工具兜底并制造错误的 default 命中。
- SSE decode stats null-contract（2026-05-17）：Rust `extract_decode_stats_json()` 在 payload 缺少 `__rccDecodeStats` 时必须返回字符串 `"null"`，不能抛 `Status::Ok("null")`；否则 TS `extractDecodeStatsWithNative()` 会把“无 stats”误报成 `native extractDecodeStatsJson is required but unavailable: null`。
- provider ban 黑盒排查铁律（2026-05-18）：若 5555/5520 出现“同一个 provider 明明应该被 ban，却提前/重复/根本不 ban”，先跑 `scripts/tests/provider-failure-ban-blackbox.mjs`，并同时挂 `provider-runtime-ingress` observer 看**每次失败到底上报了几条 error event、stage 是什么**；不要只看 selection 日志猜。
- provider 错误重复上报真源（2026-05-18）：主链 provider 失败可能同时来自 `base-provider.ts -> emitProviderError(stage=provider.http)` 与 `request-executor-provider-failure.ts -> emitProviderErrorAndWait(stage=provider.send)`；若黑盒显示 502 两次就提前 cooldown，先审 `src/providers/core/utils/provider-error-reporter.ts` 的单次错误去重 marker，禁止去 router selection/quota view 补第三语义面。
- 高频周期日志禁令（2026-05-20）：**未经 Jason 明确要求，禁止任何 500ms/逐轮/按 poll tick 输出的运行态日志进入主链**，尤其是 provider poll / heartbeat / idle counter / step scan 这类周期调试信息。此类日志不允许“节流后保留”，默认必须物理删除；只有状态跃迁、最终退出、明确错误三类日志可保留。若需要排查，优先 requestId 定点样本或临时本地调试，不得把高频日志带入常规运行态。

## Windsurf cascade provider lessons

- Windsurf cascade blackbox must be verified through the local LS gRPC cascade chain, not cloud `GetChatCompletions` or Connect/JSON detours: warmup -> `StartCascade` -> `SendUserCascadeMessage` -> trajectory poll.
- Protobuf empty embedded messages must be omitted to match WindsurfAPI `writeMessageField`; encoding `tag + len=0` can make LS reject requests as invalid wire-format data.
- When multiple `routecodex-windsurf-*` LS instances exist, pin the selected runtime per request scope. Do not store pinned LS runtime in provider instance fields because concurrent `/v1/responses` calls can overwrite it and cause `trajectory not found`.
- After modifying Windsurf provider, agent must run its own source smoke and installed `/v1/responses` smoke before asking Jason to test.

- Windsurf pending stream canceled 排查（2026-05-22）：若 `/v1/responses` 报 `The pending stream has been canceled`，先用 WindsurfAPI `grpc.js + buildInitializePanelStateRequest` 直打当前 `lsPort` 验证；若同样失败或端口无监听，根因是 LS 连接/启动形态，不是 Hub/retry/并发。RouteCodex Windsurf provider 必须按 WindsurfAPI `ensureLs()` 启动受管 LS（`--server_port --csrf_token --codeium_dir --database_dir --detect_proxy=false`），不要连 Windsurf app 的 `--random_port` 子进程或 stale `~/.rcc` 端口。
- Windsurf 工具协议改造顺序（2026-05-22）：必须先更新 `docs/design/windsurf-cascade-tool-protocol.md` 固化协议事实，再补黑盒锚点测试，最后改 `windsurf-chat-provider.ts`；禁止先写实现再反补文档/测试。
- Windsurf 工具调用目标（2026-05-22）：最终路径必须是 Cascade structured protocol：`planner_mode=DEFAULT(1)` + `CascadeToolConfig.tool_allowlist(field32)` + trajectory fields 45/47/49/50 + `additional_steps(field9)`；文本 `function_call` / `<tool_call>` prompt 注入与 harvest 只能作为待删除旧实现，不能作为完成标准。
- Windsurf 文档事实清理（2026-05-22）：当前事实只写 `docs/providers/windsurf-chat-provider-design.md` 与 `docs/design/windsurf-cascade-tool-protocol.md`；audit/goal/note 只能写历史取证且必须标注 superseded。发现 `GetChatCompletions`、cloud JSON baseurl、`tools_preamble`、文本 harvest、`~/.routecodex` 被当成当前事实时，必须立即改成 local managed LS gRPC + Cascade 与 `~/.rcc`。
- Windsurf 旧语义处置（2026-05-22）：skipped 测试、未调用 helper、注释中的旧文本工具协议都不能长期保留；确认由 structured protocol 覆盖后必须物理删除。
- Windsurf hybrid tool 边界（2026-05-23）：不要做能力路由 gating；App `SendUserCascadeMessageRequest` 只有 fields 1-9、无 tool definitions 输入槽位，所以 Codex/MCP/custom 任意工具不得进入 Cascade native structured protocol。Jason 已授权 unsupported tools 使用显式 RCC text-tool protocol：当前只有已证明等价的 one-shot shell 工具（`exec_command`/`shell_command`）走 Cascade native `run_command`；`apply_patch`、MCP/custom 工具走 `<|RCC|tool_calls>` / `<|RCC|tool_result>` 或未来显式 servertool。这不是 native 失败后的 fallback，RCC guidance 只能列 unsupported tool names，harvest 必须 native/RCC 分离并对 conflict/malformed/undeclared fail-fast。
- Windsurf fence 命名（2026-05-23）：Windsurf unsupported-tool fence 只能写 `RCC`，不得借用其他 provider 的历史协议名；若参考 DeepSeek/Qwen 文本 harvest 经验，只能迁移“容器边界/harvest 思路”，不能迁移协议名。

- Windsurf multi-account / quota / stopMessage 事实（2026-05-23）：配置账号必须是“多 key -> 多 runtime”生效，形如 `windsurf.ws-pro-N.<model>`；runtime auth 若缺 `accountAlias`，必须从 `windsurf.ws-pro-N` 派生，避免 token/session 落到 default。Windsurf 每个 runtime 启动时默认做一次 `checkHealth()` auth/model-config probe；失败即该 runtime init 失败并按 provider-init error/quota 路径移出池，不允许继续伪装可用。weekly quota 是 alias-family 级别：命中一个 model 要回收同 alias 下所有 Windsurf target，默认冷却到本地 00:00 自动恢复；显式 upstream cooldown 才能覆盖。5520 这种纯 HTTP 测试端口若 `[[httpserver.ports]].stopMessage.enabled=false`，stopMessage 必须被端口元数据关闭，不能触发 tmux followup。

## Windsurf truncation / legacy marker rule（2026-05-23）
- If Windsurf output appears truncated, first inspect `~/.rcc/codex-samples/**/provider-response-contract.json` for visible legacy `<tool_call>` / `<function_call>` fragments.
- Legacy tool markers in Cascade assistant text are not a fallback protocol; they are malformed/truncated output and must fail-fast as `WINDSURF_TOOL_PROTOCOL_CONFLICT`. Only RCC text protocol is valid for unsupported text tools.
- Windsurf 启动探测铁律补充（2026-05-23）：`checkHealth()` 返回 `false` 等同 startup probe 失败，必须抛 `WINDSURF_STARTUP_PROBE_FAILED` 并阻止 runtime handle 注册；不能把 false 当“非阻塞健康差”。weekly quota 到本地 00:00 后，quota maintenance/reload 必须清掉 expired weekly blacklist，随后由启动 probe 重新确认账号可用再入池。
- Windsurf Cascade history 对齐（2026-05-23）：对照 WindsurfAPI native bridge，`role=tool` 与 assistant tool-call-only 历史不得进入 visible Cascade prompt；native 工具结果只走 `additional_steps`。若 prompt 里出现空 `<assistant>\n\n</assistant>`，优先查 `buildCascadePromptText()` 是否没有跳过 blank rendered history turns。
- Responses 续轮工具保持（2026-05-23）：若 Windsurf/Responses 第 1 轮有工具、第 2 轮变 `finish_reason=stop`，先看路由原因是否从 `tools:tool-request-detected` 退化成仅 `search:last-tool-search`；真源可能是 scoped continuation retention 清掉 `entry.tools`。释放大 payload 可以，但不得清掉工具定义。
- Windsurf 5520 多账号配置铁律（2026-05-23）：多账号同时工作不是 `mode="priority"`，priority 会固定首个可用 target；5520 这种多账号池必须使用 `mode="round-robin"` 或明确 weighted，同时保持 provider `maxInFlight=1` 实现“单账号不并发、多账号并行”。账号配置必须去重 alias，重复 alias 会造成认证/状态语义混淆。

- Responses SSE tool_calls 调试锚点（2026-05-23）：如果 `/v1/responses stream=true` 日志显示 `finish_reason=tool_calls` 但 mem-observer 仍 `responseIndex=0 scopeIndex=0 pendingNoResponseId>0`，先查 `src/server/handlers/handler-response-utils.ts::streamResponsesJsonAsSse()` 是否像 JSON path 一样调用 conversation store 记录。样本必须进 `tests/server/handlers/handler-response-utils.responses-conversation.spec.ts` 红测，断言 response id + router id + provider timing id 均入库。
- apply_patch servertool 骨架事实（2026-05-23）：`[servertool.apply_patch].mode=servertool` 时，`apply_patch` 只在 Hub/servertool 层本地执行，并通过标准 servertool followup 骨架（captured origin + injection ops）把 `APPLY_PATCH_APPLIED/FAILED` 回给模型；不得走 tmux/client injection，不得在 provider/Windsurf 层处理。默认 `client` 模式必须保持 client 原生 tool_call 透传，runtime dispatch gate 不得消费。
- stop_message_flow 路径修正（2026-06-03）：stopless/stopMessage 普通续杯不走 tmux/client injection；Rust `servertool_skeleton_config.rs` 中 `stop_message_flow` 的 active fact 是 servertool `reenter` + `stickyProvider` + `seedLoopPayload` + `retryEmptyFollowupOnce`，无 `clientInjectOnly/clientInjectSource`。测试或实现若看到 `servertool.stop_message -> client_inject_only` 或 followup metadata stopMessage false，这是旧事实污染。
- servertool followup origin 修正（2026-06-04）：followup capture 必须在请求 entry 保存 `entryOriginRequest/capturedEntryRequest`，哪个入口协议就 clone 哪个请求 shape；`/v1/responses` 只能在 `input` 上加 delta，不能从 chat `messages`、raw metadata、responses context 或当前污染 payload 重建。旧 `backfillServertoolAdapterContextTools*` 属于错误实现，发现即删除而不是闲置。
- Responses retention cleanup（2026-05-23）：`retainedInputItems` 与 `pendingNoResponseId` 同步增长时，唯一先查 `handler-response-utils.ts` 在拿到 client `resp_*` 后是否清掉 superseded router/provider requestId；释放 payload 只能保留工具定义与 pending tool-call ids 摘要，禁止保留完整 input prefix 伪装指标下降。
- Windsurf RCC text-tool typed args（2026-05-23）：若 unsupported tool 经 RCC fence 后工具层报 `plan expected sequence` / 参数类型错，先查 `windsurf-chat-provider.ts` harvester 是否按 JSON schema 还原 array/object/boolean/number；禁止把所有 `<|RCC|parameter>` 都当 string。guidance 必须列出所有 required 参数，不能只示例第一个。
- Windsurf managed-account 请求内账号固定（2026-05-28）：健康/extra quota 探测结果只在启动/首次缓存填充时进入 `windsurfHealthCache`；单次请求内 transient retry 必须复用第一次 `resolveCascadeApiKey()` 的账号，不得重新 health probe 或静默切账号。quota exhausted 只标记 alias 并显式抛给外层 provider/VR 策略处理。
- Windsurf latest-delta 铁律（2026-05-30）：Windsurf 云端 Cascade 自带上下文，`SendUserCascadeMessage.text` 永远只发最新用户 delta；历史 system/developer/assistant/tool-result 不得重放进 text。当前轮 native/MCP tool result 只走 `additional_steps` 当前窗口；`WINDSURF_CASCADE_STALLED` 是本轮 Cascade 闭环失败，provider 内 non-retryable，禁止 provider-switch 重发造成风暴。
- apply_patch samples 排查（2026-05-23）：若 codex-samples 里反复 `APPLY_PATCH_ERROR`，先看 provider-request history 是否有 synthetic `__APPLY_PATCH_ERROR__` tool_call；真源可能是 response governance 生成旧 `{input,patch}` guard + request inbound 未剪历史。当前 schema `{filePath,patch}` 必须原样保留，不能被归一成旧 `{input,patch}`。

## Provider 错误统一码表与归一化指引（2026-05-27）

### 目标（先统一后分类）
- 所有 provider 原始错误（status/code/upstreamCode/message）必须先归一到统一错误码，再进入分类（recoverable/unrecoverable/special_400）与健康/重试/冷却状态机。
- 禁止下游模块（retry/quota/http mapper/followup）再次按 message 临时猜测分支。

### 已知错误表（v1 基线）

#### A. 认证/权限/模型类（默认不可恢复，1 次进入长冷却）
- `INVALID_API_KEY`
- `INVALID_ACCESS_TOKEN`
- `ACCESS_DENIED`
- `FORBIDDEN`
- `INSUFFICIENT_QUOTA`
- `ACCOUNT_DISABLED`
- `ACCOUNT_SUSPENDED`
- `MODEL_NOT_SUPPORTED`
- `MODEL_DISABLED`
- `NO_SUCH_MODEL`

#### B. 限流/容量/上游拥塞（可恢复，按连续计数策略）
- `HTTP_429`
- `HTTP_429_2056`
- `PROVIDER_TRAFFIC_SATURATED`
- `provider_status_2056`（上游业务码，常见于 usage limit exceeded）
- `DAILY_LIMIT_EXCEEDED` / `daily usage limit exceeded`（429 日额度耗尽语义）

#### C. 上游可恢复服务错误（可恢复）
- `HTTP_500`
- `HTTP_502`
- `HTTP_503`
- `HTTP_504`
- `UPSTREAM_EMPTY_OUTPUT`

#### D. 协议/解码类（可恢复，默认归入 provider 解码失败族）
- `SSE_DECODE_ERROR`
- `SSE_TO_JSON_ERROR`
- `UPSTREAM_STREAM_TERMINATED`
- `UPSTREAM_STREAM_INCOMPLETE`
- `UPSTREAM_STREAM_TIMEOUT`
- `UPSTREAM_HEADERS_TIMEOUT`
- `UPSTREAM_STREAM_NO_CONTENT_TIMEOUT`
- `UPSTREAM_STREAM_CONTENT_IDLE_TIMEOUT`

#### E. 路由运行态错误（非 provider 本体错误，单独处理）
- `PROVIDER_NOT_AVAILABLE`
- `QUOTA_DEPLETED`

### 与当前状态机的绑定规则（事实）
- 可恢复错误：连续 3 次 -> 30 分钟冷却；冷却后再连续 3 次 -> 长冷却（到本地次日 0 点）。
- 不可恢复错误：1 次 -> 长冷却（到本地次日 0 点）。
- `HTTP_503` persisted 冷却可在 startup/probe success 后清理；再次真实失败可重新进入冷却。

### 新错误接入流程（未来未知错误）
1. **先取样本证据**：必须有 codex-samples + provider-error snapshot（含 status/code/upstreamCode/message/stage）。
2. **先归一再分类**：在 provider 入口将新错误映射到统一码（不得在下游补丁判断）。
3. **补红测**：新增“未知错误 -> 统一码 -> 分类 -> 冷却行为”红测。
4. **补码表**：把新错误加入本节“已知错误表”，并标明归属类别与策略。
5. **再放量**：未进入码表的新错误，默认落入“未知可恢复”并强制告警，不允许静默吞掉。

### 标准执行流程（强制）
1. **先样本**：先拿 codex-samples / provider-error 日志，确认 status/code/upstreamCode/message/stage。
2. **先红测**：先写失败用例（至少覆盖 classification + retry + storm/backoff 之一）。
3. **入口归一**：先改 `provider-error-catalog.ts`，不要在下游模块先打补丁。
4. **统一消费**：`provider-failure-policy-impl.ts`、`request-retry-helpers.ts`、`request-executor-retry-decision.ts`、`retry-engine.ts` 等只消费 catalog/classification。
5. **保留特殊语义优先级**：2013/context overflow、client tool args invalid、已确认 deterministic malformed 等必须在 policy owner 显式优先处理。
6. **回归收口**：跑主链回归（request-executor + failure-policy + retry helpers + retry-engine），绿后再提交。

### 当前真相边界（2026-05-27）
- 主链错误语义已基本收口到 catalog + failure policy（classification / retry / storm/backoff）。
- `provider-response-converter` 仍有局部 remap 逻辑依赖旧测试环境假设（core dist 模块加载），这部分要单独做 harness 后再完全收口，避免误回归。

## 2026-05-28 调试精华（sticky 语义废弃）

1. Provider/route sticky 已废弃：不要再新增或恢复 `stickyTarget`、`stickyProvider`、sticky provider pin。continuation 也不是 sticky provider；它只用于判断已有 store 属于 direct 还是 local，并据此选择链路。
2. `__shadowCompareForcedProviderKey` 只允许显式内部控制场景使用（如 shadow/明确 force），servertool followup 不得因“上一跳 provider”自动写入该字段。
3. 清理 sticky 必须覆盖三层：Rust VR state/parse/selection/load-balancer，TS bridge/servertool flow policy/followup metadata，以及测试/文档中的旧事实。只删 TS 外壳不够，native 仍会继续污染。
4. 回归要求：至少包含 `sticky:` 指令被忽略的 routing-instructions 红/绿测，以及真实请求级黑盒验证非 continuation/continuation 都不粘 provider（按当前请求重新路由）。

### 2026-05-29 VR direct/weighted 调试精华
- Router direct/relay 的首次路由入口一致：inbound 后进入 VR；direct 命中后如需复入 executor，必须携带首次 route result 并跳过第二次 VR，禁止通过禁用 direct 预路由来“减少一次路由”。
- 多端口 routingPolicyGroup 隔离必须是独立 HubPipeline/VR config，不是只用 `allowedProviders` 或隐藏日志；`[VR-KEYS]` 不应在 5555 实例里看到 5520/10000 keys。
- Pool id 是展示/日志名，隔离真源只能是 `routeParams.routePolicyGroup`；weighted pool 的 display id 必须从实际 strategy 生成，不能沿用 `gateway-priority-*`。

### 2026-05-29 Windsurf Cascade shape 精华
- 对齐 `/Volumes/extension/code/WindsurfAPI` 时以实际编码字节为准，不以注释为准：`writeBoolField(false)` 会返回空 Buffer，因此 `memory_config enabled=false` 在真实 `SendUserCascadeMessage` 中被省略；RCC 不得额外发送 cascade_config field 5 `{1:0}`。
- Windsurf transient retry 不得清空同一请求首次选中的 `sessionId/cascadeId`；只有 panel missing / expired cascade / untrusted workspace 这类显式 rewarm 才允许重开 cascade。

### 2026-05-29 Windsurf model-aware health 精华
- Windsurf 账号健康不能只看 quota/extra：`ws-pro-3` 这类 Free 账号可表现为 daily/weekly 100%，但不支持 `gpt-5.5-low`，基础请求会失败；健康排序必须先判定当前 `modelUid` 是否在账号 allowed models 内，再按 rate-limit/exhausted/extra/quota 排序。
- 最小黑盒顺序：先用 `/Volumes/extension/code/WindsurfAPI` 基础 cascade 请求找到“当前模型可成功账号”，再让 RCC 选择同一类账号；禁止把 quota 最高但模型不支持的账号当最健康。
- Windsurf MCP 工具形状要同时覆盖 top-level `tool.mcp_compat` 与 OpenAI function 形态 `function.mcp_compat`；线上样本必须看到 `mcpCompatCount>0`，native 工具则看 `nativeMode=true/nativeAllowlist`。
- Windsurf provider 对 Hub 的边界协议是标准 chat tools：入口 `tools` 不在 Hub 改写；只允许 Windsurf provider 内部拆成 native Cascade 与 MCP field-10；返回 Hub 前必须把 native 工具名/参数重新映射回原始标准 chat tool call。
- Windsurf provider 内部拆分字段不得以 enumerable request body 字段暴露给 Hub Pipeline：`windsurf_custom_tools` / `windsurf_declared_native_tools` / `windsurf_native_allowlist` / `windsurf_native_mode` / `windsurf_tool_choice` 必须是 provider 私有/hidden 状态；黑盒断言 `Object.keys/JSON.stringify(body)` 不出现 `mcp_compat`、`node_repl` 或 Windsurf 内部字段。
- Windsurf provider 会经过 `processIncoming -> preprocessRequest -> sendRequest -> preprocessRequest` 双预处理；内部 hidden 工具字段必须跨第二次 preprocess 保留，禁止用 `{...request}` 这类 enumerable-only 克隆丢掉 native/MCP 分区。
- Windsurf 工具验证不能只看 provider-request 形状；必须强制真实 tool_call 并检查最终 `/v1/responses` 输出仍是请求的标准工具名（如 `shell_command`），防止 Rust response governance 再次 canonicalize 成 `exec_command`。
- `stop_followup` 是正常 continuation relay 请求，不是一次性内部噪声；nested responses followup capture 到 `requestId:stop_followup` 后，成功响应必须 rebind 到最终 `resp_*`，让外层 `recordResponse()` 通过 responseId 找回 context 并延续 `previous_response_id`/submit 上下文。
- Windsurf managed transient 502 / service unreachable / rate-limit 不等于账号坏：同一 request/session 已选中最健康账号后，provider retry 必须继续使用同一 alias；只有 quota/auth/account-unavailable 这类明确账号级事实才允许释放/冷却并切号。若日志出现 `ws-pro-3 -> ws-pro-4 -> ws-pro-2` 连环切号，先查 provider 是否又在 transient catch 中删 session binding 或写 transient cooldown。
- Windsurf 5520 单 provider 被 `provider-health.json` 的 `__http_503_daily_cooldown__` 卡成 `PROVIDER_NOT_AVAILABLE` 时，真源在 Rust VR health filter：singleton route 必须允许 persisted 503 做一次真实请求 passive reprobe；多 provider pool 仍按健康过滤/fallback，不能把旧 daily cooldown 扩散成全局不可路由。
- Windsurf managed 的账号/session/concurrency 真源在 provider 内部；executor 层不得再叠加 `windsurf.managed.*` 全局 traffic lease、transport backoff 或 Cascade provider-wide serial queue，否则同一请求 retry 会被自己的 lease/backoff 自锁。验证必须看 `~/.rcc/state/provider-traffic/state/windsurf.managed.json` 无 active lease，并连发两次 5520 请求。

### 2026-05-29 调试精华（Rust tool-result normalize CPU 热点）
- 触发信号：Node 进程 CPU 高频但 sample 栈落在 `router_hotpath_napi::shared_tooling::normalize_tool_result_text` / `strip_terminal_right_gutter_noise` / `regex::Regex::new`。
- 处理规则：优先检查 Rust hot path 是否在逐行/逐 tool-result 循环内重复 `Regex::new`；固定正则必须用 `OnceLock<Regex>` 静态缓存，并用结构红测禁止 hot-path 函数体内直接编译 regex。
- Windsurf “第二跳慢但第一跳快”若伴随 `/health` 超时和 Node CPU 飙高，先用 `sample <pid>` 查 native hotpath；2026-05-29 真源是 Rust `hub_reasoning_tool_normalizer` 每次响应治理重复 `Regex::new`，必须静态缓存 regex，不要再从 provider/上游等待方向误判。
- Windsurf managed alias 不能盲信 `~/.rcc/auth/windsurf-<alias>.json`：配置里有 `account` 时，健康探测返回的 `userStatus.email` 必须匹配该账号；不匹配则用 entry password 重登覆盖 token，没密码则该 entry exhausted，禁止把旧 token 的 quota/extra 当成目标账号事实。
- Windsurf 请求“进不去 provider”但 `/health` ready 时，先查 `routes.ts::holdUntilReady()`/`runtimeReadyPromise`：Windsurf startup health probe 必须后台异步执行，不能阻塞 runtimeReady；否则日志不会出现 `▶ [/v1/responses] started`。

### 2026-05-29 调试精华（install/global artifact 隔离）
- 触发信号：启动报 `dist/error-handling/route-error-hub.js` 缺失，或 `routecodex start` 从 repo `dist/` 回落启动；优先查 `install-global.sh` 是否在仓库内清理/重建 `dist`，以及全局包是否是指向临时 build 目录的 symlink。
- 修复规则：全局安装必须用隔离 build root 构建，再 `npm pack` 成 tarball 后安装；release snapshot 从隔离 build root 复制，且 install/current 不得被 dev link 重链回源码。

## 2026-05-29 请求日志/virtual-router-hit 可见性真相
- `/v1/responses` 请求生命周期日志必须在 handler 早期打印：至少在 runtime ready、resume、capture/store、provider resolve 之前；否则这些前置步骤早退/阻塞时会表现为“请求没进 provider/没打印”。
- 端口日志路由 `port-log-context.ts` 只能 tee 到 port log，不能吞 console；`[virtual-router-hit]`、`[provider-switch]`、`▶/✅/❌ [/v1/responses]` 默认必须进当前 console。
- 默认噪音只允许源头 gate：`[port-resolve]` 需 `ROUTECODEX_PORT_RESOLVE_LOGS=1`；`[mem-observer]` 是 pending/retained 泄漏哨兵，默认必须可见，只能显式 `ROUTECODEX_MEM_OBSERVER_DISABLE=1`/`RCC_MEM_OBSERVER_DISABLE=1` 关闭；请求生命周期关闭只能显式设置 `ROUTECODEX_HTTP_LOG_DISABLE=1`/`RCC_HTTP_LOG_DISABLE=1`。
- 回归必须覆盖：HTTP/handler 早退前仍打印 start、port context 不抑制 console、virtual-router-hit 彩色输出不被 minimal filter 吞掉。


## 2026-05-29 VR routing current-turn truth
- Coding route must be based on the current latest tool action only: actual write operations (`apply_patch`, write/edit file tools, shell writes such as `sed -i`, heredoc/write redirect) route to `coding`; read/search/plan tools (`read_file`, `cat`, `rg`, `grep`, `find`, `list`, `update_plan`) must not inherit earlier coding hits.
- Tool declarations are not routing triggers. Declaring `apply_patch` or `web_search` in `tools` must not route by itself; only current user intent or current actual tool activity may route.
- Regression for VR route changes must include HTTP blackbox evidence from `/v1/responses` or an equivalent handler harness, asserting real route/provider/log/body, not only unit tests.
- Memory observer is a leak-detection signal and must remain visible by default; only explicit `ROUTECODEX_MEM_OBSERVER_DISABLE=1`/`RCC_MEM_OBSERVER_DISABLE=1` may hide `[mem-observer]` lines. Do not gate it behind opt-in logs because pendingNoResponseId/retainedInputItems regressions must be observable in runtime.

### 2026-05-29 Windsurf Cascade live 对齐补充
- Cascade shape 对齐要覆盖 warmup lifecycle，不只比 `SendUserCascadeMessage`：`GetUserStatus -> UpdatePanelStateWithUserStatus -> InitializeCascadePanelState -> AddTrackedWorkspace -> UpdateWorkspaceTrust -> Heartbeat -> StartCascade -> SendUserCascadeMessage`。
- 默认 workspace 不得放在 `~/.rcc` 等隐藏目录；LS 会对 AddTrackedWorkspace 返回 `is hidden: ignore uri`。默认使用非隐藏临时 workspace，并用红测锁住路径形状。
- 若 RCC 与 `/Volumes/extension/code/WindsurfAPI` 使用同一 LS、同一 apiKey、同一 modelUid 都在 trajectory 返回 `an internal error occurred (trace ID: ...)`，不要继续改 RCC 请求 shape；这时真源已转为 Windsurf 上游/账号/model 可用性，需要换模型或账号做黑盒矩阵。

## 2026-05-29 Provider failover / port isolation blackbox rule
- Recoverable provider failure routing must be proven with HTTP blackbox: first request hits primary three times, emits `[provider-switch] ... exclude_and_reroute`, then returns backup 200; next request skips cooled primary; restart passive reprobe gets exactly one primary chance before cooling again.
- Multi-port VR tests must isolate `routingPolicyGroup` at the route-pool boundary and at traffic/error-state observations. A 5555 failure/cooldown must not let 5555 see 6666 candidates, and must not block 6666 from selecting its own group.
- In same-process blackbox harnesses that swap temporary `HOME`/RCC roots, reset the shared `ProviderTrafficGovernor` before constructing each server; otherwise the singleton can retain a deleted state root and hang at `provider.traffic.acquire` before provider send. This is a test isolation reset, not a production fallback.

## 2026-05-29 Servertool followup no-provider-pin rule
- Servertool followup is not a provider sticky mechanism. Do not add `stickyProvider` flow policy or inject `__shadowCompareForcedProviderKey` from followup runtime; followup must re-enter VR and let normal current-route scheduling pick the provider.
- Direct/remote Responses continuation is the only case that may restore the exact provider key, and that belongs to continuation resume metadata, not servertool followup flow policy.
- Blackbox proof: `scripts/tests/stopless-followup-blackbox.mjs` uses two round-robin providers and must observe `crs1 -> crs2` for initial request then stopless followup.

### 2026-05-29 Windsurf Kimi K2.6 UID 对齐
- Windsurf provider 内测 Kimi K2.6 时，必须先直连 Windsurf `GetUserStatus`/LS 拿真实 Cascade `modelUid`；当前 ws-pro-3 证实 UID 是 `kimi-k2-6`，不是外部 provider 常见的 `kimi-k2.6`。
- 5520 Windsurf 配置应使用已在 Windsurf provider 注册的 target（如 `windsurf.kimi-k2-6`）；若 VR 报 unknown model，先补 provider model registry + runtime modelTag 映射，再重启验证。

## 2026-05-29 Alias sticky queue removal rule
- `aliasSelection` / alias sticky queues are removed from Virtual Router. Do not add `sticky-queue`, `pinAliasQueue`, or alias-selection provider pinning back; weighted/priority plus health cooldown is the only alias/provider scheduling path.
- Use `scripts/tests/no-provider-sticky-physical-regression.mjs` with the HTTP blackbox matrix whenever touching VR routing/followup code, so provider sticky semantics cannot re-enter through Rust/TS wrappers.

### 2026-05-29 Windsurf managed account isolation
- Windsurf account aliases (`ws-pro-*`) 是 provider 内部实现细节，外部 Virtual Router/Hub/stats 当前请求链路只能看到 `windsurf.managed.<model>`；新增账号选择逻辑时必须补 bootstrap 回归防止账号 alias 外漏。
- Windsurf session sticky 禁止跨 session “账号占用避让”自锁：同 session pinned 可用则用 pinned，否则按健康排序选最优账号；不要因为另一个 session 活跃而切走最健康账号。

## 2026-05-29 Windsurf 单账号直发止血规则
- 当用户要求先恢复 Windsurf 通信时，优先切到唯一账号直发：配置只保留 `ws-pro-3 / frost89409@gmail.com`，显式 `tokenFile = "~/.rcc/auth/windsurf-ws-pro-3.json"`，禁止健康排序、旧 token 自动扫描、账号冷却和内部切号影响发送。
- 验证必须包含：定向回归 `windsurf-account-health-routing.spec.ts` + `windsurf-request-shape-sample.spec.ts`，全局安装/5520 restart，真实 `/v1/responses` 单跳 200，以及同 session 两跳上下文 token 回读；日志必须有 `single-account selected alias=ws-pro-3`，不能有 `ranked`/`cooldown`/切到 `ws-pro-*` 外部 provider。

## 2026-05-29 调试精华（端口/路由池隔离）
- Router 端口是天然隔离边界：`matchedPort + routingPolicyGroup` 必须进入 Hub metadata、VR pool filter、Responses continuation store；禁止任何 group pipeline 缺失时 fallback 到 global pipeline。
- 黑盒回归必须覆盖：端口 A 的 recoverable cooldown 不影响端口 B；端口 A 捕获的 Responses `response_id` 不能在端口 B resume；否则就是跨端口上下文/路由池泄漏。
- 真源文件：`src/server/runtime/http-server/index.ts`、`sharedmodule/llmswitch-core/rust-core/.../virtual_router_engine/engine/selection.rs`、`sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`。

### 2026-05-29 调试精华（OpenAI-chat 协议字段守恒 + stopless 断连）⚠️ 历史记录
- opencode/DeepSeek OpenAI-chat 400 不只看 null 字段；必须检查真实 `provider-request.json` 是否混入 Anthropic 字段，尤其 assistant tool-call history 的 `content:[{type:"thinking"}]`。OpenAI-chat 允许 `reasoning_content`，但不得带 Anthropic thinking block；红测必须覆盖 inbound / chat process / outbound 三段协议字段守恒。
- stopless/servertool followup 必须在 `executeNested` 启动前检查 client abort signal；不能只把 abort signal 传进 Promise.race，否则 nested 请求已发出，客户端断开后仍会续杯/重路由。

- 2026-05-29 2095 DeepSeek/OpenCode 400：若 provider-request 里 `role=tool.content` 含 `data:image`/`image_url` 数组，先走 Rust `chat_process_media_semantics` 非多模态 placeholder 真源；不要只看 user 历史媒体。DeepSeek thinking tool-call 历史必须保留 `reasoning_content`。

- 2026-05-29 历史图片清理：必须在 Rust outbound stage3 通用入口无条件 placeholder 历史 user/tool media；当前 user media 才看 `supportsMultimodal=false`。若 400 快照含 `role=tool.content data:image`，先查通用 `strip_historical_media`，禁止 provider 特例修。

- 2026-05-29 mimo/Anthropic 历史图片：若 500 快照无 `role=tool`，继续查 `role=user.content[]` 里的字符串化 JSON；`content` 字段可包含 `[{\"image_url\":\"data:image...\"}]`。修复必须在 Rust `chat_process_media_semantics` 通用 part 判定，禁止只修 OpenAI-chat tool role。

- 2026-05-29 opencode DeepSeek thinking 400：看到 `reasoning_content ... must be passed back` 时，不要只在 outbound 填点号；先查 Responses store 是否把 `reasoning` output item 和后续 `function_call` 拆开。真源修复顺序：store 绑定 reasoning→function_call，chat process 保留 function_call 顶层 `reasoning_content`，opencode DeepSeek outbound 禁止发送 `reasoning_content:"."`。

- 2026-05-29 DeepSeek reasoning_content 精华修正：禁止用工具名合成 `I need to call ...`，也禁止为缺失 tool-call history 新补 `"."`；必须追原始上游 `reasoning_content`。红测锚点：Chat response `reasoning_content` → Responses `reasoning` item 必须紧邻 `function_call`，store 才能绑定并在 chat process/outbound 原样回放。

- 2026-05-29 opencode DeepSeek session replay rule: for `reasoning_content must be passed back`, do not fabricate reasoning. Inspect final `provider-request.json`; if assistant tool-call history lacks original non-empty `reasoning_content`, suppress only `x-opencode-session` so opencode does not replay a tainted server-side thinking session. This must run at header finalization against the final outbound body; setting metadata inside SDK transport is too late because headers are already built. Required red/green: outbound HTTP blackbox capturing real upstream headers/body.

- 2026-05-30 Responses store missing context rule: if logs show `recordResponse: missing request context` for provider-shaped request ids or `:stop_followup`, check whether core response recording passes scope fields into `recordResponsesResponse`. Do not add fallback replay; bind via existing `scopeIndex` by carrying `sessionId`, `conversationId`, `matchedPort`, `routingPolicyGroup`, and `providerKey` from AdapterContext.

- 2026-05-30 chat direct model rule 已废弃（2026-06-07 纠正）：router-direct 不得用 selected `providerPayload` / runtime model 覆盖当前请求 body；这会把 direct 变成 provider outbound builder。若 provider 不接受客户端 model，必须在路由/入口契约上解决，不允许 direct 层重建请求。

### 2026-05-30 Windsurf Cascade poll / retry 精华
- Windsurf provider 内的 Cascade 状态机错误必须显式终止：`WINDSURF_CASCADE_BUSY` / `WINDSURF_CASCADE_NO_PROGRESS` 是本地 Cascade executor 状态，不是上游 503；retry policy 必须视为 unrecoverable，禁止 provider-switch 再次 Send 导致 `executor is not idle` 风暴。
- 审计卡死时同时看 provider poll 状态和请求层 retry 分类：若 provider 已抛 `retryable:false` 但仍出现重复 provider send，根因在 failure-policy / request-executor exclusion 执行链，不在 Windsurf payload shape。

- 2026-05-30 chat stream_options 400 精华：若上游报 `stream_options should be set along with stream = true`，必须查最终 `provider-request.json`，不要只看 direct payload mock。OpenAI-chat 通用真源在 `provider-request-shaping-utils`：从 request/data/metadata/runtime metadata 读取 stream intent，并在最终 provider HTTP body 保留 `stream:true`；禁止 DeepSeek/provider 硬编码。

## 2026-05-30 snapshot 路径长度精华
- `hub_snapshot_hooks` 写目录时，request/group id 只能作为 bounded debug path token；长 stop_followup 链必须 prefix+hash，不能原样当目录名。
- 该限制只允许作用于 snapshot/debug 路径；`__runtime.json` 和真实传输 payload 必须保留原始 requestId/语义。

### 2026-05-30 调试精华（minimonth / provider outbound sanitizer）
- 看到 `sanitizeProviderOutboundPayloadWithNative not available` 时，先查 `sharedmodule/llmswitch-core` native + wrapper + required-export 三点是否同步；`minimonth provider.traffic.acquire wait` 单独不是失败证据。

### 2026-05-30 VR empty-pool / excludedProviderKeys 精华
- 看到 `No available providers after applying routing instructions` 且日志有 `excludedProviderKeys`/retry 避让/并发满时，先查 Rust `apply_standard_filters`；`excludedProviderKeys` 只能避让，不能把 routing-state 后的 route pool 删空。
- 红测必须包含真实 `/v1/responses` HTTP handler + HubPipeline：metadata exclusion 覆盖 default pool 全部目标时仍返回 200 并选回池内 provider。

### 2026-05-30 VR recoverable busy 精华
- 全池 provider 临时 busy/冷却必须走唯一 recoverable 错误处理路径：Rust VR 输出 `HTTP_429` details，RequestExecutor 阻塞指数退避重试 3 次后才返回 429；禁止 `PROVIDER_NOT_AVAILABLE`，禁止 fallback/旁路。
- 2026-05-30 router-mode relay 注意：5555 MiniMax 是 relay/HubPipeline/VR；`router-direct.hub_pipeline_failed` 只是 same-protocol direct 预选日志。预选遇到 route-pool recoverable 错误必须让请求回 RequestExecutor 唯一错误链处理，禁止吞成普通 direct skip 或改成 direct fallback。


### 2026-05-30 Windsurf cascade busy polling fix (verified)
- WINDSURF_CASCADE_BUSY 不再直接 429：provider runtime 轮询 GetCascadeTrajectory 直到 status=1 (IDLE)，最多 2 分钟
- totalWaitMs=120000, pollIntervalMs=1000（cascade-continuation-block.ts）
- 有 pollIdle 回调 → 轮询等待 idle → 重试 send；无 pollIdle → 降级 blind sleep（向后兼容）
- 日志信号：cascade.busy.wait_idle（轮询中）、cascade.busy.final_timeout（2min 超时后）
- 回归测试：28/28 passed（含 5 个 RED→GREEN 轮询行为测试）
- 构建验证：v0.90.2569, build:min + install:global + restart 成功

## 2026-05-31 调试精华（Rust response effect plan 执行）
- Rust HubPipeline `servertoolRuntimeAction` 不是终点；TS provider-response 壳必须把 effect 接回 `runRespProcessStage3ServerToolOrchestration`，否则有 executor callbacks 也会报 `requires runtime executor`。
- 排查 response conversion 三连错时先分层：`provider_status_2056` 属 provider business retry；`Invalid ResponsesResponse/missing fields` 查 provider raw shape/SSE wrapper；`SERVERTOOL_HANDLER_FAILED requires runtime executor` 查 native effect plan executor glue。

## 2026-05-31 调试精华（client disconnect / servertool followup）
- client 断开后 servertool followup 必须 fail-fast；Host 侧唯一取消载体解析/保活走 `src/server/runtime/http-server/executor/request-executor-client-abort-block.ts`，禁止各处手写 `clientConnectionState` / `clientAbortSignal` 读取。
- nested followup clone/metadata merge 必须保留 live `clientConnectionState` 和 `clientAbortSignal` 对象；retry/backoff sleep 必须挂同一个 abort signal，否则客户端关闭后会继续 `:stop_followup` 递归。

## 2026-05-31 调试精华（Anthropic SSE wrapper -> Responses）
- mimo/vercel Anthropic runtime 可把 provider response 交给 Hub 时保留为 snapshot wrapper `{bodyText, mode:"sse"}`，不是标准 `{content:[]}`；Rust response canonicalizer 必须先 materialize SSE events (`message_start`, `content_block_delta`, `message_delta`) 再进 Chat->Responses remap。
- 此类修复必须有 HTTP `/v1/responses` 黑盒红测，测试真实 wrapper bodyText；若 SSE 含 `tool_use`，期望 Responses `requires_action` 而不是 `completed`。

### 2026-05-31 调试精华：provider SSE wrapper 与 snapshot port
- 若日志出现 `OpenAI chat response must contain choices array` 且样本是 `provider-response*.json` 的 `{ mode:"sse", bodyText:"data: ..." }`，先写 HTTP `/v1/responses` 黑盒复放真实样本；修点在 Rust inbound format parse 的通用 OpenAI-chat SSE materializer，不在 Provider/Hub 写 provider 特例。
- `port-unknown` 是 snapshot metadata 断链信号；provider snapshot 必须从 `ProviderContext.metadata.matchedPort/entryPort/portContext` 透传 `entryPort` 给 llmswitch native hook，同时写入 `__runtime.json`，禁止接受 unknown 作为正常结果。

### 2026-05-31 纠偏：Mimo 240110 live stream 红测
- 只复放 `provider-response.body.bodyText` 不足以证明 live 修复；真实主链可能是 `providerResponse.__sse_responses` stream。遇到 `Anthropic response must contain content array` 必须同时红测 `{ __sse_responses: Readable.from([capturedBodyText]) }` 形状。
- JS `Readable` 不能直接交给 Rust native JSON pipeline；非流式响应转换前必须做传输等价 materialize：`Readable SSE -> { mode:"sse", bodyText }`，语义解析仍由 Rust materializer/canonicalizer 完成。

### 2026-05-31 纠偏：stream=true 也必须 materialize
- Anthropic live SSE 修复不能只覆盖 `wantsStream=false`；`/v1/responses` + tool request 下即使用户侧非显式 stream，内部转换可能 `wantsStream=true`。红测必须覆盖 `providerResponse.__sse_responses` + `wantsStream=true`。
- provider snapshot 的 marker-only `{mode:"sse", captureSse, transport}` 不是可转换 payload；遇到它必须 fail-fast 为“缺 materializable stream/bodyText”，禁止继续送 Rust 当 Anthropic message 解析。
- router-direct 进入 response conversion 时必须传 `providerHandle.providerProtocol`，不能用 `providerType` 推断；`providerType:'openai' + providerProtocol:'openai-responses'` 若按 openai-chat 转换，会把 Responses payload 送进 Chat validator 并报 `missing choices`。红测必须走真实 HTTP `/v1/responses` router-direct。
- stopMessage followup 再入禁止写入 `stopMessageEnabled=false` / `routecodexPortStopMessageEnabled=false`（包括 `__rt` 内层）；`stop_message_flow` 的循环保护是真实工具列表 + Rust `used/max_repeats` 计数。若看到 `:stop_followup` 只续一轮，优先查 nested metadata false 标记与 Rust `followup_flow_id` skip，禁止改 router-direct/provider selection 语义。

## 2026-05-31 HTTP 黑盒红测与断连门禁
- 黑盒红测必须启动真实 `RouteCodexHttpServer` listener，经真实 HubPipeline/provider runtime 到本地 fake upstream；只允许 mock 输入/上游响应/客户端 socket，不得 mock handler、executor、converter 或 provider 行为。
- 客户端断开类问题必须在真实 HTTP 测试中 destroy client socket，并断言 retry/reroute/followup 没有发出后续 provider POST；白盒 abort 测试只能补充，不能替代。

## 2026-05-31 provider response conversion failover boundary
- `provider.send.completed` 是 retry/reroute 边界：之前的 transport/upstream failure 可走 provider failure policy；之后的 response normalize/convert/servertool/Rust canonicalize failure 必须 fail-fast，禁止 `provider-switch` 隐藏真实响应错误。
- 黑盒必须覆盖 HTTP 200 malformed provider response，而不是只测 HTTP 503；验收看 backup provider POST 次数为 0。

### 2026-05-31 Direct passthrough 架构禁令
- router-direct/provider-direct = provider passthrough + hooks only；禁止进入 HubPipeline response conversion、chat-process、servertool response orchestration 或任何 `executor-response` 专用壳。
- direct 的正确请求行为是“当前请求 body 对象 identity passthrough + 必要 hooks”。禁止 clone、structuredClone、jsonClone、深拷贝、从 `metadata.__raw_request_body`/snapshot/context 恢复 body、调用 direct body builder、provider outbound sanitizer、Responses/chat-style tool shape validator、history repair、protocol conversion。
- direct 允许的最小覆盖只限当前请求对象上的明确 runtime 必需字段（当前仅 stream intent 与路由层明确传入的同协议 model override；router-direct 不得用 `providerPayload` 重建或覆盖 request body）。这不是清洗、转换或兼容层；覆盖只能作用当前 request/delta 顶层，禁止重写 `input/messages/history` 中既有条目，避免 cached history 被污染并导致重复命中。
- direct provider-request 样本验收：provider body 必须是当前请求语义，不含 `metadata` / `__raw_request_body` / `requestMetadata` / `contextSnapshot`；Responses flat tool 必须保持 `{type:"function", name,...}`，direct 不得把 chat-style tool 转回或拦截。
- 如果 direct live 报 `tools[0].name` / chat-style function tool，先查请求历史/Hub Responses store owner 是否存入非法工具定义；修复点在 Hub/Responses conversation history owner，禁止在 direct runtime 清洗、补偿或 raw metadata 旁路。
- HubPipeline request/response 保持三段式严格协议链路；SSE 按 provider 配置协议在唯一链路处理。direct path 不做 materialize/remap/canonicalize，不做 fallback/patch。
- 禁止 direct 5xx/转换错误用 `routecodexSameProtocolDirectDisabled`、`recoverable_direct_5xx_reenter_executor`、二次 `executePipeline` 重入来伪装统一重试；direct 错误必须按 direct/provider transport 结果显式返回或抛出。
- 禁止把 `outboundProfile` 当 provider 物理协议猜测；配置的 provider type/module 才决定 provider runtime，VR target `outboundProfile` 只属于 HubPipeline 路由/转换语义。
- 修 direct 回归时先补真实 HTTP 黑盒：真实 `RouteCodexHttpServer` + 真实 provider runtime，只 mock upstream 输入/响应；断言 passthrough 原样返回且无 `missing choices`/`hub_pipeline_resp_client_remap_failed`。

### 2026-05-31 Mimo/Anthropic SSE response inbound 精华
- mimo 就是 Anthropic：provider SSE 进 `/v1/responses` 后只在 llmswitch-core response inbound 边界 materialize，Rust 负责 Anthropic SSE/message -> Chat/Responses 语义转换；Host executor 禁止再加 SSE materializer/换壳。
- 红测必须真实 HTTP listener + fake upstream SSE；断言成功文本、无 `Anthropic response must contain content array`、无 `missing choices`，再用真实 5555 smoke 区分转换错误与上游 503。

### 2026-05-31 Responses store cleanup leak
- Trigger: `[mem-observer] pendingNoResponseId/retainedInputItems` stays high or startup logs `clearUnresolvedResponsesConversationRequests not available`.
- Action: verify `runtime-integrations.clearUnresolvedResponsesConversationRequests()` against the global responses store object, not only the module export; red gate must be real HTTP `/v1/responses` blackbox plus store stats/cleanup assertion.

### 2026-05-31 HubPipeline Rust Closeout Slice 0
- Total-control API baseline is `runHubPipelineLibJson` / `runHubPipelineStageJson` in Rust, with TS wrappers `runHubPipelineLibWithNative` / `runHubPipelineStageWithNative`; wrappers must use `failNativeRequired` and must not fallback to `executeHubPipelineJson` or TS orchestration.
- Runtime validation must use `routecodex restart --port <port>` if lifecycle action is needed; do not do separate start/stop.

### 2026-05-31 HubPipeline Rust closeout residue removal
- HubPipeline request-stage/chat-process mainline must enter `runHubPipelineLibWithNative`; do not resurrect TS `hub-pipeline-route-and-outbound`, request-stage inbound/provider-payload orchestrators, stage hooks, or shared guards. Architecture gate: `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`.

### 2026-05-31 Rustification audit cleanup rule
- If `build:dev` fails on llmswitch rustification audit, first remove/merge new TS files and verify total non-native LOC decreased before refreshing `rustification-audit-baseline.json`; do not use allowlist as fallback for HubPipeline closeout wrappers.

### 2026-05-31 HubPipeline Slice5 barrel cleanup 精华
- Slice5 residue audit must include public barrels: `conversion/index.ts` and `hub/format-adapters/index.ts` must not export legacy TS `*SemanticMapper` or concrete `*FormatAdapter` implementations; keep type-only interfaces if needed by thin TS glue.

### 2026-05-31 HubPipeline Slice5 concrete adapter deletion 精华
- After public barrels stop exporting concrete adapters, physically delete `chat/anthropic/responses/gemini-format-adapter.ts` plus their old tests; production should retain only type interfaces in `format-adapters/index.ts`.

### 2026-05-31 response-processing retry gate 精华
- `provider.send.completed` 后只允许已归一化的 response-processing `SSE_DECODE_ERROR` 进入 retry；raw Rust empty-SSE 必须先通过共享 normalizer 打 `code/status/retryable/stage`，provider-runtime request contract errors 必须 direct-return，禁止 attempt_backoff 掩盖请求形态错误。

### 2026-05-31 HubPipeline Slice5 semantic mapper deletion 精华
- Slice5 closeout requires deleting both production `operation-table/semantic-mappers/*.ts` and tests that import those concrete mapper classes; keep architecture gate scanning `tests/` so old direct mapper tests cannot hide TS semantic truth after Rust/native migration.

### 2026-05-31 HubPipeline Slice5 operation-table runner deletion 精华
- After mapper deletion, also remove `operation-table-runner.ts` and dead req semantic stage shells/tests; stage catalog and README references must point to Rust total API, not deleted `req_inbound_stage2_semantic_map` / `req_outbound_stage1_semantic_map` IDs.

### 2026-05-31 HubPipeline bridge-actions registry removal 精华
- `conversion/bridge-actions.ts` must be native-only glue: no `registerBridgeAction`, no TS registry map, no post-native TS action execution, and no swallowed action errors.

### 2026-05-31 Anthropic response policy fail-fast 精华
- Response bridge policy wrappers must not broad-catch native policy execution; `response-runtime-anthropic-policy.ts` should propagate native policy errors instead of silently skipping response semantics.

### 2026-05-31 Responses SSE ResponseCompleted id 精华
- Trigger: Codex UI shows `Stream disconnected before completion: failed to parse ResponseCompleted: missing field id`.
- Action: inspect synthesized terminal SSE repair in `src/server/handlers/handler-response-utils.ts`; `response.completed` and `response.done` must always carry `response.id`. Add/keep HTTP blackbox with real Express `/v1/responses` handler and partial upstream SSE, not only unit parser tests.
- Boundary: do not mark an `in_progress` probe as completed merely because stream closed; only synthesize terminal frames from required_action or completed output evidence.

### 2026-05-31 HubPipeline request stage shell deletion 精华
- Rust total API covers request route/outbound stages; if TS `req_outbound_stage2_format_build`, `req_outbound_stage3_compat`, or `req_process_stage2_route_select` reappears, treat as closeout regression and fail `hub-pipeline-stage-residue-audit`.

### 2026-05-31 HubPipeline response stage shell deletion 精华
- Response path closeout means no TS `resp_inbound/*`, `resp_outbound/*`, or `resp_process/*` stage shell directories; keep acceptance coverage by moving tests to Rust total API or side-effect shells such as `servertool/response-stage-orchestration-shell`.
- Architecture gate: `hub-pipeline-stage-residue-audit` must fail if old `runResp*Stage*` wrappers or directories reappear.

### 2026-05-31 HubPipeline normalize-request cleanup 精华
- `hub-pipeline-normalize-request.ts` may keep Node/SSE materialization glue, but normalize semantics must be Rust `runHubPipelineStageWithNative({ stage: 'normalizeRequest' })`; old normalize block/helper files must stay physically absent.

### 2026-06-01 native required export bootstrap 精华
- 启动报 `native bootstrapVirtualRouterProvidersJson is required but unavailable` 不等于该函数本身缺失；先比对 `REQUIRED_NATIVE_HOTPATH_EXPORTS` 与 `router_hotpath_napi.node` 实际导出，任何 stale required export 都会让 native hotpath 前置校验整体 fail-fast。
- clock/heartbeat 删除后若只剩 `resolveClockReservationFromContextJson` / `mergeClockReservationIntoMetadataJson` missing，应从 `native-router-hotpath-required-exports.ts` 物理删除 required 项，重建 core，并验证 local/global missing=0 后再重启服务。

## 2026-06-01 Responses previous_response_id 精华
- pending Responses tool_call 的 response id 必须落盘到 `~/.rcc/state/responses-conversation-store.json`，重启后先本地恢复再进 provider；禁止把 `previous_response_id` 当作孤儿 tool_result 放行。
- 全局安装包必须携带 `sharedmodule/llmswitch-core/dist`，否则 `importCoreDist` 在 release 包中会启动失败。

## 2026-06-01 Pipeline type topology 精华
- 全局流水线类型按 `<Module><Phase><NN><Node>` 命名；Hub 主链 phase 固定为 `ReqInbound` / `ReqChatProcess` / `ReqOutbound` / `RespInbound` / `RespChatProcess` / `RespOutbound`，只允许相邻节点 builder/parser 转换。
- 中间插节点默认禁止；优先归入当前节点内部 block 或 `Meta*` / `Error*` / `Snapshot*` carrier，确需改变中段语义时开启新 chain version 或链尾追加，禁止 `03b` / `03_1` / `03.5` 临时编号。

## 2026-06-02 Hub Pipeline Phase 1 type skeleton 精华
- 请求侧第一阶段只允许透明类型骨架：`HubReqInbound02Standardized -> HubReqChatProcess03Governed -> HubReqOutbound05ProviderSemantic`；不得在该阶段接入 runtime flow 或改变 provider wire。
- 拓扑红测真源：`tests/red-tests/hub_pipeline_type_topology_contract.test.ts`，必须禁止新 `ReqProc` / `req_process` 类型骨架、非相邻 provider wire shortcut、正常 request payload 承载 metadata。

## 2026-06-02 Hub Pipeline Phase 2 response type skeleton 精华
- 响应侧第二阶段只允许透明类型骨架：`HubRespInbound02Parsed -> HubRespChatProcess03Governed -> HubRespOutbound04ClientSemantic`；不得在该阶段接入 runtime flow 或改变 client response。
- 拓扑红测真源：`tests/red-tests/hub_pipeline_response_type_topology_contract.test.ts`，必须禁止新 `RespProc` / `resp_process` 类型骨架、provider raw 直达 server client frame、正常 response payload 承载 metadata 或 success-wrapped error。

## 2026-06-02 Hub Pipeline Phase 3/4/5 topology contract 精华
- VR/provider 边界只允许透明 contract：`HubReqChatProcess03Governed -> VrRoute04SelectedTarget -> HubReqOutbound05ProviderSemantic -> ProviderReqOutbound06WirePayload`；不得在 contract 阶段接入 selection/encoder runtime 或 patch payload。
- Meta/Error carrier 必须独立于正常 req/resp payload：`MetaReq02RuntimeCarrier`、`ErrorErr03RuntimeClassified` 只能作 side-car；红测必须禁止 provider wire/client body metadata 与 success-wrapped error。
- Phase5 当前无安全 live-path 删除；`req_process_*` / `resp_process_*` Rust stage 仍是 live path，删除前必须先完成 typed entrypoint 迁移并让 residue red test 覆盖旧直连 import。

## 2026-06-02 Hub Pipeline Phase 6A-1 request typed wrapper 精华
- request typed wrappers 只允许做 type-boundary delegation：`run_hub_req_inbound_02_standardized_entrypoint`、`run_hub_req_chatprocess_03_governed_entrypoint`、`run_hub_req_outbound_05_provider_semantic_entrypoint`；不得调用 runtime stage、route selection、provider encoder。
- Phase 6A-1 必须保持未接 live path；红测 `hub_pipeline_request_typed_entrypoint_contract` 要禁止 `hub_pipeline.rs` / `hub_pipeline_lib/engine.rs` / `lib.rs` 引用这些 wrapper。

### 2026-06-02 MiniMax tool_call 文本化排障精华
- Trigger: UI 出现 `minimax:tool_call` 或 provider 工具调用进文本。Action: 先查 `--snap` raw `provider-response.json` 的字段归属（`content[].tool_use` vs text/content），再定位 resp outbound 投影；禁止先按文本收割修复结构化工具调用。

### 2026-06-02 multi-port / 10000 smoke 精华
- 10000 Empty reply 排障先查 `lsof -nP -iTCP:10000 -sTCP:LISTEN`：若 `127.0.0.1:10000` 被其他进程占用，而 RouteCodex 监听 `*:10000`，必须用 LAN IP/实际绑定地址打 smoke，禁止把 loopback Empty reply 直接归因给 RouteCodex。
- 多端口隔离验收必须同时看：`ports/<port>/server-<port>.log`、`codex-samples/<entry>/ports/<port>/...`、`provider-stats.jsonl` 的 `entryPort`、非主端口 `/admin/ports` 404 JSON、以及真实 `/v1/chat/completions` HTTP JSON。

### 2026-06-03 servertool followup 唯一路径精华
- stop_message followup 是 bounded continuation：若 `:stop_followup` 响应仍 `finish_reason=stop` 且 stop schema 未通过，必须按 `used/max_repeats` 继续续杯；只有非 `stop_message_flow` 的 generic followup hop 才 `skip_servertool_followup_hop`。
- `stopMessageFollowupPolicy` / `preserve_eligibility` 是已删除旧契约；不得在 skeleton/profile/runtime metadata/Rust context/测试 mock 中恢复。
- 验证必须看在线样本：同一客户端 requestId 可出现 bounded `:stop_followup` 链；缺 schema/invalid schema 时应递归追问到预算耗尽，不得只注入一次强 schema 引导后放行停止。

### 2026-06-03 servertool followup 单次复入精华
- `servertool` followup 禁止同一 `followupRequestId` provider 重试；空 followup 响应只能 fail-fast + 落 empty sample，不能 `retryEmptyFollowupOnce` 二次复入，否则会消耗 provider 次数并造成重复 VR hit。

### Stopless schema gate 精华（2026-06-03）
- stopless schema gate 只在 `finish_reason=stop` 且非 `/goal active`、非 plan mode 时激活；只解析当前 assistant stop 文本，不扫历史、不改历史、不改工具列表。
- stop schema 只校验数字字段 `stopreason` / `has_evidence`；`reason` / `next_step` / `evidence` / `issue_cause` / `excluded_factors` / `diagnostic_order` 只判空。followup prompt 必须质询六项：目标、过程、证据、问题原因、已排除因素、排查顺序；`stopreason=0|1` 且 reason 非空才允许 stop 并 prefix summary；缺 schema、无效 schema、`stopreason=2` 都计入同一个连续 stop 预算；非 stop/工具进展必须 reset；第三次连续 stop 预算耗尽并输出 summary。
- stopless summary 提示锁：任何 system prompt / ai-followup prompt 要求主模型做 summary、最终总结、停止说明、完成/阻塞汇报时，必须同条消息要求 stop schema JSON；缺 schema 的 stop 也会增加 `stopMessageUsed`，`serverToolLoopState.repeatCount` 只用于 loop guard，不是 schema budget。

### 2026-06-04 stopless Responses followup 红测精华
- stopless 线上日志出现 `decision=trigger` 仍“没作用”时，红测不能只断 `executed/flowId`；必须断最终 `reenterPipeline.body`：`/v1/responses` 入口要有 `input`、无 `messages`、包含原始历史与 stop schema 质询文本。
- 线上 sample 若 adapterContext 无 `capturedChatRequest`，必须检查 `__raw_request_body` / `responsesRequestContext.payload` 是否作为 captured seed 进入 `seedLoopPayload`；本地 ignored 源码旁 `.js/.d.ts` 会遮蔽 TS 测试，发现后先删除再跑红测。

### 2026-06-04 servertool response chain 精华
- 响应链命名以 Hub 为参照：`RespInbound` 是模型/provider 端进入 Hub；`RespChatProcess` 是 Hub 内响应治理；`RespOutbound` 是 Hub 出到客户端入口协议。不要把“客户端返回/进入”叫 response inbound。
- 看到 servertool/followup 响应 shape 错误时，先查 stage，不要找“servertool response”：servertool 只在 `HubRespChatProcess03Governed` 代客户端执行本地工具，后续必须走正常 `HubRespOutbound04ClientSemantic`。
- `/v1/responses` followup 红测必须断最终 client payload 顶层 `object=response`；`/v1/chat/completions` 红测必须断最终 client payload 是 Chat Completion shape 且没有被 Responses payload 直写。两个断言同时存在，才能证明 `HubRespOutbound04ClientSemantic` 是按入口协议做唯一相邻转换。

### 2026-06-04 stopless followup requestId 精华
- stopless / servertool 日志出现 `:stop_followup` 多次叠加或 codex-samples `File name too long` 时，先查 Rust `followup-core::build_followup_request_id` 的幂等与收敛；requestId 只能作为 followup identity carrier，不能按 hop 无限增长。
- 修复必须在 Rust followup-core 真源，TS bridge 缺 native 必须 fail-fast；验证要包含 Node 黑盒：`req:stop_followup:stop_followup:stop_followup -> req:stop_followup`，再 build/install/restart 5555。

## 2026-06-04 调试精华（direct / stopless / metadata）

- same-protocol direct / provider-direct 是 provider passthrough + hooks；`serverToolFollowup` 或 `:stop_followup` 不能禁用 direct、不能强制 relay、不能进入 Hub response chat-process，direct 响应不激活 stopless/servertool。
- Responses bridge / SSE client projection 禁止把 retention/context `metadata` 回写到 client payload；metadata 只能走 side-channel carrier，发现 `client response contains internal carrier field "metadata"` 时先查 bridge wrapper 是否重投 metadata，不要在 server projection 静默 strip。
- direct raw SSE 报 `[server.response_projection] client response contains internal carrier field "metadata"` 时，先确认 routeName 是否 `router-direct:*` / `port.provider-direct`；direct 应直接 pipe provider raw stream，不跑 response projection restore/guard，relay/non-direct 才保留该 guard。

### 2026-06-04 stopless/schema/abort 调试精华
- stopless missing/invalid schema 是连续 stop rejection budget，不是“无预算继续”；连续 stop 第 3 次必须走 budget-exhausted final summary，禁止无限 followup。
- `stopreason=blocked` 是合法停止态；schema parser 要接受数字与常见字符串态，不能因模型写 `"blocked"` 导致十几次不停止。
- 客户端断开是 servertool 生命周期最高优先级终止信号：server-side-tools / followup-mainline / reenter / client-inject / nested followup 都必须抛 `SERVERTOOL_CLIENT_DISCONNECTED`，禁止返回 completed 或继续 provider 请求。
- `exec_command` 安全校验只解析真实 tool arguments 的 `cmd`；不得扫描 prompt/history/工具结果文本来判定命令，sudo/osascript/admin 文本不是 broad kill，`xargs kill` 与 `kill $(...)` 才是禁止模式。
- stopless final projection 必须把 `<stop_schema>...</stop_schema>` / stopreason JSON 当控制结构剥离；允许解析、允许写 summary prefix，但禁止把 schema 原文作为 assistant text 返回客户端。

### 2026-06-04 response/stopless boundary closeout
- Client response guard must identify internal carrier by shape/scope, not by raw field name: legal protocol `metadata` is allowed; `metadata.routeHint` / `providerKey` / `__routecodex*` / `__rt*` remains fail-fast.
- direct/router-direct SSE must not bypass `ServerRespOutbound05ClientFrame` no-leak guard. Direct skips Hub Pipeline conversion, not client frame validation.
- Stopless schema parser must pick the first JSON object that actually has `stopreason`; earlier evidence JSON must not be treated as missing/invalid schema.
- Stopless visible final response strips only explicit control schema (`<stop_schema>` or fenced JSON schema object), preserving ordinary evidence blocks that mention `stopreason` text.
- Stopless budget is one consecutive-stop counter: missing-schema、provided-invalid、`stopreason=2` share `stopMessageUsed`; tool calls / non-stop progress reset it.

## 2026-06-04 请求字段等价精华
- `Responses -> Chat -> Responses` 投影禁止从 `ctx.parameters`、`ctx.metadata.parameters`、`ctx.metadata`、`ctx.toolsRaw` 或 context tool controls 补 live request 字段；这些只能作为 response-only/session/debug carrier，不能进入 ReqOutbound/ProviderReqOutbound。
- 审计请求字段等价时，不能只看 no-leak guard。必须同时跑跨协议矩阵红测，确认同一语义只从 ChatProcess/Chat 源字段进入 provider request。

### 2026-06-04 ErrorPolicyCenter 唯一链路精华
- 错误策略中心不是 `ErrorHandlingCenter`；它只允许做 HTTP/server/client projection。provider/runtime/direct/executor 错误必须进 `ErrorErr01SourceRaised -> ErrorErr02HostCaptured -> ErrorErr03RuntimeClassified -> ErrorErr04RouterPolicyApplied -> ErrorErr05ExecutionDecision -> ErrorErr06ClientProjected`。
- 分类先行：`recoverable | unrecoverable | special_400 | periodic_recovery`；retry/reroute/cooldown/fail 只能由唯一 policy decision 驱动。审计时先扫旧节点名与第二套 `recoverable/affectsHealth/shouldRetry/cooldown/reroute` 决策点。
- `provider-error-classifier` 只能做 host 捕获/adapter 记账并暴露 `resolveProviderFailureOutcome` 的 `classification/recoverable/affectsHealth`；禁止在 classifier、executor、direct 路径二次推导这些最终策略字段。
- executor reselection/keep-excluded 也属于错误策略消费端；禁止在 executor 直接写 `classification === ...` 组合决策，必须通过 `provider-failure-policy` helper 暴露的 policy outcome/decision。
- retry execution 只能消费 policy decision：`recoverable` 保持统一 retry/backoff 路径，`unrecoverable` 直返，只有 `periodic_recovery` 可触发显式替代路由；禁止在 executor 用分类比较重建这三类终端分支。

### 2026-06-04 ProviderForwarder sticky 精华
- Forwarder `stickyKey=session` 验证不能只跑 `ForwarderRegistry::select` 单测；必须覆盖 `engine::selection::select_provider` 从 metadata `sessionId/session_id/routecodexSessionId` 透传到 Rust registry，否则配置写了 sticky 但 live selection 实际按 request 轮换。

### 2026-06-04 direct passthrough/provider-wire 红线
- router-direct 不是 Hub Pipeline：只取 VirtualRouter target，禁止 `hubPipeline.execute`、禁止 req/resp inbound/outbound conversion；direct 只按入口协议与 providerProtocol 一致进入。
- `/v1/responses` direct payload 必须是当前客户端提供的 Responses wire；direct runtime 不做 chat `messages`/chat-style tool validator 或 sanitizer，客户端非法就让 provider fail-fast 返回。RouteCodex 自己生成/持久化的 Responses history 必须在 Hub/Responses store owner 保证合法，不能靠 direct 修。
- `/v1/responses` relay/Responses continuation 只能基于合法 persisted prefix 追加当前 incoming delta；不得修改 persisted prefix/basePayload，不得把 route/model 覆盖回写到 cached history。若 incoming 不是纯 delta、部分重放 prefix、或重放已完成 call_id，必须返回 null/fail-fast 走原 payload，而不是猜测修历史。

## 2026-06-04 调试精华（10000 loopback shadow）

- 若 `127.0.0.1:10000` 返回 `Empty reply from server`，先查 `lsof -nP -iTCP:10000 -sTCP:LISTEN`；macOS 上第三方服务可占 `127.0.0.1:10000`，同时 RCC 占 `*:10000`，导致 loopback 命中特定绑定而 LAN/Tailscale IP 正常。
- 多端口配置下显式 `rcc start --port <port>` 只能检查/启动目标端口，禁止因同组其他端口 healthy 提前退出；用 “requested port only” 红测锁住。

### 2026-06-05 硬编码 + Fallback 架构收口精华
- SSOT 唯一真源: `src/constants/index.ts` (API base / timeout / model / SSE caps) + `src/providers/core/runtime/provider-error-catalog.ts` (错误码) + `isWindsurfRuntimeIdentity` / `isWindsurfManagedProviderIdentity` (provider key 抽象, in `src/providers/core/contracts/windsurf-provider-contract.ts`)。
- Provider 特例物理位置: 只允许在 Provider runtime; Hub Pipeline / Virtual Router / RequestExecutor 任何 `windsurf.managed.` / `windsurf.` / `deepseek` / `qwen` 字符串前缀特判均违规; 改用 `providerFamily` 抽象 + helper。
- Rust `health.rs` 通用化: `clear_windsurf_managed_persisted_503_family` 已重命名为 `clear_persisted_503_family_for_provider`, 按 canonical provider key 匹配, 不特判 `windsurf.managed.` 前缀; 调用方 `record_success` 隐式传播。
- 物理删除铁律: 迁出后旧 Set / 旧 `if` 块 / 旧常量字符串必须删除; 保留必须经 `silent-failure-audit.mjs` + `hardcode-audit.mjs` 报警并写理由; 不得"不接入 / 不调用 / 注释掉"代替删除。
- 红测先行契约: TS 端 `tests/server/runtime/http-server/phase3-provider-family-abstraction.red.spec.ts` 锁住 3 个 server-runtime 文件零 `windsurf.managed.` / `windsurf.` 字面; Rust 端 `record_success_clears_persisted_503_family_for_non_windsurf_provider` 锁住 `health.rs` 双向行为 (deepseek.chat 清理 / qwen.turbo 不串台); 后续若新文件引入 provider key 字符串硬编码, 红测应 fail。
- 后续接手 Phase 4 必读: 静默 catch 清理前先跑 `node scripts/ci/silent-failure-audit.mjs` 拿基线 (488 / 5); 改后命中数 < 基线即合规; 新增 catch 必须满足 HAS_HANDLED_RE (warn/error/logger/report/emit/record)。
- 后续接手 Phase 5 必读: 新建 `scripts/ci/hardcode-audit.mjs` 扫 `src/` + `sharedmodule/llmswitch-core/src/` 找新增 provider key 字符串硬编码; package.json 加 `verify:hardcode` 串接 silent-failure-audit + hardcode-audit + hub-deterministic-audit + llmswitch-rustification-audit + check-file-line-limit。
- cargo test 副作用污染模式: 跑 `cargo test` 后会触碰 6-12 个 timestamp/auto-gen 文件, commit 前必须 `git status --porcelain` + 逐个 `git restore -- <path>` 排除; 唯一真实改动在 `health.rs`, 但 cargo 会再次标 M, 需 `git restore -- sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/health.rs` 恢复 commit state。
- plan 真源: `docs/goals/hardcode-fallback-arch-audit-plan.md`; 实施 commit 顺序: `2395b253a` (Phase 1) → `2eac128ef` (Phase 2) → `72a884092` (Phase 3 TS) → `7295f0e4` (Phase 3 Rust) → Phase 4-6 待续。

### 2026-06-06 5555 route_failed / metadata carrier 精华
- 看到 5555 `No available providers after applying routing instructions` 时，先查 `~/.rcc/sessions/provider-health.json` 与 `~/.rcc/sessions/127.0.0.1_5555/provider-health.json`；若 cooldown 为空且配置池非空，不要归因 health，继续按最新样本/diag 追下一个 blocker。
- OpenAI Responses provider 顶层 `metadata` 是合法 provider 响应字段，但进入 Hub response normal payload 前必须移入 `Meta*` carrier（当前为 `normalized_metadata.providerResponseMetadata`）；禁止让它进入 `HubRespInbound02Parsed` normal payload，也禁止在 client projection 静默 strip。
- 全局安装隔离构建失败若提示 llmswitch-core required output 缺失，先核对 required output 是否仍有源码 owner；`dist/bridge/routecodex-adapter.js` 已是旧契约，不得恢复死文件来满足校验。
- SSE 线上复测必须显式带 `Accept: text/event-stream`；否则日志 `acceptsSse=false` 只能证明客户端未声明 SSE，不可当作 SSE 回归。
- longcontext token-threshold 不能把非空 configured pool 筛成 `PROVIDER_NOT_AVAILABLE`：当 `context_hard_limit=false` 时，overflow-context provider 仍必须可被选中，由上游真实尝试/失败显式暴露；修点在 Rust Virtual Router selection，不在 TS executor/handler 补 provider。
- Client SSE guard 禁止按字段名裸拦 `metadata`：OpenAI Responses SSE event 顶层 `metadata:{}` 和 `response.metadata` 是公开协议字段；只在 metadata 值含 `routeHint/providerKey/__routecodex*/__rt*` 等内部 carrier shape 时 fail-fast。
- Servertool 执行迁移方向：Phase 1 保留注入/拦截，但拦截后必须投影为真实客户端 `exec_command` CLI (`routecodex servertool run <toolName> --input-json <json>`)，结果按普通客户端 `exec_command` 工具结果回传；不使用旧 restoration 机制，不恢复内部 model tool identity。详细设计见 `docs/design/servertool-cli-projection-migration.md`。

## 2026-06-06 servertool CLI projection Phase 1 精华

- servertool CLI projection 的最小闭环必须锁三件事：response-side 投影 `exec_command` + CLI dispatcher 执行 + 普通客户端工具结果回传；任何 old restoration or single-use result remapping 设计均为旧方案污染。
- `apply_patch` 已从 servertool 语义中排除，相关 architecture verifier / function map 必须检查“servertool handler 不存在”，不能继续引用旧 `handlers/apply-patch.ts`。
- stopless CLI 生命周期必须把原 followup 注入文本、连续 stop 次数、最大次数写入 `--input-json`，CLI stdout 原样返回这些字段；下一轮只根据普通 `exec_command` 工具结果继续，禁止再次投影同一个 `stop_message_auto` 造成循环。
- stopless CLI projection 必须先判定“需要续杯”：普通 `finish_reason=stop` 且已有可见正文、无显式 stopless/goal 状态时必须 passthrough；红测要断无 `exec_command`、无 `required_action`、SSE 仍输出 `output_text`。

## 2026-06-06 provider switch / retry 经验
- 若线上日志出现同一 provider 错误反复打或 `No available providers`，先用同一 `clientRequestId` 查 `~/.rcc/codex-samples/.../ports/<port>/**`：必须看到失败 provider request 后有另一个 provider response；没有第二 provider 样本，优先查 executor 是否把 provider-switch 预算错误绑定到 `maxAttempts`。
- provider 切换不是同 provider retry：任意 provider 错误只要 route pool 有未排除候选，就应写入 `excludedProviderKeys` 并 `exclude_and_reroute`；日志应包含 `[provider-switch] ... decision=provider_backoff_then_reroute`，避免模型/用户看到无反馈循环。

### 2026-06-06 direct retry wrapper 红线（2026-06-07 修正）
- router-direct 只能做 same-protocol provider passthrough + hooks；禁止本地重写 recoverable/affectsHealth/cooldown/reroute policy，禁止 provider-specific fallback，禁止把 429/5xx 投到 `ErrorHandlingCenter` 后直返。
- direct provider error 的允许路径：记录 `router-direct.send.error` → 调统一 `resolveRequestExecutorProviderFailurePlan` / Router policy decision → 若返回 `retrySwitchPlan`，只生成 `retryMetadata` 并交回标准 pipeline retry；否则原错误 fail-fast。direct 仍不得自己分类或冷却 provider。
- 429 after direct/preselected route 的关键修点是 `decorateMetadataForAttempt` 清除 `__routecodexPreselectedRoute`；否则第二跳会忽略 `excludedProviderKeys` 又打回同一 provider。
- direct 不因 `stopless` / `stopMessage` / servertool armed 改走 relay，也不在 direct response 侧激发 stopless；需要 stopless 的请求必须本来就在 relay/Hub response chain。排查“relay 不续杯”时先确认日志不是 `router-direct:*`，再看 `provider.response_convert.start serverToolsEnabled=true` 与 `[servertool] ... stop_message_auto`。
- `/v1/responses` 出现 `Responses wire requires top-level tool.name` 时，先对照 live 原始 client request / provider-request snapshot / native sanitizer 输出，确认 tool shape 首次变坏的节点；不要默认归因 direct 入口，也不要把合法 flat Responses tools 因为“有工具”改走 relay。已验证一次根因是 Rust `sanitize_provider_outbound_payload_json` 把合法 `{type:"function", name,...}` 改成 chat-style `{type:"function", function:{...}}`；唯一修复点是 provider outbound sanitizer 按协议保持 wire shape。

## 2026-06-07 Responses SSE terminal repair 精华
- Responses SSE terminal repair/dedupe 的唯一语义 owner 是 Rust native `shared_responses_response_utils.rs`。TS handler 只能 buffer/split SSE、调用 native probe update、调用 native terminal frame builder、写 native 返回的 client frames、管理 stream lifecycle。
- 若 residue/audit 命中 TS 在 terminal repair 中读取 `response.required_action` / `submit_tool_outputs` / `tool_calls`、把 required_action 推导成 `tool_calls`、或按 required_action 过滤 native repair frames，必须迁回 Rust probe/frame builder，而不是在 TS 再补一层判断。
- Required_action terminal contract：只补缺失的 `response.required_action`，不得补 `response.completed`；只补缺失的 `response.done` / `[DONE]`。Rust 改完后必须跑 `node scripts/build-core.mjs`，否则 Node blackbox 仍加载旧 `dist/native/router_hotpath_napi.node`。
- 5555 direct/relay 混跑时，若 `/v1/responses` direct SSE 在 `required_action` 后 client close 且缺 `response.done`，不要清 Responses store，也不要强制 direct->relay；TS handler 只基于 native probe 的 continuation 结论调用 native SSE conversation persistence，普通 partial delta close 仍按 abandoned request 清理并报 `upstream_stream_incomplete`。

## 2026-06-07 Responses conversation store bridge 精华
- Bridge/runtime integrations 操作 Responses conversation store 时必须命中同一个 active singleton。若 global store 缺方法，不要在 bridge 里 fallback import core dist；dist import 可能覆盖 `globalThis.__rccResponsesConversationStore`，造成 source/test store 与 runtime bridge store 分裂。
- 需要 bridge 调的方法应挂到 `ResponsesConversationStore` class 并由 exported helper 委托同一 store；禁止在 bridge 侧用 requestMap introspection 或另一个 dist store 补偿。
- router-direct 成功 Responses result 若要支持 scope continuation，必须 record response scope (`sessionId`/`conversationId`/routingPolicyGroup/providerKey) 并显式 opt-in；失败状态或 SSE wrapper 必须 clear captured request，避免 pending request payload orphan。
- `/v1/responses` SSE `client_close closeBeforeStreamEnd=true` 不能一律当 abandoned cleanup；若 native contract probe 已证明 `required_action` / tool-call continuation，必须先 persist native SSE conversation state 并保留 submit_tool_outputs continuation。只有非 tool continuation 的提前关闭才清 captured request/store。

## 2026-06-06 apply_patch 高效编辑法（沉淀）
- 想在 yml/JSON/MD 末尾追加大块内容时，先用空行 sentinel 单独 patch 一行（如 `__LONGTAIL_TAIL_SENTINEL__`），然后第二次 patch 用 sentinel 作为 find-context 并把 `+` 行接在它后面，sentinel 行用 `-` 删掉；这样 verifier 的 find-context 短、匹配稳。
- JSON / TS / Rust 文件中插入 anchor 注释（`// feature_id: <id>`）时 find-context 必须包含"原始完整行"：原文件首行如 `import { Command } from 'commander';` 后有空行，patch 的 find-context 也必须保留该空行；空行被吃会导致 verifier 失败。务必用 `head -3` 先打印精确字节。
- 长行（`package.json` `verify:architecture-ci` 链动辄 1800+ 字符）不要做单 patch 的 find+replace；分两步：(1) 用 `+` 在该行下面注入新行（短小 find-context）；(2) 在 file 末尾另开新 script 名称独立追加，不要尝试在 ci 链尾部接 `&&`。
- 修改 function-map 的 `canonical_builders` 前先 `grep -nE "^pub fn|^export (async )?function"` 真源文件，确保 builder 名在 owner_module 内真有定义；否则 `verify:function-map-canonical-builder-definitions` 会 fail。Rust 端前缀 `clear_/consume_/is_/cooldown_` 等必须 1:1 匹配函数名。
- 修改 `canonical_types` 前先 `grep` 全仓库同名字面量；与 `forbidden_paths` 下任何文件命中的字面量（哪怕只是字符串字面量提及或测试 fixture）都会被 `verify:architecture-forbidden-path-growth` 拦截。改用不会冲突的同义名。

## 2026-06-06 function-map longtail closeout 精华
- 8 个新 feature 全部以 Rust 真源为 owner_module（P1-1/2/4/5/6/7）；唯一 TS owner 仅 `manager.token_runtime`（src/token-daemon，无 Rust twin）和 `quota.unified_control_surface` 的 TS 桥接；`error.provider_failure_policy` 显式列入 `verify-architecture-ts-owner-ban` 的白名单。
- `verify:architecture-duplicate-owner` 规则：leaf-file owner（`.rs/.ts`）被多 feature 共享时，仅当 canonical_builder 集合存在交集才视为真冲突；这是 `req_outbound_stage3_compat/responses/request.rs` 4 feature 共享的合法模型（每个 feature 描述一个独立 builder）。
- 3 个新 gate：deleted-path（拦截 `required_tests/required_gates/allowed_paths` 指向已删文件）、duplicate-owner（owner 唯一性 + keyword 动作对跨 family 检测）、ts-owner-ban（除白名单外 TS 壳不得作为 owner）。注册为独立 `verify:architecture-ci-longtail` 链，不并入长 `verify:architecture-ci`（避免 1800+ 字符 find context 死循环）。
- 完成标准：25 features（17 旧 + 8 新），全套 `verify:architecture-ci` 与 3 个新 gate 全绿。

## 2026-06-06 direct tools / provider outbound shape 复测精华

- Same-protocol direct 是否成立只看入口协议与目标 provider protocol，和有没有 `tools[]` 无关；合法 Responses flat tools 必须继续 direct。禁止用“工具存在 / chat-style 变体”作为 direct->relay 选择依据。
- `Responses wire requires top-level tool.name` 的正确取证顺序：先看原始 client request 是否已经是 flat `{type:"function", name, parameters}`；再看 Rust provider outbound sanitizer / provider-request snapshot 是否把它改成 `{type:"function", function:{...}}`。若原始合法而 provider-request 变坏，根因在 outbound sanitizer/provider wire builder，不在请求前清洗，也不在 direct 入口。
- Responses provider wire shape 红线：`openai-responses` 出站 `tools` 必须保持 top-level `{type:"function", name, parameters}`；`openai-chat` 才使用 `{type:"function", function:{...}}`。协议归属必须静态/红测锁住，避免 chat tool shape 进入 Responses wire。
- 复测 10000 时若 `127.0.0.1:10000` 返回 `Empty reply from server`，先用 `lsof -nP -iTCP:10000 -sTCP:LISTEN` 查端口冲突；本机 BaiduNetdisk 可能占用 `127.0.0.1:10000`，可用本机 LAN IP 命中 RCC 的 `0.0.0.0:10000` 监听做对照。

## 2026-06-06 direct provider error / preselected route reselection lesson
- Direct provider errors must not be locally retried/rerouted in router-direct. Direct records `router-direct.send.error` and rethrows; request-level provider switching belongs to the executor/error chain, not a direct wrapper.
- 429 after a preselected direct miss can still leak to client if retry metadata keeps `__routecodexPreselectedRoute`: the second Hub execution will reselect the same failed provider and ignore `excludedProviderKeys`. Fix owner is `decorateMetadataForAttempt`: when `excludedProviderKeys.size > 0` or `attempt > 1`, remove `__routecodexPreselectedRoute` so Virtual Router can choose the next provider.
- Required red test: request-executor must cover “provider 429 with preselected route clears preselection and selects backup”; live smoke should show first `[provider-switch] ... exclude_and_reroute`, second `[virtual-router-hit]` to a different provider, then 200.

## 2026-06-06 调试精华（10000 loopback shadow / stopless metadata）

- 10000 若 `LAN /health` 正常但 `127.0.0.1 /health` empty reply，优先查 loopback-only shadow listener；macOS 可同时存在 `127.0.0.1:PORT` 与 `*.PORT`，必须启动前 fail-fast，禁止按 IP 做端口特例或把它误判为 RouteCodex block IP。
- stopless/session metadata owner 只解析并绑定 scope：header/body/user metadata 的 tmux/session/workdir 是请求事实，不能在 metadata builder 阶段因 tmux liveness 抹掉；tmux alive 检查属于后续注入/cleanup owner。

## 2026-06-07 servertool CLI / stopless closeout 精华

- `stop_message_auto` migrated path 必须同时锁 projection 和 CLI executor：projection 生成 `exec_command routecodex servertool run stop_message_auto --input-json <json>`；CLI executor 必须强制 `flowId=stop_message_flow`、`continuationPrompt`、`repeatCount`、`maxRepeats`，缺失直接 fail-fast，禁止默认 summary 或固定“继续执行”兜底。
- stopless CLI counters 读取必须按字段级优先级：`metadata.serverToolLoopState.repeatCount/maxRepeats` -> `metadata.__rt.serverToolLoopState.repeatCount/maxRepeats` -> `metadata.__rt.stopMessageState.stopMessageUsed/stopMessageMaxRepeats`；禁止对象级 `??` 短路，否则顶层 loopState 缺字段会遮住 `__rt` 真值。
- 旧 ticket/restoration 审计要分两层扫：精确 marker (`--ticket|stcli_|rcc_cli_|cli-ticket|ServertoolCliTicket|tryRestoreServertoolCliToolOutputs`) 用于证明 runtime/src/tests 无旧 ticket；宽词 `restore/restoration` 必须分类为 servertool 禁止性 marker、Responses continuation 正常语义、或无关 git restore 文案，不能把宽词命中误当旧设计复活。

### 2026-06-07 servertool Rust binary Phase 1 closeout 精华

- servertool 最终执行形态是独立 Rust binary `routecodex-servertool`（`sharedmodule/llmswitch-core/rust-core/crates/servertool-cli/`），不是 TS command handler；`servertool-core` 是 lib，提供 decision/contract/builder/gate/prompt/budget/projection。
- CLI contract 入口：`routecodex-servertool run <toolName> --input-json <json> [--flow <flowId>] [--repeat-count N --max-repeats N]`；输出 schema 由 Rust `servertool-core` owner，TS 不得发明字段。
- stopless schema 闭环 Rust owner：`stopless_schema_guidance()` 返回 `schemaGuidance`（required_fields 含 stopreason/reason/has_evidence/evidence/issue_cause/excluded_factors/diagnostic_order/done_steps/next_step/next_suggested_path/learned；stopreason_values: 0=finished/1=blocked/2=continue_needed）。
- projection schema Rust owner：`build_client_exec_cli_projection_output()` 构建 execCommand + schemaGuidance + repeatCount + maxRepeats；旧 `--ticket` / `stcli_` / `rcc_cli_` 标记在 Rust unit test 中被显式拒绝。
- exec result validation Rust guard：`validate_client_exec_command_result()` 在 exec result 进入 req_chatprocess 前校验 tool_name=stop_message_auto + flow_id=stop_message_flow；错误返回 SERVERTOOL_UNSUPPORTED_TOOL / SERVERTOOL_CLI_MISSING_FIELD / SERVERTOOL_CLI_INVALID_FIELD。
- TS 红线（Phase 1 已锁定）：TS 不得写 servertool 业务逻辑，不得 fallback 默认 summary，不得从 exec_command stdout 恢复 model tool identity；TS 只允许 spawn routecodex-servertool / parse stdout/stderr / write exec_command result / emit error event。旧 TS CLI handler 在 Rust binary parity 后物理删除。
- Phase 1 验证命令：`cargo build -p servertool-cli` / `cargo test -p servertool-core`（32/32）/ `cargo test -p servertool-cli`（3/3）/ `node scripts/tests/servertool-cli-binary-blackbox.mjs`（5/5）/ `node scripts/verify-servertool-rust-only.mjs`（全 PASS）。
- 整链路边界：Phase 1 覆盖 binary contract + projection schema + result validation + old marker 拒绝；完整 HTTP pipeline 串联（HubRespChatProcess03 拦截 → exec_command projection → 客户端执行 → exec result 回链 → req_chatprocess 03 工具改名 → schema 注入）是 Phase 2 目标，需要 HTTP blackbox 覆盖。
- 整链路已知覆盖：`stopless-followup-blackbox.mjs` 覆盖 server-side stop→followup（BackendRouteReenter），但不覆盖 ClientExecCliProjection 完整链；`tests/servertool/servertool-cli-projection.spec.ts` 覆盖 TS projection 格式，但不覆盖 Rust schema owner 身份。

## 2026-06-07 servertool stopless CLI Phase B-E closeout 精华

- Phase B outcome classification Rust owner：`classify_servertool_outcome()` 在 `servertool-core/src/outcome_contract.rs`；stop_message_auto/servertool_fixture→ClientExecCliProjection，web_search/vision_auto→BackendRouteReenter，memory_cache_auto→ServerIoInternal；fake_exec/--ticket/stcli_/rcc_cli_ 在 Rust 层被拒绝。
- Phase C tool name projection Rust owner：`project_exec_command_result_to_model_tool_result()` 在 `servertool-core/src/tool_name_projection.rs`；exec_command result → model-side original tool name 转换；验证 tool_name/flow_id/denied markers；web_search 不得投影为 ClientExecCliProjection。
- Phase D needs_user_input gate：模型输出 `needs_user_input: true` + `next_step` 填问题内容 → Rust gate AllowStop 不计 budget；next_step 为空 → Followup 要求补问题；判断标准不暴露给模型（stopreason 不含 3）。
- Phase E TS fallback deletion：`stop-message-counter.ts` 的 `resolveDefaultSnapshot` / fallback branch 已物理删除；`tryNativeBudget` catch 改为 throw `SERVERTOOL_NATIVE_BUDGET_FAILED`；`applyStopMessageFinishReasonBudget` 无 TS fallback。
- Rust 测试总数：servertool-core 54 + servertool-cli 3 + stop-message-core 42 = 99 tests ALL PASS。
- 覆盖边界：Rust unit test 已覆盖分类/projection/gate/schema；HTTP blackbox 整链路（拦截→exec→exec result→改名→schema 注入）需要完整 server 启动，当前未覆盖。

## 2026-06-08 VR media token estimate / priority longcontext 精华

- VR token estimate 只能影响路由估算，不得裁剪/改写真实 payload。Rust owner 是 `virtual_router_engine::features`; stringified structured `message.content` 必须先解析，image/video/base64 payload 在 message content 估算中应忽略，避免图片请求被错误推入 longcontext 或非多模态路线。
- priority longcontext 的上下文安全分类只能过滤不可用/硬溢出目标，不能重排原始 priority target 顺序；若日志显示 priority 路由命中后置大窗口 provider，先查 `maxContextTokens` 与 selection context classification，不要改配置当作唯一修复。
- 端口级 forwarder 排查先看 sample `client-request.json` 的 `metadata.allowedProviders`：若 routing target 是 `fwd.*` 但 allowlist 只有 `fwd` 而没有 forwarder 内真实 provider（如 `sdfv/llmgate/asxs/cc`），根因在 HTTP router port allowlist 构造，不在 Rust priority selection。修点是 `extractProviderKeysForRoutingGroup()` 展开 `virtualrouter.forwarders.*.targets`。
- llmgate/free-gpt-5.5 `EMPTY_ASSISTANT_RESPONSE` 若样本是 `/v1/responses completed + output=[]`，先核对 provider-request 是否真正是 upstream SSE：`Accept:text/event-stream` 且 body `stream:true`。`responses.streaming="always"` 是 provider upstream 传输策略，不能被 client `stream:false` 覆盖；修点在 `ResponsesProvider`，不是 response contract 或路由 fallback。
