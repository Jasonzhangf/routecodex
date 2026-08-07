# V3 Web Search ServerTool 状态机 — 实现计划

> 设计真源：`docs/goals/v3-web-search-servertool-state-machine-proposal.md`（已定稿，Jason 审批）
> 本文档只承载实现步骤 / 文件清单 / 验证矩阵 / DoD；设计语义一律以 proposal 为准，不在此重复。
> map 登记：`v3.web_search_servertool_state_machine`（v3-function-map.yml / v3-verification-map.yml，status: design，mainline `v3-web-search-sm-01~08` binding_pending）
> claim：`.agent-collab/claims/v3.web_search_servertool_state_machine/owner.json`（active）

## 1. 目标与验收标准

按已定稿 proposal 实现 V3 web_search ServerTool 状态机闭环（Mode A 原生透传 + Mode B 本地搜索自动续轮），并把 StoplessCenter 升级为通用 ServerToolCenter（stopless 为第一个注册工具、行为不变）。vision（media semantics 治理）为独立后续 feature，不在本计划主体内。

验收标准（proposal §Completion Gates 全文，摘要）：
- StoplessCenter → 通用 ServerToolCenter（typed per-tool/per-session 操作已登记资源 map，stopless 行为零变化）
- Req04 工具面决策：有 GPT native-search 目标保留标准 `web_search`；否则替换为本地 `websearch`（exactly once，普通工具不动）
- Resp03 拦截实际 `websearch` call → 强制 `route=websearch` → 重入 VR search-dispatch edge 一次额外 hop → 拦截搜索响应 → `SearchResultCaptured`
- 投影 Responses `web_search_call` 等价结果（started/completed、query、action、text_result、ref_id/citation）+ 原 call_id 配对 function output
- 下一轮 Req04 恢复：读 websearch 实例 → 验证 call-id 配对 → 注入搜索结果（不重建 entry payload）
- 全链路状态只进 ServerToolCenter 控制资源，零泄漏

## 2. 范围与边界

In Scope：
- ServerToolCenter 泛化（common.rs 通用注册表 + stopless 迁移 + websearch 新实例）
- Req04 工具面决策（Mode A/B）
- Resp03 拦截/剥离 + 强制 VR search-dispatch hop + 搜索响应拦截
- 搜索结果投影（Codex 契约对齐）+ 原 call_id 续轮注入
- v3-config 编译（model search mode + 唯一 backend binding）
- v3 map/contract 绑定（resource/function/mainline/verification）
- 红测/绿测 + 架构 gates + live 验证

Out of Scope：
- vision media semantics（独立 feature，后续）
- 引擎 fallback 迭代（禁止）
- 第二套 VR / entry payload 重建 / 主模型 re-entry（禁止）
- provider 特例分支进 Hub/VR（禁止，一律编译期 manifest typed fact）
- provider-direct / non-Responses direct 注入或激发（禁止）

## 3. 设计原则

- 控制面与 payload 物理隔离：ServerToolCenter 状态只进 MetadataCenter 控制资源；禁止 provider body / client payload / CLI stdout / continuation store / debug payload
- 同轮 provenance：注入/剥离/恢复必须同 scope、同 request、同 toolName、同 call-id；历史与 continuation 不可变区不得修改
- fail-fast：搜索失败进 Error01-06，禁止投影为成功、禁止 fallback 引擎、禁止静默 strip
- Rust-only：所有语义在 v3 Rust crates；TS 不新增功能代码
- 红测先行：每个阶段先固化为红的 failing test，再改唯一真源转绿

## 4. 技术方案（含文件清单）

### 4.1 ServerToolCenter 泛化（step 1）
`v3/crates/routecodex-v3-runtime/src/hub_v1/common.rs` 新增：
- `V3ServerToolName`（Stopless / WebSearch，as_str/parse_str）
- `V3WebSearchCenterPhase`（Idle / LocalToolSurfaceActive / ToolCallObserved / SearchDispatchPrepared / SearchInFlight / SearchResultCaptured / HostedResultProjected / MainModelContinuationPrepared / Completed / Failed）
- `V3WebSearchCenterState`（phase、transition_reason、execution_budget、original_call_id、query/count/recency/content_types、backend_binding、normalized_result、typed_failure、last_request_id/response_id、updated_at；相邻迁移校验）
- `V3ServerToolInstanceState`（enum：Stopless(V3StoplessCenterState) / WebSearch(V3WebSearchCenterState)）
- `V3ServerToolCenterKey`（toolName + scope：entryProtocol+endpoint+serverId/port+routingGroup+sessionId+toolRunId）
- `V3ServerToolCenter`（Mutex<BTreeMap<Key, Instance>>；register/load/store/transition/clear；跨工具/跨 session fail-fast）

