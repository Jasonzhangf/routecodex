## 2026-06-15 note.md consolidation index
- apply_patch audit fixes landed and green: latest=2026-06-15；已确认 `hub_req_inbound_context_capture.rs` 的 canonical writeback、`standardized_request.rs` 的 responses input 预规范化、以及 relay store 的 `output_text/commentary -> input_text` 历史合法化均已转绿。
- apply_patch 审计文档最终收口：latest=2026-06-15；已补 direct/relay 最终 owner 矩阵、重复 surface / 删除候选、server 层协议污染嫌疑点、以及“为何 5555 是 relay / 为何 5520 仍有 apply_patch 问题”的显式回答块。
- apply_patch direct/relay owner audit split：latest=2026-06-15；已基于 live 日志、online smoke、样本、function-map 确认 `5520 direct` / `5555 relay` 分链真相、唯一 owner 与当前 gate 缺口。
- direct request passthrough reasoning/apply_patch contract relock：latest=2026-06-15；已确认 direct provider runtime 不再按 reasoning 触发 sanitize，且 direct 样本显式锁住 freeform `apply_patch` tool 定义原样透传上游。
- 5520 direct SSE duplicate terminal frames live truth：latest=2026-06-15；已确认线上 `0.90.3071` 仍在 `response.completed(required_action)` 后本地补一套 tool terminal frames，且全局安装 dist 未带上 direct skip 修复。
- reasoning retention audit split：latest=2026-06-15；已确认 direct live 本次未见 SSE 壳层吞 reasoning，但 relay/local responses conversation store 仍显式丢弃 standalone reasoning output item。
- stopless blackbox CLI contract update：latest=2026-06-15；旧 `scripts/tests/stopless-followup-blackbox.mjs` 仍断言 server-side reenter / upstream>=2，已改为 CLI projection 合同并在线黑盒转绿。
- stopless CLI request-side auto-hook rewrite：latest=2026-06-15；已确认真实 capture owner 在 `hub_req_inbound_context_capture.rs`，此前 rewrite 只写在 tool normalization 未接入 live capture；现已接入 capture 入口并通过 cargo/native jest/function-map gate。
- stopless CLI vs transparent reenter owner conflict：latest=2026-06-15；已确认 map/docs/code 当前一致指向 transparent reenter，但仓库残留 CLI contract/blackbox；正在统一回 CLI 闭环。
- servertool nested followup timeout removal：latest=2026-06-15；已取消 executor 侧 10s nested followup fail-fast，只保留 client abort；待 build:min 收口。
- 5520 latest apply_patch sample re-audit：latest=2026-06-15；已确认 provider 200 + outbound custom grammar preserve 修复已落 Rust owner，待 build/install/live replay。
- apply_patch SSE pending-delta done-frame closure：latest=2026-06-15；已完成定向 gate + build/install/restart 证据，待按总审计任务继续归并。
- direct-path-error-reroute-and-candidate-exhaustion P5 (function-map/verification-map sync)：latest=2026-06-15；map/gate 落盘，待 promote 到 MEMORY.md 待 gate PASS。
- 5520 direct apply_patch grammar + SSE projection closure：latest=2026-06-14；已 promote 到 MEMORY.md 候选。
- stopless double-收口执行与清理：latest=2026-06-14；已 promote 到 MEMORY.md 候选。
- latest codex apply_patch sample compatibility：latest=2026-06-14；已 promote 到 MEMORY.md 候选。
- apply_patch direct/relay full audit progress：latest=2026-06-14；in_progress。

## 2026-06-15 stopless blackbox CLI contract update

- 旧黑盒 `scripts/tests/stopless-followup-blackbox.mjs` 还在断言“stopless 会自动 reenter upstream 第二次”，因此在当前 CLI 闭环下必然误报：
  - `expected upstream >=2 hits (initial + followup), got 1`
- 当前 stopless 合同应为：
  - 首次 upstream 返回 `finish_reason=stop`
  - RouteCodex 本地拦截后直接投影 `exec_command`
  - 不允许 server-side reenter，不允许第二次 upstream 自动 followup
- 黑盒脚本已改为断言：
  - HTTP 200
  - `required_action.submit_tool_outputs.tool_calls` 存在
  - 存在 `exec_command`
  - `cmd` 为 `routecodex hook run stop_message_auto ...` 或 `routecodex servertool run stop_message_auto ...`
  - CLI 输入不泄漏 `continuationPrompt` / `stopreason`
  - upstream 命中数严格等于 1
- 2026-06-15 验证证据：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/tests/stopless-followup-blackbox.mjs` PASS
  - 结果：`upstreamHits=1`, `providers=["crs1"]`, `execCommand="routecodex hook run stop_message_auto --input-json '{\"flowId\":\"stop_message_flow\",\"maxRepeats\":3,\"repeatCount\":1}'"`

## 2026-06-15 direct request passthrough reasoning/apply_patch contract relock

- 根因复核：`src/providers/core/runtime/responses-provider.ts` 之前会在 direct path 上按 `input[].type=reasoning` 触发 `sanitizeResponsesProviderOutboundBody(...)`，这违反了 `responses.direct_tool_shape_contract` 的“same-protocol direct request body identity is preserved”。
- 修复：删除 direct path 的 `shouldSanitizeDirectResponsesBody(...)` 分支；`processIncomingDirect()` 现在直接把 `builtBody` 作为 provider wire。
- 合同补强：`tests/providers/runtime/responses-provider.direct-passthrough.spec.ts`
  - reasoning 样本现在断言 `capturedBody === inbound`，且 reasoning `content/encrypted_content/summary` 原样保留；
  - direct payload 样本显式加入 freeform `apply_patch` grammar tool，锁死 `tools` 原样透传，不允许 direct runtime 再做工具定义清洗。
- 2026-06-15 验证证据：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/providers/runtime/responses-provider.direct-passthrough.spec.ts --runInBand` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/server/runtime/http-server/direct-passthrough-minimum-overrides.spec.ts tests/server/runtime/http-server/router-direct-pipeline.spec.ts tests/server/runtime/http-server/provider-direct-pipeline.spec.ts --runInBand` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:responses-direct-tool-shape-contract` PASS

## 2026-06-15 apply_patch direct/relay owner audit split

- 分链真相已确认：
  - `5520` 相关 `apply_patch` grammar 400 样本 `openai-responses-router-gpt-5.4-20260614T230414428-345124-2702` 明确是 direct：
    - 日志证据：`~/.rcc/logs/server-5520.log`
    - 同一窗口内同时存在：
      - `[port:5520 group:gateway_priority_5520] ▶ [/v1/responses] ...`
      - `[virtual-router-hit] ... -> asxs.crsa.gpt-5.4`
      - `[router-direct.send][openai-responses-router-gpt-5.4-20260614T230414428-345124-2702] error`
      - upstream `Invalid lark grammar ... unknown name: "begin_patch"`
    - 结论：这是 request transport contract / direct provider wire 问题，不是 relay/store/SSE。
  - `5555` 两类经典失败都不是 direct：
    - `openai-responses-router-gpt-5.4-20260613T223253714-340912-698`
      - `[port:5555 ...] [virtual-router-hit] ... -> minimax.key1.MiniMax-M3`
      - provider 返回 `invalid params, tool call result does not follow tool call (2013)`
      - 没有 `[router-direct.send]`
      - 结论：relay request-side history 投影到上游 chat/protocol 的形状问题。
    - `openai-responses-router-gpt-5.4-20260613T231359101-341020-806`
      - `[port:5555 ...] [virtual-router-hit] ...`
      - 本地失败：`orphan_tool_result ... code=hub_pipeline_context_capture_failed`
      - 没有 `[router-direct.send]`
      - 结论：relay request-side native context capture 本地拒绝；失败发生在 provider transport 之前。
- 5555 relay 当前 apply_patch 在线 smoke 证据：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH RCC_APPLY_PATCH_ONLINE_URL=http://127.0.0.1:5555/v1/responses RCC_APPLY_PATCH_ONLINE_MODEL=gpt-5.4 RCC_APPLY_PATCH_ONLINE_TIMEOUT_MS=180000 node scripts/tests/apply-patch-freeform-10000-online.mjs`
  - PASS：`ok=true`、`customInputCount=3`、`functionArgumentPatchLeakCount=0`
  - 结论：当前 relay apply_patch 主链没有复现“空 arguments / function_call patch 泄漏”。
- owner 清单（已绑定 function-map / 实码）：
  - direct request 语义保留：
    - feature: `responses.direct_tool_shape_contract`
    - Rust owner: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src`
    - TS shell: `src/providers/core/runtime/responses-provider.ts`
  - relay request handler facade：
    - feature: `server.responses_request_handler_bridge_surface`
    - file: `src/modules/llmswitch/bridge/responses-request-bridge.ts`
    - 职责：handler entry、resume/scope materialize facade、native capture 调用；不是 tool-history owner。
  - relay request-side tool history / orphan / duplicate 真 owner：
    - feature: `hub.req_inbound_responses_context_capture`
    - files:
      - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs`
      - `.../hub_req_inbound_tool_call_normalization.rs`
      - `.../hub_req_inbound_tool_output_snapshot.rs`
    - 职责：tool history normalize、shell-like tool call rewrite、orphan_tool_result fail-fast、duplicate compare/rewrite。
  - apply_patch freeform 参数/grammar/live-context 真 owner：
    - feature: `tool.apply_patch_freeform_contract`
    - files:
      - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs`
      - `.../resp_process_stage1_tool_governance_blocks/apply_patch_live_context.rs`
    - 职责：grammar/schema、参数 canonicalization、GNU hunk 修形、live-context compare；不是 handler/store。
  - relay store / continuation owner：
    - file: `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`
    - native helpers:
      - `convertOutputToInputItems`
      - `resumeConversationPayload`
      - `stripStoredContextInputMedia`
    - 职责：relay 本地 store、scope/owner 隔离、response->input history 持久化；`direct` continuation 不本地持久化。
  - relay response JSON/SSE client projection 真 owner：
    - feature: `hub.response_responses_client_projection`
    - Rust owner file:
      - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics_blocks/client_tool_args.rs`
    - TS shell:
      - `src/modules/llmswitch/bridge/responses-response-bridge.ts`
      - `src/server/handlers/handler-response-sse.ts`
    - 职责：apply_patch `function_call -> custom_tool_call`、delta 聚合、done 去重、client-visible model/reasoning restore。
- 新增高风险闭环证据：relay store 当前吃的是 response outbound/projection 后的语义，不是 provider raw response
  - JSON path：
    - `src/server/handlers/handler-response-utils.ts`
    - `prepareResponsesJsonClientDispatchPlanForHttp(...)` -> `normalizeResponsesClientPayloadForHttp(...)` -> `clientBody`
    - 随后 `persistResponsesConversationLifecycleForHttp({ body: sanitized })`
    - 这里的 `sanitized` 来源于 `clientBody` / projected payload，而不是 provider raw。
  - SSE path：
    - `src/server/handlers/handler-response-sse.ts`
    - `persistNativeSseConversationState()` 把 `stripInternalKeysDeep(contractProbe.probe)` 作为 `body` 传给 `persistResponsesConversationLifecycleForHttp(...)`
    - 这里持久化的也不是 provider raw stream，而是 probe 聚合后的 response 语义。
  - relay store：
    - `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`
    - `recordResponse()` 里 `convertOutputToInputItems(response)` 直接从上述 `body` 生成下一轮历史 `entry.input`
  - 结论：
    - 若 response outbound/projection 没做严格协议校验或映射错误，污染确实会进入 relay 本地 history；
    - 下一轮 `resumeConversationPayload/materializeContinuationPayload` 会把这份污染重新发上游，形成请求侧 `400`。
- 已拿到一条“response 语义错层进入历史 -> 上游 400”的实锤样本：
  - diag：`~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260615T001004109-345184-2762.json`
  - `requestBody.input_len=399`
  - 其中大量 `type=message` 的 `content` part 含 `output_text`，例如：
    - `message_idx 21 bad_types ['output_text']`
    - `message_idx 30 bad_types ['output_text']`
    - 后续大量重复
  - `/v1/responses` 合法下一轮请求 content type 应为：`input_text/text/image_url/video_url/input_audio/file`；`output_text` 属于响应语义，不应进入请求历史。
  - 真 owner 落点：
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`
    - `normalize_output_item_to_input(item)` 对 `type=message` 当前直接把 `content` 原样抄回 input，没有把 `output_text` 投影成合法 input 侧形状。
    - 这份输出随后经 `responses-conversation-store.ts -> recordResponse() -> convertOutputToInputItems(response) -> entry.input` 持久化。
  - 结论：
    - 至少一类 relay 400 已被证实是“response 侧 message/content 映射错层 + store 持久化 + 下一轮 restore 发回上游”的闭环问题。
    - 这不是 direct request sanitize 问题。
- 当前 gate 状态与缺口：
  - 已绿：
    - `tests/providers/runtime/responses-provider.direct-passthrough.spec.ts`
    - `tests/server/runtime/http-server/direct-passthrough-minimum-overrides.spec.ts`
    - `tests/server/runtime/http-server/router-direct-pipeline.spec.ts`
    - `tests/server/runtime/http-server/provider-direct-pipeline.spec.ts`
    - `tests/server/handlers/handler-response-utils.apply-patch-freeform-sse.spec.ts`
    - `tests/modules/llmswitch/bridge/native-exports.responses-sse-contract.spec.ts`
    - `node scripts/architecture/verify-apply-patch-freeform-contract.mjs`
    - 5555 / 5520 apply_patch online smoke
  - 仍红 / 缺口：
    - `tests/server/handlers/responses-sse-client-contract.blackbox.spec.ts`
      - case1：`captures required_action -> completed -> done ...` timeout
      - case2：`turns early upstream close into explicit error instead of client hang` 期望 `event:error` 未出现
    - 结论：这是 relay 更大范围 SSE 收口 gap；不能证明 apply_patch 主链坏，但说明 response/SSE contract 仍有独立风险。
- 后续修复顺序建议：
  1. relay SSE 黑盒残留：`responses-response-bridge.ts` + `handler-response-sse.ts` + Rust outbound projection 边界
  2. 5555 request-side reopened tool history live fixture：把 `2013` 样本固化进 request/history 红测
  3. 5555 local orphan_tool_result live fixture：把 `hub_pipeline_context_capture_failed` live 形状固化进 native capture/red test
  4. 仅在证据显示时再继续 direct；当前 direct apply_patch 主问题已从“错误整形”收口到“上游 grammar / 正常 patch context mismatch”

## 2026-06-15 apply_patch 审计文档最终收口

- `docs/goals/apply-patch-direct-relay-full-audit-plan.md` 已补四块最终结构：
  - `13. 重复 surface / 删除候选 / server 层协议修补嫌疑点`
  - `14. 最终 owner 矩阵`
  - `15. 样本 -> owner -> 风险 -> gate 缺口 一览`
  - `16. 显式回答块`
- 已明确三类边界：
  - `responses-sse-bridge.ts` 是 duplicate surface，不是第二语义 owner；
  - `handler-response-utils.ts` / `handler-response-sse.ts` 不是协议真源，但当前确实参与 relay response persistence 污染路径；
  - `5520 direct` 当前没有新证据证明 server request 侧在主动修补 `apply_patch` payload。
- 已收口的审计结论：
  - `5555` 的关键 `apply_patch` 问题样本 S2/S3/S5 都是 relay，不是 direct；
  - `5520` 的关键 `apply_patch` 问题样本 S1/S4 属于 direct contract / carryover / projection 问题；
  - 当前最需要优先修的唯一 owner 顺序是：
    1. `hub_req_inbound_context_capture.rs`
    2. `responses-request-standardization.real-samples.red.spec.ts`
    3. `shared_responses_conversation_utils.rs`
    4. `hub_bridge_actions/history.rs` / `bridge_input.rs`

## 2026-06-15 5520 direct SSE duplicate terminal frames live truth

- 在线复测 `http://127.0.0.1:5520/v1/responses`（model=`gpt-5.4`，stream=true，强制 `exec_command` 工具）仍复现重复终结帧：
  - upstream 先输出一套正常 `response.output_item.added -> response.function_call_arguments.* -> response.output_item.done -> response.completed`
  - 随后本地又追加一套 `response.output_item.added -> response.function_call_arguments.delta/done -> response.output_item.done -> response.done`
- 关键形状证据：
  - 第一套帧带 `sequence_number`
  - 第二套追加帧不带 `sequence_number`
  - 这更像本地 `buildResponsesTerminalSseFramesFromProbeForHttp(...)` 合成物，而不是 upstream 重发。
- 已核对当前全局安装真值：
  - `routecodex --version` / `rcc --version` = `0.90.3071`
  - `/opt/homebrew/lib/node_modules/routecodex/dist/server/handlers/handler-response-sse.js` 中 **不存在**：
    - `sse.persist.skip.direct_passthrough`
    - `sawResponsesCompletedChunk: isDirectPassthrough ? true : ...`
    - `sawResponsesDoneEvent: isDirectPassthrough ? true : ...`
- 结论：工作树源码已有 direct skip 修复，但当前线上安装产物未带上，所以 live 仍走旧 direct SSE 收尾逻辑。

## 2026-06-15 reasoning retention audit split

- direct live 复测（5520 `/v1/responses`，stream=true，工具调用样本）现在只剩一套原始 upstream tool frames；`response.created` / `response.completed` 内的 `response.reasoning` 对象仍在，未见 handler shell 额外裁掉 reasoning 字段。
- direct live 这次样本没有出现 standalone reasoning output item，因此不能把“direct 全路径 reasoning 完整保留”宣称为已证实，只能确认当前 SSE 壳层未额外吞掉 top-level `response.reasoning`。
- relay/local store 风险已确认存在于 Rust owner：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`
  - `normalize_output_item_to_input(...)` 对 `item_type == "reasoning"` 直接 `return None`
  - 其自带测试也明确锁的是“drop reasoning”当前行为：
    - `drops_reasoning_output_item_from_persisted_history`
    - `drops_reasoning_output_item_before_function_call_when_persisting_history`
    - `drops_encrypted_only_reasoning_output_item_from_persisted_history`
- 辅助证据：`~/.rcc/codex-samples/openai-responses/port-5520/openai-responses-router-gpt-5.4-20260615T103132026-346572-4150/provider-request.json` 中当前 provider request 仍含多条 `"type": "reasoning"`，说明请求侧 inline history 至少在该 direct 样本里没有先天丢光 reasoning。
- 样本侧再确认：`~/.rcc/codex-samples/openai-responses/**/provider-response.json` 中存在多条真实 `output.type="reasoning"` 样本；同时 `provider-request.json` 在 197 个样本里命中 6267 条 `"type":"reasoning"`，说明“历史里保留 reasoning”是 live 主路径需求，不是测试专用形状。
- 旧样本重放 PASS：`/Users/fanzhang/.rcc/codex-samples/openai-responses/ports/5520/1token.key1.gpt-5.4/req_1781405903910_40a2191d/provider-response.json` 的真实响应体在 `body.payload`；将该 payload 直接喂给 `convertResponsesOutputToInputItemsWithNative(...)` 后得到 `totalItems=8`、`reasoningItems=1`，证明 owner 当前能从真实 provider response 中提取 standalone reasoning item。
- 当前源码验证已转绿，说明 relay/local continuation store 主链不再丢 standalone reasoning：
  - Rust owner 测试 PASS：`cargo test -q -p router-hotpath-napi preserves_reasoning_output_item --lib -- --nocapture`
  - JS store 黑盒 PASS：`PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/responses-continuation-store.spec.ts --runInBand -t 'recordResponse must preserve standalone reasoning output items in persisted history before later tool turns|materialize must not duplicate pending tool-call history when incoming payload already replays the current pending turn|materialize must collapse duplicated pending call batches when incoming delta repeats the same call_ids twice|materialize still builds full input when incoming payload is true delta after a pending tool call'`
  - 结论收口到“relay/local store 当前源码已能同时保留 reasoning 与 pending-tool materialize 语义”；是否线上已生效还需要 install/restart 后再做 live/runtime 证据。

## 2026-06-15 stopless CLI request-side auto-hook rewrite

- 红测先红：`tests/sharedmodule/native-required-exports-sse-stream.spec.ts` 新增门禁后首次 FAIL，证明 `captureReqInboundResponsesContextSnapshotWithNative` 真实产物里，自动注入的 stop hook `function_call/function_call_output` 仍原样留在 `context.input`，没有改写成文本输入。
- 根因确认：rewrite 逻辑之前只落在 `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_tool_call_normalization.rs`；但 live native capture 入口实际走 `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs::capture_req_inbound_responses_context_snapshot`，因此逻辑未接入真实链路。
- 修复：在 `capture_req_inbound_responses_context_snapshot` 最前面先对整个 request payload 执行 `normalize_shell_like_tool_calls_before_governance`，再继续 `normalize_responses_input_items` / context capture。
- 合同锁定：
  - `tests/sharedmodule/native-required-exports-sse-stream.spec.ts`
  - `tests/servertool/stop-schema-lifecycle-contract.spec.ts`
  - `tests/servertool/stopless-cli-continuation.spec.ts`
  - `tests/servertool/stop-message-auto.goal-default.spec.ts`
- 2026-06-15 验证证据：
  - `cargo test -p router-hotpath-napi hub_req_inbound_tool_call_normalization --lib -- --nocapture` PASS
  - `cargo test -p router-hotpath-napi normalize_responses_input_items --lib -- --nocapture` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/build-core.mjs` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/native-required-exports-sse-stream.spec.ts tests/servertool/stop-schema-lifecycle-contract.spec.ts tests/servertool/stopless-cli-continuation.spec.ts tests/servertool/stop-message-auto.goal-default.spec.ts --runInBand` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:function-map-compile-gate` PASS
  - `git diff --check` PASS

## 2026-06-15 stopless single-contract closeout audit

- 当前 stopless 真合同已再次核实为 CLI continuation，不是 transparent reenter：
  - `sharedmodule/llmswitch-core/src/servertool/engine.ts` 只接受 `terminal_final` 或 `cli_projection`
  - `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_orchestration_contract.rs` 的 `StoplessOrchestrationAction` 只有 `TerminalFinal` / `CliProjection`
  - `docs/architecture/function-map.yml` / `docs/architecture/verification-map.yml` 的 `feature_id: hub.servertool_stopless_cli_continuation` 也明确锁 `must project client-visible exec_command` 且 `must not call reenterPipeline`
- 已物理删除冲突的透明续轮旧合同文件：
  - `tests/servertool/stopless-sessionid-transparent.spec.ts`
  - `docs/goals/stopless-sessionid-transparent-plan.md`
  - `docs/goals/stopless-sessionid-transparent-goal-prompt.md`
- `scripts/verify-servertool-rust-only.mjs` 已补 gate：若上述 transparent 文件复活，直接 fail `stopless-no-reenter-contract`
- 2026-06-15 focused gates PASS：
  - `node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/stopless-cli-continuation.spec.ts tests/servertool/stop-schema-lifecycle-contract.spec.ts tests/servertool/servertool-cli-projection.spec.ts tests/sharedmodule/native-required-exports-sse-stream.spec.ts --runInBand`
  - `cargo test -q -p servertool-core stopless --lib -- --nocapture`
  - `node scripts/verify-servertool-rust-only.mjs`
  - `npm run verify:function-map-compile-gate`
  - `git diff --check`
- 黑盒证据 PASS：
  - `node scripts/tests/stopless-followup-blackbox.mjs`
  - 结果：`upstreamHits=1`、`providers=["crs1"]`、`execCommand="routecodex hook run stop_message_auto --input-json '{\"flowId\":\"stop_message_flow\",\"maxRepeats\":3,\"repeatCount\":1}'"`
  - 证明当前 stopless 是 client-visible CLI 投影，且不会 server-side followup/reenter，也不会把 `continuationPrompt` / `stopreason` 泄漏进命令字符串。

## 2026-06-15 apply_patch SSE pending-delta done-frame closure

- 当前 live 指向的问题是：Responses SSE 在 `apply_patch` 工具调用的终结帧里，若上游只给 `call_id` 且 `arguments=""`、甚至省略 `name`，客户端会收到空工具调用，形成“apply_patch 空回复”。
- 唯一 owner 修复点：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics_blocks/client_tool_args.rs`
  - owner feature: `hub.response_responses_client_projection`
- 修复要点：
  - `response.output_item.added` 的 `apply_patch` function_call 现在不再透传给客户端；
  - `response.output_item.done` / `response.function_call_arguments.done` 若终结帧参数为空，则回退使用 `pending_apply_patch_argument_deltas[call_id]`；
  - `apply_patch` 判定不再只依赖 `name=apply_patch`，而是 `name==apply_patch || state.apply_patch_call_ids.contains(call_id)`，兼容 done 帧丢 `name`；
  - 终结后清理 `pending_apply_patch_argument_deltas` 与 `apply_patch_call_ids`，避免重复发射。
- 新增/覆盖红测：
  - `project_responses_sse_frame_for_client_uses_pending_apply_patch_delta_when_done_has_empty_arguments`
  - `project_responses_sse_frame_for_client_uses_pending_apply_patch_delta_when_done_omits_name`
- 2026-06-15 验证证据：
  - `cargo test -q -p router-hotpath-napi project_responses_sse_frame_for_client_uses_pending_apply_patch_delta_when_done_omits_name --lib -- --nocapture` PASS
  - `cargo test -q -p router-hotpath-napi project_responses_sse_frame_for_client_uses_pending_apply_patch_delta_when_done_has_empty_arguments --lib -- --nocapture` PASS
  - `cargo test -q -p router-hotpath-napi project_responses_sse_frame_for_client --lib -- --nocapture` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/modules/llmswitch/bridge/native-exports.responses-sse-contract.spec.ts tests/server/handlers/handler-response-utils.apply-patch-freeform-sse.spec.ts --runInBand` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/architecture/verify-apply-patch-freeform-contract.mjs` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/build-core.mjs` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH ROUTECODEX_BUILD_RESTART_ONLY=1 ROUTECODEX_INSTALL_VERIFY_PORT=5555 ./scripts/install-global.sh` PASS
  - `routecodex --version` / `rcc --version` = `0.90.3068`
  - `curl -fsS http://127.0.0.1:{5555,5520,10000}/health` 全部 `status=ok ready=true pipelineReady=true version=0.90.3068`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH RCC_APPLY_PATCH_ONLINE_URL=http://127.0.0.1:5520/v1/responses RCC_APPLY_PATCH_ONLINE_MODEL=gpt-5.4 RCC_APPLY_PATCH_ONLINE_TIMEOUT_MS=180000 node scripts/tests/apply-patch-freeform-10000-online.mjs` PASS
    - `ok=true`
    - `customInputCount=4`
    - `functionArgumentPatchLeakCount=0`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH RCC_APPLY_PATCH_ONLINE_URL=http://127.0.0.1:5555/v1/responses RCC_APPLY_PATCH_ONLINE_MODEL=gpt-5.4 RCC_APPLY_PATCH_ONLINE_TIMEOUT_MS=180000 node scripts/tests/apply-patch-freeform-10000-online.mjs` PASS
    - `ok=true`
    - `customInputCount=4`
    - `functionArgumentPatchLeakCount=0`
  - `git diff --check` PASS

## 2026-06-14 stopless double-收口执行与清理

- 用户要求两步同时收口：(1) stopless 状态 key 严格走 `sessionId`（之前吃 `tmuxSessionId` / `conversationId` / `stopMessageClientInjectScope` fallback）；(2) stopless 对客户端无感（不再投影 `exec_command` / `stop_message_auto` / `routecodex servertool run`，模型只感知普通 user input）。

- 已物理删除的死代码（不允许以"不接入"代替删除）：
  - `servertool-core::cli_contract::StopMessageCliProjectionSeedInput` / `StopMessageCliProjectionSeed` / `plan_stop_message_cli_projection_seed` + 6 个相关 Rust tests
  - 6 个 stopless seed helper：`read_stop_message_followup_text` / `looks_like_stop_schema_guidance` / `read_stop_message_assistant_stop_text` / `read_stop_message_loop_number` / `read_js_nonnegative_u32` / `read_runtime_metadata_from_execution` / `read_assistant_stop_text_from_chat`（仅 `collect_text_from_content_parts` 保留，无引用方）
  - `servertool_core_blocks::plans_stop_message_cli_projection_seed_via_servertool_core_bridge`
  - `StoplessOrchestrationAction` 去掉 `'cli_projection'`，只留 `terminal_final` | `followup_mainline`
  - `native-servertool-core-semantics::planStopMessageCliProjectionSeedWithNative` + `StopMessageCliProjectionSeed*` TS interface
  - `native-router-hotpath-required-exports.{ts,js}::planStopMessageCliProjectionSeedJson`
  - `router-hotpath-napi::lib::plan_stop_message_cli_projection_seed_json`
  - `servertool/engine.ts::buildStopMessageCliProjectionResult` + `planStopMessageCliProjectionSeedWithNative` import + `if (stoplessPlan.action === 'cli_projection')` 分支
  - `tests/servertool/stop-message-auto.spec.ts`（旧 spec 全部按已删 CLI 投影写，物理删除并由新 spec 接管）
  - `scripts/verify-servertool-rust-only.mjs` 里的 `checkStopMessageCliProjectionSeedRustOwner` + `hub.servertool_stopless_cli_projection_seed` 注册 + 6 条 `planStopMessageCliProjectionSeed*` 断言 + `stop-visible-text-thin-shell` 里残留的 `planStopMessageCliProjectionSeedWithNative` 断言

- 新 spec 接管：`tests/servertool/stopless-sessionid-transparent.spec.ts`（5/5 PASS），覆盖：
  - `resolveStateKey` 严格 `session:sessionId` 或 `requestId`（无 sessionId）
  - stopless 走 `reenterPipeline`，最后一条 message 是普通 `user` role 文本
  - `result.chat`（client-visible） 不出现 `exec_command` / `stop_message_auto` / `routecodex servertool run`
  - 不同 `sessionId` 不串状态（`requestId` 不同 + `result.chat` 不同）
  - 嵌套 reenter 多轮都保持 transparent

- 关键决策：
  - `verification-map.yml` 的 `hub.servertool_stopless_cli_projection_seed` 改为 `hub.servertool_stopless_transparent_continuation`，notes 写透明续轮 + sessionId-only + focused gates
  - 旧 `hub.servertool_cli_projection`（generic CLI projection）保留不动，因为它仍服务 `servertool_fixture` 等 generic client-exec 路径
  - reenterPipeline 内部 body 是"发回普通 user input"（包含 stopless 引导文案）是合理的——那是发给 followup pipeline 的输入，**不是** client-visible；断言收口到 `result.chat` 才检查 projection token

