# 2026-06-29: SSE partial-stream salvage fallback removed
- Chat/Responses SSE decode projection 不允许在 stream terminated / timeout 后把已收到的 partial chunks salvage 成成功响应；错误必须显式进入 SSE decode error path。
- `chat-sse-to-json-converter.ts` 的 `isTerminatedError` / `trySalvageResponse` 和 `responses-sse-to-json-converter.ts` 的 `tryMaterializeFinalResponse` 已删除；`verify:sse-architecture-boundary` 防止 `const salvaged =` / `return salvaged` 类 fallback 复活。
- 回归测试分别锁住 chat partial stream termination 与 responses missing terminal done timeout，证明不会把未完整终止的流投影为成功。

# 2026-06-29: chat SSE projection provider-specific residue removed
- `sharedmodule/llmswitch-core/src/sse/sse-to-json/chat-sse-to-json-converter.ts` 已物理删除 DeepSeek-web patch/error/control 兼容逻辑；通用 chat SSE 转换器只保留标准 chat chunk / done / error / ping 处理。
- `verify:sse-architecture-boundary` 已扩展到 provider-neutral SSE projection files，禁止 `deepseek/glm/lmstudio/minimax/qwen/kimi/siliconflow` 等 provider-specific marker 复活。
- 旧 DeepSeek patch 样本应在通用 chat SSE 转换器中 fail-fast，不再被当成可重用的 provider-neutral 语义帧。

# RouteCodex Project Memory

# 2026-06-29: servertool CLI projection TS facade deleted
- `sharedmodule/llmswitch-core/src/servertool/cli-projection.ts` 与旧 `tests/servertool/servertool-cli-projection.spec.ts` 已物理删除；generic servertool CLI projection 的活入口是 `cli-projection-runtime-shell.ts` 调 Rust/native `buildClientExecCliProjectionOutputWithNative`、`buildClientVisibleProjectionShellWithNative`、`buildServertoolCliProjectionExecutionContextWithNative`。
- `tests/servertool/cli-projection-runtime-shell.spec.ts` 取代旧 projection spec；function/verification map、wiki/html 与设计文档应指向 runtime shell 和 Rust/native owner。`verify:servertool-rust-only` 必须防止旧 facade/test 复活，并禁止 TS runtime shell 手拼 `exec_command` shape 或 CLI command string。
- Stopless CLI stdout 不再暴露 `schemaGuidance`；相关测试应保持 `schemaGuidance` undefined，schema guidance 只能走下一轮模型侧修复材料，不进入 client-visible CLI stdout。

# 2026-06-29: chat-process session usage Rust-owned
- `saveChatProcessSessionActualUsage` 的 request counter、local-day reset、tmux session usage scope、token/message usage writeback 已收口到 Rust `virtual_router_engine::chat_process_session_usage` + `routing_state_store::GlobalRequestCounter`。
- TS `chat-process-session-usage.ts` 只允许调用 `planChatProcessSessionUsage` native shell；禁止恢复 TS scope resolver、usage normalization、routing state load/write、`Date.now()` timestamp owner。
- counter 持久化真源是 `~/.rcc/state/global-request-counter.json`；Rust tests 必须用 `with_session_dir_override` 隔离临时 counter，禁止污染真实 `~/.rcc` 状态；counter 读/解析/写入失败必须 fail-fast，不能重置成新 counter 继续成功。

# 2026-06-29: provider-response duplicate V2 orchestration owner rejected
- Provider response orchestration 主线当前 Rust 真源是 `hub_pipeline_lib/engine.rs` 产出的 response effect plan，以及 `hub_pipeline_lib/effect_plan.rs` 的 native effect plan normalizer / servertool runtime action planner。
- 禁止新增独立 `provider_response_orchestration_v2` / `native-provider-response-orchestration-v2` / `native-provider-response-sse-materialize-fallback` 第二 owner；这类未接入 planner 会复制 SSE materialization、usage normalization、servertool plan、streamPipe 和 metadata write semantics，必须物理删除并用 residue audit 防复活。

# 2026-06-29: stopless followup-flow skip branch removed
- `serverToolFollowup` 不再是 stop-message auto handler 的 skip / recursion guard truth；stopless 决策不得读取 `followup_flow_id` 或 `runtime_control.serverToolFollowup` 来返回 `skip_servertool_followup_hop`。
- `serverToolFollowup` 仍可作为 routing/metadata control 使用，但 stopless lifecycle 的继续/终止真源是 Chat Process request/response boundary、MetadataCenter `runtime_control.stopless` 和当前请求 tool output。
- `verify:servertool-rust-only` 与 residue audit 已锁住 `followupFlowId`、`read_servertool_followup_flow_id`、`STOP_MESSAGE_FOLLOWUP_FLOW_ID`、`skip_servertool_followup_hop` 不复活。