relay/direct 装配：
- `responses_relay_runtime.rs`：`V3ResponsesRelayStoplessControlState` 升级为通用 `V3ResponsesRelayServerToolControlState`（或并列持有 center），stopless 调用点迁移为 stopless 桶（行为不变）
- `kernel/direct_state.rs` + `direct_stopless.rs` + `direct_runtime_helpers.rs` + `kernel.rs`：direct 侧同样迁移
- `hub_v1.rs` 导出

红测：跨工具/跨 session 隔离、非法相邻迁移 fail-fast、stopless 行为等价。

### 4.2 map/contract 绑定（step 2）
- `v3-resource-operation-map.yml`：`v3.servertool.state_machine_control` 资源升级为通用（allowed_writers 引用 `V3ServerToolStateManager`）；新增 backend binding 资源
- `v3-function-map.yml`：`v3.web_search_servertool_state_machine` design → 绑定真实符号
- `v3-mainline-call-map.yml`：`v3-web-search-sm-01~08` binding_pending → binding_anchored（真实 caller/callee symbol）
- `v3-verification-map.yml`：红测/绿测 gate 落位

### 4.3 Config 编译（step 3）
`v3/crates/routecodex-v3-config/src/types.rs`：`V3WebSearchExecutionMode` 语义化（`native_remote_search_tool_mix` / `metadata_center_local_search` / `none`），编译 exactly one backend binding（provider 池 binding，如 search provider），`v2_compat.rs` 映射不动。

### 4.4 Req04 工具面决策（step 4）
`servertool_hooks.rs`（或 `req_chat_process_04_governed.rs`）：post-route GPT 资格判定（消费编译期 typed fact，禁 provider 前缀）→ 保留标准 `web_search`（Mode A）或替换为本地 `websearch` function tool（Mode B，`request_outbound_builtin_tool_projection.rs::build_local_web_search_function_tool` 复用）+ ServerToolCenter[websearch].LocalToolSurfaceActive。

### 4.5 Resp03 拦截 + 强制 search-dispatch（step 5）
`servertool_hooks.rs::apply_v3_tool_call_servertool_hook_at_resp03` 扩展 websearch 分支：
- 同轮激活校验 → 参数校验 → ToolCallObserved
- MetadataCenter 写强制 `route=websearch`
- 从当前 canonical context 构建 typed 搜索请求 → 重入 VR registered search-dispatch edge（`v3-virtual-router/src/lib.rs`，一次额外 hop，正常 SelectedTarget → ReqOutbound → Provider → RespInbound）
- Resp03 拦截搜索响应 → SearchResultCaptured

新 dispatcher owner（先登记资源）：typed WebSearchExecutionRequest → one backend binding → typed WebSearchExecutionResult；无 fallback 迭代。

### 4.6 投影 + 续轮（step 6）
- Resp03：投影 hosted `web_search_call` 等价结果（started/completed、query、action、text_result、ref_id/citation；对齐 `~/code/codex/codex-rs` 契约）+ 原 call_id 配对 function output → HostedResultProjected
- Resp04 save finalized canonical context
- 下一轮 Req04（`relay_request.rs` restore 之后）：读 websearch 实例 → 验证 call-id 配对 → 注入 stored canonical search result（不重建 entry payload）→ Completed

### 4.7 测试与 gates（step 7）
proposal §Test Design 全量（8 red + 7 positive + 6 negative），加：
- `verify:v3-resource-map` / `verify:v3-mainline-caller-flow` / `verify:v3-architecture-docs` / `verify:servertool-rust-only` / `build:v3-cli`
- 红测：`search_content_types` → MiniMax/GLM OpenAI Chat `UnmappedOutboundFields` 先红后绿

### 4.8 运行时验证（step 8）
全局安装 + 聚合重启 + 全部成员端口 health + 同入口 live 旧样本（MiniMax/GLM 502）复测 + Codex review。

## 5. 风险与规避

| 风险 | 规避 |
| --- | --- |
| stopless 迁移回归 | 纯新增优先 + stopless 桶行为等价红测 + 既有 stopless gates 全绿 |
| 控制状态泄漏 payload | ServerToolCenter 状态仅 MetadataCenter 控制资源；红测锁泄漏即 fail-fast |
| "重入"越界成第二 VR / 主模型 re-entry | 只重入 VR registered search-dispatch edge（一次额外 hop）；红测禁止项 |
| provider 前缀特判复活 | 编译期 manifest typed fact，runtime 只消费；架构 gate 扫 provider key 特判 |
| 502 回归（MiniMax/GLM） | 先固化红样本（UnmappedOutboundFields）再绿化，live 同入口复测 |

## 6. 测试计划

- 单元：ServerToolCenter 隔离/迁移、websearch 状态机迁移、参数校验、backend binding 唯一性
- 集成：Req04 工具面决策（Mode A/B）、Resp03 拦截、强制 search-dispatch hop、投影、下一轮注入
- 黑盒：Responses 入口 + MiniMax/GLM OpenAI Chat 目标 502 样本
- 架构 gates：见 4.7
- live：全局安装 + 聚合重启 + health + 旧样本重放

