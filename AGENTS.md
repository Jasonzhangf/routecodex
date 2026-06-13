# RouteCodex Project AGENTS（入口与路由索引）

## 全局硬护栏（Hard Guards）
1. **单一路径真源**：`HTTP server -> llmswitch-core Hub Pipeline -> Provider V2 -> upstream`，禁止旁路。
2. **llmswitch-core 主导工具与路由**：Host/Provider 不得重建工具治理与路由语义。
3. **Rust runtime 语义真源**：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/`。
4. **Fail-fast + no fallback**：严禁一切 fallback/降级/兜底逻辑，错误必须显式暴露，禁止静默失败。
5. **先验证后结论**：无文件/日志/测试证据，不得宣称完成。
6. **非授权不破坏**：未获明确授权，不做删除/回滚/迁移/发布类破坏动作。
7. **禁止进程杀戮命令**：禁用 `kill/pkill/killall/taskkill/lsof|xargs kill` 等。
8. **llmswitch-core 禁止新增 TS 功能代码**：如有必要，一律转为 Rust 实现，TS 仅允许保留最小调用壳层。
9. **Hub Pipeline / Chat Process 必须 Rust-only**：凡属 Hub Pipeline / chat process / req_chatprocess / resp_chatprocess / servertool followup orchestration 的语义、判定、修复、兼容、sanitize、tool list 注入与裁剪，唯一真源必须在 Rust，TS 收缩为薄壳转发。
10. **只写必要代码，且必须最小合规**：新增/修改代码前，先证明它是完成当前需求所必需的；禁止加入用户未要求、问题未证明需要、或不影响验收的代码。实现必须保持最小合规面，能删则删，能不加就不加。
11. **已移除 provider 禁止复活**：已物理删除的 provider 不得恢复其 runtime、contract、probe、harness、compat profile、fixture、script、test、doc 或 config 入口，除非 Jason 明确授权新 provider 设计。
12. **Hub Pipeline / Virtual Router 禁止 provider 特例**：Hub Pipeline 与 Virtual Router 永远只承载协议、路由、工具治理的通用语义；禁止写入任何 provider-specific 分支、shape 修补、上下文补偿或已移除 provider 特例。provider 差异只能在对应 Provider runtime 内解决。
13. **direct passthrough 禁止换壳转换**：router-direct/provider-direct 的唯一职责是 provider passthrough + hooks；禁止进入 HubPipeline response conversion/chat-process/servertool response orchestration，禁止新增 direct response 专用壳、SSE materialize/remap/canonicalize、fallback/patch/shape 修补；禁止 direct 5xx/转换错误通过 `routecodexSameProtocolDirectDisabled` 重入 executor/reroute。
14. **Hub Pipeline 流水线锁定原则**：靠“类型不可接 + 运行时必拦 + 导出不可见 + 红测必红”锁住 `req_inbound -> req_chatprocess -> req_outbound -> resp_inbound -> resp_chatprocess -> resp_outbound`，禁止靠约定维护阶段边界；`req_inbound` 是唯一标准化入口，`req_chatprocess` 禁止协议转换，`req_outbound` 是唯一 provider wire build。
15. **metadata 请求/响应闭环隔离**：metadata 只能作为单个 request/response 闭环内的无状态内部控制语义 carrier；provider 出站 body、provider SDK options、client response body、provider/runtime 持久状态均不得携带内部 metadata。闭环结束必须释放，不得跨 requestId / pipelineId / port(serverId) / sessionId / conversationId 复用或污染。禁止 `body.metadata -> provider options`、`rawBody.metadata -> SDK request`、`payload.metadata.context -> provider wire payload`、snapshot metadata 进入正常 live path。
16. **全局流水线类型拓扑锁**：请求链、响应链、错误链、metadata carrier、Virtual Router、Provider Runtime、Server Runtime 的关键数据结构必须按“模块 + 阶段 + 节点序号 + 节点语义”唯一命名并唯一拥有；Hub 主链阶段固定为 `ReqInbound` / `ReqChatProcess` / `ReqOutbound` / `RespInbound` / `RespChatProcess` / `RespOutbound`。只允许相邻节点 builder/parser 转换，禁止跨节点 shortcut、同义 DTO、重复 shape、散落 `From` 转换、裸 `unknown`/`Record`/`Value` 承载关键语义。拓扑、命名、插节点规则真源见 `docs/design/pipeline-type-topology-and-module-boundaries.md`。
17. **错误链唯一入口锁**：provider/runtime/direct/executor 错误必须单向进入 `ErrorErr01SourceRaised -> ErrorErr02HostCaptured -> ErrorErr03RuntimeClassified -> ErrorErr04RouterPolicyApplied -> ErrorErr05ExecutionDecision -> ErrorErr06ClientProjected`；`router-direct` / `RequestExecutor` / provider runtime 只能作为 source/caller，不得本地实现 retry/reroute/cooldown/health policy，不得手拼 provider error event。
18. **红测→绿化→旧样本在线复测锁**：每次开发新功能或修复缺陷，必须先固化最小 failing sample / red test 并确认当前为红，再修改唯一真源让其转绿；绿化后必须在线重放旧错误样本或同入口真实样本，证明不是只对单测修好的虚假修复。没有“先红”证据或没有旧样本在线复测证据，不得宣称闭环完成。
19. **Responses continuation 三重隔离锁**：Responses continuation / submit_tool_outputs / scope materialize 必须同时按 `entry protocol(or endpoint)`、`continuationOwner(direct|relay)`、`session/conversation(+port/group)` 建立恢复隔离键。禁止普通 chat/messages 入口命中 responses continuation scope；禁止 direct continuation 续到 relay；禁止 relay continuation 伪装成 direct remote continuation；禁止仅凭 session/scope 命中历史自动续接。

## Metadata 生命周期硬边界（醒目）
1. **入口可读**：req_inbound / adapter 可从当前请求读取 metadata，并绑定 requestId、pipelineId、port/serverId、session/conversation scope。
2. **内部可用**：Hub Pipeline、Virtual Router、Provider Runtime 可通过 runtime carrier / context side-channel 读取 metadata 作为控制语义（routeHint、entryEndpoint、stream intent、servertool/web_search、snapshot 标签等）。
3. **出站隔离**：provider HTTP body、SDK request/options、direct passthrough body、Responses/Anthropic/OpenAI/Gemini/Qwen/GLM provider body 不得出现内部 metadata；发现必须 fail-fast，禁止静默删除当作修复。
4. **响应隔离**：resp_inbound/process/outbound 只能读取同一 requestId/pipelineId 的 metadata；不得把 metadata 注入 client response body。
5. **闭环释放**：请求/响应闭环完成后 metadata 不得进入全局 singleton、provider health/quota、session cache、port-shared cache、snapshot replay normal path。
6. **错误模式**：禁止从 `metadata.context` 补 provider payload；禁止从 `metadata.user_id/session_id/conversation_id` 生成上游 body/options；禁止跨端口或跨 session 复用 metadata 对象；禁止把 debug/snapshot metadata 当作 live runtime metadata。
7. **Responses continuation 隔离模式**：禁止把 `/v1/responses` continuation state 当作普通 chat/messages 会话历史复用；禁止只靠 `sessionId` / `conversationId` 命中旧 continuation；恢复必须同时校验入口协议、continuation owner、port/group scope 与会话 scope。

## 标准接口契约流水线图（醒目）

```text
                         Meta* carrier / ErrorErr* chain / Snapshot* carrier
                                      (side-channel, never normal payload)
                                                ^
                                                |