# 2026-06-29: stopless runtime-state MetadataCenter-only closeout
- stopless runtime-state restore 真源已收口到 Rust `servertool-core/src/persisted_lookup.rs::resolve_runtime_stop_message_state_from_metadata_center`，只读取 `MetadataCenter.runtime_control.stopless`（或同语义 snake-case carrier）；旧 adapter-context surface、`stopMessageState`、`serverToolLoopState`、`responsesRequestContext` data-plane restore 均不是合法 runtime-state truth。
- NAPI/TS surface 名称必须使用 `resolveRuntimeStopMessageStateFromMetadataCenter*`；`resolveRuntimeStopMessageStateFromAdapterContext*` / `RuntimeStopMessageStateFromAdapterContext*` 属于已删 surface，`verify:servertool-rust-only` 必须防复活。
- `tests/servertool/stop-message-runtime-utils.continuation.spec.ts` 已删除；`hub.metadata_center_mainline` required tests 改由 `tests/servertool/stopless-cli-continuation.spec.ts` 和 `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` 锁住。

# 2026-06-29: servertool backend-route public surface retirement
- `backend_route_contract.rs` / `BackendRouteReenter` / `ServertoolBackendRouteHint01Planned` / `planServertoolBackendRoutePolicy*` 已从 servertool public surface 退役；`verify:servertool-rust-only` 现在应检查旧文件物理缺失与 forbidden marker，而不是要求旧 backend-route owner 符号存在。
- 退役 gate 不能用 `return` 后不可达旧断言保留历史合同；旧 “must exist” 检查必须物理删除，否则会误导后续 agent 复活已删 surface。
- `extractTextFromChatLikeWithNative` 是合法 thin wrapper：TS 只 JSON stringify/parse 并调用 `extractServertoolTextFromChatLikeJson`，文本抽取真源仍是 Rust `servertool-core/src/text_extraction.rs`。

# 2026-06-29: req-outbound provider wire compat TS actions closeout
- `HubReqOutbound05ProviderSemantic -> ProviderReqOutbound06WirePayload` 的 provider wire compat 真源是 Rust `req_outbound_stage3_compat`；旧 `sharedmodule/llmswitch-core/src/conversion/compat/actions/*` TS action 与自测已物理删除，并由 `verify:responses-request-compat-rust-only` 防复活。
- compat shell 测试必须绑定 `MetadataCenter.runtime_control.providerProtocol`；flat `adapterContext.providerProtocol` 只能作为测试输入辅助，不是 req-outbound compat owner 真源。
- 最新 MiniMax `tool id() not found` error-only 样本缺 `client-request.json` 时不能宣称完整在线复打；可用最近 replayable `/v1/responses` client sample 补充验证，但剩余风险必须明确。

# 2026-06-29: MetadataCenter dualwrite gate / stopMessageEnabled flat truth closeout
- `hub.metadata_center_dualwrite_api` 的 closeout gate 必须在 `docs/architecture/metadata-center-manifest.yml` required gates 中可查询；`verify:metadata-center-dualwrite-api` 已锁住 manifest gate 绑定和 direct Rust truth residue。
- Req governance 的 stopless instruction injection 只能读 `MetadataCenter.stop_message_enabled()`；flat `metadata.stopMessageEnabled` 不再是合法 truth source，gate 禁止其复活。
- 本切片已验证 metadata dualwrite gate、metadata manifest/code sync、write-boundary、leak-boundary、function-map/mainline/wiki gates、metadata dualwrite Jest、Rust non-test check/native build、TS typecheck、stopless invalid-schema blackbox。当前 cargo lib tests 仍被并行 servertool test-only missing export blocker 拦住，`verify:servertool-rust-only` 仍被脚本 ReferenceError 拦住，二者不能作为本切片闭环证据。