## 7. 实施步骤（顺序）

1. ServerToolCenter 泛化（common.rs + relay/direct 装配 + 红测）
2. map/contract 绑定（resource/function/mainline/verification）
3. Config 编译（mode + backend binding）
4. Req04 工具面决策（Mode A/B）
5. Resp03 拦截 + 强制 VR search-dispatch（含 dispatcher 登记）
6. 投影 + 下一轮 Req04 恢复注入
7. 红测/绿测 + 架构 gates
8. 运行时验证 + Codex review

## 8. 完成定义（DoD）

- proposal §Completion Gates 全部满足（含 StoplessCenter 泛化、dispatcher 登记、mainline 替换、map 更新、502 红样本证据）
- 全部架构 gates 与定向测试绿
- 全局安装 + 一次聚合重启 + 所有成员端口 health OK
- 同入口 live 旧样本（MiniMax/GLM 502）复测通过，真实搜索输出与 scope 隔离可证明
- Codex review PASS（逐模块越界检查）

## 9. 已确认决策（Jason 审批，2026-08-06）

- 续轮桥接：重入现有 VR 的 registered search-dispatch edge（一次额外 hop，原 call_id 继续主模型）；非客户端 CLI、非主模型 re-entry
- 搜索后端：走 VR search provider 池（proposal 立场）
- vision 范围：media semantics 治理（独立后续 feature）
- 实施顺序：先 websearch 后 vision
- 客户端响应合同：hosted-search 等价（started/completed、query、action、text_result、ref_id/citation），参考 `~/code/codex/codex-rs/app-server/tests/suite/v2/web_search.rs`

## 10. 任务 goal 提示词（可直接作为 /goal 使用）

```text
/goal
目标：按已定稿 proposal 实现 V3 web_search ServerTool 状态机闭环（ServerToolCenter 泛化 + Mode A 原生透传 + Mode B 本地搜索自动续轮 + 原 call_id 结果配对注入），并完成架构 map/contract 绑定与全量验证。

说明：本任务不再写新的提示词，直接按实现文档执行。

实现文档：
- docs/goals/v3-web-search-servertool-state-machine-plan.md（实现计划，步骤/文件清单/验证矩阵/DoD）
- docs/goals/v3-web-search-servertool-state-machine-proposal.md（设计真源，已定稿）
- .agents/skills/rcc-dev-skills/SKILL.md（P0 护栏与调试顺序）

执行规范：
- 先读 v3-function-map / v3-mainline-call-map / v3-verification-map / v3-resource-operation-map 中 v3.web_search_servertool_state_machine 定义，锁定 owner 与 allowed/forbidden paths，再动手；写完做 diff 越界自检
- 禁止脚本批量替换；逐文件读取核实后用 apply_patch hunk 手工修改
- ServerToolCenter 控制状态只进 MetadataCenter 控制资源，禁止进入 provider body / client payload / CLI / continuation store / debug payload；泄漏必须 fail-fast，禁止 silent strip 与 handler/SSE/outbound 补偿
- 禁止 fallback 引擎迭代、第二套 VR、entry payload 重建、主模型 re-entry、provider 前缀特判进 Hub/VR（一律消费编译期 manifest typed fact）
- 红测先行：每个阶段先固化 failing test 确认红，再改唯一真源转绿；stopless 迁移必须行为零变化
- 实现前先刷新 .agent-collab/（claims/owner.json 已 active：v3.web_search_servertool_state_machine），保留并行 worker 的无关 dirty worktree

验证：
- ServerToolCenter 隔离/迁移单测（跨工具/跨 session fail-fast、相邻迁移合法性、stopless 行为等价）
- proposal §Test Design 全量红/绿测（8 red + 7 positive + 6 negative），含 MiniMax/GLM 502 红样本（UnmappedOutboundFields）先红后绿
- 架构 gates：verify:v3-resource-map / verify:v3-mainline-caller-flow / verify:v3-architecture-docs / verify:servertool-rust-only / build:v3-cli
- 运行时：全局安装 + 一次聚合重启 + 全部成员端口 /health + 同入口 live 旧样本复测（真实搜索输出 + scope 隔离可证明）
- 最终 Codex review PASS

完成标准：
- ServerToolCenter 泛化落地且 stopless 行为零变化；web_search 闭环（注入→拦截剥离→强制 VR search-dispatch→hosted 投影→原 call_id 下轮注入）端到端可用
- 客户端收到 hosted-search 等价结果（started/completed、query、action、text_result、ref_id/citation），内部 websearch 细节零泄漏
- v3.web_search_servertool_state_machine 在 function/mainline/verification map 中绑定真实符号并转 active
- 所有 gates 绿、live 复测通过、Codex review PASS，vision（media semantics 治理）作为独立后续 feature 另行排期
```