Client HTTP
  |
  v
[ServerReqInbound01ClientRaw]
  |  owner: server adapter / Express route
  v
[HubReqInbound02Standardized]
  |  owner: req_inbound; parse entry protocol, capture context, bind metadata scope
  v
[HubReqChatProcess03Governed]
  |  owner: req_chatprocess; Rust-only tools/reasoning/history governance
  v
[VrRoute04SelectedTarget]
  |  owner: virtual_router; route classify/select only, no payload patch
  v
[HubReqOutbound05ProviderSemantic]
  |  owner: req_outbound; provider semantic envelope only
  v
[ProviderReqOutbound06WirePayload]
  |  owner: provider runtime/outbound codec; provider HTTP body, no internal metadata
  v
[ProviderReqOutbound07TransportRequest] ---> upstream provider
  |                                           |
  |                                           v
  |                              [ProviderRespInbound01Raw]
  |                                           |
  |                                           v
  |                              [HubRespInbound02Parsed]
  |                                           |  owner: resp_inbound; parse provider raw only
  |                                           v
  |                              [HubRespChatProcess03Governed]
  |                                           |  owner: resp_chatprocess; Rust-only tool harvest / servertool followup
  |                                           v
  |                              [HubRespOutbound04ClientSemantic]
  |                                           |  owner: resp_outbound; client protocol projection only
  |                                           v
  +----------------------------> [ServerRespOutbound05ClientFrame] ---> Client HTTP/SSE