# 2026-06-29: MetadataCenter bridge projection node sync
- `metadata.center.mainline` 必须显式区分 `MetaResp07BridgeMetadataBound` 与 read-only `MetaResp07ServertoolContextProjected`：bridge 绑定由 `buildBridgeAdapterContext -> readRuntimeServerToolProjection` 锚定，servertool context projection 由 `runProviderResponseRustHubPipeline -> readRuntimeControlFromBoundMetadataCenter` 锚定，closeout 继续由 `releaseMetadataCenterForHttpResponse -> markReleased` 负责。
- `MetaResp07ServertoolContextProjected` 在 `metadata-center-manifest.yml` 中只能是 read-only stage，不允许 `write_families`；`verify:architecture-metadata-center-write-boundaries` 已锁住该规则。
- 已提交 `8aa2fec8d docs(metadata): split servertool bridge node`，并在 clean worktree 验证 metadata write-boundary、manifest-code-sync、mainline-call-map、mainline-manifest-sync、wiki-sync、mainline node consistency、function-map compile gate 与 `git diff --check` 通过。主工作树的后续 function-map gate 可能被并行 `hub.chat_process_session_usage` 脏改阻塞，需按独立 slice 处理。

# 2026-06-29: virtual router rustification audit 结论
- virtual router 核心选路、metadata surface、route availability floor、primary_exhausted plan 已是 Rust 真源；TS 侧主要残留在 bootstrap/wrapper、host effects、hit-log、bridge/tests/docs。
- 收口顺序应先做纯薄壳删除，再做 metadata/routeHint 相关桥接收口，最后清理测试与文档残留；vra-04 仍是 TS consumer 边，不是 VR 真源。
- 2026-06-29 thin-wrapper slice：VR bootstrap wrapper 禁止本地 `loadNativeRouterHotpathBinding` / error plumbing，统一走 `callNativeJson`；executor singleton route-pool exhaustion 只能消费 Rust `evaluateSingletonRoutePoolExhaustionNative`，不得在 TS 重算 hold/floor 语义。