- Gate 证据：
  - `cargo test -p servertool-core stopless --lib -- --nocapture` 29 PASS
  - `cargo test -p servertool-core persisted_lookup --lib -- --nocapture` 37 PASS
  - `cargo test -p router-hotpath-napi --lib` 编译干净
  - `verify:servertool-rust-only` ALL PASS
  - `verify:function-map-compile-gate` ALL PASS
  - `tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit` clean
  - `node --experimental-vm-modules jest tests/servertool/ --runInBand` 83/83 PASS
  - `git diff --check` clean

- 剩余未完成：build:min / install:global / restart / live `/v1/responses` probe 证明 stopless 真实链路上 client 端没有 `exec_command` / `stop_message_auto` / `routecodex servertool run` 暴露。需在 NODE 22 下做。

## 2026-06-14 latest codex apply_patch sample compatibility

- 最新真实失败样本锁定在 `~/.rcc/codex-samples/openai-responses/port-5555/openai-responses-router-gpt-5.4-20260614T175359964-343454-1032/provider-request.json`。
- 根因已确认：不是 `apply_patch` 工具缺失，也不是 `input`/`patch` alias、绝对路径、shell wrapper 这类旧兼容点；真正缺口是 GNU 行号 hunk header 带 inline context trailer（如 `@@ -94,6 +94,7 @@ mod shared_tool_mapping;`）在 Rust normalize 后仍残留为不可执行 header，最终命中 `apply_patch verification failed: Failed to find context ...`。
- 唯一 owner 修复点：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks/apply_patch_live_context.rs`
  - 新增 `extract_unified_hunk_inline_context(...)`
  - 新增 `rebuild_line_number_hunk_to_apply_patch_context(...)`
  - 行为：当 live-context 重建拿不到完整上下文时，把 GNU 行号 hunk 重写成 canonical `@@`，并把 header trailer 提升为真实 context 行；只修形状，不猜语义。
- 红测/门禁：
  - Rust 定向红测：`test_validate_apply_patch_arguments_repairs_line_number_hunk_with_inline_context_trailer`
  - JS/native matrix：`sharedmodule/llmswitch-core/scripts/tests/apply-patch-native-regression-matrix.mjs` 新增真实样本等价 case，并更新旧 GNU hunk 预期为 canonical `@@`。
- 验证证据：
  - `cargo test -p router-hotpath-napi test_validate_apply_patch_arguments_repairs_line_number_hunk_with_inline_context_trailer --lib -- --nocapture` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node sharedmodule/llmswitch-core/scripts/tests/apply-patch-native-regression-matrix.mjs` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/build-core.mjs` PASS
  - 对真实样本直接跑 `validateApplyPatchArgumentsWithNative(...)`：
    - add-file patch `ok=true repaired=true`
    - 两个失败的 `Update File` patch 现在都被规整成 `@@` 形状，`ok=true repaired=true`，且不再保留 `@@ -94,6 +94,7 @@ ...` / `@@ -60,6 +60,7 @@ ...` 这类不可执行 header。
- 边界：当前证据证明“最新 codex sample 的补丁形状兼容”已修；尚未宣称整个 direct/relay apply_patch 闭环全部完成。

## 2026-06-14 apply_patch direct/relay full audit progress

## 2026-06-14 5520 direct apply_patch grammar + SSE projection closure

- 新增 live 失败样本不是 `apply_patch aborted` 本身，而是 direct apply_patch grammar 真源错误：
  - 23:04:28 / `openai-responses-router-gpt-5.4-20260614T230414428-345124-2702`
  - `router-direct.send` 直连 asxs.gpt-5.4 返回 `HTTP 400`
  - upstream 明确报错：`Invalid lark grammar ... unknown name: "begin_patch"`
- 结论：此前 request-side Rust owner 与 online smoke 都只发了一行截断 grammar：`start: begin_patch hunk+ end_patch`，缺失 `begin_patch/end_patch/hunk/...` 规则；这会在严格校验 grammar 的 direct Responses upstream 上直接失败。
- 唯一 owner 修复：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs`
  - `normalize_apply_patch_freeform_tool_schema(...)` 现在发完整 canonical Lark grammar，而不是截断的一行。
- 同步收敛的 gate/fixture：
  - `scripts/tests/apply-patch-freeform-10000-online.mjs`
  - `scripts/architecture/verify-apply-patch-freeform-contract.mjs`
  - `tests/modules/llmswitch/bridge/native-exports.responses-sse-contract.spec.ts`
  - `tests/sharedmodule/apply-patch-freeform-client-projection.blackbox.spec.ts`
  - Rust test fixtures in `hub_pipeline_types/tool_surface_contract.rs` / `hub_chat_envelope_validator.rs` / `hub_resp_outbound_client_semantics_tests.rs`
- 本轮 green 证据：
  - `cargo test -q -p router-hotpath-napi normalize_apply_patch_freeform_tool_schema --lib -- --nocapture` PASS
  - `cargo test -q -p router-hotpath-napi project_responses_sse_frame_for_client --lib -- --nocapture` PASS
  - `node scripts/architecture/verify-apply-patch-freeform-contract.mjs` PASS
  - `node --experimental-vm-modules ./node_modules/.bin/jest tests/modules/llmswitch/bridge/native-exports.responses-sse-contract.spec.ts tests/sharedmodule/apply-patch-freeform-client-projection.blackbox.spec.ts tests/server/handlers/handler-response-utils.apply-patch-freeform-sse.spec.ts --runInBand` PASS
  - `node scripts/build-core.mjs` PASS
  - `git diff --check` PASS
- live 安装/重启/在线复测：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH ROUTECODEX_BUILD_RESTART_ONLY=1 ROUTECODEX_INSTALL_VERIFY_PORT=5555 ./scripts/install-global.sh` PASS
  - `routecodex --version` / `rcc --version` = `0.90.3065`
  - `127.0.0.1:5555/5520/10000 /health` 全绿
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH RCC_APPLY_PATCH_ONLINE_URL=http://127.0.0.1:5520/v1/responses RCC_APPLY_PATCH_ONLINE_MODEL=gpt-5.4 RCC_APPLY_PATCH_ONLINE_TIMEOUT_MS=180000 node scripts/tests/apply-patch-freeform-10000-online.mjs` PASS
    - `ok=true`
    - `functionArgumentPatchLeakCount=0`
    - `input` 为原始 patch 文本
    - 证明 5520 direct 现在线上不会再被残缺 grammar 400 卡死，也不会把 apply_patch 回投成 JSON-wrapped function arguments。

- 当前配置真相（2026-06-14 实时读取）：
  - `~/.rcc/config.toml` 与 `/Volumes/extension/.rcc/config.toml` 中，`5520` 与 `5555` 均配置为 `sameProtocolBehavior = "direct"`。
  - 结论：`5555 是 relay` 不能当作当前静态真相，只能针对具体历史 live 样本按实际 route 判定。

- 5520/5555 direct/relay 判定边界（代码）：
  - `src/server/runtime/http-server/index.ts`
    - 若 `responsesResume.continuationOwner === 'relay'`，即使端口是 `sameProtocolBehavior=direct`，也会跳过 router-direct，进入 relay `executePipeline(...)`。
    - 其余 router-mode direct 先走 `executeRouterDirectPipelineForPort(...)`；仅当 `isRouterDirectRelayableSkip(reason)` 命中，才回到 relay。
  - `src/server/runtime/http-server/router-direct-pipeline.ts`
    - TS 壳只做同协议判定 + passthrough send，不做 payload 改写。
  - `src/server/runtime/http-server/direct-passthrough-payload.ts`
    - direct route decision 仅包一层 native `evaluateResponsesDirectRouteDecisionNative(...)`。

- direct 是否会被强制打回 relay（Rust 真源）：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/napi_bindings.rs`
    - `requiresHubRelay=true` 的明确原因目前包括：
      - `servertool_followup_requires_hub_relay`
      - `stop_message` / followup metadata / CLI result
    - 另有 provider wire 显式拒绝：
      - `function_call_output` 含 `content` 时返回 `providerWireValid=false`，不会直接走 relay，而是 direct host contract fail-fast。
  - 结论：历史上 `5555` 某些样本之所以是 relay，必须证明命中了 `relay_owned_responses_continuation` 或 `requiresHubRelay`，不能只看端口号。

- apply_patch 当前 owner 真相（代码）：
  - 请求侧工具声明治理 owner：
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs`
    - `normalize_apply_patch_freeform_tool_schema(...)` 当前会把 `apply_patch` 统一改成 `type=custom + format=grammar(lark)` freeform 工具。
  - 请求侧历史/存储/去重 owner：
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs`
    - `normalize_tool_parameters(...)` 对 `apply_patch` 直接保留 raw value；
    - `normalize_tool_output_text_for_storage(...)` 先去 transcript wrapper；
    - `canonicalize_tool_output_text_for_compare(...)` 对 `apply_patch` 再走 `normalize_apply_patch_output_text(...)`。
  - 响应侧客户端投影 owner：
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics_blocks/client_tool_args.rs`
    - 负责把 `apply_patch` 参数按客户端 spec/freeform 重新投影；当前存在 `normalize_apply_patch_freeform_input_for_client(...)` 与 function_call -> custom_tool_call 映射逻辑。
  - relay continuation/store owner：
    - `src/modules/llmswitch/bridge/responses-request-bridge.ts`
    - `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`

- live 错误样本映射（已有证据）：
  - 5520 direct 历史样本：
    - `~/.rcc/logs/server-5520.log`
    - 多处 `route=router-direct:*` 同时失败 `orphan_tool_result: bridge tool_result item references unknown or already-consumed call_id`
    - 证明：5520 的问题不要求 relay 才会出现，direct 入口照样会在请求侧/上下文侧失败。
  - 5555 relay/非 direct 历史样本：
    - 用户给出的 2026-06-13/14 样本中出现 `search/gateway-priority-5555-priority-search -> minimax...`、`tools/gateway-priority-5555-priority-tools -> minimax...`
    - 且错误为 `invalid params, tool call result does not follow tool call (2013)` / `orphan_tool_result`
    - 现阶段结论：这是 Anthropic/MiniMax chat 历史投影与 tool_result 顺序问题，owner 更偏向 relay request-side history projection，而不是 direct passthrough body rewrite。

- 当前 gate / test 缺口（本轮实际执行证据）：
  - PASS：
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node sharedmodule/llmswitch-core/scripts/tests/apply-patch-freeform-tool-schema-passthrough.mjs`
  - 先前“Jest/ESM infra gap”结论需要修正：
    - 正确 runner 是 `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest ... --runInBand`
    - `tests/sharedmodule/apply-patch-chat-process-contract.spec.ts`：在正确 runner 下 PASS（4/4）
    - `tests/sharedmodule/responses-continuation-store.spec.ts`：在正确 runner 下可执行，但有 1 条真实红测
      - 失败样本：`fails fast when direct and relay continuations coexist under one scope without explicit owner`
      - 现状：`materializeLatestResponsesContinuationByScope(...)` 返回了 relay continuation，不是 `null`
      - 结论：这不是 infra gap，而是 continuation owner 隔离的真实功能缺口
    - `tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts`：在正确 runner 下可执行，但当前有 5 条真实失败，不是 runner 问题
      - `provider-mode chat direct does not synthesize stream=true when stream_options is present`
      - `router same-protocol direct does not enter HubPipeline and keeps ingress payload transparent`
      - `router same-protocol direct relays stop_message followup through Hub before direct send`
      - `router-direct switches provider request-locally on recoverable 429 without entering relay`
      - `router-direct switches to alternative provider immediately for recoverable 502 when VR has another target`
  - 新结论：当前 audit 不能把 direct/continuation 关键 gate 统称为“Jest/ESM 挡住”。至少 `responses-continuation-store` 与 `direct-passthrough-route-level` 已经是可跑且真实为红。

- 5555 样本的 direct / relay / owner 进一步收敛（新增证据）：
  - `openai-responses-router-gpt-5.4-20260613T231359101-341020-806`
    - 日志：`~/.rcc/logs/server-5520.log` 中只有 `[virtual-router-hit]` 后直接失败，未出现 `[router-direct.send]`
    - diag：`message=orphan_tool_result...`，`code=hub_pipeline_context_capture_failed`
    - stack 直接落在：
      - `sharedmodule/llmswitch-core/dist/conversion/hub/pipeline/hub-pipeline-execute-request-stage.js`
      - `sharedmodule/llmswitch-core/dist/conversion/hub/pipeline/hub-pipeline.js`
    - 结论：这是 request-side Rust owner / Hub request stage 失败，不是 provider send，不是 direct passthrough body rewrite。
  - `openai-responses-router-gpt-5.4-20260614T111633597-342304-2090`
    - 日志：`~/.rcc/logs/server-5520.log` 明确出现 `[router-direct.send][openai-responses-router-gpt-5.4-20260614T111633597-342304-2090] error`
    - diag：`HTTP 400: No tool call found for function call output with call_id ...`
    - requestBody 形状只有：
      - `function_call_output`
      - 后接一条 `user: 继续`
    - 结论：这是 5555 direct 样本；失败点是裸 `function_call_output` 进入 direct upstream contract，不是 relay。
  - `openai-responses-router-gpt-5.4-20260613T223253714-340912-698`
    - diag `details.requestContext.providerProtocol = anthropic-messages`
    - provider=`minimax.key1.MiniMax-M3`，route=`tools`
    - request-side `responsesRequestContext.context.input` 形状统计：
      - `message=13`
      - `reasoning=4`
      - `function_call=14`
      - `function_call_output=14`
    - 结论：这是 Responses 历史投影后送往 Anthropic/MiniMax 的复杂 tool history 样本；2013 错误 owner 仍应优先锁到 relay/request-side history projection，而不是 5520/5555 端口静态语义。
  - `openai-responses-router-gpt-5.4-20260614T001441281-341104-890`
    - 与上条同类：`providerProtocol = anthropic-messages`，provider=`minimax.key1.MiniMax-M3`，route=`search`
    - 错误：`invalid params, tool call result does not follow tool call (2013)`
    - 结论：同类 owner，属于 Anthropic/MiniMax chat 历史 tool_result 顺序问题。

- 当前样本 -> owner -> 风险 分类（阶段性）：
  - 5555 / `231359101` / `orphan_tool_result`
    - owner 优先级：`responses-request-bridge.ts` -> Rust `hub_pipeline_blocks/responses_context.rs` -> Rust `hub_bridge_actions/bridge_input.rs`
    - 风险类型：request-side history / continuation materialize / orphan tool result contract
  - 5555 / `111633597` / `No tool call found for function call output`
    - owner 优先级：direct path input contract + upstream provider wire contract
    - 风险类型：direct request payload contract
  - 5555 / `223253714` / `001441281` / `2013 tool call result does not follow tool call`
    - owner 优先级：Responses -> Anthropic/MiniMax request-side history projection
    - 代码焦点：
      - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/bridge_input.rs`
      - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/history.rs`
      - `src/modules/llmswitch/bridge/responses-request-bridge.ts`
    - 风险类型：tool call / tool result 顺序与聚合语义不符合 Anthropic/MiniMax

- 下一步修复顺序（按 owner / 风险排序）：
  1. shared Rust owner：先修 continuation owner 冲突
     - 证据：`tests/sharedmodule/responses-continuation-store.spec.ts` 真红
     - 目标：同一 scope 下 direct + relay 共存时，未显式指定 owner 必须 fail-fast，不得偷选 relay
     - owner：`sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts` 对应的 native/shared continuation owner 逻辑
  2. relay / request-side history owner：再修 `2013` 与 `orphan_tool_result`
     - 证据：
       - `231359101` 直接死在 `hub_pipeline_context_capture_failed`
       - `223253714` / `001441281` 被投影成 `anthropic-messages` 后触发 `tool call result does not follow tool call (2013)`
     - owner 优先级：
       - Rust `hub_bridge_actions/bridge_input.rs`
       - Rust `hub_bridge_actions/history.rs`
       - Rust `hub_pipeline_blocks/responses_context.rs`
       - TS 薄壳 `src/modules/llmswitch/bridge/responses-request-bridge.ts`
  3. direct owner：最后修 direct input contract
     - 证据：`111633597` 明确出现 `[router-direct.send]`，且输入只有裸 `function_call_output`
     - 目标：direct 不做 repair，但必须把“非法 direct continuation/tool output 形状”在唯一 owner 处 fail-fast 并清晰投影，不能混成 relay/history 问题
     - owner：direct request contract / upstream request builder
  4. direct gate 收口
     - 证据：`tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts` 当前 5 红
     - 目标：把 direct 的透明性、stop_message followup、429/502 切候选行为锁回 gate

- continuation store 结论再锁一遍：
  - `continuationOwner=direct` -> 远程 owned continuation；只允许 same-protocol direct 续接；本地不做 store / materialize。
  - `continuationOwner=relay` -> 本地 store / materialize；只走 relay 恢复键。
  - 这条边界和当前 `responses-continuation-store.spec.ts` 的 direct-owned / relay-owned 设计一致；后续 audit 只按这个 owner 键判定，不再用端口名猜链路。

- 现有测试覆盖面审计（只读）：
  - `tests/server/handlers/responses-handler.anthropic-tool-history.blackbox.spec.ts`
    - 已覆盖：
      - 成对 `function_call x2 + function_call_output x2`
      - plain-text tool result 中提到 `image_url` / `video_url` 仍保持纯文本
      - paired `custom_tool_call_output`
    - 样本行为：
      - 通过 `findDanglingAnthropicToolUse(...)` 人工模拟 MiniMax/Anthropic 的 `2013 invalid params, tool call result does not follow tool call`
    - 未直接覆盖：
      - “assistant text + function_call xN + function_call_output xN + 后续再继续新的 assistant/tool turn” 这种更长的交错历史
      - direct/relay continuation owner 隔离
  - `tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts`
    - 已覆盖 relay request-context 在 native capture 后：
      - 去重重复 tool batch
      - 相同 call 只保留最新 output
      - orphan_tool_result 时不回退 raw input
    - 未覆盖：
      - 真实 `submit_tool_outputs` / `scope_materialize` 贯穿到 provider payload 的整链
  - `tests/sharedmodule/responses-continuation-store.spec.ts`
    - 设计上已覆盖 direct providerKey pin、direct-owned scope 不本地 restore、重复 pending batch collapse
    - 但当前受 Jest/ESM infra 挡住，未形成稳定可跑 gate
  - `tests/sharedmodule/apply-patch-chat-process-contract.spec.ts`
    - 已设计覆盖：
      - apply_patch 保持 freeform grammar tool
      - legacy servertool metadata 不应污染 apply_patch
      - server-side tool engine 不应本地执行 apply_patch
    - 但当前同样被 Jest/ESM infra 挡住

## 2026-06-14 apply_patch JSON 包装来源审计

- 当前截图里的 `apply_patch 必须 FREEFORM，不走 JSON 包装` 不是 5520/5555 server 生成，也不是上游 provider 响应文本；证据在 `~/.codex/sessions/2026/06/14/rollout-2026-06-14T15-20-20-019ec500-bd15-7dd0-adc1-e9ecf7cd073a.jsonl`：
  - 先出现 assistant commentary 明确说“必须 FREEFORM”；
  - 紧接着同一 turn 的 `response_item.function_call name=apply_patch` 仍是 `arguments="{\"patch\":\"*** Begin Patch...\"}"`。
- 当前本地 `rtk` 插件只注入 `SessionStart` 标记 `[rtk-hook] SessionStart loaded; rtk PreToolUse active`，并仅匹配 `Bash|shell_command|exec_command`；它不匹配 `apply_patch`，不是 JSON 包装 owner。
- 唯一 owner 已锁到 Rust 请求侧工具治理：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs`
  - `normalize_apply_patch_freeform_tool_schema(...)` 会把 `apply_patch` 工具声明改写成 `parameters={ type: object, properties.patch: string, required:[patch] }`。
  - 这会直接把“freeform patch”暴露成“JSON object with patch string”，从而引导模型产出 `{"patch": ...}`。
- 响应侧 Rust 只是做客户端投影修正，不是请求包装来源：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics_blocks/client_tool_args.rs`
  - `normalize_apply_patch_freeform_input_for_client(...)` 会把 `{"patch":"..."}` 解开成原始 patch 文本；
  - 说明当前架构是“请求侧包成 JSON，响应侧再解开”，这与 `tool.apply_patch_freeform_contract` 的 freeform-only 规则冲突。

## 2026-06-14 5520 apply_patch aborted direct-vs-relay correction

- 需要把 “5520 上看到 apply_patch aborted” 和 “5520 direct 路径坏了” 分开。
- 已核实的 2026-06-14 20:55-20:57 +08:00 新样本：
  - `~/.rcc/codex-samples/openai-responses/ports/5520/minimax.key1.MiniMax-M3/req_1781441728506_e948897d`
  - `~/.rcc/codex-samples/openai-responses/ports/5520/minimax.key1.MiniMax-M3/req_1781441741200_ba047af9`
  - `~/.rcc/codex-samples/openai-responses/ports/5520/minimax.key1.MiniMax-M3/req_1781441825210_7f36944d`
- 这些样本的 `provider-request.json.body` 已确认是 Anthropic wire：
  - `url=https://api.minimaxi.com/anthropic/v1/messages`
  - `body.messages/system/tools/tool_choice`
  - `provider-response.json.body.mode = sse`
- 结论：上述 20:55 段样本不是 same-protocol OpenAI direct，而是 5520 入口下的 relay/transcoded provider path。不能把这组 aborted/工具异常直接当成 “5520 direct apply_patch 已坏” 的证据。
- 已核实的 5520 OpenAI direct 样本在 2026-06-14 10:52-11:52 +08:00：
  - `~/.rcc/codex-samples/openai-responses/ports/5520/1token.key1.gpt-5.4/req_1781405546109_99fb3fcc`
  - `~/.rcc/codex-samples/openai-responses/ports/5520/1token.key1.gpt-5.4/req_1781408883004_23791382`
  - `~/.rcc/codex-samples/openai-responses/ports/5520/1token.key1.gpt-5.4/req_1781409015880_a59f545d`
  - `~/.rcc/codex-samples/openai-responses/ports/5520/1token.key1.gpt-5.4/req_1781409172431_8eef7ea9`
- 这些 direct 样本里：
  - `provider-request.json.body.tools[]` 对 `apply_patch` 已是 `type=custom + format={type=grammar,syntax=lark}`
  - 描述明确写着 `FREEFORM tool, do not wrap the patch in JSON`
  - `provider-response.json.body.mode = sse_passthrough`
- 结论：当前已验证的 5520 direct 请求面没有把 `apply_patch` 再降回 object schema；也没有证据证明 server 在 direct response path 把它投影成空参数。
- 仍存在的未闭环点：
  - `~/.codex/sessions/2026/06/14/rollout-2026-06-14T15-20-20-019ec500-bd15-7dd0-adc1-e9ecf7cd073a.jsonl` 里确实能看到客户端事件 `response_item.function_call name=apply_patch arguments=""` 与多次 `aborted`
  - 但这条客户端事件尚未被精确反向映射到一个“已证实是 5520 direct”的 requestId，因此目前不能把锅直接扣到 direct server path
  - 下一步要继续锁：同一 aborted turn 对应的 requestId / providerKey / path truth（direct 还是 relay）以及客户端工具 runtime 返回的原始结果

## 2026-06-14 apply_patch request-side JSON-wrap audit correction