```

## 标准错误链契约图（醒目）

```text
provider/runtime/direct/executor throw
  |
  v
[ErrorErr01SourceRaised]
  |  owner: error source/caller; raw error + stage + runtime scope only
  v
[ErrorErr02HostCaptured]
  |  owner: src/providers/core/utils/provider-error-reporter.ts
  v
[ErrorErr03RuntimeClassified]
  |  owner: src/providers/core/runtime/provider-failure-policy-impl.ts
  v
[ErrorErr04RouterPolicyApplied]
  |  owner: sharedmodule/llmswitch-core virtual_router_engine / provider-runtime-ingress
  v
[ErrorErr05ExecutionDecision]
  |  owner: request/direct executor consumer; execute Router policy decision only
  v
[ErrorErr06ClientProjected]
  |  owner: HTTP/server error projection only
  v
client-visible error
```

- direct provider 5xx/429/524 必须进入 `ErrorErr02HostCaptured -> ErrorErr04RouterPolicyApplied`；失败仍原样 fail-fast，不得 fallback 成成功。
- `ErrorHandlingCenter` 只能属于 `ErrorErr06ClientProjected`，禁止进入 provider retry/reroute/cooldown policy。
- metadata/debug/snapshot/error carrier 不得混入 provider normal request payload 或 client normal response body。

- 图中每个 `[]` 都是唯一接口契约节点；只能相邻转换，禁止跨节点 shortcut。
- metadata / error / snapshot 永远走图顶 side-channel carrier，不得混入 request/response normal payload。
- `Virtual Router` 只能消费 `HubReqChatProcess03Governed`，只产出 `VrRoute04SelectedTarget`；不得修 payload、不得处理工具结果。
- provider runtime 只能消费 `HubReqOutbound05ProviderSemantic` / `ProviderReqOutbound06WirePayload`，不得读取 `rawBody` 重建上下文。
- direct passthrough 仍必须遵守 provider wire / hooks 边界，禁止重入 Hub response conversion 或 fallback reroute。

## Hub Pipeline 节点职责硬边界（醒目）
1. **req_inbound**：只做入口协议解析、上下文捕获、原始语义保留；不得伪造工具结果、不得吞非法工具顺序。
2. **req_chatprocess**：请求侧工具治理唯一入口；工具声明注入/裁剪、文本工具 harvest、apply_patch/servertool/MCP/native 工具治理必须 Rust-only。
3. **virtual_router**：只做路由分类与目标选择；不得修补 payload、不得处理工具结果、不得读取别的端口或别的路由池状态。
4. **req_outbound**：只把 Hub 规范语义编码成 provider 协议；不得把 `tool_calls` / `function_call_output` / servertool 语义降级为普通文本。
5. **provider_runtime**：只做 transport/auth/provider 内部协议兼容；不得承担 Hub 工具治理，provider-specific 差异不得写入 Hub Pipeline。
6. **resp_inbound**：只把 provider 原始响应解析回 Hub 规范响应；SSE/JSON 解析失败必须显式错误。
7. **resp_chatprocess**：响应侧工具治理唯一入口；文本工具收割、servertool followup、apply_patch 逆向转换、internal tool 剥离必须 Rust-only。
8. **resp_outbound**：只把 Hub 响应投影回客户端入口协议；不得修复请求侧历史污染、不得 provider 特例、不得吞上游错误。
9. **servertool_followup**：只能基于 origin snapshot 重建 followup；只能走 relay Hub Pipeline 单次复入；不得进入 router-direct/provider-direct 预跑或直通；不得从当前污染 payload 猜测补偿。servertool 只代客户端执行本地工具，不拥有专用响应出口；followup 响应必须按 provider/model -> `RespInbound` -> `HubRespChatProcess03Governed` -> `HubRespOutbound04ClientSemantic` -> client 的正常响应链返回。
10. **审计真源**：完整执行文档见 `docs/goals/hubpipeline-tool-boundary-audit-goal.md`。
11. **Responses continuation owner**：`buildChatRequestFromResponses` 等 bridge 只负责已确认的 Responses continuation 协议转换，不负责 scope/owner 判定。entry/owner 隔离必须在 continuation store / restore / materialize owner 层完成；桥层收到 owner 不匹配或缺失 `fullInput` 时必须 fail-fast。

## 全局流水线类型拓扑（醒目）
1. **双向链条固定**：请求链必须从 `ServerReqInbound01ClientRaw` 单向进入 Hub/VR/Provider；响应链必须从模型/provider 端的 `ProviderRespInbound01Raw` 单向进入 Hub，再经 `HubRespOutbound04ClientSemantic` 出到 `ServerRespOutbound05ClientFrame`；`RespInbound/RespOutbound` 均以 Hub 为参照。错误链必须从发生点进入统一错误 pipeline，不得反向补请求 payload。
2. **命名模板固定**：`<Module><Phase><NN><Node>`，例如 `HubReqInbound02Standardized`、`HubReqChatProcess03Governed`、`VrRoute04SelectedTarget`、`ProviderReqOutbound06WirePayload`、`ServerRespOutbound05ClientFrame`、`ErrorErr03RuntimeClassified`。
3. **节点序号是位置**：序号表达拓扑位置，不表达版本；新增中间节点默认禁止。确需新增时必须先更新 `docs/design/pipeline-type-topology-and-module-boundaries.md`，优先归入既有节点内部 block / carrier；禁止重编号既有节点，禁止 `03b` / `03_1` / `03.5` 临时编号。
4. **唯一 builder/parser**：每个节点类型只能有一个 owning builder/parser；转换函数必须写明相邻来源和目标，如 `build_hub_req_chatprocess_03_from_hub_req_inbound_02`。
5. **禁止跨链污染**：metadata、error、debug/snapshot、provider runtime state 都不能伪装成 req/resp 正常 payload；进入下一链路前必须经对应 carrier 类型或错误类型显式投影。
6. **红测锁边界**：所有关键链路必须有红测扫描非相邻转换、内部字段泄漏、重复 DTO、旧 TS 语义壳复活；红测路径和禁止模式写入拓扑文档。

## 分类路由（按需跳转）
1. 入口总览：`docs/agent-routing/00-entry-routing.md`
2. 运行时与架构真源：`docs/agent-routing/10-runtime-ssot-routing.md`
3. 构建/验证/发布：`docs/agent-routing/20-build-test-release-routing.md`
4. servertool / stopMessage / stopless followup：`docs/agent-routing/30-servertool-lifecycle-routing.md`
5. 任务跟踪与记忆：`docs/agent-routing/40-task-memory-routing.md`
6. 权威细节文档：
   - `docs/ARCHITECTURE.md`
   - `docs/error-handling-v2.md`
   - `docs/routing-instructions.md`
   - `docs/stop-message-auto.md`
   - `docs/design/servertool-stopmessage-lifecycle.md`
   - `docs/design/servertool-followup-rebuild-from-origin.md`
   - `docs/design/pipeline-type-topology-and-module-boundaries.md`

## 标准执行顺序
1. 读本文件（项目入口 + 护栏）。
2. 读 `docs/agent-routing/00-entry-routing.md` 选路。
3. 打开对应路由文档与相关 skill 文档执行。
4. 执行后用证据回报：变更、验证、剩余缺口、下一步。

## 维护原则
- 本文件保持短小：只保留入口、护栏、路径。
- 细节写到 `docs/agent-routing/*` 或技能文档，不回灌本文件。

## 当日事实更新（2026-05-27）
1. 5555 主备问题当前已证实：Rust Virtual Router 的 priority 选路语义正常；“主 provider 未命中”优先排查 health/quota/runtime init 状态，不先改 selection。
2. provider health 的 `__http_503_daily_cooldown__` 为 persisted 状态（canonical key 生效，`key1 -> 1`）；启动后应先重新校验可恢复性，若首个真实请求仍不可恢复（如 503）则再次冷却。
3. 启动排障必须区分：`checkHealth=false`、`VR success hook 不可用`、`success 后再次失败重写冷却` 三个分支；不得混为“路由器错误”。
4. 本项目该类问题调试先看 `.agents/skills/rcc-dev-skills/SKILL.md` 的“2026-05-27 调试精华（5555 主备/health/stopless）”章节，再执行改动。
5. 错误处理主链真相：provider/local error 先归一到 `src/providers/core/runtime/provider-error-catalog.ts`，再进入 `provider-failure-policy-impl.ts` 分类；`request-retry-helpers` / `request-executor-retry-decision` / `request-executor-session-storm-backoff` / `retry-engine` 只消费统一码与分类结果，禁止新增 message-only 分叉。
6. Provider 模型名双轨契约（2026-06-12）：`provider.models.<modelId>` 的 key 即唯一 upstream/provider wire model 名；`aliases` 仅供客户端可见模型名和客户端入口匹配使用。`/v1/models` 可以展示 alias（无 alias 时展示 `modelId`），但 provider 出站请求里的 `body.model` 必须始终回写为 `modelId`，禁止把 alias 直接发给上游。
7. Responses continuation 契约（2026-06-12）：remote/upstream-owned `responseId/previous_response_id` 必须记 `continuationOwner=direct` 并沿 same-protocol direct 续接；本地 relay/materialize 生成的 continuation id 必须记 `continuationOwner=relay` 并只走 relay。`store:false` 不得阻止同一 response 的 tool continuation 持久化；response 侧若仍有 pending tool call，必须以 response 真相将 `allowContinuation=true`。`providerKey` 只能存在于 runtime/meta carrier 做 direct pin，禁止写回 resumed/materialized provider payload。
8. Responses continuation 隔离补充（2026-06-13）：continuation 恢复键必须同时锁 `entry protocol/endpoint + continuationOwner + session/conversation(+port/group)`；不能只靠 session scope materialize。普通 `/v1/chat/completions` / `/v1/messages` 入口命中到 Responses continuation 时必须显式拒绝，而不是桥接补偿；`buildChatRequestFromResponses` 只消费已确认属于 Responses owner 的 `fullInput`。

## 2026-06-05 硬编码 + Fallback 架构收口引用

- 本规则的 **执行规范、门禁、白名单** 由 `docs/goals/hardcode-fallback-arch-audit-plan.md` 细化；SSOT 迁移 (constants / 错误码 / provider key 抽象) 必须按 plan §7 阶段顺序推进。
- 物理删除铁律 (项目级): 迁出后旧 Set / 旧 `if` 块 / 旧常量字符串必须删除；保留必须经 `silent-failure-audit.mjs` + `hardcode-audit.mjs` 报警并写理由；不得用"不接入 / 不调用 / 注释掉 / 闲置"代替删除。
- Provider 特例唯一允许位置: Provider runtime。Hub Pipeline / Virtual Router / RequestExecutor 禁 provider key 字符串前缀特判；改用 `providerFamily` / runtime identity 抽象。
- Rust runtime: 不得用 provider key 前缀特判 persisted 503 family cleanup；必须使用通用 provider-family cleanup 语义。
- 红测先行: 每个 Phase 必须有红测先红后绿；TS 端参考 `tests/server/runtime/http-server/phase3-provider-family-abstraction.red.spec.ts`；Rust 端用 provider-family cleanup 双向 fixture 锁住不串台。
- 完成标准 5 验证: `pnpm run verify:hardcode` 必须 PASS; `silent-failure-audit.mjs` 命中数 < 488 (基线) 且 < 后续 Phase 4 后的新基线。