- 2026-06-28: provider error 处理必须走统一 ErrorErr01-06 链，错误中心消费 `ErrorErr05ExecutionDecision` 后才能决定 reroute / project；`error.backoff_action_queue` 只负责 1s -> 3s -> 5s 的 blocking wait，不负责 provider 冷却。`priority` 模式是 strict ordered failover，`ykk` 仍可选时不得落到 `asxs` / `XL`。
- 2026-06-28: 已按架构移除的不合规 TS owner 不得因为 build/map 缺失而恢复。遇到 `servertool-adapter-context.ts` 这类已删 TS owner 被 mainline/function-map 引用时，应把调用边和 docs 收到当前合法 owner（如 bridge 本地 adapterContext 组装或 Rust/native owner），并保持旧 TS 文件物理删除。
- 2026-06-28: `provider-traffic-governor.ts` 旧 server runtime owner/test 属于已迁移 TS 面；`error.backoff_action_queue` 的 map/gate 应指向 `src/modules/traffic-governor/index.ts`、native traffic governor binding 和 executor 现有单测，不得恢复旧 `tests/server/runtime/http-server/provider-traffic-governor.spec.ts`。
- 2026-06-28: runtime bug 修复不能只用单测、编译或泛化 smoke 宣称闭环；必须用触发该问题的原始出错请求样本在线重放，确认同一个样本不再复现。若样本复打仍失败，继续追唯一真源修复，不能把“修了代码”当完成。
- 2026-06-28: 10000 长上下文 routing 中，`longcontext:token-threshold` 必须优先于 `search:last-tool-search`，否则超大上下文会被 search continuation 抢到小/search provider 并触发 provider context 400。修复 owner 是 Rust `virtual_router_engine::classifier`，不是 req/resp outbound 或 SSE。
- 2026-06-28: provider HTTP 200 business error 不是 malformed response，不能包成 502。`base_resp.status_code` / `error.code` / `error.type` 等上游业务错误应保留为 `PROVIDER_BUSINESS_ERROR` + upstream code/message；容量/限流类投影 429，普通业务拒绝投影 400，除非有明确合同不得改写成 generic upstream 502。
- 2026-06-27: `providerProtocol` 唯一真源是 provider config/init 后的 provider handle，并只能在 VR/provider selection 后写入 `MetadataCenter.runtime_control.providerProtocol`；禁止从 client entry endpoint、payload shape、`providerTypeToProtocol`、flat `metadata.providerProtocol` 或 `adapterContext.providerProtocol` 推导/兜底。响应解析和 servertool/usage 等内部消费者只读 MetadataCenter，冲突必须 fail-fast。
- 2026-06-27: `/v1/responses` 续接/恢复的响应侧清理必须在 Rust owner 内把 `function_call` 和 `function_call_output` 的 `id` 统一规范化为 `fc_*`；只清 meta 或只保留 `call_id` 不够，会把 `call_servertool_cli_*` 原样带回上游并触发 Responses upstream 校验失败。
- 2026-06-27: tmux/session-binding 相关 server 残留可以物理删除，但 Metadata Center 本体不能删；只允许移除 `client_attachment_scope`、`stopMessageClientInject` 这类 attachment/control 语义槽位。该类清理后必须先过 `tsc` 和 `npm run build:base`，若 wiki 门禁失败则先重渲 `render-architecture-wiki-pages.mjs` 与 `render-architecture-wiki-html` 再复验。
- 2026-06-28: stopless 多轮闭环的标准骨架是 Rust ReqChatProcess 产出 `metadata.runtime_control.stopless`，TS request-stage shell 只把该 Rust plan 写入同一请求绑定的 `MetadataCenter.runtime_control.stopless`，Response ChatProcess 读取同一 control slot 拦截 stop。`requestTruth.runtimeControl`、top-level metadata、file persistence、sessionDir writeback、SSE/outbound 修补都不是合法 stopless control owner。已用 5555 live probe 验证 `repeatCount=1 -> repeatCount=2 -> stopless budget exhausted`，并用 `stopless-followup-blackbox` 验证 3 次 upstream 命中后第三轮 stop。
- 2026-06-28: stopless stop schema 是条件必填合同，不是全字段必填。`stopreason/reason/has_evidence` 是 attempted schema 基线；`has_evidence=1` 时 `evidence` 必填；terminal `stopreason=0|1` 必须 `has_evidence=1` 且 `evidence` 非空；continue `stopreason=2` 必须 `next_step`，且下一轮模型续跑文本就是 `next_step`；`blocked + needs_user_input=true` 必须把 summary 和用户决策问题返回客户端并以 `finish_reason=stop` 停止等待。已用 `verify:stopless-invalid-schema-blackbox` 验证 missingFields 收敛 `["has_evidence","next_step"] -> ["next_step"]`，并用 `stopless-followup-blackbox` 回归多轮闭环。
- 2026-06-28: Anthropic provider 400 `function name or parameters is empty (2013)` 可能是 provider outbound 把 OpenAI chat tool wrapper 发到 Anthropic `/v1/messages`，而不是工具名/参数本身为空。先查 `~/.rcc/codex-samples/<endpoint>/ports/<port>/<requestId>/provider-request*.json` 的 provider-facing body。修复 owner 是 Rust `hub_protocol_spec_semantics::normalize_provider_outbound_tools` 复用 `anthropic_openai_codec::map_chat_tools_to_anthropic_tools`；禁止在 TS handler/provider runtime 再做第二套协议 mapper。
- 2026-06-29: Anthropic provider 400 `tool result's tool id() not found (2013)` 的优先判断是 outbound 映射缺失，不是清洗缺失：若 provider-facing `messages` 仍有 OpenAI `assistant.tool_calls` / `role:"tool"` / top-level `tool_call_id`，必须先在 Rust provider outbound policy 对 `anthropic-messages` 执行 whole-payload OpenAI chat history -> Anthropic `tool_use/tool_result` 映射，再进入清洗/allowlist。修复 owner 是 `hub_protocol_spec_semantics::apply_provider_outbound_policy` 调用 `anthropic_openai_codec::build_anthropic_request_from_openai_chat_value`。
- 2026-06-29 token estimator wrapper slice：`native-virtual-router-runtime.ts` 的 `countRequestTokens` / `computeRequestTokens` 已改为共享 `callNativeJson('estimateVirtualRouterRequestTokensJson', ...)`；本地 `loadNativeRouterHotpathBindingForInternalUse` / `readNativeFunction` 已移除，empty / invalid / invalid-token-count 仍 fail-fast。
- 新门禁：`verify-vr-no-ts-runtime` 现在同时锁 `native-virtual-router-runtime.ts`，禁止 token estimator wrapper 重新长回本地 native binding plumbing。
- 已验证：`npm run verify:vr-no-ts-runtime`、`PATH=/opt/homebrew/opt/node@22/bin:$PATH npx tsc -p tsconfig.json --pretty false`、`node ../../node_modules/jest/bin/jest.js --config jest.config.cjs --runInBand --runTestsByPath tests/router/token-counter-media-ignore.test.ts`、`git diff --check`。