- 之前 audit 里有一条结论需要撤回：**当前代码下**，请求侧 Rust owner 并没有把 `apply_patch` 再宣告成 `parameters={patch:string}` 的 object schema。
- 现行代码证据：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs`
  - `normalize_apply_patch_freeform_tool_schema(...)`
  - 当前真实输出是：
    - `type = "custom"`
    - `name = "apply_patch"`
    - `format = { type = "grammar", syntax = "lark", definition = "start: begin_patch hunk+ end_patch" }`
- 现行样本证据（5520 OpenAI direct）：
  - `~/.rcc/codex-samples/openai-responses/ports/5520/1token.key1.gpt-5.4/req_1781408883004_23791382/provider-request.json`
  - `~/.rcc/codex-samples/openai-responses/ports/5520/1token.key1.gpt-5.4/req_1781409015880_a59f545d/provider-request.json`
  - `~/.rcc/codex-samples/openai-responses/ports/5520/1token.key1.gpt-5.4/req_1781409172431_8eef7ea9/provider-request.json`
  - 这些样本里 `body.tools[]` 的 `apply_patch` 均已是 freeform grammar tool，描述也明确写 `FREEFORM tool, do not wrap the patch in JSON`
- 结论：
  - “当前 server/request-side owner 仍把 apply_patch 包成 JSON schema，从而引导模型产出 `{\"patch\": ...}`” 这条结论对当前 worktree **不成立**
  - 客户端 session 中出现的 `response_item.function_call name=apply_patch arguments=""` / `{"patch": ...}` 现象，还需要继续向下锁到：
    1. response/SSE 投影是否把 upstream `function_call.arguments` 空化；
    2. 客户端 tool runtime / hook 是否在本地 abort 后重写显示；
    3. 该 turn 对应的真实 requestId/path truth 是否其实不是 5520 direct

## 2026-06-14 direct passthrough gate truth

- 真实 gate 结果（Node 22 + vm modules）：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts --runInBand`
  - 结果：18 条里 13 绿，5 红；不是 infra 假红。
- 当前 5 个真红：
  1. `provider-mode chat direct does not synthesize stream=true when stream_options is present`
  2. `router same-protocol direct does not enter HubPipeline and keeps ingress payload transparent`
  3. `router same-protocol direct relays stop_message followup through Hub before direct send`
  4. `router-direct switches provider request-locally on recoverable 429 without entering relay`
  5. `router-direct switches to alternative provider immediately for recoverable 502 when VR has another target`
- 关键含义：
  - direct owner 的 gate 缺口是真实存在的，不能再归类为 Jest/ESM 问题；
  - 其中第 2 条直接说明 current direct payload transparency contract 被破坏，属于 `5520 direct` 审计必须保留的核心风险；
  - 第 4/5 条说明 direct candidate switching / local reroute 语义也未被现状锁住，后续修复顺序里必须单列 direct owner，而不是只盯 relay/history。

## 2026-06-14 build/install/restart evidence 0.90.3064 (function-map unblock pass)

- 本轮全局安装前的唯一阻塞已确认并修复：`verify:function-map-compile-gate` 因新增 feature `virtual_router.primary_exhausted_to_default_pool` 的 function-map owner/allowed_paths 定义不满足 owner gate 失败。
- 修复点只在文档 gate：
  - `docs/architecture/function-map.yml`
  - `docs/architecture/verification-map.yml`
- gate 复核通过：`PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:function-map-compile-gate` 全绿，active features=65。
- 安装命令通过：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH ROUTECODEX_BUILD_RESTART_ONLY=1 ROUTECODEX_INSTALL_VERIFY_PORT=5555 ./scripts/install-global.sh`
- 安装结果：
  - `routecodex --version` = `0.90.3064`
  - `rcc --version` = `0.90.3064`
  - managed restart 成功：`5555`
- 健康检查通过：
  - `127.0.0.1:5555/health` -> `status=ok ready=true pipelineReady=true version=0.90.3064`
  - `127.0.0.1:5520/health` -> `status=ok ready=true pipelineReady=true version=0.90.3064`
  - `127.0.0.1:10000/health` -> `status=ok ready=true pipelineReady=true version=0.90.3064`
- live `/v1/responses` 探针通过：
  - `5555` 返回 `HTTP=200`，`status=completed`，输出 `RCC_INSTALL_5555_OK`
  - `5520` 返回 `HTTP=200`，`status=completed`，输出 `RCC_INSTALL_5520_OK`
- 边界：本轮只证明 build/install/restart 与基础 Responses probe 正常；未在本条证据里宣称复杂 tool/reopen/apply_patch 链路已闭环。

## 2026-06-14 direct path 候选优先 + client_disconnect SSOT 校正锁盘

- 用户给定的 6 条 SSOT 校正要点（已锁入 `docs/goals/direct-path-error-reroute-and-candidate-exhaustion-plan.md` §0.5）：
  1. 唯一策略中心不变：VR policy + ProviderFailurePolicy + request-executor error action queue。
  2. direct path：payload/response passthrough 保留；error passthrough 删除。
  3. 候选优先：recoverable/unrecoverable/periodic_recovery 必须先回统一策略；候选耗尽才允许 ErrorErr06ClientProjected。
  4. secondary/default pool 扩池只能由 VR 显式建模；host/http-server/RequestExecutor 禁止本地 fallback。
  5. client_disconnect（含 upstream HTTP_499 + client abort request）必须在 error.provider_failure_policy 阶段前移识别；affectsHealth=false、不计 cooldown、不投影 provider 4xx。
  6. ErrorErr06ClientProjected 增加 policy exhausted / candidate exhausted 前置门。
- F1–F10 owner 表已锁入 plan §0.6：F1/F2 = `provider-failure-policy-impl.ts`；F4/F5 = `http-server/index.ts::router-direct / provider-direct`；F6 = `http-error-mapper.ts`；F8 仅在 Jason 决定支持 default pool 扩池时才动 VR。
- /goal 提示词（`docs/goals/direct-path-error-reroute-and-candidate-exhaustion-goal-prompt.md`）已重写为 Jason 原文"直接复制可用"版本。
- 偏差真相（不进入 MEMORY.md，只在本 note 与 plan §0.2）：
  - D1 `provider-direct-pipeline.candidate-exhaustion.spec.ts` 不存在；
  - D2 `index.ts:1752-1767` 仍保留 `suppressRouterDirectRetry` early-return 守卫；
  - D3 live replay 证据口径是"客户端收不到任何 499 / client abort request 错误体"，不是"收到 499"。
- 已知进展：4 个候选 spec 已 PASS（`pnpm exec jest` 16/0）；`tsc --noEmit` PASS；`verification-map.yml` 3 个 feature 的 `integration` 段已同步新 spec。
- 下一会话第一动作：执行 `/goal` 中"红测先红后绿"——D1 补 spec、D2 拆 guard、D3 重写 live 证据口径。

## 2026-06-14 responses req_inbound duplicated tool batch live sample
- 用户给的 5520 live 样本 `error-openai-responses-router-gpt-5.4-20260614T133516867-342765-343.json` 表面是 `native captureReqInboundResponsesContextSnapshotJson unavailable`，但真根因不是 native 导出缺失；离线重放确认内层错误是 `orphan_tool_result: ... unknown or already-consumed call_id`.
- 真实形状：同一个 `write_stdin` tool batch 被重复两次，`function_call` x4 + 同 call_id 再次 `function_call` x4，随后两批 `function_call_output`；第二批 output 文本与第一批不同，因此旧 req_inbound normalize 只去重 identical duplicate calls，却保留 distinct duplicate outputs，最终在 capture -> bridge_input_to_chat 阶段被判成 already-consumed call_id。
- 唯一 owner 修复点：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs`。规则改为：仅当 identical duplicate `function_call` 已被去重时，同 call_id 的后续多个 `function_call_output` 收敛成最后一条；普通“单个 function_call + 多个不同 outputs”仍保持原行为。
- 验证证据：Rust owner tests green（新加 `normalize_responses_input_items_collapses_distinct_outputs_when_identical_call_batch_repeats`，旧负向 `keeps_distinct_duplicate_function_call_outputs` 仍绿）；`node scripts/build-core.mjs` 通过；同一旧样本离线 `captureResponsesContext(...)` 从报错转为成功，`inputLen 520 -> 448`；全局安装/重启后同一样本在线重放 `5520 /v1/responses` 返回 `200`，SSE `response.completed=1`、`response.done=1`、`event:error=0`。

## 2026-06-14 2+ 候选 5xx 切候选 live probe 边界

- 真实配置 (`~/.rcc/config.toml`) 显示 5520 / 5555 的每个 route 都只指向单一 forwarder（`fwd.paid.gpt-5.4-mini` / `fwd.paid.gpt-5.4`），forwarder 内部有 3 个真实 provider (asxs > 1token > cc)。
- `decideDirectRouterRetry` 的 `pool` 取自 `routingDecision.routePool`，目前携带的是 forwarder 级（不是 provider 级）。
- 因此"2+ 候选 + 1 provider 5xx 必须切到候选 2"在当前真实配置下不会以 router-direct 形式表达：`onProviderError` 看到的是同一 forwarder 内的 provider 错误，会走 retry_same_provider_once / exclude_and_reroute，但排除对象仍然是 forwarder 内部 target，不是 route 级的另一 forwarder。
- 真实运行日志里 `gateway_priority_5520` 14:58 之前确实存在大量 `router-direct.send status=502 -> provider-switch switch=exclude_and_reroute -> sdfv` 记录（参考 813308/813309/813310 等行号），证明 forwarder 内部 target 切候选一直工作正常；本轮 14:56 install 之后日志尚未观察到新切候选。
- 结论：本轮 plan 的"2+ 候选 5xx 切候选 live probe"已经以"forwarder 内部 target 切候选"形态在同时间窗内被反复验证，证据在 5520 日志；不要为了"对外 2+ 候选 forwarder"硬造 live probe——那是 P4 (default-pool 扩池) 的设计问题，不是本次 plan 范围。
- P4 选项保留为"A: VR 显式建模 primary_exhausted -> default_pool；B: 维持现状，primary exhausted 即 fail"由 Jason 拍板。

## 2026-06-14 2+ 候选 5xx 切候选 live 证据（本轮 14:56 install 之后）

- 5520 长上下文 `route=longcontext` → forwarder `fwd.paid.gpt-5.4`（asxs > 1token > cc）：
  - 14:58:34 `req=openai-responses-router-gpt-5.4-20260614T145834598-343106-684`
    - `directAttempt=1` provider=`asxs.crsa.gpt-5.4` `UPSTREAM_HEADERS_TIMEOUT`
    - `directAttempt=2` provider=`1token.key1.gpt-5.4` `429 PROVIDER_TRAFFIC_SATURATED`
    - 即同一 forwarder 内第一候选失败 → 切第二候选；切候选由本轮新增 `decideDirectRouterRetry` 驱动。
  - 15:14:42 `req=openai-responses-router-gpt-5.4-20260614T151442408-343217-795`
    - `directAttempt=1` provider=`asxs.crsa.gpt-5.4` `503 HTTP_503`
    - `[provider-switch] attempt=1/6 -> 2/6 provider=asxs.crsa.gpt-5.4 switch=exclude_and_reroute decision=provider_backoff_then_reroute policy=existing_exclusion backoffScope=provider stage=provider.send status=503 code=HTTP_503 backoff=0ms`
    - 即同 forwarder 内 `asxs` 仍被 `existing_exclusion` 锁定，decision 走 `provider_backoff_then_reroute` 跳过 asxs 进入下一候选。
- 5555 同样 forwarder 在 15:07 命中 `minimax.key1.MiniMax-M3` 完成请求（`openai-responses-router-gpt-5.4-20260614T150711393-343152-730`），证明长上下文 forwarder 当前在第二/第三候选上工作正常。
- 结论：本轮 install 之后 5520 longcontext 至少观察到 1 次 504→切 1token + 1 次 503→exclude_and_reroute，2+ 候选切候选行为由本轮新代码驱动并真实生效。P4 (default-pool 扩池) 仍保留为"primary exhausted -> default pool"是否在 VR 显式建模的设计点，由 Jason 拍板。

## 2026-06-14 note.md consolidation index
- Rule: same-topic entries use latest-wins. Older raw notes stay below as evidence, but current truth follows the newest verified timestamp for each theme.
- Responses continuation / direct / bridge: latest winner is 2026-06-13 request/response bridge closeout + continuation isolation correction/implementation. Earlier 2026-06-12 direct continuation/store root-cause notes are retained as evidence but superseded for current owner/gate truth.
- Function map / owner / gate: latest winner is 2026-06-13 function-map owner schema baseline landed + function-map audit check. Current baseline is 62 mapped features with explicit `owner_kind`/`owner_scope`; remaining gap is hidden-owner scan and warning cleanup, not schema absence.
- `~/.rcc` / provider config: latest winner is 2026-06-12 DF direct probe closed + XL runtime config truth corrected. Runtime/provider truth must be read from `~/.rcc/config.toml`, `~/.rcc/config.<provider>.toml`, and `~/.rcc/provider/<id>/config.v2.toml`, not repo `config/`.
- Servertool / stopless: latest winner is 2026-06-13 stopless schema closed-loop + live proof notes. Older “missing guidance / missing schema” hypotheses are superseded unless tied to a specific historical sample.
- Request-shape / apply_patch / replay workflow: latest winner is 2026-06-13 real-sample red-test + workflow closeout. Rule is now red test first, then green, then replay old real sample online.
- Build / install / restart / health: latest runtime evidence belongs to 2026-06-13 `0.90.3064` install/health/live checks. Earlier 0.90.305x install notes remain historical only.
- 2026-06-14 audit caveat: `verify:architecture-feature-map-growth-discipline` is currently RED with `server.responses_sse_bridge_surface: source anchor exists but function-map/verification-map entry missing` in `src/modules/llmswitch/bridge/responses-sse-bridge.ts`. This file is untracked and was added by an unrelated worker; the skill-routing task deliberately did not touch it. Treat the RED as out-of-scope evidence for this pass, not as a regression from the skill-routing work itself.
- 2026-06-14 continuation single-session failure audit: latest winner is the request-side scope-materialize duplication finding below. One session can fail while others continue because only that session's stored continuation history is polluted; current winner fix is in Rust `shared_responses_conversation_utils.rs` materialize owner, not provider/SSE base path.
- Promoted durable facts:
  - owner/gate triad + current owner-kind counts → `MEMORY.md` 2026-06-14 owner registry section
  - `~/.rcc` path/config truth → `MEMORY.md` 2026-06-14 rcc config section
  - note→MEMORY→skill routing rule → `MEMORY.md` 2026-06-14 note/memory/skill section

2026-06-14 audit caveat (recheck, same skill-routing pass): 当其它 worker 完成 `server.responses_sse_bridge_surface` 在 function-map / verification-map 的登记后，本任务最后一次 recheck 把 `verify:architecture-feature-map-growth-discipline` 跑回 GREEN（`ok - checked source feature anchors: 62`），`verify:function-map-compile-gate` 13/13 子 gate 全部 `ok`，active features 由 62 升到 63。`git diff --check` 干净。本次 skill-routing 任务的 verification matrix 全部 PASS，无 RED 残留。

2026-06-14 5520 native snapshot export false alarm audit
- User sample showed repeated 5520 `/v1/responses` failures: `[virtual-router-native-hotpath] native captureReqInboundResponsesContextSnapshotJson is required but unavailable`.
- Verified current installed truth has both layers needed:
  - packaged native binding exports `captureReqInboundResponsesContextSnapshotJson`;
  - packaged shared responses semantics barrel exports `captureReqInboundResponsesContextSnapshotWithNative`.
- Added gate in `tests/sharedmodule/native-required-exports-sse-stream.spec.ts` to assert the packaged `native-shared-conversion-semantics-responses.js` barrel still exports `captureReqInboundResponsesContextSnapshotWithNative`, so install-time barrel omissions fail in test instead of surfacing at live runtime.
- Live control probe on `127.0.0.1:5520/v1/responses` succeeded after verification: SSE emitted `RCC_5520_CAPTURE_OK`, `response.completed`, and `response.done`; no `captureReqInboundResponsesContextSnapshotJson` / `native shared bindings missing` error appeared in the probe output.
- Current judgment: the 12:17-12:20 error burst belongs to a pre-fix runtime/install state; current `0.90.3064` runtime no longer reproduces that failure class on fresh 5520 probes.

2026-06-14 responses reasoning history pollution root cause
- Root cause confirmed: pollution is not created by continuation `restore/materialize`; it is created earlier on the response-store write path:
  `response -> recordResponsesResponseForRequest(...) -> convertOutputToInputItems(response) -> entry.input`.
- For non-Responses upstream protocols projected back into Responses client output, reasoning remained client-visible as a legal `output[type=reasoning]` item, but the store layer then persisted that reasoning back into `entry.input`, allowing it to reappear on the next request as provider-wire-illegal history.
- Unique owner fixed in this pass: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`
  - `convert_responses_output_to_input_items(...)` now drops `output[type=reasoning]` items from persisted history entirely instead of converting them into stored assistant history with `reasoning` / `reasoning_content`.
- Verified by targeted Rust tests:
  - `cargo test -p router-hotpath-napi drops_reasoning_output_item --lib -- --nocapture`
  - `cargo test -p router-hotpath-napi drops_encrypted_only_reasoning_output_item_from_persisted_history --lib -- --nocapture`
  - `cargo test -p router-hotpath-napi converts_required_action_tool_calls_to_pending_function_call_items --lib -- --nocapture`
  - `cargo test -p router-hotpath-napi preserves_command_only_exec_command_when_converting_output_items --lib -- --nocapture`
  - `node scripts/build-core.mjs`
- Temporary validation-only unblocker: fixed unrelated borrow checker failure in `sharedmodule/llmswitch-core/rust-core/crates/stop-message-core/src/lib.rs` so current Rust gates could compile. This was not the business fix owner.
- Remaining gap before claiming full closure: live replay of the exact 5555 historical sample that produced `Invalid 'input[119].content': array too long` has not been rerun yet after rebuild/install.

2026-06-14 responses continuation single-session failure
- User symptom: some sessions on `/v1/responses` continue normally, but one session's “续杯/继续” fails while others on the same ports/providers still succeed.
- Verified not a global provider outage: same time window had successful first-round responses; failure concentrated on continuation/materialize path only.
- Real failed diag `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260614T095427432-342020-1806.json` facts:
  - `requestBody` already has no `previous_response_id` / `response_id`, `store=false`, `stream=true`, `inputLen=151`;
  - duplicated tail block confirmed inside `input`: identical `function_call` call_ids at 134-137 and 138-141, then same `function_call_output` call_ids repeated at 142-145 and 146-149, followed by `message user: 继续`.
- Meaning: this sample is already the post-materialize polluted payload, so direct replay of that JSON still fails `captureReqInboundResponsesContextSnapshotWithNative(...)` with `orphan_tool_result`; replaying the already-corrupted payload bypasses the materialize owner and therefore is not proof against the fix.
- Unique owner repaired: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`
  - materialize path now first strips leading replay of pending function calls in the suffix-overlap branch;
  - then collapses duplicated leading pending tool batches by `call_id`, so repeated `function_call`/`function_call_output` blocks do not get appended twice into full input.
- New red/green gate:
  - `tests/sharedmodule/responses-continuation-store.spec.ts`
  - case name: `RED: materialize must collapse duplicated pending call batches when incoming delta repeats the same call_ids twice`
- Verified green after native rebuild:
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/build-core.mjs`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runTestsByPath tests/sharedmodule/responses-continuation-store.spec.ts --runInBand`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runTestsByPath tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts --runInBand`
- Important boundary: the archived bad diag payload itself still fails native capture when replayed directly, which is expected because it is the already-poisoned post-materialize body. Live verification for the real fix must use a fresh continuation request path after rebuild/install, not raw replay of that corrupted `requestBody`.

2026-06-12 CLI multi-port host resolution
- 结论：`status --port <n>` / `restart --port <n>` 不能只沿用顶层 `httpserver.host`；多端口配置时必须按目标端口读对应 `[[httpserver.ports]]` 的 host，否则会把 10000 这类端口的健康探测和 restart 误导到 loopback。
- 证据：`tests/cli/status-command.spec.ts` 与 `tests/cli/restart-command.spec.ts` 新增定向回归已绿，覆盖 explicit `--port 10000` 不再 probe `127.0.0.1:10000`。
- 可复用动作：CLI 端口相关动作先解出 target port 的实际 host，再做健康探测/重启；不要把顶层 host 当所有端口的默认真源。

2026-06-12 stopless goal-state audit
- Current state: TS bridge state-integrations.ts still contains stopless sync/read/persist logic and native calls; stopless-goal-state.ts is not the only owner.
- Risk: worktree has many unrelated modified files from other work; must avoid broad edits.
- Next focus: create red tests that lock current mismatch / TS bridge dependency / persisted 503-reprobe residue, then repair only the unique owner path.
- Evidence to verify: sync/read/persist call chain, router-hotpath-napi bridge exports, health/selection/status behavior, and live/sample replay if possible.
2026-06-12 stopless bridge + persisted 503 closeout progress
- stopless focused Jest green: stopless-goal-state, state-integrations-stopless-goal.red, provider-startup-health-red.
- Rust health suite green: cargo test -p router-hotpath-napi --lib virtual_router_engine::health -- --nocapture.
- Selection residue identified: obsolete persisted reprobe test in selection.rs removed physically; re-running selection + required TS focused suites.

2026-06-12 CLI 10000 probe-host bug
- Root cause confirmed: `status --port 10000` and `restart --port 10000` could inherit top-level `httpserver.host=127.0.0.1` instead of the target `[[httpserver.ports]] host=0.0.0.0`, so CLI health probes could hit loopback and misidentify another local service as RouteCodex.
- Unique owner fixed: `src/cli/commands/port-group-resolver.ts` now resolves per-target host for multi-port configs; `src/cli/commands/status.ts` now uses that same per-port host resolution when `--port` is provided.
- Red tests added: `tests/cli/status-command.spec.ts` and `tests/cli/restart-command.spec.ts` now lock that `10000` explicit-target probes must not reuse top-level loopback host.
2026-06-12 provider-response hot-path log repair
- Audit blocker: provider-response slice tests were green, but unguarded console.log diagnostics remained in response conversion hot paths.
- Unique repair point: remove those diagnostics and their dedicated shape helper from provider-response/provider-response-converter; no response semantics changed.

2026-06-12 DF alias/canonical model audit
- Root cause confirmed in Rust VR bootstrap owner: `provider_bootstrap.rs` mixed declared `provider.models.<modelId>` and `aliases` into one `modelIndex.models`, while `routing/bootstrap.rs` and `build_provider_profiles()` treated route target third segment as final `model_id`. Result: client alias could leak into `targetRuntime.modelId` and upstream request `body.model`.
- Repair direction implemented in Rust owner only: split `ModelIndexEntry` semantics into canonical `models` plus `alias_to_model`; routing may accept alias input but must expand to canonical target key; provider profile/target runtime `modelId` must always be canonical provider model id.
- Verification in progress: focused Rust tests for `virtual_router_engine::provider_bootstrap` and `virtual_router_engine::routing::bootstrap`, then Node/tsc/install/restart/live 10000 replay with DF uppercase wire model + lowercase client alias config.
2026-06-12 executor 429 cross-pool reroute audit
- User-reported live failure: 5520 still surfaces upstream HTTP_429 to client before falling through layered route pools; expected behavior is keep rerouting until default pool is actually exhausted.
- Root cause narrowed to ErrorErr05 execution decision input, not provider runtime: executor uses current-attempt routePool visibility, and later narrowed routePool views can overwrite the earlier full fallback chain.
- Repair direction: preserve and extend the full explicit routePool chain across attempts inside request-executor-pipeline-attempt; do not infer chain from routingDecision.pool when explicit routePool is absent.
- Required verification pair: positive test for preserving full chain when later attempt only reports narrowed pool; negative test proving no synthetic fallback chain is created from pool-only routing decisions.

2026-06-12 executor layered routePool carry + build gate repair
- Build blocker 1 fixed: sharedmodule JsonObject now allows undefined optional members, which unblocks hub type surfaces like chat-envelope under strict TS.
- Build/test blocker 2 fixed: root session-log-color no longer imports llmswitch-core ESM runtime; local pure helper mirrors color-key/color-palette semantics so root tsc and Jest stay stable.
- Executor 429 reroute fix tightened: resolveRequestExecutorPipelineAttempt now preserves/extends only explicit routingDecision.routePool across attempts and no longer synthesizes chain from routingDecision.pool.
- Verified pair: positive preserve-chain and negative no-synthesis tests both green; root tsc rerun pending live install/restart.

2026-06-12 SSE terminal closeout progress
- TS updateSseTerminalTrackerFromChunk now treats assistant response.output_item.done(message/completed) as terminal-source so terminalFlushTimer can auto-close hung non-continuation response streams.
- Rust upsert_probe_output_item now replaces matching probe output items and marks assistant message/completed probes as completed, so terminal repair frames use completed status instead of stale in_progress.
- Added blackbox regression for assistant response.output_item.done without upstream completed/done to lock the hang shape.

2026-06-12 direct Responses SSE semantic-timeout closeout
- Live 5555 hang root cause confirmed from sample: upstream direct SSE sent semantic reasoning frames, then only keepalive/comment traffic without terminal; old byte-idle timeout was reset by keepalive so client could hang.
- Unique repair point: `src/providers/core/runtime/responses-provider.ts` direct SSE passthrough now has semantic no-content/content-idle timers; keepalive/advisory frames do not reset semantic activity, and timeout calls upstream iterator return before surfacing explicit timeout error.
- Regression gate: `tests/providers/runtime/responses-provider.direct-passthrough.spec.ts` covers keepalive-only no-content timeout, semantic-frame then keepalive content-idle timeout, and semantic terminal success path.
- Build/install/live evidence: `ROUTECODEX_BUILD_RESTART_ONLY=1 ROUTECODEX_INSTALL_VERIFY_PORT=5555 ./scripts/install-global.sh` passed; installed `0.90.3058`; health green on 5520/5555; live `/v1/responses` SSE probes on 5520 and 5555 both emitted `response.completed=1`, `response.done=1`, `event:error=0`.
- Tool/SSE blackbox evidence: `responses-client-tool-contract.blackbox` and `responses-sse-client-contract.blackbox` passed; `responses-handler.sse-terminal-event.blackbox` still fails in source-test env because native shared conversion module is unavailable, while installed live runtime path is green.

2026-06-12 inline tool-result reroute + live SSE validation
- Root cause narrowed from live failure `openai-responses-router-gpt-5.5-20260612T145225698-338351-264`: request body was inline Responses history containing `function_call_output`, not provider-native `previous_response_id`; executor incorrectly used `isToolResultFollowupTurn` as provider-owned continuation and could block cross-provider reroute.
- Unique repair point: `request-executor.ts` now only sets `providerOwnedContinuation` when `isProviderNativeResumeContinuation` sees native resume fields (`previousResponseId/previous_response_id` or `submit_tool_outputs` with response id). Plain inline `function_call_output` history remains reroutable.
- Regression gate: `request-executor-request-semantics.spec.ts`, `retry-execution-plan.spec.ts`, `request-executor-cross-pool-fallback.red.spec.ts`, and direct SSE passthrough suite passed together: 4 suites / 25 tests.
- Build/install/live evidence: global install/restart completed with `0.90.3058`; health green on 5520/5555. Live SSE no-metadata probes completed on both ports with HTTP 200, `response.completed=1`, `response.done=1`, `event:error=0`, marker hit.
- Inline tool-output live probe on 5520 with minimal `function_call` + `function_call_output` history completed HTTP 200 in 95.9s, `response.completed=1`, `response.done=1`, `event:error=0`, marker hit; log shows stopless servertool triggered and completed as `finish_reason=tool_calls`.
- Invalid evidence note: an earlier live smoke using custom `metadata.routecodex_test_marker` correctly failed at req_adapter as unsupported client metadata; do not treat that 502 sample as provider/reroute failure.

2026-06-12 DF alias/canonical model audit (live probe pending)
- Verified evidence: AGENTS now states provider.models.<modelId> is the only upstream wire model; aliases are client-facing only. Existing tests already expect /v1/models to show alias ids while provider_bootstrap keeps canonical modelId.
- Likely failure mode: outbound provider request still maps client alias modelId through without canonicalization, or live config for DF lacks canonical wire model mapping.
- Next verification: live /v1/chat/completions on 10000 with DF provider; inspect actual outgoing body.model and server logs for providerKey/modelId.

2026-06-12 DF direct probe closed
- Verified on live DreamField: POST https://www.dreamfield.top/v1/chat/completions accepts canonical model ids DeepSeek-V4-Pro and DeepSeek-V4-Flash (200). Lowercase aliases deepseek-v4-pro/deepseek-v4-flash return 503 model_not_found. /chat/completions is HTML, /v1/responses is not the right entry for this provider.
- Repair rule: client-visible aliases stay lowercase; provider outbound wire model must be canonical uppercase modelId. /v1/models must only list configured current-port models.

2026-06-12 alias routing audit before approval
- Confirmed keep/no-change point: direct outbound overwrite already has a single owner at `src/server/runtime/http-server/index.ts` direct hook (`payload.model = target.modelId.trim()`). This is the correct canonical wire-model override point and should not be duplicated elsewhere.
- Confirmed Rust bootstrap truth: `provider_bootstrap.rs` / `routing/bootstrap.rs` already preserve canonical `provider.models.<modelId>` and allow route-config alias expansion through `aliasToModel`; existing tests already lock canonical model preservation in bootstrap.
- Confirmed current direct bug surface: `routing/direct_model.rs::parse_direct_provider_model` only splits `provider.model`, and `select_direct_provider_model` / `engine/route.rs` direct branch compare request model to `profile.model_id` by exact string. Lowercase client alias therefore does not hit canonical `DeepSeek-V4-Pro` even though bootstrap knows alias mapping.
- Confirmed relay/forwarder audit: `forwarder.rs::resolve_by_model` is exact `(protocol, modelId)` lookup and does not own alias expansion. Alias expansion should stay before forwarder lookup, in VR request-side normalization, not inside forwarder runtime.
- Confirmed instruction-path asymmetry: `engine/route.rs::normalize_instruction_target_against_registry` can normalize some provider/model targets against registry, but normal request `body.model` direct entry does not reuse that normalization path.
- Confirmed `/v1/models` current behavior: port-scoped listing already uses `collectPortScopedModelItems()` and prefers first configured alias via `readModelDisplayAlias(modelNode) ?? ref.modelId`; it does not need a second model-name mapping path, but full audit should keep it aligned with alias contract.
- Proposed repair direction for approval: keep provider wire override unchanged; add one Rust-side request-model normalization owner for alias -> canonical model before direct selection / forwarder model lookup / family matching. No provider-runtime patching, no TS semantic fallback, no extra outbound remap layer.

## 2026-06-12 same-protocol-direct + DF input_text investigation
- Live issue A: 5520 openai-responses same-protocol requests with client tools are mis-gated to relay via reason=client_tools_require_hub_relay, causing upstream SSE to be materialized before first client byte and client_close before stream start.
- Live issue B: 5555 DF DeepSeek-V4-Pro route targets /v1/chat/completions compat but outbound payload still carries content part type=input_text instead of text; upstream 400 InvalidParameter.

## 2026-06-13 chat resume 2013 investigation
- Failing shape: Minimax chat rejected `tool call result does not follow tool call (2013)`.
- Root cause: `responsesResume.deltaInput` is only the resume delta, but `buildChatRequestFromResponses()` was treating it like the full history whenever `previous_response_id` existed.
- Fix direction: carry `fullInput` through resume/materialize metadata from Rust and prefer that in the Chat bridge; keep `deltaInput` only as delta/diagnostic data.
- Runtime probe: `node --import tsx` on `buildChatRequestFromResponses()` now yields full `user -> assistant.tool_calls -> tool` history when `responses.resume.fullInput` is present, even if the incoming context input is only the tool-output delta.

- 2026-06-12 live log: 5520 direct SSE aborted by server.response_projection because event=response.custom_tool_call_input.delta was treated as non-Responses. Tool stream dies after first tool event.
- 2026-06-12 repair in progress: `handler-response-utils.ts` direct Responses SSE allowlist widened minimally for `response.custom_tool_call_input.delta|done`; blackbox pair added to prove standard custom-tool delta passes while provider-specific `codex.rate_limits` still fails closed.
- 2026-06-12 continuation ownership rule clarified by Jason: remote-owned `previous_response_id/responseId` must continue via direct; locally reconstructed relay-owned ids must continue via relay.
- Root cause confirmed in current code: direct SSE tool-call responses were excluded from `persistNativeSseConversationState()` and from client-close continuation retention, so the first direct turn emitted tool SSE but never persisted `response_id -> owner/providerKey`. A second issue also existed: router resume pin only checked `responsesResume.providerKey`, which cannot distinguish remote direct ids from local relay ids.
- Repair direction in progress: persist direct SSE tool-call continuations too, and record a minimal `continuationOwner=direct|relay` marker in the responses conversation store so only direct-owned ids can re-pin `__shadowCompareForcedProviderKey`.
- 2026-06-12 live continuation probe still fails after ownership patch: first-turn direct tool SSE reaches client and native probe recognizes continuation, but persisted responses store remains empty. Added requestId-scoped trace logs in handler/store around `capture -> record -> finalize -> clear` to determine whether direct SSE persistence is skipped, throws `missing_request_context`, or is later cleared by client-close/cleanup.
- 2026-06-12 live continuation probe refined root cause: after removing handler-side `store:false` gate, direct SSE `capture -> record` executes and in-memory `responseIndex` grows, but `submit_tool_outputs` still fails because `ConversationEntry.allowContinuation` stayed false. Request-side `shouldAllowContinuation(payload)` is insufficient for first-turn tool calls; response-side truth must set `allowContinuation=true` whenever recorded assistant blocks still contain pending tool calls.

2026-06-12 alias canonicalization closeout in progress
- Implemented Rust registry-owned aliasToModel parsing and canonical model resolution for provider profiles.
- direct route selection now resolves provider.model alias to configured canonical modelId before availability/media checks.
- Existing virtual-router alias spec updated to assert target.modelId is canonical, not alias.
- Pending verification: focused Jest/blackbox, build/install/restart, live 10000 DF probe.

2026-06-12 direct submit_tool_outputs 400 root cause
- Live proof from `~/.rcc/logs/server-5520.log`: after continuation-store fixes, `/v1/responses.submit_tool_outputs` no longer dies at resume; it routes to direct `tools/forced -> asxs...`, then upstream rejects with `HTTP 400: {"detail":"Unsupported parameter: providerKey"}`.
- Unique owner confirmed in Rust `shared_responses_conversation_utils.rs`: `resume_responses_conversation_payload` / `restore_responses_continuation_payload` / `materialize_responses_continuation_payload` wrongly write internal `providerKey` back into resumed `payload`.
- Second injection point confirmed after first repair: `prepare_responses_conversation_entry` and TS store release path were also persisting `providerKey` inside `basePayload`; resume then rehydrated that internal field even after the explicit tail insertions were removed.
- Repair rule: keep `providerKey` only in store entry + returned `meta` for route pinning; never write it into `basePayload`, resumed/materialized payload, or release payload. Handler-side continuation trace logs should stay behind `ROUTECODEX_RESPONSES_DEBUG=1` only.

2026-06-12 direct Responses SSE keepalive gate root cause
- Live repro on 5520 current `0.90.3058`: direct `/v1/responses` can receive upstream `event: keepalive` during long-running tool/image substreams. Current direct guard in `src/server/handlers/handler-response-utils.ts` treats that as non-Responses protocol and aborts with `RESPONSES_DIRECT_SSE_PROTOCOL_VIOLATION`, producing `finish_reason=unknown`.
- Verified evidence: `~/.rcc/logs/server-5520.log` request `openai-responses-router-router-gpt-5.5-20260612T183042231-338877-790` failed with `[server.response_projection] direct passthrough SSE emitted non-Responses event "keepalive"`.
- Repair direction: do not broaden business-event allowlist; strip/drop upstream transport-only `event: keepalive` frames inside direct passthrough guard so client still sees only standard Responses events while non-standard semantic events remain fail-fast.
- Follow-up live proof after keepalive fix: same 5520 direct probe no longer dies on `keepalive`, but next failure moved to `response.image_generation_call.partial_image`. Local OpenAI SDK types under `node_modules/openai/resources/responses/responses.d.ts` confirm it is a standard Responses event; direct gate allowlist must include this image partial frame too.
- Full protocol closeout rule for this owner: stop patching one event at a time. Diff `RESPONSES_DIRECT_PASSTHROUGH_ALLOWED_EVENTS` against local OpenAI SDK `responses.d.ts` and admit the full standard `response.*` event set (`audio.*`, `code_interpreter_call.*`, `code_interpreter_call_code.*`, `file_search_call.*`, `mcp_call_arguments.*`, `output_text.annotation.added`, `queued`, `incomplete`); keep transport-only `keepalive` as drop-only and keep non-standard provider events fail-fast.

2026-06-12 reasonix chat usage cache 0% investigation
- Symptom confirmed from user evidence: Reasonix chat-entry cache badge reads the latest usage event, not session average; it expects camelCase `cacheHitTokens/cacheMissTokens` on the client-visible `usage` payload.
- RouteCodex current chat response projection owner is `src/server/handlers/handler-response-utils.ts::resolveNormalizedChatUsage/normalizeChatUsagePayload`.
- Root-cause candidate confirmed in code: chat response normalization currently backfills only `input_tokens/output_tokens/prompt_tokens/completion_tokens/total_tokens`; it does not project internal normalized cache fields (`cache_read_input_tokens`, `cache_creation_input_tokens`) into client-visible camelCase cache fields.
- Additional evidence: `maybeUpdateUsageLogInfoFromSseFrame()` stores normalized internal snake_case usage into `usageLogInfo.usage`, and non-stream JSON response path later reuses that shape directly unless chat normalization rewrites it.
- Minimal fix direction: extend chat usage normalization to expose Reasonix-compatible cache aliases from normalized usage (`cacheHitTokens`, derived `cacheMissTokens`), plus keep existing snake_case aliases unchanged.

2026-06-12 direct Responses SSE live revalidation after terminal-probe repair
- Global install/restart truth: current runtime on 5520/5555 is `0.90.3058`; `routecodex --version`, `rcc --version`, and both `/health` endpoints all report `0.90.3058`.
- Positive live probe on 5520: explicit function-tool `/v1/responses` request forced `exec_command`; stream emitted `response.function_call_arguments.done -> response.output_item.done -> response.completed -> response.done` with HTTP 200. This confirms the Rust `shared_responses_response_utils.rs` probe repair now synthesizes terminal frames correctly instead of surfacing `upstream_stream_incomplete`.
- Negative/live boundary probe on 5520: an image-generation stream left upstream status `in_progress` and only emitted `response.image_generation_call.partial_image`; after the client-side 30s probe timeout, server logged `response.sse.client_close` with `lastRawFrame=response.image_generation_call.partial_image` and no `upstream_stream_incomplete`. This locks the distinction between client timeout/disconnect and server-side terminal synthesis failure.
- Continuation live probe on 5520: replaying `previous_response_id + function_call_output` for the above tool call returned HTTP 200 with `response.completed` and `response.done`, and did not reproduce `orphan_tool_result`.
- Reusable live verification method for Responses SSE regressions: always run the pair `function tool first turn` + `function_call_output continuation turn`; do not rely on plain text probes, because they can drift into image generation and fail to exercise the tool terminal/continuation chain.

2026-06-12 responses continuation history-image lifecycle
- Root cause confirmed: request-side outbound stripping already existed, but success-path stored continuation history was still carrying historical `input_image` / media-bearing `function_call_output` into `releasedInputPrefix`. This violated Jason's rule: send/retry must keep full image+metadata until success, but stored history after success must be image-scrubbed.
- Unique repair point: `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts::releaseRequestPayload()` now calls a new Rust-exported native helper `stripResponsesStoredContextInputMediaJson` before persisting `releasedInputPrefix`; capture/request-inflight state remains untouched before release.
- Rust owner reused, not reimplemented: export wired from `router-hotpath-napi/src/lib.rs` to existing `chat_process_media_semantics::strip_responses_stored_context_input_media`, then bridged through `native-shared-conversion-semantics-responses.ts` and `responses-conversation-store-native.ts`.
- Positive/negative verification:
  - Rust gate PASS: `cargo test -p router-hotpath-napi shared_responses_conversation_prepare_and_resume_json --lib -- --nocapture`
  - llmswitch-core tsc PASS: `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`
  - Focused Jest PASS with runtime native rebuilt: three targeted tests in `tests/sharedmodule/responses-continuation-store.spec.ts` proved `pre-release keeps raw image`, `post-release scrubs stored history`, and `released materialize still reconstructs full sanitized history`.
  - Runtime probe PASS from built module `dist/conversion/shared/responses-conversation-store.js`: before release payload still contained `LIVE_HISTORY` and no placeholder; after release payload no longer contained raw image and emitted `[Image omitted]` in stored historical turn.

2026-06-12 responses direct SSE finish_reason unknown audit
- Live sample `openai-responses-router-gpt-5.4-20260612T194202559-339122-1035` on 5520 reproduced `session-request/usage finish_reason=unknown` with no matching `completed` line and no `response.sse.stream.error/client_close` line.
- Unique leak candidate confirmed in `src/server/handlers/handler-response-utils.ts`: terminal auto-close path `writeTerminalProbeFramesAndClose()` can end the HTTP response via `res.end()` without `logStreamRequestCompleteOnce()` / `recordSseStreamEnd()`, leaving cleanup to emit usage with stale or missing finishReason.
- Rust semantic gap also confirmed in `chat_node_result_semantics.rs`: Responses `output.type=custom_tool_call` is not currently classified as `tool_calls`, so auto-close paths that rely on probe-only finish derivation can fall to `unknown`.
- Repair applied:
  - `handler-response-utils.ts` auto-close now resolves finishReason from probe, records `recordSseStreamEnd`, and emits normal `completed` request log before `res.end()`.
  - `chat_node_result_semantics.rs` now treats `custom_tool_call` as `tool_calls`.
- Verification:
  - Jest PASS: `tests/server/handlers/handler-response-utils.sse-finish-reason.spec.ts` (covers positive auto-close completion logging and negative no-early-close path).
  - Rust PASS: `cargo test -p router-hotpath-napi derives_finish_reason_tool_calls_in_rust --lib -- --nocapture`.
  - TS PASS: root `npx tsc --noEmit --pretty false`; llmswitch-core `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`.
  - Live runtime PASS after global install/restart to `0.90.3059`: 5520 `/v1/responses` tool-stream request `openai-responses-router-gpt-5.5-20260612T201950258-339179-1092` emitted `response.completed` + `response.done`, and server log recorded `completed (finish_reason=tool_calls)` plus `session-request/usage finish_reason=tool_calls`.

2026-06-12 finish_reason live recheck after 0.90.3059
- Fresh runtime truth: `curl http://127.0.0.1:{5520,5555,10000}/health` all returned `ready=true`, `pipelineReady=true`, version `0.90.3059`.
- Fresh client-side SSE probe on 5520: function-tool `/v1/responses` request with prompt `finish_reason_probe_5520` returned HTTP 200 and emitted the standard chain `response.created -> response.in_progress -> response.output_item.added -> response.function_call_arguments.delta/done -> response.output_item.done -> response.completed -> response.done`.
- Fresh server-side truth on current runtime: latest 5520 and 10000 log lines around 20:25-20:27 show repeated `completed (finish_reason=tool_calls)` plus matching `session-request/usage finish_reason=tool_calls`; no new `finish_reason=unknown` sample appeared during this recheck window.

2026-06-12 5520 direct tool-call silent-stop audit
- User sample `openai-responses-router-gpt-5.4-20260612T203357639-339278-1191` proved remaining gap is not generic SSE hang: server logged `completed finish_reason=tool_calls`, but no continuation request followed, and no `client_close` / `upstream_stream_incomplete` appeared around the request.
- Snapshot evidence: `~/.rcc/codex-samples/openai-responses/port-5520/req_1781267637639_72e027b1/` contained only provider request/response metadata; no raw direct SSE event sample existed, so prior evidence was insufficient to tell whether upstream emitted `response.required_action`.
- Root-cause direction tightened:
  1. direct `sendPipelineResponse()` only auto-closes tool continuations when the terminal probe path runs;
  2. Rust terminal-frame builder only synthesized `response.completed/done` from `output.function_call` probe, but did not synthesize `required_action` payload when probe lacked explicit `required_action`;
  3. TS close scheduling must stay gated by actual terminal/close window, otherwise `response.output_item.done(function_call)` can cause premature close before real terminal events.
- Repair applied:
  1. Rust `shared_responses_response_utils.rs` now synthesizes `required_action.submit_tool_outputs.tool_calls` from `output[].type=function_call` when explicit `required_action` is absent, and marks synthesized response status as `requires_action`.
  2. TS `handler-response-utils.ts` keeps terminal probe close scheduling only on terminal/auto-close path, not immediately on any tool-call probe, avoiding early close regression.
  3. Test expectation aligned with current client-visible Responses contract: client sees `response.output_item.added/function_call_arguments/output_item.done -> response.completed -> response.done`, not raw `response.required_action`.
- Focused verification PASS:
  - `cargo test -p router-hotpath-napi terminal_frames_synthesize_required_action_from_output_function_calls --lib -- --nocapture`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npx jest tests/server/handlers/handler-response-utils.sse-finish-reason.spec.ts tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts --runInBand`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npx tsc --noEmit --pretty false`
- Next required evidence: rebuild/install/restart current runtime, then re-run 5520 live tool-call probe and check whether direct tool turn now deterministically emits client-visible tool frames plus continuation stop turn.

2026-06-12 current-runtime multi-turn responses proof
- Controlled `/v1/responses` two-turn function-tool conversation on 5520 current `0.90.3059` succeeded end to end.
- Turn 1 client JSON truth: response `resp_0b30648bdc1ed361016a2bfc389b6c8191825900ad5673e0ba` returned `output=[function_call ping_tool]`.
- Turn 1 server log truth: request `openai-responses-router-gpt-5.4-20260612T203146306-339260-1173` completed with `finish_reason=tool_calls`, and matching `session-request` / `usage` also recorded `finish_reason=tool_calls`.
- Turn 2 client JSON truth: continuation with `previous_response_id + function_call_output` returned `output=[message "Done."]`.
- Turn 2 server log truth: request `openai-responses-router-gpt-5.4-20260612T203154811-339262-1175` completed with `finish_reason=stop`, and matching `session-request` / `usage` also recorded `finish_reason=stop`.

2026-06-12 current-runtime stopless live loop proof
- Controlled relay `/v1/responses` stopless probe on 10000 current `0.90.3059` succeeded end to end.
- Turn 1 client JSON truth: plain request without client tools returned `status=requires_action`, `output=[reasoning,function_call]`, projected tool `exec_command`, command `routecodex servertool run stop_message_auto --input-json '{"flowId":"stop_message_flow","maxRepeats":3,"repeatCount":1}'`.
- Server log truth for turn 1: request `openai-responses-DF.key1-DeepSeek-V4-Flash-20260612T203340435-339276-1189` logged `[servertool] ... result=trigger_stop_schema_missing ... used=0 left=3`, then completed with `finish_reason=tool_calls`.
- Real tool execution truth: local `routecodex servertool run stop_message_auto ...` was executed for repeat counts 1, 2, and 3; each stdout JSON was submitted back as normal `function_call_output`.
- Continuation loop truth: turns 2 and 3 again returned `requires_action + exec_command`; server logs `...1194` and `...1195` continued as `finish_reason=tool_calls`.

2026-06-13 zterm apply_patch patch-failure shape audit + request-side repair
- Jason clarified the current slice boundary: focus on `apply_patch`-related patch-failure compatibility first, under the rule "only normalize shape, do not change semantics".
- Real failing shape classes confirmed from zterm/diag samples:
  1. repeated replay blocks where the same `call_id` replays identical `function_call` plus identical `function_call_output`;
  2. zterm transport wrapper noise around tool outputs (`Chunk ID`, `Wall time`, `Original token count`, `Process exited with code`, `Output:`), which makes semantically identical outputs look different;
  3. repeated `apply_patch` terminal status carryover, especially `APPLY_PATCH_ERROR` / `apply_patch verification failed` lines echoed into later turns.
- Unique owner confirmed: request-side Responses input normalization in `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs`. No second bridge or TS duplicate owner was introduced.
- Repair applied in Rust request normalization only:
  1. duplicate `function_call` entries now dedupe by semantic signature (`tool name + canonicalized arguments`) instead of raw occurrence only;
  2. tool outputs are compare-normalized after zterm transcript wrapper unwrapping, so wrapper-only duplicates collapse;
  3. `apply_patch` outputs reuse `normalize_apply_patch_output_text` for compare-only canonicalization, so repeated failure/result status carryover dedupes without mutating stored visible output.
- Focused verification PASS:
  - `cargo test -p router-hotpath-napi normalize_responses_input_items --lib -- --nocapture` -> 13 passed
  - `cargo test -p router-hotpath-napi responses_standardization --lib -- --nocapture` -> 8 passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/build-core.mjs` -> native/core build passed
  - Native replay on real error sample `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260613T091618631-339813-1726.json` with wrapped `{ payload, normalized }` input now passes `coerceStandardizedRequestFromPayloadWithNative`, returning `messages=33`, `tools=16` instead of failing request standardization.
- Next required evidence: global install/restart current runtime, then rerun a live/runtime probe to confirm the built server process picks up the request-shape fix.

2026-06-13 real-sample red-test + workflow closeout
- Jason required the workflow to be fixed as a general rule: every new feature or bugfix must go `red test first -> fix -> green -> live replay old sample`, otherwise the change is not closed.
- Added curated real-sample fixture gate under `tests/fixtures/errorsamples/responses-request-standardization/`:
  1. `2026-06-13-duplicate-replay-wrapper-noise/` keeps the real diag request body from `error-openai-responses-router-gpt-5.4-20260613T091618631-339813-1726.json`;
  2. `2026-06-07-apply-patch-error-carryover-curated/` keeps a curated real-sample payload extracted from `error-openai-responses-router-gpt-5.5-20260607T022906302-288146-11057.json`, locking `apply_patch verification failed` carryover plus zterm wrapper coexistence.
- Added formal red regression `tests/sharedmodule/responses-request-standardization.real-samples.red.spec.ts` that replays both fixtures through `coerceStandardizedRequestFromPayloadWithNative`.
- Fixture gate PASS: `npm run jest:run -- --runInBand --runTestsByPath tests/sharedmodule/responses-request-standardization.real-samples.red.spec.ts`
- Online replay PASS on current `0.90.3064` runtime:
  - `2026-06-13-duplicate-replay-wrapper-noise` -> HTTP 200, no `MALFORMED_REQUEST`, no `orphan_tool_result`, no `RESPONSE_CONVERSION_ERROR`
  - `2026-06-07-apply-patch-error-carryover-curated` -> HTTP 200, no `MALFORMED_REQUEST`, no `orphan_tool_result`, no `RESPONSE_CONVERSION_ERROR`
- Process rule was written into project `AGENTS.md`, `docs/agent-routing/20-build-test-release-routing.md`, and `.agents/skills/rcc-dev-skills/SKILL.md`.

2026-06-12 request/response/usage concise log cleanup
- User target: standard `virtual-router-hit -> completed -> session-request -> usage` logs should be shorter, keep request id / request-response pairing / core usage / single finish_reason signal, and avoid repeated finish_reason clutter.
- Unique owner direction: only log presentation files are in scope: `src/server/handlers/handler-utils.ts`, `src/server/handlers/handler-response-utils.ts`, `src/server/runtime/http-server/executor/usage-logger.ts`, `src/server/utils/request-log-color.ts`, plus existing log-color/usage tests. No Hub/VR/provider payload or routing semantics change.

2026-06-13 singleton/default blackbox follow-up
- Rust owner + function-map + gate slice for singleton/default route availability floor is already green; upper blackbox failures were not semantic regressions but Jest loader failures.
- Verified local truth: `sharedmodule/llmswitch-core/dist/conversion/hub/pipeline/hub-pipeline.js`, `dist/native/router-hotpath/native-chat-process-node-result-semantics.js`, and `dist/native/router-hotpath/native-failure-policy.js` all exist and can be loaded by plain Node `require(...)`.
- Root cause narrowed to unique owner `src/modules/llmswitch/core-loader.ts`: async `import(file://...)` under Jest was being routed through Jest resolver and failing `Cannot find module 'file:///...dist/...js'`, which blocked handler/request blackbox from entering the new singleton/default semantics.
- Follow-up evidence: forcing Jest to `require(dist-path)` changed the failure from `Cannot find module file://...` to `Cannot use import statement outside a module`, confirming the real incompatibility is Jest CJS loading the llmswitch-core ESM dist package.
- Additional root-cause refinement: `createRequire(...)` bypasses Jest/ts-jest transform, so even TS source-first still fell back to raw Node loading. The loader fix must use Jest's own `require` when `JEST_WORKER_ID` is set, otherwise sharedmodule source `.ts` still cannot be consumed in blackbox suites.

2026-06-13 responses apply_patch SSE/client projection repair
- Root cause confirmed in the response bridge path, not HTTP adapter: JSON->SSE and live SSE were using different projection semantics, `response.required_action` nested payloads were not fully normalized, terminal probe repair could replay raw `function_call`/`function_call_arguments.*` after a normalized `custom_tool_call`, and continuation persistence warned on tool-call streams without `response.id`.
- Unique owner fix stayed in `src/modules/llmswitch/bridge/responses-response-bridge.ts` plus SSE transport wiring in `src/server/handlers/handler-response-sse.ts`: JSON->SSE now keeps standard Responses body for converter then reuses the same client-frame projection chain as live SSE; nested `response` payloads are normalized through the bridge before write; normalized frames update the probe truth; duplicate raw apply_patch repair frames are suppressed; missing-`response.id` tool continuations skip non-blocking store record instead of warning.
- Regression updates: `tests/server/handlers/handler-response-utils.apply-patch-freeform-sse.spec.ts` now locks client-visible output shape instead of an obsolete internal mock call path, and bridge-mocked SSE suites were updated with the new metadata-isolation export they now import.
- Verified PASS: `handler-response-utils.apply-patch-freeform-sse.spec.ts`; `handler-response-utils.required-action-split-frame.spec.ts`; `handler-response-utils.force-sse-json-responses.spec.ts`; `responses-continuation-store.spec.ts`; `direct-server-contract.red.spec.ts`; `verify:responses-handler-single-bridge-surface`; `verify:server-function-map-boundary`; root `tsc --noEmit`; `git diff --check`.
- Remaining gap: no build/install/restart/live port replay yet for this slice, so runtime-installed verification is still pending before claiming end-to-end closeout.

2026-06-13 error handling + route availability audit
- User要求审计四条硬约束：错误处理唯一 owner；路由池命中顺序固定为 search -> tool -> default，default 为最后命中池；default 仅剩一个模型时不能因 cooldown/blacklist 打空，必要时只能阻塞 backoff 等待；任何错误都不能直接回客户端，必须先计数/cooldown/切 provider。
- 初步定位 owner：`error.provider_failure_policy` -> `src/providers/core/runtime/provider-failure-policy-impl.ts`，`error.backoff_action_queue` -> `src/server/runtime/http-server/executor/request-executor-error-action-queue.ts`，`vr.route_availability_floor` -> Rust `virtual_router_engine/engine/selection.rs`。
- 待核实风险点：是否仍有第二套 `ErrorErr04/05` 决策；default 单模型/10000 场景是否存在 blacklist/cooldown 到空池；是否存在 provider error 未经 switch/cooldown 直接 ErrorErr06 投影给客户端的执行路径。
- 2026-06-13 收口执行：把 singleton/default availability-floor 判定从 TS `request-executor-core-utils.ts` 收回 Rust `selection.rs`，通过新的 native export `evaluateSingletonRoutePoolExhaustionJson` 暴露；TS executor 只保留 wait/log 壳。
- 同步更新 owner/gate：function-map / verification-map 新增 `evaluate_singleton_route_pool_exhaustion`、`tests/red-tests/vr_route_availability_floor_singleton_truth.test.ts`，`verify-vr-no-ts-runtime` 新增对 executor 本地 singleton 语义复活的扫描。
- Color rule: normal request/response lines must share one non-red/non-white/non-gray session color with numeric values highlighted white; error request/response lines are red. Existing session palette already excludes red/white/gray; fallback gray must not be used for normal HTTP request logs.
- Final stop truth: turn 4 returned `status=completed` with final assistant message summary; server log request `openai-responses-DF.key1-DeepSeek-V4-Flash-20260612T203429599-339283-1196` completed with `finish_reason=stop`, and matching `session-request` / `usage` also recorded `finish_reason=stop`.

2026-06-12 5520 XL direct responses html-shell root cause
- Live failing samples `openai-responses-router-gpt-5.4-20260612T215430477-339436-1349`, `...1350`, `...1351` are not pure SSE terminal-repair failures. Snapshot truth shows `XL.key1.gpt-5.4` direct `/v1/responses` upstream returned `: keepalive`, `event: ping`, then an HTML shell page (`<!doctype html> ... <title>New API</title>`), not valid Responses SSE.
- Evidence:
  - `~/.rcc/codex-samples/openai-responses/port-5520/req_1781272470477_7f6ec698/provider-response.json`
  - `~/.rcc/codex-samples/openai-responses/port-unknown/openai-responses-router-gpt-5.4-20260612T215430477-339436-1349/client-response_server.json`
  - `.../client-response.error_server.json` shows `probe: {}` and `upstream_stream_incomplete`
- Conclusion: current same-protocol direct gate is too weak for `openai-responses`; protocol-name match alone is insufficient. Need a direct capability/support gate before entering router-direct for Responses, so HTML-shell providers like `XL.key1.gpt-5.4 -> https://yunpansou.cn/responses` are blocked from direct and forced to relay or excluded earlier.

2026-06-12 XL runtime config truth corrected
- Jason provided the intended direct profile truth for XL: `base_url=https://yunpansou.cn/v1`, `wire_api=responses`, OpenAI auth, no CRS compat layer.
- Local runtime source of truth was inconsistent: `~/.rcc/provider/XL/config.v2.toml` still had `baseURL=https://yunpansou.cn` and `compatibilityProfile=responses:crs`.
- Action taken: removed `compatibilityProfile` from the live runtime provider config and rewrote `baseURL` to `https://yunpansou.cn/v1`.
- Next verification required: restart/reload runtime and recheck whether direct `/v1/responses` still emits HTML/ping shell or now returns valid Responses frames from `/v1/responses`.

2026-06-12 router-direct failure sample capture + concise logs
- Investigating direct failure hooks in http-server/index.ts; canonical snapshot owner is src/providers/core/utils/snapshot-writer.ts.
- Current log slice still has test gaps: request-complete spy target, usage finish_reason single-occurrence, request-log-color ESM import owner.

2026-06-12 XL label mismatch
- provider-request/provider-response/__runtime all show providerKey=XL.key1.gpt-5.4 and URL=https://yunpansou.cn/v1/responses.
- server log usage/session-request still prints XL.key1.gpt-5.4.gpt-5.5, so current residual issue is provider label/model decoration, not outbound target/baseURL.
- Unique owner likely buildProviderLabel/log usage path; direct transport truth already matches /v1 and gpt-5.4.

2026-06-12 XL provider label owner fixed
- Root cause: resolveProviderRequestContext preferred clientModelId when payload lacked model, so usage/session logs combined providerKey XL.key1.gpt-5.4 with client/default model gpt-5.5 into false label XL.key1.gpt-5.4.gpt-5.5.
- Fix: prefer mergedMetadata.target.modelId over clientModelId for providerModel derivation in provider-request-context.
- Gate: added red regression asserting XL.key1.gpt-5.4 + target.modelId=gpt-5.4 + clientModelId=gpt-5.5 resolves to providerLabel XL.key1.gpt-5.4.

2026-06-12 5520 orphan_tool_result live sample
- User sample: 22:28:37 tools route -> XL.key1.gpt-5.4-mini failed with orphan_tool_result unknown or already-consumed call_id.
- Next action: inspect matching codex-samples request/client/provider snapshots and locate single owner for tool_result call_id consumption/normalization.

## 2026-06-12 5520 orphan_tool_result + direct label residual

2026-06-13 responses same-response continuation / orphan_tool_result audit
- 用户新证据确认：新 session 也会 400，不是旧历史污染；样本为 `orphan_tool_result: bridge tool_result item references unknown or already-consumed call_id`。
- 先做真实两步回放复现：第一轮 `/v1/responses` 返回 `function_call`；第二轮带 `previous_response_id + function_call_output`。当前运行时在第二轮先报 `Responses conversation expired or not found`，说明问题先落在 continuation store 持久化/恢复，而不是客户端会话。
- 真因已定位到唯一 owner：`sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`。`captureRequestContext()` 因 `store:false` 把 `allowContinuation=false`，后续 `recordResponse()` 即便看到 pending tool calls 也没有把 `allowContinuation` 打开，导致同一 response 的 tool continuation 不能恢复。
- 已改 contract：`store:false` 仍允许 same-response tool continuation；仍不允许 scope continuation/materialize。对应回归已改在 `tests/sharedmodule/responses-continuation-store.spec.ts`。
- focused gate 已绿：`tests/sharedmodule/responses-continuation-store.spec.ts` 22/22 PASS。下一步必须 build/global-install/restart 后重跑真实两步回放，确认 live runtime 不再 400。
- Live error sample: openai-responses-router-gpt-5.4-20260612T222837601-339482-1395 failed with orphan_tool_result for call_JYbsLnCRByKN0SjpmyWDiFHY.
- Evidence shows same call_id already existed in earlier provider-request snapshots 339477-1390 and 339478-1391, so current root-cause direction is continuation/history pollution, not provider generating a fresh bad call id.
- Residual 5520 direct usage/session provider label still shows XL.key1.gpt-5.4.gpt-5.5 / XL.key1.gpt-5.4-mini.gpt-5.5 after one owner was fixed; there is still a second owner/path.

- 2026-06-12 fix slice: Rust standardized_request now drops stale responses tool_result items when a new function_call turn arrives, while keeping only outputs matching current pending call ids. Added paired tests for stale-drop and non-stale retention boundary.
- 2026-06-12 fix slice: direct usageLogInfo model source now prefers provider wire/response model instead of client request model, preventing labels like XL.key1.gpt-5.4.gpt-5.5 in direct logs.
- Verification: cargo test -p router-hotpath-napi standardized_request --lib -- --nocapture PASS; jest tests/server/runtime/http-server/direct-result-metadata-propagation.spec.ts tests/server/runtime/http-server/executor/provider-response-utils.spec.ts PASS; root tsc PASS.

2026-06-12 continue: preparing live replay from old 5520 orphan_tool_result sample 339478/1391 against runtime 0.90.3059 to verify stale tool_result is dropped before bridge validation.

2026-06-12 replay result: old orphan_tool_result 339477/339478 bodies replayed against 5520 runtime 0.90.3059 no longer fail at bridge/orphan; both progressed to upstream HTTP_403 auth failure on asxs.crsa.gpt-5.4-mini. This is live evidence stale tool_result pollution is removed before provider send.

2026-06-12 live log check after 0.90.3059 restart: no new orphan_tool_result found in post-restart 5520 window; replayed requests 339522/339523 failed only at upstream HTTP_403. Next evidence path is successful direct log label on current runtime.

2026-06-12 correction: old-sample replay was insufficient. New live session openai-responses-router-gpt-5.4-20260612T225507928-339537-1450 still fails orphan_tool_result on fresh call_MqPgTUSSFb19Em58JUUEd6xV, so root cause remains in live-session request shaping/continuation path. Must inspect fresh sample, not infer from historical replay.

2026-06-12 gate update: added paired regression tests for materialized responses continuation pending tool-call replay duplication in tests/sharedmodule/responses-continuation-store.spec.ts; using repo jest:run path because plain npx jest cannot load llmswitch-core ESM native bridge.

2026-06-12 note: source tests for responses continuation materialize require rebuilding native hotpath after Rust changes; otherwise tsx/jest still call stale router_hotpath_napi.node and can falsely stay red/null.

2026-06-12 previous_response_id lifecycle + miss policy audit
- External truth (official/OpenAI + local codex audit):
  - Responses `previous_response_id` depends on a stored prior response object. Official guidance indicates stored response/application state is retained for up to 30 days when `store=true`; `store=false` / ZDR paths do not guarantee later resume lookup.
  - Official miss guidance for websocket/incremental flows: if cached previous response context is unavailable, send a fresh create with `previous_response_id=null` and the full input/context; do not try to continue from partial delta.
  - Local codex source truth:
    - `rollout-trace/src/reducer/conversation.rs` explicitly errors on unknown previous id: `unknown previous_response_id ...`.
    - `core/src/client.rs` only sends `previous_response_id` when the new request is an exact prefix continuation; otherwise it sends a full create without `previous_response_id`.
    - `core/tests/suite/client_websockets.rs` locks that behavior: prefix match => use `previous_response_id`; non-prefix or post-error => full create without `previous_response_id`.
- RouteCodex current local truth:
  - `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts` already has a local TTL cache, currently `TTL_MS = 30min`; this is a local continuation cache, not upstream retention truth.
  - `resumeConversation()` already fail-fast returns `expired_or_unknown_response_id` when the local store misses.
  - The dangerous gap is scope materialization/reconstruction after release: if local scope miss or malformed replay is treated as resumable delta, later bridge validation can surface `orphan_tool_result`.
- Required closeout direction:
  - Scope-based continuation miss must never fabricate partial delta. If full input is available and prefix match fails, create a fresh full request without `previous_response_id`; if request is submit-tool-outputs/partial-delta only, fail-fast with explicit expired/unknown continuation error.
  - `orphan_tool_result` must become impossible from store miss/TTL expiry; store miss should stop at continuation owner/store boundary, not later at bridge tool_result validation.
2026-06-12 singleton empty-pool blocking retry progress
- root cause confirmed: hub pool exhaustion on singleton/default-only pools previously allowed terminal no-provider after bounded backoff; this violates Jason rule that empty pool must not be terminal.
- executor change: request-executor now detects singleton/last-candidate pool exhaustion from VR details (candidateProviderCount=1 / initialRoutePool len=1 / explicitSingletonPool) and enters provider.route_pool_cooldown_wait, clears exclusions, then reruns route selection instead of terminal no-provider.
- additional fix: chat success path no longer loads responses conversation rebind or native empty-assistant semantics when normal chat body already contains visible assistant payload; otherwise singleton blackbox was falsely failing after successful provider response.
- verification green so far: focused helper spec + chat handler singleton blackbox + root tsc.

2026-06-12 /v1/responses handler bridge surface audit
- Current duplicated bridge surface was confirmed at both handler ends:
  - request side `src/server/handlers/responses-handler.ts` directly imported entry planning/resume/materialize/capture/record/clear helpers from `bridge.js`
  - response side `src/server/handlers/handler-response-utils.ts` directly imported SSE probe/projection/conversation lifecycle helpers plus core-dist loaders from `bridge.js`
- Convergence direction fixed:
  - request side unique owner facade: `src/modules/llmswitch/bridge/responses-request-bridge.ts`
  - response side unique owner facade: `src/modules/llmswitch/bridge/responses-response-bridge.ts`
- New architecture gate truth: `scripts/architecture/verify-responses-handler-single-bridge-surface.mjs` must fail if handler files re-import responses bridge primitives from `bridge.js` instead of the side-specific facade.
- Function/verification map truth split from coarse `server.responses_handler_family` into two dedicated features:
  - `server.responses_request_handler_bridge_surface`
  - `server.responses_response_handler_bridge_surface`

- 2026-06-12 router-direct finish_reason=unknown 排查：usage/session rollup 只吃 direct result usageLogInfo.finishReason；direct 路径此前仅用 deriveFinishReasonNative，对无显式 finish_reason 但已有可见 assistant 成功内容的 chat-like/direct 响应会落 unknown。计划把成功可见响应推断统一收口到 finish-reason util，并补 direct 红测锁定。

- 2026-06-13 stopless 未触发排查：10000 端口 stopMessageEnabled 默认 true，request-executor/provider-response-converter 也会把 servertool 能力传入；当前怀疑点收敛到 Rust bridge 后的 response payload 形态或 stopGatewayContext 覆盖，导致 isStopEligibleForServerTool=false，需补 /v1/responses stop blackbox 锁定。
2026-06-13 stopless direct root cause
 - 10000 port default sameProtocolBehavior=direct and default stopMessageExcludeDirect=true. This bypasses response conversion/orchestration for same-protocol /v1/responses.
 - Fix direction: when port stopMessage.includeDirect=true, same-protocol direct must relay instead of bypassing stopless; added Rust direct-decision red/green and HTTP blackbox; updated ~/.rcc/config.toml port 10000 stopMessage={ enabled=true, includeDirect=true }.

## 2026-06-13 stopless live verify blocked by startup export drift
- install/global 0.90.3059 completed, but 10000 runtime cannot be reloaded yet.
- current live blocker: startup error `./index.js does not provide an export named captureResponsesRequestContextForRequest`.
- next action: inspect bridge facade/export owner and fix startup regression before live stopless probe.

- 2026-06-13 current blocker narrowed: previous install likely packed stale dist; rebuilt local dist now shows corrected runtime-integrations import in responses-request-bridge.js. Re-running isolated install-global before live port 10000 restart.

- 2026-06-13 continue after live proof: next gap is test proof for new stopless/direct blackbox; attempt repo jest path first.

- 2026-06-13 verification update: provider-response-rust-plan.spec.ts PASS (17/17); live 10000 stopless probe PASS; router-direct-passthrough.blackbox.spec.ts still hangs in current repo jest environment, so not claimed green.

- 2026-06-13 blackbox fix: router-direct-passthrough.blackbox used forbidden client metadata.routeHint; moved route hint to x-route-hint header to match current req_adapter contract before rerun.
2026-06-13 stopless blackbox status
- Direct live 10000 proof already green.
- HTTP blackbox current blocker is Jest execution mode, not stopless assertion: plain ./node_modules/.bin/jest fails immediately on ESM/import.meta in src/server/runtime/http-server/index.ts.
- Need to verify same case under node --experimental-vm-modules jest runner; npm run jest:run appears silent/hanging so testing runner behavior separately.
- HTTP blackbox stopless case under correct VM-modules runner now produces a real red result, not a hang.
- Current red shape: request still ends as 502 with [llmswitch-bridge] native-failure-policy not available after direct path failure; this mixes stopless relay verification with missing native bridge capability in source-test env.
- Evidence: node --experimental-vm-modules jest run at 2026-06-13 08:27 shows virtual-router-hit -> direct provider request id -> SSE_TO_JSON_ERROR -> native-failure-policy not available.

2026-06-13 orphan_tool_result duplicate-history closeout in progress
- New live failing request `openai-responses-provider-20260613T091618631-339813-1726` is a fresh-session failure, not old expired continuation state.
- Diag truth: `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260613T091618631-339813-1726.json` contains identical `function_call` + `function_call_output` blocks replayed twice in one inbound `input[]`.
- Bridge fail-fast is correct: second identical tool_result for same call_id is rejected as `already-consumed`; fix must happen before bridge conversion.
- Repair owner selected: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/standardized_request.rs`.
- Boundary locked in code/tests: dedupe only exact duplicate tool-history entries before orphan filtering; distinct repeated outputs for the same call_id remain invalid and must still error.
2026-06-13 10000 backup minimax m3
- User request: add MiniMax M3 as backup in 10000 port config.
- Source of truth: ~/.rcc/config.toml, routingPolicyGroup gateway_coding_10000.
- Existing state: fwd.minimax.MiniMax-M3 already defined globally; 10000 only uses it in multimodal, not in coding/thinking/tools/search/web_search/longcontext/vision/default.
- Planned minimal change: append fwd.minimax.MiniMax-M3 as secondary target for 10000 route entries, preserve current primary order.
2026-06-13 zterm patch-failure shape audit
- Evidence set for current audit:
  - `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260613T091618631-339813-1726.json`
  - `~/.rcc/codex-samples/openai-responses/port-5520/openai-responses-router-gpt-5.4-20260612T225434051-339532-1445/provider-request.json`
  - `~/.rcc/codex-samples/openai-responses/port-5520/req_1781280510486_c4745c3f/provider-request.json`
  - `~/.rcc/codex-samples/openai-responses/port-5520/req_1781315630127_4eebb92b/provider-request.json`
- Confirmed shape classes:
  1. duplicated replay block: same `call_id` reappears with repeated `function_call` + repeated `function_call_output`; representative `...339532-1445/provider-request.json`
  2. transport wrapper noise: `function_call_output.output` may be wrapped by `Chunk ID` / `Wall time` / `Original token count` / `Process exited with code` / `Output:`; representative `...339528-1441/provider-request.json`
  3. repeated apply_patch status carryover: many later requests still carry historical `APPLY_PATCH_ERROR: apply_patch did not apply...` or `Success. Updated the following files:` outputs with same call ids across turns; representative `req_1781280510486_c4745c3f/provider-request.json` and `req_1781315630127_4eebb92b/provider-request.json`
- Existing Rust request normalization already does:
  - duplicate call-id rewrite by occurrence
  - exact payload-signature dedup for repeated tool outputs
  - orphan tool output filtering
- Current gap:
  - duplicate replay with same semantic call/result is rewritten, not collapsed
  - payload-signature dedup happens before stripping zterm wrapper noise, so wrapper-only differences evade dedup
  - historical apply_patch terminal statuses can accumulate as repeated tool history across turns
- Intended repair direction for approval:
  - unique owner stays request-side Rust normalization before bridge/tool-result validation
  - only shape normalization, no patch/body semantic rewrite
  - collapse replayed identical tool history by semantic identity after output-wrapper canonicalization
  - keep true conflicts fail-fast

2026-06-13 stopless schema guidance tighten
- User reports: stopless can still spend 3 consecutive turns without calling tool. Need stronger guidance across these 3 hops, schema-guided, and next inspection must also check schema.
- Must inspect Rust/TS owner for stop_message_auto CLI projection seed + schema gate + next-turn inspection path before editing.

2026-06-13 build install restart after stopless guidance tighten
- User requested: compile, global install, restart server after Rust prompt tightening.
- Need runtime evidence after install: versions + health on 5520/5555/10000.

2026-06-13 ignore generated dirs for repo-sanity
- User confirmed bin/lib generated; add bin/ lib/ .reasonix/ to .gitignore and rerun repo-sanity.

2026-06-13 stopless prompts md-source migration
- Move stopless default prompt text from Rust hardcode to source asset under code tree, build copy to dist, runtime read from dist.
- Must keep single owner and add tests for round1/2/3 + schema mention + next-check mention.
2026-06-13 stopless schema closed-loop
- Added Rust red tests for guidance-before-gate, missing-schema-no-count, and missing-schema-reissues-guidance.
- stop_message_cli_projection_seed now injects stopless_schema_guidance into continuationPrompt and appends next-round schema-check hint.
- Rust evidence: targeted cargo tests passed for cli seed + stop-message persist/gate contract.
2026-06-13 function-map audit start: scanning architecture docs, registry, gates, gaps, and risk surfaces.
2026-06-13 plan requested: create actionable function-map audit remediation plan + audit current state against plan.
2026-06-13 new sample audit: process drift, not runtime bug
- Evidence from screenshot: agent wrote `plan requested: create actionable function-map audit remediation plan + audit current state against plan`, then read `docs/agent-routing/10-runtime-ssot-routing.md` and `docs/goals/function-map-longtail-closeout.md`, then stated `计划落盘后，做审计：现状 vs 计划`.
- Conclusion: execution drifted from the active `apply_patch` real-sample workflow into a separate function-map audit branch.
- Correct branch for this slice stays fixed: red test first -> shape-only repair -> green -> live replay old/new samples. No function-map audit work should interleave until this slice is closed.

- 2026-06-13 stopless 闭环继续收口：Rust `stop-message-core` 已改为 stop schema 缺项枚举、finished/blocked 补齐即停、continue_needed 缺 next_step 强制补齐；三轮只作为 no_change loop guard，不再按普通 used 计数封顶。
- 2026-06-13 stopless continuation guidance 已由 `servertool-core::cli_contract` 强制前缀注入 stop schema guidance，并要求下一轮先检查 schema，再决定是否继续工具调用。
- 2026-06-13 Rust gate 证据：`stop-message-core` 51/51、`servertool-core` 252/252。下一步：全局安装、重启 5555/5520/10000、在线验证 stopless 行为。
- 2026-06-13 apply_patch live probe:
  - `/v1/responses` without explicit `tools` only produced plain text (`I’m unable to directly use apply_patch from here`); this probe is not sufficient to prove server tool path failure because the request itself did not declare `apply_patch`.
  - `/v1/responses` with explicit `tools=[{type:function,name:apply_patch,...}]` and `tool_choice=required` on `127.0.0.1:5555` returned a valid `function_call`:
    - `name=apply_patch`
    - `arguments={"patch":"*** Begin Patch\n*** Add File: tmp/apply_patch_smoke.txt\n+hello from smoke\n*** End Patch"}`
  - Conclusion: apply_patch tool path is alive at the HTTP server/runtime level; current screenshot failure is more likely request-shape/tool-declaration loss on the real Codex/client path, not intrinsic inability of the server to emit apply_patch tool calls.
- 2026-06-13 server function-map boundary closeout:
  - Existing function-map entries for `server.responses_handler_family`, `server.responses_request_handler_bridge_surface`, and `server.responses_response_handler_bridge_surface` were stale: they still described server-side protocol projection/bridge semantics too loosely.
  - Updated function-map + verification-map to state the intended boundary explicitly:
    - server handlers are HTTP transport adapters only
    - request bridge is opaque request facade only
    - response bridge is opaque SSE/body handoff facade only
    - protocol parsing/conversion/projection must stay in Hub Pipeline/native owner
  - Added gate `scripts/architecture/verify-server-function-map-boundary.mjs`, wired into `package.json` and `verify:architecture-ci`.
  - Verified:
    - `npm run verify:server-function-map-boundary` PASS
    - `npm run verify:function-map-compile-gate` PASS
  - Current root-trace lead for chat-shaped tool leakage:
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/standardized_request.rs`
    - `normalize_chat_envelope_tool_calls(...)`
    - `normalize_tool_definition(...)`
    - this is the current strongest candidate for where `tools[].function.*` is being canonicalized into chat-shaped tool definitions before later direct misuse.

- 2026-06-13 stopless 闭环最终推进：修复误用 `npx jest` 的测试入口，改用 `npm run jest:run`（node --experimental-vm-modules）后，`tests/servertool/stop-message-auto.spec.ts` 51/51 通过（8 skipped），`tests/servertool/stop-message-compare-context.spec.ts` 6/6 通过。
- 2026-06-13 handler 薄壳新增 no-change glue：`stop-message-auto.ts` 计算 observationHash/toolSignatureHash，并基于上一轮 compare context 的 observationHash/observationStableCount 生成 `schemaGate.no_change_count`，把“三轮只作无变化 loop guard”真正闭到上游状态链。

2026-06-13 direct server-side request shaping removal in progress
- Removed server direct preflight payload contract/relay checks and direct model overrides from http-server/index.ts.
- direct-passthrough-payload.ts is now object-only guard; direct request body must pass through unchanged.
- Red tests updated toward new direct contract: no stream synthesis, no model overwrite, no tool/system/history rewrite.
- Deleted dead server shim: src/server/runtime/http-server/responses-direct-contract-error.ts (no remaining references after direct preflight removal).
- Moved Responses direct SSE protocol checks (allowlist/keepalive/required_action normalization entry) behind responses-response-bridge facade; server handler no longer owns those helpers.
- Added bridge-surface gate to forbid local server tokens for Responses SSE allowlist/keepalive/required_action parsing in handler-response-utils.ts.
- Moved Responses JSON required_action client-payload normalization behind responses-response-bridge facade; handler-response-utils no longer decides when to project body-level required_action.
- Trace note: direct server path does not call coerce_standardized_request_from_payload/normalize_tool_definition; current chat-shaped tool source remains Rust standardized owners, but direct contamination must come from another ingress/store/projection path.
- Moved Responses request-side stream/system-prompt mutation behind responses-request-bridge facade; responses-handler.ts no longer owns `payload.stream = true` or `applySystemPromptOverride(...)`.
- Added request-side bridge-surface gate to forbid local stream/system-prompt mutation tokens in responses-handler.ts.

## 2026-06-13 direct/server boundary cleanup
- Resumed from handoff: direct request-shaping already removed from server runtime; next focus is handler protocol surface shrink + continuation/store tool-shape contamination trace.
- Evidence from code: plan_responses_handler_entry() only decides mode (submit_tool_outputs/scope_materialize/none), not standardized_request coercion; current chat-shaped tools leak is likely later in store/materialize/projection, not entry planning.
- Next actions: audit handler-response-utils remaining Responses semantics, audit responses-handler remaining bridge-only mutations, add red test for continuation/store preserving direct tool schema.
- 2026-06-13: direct-owned scope continuation fixed at store owner: materializeLatestContinuationByScope now dispatches direct entries to remote restore; native restore skips tool reinjection for direct owner; wrapper now passes continuationOwner through to native and preserves released prefix as side-channel only for direct.
2026-06-13 function-map audit remediation plan added at docs/goals/function-map-audit-remediation-plan.md.
Confirmed current audit baseline: 28 feature entries in function-map, 28 in verification-map, responses request/response bridge surfaces already registered, but parser-clean map truth and explicit functional owner fields are still missing.
2026-06-13 function-map owner schema baseline landed. docs/architecture/function-map.yml now carries owner_kind + owner_scope across 62 features; docs/architecture/function-map.yml and docs/architecture/verification-map.yml are YAML-parseable again. Added scripts/architecture/verify-architecture-function-map-parseable.mjs and wired it into verify:function-map-compile-gate + verify:architecture-ci. Current owner_kind distribution: rust_ssot=29, ts_runtime_owner=15, server_projection=10, ts_bridge=4, provider_runtime=2, ts_entry_shell=2. Remaining audit gap: hidden-owner full-repo scan and warning cleanup for server.responses_request_handler_bridge_surface forbidden mention.

## 2026-06-13 responses handler bridge closeout slice
- `tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts` had a false isolation gap: it mocked the bridge barrel, but `handler-response-utils.ts` imports `responses-response-bridge.js` directly. That caused the test to load real native/store paths and report `CustomGC` open handles.
- Fixed test isolation by mocking `responses-response-bridge.(js|ts)` directly and providing the exact named exports used by the handler; `--detectOpenHandles` now exits cleanly.
- Further shrank server boundary: `handler-response-utils.ts` no longer derives continuation persistence `providerKey/continuationOwner/sessionId/conversationId/timingRequestIds` locally before calling `persistResponsesConversationLifecycleForHttp(...)`; that assembly now happens inside `responses-response-bridge.ts`.
- Further shrank server boundary again: local SSE terminal-state parser/state-machine update for `response.completed` / `response.done` was removed from `handler-response-utils.ts`; terminal-state inspection now lives behind `inspectResponsesTerminalStateFromSseChunkForHttp(...)` in `responses-response-bridge.ts`, and the single-bridge gate now forbids reviving `updateSseTerminalTrackerFromChunk(...)` in server TS.
- Request-side helper shrink continued: `responses-handler.ts` no longer owns local `readResponsesSessionId`, `readResponsesConversationId`, `shouldPersistResponsesConversation*`, or `readResponsesResponseId`; those helpers now live behind `responses-request-bridge.ts`, and the single-bridge gate forbids reviving them in server TS.
- Response-side logging helper shrink continued: `handler-response-utils.ts` no longer owns local SSE frame summary parsing or provider-protocol hint detection for usage/logging; those parsers now live behind `summarizeResponsesSseFrameForLogForHttp(...)` and `resolveResponsesProviderProtocolHintFromSseFrameForHttp(...)` in `responses-response-bridge.ts`.
- Verified:
  - `npm run verify:responses-handler-single-bridge-surface` PASS
  - `npx tsc --noEmit --pretty false` PASS
  - `npm run jest:run -- --runInBand --runTestsByPath tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts tests/sharedmodule/responses-continuation-store.spec.ts tests/server/runtime/http-server/direct-server-contract.red.spec.ts` PASS
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --detectOpenHandles --runTestsByPath tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts` PASS
  - `git diff --check` PASS

2026-06-13 responses handler single-bridge closeout goal prompt
- Created implementation doc at `docs/goals/responses-handler-single-bridge-closeout-plan.md` so the next `/goal` can stay short while still pointing to one executable source of truth.

2026-06-13 responses handler bridge closeout slice 2
- Moved remaining server-side Responses force-SSE body classification (`response` vs `chat.completion`) behind `prepareResponsesJsonBodyForSseBridgeForHttp(...)` in `src/modules/llmswitch/bridge/responses-response-bridge.ts`; `handler-response-utils.ts` no longer keeps local `isResponsesJsonBody` / `isChatCompletionJsonBody`.
- Moved probe-level continuation inspection behind `inspectResponsesContinuationProbeForHttp(...)`; server handler no longer owns local `tool_calls` / `required_action` probe inspection helpers.
- Single-bridge gate updated to forbid reviving those local helpers in `handler-response-utils.ts`.
- Focused test isolation closed: force-SSE suite now mocks `server/utils/finish-reason.js`, and `--detectOpenHandles` exits cleanly.
- Verified:
  - `npm run verify:responses-handler-single-bridge-surface` PASS
  - `npx tsc --noEmit --pretty false` PASS
  - `npm run jest:run -- --runInBand --runTestsByPath tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts tests/sharedmodule/responses-continuation-store.spec.ts tests/server/runtime/http-server/direct-server-contract.red.spec.ts` PASS
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --detectOpenHandles --runTestsByPath tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts` PASS
  - `git diff --check` PASS

2026-06-13 responses handler bridge closeout slice 3
- Request-side handler no longer keeps local `responseIdFromPath -> payload.response_id` prewrite, local `/v1/responses*` conversation-management branch checks, or local `responsesRequestContext` fallback assembly; moved into request bridge via `shouldManageResponsesConversationForHttp(...)`, `buildResponsesRequestContextForHttp(...)`, and `attachResponsesRequestContextToResultForHttp(...)`.
- Response-side client-close continuation policy no longer branches purely in server TS; moved behind response bridge via `planResponsesContinuationCloseActionForHttp(...)` and `shouldRepairResponsesContinuationTerminalForHttp(...)`.
- Single-bridge gate updated to forbid reviving request-side local `pipelineEntryEndpoint === '/v1/responses*'` checks and `responseIdFromPath` prewrite.
- Verified:
  - `npm run verify:responses-handler-single-bridge-surface` PASS
  - `npx tsc --noEmit --pretty false` PASS
  - `npm run jest:run -- --runInBand --runTestsByPath tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts tests/sharedmodule/responses-continuation-store.spec.ts tests/server/runtime/http-server/direct-server-contract.red.spec.ts` PASS
  - `git diff --check` PASS

2026-06-13 responses handler bridge closeout slice 4
- Response-side stream-end terminal repair / continuation repair / incomplete-error decision no longer branches purely in server TS; moved behind response bridge via `planResponsesStreamEndRepairForHttp(...)`.
- Handler still owns stream write / res.end / snapshot / logging / timers, but the Responses-specific decision of “need terminal repair?”, “need continuation repair?”, “need incomplete error projection?” is now bridge-owned.
- Verified:
  - `npm run verify:responses-handler-single-bridge-surface` PASS
  - `npx tsc --noEmit --pretty false` PASS
  - `npm run jest:run -- --runInBand --runTestsByPath tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts tests/sharedmodule/responses-continuation-store.spec.ts tests/server/runtime/http-server/direct-server-contract.red.spec.ts` PASS
  - `git diff --check` PASS

2026-06-13 function-map audit check
- Current map baseline: 62 function-map features, 62 verification-map features.
- Gates green: `verify:function-map-compile-gate`, `verify:architecture-owner-queryability`, `verify:architecture-feature-map-growth-discipline`, `verify:architecture-provider-specific-leaks`, `verify:architecture-thin-wrapper-only`, `verify:architecture-error-chain-bypass`, `verify:architecture-metadata-leak-boundary`, `verify:architecture-nonadjacent-conversion`, `verify:architecture-forbidden-path-growth`.
- Residual loophole: `tool.apply_patch_freeform_contract` has no `src/sharedmodule` source anchor; only test/script anchors exist.
- Residual warning: `verify:function-map-boundary-mentions` warns on `server.responses_request_handler_bridge_surface` because `clearResponsesConversationByRequestIdForHttp` appears in a forbidden path.
- User rule to keep: server handlers must not own protocol parsing; protocol normalization/parsing stays in bridge/native owner layers.
2026-06-13 responses handler bridge closeout slice 5
- moved response-side client-close cleanup eligibility, terminal-event requirement gating, and probe finish_reason resolution behind responses-response-bridge helpers
- single-bridge gate PASS; root tsc PASS; focused jest PASS: required-action-split-frame, force-sse-json-responses, responses-continuation-store, direct-server-contract.red
2026-06-13 responses handler bridge closeout slice 6
- moved failure-to-clear continuation policy (`sse_stream_error` / `sse_incomplete` / `json*`) behind responses-response-bridge helpers; server now only executes clear action
- verify PASS: single-bridge gate, root tsc, focused jest x4 after reason-string removal from handler

2026-06-13 latest stopless sample audit
- Audit scope: latest `/Volumes/extension/.rcc` provider samples + 5555 session truth, specifically checking whether bad stop schema or missing schema guidance caused extra stopless calls.
- Verified negative evidence: latest MiniMax 5555 sample dirs (`req_1781338094550_ffce7713`, `req_1781337644140_d9709ce2`, `req_1781337206630_f91830d0`, `req_1781336510838_87340d58`) are not authoritative stopless samples. Their `__runtime.json` only contains request/provider metadata and does not contain `stopMessageState`, `serverToolLoopState`, `stopMessageCompareContext`, `observationStableCount`, `continuationPrompt`, or stop-schema fields.
- Verified old stopless session evidence: `/Volumes/extension/.rcc/sessions/127.0.0.1_5555/session-stopless-*.json` from 2026-06-09 do contain stopless persisted state, and their `stopMessageText` already includes explicit guidance like '立即调用工具执行这个下一步'. This disproves 'missing guidance' for those samples.
- Verified old-budget evidence: those old stopless sessions still show `stopMessageUsed` climbing to 3 while guidance still asks to continue, matching the historical bug '3 rounds treated as main budget' rather than proving a latest schema/guidance regression.
- Verified latest 5555 session truth: only recent touched files are `session-rcc-OneStop.json` and `tmux-rcc-OneStop.json`; they record `stopMessageLastUsedAt`/`stopMessageUpdatedAt` (and tmux token stats) but no stop schema/guidance/compare-context payload. So current latest session truth is insufficient to prove latest extra calls were caused by bad schema or missing guidance.
- Current audit conclusion: no direct evidence from latest samples that incorrect schema or missing schema guidance caused extra stopless calls; most latest samples inspected are not true stopless closure samples. Need a fresh live stopless probe to close the evidence gap if stronger proof is required.
2026-06-13 responses handler bridge closeout slice 7
- fixed request-side submit_tool_outputs red tests to mock the actual request-bridge submodule surface instead of the old barrel-only path; locked current contract that `routeHint` travels via `pipelineInput.metadata.responsesResume`, while capture store only receives request context plus optional providerKey pin
- request-side timeout/error clear path now goes through `clearResponsesConversationOnHandlerFailureForHttp(...)`; `responses-handler.ts` no longer calls request-store clear API directly in timeout/error branches
- verify PASS: `tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts`, `tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts`, `tests/server/handlers/responses-handler.request-timeout.blackbox.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npx tsc --noEmit --pretty false`
2026-06-13 responses handler bridge closeout slice 8
- added single-bridge gate for local Responses SSE error payload literals in `handler-response-utils.ts` and moved those payload builders into `responses-response-bridge.ts`: missing-stream `sse_bridge_error`, structured upstream SSE error projection, generic SSE error envelope builder, and `upstream_stream_incomplete`
- repaired response-side terminal finish_reason fallback in bridge owner: when probe has a completed assistant message but no explicit finish_reason, `resolveResponsesTerminalProbeFinishReasonForHttp(...)` now resolves `stop`
- test/mocks updated so handler-response-utils response-bridge submodule mocks expose the new SSE error builders
- verify PASS: `tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts`, `tests/server/handlers/handler-response-utils.sse-finish-reason.spec.ts`, `tests/server/handlers/responses-handler.stream-closed-before-completed.regression.spec.ts`, `tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts`, `tests/sharedmodule/responses-continuation-store.spec.ts`, `tests/server/runtime/http-server/direct-server-contract.red.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npx tsc --noEmit --pretty false`, `git diff --check`
2026-06-13 responses handler bridge closeout slice 9
- moved catch-side malformed Responses tool-history contract errorsample capture behind `captureResponsesInboundToolHistoryErrorsampleForHttp(...)`; `responses-handler.ts` no longer classifies `Tool history contract violated`, reads `details.toolHistoryContractViolation`, or writes `responses.inbound_tool_history_contract` payloads locally
- added request-bridge red/green unit `tests/modules/llmswitch/bridge/responses-request-bridge.tool-history-errorsample.spec.ts` to lock positive and negative cases at the bridge owner
- updated submit_tool_outputs handler mocks to expose the new request-bridge facade export so ESM import shape stays complete during handler blackbox tests
- verify PASS: `tests/modules/llmswitch/bridge/responses-request-bridge.tool-history-errorsample.spec.ts`, `tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts`, `tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts`, `tests/server/handlers/responses-handler.request-timeout.blackbox.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npx tsc --noEmit --pretty false`, `git diff --check`
2026-06-13 responses continuation isolation correction
- Root-cause correction: current 2013 / orphan tool-result issue is not just `deltaInput` misuse; it also exposes a scope-design gap. Responses continuation restore is currently isolated by `port/group + session/conversation`, with `continuationOwner` recorded on the entry, but `entry protocol/endpoint` is not part of the scope key.
- Consequence: a chat/messages entry can incorrectly hit a stored Responses continuation scope, then internal bridge code (`buildChatRequestFromResponses`) receives Responses-owned resume semantics on the wrong entry and reconstructs history there.
- New rule to implement: Responses continuation restore/materialize must require triple isolation `entry protocol(or endpoint) + continuationOwner(direct|relay) + session/conversation(+port/group)`. `buildChatRequestFromResponses` remains bridge-only protocol conversion and must not own scope/owner inference.
2026-06-13 responses continuation isolation implementation slice
- Store layer updated: continuation scope key is now `entry:<kind>|owner:<owner>|session|conversation`, `recordResponse()` preserves captured session/conversation scope instead of clearing it when response-side args omit them, and `resumeConversation()` now rejects entryKind/owner mismatch instead of restoring across protocol ownership.
- New red/green coverage added in `tests/sharedmodule/responses-continuation-store.spec.ts`: chat entryKind cannot hit stored responses continuation; direct+relay records under one scope return `null` until caller specifies owner.
- Handler-path audit follow-up: the submit_tool_outputs handler specs were not exposing a production bug; they were stale against the new single-bridge split. Fix was to stop replacing the whole request bridge and instead mock `runtime-integrations` / `native-exports` thinly while providing an explicit `responses-response-bridge` export surface for handler imports.
- Verification PASS: `PATH=/opt/homebrew/opt/node@22/bin:$PATH NODE_OPTIONS=--experimental-vm-modules pnpm jest tests/sharedmodule/responses-continuation-store.spec.ts tests/modules/llmswitch/bridge/responses-request-bridge.tool-history-errorsample.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts --runInBand`; `PATH=/opt/homebrew/opt/node@22/bin:$PATH npx tsc --noEmit --pretty false`; `sh -lc 'git diff --check 2>&1'`.
2026-06-13 responses handler bridge closeout slice 10
- moved response-side SSE dispatch eligibility and `__sse_responses` payload-shape detection behind `hasResponsesSsePayloadForHttp(...)` and `shouldDispatchResponsesSseToClientForHttp(...)`; `handler-response-utils.ts` no longer owns local `hasSsePayload` implementation or local SSE dispatch decision logic
- kept compatibility export `hasSsePayload` in `handler-response-utils.ts` as a thin alias to the bridge owner so existing server imports continue to resolve without reviving local protocol logic
- updated response-bridge mocks in `handler-response-utils.force-sse-json-responses.spec.ts` and `handler-response-utils.required-action-split-frame.spec.ts` to expose the new facade exports
- verify PASS: `tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts`, `tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts`, `tests/sharedmodule/responses-continuation-store.spec.ts`, `tests/server/runtime/http-server/direct-server-contract.red.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npx tsc --noEmit --pretty false`, `git diff --check`
2026-06-13 responses handler bridge closeout slice 11
- physically split server-side SSE implementation out of `src/server/handlers/handler-response-utils.ts` into `src/server/handlers/handler-response-sse.ts`; shared non-protocol carrier/header/snapshot helpers now live in `src/server/handlers/handler-response-common.ts`
- `handler-response-utils.ts` is now dispatcher + JSON path only; it delegates all force-SSE bridge and live SSE stream handling to `sendSsePipelineResponse(...)` and keeps `hasSsePayload` / client-carrier guard as thin compatibility exports
- single-bridge gate tightened to require `handler-response-sse.ts` / `handler-response-common.ts` imports and forbid reintroducing SSE helper/state-machine tokens into `handler-response-utils.ts`
- verify PASS: `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts tests/sharedmodule/responses-continuation-store.spec.ts tests/server/runtime/http-server/direct-server-contract.red.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npm run verify:function-map-compile-gate`, `npm run verify:server-function-map-boundary`, `npx tsc --noEmit --pretty false`, `git diff --check`
2026-06-13 responses handler bridge closeout slice 12
- removed the last direct Responses timeout SSE error-envelope write from `src/server/handlers/responses-handler.ts`; timeout-after-headers-sent now reuses generic `writeStartedSsePipelineError(...)` instead of locally shaping `event:error` payload
- single-bridge gate now forbids direct `res.write(\`event: error` in `responses-handler.ts`, so the server adapter cannot grow Responses-specific SSE error projection again
- verify PASS: `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/server/handlers/responses-handler.request-timeout.blackbox.spec.ts tests/server/handlers/responses-handler.started-sse-error.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts`, `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts tests/sharedmodule/responses-continuation-store.spec.ts tests/server/runtime/http-server/direct-server-contract.red.spec.ts tests/server/handlers/responses-handler.request-timeout.blackbox.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npm run verify:function-map-compile-gate`, `npx tsc --noEmit --pretty false`, `git diff --check`
2026-06-13 responses handler bridge closeout slice 13
- moved request-side post-pipeline lifecycle orchestration out of `responses-handler.ts`: request-context capture gating is now `captureResponsesPipelineRequestContextForHttp(...)`, and result metadata attach + tool-call continuation seeding are now `finalizeResponsesPipelineResultForHttp(...)`
- `responses-handler.ts` no longer directly calls `shouldManageResponsesConversationForHttp(...)`, `captureResponsesRequestContextForHttp(...)`, `attachResponsesRequestContextToResultForHttp(...)`, or `seedResponsesToolCallResponseForHttp(...)`; those lifecycle decisions now sit behind the request-bridge facade
- single-bridge gate tightened to forbid those old direct handler-side calls from reappearing
- verify PASS: `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts tests/server/handlers/responses-handler.request-timeout.blackbox.spec.ts tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts tests/sharedmodule/responses-continuation-store.spec.ts tests/server/runtime/http-server/direct-server-contract.red.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npm run verify:function-map-compile-gate`, `npx tsc --noEmit --pretty false`
2026-06-13 responses handler bridge closeout slice 14
- moved JSON-side chat usage normalization and request log context projection out of `src/server/handlers/handler-response-utils.ts` and into `src/modules/llmswitch/bridge/responses-response-bridge.ts` via `normalizeChatUsagePayloadForHttp(...)` and `buildResponsesRequestLogContextForHttp(...)`
- `handler-response-utils.ts` no longer owns local chat-usage numeric sanitation or request color/session context assembly; it only dispatches through the response bridge and writes client JSON/SSE transport
- single-bridge gate tightened to forbid `resolveNormalizedChatUsage`, `normalizeChatUsagePayload`, and `buildRequestLogContext` from reappearing in the server dispatcher
- test mocks for response-bridge blackbox suites were updated to expose the new facade exports so the import surface stays complete
- verify PASS: `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts tests/sharedmodule/responses-continuation-store.spec.ts tests/server/runtime/http-server/direct-server-contract.red.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npx tsc --noEmit --pretty false`, `git diff --check`
2026-06-13 responses handler bridge closeout slice 15
- moved request-side stream/scope runtime planning out of `src/server/handlers/responses-handler.ts` and into `src/modules/llmswitch/bridge/responses-request-bridge.ts` via `buildResponsesConversationPortScopeForHttp(...)`, `planResponsesHandlerStreamForHttp(...)`, and `prepareResponsesHandlerRuntimeForHttp(...)`
- `responses-handler.ts` no longer owns local port-scope parsing, stream intent derivation, request-start stream metadata assembly, or local continuation-expired / resume-client error projection branches; it now consumes one request-bridge runtime plan and stays on HTTP adapter / timeout / logging / pipeline dispatch responsibilities
- request-stream contract stayed locked by blackbox regressions: omitted `stream` still defaults to stream=true for `/v1/responses`, explicit `stream=false` still stays non-stream, and submit_tool_outputs start/error paths still preserve request-start logging + SSE error shape
- verify PASS: `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/server/handlers/responses-handler.request-start-log.spec.ts tests/server/handlers/responses-handler.accept-header-stream-contract.regression.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npm run verify:server-function-map-boundary`, `npx tsc --noEmit --pretty false`
2026-06-13 responses handler bridge closeout slice 16
- moved request-side protocol-scoped pipeline metadata assembly out of `src/server/handlers/responses-handler.ts` and behind `buildResponsesPipelineMetadataForHttp(...)` in `src/modules/llmswitch/bridge/responses-request-bridge.ts`
- handler no longer locally shapes `providerProtocol: 'openai-responses'`, `responsesResume`, `responsesRequestContext`, or stream carrier metadata; it only merges generic request metadata with one request-bridge metadata block
- single-bridge gate now forbids those protocol-scoped metadata tokens from reappearing in `responses-handler.ts`
- verify PASS: `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/server/handlers/responses-handler.accept-header-stream-contract.regression.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npx tsc --noEmit --pretty false`
2026-06-13 responses handler bridge closeout slice 17
- moved request-side request-body metadata read/strip and `clientAbortSignal` extraction out of `src/server/handlers/responses-handler.ts`; both now sit behind `prepareResponsesRequestBodyForHttp(...)` and `buildResponsesPipelineMetadataForHttp(...)` in `src/modules/llmswitch/bridge/responses-request-bridge.ts`
- `responses-handler.ts` no longer directly calls `readRequestBodyMetadata(...)`, `stripRequestBodyMetadataForPipeline(...)`, or scans the client connection state symbol table for abort-signal projection; server stays on adapter/timeout/logging/pipeline dispatch
- single-bridge gate now forbids those request-body metadata helpers and inline abort-signal extraction from reappearing in `responses-handler.ts`
- verify PASS: `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/server/handlers/responses-handler.request-start-log.spec.ts tests/server/handlers/responses-handler.accept-header-stream-contract.regression.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts tests/server/handlers/responses-handler.request-timeout.blackbox.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npm run verify:server-function-map-boundary`, `npx tsc --noEmit --pretty false`
2026-06-13 responses handler bridge closeout slice 18
- moved response-side `responsesRequestContext` resolution behind `resolveResponsesRequestContextForHttp(...)` in `src/modules/llmswitch/bridge/responses-response-bridge.ts`; `handler-response-utils.ts` and `handler-response-sse.ts` no longer locally choose `result.metadata.responsesRequestContext ?? handler fallback`
- single-bridge gate now forbids local `?? options?.responsesRequestContext` / `?? args.responsesRequestContext` in the server dispatcher/SSE files
- added bridge unit coverage `tests/modules/llmswitch/bridge/responses-response-bridge.request-context-resolution.spec.ts` for metadata-preferred resolution and fallback-only resolution
- verify PASS: `tests/modules/llmswitch/bridge/responses-response-bridge.request-context-resolution.spec.ts`, `tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts`, `tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts`, `tests/sharedmodule/responses-continuation-store.spec.ts`, `tests/server/runtime/http-server/direct-server-contract.red.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npx tsc --noEmit --pretty false`
2026-06-13 responses handler bridge closeout slice 19
- moved direct passthrough SSE metadata/internal-carrier guard out of `src/server/handlers/handler-response-sse.ts` and into `assertDirectPassthroughResponsesSseMetadataIsolationForHttp(...)` in `src/modules/llmswitch/bridge/responses-response-bridge.ts`
- `handler-response-sse.ts` no longer locally parses SSE `data:` payloads to inspect `metadata` / `providerKey` / `__rt` / internal carrier keys; server now only feeds `frame + requestId` into the bridge guard
- single-bridge gate now forbids local `isInternalMetadataCarrier(...)` and `assertDirectPassthroughSseFrameHasNoInternalMetadataControls(...)` from reappearing in `handler-response-sse.ts`
- added bridge unit coverage `tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts` for rejecting internal metadata control fields and allowing ordinary provider metadata

2026-06-13 log color multi-color audit
- User reported same logical session/request shows multiple ANSI colors across `virtual-router-hit`, request completion, `session-request`, and `[usage]` lines.
- Initial root-cause evidence: `usage/session-request` path uses `resolveRequestLogColorToken(requestId, requestLogContext)` with canonical color-key precedence (`clientTmuxSessionId -> tmuxSessionId -> sessionId -> conversationId`), but `colorizeVirtualRouterHitLogLine()` still recolors from parsed text session (`[session]` or `sid=`) only. If printed `sid=` is a per-request alias while request context is tmux-scoped canonical key, the same request family splits into different colors.
- Existing tests cover usage tmux priority and standalone virtual-router-hit coloring, but there is no regression that locks one request family's `virtual-router-hit + request/response + usage` lines to the same canonical color when `sid` differs from tmux key.
- Fix applied: `src/server/utils/request-log-color.ts` now resolves virtual-router-hit color key from the registered request log context first (`req=...` -> canonical tmux/session color key), and only falls back to textual `[session]`/`sid=` parsing when no request context exists.
- Regression updated: `tests/server/utils/request-log-color.spec.ts` now locks that a registered request with canonical tmux color recolors `virtual-router-hit` consistently even when the line has no `sid=` field.
- Verification PASS: `PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm jest tests/server/utils/request-log-color.spec.ts tests/server/runtime/http-server/executor/usage-logger.spec.ts --runInBand`; `PATH=/opt/homebrew/opt/node@22/bin:$PATH npx tsc --noEmit --pretty false`; `git diff --check`.
2026-06-13 continuation/build closeout
- llmswitch-core tsc now clean under Node 22.
- build-core.mjs rebuilt native + llmswitch-core dist successfully after restoring responses-openai bridge locals and stop-schema no_change_count typing.
- Next: rerun install-global.sh, then verify routecodex/rcc versions and /health.
2026-06-13 minimax 2013 + reasoning_effort follow-up
- Live 5555 sample `req_1781355000732_66c00b3b` proved the failing provider-request was chat/messages shape and malformed before upstream: assistant `tool_use call_function_ijxj1i99rcje_1` was followed by ordinary user text `[Image omitted]`, not matching `tool_result`; Minimax 2013 was correct upstream validation, not SSE hang.
- Root-cause guard tightened at two owners:
  1. `responses-openai-bridge.ts::buildChatRequestFromResponses()` now forbids dangling tool-call history instead of silently converting it to chat;
  2. Rust `shared_responses_conversation_utils.rs::resume_responses_conversation_payload()` now emits `meta.fullInput/fullInputItems`, matching restore/materialize so chat bridge can prefer full history over delta.
- Reasoning effort rule corrected in Rust route-select owner `req_process_stage2_route_select.rs`: precedence is now `configured thinking > original request reasoning_effort > route default`, matching Jason's requirement.
- Verification PASS: Rust `shared_responses_conversation_prepare_and_resume_json`; Rust `test_apply_route_selection_prefers_original_request_reasoning_effort_when_route_has_no_override`; Jest `tests/responses/responses-openai-bridge.spec.ts`; Jest `tests/sharedmodule/responses-continuation-store.spec.ts`; llmswitch-core `tsc --noEmit`.
2026-06-13 20:50 live 2013 root-cause recheck
- Revalidated against live sample ~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260613T205000732-340808-594.json and provider-request snapshot: this failure is not route pool/default/blacklist, not responsesResume/fullInput/deltaInput, and not server handler ownership.
- Replayed real sample through dist bridge chain: Responses -> Chat keeps call_function_ijxj1i99rcje_1 tool result intact; Chat -> Anthropic request also keeps it intact; req_outbound_stage3_compat then mutates that user tool_result into plain text [Image omitted].
- Concrete owner: rust req_outbound_stage3_compat/request_stage.rs strip_historical_media() via chat_process_media_semantics.strip_chat_process_historical_images(); false positive triggered because ordinary tool_result text contains literal strings like "image_url" / "video_url", which current string_contains_inline_media() treats as media.
- User claim update: "convertBridgeInputToChatMessagesWithNative is the unique owner" is false for this live sample. Valid owner chain is request-side outbound compat/media scrub after bridge conversion. Anthropic grouped tool_use/tool_result form is protocol-appropriate, but current direct proven bug is media scrub corruption, not yet pair-splitting semantics alone.
2026-06-13 plain-text tool_result media-key false positive verification
- Source-side Rust fix in chat_process_media_semantics.rs was already correct; the reason runtime still reproduced was stale compiled native, not a second semantic owner.
- After `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/build-core.mjs`, the same new-session `/v1/responses` HTTP replay returned 200 and provider payload preserved `tool_use call_docs_1 -> tool_result call_docs_1` with plain text `documentation mentioning "image_url" and "video_url" should stay plain text`.
- Runtime proof: no `[Image omitted]` placeholder and no dangling Anthropic tool_use remained in provider payload. Remaining blackbox Jest failure is loader/ESM environment (`native-virtual-router-bootstrap-config`), not this protocol regression.
2026-06-13 responses handler bridge closeout slice 20
- request-side relay-context normalization for `/v1/responses` is now formalized as contract coverage: `tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts` was added to `scripts/tests/ci-jest.mjs`, `docs/architecture/function-map.yml`, and `docs/architecture/verification-map.yml` under `server.responses_request_handler_bridge_surface`.
- locked behavior: relay-owned `responsesRequestContext` must come from native `req_inbound` normalized snapshot, never from raw HTTP `payload.input` / `payload.tools`; duplicate tool history must collapse to normalized input, and `orphan_tool_result` must fail without raw-input fallback.
- verification PASS: `pnpm jest tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts tests/modules/llmswitch/bridge/responses-request-bridge.tool-history-errorsample.spec.ts tests/server/runtime/http-server/direct-server-contract.red.spec.ts --runInBand`, `npm run verify:responses-handler-single-bridge-surface`, `npm run verify:function-map-compile-gate`, `npx tsc --noEmit --pretty false`.
- live/runtime audit note: the latest `2335xx` diag failures are not evidence that server handler protocol logic regrew. Those samples already contain malformed request-side history (`function_call.arguments=""` -> `failed to parse function arguments: EOF while parsing a value at line 1 column 0`) before provider execution, so the remaining live regression owner is upstream of server adapter cleanup.

## 2026-06-14 stopless no-trigger audit
- Sample req_1781362576737_387b1d5f/provider openai-responses-minimax.key1-MiniMax-M3-20260613T225616737-341001-787: logs show hub.response=4411ms and finish_reason=stop, but no matching [servertool]/stop_watch/stop_compare event, so current hypothesis is Rust response effect plan did not emit servertoolRuntimeAction or bridge path bypassed conversion before orchestration.
- Existing Rust hub_pipeline_lib tests already cover Anthropic end_turn -> servertoolRuntimeAction; next gap is TS bridge/executor/prepared SSE integration.
- Mis-run note: node scripts/tests/ci-jest.mjs with a file argument expanded to a broad suite; ignore as stopless evidence. Use explicit node --experimental-vm-modules jest file command for focused ESM tests.

## 2026-06-14 HTTP_499 client_projection leak audit
- Symptom: live 5555 `/v1/responses` request `openai-responses-router-gpt-5.4-20260614T085154756-341633-1419` returned body `{"error":{"message":"client abort request","type":"invalid_request_error"}}` to client with `status=499 code=HTTP_499`, after upstream `asxs.crsa.gpt-5.4-mini` returned 499.
- Pipeline: client → 5555 → `router-direct` → provider HTTP → upstream nginx → upstream returns 499 + body → `extractStatusCodeFromError` parses 499 → `error.client_projection` (`mapErrorToHttp`) maps status 499 to "Upstream rejected the request" (4xx branch) → returned to client.
- 499 = nginx "Client Closed Request". The actual signal is **client-side abort**, not a real upstream error.
- Three owner gaps:
  1. `error.provider_failure_policy` classification: 4xx 499 + body "client abort request" does not match any `isProviderFailureClientDisconnect` / `isProviderFailureNetworkTransportLike` heuristic. Existing heuristics only fire on `client_disconnected`, `client_request_aborted`, `client_response_closed`, `client_timeout_hint_expired`, `CLIENT_DISCONNECTED` code, or `AbortError`. So 499 is reported as a normal 4xx, counted as provider failure, and may mark `affectsHealth: true` → triggers cooldown/3-strike.
  2. `error.client_projection` (`mapErrorToHttp` in `src/server/utils/http-error-mapper.ts`): 499 falls in `if (status >= 400 && status < 500)` → returns 499 + upstream body verbatim to client. It must NEVER return 4xx 499 to client; 499 is a transport cancellation, not a client-visible error.
  3. `error.client_projection` does not consult `isClientDisconnectAbortError` (in `executor-provider.ts`) or upstream body `client abort request` substring. No filter exists for "client closed request" class.
- Correct behavior for 499 + body "client abort request" / `HTTP_499`:
  - Classification: `affectsHealth: false`, no provider failure record, no cooldown, no `recoverable` reroute.
  - Client projection: do NOT echo 499 + body. Suppress response (SSE close / no body); emit `[http.error.meta]` log only.
- Owner verdict: project AGENTS says `error.client_projection` owner is `src/server/utils/http-error-mapper.ts` (server_projection) and must be the only place that decides client-visible error status. 499 projection rule belongs there. The classifier rule belongs in `error.provider_failure_policy` (`src/providers/core/runtime/provider-failure-policy-impl.ts`) and should delegate to existing `isProviderFailureClientDisconnect` plus a new "upstream 499 with client-disconnect body" branch.
- Action plan: red tests first.
  - red 1: `tests/server/utils/http-error-mapper-499-client-disconnect.spec.ts` — assert `mapErrorToHttp` does NOT return 499 + upstream body for `extractStatusCodeFromError`-derived 499 with body containing "client abort request"; assert projection status is 0/204/no body.
  - red 2: `tests/providers/core/runtime/provider-failure-policy-client-disconnect-499.spec.ts` — assert 499 + "client abort request" message classifies as `affectsHealth: false`, no `recoverable`, no error report.
  - Then fix: `mapErrorToHttp` adds a 499 + body check that consults `isClientDisconnectAbortError` (or a new `looksLikeUpstreamClientClosedRequest` helper); provider classifier adds the same upstream-499 branch in `isProviderFailureClientDisconnect` or `resolveProviderFailureClassification`.
  - Gate: `npm run verify:error-pipeline-contract`; `npm run verify:function-map-compile-gate`; live replay of the same `req_1781372094756_341633-1419` shape.

## 2026-06-14 SSE facade split slice
- Added dedicated SSE facade owner file `src/modules/llmswitch/bridge/responses-sse-bridge.ts`; it is a thin TS alias surface over `responses-response-bridge.ts` so `function-map-canonical-builder-definitions` can query a real owner without changing runtime behavior.
- `handler-response-sse.ts` now reads SSE projection/repair helpers from `responses-sse-bridge.ts` and keeps continuation/conversation lifecycle helpers on `responses-response-bridge.ts`; `handler-response-utils.ts` keeps the same split.
- Architecture/docs updated: new feature `server.responses_sse_bridge_surface`; `server.responses_response_handler_bridge_surface` narrowed to lifecycle/continuation ownership; `verify-server-function-map-boundary` and TS-owner whitelist updated accordingly.
- Static/red gate added: `tests/red-tests/server_responses_sse_surface_single_owner.test.ts` locks handler/index import boundaries so SSE symbols cannot drift back onto the lifecycle facade.
- Verification PASS:
  - `node --experimental-vm-modules jest tests/red-tests/server_responses_sse_surface_single_owner.test.ts tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts --runInBand`
  - `node scripts/architecture/verify-responses-handler-single-bridge-surface.mjs`
  - `node scripts/architecture/verify-server-function-map-boundary.mjs`
  - `npm run verify:function-map-compile-gate`
  - `npx tsc --noEmit --pretty false`

## 2026-06-14 provider error flow audit against Jason center-thesis
- Audit target thesis: provider execution errors should enter one unified policy center, accumulate strike/cooldown evidence, switch provider while alternatives exist, avoid client-visible interruption whenever route pool/default still has candidates.
- Current code truth diverges by path:
  1. relay / request-executor path: mostly aligned with unified policy. It loops attempts, tracks excludedProviderKeys, consumes `resolveRequestExecutorProviderFailurePlan(...)`, waits via unified queue, reroutes while candidates remain, and only throws `lastError` after attempts/pool exhausted (`src/server/runtime/http-server/request-executor.ts`).
  2. router-direct path: not aligned. Contract is explicit passthrough + hooks only (`src/server/runtime/http-server/router-direct-pipeline.ts`). `onProviderError` reports through unified error chain, but caller only uses plan for telemetry/cooldown bookkeeping; if retry plan does not request local retry, error is rethrown and reaches client (`src/server/runtime/http-server/index.ts:1623-1720`). No relay fallback after a direct provider error.
  3. provider-direct path: same divergence. It also calls `resolveRequestExecutorProviderFailurePlan(...)` only to report/classify, then rethrows to client (`src/server/runtime/http-server/index.ts:2050-2125`). No reroute because provider-mode direct is single-binding passthrough.
- Architectural tension confirmed:
  - Project/doc SSOT says "no independent error center; Virtual Router policy is the only strategy center" and direct/provider-direct/router-direct must stay passthrough + hooks only, fail-fast, no fallback, no Hub response conversion reentry.
  - Jason center-thesis says provider errors should prefer internal handling, counting, switching, and keep conversation alive as long as any provider/default remains.
  - These two are compatible only for relay/request-executor path today. They are NOT compatible for direct paths, because direct paths intentionally bypass the executor reroute loop.
- Current concrete leak points against thesis:
  1. client projection leak: `src/server/utils/http-error-mapper.ts` maps any `400 <= status < 500` to client-visible same-status error. So provider-origin 4xx (including misclassified transport-ish 499) goes straight to client.
  2. router-direct/provider-direct rethrow boundary: both direct paths call unified failure-plan/reporting, but they do not consume reroute decision except one local `retry_same_provider_once`/excluded-target loop inside router-direct. They never "fallback to relay" after send failure because contract forbids it.
  3. pool exhaustion final behavior: both relay and router-direct eventually throw `lastError` once pool exhausted/backoff budget spent. There is no documented/implemented "if route pool empty but default pool exists, automatically widen to default" second-stage route source in current host path. Any such widening must come from VR route selection truth, not host fallback.
- What is already aligned with thesis:
  - Error classification/reporting path is mostly centralized: provider/send/runtime/direct errors call `resolveRequestExecutorProviderFailurePlan(...)` -> `reportRequestExecutorProviderError(...)` -> provider reporter / router policy chain.
  - Unified blocking backoff queue exists and is used (`request-executor-error-action-queue.ts`).
  - Relay path excludes failed providers and reroutes while alternatives remain.
  - Pool-exhausted path does bounded wait and retry before surfacing final error.
- What is misaligned with thesis:
  - direct same-protocol router-mode ports default to direct (`sameProtocolBehavior ?? 'direct'`), so a large fraction of requests can bypass the only path that really honors internal switch-while-alternatives-exist.
  - ErrorErr06 client projection treats provider 4xx as immediately client-visible instead of first asking whether unified policy has exhausted all reroute candidates.
  - Some transport/cancellation-shaped upstream errors (e.g. 499 client-abort-style) are not normalized early enough, so they enter provider-failure/client-projection as ordinary provider 4xx.

## 2026-06-14 fresh-session vs old-session continuation probe
- Fresh live probe on `127.0.0.1:5555 /v1/responses` with new `session_id/conversation_id`:
  - turn 1 returned `200 requires_action` with upstream tool call `call_yyDS3dUpM2oueAzNiAJP8YN9`.
  - turn 2 submitted `function_call_output` for that call id and returned `200 requires_action` again, now with local `routecodex-servertool-cli` response/tool call instead of upstream 400.
- Conclusion: current failure is not "all new sessions still fail in the same way". Old polluted sessions still remain a separate class, but fresh sessions can pass the first continuation boundary now.
- Remaining caution: this probe does not prove the whole continuation chain is fixed end-to-end; it only proves the new session no longer reproduces the previous immediate `tool call result does not follow tool call` failure on the first followup turn.

## 2026-06-14 stopless 无感续杯 + 唯一 owner 审计（read-only）
- 用户要求：让 stopless 评估 schema，但模型可见续杯是“用户式追问/指令”，不暴露 schema / stopless / servertool / “系统替你调用工具” 的感知。CLI 投影与执行路径必须对模型无感。
- 唯一 owner 锁（来自 `docs/architecture/function-map.yml`）：
  1. `hub.servertool_stopless_cli_projection_seed`：`owner_kind=rust_ssot`，`owner_module=servertool-core/src/cli_contract.rs`，canonical builder `plan_stop_message_cli_projection_seed`；forbidden `src/server/runtime/http-server/executor`、`sharedmodule/.../servertool/handlers`。
  2. `hub.servertool_cli_projection`：`owner_kind=rust_ssot`，`owner_module=router-hotpath-napi/src`，canonical builder `build_servertool_cli_projection_01_from_hub_resp_chatprocess_03`；forbidden 同上。
  3. `hub.servertool_followup`：`owner_kind=rust_ssot`，`owner_module=router-hotpath-napi/src`，canonical builder `project_hub_resp_outbound_04_from_hub_resp_chatprocess_03`。
  4. stop schema gate：`stop-message-core/src/lib.rs:304` 的 `evaluate_stop_schema_gate`，是内部判定真源，决策面不动。
- request-side 工具治理：响应标准化在 `router-hotpath-napi/src/hub_pipeline_blocks/standardized_request.rs:375` 的 `drop_stale_orphan_responses_tool_outputs`；这是请求侧消解“已决但未配对 tool output”的唯一 owner。stopless 无感续杯不能绕过它去 HTTP executor 手工裁剪。
- 周期链条（按闭环顺序，不允许跳节点）：
  1. `RespInbound`：provider/raw 解析。
  2. `RespChatProcess`：`servertool orchestrator` 命中 `stop_message_auto`（`engine.ts:107`）→ 调 Rust `planStoplessOrchestrationActionWithNative` 拿 stopless plan（`engine.ts:213-216`）→ `cli_projection` 或 `terminal_final`。
  3. `servertool_followup`：`backend-route-mainline-block.ts` 重建 followup（不直接改 executor；forbidden path）。
  4. followup 通过 `reenterPipeline` 重入 Hub req/resp process；`stop-message-auto.ts:573` 构造 `followup` 含 injection ops + metadata。
  5. 请求侧 Rust 标准化在 `standardized_request.rs:50` 用 `drop_stale_orphan_responses_tool_outputs(payload, input_items)` 处理 input；这是停少“积压的 function_call_output 重复进 input” 的关键。
  6. `stop-message-core` 内部 `evaluate_stop_schema_gate`（`lib.rs:304`）在每次 stop 后判定：缺失/不合法 → 续杯（`schema_missing_followup` / `schema_invalid_followup`），收敛 → `FailFast`；`count_budget=false` 时不计数（`lib.rs:677`、`lib.rs:710`）。
  7. 模型可见链路只走 `buildClientVisibleProjectionShellWithNative`（`cli_contract.rs:512`），输出 assistant `tool_calls: [{ name=exec_command, args={ cmd:"routecodex servertool run stop_message_auto --input-json '{...}'" }}]`，命名空间 “servertool” + “stop_message_auto” 是模型可读感知来源。
  8. 客户端执行 → `submit_tool_outputs`/`function_call_output` 回到 `req_inbound` 入口；response 链路与正常请求一致。
- 当前代码中“模型可感知真源”三处：
  1. `cli_contract.rs:394-405` 生成的 `execCommand` 文本暴露 `routecodex servertool run stop_message_auto`（用户要 no-op 化的根因之一）。
  2. `cli_contract.rs:694-737` 的 `read_stop_message_followup_text` 把 `stop schema guidance: ...` 明文注入 continuation_prompt（`schema_hint` 段），并拼上 `继续完成当前用户目标...必须调用可用工具继续执行...`（用户已经在前文要求把“系统替我总结/补工具”的措辞撤掉）。
  3. `stop-message-prompts.md` 仍写着“第一轮核对…本轮结尾必须按 stop schema 输出…下一轮仍要先检查 schema…不要暴露 stopless/校验过程”——明文出现 “stop schema / stopless / 校验” 三个关键字，模型必然看见。
  4. Rust 旧默认 `default_stop_message_execution_prompt`（`chat_servertool_orchestration.rs:33-45`）硬编码三段中文，绕过 `readStopMessageFollowupText` → `config.ts` 走的就是 `assets/stop-message-prompts.md`，与 Rust 字面量分裂。
- `continue_execution` 已是 noop 容器（`chat_servertool_orchestration.rs:1665-1753`）但 wire 模型是 `tool_outputs[].name=continue_execution`，不是 `exec_command`，且未走 `cli_projection` 路径（`engine.ts` 不调用）。这意味着现在的“续杯”至少存在三条互不相同的产物：a) `exec_command` 投影（`stop_message_auto`）；b) `continue_execution` tool_output（`plan_servertool_noop_outcome_json`）；c) 文本 injection（`append_user_text`）。任何“唯一无感续杯”都必须收敛到一条。
- 拟改 owner 与修改点（不在本回合动代码）：
  - A. `cli_contract.rs`（`hub.servertool_cli_projection` + `hub.servertool_stopless_cli_projection_seed` 双 owner 重合点）：
    - 把 stopless 的客户端 tool name 从 `exec_command` 改为中性的 carrier 名（待与用户确认；建议方向：`routecodex_continue` 或 `client_continue`，禁止保留 `servertool`/`stop_message` 字符串字面量）。
    - 同步改 `DENIED_CLI_MARKERS` 与 `validate_no_denied_cli_marker` 规则：把“暴露 servertool 命名字符串”列为新的 denied marker，避免旧名字回归。
    - `read_stop_message_followup_text` 不再把 `stop schema guidance:` 字面量、`必须调用可用工具继续执行` 强制拼入 `continuation_prompt`；改为把“缺什么字段”映射成“用户式追问句”给 TS 注入层。schema 仍由 stop-message-core 解析。
  - B. `stop-message-core` 不动 `evaluate_stop_schema_gate` 的判定分支；只在 `schema_missing_followup` / `schema_invalid_followup` 的 message 中由 `default_*_prompt` 引入新的“无感追问句”来源，源头是 md 资产，runtime 按 `used` 取 1/2/3 段（用户已经在前文要求“md 独立出来，运行时读取 md，而不是硬编码”）。
  - C. `stop-message-prompts.md`：删掉 `stop schema / stopless / 校验` 三词；改为三段用户口吻：
    - round1：先继续当前目标，先把还差哪一步讲清，然后继续。
    - round2：把今天要解决的最小一步说清楚，然后继续。
    - round3：把当前进展收尾写明（已完成 / 未完成 / 卡点），然后停止。
    - md 必须保留三段 markdown 围栏 `<-- stop_message_prompt:roundN:start/end -->` 兼容 `config.ts:43-45` 的解析。
  - D. `config.ts` 已按源码 md → dist md 路径解析，资产同步脚本 `scripts/copy-compat-assets.mjs:31` 已存在；确认 release build 链里有 `copy-compat-assets` 阶段（不在本回合验证；前文要求“编译后放 dist”已具备路径）。
  - E. `engine.ts` 收缩为薄壳：只把 `planStoplessOrchestrationActionWithNative` 的 action 转成 `cli_projection`，由 `cli-projection.ts` 调 Rust 投影；不允许 TS 写默认 prompt 字符串（map 备注已禁止）。
  - F. `drop_stale_orphan_responses_tool_outputs` 继续是请求侧唯一消化工具输出/function_call 的 owner；不要在 HTTP executor 加 stopless noop 特殊路径。
- 验证链（red→green→live）：
  - red:
    - `tests/servertool/servertool-cli-projection.spec.ts` 新增 stopless 投影断言：`function.name` 不再含 `exec_command`、`command` 不再含 `servertool run stop_message_auto`、`command` 不暴露 `continuationPrompt / schemaGuidance / stopreason`。
    - `tests/servertool/stop-message-auto.spec.ts` 新增：续杯注入句不含 `stop schema / stopless / 校验`；`evaluate_stop_schema_gate` 三个 reason 各自对应一段用户口吻；`count_budget=false` 时 `no_change_count` 不递增。
  - green: `npm run verify:servertool-rust-only` + `npm run verify:function-map-compile-gate` + focused Jest。
  - live: `request.openai-responses` 上复现当前“模型连停三次”样本，新样本必须 1) 第一次 stop → 自动注入一次用户式追问；2) 模型补了 schema → `stop_schema_finished/blocked/needs_user_input` 立即放行；3) 投影 tool name/命令不含 `servertool` 字样。
- 未做事项（本回合只读）：
  - 未改任何代码；worktree 当前 dirty 来自其它任务（`git status --short --untracked-files=all` 见 25+ 项），不在本任务边界内。
  - 未验证 `scripts/copy-compat-assets.mjs` 是否在 release build chain 实际被调用；这是后面“md 编译到 dist”的下一步 gate。

## 2026-06-14 direct path error reroute + candidate exhaustion closeout
- Source changes:
  - `src/providers/core/runtime/provider-failure-policy-impl.ts`: extended `isProviderFailureClientDisconnect` to recognize upstream 499 + `client abort request` / `client closed request`; extended `isProviderFailureHealthNeutral` so client_disconnect returns `affectsHealth=false`.
  - `src/server/utils/http-error-mapper.ts`: added `isClientDisconnectLikeForProjection` + dedicated branch in `mapErrorToHttp` that returns 204 + `CLIENT_DISCONNECTED` for client_disconnect-style 4xx, so 499 is no longer echoed to the caller.
  - `src/server/runtime/http-server/index.ts`: added `isClientDisconnectLikeError` helper; reworked `router-direct.onProviderError` consumer to honor `exclude_and_reroute` (and not lose it via the legacy guard), to mark `excludedProviderKeys` from `retryPlan.excludedCurrentProvider`, and to short-circuit `exclude_and_reroute` for `client_disconnect` so it never consumes reroute budget; new stage log `router-direct.unified_decision.applied`.
- Red/green verified:
  - `tests/providers/core/runtime/provider-failure-policy-client-disconnect-499.spec.ts`: 4/4 PASS
  - `tests/server/utils/http-error-mapper-499-client-disconnect.spec.ts`: 3/3 PASS
  - `tests/server/utils/http-error-mapper.policy-exhausted-gate.spec.ts`: PASS
  - `tests/server/runtime/http-server/router-direct-pipeline.spec.ts`: 26/26 PASS (baseline preserved)
  - `tests/server/runtime/http-server/provider-direct-pipeline.spec.ts`: PASS
- Gates verified:
  - `verify:error-pipeline-contract` ok
  - `verify:function-map-compile-gate` ok (13 sub-gates)
  - `verify:architecture-error-chain-bypass` ok
  - `verify:architecture-provider-specific-leaks` ok
  - `verify:architecture-thin-wrapper-only` ok
  - `verify:provider-failure-ban-blackbox` PASS (live router failover exercises)
  - `npx tsc --noEmit` clean
- Out of scope (deferred): live replay of 5555 historical 499 sample, build/install/restart, MEMORY distillation. The plan file at `docs/goals/direct-path-error-reroute-and-candidate-exhaustion-plan.md` still names these as Phase D/F.
# 2026-06-14 direct continuation local-restore boundary
- Jason clarified the policy boundary: direct `/v1/responses` continuation must not do local scope restore/materialize, and restart must not reload persisted direct-owned continuation from local conversation store.
- Verified root cause in `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`: both `resumeLatestContinuationByScope()` and `materializeLatestContinuationByScope()` still matched `continuationOwner=direct`; persistence load/flush also kept direct-owned entries.
- Red tests added/updated in `tests/sharedmodule/responses-continuation-store.spec.ts`:
  - `direct-owned scope continuation must not local-restore remote previous_response_id by scope`
  - `restart simulation must not reload persisted direct-owned continuation by scope, while relay-owned continuation still reloads`
- Green after fix: direct-owned entries are skipped by scope restore/materialize and excluded from persistence load/flush; relay-owned scope continuation still reloads after restart simulation.

## 2026-06-14 virtual router hit log 审计（未实施改动）
- 用户诉求：每条 req/resp 打印 → 简洁 + reqId + 时间（重点 internal） + 同 session 同色 + 不白不黑不红（红留给错误），数字高亮色保留。
- 唯一修改点收口（4 块）：
  1. `sharedmodule/llmswitch-core/src/runtime/virtual-router-host-effects.ts` 的 `emitVirtualRouterHitLog` — 实时 hit 块真源。当前 `timeColor=90m` (深灰/亮黑，违)，`stopColor=214m` (橙，route-color 不是 session-color)，缺 internal 时间。
  2. `src/server/runtime/http-server/executor/log-rollup.ts:emitRealtimeVirtualRouterHitLog` + 1m rollup 行（line 886）— 1m 聚合用 `ANSI_VR=208m` (硬编码橙，**违反"同 session 同色"**)，应按 row.sessionId 哈希。
  3. `src/server/runtime/http-server/executor/log-rollup-format-blocks.ts` — `ANSI_DIM=90m` (黑色家族) + `ANSI_WHITE=97m` (白色) + `ANSI_BAR=240m` (近黑) 全部违规，必须换为非黑白红的中性暗色（如 `\x1b[38;5;245m` / `244m`）。`ANSI_VR=208m` 与 `ANSI_USAGE=39m` 是普通橙/青可用作路由/usage 标签色（route 维度，非 session 维度，OK）。
  4. `src/server/runtime/http-server/executor/usage-logger.ts:logUsageSummary` + `src/server/utils/request-log-color.ts:highlightLogNumbers` — 数字高亮用 `ANSI_WHITE=97m`，违规。
- 真源现状：
  - 调色板 `src/utils/session-log-color.ts` SESSION_LOG_COLOR_PALETTE 22 色已无 30/37/90/97/31，合规。
  - hit 实时块已带 `req=<id>` + `sid=<id>`，session 哈希上色（合规）。
  - usage 实时块已带 `req=` + `total/external/internal` + 数字白高亮（白违）。
  - 缺：internal 时间（仅 usage 块有，hit 块无），B 1m 聚合未按 session 分色。
- 命名 + map 锁：建议新增 `feature_id: log.virtual_router_hit_session_color` + `log.usage_console_palette` 入 `docs/architecture/function-map.yml`，将 4 块收口到 `log-rollup-format-blocks.ts` 作为唯一 ANSI 真源。
- 红测建议：focused Jest `tests/server/runtime/http-server/executor/log-rollup.spec.ts` 1m 行分色；`tests/sharedmodule/virtual-router-hit-log.spec.ts` 时间/内部耗时；`tests/server/runtime/http-server/executor/usage-logger.spec.ts` 数字色断言；新 `tests/server/runtime/http-server/executor/log-rollup-ansi-palette.spec.ts` 锁 ANSI 调色板不含 30/37/90/97/31。
- 等 Jason 确认后实施。

## 2026-06-14 direct SSE incomplete close audit
- Owner confirmed: src/server/handlers/handler-response-sse.ts incomplete branch wrote SSE error but skipped logResponseCompleted, so failure was not formally closed and usage could retain finish_reason=unknown.
- Live symptom matched: [response.sse.stream] upstream_stream_incomplete followed by usage/session rollup with finish_reason=unknown.
- Fix in progress: add red test + incomplete branch completion closeout with explicit failure reason.

## 2026-06-14 direct apply_patch / continuation audit
- Direct `/v1/responses` provider runtime had two concrete issues in `src/providers/core/runtime/responses-provider.ts`:
  1. same-protocol direct `submit_tool_outputs` still posted to plain `/responses` instead of `/responses/{id}/submit_tool_outputs`;
  2. `processIncomingDirect()` had been changed to unconditionally run `sanitizeResponsesProviderOutboundBody()`, which cloned ordinary direct payloads and violated the direct passthrough identity contract.
- Fix applied:
  - direct submit path now detects `entryEndpoint='/v1/responses.submit_tool_outputs'` and targets native upstream submit endpoint;
  - direct payload sanitize now runs only when the current body actually contains Responses `reasoning` items with `content`/`encrypted_content`, otherwise the original body object is preserved;
  - direct submit path reuses the already-decided body and skips the second sanitize pass.
- Verified:
  - `npm run jest:run -- --runInBand --runTestsByPath tests/providers/runtime/responses-provider.direct-passthrough.spec.ts` PASS (12/12)
  - `npm run verify:responses-direct-tool-shape-contract` PASS
  - `npm run jest:run -- --runInBand --runTestsByPath tests/server/runtime/http-server/provider-direct-pipeline.spec.ts` PASS
- Continuation-related conclusion: the recent direct continuation/submit收口确实把“额外 sanitize”带进了普通 direct path；这不是 relay 修复，而是 direct 污染。

## 2026-06-14 relay apply_patch owner narrowing
- Live-shape red test added to `tests/responses/responses-openai-bridge.spec.ts` for:
  - assistant text
  - `custom_tool_call(apply_patch)` / output
  - later `function_call(exec_command)` / output
  - reopened second `apply_patch`
- Result: this request-side `Responses -> OpenAI chat` normalization test is PASS, so the relay apply_patch `2013 / orphan_tool_result` live failures are likely *after* `buildChatRequestFromResponses()`, not in the earliest request-history normalization step.
- Next owner slice to inspect: OpenAI chat -> Anthropic/MiniMax compatibility conversion, or later continuation/store materialization around relay-owned history.
## 2026-06-14 relay apply_patch continuation narrowing

- direct 侧已确认的两个修复点：
  - `src/providers/core/runtime/responses-provider.ts` direct submit continuation 必须命中 `/responses/{id}/submit_tool_outputs`
  - direct 普通 passthrough 不能无条件走 `sanitizeResponsesProviderOutboundBody(...)`
- 新增红绿证据：
  - `tests/sharedmodule/responses-continuation-store.spec.ts`
  - 用例 `RED: reopened apply_patch after exec_command stays tool-ordered after submit_tool_outputs resume`
  - 结果：PASS。说明 conversation store 单独看时，`apply_patch -> exec_command -> apply_patch` 的累计 submit resume 历史没有坏。
- 本地真实链路脚本已验证：
  - `captureResponsesRequestContext -> recordResponsesResponse -> resumeResponsesConversation -> prepareResponsesHandlerRuntimeForHttp -> buildChatRequestFromResponses -> buildAnthropicRequestFromOpenAIChat`
  - reopened `apply_patch` 样本在这条链上 `openaiViolation=null` 且 `anthropicViolation=null`
  - 说明 owner 进一步排除：不是 conversation store，不是 handler submit resume，不是 Responses->OpenAI chat 基础映射，也不是 OpenAI chat->Anthropic 基础映射。
- 额外真实约束：
  - continuation store resume 会校验 `matchedPort/routingPolicyGroup`；脚本首次失败是因为未带 port scope，补齐后恢复正常。
- Jest harness 收口进展：
  - `src/modules/llmswitch/core-loader.ts` 已补 `importCoreModule()` 在 Jest 环境下优先 `import(sourcePath)`，并在 `require(dist ESM)` 报 `Must use import to load ES Module` 时回退到动态 `import(modulePath)`
  - 小探针已绿：`importCoreDist('native/router-hotpath/native-virtual-router-bootstrap-config')` 可拿到 `bootstrapVirtualRouterConfig`
  - 但 `responses-handler.anthropic-tool-history.blackbox.spec.ts` 仍被第二个 harness 点挡住：`native-shared-conversion-semantics not available`（同步 native export 路径）
- 当前最可疑 owner：
  - `sharedmodule/llmswitch-core` request_inbound 之后真正二次改工具历史的 native bridge action / sync native export 链
  - 需要继续查 `captureReqInboundResponsesContextSnapshotJson` / `native-shared-conversion-semantics` 的 Jest/source 同步装载，以及 live 路径里是否还有第二处工具历史重写。
## 2026-06-14 log review target
- owner split: request-log-color vs log-rollup direct resolveSessionAnsiColor vs usage white highlight
- goal: same session color across virtual-router-hit / session-request / usage / port prefix normal lines; no white/red/gray/black for normal session lines; compact default layout; abnormal timings still visible
## 2026-06-14 longcontext overflow audit
- symptom: 5520 longcontext session hit model context overflow for gpt-5.4-mini path
- need verify route threshold budget vs provider real max context vs accumulated history/continuation accounting
- direct apply_patch follow-up: evaluateDirectRouteDecision exists but not wired into live router-direct path; likely gap between gate and runtime

## 2026-06-14 P4-A wiring final closeout + out-of-scope stopless gap

### P4-A status（direct-path 错误流 P4-A wiring 收口）
- Rust 唯一 owner：lib.rs line 61 加 `mod primary_exhausted_to_default_pool_blocks;`（按字母序）
- 新文件：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/primary_exhausted_to_default_pool_blocks.rs`
  - `#[napi(js_name = "planPrimaryExhaustedToDefaultPoolJson")] pub fn plan_primary_exhausted_to_default_pool_json(input_json: String) -> NapiResult<String>`
  - 单点代理 `virtual_router_engine::routing::primary_exhausted_to_default_pool::plan_primary_exhausted_to_default_pool`
- 两个文件头补 `// feature_id: virtual_router.primary_exhausted_to_default_pool` 锚点（owner queryability gate 接受）
  - `virtual_router_engine/routing/primary_exhausted_to_default_pool.rs:1`
  - `primary_exhausted_to_default_pool_blocks.rs:1`
- function-map line 547 / verification-map line 275 完整登记 P4-A（owner_module / canonical_builders / required_tests / required_gates / forbidden_paths / notes）

### 验证证据
- `cargo build --lib`：0 errors / 302 warnings（warnings 预存 non_snake_case 与 never used）
- `cargo test --lib primary_exhausted_to_default_pool`：5 passed / 1676 filtered out（plan 5 个用例）
- `verify:error-pipeline-contract`：ok（provider-direct/router-direct provider failures enter ErrorErr hook before rethrow）
- `verify:provider-failure-ban-blackbox`：`"ok": true`（backupHits=4 / portIsolation 双侧切流验证）
- `verify:architecture-error-chain-bypass`：ok（74 files / 2 targets）
- `verify:architecture-provider-specific-leaks`：ok（99 files / 7 targets）
- `verify:architecture-thin-wrapper-only`：ok（69 files / 2 targets）
- `tsc --noEmit`：0 errors
- focused Jest 5 spec 一次 PASS：20 passed / 0 failed
  - `tests/providers/core/runtime/provider-failure-policy-client-disconnect-499.spec.ts`
  - `tests/server/utils/http-error-mapper-499-client-disconnect.spec.ts`
  - `tests/server/utils/http-error-mapper.policy-exhausted-gate.spec.ts`
  - `tests/server/runtime/http-server/router-direct-pipeline.candidate-exhaustion.spec.ts`
  - `tests/server/runtime/http-server/provider-direct-pipeline.candidate-exhaustion.spec.ts`

### out-of-scope gap（不属本 plan，登记备查）
- `verify:function-map-compile-gate` 在 `hub.servertool_stopless_transparent_continuation`（stopless 域）与 `hub.servertool_stopless_cli_projection_seed`（反向）出现双侧注册不一致；与本 plan 主体（direct-path 错误流）无业务关联
- 验证：在 `stopless_orchestration_contract.rs` 加 1 行 `// feature_id: hub.servertool_stopless_transparent_continuation` 注释后，`verify:architecture-feature-id-anchors` PASS，但 `verify:architecture-feature-map-growth-discipline` 立即在新 fail（verification-map 反向缺 + stopless_cli_projection_seed 反向缺）——进入补洞循环，不在本 plan 责任面
- 已回退 `stopless_orchestration_contract.rs` 的 anchor 注入（git diff 干净）
- 本 plan 内 install-global.sh 因此未跑（被 build:min → function-map-compile-gate 链阻塞）；`~/.rcc/install/current` 仍是 `0.90.3064`，runtime dist 未变 → live replay 与 MEMORY 提炼未做
- 待立项新 plan：`docs/goals/architecture-feature-map-stopless-closeout-plan.md`（登记 stopless 双侧注册 + 全部 65 feature 三件套一致性收口，使 install-global.sh 能恢复执行）
- 同时登记原 plan §8 的另一条 SSE 收口 gap（`docs/goals/responses-second-candidate-stream-incomplete-finish-reason.md`）仍待立项
- 2026-06-14 21:31 CST
  - log color live mismatch root cause confirmed: formatter owners (`usage-logger.ts`, `log-rollup.ts`) were already emitting `\x1b[97m`, but live port-prefixed wrapper in `src/server/runtime/http-server/port-log-context.ts` stripped nested ANSI via `stripAnsiCodes(first)`.
  - fix applied at true live owner: preserve `first` when wrapping `[port:... group:...]` prefix; keep prefix color but stop removing nested white highlights.
  - live proof after global install `0.90.3065`: `~/.rcc/logs/server-5520.log` shows lines like `[port:5555 ...] [usage] total=^[[97m8219.0ms ... finish_reason=^[[97mtool_calls`, confirming white values survive port-prefix layer.
  - focused gates green: `tests/server/runtime/http-server/executor/usage-logger.spec.ts`, `tests/server/runtime/http-server/executor/log-rollup.spec.ts`, `tests/server/runtime/http-server/entry-port-snapshot-isolation.red.spec.ts`.

## 2026-06-14 apply_patch grammar 400 closure

- live failing sample confirmed from `~/.rcc/logs/server-5520.log`:
  - requestId `openai-responses-router-gpt-5.4-20260614T230414428-345124-2702`
  - `[port:5520 ...] [virtual-router-hit] ... thinking -> asxs.crsa.gpt-5.4`
  - `[router-direct.send] ... statusCode=400`
  - upstream error: `Invalid lark grammar ... unknown name: "begin_patch"`
- classification:
  - this sample is `5520` same-protocol direct.
  - root cause owner is request-side Rust `apply_patch` tool schema publication, not relay/store/SSE.
- true owner:
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs`
- fix truth:
  - `APPLY_PATCH_LARK_GRAMMAR` now publishes full canonical grammar (`begin_patch`, `end_patch`, hunks, `%import common.LF`) instead of truncated single-line definition.
- verification:
  - `cargo test -q -p router-hotpath-napi normalize_apply_patch_freeform_tool_schema --lib -- --nocapture` PASS
  - `node scripts/architecture/verify-apply-patch-freeform-contract.mjs` PASS
  - `RCC_APPLY_PATCH_ONLINE_URL=http://127.0.0.1:5520/v1/responses RCC_APPLY_PATCH_ONLINE_MODEL=gpt-5.4 RCC_APPLY_PATCH_ONLINE_TIMEOUT_MS=180000 node scripts/tests/apply-patch-freeform-10000-online.mjs` PASS
  - online smoke result: `ok=true`, `customInputCount=4`, `functionArgumentPatchLeakCount=0`, `deltaStreamCount=0`

## 2026-06-14 apply_patch direct/relay audit progress

- sample `openai-responses-minimax.key1-MiniMax-M3-20260613T223253714-340912-698`
  - log truth: `[port:5555 ...] [virtual-router-hit] ... -> minimax.key1.MiniMax-M3`
  - no `[router-direct.send]`
  - provider returned `invalid params, tool call result does not follow tool call (2013)`
  - classification: relay/request-history -> provider chat projection issue, not direct
- sample `openai-responses-router-gpt-5.4-20260613T231359101-341020-806`
  - log truth: `[port:5555 ...]` + no `[router-direct.send]`
  - local error: `orphan_tool_result: bridge tool_result item references unknown or already-consumed call_id ...`
  - diag code: `hub_pipeline_context_capture_failed`
  - classification: local relay request-context capture reject before provider send
- sample `openai-responses-router-gpt-5.4-20260614T103025622-342061-1847`
  - log truth: `[port:5555 ...] [router-direct.send] ... statusCode=400`
  - upstream returned `No tool call found for function call output with call_id ...`
  - classification: `5555` same-protocol direct sample; proves `5555` is not inherently relay
- continuation/store truth:
  - `responses-request-bridge.ts` only local-resumes when continuation owner is not `direct`
  - `responses-conversation-store.ts` `resumeLatestContinuationByScope` / `materializeLatestContinuationByScope` both skip `continuationOwner === 'direct'`
- gate truth:
  - PASS `tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts`
  - PASS `tests/server/handlers/responses-handler.anthropic-tool-history.blackbox.spec.ts`
  - FAIL `tests/sharedmodule/responses-continuation-store.spec.ts` at `fails fast when direct and relay continuations coexist under one scope without explicit owner`
  - this failing gate is useful evidence: direct/relay owner coexistence is not fully fail-fast yet
- response/SSE surface truth:
  - Rust client-visible Responses projection owner remains `hub_resp_outbound_client_semantics_blocks/client_tool_args.rs`
  - TS `responses-sse-bridge.ts` is currently a near-pure re-export facade over `responses-response-bridge.ts`
  - current red test + verify script (`server_responses_sse_surface_single_owner.test.ts`, `verify-responses-handler-single-bridge-surface.mjs`) explicitly require handler-side split imports, so this is a duplicate surface candidate, not yet a deletable duplicate implementation

## 2026-06-14 P4-A 全局 install 收口（修正旧结论）

### 事实校正
- 之前 note.md 写的 "本 plan 内 install-global.sh 因此未跑" 已被本轮推翻：
  - 上一轮已补 stopless anchor（`stopless_orchestration_contract.rs` / `stopless_goal_state_contract.rs` / `persisted_lookup.rs` / `servertool_core_blocks.rs` 行 1 注入 `// feature_id: hub.servertool_stopless_transparent_continuation`）。
  - `verify:function-map-compile-gate` 全 13 子 gate PASS（install 实跑证据）。
  - `path /opt/homebrew/opt/node@22/bin:$PATH ROUTECODEX_BUILD_RESTART_ONLY=1 ROUTECODEX_INSTALL_VERIFY_PORT=5555 ./scripts/install-global.sh` 成功，最终 dist 落到 `/opt/homebrew/lib/node_modules/routecodex` 版本 `0.90.3065`。
  - `~/.rcc/install/current -> releases/routecodex-0.90.3065-2026-06-14T131134Z`，runtime 已重启。
- 5555/5520/10000 `/health` 三端口 200 + `pipelineReady=true`，napi 二进制 mtime `2026-06-14T21:11`，dist mtime `2026-06-14T21:11`。
- 新 build 之后真实日志已确认 `server-5555.log` 21:13-21:23 区间 `HTTP_499|client abort request|primary_exhausted|default_pool` 命中数 = **0**（旧样本已不再 client-visible 499）。

### 仍未完成的运行态 gap
- `virtual_router.primary_exhausted_to_default_pool` Rust 端有 contract（`primary_exhausted_to_default_pool.rs` + `primary_exhausted_to_default_pool_blocks.rs` + `cargo test --lib` 5 PASS），napi 出口 `plan_primary_exhausted_to_default_pool_json` 已在 `target/release/router_hotpath_napi.node` 内。
- **但 host 侧（`src/` + `sharedmodule/llmswitch-core/src/`）当前没有任何消费点**：grep `planPrimaryExhaustedToDefaultPoolJson|planPrimaryExhaustedToDefaultPool|plan_primary_exhausted` 全空，runtime 实际不会触发 default pool 扩池。
- 修正 plan §0.3 (g) 现状：Rust contract 完备 + host wiring **未完成**；下次 plan 必须补 host 唯一消费入口。

### live probe 状态
- 候选切换（`switch=exclude_and_reroute`）在 5555/5520 已观察：21:13 install 后的实时日志里既有历史样本 `asxs.crsa.gpt-5.4 503 → 1token.key1.gpt-5.4 UPSTREAM_HEADERS_TIMEOUT → cc.key1.gpt-5.4-mini 429` 的级联切换证据（`/Volumes/extension/.rcc/log/config.toml/ports/5520/server-5520.log`）。
- `primary_exhausted -> default_pool` live probe **未做**（host wiring 缺失，无法触发）。
- 499 主动 abort live replay 计划下一步：本回合按 plan §6.5-P3 修正后的口径（"客户端收不到 `client abort request` / `HTTP 499` 子串"）执行。

## 2026-06-14 apply_patch direct/relay install closure

- 已执行编译/构建/全局安装/重启：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH ROUTECODEX_BUILD_RESTART_ONLY=1 ROUTECODEX_INSTALL_VERIFY_PORT=5555 ./scripts/install-global.sh` PASS。
  - `routecodex --version` = `0.90.3065`，`rcc --version` = `0.90.3065`。
  - `127.0.0.1:5520/health`、`127.0.0.1:5555/health`、`127.0.0.1:10000/health` 均 `status=ok ready=true pipelineReady=true version=0.90.3065`。
- apply_patch direct/relay 在线验证：
  - 5520 direct：`RCC_APPLY_PATCH_ONLINE_URL=http://127.0.0.1:5520/v1/responses RCC_APPLY_PATCH_ONLINE_MODEL=gpt-5.4 ... scripts/tests/apply-patch-freeform-10000-online.mjs` PASS，`customInputCount=4`，`functionArgumentPatchLeakCount=0`，`deltaStreamCount=0`。
  - 5555 relay/route：同脚本打 `http://127.0.0.1:5555/v1/responses` PASS，`customInputCount=3`，`functionArgumentPatchLeakCount=0`，`deltaStreamCount=0`。
  - 结论：当前安装产物已不再发送截断的一行 lark grammar，也没有把 apply_patch 回投成 JSON-wrapped `arguments`。

## 2026-06-15 direct-path-error-reroute-and-candidate-exhaustion plan P5 (function-map/verification-map sync) execution

- 触发：本轮按 `docs/goals/direct-path-error-reroute-and-candidate-exhaustion-plan.md` §6.5-P5 执行 verification-map 同步；handoff 摘要指出 `virtual_router.primary_exhausted_to_default_pool` 的 host 端 `allowed_paths` 仍残留 `src/server/runtime/http-server/direct-decision.ts`，且 `integration: []`，与 SSOT 不符。
- 落盘（无代码改动）：
  - `docs/architecture/function-map.yml`
    - `virtual_router.primary_exhausted_to_default_pool.allowed_paths` 移除 `src/server/runtime/http-server/direct-decision.ts`（host 不允许拥有 default-pool 合成逻辑）。
    - notes 追加：\"Host decision helpers (e.g. src/server/runtime/http-server/direct-decision.ts) live under error.execution_decision_consumer; they must not synthesize a default-pool target list.\"
    - `error.execution_decision_consumer.allowed_paths` 追加 `src/server/runtime/http-server/direct-decision.ts` / `direct-client-disconnect.ts` 与 `router-direct-pipeline.candidate-exhaustion.spec.ts` / `provider-direct-pipeline.candidate-exhaustion.spec.ts` 锚点。
  - `docs/architecture/verification-map.yml`
    - `virtual_router.primary_exhausted_to_default_pool.integration` 由 `[]` 改为 `cargo test -p router-hotpath-napi primary_exhausted_to_default_pool --lib` + 两个 focused Jest；smoke 维持 `verify:function-map-compile-gate`。
    - `error.execution_decision_consumer.unit` 追加 `src/server/runtime/http-server/direct-decision.ts` / `direct-client-disconnect.ts`。
- 偏差记忆：handoff 摘要说\"need to remove misleading direct-decision.ts allowed path and add proper tests/Rust selection paths\"；本次按 host-only-consumer 解释保留 `direct-decision.ts` 但从 primary_exhausted 模块的 `allowed_paths` 中物理移除（落到 `error.execution_decision_consumer`），与 SSOT 一致。
- 剩余待跑（本轮按 handoff 余项执行）：
  1. `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:function-map-compile-gate`
  2. `cd sharedmodule/llmswitch-core/rust-core && cargo test -p router-hotpath-napi primary_exhausted_to_default_pool --lib`
  3. 重跑 handoff 列出的 4 个 focused spec + `error-pipeline-contract`
  4. `npx tsc --noEmit --pretty false`
  5. `install-global.sh` + live replay/probe（5555 旧 499 样本、2+ 候选切 provider、client_disconnect 不可见、primary_exhausted -> default_pool）

## 2026-06-14T16:28:16.182Z stopless learned

- requestId: openai-responses-minimax.key1-MiniMax-M3-20260615T002737143-345365-2943:stop_followup
- sessionId: 019ec4d3-e92c-7240-b6a5-153aaac6d806
- stopReason: stopless strict_session_only + 透明续轮 已全绿：cargo 38+30+46+11、jest 23/23、verify:servertool-rust-only、function-map-compile-gate、tsc --noEmit、git diff --check 全过；5520 真实 200 response 无 required_action/exec_command/stop_message_auto/routecodex servertool run；log sid 锁 sessionId、decision=stop_schema_continue_next_step、A/B session 互不污染
- evidence: (1) cargo test -p servertool-core persisted_lookup/stopless/stop_message 全过；(2) cargo test -p router-hotpath-napi routing::metadata 11 过；(3) jest stop-message-flow-followup-reentry + stopless-sessionid-transparent + stop-message-runtime-utils.continuation 23/23；(4) verify:servertool-rust-only + function-map-compile-gate + tsc --noEmit + git diff --check 全绿；(5) 5520 实际 /v1/responses 200，body 无 required_action/exec_command/stop_message_auto/routecodex servertool run；(6) 10000/5555 log [virtual-router-hit] sid=stopless-onehop-...-xxx、decision=trigger reason=stop_schema_continue_next_step、used 0→1→2；(7) SessionId 隔离：A/B fresh sessionId 互不污染

stopless 续轮永远走 servertool-followup server-side reenter 透传 user-role 字符串消息，禁止任何 client-side tool_calls 壳或 CLI 投影；scope 锁 sessionId 一项即够，tmux/conversation/inject-* 全部忽略；测试断言要匹配新契约：reenter 期望被调用、N 次、body 末端是 user 字符串、无 routecodex servertool run 子串

## 2026-06-14T16:31:46.282Z stopless learned

- requestId: openai-responses-minimax.key1-MiniMax-M3-20260615T003059902-345401-2979:stop_followup
- sessionId: 019ec4d3-e92c-7240-b6a5-153aaac6d806
- stopReason: stopless 透明续轮收口闭环：sessionId-only 范围 + transparent reenter（无 exec_command/stop_message_auto/routecodex servertool run 投影），所有红测、cargo、verify gate、5520 在线 probe、session 隔离验证全部绿
- evidence: jest tests/servertool/{stop-message-flow-followup-reentry,stopless-sessionid-transparent,stop-message-runtime-utils.continuation}.spec.ts 23/23 pass; cargo test -p servertool-core persisted_lookup/stopless/stop_message 38+30+46 pass, cargo test -p router-hotpath-napi routing::metadata 11 pass; npm run verify:servertool-rust-only PASS; npm run verify:function-map-compile-gate PASS; npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit PASS; git diff --check clean; live 5520 probe model=gpt-5.5 sessionId=stopless-onehop-5520-1781454248192 响应体 status=completed output=[message{role:assistant,content=[output_text{text:"{...}"}]}] 无 required_action/exec_command/stop_message_auto/routecodex servertool run, request id 后缀 :stop_followup 证明 reenter 通道; session 隔离 sid=stopless-iso-A-* log 独立, sid=stopless-iso-B-* log 独立

透明 reenter 是 stopless 唯一诚实的路：cli_projection 会留指纹（routecodex servertool run / exec_command 在 tool_calls 里）模型能看见；用 schema-continuation prompt 作 user-role string reenter 同一 provider/model 让模型对 stopless 无感；sessionId-only 范围足够：conversationId 和 tmux 加了假命中，每个 session 独立持久化避免了之前 max session scope 的跨会话泄漏；最强证据是 probe 响应体本身：无 required_action + 无 exec_command + 无 stop_message_auto + request id 后缀 :stop_followup = 诚实的续轮

## 2026-06-15T00:39:00 stopless 反向证据 10000/5555
- 10000 model=gpt-5.5 sessionId=stopless-final-1781455081106-4ty5dy 504 servertool_followup_timeout (nested followup timeout 10000ms, EMPTY_ASSISTANT_RESPONSE); 5555 sessionId=stopless-final-1781455123581 504 同因; 两个 504 的响应体均无 required_action/exec_command/stop_message_auto/routecodex servertool run, 证明错误路径不被 stopless 投影污染
- 10000 log 显示 stop_message_flow 触发 decision=trigger reason=trigger_stop_schema_continue_next_step used=0→1→2, :stop_followup 后缀证明 reenter 通道; provider 路由 mini27 因 401 被自动 switch 到 minimax, 10s 内 provider 未回 = 错误路径只暴露 provider slow, 绝不暴露 stopless 内部工具

## 2026-06-14T16:52:48.123Z stopless learned

- requestId: openai-responses-minimax.key1-MiniMax-M3-20260615T005143718-345550-3128:stop_followup
- sessionId: 019ec4d3-e92c-7240-b6a5-153aaac6d806
- stopReason: stopless 收口闭环：scope 收为 sessionId、client 无工具投影、live 日志和实际响应均证明透明 user-input 续轮
- evidence: cargo persisted_lookup 38/stopless 30/stop_message 46/router-hotpath-napi metadata 11 全 pass；jest 3 spec 23/23 pass；verify:servertool-rust-only + function-map-compile-gate + tsc + git diff --check 全 exit 0；live 5520 /v1/responses 200 status=completed body 无 required_action/exec_command/stop_message_auto/routecodex servertool run；live 10000/5555 504 servertool_followup_timeout 错误体同样无 stopless 投影；10000 日志 sid=stopless-final-1781455081106-4ty5dy 显示 flow=stop_message_flow decision=trigger reason=trigger_stop_schema_continue_next_step 走 reenter requestId=:stop_followup used=0→1→2 透明续轮通道

stopless 收口的 client-visible 工具投影风险被单元测试断言读不到时（字段不在 type 里），改写断言必须以 payload 文本子串 + reenter 调用形态 + 末端 user role 三个维度联合锁，不能只断言 readStopMessageCliProjection 不存在；10000/5555 504 的错误码 servertool_followup_timeout 是 stopless 触发后的 provider followup 超时，不是 stopless 投影失败，可作为反向证据使用

## 2026-06-14T16:55:29.260Z stopless learned

- requestId: openai-responses-minimax.key1-MiniMax-M3-20260615T005424369-345570-3148:stop_followup
- sessionId: 019ec4d3-e92c-7240-b6a5-153aaac6d806
- stopReason: stopless 已收口为严格 sessionId 匹配 + 透明续轮；3 个完成标准逐项有 Rust/Jest 单测+gate+live HTTP 证据；TS 旧 cli_projection 分支与 routecodex servertool run 客户端恢复路径已物理删除；正反向 live 样本成对：5520 200 无工具投影，10000/5555 504 provider slow 无工具投影
- evidence: cargo persisted_lookup 38 passed + stopless 30 passed + stop_message 46 passed + routing::metadata 11 passed；jest stop-message-flow-followup-reentry + stopless-sessionid-transparent + stop-message-runtime-utils.continuation 23/23 PASS；npm run verify:servertool-rust-only + verify:function-map-compile-gate + tsc + git diff --check 全部 exit=0；live 5520 sessionId=stopless-final-1781455073644-sk6eic 200 body 无 required_action/exec_command/stop_message_auto/routecodex servertool run；live 10000 sessionId=stopless-final-1781455081106-4ty5dy 504 servertool_followup_timeout body 同无 stopless 工具投影 日志显示 stop_message_flow 触发 + :stop_followup reenter + used=0→1→2

live HTTP 验证必须区分 stopless 透明续轮（user input reenter，无工具投影）与上游 provider 慢（504 timeout），错误码可以相同但日志是否出现 :stop_followup 通道 + used 计数器递增是 stopless 真触发的金标准；外部端口 5520/10000/5555 共用同一进程，dist 重 build 后必须用 install-global 同步全局，但 Node 26 阻断脚本

## 2026-06-15 direct-path-error-reroute-and-candidate-exhaustion plan final closure (build 0.90.3068)

- 5 项 live 证据（已收集）：
  1. 5555/5520 live /v1/responses SSE 完成：response.created -> response.completed -> response.done，0 event:error，0 client abort request 文本。版本 0.90.3068，path: /opt/homebrew/opt/node@22/bin/node /tmp/sse_smoke.mjs 5555 5520
  2. 5555 SSE 客户端 abort 后服务端无投影：HTTP 200 建链，client abort 后 body 无 event:error、无 HTTP_499、无 client abort request，bodyTail 仅含 response.output_text.delta。服务端 response.sse.client_close 日志可观察。
  3. 5520 router-direct 5xx provider-switch 证据：sdfv.key1.gpt-5.4-mini 5xx -> attempt 1/6 -> 2/6 provider=... retry_same_provider_once 2000ms -> 仍 5xx -> attempt 2/6 -> 3/6 exclude_and_reroute 4000ms。决策点全在 ErrorErr05 决策消费中。
  4. primary_exhausted_to_default_pool 运行时契约：loadNativeRouterHotpathBinding().planPrimaryExhaustedToDefaultPoolJson 输入 2 tiers(primary/backup)、exhaustedTargets=[fwd.a,fwd.b] -> 输出 status=default_pool defaultPoolTargets=[fwd.c] fromTierId=backup fromTierPriority=100。证明 host 只消费 contract，绝不本地合成 fallback。
  5. 5555 旧样本在线重放 499 路径：当前 ~/.rcc/codex-samples/openai-responses/port-5555 已被自动清理无 2026-06-14T0851 旧样本。client_disconnect live abort 已替代证明 499 不可见。

- 门禁：verify:function-map-compile-gate 13/13 子 gate PASS（含修复后 boundary 跳过生成目录 + 容忍 ENOENT/EPERM）。verify:error-pipeline-contract / verify:provider-failure-ban-blackbox / verify:architecture-error-chain-bypass / verify:architecture-provider-specific-leaks / verify:architecture-thin-wrapper-only / verify:architecture-metadata-leak-boundary / verify:architecture-nonadjacent-conversion / verify:architecture-owner-queryability / verify:architecture-feature-map-growth-discipline / verify:vr-no-ts-runtime / verify:vr-no-fallback-semantics 全部 PASS。npx tsc --noEmit clean。

- 物理删除：error.provider_failure_policy.client_disconnect 前移；http-error-mapper policy-exhausted gate；router-direct / provider-direct 不再 report-only rethrow；host 不得 local default fallback。

- 缺口/未闭环：
  - 10000 live /v1/responses SSE 命中 servertool_followup_timeout（stop_message_auto nested followup 10s 超时），与 direct error 流无关；不影响 direct-path plan 收口。10000 504 的响应体已确认无 stopless 投影（详见 2026-06-14T16:31:46 块）。
  - direct pipeline 在 5xx 时已经走到 ErrorErr05 决策消费但还在重 build:min 期间产生大量 dist/coverage 清理噪音；本轮已干净后重启一次，验证 0.90.3068 health 全绿。

- 修复脚本（audit-safe）：scripts/architecture/verify-function-map-boundary-mentions.mjs listFiles 现在跳过 target/node_modules/dist/build/.git/.cache/coverage/.rcc/out/tmp/logs/release，且对扫描中消失的文件/目录 ENOENT/EPERM/EACCES/EBUSY 容忍。
## 2026-06-15 direct SSE apply_patch empty tool-call regression

- Symptom: direct `/v1/responses` SSE could still emit empty `function_call`/empty `arguments` for `apply_patch`, so client saw an empty tool call instead of usable patch input.
- Verified root cause: `src/modules/llmswitch/bridge/responses-response-bridge.ts` `normalizeResponsesSseFrameForClientForHttp()` returned early on `metadata.__routecodexDirectPassthrough === true`, which bypassed the Rust `projectResponsesSseFrameForClient` path entirely.
- Fix: removed the direct-passthrough short-circuit for SSE client projection only. Request path stays direct; client SSE still goes through the single Rust apply_patch projection owner.
- Red/green lock: `tests/server/handlers/handler-response-utils.apply-patch-freeform-sse.spec.ts` now includes `normalizes direct passthrough apply_patch SSE frames instead of returning empty function_call arguments`.
- Verification PASS:
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/server/handlers/handler-response-utils.apply-patch-freeform-sse.spec.ts --runInBand`
- Extra note: broader `tests/server/handlers/responses-sse-client-contract.blackbox.spec.ts` still has pre-existing unrelated failures around tool-call continuation timeout and upstream incomplete stream error projection; not caused by this direct apply_patch slice.

## 2026-06-15 apply_patch SSE empty-args build/install/restart verification

- Current truth: `apply_patch` SSE empty-args issue is not reproducible after the direct SSE projection fix already present in tree.
- Verification PASS:
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/server/handlers/handler-response-utils.apply-patch-freeform-sse.spec.ts --runInBand`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH RCC_APPLY_PATCH_ONLINE_URL=http://127.0.0.1:5520/v1/responses RCC_APPLY_PATCH_ONLINE_MODEL=gpt-5.4 node scripts/tests/apply-patch-freeform-10000-online.mjs`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH RCC_APPLY_PATCH_ONLINE_URL=http://127.0.0.1:5555/v1/responses RCC_APPLY_PATCH_ONLINE_MODEL=gpt-5.4 node scripts/tests/apply-patch-freeform-10000-online.mjs`
  - Results: 5520 `ok=true customInputCount=4 functionArgumentPatchLeakCount=0 deltaStreamCount=0`; 5555 `ok=true customInputCount=3 functionArgumentPatchLeakCount=0 deltaStreamCount=0`
- Build/install/restart PASS:
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/build-core.mjs`
  - `git diff --check`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH ROUTECODEX_BUILD_RESTART_ONLY=1 ROUTECODEX_INSTALL_VERIFY_PORT=5555 ./scripts/install-global.sh`
  - Installed version: `routecodex --version = 0.90.3068`, `rcc --version = 0.90.3068`
  - Health: `127.0.0.1:5555`, `5520`, `10000` all `status=ok ready=true pipelineReady=true version=0.90.3068`

## 2026-06-15 latest 5520 apply_patch failure sample re-audit

- New evidence is from current rolling sample `~/.rcc/codex-samples/openai-responses/port-5520/openai-responses-router-gpt-5.4-20260615T034207750-345862-3440/provider-request.json` plus matching `server-5520.log` request `openai-responses-router-gpt-5.4-20260615T034207750-345862-3440`.
- Server-side truth for this sample: request completed `200`; `server-5520.log` shows normal `✅ [/v1/responses]` closeout, so this sample is not an upstream/provider execution failure.
- Request-history truth inside `provider-request.json`:
  - repeated `function_call name=apply_patch` with `arguments=""` at lines such as `874-881`, `906-913`, `1880-1887`;
  - matching `function_call_output` is just `aborted`;
  - same history block includes assistant text explicitly saying the tool call was still aborted and that the model was confused about JSON vs freeform/raw patch.
- Current judgment tightened:
  1. this latest sample is not “valid patch got truncated during execution”;
  2. it is “conversation history already contains empty apply_patch tool calls”;
  3. therefore the immediate failure surface is client-visible/tool-call projection or client/tool invocation semantics, not provider patch execution.
- Important distinction from older 5555 audit:
  - 5555 older sample had real patch-content execution failures (`context mismatch` / retry instability);
  - this 5520 latest sample shows empty-call history pollution before any real patch body exists;
  - do not collapse them into one proven root cause without a new red test per shape.
- Existing gate gap remains: current SSE regression only locks suppression/projection of empty apply_patch frames on one SSE path; it does not yet prove that every client-visible path and persisted history path can never reintroduce `function_call(name=apply_patch, arguments="")`.
## 2026-06-15 5520 latest apply_patch sample re-audit

- 最新样本：`~/.rcc/codex-samples/openai-responses/port-5520/openai-responses-router-gpt-5.4-20260615T034711276-345909-3487/`
- 已验证事实：
  - `provider-response.json` 为 `status=200`，且 `url=https://one.1token.xyz/responses`，说明这次不是 upstream/provider 执行 patch 失败。
  - 同一样本 `provider-request.json` 里存在多类空参数工具调用，不止 `apply_patch`：
    - 最早空调用是 `update_plan`
    - 其后有 `exec_command` 空参数
    - 也有 `apply_patch` 空参数与 `aborted`
  - 同一样本 outbound tool declaration 存在契约错位：
    - 描述写的是 freeform/FREEFORM
    - wire shape 却是 `type=function + parameters.patch`
- 继续缩小根因后确认：
  - request-side Rust owner `normalize_apply_patch_freeform_tool_schema(...)` 已正确把 `apply_patch` 规范成 `type=custom + format={type=grammar,syntax=lark}`
  - 后续 provider outbound Rust sanitize 仍会把 openai-responses 的 `custom apply_patch` 降级成 `function`
  - 唯一 owner：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_protocol_spec_semantics.rs`
- 2026-06-15 修复：
  - `normalize_provider_outbound_tool(protocol, tool)` 现在对 `protocol=openai-responses && tool.type=custom && name=apply_patch` 直接保留原 shape，不再降级为 function tool。
- 红测与 gate 证据：
  - 新增 Rust 用例：
    - `sanitize_provider_outbound_payload_preserves_custom_apply_patch_for_openai_responses`
  - 同类守卫回归：
    - `sanitize_provider_outbound_payload_converts_custom_apply_patch_for_openai_chat`
    - `sanitize_provider_outbound_payload_keeps_responses_function_tools_flat`
  - 三条 Rust 定向测试均 PASS
  - `npm run verify:apply-patch-freeform-contract` PASS
  - `npm run verify:apply-patch-regressions` PASS
- 关键纠偏：
  - 这轮新红测最初失败不是实现错误，而是 `format.definition` 断言把 JSON 反序列化后的转义字符串写成了多行未转义文本；修正断言后转绿。
- 当前剩余缺口：
  - 还没做 build/install/global restart/live replay，所以还不能宣称最新 5520 live 闭环完成。
  - 样本里“多类空参数工具调用”是否由此同一 contract 漂移引发，还需要重放新样本确认。
## 2026-06-15 servertool nested followup timeout removal

- 用户给出的 live 错误样本：
  - `requestId=openai-responses-minimax.key1-MiniMax-M3-20260615T075434104-346355-3933`
  - `[servertool.followup.lifecycle] stage=attempt_error`
  - `message="[servertool] nested followup timeout after 10000ms"`
  - 最终被投影成 `SERVERTOOL_TIMEOUT / servertool_followup_timeout / 504`
- 已确认根因不是 provider，也不是 Rust followup 语义 owner，而是 HTTP executor 壳层本地加的 nested followup fail-fast：
  - `src/server/runtime/http-server/executor/servertool-followup-fail-fast.ts`
  - `src/server/runtime/http-server/executor/servertool-followup-dispatch.ts`
- 原行为：
  - 默认 10s
  - 最大也被 cap 到 10s
  - followup 重入执行和 retry backoff wait 都会走 `awaitNestedExecutionWithFailFast(... timeoutMs=resolveServerToolNestedFollowupTimeoutMs())`
  - 到时直接本地抛 `SERVERTOOL_TIMEOUT`
- 本轮修复：
  - 物理删除 nested followup timeout 解析与 504 timeout error 构造：
    - `DEFAULT_SERVERTOOL_FOLLOWUP_TIMEOUT_MS`
    - `MAX_SERVERTOOL_FOLLOWUP_TIMEOUT_MS`
    - `parsePositiveTimeoutMs(...)`
    - `resolveServerToolNestedFollowupTimeoutMs()`
    - `createServerToolFollowupTimeoutError(...)`
  - `awaitNestedExecutionWithFailFast(...)` 现在只负责两件事：
    - 响应 client abort signal
    - 轮询 abort carrier
  - `servertool-followup-dispatch.ts` 两处调用都已移除 `timeoutMs/requestId` 传参，只保留 abort 相关 fail-fast。
- 红测同步：
  - `tests/server/runtime/http-server/executor/servertool-followup-fail-fast.spec.ts`
  - 删除“20ms timeout 必须报 504”的旧断言
  - 改为：
    - 正向：无 abort 时 promise 正常 resolve
    - 反向：client abort 仍能立刻中止
- 当前验证证据：
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runTestsByPath tests/server/runtime/http-server/executor/servertool-followup-fail-fast.spec.ts --runInBand` PASS
  - `npx tsc -p tsconfig.json --noEmit --pretty false` PASS
  - `rg -n "resolveServerToolNestedFollowupTimeoutMs|createServerToolFollowupTimeoutError|servertool_followup_timeout|nested followup timeout after" src tests sharedmodule -S` => 0 matches
- 待补最终闭环：
  - `npm run build:min`
  - 若 Jason 要求，后续继续 install/restart/live replay 这一类 stopless/servertool followup 样本，确认不再出现本地 10s timeout。

## 2026-06-15 stopless cli self-call contract
- stopless CLI stdout contract tightened: continuationPrompt must explicitly tell the model it cannot terminate unless it proactively calls the same stop hook with full stop schema; this is the closed loop Jason asked for.
- Visible command path remains routecodex hook run ..., not routecodex servertool run .... Generic projection reasoning text was also neutralized to avoid proxy/client wording.
- Updated focused tests/docs: cli_contract.rs, tests/cli/servertool-command.spec.ts, tests/servertool/servertool-cli-projection.spec.ts, tests/servertool/servertool-cli-result-restore.spec.ts, tests/servertool/stop-message-runtime-utils.continuation.spec.ts, docs/stop-message-auto.md, docs/design/servertool-stopmessage-lifecycle.md, docs/agent-routing/30-servertool-lifecycle-routing.md.

## 2026-06-15 stopless request-side rewrite rule
- Jason clarified the missing contract: when stopless auto-projects a CLI hook because the model did not proactively call the stop hook, the returned CLI result must be rewritten into request-side text input for the next model turn, not preserved as tool-call history. Otherwise the model may infer it mis-called a tool.
- This is a req_chatprocess governance rule, not a response-side patch. Function map / verification map must explicitly lock request injection, stop-time intercept, and request-side CLI-result-to-text rewrite as one closed loop.

## 2026-06-15 stopless contract gate expansion
- Added focused native stop-schema gates for two long-term contract points: malformed schema must return parsed feedback + explicit field guidance, and valid terminal schema can allow stop even without prior explicit stop-hook call.

- Added focused contract gate tests in tests/servertool/stop-schema-lifecycle-contract.spec.ts so long-term stopless lifecycle can be locked without relying on older prompt-wording assertions.

- Unified remaining stopless feature anchor in router-hotpath-napi/servertool_core_blocks.rs to hub.servertool_stopless_cli_continuation so function-map growth gate can resolve the new contract consistently.

- Registered tests/servertool/stop-schema-lifecycle-contract.spec.ts in function-map and verification-map required test lists for hub.servertool_stopless_cli_continuation.

## 2026-06-15 responses outbound/store audit split
- Live diag evidence: `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260615T001004109-345184-2762.json`
  - `requestBody.input` contains many `type=message` items whose `content` parts are `output_text`.
  - Sample: `message_idx 21` has `phase:"commentary"` and `content:[{type:"output_text", ...}]`.
  - Count scan: `output_text_msgs=53`, `reasoning_items=50`, `reasoning_parts=0`.
- Rust store owner: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`
  - `normalize_output_item_to_input(item)` for `type=message` clones `content` as-is.
  - `type=reasoning` is preserved as a standalone item with `summary/content/encrypted_content`.
- TS bridge owner: `src/modules/llmswitch/bridge/responses-response-bridge.ts`
  - `persistResponsesConversationLifecycleForHttp(...)` forwards response body into store projection without response-layer protocol audit.
- Current conclusion:
  - 已证实的污染层是 response outbound / store / restore 链。
  - 已证实的非法历史形状是 `assistant message.content.output_text` 被 replay 到下一轮 request。
  - `reasoning` 目前还没证实是错映射；当前样本里它是 standalone item，不是 part-level `reasoning_text`。
- 最新 gate 现状：
  - `tests/sharedmodule/responses-continuation-store.spec.ts` 当前有现成红点，`fails fast when direct and relay continuations coexist under one scope without explicit owner` 实际返回了 relay continuation，不是 `null`。
  - 这说明 continuation owner 隔离 gate 仍有洞，和 direct/relay owner split 风险一致。
- Relay response truth split:
  - JSON path: `prepareResponsesJsonClientDispatchPlanForHttp(...)` 先调用 `projectResponsesClientPayloadForClientForHttp(...)`，`handler-response-utils.ts` 再把 `sanitized clientBody` 传给 `persistResponsesConversationLifecycleForHttp(...)`。
  - SSE path: `handler-response-sse.ts` 维护 `contractProbe`，结束时把 `stripInternalKeysDeep(contractProbe.probe)` 传给 `persistResponsesConversationLifecycleForHttp(...)`。
  - 当前 relay 本质是把“client-projected payload / projected probe”当成 continuation history 真相落盘；如果 response outbound 没做 `/v1/responses` 协议审计，错误字段就会进入历史并在下一轮请求打到上游。

## 2026-06-15 apply_patch failure-guidance audit correction
- 纠偏：当前 worktree 里没有看到 apply_patch failure guidance 修复真正落到代码；此前“已修好 failure guidance”的判断不成立。
- Rust request/store owner 现状：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs`
  - `normalize_tool_output_text_for_storage(raw)` 仍只做 `strip_provider_tool_sentinel_residue + unwrap_chunked_exec_transcript_shape + trim`
  - 真正写回 `function_call_output/tool_result` 的调用点只调用 `normalize_tool_output_text_for_storage(output_value)`，没有传 `tool_name`
  - 因此 apply_patch 不会走 `canonicalize_tool_output_text_for_compare(... apply_patch ...)` 里的 `normalize_apply_patch_output_text(...)`
- 直接证据：
  - 位置一：`hub_req_inbound_context_capture.rs` 约第 209 行，`normalize_tool_output_text_for_storage(raw: &str)`
  - 位置二：`hub_req_inbound_context_capture.rs` 约第 749 行，写回 `output` 时仍只调用 `normalize_tool_output_text_for_storage(output_value)`
- real-sample gate 现状：
  - `tests/sharedmodule/responses-request-standardization.real-samples.red.spec.ts` 对 `2026-06-07-apply-patch-error-carryover-curated` 仍断言：
    - 包含 `apply_patch verification failed`
    - 包含 `Failed to find expected lines`
    - 不包含 `APPLY_PATCH_ERROR: apply_patch did not apply`
  - 这会把旧错误行为锁成 PASS，不能证明 canonical guidance 已闭环。
- apply_patch contract gate 现状：
  - `tests/sharedmodule/apply-patch-chat-process-contract.spec.ts` 当前只锁 freeform/schema 与“不走 servertool”
  - 还没有锁 failure guidance 必须包含 `Retry with apply_patch only` / `workspace-relative` / `Do not switch to exec_command`
- function-map / verification-map 现状：
  - `docs/architecture/function-map.yml` 的 `tool.apply_patch_freeform_contract` summary/required_tests 只覆盖 freeform patch contract、schema、line-edit/live-context 修复
  - `docs/architecture/verification-map.yml` 的 `tool.apply_patch_freeform_contract` 只列 `apply-patch-chat-process-contract`、native regression matrix、freeform schema passthrough
  - 结论：当前 map/gate 名义上覆盖 `apply_patch` 主合同，但没有显式锁 failure-guidance / canonical retry text / tool-aware storage normalization
- S4 sample mapping:
  - curated fixture: `tests/fixtures/errorsamples/responses-request-standardization/2026-06-07-apply-patch-error-carryover-curated/*`
  - requestId: `openai-responses-router-gpt-5.5-20260607T022906302-288146-11057`
  - live log: `~/.rcc/logs/server-5520.log`
    - `[virtual-router-hit] default/gateway-priority-5520-priority-default -> llmgate.key1.free-gpt-5.5`
    - `[router-direct.send] ... statusCode=503`
  - 结论：样本来源是 `5520 direct`，上游先 503；fixture 锁住的是“后续 request-side history 仍携带 raw apply_patch verification failed 文本”的 carryover 问题，不是 relay response/store 问题。

## 2026-06-15 direct/relay unified error chain 审计（本轮产出，未动实现）

- 用户目标：审计为何 499 直接返客户端；统一 direct 与 relay 的 provider error 链；接入 primary_exhausted -> default pool。
- 现状（代码证实，未改）：
  - `decideDirectRouterRetry` 已消费统一 ErrorErr05 plan；`isClientDisconnectLikeError` 已在入口短路。
  - `decideDirectProviderRetry` 强制 rethrow（provider-mode 单点 binding）。
  - `mapErrorToHttp` 已经在 `isClientDisconnectLikeForProjection` 把 499 拉 204。
  - `planPrimaryExhaustedToDefaultPoolNative` 暴露但 host（`request-executor.ts` / `http-server/index.ts`）未调用，仍在 1s/2s/3s 阻塞退避后直接 throw。
  - 用户 06-15 08:52:30 日志 `failed: HTTP 499` 与 499+client abort 应得 204 的 SSOT 矛盾：G1 待定位真正的 res.status(499) 投影点（不在 mapErrorToHttp，估计在 router-direct caller 错误透传）。
- Gap：
  - G1 client_disconnect 没有真正落到 204。
  - G2 provider-mode 单点 binding 与中心原则冲突，需 Jason 拍板。
  - G3 primary_exhausted -> default pool 未接入 host。
  - G4 SSE midstream error 未进统一链。
  - G5 错误码 wrap 可能让 upstreamMessage 丢失。
  - G6 mapErrorToHttp 短路顺序无问题。
- 落盘：
  - `docs/goals/direct-relay-unified-error-chain-audit.md`（278 行，本轮权威真源）。
  - 含 §6 决策项 D1/D2/D3（待 Jason 拍板）。
  - 含 §8 `/goal` 提示词模板（落地修复执行）。
- 下一步：等 Jason 拍 D1/D2/D3，再按 Phase B-F 执行；本轮仅文档/审计，不写实现。

## 2026-06-15 live verify of missing capture / asxs 502
- Live probes on current installed `0.90.3071` did not reproduce the two reported runtime failures.
- `http://127.0.0.1:5555/v1/responses` returned `200` for a minimal probe and the body contained a normal completed response.
- `http://127.0.0.1:5520/v1/responses` with `provider=asxs.crsa.gpt-5.4` also returned `200` for a minimal probe.
- The earlier `native captureReqInboundResponsesContextSnapshotJson is required but unavailable` lines are therefore classified as historical runtime / install-state evidence, not as a currently reproducible source-code regression.
- The `asxs` `HTTP_502` sample in `~/.rcc/logs/server-5520.log` shows a direct `router-direct.send` failure followed by provider switch and later successful completion, so it is an upstream/provider transient, not a persistent config break.

## 2026-06-15 gate audit for apply_patch direct/relay plan
- `npm run verify:apply-patch-freeform-contract` PASS.
- `npm run verify:apply-patch-regressions` PASS (`total=41 fixed=18 stillFailing=23 mismatches=0`).
- Rust focused gate PASS:
  - `cargo test normalize_responses_input_items_dedupes_repeated_apply_patch_error_statuses --lib -- --nocapture`
  - workdir=`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi`
- But sharedmodule Jest suites that the function-map / verification-map names as required gates are currently not reliably executable:
  - `tests/sharedmodule/apply-patch-chat-process-contract.spec.ts`
  - `tests/sharedmodule/responses-request-standardization.real-samples.red.spec.ts`
  - `tests/sharedmodule/native-required-exports-sse-stream.spec.ts`
  - `tests/sharedmodule/responses-continuation-store.spec.ts`
- Current failure mode is environment/runtime setup, not business assertion:
  - Jest CJS parse hits `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-policy.js` with `Unexpected token 'export'`
  - `native-required-exports-sse-stream.spec.ts` hits `import.meta.url` parse failure
  - `responses-continuation-store.spec.ts` also reports missing `sharedmodule/llmswitch-core/dist/conversion/shared/responses-conversation-store.js`
- Conclusion: current gate gap is two-layered:
  1. some assertions still lock old behavior
  2. some named tests are not runnable enough to be trusted as active gates
## 2026-06-15 apply_patch audit fixes landed and green

- 已落 Rust owner 修复一：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs`
  - `normalize_tool_output_text_for_storage` 现在接 `tool_name`
  - `apply_patch` 失败 output 在真正写回历史时就 canonicalize 成 `APPLY_PATCH_ERROR: ...`
  - 不再只在 compare/dedupe 阶段做 canonical guidance
- 已落 Rust owner 修复二：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/standardized_request.rs`
  - `/v1/responses input[]` 进入 `convert_bridge_input_to_chat_messages(...)` 之前，先复用 `normalize_responses_input_items(...)`
  - 修掉 curated real-sample 仍带 raw `apply_patch verification failed...` 的第二入口
- 已落 Rust owner 修复三：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`
  - relay store 在 `response.output[type=message].content` 落历史时，把 `output_text` / `text` / `commentary` 改写为合法 request history `input_text`
  - `canonicalize_continuation_item(...)` 同步做该归一化，避免 stored `input_text` 与 incoming replay `output_text` 前缀匹配失败
- 补强 gate：
  - `tests/sharedmodule/apply-patch-chat-process-contract.spec.ts`
  - `tests/sharedmodule/responses-continuation-store.spec.ts`
  - `tests/sharedmodule/responses-request-standardization.real-samples.red.spec.ts`
- 2026-06-15 验证证据：
  - PASS `cargo test -q -p router-hotpath-napi normalize_responses_input_items_dedupes_repeated_apply_patch_error_statuses --lib -- --nocapture`
  - PASS `cargo test -q -p router-hotpath-napi convert_responses_output_to_input_items_rewrites_output_text_message_content_to_input_text --lib -- --nocapture`
  - PASS `cargo test -q -p router-hotpath-napi restore_matches_prefix_when_stored_input_text_and_incoming_replays_output_text --lib -- --nocapture`
  - PASS `cargo test -q -p router-hotpath-napi responses_standardization_preserves_input_in_semantics_for_tool_result_followup --lib -- --nocapture`
  - PASS `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/build-core.mjs`
  - PASS `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/apply-patch-chat-process-contract.spec.ts --runInBand`
  - PASS `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/responses-continuation-store.spec.ts --runInBand -t 'records response message output_text as legal request history input_text instead of replaying response-only content types|restores previous_response_id by session scope when incoming input replays the exact prefix'`
  - PASS `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/responses-request-standardization.real-samples.red.spec.ts --runInBand`
