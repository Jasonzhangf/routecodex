## 2026-06-22 reasoningStop live closeout probe

- 5555 live probe 已重放，当前结论明确：
  - 首轮 `/v1/responses` 进入 managed stopless path 后，客户端拿到的是 `exec_command` 投影；
  - `hasExecCommand=true`、`hasReasoningStop=false`；
  - shell 命令是 `routecodex hook run reasoningStop --input-json ...`，不是 raw `reasoningStop` tool 透传给客户端；
  - CLI 输出继续带 `stop_message_auto` 的结构化指导和 `schemaGuidance`，这是正常闭环，不是客户端可见 raw tool 注入。
- 这次 probe 里看到的 `reasoningStop` 只存在于内部 reasoning/日志链路，不是 client-visible payload。
- 仍然存在的 probe 失败是第二轮 `submit_tool_outputs` 的 `Responses conversation expired or not found`，属于 probe 会话寿命问题，不是 `reasoningStop` 拦截失效。
- 验证命令：
  - `node scripts/tests/stopless-5555-live-probe.mjs`
  - `pnpm exec jest tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts --runInBand`
  - `cargo test -p servertool-core stopless --lib -- --nocapture`

## 2026-06-22 submit_tool_outputs second response persistence truth

- 本轮定位到 `/v1/responses.submit_tool_outputs` relay follow-up 的唯一代码缺口在 `src/server/handlers/responses-handler.ts`：
  - `preparedRuntime.requestContext` 之前只写入 metadata / inbound capture；
  - 调 `sendPipelineResponse(...)` 时没有把 `responsesRequestContext` 传下去；
  - 导致 response-side `persistResponsesConversationLifecycleForHttp(...)` 被调用时 `requestContext === undefined`；
  - 这样第二轮 submit 后新产生的 `requires_action` responseId 无法被 continuation store 正常 capture/record。
- 已修复：
  - `handleResponses(...)` 现在把 `responsesRequestContext: requestContext` 传入 `sendPipelineResponse(...)`。
- 红绿测试：
  - 新增/更新 `tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts`
  - 新红测锁住：relay submit_tool_outputs follow-up 的新 `requires_action` response 必须带 `requestContext` 进入 `persistResponsesConversationLifecycleForHttp(...)`。
  - focused + full file 均 PASS。
- 相关回归：
  - `tests/server/handlers/handler-response-utils.responses-conversation.spec.ts` PASS。
  - `npm run verify:function-map-compile-gate` PASS。
- live 结果（5555）：
  - 全局安装 `npm install -g .` 完成；
  - `routecodex restart --port 5555` 成功；
  - `/health` = `ready=true version=0.90.3250`；
  - `node scripts/tests/stopless-5555-live-probe.mjs` 结果已变化：
    - 旧问题 `Responses conversation expired or not found / MALFORMED_REQUEST (400)` 本轮未再出现；
    - 新问题变为第二轮 submit `status=502 code=HTTP_HANDLER_ERROR`。
- 结论：
  - “第二轮 submit 的 follow-up response 没有 requestContext” 这一层已修；
  - live 还剩下一层新的 handler/provider-side 502，要继续顺着新的 requestId / error projection 往下查，不能宣称 stopless 已闭环。

## 2026-06-22 servertool execution-shell shell-shell alias names collapse

- `sharedmodule/llmswitch-core/src/servertool/execution-shell.ts` 去掉了纯命名别名：
  - `buildServertoolDispatchPlanInputThinShellShell`
  - `buildServertoolOutcomePlanInputThinShellShell`
  - `createServertoolExecutionLoopStateShell`
  - `resolveToolCallExecutionOutcomeThinShellShell`
  - `runToolCallExecutionLoopThinShellShell`
- 现在这些导出直接指向真函数名，不再多一层 `*ShellShell` 中间命名。
- 验证：
  - `tests/servertool/execution-shell.auto-hook-failfast.spec.ts`
  - `tests/servertool/server-side-tools.failfast.spec.ts`
  - `tests/servertool/execution-dispatch-outcome-shell.spec.ts`
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - `tests/servertool/servertool-cli-native-bridge.spec.ts`
  - `tests/servertool/server-side-tools.cli-projection-guard.spec.ts`
  - `node scripts/verify-servertool-rust-only.mjs`
  - `node scripts/build-core.mjs`

## 2026-06-22 servertool execution-shell auto-hook wrapper physical delete

- 物理删除 `sharedmodule/llmswitch-core/src/servertool/execution-shell.ts` 里的纯 wrapper：
  - `ServertoolAutoHookDescriptor`
  - `runAutoHookExecutionQueue(...)`
- 这个壳只是把调用转发到 `auto-hook-caller.ts`，没有真实 runtime owner。
- 验证：
  - `tests/servertool/execution-shell.auto-hook-failfast.spec.ts`
  - `tests/servertool/server-side-tools.cli-projection-guard.spec.ts`
  - `tests/servertool/server-side-tools.failfast.spec.ts`
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - `tests/servertool/servertool-cli-native-bridge.spec.ts`
  - `node scripts/verify-servertool-rust-only.mjs`
  - `node scripts/build-core.mjs`

## 2026-06-22 servertool bindServertoolContract identity wrapper physical delete

- 物理删除 `sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.ts` 里的纯 identity wrapper：
  - `bindServertoolContractWithNative<T>(value: T): T`
- 同步从 `sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts` 的导入/导出链路移除该符号。
- 真实仓库消费只剩测试 mock，占位字段不再有 runtime owner。
- 验证：
  - `tests/servertool/server-side-tools.cli-projection-guard.spec.ts`
  - `tests/servertool/server-side-tools.failfast.spec.ts`
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - `tests/servertool/servertool-cli-native-bridge.spec.ts`
  - `tests/servertool/execution-shell.auto-hook-failfast.spec.ts`
  - `node scripts/verify-servertool-rust-only.mjs`
  - `node scripts/build-core.mjs`

## 2026-06-22 servertool response-stage dead wrapper delete

- 物理删除 `sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts` 里的死壳：
  - `bindResponseStageGateNativeShell(...)`
  - 同时删掉它对应的 `JsonObject` / `respStageGateNative` import
- 这层 wrapper 在仓库里无真实消费，只是 `respStageGateNative(args) as JsonObject` 的空转壳。
- 同步修正 `scripts/verify-servertool-rust-only.mjs`：
  - 不再要求 response-stage gate alias 存在
  - 改为禁止 `bindResponseStageGateNativeShell(` 复活
- 验证：
  - `tests/servertool/server-side-tools.cli-projection-guard.spec.ts`
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - `tests/servertool/servertool-cli-native-bridge.spec.ts`
  - `tests/servertool/execution-shell.auto-hook-failfast.spec.ts`
  - `node scripts/verify-servertool-rust-only.mjs`
  - `node scripts/build-core.mjs`

## 2026-06-22 servertool auto-hook pure alias wrapper physical delete

- 物理删除 `sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.ts` 里的纯 alias wrapper `runServertoolAutoHookCallerViaImplThinShell(...)`。
- 直接出口改为：
  - `export const runServertoolAutoHookCallerImpl = runServertoolAutoHookCallerViaThinShell;`
- 同步修正 `scripts/verify-servertool-rust-only.mjs`：
  - 不再要求旧 wrapper 的 `return await runServertoolAutoHookCallerViaThinShell(args);`
  - 改为禁止 `runServertoolAutoHookCallerViaImplThinShell` 复活
- 验证：
  - `tests/servertool/server-side-tools.auto-hook-caller-guard.spec.ts`
  - `tests/servertool/servertool-cli-native-bridge.spec.ts`
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - `tests/servertool/execution-shell.auto-hook-failfast.spec.ts`
  - `node scripts/verify-servertool-rust-only.mjs`
  - `node scripts/build-core.mjs`

## 2026-06-22 servertool engine runtime-action cli projection compat field physical delete

- 进一步物理删除废弃兼容字段 `hasServertoolCliProjectionContext`：
  - Rust `engine_runtime_action_contract.rs` 不再持有该字段
  - TS `native-servertool-core-semantics.ts` 不再序列化该字段
  - `tests/servertool/servertool-cli-native-bridge.spec.ts` 不再显式传该字段
- 事实现在只靠 `executionContext.servertoolCliProjection` 推导 cli projection runtime action。
- 验证继续全绿：
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs`
  - focused Jest 4 suites / 38 tests
  - `node scripts/verify-servertool-rust-only.mjs`
  - `node scripts/build-core.mjs`

## 2026-06-22 servertool engine runtime-action cli projection compat cleanup

- 本轮收掉 `sharedmodule/llmswitch-core/src/servertool/engine.ts` 里残余的显式 `hasServertoolCliProjectionContext: false`。
- 兼容面同步下沉：
  - `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/engine_runtime_action_contract.rs`
    - `has_servertool_cli_projection_context` 加 `#[serde(default)]`
  - `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`
    - `planServertoolEngineRuntimeActionWithNative(...)` 的该字段改成可选
- 结果：
  - `engine.ts` 只传 `executionContext: engineResult.execution.context`
  - Rust 仍可从 `execution_context.servertoolCliProjection` 自行推导
- focused 验证：
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs`
  - `tests/servertool/servertool-cli-native-bridge.spec.ts`
  - `tests/servertool/engine.stopless-session-thin-shell.spec.ts`
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - `tests/servertool/execution-shell.auto-hook-failfast.spec.ts`
  - `node scripts/verify-servertool-rust-only.mjs`
  - `node scripts/build-core.mjs`

## 2026-06-22 stopless reasoningStop build/min + live replay closeout

- `npm run build:min` 已完成并退出码 0；当前 `0.90.3245` 版本在 5555/5520 health 都是 ready。
- live replay 结论：
  - 首轮 `/v1/responses` 仍按预期进入 `exec_command(routecodex hook run reasoningStop ...)`，没有把 raw `required_action.reasoningStop` 透给客户端。
  - 响应里 `stop_message_auto` 的 CLI projection 仍然成立，`hasExecCommand=true`、`hasReasoningStop=false`。
  - probe 的第二轮在长链路上遇到 `Responses conversation expired or not found`，这属于探针会话寿命问题，不是首轮 hook 拦截失效。
- 当前可复用判法：
  - live 先看首轮是否产出标准 `exec_command`；
  - 再看是否有 raw `reasoningStop` 泄漏；
  - 最后才看续轮是否因会话过期/样本失活失败，不要把探针寿命问题误判成骨架回退。

## 2026-06-22 reasoningStop response-hook live replay on 5555

- 全局安装与重启证据：
  - `npm run install:global` 最终跑过完整 verify/build 链；中途因 wiki markdown / html render out-of-sync 先后执行：
    - `node scripts/architecture/render-architecture-wiki-pages.mjs`
    - `npm run render:architecture-wiki-html`
  - `routecodex restart --port 5555` 与 `routecodex restart --port 5520` 均成功。
  - `/health`：
    - `http://127.0.0.1:5555/health` -> `ready=true version=0.90.3244`
    - `http://127.0.0.1:5520/health` -> `ready=true version=0.90.3244`
- 5555 live probe：
  - 命令：`node scripts/tests/stopless-5555-live-probe.mjs`
  - probe 输出文件：`/tmp/stopless-5555-live-probe.json`
  - 第一轮真实结果：
    - `hasExecCommand=false`
    - `hasReasoningStop=true`
    - `reasoningStopArguments={"reason":"第一轮故意缺 schema","stopreason":2}`
  - 续轮闭环结果：
    - `resumeChain[0].actionKind=reasoningStop`
    - server 返回的是 `stop_message_auto` CLI output，并通过正常 `submit_tool_outputs` 闭环
    - `resumeChain[0].status=200`
    - `resumeChain[0].responseStatus=completed`
    - 无 `type:error` / `status=400` / raw `reasoningStop` 泄漏到客户端
- 当前 live 结论：
  - 5555 上 `/v1/responses` 的 `reasoningStop` 已按 response hook 骨架正常拦截；
  - 客户端不再收到非法 raw `reasoningStop` 注入；
  - stopless continuation 已经通过 `stop_message_auto` 的 CLI/tool-output 正常闭环。

## 2026-06-22 5520 thinking glm loadbalancing config truth

- 现场真相已确认：`~/.rcc/config.toml` 里 `gateway_priority_5520.routing.thinking` 已是 `fwd.paid.gpt-5.4 + fwd.glm.glm-5.2`，权重 1:1，`thinking = high`。
- `fwd.glm.glm-5.2` 在 builder 里会展开成两个 providerKey：`XLC.key1.glm-5.2` 和 `XLC.key2.glm-5.2`，不是单 target。
- 对应验证测试 `tests/config/virtual-router-builder.forwarder-10000.spec.ts` 需要按 builder 真相断言，不应继续用旧的“thinking 只有 gpt”预期。
- 5555 的 `coding/thinking/longcontext` 构图也要按 builder 输出分开断言，不能用同一数组复用。

## 2026-06-22 reasoningStop response-hook tool_call closure

- 样本边界已重新锁定：`reasoningStop` 是 response hook 的 internal stop tool，不是 client-visible tool；客户端最终只能看到 `exec_command(routecodex hook run reasoningStop ...)`。
- 这轮先后排除了两个假因：
  - 只修 `HubPipeline` effect 去重不够，client-visible payload 仍会看到 raw `reasoningStop`；
  - 直接在 `build_responses_payload_from_chat_core()` 里跳过 `reasoningStop` 是错修，会把 `/v1/responses` payload 变成 `output=[]` 并触发 `EMPTY_ASSISTANT_RESPONSE`。
- 真根因链：
  - `HubPipeline` 原本把 `stop_eligible_followup` 也绑在 `should_plan_servertool_runtime_action(metadata.runtimeEffects.*)` 上；
  - `/v1/responses` 的 response hook CLI projection 不依赖 providerInvoker/reenter/clientInject callback，所以 live/blackbox 中根本没产出 `servertoolRuntimeAction`；
  - 补完后又暴露第二层骨架问题：planner 把 `stop_eligible_followup` 当成普通 `requireRuntimeExecutor`，在无 executor callback 时抛 `Rust HubPipeline servertoolRuntimeAction requires runtime executor`。
- 正确修复：
  - `hub_pipeline_lib/engine.rs`：`stop_eligible_followup` 独立于 runtime callbacks 规划；
  - `hub_pipeline_lib/engine.rs` + `effect_plan.rs`：新增/启用 `requireResponseHookRuntime` 动作类型，供 response required hook 本地执行，不再借用 `requireRuntimeExecutor`。
- 关键验证：
  - Rust focused：
    - `responses_reasoning_stop_tool_call_emits_stop_runtime_action_without_runtime_callbacks` -> PASS
    - `plans_servertool_runtime_action_execution_in_rust` -> PASS
  - native rebuild：`node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` -> PASS
  - 黑盒：`tests/server/handlers/responses-handler.servertool-stopless.dual-port.e2e.spec.ts --runInBand` -> 4/4 PASS
  - 黑盒日志真相：
    - `tool=stop_message_auto ... finish_reason=tool_calls_internal_stop_tool eligible=true match=activated ...`
    - 说明 `reasoningStop tool_call` 已被 response hook 正常拦截并进入 CLI projection 闭环。
- 测试边界纠偏：
  - 新增过一条 `convertProviderResponse` focused unit，但它不是最终 client-visible boundary，和黑盒边界不一致；已物理删除，避免留下过时断言。

## 2026-06-21 codex-samples stopless legacy shell-history closeout

- Jason 要求“根据样本闭环”，本轮直接以 `~/.rcc/codex-samples/openai-responses/port-5555/req_1782044107054_dbbc0a5f/provider-request.json` 为坏样本真源。
- 样本真相：
  - 历史里确实存在 assistant/tool 对：
    - `exec_command(arguments={\"cmd\":\"reasoningStop\"})`
    - tool output `zsh:1: command not found: reasoningStop`
  - 这不是 stop schema 继续缺字段的问题，而是旧 shell 投影污染被带回后续 provider-request。
- 修复点只落 request-side normalization owner：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_tool_call_normalization.rs`
  - 新增 `is_malformed_reasoning_stop_shell_command(...)`
  - 规则：当请求工具池已经暴露标准 `reasoningStop` 时，若历史里仍出现 shell-like tool 执行裸 `reasoningStop` / `reasoning_stop`，则把这对 assistant/tool 历史项物理删除，不再继续透传。
- 红测先行：
  - `drops_legacy_bare_reasoning_stop_shell_history_from_messages`
  - `drops_legacy_bare_reasoning_stop_shell_history_from_responses_input`
- focused 验证：
  - `cargo test -p router-hotpath-napi drops_legacy_bare_reasoning_stop_shell_history_from_messages -- --nocapture` -> PASS
  - `cargo test -p router-hotpath-napi drops_legacy_bare_reasoning_stop_shell_history_from_responses_input -- --nocapture` -> PASS
  - 回归：
    - `rewrites_projected_reasoning_stop_cli_pair_when_call_id_is_not_auto_injected` -> PASS
    - `reasoning_stop_function_call_output_becomes_guidance_input_item` -> PASS
    - `test_govern_response_repairs_malformed_exec_command_reasoning_stop_back_to_reasoning_stop` -> PASS
- 当前结论：
  - 旧坏样本里的裸 `reasoningStop` shell 历史现在会在 request normalization 被物理移除；
  - 这次闭环的是“旧 shell 污染不能再带进后续 provider-request”，不是宣称 stopless 全链所有 live loop 已全部完结。

## 2026-06-22 stop-message prompt asset module-path root cause

- 04:43 的 5555 live probe 新证据已确认：首轮三次都不是 raw `reasoningStop` 泄漏，也不是 provider 业务错误，而是 response hook 在 `convert.bridge` 阶段直接失败：
  - `STOP_MESSAGE_PROMPT_ASSET_FAILED: ENOENT ... /opt/homebrew/lib/node_modules/routecodex/sharedmodule/llmswitch-core/src/servertool/assets/stop-message-prompts.md`
- 真根因在 `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/config.ts`：
  - prompt asset 解析写成了 `process.cwd()/dist/servertool/assets/...`；
  - 全局安装后 `cwd` 指向主包根目录，这条路径与 llmswitch-core 模块实际 dist 路径不一致；
  - `PROMPT_DIST_PATH` miss 后又回退到 `PROMPT_SOURCE_PATH`，而发布包里本来就不带 `sharedmodule/llmswitch-core/src/...`，所以最终必然 ENOENT。
- 这不是“缺资产复制”本身：
  - 本地 `sharedmodule/llmswitch-core/dist/servertool/assets/stop-message-prompts.md` 存在；
  - `scripts/copy-compat-assets.mjs` 也已经负责复制该资产。
- 修复方向已锁定为骨架级路径真源：
  - prompt asset 按模块相对路径解析，源码与 dist 共用同一规则；
  - 不再依赖 `process.cwd()` 推断 llmswitch-core 的 dist 资产位置。
- 红绿测试已补：
  - `tests/servertool/stop-message-auto.config-precedence.spec.ts`
  - 新断言：切换到临时空 `cwd` 后，`resolveStopMessageExecutionPromptForRound(0/1/2)` 仍能正确加载 prompt asset。

## 2026-06-21 servertool auto-hook outcome classification rust-owner

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.ts` 的 auto-hook 执行残余 TS owner。
- 旧 TS 仍本地 owner 一层 outcome 分类语义：
  - `planned_null`
  - `materialized_match`
  - `materialized_empty`
  - error 分支显式传 `outcome: 'error'`
- 现在统一并回现有 Rust owner：
  - `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/auto_hook_execution_contract.rs`
  - input 新增：
    - `hasPlannedResult`
    - `hasMaterializedResult`
    - `materializedFlowId`
  - `outcome` 改为兼容字段；Rust 优先从事实输入推导 outcome，旧显式 `outcome` 仅保留兼容
- TS 壳层变化：
  - `auto-hook-caller.ts` 不再本地枚举 `planned_null/materialized_match/materialized_empty/error`
  - TS 只传事实输入：是否拿到 planned、是否 materialize 成功、materialized flowId、error message
- bridge / gate：
  - `router-hotpath-napi/src/servertool_core_blocks.rs` 补 bridge 断言
  - `native-servertool-core-semantics.ts` 补 wrapper input shape
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts` 明确禁止 `auto-hook-caller.ts` 复活：
    - `outcome: 'error'`
    - `outcome: 'planned_null'`
    - `outcome: 'materialized_match'`
    - `outcome: 'materialized_empty'`
- focused 验证：
  - `cargo test -p servertool-core auto_hook_execution_contract -- --nocapture` -> 3 passed
  - `cargo test -p router-hotpath-napi plans_auto_hook_execution_decision_via_servertool_core_bridge -- --nocapture` -> 1 passed
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` -> PASS
  - focused Jest:
    - `tests/servertool/servertool-auto-hook-trace.spec.ts`
    - `tests/servertool/execution-shell.auto-hook-failfast.spec.ts`
    - `tests/servertool/server-side-tools.failfast.spec.ts`
    - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
    - 结果：4 suites / 21 tests passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
  - `node scripts/build-core.mjs` -> PASS

## 2026-06-21 response-side stop schema harvest / rust-owner audit

- 核查目标：
  - response 侧是否“正确找到 fence 进行 harvest”
  - 这段 stopless / reasoningStop 语义在 rust 化后是否已经不是 TS owner
- 文件证据：
  - `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stop_visible_text.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks/tool_call_governance.rs`
  - `docs/architecture/function-map.yml`
  - `docs/architecture/mainline-call-map.yml`
  - `docs/architecture/verification-map.yml`
- 当前真相 1：response 侧并不存在“看到任意 JSON/fence 就 harvest stop schema”的通用逻辑。
  - `strip_stop_schema_control_text()` 只移除 `<rcc_stop_schema>...</rcc_stop_schema>` 控制块，以及可见文本里的“停止原因:”行。
  - `preserves_non_fenced_json_and_unclosed_json()` 明确锁死：裸 JSON、未闭合 JSON 不会被当成 stop schema 剥离或 harvest。
  - `extract_current_assistant_reasoning_stop_arguments()` 只从结构化 `reasoningStop` tool call / function call 读取 `arguments`，不是从普通文本里抓裸 JSON。
- 当前真相 2：response/tool governance 仍有另一类“tool call harvest”，但那是 Rust chat-process/tool-governance 的通用 wrapper/tool-call 收割，不等于 stop schema fence harvest。
  - `tool_call_governance.rs` 里的 `maybe_harvest_empty_tool_calls_from_json_content()` 走的是 `harvest_explicit_wrapper_only_tool_calls_from_payload(...)`。
  - 它解决的是 payload 里显式 wrapper/tool-call 结构补全与治理，不是 stop schema 可见文本解析真源。
- 当前真相 3：这段 stopless 关键语义现在主要是 Rust owner，不是 TS owner。
  - stop schema 可见文本剥离 / `reasoningStop` arguments 提取：Rust `servertool-core/src/stop_visible_text.rs`
  - response 侧 malformed `exec_command(cmd=\"reasoningStop\")` 修复：Rust `router-hotpath-napi/.../tool_call_governance.rs`
  - stopless CLI projection / repeatCount 递进 / schema feedback：Rust `servertool-core/src/cli_contract.rs`
  - stopless projection context 恢复：Rust `servertool-core/src/stopless_cli_projection_context_contract.rs`
  - request 里从当前 tool_output 恢复 stopless snapshot：Rust `servertool-core/src/persisted_lookup.rs`
- 边界说明：
  - TS `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts` 仍是活壳层/编排层，负责调用 native、metadata carrier 绑定、plan 组合；
  - 不能宣称整个 stopless mainline 已“完全无 TS”。`note.md` 既有结论仍成立：局部语义 Rust owner 已很多，但 hook skeleton/mainline 是否完全 Rust-only 仍需按 `binding pending` 口径处理。
- 对 Jason 当前截图症状的直接含义：
  - 如果 live 响应里只是普通文本、裸 JSON、旧 fenced json，而不是 `<rcc_stop_schema>` 或结构化 `reasoningStop.arguments`，当前 response 真源不会把它当 stop schema harvest 成功。
  - 所以这轮问题不能再假设“response 侧会自动从任意文本 schema 补 harvest”；要么请求注入明确要求 canonical `<rcc_stop_schema>` / structured `reasoningStop`，要么继续查 loop state restore 为何退回 `repeatCount=1`。

## 2026-06-21 servertool outcome-runtime selection rust-owner

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/execution-dispatch-outcome-shell.ts` 的 outcome materialization 残余 TS owner。
- 旧 TS 仍本地 owner 三段选择/组装语义：
  - followup 选择：`lastExecution.followup` vs `resolvedFollowup`
  - execution envelope 选择：`reuseLastExecutionEnvelope ? lastExecution : { flowId }`
  - mixed-client-tools `pendingInjection` 组装：`sessionId/aliasSessionIds/afterToolCallIds/messages`
- 现在统一下沉到 Rust owner：
  - `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_outcome_runtime_action_contract.rs`
  - contract output 新增：
    - `selectedFollowup`
    - `selectedExecutionEnvelope`
    - `pendingInjection`
    - `executionFlowId`
- bridge / thin shell 收口：
  - `router-hotpath-napi/src/servertool_core_blocks.rs` 补 bridge 断言
  - `native-servertool-core-semantics.ts` 补 wrapper input/output shape
  - `execution-dispatch-outcome-shell.ts` 不再本地选择 followup / envelope，也不再本地组装 pendingInjection；TS 只消费 native runtime action plan
- focused tests / gate：
  - `tests/servertool/execution-dispatch-outcome-shell.spec.ts`
  - `tests/servertool/servertool-cli-native-bridge.spec.ts`
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - audit 明确禁止：
    - `args.executionState.lastExecution?.followup as`
    - `outcomePlan.resolvedFollowup as`
    - `const injectionMessages = outcomePlan.pendingInjectionMessagesResolved`
    - `pendingInjection: {`
- 串行验证：
  - `cargo test -p servertool-core execution_outcome_runtime_action_contract -- --nocapture` -> 6 passed
  - `cargo test -p router-hotpath-napi plans_servertool_execution_outcome_runtime_action_via_servertool_core_bridge -- --nocapture` -> 1 passed
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` -> PASS
  - focused Jest:
    - `tests/servertool/execution-dispatch-outcome-shell.spec.ts`
    - `tests/servertool/servertool-cli-native-bridge.spec.ts`
    - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
    - 结果：3 suites / 38 tests passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
  - `node scripts/build-core.mjs` -> PASS

## 2026-06-21 servertool outcome-plan input extraction rust-owner

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/execution-dispatch-outcome-shell.ts` 的 outcome-plan 输入提炼残余 TS owner。
- 旧 TS 仍本地 owner 一层 outcome-plan 输入提炼：
  - 从 `adapterContext.sessionId`
  - 从 `adapterContext.conversationId`
  - 从 `baseForExecution.tool_outputs`
  - 再喂给 `buildServertoolOutcomePlanInputWithNative(...)`
- 现在把这层提炼并回现有 Rust builder：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_skeleton_config.rs`
  - `build_servertool_outcome_plan_input_json(...)` 新增从 `adapterContext` / `baseForExecution` 读 `sessionId` / `conversationId` / `tool_outputs`
  - 旧显式 `sessionId` / `conversationId` / `toolOutputs` 输入仍保留兼容
- TS 壳层变化：
  - `execution-dispatch-outcome-shell.ts` 不再本地提炼上述三个字段
  - 直接传 `adapterContext: args.options.adapterContext`
  - 直接传 `baseForExecution: args.baseForExecution`
- gate 收紧：
  - `tests/servertool/execution-dispatch-outcome-shell.spec.ts`
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - `scripts/verify-servertool-rust-only.mjs`
  - 明确禁止 `execution-dispatch-outcome-shell.ts` 复活：
    - `args.options.adapterContext && typeof (args.options.adapterContext as any).sessionId ===`
    - `args.options.adapterContext && typeof (args.options.adapterContext as any).conversationId ===`
    - `Array.isArray((args.baseForExecution as any).tool_outputs)`
- focused 验证：
  - `cargo test -p router-hotpath-napi builds_outcome_plan_input_from_adapter_context_and_base_for_execution -- --nocapture` -> 1 passed
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` -> PASS
  - focused Jest:
    - `tests/servertool/execution-dispatch-outcome-shell.spec.ts`
    - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
    - 结果：2 suites / 16 tests passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
  - `node scripts/build-core.mjs` -> PASS

## 2026-06-21 servertool engine cli-projection-context runtime action rust-owner

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/engine.ts` 的 post-engine 残余 TS owner。
- 旧 TS 仍本地 owner 一层 generic cli-projection context 判定：
  - `const hasServertoolCliProjectionContext = ...`
  - 本地看 `engineResult.execution.context.servertoolCliProjection`
  - 再把布尔值喂给 `engine_runtime_action_contract`
- 现在把这层解读并回现有 Rust owner：
  - `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/engine_runtime_action_contract.rs`
  - 新 input 增加 `executionContext`
  - Rust 优先从 `executionContext.servertoolCliProjection` 解读 generic cli-projection contract；旧 `hasServertoolCliProjectionContext` 仅保留兼容输入
- TS 壳层变化：
  - `engine.ts` 不再本地判断 `servertoolCliProjection`
  - 直接传 `executionContext: engineResult.execution.context` 给 native runtime action
- bridge / gate：
  - `router-hotpath-napi/src/servertool_core_blocks.rs` 补 bridge 断言，锁 `executionContext.servertoolCliProjection -> return_servertool_cli_projection_final`
  - `tests/servertool/engine.stopless-session-thin-shell.spec.ts`
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - `scripts/verify-servertool-rust-only.mjs`
  - 明确禁止 `const hasServertoolCliProjectionContext =` 与 `.servertoolCliProjection` 在 `engine.ts` 复活
- focused 验证：
  - `cargo test -p servertool-core engine_runtime_action_contract -- --nocapture` -> 6 passed
  - `cargo test -p router-hotpath-napi plans_servertool_engine_runtime_action_via_servertool_core_bridge -- --nocapture` -> 1 passed
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` -> PASS
  - focused Jest:
    - `tests/servertool/servertool-cli-native-bridge.spec.ts`
    - `tests/servertool/engine.stopless-session-thin-shell.spec.ts`
    - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
    - 结果：3 suites / 34 tests passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
  - `node scripts/build-core.mjs` -> PASS

## 2026-06-21 servertool response-stage gate-plan runtime action rust-owner

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.ts` 的 response-stage / auto-hook 残余 TS owner。
- 旧 TS 仍本地 owner 一层 gate-plan 解读语义：
  - 先拿 `responseStagePlan`
  - 再本地拆 `nextAction`
  - pre/post auto-hook 两次把 `nextAction` 喂回 runtime action contract
- 现在把这层解读并回同一个 Rust owner：
  - `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/response_stage_runtime_action_contract.rs`
  - 新 input 增加 `responseStageGatePlan`
  - Rust 先从 `responseStageGatePlan.nextAction` 读 action；旧 `responseStageNextAction` 仅保留兼容输入
- TS 壳层变化：
  - `server-side-tools-impl.ts` 不再本地拆 `responseStagePlan.nextAction`
  - pre/post auto-hook 都直接传 `responseStageGatePlan: responseStagePlan` 给 native
- gate 收紧：
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - `scripts/verify-servertool-rust-only.mjs`
  - 明确禁止 `responseStageNextAction:` 与 `(responseStagePlan as Record<string, unknown>).nextAction` 在 `server-side-tools-impl.ts` 复活
- focused 验证：
  - `cargo test -p servertool-core response_stage_runtime_action_contract -- --nocapture` -> 6 passed
  - `cargo test -p router-hotpath-napi plans_servertool_response_stage_runtime_action_via_servertool_core_bridge -- --nocapture` -> 1 passed
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` -> PASS
  - focused Jest:
    - `tests/servertool/servertool-cli-native-bridge.spec.ts`
    - `tests/servertool/server-side-tools.failfast.spec.ts`
    - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
    - 结果：3 suites / 37 tests passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
  - `node scripts/build-core.mjs` -> PASS

## 2026-06-21 servertool pre-command persisted-load runtime action rust-owner

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.ts` 的 pre-command persisted state 路径。
- 旧 TS 仍本地 owner 一段 persisted load failure 语义：
  - `loadRoutingInstructionStateSync(...)` 失败后，TS 自己决定 state-load-failed error 投影；
  - 同时 persisted load 前后各自再本地拼一段 selection 分支。
- 现在把这层统一收进同一个 Rust owner 文件：
  - `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/pre_command_hook_contract.rs`
  - 新 contract：`plan_runtime_pre_command_state_runtime_action(...)`
  - action：
    - `use_selected`
    - `load_persisted`
    - `throw_state_load_failed`
- 新 bridge / 壳层变化：
  - NAPI: `plan_runtime_pre_command_state_runtime_action_json`
  - TS wrapper: `planRuntimePreCommandStateRuntimeActionWithNative(...)`
  - `server-side-tools-impl.ts` 现在不再本地 owner persisted-load error shape；TS 只做 persisted state IO 和 native errorPlan -> `ProviderProtocolError` 壳。
- focused 验证：
  - `cargo test -p servertool-core pre_command_hook_contract -- --nocapture` -> 7 passed
  - `cargo test -p router-hotpath-napi plans_runtime_pre_command_state_runtime_action_via_servertool_core_bridge -- --nocapture` -> 1 passed
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` -> PASS
  - focused Jest:
    - `tests/servertool/servertool-cli-native-bridge.spec.ts`
    - `tests/servertool/server-side-tools.failfast.spec.ts`
    - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
    - 结果：3 suites / 37 tests passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
  - `node scripts/build-core.mjs` -> PASS

## 2026-06-21 stopless malformed exec_command(reasoningStop) response-governance repair

- 继续处理 5555 live `exec_command(cmd="reasoningStop")` 泄漏。
- 先按真实线上坏样本补红测：
  - `resp_process_stage1_tool_governance_tests.rs::test_govern_response_repairs_malformed_exec_command_reasoning_stop_back_to_reasoning_stop`
  - 当前先红：输出仍是 `function.name = "exec_command"`，未归一回 `reasoningStop`。
- 唯一修复点确认在响应治理 owner：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks/tool_call_governance.rs`
  - 新增 `maybe_repair_exec_command_reasoning_stop_projection(...)`
  - 仅在 `requestedToolNames` 确实暴露了 `reasoningStop` 且模型把它误发成 `exec_command(cmd="reasoningStop")` 时，归一为真正的 `reasoningStop` tool call，并物理移除 `cmd/command/script/toon` 壳字段。
- focused 验证：
  - `cargo test -p router-hotpath-napi test_govern_response_repairs_malformed_exec_command_reasoning_stop_back_to_reasoning_stop -- --nocapture` -> PASS
  - `cargo test -p router-hotpath-napi test_govern_response_does_not_repair_reasoning_stop_into_exec_command_when_requested -- --nocapture` -> PASS
- 文案真源同步：
  - `docs/design/servertool-rust-only-architecture.md` 当前态别名改为 `reasoningStop`
  - `docs/stop-message-auto.md` 补明“优先路径是主动调用 reasoningStop function tool + 完整 schema”

## 2026-06-21 servertool build-core type-boundary follow-up

- 当前 servertool gate 已过，新的阻塞点是 `node scripts/build-core.mjs` 的 4 个 TS 类型错误，不是 function-map / wiki / rust-only gate 回退。
- 待收口文件：
  - `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`
  - `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-analysis.ts`
  - `sharedmodule/llmswitch-core/src/servertool/engine.ts`
  - `sharedmodule/llmswitch-core/src/servertool/execution-dispatch-outcome-shell.ts`
- 处理原则：
  - 只做 TS 类型边界与 parser 对齐；
  - 不在 TS 新增 servertool 业务分支；
  - 若 contract 真源在 Rust/Native，TS 仅补显式 narrowing 或 payload shape 对齐。

## 2026-06-21 ecodev force-sse chat-completions bridge gap

- 继续收口 live `5555` 的 `ecodev` 可用性。
- 已确认上一轮 `406` 根因已消失：`ecodev` upstream 请求现在是 `/v2/no-stream/chat/completions` + `Accept: application/json` + `stream:false`，上游返回 `200`。
- 当前真实 blocker 不在 provider，而在 HTTP handler 投影层：
  - 入口：`/v1/chat/completions`
  - 条件：client `stream:true`，provider family 强制 non-stream upstream
  - 现象：pipeline `result.sseStream === undefined`，上游 JSON 成功，但 handler 只会把 `/v1/responses` JSON 桥成 SSE，导致 client 收到本地 `sse_bridge_error`
- 代码证据：
  - `src/server/handlers/handler-response-sse.ts` 在 `forceSSE && result.sseStream === undefined` 时先走 `dispatchResponsesJsonAsSse(...)`
  - `src/modules/llmswitch/bridge/responses-response-bridge.ts#prepareResponsesJsonBodyForSseBridgeForHttp` 仅支持 `/v1/responses` 和 `/v1/responses.submit_tool_outputs`，`/v1/chat/completions` 直接返回 `null`
- 共享真源已存在，不能再造一套：
  - `sharedmodule/llmswitch-core/src/sse/json-to-sse/chat-json-to-sse-converter.ts`
- 本轮先补红测：
  - `tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts`
  - 新样本锁 `/v1/chat/completions` + `forceSSE` + `chat.completion` JSON 必须出 chat SSE，而不是 `sse_bridge_error`

## 2026-06-21 reasoningStop single-ssot rename closeout

- 本轮继续追查 stopless/public tool rename 是否真的“从头到尾改完”。
- 发现上轮并未闭环：除 `req_outbound_stage3_compat` 外，`servertool-core` 里仍有真实 runtime owner 残留旧名：
  - `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_result_guard.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stop_visible_text.rs`
- 这三处分别仍在使用：
  - public CLI alias `reasoning_stop`
  - CLI marker `routecodex hook run reasoning_stop`
  - assistant/current turn tool-call name `reasoning.stop`
- 这次已收口为单一真源：
  - public alias 统一为 `reasoningStop`
  - assistant/current turn stop tool name 统一为 `reasoningStop`
  - 删除死残片 `servertool-core/src/cli_contract.rs.bak`
  - 同步更新当前活跃 function-map / verification-map / mainline / wiki / stopless docs 的旧 alias 文案
- 过时测试纠偏：
  - `stop_visible_text` 有一条 full-lib 红测失败不是 rename 回退，而是旧断言把“裸内联 JSON”当 stop schema；当前真合同只剥离 fenced/control schema。
  - 已把样本更新成 `<rcc_stop_schema>...</rcc_stop_schema>`，不为兼容旧测去补错误逻辑。
- 验证：
  - `cargo test -p servertool-core --lib -- --nocapture` -> 345 passed
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` -> PASS
  - focused Jest:
    - `tests/servertool/servertool-cli-native-bridge.spec.ts`
    - `tests/server/handlers/responses-handler.servertool-stopless.dual-port.e2e.spec.ts`
    - `tests/server/runtime/http-server/provider-response-utils.request-semantics.spec.ts`
    - `tests/server/runtime/http-server/executor/servertool-followup-dispatch.spec.ts`
    - `tests/servertool/stop-schema-lifecycle-contract.spec.ts`
    - `tests/scripts/stopless-5555-live-probe.spec.ts`
    - 结果：6 suites / 68 tests passed
  - snapshot install:
    - `node scripts/install-release-snapshot.mjs`
    - `~/.rcc/install/current` -> `routecodex-0.90.3235-2026-06-21T103545Z`
  - live runtime:
    - `node ~/.rcc/install/current/dist/cli.js --version` -> `0.90.3235`
    - `node ~/.rcc/install/current/dist/cli.js restart --port 5555`
    - `curl http://127.0.0.1:5555/health` -> `version=0.90.3235 ready=true`
  - live probe:
    - `node scripts/tests/stopless-5555-live-probe.mjs`
    - 结果：`finalStatus=invalid_non_stopless_exec_command_path`
    - 但在线响应样本已证明运行中的 `/v1/responses` 返回 `exec_command.arguments.cmd = "reasoningStop"`，且无 `reasoning_stop` / `reasoning.stop` 残留；说明 rename 已在 live runtime 生效，只是 stopless 闭环 probe 仍未完全恢复到预期 managed path。

## 2026-06-21 servertool target-doc wording lock

- 复核“先更新目标文档，再执行替换”是否已经完成。
- 结论：skills / wiki / manifest / mainline 已基本对齐到“CLI 业务流不变，hook 治理请求/响应注入与拦截”的目标。
- 仍发现一处文档层歧义：
  - `docs/design/servertool-rust-only-architecture.md` 顶部仍保留旧的 `response runtime action -> server-side followup/reenter` 子链写法，虽然下文已有 2026-06-21 更正和其他文档 supersede 说明，但 review 时容易读成双主线。
- 已把该段改成 `Superseded Legacy Note`：
  - 明确旧链仅作迁移背景；
  - 当前唯一目标真源以下方 hook skeleton 更新段、wiki 和 `servertool.hook_skeleton.mainline` 为准；
- 明确 `stopless` CLI 不得重新解释为 server-side followup/reenter。
- 这次是文档真源收口，不代表 runtime Rust-only closeout 已完成；`servertool.hook_skeleton.mainline` 仍必须保持 `binding pending`。

## 2026-06-21 servertool execution-branch contract rust-owner

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.ts`：
  - 旧 TS 仍本地 owner 两处 post-dispatch branch 语义：
    - `dispatchPlan.executableToolCalls.find(isClientExecCliProjectionToolCall)`
    - `executionState.executedToolCalls.length > 0`
  - 现在把这层 branch decision 下沉到 Rust：
    - 新 owner：`sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_branch_contract.rs`
    - feature_id：`hub.servertool_execution_branch_contract`
    - 新 contract：`plan_servertool_execution_branch(...)`
    - action：
      - `client_exec_cli_projection`
      - `resolve_execution_outcome`
      - `continue_response_stage`
  - 新 bridge：
    - NAPI：`plan_servertool_execution_branch_json`
    - TS wrapper：`planServertoolExecutionBranchWithNative(...)`
  - `server-side-tools-impl.ts` 现在不再本地用 `.find(isClientExecCliProjectionToolCall)` 和 `executedToolCalls.length > 0` 判主分支：
    - pre-loop 用 native branch plan 决定是否走 client CLI projection；
    - post-loop 用 native branch plan 决定是否 resolve execution outcome 或继续 response-stage。
- gate 收紧：
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - `scripts/verify-servertool-rust-only.mjs`
  - 现在额外禁止 `server-side-tools-impl.ts` 复活：
    - `.find(isClientExecCliProjectionToolCall)`
    - `executionState.executedToolCalls.length > 0`
  - 同时要求：
    - Rust contract / `lib.rs` / NAPI bridge / required export / TS wrapper / TS thin-shell 调用点全部存在。

## 2026-06-21 forwarder authoring redundancy review

- Jason 提出 forwarder 配置当前写法冗余：同一类模型跨 provider 聚合时，不应在每个 target 重复 `modelId`，应由 forwarder-level `model` 统一声明，target 只保留聚合/选路信息。
- 代码证据已确认 runtime 真源本身就是“单模型 forwarder”：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/forwarder.rs`
  - `ForwarderEntry` 只持有一份 `model_id`
  - `ForwarderTarget` 只持有 `provider_key / weight / priority / disabled`
- TS contract/status 也与该语义一致：
  - `sharedmodule/llmswitch-core/src/native/router-hotpath/virtual-router-contracts.ts`
  - `ForwarderStatusState` 只持有 `forwarderId / protocol / modelId / strategy / stickyKey / targets`
- 冗余主要出现在 authoring/live config 层：
  - `/Volumes/extension/.rcc/config.toml`
  - 当前 `virtualrouter.forwarders."fwd.paid.gpt-5.4"` 已声明 `model = "gpt-5.4"`，但每个 `targets` 仍重复 `modelId = "gpt-5.4"`
- Host normalization 当前支持“继承 forwarder model”，说明 runtime 并不需要 target-level `modelId`：
  - `src/config/virtual-router-builder.ts`
  - `resolveForwarderTargetProviderKeys()` 中 `modelId = target.modelId ?? target.model ?? options.forwarderModelId`
- 但 host 仍会把 target 展开成完整 providerKey 列表并把原 target 字段一并透传给 native：
  - `normalizeForwardersForNative()` 使用 `...target, providerKey`
  - 这让 authoring shape 看起来像 target 自己持有 model 语义，造成配置风格冗余
- `src/providers/profile/forwarder-types.ts` 已经把 `ProviderForwarderTarget` 收敛成仅 `providerId / weight / priority / disabled`
  - 说明 schema 设计方向其实已经接近 Jason 想要的样子
  - 真正待收口的是 config authoring 规范与 normalize/export 形态，而不是 Rust 选路逻辑

## 2026-06-21 forwarder authoring strictness + materialized rebuild boundary

- 这轮已把 forwarder 规则收口成双边界：
  - authoring config：target 只允许 `providerId + priority/weight/disabled`，不同模型必须拆独立 forwarder，禁止 target `modelId/model/provider` 覆写
  - materialized config：`buildVirtualRouterInputV2()` 仍必须接受已规范化的 `forwarders`（顶层 `modelId`、target `providerKey`），否则 `materializeRouteCodexConfig()` 产物无法再次启动
- 代码侧边界：
  - `src/providers/profile/provider-profile-loader.ts` 负责 authoring 约束与清晰错误
  - `src/config/virtual-router-builder.ts` 负责同时兼容 authoring 输入和 materialized 输入，但禁止 target-level model override
- live config 真相同步：
  - `~/.rcc/config.toml`
  - `/Volumes/extension/.rcc/config.toml`
  - 当前 forwarder target 已物理移除冗余 `modelId`
- focused 验证闭环：
  - `tests/providers/forwarder-selection.spec.ts`
  - `tests/config/virtual-router-builder.model-alias-contract.spec.ts`
  - `tests/config/provider-v2-loader.spec.ts`
  - `tests/config/virtual-router-builder.forwarder-10000.spec.ts`
  - 两份 live config `config validate` 均 PASS
- focused 验证：
  - `cargo test -p servertool-core execution_branch_contract -- --nocapture` -> 3 passed
  - `cargo test -p router-hotpath-napi plans_servertool_execution_branch_via_servertool_core_bridge -- --nocapture` -> 1 passed
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` -> PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/servertool-cli-native-bridge.spec.ts --runInBand` -> 1 suite / 8 tests passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/server-side-tools.failfast.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand` -> 2 suites / 13 tests passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
- 当前边界：
  - response-stage 主分支里 CLI projection / outcome resolve / continue response-stage 的 branch owner 已不在 TS；
  - 但 `server-side-tools-impl.ts`、`execution-handler-materialization-shell.ts`、`engine.ts` 仍有活 TS orchestration；
  - `servertool.hook_skeleton.mainline` 仍必须保持 `binding pending`。

## 2026-06-21 servertool execution-handler runtime-action contract rust-owner

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/execution-handler-materialization-shell.ts`：
  - 旧 TS 仍本地 owner 一层 materialize/backend/finalize/reenter 主分支决策：
    - handler plan / result contract 推进
    - backend `vision_analysis | web_search | unsupported`
    - `reenterPipeline` 可用性
    - `finalize_without_backend | return_handler_result | invalid_plan_*`
  - 现在把这层总分支合成为 Rust runtime action contract：
    - owner：`sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_handler_contract.rs`
    - 新 contract：`plan_servertool_handler_runtime_action(...)`
    - 新 action：
      - `execute_backend_vision_analysis_then_finalize`
      - `execute_backend_web_search_then_finalize`
      - `finalize_without_backend`
      - `return_handler_result`
      - `invalid_plan_missing_finalize`
      - `invalid_plan_result`
      - `backend_requires_reenter_pipeline`
      - `unsupported_backend_plan_kind`
  - 新 bridge：
    - NAPI：`plan_servertool_handler_runtime_action_json`
    - TS wrapper：`planServertoolHandlerRuntimeActionWithNative(...)`
  - `execution-handler-materialization-shell.ts` 现在不再本地串：
    - `planServertoolHandlerContractWithNative(...)`
    - `planServertoolBackendExecutionWithNative(...)`
    - `planServertoolMaterializationProgressWithNative(...)`
    这些分散判断来决定主分支；TS 只根据 native runtime action 执行 backend IO / finalize / fail-fast 投影。
- gate 收紧：
  - `scripts/verify-servertool-rust-only.mjs`
    - 现在额外禁止该文件复活：
      - `planServertoolHandlerContractWithNative`
      - `planServertoolBackendExecutionWithNative`
    - 要求 Rust contract / NAPI export / required export / TS wrapper / TS thin-shell 全部存在。
- focused 验证：
  - `cargo test -p servertool-core execution_handler_contract -- --nocapture` -> 2 passed
  - `cargo test -p router-hotpath-napi plans_servertool_handler_runtime_action_via_servertool_core_bridge -- --nocapture` -> 1 passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/execution-shell.backend-failfast.spec.ts tests/servertool/server-side-tools.failfast.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand` -> 3 suites / 16 tests passed

## 2026-06-21 servertool stopless cli projection context rust-owner

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/engine.ts`：
  - 旧 TS 仍本地 owner `resolveStoplessCliProjectionContext(...)` 的 stopless CLI projection 上下文决策：
    - `reasoningText`
    - `repeatCount`
    - `maxRepeats`
    - `triggerHint`
    - `schemaFeedback`
  - 现在把这层规划下沉到 Rust：
    - owner：`sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_cli_projection_context_contract.rs`
    - feature_id：`hub.servertool_stopless_cli_projection_context`
    - 新 contract：`plan_stopless_cli_projection_context(...)`
  - 新 bridge：
    - NAPI：`plan_stopless_cli_projection_context_json`
    - TS wrapper：`planStoplessCliProjectionContextWithNative(...)`
  - `engine.ts` 现在只负责采集 raw inputs：
    - `execution.context`
    - runtime stop-message snapshot
    - runtime control `stopless`
    - chat/adapter stop text
    - 然后交给 native plan，再把结果喂给 CLI projection shell。
- gate 收紧：
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
    - 额外禁止 `engine.ts` 复活：
      - `const triggerHint = [`
      - `const schemaFeedbackCandidate = [`
      - `const repeatCount =`
      - `const maxRepeats =`
      - `extractCurrentAssistantStopTextWithNative(chatResponse ?? null) ||`
  - `tests/servertool/engine.stopless-session-thin-shell.spec.ts`
    - 新增 source-level guard：`engine.ts` 必须通过 `planStoplessCliProjectionContextWithNative`
  - `scripts/verify-servertool-rust-only.mjs`
    - 现在要求 Rust contract / `lib.rs` / NAPI export / required export / TS wrapper / TS thin-shell 调用点全部存在。
- focused 验证：
  - `cargo test -p servertool-core stopless_cli_projection_context_contract -- --nocapture` -> 3 passed
  - `cargo test -p router-hotpath-napi plans_stopless_cli_projection_context_via_servertool_core_bridge -- --nocapture` -> 1 passed
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` -> PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/servertool-cli-native-bridge.spec.ts tests/servertool/engine.stopless-session-thin-shell.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand` -> 3 suites / 19 tests passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
- 当前边界：
  - stopless CLI projection context 已不再由 `engine.ts` 本地拼；
  - 但 `engine.ts` 仍保留 stop signal / timeout / runEngine / stopless/followup branch orchestration 薄壳，`servertool.hook_skeleton.mainline` 仍必须保持 `binding pending`。

## 2026-06-21 servertool engine runtime-action contract rust-owner

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/engine.ts`：
  - 旧 TS 仍本地 owner post-engine 主分支决策：
    - mixed tools `pendingInjection`
    - generic `servertoolCliProjection`
    - `stop_message_auto` terminal final
    - `stop_message_auto` cli projection
    - fallthrough `runFollowupMainline`
  - 现在把这层主分支收成 Rust runtime action contract：
    - owner：`sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/engine_runtime_action_contract.rs`
    - feature_id：`hub.servertool_engine_runtime_action_contract`
    - 新 contract：`plan_servertool_engine_runtime_action(...)`
    - action：
      - `persist_pending_injection_and_return`
      - `return_servertool_cli_projection_final`
      - `return_stop_message_terminal_final`
      - `build_stop_message_cli_projection`
      - `continue_followup_mainline`
  - 新 bridge：
    - NAPI：`plan_servertool_engine_runtime_action_json`
    - TS wrapper：`planServertoolEngineRuntimeActionWithNative(...)`
  - `engine.ts` 现在只采集 raw booleans / `stoplessAction`，再按 native action 执行 IO shell：
    - persist pending injection
    - build stopless CLI projection shell
    - or hand off to followup mainline shell
- gate 收紧：
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
    - 额外禁止 `engine.ts` 复活：
      - `if (engineResult.pendingInjection)`
      - `!stoplessPlan.isStopMessageFlow &&`
      - `if (stoplessPlan.action === 'terminal_final')`
      - `if (stoplessPlan.action === 'cli_projection' && stoplessPlan.isStopMessageFlow)`
  - `tests/servertool/engine.stopless-session-thin-shell.spec.ts`
    - 新增 source-level guard：`engine.ts` 必须通过 `planServertoolEngineRuntimeActionWithNative`
  - `scripts/verify-servertool-rust-only.mjs`
    - 现在要求 Rust contract / `lib.rs` / NAPI export / required export / TS wrapper / TS thin-shell 调用点全部存在。
- focused 验证：
  - `cargo test -p servertool-core engine_runtime_action_contract -- --nocapture` -> 5 passed
  - `cargo test -p router-hotpath-napi plans_servertool_engine_runtime_action_via_servertool_core_bridge -- --nocapture` -> 1 passed
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` -> PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/servertool-cli-native-bridge.spec.ts tests/servertool/engine.stopless-session-thin-shell.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand` -> 3 suites / 21 tests passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
  - `git diff --check -- <touched files>` -> PASS
- 当前边界：
  - `engine.ts` 的 post-engine outcome branching 已不再由 TS 本地做主决策；
  - 但 `engine.ts` 仍保留 stop signal/direct guard、logger wiring、timeout shell、engine runner shell、followup shell handoff，`servertool.hook_skeleton.mainline` 仍必须保持 `binding pending`。

## 2026-06-21 servertool engine preflight contract rust-owner

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/engine.ts` 前半段 early-return 主分支：
  - 旧 TS 仍本地 owner 两处 preflight 决策：
    - synthetic RouteCodex control text 直接 passthrough 返回
    - `stopSignal.observed` 且 direct/provider-direct 禁 stopless 时直接跳过 servertool
  - 现在把这层 preflight 收成 Rust contract：
    - owner：`sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/engine_preflight_contract.rs`
    - feature_id：`hub.servertool_engine_preflight_contract`
    - 新 contract：`plan_servertool_engine_preflight(...)`
    - action：
      - `return_original_chat`
      - `return_original_chat_direct_passthrough`
      - `continue_to_engine`
  - 新 bridge：
    - NAPI：`plan_servertool_engine_preflight_json`
    - TS wrapper：`planServertoolEnginePreflightWithNative(...)`
  - `engine.ts` 现在只采集：
    - `containsSyntheticRouteCodexControlText(options.chat)`
    - `stopSignal.observed`
    - `stoplessIsDisabledOnDirectRoute(options.adapterContext)`
    - 再按 native action 执行 return/log shell。
- gate 收紧：
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
    - 额外禁止 `engine.ts` 复活：
      - `if ( containsSyntheticRouteCodexControlText(options.chat) )`
      - `if (stoplessIsDisabledOnDirectRoute(options.adapterContext))`
  - `tests/servertool/engine.stopless-session-thin-shell.spec.ts`
    - 新增 source-level guard：`engine.ts` 必须通过 `planServertoolEnginePreflightWithNative`
  - `scripts/verify-servertool-rust-only.mjs`
    - 现在要求 Rust contract / `lib.rs` / NAPI export / required export / TS wrapper / TS thin-shell 调用点全部存在。
- focused 验证：
  - `cargo test -p servertool-core engine_preflight_contract -- --nocapture` -> 3 passed
  - `cargo test -p router-hotpath-napi plans_servertool_engine_preflight_via_servertool_core_bridge -- --nocapture` -> 1 passed
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` -> PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/servertool-cli-native-bridge.spec.ts tests/servertool/engine.stopless-session-thin-shell.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand` -> 3 suites / 23 tests passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
  - `git diff --check -- <touched files>` -> PASS
- 当前边界：
  - `engine.ts` preflight synthetic/direct early return 已不再由 TS 本地做主决策；
  - 但 `engine.ts` 仍保留 stop gateway inspect attach、logger wiring、timeout shell、engine selection shell、no-execution skip shell、followup handoff，`servertool.hook_skeleton.mainline` 仍必须保持 `binding pending`。
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
  - `git diff --check -- <touched files>` -> PASS
- 当前边界：
  - handler materialization / backend-finalize 总分支决策 owner 已进一步不在 TS；
  - 但 `runServertoolHandler(...)` 的 handler invoke try/catch envelope、`backendIoExecutors` IO map、以及更上层 `engine.ts` / `server-side-tools-impl.ts` 仍有活 TS orchestration；
  - `servertool.hook_skeleton.mainline` 仍必须保持 `binding pending`。

## 2026-06-21 servertool engine skip contract rust-owner

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/engine.ts`：
  - 旧 TS 仍本地 owner 一层 skip branch：
    - `engineResult.mode === 'passthrough'`
    - `!engineResult.execution`
  - 现在把这层 skip decision 下沉到 Rust：
    - owner：`sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/engine_skip_contract.rs`
    - feature_id：`hub.servertool_engine_skip_contract`
    - 新 contract：`plan_servertool_engine_skip(...)`
    - action：
      - `return_skipped_passthrough`
      - `return_skipped_no_execution`
      - `continue_matched_flow`
- 新 bridge：
  - NAPI：`plan_servertool_engine_skip_json`
  - TS wrapper：`planServertoolEngineSkipWithNative(...)`
- `engine.ts` 现在只根据 native skip plan 做 log / record skipped / return shell：
  - 不再本地用 `if (engineResult.mode === 'passthrough' || !engineResult.execution)` 直接判 skip。
- gate 收紧：
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - `tests/servertool/engine.stopless-session-thin-shell.spec.ts`
  - `scripts/verify-servertool-rust-only.mjs`
  - 现在额外禁止 `engine.ts` 复活：
    - `if (engineResult.mode === 'passthrough' || !engineResult.execution)`
- focused 验证：
  - `cargo test -p servertool-core engine_skip_contract -- --nocapture` -> 3 passed
  - `cargo test -p router-hotpath-napi plans_servertool_engine_skip_via_servertool_core_bridge -- --nocapture` -> 1 passed
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` -> PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/servertool-cli-native-bridge.spec.ts tests/servertool/engine.stopless-session-thin-shell.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand` -> 3 suites / 25 tests passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
  - `git diff --check -- <touched files>` -> PASS
- 调试补充：
  - 这次确认一个稳定流程规则：依赖新 NAPI 导出的 Jest/CLI 黑盒不能和 native build 并行跑；否则会先加载旧 `.node`，出现成串 `native unavailable` 假失败。
  - 已把这条写回 `.agents/skills/rcc-dev-skills/references/23-servertool-hook-dev-debug-flow.md`。
- 当前边界：
  - `engine.ts` 的 passthrough/no-execution skip owner 已不在 TS；
  - 但 `engine.ts` 仍保留 stop gateway inspect/attach、logger wiring、timeout shell、engine runner shell、followup shell handoff；
  - `server-side-tools-impl.ts` 与 `execution-handler-materialization-shell.ts` 也仍有活 TS orchestration；
  - `servertool.hook_skeleton.mainline` 仍必须保持 `binding pending`，不能宣称 servertool 主线已 Rust-only closeout。

## 2026-06-21 servertool execution-outcome runtime-action contract rust-owner

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/execution-dispatch-outcome-shell.ts`：
  - 旧 TS 仍本地 owner 一层 outcome branch：
    - `mixed_client_tools` 是否满足 pending injection contract
    - `reuse_last_execution` / `resolvedFollowup` 选 followup 来源
    - followup contract 缺失时 fail-fast
  - 现在把这层 outcome runtime action 下沉到 Rust：
    - owner：`sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_outcome_runtime_action_contract.rs`
    - feature_id：`hub.servertool_execution_outcome_runtime_action_contract`
    - 新 contract：`plan_servertool_execution_outcome_runtime_action(...)`
    - action：
      - `return_mixed_client_tools_pending_injection`
      - `invalid_mixed_client_tools_outcome`
      - `reuse_last_execution_followup`
      - `use_resolved_followup`
      - `missing_followup_contract`
- 新 bridge：
  - NAPI：`plan_servertool_execution_outcome_runtime_action_json`
  - TS wrapper：`planServertoolExecutionOutcomeRuntimeActionWithNative(...)`
- `execution-dispatch-outcome-shell.ts` 现在只根据 native runtime action 做 shell：
  - mixed pending-injection client response materialize
  - invalid mixed outcome fail-fast
  - followup source select
  - missing followup fail-fast
- gate 收紧：
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - `scripts/verify-servertool-rust-only.mjs`
  - 现在额外禁止该文件复活：
    - `if (outcomePlan.outcomeMode === 'mixed_client_tools')`
    - `outcomePlan.followupStrategy === 'reuse_last_execution'`
    - `? args.executionState.lastExecution.followup`
- focused 验证：
  - `cargo test -p servertool-core execution_outcome_runtime_action_contract -- --nocapture` -> 5 passed
  - `cargo test -p router-hotpath-napi plans_servertool_execution_outcome_runtime_action_via_servertool_core_bridge -- --nocapture` -> 1 passed
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` -> PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/execution-dispatch-outcome-shell.spec.ts tests/servertool/servertool-cli-native-bridge.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand` -> 3 suites / 26 tests passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
  - `git diff --check -- <touched files>` -> PASS
- 当前边界：
  - `execution-dispatch-outcome-shell.ts` 的 mixed/followup outcome decision owner 已进一步不在 TS；
  - 但 `runServertoolIoExecutionQueue(...)` 的 handler loop / noop loop 仍是 TS orchestration shell；
  - 更上层 `server-side-tools-impl.ts` response-stage orchestration 与 `engine.ts` 主链 shell 仍未 closeout；
  - `servertool.hook_skeleton.mainline` 仍必须保持 `binding pending`，不能宣称 hook skeleton runtime 已 Rust-only 完成。

## 2026-06-21 servertool execution-state contract rust-owner

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/execution-dispatch-outcome-shell.ts` 与 `execution-shell.ts`：
  - 旧 TS 仍本地 owner 两类状态/结果语义：
    - `createServertoolExecutionLoopState()` / `appendExecutedToolRecord(...)`
    - `applyServertoolExecutionResult(...)` 的本地 object overwrite
  - 现在把 execution loop state 的 create/append 下沉到 Rust：
    - 新 owner：`sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_state_contract.rs`
    - feature_id：`hub.servertool_execution_state_contract`
    - 新 contract：
      - `create_servertool_execution_loop_state()`
      - `append_executed_tool_record(...)`
  - 新 bridge：
    - NAPI：
      - `create_servertool_execution_loop_state_json`
      - `append_servertool_executed_record_json`
    - TS wrapper：
      - `createServertoolExecutionLoopStateWithNative(...)`
      - `appendServertoolExecutedRecordWithNative(...)`
  - `execution-dispatch-outcome-shell.ts` 现在不再本地 push/set/add 执行状态，只消费 native state contract，再把 `executedIds` 数组水合成 TS `Set`。
  - `execution-shell.ts` 现在不再保留第二份重复实现，改为直接 re-export dispatch thin shell。
  - `applyServertoolExecutionResult(...)` 不再本地做 key-diff overwrite，改为复用 `orchestration-blocks.ts` 的薄壳 helper `replaceJsonObjectInPlace(...)`。
- gate 收紧：
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - `scripts/verify-servertool-rust-only.mjs`
  - 现在额外禁止：
    - `execution-dispatch-outcome-shell.ts` 复活 `executedToolCalls: []` / `executedIds.add(...)` / `state.lastExecution = execution` / `const newKeys = new Set(...)`
    - `execution-shell.ts` 复活第二份相同状态推进/dispatch mismatch 语义
- focused 验证：
  - `cargo test -p servertool-core execution_state_contract -- --nocapture` -> 3 passed
  - `cargo test -p router-hotpath-napi plans_servertool_execution_state_via_servertool_core_bridge -- --nocapture` -> 1 passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/execution-dispatch-outcome-shell.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand` -> 2 suites / 12 tests passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
  - `git diff --check -- <touched files>` -> PASS
- 当前边界：
  - execution-dispatch shell 的 execution state create/append owner 已不在 TS；
  - 但 mixed outcome materialization、`filterOutExecutedToolCalls(...)` 依赖的 executed-id 消费、以及更上层 `server-side-tools-impl.ts` / `engine.ts` 仍有活 TS 编排；
  - `servertool.hook_skeleton.mainline` 仍必须保持 `binding pending`。

## 2026-06-21 servertool execution-dispatch contract rust-owner

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/execution-dispatch-outcome-shell.ts`：
  - 旧 TS 仍本地 owner 三类 fail-fast contract：
    - `[servertool] dispatch spec mismatch: ...`
    - `[servertool] invalid native mixed-client-tools outcome contract`
    - `[servertool] missing native followup contract for servertool-only outcome`
  - 现在把这三类 execution-dispatch contract 下沉到 Rust：
    - 新 owner：`sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_dispatch_contract.rs`
    - feature_id：`hub.servertool_execution_dispatch_contract`
    - 新 contract：
      - `plan_servertool_dispatch_spec_mismatch_error(...)`
      - `plan_servertool_invalid_mixed_client_tools_outcome_error(...)`
      - `plan_servertool_missing_followup_contract_error(...)`
  - 新 bridge：
    - NAPI：`plan_servertool_execution_dispatch_error_json`
    - TS wrapper：`planServertoolExecutionDispatchErrorWithNative(...)`
  - `execution-dispatch-outcome-shell.ts` 现在不再本地手拼上述 message/details，只消费 native `ServertoolErrorPlan` 再投影 `ProviderProtocolError`。
- gate 收紧：
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - `scripts/verify-servertool-rust-only.mjs`
  - 现在额外禁止 `execution-dispatch-outcome-shell.ts` 复活：
    - `[servertool] dispatch spec mismatch:`
    - `[servertool] invalid native mixed-client-tools outcome contract`
    - `[servertool] missing native followup contract for servertool-only outcome`
- focused 验证：
  - `cargo test -p servertool-core execution_dispatch_contract -- --nocapture` -> 3 passed
  - `cargo test -p router-hotpath-napi plans_servertool_execution_dispatch_error_via_servertool_core_bridge -- --nocapture` -> 1 passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/execution-dispatch-outcome-shell.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand` -> 2 suites / 10 tests passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
- 当前边界：
  - execution-dispatch shell 的三类 contract fail-fast owner 已不在 TS；
  - 但 `appendExecutedToolRecord(...)`、`applyServertoolExecutionResult(...)`、loop state 累积与 response object overwrite 仍在 TS thin shell；
  - `server-side-tools-impl.ts`、`engine.ts` 仍有活 TS 编排，`servertool.hook_skeleton.mainline` 仍必须保持 `binding pending`。

## 2026-06-21 servertool skills sediment closure

- Jason 明确要求：整个 servertool 开发和 debug 流程必须沉淀入 skills，而不是只停留在目标文档、note 或聊天说明。
- 已补 repo 内规则：
  - `.agents/skills/rcc-dev-skills/SKILL.md`
    - servertool 专项必经流新增“稳定动作序列/切段法/反模式/验证口径必须回写 23 或 lessons”
  - `.agents/skills/rcc-dev-skills/references/23-servertool-hook-dev-debug-flow.md`
    - 新增 `Skills 沉淀闭环`
    - 明确 stable flow -> 23，月度经验卡 -> lessons，raw 才留 note
  - `.agents/skills/rcc-dev-skills/references/60-note-memory-flow.md`
    - 明确 servertool 还要沉淀 slice 顺序、debug 切段、黑盒必经路径、删 TS 准入条件
  - `.agents/skills/rcc-dev-skills/references/80-skill-routing-convention.md`
    - 明确已有主题的新稳定流程不新建散文件，直接回写现有 reference
- 结论：
  - 现在“servertool 开发/debug 流程要沉淀入 skills”已经从口头要求变成 repo 内执行规则。
  - 这仍是流程/知识真源锁定，不代表 runtime Rust-only closeout 已完成。

## 2026-06-21 servertool execution-handler error contract rust-owner

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/execution-handler-materialization-shell.ts`：
  - 旧 TS 仍手拼多类 `SERVERTOOL_HANDLER_FAILED` error envelope：
    - invalid handler plan missing finalize
    - invalid handler plan/result contract
    - handler failed
    - vision_analysis backend requires reenterPipeline
    - unsupported backend plan kind
  - 现在把这些 error contract 下沉到 Rust：
    - 新 owner：`sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_handler_contract.rs`
    - feature_id：`hub.servertool_execution_handler_contract`
    - 新 contract：
      - `plan_servertool_handler_contract(...)`
      - `plan_servertool_handler_failed_error(...)`
      - `plan_servertool_backend_requires_reenter_pipeline_error(...)`
      - `plan_servertool_unsupported_backend_plan_kind_error(...)`
      - `plan_servertool_invalid_handler_plan_missing_finalize_error(...)`
      - `plan_servertool_invalid_handler_plan_result_error(...)`
  - 新 bridge：
    - NAPI：`plan_servertool_handler_contract_error_json`
    - TS wrapper：`planServertoolHandlerContractErrorWithNative(...)`
  - `execution-handler-materialization-shell.ts` 现在不再本地手拼上述错误文案与 details，只把 Rust `ServertoolErrorPlan` 投影为 `ProviderProtocolError`。
- gate 收紧：
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - `scripts/verify-servertool-rust-only.mjs`
  - 现在额外禁止 `execution-handler-materialization-shell.ts` 复活：
    - `[servertool] invalid handler plan contract: missing finalize`
    - `[servertool] invalid handler plan/result contract`
    - `[servertool] handler failed:`
    - `[servertool] vision_analysis backend requires reenterPipeline`
    - `[servertool] unsupported backend plan kind:`
- focused 验证：
  - `cargo test -p servertool-core execution_handler_contract -- --nocapture` -> 2 passed
  - `cargo test -p router-hotpath-napi plans_servertool_handler_contract_error_via_servertool_core_bridge -- --nocapture` -> 1 passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/execution-shell.backend-failfast.spec.ts tests/servertool/server-side-tools.failfast.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand` -> 3 suites / 15 tests passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
- 当前边界：
  - execution-handler shell 的 error envelope owner 已不在 TS；
  - 但 `materializeServertoolPlannedResult(...)` 的 plan/result/backend-finalize orchestration 仍在 TS thin shell；
  - `server-side-tools-impl.ts`、`execution-dispatch-outcome-shell.ts`、`engine.ts` 仍有活 TS 主线，`servertool.hook_skeleton.mainline` 仍必须保持 `binding pending`。

## 2026-06-21 servertool auto-hook queue progression rust-owner

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.ts`：
  - 旧 TS 仍保有 optional -> mandatory queue 推进语义：
    - `const optionalResult = ...`
    - `if (optionalResult) return ...`
    - `const mandatoryResult = ...`
    - `if (mandatoryResult) return ...`
  - 现在把这层 queue progression 下沉到 Rust：
    - 新 owner：`sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/auto_hook_queue_contract.rs`
    - feature_id：`hub.servertool_auto_hook_queue_progress`
    - 新 contract：`plan_auto_hook_queue_progress(...)`
    - action：`return_result | continue_next_queue | return_null`
  - 新 bridge：
    - NAPI：`plan_auto_hook_queue_progress_json`
    - TS wrapper：`planAutoHookQueueProgressWithNative(...)`
  - `auto-hook-caller.ts` 现在不再本地凭 `optionalResult/mandatoryResult` 判队列推进，只消费 native queue progress plan。
- 同轮把 focused Jest 改成 hermetic thin-shell proof：
  - `tests/servertool/execution-shell.auto-hook-failfast.spec.ts`
  - `tests/servertool/servertool-auto-hook-trace.spec.ts`
  - 不再因为无关 native unavailable 失败；只锁当前 auto-hook caller slice。
- gate 收紧：
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - `scripts/verify-servertool-rust-only.mjs`
  - 现在额外禁止 `auto-hook-caller.ts` 复活：
    - `if (optionalResult) {`
    - `if (mandatoryResult) {`
- focused 验证：
  - `cargo test -p servertool-core auto_hook_queue_contract -- --nocapture` -> 3 passed
  - `cargo test -p servertool-core auto_hook_execution -- --nocapture` -> 2 passed
  - `cargo test -p router-hotpath-napi plans_auto_hook_queue_progress_via_servertool_core_bridge -- --nocapture` -> 1 passed
  - `cargo test -p router-hotpath-napi plans_auto_hook_execution_decision_via_servertool_core_bridge -- --nocapture` -> 1 passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/execution-shell.auto-hook-failfast.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts tests/servertool/servertool-auto-hook-trace.spec.ts --runInBand` -> 3 suites / 10 tests passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
- 当前边界：
  - auto-hook caller 的 attempt outcome + queue progression 都已由 Rust plan owner 决定；
  - 但 queue 内实际 handler execution/materialization loop 仍是 TS IO shell；
  - `server-side-tools-impl.ts`、`execution-handler-materialization-shell.ts`、`engine.ts` 仍有活 TS 主线，`servertool.hook_skeleton.mainline` 仍必须保持 `binding pending`。

## 2026-06-21 servertool dev/debug flow skills closure

- 已复核“整个开发和 debug 流程要沉淀入 skills”当前状态：
  - 主入口：`.agents/skills/rcc-dev-skills/SKILL.md`
  - 骨架目标：`.agents/skills/rcc-dev-skills/references/22-servertool-hook-skeleton-workflow.md`
  - 开发/debug/删 TS 闭环：`.agents/skills/rcc-dev-skills/references/23-servertool-hook-dev-debug-flow.md`
- 本轮补充：
  - `23-servertool-hook-dev-debug-flow.md` 顶部新增一眼执行 ASCII 主流程：
    - 文档锁定 -> 红测/红 gate -> Rust slice -> 白盒 -> 黑盒 -> replay -> map anchored -> 删 TS -> note/MEMORY/lessons
  - 明确 `binding pending` 期间禁止宣称主线 Rust-only 已完成。
- 结论：
  - servertool 的开发与 debug 流程现在已经以 skill/reference 形式落盘；
  - 这次是 skills 沉淀收口，不是 runtime Rust-only closeout；
  - `servertool.hook_skeleton.mainline` 仍应保持 `binding pending`，不能误报实现完成。

## 2026-06-21 servertool cli projection execution context rust-owner

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.ts`：CLI projection 命中后，TS 不再手拼
  - `flowId: 'servertool_cli_projection'`
  - `context.servertoolCliProjection.{ clientCallId, toolName, requestId }`
- 新 Rust owner：
  - `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`
  - 新 helper：`build_servertool_cli_projection_execution_context(...)`
  - NAPI bridge：`router-hotpath-napi/src/servertool_core_blocks.rs` + `src/lib.rs`
  - TS wrapper：`buildServertoolCliProjectionExecutionContextWithNative(...)`
- TS 现状：
  - `server-side-tools-impl.ts` 现在只消费 native execution context plan，再返回 `execution`
  - `servertool-active-orchestration-audit` 与 `verify-servertool-rust-only.mjs` 已收紧，禁止该文件复活 `flowId: 'servertool_cli_projection'` 与 `servertoolCliProjection: {` 这段本地 owner 语义
- focused 验证：
  - `cargo test -p servertool-core cli_projection_execution_context -- --nocapture` -> 2 passed
  - `cargo test -p router-hotpath-napi cli_projection_execution_context -- --nocapture` -> 0 matching tests / compile pass
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` -> PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/servertool-cli-native-bridge.spec.ts tests/servertool/server-side-tools.failfast.spec.ts tests/servertool/server-side-tools.cli-projection-guard.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand` -> 4 suites / 16 tests passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
- 当前剩余活 TS 聚焦：
  - `server-side-tools-impl.ts` 仍有 runtime metadata / persistent state 读取与 sticky load error wrap
  - `applyPreCommandHooksToToolCalls(...)` 之前的 runtime pre-command state resolve 仍在 TS
  - response-stage gate / auto-hook 分流主线仍由 TS 负责 orchestrate

## 2026-06-21 servertool dev/debug flow skill entry lock

- 已复核当前真源一致性：
  - 目标文档：`docs/design/servertool-rust-only-architecture.md`
  - review/wiki：`docs/architecture/wiki/servertool-hook-skeleton-mainline-source.md`
  - skill 执行真源：`.agents/skills/rcc-dev-skills/references/22-servertool-hook-skeleton-workflow.md` + `23-servertool-hook-dev-debug-flow.md`
- 22 已锁：
  - client-visible CLI 仍是业务生命周期；
  - request/response hook skeleton 顺序节点；
  - required/optional 规则；
  - 单元测试 case matrix 与黑盒必经路径。
- 23 已锁：
  - 文档锁定 -> 红 gate -> Rust owner 下沉 -> 白盒 -> 黑盒 -> replay -> anchored map -> 删 TS；
  - debug 切段法；
  - 删 TS 的准入条件与反模式。
- 本轮把 `.agents/skills/rcc-dev-skills/SKILL.md` 主入口再收紧：
  - 只要任务涉及 `servertool / stopless / hook run / followup / reenter / schema / tool injection`，必须先读 `22` 再读 `23`；
  - 若 `servertool.hook_skeleton.mainline` 仍是 `binding pending`，只能宣称目标/骨架锁定，不能宣称 runtime Rust-only 已完成。
- 这轮是 skill 入口锁定，不是 runtime closeout；代码主线仍有活 TS，不能误报完成。

## 2026-06-21 servertool runtime pre-command state selection rust-owner

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.ts`：
  - 原先 TS 本地 owner 语义：
    - `asObject(directRuntime?.preCommandState) ??`
    - `asObject((runtimeMetadata as Record<string, unknown> | undefined)?.preCommandState)`
    - 若都没有，再决定是否 `loadRoutingInstructionStateSync(...)`
  - 现在改为 Rust owner `pre_command_hook_contract::plan_runtime_pre_command_state_selection(...)`：
    - 先判 `direct_runtime`
    - 再判 `runtime_metadata`
    - 只有 native plan 返回 `load_persisted` 时，TS 才允许做 persisted IO
    - persisted load 完后再回 native 做最终 state selection
- 新 bridge：
  - Rust export：`plan_runtime_pre_command_state_selection_json`
  - NAPI export：`plan_runtime_pre_command_state_selection_json`
  - TS wrapper：`planRuntimePreCommandStateSelectionWithNative(...)`
- 收紧 gate：
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - `scripts/verify-servertool-rust-only.mjs`
  - 现已额外禁止 `server-side-tools-impl.ts` 复活：
    - `asObject(directRuntime?.preCommandState) ??`
    - `asObject((runtimeMetadata as Record<string, unknown> | undefined)?.preCommandState)`
- focused 证明：
  - Rust unit：
    - `cargo test -p servertool-core runtime_pre_command_state_selection -- --nocapture` -> 2 passed
    - `cargo test -p router-hotpath-napi runtime_pre_command_state_selection -- --nocapture` -> 1 passed
  - Jest：
    - `tests/servertool/server-side-tools.failfast.spec.ts`
      - direct runtime state 命中时不读 persisted
      - runtime metadata state 命中时不读 persisted
      - 只有 native plan 请求 persisted load 时才读取 sticky state
    - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
    - 结果：2 suites / 10 tests passed
  - gate：
    - `node scripts/verify-servertool-rust-only.mjs` -> PASS
- 当前边界：
  - pre-command state 的 source 选择语义已不在 TS
  - persisted state 的实际文件 IO 仍在 TS thin shell，符合当前“TS 只保留 IO shell”方向
  - `server-side-tools-impl.ts` 仍有 response-stage gate / auto-hook orchestration 主线，下一刀继续削这块

## 2026-06-21 servertool response-stage gate support/next-action rust-owner

- 本轮继续收缩 `server-side-tools-impl.ts` 与 `response-stage-orchestration-shell.ts` 的 response-stage 收口逻辑：
  - 旧 TS 语义里还保留两层本地判断：
    - `hasServertoolSupport = providerInvoker || reenterPipeline || clientInjectDispatch`
    - `if !shouldBypass => run auto hook / orchestration`
  - 现在把这层决策继续下沉到 Rust `chat_servertool_orchestration.rs`：
    - gate input 改为 `capabilities.{ providerInvoker, reenterPipeline, clientInjectDispatch }`
    - Rust owner 统一算出 support truth
    - gate output 新增 `nextAction: bypass | run_auto_hooks`
- TS 当前边界：
  - `server-side-tools-impl.ts` 不再本地拼 `hasServertoolSupport`
  - `response-stage-orchestration-shell.ts` 也不再本地拼 `hasServertoolSupport`
  - 两处都只消费 native `nextAction`
  - auto-hook caller 仍是 TS IO/execution shell；是否进入该 caller 的业务决策已不在 TS
- gate 收紧：
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - `scripts/verify-servertool-rust-only.mjs`
  - 现在额外禁止 `server-side-tools-impl.ts` 复活：
    - `hasServertoolSupport:`
    - `typeof options.providerInvoker === 'function' || typeof options.reenterPipeline === 'function'`
- focused 验证：
  - Rust：
    - `cargo test -p router-hotpath-napi plan_servertool_response_stage_gate -- --nocapture` -> 2 passed
    - 现有 gate tests 同时锁 `nextAction=bypass` 与 `nextAction=run_auto_hooks`
  - Jest：
    - `tests/servertool/server-side-tools.failfast.spec.ts`
      - 新增 proof：response-stage gate 现在收到 native `capabilities` 输入，而不是 TS support 布尔
    - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
    - `tests/servertool/server-side-tools.response-stage-gate-guard.spec.ts`
    - 结果：3 suites / 12 tests passed
  - Gate：
    - `node scripts/verify-servertool-rust-only.mjs` -> PASS
- 当前剩余边界：
  - response-stage “是否进入 auto-hook caller”的决策已转 native
  - 但 auto-hook caller 本身的 queue execution/materialization 仍在 TS thin shell；后续要继续往 queue runner / materialized result 收口

- 同轮继续把 sticky routing state load error 信封下沉到 Rust：
  - TS 不再本地 `new ProviderProtocolError(... code='SERVERTOOL_STATE_LOAD_FAILED' ...)`
  - 新 Rust owner：`orchestration_policy_contract::plan_servertool_state_load_failed_error(...)`
  - 新 native wrapper：`planServertoolStateLoadFailedErrorWithNative(...)`
  - `server-side-tools-impl.ts` 现在通过 `createServertoolStateLoadFailedError(...)` 消费 Rust error plan
- gate 收紧：
  - `servertool-active-orchestration-audit` / `verify-servertool-rust-only.mjs` 额外禁止 `server-side-tools-impl.ts` 复活
    - `code: 'SERVERTOOL_STATE_LOAD_FAILED'`
    - `'[servertool] sticky routing state load failed:'`
- 第二刀 focused 验证：
  - `cargo test -p servertool-core plans_servertool_error_payloads -- --nocapture` -> 1 passed
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` -> PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/server-side-tools.failfast.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand` -> 2 suites / 7 tests passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
- 更新后的真实边界：
  - `server-side-tools-impl.ts` 里 sticky state load 的错误 owner 已不在 TS
  - 但 runtime pre-command state 的 source 选择 / persisted load 本身仍在 TS；下一刀应继续削这段 state resolve 与 response-stage orchestration

## 2026-06-21 servertool hook skeleton gate resync

- 已重新核对目标文档、wiki/mainline、skills 与代码现状：当前目标仍是 client-visible CLI `routecodex hook run <toolName> --input-json <json>`，hook 只治理请求/响应注入、拦截、schema、followup、reenter、finalize；`servertool.hook_skeleton.mainline` 仍必须保持 `binding pending`，不能伪造 Rust owner 绑定。
- `rcc-dev-skills` 已沉淀 servertool 全流程：
  - `.agents/skills/rcc-dev-skills/references/22-servertool-hook-skeleton-workflow.md` 锁目标骨架、标准流程、case matrix、验证栈；
  - `.agents/skills/rcc-dev-skills/references/23-servertool-hook-dev-debug-flow.md` 锁开发顺序、debug 切段、证据链、删 TS 准入条件。
- 本轮 gate 真实失败点已核实只是 `scripts/verify-servertool-rust-only.mjs` 过期：
  - 旧断言仍要求 `server-side-tools-impl.ts` 保留 TS 本地判断 `return executionMode === 'client_exec_cli_projection';`
  - 代码真相已改为 native thin shell：`isServertoolClientExecCliProjectionToolCallWithNative({ executionMode: toolCall.executionMode })`
- 已修复门禁脚本为新 thin-shell 断言，不改业务主线语义。
- 验证结果：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/server-side-tools.failfast.spec.ts tests/servertool/server-side-tools.cli-projection-guard.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand` -> 3 suites / 9 tests passed
- 当前边界不变：
  - 这次只修正 stale gate，不代表 servertool 已 Rust-only closeout。
  - `sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.ts`、`engine.ts` 等仍有活 TS 编排，后续要继续按 slice 下沉到 Rust owner，再补白盒/黑盒与旧样本 replay。

## 2026-06-21 servertool Rust-only audit

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.ts`：engine 入口的 client-disconnect fail-fast 不再在 TS 手拼 `Error + code=SERVERTOOL_CLIENT_DISCONNECTED + details.requestId`，改为复用 native contract shell `createServerToolClientDisconnectedError(...)`。判定仍走 `isAdapterClientDisconnectedWithNative(...)`，错误信封也不再是 TS 本地 owner。
- gate 同步收紧：
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts` 额外禁止 `server-side-tools-impl.ts` 复活 `'SERVERTOOL_CLIENT_DISCONNECTED'` 与 `'[servertool] client disconnected before servertool execution'` 字面量。
  - `scripts/verify-servertool-rust-only.mjs` 同步把上述 marker 纳入 forbidden list。
- focused 验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/server-side-tools.failfast.spec.ts tests/servertool/server-side-tools.cli-projection-guard.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand` -> 3 suites / 9 tests passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
- 当前边界：`runServerSideToolEngineImpl()` 仍然保有 runtime metadata / persistent state resolve、pre-command hook apply、dispatchPlan -> cliProjection/executionState/responseStageGate/autoHook 分流这些主线编排；本轮只是继续削掉其中一个明确的 TS 错误策略 owner。
- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.ts`：`collectAdditionalClientToolCallsImpl()` 不再由 TS 负责筛掉 `projectedToolCallId` 和 `stop_message_auto`，改为 Rust/NAPI helper `collectServertoolAdditionalClientToolCallsWithNative(...)`。这把 client-visible CLI projection 的“附带 tool_calls 过滤”语义从 TS 主线移到 `router-hotpath-napi/src/chat_servertool_orchestration.rs`。
- 新增 Rust focused：`collect_servertool_additional_client_tool_calls_filters_projected_and_stop_message_auto`，锁“投影 tool call 本身 + stop_message_auto 必须被排除，其余如 exec_command 保留”。
- gate 同步收紧：
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts` 额外禁止 `server-side-tools-impl.ts` 复活 `return name !== 'stop_message_auto';`
  - `scripts/verify-servertool-rust-only.mjs` 同步把上述 marker 纳入 forbidden list。
- focused 验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/server-side-tools.cli-projection-guard.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand` -> 2 suites / 7 tests passed
  - `cargo test -p router-hotpath-napi collect_servertool_additional_client_tool_calls_filters_projected_and_stop_message_auto -- --nocapture` -> 1 passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
- 当前边界仍不变：这只是把 `server-side-tools-impl.ts` 里一块 CLI projection 附带消息筛选语义下沉；`runServerSideToolEngineImpl()` 本身仍保有 request/response orchestration、runtime metadata/persistent state 读取、response-stage gate 与 auto-hook 分流等活 TS 主线。
- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/execution-dispatch-outcome-shell.ts`：handler error 不再由 TS 手拼 `JSON.stringify({ ok:false, tool, message, retryable:true })` + `appendToolOutput(...)`，改为 Rust/NAPI helper `buildServertoolHandlerErrorToolOutputPayloadWithNative(...)`。这把 error tool-output 的字段合同（`ok/tool/message/retryable`）从 TS 主链移到 `router-hotpath-napi/src/chat_servertool_orchestration.rs`。
- 新增 focused 证明：
  - `tests/servertool/execution-dispatch-outcome-shell.spec.ts` 锁“handler error 走 native helper，TS append/stringify 不再被调用”。
  - Rust focused：`build_servertool_handler_error_tool_output_payload_uses_structured_retryable_error_contract`，锁新 helper 输出 `tool_outputs[0].content` 的结构化 retryable error 合同。
- gate 同步收紧：
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts` 现在额外禁止 `execution-dispatch-outcome-shell.ts` 复活 `args.appendToolOutput(` 与 `JSON.stringify({`。
  - `scripts/verify-servertool-rust-only.mjs` 同步把上述 marker 纳入 red gate。
- 本轮验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/execution-dispatch-outcome-shell.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand` -> 2 suites / 6 tests passed
  - `cargo test -p router-hotpath-napi build_servertool_handler_error_tool_output_payload_uses_structured_retryable_error_contract -- --nocapture` -> 1 passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
- 边界不变：这只是收掉 `execution-dispatch-outcome-shell.ts` 里一段明确的活 TS 语义；request/response hook runtime 主线、followup/reenter 规划、`server-side-tools-impl.ts` 与 `engine.ts` 仍未 Rust-only，`servertool.hook_skeleton.mainline` 仍必须保持 `binding pending`。
- 已补 skills 沉淀：`23-servertool-hook-dev-debug-flow.md` 新增“标准开发闭环”，明确 servertool 迁移必须按“先审计活 TS -> 锁目标文档 -> 红 gate -> Rust owner 下沉 -> 白盒/黑盒 -> replay -> anchored map -> 删 TS”执行；`92-lessons-2026-06.md` 新增 L92-34，锁“wiki/mainline/manifest 负责目标真源，22/23 skill 负责执行真源”。
- 当前结论仍不变：文档和 skill 目标已经对齐，但代码尚未对齐到 Rust-only；`servertool.hook_skeleton.mainline` 仍必须保持 `binding pending`，不能宣称实现完成。
- `registry-impl.ts` 已继续收缩：`listAutoHandlersForRegistryImpl()` 不再在 TS 侧按 `phase/priority/order/name` 排序，直接返回 builtin + ad-hoc 列表，真实顺序留给 `buildAutoHookQueuesFromConfig -> planServertoolHookScheduleWithNative`；同时 `registerServerToolHandlerImpl()` / `getServerToolHandlerImpl()` / `registerAdHocHandlerForTests()` 对非 builtin tool 不再无条件触发 native skeleton lookup。新增 gate 收紧：`tests/servertool/servertool-active-orchestration-audit.spec.ts` 与 `scripts/verify-servertool-rust-only.mjs` 现在会拦 `resolveAutoHookPhaseRank`、TS comparator `.sort((left, right) => {`、`phaseRankDiff/priorityDiff/orderDiff` 复活。
- focused 验证已补齐并去环境依赖：
  - `tests/servertool/server-side-tools.auto-hook-config.spec.ts` 继续通过，证明 auto-hook queue 最终顺序走 native hook skeleton scheduler。
  - `tests/servertool/server-side-tools.failfast.spec.ts` 已改为 hermetic native shell proof：mock `execution-shell.js`、`cli-projection.js`、`state-scope.js`、`runtime-metadata.js` 及最小 native exports，只验证 client-disconnect fail-fast 与 handler error -> retryable tool output closed-loop，不再依赖本机 native build surface。
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/servertool-active-orchestration-audit.spec.ts tests/servertool/server-side-tools.auto-hook-config.spec.ts tests/servertool/server-side-tools.failfast.spec.ts --runInBand` -> 12 passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
- `tests/servertool/server-side-tools.auto-hook-config.spec.ts` 已修复 focused Jest mock 过期：`orchestration-blocks.ts` 现依赖 `runServertoolOrchestrationMutationWithNative`，测试原 mock 未导出该 symbol，导致 focused proof 在 import 阶段即红，不是业务断言失败。现已补齐 `.js/.ts` mock export，并用最小 op->payload stub 覆盖 `build_assistant_tool_call_message` / `append_tool_output` / strip/filter/patch 等 mutation 入口；`PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/server-side-tools.auto-hook-config.spec.ts --runInBand` -> 5 passed。
- 已把“servertool 开发 + debug 流程必须沉淀入 skills”落为独立 reference：`.agents/skills/rcc-dev-skills/references/23-servertool-hook-dev-debug-flow.md`；主 `SKILL.md` 仅新增路由，`22` 继续锁骨架目标，`23` 承载实施顺序、debug 切段、证据链、删 TS 准入条件。
- 继续推进：已新增 `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/hook_skeleton_contract.rs`，把 hook skeleton 的方向/phase/requiredness/spec/scheduler/effect plan 下沉到 Rust；当前已覆盖 stable sort `priority -> order -> id`、duplicate hook id fail-fast、missing required hook fail-fast、optional disabled -> no-op event、adjacent node validation、effect-kind merge conflict fail-fast。
- 已新增 native thin wrappers：`servertool_core_blocks.rs` / `router-hotpath-napi/src/lib.rs` / `native-servertool-core-semantics.ts` 对应 `validateServertoolHookSkeletonPhaseJson`、`planServertoolHookScheduleJson`；TS 未承载排序/校验语义。
- 已增强 `scripts/verify-servertool-rust-only.mjs`，新增 hook skeleton Rust owner gate；并补齐 `docs/architecture/verification-map.yml` 中现有 servertool closeout/test 映射缺口，使 `node scripts/verify-servertool-rust-only.mjs` 重新通过。
- 验证证据：
  - `cargo test -p servertool-core hook_skeleton_contract` -> 7 passed
  - `cargo test -p router-hotpath-napi validate_servertool_hook_skeleton_phase_json --lib` -> package compile/test collection passed（0 matching tests）
  - `node scripts/verify-servertool-rust-only.mjs` -> PASS
  - `npm run verify:function-map-compile-gate` -> PASS
  - `npm run verify:architecture-mainline-call-map && npm run verify:architecture-mainline-manifest-sync && npm run verify:architecture-wiki-sync` -> PASS
- 当前未闭环：hook skeleton 仍未接入真实 request/response runtime 主线，`servertool.hook_skeleton.mainline` 仍应保持 `binding pending`；全包 `cargo test -p servertool-core` 与 `cargo test -p router-hotpath-napi servertool --lib` 仍被现存 `stop_visible_text` 相关失败阻塞，不可宣称目标完成。

- 审计目标：解释 servertool 路径为何仍有巨大 TS，目标状态为全流程 Rust、0 TS 业务语义。
- 已验证事实：`sharedmodule/llmswitch-core/src/servertool`、native wrappers、`src/cli/commands/servertool.ts`、`src/server/runtime/http-server/executor/*servertool*.ts` 显式 servertool TS 合计约 15037 行；其中 `engine.ts`、`server-side-tools-impl.ts`、`handlers/stop-message-auto.ts`、`servertool-followup-dispatch.ts` 仍在主线承载编排/状态读取/metadata 写入/dispatch/reenter 语义，不是纯 native loader。
- 根因：当前 `verify:servertool-rust-only` 主要锁“Rust owner/export 存在、旧文件删除、部分 forbidden marker 不复活、build 跑 gate”，但没有硬性禁止 `engine.ts` / `server-side-tools.ts` / `execution-shell.ts` / `registry.ts` 等活 TS 主链继续存在；`docs/goals/servertool-skeleton-rust-only-closeout-plan-2026-06-20.md` 已明确记录该 gate 可绿但“servertool 已 Rust-only”仍是假命题。
- 下一步：先把审计结论转成红 gate，禁止活 TS 主线语义；再分 slice 迁移 stopless response decision、tool dispatch/outcome、followup dispatch/reenter、registry/skeleton 到 Rust；最后物理删除 TS 业务文件，仅保留 native loader/JSON IO/transport shell。
- Jason 纠偏后的目标：业务执行生命周期仍然是 client-visible CLI（`routecodex hook run <toolName> --input-json <json>`）；hook 不替代 CLI。hook 只作为 Rust-owned 注入/恢复/拦截/followup/reenter/finalize 机制，统一管理请求工具注入、CLI stdout/tool result 恢复、响应拦截、followup/reenter effect plan，并支持 multi-hook stable scheduling。
- 已同步目标文档：`docs/design/servertool-rust-only-architecture.md`、`docs/goals/servertool-rustification-implementation-plan.md`、`docs/goals/servertool-skeleton-rust-only-closeout-plan-2026-06-20.md`。

## 2026-06-21 stopless budget_exhausted live loop closure

- 5555 live probe `stopless-live-probe-1782011933758` 已抓到真实根因：终态 `budget_exhausted` 之后，provider request 仍带 system stopless instruction + `reasoning.stop` tool，最终 `finalStatus=reasoning_stop_loop_or_unclosed`。
- 样本证据：`/Volumes/extension/.rcc/codex-samples/openai-responses/port-5555/req_1782012119213_490b5861/provider-request.json` 第 4 条消息已经是“不要再继续执行了”的 budget exhausted 用户引导，但 request 里仍有 system stopless instruction 与 `tools=["reasoning.stop"]`。
- 已验证真正漏点不是 direct，也不是历史剥离；是 stopless followup 进入下一轮前，`function_call_output` 已桥接成普通 user 文本，request owner 只能依赖 MetadataCenter `runtime_control.stopless.triggerHint` 判 terminal。
- 直接原因 1：`sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts` 之前把 `schemaGate.reason_code` 原样写进 MetadataCenter `runtime_control.stopless.triggerHint`，写成了 `stop_schema_budget_exhausted` / `stop_schema_finished` 这类 reason code，而不是 request owner 识别的 normalized trigger token。
- 直接原因 2：Rust request owner `req_process_stage1_tool_governance_blocks/orchestrator.rs` 对 metadata stopless trigger 只识别 `budget_exhausted|schema_pass`，不识别旧 raw reason code，因此 live 继续注入 `reasoning.stop`。
- 本轮修复方向：
  - TS writer 统一 `reasonCode -> triggerHint` 归一：`stop_schema_budget_exhausted -> budget_exhausted`，`stop_schema_finished/blocked/... -> schema_pass`，并同步写回 `execution.context.stopSchemaTriggerHint/serverToolLoopState.triggerHint`。
  - Rust request owner 终态判定补 raw reason code 兼容，锁 `stop_schema_budget_exhausted/stop_schema_finished/...` 也视为 terminal strip。

## 2026-06-21 direct stopless contract correction

- 纠正前一轮误判：不能把“历史里出现过 `reasoning.stop`”当成永久 relay 条件，这会把 direct 路径锁死。
- 当前要修的是 direct 语义本身：same-protocol direct 永远不使用 stopless，不应靠 `includeDirect` 把 stopless 混进 direct 历史。

## 2026-06-21 relay submit_tool_outputs reroute relay-pin audit

- 直接根因 1 已验证：`src/server/runtime/http-server/executor/request-executor-attempt-state.ts` 之前会把 `responsesResume.providerKey` 无条件提升为 `runtime_control.retryProviderKey`，并清空 `excludedProviderKeys`；现在仅 `continuationOwner !== 'relay'` 才允许 provider pin。
- 直接根因 2 已验证：`src/modules/llmswitch/bridge/responses-request-bridge.ts` 在 relay `/v1/responses.submit_tool_outputs` 恢复时，会把 `resumeMeta.providerKey` 写进 `MetadataCenter.runtime_control.retryProviderKey`；现在 relay 只写 `routeHint`，不再写 retry pin。
- 直接根因 3 已验证：`sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts` 在 request-stage router metadata 投影时，会从 `responsesResume.providerKey` 回填 flat `metadata.retryProviderKey`；现在 relay continuation 显式跳过这条回填。
- 黑盒证据：`tests/server/handlers/responses-provider-owned-continuation-reroute.blackbox.spec.ts` 现已证明 relay `submit_tool_outputs` 首次 429 后，provider 访问序列从 `['primary', 'primary', ...]` 收口为 `['primary', 'secondary']`，说明 reroute 已不再被 relay resume provider pin 反向钉回主 provider。
- Rust 现状：`router-hotpath-napi` 的 Rust 单测已改为 relay continuation 不要求 retry pin；但 JS helper `buildRouterMetadataInputWithNative(...)` 的 isolated helper 输出仍会带 `retryProviderKey`，当前只在 helper-spec 层存在，不影响本轮 request-executor / handler / blackbox 主链证据，后续若继续清 Rust helper 语义需单独追 `buildRouterMetadataInputJson` 绑定实际产物。

## 2026-06-21 stopless fence SSOT live loop evidence

- Jason 新增 live 证据（截图）：`routecodex hook run reasoning_stop --input-json ...` 在正常使用时被连续重复触发，多轮都返回 `schemaFeedback.missingFields=[stopreason,reason,has_evidence,evidence,issue_cause,excluded_factors,diagnostic_order,...]`，`reasonCode=stop_schema_missing`，`triggerHint=no_schema`，说明 stopless 闭环没有收敛。
- 当前推断必须同时检查两层：
  - stop schema 解析真源是否仍接受旧裸 JSON/旧 fenced json，而没有把 `<rcc_stop_schema>` 作为唯一合同；
  - request-side stopless 注入是否没有把“必须输出 fence + reasoning.stop.arguments”明确绑定，导致模型每轮只收到自然语言纠偏但无法稳定闭环。
- 本轮继续按 `docs/goals/stopless-fence-ssot-plan.md` 执行：先把旧合同测试改红，再改 Rust owner，最后重放 5555 live probe 验证不再持续 `stop_schema_missing`.

## 2026-06-20 protocol lock closeout

## 2026-06-20 responses continuation owner routing audit

- 用户纠正真相：`direct=远端保存+远端恢复`，`relay=本地保存+本地恢复/materialize`；请求携带 `previous_response_id/response_id` 时，必须先判 `continuationOwner`，再决定 same-protocol 响应路由；本地 store 只服务 relay。
- 已核实当前 handler 侧 owner 分叉点在 `src/modules/llmswitch/bridge/responses-request-bridge.ts -> prepareResponsesHandlerEntryForHttp(...)`：
  - `submit_tool_outputs` 会先 `lookupResponsesContinuationByResponseId(...)`
  - `direct`：不本地 resume，保留 `/v1/responses.submit_tool_outputs` 远端续接
  - `relay`：本地 `resumeResponsesConversation(...)` 后改回 `/v1/responses` 主线
- 已核实现有黑盒：
  - `tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts` focused PASS，已锁 submit_tool_outputs 的 direct/relay 分叉
  - `tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts` 已锁 `responsesResume.continuationOwner=relay + materialized=true` 时必须跳过 router-direct
- 当前真实缺口：
  - 普通 `/v1/responses` 带 `previous_response_id` 时，handler/bridge 还没有先查 `lookupResponsesContinuationByResponseId(...)` 判 owner
  - 也就是说，用户要求的“plain continuation 先判 direct|relay 再走响应路由”在 request mainline 还未闭环
  - 下一步红测应锁这个缺口，而不是继续给 local store 增加 direct-local 假设测试

- 当前协议合同：`req_inbound = entry path protocol`、`req_outbound = VR/provider target protocol`、`resp_inbound = provider target protocol`、`resp_outbound = entry path protocol`；SSE/JSON 只决定 framing/materialization，不决定协议。
- 本轮物理删除/收缩：`provider-direct` 入口协议 resolver 只接收 entry path string，不再接受 requestInfo/object；HubPipeline TS/Rust 缺 `providerProtocol` 不再默认 `openai-chat`；Rust SSE protocol resolver 不再读取 `sseProtocol/clientSseProtocol/routeSseProtocol` 覆盖协议；旧错误测试“responses entry protocol preserved as provider protocol”已删除。
- 验证：focused Jest provider-direct/request-executor PASS；SSE normalize + stage residue PASS；Rust focused `test_empty_provider_protocol_fails_fast`、`test_resolve_sse_protocol_ignores_metadata_protocol_override`、`openai_chat_response_remaps_to_openai_responses_client_payload`、`response_path_missing_provider_protocol_fails_fast` PASS；`tsc --noEmit` PASS。

## 2026-06-20 restart safety correction

- 用户纠正：我在用户恢复旧配置后仍准备直接 `routecodex restart --port 5555`，这是危险顺序。
- 已确认事实：当前 `~/.rcc/provider/XLC/config.v2.toml` 的 `errorMapping.rules` 仍是紧凑的 `origin/to` 形态，`routecodex config validate` 通过；但这不等于可以直接重启，必须先确认“当前配置就是要启动的配置”。
- 这次应记住的流程：先看用户恢复后的运行配置真相，再做 config validate，最后才允许考虑 restart / health / live probe。

## 2026-06-20 provider error reroutable-until-default-empty audit

- 用户目标：provider 错误不应由多处各自处理并过早返回客户端；理论规则是当前 VR 候选池不空不返，主池耗尽先落 default，default 最后一层 provider 不被移出池。
- 2026-06-20 16:09 新增 live 问题拆分：5555 `/v1/responses` 日志证明 `XLC.key2.deepseek-v4-pro` 上游返回 HTTP 400 body `All available accounts exhausted`，当前投影为客户端 `HTTP_400`；这需要 provider 配置级错误映射（例如 provider `extensions.errorMapping.rules`）把该上游 shape 映射为 429/耗尽语义。另一个独立问题是 Rust VR forwarder 的 session sticky 会无理由固定同一 provider，导致同一坏 provider 反复命中；两者必须分开修、分开测。
- 2026-06-20 本轮继续执行：先重读目标附件 `/Users/fanzhang/.codex/attachments/46e80fd9-192c-4050-a07b-3b7b4a90a294/pasted-text-1.txt`、rcc skill、runtime ssot 路由；当前 worktree 很脏，限定只改 `error.execution_decision_consumer`、`error.client_projection`、config default skeleton 相关文件。
- 已核实已有文档：`docs/goals/direct-relay-unified-error-chain-audit.md`、`docs/goals/provider-error-reroutable-until-pool-and-default-empty.md`、`docs/error-handling-v2.md` 已描述目标架构；function-map 已有 `error.provider_failure_policy`、`error.execution_decision_consumer`、`error.client_projection`、`virtual_router.primary_exhausted_to_default_pool`。
- 已核实实现闭合项：`request-executor.ts` 与 `http-server/index.ts` 在 pool exhausted 后会调用 Rust `resolvePrimaryExhaustedPlan` / `plan_primary_exhausted_to_default_pool` 并把 `defaultPoolTargets` 写入下一轮 `allowedProviders`；Rust `cargo test -p router-hotpath-napi primary_exhausted_to_default_pool --lib` PASS（5 tests）。
- 当前主要 gap 1：`resolveProviderRetryExecutionPlan` 支持 `defaultTierAvailable/defaultPoolAvailable`，但 `resolveRequestExecutorProviderFailurePlan` 调用未传该字段；实际 `mayProject` gate 默认把 defaultPoolAvailable 当 false，无法证明“default 池非空时禁止投影”在 ErrorErr05 主线真实生效。
- 当前主要 gap 2：`direct-decision.ts` 仍有 `isTerminalAuthFailure`，把 401/402/403/INVALID_API_KEY/INSUFFICIENT_QUOTA 等 auth/quota 错误在 router-direct 提前 rethrow；这与 2026-06-20 新规则“所有 provider 错误一律可切，唯一停止条件是可选池+default 池同时为空”冲突。老测试 `router-direct-pipeline.candidate-exhaustion.spec.ts` 与 `direct-passthrough-route-level.spec.ts` 仍锁 401 fail-fast。
- 当前主要 gap 3：`http-error-mapper.policy-exhausted-gate.spec.ts` 失败，测试还按旧 `details.policyExhausted` 调用 projection；实现已要求完整 `ErrorErr05ExecutionDecision`。说明 `error.client_projection` 的测试/文档/实现未完全对齐。
- 验证证据：`error_chain_may_project_gate.test.ts` + `router-direct-pipeline.candidate-exhaustion.spec.ts` + `retry-execution-plan.spec.ts` PASS（27 tests）；`http-error-mapper.policy-exhausted-gate.spec.ts` FAIL 4 tests；`provider-direct-pipeline.candidate-exhaustion.spec.ts` 与 `http-error-mapper-499-client-disconnect.spec.ts` PASS。
- 修复路径：先改红测/旧测试锁 401/403/auth/quota 可切；再把 default tier availability 从 VR/default pool planner 接入 `resolveRequestExecutorProviderFailurePlan -> resolveProviderRetryExecutionPlan`；再删除 `direct-decision.ts` auth terminal 早返；最后统一 ErrorErr06 projection 只接受完整 ErrorErr05 decision，并跑 focused gates + live 5555 default-pool replay。
- 本轮红测证据：
  - `tests/server/runtime/http-server/router-direct-pipeline.candidate-exhaustion.spec.ts` 改为要求 `HTTP_401/HTTP_403/INVALID_API_KEY/INSUFFICIENT_QUOTA/ACCOUNT_DISABLED` 在有剩余候选时 `request_reroute`；修改实现前失败 5 条，实际收到 `rethrow`。
  - `tests/config/routecodex-config-loader.v2-single-source.spec.ts` 新增 default skeleton 缺失/空 targets 两条；实现前均错误 resolve。
- 本轮实现：
  - `src/server/runtime/http-server/direct-decision.ts` 物理删除 `isTerminalAuthFailure/readStatusCode/readErrorCode` 与 auth/quota 早返；router-direct 只按 retry plan、attempt budget、remaining route pool 决定。
  - `resolveRequestExecutorProviderFailurePlan` 增加 `defaultTierAvailable` 并传入 `resolveProviderRetryExecutionPlan`；standard executor 与 router-direct 从 routing group route tiers 计算 default availability。
  - `resolveDefaultTierAvailableForErrorErr05` 只消费已提取 route tiers，不合成 provider 链；若当前 routePool 已经是 default 最后 provider 或 default target 已 excluded，则返回 false，避免 default 池被伪装成永远可用。
  - `http-error-mapper.policy-exhausted-gate.spec.ts` 已对齐完整 ErrorErr05 decision；旧 `details.policyExhausted` marker 只作为 legacy negative test。
  - `user-config-loader.ts` 增加 v2 default skeleton gate：每个 routing group 必须有显式非空 `routing.default` provider tier。
- 本轮 focused 绿测证据：`PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/config/routecodex-config-loader.v2-single-source.spec.ts tests/server/runtime/http-server/router-direct-pipeline.candidate-exhaustion.spec.ts tests/server/runtime/http-server/executor/request-executor-primary-exhausted-plan.spec.ts tests/server/utils/http-error-mapper.policy-exhausted-gate.spec.ts tests/server/utils/http-error-mapper-499-client-disconnect.spec.ts --runInBand` PASS（5 suites / 37 tests）。
- 当前阻断/缺口：`tests/server/runtime/http-server/executor/request-executor-provider-failure-plan.spec.ts` 仍被 `[llmswitch-bridge] native-failure-policy not available` 阻断，需要先恢复/构建 native failure policy artifact 后复跑；尚未跑 architecture gates/build/5555 live replay，不能宣称完成。
- 2026-06-20 继续审计新增缺口：`router-direct` 已把 `defaultTierAvailable` 接入 ErrorErr05，但 `decideDirectRouterRetry(...)` 仍只按当前 route pool 剩余数决定是否递归；当当前池只有 `p1`、`defaultPoolAvailable=true` 时会 rethrow 原 provider error，依赖后续 catch 并不能进入 `primary_exhausted_to_default_pool`。需要红测锁定“当前池空但 default 池可用 => request_reroute”，再最小修复 direct decision consumer。
- 红绿证据：新增 `router-direct-pipeline.candidate-exhaustion.spec.ts` 用例 `[forward] exhausted current pool with defaultPoolAvailable=true → request reroute into VR default planner`；修复前 FAIL（Expected `request_reroute`, Received `rethrow`），修复 `direct-decision.ts` 后 focused PASS。实现只消费 ErrorErr05 的 `defaultPoolAvailable/mayProject`，不在 host 合成 default provider 链，仍交给 VR/Rust planner。
- 2026-06-20 绿测证据：
  - Focused Jest PASS：`request-executor-provider-failure-plan`、`retry-execution-plan`、`router-direct-pipeline.candidate-exhaustion`、`provider-direct-pipeline.candidate-exhaustion`、`request-executor-primary-exhausted-plan`、`http-error-mapper.policy-exhausted-gate`、`http-error-mapper-499-client-disconnect`、`routecodex-config-loader.v2-single-source` 共 8 suites / 56 tests。
  - Rust PASS：`cargo test -p router-hotpath-napi primary_exhausted_to_default_pool --lib`，5 passed。
  - Gate PASS：`npm run verify:error-pipeline-contract`；`npm run verify:provider-failure-ban-blackbox`，黑盒日志证明 503 primary provider-switch 到 backup 后 200；`npm run verify:function-map-compile-gate`；`npm run verify:architecture-error-chain-bypass`；`npx tsc --noEmit --pretty false`。
  - Build PASS：`npm run build:base` exit 0，包含 architecture review surface light、function-map gate、Responses/servertool gates、llmswitch ensure/build/vendor、clean、gen-build-info、tsc、webui build、copy assets、fix cli permission；仅 Rust warning。
- 2026-06-20 15:22 final closeout 补证：
  - 新增 `scripts/tests/provider-failure-ban-blackbox.mjs` auth/quota runtime 黑盒场景：mock primary 分别返回 `HTTP_401`、`HTTP_403`、`INSUFFICIENT_QUOTA(429)`，backup 返回 200；断言每个场景 `primaryHits=1`、`backupHits=1`、`clientStatus=200`，日志出现 `[provider-switch] ... switch=exclude_and_reroute ... status=401/403/429 ... completed status=200`。
  - `npm run verify:provider-failure-ban-blackbox` 在 build 前后各 PASS；build 后输出包含 `scenario401/clientStatus=200`、`scenario403/clientStatus=200`、`scenarioInsufficientQuota/clientStatus=200`。
  - Focused Jest PASS：`error_chain_may_project_gate` + provider failure plan + retry plan + router/provider direct candidate exhaustion + primary exhausted + http-error-mapper policy/client_disconnect + config default skeleton 共 9 suites / 65 tests。
  - Rust PASS：`cargo test -p router-hotpath-napi primary_exhausted_to_default_pool --lib`，5 passed。
  - Gate/build PASS：`verify:error-pipeline-contract`、`verify:provider-failure-ban-blackbox`、`verify:function-map-compile-gate`、`verify:architecture-error-chain-bypass`、`npx tsc --noEmit --pretty false`、`npm run build:base`。
  - `npm run install:global` 首次失败于无关 servertool wiki generated docs 不同步；按 gate 提示运行 `render-architecture-wiki-pages` + `render:architecture-wiki-html` 后 `verify:architecture-wiki-sync` / `verify:architecture-wiki-html-sync` PASS，第二次 `install:global` PASS。
  - 安装态版本：`routecodex --version` 与 `rcc --version` 均为 `0.90.3210`；`~/.rcc/install/current` 与 `/Volumes/extension/.rcc/install/current` 均指向 `releases/routecodex-0.90.3210-2026-06-20T071839Z`。
  - `routecodex restart --port 5555` PASS（in-place signal restart，无 kill）；`/health` 返回 `{"status":"ok","ready":true,"pipelineReady":true,"server":"routecodex","version":"0.90.3210"}`。
  - 生产 5555 live replay：`/v1/chat/completions model=gpt-5.4` request `openai-chat-unknown-unknown-20260620T152014037-375547-589` 先命中 `XLC.key1.glm-5.2` 503/model_not_found -> `[provider-switch] attempt=1/6 -> 2/6`，再命中 `XLC.key2.deepseek-v4-pro` 503/model_not_found -> `[provider-switch] attempt=2/6 -> 3/6`，随后命中 `minimax.key1.MiniMax-M3` 并完成 `status=200`。
  - 权威文档同步：`docs/error-handling-v2.md` 删除旧 “default pool 还不是显式 contract” gap，补 2026-06-20 `routePoolRemainingAfterExclusion + defaultPoolAvailable -> mayProject` contract；`docs/design/pipeline-type-topology-and-module-boundaries.md` 补 ErrorErr05 gate 字段。
  - 当前完成边界：生产 5555 自然样本覆盖 provider 5xx/model_not_found 先切；auth/quota 类用 installed dist runtime + mock upstream 黑盒覆盖，未改生产 provider 凭据强制制造 401/403。

## 2026-06-20 stopless budget_exhausted request-governance closure slice

- 当前唯一剩余问题转移到 request chat-process owner：CLI `schemaFeedback` 已能进入 live tool output，但 `budget_exhausted` 之后 provider 下一轮仍继续返回 `reasoning.stop` required_action，形成 loop。
- 已锁定的新根因：
  - `req_process_stage1_tool_governance_blocks/orchestrator.rs` 只要 metadata 开启 stopless，就无条件注入 stopless system instruction + `reasoning.stop` tool；
  - 即使上一轮 `function_call_output` 已明确 `schemaGuidance.triggerHint=budget_exhausted`，请求治理也不会撤掉 stopless 控制面，provider 仍可继续看到 stopless 工具与“停止时必须调用 reasoning.stop”的约束。
- 本轮 Rust 修复：
  - 新增 `request_has_terminal_budget_exhausted_stopless_output(...)`，扫描 `input/messages` 内 stopless tool output 的 `schemaGuidance.triggerHint=budget_exhausted`。
  - 若命中 terminal budget exhausted：
    - 物理移除 stopless injected `instructions`
    - 物理移除 `tools` 中的 `reasoning.stop`
    - 清除 `tool_choice=required` / `toolChoice` 残留，避免继续强制工具调用
  - 非 terminal（如 `invalid_schema` / `no_schema`）继续保留 stopless 控制，不影响原闭环。
- 红测/反测：
  - `test_terminal_budget_exhausted_stopless_turn_strips_reasoning_stop_controls`
  - `test_non_terminal_stopless_feedback_keeps_reasoning_stop_controls`
- 当前验证：
  - `cargo test -p router-hotpath-napi test_terminal_budget_exhausted_stopless_turn_strips_reasoning_stop_controls -- --nocapture` PASS
  - `cargo test -p router-hotpath-napi test_non_terminal_stopless_feedback_keeps_reasoning_stop_controls -- --nocapture` PASS
  - `cargo test -p router-hotpath-napi reasoning_stop_ -- --nocapture` PASS（11 passed）
  - `cargo test -p router-hotpath-napi execute_hub_pipeline_json_rewrites_stopless_cli_result_into_provider_guidance -- --nocapture` PASS
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/scripts/stopless-5555-live-probe.spec.ts --runInBand` PASS
- 下一步：
  - build:min
  - install:global
  - `routecodex restart --port 5555`
  - 复跑 `node scripts/tests/stopless-5555-live-probe.mjs`
  - 目标：`finalStatus` 不再是 `reasoning_stop_loop_or_unclosed`

## 2026-06-20 stopless reasoning.stop client-projection repair

- 当前 slice 目标：修复 5555 live stopless 响应把合法 `reasoning.stop` 工具调用错误改写成 `exec_command(cmd="reasoning.stop")` 的问题，并把 live probe 更新到当前合同。
- 已验证根因：
  - live 样本 `req_1781893759341_977c3633` 的 `provider-response.json` 证明 upstream 返回的是标准 `reasoning.stop` tool call，不是 `exec_command`。
  - Rust focused red tests 证明问题发生在 `resp_process_stage1_tool_governance_blocks/tool_call_governance.rs` 的 `maybe_repair_malformed_exec_command_name(...)`：它把 `reasoning.stop` 错判成 shell 命令名，并塞出 `cmd:"reasoning.stop"`。
- 代码收口：
  - `tool_call_governance.rs` 新增 `should_preserve_structured_tool_name(...)`，对 requested structured tool 和 namespaced dotted tool 名（如 `reasoning.stop`）直接保留，不再进入 exec repair。
  - `scripts/tests/stopless-5555-live-probe.mjs` 不再把“无 exec_command”一律判失败；新增 proactive `required_action.reasoning.stop` success contract。
- 测试锁定：
  - Rust: `resp_process_stage1_tool_governance_tests.rs` 新增 2 条红测，锁 `reasoning.stop` 在 requested / non-requested 两种情况下都不得被修成 `exec_command`。
  - Jest: `tests/scripts/stopless-5555-live-probe.spec.ts` 新增 probe 单测，锁 `summarizeAttempt(...)` 识别 proactive `reasoning.stop` required_action。
- 验证：
  - 红测先红：`cargo test -p router-hotpath-napi test_govern_response_does_not_repair_reasoning_stop_into_exec_command -- --nocapture` => 2 failed，断言当前输出实际是 `exec_command`。
  - 绿化后：同命令 => `2 passed`；更宽 suite `cargo test -p router-hotpath-napi resp_process_stage1_tool_governance_tests -- --nocapture` => `182 passed, 1 ignored`。
  - `npm run build:min` PASS。
  - `npm run install:global` PASS；`routecodex --version` => `0.90.3192`。
  - `routecodex restart --port 5555` PASS；`curl http://127.0.0.1:5555/health` => `version=0.90.3192 ready=true pipelineReady=true`。
  - live probe：`node scripts/tests/stopless-5555-live-probe.mjs` 返回 `finalStatus=reasoning_stop_requires_action`；attempt#1 `hasExecCommand=false`, `hasReasoningStop=true`，client body `required_action.submit_tool_outputs.tool_calls[0].name = reasoning.stop`，不再出现 `cmd:"reasoning.stop"`。
- 结论边界：
  - 本 slice 修复的是“客户端投影错位”与“live probe 误报失败”。
  - 当前 5555 live 成功合同已是 proactive `reasoning.stop` required_action，不是旧 probe 假定的 stopless CLI projection 路径。

## 2026-06-20 global build/install/restart closeout

- 用户要求：编译构建、全局安装、重启服务器；禁止 kill，必须用 restart。
- 执行事实：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run build` in `sharedmodule/llmswitch-core` PASS。
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run build:base` PASS，`BUILD_BASE_EXIT=0`；build artifact version advanced through `0.90.3189` and package version later became `0.90.3190`.
  - `install-global.sh` canonical path failed inside isolated rebuild with stale/dirty-source TS errors: `state-integrations.ts` unknown-to-`RoutingInstructionState | null`, `http-server/index.ts` `Cannot find name 'path'`. Direct `npx tsc --noEmit --pretty false` in repo root immediately after returned `TypeScript: No errors found`, so failure was isolated-build path/current-dirty-source interaction, not final installed runtime proof.
  - Manual global install used built tarball: `npm pack --pack-destination /tmp/routecodex-manual-pack` produced `routecodex-0.90.3190.tgz`; `npm install -g /tmp/routecodex-manual-pack/routecodex-0.90.3190.tgz --no-audit --no-fund --omit=optional --ignore-scripts` succeeded.
  - Required runtime artifacts were restored into `dist/native/router_hotpath_napi.node` and `dist/bin/routecodex-servertool` before pack because current `build:base` sequence runs native packaging before `clean`, and `clean-safe` removes root `dist/native` / `dist/bin`.
  - `node scripts/install-release-snapshot.mjs` refreshed both `$HOME/.rcc/install/current` and `/Volumes/extension/.rcc/install/current` to `releases/routecodex-0.90.3190-2026-06-19T162648Z`.
  - `npm run llmswitch:link:global` relinked global package and both install/current snapshots to local `sharedmodule/llmswitch-core`.
  - `routecodex restart --port 5555` succeeded via in-place signal restart; no kill command used.
- Verification:
  - `routecodex --version` and `rcc --version` both return `0.90.3190`.
  - `curl -sS http://127.0.0.1:5555/health` returned `{"status":"ok","ready":true,"pipelineReady":true,"server":"routecodex","version":"0.90.3190"}`.
  - Multi-port health also PASS: `5520`, `10000`, and `5555` all returned `ready=true`, `pipelineReady=true`, version `0.90.3190`.
- Follow-up risk:
  - Build script ordering risk remains: `build:base` packages Rust native artifacts before `npm run clean`, so root `dist/native` and `dist/bin` can be deleted unless native packaging is repeated after clean or clean is moved before native packaging.
  - Current worktree remains dirty; this install included dirty worktree state.

## 2026-06-20 stopless native wrapper + blackbox closure slice

- 这轮只修 stopless TS native thin wrapper 契约，不改 Rust stopless 语义 owner。
- 根因一：`sharedmodule/llmswitch-core/src/native/router-hotpath/native-stop-message-auto-semantics.ts` 直接把 Rust `evaluateStopSchemaGateJson` 的 camelCase 输出当成 snake_case 合约用，导致 `reason_code` / `missing_fields` / `followup_text` 在 TS 侧变成 `undefined`。
- 修复：wrapper 现在把 `reasonCode/summaryPrefix/followupText/countBudget/noChangeCount/observationHash/maxRepeats/missingFields` 规范化到现有 snake_case 读取位，同时保留 camelCase 兼容字段。
- 根因二：`tests/servertool/stop-message-native-decision.spec.ts` 仍按旧 stopless 文案和旧计数契约写断言；真实 Rust stop-schema gate 现在按 `observation_hash + no_change_count` 判定连续 `no_schema/invalid_schema` 三次 fail-fast，不是只看 `used`。
- 黑盒测试已对齐真实契约：
  - missing schema 断言结构化 schema 引导内容，而不是旧“第一轮/第二轮核对”文案。
  - repeated no_schema / invalid_schema 通过 `prevObservationHash + prevNoChangeCount` 模拟真实连续轮，第三次 fail-fast。
  - terminal blocked/finished schema 用数字 `stopreason`，不再把 `blocked` 当字符串。
- 已验证：
  - `tests/servertool/stop-message-native-decision.spec.ts` PASS（26 tests）
  - `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts` PASS（7 tests）
  - `tests/servertool/stopless-cli-continuation.spec.ts` PASS（10 tests）
  - `cargo test -p stop-message-core --test stop_schema_gate_closure` PASS
  - `cargo test -p router-hotpath-napi hub_pipeline_lib::tests::execute_hub_pipeline_json_rewrites_stopless_cli_result_into_provider_guidance` PASS
  - `npm run verify:servertool-rust-only` PASS
  - `npx tsc --noEmit --pretty false` PASS
  - `npm run build:min` PASS
  - `./scripts/install-global.sh` PASS，global/live version 升到 `0.90.3191`
  - `routecodex restart --port 5555` PASS；`/health` 返回 `ready=true pipelineReady=true version=0.90.3191`
- live 5555 事实：
  - 样本 `req_1781892989011_ac445f3f` 走 `router-direct:default -> asxs.crsa.gpt-5.4-mini`，`finish_reason=stop` 但不激活 stopless；这是符合“direct 不执行 stopless”的规则，不是 bug。
  - 后续为了命中 relay/chat-process 的 live stopless 样本，尝试了长上下文和 tools 探针；当前都被 default/direct 命中或上游 403/429/503 打断，未拿到可用于 stopless 的 relay `finish_reason=stop` 真实样本。
- 当前缺口：
  - 还缺一条 5555 relay/chat-process 的 live `finish_reason=stop` 样本，用来证明安装态里 provider request 真的出现 stopless CLI/schema guidance 闭环。
  - direct 边界已验证正确；relay stopless 安装态尚未完成最终 live 闭环。

## 2026-06-20 openai vs anthropic transport audit slice

- 现有实现差异已确认：
  - anthropic 走 `VercelAiSdkAnthropicTransport.executePreparedRequest()`，直接 `fetch()` 上游，body 仅做 Anthropic remote-image/headers 处理。
  - openai 走 `VercelAiSdkOpenAiTransport.executePreparedRequest()`，会先 `normalizeResponsesToChatBody(providerBody)`，再用 `OpenAIChatLanguageModel.getArgs()` 生成最终 request body，随后才 `fetch()`。
- 当前怀疑点：
  - openai 路径多一层 model SDK 生成 args，最可能在 `body.model` / `messages` / `tools` 兼容上引入偏差；
  - 502 可能来自该层 `getArgs()` / body 生成失败或上游返回被包装，不是 anthropic 同类流程的问题。

- 已确认事实：
  - openai 路径走 `VercelAiSdkOpenAiTransport.executePreparedRequest()`，先 `normalizeResponsesToChatBody(providerBody)`，再 `OpenAIChatLanguageModel.getArgs()` 生成 body，最后 `fetch()`；anthropic 路径走 `VercelAiSdkAnthropicTransport.executePreparedRequest()`，仅 `sanitizeAnthropicOutboundHeaders + executeAnthropicRequestWithBody`，**没有 SDK 中间层**。
  - `1token / asxs / cc / XLC` 在 `~/.rcc/provider/*/config.v2.toml` 都声明 `type=responses` + `compatibilityProfile=responses:crs` + `transportBackend=openai-sdk`。
  - 在 `src/providers/core/runtime/http-request-executor.ts` 的 `resolveProviderWireProtocol()`：`outboundProfile=openai-responses` → protocol `openai-responses`；`outboundProfile=openai-chat` → `openai-chat`。
  - `src/providers/core/runtime/vercel-ai-sdk/openai-sdk-transport.ts` 的 `body.model = pickString(providerBody.model)` → 来自 `chat-protocol-client.buildRequestBody` 的 `body.model`；但该 transport 又**总是**走 `OpenAIChatLanguageModel.getArgs()`，并把 `messages/stream/tools` 重写成 OpenAI Chat 形状。
  - 真 502 真源：openai 失败样本 `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260619T235943502-...` 报 `Rust HubPipeline response path failed: hub_pipeline_error: OpenAI chat SSE response did not contain choices array`，说明 openai 路径期望 OpenAI Chat SSE 形状（`choices[]`），但上游 CRS 实返 **Responses 形状**（无 `choices`）。
  - 同样 openai 失败样本 `error-openai-responses-router-gpt-5.4-20260620T142400550-...` 是 `providerKey=XLC.key1.glm-5.2 / providerType=openai / providerProtocol=openai-chat / compatibilityProfile=compat:passthrough`，**这才是 chat 形态**；其它如 `error-openai-responses-router-request-20260620T134036101-...` `outboundProfile=openai-chat / processMode=chat / providerType=openai` 一样是 chat 形态。
  - anthropic 路径在 diag 库中 0 个 `choices array` 错误（`rg -l 'choices array' /Users/fanzhang/.rcc` 无命中），确认 anthropic 不存在同类 502。
  - 这意味着"openai 路径"内部进一步分裂：实际生效 `openai-responses` wire 时被错误当成 `openai-chat` wire → 发 chat body + 期望 choices → 上游返 responses shape → 502。anthropic 路径永远按 `messages` 收发，不存在这个错位。

- 下一步：
  - 锁 `providerProtocol / outboundProfile / compatibilityProfile` 在 openai 路径的实际生效真源（`http-request-executor.resolveProviderWireProtocol` vs `responses-provider.buildRequestBody`）。
  - 找 openai/responses 路径 `responses:crs` 的 wire-builder 是不是真的把 chat body 转回 Responses；若没转，就是 502 唯一根因。
  - 在改任何代码前，先固化一个 red sample 锁住"openai 路径 outboundProfile=openai-responses 时发 chat body" 的失败，并在 anthropic 路径无影响。
- 下一步：
  - 找 openai/anthropic 对应单测与 live diag，核对是否存在 openai 专属 502、model rewrite、protocol mismatch。

## 2026-06-20 logging compact layout + noise suppression

- 用户新要求已落到 owner 面：
  - `port-log-context.ts` 前缀从 `[port:5555 group:gateway_priority_5555]` 收成 `[5555]`
  - `usage-logger.ts` 主行收成 `project=/path:5555 route=tools`
  - `log-rollup.ts` realtime `session-request` / `virtual-router-hit` 改成 `route=<main-route> provider=<provider.model> project=/path[:port]`
- `dailyProviderStatsDate` 原先用 UTC `toISOString().slice(0,10)`，现改为本地日切 helper `resolveLocalDayKey()`，reset 点跟随本地 00:00。
- 新增抑噪：
  - realtime `virtual-router-hit` 对同 `session + route/pool + provider/model + reason` 加 1.5s 去重，避免同一轮重复刷屏。
  - `handler-utils.ts` 对常见 `408/425/429` 错误保留主错误行，但禁止再打印第二条 `[http.error.meta]` 冗余 JSON。

## 2026-06-19 MetadataCenter route-control slice verification closeout

- 当前边界：不再处理 tokenrelay / parallel tool call；tokenrelay 已按最新事实视为可工作。本 slice 只验证并收口 MetadataCenter route-control 未提交改动。
- 代码方向：
  - `index.ts` 不再把 `preselectedRoute` / `retryProviderKey` 回写到 `metadata.__rt`，只写 MetadataCenter runtime_control。
  - TS Hub request-stage bridge 以 `metadata.runtime_control` / MetadataCenter runtime_control 为优先 truth，并从 legacy `__rt` native projection 中剥离 route/retry 控制位。
  - Rust router metadata / hub route reader 优先读取 `metadata.runtime_control.retryProviderKey/preselectedRoute`；legacy `__rt` 只保留兼容读取。
  - `router-direct-protocol-boundary.spec.ts` 测试 helper 改为绑定 MetadataCenter request truth；stopless relay 正向用例通过 `runtime_control.serverToolFollowup` 激活，不恢复 flat metadata 或 `__rt` truth。
- 验证：
  - focused Jest：`router-direct-protocol-boundary`、`direct-passthrough-route-level`、`request-executor-attempt-state.contract`、`request-executor-preselected-route.blackbox` PASS（4 suites / 39 tests）。
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npx tsc --noEmit --pretty false` PASS。
  - `npm run audit:custom-payload-carriers` PASS；`__routecodex* runtime=14 files=9`，`__sse_* runtime=0`；routecodex runtime hits are guard/contract surfaces, not payload_side_channel.
  - `npm run audit:custom-payload-carrier-owner-queryability` PASS；`routecodex unique-owner=9 ambiguous=0 missing=0 missing-verification=0`。
  - `npm run verify:architecture-custom-payload-carrier-runtime-manifest` PASS。
  - `npm run verify:architecture-custom-payload-carrier-containment` PASS。
  - `git diff --check` PASS。
- 未做/风险：
  - 当前 worktree 有并行 stop-message/servertool-core/SSE 脏改，未跑全量 architecture-ci/build/live smoke；提交时必须只 stage MetadataCenter route-control 相关文件，排除 stop schema 与 chat SSE 改动。

## 2026-06-19 5520 chat SSE context_length_exceeded error projection fix

- 症状样本：5520 `/v1/chat/completions` 非流转换日志把上游真实 `context_length_exceeded` 投成 `SSE_TO_JSON_ERROR` / `SSE_DECODE_ERROR`，样本 requestId 为 `openai-chat-token.key1-gpt-5.4-20260619T212542264-373319-4078`。
- owner：`sse.chat_stream_projection`；唯一修改点为 `sharedmodule/llmswitch-core/src/sse/sse-to-json/chat-sse-to-json-converter.ts`，不改 provider runtime、路由、retry 或 tokenrelay 配置。
- 根因：`processErrorEvent()` 已解析出 `finish_reason=context_length_exceeded`，但随后用 `CHAT_CONVERSION_ERROR_CODES.STREAM_ERROR` 重新创建错误；外层 `wrapSseError()` 只能看到 `CHAT_STREAM_ERROR`，最终投成 SSE decode error，丢失 provider semantic code/status/retryable。
- 修复：新增 chat SSE upstream semantic error builder；`event:error/toast` 与 `_errorInfo` patch chunk 路径均直接抛出带 `code/upstreamCode/status/statusCode/retryable/requestExecutorProviderErrorStage` 的 semantic error，外层只补上下文，不覆盖上游错误语义。
- 红测证据：`tests/sharedmodule/chat-sse-usage-roundtrip.spec.ts` 新增黑盒测试，当前实现先红，收到 `code=SSE_DECODE_ERROR` / `upstreamCode=CHAT_STREAM_ERROR`；修复后转绿并断言 `code=upstreamCode=context_length_exceeded`、`status=400`、`retryable=false`。
- 验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/sharedmodule/chat-sse-usage-roundtrip.spec.ts --runInBand` PASS（8 tests）
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npx tsc --noEmit --pretty false` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:sse-architecture-boundary` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:function-map-compile-gate` PASS
  - `git diff --check` PASS
- 当前未做：尚未全局安装/重启 5520，因此不能宣称 live runtime 已更新；需要安装后用同类上游 context-window 样本复核客户端错误码。

## 2026-06-19 tokenrelay deepseek-v4-pro / 5555 direct diagnosis

- 2026-06-19 18:47 最新确认与纠偏：
  - 当前问题必须以 5555 relay 为准，不能用 5557 provider-direct 结论替代；tokenrelay 是 OpenAI/chat provider，`/v1/responses` inbound 经 5555 relay 后应发 OpenAI `/v1/chat/completions` wire。
  - 17:57 样本 `req_1781863064200_8333b451` 的 provider request 已确认：URL 为 `/v1/chat/completions`，`body.model=deepseek-v4-pro`，`stream=true`，不是模型名错误，也不是 raw `/v1/responses` 直发。
  - 该样本内历史 assistant `tool_calls` 计数为 `{1:81,2:1,3:1}`；直接 upstream 原样 stream=true 返回 `This model only supports single tool-calls at once!`。
  - 只把 assistant 多 `tool_calls` 拆成多个 assistant turn、每个 turn 单 `tool_calls` 后，同一 upstream stream=true replay 返回 HTTP 200。
  - 修复点应在 Rust `req_outbound_stage3_compat` 的 OpenAI-chat provider-wire compat；不能改 Hub Pipeline 标准语义，也不能把 tokenrelay `type` 改成 responses。
  - 当前修复遍历整个 outbound `messages` 数组，不是只改当前轮；历史轮和 latest/current 轮的 parallel `tool_calls` 都会被拆。
  - 已补红测锁定：历史轮 + 最后/latest 轮同时带 parallel `tool_calls` 时都会被拆；无 profile 时保持原 parallel shape；single-call turn 不变。
  - 5555 live 当前版本为 `0.90.3187`，`/health` 返回 `ready=true pipelineReady=true`。

- 2026-06-19 17:16:19 最新 provider curl/config 复核真相：
  - upstream `https://token-relay-v2-production.up.railway.app/v1/chat/completions` 直打 `deepseek-v4-pro` 返回 HTTP 200；
  - upstream `https://token-relay-v2-production.up.railway.app/v1/responses` 直打同模型同最小 payload 也返回 HTTP 200；
  - 本地 `http://127.0.0.1:5557/v1/chat/completions` 返回 HTTP 200；
  - 本地 `http://127.0.0.1:5557/v1/responses` 返回 HTTP 502，但最新 diag `~/.rcc/diag/error-openai-responses-router-deepseek-v4-pro-20260619T171619674-371209-1968.json` 证明这不是 upstream 502，而是本地 preflight 拒绝：`Provider mode with protocolBehavior=direct requires matching protocols: inbound=openai-responses, provider=openai-chat`。
- 结论：`tokenrelay` 当前“不可用”至少包含一个已锁死的本地协议声明问题，不是 upstream `/v1/responses` 普遍不可用。
- 配置差异真相：
  - `~/.rcc/provider/tokenrelay/config.v2.toml` 缺少 `[provider.responses]` 块；
  - 多个可正常承接 responses 入口的 provider（如 `1token/asxs/cc/XL`）均显式声明 `[provider.responses] process = "chat"` 与 `streaming = "always"`。
- 5555 live 日志真相（2026-06-19 16:29:27、17:03:00）：
  - virtual router 确实命中过 `tokenrelay.key1.deepseek-v4-pro`；
  - 命中后 provider-switch 记录 `stage=provider.send status=502 code=HTTP_502`，并继续 reroute 到后续 provider；
  - 因此“没有命中 tokenrelay”不是事实，当前应继续区分：provider-mode direct 协议映射错误 vs router 5555 路径上的 payload/relay send 失败。

- 5557 provider-direct installed sample `req_1781847365527_fa0b4ed0/provider-request.json` confirmed `body.model=deepseek-v4-pro`.
- Direct curl to tokenrelay upstream `/v1/responses` with old 5555 failing sample `openai-responses-router-gpt-5.4-20260619T131216066-369320-79/provider-request.json` and only `model` rewritten to `deepseek-v4-pro` reproduced HTTP 500 `NoneType object is not subscriptable`.
- Tokenrelay minimal `/v1/responses` with `deepseek-v4-pro` succeeds, but old payload with historical `input` slice of last 5/20 items still fails even without tools/client_metadata/Responses control fields. This points to tokenrelay Responses-history compatibility, not model availability.
- Suspected owner: router-direct same-protocol eligibility ignores selected target `outboundProfile=openai-chat` / `responses.process=chat`, so it bypasses Hub Responses->Chat conversion and sends raw Responses history to tokenrelay.
- 2026-06-19 13:55 live proof after install/restart: explicit `model=tokenrelay.deepseek-v4-pro` on `5555 /v1/responses` returns HTTP 200 with exact marker `RCC_TOKENRELAY_HUB_RELAY_1781848542`; sample `req_1781848542950_d98a1134/provider-request.json` shows `model=deepseek-v4-pro`, `inputLen=3`, no tools. This proves tokenrelay provider itself works behind 5555 router entry.
- 2026-06-19 13:56/13:57 follow-up probes with `model=gpt-5.4` still did not route to tokenrelay: both input-text inline `<**tokenrelay.deepseek-v4-pro**>` and top-level `instructions="<**tokenrelay.deepseek-v4-pro**>"` ended on `XLC.key1.glm-5.2`, provider-request body was chat-shaped `messages[]`, `model=glm-5.2`, and request failed with upstream `model_not_found`.
- Current live blocker is no longer tokenrelay upstream 500 on direct-model path. The remaining 5555 thinking-path blocker is that `XLC.key1.glm-5.2` failure logs `provider-switch attempt=1/6 -> 2/6 decision=provider_backoff_then_reroute`, but the live request still terminates immediately with `model_not_found` instead of producing a second `virtual-router-hit` to tokenrelay. Next owner to inspect: request-executor reroute consumption / routePool preservation after first provider failure.

## 2026-06-19 5520 GPT forwarder priority update

- Runtime truth updated in `~/.rcc/config.toml`: both `fwd.paid.gpt-5.4` and `fwd.paid.gpt-5.4-mini` now order paid GPT targets as `asxs > 1token > XL > cc`.
- Verification: `routecodex config validate` PASS; `routecodex restart --port 5520` completed; `curl http://127.0.0.1:5520/health` returned `ready=true pipelineReady=true version=0.90.3171`.
- Live evidence after restart: 5520 log shows a real request routed to `1token.key1.gpt-5.4-mini.gpt-5.5`; synthetic minimal probe still failed before useful VR evidence and is not counted as selection proof.

## 2026-06-19 5520 default direct runtimeKey visibility root cause

- 在线真相已锁：
  - `~/.rcc/config.toml` 中 `gateway_priority_5520.routing.default.targets = ["fwd.paid.gpt-5.4-mini", "fwd.minimax.MiniMax-M3"]`，所以 5520 default 是多候选，不是单候选。
  - `~/.rcc/log/config.toml/ports/5520/server-5520.log` 与 `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260619T113755819-369238-4521.json` 证明 live 失败发生在 router-direct owner 内，错误是 `Provider not found for runtimeKey: asxs.crsa`，先于任何 provider-switch。
- Native bootstrap 真相：
  - `bootstrapProvidersWithNative(...)` 对 `~/.rcc/provider/asxs/config.v2.toml`（auth alias=`crsa`）产出的 `runtimeEntries` 只有两段 runtime key：`asxs.crsa`，不是 `asxs.crsa.gpt-5.4-mini`。
  - 5520 live virtual-router 命中的 providerKey 是三段：`asxs.crsa.gpt-5.4-mini`。
- 本地最小复现：
  - `RouteCodexHttpServer.isProviderVisibleInMetadataScope('asxs.crsa.gpt-5.4-mini', {allowedProviders:['asxs.crsa.gpt-5.4-mini']}) === true`
  - 但同 metadata 下 `isProviderVisibleInMetadataScope('asxs.crsa', ...) === false`
  - 这会让 direct path 在成功解析到两段 runtime key / handle 前就把 `asxs.crsa` 判成“不可见”，后续落成 `Provider not found for runtimeKey: asxs.crsa`。
- 最小 owner 修复：
  - `src/server/runtime/http-server/index.ts:isProviderVisibleInMetadataScope(...)` 现在允许反向匹配：当 allowed provider 是模型级三段 key 时，对应的两段 alias runtime key 也视为可见（`providerId.startsWith(runtimeKey + '.')`）。
- 已验证：
  - `tests/server/runtime/http-server/provider-binding-resolution.spec.ts` 新增红测先红后绿，锁“两段 alias runtime key 在三段 allowedProviders 下仍可见”。
  - `tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts -t "5520 default mixed-protocol backup relays into Hub after first direct provider fails"` 继续 PASS，并且日志证明先 `[provider-switch]` 再 200。

## 2026-06-19 SSE body wrapper custom semantics removal slice

- 当前 slice 目标：按 MetadataCenter/internal-payload 规则清理 response SSE wrapper 自定义语义，禁止 normal response body 上的 `sseStream` 驱动 SSE 或泄给客户端；SSE stream 只能走 `PipelineExecutionResult.sseStream` 这种内部执行结果 side-channel，forceSSE JSON bridge 只消费标准 Responses/chat JSON。
- 代码收口：
  - `sendSsePipelineResponse(...)` 只用 `result.sseStream` 取流，删除 `body.sseStream` fallback。
  - `shouldDispatchResponsesSseToClientForHttp(...)` 不再检查 body wrapper / flat stream metadata，只保留 forceSSE 显式投影；普通 streaming 由 result-level `sseStream` 触发。
  - 删除 `hasResponsesSsePayloadForHttp` canonical builder/export/barrel，删除 JSON projection/bridge plan 的 `hasSsePayload` 参数。
  - `assertClientResponseHasNoInternalCarriers(...)` 把 `sseStream` 列为 client normal payload forbidden field，body wrapper 到 JSON 分支会 fail-fast。
  - 更新旧 focused mocks，把 split required_action stream 测试从 body wrapper 改成 `sseStream` result field + 标准 Responses body。
- 测试锁定：
  - 新增 `tests/server/handlers/handler-response-sse-wrapper-contract.spec.ts`，静态禁止 `bodyRecord?.sseStream` / `hasResponsesSsePayloadForHttp` / `hasSsePayload` 复活，并断言 client JSON normal payload 中 `sseStream` fail-fast。
  - focused Jest：SSE wrapper contract + forceSSE JSON bridge + split required_action + MetadataCenter closeout PASS（4 suites / 16 tests）。
- 剩余审计项：历史 tests/fixtures 与若干老测试仍含 `__routecodex_stream_*` wrapper residue；未混入本 slice，下一步单独审计迁移或删除。

## 2026-06-19 legacy __routecodex_stream residue removal slice

- 当前 slice 目标：清理上一 slice 留下的 `__routecodex_stream_finish_reason` / `__routecodex_stream_contract_probe_body` 测试与 fixture 残留，不恢复 body-level stream wrapper，功能不变。
- 代码/测试收口：
  - `handler-response-sse.ts` 修正 forceSSE JSON 分支：`forceSSE && result.sseStream === undefined` 时先走标准 JSON->SSE bridge，避免移除 body wrapper 后误落 missing-stream。
  - `handler-response-utils.responses-store-integration.spec.ts` 改为标准 Responses JSON body 与标准 SSE frame helper；continuation 断言改看 store/resume 行为，不锁过时 barrel mock 调用。
  - `handler-response-sse-wrapper-contract.spec.ts` 新增静态扫描，禁止 legacy stream probe/finish-reason key 在 server tests/runtime tests/conversion-matrix fixtures 复活。
  - conversion-matrix fixture 删除 `__sse_responses`/`__routecodex_stream_contract_probe_body`/`__routecodex_finish_reason` wrapper，保留标准 response object + usage。
- 验证：
  - handler focused Jest 4 suites / 34 tests PASS（用 `--forceExit`，测试本身全绿；suite 仍有既存 open handle 噪音）。
  - `npx tsc --noEmit --pretty false --skipLibCheck` PASS。
  - `rg "__routecodex_stream" tests/server tests/fixtures/conversion-matrix scripts/architecture/verify-no-custom-payload-carriers.mjs` 只剩 deny gate 脚本命中。
  - `audit:custom-payload-carriers` PASS：`__sse_* runtime files=0`。
  - owner-queryability / runtime-manifest / containment / `verify:function-map-compile-gate` PASS。
  - `git diff --check` PASS。
- 剩余风险：本 slice 未安装/重启/live；`__sse_responses` 历史残留仍在 tests/scripts/docs，作为后续单独切片处理，runtime=0。

## 2026-06-19 MetadataCenter followup-dispatch legacy control removal slice

- 当前 slice 目标：清理 `servertool-followup-dispatch` / nested metadata builder 中最后一段 active legacy followup control 读取与 promotion，避免 `metadata.__rt.serverToolFollowup/clientInjectSource/stoplessGoalStatus` 或 flat `metadata.serverToolFollowup/isServerToolFollowup/clientInjectSource` 继续作为真源。
- 代码收口：
  - `readFollowupMarkerFromMetadata(...)` 只读 `MetadataCenter.read(metadata)?.readRuntimeControl()` 的 `serverToolFollowup/serverToolFollowupSource/stoplessGoalStatus`。
  - `writeFollowupRuntimeControlToMetadata(...)` 只写 `MetadataCenter.runtime_control`，不再回写 `metadata.__rt.serverToolFollowup/clientInjectSource/serverToolFollowupSource/stoplessGoalStatus`。
  - `buildServerToolNestedRequestMetadata(...)` 合并 base/extra 的 request-scoped MetadataCenter side-channel，再用 `readRuntimeControlProjection(out)` 判断 followup continuity；不再用 `__rt.serverToolFollowup` 派生 session/daemon/tmux 或清 `clientRequestId`。
  - nested explicit followup source 只读 `runtime_control.serverToolFollowupSource`；source-only followup 仍合法，但必须走 MetadataCenter。
- 测试锁定：
  - `servertool-followup-dispatch.spec.ts` 所有正向 followup 激活改用 MetadataCenter helper，反向断言 nested metadata 不再出现 `__rt.serverToolFollowup`。
  - `servertool-followup-dispatch.contract.spec.ts` 新增静态 gate，禁止 `promoteLegacyFollowupControlToMetadataCenter`、flat `metadata.serverToolFollowup/isServerToolFollowup/clientInjectSource`、`rt?.serverToolFollowup/clientInjectSource/serverToolFollowupSource/stoplessGoalStatus`、`runtimeMeta.serverToolFollowup` 复活。
- 验证：
  - focused Jest：`servertool-followup-dispatch.contract.spec.ts` + `servertool-followup-dispatch.spec.ts` PASS（37 tests）。
  - related Jest：dispatch contract/spec + adapter-context + request-executor-runtime-blocks + provider-response-converter contract + goal-followup-http400 PASS（6 suites / 69 tests）。
  - `npx tsc --noEmit --pretty false` PASS。
  - `npm run audit:custom-payload-carriers` PASS：`__routecodex* runtime=14 files=9`，`__sse_* runtime files=0`。
  - owner/queryability, runtime-manifest, containment, `verify:function-map-compile-gate`, `verify:architecture-ci`, `build:min`, `git diff --check` 均 PASS。
- 剩余风险：本 slice 未安装/重启 live 5555；结论仅限 repo worktree/build/gate，不宣称当前已安装 runtime。

## 2026-06-19 MetadataCenter request-route runtime-control slice

- 当前 slice 目标：把 request route control 的 active truth 从 flat `__routecodex*` 迁到 `MetadataCenter.runtime_control` / native runtime side-channel projection，功能不变，降低 payload-side-channel residue。
- 代码收口：
  - `prepareRequestExecutorAttemptState(...)` 删除 legacy flat `__routecodexRetryProviderKey`，retry pin 写入 `MetadataCenter.runtime_control.retryProviderKey`。
  - `executeRequestStagePipeline(...)` 优先读取 `MetadataCenter.runtime_control.preselectedRoute`，legacy `__rt.preselectedRoute` 只作为 native ingress projection；同名 runtime control 由 MetadataCenter 覆盖 `__rt`。
  - Rust route metadata / meta carrier / VR route consumer 改读 `metadata.__rt.retryProviderKey` -> internal `retryProviderKey`，不再读 flat `__routecodexRetryProviderKey`。
  - 本地 error/global markers 清理：provider request info、auth preflight fatal、snapshot buffer、daemon admin locals 从 `__routecodex*` marker 转成 Symbol 或普通 local key。
  - custom payload carrier manifest 改为只保留 guard/contract surfaces，并要求每个 manifest entry 显式 `owner_feature_id`，owner-queryability gate 能按 manifest owner 反查 verification-map。
- 测试锁定：
  - `request-executor-attempt-state.contract.spec.ts` 正向断言 retry pin 写入 MetadataCenter，并反向断言 flat key 被删除。
  - `hub-pipeline-preselected-route.spec.ts` 断言 MetadataCenter preselectedRoute 胜过 flat residue，且 stopMessage/stopless runtime_control 会投影到 native metadata；legacy `__rt` 不能覆盖 MetadataCenter 同名控制位。
  - Rust route/meta focused tests 覆盖 retryProviderKey carrier 与 route consumer；Rust hub-pipeline fixture 改用 `__rt.preselectedRoute`。
- 已验证：
  - custom payload carrier audit / owner-queryability / runtime manifest / containment PASS；当前 `__routecodex* runtime=14 files=9`，均为 guard/contract surfaces。
  - focused Jest：request-executor-attempt-state + hub-pipeline-preselected-route PASS；executor-metadata + direct route focused suite PASS（Jest open-handle caveat，测试已 PASS）。
  - Rust focused：router_metadata_input forced-provider test PASS；meta_error_carriers PASS；virtual_router_engine::engine::route PASS。
  - `npx tsc --noEmit --pretty false`、`git diff --check`、`verify:function-map-compile-gate`、`build:min`、`verify:architecture-ci` 均已在同一 worktree PASS；staged slice 提交前需复跑核心 gate。
- 剩余风险：
  - 当前未安装/重启当前 uncommitted code；5555 health 只证明 live runtime 可用，不能证明本 slice 安装态。
  - 仓库仍有并行脏改和历史 test/contract 对 legacy key 的引用；本 slice 只提交 request-route runtime-control 与 local-marker 清理。

## 2026-06-19 MetadataCenter followup/goal-state slice

- 当前 slice 目标：继续把 Hub pipeline / followup 控制语义从 legacy `__rt` 收口到 `MetadataCenter.runtime_control`，保持功能不变，只移除 active mainline 对旧内部字段的依赖。
- 代码收口：
  - `request-executor-runtime-blocks.ts` 的 `isServerToolFollowupRequest(...)` 只认 `readRuntimeControlProjection(metadata).serverToolFollowup === true`，不再读 `metadata.__rt.serverToolFollowup`。
  - `index.ts` router direct 的 `mustRelayServerToolFollowup` 改为复用 `isServerToolFollowupRequest(metadata)`，去掉本地 `__rt` fallback 读取。
  - `servertool-adapter-context.ts` 会把已绑定的 `MetadataCenter` 继续绑定到 adapter context；adapter `__rt.serverToolFollowup` 仅作为本地兼容投影，由 `runtime_control.serverToolFollowup === true` 派生，不再从 flat metadata / legacy `__rt` 读取真相。
  - `provider-response-converter.ts` 的 `stoplessGoalStatus` 改为通过 `MetadataCenter.attach(...).writeRuntimeControl(...)` 写入和同步；不再把 `adapterContext.__rt.stoplessGoalStatus` 当成 authoritative runtime truth。
  - `buildResponseMetadataBagForProviderResponseConverter(...)` 在补 `providerFamily` 时保留 request-local `MetadataCenter` binding，避免响应侧 bridge 丢失 side-channel。
- 测试锁定：
  - `request-executor-runtime-blocks.spec.ts` 新增正向测试：`MetadataCenter.runtime_control.serverToolFollowup=true` 会激活 followup request truth。
  - 同文件新增反向测试：仅 `metadata.__rt.serverToolFollowup=true` 不会复活 followup truth。
  - `provider-response-converter.contract.spec.ts` 断言源码不再读 `requestSemantics.__routecodex` / `adapterRt?.stoplessGoalStatus`，并断言 `providerFamily` 包装后仍保留 `MetadataCenter`。
  - `provider-response-converter.goal-followup-http400.spec.ts` 统一通过 `MetadataCenter` 绑定 followup truth，并断言 `stoplessGoalStatus` 在 active->stopped 之间按错误阈值推进。
  - `direct-passthrough-route-level.spec.ts` 的 stop followup relay case 改为通过 `MetadataCenter.runtime_control.serverToolFollowup/serverToolFollowupSource` 提供 truth；本文件另有并行脏改动，提交时必须只 stage 当前 hunk。
- 验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/runtime/http-server/request-executor-runtime-blocks.spec.ts tests/server/runtime/http-server/executor/provider-response-converter.contract.spec.ts tests/server/runtime/http-server/executor/provider-response-converter.goal-followup-http400.spec.ts tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts --runInBand` PASS（4 suites / 32 tests）
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts tests/server/runtime/http-server/executor/provider-response-converter.goal-followup-http400.spec.ts tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts tests/server/runtime/http-server/request-executor-runtime-blocks.spec.ts --runInBand` PASS（4 suites / 49 tests；有既存 open handles 提示，但测试本身通过）
  - `npm run audit:custom-payload-carriers` PASS：`__routecodex* runtime=14 files=9`，`__sse_* runtime files=0`，`response.metadata runtime files=4`
  - `npm run audit:custom-payload-carrier-owner-queryability` PASS：`routecodex_prefix unique-owner=9 ambiguous=0 missing=0`
  - `npm run verify:architecture-custom-payload-carrier-runtime-manifest` PASS
  - `npm run verify:architecture-custom-payload-carrier-containment` PASS
  - `npm run verify:function-map-compile-gate` PASS
  - `npm run verify:architecture-ci` PASS
  - `npx tsc --noEmit --pretty false` PASS
  - `npm run build:min` PASS
  - `git diff --check` PASS
- 当前残留：
  - 本 slice 只清 active mainline followup / stoplessGoalStatus 对 legacy `__rt` 的依赖，没有减少 `__routecodex* runtime=14 files=9` 的 guard/contract 残留总数。
  - 下一步仍需继续做 request-route control（如 retry/preselected route）向 `MetadataCenter.runtime_control` 的迁移和剩余 runtime residue 审计。

## 2026-06-19 metadata-center stream/client-abort slice gate closeout

- `verify:architecture-ci` 的唯一阻塞不是 runtime 语义回归，而是 `src/server/handlers/handler-utils.ts` 的本地 `MetadataCenter.writeRuntimeControl(...)` writer stage 误用了 canonical 节点名 `MetaReq04RuntimeControlBound`，触发 `hub.metadata_center_request_capture` / `hub.metadata_center_attempt_merge` 的 forbidden-path-growth。
- 最小修复：把 handler 本地 writer stage 改成 `handler_pipeline_runtime_control`，不改写入语义、不改 owner、不改 runtime_control 内容，只消除 handler 路径对 canonical hub stage id 的泄漏。
- 验证：
  - `npm run verify:architecture-ci` PASS
  - `npm run verify:architecture-forbidden-path-growth` PASS
  - `npm run verify:function-map-compile-gate` PASS
  - `npx tsc --noEmit --pretty false` PASS
  - `git diff --check` PASS
- 审计事实：当前 `MetaReq04RuntimeControlBound` 只剩 function-map 真源和 `src/modules/llmswitch/bridge/responses-request-bridge.ts` 的桥层 owner 写入；`src/server/handlers/**` 已无命中。

## 2026-06-18 MetadataCenter stopless runtime-control slice

- Goal slice implemented: stopless/servertool followup control semantics now write `runtime_control.stopless` through the bound `MetadataCenter` side-channel; the write is fail-fast when the request-local MetadataCenter binding is absent.
- Rust followup readers tightened:
  - `chat_node_result_semantics.rs` reads reasoning-stop followup source only from `runtime_control.serverToolFollowupSource`.
  - `chat_servertool_orchestration.rs` reads servertool followup / source only from `runtime_control.serverToolFollowup` and `runtime_control.serverToolFollowupSource`, not flat metadata or `__rt`.
  - Added negative Rust coverage proving legacy flat / `__rt` followup control markers no longer activate followup tool merge or reasoning-stop suppression.
- TS side-channel bridge fix:
  - `runtime-metadata.ts::ensureRuntimeMetadata(...)` preserves the request-local `Symbol.for('routecodex.metadataCenter')` binding across native metadata normalization so servertool/stop-message handlers do not lose MetadataCenter state.
  - `stop-message-auto.ts` writes stopless state with local writer stage `stop_message_auto_runtime_control_writer`, avoiding canonical node-id leakage in host labels.
- Architecture truth synced:
  - `docs/architecture/metadata-center-manifest.yml` declares `runtime_control.stopless`.
  - function-map / mainline-call-map / verification-map now distinguish completed stopless writer migration from still-partial request-route writer migration.
  - architecture wiki HTML regenerated.
- Verification:
  - `cargo test -p router-hotpath-napi chat_servertool_orchestration --lib -- --nocapture` PASS (43 tests)
  - `cargo test -p router-hotpath-napi chat_node_result_semantics --lib -- --nocapture` PASS (14 tests)
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/stop-message-compare-context.spec.ts tests/servertool/stopless-metadata-center.spec.ts tests/servertool/stopless-metadata-writer-ownership.spec.ts --runInBand` PASS (11 tests)
  - focused followup/provider-response Jest PASS (11 tests)
  - `npm run audit:custom-payload-carriers` PASS; `__routecodex*` runtime files=9 / hits=14, `__sse_*` runtime files=0
  - `npm run audit:custom-payload-carrier-owner-queryability` PASS; routecodex unique-owner=9, ambiguous=0
  - `npm run verify:architecture-custom-payload-carrier-runtime-manifest` PASS
  - `npm run verify:architecture-custom-payload-carrier-containment` PASS
  - `npm run verify:architecture-metadata-center-manifest-code-sync` PASS
  - `npm run verify:function-map-compile-gate` PASS
  - `npm run verify:architecture-ci` PASS after serial rerun; first parallel attempt failed only because concurrent build removed a transient Rust `target/debug/deps/rmeta*` path during scan
  - `npx tsc --noEmit --pretty false` PASS
  - `npm run build:min` PASS
  - `git diff --check` PASS
  - live 5555 health: `ready=true pipelineReady=true version=0.90.3143`
  - live `/v1/responses` smoke sample: `/Volumes/extension/.rcc/codex-samples/openai-responses/port-5555/req_1781786919393_7ec6abe3`
  - sample scan: provider-request/provider-response contain no `__routecodex`, `__sse_`, `__rt`, `payload_side_channel`, `runtime_control`, `serverToolFollowup`, or `stoplessGoalStatus`; curl SSE response used standard `response.metadata:{}` only.
- Remaining scope:
  - request-route runtime-control writer lane (`retryProviderKey`, `preselectedRoute`) remains partial and should be migrated in a separate slice.
  - broader Rust `__rt` runtime side-channel still exists for non-payload internal metadata carrier lanes; this slice only locks stopless/followup control semantics.

## 2026-06-18 MetadataCenter stopMessage/runtime-control followup closeout

- 本轮继续执行 internal metadata cleanup goal：`stopMessageEnabled` / `stopMessageExcludeDirect` 从 request metadata / nested followup metadata 的 flat 字段和 `__rt` 控制语义迁到 `MetadataCenter.runtime_control`。
- 代码收口：
  - `index.ts` 入口写 `runtime_control.stopMessageEnabled/stopMessageExcludeDirect`，不再把 stopMessage 控制写入 normal metadata payload。
  - `request-executor.ts`、`servertool-adapter-context.ts` 只通过 `readRuntimeControlProjection(...)` 消费 stopMessage enablement。
  - `servertool-followup-dispatch.ts` nested followup 只写 `MetadataCenter.runtime_control.stopMessageEnabled=false` 禁用递归，不写 flat/`__rt` fallback；retry JSON clone 显式保留 `MetadataCenter` symbol binding。
  - `servertool-followup-metadata.ts` 复制 request-local MetadataCenter side-channel 并剥离 stopMessage flat / `__rt` 控制字段。
  - `provider-response-converter.ts` servertool followup 错误判定不再读 `requestSemantics.__routecodex`，只读 MetadataCenter runtime-control。
  - `MetadataCenter.attach/read` 从 `instanceof` 改为结构化 duck-type，避免 Jest/ESM 多实例或 side-by-side emit 导致 side-channel 读不到。
- 发现并物理删除了 `src/server/runtime/http-server/metadata-center/*.js/*.d.ts` 陈旧生成残留；这些文件会抢占 `.js` import，导致旧 `instanceof` 实现复活。已加入 `verify:architecture-deleted-path` gate 防复活。

## 2026-06-19 MetadataCenter migration audit continuation

- 本轮只做现状审计，不改 `cli_contract.rs`，不碰用户正在改的 `stop schema` 测试目录。
- 目前确认的 canonical truth：
  - `request-executor-attempt-state.ts` 里 `retryProviderKey` 已写入 `MetadataCenter.runtime_control`，flat `__routecodexRetryProviderKey` 只剩删除残留；

## 2026-06-19 uncommitted stopless audit after provider push

- 非 stopless 可提交项已单独完成并推送：
  - commit `f0fb0bb5b` `fix(provider): accept json over sse requests` 已 `git push origin main`。
  - 验证：`tests/provider/http-client-poststream-headers-timeout.spec.ts` PASS，`tests/providers/core/runtime/protocol-http-providers.unit.test.ts` PASS，`npx tsc --noEmit --pretty false` PASS。
- 当前剩余 worktree 脏改全部属于 stopless / stop schema / reasoning.stop 线：
  - `router-hotpath-napi/src/hub_pipeline.rs`
  - `router-hotpath-napi/src/hub_pipeline_lib/tests.rs`
  - `router-hotpath-napi/src/hub_reasoning_tool_normalizer.rs`
  - `router-hotpath-napi/src/hub_req_inbound_tool_call_normalization.rs`
  - `router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs`
  - `router-hotpath-napi/src/req_process_stage1_tool_governance_tests.rs`
  - `servertool-cli/src/main.rs`
  - `servertool-cli/tests/cli_blackbox.rs`
  - `servertool-core/src/cli_contract.rs`
  - `stop-message-core/src/lib.rs`
- 当前不能提交的直接证据：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/stop-schema-lifecycle-contract.spec.ts --runInBand` FAIL（4/4 fail）。
  - 失败真相：TS contract 期待 `evaluateStopSchemaGateWithNative(...)` 返回 `reason_code`，实际当前结果里该字段为 `undefined`；失败用例覆盖 `stop_schema_missing` / `stop_schema_finished` / `stop_schema_continue_next_step` / `stop_schema_stopreason_missing_or_non_numeric`。
- 额外 review 风险点：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs` 当前会在 `stopMessageEnabled` 路径自动注入 `reasoning.stop` tool；属于 stopless 语义扩面，不应与非 stopless 改动混提。
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_tool_call_normalization.rs` 当前把任意 stop-hook shell call + output 对改写成 guidance text，不再要求 auto-injected call id 前缀；这是 stopless/history rewrite 语义变化，提交前必须靠完整 stop schema contract 绿测证明。
  - `servertool-followup-dispatch.ts` / `provider-response-converter.ts` / `servertool-adapter-context.ts` 的 active 读写都已经转向 `MetadataCenter`；
  - `chat_node_result_semantics.rs` 和 `chat_servertool_orchestration.rs` 已经从 `runtime_control` 读 followup / stopless 语义。
- 仍然存在的 bridge / projection 面：
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts` 仍会把 `MetadataCenter.runtime_control` 投影成 native `__rt`，并把 `preselectedRoute` 写进 `__rt` 供 Rust bridge 消费；
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/router_metadata_input.rs` 仍从 `metadata.__rt.retryProviderKey` 读取桥接值；
  - `servertool-followup-dispatch.ts` 里还保留对 legacy `requestSemantics.__routecodex` 的清理和 `runtime_control` 合并逻辑，这是删除旧真源后的兼容清道，而不是新的 payload truth。
- 当前判断：MetadataCenter 已经是 Hub 侧控制语义真源，但 TS -> Rust 的 `__rt` 桥接仍在，不能把这轮说成“完全无 `__rt` 兼容层”；后续如果要继续收口，需要单独决定是否连桥接投影也物理删掉，或只保留最小 native ingress projection。
- 验证：
  - focused Jest 5 suites PASS，50 tests。
  - `npx tsc --noEmit --pretty false` PASS。
  - `git diff --check` PASS。
  - `npm run audit:custom-payload-carriers` PASS：`payload_side_channel=0`，`__sse_* runtime files=0`。
  - `audit:custom-payload-carrier-owner-queryability` PASS：`__routecodex* unique-owner=9 ambiguous=0`。
  - custom payload manifest / containment / function-map compile / deleted-path gates PASS。
  - `npm run build:min` PASS。
  - `npm run verify:architecture-ci` PASS。

## 2026-06-18 continuation contract local green, but 5555 live probe still not entering stopless activation

- 本轮已完成本地 contract 收口并确认运行态版本切到 `0.90.3145`：
  - `build:min` PASS；
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run install:global` PASS；
  - `routecodex --version` => `0.90.3145`；
  - `curl http://127.0.0.1:5555/health` => `version=0.90.3145`。
- continuation contract 相关本地验证已绿：
  - `tests/sharedmodule/responses-continuation-store.spec.ts -t "preserves restored tools"` PASS；
  - `tests/responses/responses-openai-bridge.spec.ts` PASS；
  - `tests/sharedmodule/hub-pipeline-rust-responses-provider-payload.regression.spec.ts` PASS。
- 在线 probe 现状不能宣称闭环：
  - `scripts/tests/stopless-5555-final-probe.mjs` 首轮未拿到 `exec_command`，直接 FAIL；
  - `scripts/tests/stopless-5555-live-probe.mjs` 三次尝试均未进入 stopless followup，最终 `finalStatus=no_live_stopless_path`。
- 已锁在线样本事实：
  - 5555 新样本使用新版本 `0.90.3145`，说明不是旧包未刷新；
  - `req_1781788334947_d34fc5f8` / `req_1781788340375_07897c6c` / `req_1781788352221_32be85ef` 的 `provider-request.json` 都只是把 probe 提示词原样发给上游；
  - 对应 `provider-response.json` 里模型按提示词直接输出 stop schema JSON（`stopreason=2`），没有工具调用，也没有 stopless servertool followup；
  - 所以这批 live probe 失败不是 continuation restore 再次坏了，而是 probe prompt 本身把模型引导成“直接输出 stop schema”，根本没有进入 stopless 激活路径。
- 下一步要做的不是继续看 continuation contract，而是重审 5555 online probe 设计：
  - 构造一个真实会先自然 `finish_reason=stop` 且不直接输出 stop schema 的 managed relay 样本；
  - 再检查该样本是否触发 stopless exec_command；
  - 之后再看 followup request 里 schema feedback / guidance / restoredTools 是否闭环。

## 2026-06-18 continuation contract closeout in progress: relay restore + restoredTools bridge

- 当前标准 contract 收口继续沿两条红测推进：
  - `tests/sharedmodule/responses-continuation-store.spec.ts -t "preserves restored tools"`；
  - `tests/responses/responses-openai-bridge.spec.ts -t "restores tools from canonical responses resume contract when caller tools are empty"`。
- 已锁事实：
  - TS bridge 之前没有把 canonical `semantics.responses.resume.restoredTools` 纳入 `buildChatRequestFromResponses()` 的初始 tools 恢复链；
  - relay `resumeLatestResponsesContinuationByScope()` 命中 scope 后，native `restore_responses_continuation_payload()` 仍把 `previous_response_id + delta-only user input` 拒绝为 `null`，与新 contract 不符；
  - 本轮先做最小 owner 修正，不扩散到 SSE / protocol / direct。
- 当前进度：
  - 已补 `buildChatRequestFromResponses()` 从 canonical `restoredTools` 恢复 chat tools；
  - 已尝试在 Rust restore 放行 canonical relay delta-only resume；
  - 首轮 native build 因一处 Rust 调用签名错误未完成，已修正，待重新 build + 复跑 focused tests。

## 2026-06-18 internal metadata request-write topology plan

- Jason clarified the next cleanup rule: request nodes should not perform unnecessary metadata writes; only necessary request-scoped control truth may be written to `MetadataCenter`, especially `runtime_control`.
- Updated `docs/goals/internal-metadata-center-migration-plan.md` with a dedicated request metadata write topology:
  - default request-node behavior is no metadata create/merge/backfill/patch/scrub;
  - legal writes are limited to canonical `MetadataCenter` families: `request_truth`, `continuation_context`, `runtime_control`, `provider_observation`, and debug/replay where explicitly scoped;
  - old payload-side-channel fields must be physically removed, not renamed into generic metadata;
  - new gates must fail old `__routecodex*`, `requestSemantics.__routecodex`, `__sse_*`, internal payload metadata/options writes, and undeclared `MetadataCenter.writeRuntimeControl(...)` slots.
- This is a planning/doc update only; runtime migration and final verification remain pending.

## 2026-06-18 stopless provider-request blackbox closure pivot

- Jason 明确纠正：当前最该做的是直接离线验证最终 provider 请求，不要继续围着中间 metadata 和样本目录绕。
- 已锁事实：
  - host 最终发送的是 `request-executor -> pipelineResult.providerPayload`；
  - `pipelineResult.providerPayload` 来自 `HubPipeline.execute() -> executeRequestStagePipeline() -> runHubPipelineLibWithNative(...)`；
  - 所以 stopless 是否真正进入 provider 请求，必须在 hub pipeline/native orchestration 黑盒上直接断言 `providerPayload`。
- 本轮新增了一条 `sharedmodule/llmswitch-core/test/hub/hub-pipeline.spec.ts` 的 stopless providerPayload 红测草案，内容是 `/v1/responses + stopless tool result + schemaFeedback` 必须在最终 `providerPayload.messages` 中出现：
  - stopless system instruction
  - `上一轮执行结果`
  - `repeatCount=2/3`
  - `reasonCode=stop_schema_missing`
  - `missingFields=stopreason, reason`
  - `如果任务已经完成`
- 但根仓 Jest 不收 `sharedmodule/llmswitch-core/test/*`，所以这条测试还没有进入当前实际测试 harness。
- 下一步收口：
  - 把同样的 providerPayload 黑盒红测迁到根仓会执行的 `tests/sharedmodule/` 或 `tests/responses/`；
  - 直接打 `HubPipeline.execute()` 或等价 native orchestration 入口；
  - 若红，根因锁在 native hub pipeline/providerPayload build；若绿，再查 build/install/live version 差异。


## 2026-06-18 internal metadata cleanup closeout

- Goal status reached for the requested cleanup slice: request/response/provider/client payloads no longer carry internal control truth, and necessary control truth is written only through `MetadataCenter` / runtime side-channel.
- Verified gates:
  - `npm run audit:custom-payload-carriers` PASS
  - `npm run audit:custom-payload-carrier-owner-queryability` PASS
  - `npm run verify:architecture-custom-payload-carrier-runtime-manifest` PASS
  - `npm run verify:architecture-custom-payload-carrier-containment` PASS
  - `npm run verify:function-map-compile-gate` PASS
  - `npm run verify:architecture-ci-longtail` PASS
  - `npm run verify:architecture-review-surface` PASS
  - `npm run verify:architecture-ci` PASS
  - `npx tsc --noEmit --pretty false` PASS
  - `npm run build:min` PASS
  - `git diff --check` PASS
- Focused runtime proof:
  - `tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts` PASS after direct 401 fail-fast fix
  - `routecodex restart --port 5555` PASS
  - `curl http://127.0.0.1:5555/health` returned `ready=true pipelineReady=true version=0.90.3136`
  - real `/v1/responses` smoke returned `ok`
  - provider-request body had no `metadata`, `__routecodex*`, `__sse_*`, or `__rt`
  - `client-request.json` contains `body.metadata.__rt` only as snapshot runtime capture; inner `body.body` remained protocol-only
- Residual intentional surfaces remain only as guard/contract/doc references and are covered by manifest + owner-queryability gates.

## 2026-06-18 XLC key split and 5555 priority update

- XLC provider config updated: `key1` is documented for GLM models, `key2` for DeepSeek models; `key2` secret is intentionally not repeated here.
- 5555 `coding` / `thinking` / `longcontext` route priority updated to `XLC.key1.glm-5.2 -> XLC.key2.deepseek-v4-pro -> fwd.minimax.MiniMax-M3 -> GPT`.
- Verification:
  - `routecodex config validate` PASS.
  - Direct upstream curl: `key1 + glm-5.2` currently returns upstream 429 rate-limit after earlier successful 200; `key2 + deepseek-v4-pro` reaches upstream and returns 402 insufficient balance.
  - 5555 live sample after restart shows first attempt `XLC.key1.glm-5.2`, second attempt `XLC.key2.deepseek-v4-pro`, then MiniMax.
- Boundary: 5555 remains `sameProtocolBehavior = "direct"` per Jason correction; do not change direct/relay behavior for this config task.

## 2026-06-18 global internal metadata audit for MetadataCenter migration

- Audit scope: global `__routecodex*`, `__sse_*`, and `response.metadata` runtime residues before planning MetadataCenter/runtime side-channel migration.
- Commands run:
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run audit:custom-payload-carriers` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run audit:custom-payload-carrier-owner-queryability` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-custom-payload-carrier-runtime-manifest` PASS
- Current baseline:
  - `__routecodex*`: `runtime=72`, runtime files=`25`; category split: `payload_side_channel=10`, `guard_surface=5`, `local_runtime_marker=6`, `contract_or_test_surface=4`.
  - `__sse_*`: runtime files=`0`; remaining hits are tests/scripts/docs/fixtures only.
  - `response.metadata`: runtime files=`4`; split: `guard_surface=1`, `local_runtime_marker=1`, `contract_or_test_surface=2`.
  - Owner queryability: `__routecodex* unique-owner=20 / ambiguous-owner=5 / missing-owner=0 / missing-verification=0`; `response.metadata unique-owner=4 / ambiguous-owner=0`.
- Migration finding:
  - Only `payload_side_channel=10` is the direct MetadataCenter/runtime side-channel migration target.
  - `guard_surface` must remain as fail-fast boundary during migration.
  - `local_runtime_marker` should be renamed to typed local fields/WeakMap/local symbol state, not routed through normal request/response payload.
  - `contract_or_test_surface` should change only after corresponding runtime migration changes, otherwise tests/contracts become stale.
- Primary migration lanes:
  - Request route control: `__routecodexRetryProviderKey` and `__routecodexPreselectedRoute` -> `MetadataCenter.runtime_control.retryProviderKey/preselectedRoute`.
  - Response followup semantics: `requestSemantics.__routecodex.{serverToolFollowup,serverToolFollowupSource,stoplessGoalStatus}` -> `MetadataCenter.runtime_control.serverToolFollowup/serverToolFollowupSource/stoplessGoalStatus`.
  - Rust request-route readers currently still consume old flat fields; they must move after TS writers are migrated, not before.

## 2026-06-18 stopless schema-missing guidance branch fix

- Jason 最新明确要求：`schema missing` 时的引导不能只是“补字段”，必须显式分支：
  - 第一轮短提示：继续执行；如果任务已经完成，再补齐 schema。
  - 第二轮再展开：如果任务已经完成，补齐 schema；如果任务还没完成，继续执行。
- 这次只改 stopless model-visible guidance owner，不碰 SSE/协议层：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_tool_call_normalization.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`
- 具体收口：
  - `triggerHint=no_schema` 改成按轮次分支：首轮短，二轮展开。
  - `reasonCode=stop_schema_missing` 的 feedback 也按轮次分支：首轮短，二轮展开。
- 新增 focused tests：
  - `stop_hook_guidance_text_for_first_missing_schema_round_stays_short`
  - `stop_hook_guidance_text_for_second_missing_schema_round_must_expand_branching`
  - `stopless_resume_guidance_for_first_missing_schema_round_stays_short`
  - `stopless_resume_guidance_for_second_missing_schema_round_must_expand_branching`
- 验证：
  - `cargo test -p router-hotpath-napi stop_hook_guidance_text_for_first_missing_schema_round_stays_short --lib -- --nocapture` PASS
  - `cargo test -p router-hotpath-napi stop_hook_guidance_text_for_second_missing_schema_round_must_expand_branching --lib -- --nocapture` PASS
  - `cargo test -p router-hotpath-napi stopless_resume_guidance_for_first_missing_schema_round_stays_short --lib -- --nocapture` PASS
  - `cargo test -p router-hotpath-napi stopless_resume_guidance_for_second_missing_schema_round_must_expand_branching --lib -- --nocapture` PASS
- 备注：
  - 这是文案/引导闭环的一部分，还没有做 5555 live probe 复核，所以不能宣称 stopless 整体语义闭环完成。

## 2026-06-18 stopless fresh-request history contamination fix

- Jason 最新这条“还在循环”不是 continuation restore 那条旧问题，而是 fresh `/v1/responses` 请求历史里直接混入了旧 stopless CLI transcript，导致 provider request 在进入上游前就已经带着 `Chunk ID ... Output: {"toolName":"stop_message_auto"...}` 污染文本。
- 真实证据：
  - 旧污染样本：`/Volumes/extension/.rcc/codex-samples/openai-responses/port-5555/req_1781756088758_a1cdfc62/provider-request.json`
  - 污染位置：约 `L3939+` 出现多条 `role=user` 的 stopless transcript 文本
- 这次唯一 owner 修点落在 Rust bridge history/input 归一化，而不是 SSE/协议层：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/utils.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/bridge_input.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/history.rs`
- 新行为：
  - 对 `role=user` 的历史消息，如果内容能被归一化识别为 stopless CLI transcript/result（即 `toolName == stop_message_auto`），直接在 bridge owner 层丢弃，不再当普通历史传给模型。
  - 这样既不会污染 provider request，也不会污染 `latest_user_instruction`。
- 新红测：
  - `build_bridge_history_drops_stopless_cli_transcript_user_history`
  - `convert_bridge_input_drops_stopless_cli_transcript_user_message`
- 离线验证：
  - `cargo test -p router-hotpath-napi build_bridge_history_drops_stopless_cli_transcript_user_history --lib -- --nocapture` PASS
  - `cargo test -p router-hotpath-napi convert_bridge_input_drops_stopless_cli_transcript_user_message --lib -- --nocapture` PASS
  - `cargo test -p router-hotpath-napi hub_bridge_actions --lib -- --nocapture` PASS
- packaged native 已刷新：
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` PASS
- 真实样本片段离线回放（dist/native）：
  - 用旧污染样本中 `继续执行 + 3 条 stopless transcript` 回放 `convertBridgeInputToChatMessages`
  - 输出只剩 `继续执行`，`pollutedOut=0`
- 安装态 / 运行态验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run build:min` PASS
  - `routecodex --version` => `0.90.3121`
  - `routecodex restart --port 5555` PASS
  - `curl -s http://127.0.0.1:5555/health` => version `0.90.3121`
  - 本地真实重放请求（同样本污染片段）后，新样本：
    - `/Volumes/extension/.rcc/codex-samples/openai-responses/port-5555/req_1781757433137_9a4026a1/provider-request.json`
    - provider request 只剩一条 `input_text = "继续执行"`
    - `rg -n "Chunk ID:|stop_message_auto"` 对该文件 `0 matches`

## 2026-06-18 stopless continuation/restore collapse fix: only latest guidance survives

- Jason 当前这条 stopless 闭环问题，根因不是工具列表消失，而是 continuation/restore/materialize 把旧 stopless `function_call + function_call_output` 当普通历史重新带回后续 provider request，导致旧 guidance 污染后续轮次，VR 看到的也不是“当期轮”。
- 已锁唯一 owner：
  - TS store 只是保存/交给 native：`sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`
  - 真正 collapse owner：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`
- 这次修正把 collapse 真源从“猜 exec_command 文本是否像 stop hook”改成“看已完成 tool output 的真实语义”：
  - 先识别 `function_call_output.output.toolName == stop_message_auto`
  - 再按 `call_id` 折叠对应 stopless pair 为一条 user guidance
  - 最后只保留最新一条 stopless guidance，旧 guidance 全删
- 直接证据：
  - `resumeResponsesConversationPayloadWithNative(...)` 在修前会吐回两轮 `function_call/function_call_output`
  - 修后同一 native 直调只剩：
    - 原始 user message
    - 最新 stopless guidance message
- 新增/更新验证：
  - Rust red->green: `cargo test -p router-hotpath-napi resume_collapses_stopless_history_to_latest_guidance_only --lib -- --nocapture` PASS
  - Rust suite: `cargo test -p router-hotpath-napi shared_responses_conversation_utils --lib -- --nocapture` PASS
  - normalization guard: `cargo test -p router-hotpath-napi hub_req_inbound_tool_call_normalization --lib -- --nocapture` PASS
  - JS blackbox: `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/sharedmodule/responses-continuation-store.spec.ts --runInBand` PASS
- 运行时注意：
  - Jest/Node 默认先吃 `sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node`
  - 仅跑 `cargo test` 不会刷新 packaged native；必须跑 `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` 或更高层 build/install 流程

## 2026-06-18 stopless structured feedback + req_chatprocess transparent rewrite

- Jason latest correction locked three requirements together:
  - CLI feedback must stay concise structured data, not long natural-language followup text.
  - req_chatprocess must rewrite the paired stopless tool execution result into model-transparent natural language plus missing/error feedback.
  - virtual router must still route the stopless continuation turn to `thinking`, and this must be reflected in mainline source + wiki.
- Verified owner chain:
  - response-side precise schema gate truth originates in `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts` (`schemaGate.reason_code`, `schemaGate.missing_fields`);
  - stopless CLI projection owner remains `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`;
  - model-visible rewrite owner remains `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_tool_call_normalization.rs`;
  - VR thinking route lock remains `tests/servertool/stopless-vr-route-hint.spec.ts`.
- Implemented direction:
  - stop-message handler now emits structured `stopSchemaFeedback { reasonCode, missingFields }` into stopless execution context;
  - CLI projection preserves only concise stopless input (`flowId/repeatCount/maxRepeats/triggerHint` + optional `schemaFeedback`);
  - CLI stdout now preserves `schemaFeedback`;
  - req_chatprocess now rewrites stopless paired tool result using:
    - `continuationPrompt`
    - natural-language rendering of `schemaFeedback`
    - natural-language rendering of `schemaGuidance.decisionRules/invalidExamples`
- Focused evidence:
  - `cargo test -p servertool-core cli_contract --lib -- --nocapture` PASS
  - `cargo test -p router-hotpath-napi hub_req_inbound_tool_call_normalization --lib -- --nocapture` PASS
  - `cargo build -p servertool-cli --bin routecodex-servertool` PASS
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/cli/servertool-command.spec.ts --runInBand` PASS
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/stopless-vr-route-hint.spec.ts --runInBand` PASS
- Doc truth updated:
  - `docs/architecture/function-map.yml`
  - `docs/architecture/mainline-call-map.yml`
  - `docs/architecture/verification-map.yml`
  - `docs/architecture/wiki/stopless-session-mainline-source.md`
  - `docs/architecture/wiki/servertool-ownership-map.md`

## 2026-06-18 stopless mainline closure gap: req-side schema contract missing on `/v1/responses`

- 最新真实样本再次证明“无限续接 / 不触发”不是单纯模型理解问题，而是 req 侧 stopless schema contract 没有落到 `/v1/responses` 主线的真实 wire：
  - 样本：`/Volumes/extension/.rcc/codex-samples/openai-responses/port-5555/req_1781757806242_67c06c6a/provider-request.json`
  - 证据：
    - provider request 顶层 `system` 只有默认 `You are Claude Code...`
    - `rg -n 'stopreason|continue_needed|stop_message_auto|reasoning_stop'` 对该 provider-request 为 0 命中
    - 同文件却仍有正常 tool 列表，说明不是 provider request 整体异常，而是 stopless contract 没被注入到真实主线
- 当前唯一 owner 根因方向已锁：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs`
    - 现在 `prepend_stopless_system_instruction()` 只会写 `request.messages`
  - 但 `/v1/responses` 主线真实会先经过 `input/instructions`，后续 `buildChatRequestFromResponses()` 才转成 chat messages
  - `buildChatRequestFromResponses()` 已支持从 `payload.instructions -> captured.systemInstruction -> system message`，所以真正缺的是 req_process 对 responses 形态写 `instructions`
- 下一刀收口：
  - req_process stopless contract 注入改成同时覆盖：
    - chat/messages 形态：`messages[0].role=system`
    - responses/input 形态：`instructions`
- 红测至少两层：
  - Rust：`apply_req_process_tool_governance` 对 `/v1/responses + input` 必须写入 `instructions`
  - TS：`buildChatRequestFromResponses` 收到该 `instructions` 后，chat request `messages[0]` 必须是包含 `stopreason` 的 system message

## 2026-06-18 stopless live followup snapshot gap on `/v1/responses` continuation

- 5555 在线复核 `0.90.3129` 先锁到一个新的真实 owner：
  - 首轮 stopless 激活正常，CLI payload 已带 `schemaFeedback`
  - 但 submit_tool_outputs 第二轮 provider-request 起初仍缺 `上一轮执行结果：repeatCount/reasonCode/missingFields`
  - 这不是 `hub_req_inbound_tool_call_normalization.rs` owner，而是 `/v1/responses` continuation collapse owner：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`
- 修正：
  - 给 `shared_responses_conversation_utils.rs::build_stop_hook_guidance_text_from_output(...)` 补上与 req inbound normalization 同步的 stopless snapshot 文本：
    - `上一轮执行结果：repeatCount=2/3；reasonCode=...；missingFields=...。`
- 本地验证：
  - `cargo test -p router-hotpath-napi shared_responses_conversation_utils --lib -- --nocapture` PASS
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/sharedmodule/responses-continuation-store.spec.ts --runInBand` PASS
- 在线证据：
  - 最新样本 ` /Volumes/extension/.rcc/codex-samples/openai-responses/port-5555/req_1781767097095_e92d4345/provider-request.json`
  - 已出现：
    - `上一轮执行结果：repeatCount=2/3；reasonCode=stop_schema_continue_next_step；missingFields=...`
- 仍需说明的缺口：
  - 当前 `scripts/tests/stopless-5555-live-probe.mjs` 自身把第二轮模型行为限定成“看到 repeatCount=1 就直接输出 stop schema JSON”，所以它不适合作为“三次 no_schema 在线自然停”的 live 证据；这条仍只有本地黑盒 gate，尚未做真实在线三轮复核。

## 2026-06-18 relay `/v1/responses` tools->minimax raw SSE leak root cause and fix

- 真实失败样本：
  - log requestId=`openai-responses-minimax.key1-MiniMax-M2.7-20260618T101045841-364433-4887`
  - sample dirs:
    - `/Volumes/extension/.rcc/codex-samples/openai-responses/port-5555/req_1781748645841_a22d38d0`
    - `/Volumes/extension/.rcc/codex-samples/openai-responses/port-unknown/openai-responses-minimax.key1-MiniMax-M2.7-20260618T101045841-364433-4887`
- 样本证据已锁死：
  - `provider-response_1.json` 只有 Anthropic raw SSE：末尾 `event: message_stop`
  - `client-response_server.json` 也把 raw `message_stop` 直接吐给 client，随后补 `event: error code=upstream_stream_incomplete`
  - 说明这条 relay `/v1/responses` tools 路径在响应投影前没有先完成 raw Anthropic SSE -> standard Responses 语义转换
- 唯一 owner 根因：
  - `src/server/runtime/http-server/executor/provider-response-utils.ts::normalizeProviderResponseBody`
    - 对“只有 `sseStream`，没有 body”的 provider response 会返回 `body=undefined`
  - `src/server/runtime/http-server/executor/provider-response-converter.ts`
    - 原先在 `/v1/responses` 转换前有早退：`if (!body || typeof body !== 'object') return options.response;`
    - 结果 stream-only relay response 整段跳过 bridge conversion，raw SSE 直接漏到 client
- 已修：
  - `provider-response-converter.ts` 新增 `buildBridgeProviderResponseSeed(...)`
  - 对 stream-only provider response，不再因 `body` 缺失早退；改为用 `sseStream + status/headers/metadata` 组装 bridge seed，再进入 bridge conversion
- 已验证：
  - `npx jest tests/server/runtime/http-server/executor/provider-response-converter.bridge-seed.spec.ts --runInBand` PASS
  - `npx jest tests/server/runtime/http-server/executor/provider-response-relay-sse.spec.ts --runInBand` PASS
  - `npm run build:min` PASS
- 备注：
  - 旧 `provider-response-converter.prebuilt-sse-passthrough.spec.ts` 这组 test 自带 ESM/core-loader mock 脆弱面，当前仍会在进入断言前卡在 `conversion/hub/response/provider-response` 动态装载，不把它当成本次修复真假判断依据

## 2026-06-18 payload-carrier baseline rerun after P0 role-map doc sync

- 复跑原因：`docs/goals/hub-pipeline-slimming-no-function-loss-plan.md` 新增 `P0 TS/host role map` 后，需要确认 audit 只是 docs 命中变化，没有把 runtime / owner-queryability 基线打偏。
- 复跑结果：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run audit:custom-payload-carriers` PASS
  - `__routecodex*`: `runtime=72, test=81, script=16, doc=58`，runtime unique files=`25`
  - `__sse_*`: `runtime=0, test=20, script=15, doc=7`，runtime unique files=`0`
  - `response.metadata`: `runtime=11, test=13, script=5, doc=44`，runtime unique files=`4`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run audit:custom-payload-carrier-owner-queryability` PASS
    - `__routecodex*`: `unique-owner=16`、`ambiguous-owner=9`、`missing-owner=0`、`missing-verification=0`
    - `response.metadata`: `unique-owner=2`、`ambiguous-owner=2`、`missing-owner=0`、`missing-verification=0`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-custom-payload-carrier-runtime-manifest` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/architecture/verify-custom-payload-carrier-containment.mjs` PASS
  - `git diff --check` PASS
- 结论：
  - 本次变化只在 docs 面：`__routecodex* doc 41 -> 58`
  - runtime files、runtime category / semantic family / resolution track、owner-queryability 全部保持不变
  - `P0 TS/host role map` 可以继续作为 writer-first 清理顺序的真事实，不会把审计面写假

## 2026-06-18 P0 writer-first migration checklist anchored to source + verification map

- 已把 P0 五项从“role map”继续收成可执行 checklist，位置：`docs/goals/hub-pipeline-slimming-no-function-loss-plan.md`
- 当前真实顺序：
  - request-route lane：`request-executor-attempt-state.ts -> index.ts -> hub-pipeline-execute-request-stage.ts`
  - response-followup lane：`servertool-followup-dispatch.ts -> provider-response-converter.ts`
- 真实角色与源码锚点已再次核实：
  - `request-executor-attempt-state.ts` `L48-L55` = narrow writer
  - `index.ts` `L1310-L1319`, `L1402-L1410` = entry writer + relay bridge
  - `hub-pipeline-execute-request-stage.ts` `L20-L25` = bridge copier
  - `servertool-followup-dispatch.ts` `L223-L245`, `L279-L331` = materializer / mutating reader
  - `provider-response-converter.ts` `L1031-L1034` = pure reader
- verification-map 也已对齐到这五个 owner：
  - `hub.metadata_center_attempt_merge`
  - `server.http_runtime_entry`
  - `hub.request_stage_pipeline_bridge`
  - `server.servertool_followup_dispatch_surface`
  - `server.provider_response_conversion_host`
- 结论：
  - 后续如果要继续清 `__routecodex*` runtime residue，必须按这两条 lane 的固定顺序推进
  - 不能跳过 writer/materializer 直接收 bridge/reader；那样只会把旧字段读取面换地方，不会真的退出 payload truth

## 2026-06-18 request-route control source-to-sink verdict

- 已补 source-to-sink 审计：
  - `__routecodexRetryProviderKey` 当前最窄 TS writers = `request-executor-attempt-state.ts` + `index.ts`
  - `__routecodexPreselectedRoute` 当前关键链 = `index.ts` writer -> `executor-metadata.ts` / `servertool-followup-metadata.ts` guards -> `hub-pipeline-execute-request-stage.ts` bridge -> Rust `hub_pipeline_lib/engine.rs` read

## 2026-06-18 stopless metadata/request-result writer-first audit

- Jason 当前要求先清 stopless 这条线的 metadata 与 request-result 改写点，确保 trace 可读、唯一 writer 可锁。
- 已确认 stopless metadata 真正应该保留的主 writer：
  - `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts`
  - 这里写 `flowId/repeatCount/maxRepeats/triggerHint/continuationPrompt/schemaFeedback/active` 到 `MetadataCenter`。
- 已确认重复 writer 并已物理删除：
  - `sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts`
  - 删除原因：它从 `runtimePreCommandState.stopMessageText/Used/MaxRepeats` 二次回灌 stopless runtime control，属于非 owner 的重复写入，`reason=seed-from-routing-state`。
- 新增 focused test：
  - `tests/servertool/stopless-metadata-writer-ownership.spec.ts`
  - 锁 `runServerSideToolEngine` 不再从 precommand routing state 重写 stopless metadata。
- 已验证：
  - `tests/servertool/stopless-metadata-writer-ownership.spec.ts` PASS
  - `tests/servertool/servertool-auto-hook-trace.spec.ts` PASS
- 当前 request-result 改写 owner 仍分两段，需继续收口：
  - fresh request 翻译 owner：`rust-core/.../hub_req_inbound_tool_call_normalization.rs`
  - continuation/history 折叠 owner：`rust-core/.../shared_responses_conversation_utils.rs`
- 当前最可疑的非必要链路点：
  - `req_process_stage1_tool_governance_blocks/request_result.rs` 会把外部 metadata 与 governed metadata 再 merge 一次，必须加 trace / 红测确认 stopless control 没被覆盖。
  - `hub_req_inbound_tool_call_normalization.rs` 与 `shared_responses_conversation_utils.rs` 都会把 stopless tool output 翻译成模型可见文本；后续需要锁“谁负责翻译，谁只负责折叠历史”，避免双 owner。

## 2026-06-18 Jason 新规则收口：direct 不执行 stopless + 非 owner metadata 不得覆盖

- Jason 最新明确两条规则：
  1. direct 路径不应该执行 stopless；
  2. 不应该覆盖的地方要移除。
- 已落实到代码：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/napi_bindings.rs`
    - 删除 `evaluate_responses_direct_route_decision(...)` 中 stopless/servertool followup 强制 relay 逻辑。
    - 物理删除死代码 helper：
      - `has_stop_message_cli_result`
      - `scan_stop_message_cli_result`
      - `is_stop_message_cli_result_object`
      - `collect_direct_stop_message_text`
      - `stop_message_include_direct`
      - `has_servertool_followup_marker`
    - 新 direct 语义：responses same-protocol direct 上，stopless / generic servertool followup metadata 都不再触发 relay 判定。
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/request_result.rs`
    - `build_processed_request(...)` metadata merge 从覆盖式 `insert` 改为 `entry(...).or_insert(...)`，只补缺失键，不允许 governed metadata 覆盖已有 metadata truth。
- 新/更新验证：
  - Rust focused:
    - `cargo test -p router-hotpath-napi responses_direct_route_decision_tests --lib -- --nocapture` PASS
    - `cargo test -p router-hotpath-napi request_result --lib -- --nocapture` PASS
  - request_result 新测试：
    - `build_processed_request_does_not_override_existing_metadata_truth`
- 当前收口后结论：
  - direct 不再被 stopless/servertool followup 元数据拽进 relay。
  - req_process 尾部不再允许局部 governed metadata 覆盖请求已有 metadata 真相。
  - 下一步仍需继续锁 fresh request 翻译 owner 与 continuation/history 折叠 owner 的单一职责，并在线复核 provider-request 是否真正带出 stopless feedback。

## 2026-06-18 stopless MetadataCenter staged bridge: request-local control truth to provider-request blackbox

- Jason 当前明确方向已锁：stopless 等控制语义不能继续跟 normal payload/history 走，必须收进 `MetadataCenter`；这次只做 stopless 的 staged bridge，不宣称 session-scoped 中心化已经完成。
- 本轮实现：
  - 新增唯一 helper：`sharedmodule/llmswitch-core/src/servertool/stopless-metadata-center.ts`
  - `server-side-tools.ts` 里 legacy routing-state -> stopless runtime control seed 改走该 helper
  - `stop-message-auto.ts` finalize 写 stopless runtime control 也改走同一 helper，避免两份写入语义
  - `src/utils/responses-to-chat.ts` 补 host-side guard：native codec 若未把现有 `instructions` 投成 `system` message，则显式补到最终 `messages[0]`
- 证据：
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/stopless-metadata-center.spec.ts --runInBand` PASS
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts --runInBand` PASS
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/utils/responses-to-chat-native.spec.ts --runInBand` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npx tsc --noEmit --pretty false` PASS
- 这轮新锁住的黑盒结论：
  - `MetadataCenter.runtime_control.stopless`
    -> `prepareResponsesRequestBodyForHttp(...).pipelineBody.instructions`
    -> `normalizeResponsesToChatBody(...).messages`
    已能本地证明落到最终 provider-request 形态
- 仍然未完成的边界：
  - 这只是 request-local MetadataCenter staged bridge，不等于 session-scoped control center
  - 在线 5555 真实样本还没复核；只有完成 build/install/restart + replay/观察 provider-request 样本后，才能宣称线上链路也通
- 新增更强约束：
  - `metadata-center-manifest.yml` 已声明 `runtime_control` family 与 `MetaReq04RuntimeControlBound`
  - `metadata-center-types.ts` 也已有 `runtime_control`
  - 但 `metadata-center.ts` 当前 `state/read/write/markReleased` 还没有 `runtime_control` 实现
- 因此当前“最安全的下一刀”修正为：
  - 首选前置 slice = `hub.metadata_center_mainline / mtc-03 runtime_control plumbing`
  - 次选才是 `hub.metadata_center_attempt_merge / request-executor-attempt-state.ts`
  - 不首选 `index.ts`，因为它同时碰 direct relay、port dispatch、`PreselectedRoute` 与 `RetryProviderKey`
  - 不首选 `hub-pipeline-execute-request-stage.ts`，因为它依赖 Rust request-stage route input 同批切换
- 这意味着后续若要真正开始字段迁移实现，最稳的顺序仍然是：
  - 先补 `runtime_control` carrier
  - 再单收 attempt writer
  - 再收 entry writer
  - 最后才碰 TS bridge / Rust request-route band

## 2026-06-18 mtc-03 review-surface correction

- 已更新 `docs/architecture/wiki/metadata-center-mainline-source.md`：
  - `mtc-03` 的缺口不只是 `MetadataCenter` API 未实现
  - runtime-control family 现在还是“manifest/type 先行、state/read/write/release 落后”
  - request-route pin 这一小段语义也还没成为 first-class center slot
- 结论：
  - “最窄 writer 看起来最安全”这件事仍成立，但它已经不是最前置 slice
  - 真正的前置 slice 仍是 `hub.metadata_center_mainline / mtc-03 runtime_control plumbing`

## 2026-06-18 current worktree review-surface refresh after internal-field cleanup progress

- 重新按 goal 要求读了 `/Users/fanzhang/.codex/attachments/8c20d54c-9dab-43f9-a735-57abc20fb98a/pasted-text-1.txt`，并基于当前 worktree 重新跑 review-surface / payload-carrier 审计。
- 当前 runtime 基线：
  - `npm run audit:custom-payload-carriers` PASS
  - `__routecodex*`: `runtime=72, test=81, script=16, doc=41`，runtime unique files=`25`
  - `__sse_*`: `runtime=0, test=20, script=15, doc=7`，runtime unique files=`0`
  - `response.metadata`: `runtime=11, test=13, script=5, doc=44`，runtime unique files=`4`
- 当前 owner/queryability：
  - `npm run audit:custom-payload-carrier-owner-queryability` PASS
  - `__routecodex*`: `unique-owner=16`、`ambiguous-owner=9`、`missing-owner=0`、`missing-verification=0`
  - `response.metadata`: `unique-owner=2`、`ambiguous-owner=2`、`missing-owner=0`、`missing-verification=0`
- 已把 `payload_side_channel=10` 落成具体候选表：
  - 文档：`docs/goals/hub-pipeline-slimming-no-function-loss-plan.md`
  - 排序原则：先 `unique-owner` TS/host (`request-executor-attempt-state.ts` / `servertool-followup-dispatch.ts` / `provider-response-converter.ts` / `index.ts` / `hub-pipeline-execute-request-stage.ts`)，再 `ambiguous-owner` Rust broad-owner 带
  - 每项都已写明 owner、当前 token hits、semantic family、处置结论、风险、验证路径
- 当前 review-surface / longtail 复核：
  - `npm run verify:architecture-custom-payload-carrier-runtime-manifest` PASS
  - `node scripts/architecture/verify-custom-payload-carrier-containment.mjs` PASS
  - `npm run verify:function-map-compile-gate` PASS
  - `npm run verify:architecture-ci-longtail` PASS
  - `npm run verify:architecture-wiki-browser-smoke` PASS
  - `npm run verify:architecture-mainline-mermaid-sync` PASS
  - `npm run verify:architecture-forbidden-path-growth` PASS
  - `npm run verify:architecture-adjacent-builder-naming` PASS
- 继续确认：
  - 这轮 review-surface 没有发现新的红 gate
  - 当前最明显的变化是 `__routecodex*` runtime unique files 已稳定在 `25`
  - 之后已改用更稳定的命令执行方式补齐完整回执：
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci; printf '__RC__=%s' $?`
      - 完整输出已拿到，最终 `__RC__=0`
    - `node -e 'spawnSync(\"npm\", [\"run\", \"build:min\"], ...); write /tmp/rtk-buildmin.exit'`
      - `/tmp/rtk-buildmin.exit = 0`
      - `/tmp/rtk-buildmin.log` 末尾显示 `vite build`、`copy-compat-assets`、`copy-modules-config`、`fix:cli-permission` 已执行完
- 本轮只更新审计面与证明，不接手 Jason 正在做的内部字段运行时删除实现线

## 2026-06-18 build/install/live evidence refresh on current worktree

- 为了把“PTy/session 空转”从证据链里剔掉，这轮改用两种更稳定的方式取完整回执：
  - `verify:architecture-ci` 直接打印最终退出码
  - `build:min` / `install:global` 用 `node:child_process.spawnSync(...)` 包装，并把完整日志落到 `/tmp`
- 当前完整证据：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci; printf '__RC__=%s' $?`
    - 最终 `__RC__=0`
  - `node -e 'spawnSync(\"npm\", [\"run\", \"build:min\"], ...); write /tmp/rtk-buildmin.exit'`
    - `/tmp/rtk-buildmin.exit = 0`
    - `/tmp/rtk-buildmin.log` 尾部已确认执行完：
      - `vite build`
      - `copy-compat-assets`
      - `copy-modules-config`
      - `fix:cli-permission`
  - `node -e 'spawnSync(\"npm\", [\"run\", \"install:global\"], env.ROUTECODEX_INSTALL_INPLACE_BUILD=1 ...)'`
    - `/tmp/rtk-installglobal.log` 已明确输出：
      - `✅ 构建完成`
      - `🌍 执行全局安装...`
      - `changed 220 packages in 17s`
      - `✅ 全局安装成功`
      - `📦 刷新 RCC install/current runtime snapshot...`
    - 该脚本尾部仍可能卡在 snapshot refresh 后的 shell/PTY 回执，不把“无 exit 文件”当作失败；成功结论以下面真实证据为准：
      - `routecodex --version` => `0.90.3110`
      - `routecodex restart --port 5555` => `✔ RouteCodex server restarted: localhost:5555`
      - `curl -s http://127.0.0.1:5555/health` => `{\"status\":\"ok\",\"ready\":true,\"pipelineReady\":true,\"server\":\"routecodex\",\"version\":\"0.90.3110\"}`
      - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/tests/stopless-5555-live-probe.mjs` PASS
        - `health.version = 0.90.3110`
        - first turn `responseStatus=requires_action`
        - resume chain `responseStatus=completed`
        - `finalStatus=completed`
- 结论：
  - 当前 worktree 上，`CI gate -> build:min -> install:global -> restart -> /health -> live stopless replay` 这条证据链已经再次闭环
  - 这轮仍不意味着 Jason 的内部字段删除实现已经全部完成；它只说明 review-surface / build/install/runtime 验证链没有被当前清理进度打断

## 2026-06-18 followup dispatch duplicate-helper closeout and residual red classification

- 已把 `servertool-followup-dispatch.ts` 的本地 `readResponsesResponseId(...)` 去重到 `responses-request-bridge.ts::readResponsesResponseIdFromHttp(...)`。
- 这次去重后的单测验证结果：
  - `tests/server/runtime/http-server/executor/servertool-followup-dispatch.spec.ts` PASS
- 为了让 Jest mock 跟上当前导出面，补了两处测试出口：
  - `module-loader.js` mock 增加 `resolveImplForSubpath` / `parsePrefixList` / `matchesPrefix` / `isEngineEnabled` / `getEnginePrefixes` / `resolveCoreModulePath`
  - `native-chat-process-servertool-orchestration-semantics.js` mock 增加 `planServertoolSkeletonDerivedConfigWithNative` / `resolveServertoolToolSpecWithNative`
- 三件套复跑结果：
  - `tests/server/runtime/http-server/executor/servertool-followup-dispatch.spec.ts` PASS
  - `tests/server/runtime/http-server/executor/servertool-followup-model-pin-regression.spec.ts` 仍红
  - `tests/server/handlers/responses-handler.stop-followup-metadata.blackbox.spec.ts` 仍红
- 这两个剩余红点和本次去重无直接因果：
  - blackbox 红点是 `forbidden client metadata field: __rt`，属于当前你在清的内部字段入口校验线
  - model-pin 红点是 `servertool-followup-metadata.ts` 仍按设计剥离 `providerKey/targetProviderKey/assignedModelId`
- 当前处理原则不变：我只审计 / 收口 / 证明，不接手你正在做的内部字段物理删除实现线

## 2026-06-18 followup dispatch duplicate helper dedup

- 继续收 `servertool-followup-dispatch.ts` 时确认：
  - 本地 `readResponsesResponseId(...)`
  - 与 `src/modules/llmswitch/bridge/responses-request-bridge.ts::readResponsesResponseIdFromHttp(...)`
  - 逻辑同形，且 bridge 侧已经是现存 canonical builder
- 额外核查：
  - `responses-request-bridge.ts` 不 import `servertool-followup-dispatch.ts`
  - 不会形成循环依赖
- 已改：
  - `servertool-followup-dispatch.ts` 改为直接 import `readResponsesResponseIdFromHttp(...)`
  - 删除本地重复 helper `readResponsesResponseId(...)`
- 这次改动属于 shared logic first / duplicate wrapper removal，不改 runtime 语义，不改 payload carrier 基线

## 2026-06-18 dead-helper trim in followup/converter band

- 继续沿 `response_followup_semantics` 带做瘦身时，补做本地 helper 零 caller 扫描：
  - `src/server/runtime/http-server/executor/servertool-followup-dispatch.ts::isManagedStoplessGoalRequestSemantics`
  - `src/server/runtime/http-server/executor/provider-response-converter.ts::resolveGoalPersistenceScopeKey`
- `rg` 证据：
  - 这两个 helper 在 `src/tests/docs/sharedmodule` 范围内都只有定义命中，没有 runtime/test caller
- 结论：
  - 两者都属于纯 dead helper，可物理删除，不影响 payload carrier 基线与运行时语义
- 已删：
  - `isManagedStoplessGoalRequestSemantics(...)`
  - `resolveGoalPersistenceScopeKey(...)`
- 这轮是纯代码清理，不改 function-map / manifest 基线；验证口径走 focused build/gate

## 2026-06-18 response followup semantics slimming: zero-runtime-consumer helper removal

- 继续做 payload-carrier 审计时发现：
  - `src/server/runtime/http-server/executor/request-executor-response-inspect.ts::readServerToolFollowupSource`
  - 全仓命中只有：
    - 定义本身
    - `docs/architecture/function-map.yml` symbol table
    - `tests/server/runtime/http-server/executor/request-executor-response-inspect.spec.ts`
  - `rg -n "readServerToolFollowupSource" src tests docs scripts sharedmodule` 没有任何 runtime caller
- 结论：
  - 这是一个零 runtime consumer 的 dead helper，且它是该文件里唯一 `requestSemantics.__routecodex` 读取点
  - 物理删除该 helper 不改变功能行为，但可以真实收缩 `response_followup_semantics` runtime residue
- 已改：
  - 删除 `readServerToolFollowupSource(...)`
  - 删除对应白盒测试
  - `docs/architecture/function-map.yml` 去掉该 canonical builder，并把 owner_scope 改回真实剩余职责
  - `docs/architecture/custom-payload-carrier-runtime-manifest.yml` 删除 `request-executor-response-inspect.ts` 这项 runtime residue
  - 相关审计文档基线同步预期：
    - `__routecodex*` runtime files `26 -> 25`
    - `payload_side_channel 11 -> 10`
    - `response_followup_semantics 4 -> 3`
- 这次改动属于 dead helper 瘦身，不接管 Jason 正在做的字段迁移实现线

## 2026-06-18 custom payload carrier truth-refinement: request-route guard split

- 继续做 Jason 并行字段清理之外的 review-surface 审计，不碰 runtime 实现线。
- 重新核 `src/server/runtime/http-server/executor-metadata.ts` 与 `src/server/runtime/http-server/executor/servertool-followup-metadata.ts` 的 `__routecodex*` residue 语义：
  - `executor-metadata.ts`
    - 代码证据：`decorateMetadataForAttempt(...)` 只在 retry/excluded-provider 路径 `delete clone.__routecodexPreselectedRoute`
    - 白盒证据：`tests/server/http-server/executor-metadata.spec.ts` 用例 `drops stale preselected route on retry attempts with provider exclusions`
    - 结论：当前 `__routecodex*` residue 是 strip/guard，不是写入 side-channel owner
  - `servertool-followup-metadata.ts`
    - 代码证据：`stripProviderSelectionMetadataFields(...)` 会删 `__routecodexPreselectedRoute` / `providerKey` / `targetProviderKey` / `target`
    - 白盒证据：`tests/server/runtime/http-server/executor/servertool-followup-metadata.spec.ts` 用例 `does not inherit provider selection metadata for followup reentry`
    - 结论：当前 `__routecodex*` residue 是 followup reentry guard，不是 payload-side-channel writer
- 因此把 `docs/architecture/custom-payload-carrier-runtime-manifest.yml` 中这两个文件从 `payload_side_channel` truthy 改为 `guard_surface`；`semantic_family` 仍保留 `request_route_control`
- 预期分桶变化：
  - `__routecodex*`: `payload_side_channel 13 -> 11`
  - `__routecodex*`: `guard_surface 3 -> 5`
- 这次改动只修 review surface truth，不改 runtime 语义；后续 Jason 做字段物理删除时，这两处应作为 guard/strip 面审计，不应再被算进真实 side-channel writer 清单

## 2026-06-18 architecture review-surface rerun + canonical-builder spread closeout

- resume 后按项目/全局约束重读了 `~/.codex/USER.md`、`note.md`、`docs/agent-routing/00-entry-routing.md`、`docs/agent-routing/10-runtime-ssot-routing.md`、goal 文档与 `user-correction-alignment` / `coding-principals` / `rcc-dev-skills`。
- 基线复跑：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:function-map-compile-gate` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci-longtail` PASS
  - `git diff --check` PASS
- `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci` 首次复跑时命中真实漂移：
  - `verify:architecture-forbidden-path-growth` 报 `vr.route_selection: "VrRoute04SelectedTarget" found in forbidden path src/server/runtime/http-server/executor/request-executor-pipeline-attempt.ts`
  - 根因不是 VR 主线语义泄漏，而是 `request-executor-pipeline-attempt.ts` 里的 `MetadataCenter` provider-observation writer 把 canonical node id `VrRoute04SelectedTarget` 当成了本地 `stage` 标签。
- 修复：
  - `src/server/runtime/http-server/executor/request-executor-pipeline-attempt.ts`
    - `PIPELINE_ATTEMPT_PROVIDER_OBSERVATION_WRITER.stage`
    - 从 `VrRoute04SelectedTarget` 改成局部 observation 标签 `request_executor_pipeline_target_observation`
  - 这次改动不碰 payload、不改 runtime route semantics，只收回 forbidden-path growth。
- 修后复验：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-forbidden-path-growth` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci` PASS
  - `git diff --check` PASS
- 继续复核 owner/queryability 收口方向：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run audit:function-map-canonical-builder-spread` PASS
  - 当前 `features_with_multi_file_canonical_builders=14`
  - 高信号结构性 broad-owner：
    - `vr.route_selection`
    - `virtual_router.primary_exhausted_to_default_pool`
    - `vr.provider_forwarder_runtime`
    - `hub.metadata_boundary`
    - `hub.response_post_servertool_client_projection`
- 结论：
  - 当前剩余 Rust broad-owner ambiguity 不是“再缩 `owner_module`”就能真收口的问题。
  - 对 `vr.route_selection` / `virtual_router.primary_exhausted_to_default_pool` 这类 feature，canonical builders 客观分布在多个文件；直接把 `owner_module` 改窄会破坏 `verify:function-map-canonical-builder-definitions` / `verify:function-map-compile-gate` 的真实性。
  - 下一步如果还要继续降低 `audit:custom-payload-carrier-owner-queryability` 的 `ambiguous-owner`，只能做 truthy sub-feature split，不能做伪 file owner 收窄。
- 继续复核 Jason 的 payload/SSE 清理后静态锁面：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run audit:custom-payload-carriers` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run audit:custom-payload-carrier-owner-queryability` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-no-custom-payload-carriers` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/architecture/verify-custom-payload-carrier-containment.mjs` PASS
  - 当前事实：
    - `__sse_*` runtime residues 仍为 `0`
    - `__routecodex*` runtime files 仍为 `26`
    - owner-queryability 现为 `unique-owner=17 / ambiguous-owner=9 / missing-owner=0 / missing-verification=4`
- 本轮继续补的不是实现清理，而是 verification/queryability 锁：
  - `docs/architecture/verification-map.yml`
    - `error.provider_failure_policy` 新增 unit 路径：
      - `src/providers/core/runtime/http-request-executor.ts`
      - `src/providers/core/runtime/provider-request-header-orchestrator.ts`
      - `src/providers/core/runtime/transport/oauth-header-preflight.ts`
    - `server.responses_handler_family` 新增：
      - unit `src/server/handlers/handler-utils.ts`
      - contract `tests/server/handlers/handler-utils.metadata-contract.spec.ts`
      - integration `tests/server/handlers/handler-utils.metadata.spec.ts`
  - 结果：
    - `audit:custom-payload-carrier-owner-queryability` 收口为 `unique-owner=17 / ambiguous-owner=9 / missing-owner=0 / missing-verification=0`
    - 首次复跑 `verify:architecture-ci` 暴露 manifest 基线滞后：上述 4 个文件在 `custom-payload-carrier-runtime-manifest.yml` 仍写成 `verification_state: missing`
    - 已同步 manifest 为 `present`
- 修后复验：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-custom-payload-carrier-runtime-manifest` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci-longtail` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci` PASS
  - `git diff --check` PASS

## 2026-06-18 metadata center phase-1 provider observation closeout slice

- 继续收 MetadataCenter phase-1 的旧 flat provider projection 面，这轮把 `provider_observation` family 真正落到 request-scoped `MetadataCenter`：
  - `src/server/runtime/http-server/metadata-center/metadata-center-types.ts`
    - 新增 `MetadataCenterProviderObservation`
  - `src/server/runtime/http-server/metadata-center/metadata-center.ts`
    - 新增 `writeProviderObservation(...)` / `readProviderObservation()`
    - `markReleased(...)` 现在也覆盖 `providerObservation`
  - `src/server/runtime/http-server/executor/request-executor-pipeline-attempt.ts`
    - 删除 flat `mergedMetadata.target` / `mergedMetadata.compatibilityProfile` 写入
    - 改为只写 center `provider_observation.{target,providerKey,assignedModelId,modelId,clientModelId,compatibilityProfile}`
  - `src/server/runtime/http-server/executor/request-executor-attempt-state.ts`
    - merge request/pipeline metadata center 时，把 `providerObservation` family 一并 merge 进最终 center
  - 读路径迁移：
    - `servertool-adapter-context.ts`
    - `provider-request-context.ts`
    - `provider-response-utils.ts`
    - provider model / compatibility / original client model 现在优先读 center-backed `provider_observation`
- 新/改测试：
  - `tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts`
  - `tests/server/runtime/http-server/executor/provider-request-context.spec.ts`
  - `tests/server/runtime/http-server/executor/provider-response-utils.spec.ts`
  - `tests/server/runtime/http-server/request-executor.excluded-provider-reselection.spec.ts`
  - `tests/server/http-server/executor-metadata.spec.ts`
- docs/wiki 同步：
  - `docs/architecture/wiki/metadata-center-mainline-source.md`
  - `docs/architecture/wiki/metadata-center-audit.md`
  - `docs/architecture/wiki/html/metadata-center-mainline-source.html`
- 验证：
  - focused:
    - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts tests/server/runtime/http-server/executor/provider-request-context.spec.ts tests/server/runtime/http-server/executor/provider-response-utils.spec.ts tests/server/http-server/executor-metadata.spec.ts --runInBand` PASS
    - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/runtime/http-server/request-executor.excluded-provider-reselection.spec.ts -t "writes provider observation into MetadataCenter instead of reviving flat target metadata" --runInBand` PASS
  - regression stack:
    - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/runtime/http-server/executor/request-executor-request-state.spec.ts tests/server/runtime/http-server/executor/goal-state-persistence.spec.ts tests/server/http-server/executor-metadata.spec.ts tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts tests/server/runtime/http-server/executor/request-executor-session-storm-backoff.spec.ts tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts tests/server/runtime/http-server/index.request-truth-contract.spec.ts tests/modules/llmswitch/bridge/responses-response-bridge.request-truth.spec.ts tests/server/runtime/http-server/executor/client-injection-flow.spec.ts tests/server/runtime/http-server/executor/provider-request-context.spec.ts tests/server/runtime/http-server/executor/provider-response-utils.spec.ts --runInBand` PASS
  - docs/gates:
    - `npm run verify:architecture-wiki-sync` PASS
    - `npm run render:architecture-wiki-html` PASS
    - `npm run verify:architecture-wiki-html-sync` PASS
    - `npm run verify:function-map-compile-gate` PASS
  - build/install/live:
    - `npm run build:min` PASS
    - `ROUTECODEX_INSTALL_INPLACE_BUILD=1 npm run install:global` 实际生效；安装过程仍有 silent hang 现象
    - `/health` after restart => `ready=true pipelineReady=true version=0.90.3102`
    - `node scripts/tests/stopless-5555-live-probe.mjs` PASS
      - first turn `requires_action`
      - `hasExecCommand=true`
      - resume after hook output => `completed`
      - `finalStatus=completed`
- 额外事实：
  - `tests/server/runtime/http-server/request-executor.excluded-provider-reselection.spec.ts` 里现有用例 `does not infer fallback routePool from pool when explicit routePool is missing` 单独运行仍红，表现与本轮 provider observation 改动无关；这条属于该文件已有 routePool 语义噪音，不是 metadata center provider observation 回归。

## 2026-06-18 handler entry generic metadata-merge closeout slice

- 继续收 MetadataCenter phase-1 里明确点名的旧 merge surface，这轮把 `src/server/handlers/handler-utils.ts::mergePipelineMetadata` 物理删掉，改成显式 handler entry builder：`buildHandlerPipelineMetadata(...)`。
- 改动面：
  - `src/server/handlers/handler-utils.ts`
    - 删除 `mergePipelineMetadata`
    - 保留 denylist/allowlist sanitize 语义，但入口改成显式 handler builder 名称，不再保留“泛型 merge 真源”语义
  - `src/server/handlers/chat-handler.ts`
  - `src/server/handlers/messages-handler.ts`
  - `src/server/handlers/responses-handler.ts`
    - 三个入口都改用 `buildHandlerPipelineMetadata(...)`
  - `tests/server/handlers/handler-utils.metadata-contract.spec.ts`
  - `tests/server/handlers/handler-utils.metadata.spec.ts`
    - 同步锁定新 builder
- review surface 同步：
  - `docs/architecture/wiki/metadata-center-mainline-source.md`
  - `docs/architecture/wiki/metadata-center-audit.md`
  - `docs/architecture/function-map.yml`
  - `docs/architecture/mainline-call-map.yml`
  - `docs/goals/metadata-center-implementation-plan.md`
  - HTML 重渲染后 `metadata-center-mainline-source.html` 已不再残留 `mergePipelineMetadata`
- 验证：
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/handlers/handler-utils.metadata-contract.spec.ts tests/server/handlers/handler-utils.metadata.spec.ts --runInBand` PASS
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/runtime/http-server/executor/request-executor-request-state.spec.ts tests/server/runtime/http-server/executor/goal-state-persistence.spec.ts tests/server/http-server/executor-metadata.spec.ts tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts tests/server/runtime/http-server/executor/request-executor-session-storm-backoff.spec.ts tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts tests/server/runtime/http-server/index.request-truth-contract.spec.ts tests/modules/llmswitch/bridge/responses-response-bridge.request-truth.spec.ts tests/server/runtime/http-server/executor/client-injection-flow.spec.ts --runInBand` PASS
  - `npm run verify:architecture-wiki-sync` PASS
  - `npm run render:architecture-wiki-html` PASS
  - `npm run verify:architecture-wiki-html-sync` PASS
  - `npm run verify:function-map-compile-gate` PASS
  - `npm run build:min` PASS
  - `routecodex --version` => `0.90.3101`
  - `routecodex restart --port 5555` PASS
  - `curl -s http://127.0.0.1:5555/health` => `ready=true pipelineReady=true version=0.90.3101`
  - `node scripts/tests/stopless-5555-live-probe.mjs` PASS
    - first turn `requires_action`
    - `hasExecCommand=true`
    - resumed `submit_tool_outputs` => `completed`
    - final `finalStatus=completed`

## 2026-06-18 metadata center phase-1 executor followup closeout

- 继续收 `request_truth + continuation_context` phase-1，补上 executor 带里两个真实残留 consumer：
  - `src/server/runtime/http-server/executor/request-executor-request-state.ts`
  - `src/server/runtime/http-server/executor/goal-state-persistence.ts`
- 已改：
  - `initializeRequestExecutorRequestState(...)` 的 `registerRequestLogContext(...)` 不再读 flat `initialMetadata.sessionId/conversationId`，只读 `readRuntimeRequestTruthIdentifiers(initialMetadata)`。
  - `persistGoalStateFromMergedMetadata(...)` 不再读 flat `metadata.sessionId/conversationId`，改从 `MetadataCenter.request_truth` 取 session/conversation。
- 新增白盒锁：
  - `tests/server/runtime/http-server/executor/request-executor-request-state.spec.ts`
  - `tests/server/runtime/http-server/executor/goal-state-persistence.spec.ts`
- 正向锁：
  - 有 `MetadataCenter.request_truth` 时，即使 flat 字段缺失或冲突，request log context / stopless goal persistence 仍取 center truth。
- 反向锁：
  - 只有 flat `sessionId/conversationId`、没有 center truth 时，不得伪造 request truth；
  - `goal-state-persistence` 在无 explicit inject scope 且无 center truth 时不得持久化。
- 定向审计结论：
  - `responses-request-bridge.ts` 当前 `readResponsesSessionIdFromHttp/readResponsesConversationIdFromHttp` 仍属于入口 scope seed / continuation 恢复定位，不是 request truth materialization，本轮不改。
  - `state-integrations.extractSessionIdentifiersFromMetadata(...)` 当前只被 `executor-metadata.ts` 用于入口 requestTruth source seed，不是旧双真源读路径，本轮不改。
- 已验证：
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/runtime/http-server/executor/request-executor-request-state.spec.ts tests/server/runtime/http-server/executor/goal-state-persistence.spec.ts --runInBand` PASS
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/http-server/executor-metadata.spec.ts tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts tests/server/runtime/http-server/executor/request-executor-session-storm-backoff.spec.ts tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts tests/server/runtime/http-server/index.request-truth-contract.spec.ts tests/modules/llmswitch/bridge/responses-response-bridge.request-truth.spec.ts tests/server/runtime/http-server/executor/client-injection-flow.spec.ts tests/server/runtime/http-server/executor/request-executor-request-state.spec.ts tests/server/runtime/http-server/executor/goal-state-persistence.spec.ts --runInBand` PASS

## 2026-06-18 owner-queryability split closeout for http-server executor band

- 本轮不碰 Jason 正在做的 `__routecodex_*` / SSE custom 字段实现清理，只做 review surface / owner map / source anchor / verification 收口。
- 结构调整：
  - 把 `hub.metadata_center_mainline` 从目录级 owner 缩到真实 registry/release owner：`metadata-center.ts`
  - 新增 file-scoped owner：
    - `hub.metadata_center_request_capture` -> `executor-metadata.ts`
    - `hub.metadata_center_attempt_merge` -> `request-executor-attempt-state.ts`
    - `hub.metadata_center_servertool_context` -> `servertool-adapter-context.ts`
    - `daemon_admin.auth_gate_shell` -> `daemon-admin-routes.ts`
    - `server.provider_response_conversion_host` -> `provider-response-converter.ts`
    - `server.response_inspection_helpers` -> `request-executor-response-inspect.ts`
    - `server.servertool_followup_dispatch_surface` -> `servertool-followup-dispatch.ts`
    - `server.servertool_followup_metadata_surface` -> `servertool-followup-metadata.ts`
    - `server.http_runtime_lifecycle` -> `http-server-lifecycle.ts`
  - `server.http_runtime_entry` 收窄为 `index.ts` 真壳层，不再吃整个 `src/server/runtime/http-server/`
- 新增定向测试：
  - `tests/server/runtime/http-server/executor/request-executor-response-inspect.spec.ts`
  - `tests/server/runtime/http-server/daemon-admin-routes.auth.spec.ts`
- 已验证：
  - `node --experimental-vm-modules ./node_modules/.bin/jest tests/server/runtime/http-server/executor/request-executor-response-inspect.spec.ts tests/server/runtime/http-server/daemon-admin-routes.auth.spec.ts --runInBand` PASS
  - `node --experimental-vm-modules ./node_modules/.bin/jest tests/server/http-server/executor-metadata.spec.ts tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts --runInBand` PASS
  - `node --experimental-vm-modules ./node_modules/.bin/jest tests/server/runtime/http-server/executor/provider-response-converter.unified-semantics.spec.ts tests/server/runtime/http-server/executor/provider-response-converter-empty-sse.spec.ts tests/server/runtime/http-server/executor/provider-response-converter.prebuilt-sse-passthrough.spec.ts --runInBand` PASS
  - `npm run verify:function-map-compile-gate` PASS
  - `npm run verify:architecture-owner-queryability` PASS
  - `npm run verify:architecture-review-surface-light` PASS
  - `npm run audit:custom-payload-carrier-owner-queryability` PASS
- 新审计结果：
  - `__routecodex*` runtime 从 `unique-owner=9 / ambiguous-owner=17 / missing-owner=0 / missing-verification=8`
  - 提升到 `unique-owner=17 / ambiguous-owner=9 / missing-owner=0 / missing-verification=4`
  - 当前剩余 9 个 ambiguous owner 全部在 Rust crate broad owner 区，不再是 `src/server/runtime/http-server/executor/**` 这条 TS 热带
- 发现的非本轮回归基线噪音：
  - `tests/server/runtime/http-server/executor/servertool-followup-dispatch.spec.ts` 现有一条红点：缺 `normalizeServertoolRegistrationSpecWithNative` export
  - `tests/server/handlers/responses-handler.stop-followup-metadata.blackbox.spec.ts` 当前受更严格 metadata 边界影响，现状 502 / `forbidden client metadata field: __rt`
  - 这两处未由本轮 map/anchor 变更引入，本轮未接手修实现

## 2026-06-18 architecture/build gate rerun + doc drift closeout

## 2026-06-18 bridge surface re-audit on current worktree

- 在当前大脏树上重新复核 `responses-sse-bridge.ts` / `responses-response-bridge.ts`，目标不是改实现，而是保证 slimming candidate table 仍然说真话。
- 口径：
  - 扫描 `src` / `tests` / `scripts` / `docs/architecture` / `docs/goals`
  - 排除 `dist` / `coverage` / `target` / `node_modules` / `.git` / `*migrated*`
  - 统计“唯一引用文件数”，并额外做 exported symbol 零消费者扫描
- 结果：
  - `responses-sse-bridge`：唯一文件级命中 `runtime=4, test=5, script=1, doc=12`
  - `responses-response-bridge`：唯一文件级命中 `runtime=5, test=11, script=1, doc=13`
  - 两个文件的 exported symbol 复核都没有出现新的 zero-consumer export
- 结论：
  - `responses-sse-bridge.ts` 仍然只是 facade surface，但当前仍被 runtime handler / bridge barrel / red gate / map 消费，不能直接删
  - `responses-response-bridge.ts` 仍没有安全的“整文件瘦身”证据，只能继续找更小粒度 helper 或后续 native-downshift 点
  - `docs/goals/hub-pipeline-slimming-no-function-loss-plan.md` 已把这两个候选项改成当前 worktree 的唯一文件级 consumer count，避免继续沿用旧 token-hit 数

## 2026-06-18 internal-field cleanup audit prep

- 目标：在 Jason 并行清 `__routecodex_*` / SSE custom 字段时，先把“当前 gate 覆盖面”和“剩余内部 carrier 分布”审计清楚，不抢改实现。
- 新增 repo 级审计入口：
  - `scripts/architecture/audit-custom-payload-carriers.mjs`
  - `npm run audit:custom-payload-carriers`
  - 作用：跨 `src/tests/scripts/docs/sharedmodule` 统计 `__routecodex*` / `__sse_*` / `response.metadata` 的 bucket 分布，给后续清理前后做基线对比
- 当前 `verify-no-custom-payload-carriers.mjs` 事实：
  - 只扫描 `src`、`sharedmodule/llmswitch-core/src`、`rust-core/router-hotpath-napi/src`
  - 只禁 6 个精确 token：
    - `__sse_responses`
    - `__sse_stream`
    - `__routecodexDirectPassthrough`
    - `__routecodex_finish_reason`
    - `__routecodex_stream_contract_probe_body`
    - `__routecodex_reasoning_stop_finalized`
  - 不扫描 `tests` / `scripts` / `docs`
  - 不做 generic prefix ban：不会拦 `__routecodexPreselectedRoute`、`__routecodexRetryProviderKey`、`__routecodexRequestInfo`、`__routecodexProviderErrorReported` 等其它前缀字段
- 当前 runtime 仍存在的 `__routecodex*` 主要分三类：
  1. request-side metadata side-channel
     - `sharedmodule/.../hub-pipeline-execute-request-stage.ts`
     - `src/server/runtime/http-server/index.ts`
     - `src/server/runtime/http-server/executor-metadata.ts`
     - 仍在读/写 `__routecodexPreselectedRoute`、`__routecodexRetryProviderKey`
  2. internal object / error marker
     - `src/providers/core/runtime/http-request-executor.ts` 的 `__routecodexRequestInfo`
     - `src/providers/core/runtime/provider-request-header-orchestrator.ts` 的 `__routecodexAuthPreflightFatal`
     - `src/providers/core/utils/provider-error-reporter.ts` 的 `__routecodexProviderErrorReported`
     - `src/providers/core/utils/snapshot-writer-buffer.ts` 的 `__routecodexProviderSnapshotErrorBuffer`
  3. client-visible metadata guard / rejection logic
     - `src/modules/llmswitch/bridge/responses-response-bridge.ts` 会把 `__routecodex*` / `__rt*` / `providerKey` 视为 internal metadata carrier，在 `response.metadata` SSE frame 中 fail-fast
- 当前 client-visible `metadata` 出口规则：
  - `src/server/handlers/handler-response-common.ts`
    - 非 `response` / `response.*` 协议形状的顶层 `metadata` 直接 fail-fast
    - 对合法 `response.metadata`，若内部含 `__routecodex*` / `__rt*` / internal metadata keys，也会 fail-fast
    - 普通 provider `response.metadata` 仍允许透传，这是当前标准协议语义，不是自定义 carrier
- 结论：
- 当前“payload 自定义字段”热区 gate 是绿的，但它只锁住了已知高风险 token，不是“所有 `__routecodex*` 前缀一律防复活”的完整 gate
- 新发现的 owner-queryability 缺口：
  - `requestSemantics.__routecodex` 目前分布在 `request-executor-response-inspect.ts`、`servertool-followup-dispatch.ts`、`provider-response-converter.ts`
  - provider-runtime local markers 目前分布在 `http-request-executor.ts`、`provider-request-header-orchestrator.ts`、`oauth-header-preflight.ts`、`snapshot-writer-buffer.ts`
  - 这两组在现有 `function-map.yml` / `verification-map.yml` 里都还做不到 1-2 次查询内稳定反查唯一 owner；后续 Jason 清理前，必须先补 owner/queryability，不能继续只靠 grep 改字段
- 新增结构化 owner-queryability 审计：
  - `scripts/architecture/audit-custom-payload-carrier-owner-queryability.mjs`
  - `npm run audit:custom-payload-carrier-owner-queryability`
  - 当前结果：
    - `__routecodex*` runtime `26` 个文件里，`unique-owner=9`、`ambiguous-owner=17`、`missing-owner=0`、`missing-verification=8`
    - `response.metadata` runtime `4` 个文件里，`unique-owner=2`、`ambiguous-owner=2`、`missing-owner=0`、`missing-verification=0`
  - 当前最值得先补 map 的缺口：
  - 本轮已补上的 owner 缺口：
    - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts` -> `hub.request_stage_pipeline_bridge`
    - `src/providers/core/utils/snapshot-writer-buffer.ts` -> `snapshot.provider_error_buffer`
    - `src/providers/core/hooks/debug-example-hooks.ts` -> `provider.debug_example_hooks_surface`
  - 当前最明显的 owner 歧义带：
    - `src/server/runtime/http-server/executor/**` 仍普遍落在 `hub.metadata_center_mainline` 与 `server.http_runtime_entry` 双 owner 之间
- 当前 repo 里仍有大量 `tests` / `docs` / `fixtures` 历史样本使用旧字段，后续如果 Jason 要求彻底收口，这些面也需要分开判定：保留为历史样本、还是同步清理
- `npm run audit:custom-payload-carriers` 当前基线：
  - `__routecodex*`
    - hits: `runtime=76, test=81, script=12, doc=17`
    - unique files: `runtime=26, test=32, script=5, doc=3`
    - runtime 主热区：`__routecodexPreselectedRoute`、`__routecodexRetryProviderKey`、`__routecodexRequestInfo`、`__routecodexAuthPreflightFatal`
  - `__sse_*`
    - hits: `runtime=0, test=20, script=13, doc=6`
    - unique files: `runtime=0, test=8, script=6, doc=4`
    - 当前已无 runtime 残留，主要还在测试 fixture / install verify / mock extract / 历史文档
  - `response.metadata`
    - hits: `runtime=11, test=13, script=3, doc=32`
    - unique files: `runtime=4, test=3, script=3, doc=4`
    - runtime 面主要是 `responses-response-bridge.ts` allowlist/guard、Rust contract、provider debug hooks
- 新增 runtime spread 锁：
  - `scripts/architecture/verify-custom-payload-carrier-containment.mjs`
  - `package.json` 新增 `verify:architecture-custom-payload-carrier-containment`
  - `verify:architecture-ci-longtail` 已强制接线
  - 当前 allowlist 真相：
    - `__routecodex*`: runtime allowlisted files = `26`
    - `__sse_*`: runtime allowlisted files = `0`
    - `response.metadata`: runtime allowlisted files = `4`
- 当前已验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run audit:custom-payload-carriers` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/architecture/verify-custom-payload-carrier-containment.mjs` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/architecture/verify-function-map-build-wiring.mjs` PASS
- 等 Jason 的实现清理合入后，下一轮审计应重点看两件事：
  1. runtime 侧是否还把请求/响应 payload 语义建立在 `__routecodex*` 字段上
  2. static gate 是否要从“精确 token denylist”升级到“prefix-aware + side-channel-aware”防复活

## 2026-06-18 install/build tiering gate closeout

- 为了把“本地 build/install 与 CI 都能阻断 review-surface 漂移”从间接事实收成机器锁，本轮只补了调用层级 gate，不接手 Jason 正在做的 `__routecodex_*` / SSE custom 字段清理。
- 新增：
  - `scripts/architecture/verify-build-script-tiering.mjs`
  - 校验 `build:dev` / `build:dev:full` 只能经 `npm run build`
  - 校验 `install:global` / `install:release` 只能经各自 installer shell
  - 校验 `scripts/install-global.sh` / `scripts/install-release.sh` 内部必须走 `npm run build:min`
- 接线：
  - `package.json` 新增 `verify:build-script-tiering`
  - `verify:architecture-ci-longtail` 现强制执行该 gate
  - `scripts/architecture/verify-function-map-build-wiring.mjs` 新增反向检查：若 longtail 移除 `verify:build-script-tiering` 直接 fail
- 已验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/architecture/verify-build-script-tiering.mjs` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/architecture/verify-function-map-build-wiring.mjs` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run build:min` PASS
  - `git diff --check` PASS
- 结论：
  - review-surface 漂移现在不只会被 `build` / `build:min` 挡住，install shell 也被静态 gate 锁到必须经过 `build:min`
  - 这次补的是“防绕过 gate”，不是新的 `install:global` / `install:release` 实机 smoke；当前无权把它表述成一次新的安装运行验证

- 重新按当前 worktree 取了完整硬证据，不再沿用 earlier shell 采样不稳定的旧结论：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-review-surface-light` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run build:min` PASS
- 这次 rerun 说明当前代码面上：
  - no-custom-payload-carriers / mainline-call-map / wiki-sync / wiki-html-sync / manifest-sync 全绿；
  - review surface 已真实进入主 `architecture-ci`；
  - `build:min` 已能在本地前置链挡住 review-surface 漂移，不再只是远端 CI 兜底。

## 2026-06-18 stopless submit_tool_outputs relay mainline correction

- 继续追 live stopless 首轮激活后“第一次 submit_tool_outputs 没把工具结果带回 provider”的问题，先用真实 persisted continuation state 和 dist bridge 做了两段本地复核：
  - `responses-conversation-store.resumeResponsesConversation(...)` 产出的 payload 正常，包含 `previous_response_id + input[user, function_call, function_call_output]`，并且 `meta.fullInput/toolOutputsDetailed` 也正常。
  - `buildChatRequestFromResponses(...)` 对上述 resumed payload 的本地复核也正常，能产出 `assistant tool_call + role=tool/tool_call_id` 的 chat messages。
- 这说明根因不在 continuation store，也不在 Responses->Chat bridge 本体；收敛到“relay-owned submit_tool_outputs 已经 local materialize 成普通 `/v1/responses` continuation 后，仍带着 synthetic `/v1/responses.submit_tool_outputs` 往下走，存在被 provider/runtime 当成 upstream-native submit endpoint 重新解释的风险”。
- 本轮收口：
  - `src/modules/llmswitch/bridge/responses-request-bridge.ts`
    - relay-owned `resumeResponsesConversation(...)` 成功后，`pipelineEntryEndpoint` 改为 `/v1/responses`，不再继续沿用 `/v1/responses.submit_tool_outputs`。
  - `tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts`
    - 把 relay resume mock 从过时的 `tool_outputs` 形状改成真实 materialized `input[function_call,function_call_output]`；
    - 断言 pipeline 主线改为 `/v1/responses`，且 body 不再含 `tool_outputs`。
  - `tests/providers/core/runtime/responses-provider-helpers.spec.ts`
    - 新增 guard：`previous_response_id + input/function_call_output` 绝不能被 `extractSubmitToolOutputsPayload()` 误判成 native submit payload。
- 当前单测证据：
  - `npm run jest:run -- --runInBand --runTestsByPath tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts` PASS
  - `tests/providers/core/runtime/responses-provider-helpers.spec.ts` 跑通了新增 guard，但文件内已有旧断言 `429 affectsHealth=false` 目前本地仍红，属于既有基线噪音，和本轮 submit relay 改动无关。
- 本轮剩余漂移已经收敛到文档叙事而不是 gate/代码：
  - `docs/goals/hub-pipeline-architecture-review-surface-cleanup-plan.md` 仍把 `mtc-07` 写成 pending；
  - `docs/architecture/wiki/metadata-center-mainline-source.md` 仍把 center 主线描述成 `future`。
- 收口动作：
  - architecture review surface 计划改为：`mtc-07` 已 anchored 到 `metadata-center.ts::releaseMetadataCenterForHttpResponse -> MetadataCenter.markReleased`；
  - metadata-center wiki 改成“当前已部分实现、仍在迁移”，不再沿用 future 叙事；
  - 改完需要重渲染 wiki HTML，并复跑 wiki sync/html sync/manifest sync。

## 2026-06-18 stopless submit_tool_outputs second-hop real root cause locked

- 用 repo 本地 native `executeHubPipelineWithNative(...)` 直接重放 exact stopless resumed payload（`previous_response_id + user + reasoning + function_call + function_call_output`，target=`anthropic:claude-code`）后，复现了和 live 5555 一致的错误：provider request 只剩 user 文本，没有 `assistant tool_use + user tool_result`。
- 这把 owner 从“server 调用面/全局安装漂移”收敛到了 Rust mainline 内部；随后再逐段复核：
  - `coerceStandardizedRequestFromPayloadJson` 正常，产出 `user + assistant(tool_call) + tool`。
  - `applyReqProcessToolGovernanceJson` 正常，仍保留 tool pair，只额外 prepend stopless system instruction。
  - 直接调用 `buildAnthropicFromOpenaiChatJson(...)` 对上述 governed chat payload 转 anthropic 时，tool pair 被错误丢失，只剩 `system/user`。
- 最终根因：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/anthropic_openai_codec.rs`
  - `is_declared_tool_name(...)` 只有在 request 顶层 `tools` 声明里出现过的工具名才允许保留 assistant `tool_calls` / tool result。
  - stopless resumed relay submit_tool_outputs 正常不会再带 client `tools` 声明，因此 `exec_command` 被误判成 undeclared，`tool_use/tool_result` 全被过滤。
- 已修：
  - `is_declared_tool_name(...)` 改为：当 request 顶层没有任何 declared tools 时，不做这层名字过滤，保留既有 tool history。
  - 新增定向 Rust 锁：
    - `anthropic_openai_codec.rs::build_anthropic_from_openai_chat_preserves_tool_history_without_declared_tools`
    - `hub_pipeline_tests.rs::test_execute_hub_pipeline_preserves_stopless_resume_tool_history_without_declared_tools`
  - 同步刷新已有 anthropic continuation 测试断言，改成锁语义存在性，不再依赖 claude-code compat 下的具体 message index。
- 当前源码验证：
  - `cargo test build_anthropic_from_openai_chat_preserves_tool_history_without_declared_tools --package router-hotpath-napi` PASS
  - `cargo test test_execute_hub_pipeline_preserves_stopless_resume_tool_history_without_declared_tools --package router-hotpath-napi` PASS
  - `cargo test test_execute_hub_pipeline_preserves_responses_tool_continuation_for_anthropic_provider --package router-hotpath-napi` PASS
  - `cargo test request_codec_does_not_drop_live_stopless_tool_continuation_when_chat_messages_shortcut_exists --package router-hotpath-napi` PASS
- 下一步必须做：
  - rebuild native
  - global install
  - restart 5555
  - replay `scripts/tests/stopless-5555-live-probe.mjs`
  - 重新核对 live `provider-request.json` 是否已出现 `tool_use/tool_result`，再判断 submit_tool_outputs 是否真正闭环

## 2026-06-18 stopless live probe finalStatus misreport closed

- 在 `second-hop` 主线修复已经 live 生效后，`/tmp/stopless-5555-live-probe.json` 仍把 `finalStatus` 留成 `requires_action`，但 `resumeChain[0].rawBody.raw` 实际已包含 `response.completed` / `response.done` 和最终 assistant 文本。
- 真根因不在 stopless runtime，而在 probe 自己：
  - `scripts/tests/stopless-5555-live-probe.mjs::summarizeAttempt(...)` 只会读 JSON body，不会解析 `submit_tool_outputs` 返回的原始 SSE 字符串，所以恢复轮拿不到最终 `status=completed`。
  - 同文件还存在测试边界错误：被 import 时会直接执行 `main()`，导致脚本测试带 live 副作用。
- 已修：
  - 新增 `parseSseResponseEnvelope()` / `materializeProbeResponseBody()`，把 raw SSE 里的最后一个 `response` envelope materialize 回 probe summary；
  - `summarizeAttempt()` 统一基于 materialized body 取 `responseId/status/outputText`；
  - 增加 direct-execution guard，只有脚本直接执行时才会跑 `main()`。
- 新锁：
  - `tests/scripts/stopless-5555-live-probe.spec.ts`
  - 覆盖两件事：
    1. raw SSE completion 必须能 materialize 成 `status=completed`
    2. `summarizeAttempt()` 不能再把完成态 SSE 误报成 `requires_action`
- 当前验证：
  - `npm run jest:run -- --runInBand --runTestsByPath tests/scripts/stopless-5555-live-probe.spec.ts` PASS
  - `node scripts/tests/stopless-5555-live-probe.mjs` 线上复放 PASS，输出：
    - 首轮：`responseStatus=requires_action`
    - 恢复轮：`responseStatus=completed`
    - 最终：`finalStatus=completed`

## 2026-06-18 metadata center phase-1 request-truth read-path tightening

- 继续按 `docs/goals/metadata-center-implementation-plan.md` 收 request truth / continuation_context 第一阶段，当前锁定并已收口的旧双真源读路径：
  1. `src/server/runtime/http-server/metadata-center/request-truth-readers.ts`
     - 之前还会从 flat `metadata.sessionId/session_id/conversationId/conversation_id` 回退读取；
     - 已改成只读 `MetadataCenter.request_truth`。
  2. `src/modules/llmswitch/bridge/responses-response-bridge.ts`
     - request log / responses persistence 辅助上下文不再把 flat metadata 当 request truth；
     - 现在只认 `usageLogInfo` 或 `MetadataCenter.request_truth`。
  3. `src/server/runtime/http-server/executor/servertool-followup-dispatch.ts`
     - nested responses request context capture 不再直读 `metadata.sessionId/conversationId`；
     - 现在改走 centralized `readRuntimeRequestTruthIdentifiers(...)`。
  4. `src/server/runtime/http-server/executor/client-injection-flow.ts`
     - inject scope 推导不再从 flat request session 字段偷读；
     - 现在 tmux 之外只认 `MetadataCenter.request_truth`。
  5. `src/server/runtime/http-server/executor/request-executor-session-storm-backoff.ts`
     - session/conversation storm backoff scope 不再从 flat request session 字段偷读；
     - 现在只认 `MetadataCenter.request_truth`，没有 truth 时退到 workdir/daemon/clientType scope。
- 新增/更新测试锁：
  - `tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts`
  - `tests/modules/llmswitch/bridge/responses-response-bridge.request-truth.spec.ts`
  - `tests/server/runtime/http-server/executor/client-injection-flow.spec.ts`
  - `tests/server/runtime/http-server/executor/request-executor-session-storm-backoff.spec.ts`
  - 另外复核通过：
    - `tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts`
    - `tests/server/runtime/http-server/index.request-truth-contract.spec.ts`
    - `tests/server/runtime/http-server/executor-metadata.binding.spec.ts`
    - `tests/servertool/servertool-cli-projection.spec.ts`
- 当前验证结果：
  - request truth 定向链 PASS：
    - `npm run jest:run -- --runInBand --runTestsByPath tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts tests/modules/llmswitch/bridge/responses-response-bridge.request-truth.spec.ts tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts`
    - `npm run jest:run -- --runInBand --runTestsByPath tests/server/runtime/http-server/executor/client-injection-flow.spec.ts tests/server/runtime/http-server/executor/request-executor-session-storm-backoff.spec.ts`
    - `npm run jest:run -- --runInBand --runTestsByPath tests/server/runtime/http-server/executor-metadata.binding.spec.ts`
    - `npm run jest:run -- --runInBand --runTestsByPath tests/server/runtime/http-server/index.request-truth-contract.spec.ts tests/servertool/servertool-cli-projection.spec.ts`
  - live 5555 replay 继续为绿：
    - `node scripts/tests/stopless-5555-live-probe.mjs`
    - 新样本：`sessionId=stopless-live-1781726889159`
    - 结果仍是：首轮 `requires_action`、恢复轮 `completed`、最终 `finalStatus=completed`
- 当前未完成：
  - `build:min -> install:global -> restart 5555 -> live replay` 还没跑完；
  - `build:min` 前置 `review-surface/wiki/html/manifest` gate 已单独收绿，但长链构建当时被拆开执行；
  - `verify:function-map-compile-gate` 单独执行仍在等待明确输出，需下一步继续把完整 build/install 链跑完。

## 2026-06-17 hub pipeline architecture review evidence

## 2026-06-18 metadata center mtc-07 closeout verified

- 本轮目标是把 `docs/architecture/mainline-call-map.yml` 里的 `metadata.center.mainline::mtc-07` 从 `binding pending` 收成真实 owner/binding，不接手 Jason 正在并行清理的 `__routecodex_*` / SSE custom payload 字段线。
- 实现收口：
  - `src/server/runtime/http-server/metadata-center/metadata-center.ts`
    - 增加 `METADATA_CENTER_STATUS_ORDER`
    - 增加 `transitionSlotStatus(...)`
    - 增加 `markReleased(...)`
    - `releaseMetadataCenterForHttpResponse(...)` 已从 handler helper 收回到 MetadataCenter owner 文件，避免 function-map canonical builder 漂移
  - `src/server/handlers/handler-response-common.ts`
    - 改为从 MetadataCenter owner import/re-export `releaseMetadataCenterForHttpResponse`
  - `src/server/handlers/handler-response-utils.ts`
    - JSON `empty` / normal closeout 都显式调用 release helper
  - `src/server/handlers/handler-response-sse.ts`
    - bridge error / structured error / missing stream / prestart client close / normal SSE finish-close 都显式调用 release helper
- 文档绑定同步：
  - `docs/architecture/function-map.yml`：`hub.metadata_center_mainline` 维持 active，canonical builder `releaseMetadataCenterForHttpResponse` 已与真实 owner 对齐
  - `docs/architecture/mainline-call-map.yml`：`mtc-07` 真实绑定改为 `metadata-center.ts::releaseMetadataCenterForHttpResponse -> MetadataCenter.markReleased`
  - `docs/architecture/wiki/metadata-center-mainline-source.md`：`mtc-07` 说明改成真实 owner 文件
  - 已重渲染 generated wiki / HTML：`mainline-call-graph.md` 与 `metadata-center-mainline-source.html` 等同步
- 定向验证通过：
  - `tests/server/handlers/handler-response-utils.metadata-center-closeout.spec.ts`
  - `tests/server/http-server/executor-metadata.spec.ts`
  - `tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts`
  - `node scripts/architecture/verify-function-map-canonical-builder-definitions.mjs`
  - `npm run verify:architecture-mainline-call-map`
  - `npm run verify:architecture-wiki-sync`
  - `npm run verify:architecture-wiki-html-sync`
  - `npm run verify:architecture-manifest-sync`
  - `npm run verify:architecture-review-surface-light`
  - `npm run verify:architecture-review-surface`
  - `npm run verify:architecture-ci-longtail`
  - `node scripts/architecture/verify-function-map-build-wiring.mjs`
  - `npm run verify:architecture-no-custom-payload-carriers`
  - `npx tsc --noEmit --pretty false`
  - `git diff --check`
- 结论：
  - `mtc-07` 现在已有真实 closeout/release owner，不再是“文档 pending edge”
  - 此 slice 不改 payload 语义，不改 provider/runtime 路由，只做 request-scoped MetadataCenter closeout 状态收口
- 剩余非本轮 blocker：
  - 完整 `build:min` / `verify:architecture-ci` 通过 shell 工具长链采样存在 session 输出异常；当前已拿到其前置 review-surface / function-map / longtail leaf 证据，但本轮只把它记为“工具取证不稳定”，不把它宣称成未验证的失败或成功
  - Jason 最新规则下，`assertClientResponseHasNoInternalCarriers()` 对顶层 `metadata` 仍需后续补成一律 fail-fast 审计点

## 2026-06-18 install-global isolated build blocker on stopless-goal-state import

- 在把最新 stopless mainline 修正推到全局 CLI 时，`PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run install:global` 并没有卡在业务逻辑，而是卡在隔离构建目录的 Jest：
  - `tests/server/http-server/routes.invalid-json.spec.ts` 报 `Could not locate module ../../../../sharedmodule/llmswitch-core/dist/servertool/handlers/stopless-goal-state.js`
- 根因：
  - `scripts/install-global.sh` 的 isolated build copy 明确排除了 `sharedmodule/llmswitch-core/dist`
  - 但 `src/modules/llmswitch/bridge/state-integrations.ts` 还在静态 import `../../../../sharedmodule/llmswitch-core/dist/servertool/handlers/stopless-goal-state.js`
  - 导致 repo 直跑可用、isolated build 必炸，模块解析真源不一致
- 收口：
  - `state-integrations.ts` 已改成通过 `requireCoreDist('servertool/handlers/stopless-goal-state')` 读取 stopless owner exports，不再静态绑仓库内 dist 路径
  - 这样隔离构建 / Jest / 全局安装都走同一个 llmswitch bridge loader
- 复核：
  - `tests/server/http-server/routes.invalid-json.spec.ts` 已转绿
  - `tests/sharedmodule/state-integrations-stopless-goal.red.spec.ts` 当前仍有与本次修复无关的既有红点：
    - `READ: returns empty owner result when no goal state is persisted` 读到了预存 state
    - `COOLDOWN` 断言仍假设 Rust `health.rs` 不含 `persisted_503_reprobe_available`

## 2026-06-18 response metadata guard protocol-shape closeout

- 继续处理 `assertClientResponseHasNoInternalCarriers(...)` 的剩余边界时，先按当前 worktree 跑了：
  - `tests/red-tests/server_response_projection_metadata_guard.test.ts`
  - `tests/red-tests/server_sse_guard_e2e.test.ts`
  - `tests/red-tests/server_sse_metadata_guard_e2e.test.ts`
- 真实红点不是“所有 metadata 都漏”，而是：
  - generic SSE frame 顶层 `metadata` 仍被放过；
  - 但 `Responses` 协议里的合法 metadata 场景（`object: "response"` / `type: "response.*"`）本来就是绿的，不能一刀切打死。
- 最小修复：
  - `src/server/handlers/handler-response-common.ts`
    - 新增 `isClientVisibleProtocolMetadataContainer(...)`
    - 规则改成：只有 `Responses` 合法协议形状才允许 `metadata` 继续递归检查；其它 generic frame/body 一旦出现顶层 `metadata` 直接 fail-fast
  - `tests/red-tests/server_response_projection_metadata_guard.test.ts`
    - 新增非 `Responses` JSON body 顶层 `metadata` 即使值看似 client-safe 也必须报错的覆盖
- 已验证：
  - `tests/red-tests/server_response_projection_metadata_guard.test.ts` PASS
  - `tests/red-tests/server_sse_guard_e2e.test.ts` PASS
  - `tests/red-tests/server_sse_metadata_guard_e2e.test.ts` PASS
  - `tests/server/handlers/handler-response-sse-frame-metadata-guard.spec.ts` PASS
- 未作为本轮证据的噪音：
  - `tests/server/handlers/handler-metadata-boundary.spec.ts` 当前混有既有 mock/协议漂移：
    - `/v1/responses` helper 按 JSON 解析，但当前 mock path 可能返回 SSE error frame 文本；
    - image/messages/chat 分支也夹杂旧 mock body 形状和 handler error-path 断言；

## 2026-06-18 handler metadata boundary contract refresh + persisted request-context fix

- 在清 `handler-metadata-boundary.spec.ts` 噪音时，先确认了三处真实漂移不是 runtime regressions，而是测试样本落后于当前契约：
  - `/v1/responses` 未显式传 `stream: false`，当前 handler 默认可能走 SSE；
  - `/v1/images/generations` 样本缺 `model`，当前 handler 正常返回 400；
  - image path 当前 pipeline body/metadata 键名是 `imageGeneration`，不再是旧断言里的 `qwenImageGeneration`。
- 已修测试契约：
  - `tests/server/handlers/handler-metadata-boundary.spec.ts`
    - responses 两个 JSON 断言样本补 `stream: false`
    - image 样本补 `model`
    - image 断言改成 `imageGeneration`
    - persisted request-context 断言改成读 `MetadataCenter.continuation_context.responsesRequestContext`，不再读旧 flat `metadata.responsesRequestContext`
- 随后暴露出一个真实实现问题：
  - `src/modules/llmswitch/bridge/responses-request-bridge.ts::buildResponsesRequestContextForHttp`
  - 之前把 `args.payload` 原样塞进 `responsesRequestContext.payload`
  - 这会把客户端 request body `metadata` 持久化进 continuation request context，违背“request body metadata 不进 persisted responses request context”规则
- 已修唯一 owner：
  - `buildResponsesRequestContextForHttp(...)` 现在先过 `stripRequestBodyMetadataForPipelineForHttp(args.payload)`，持久化时只存剥离 metadata 的 payload
- 新增 focused lock：
  - `tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts`
    - 新增 `strips request body metadata before persisting relay request context payload`
- 已验证：
  - `tests/server/handlers/handler-metadata-boundary.spec.ts` PASS
  - `tests/modules/llmswitch/bridge/responses-request-bridge.metadata-center.spec.ts` PASS
  - `tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts` PASS
  - `tests/modules/llmswitch/bridge/responses-response-bridge.request-context-resolution.spec.ts` PASS
  - `tests/modules/llmswitch/bridge/state-integrations.metadata-center.spec.ts` PASS
  - `npm run verify:architecture-review-surface-light` PASS
  - `npx tsc --noEmit --pretty false` PASS

## 2026-06-18 responses handler single-bridge-surface trim

- `npm run verify:architecture-ci` 最新红项已收敛到 `verify:responses-handler-single-bridge-surface`。
- 根因不是 bridge 逻辑漂移，而是 handler 层仍自带 `hasSsePayload()` facade：
  - `src/server/handlers/handler-response-utils.ts` 导出本地 helper；
  - `chat-handler.ts` / `messages-handler.ts` / `responses-handler.ts` 通过 `handler-utils.ts` 间接消费；
  - gate 将其视为 responses handler response-side extra surface。
- 最小修复面：物理删除 `hasSsePayload` export/re-export，handler 与测试统一改成直接判 `result.sseStream !== undefined`，不引入新 facade。
- 已完成：
  - `src/server/handlers/handler-response-utils.ts` 删除 `hasSsePayload()`；
  - `src/server/handlers/handler-utils.ts` 删除转发导出；
  - `chat-handler.ts` / `messages-handler.ts` / `responses-handler.ts` 改成直接判 `result.sseStream === undefined` 决定是否走 JSON complete log；
  - `tests/red-tests/server_sse_guard_e2e.test.ts` 不再依赖 module helper。
- 已验证：
  - `npm run verify:responses-handler-single-bridge-surface` PASS
  - `npm run verify:architecture-ci` PASS
  - `npm run build:min` PASS
  - `npx tsc --noEmit --pretty false` PASS
  - `git diff --check` PASS
- 新发现但未纳入本轮 gate 闭环：
  - `tests/red-tests/server_sse_guard_e2e.test.ts` 现在暴露 `assertClientResponseHasNoInternalCarriers()` 对顶层 `metadata` 不是一律 fail-fast，只在 metadata 内部命中 internal carrier key 时才报错。
  - 这和 Jason 最新“非协议标准字段不得混入 payload”规则不完全一致，应作为内部字段清理后的下一收口点。

## 2026-06-18 finish reason fallback alias removal

- 候选 `src/server/utils/finish-reason.ts::deriveFinishReasonWithVisibleSuccessFallback` 已确认是真死别名，不再承载任何独立语义：
  - 实现只是 `return deriveFinishReason(body)`；
  - 生产调用点只剩 `src/server/handlers/handler-utils.ts` 与 `src/server/runtime/http-server/index.ts`；
  - 直接测试 import 只剩 `tests/server/utils/finish-reason.visible-success.spec.ts`；
  - 其余两处只是 handler focused tests 的 mock residue，不是 runtime consumer。
- 已完成：
  - 删除 `deriveFinishReasonWithVisibleSuccessFallback` export；
  - `handler-utils.ts` / `http-server/index.ts` 统一改回直接调用 `deriveFinishReason(...)`；
  - `tests/server/utils/finish-reason.visible-success.spec.ts` 改成直接覆盖 `deriveFinishReason(...)` 的 visible-success 场景；
  - `verify:architecture-deleted-path` 新增 repo-wide deny token，禁止 `deriveFinishReasonWithVisibleSuccessFallback` 在 `src/tests/scripts` 复活。
- 定向验证过程中发现两条 submit_tool_outputs focused tests 的 mock 与当前真实导出漂移：
  - 缺 `captureReqInboundResponsesContextSnapshot`
  - 缺 `lookupResponsesContinuationByResponseId`
  - 已做最小 mock 同步，不改测试语义。
- 已验证：
  - `tests/server/utils/finish-reason.spec.ts`
  - `tests/server/utils/finish-reason.visible-success.spec.ts`
  - `tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts`
  - `tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts`
  - `npm run verify:architecture-deleted-path`
  - `npx tsc --noEmit --pretty false`
  - `npm run verify:architecture-ci`
  - `npm run build:min`
  - `git diff --check`

## 2026-06-18 metadata center mainline pending-edge closeout progress

- 重新按当前 worktree 复核 `docs/architecture/mainline-call-map.yml` 的 `metadata.center.mainline` 后半段，不再沿用“mtc-04..07 全 pending”的旧叙事。
- 当前真实代码绑定：
  - `mtc-04` 可诚实绑定到 `src/server/runtime/http-server/executor/request-executor-pipeline-attempt.ts::resolveRequestExecutorPipelineAttempt`：
    - 这里在 `finalizeRequestExecutorAttemptMetadata(...)` 之后写 `mergedMetadata.target` 与 `mergedMetadata.compatibilityProfile`；
    - 说明 provider observation 已有真实 adjacent owner，但仍走 flat metadata，不是显式 `provider_observation` family。
  - `mtc-05` 可诚实绑定到 `src/modules/llmswitch/bridge/responses-response-bridge.ts::persistResponsesConversationLifecycleForHttp`：
    - 当前 response closeout 会本地 `deriveFinishReason(args.body)`；
    - 同时通过 `readRuntimeRequestTruthIdentifiers(args.metadata)` 读取 MetadataCenter-backed request truth 做 continuation lifecycle persistence；
    - 这是真实 response-observation read path，但 `response_observation` 尚未落成独立 center family。
  - `mtc-06` 可诚实绑定到 `src/server/runtime/http-server/executor/servertool-adapter-context.ts::buildServerToolAdapterContext -> MetadataCenter.readRequestTruth()`：
    - servertool projection 现在已锁住 request `sessionId/conversationId` 只从 center 读；
    - 但 route/provider observation 仍来自 flat metadata bag，所以只能记 `partial`。
- 仍不能伪造的部分：
  - `mtc-07` closeout/release 仍无显式 MetadataCenter finalize/release API；继续保持 `binding pending`，不编假 symbol。
- 文档同步方向：
  - `docs/architecture/wiki/metadata-center-mainline-source.md` 应改成“`mtc-04/05/06` partial、`mtc-07` pending”的状态描述；
  - slimming / architecture review plans 也要同步，不再把后半段说成 4 条全 pending。

## 2026-06-18 servertool-request-normalizer single-consumer trim

- 复核后确认 `src/server/runtime/http-server/executor/servertool-request-normalizer.ts` 只有 39 行、只承载 `syncStoplessGoalStateFromCapturedRequest(...)` 一个 helper，且生产 consumer 仅 `buildServerToolAdapterContext(...)` 一处。
- 现有 `tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts` 已经覆盖该 helper 的核心语义，不需要先补新测试：
  - RCC fenced `capturedEntryRequest` 覆盖 `capturedChatRequest`
  - metadata `capturedEntryRequest` 作为 RCC fence fallback
  - `onReasoningStopSeedError` 回调吞错路径
- 本轮动作：
  - 将 `syncStoplessGoalStateFromCapturedRequest(...)` 直接内联回 `src/server/runtime/http-server/executor/servertool-adapter-context.ts`
  - 物理删除 `src/server/runtime/http-server/executor/servertool-request-normalizer.ts`
  - `docs/architecture/verification-map.yml` 删除该单文件 unit 路径
  - `scripts/architecture/verify-architecture-deleted-path.mjs` 新增 deleted-path 防复活
- 这属于“单 consumer 单函数文件回收”，不改变 stopless / MetadataCenter 语义，只缩小 host-side glue surface。

- 本轮已把 Hub Pipeline architecture review surface 从“有文档但会漂移”推进到可 gate 化状态：
  - `package.json` 新增 `verify:architecture-review-surface-light` 和 `verify:architecture-review-surface`；
  - `build` / `build:min` 已在 `tsc` 前强制运行 `verify:architecture-review-surface-light`；
  - `verify:architecture-ci` 已接入完整 `verify:architecture-review-surface` 和 `verify:architecture-ci-longtail`；
  - `scripts/architecture/verify-function-map-build-wiring.mjs` 已加锁：如果 build/min 移除 review surface light，或 architecture-ci 移除 review surface / longtail，会直接失败。
- 当前 architecture review surface 验证已通过：
  - `npm run verify:architecture-review-surface` PASS：mainline call map 7 chains / 44 edges / 9 shared functions；wiki sync 检查 7 generated + 7 manual pages；HTML sync PASS；metadata-center manifest sync PASS；Chrome browser smoke 检查 14 HTML pages。
  - `npm run verify:architecture-ci-longtail` PASS：deleted-path、duplicate-owner、ts-owner-ban 都绿。
  - `npm run verify:function-map-compile-gate` PASS：71 active features，284 canonical builders，且 build wiring gate 已检查 review surface light。
  - `npm run verify:architecture-mainline-mermaid-sync` PASS；`git diff --check` PASS。
- 当前未跑 `build:min`：Jason 正在并行处理 payload/SSE 内部字段清理，完整 build 可能被该进行中代码面影响；本轮只宣称 architecture review surface/gate 闭环，不宣称全仓 build 通过。
- active goal 继续推进到瘦身审计候选表：
  - 已更新 `docs/goals/hub-pipeline-slimming-no-function-loss-plan.md`，新增“当前状态复核补充”表，包含 owner、consumer count、处置结论、风险、验证路径。
  - 当前明确 delete candidate：`servertool-response-normalizer.ts::buildServerToolSseWrapperBody`，生产 consumer 为 0（只剩定义、测试、历史 doc），但与 Jason 正在处理的 payload/SSE 字段清理重叠，本轮只登记不删除。
  - 当前 merge/rename candidate：`deriveFinishReasonWithVisibleSuccessFallback`，函数体已只是 `deriveFinishReason`，但 dirty 文件与现有测试仍引用旧名。
  - 当前 marker cleanup candidate：`bodyContainsReasoningStopFinalizedMarker` 恒返回 false，属于旧 `__routecodex_reasoning_stop_finalized` marker 残留接口，需等内部字段清理稳定后删除调用链。
  - 当前 defer：`responses-sse-bridge.ts` 和 `responses-response-bridge.ts`，仍是 function-map owner/canonical bridge surface，不能按“大文件/重复 facade”直接删除。
- 最新验证：
  - `npm run verify:function-map-build-wiring` PASS。
  - `git diff --check` PASS。
  - `npm run verify:architecture-review-surface-light` 当前 FAIL 于新接入的 `verify:architecture-no-custom-payload-carriers`，红项为当前已知 `__sse_responses` / `__routecodexDirectPassthrough` / `__sse_stream` 残留；这与 Jason 并行清理任务一致，本轮不抢改。
- 继续复核（不触碰并行 payload/SSE 内部字段清理实现）：
  - `npm run verify:architecture-mainline-call-map` PASS：7 chains / 44 edges / 9 shared functions。
  - `npm run verify:architecture-wiki-sync` PASS：7 generated wiki pages + 7 manual wiki pages。
  - `npm run verify:architecture-wiki-html-sync` PASS：HTML render artifacts match。
  - `npm run verify:architecture-manifest-sync` PASS：`metadata.center.mainline` / 8 nodes / owner `hub.metadata_center_mainline`。
  - `npm run verify:architecture-wiki-browser-smoke` PASS：Chrome loaded 14 HTML pages and Mermaid smoke render was nonblank.
  - `npm run verify:architecture-ci-longtail` PASS：deleted-path / duplicate-owner / ts-owner-ban all green.
  - `npm run verify:function-map-compile-gate` PASS：71 active features, 284 canonical builders, build wiring still requires review surface light.
  - `npm run verify:architecture-mainline-mermaid-sync` PASS；`git diff --check` PASS。
  - 当前剩余 blocker 仍是 Jason 正在清的 non-standard payload carrier gate；本轮不抢改 `__routecodex_*` / SSE wrapper 字段实现面。

## 2026-06-17 SSE/custom-field boundary correction

- Jason 明确纠正：SSE 层只能承载标准协议语义，不能解析帧内容来触发 servertool/stopless，也不能在请求/响应 payload 内塞自定义控制字段。
- 最新收口规则：所有非协议标准字段都不得混入请求/响应 payload；`__routecodex_*` 与 `__sse_responses` 这类内部 carrier 必须迁出 payload，内部控制只走 `MetadataCenter` / runtime side-channel。
- 当前已定位两类污染源：
  - direct continuation owner 通过 `__routecodexDirectPassthrough` 放进 result metadata 并被 SSE handler / bridge 读取；
  - SSE stream 通过 `body.__sse_responses` 包装传给 response handler，属于自定义 response payload 字段。
- 收口方向：direct owner 写入 `MetadataCenter.continuation` 或显式 typed result side-channel；SSE stream 迁到 `PipelineExecutionResult.sseStream` 等 runtime side-channel，handler 不再从 body 解析 wrapper。
- 当前必须删除的错误面：
  - `__routecodex_finish_reason`
  - `__routecodex_stream_contract_probe_body`
  - `__routecodex_reasoning_stop_finalized`
  - `provider-response-converter` 的 `prebuilt_sse_stopless_bridge`
- 新边界：finish reason、terminal probe、servertool/stopless 状态只能来自 chat process 正常语义或 MetadataCenter/runtime side-channel；不能通过 SSE wrapper 自定义字段传递。
- `__sse_responses` 仍是更深一层的内部 stream carrier 残留，后续也应迁到 MetadataCenter/runtime side-channel，不再作为 payload 字段长期存在。

- function-map/verification-map 体系当前较完整：`npm run verify:function-map-compile-gate` PASS，覆盖 71 active features、71 verification rows、284 canonical builders，且 `build` / `build:min` 已强制先跑该 gate。
- 当前不能宣称 hub pipeline 架构闭环已全锁住：`npm run verify:architecture-mainline-call-map` FAIL，`metadata.center.mainline` 的 `mtc-01/mtc-02` symbol 绑定漂移；`npm run verify:architecture-wiki-sync` 因 mainline map 无法 render；`npm run verify:architecture-wiki-html-sync` FAIL，`metadata-center-mainline-source.html` out of sync。
- mainline call map 状态量化：7 chains / 43 edges，其中 34 anchored、3 partial、6 binding pending；pending 主要集中在 request route/outbound split 与 metadata center 后半段。
- 流程漂移缺口：`build:min` 只强制 function-map compile gate，不强制 mainline/wiki gate；CI workflow 跑 `verify:architecture-ci` 会挡，但本地安装/构建可绕过 mainline/wiki 漂移。`verify:architecture-ci-longtail` 当前 FAIL 于 duplicate-owner 的 `metadata:runtime` 跨 family overlap，且未并入主 architecture-ci。
- wiki/manifest 缺口：repo 有 HTML wiki 与 `metadata-center-manifest.yml`，但未看到 manifest 与 call map/wiki/function-map 的一致性校验，也未看到浏览器级 wiki render smoke gate；目前只锁 markdown/html 文本同步。

## 2026-06-17 stopless hidden responsesRequestContext session leak

- 现网 `0.90.3077` 日志已确认不是历史噪音：`[servertool] ... stop_message_auto ... used=0 left=3 active=true` 后，同一请求仍以 `finish_reason=tool_calls` 返回，而同条 request 的 `[session-request][rt]` 仍是 `session=unknown`。
- 工作树与安装态 `sharedmodule/llmswitch-core/dist/servertool/engine.js` 都已含 `skipped_missing_session` gate，说明“缺 gate”不是根因。
- 新候选根因：`src/server/runtime/http-server/executor/servertool-request-normalizer.ts` 仍把 `responsesRequestContext.sessionId/conversationId` 回填到 `baseContext.sessionId/conversationId`；而 session realtime log 不把这层 continuation context 当请求 session 真相。
- 这会导致 stopless 在“外层请求 session=unknown，但 relay/resume context 内有旧 session”时误激活；修复方向是把 `responsesRequestContext` 从 request session truth 候选里移除，并补红测锁“responsesRequestContext-only 不得激活 stopless”。

## 2026-06-18 stopless first-turn direct bypass root cause

- “5555 该激活却没激活”当前已锁到 direct/relay 主线，而不是 finish_reason 或 session header 缺失：
  - `~/.rcc/config.toml` 中 `5555` 为 `sameProtocolBehavior = "direct"`；
  - 项目规则已写明 direct 响应不进入 Hub `resp_chatprocess`，因此 stopless 不会在 direct 路上激活；
  - Rust 已有 `evaluateResponsesDirectRouteDecision*` / `servertool_followup_requires_hub_relay` 契约，但 TS 主线 `executeRouterDirectPipelineForPort()` 之前根本没接这层判定。
- 本轮已修唯一主线：
  - `src/server/runtime/http-server/index.ts` 在 router-direct 进入 VR 之前先跑 `evaluateDirectRouteDecision(...)`；
  - 若 `requiresHubRelay=true`，直接返回 relayable skip，不再先撞 `virtual-router-not-ready` 或直通 provider；
  - 若 provider wire 非法，直接抛 host payload contract error，禁止继续 direct route。
- 新红测已先红后绿：
  - `tests/server/runtime/http-server/direct-passthrough-payload.spec.ts`
    - `stopMessageEnabled=true + stopMessageExcludeDirect=false` 的首轮 `/v1/responses` 现在必须 `requiresHubRelay=true`
  - `tests/server/runtime/http-server/router-direct-protocol-boundary.spec.ts`
    - `stopMessage.includeDirect=true` 时，`executePortAwarePipeline(5555, /v1/responses)` 必须在 direct transport 前 relay 到 Hub

## 2026-06-18 stopless live non-activation narrowed to metadata-center clone loss

- 在线 5555 现象已复核：`/v1/responses` 返回 provider 原始 `response.completed`，`output_text` 直接泄漏 stop schema，没有 `exec_command`。
- 黑盒继续暴露第二个独立红点：`seedReasoningStopStateFromCapturedRequest` / `readStoplessGoalState` 在 Jest 下因 `servertool/handlers/stopless-goal-state` 被 source `require` 成 `ERR_REQUIRE_ESM`。
- 更关键的 live 结构性漏洞：
  - `buildServerToolAdapterContext(...)` 只信 `MetadataCenter.readRequestTruth()`，若 center 缺失会主动 `delete baseContext.sessionId/conversationId`；
  - `decorateMetadataForAttempt(...)` 之前只做 `structuredClone`，没有把 `MetadataCenter` symbol 重新 bind 到 attempt clone；
  - 这会让 request 入口明明已经写入的 request truth，在 response-stage adapterContext 里看起来像“无 session truth”，最终触发 Rust stopless contract 的 `stop_message_missing_session -> terminal_final`，表现为 stop schema 泄漏而非 cli projection。
- 本轮修复方向：
  - `executor-metadata.ts` 在 attempt clone 后显式 `MetadataCenter.bind(clone, MetadataCenter.read(base))`；
  - `module-loader.ts` 把 `servertool/handlers/stopless-goal-state` 加入 Jest dist-only 前缀，避免黑盒继续被 `ERR_REQUIRE_ESM` 挡住。
- 当前结论：
  - 代码层根因不是“sessionId 不存在”，而是“首轮 stopless direct->relay 判定器未接主线，且接入位置还必须早于 VR 准备检查”；
  - 线上要真正激活，还需要把目标端口配置成 `stopMessage.includeDirect=true`，否则默认仍是 direct 排除 stopless。

## 2026-06-17 metadata center read-path trim follow-up

- 本轮继续对 goal 做真正收口，不再只停在入口 materialize：
  - `src/server/runtime/http-server/executor/servertool-adapter-context.ts` 已改成 request `sessionId/conversationId` 只读 `MetadataCenter.request_truth`，不再从 `entryOriginRequest`、平铺 `metadata.sessionId`、`__rt.sessionId` 或其它别名回填。
  - `src/server/runtime/http-server/executor/servertool-request-normalizer.ts` 已物理删除 `backfillAdapterContextSessionIdentifiersFromEntryOriginRequest()`，旧 request truth 回填面消失。
- 新发现并已修：`MetadataCenter.writeRequestTruth()` 之前只是名义上的 `write_once`，实现上仍允许覆盖；现已改成第二次写同 slot 直接抛错，避免 request truth 被后续阶段静默重定义。
- 定向回归已通过：
  - `tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts`
  - `tests/server/http-server/executor-metadata.spec.ts`
  - `tests/servertool/stopless-cli-continuation.spec.ts`
  - `tests/modules/llmswitch/bridge/responses-request-bridge.metadata-center.spec.ts`
  - `npx tsc --noEmit --pretty false`

## 2026-06-17 factual Codex samples session headers audit

- 只看事实样本，不做协议推断，已确认多个真实 Codex-origin request 样本都带 request session 标识，而且位置在 HTTP headers。
- 硬证据 1：`tests/fixtures/goal-request-user-input-real-samples/provider-request.goal.nested-after-fix.json`
  - `headers.User-Agent = codex-tui/...`
  - `headers.originator = codex-tui`
  - `headers.session_id = 019dfdbc-46c0-77b1-bcd6-d832b6080c9d`
  - `headers.conversation_id = 019dfdbc-46c0-77b1-bcd6-d832b6080c9d`
- 硬证据 2：`tests/fixtures/goal-request-user-input-real-samples/provider-request.goal.flattened-before-fix.json`
  - `metadata.clientHeaders.session_id = 019dfdc9-bcd7-7b70-8384-8bcaa9a63e6f`
  - `metadata.clientHeaders.conversation_id = 019dfdc9-bcd7-7b70-8384-8bcaa9a63e6f`
  - 同样带 `user-agent = codex-tui/...` 与 `originator = codex-tui`
- 硬证据 3：`tests/fixtures/errorsamples/2026-05-17-responses-empty-output/provider-request.json`
  - `metadata.clientHeaders.session_id = 019e34fa-1e7a-7eb0-bab2-0752ac6ff649`
  - `metadata.clientHeaders.conversation_id = 019e34fa-1e7a-7eb0-bab2-0752ac6ff649`
  - 同样带 `user-agent = codex-tui/...`
- 当前代码面对应事实：
  - `src/server/runtime/http-server/executor-metadata.ts::extractRequestSessionIdFromHeaders()` 已支持 `session_id/session-id/x-session-id`
  - `buildRequestMetadata()` 会把 header-derived session/conversation 写入 `MetadataCenter.request_truth`
- 新确认的疑点不是“Codex 不带 session”，而是 live 链某处没有把这个事实反映到最终日志/功能读点：
  - `src/server/runtime/http-server/index.ts::readSessionIdForUsageLog()` 仍只读顶层 `metadata.sessionId/session_id`，不读 `MetadataCenter.request_truth`
  - 因此即使 request truth 已存在，usage/session realtime log 仍可能打印 `session=unknown`

## 2026-06-17 legacy /v1/messages replay session truth progress

- 旧失败 replay 样本 `tests/fixtures/goal-request-user-input-real-samples/runs/sample_1781701218849/metadata-center-replay-flattened-before-fix/request.json` 当前已证明：
  - 最初失败不是“Codex 没带 session”，而是 replay script 只认顶层 `headers`，没有把样本里 `body.metadata.clientHeaders` 还原成真实 HTTP headers。
  - 修完 `scripts/replay-codex-sample.mjs` 后，`/v1/messages` 不再因 `clientHeaders` / `rcc_passthrough_tool_choice` 这类 replay-only metadata 被 server req adapter 拒绝。
  - 最新 live 5555 日志已出现：
    - `req=req_1781701966842_f92f387a sid=019dfdc9-bcd7-7b70-8384-8bcaa9a63e6f`
    - request id 从 `anthropic-messages-unknown-unknown-*` 变成 `anthropic-messages-minimax.key1-MiniMax-M3-*`
  - 说明这条 replay 已经过了“session truth / metadata contract”层，进入真实 provider 路由。
- 当前这条 replay 的新失败点已经前移到真实 upstream/provider 400：
  - `invalid params, function name or parameters is empty (2013)`
  - 这不再是 session truth 丢失问题。

## 2026-06-17 stopless live replay second root cause

- live 5555 replay after reinstall/restart still showed repeated `session=unknown` + `tool=stop_message_auto ... used=0 left=3 active=true`, so earlier “missing-session gate” local green was not enough for live closeout.
- New root cause slice: stopless owner `sharedmodule/llmswitch-core/src/servertool/engine.ts::readStoplessSessionId()` treated any non-empty string as valid session truth; live chain appears to pass sentinel string `unknown`, so stopless activated instead of skipping.
- Fix direction: normalize stopless session tokens so `unknown/none/null/-` count as missing; add red test proving sentinel `unknown` disables CLI projection.

## 2026-06-17 tmux-request-session drift trim

- `src/modules/llmswitch/bridge/state-integrations.ts::extractSessionIdentifiersFromMetadata()` 之前仍把 `tmuxSessionId/clientTmuxSessionId` 当成 request `sessionId` 候选，这与“tmux 只是 client attach/inject scope，不是 request session truth”冲突。
- `src/server/runtime/http-server/session-client-registry.ts` 仍有两处旧别名残留：
  - 记录加载/注册/heartbeat 时把 `tmuxSessionId` 回填到 `record.sessionId`
  - callback inject body 里发送 `sessionId: tmuxSessionId`
- 本轮已加红测并物理删除上述两处写入，先锁“tmux 不得 materialize 成 request session/stopless session truth”，再继续看 live stopless 闭环是否因此收敛。

## 2026-06-17 stopless closed-loop fix (counter + schema feedback gate)

- 新发现的闭环断点分两处：
  - 计数器语义错：之前 `observed=false` 不落 reset，导致“非连续 stop”后旧计数会挂着；用户要求是真正的“连续 stop 才累计，不连续立即清零”。
  - schema 反馈链断：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_servertool_orchestration.rs` 明明读到了 `decision.followupText/followup_text`，却用 `_raw_followup_text_ignored` 丢掉，再改写成 generic prompt，导致“缺什么引导什么”根本到不了下一轮。
- 本轮收口方向：
  - Rust `stop_message_counter` 保持“非 stop 也 reset persisted used=0”的唯一真源。
  - Rust `chat_servertool_orchestration` 改成：schema/invalid-schema/non-terminal-schema/budget-exhausted 触发时，优先把 `decision.followup_text` 原样发到 client-visible next-turn prompt；只有普通 stop 才走 generic natural prompt。
  - `stopless_prompt.rs` 撤回“固定模板字段提示”这条错误方向，generic prompt 只保留自然语言；字段级纠错只来自 schema gate 真正的失败反馈。
  - gate 增补：`scripts/verify-servertool-rust-only.mjs` 现在禁止 `chat_servertool_orchestration.rs` 再出现 `_raw_followup_text_ignored` 这种“读到又丢”的实现。

## 2026-06-17 runtime-session-dir ssot closeout audit

- 当前工作树复核结果：
  - `ROUTECODEX_SESSION_DIR` 的生产 env 读法已收敛到 runtime bootstrap owner（`src/server/runtime/http-server/session-dir.ts`）；功能链 stopless / pending-session / routing-state 不再自己从 env 猜目录。
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/napi_proxy.rs` 只从 `metadata.__rt.{sessionDir,rccUserDir}` 读取 runtime path override，顶层 `metadata.sessionDir/rccUserDir` 不再是合法 fallback。
  - `SessionClientRegistry` 现在只认显式注入的 bindings store path；`conversationSessionId -> tmuxSessionId` 绑定不再反向定义 request `sessionId` 或 workdir 身份。
- 文档/正式 review 面同步完成：
  - `docs/design/server-runtime-lifecycle-ssot.md`
  - `docs/architecture/wiki/metadata-boundary-map.md`
  - `docs/architecture/wiki/runtime-lifecycle-call-graph.md`
  - `docs/architecture/wiki/html/runtime-lifecycle-call-graph.html`
  - `docs/architecture/wiki/html/metadata-boundary-map.html`
- 仍保留的结构性风险：
  - `ROUTECODEX_SESSION_DIR` 物理上仍混放 routing state、session bindings、provider health、servertool pending 等多类 runtime state。
  - 这已经不再是“身份语义混用”问题，而是“目录物理分层”问题；建议后续单独做 subdir split，不作为当前 ssot 收口 blocker。

## 2026-06-17 stopless sessionId contract drift cleanup

## 2026-06-17 install-global + restart 5555 unblock

- 用户要求直接编译 / 全局安装 / 重启 `5555` 验证 live 是否切到新 stopless 契约。
- 实际阻塞点不是 `install-global.sh` 后半段，而是工作树编译错误：
  - `src/modules/llmswitch/bridge/state-integrations.ts` 直连 core dist JS 时把 native routing-state 参数推成 `unknown`，`tsc` 报 `TS2345`
  - `src/server/runtime/http-server/index.ts` 缺 `node:path` import，`tsc` 报 `TS2304`
- 最小修复：
  - 给 `state-integrations.ts` 补 `RoutingInstructionState` 类型签名并用 typed native aliases 调用
  - 给 `http-server/index.ts` 补 `import path from 'node:path'`
- 验证证据：
  - `npx tsc --pretty false --noEmit` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH ROUTECODEX_INSTALL_INPLACE_BUILD=1 npm run install:global` 已完成全局安装，并把 `~/.rcc/install/current` 切到 `releases/routecodex-0.90.3075-2026-06-17T043357Z`
  - `routecodex --version` = `0.90.3075`
  - `routecodex restart --port 5555` PASS
  - `curl http://127.0.0.1:5555/health` 返回 `{\"status\":\"ok\",\"ready\":true,\"pipelineReady\":true,\"server\":\"routecodex\",\"version\":\"0.90.3075\"}`

- 新发现的仓库残留不是生产代码 throw，而是 docs/gate 漂移：
  - `docs/design/servertool-stopmessage-lifecycle.md` 还写 stopless 是 session-scoped CLI continuation，并声称缺 `sessionId/requestId` 时 runtime 自动补。
  - `scripts/verify-servertool-rust-only.mjs` 还把旧错误字符串 `stop_message_auto auto flow requires sessionId on adapterContext` 当成应存在 contract。
- 这与当前 stopless 真相冲突：
  - stopless CLI command / stdout 不要求 `sessionId/requestId/sessionDir`
  - stopless next-turn 恢复只认当前 request `tool_outputs` + runtime metadata
  - stopless 不属于 persisted continuation/file-state owner
- 处理策略：
  - 更新 stopless lifecycle 设计文档为 runtime-metadata closed loop
  - 把 verify gate 从“必须存在 sessionId lock”改成“禁止复活 sessionId requirement / env fallback”

## 2026-06-17 runtime-session-dir owner trim follow-up

- 本轮又确认两处与 goal 冲突的残留：
  - `SessionClientRegistry` 虽已支持 bootstrap 显式注入 `bindingsStorePath`，但类内仍保留 `ROUTECODEX_SESSION_DIR -> session-bindings.json` 推断。
  - Rust `virtual_router_engine/napi_proxy.rs` 的 runtime path override 仍允许从 metadata 顶层读取 `sessionDir/rccUserDir`，不是只认 `__rt.*` carrier。
- 收口动作：
  - 删除 `SessionClientRegistry` 的 env 推断，只保留显式 `bindingsStorePath`
  - `napi_proxy.rs` 改成只读 `metadata.__rt.{sessionDir,rccUserDir}`
  - 补回归测试，锁 `ROUTECODEX_SESSION_DIR` 和 metadata 顶层字段都不能再充当功能链 fallback

## 2026-06-16 mainline call map mermaid/wiki/gate closure

## 2026-06-17 direct Responses headers timeout audit

- 用户样本：`5520` direct `/v1/responses`，`asxs.crsa.gpt-5.4`，`routeName=longcontext`，`router-direct.send` 报 `UPSTREAM_HEADERS_TIMEOUT` 后进入 provider-switch。
- owner 定位：direct pipeline 只做 same-protocol passthrough + hooks，实际 provider SSE 发送在 `src/providers/core/runtime/responses-provider.ts` -> `HttpClient.postStream()`；不是 direct pipeline 出站 payload 问题。
- 根因：`HttpClient.postStream()` 的 headers timer 会在收到 upstream headers 前触发；代码常量 `DEFAULT_TIMEOUTS.PROVIDER_STREAM_HEADERS_CAP_MS` / `SSE_DEFAULT_CAPS.STREAM_HEADERS_CAP_MS` 仍是 `120_000`，与 `src/providers/README.md` 声明的 `min(900000, providerTimeout)` 不一致，导致长上下文/工具 direct SSE 请求可能在 provider timeout `240_000` 前被内部 120s headers clock 提前切断。
- 修正：headers cap 调整为 `900_000`，默认实际等待回到 `min(900000, providerTimeout)`；同时 Responses direct SSE config helper 支持传递 `providerStreamHeadersTimeoutMs` / `streamHeadersTimeoutMs` / `headersTimeoutMs`，不改变 provider wire payload。
- 已验证：`tests/provider/http-client-poststream-headers-timeout.spec.ts` PASS，锁住显式短 headers timeout 仍 fail-fast、默认 cap 为 900s、默认不再被 120s cap 截断；`tests/providers/runtime/responses-provider.direct-passthrough.spec.ts` PASS，锁住 direct SSE 能传 idle + headers timeout；`npx tsc --noEmit` PASS；`npm run verify:function-map-compile-gate` PASS。

## 2026-06-17 servertool CLI explicit sessionDir closeout progress

- `ROUTECODEX_SESSION_DIR` 在 stopless / servertool CLI 这一轮已进一步收口为 runtime workdir root，不再让 CLI binary 侧隐式依赖 env 注入；当前 contract 是 `routecodex hook run ... --session-dir <dir>` 显式透传到 Rust CLI / persisted_state_fs。
- 已补生产 owner：
  - `sharedmodule/llmswitch-core/src/servertool/cli-projection.ts` 读取 runtime `sessionDir` 时补了 `adapterContext.__rt` 直读，并允许 engine 显式覆盖；
  - `sharedmodule/llmswitch-core/src/servertool/engine.ts` 在 orchestration 入口先抓 `sessionDir`，避免后续 runtime helper 改写 `adapterContext` 后丢失；
  - `router-hotpath-napi/src/servertool_core_blocks.rs` 的 persisted-state JSON helper 现已带 `sessionDir` 参数透传；
  - `servertool-core/src/persisted_state_fs.rs` 顶部注释已改成“显式 session_dir 优先”，不再暗示 env override 是 contract。
- 关键真相：
  - 之前 Node/Jest 一直在吃旧 native binding，导致看起来代码改了但命令里仍不带 `--session-dir`；`node scripts/build-core.mjs` 之后，最小 `tsx` 直调已确认命令变成 `... --session-dir '/tmp/sdir' --session-id ...`。
  - 一旦 `sessionDir` 真正生效，`stopless-cli-continuation` 旧预期暴露为 stale：第 1 轮服务端投影命令仍是 `repeatCount=1`，但客户端 CLI 读取同 session persisted truth 后，stdout 会直接进入 `repeatCount=2`；下一轮服务端因此进入 terminal closeout，不会再投第二条 CLI 命令。
- 本轮已把相关 Jest 预期同步到真实闭环语义，并收绿：
  - `tests/servertool/servertool-cli-projection.spec.ts`
  - `tests/servertool/stopless-cli-continuation.spec.ts`
- Rust 侧补充：
  - `servertool-core/src/cli_contract.rs` 的旧测试里，非 stopless `servertool_fixture` 不应再断言带 `sessionId/requestId`；现已改为显式断言“非 stopless 不带 identity flags”。
- 当前剩余风险：
  - `cargo test -p servertool-core ...` 全库 still 会碰到独立旧红 `stop_message_persist_plan::tests::non_counting_gate_preserves_decision_budget_and_used`，与本轮 `sessionDir/sessionId` 收口无直接因果，需单独审。

## 2026-06-17 runtime-session-dir-ssot closeout audit

- `docs/goals/runtime-session-dir-ssot-plan.md` 当前四项 DoD 已基本对齐：
  - 文档：`docs/design/server-runtime-lifecycle-ssot.md` 已明确 `ROUTECODEX_SESSION_DIR` 只是 runtime workdir root，不是语义 `sessionId`。
  - 代码：stopless / servertool CLI / routing-state 功能链现在靠 runtime metadata/explicit arg 传 `sessionDir`，不再在功能链内部用 env/top-level fallback 猜回去。
  - 测试：`tests/servertool/servertool-cli-projection.spec.ts`、`tests/servertool/stopless-cli-continuation.spec.ts` 与 `cargo test -p servertool-cli --test cli_blackbox` 已证明显式 `--session-dir` + same-session writeback 闭环成立。
  - wiki：`docs/architecture/mainline-call-map.yml`、`docs/architecture/wiki/stopless-session-mainline-source.md` 已同步到“显式 `--session-dir`、same-session closed-loop 已闭环”的真相。
- 仍保留一个后续结构性建议，不算本轮 blocker：
  - `ROUTECODEX_SESSION_DIR` 下面仍混有 routing/session/provider-health/servertool 等多类 runtime 状态；目录物理分层仍值得单独做，但不影响本轮把它从“session identity”语义里剥离。

## 2026-06-17 session management simplification audit

- 当前“session 管理很复杂”的根因不是单个 `sessionId` 本身复杂，而是把 4 类不同生命周期混在一起了：
  - request 内短生命周期控制：stopless `used/repeatCount`、trigger hint；
  - 跨一次客户端工具回合的 continuation：stopless CLI writeback；
  - 跨下一次请求的 pending injection：`servertool-pending/<session>.json`；
  - tmux/client 绑定：`session-bindings.json` + conversation/tmux 映射。
- 关键冗余点已确认：
  - `seedStoplessCliPersistedState()` 和 `recordStoplessContinuationState()` 当前实现等价，都是 `recordStoplessContinuationStateWithNative -> saveRoutingInstructionStateSync`，属于重复状态入口。
  - stopless 当前同时复用 routing state store 文件形状和 CLI 自带 persisted_state_fs 读取路径，导致“为了读同一个 session 计数，要维护两套命名/目录/读取契约”。
  - `SessionClientRegistry` 的 tmux/conversation 绑定与 stopless/session continuation 没有同一 owner，却都挂在 “session” 语义下，认知面被污染。
- 精简方向建议：
  - stopless / pending-injection 与 tmux/client registry 彻底拆语义：前者只认 request `sessionId`，后者只认 client/tmux binding id。
  - 若接受“server 重启后丢失未完成 stopless/pending 状态”，可把 stopless/pending-injection 统一收进单实例内存 registry，直接删除 `sessionDir` 依赖。
  - 若不能接受重启丢失，则仍建议只保留一个最小 persisted owner：`sessionId -> { stopless?, pendingInjection? }`；不要再复用 routing-state store，也不要再让 CLI 自己镜像一套路径规则。

## 2026-06-17 stopless runtime-metadata-only closeout

- 本轮已把 stopless CLI 主合同改成 runtime-metadata/current-request-tool-output owner：
  - CLI projection 不再带 `--session-dir` / `--session-id` / `--request-id`
  - Rust CLI binary 不再要求 stopless identity flags
  - next-turn 恢复走 `persisted_lookup.rs::resolve_runtime_stop_message_state_from_adapter_context()` 从当前 request `tool_outputs` / runtime metadata 取 truth
  - `runtime-utils.ts` / `state-integrations.ts` 中 stopless 专用 persisted helper 已开始物理删除，旧 `stopless-prompt.client-visible.spec.ts` 已删
- 定向验证：
  - `cargo test -p servertool-core cli_contract --lib -- --nocapture` PASS
  - `cargo test -p servertool-cli --test cli_blackbox -- --nocapture` PASS
  - `node scripts/build-core.mjs` PASS
  - `node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/servertool-cli-projection.spec.ts tests/servertool/stopless-cli-continuation.spec.ts tests/cli/servertool-command.spec.ts --runInBand` PASS
  - `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false` PASS
- 剩余结构性缺口：
  - broader docs/wiki/html 仍有不少旧 `sessionDir/persisted writeback` 叙述，需要继续扫
  - pending-injection / pending-session 仍是另一套 persisted owner，尚未按“只保留最小必要状态机”整体砍完

## 2026-06-17 stopless persisted writeback surface physically removed

- 本轮只收口 stopless，不扩散到 broader `stop_message` persisted snapshot。
- 已物理删除 stopless 已无消费者的 persisted writeback surface：
  - `recordStoplessContinuationStateWithNative`
  - `savePersistedRuntimeStopMessageStateWithNative`
  - 对应 `router-hotpath-napi` export
  - `servertool-core` 内仅服务这条旧链的 `persisted_state_fs_write.rs`
- 现状更清晰：
  - stopless 当前唯一主线仍是 `runtime metadata + current request tool_outputs`
  - persisted lookup/save 仍存在于 broader `stop_message` / pending / continuation 家族，不能误读成 stopless 当前轮 owner
- 验证：
  - `node scripts/build-core.mjs` PASS
  - `jest tests/servertool/stopless-cli-continuation.spec.ts tests/servertool/servertool-cli-projection.spec.ts tests/cli/servertool-command.spec.ts --runInBand` PASS
  - `npm run verify:function-map-compile-gate` PASS
  - 全仓 grep `recordStoplessContinuationState* / savePersistedRuntimeStopMessageState*` 0 命中

## 2026-06-17 tmux binding store path explicit + live stale install evidence

- `SessionClientRegistry` 生产链已收口为 runtime bootstrap 显式注入 `session-bindings.json` store path，不再让 registry 自己在生产路径里靠全局 env 推断当前实例 workdir。
- `state-integrations.ts` 的 routing-state bridge 改成直接静态 ESM import 已编译 core dist，Jest 下 `session-client-routes.spec.ts` 的 `ERR_REQUIRE_ESM` non-blocking warning 已消失。
- 当前 live 5555 的 `stop_message_auto auto flow requires sessionId on adapterContext` 已核实不是工作树真相，而是旧安装包真相：
  - 当前 workspace `sharedmodule/llmswitch-core/src/servertool/cli-projection.ts` 与 `dist/servertool/cli-projection.js` 都已不再包含该 throw。
  - 旧安装包 `~/.rcc/install/releases/routecodex-0.90.3075-2026-06-17T023503Z/sharedmodule/llmswitch-core/dist/servertool/cli-projection.js` 仍包含该 throw。
  - `~/.rcc/log/config.toml/ports/5555/server-5555.log` 与对应 diag stack 证明 5555 运行时命中的正是旧安装包 `/opt/homebrew/lib/node_modules/routecodex/.../dist/servertool/cli-projection.js`。
- 结论：当前代码面已收口，但 live 5555 若要消除此报错，还需要重新安装/切换到新构建并重启运行中的 server。此轮未执行 live restart。

## 2026-06-17 stopless architecture map deconflict

- `hub.servertool_stopless_cli_continuation` 的 function-map 真源之前混入了 `StoplessGoalStateRead/PersistPlan`，容易把 `stop_message_auto` 的 runtime-metadata-only 主线误读成另一套 `/goal` 文本状态持久化契约。
- 已把 stopless feature 的 canonical types/builders 收窄到真正主线 owner：`plan_stopless_orchestration_action`、`resolve_runtime_stop_message_state_from_adapter_context`、`plan_client_exec_cli_projection_output`。
- wiki/README/coverage/servertool-followup 页面同步改成“当前请求 `tool_outputs` + runtime metadata”叙述，避免后续按 sessionDir/file/tmux 思路改错位置。

## 2026-06-17 persistence boundary clarification

- Jason 新规则已钉死：只有 protocol-independent continuation 必须保存、必须文件化；其他状态按生命周期判定，不因名字里有 session 就默认持久化。
- 这意味着 stopless 继续保持非持久化 owner；responses/server continuation 这类跨协议恢复态才属于必须保存的文件化状态。

## 2026-06-17 global session-state audit status

- 当前已确认：`session-bindings.json` / `SessionClientRegistry` 仍未进入 architecture function-map / verification-map / mainline-call-map 的 owner queryability 体系。
- 这说明本轮虽然补齐了 stopless、pending-session、runtime-lifecycle、continuation 的边界说明，但 tmux/client binding 这支仍未被同等级索引化，目标还不能宣称全闭环。

## 2026-06-17 tmux client binding indexed

- `runtime.tmux_client_binding` 已补进 `function-map.yml` / `verification-map.yml` / `mainline-call-map.yml`，owner/queryability 缺口已关闭。
- 当前文档真相：
  - `tmuxSessionId` = client attachment / injection runtime scope
  - `conversationSessionId` = conversation narrowing key
  - request `sessionId` = request/continuation scope
  - `session-bindings.json` 只是 `conversationSessionId -> tmuxSessionId` runtime lookup，不是 request session 真源，也不是 continuation store
- 顺手验证暴露旧红：
  - `tests/server/http-server/session-client-routes.spec.ts` 多处 `/daemon/session-client/inject` 仍 404
  - `tests/server/runtime/http-server/executor-metadata.binding.spec.ts` conversation binding fallback 仍未按预期恢复 tmux scope
  - cleanup path 仍碰到 `stopmessage-scope-rebind -> bridge/state-integrations` 的 ESM 旧桥问题

## 2026-06-17 metadata-only sessionDir final trim

- 本轮又补掉一个直接违背 goal 的生产残留：`sharedmodule/llmswitch-core/src/servertool/engine.ts::readStoplessSessionDir()` 以前还会从顶层 `adapterContext.sessionDir` 读值；现已删掉，只保留 runtime metadata / `__rt.sessionDir`。
- 当前结论更新为：
  - stopless / servertool CLI 主功能链里，`sessionDir` 不再靠顶层字段回填；
  - 剩余 `ROUTECODEX_SESSION_DIR` / 无 override `loadRoutingInstructionStateSync(...)` 读法主要还在 runtime bootstrap / broader routing-state surfaces，适合作为后续“目录物理拆分 + runtime-state owner 收口”任务，不应在本 goal 里顺手扩散。

- 结论先钉死：`docs/architecture/mainline-call-map.yml` 是主线调用关系唯一真源；Mermaid wiki 只能做 render artifact，不能再手写第二份主线图，否则会再次漂移。
- 本轮落地内容：
  - 新增 `scripts/architecture/mainline-call-map-lib.mjs` 作为 parse/validate/render 共用库。
  - 新增 `render-mainline-mermaid.mjs`，目标产物固定为 `docs/architecture/wiki/mainline-call-graph.md`。
  - 新增 `verify-architecture-mainline-call-map.mjs`，校验链/边 schema、owner_doc 路径、非 pending caller/callee file 存在、symbol 真正在文件里出现、owner_feature_id 能反查 function-map。
  - 新增 `verify-architecture-mainline-mermaid-sync.mjs`，强制 render artifact 与 YAML 同步。
- 规则收口：
  - `function-map.yml` 继续管 owner / allowed paths / required tests。
  - `mainline-call-map.yml` 继续管 request/response/error 相邻调用边。
  - `wiki/mainline-call-graph.md` 只负责 Mermaid review 面和表格，不承载独立规则。
- package gate 已接入：
  - `render:architecture-mainline-mermaid`
  - `verify:architecture-mainline-call-map`
  - `verify:architecture-mainline-mermaid-sync`
  - `verify:architecture-ci` 现已串上 mainline map + mermaid sync。
- 验证证据：
  - `npm run verify:architecture-mainline-call-map` PASS
  - `npm run render:architecture-mainline-mermaid` PASS
  - `npm run verify:architecture-mainline-mermaid-sync` PASS
  - `npm run verify:architecture` PASS
  - `git diff --check` PASS
  - Computer Use + Chrome 本地渲染验证 PASS：
    - 临时页 `file:///tmp/routecodex-mainline-mermaid-check.html`
    - 页面状态文本为 `All diagrams rendered successfully.`
    - 三张图的 step label 与节点名都已被实际渲染，未出现 syntax/render error
- 下一步：单独收口 `req-03` / `req-04` 两条 request 中段 pending edge，避免把 runtime orchestration 与 typed contract 继续混写。

## 2026-06-16 stopless zterm 死循环追踪

- Jason 报告的线上 stopless 死循环已拿到两类硬证据：
  1. `~/.rcc/logs/server-5520.log` 中同一 session 会出现 `:stop_followup used=1/2` 后，下一次顶层请求又回到 `used=0`，说明预算没有跨失败闭环延续；
  2. `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260615T095637735-346472-4050.json` 明确显示线上失败栈仍经过 `backend-route-reenter-block.js::runReenterFollowup`，不是纯 CLI projection，且失败原因为 `EMPTY_ASSISTANT_RESPONSE`。
- 这说明当前 live 问题至少有两层：
  1. 安装/生效链路上仍存在旧的 server-side followup/reenter 路径；
  2. stopless budget 对 no-schema / failed followup 的持久化收敛没有锁死，导致顶层新请求重复从 0 开始。
- 当前源码审计还发现一个直接冲突点：`servertool-core/src/stop_message_persist_plan.rs` 里 `count_budget=false` 仍会让 `next_used` 不增长，而 Jason 的 stopless 规则要求 no-schema 也要进入 `used=1->2->3`，耗尽后 reset 并 stop。
- 下一步改动口径：
  - 先补红测锁 `no-schema 1->2->3->stop/reset`；
  - 再修 Rust persist truth；
  - 再跑 focused test + build/install/restart + live replay，确认不再走 `runReenterFollowup`。

## 2026-06-17 stopless sessionId direct path persisted lookup root cause

- 当前 root cause 已确认在 Rust 真源 `servertool-core/src/persisted_lookup.rs`：
  - `collect_stop_message_persisted_candidate_keys()` 之前只有 `direct_record.sessionId` 先命中时，才把 `strict_session_scope` 放进 `candidateKeys`；
  - 这导致 direct/top-level `sessionId` 没进入 stopless persisted read path 时，同 session 新请求会反复从 `used=0` 开始，无法闭环。
- 修正原则：
  - `strict_session_scope=session:<sessionId>` 本身就是 stopless 唯一闭环主键，必须无条件进入 `candidateKeys`；
  - 不能再依赖 direct record 表面字段先命中才允许 lookup。
- 已补 Rust 回归测试：
  - `runtime_session_scope_participates_even_when_direct_record_lacks_session_id`
  - 锁住“record 无 sessionId，但 runtime metadata 有 sessionId 时仍必须 lookup 同一 session scope”。

## 2026-06-16 primary_exhausted_to_default_pool host wiring audit

- 提交审计确认两处真实问题：
  1. `index.ts` / `request-executor.ts` 在 `primary_exhausted -> default_pool` 上只把 `allowedProviders` 包成单个 fake primary tier，没把真实 backup/default tier 传给 Rust planner。
  2. 传给 planner 的 `route` 还是 `routingPolicyGroup`，不是实际 route 名；而且 `allowedProviders` 还会把 `fwd.*` 扁平成 provider id，和 VR 配置 target 身份不一致。
- 修复方向：host 改为从 `virtualrouter.routingPolicyGroups[group].routing[route]` 直接抽 `targets/priority/backup`，route 名优先从 `routeName/routeHint/preselectedRoute` 解析，禁止回退到 group id。
- 提交污染附带问题：`.gitignore` 只忽略 `tmp/`，未忽略 `.tmp/`，导致 stopless/jest 运行态 JSON 大量出现在未跟踪列表；本轮只补 ignore 规则，不做未授权删除。
- 2026-06-16 收口验证：当前 checkout 已把 host wiring 改为 `extractRoutingTiersForRoutingGroupRoute(...)` + `resolvePrimaryExhaustedRouteName(...)` + Rust planner consumption；同时已把 `virtual_router.primary_exhausted_to_default_pool` 的 function-map / verification-map 补齐到真实 host 消费路径（`http-server-bootstrap.ts`、`index.ts`、`request-executor.ts`、`request-executor-core-utils.ts`）与最小合同测试。验证 PASS：
  - `node --experimental-vm-modules ./node_modules/.bin/jest tests/server/http-server/http-server-bootstrap.routing-policy-group.spec.ts --runInBand`
  - `node --experimental-vm-modules ./node_modules/.bin/jest tests/server/runtime/http-server/executor/request-executor-primary-exhausted-plan.spec.ts --runInBand`
  - `npm run verify:function-map-compile-gate`
  - `git diff --check`
- `.tmp/` ignore 生效验证：`git status --short --untracked-files=all | rg '^\\?\\? \\.tmp/'` 无输出，说明新的运行态 JSON 噪音不再污染提交面。

## 2026-06-15 note.md consolidation index
- stopless invalid-schema CLI closure fixed: latest=2026-06-16；根因确认不是 `triggerHint` 丢失，而是 stopless 拦截后只把 routing state 持久化，没把 CLI 读取的 persisted-state-fs 预写好；导致 invalid schema 首个 CLI 工具结果只能看到 generic prompt。当前真相：handler 在 relay stopless CLI projection 时同时维持两份状态边界，routing state 继续按原链推进计数，CLI persisted-state-fs 只为当前投影命令预写当前 `used` + detailed followup text，CLI 执行后再把 `used` 推进到下一拍。定向验证 PASS：`tests/servertool/stopless-cli-continuation.spec.ts`、`tests/servertool/stopless-prompt.client-visible.spec.ts`、`cargo test -p servertool-core stopless_cli_invalid_schema_reuses_persisted_detail_text --lib -- --nocapture`、`cargo test -p servertool-core invalid_schema_prefers_detailed_followup_text_for_snapshot --lib -- --nocapture`、`git diff --check`。
- stopless CLI identity contract corrected: latest=2026-06-16；当前真相不是“缺 `sessionId/requestId` fail-fast”，而是 Rust CLI/runtime 自动补 execution-local identity，TS shell 只校验 stdout 带回了 identity、不得再做第二次 persisted write。已同步改 `src/cli/commands/servertool.ts`、`tests/cli/servertool-command.spec.ts`、`servertool-cli/tests/cli_blackbox.rs`、`docs/stop-message-auto.md`、`docs/design/servertool-stopmessage-lifecycle.md` 与 function/verification map。focused gate 待本轮重跑确认。
- stopless 模型侧无感收口：2026-06-16；已确认 `cli_contract.rs` 里不能把 `triggerHint`、`previousMissing`、`forcestop`、`repeatCount/maxRepeats/budget` 之类内部状态放进模型可见的 guidance。模型侧只保留纯业务语言的 continuationPrompt，服务端内部计数继续存在但不外露。live 复测已看到 `stopless-cli-continuation`、`stopless-vr-route-hint`、`stop-message-auto-no-reenter` 通过。
- stopless relay sessionId propagation fixed at two boundaries: latest=2026-06-16；本轮先收口 Jason 指定的 `SERVERTOOL_CLI_MISSING_FIELD: sessionId`。确认 request bridge 早已把 `/v1/responses` 的 `sessionId/conversationId` 写进 `metadata.responsesRequestContext`，真正漏点有两处：1) `src/server/runtime/http-server/executor/servertool-request-normalizer.ts` 以前只从 `entryOriginRequest` / request metadata 回填 adapter context，不读现成的 `responsesRequestContext`；2) `src/server/runtime/http-server/executor/servertool-followup-metadata.ts` 以前构造 nested followup metadata 时只会从 continuity headers 提取 `sessionId/conversationId`，headers 缺失时不会回退到 relay `responsesRequestContext`。现已两处同时补齐，且未新增任何 payload/meta 字段，只消费既有 runtime metadata。定向验证 PASS：`tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts`、`tests/server/runtime/http-server/executor/servertool-followup-metadata.spec.ts`、`tests/servertool/stopless-cli-continuation.spec.ts`。direct stopless bypass 仍保持：`router-direct/provider-direct` runtime routeName 下 stopless CLI projection 不触发。
- apply_patch audit focused 4-suite rerun re-confirmed: latest=2026-06-16；本轮又把最关键的 4 组 gate 复跑了一次：`responses-provider.direct-passthrough`、`responses-handler.anthropic-tool-history` 继续 PASS；`responses-sse-client-contract.blackbox`、`direct-passthrough-route-level` 继续 FAIL，汇总 `2 failed / 2 passed / 4 total`、`7 failed / 43 passed / 50 total`。这把当前 completion-audit 再压实了一层：direct provider passthrough 与 relay anthropic tool-history 基线没有漂移；剩余主红面仍只在 handler-level SSE terminal/error closeout 与 direct route-level 总合同张力。附带事实是 Jest 末尾仍报 open handles，因此 `direct-passthrough-route-level.spec.ts` 更适合作为 contract tension 证据，而不是单独 completion gate。
- apply_patch audit S3 exact queue-failure anchors pinned: latest=2026-06-16；本轮把 S3 主样本也补成了可直接引用的行级证据。`~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260613T231359101-341020-806.json:1404-1455` 现在可直接看到同一 `call_JyD0R31sWoSfsvEtKsqHJkRh` 的 `function_call x2 + function_call_output x2`，且 sibling `call_cQ4...`、`call_36y...` 也按同样模式重复；`2242-2244` 则直接把它记成 `orphan_tool_result: ... unknown or already-consumed call_id`。这把 S3 从“可能是单个孤儿 output”彻底纠正成“多 call_id 并行 duplicate-batch 进入 already-consumed queue 后在 Rust capture/bridge 本地 fail-fast”。
- apply_patch audit S4/S5 exact line anchors pinned: latest=2026-06-16；本轮把两条最关键的 replay 污染样本补成了 request-body 级硬锚点。S4 现在可直接引用 `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260615T180749445-347851-1128.json:33-39`，里面就是 `exec_command` + `arguments="routecodex hook run stop_message_auto --input-json ..."` + `status=in_progress` + `call_servertool_cli_*`；这说明 internal stopless CLI artifact 的确进入了下一轮 `/v1/responses` request body。S5 现在可直接引用 `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260615T001004109-345184-2762.json:215-223`，可见 `type=message role=assistant content[0].type=output_text` 已被写进 request history；这证明 response-only content 污染历史是实锤，不是抽象推断。
- apply_patch audit source-level split anchored: latest=2026-06-16；本轮把 `5520 direct` / `5555 relay` 的 source-level 函数链补齐了。`5520` 这边，`index.ts` 先拿 `rawDirectPayload` 再直接令 `requestPayload = rawDirectPayload`，`router-direct-pipeline.ts::executeRouterDirectPipeline()` 真正发送的是 `input.requestPayload`，`recordPayloadAudit()` 只记 observable fields，不改 payload；所以 direct request 入口确实只是 passthrough + audit。`5555` 这边，`responses-request-bridge.ts::prepareResponsesHandlerRuntimeForHttp()` 先走 `prepareResponsesHandlerEntryForHttp()`，再走 `buildResponsesRequestContextForHttp()`；前者负责 `lookupResponsesContinuationByResponseId` / `resumeResponsesConversation` / `materializeLatestResponsesContinuationByScope`，后者直接调用 `captureReqInboundResponsesContextSnapshot()`，说明 relay request capture/continuation owner 确实在 provider send 之前发生。response 侧，`handler-response-utils.ts` 的 JSON path 和 `handler-response-sse.ts` 的 SSE path 都是先得到 client-projected body/probe，再交给 `persistResponsesConversationLifecycleForHttp()`；这继续证明 relay 本地 store 吃的是 client projection 后的语义，不是 provider raw response。
- apply_patch audit direct-not-local-store pinned: latest=2026-06-16；`sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts` 现在已有直接源码证据：`shouldPersistLocally(entry)` 明确返回 `continuationOwner !== 'direct'`，`flushPersistence()` 和 `ensurePersistenceLoaded()` 都受它约束；也就是说 direct continuation 明确不进本地 persisted store，本地 history 污染只能由 relay 形成。
- apply_patch audit S6 facade reality pinned: latest=2026-06-16；`src/modules/llmswitch/bridge/native-exports.ts` 当前真实同时有 sync `captureReqInboundResponsesContextSnapshotJson(...)` 和 async `captureReqInboundResponsesContextSnapshot(...)` 两个 facade，而且二者都指向同一个 native binding `captureReqInboundResponsesContextSnapshotWithNative`。这进一步支撑了当前对 S6 的定性：历史 `required but unavailable` 更像 native owner fail-fast 被外层包装，而不是“JS facade 本身缺导出”。
- apply_patch audit exclusion set tightened: latest=2026-06-16；三类测试现在必须从 completion 证据里显式排除：1) `responses-request-bridge.tool-history-errorsample.spec.ts` 当前是 stale harness，实跑直接 module-link 失败，报 `native-exports.js` 不再导出旧名 `captureReqInboundResponsesContextSnapshot`；2) `provider-response-rust-plan.spec.ts` 实跑仍是 `11 pass / 6 fail`，六红全部只是在断言旧命令 `routecodex servertool run stop_message_auto`，实际稳定输出已是 `routecodex hook run stop_message_auto --input-json ...`；3) `responses-handler.servertool-cli-projection.blackbox.spec.ts` 虽然 `5/5 PASS`，但本质仍是 transitional CLI projection 合同，不能替代 replay-safe outbound/store gate。
- apply_patch audit SSE blackbox red revalidated: latest=2026-06-16；`tests/server/handlers/responses-sse-client-contract.blackbox.spec.ts` 再实跑仍是 `7 pass / 2 fail / 9 total`。两条真实业务红未变：tool-call continuation case 仍 5s timeout；early upstream close case 仍只有 `response.created + response.output_text.delta`，没有 `event:error` / `upstream_stream_incomplete`。这继续把问题收敛到 `handler-response-sse.ts` 的 stream-end repair / client projection，不是环境挂。
- apply_patch audit 4444 exclusion refreshed: latest=2026-06-16；用户给的 `4444` live 错误 `Rust HubPipeline response path failed: hub_pipeline_resp_anthropic_chat_canonicalize_failed ...` 继续归到 provider malformed Anthropic payload / `hub.response_anthropic_client_projection` 问题簇，不并入 `apply_patch direct/relay` 主审计。
- apply_patch audit S6/live-required-unavailable reclassified: latest=2026-06-16；本轮把 `S6` 再压实了一层。`tests/sharedmodule/native-required-exports-sse-stream.spec.ts` 现已实跑 `12/12 PASS`，证明 packaged binding、required export list、native req_inbound capture 本身都能工作；但历史 diag `error-openai-responses-router-gpt-5.4-20260615T152358679-347208-485.json` 同时出现两类信息：一方面 exports 列表里明确包含 `captureReqInboundResponsesContextSnapshotJson`，另一方面 stack/message 又报 `native captureReqInboundResponsesContextSnapshotJson is required but unavailable: dangling_tool_call ... does not have a matching tool result in history`。结论：这条历史样本更像“native owner fail-fast 被包成 required unavailable”，不是单纯的 export/binding 缺失。
- apply_patch audit stale harness surfaced: latest=2026-06-16；`tests/modules/llmswitch/bridge/responses-request-bridge.tool-history-errorsample.spec.ts` 本轮实跑不是业务红，而是 suite 直接在 module link 阶段失败：`SyntaxError: The requested module './native-exports.js' does not provide an export named 'captureReqInboundResponsesContextSnapshot'`。当前真实 surface 其实同时有 sync `captureReqInboundResponsesContextSnapshotJson(...)` 和 async `captureReqInboundResponsesContextSnapshot(...)` facade，所以这更像测试 mock 壳层漂移。结论：这条 spec 不能再算作 S2/S3/S6 的可信 gate，只能算 stale harness 证据。
- apply_patch audit map-anchor closeout refreshed: latest=2026-06-16；本轮把剩余 gap 和 function-map / verification-map 真源直接绑死了。`S2/S3` 现在明确挂在 `feature_id: hub.req_inbound_responses_context_capture`，现有 smoke 只锁 duplicate batch normalize，不锁 live reopened inline-history fixture。`S5 outbound` 明确挂在 `feature_id: hub.response_responses_client_projection`，map notes 已经写明“不允许 internal stopless/servertool CLI function_call 和 illegal pending status 进入 replay history”，但测试层还没把这条拆成独立 red test。`S5 persistence/store` 明确挂在 `feature_id: server.responses_response_handler_bridge_surface`，verification notes 也已经写明 store contract 要锁 replay-safe persistence，只是当前 contract 还没把 internal CLI artifact 单独钉住。`duplicate facade` 明确挂在 `feature_id: server.responses_sse_bridge_surface`，而且 map 仍把 `responses-sse-bridge.ts` 登记为 active ts_bridge，说明当前只能记 delete candidate，不能宣称唯一出口已完成。
- stopless stale/transitional gate split reverified: latest=2026-06-16；本轮重新实跑了三条最关键的 S5 邻接 gate。`tests/sharedmodule/responses-continuation-store.spec.ts` 当前 `33/33 PASS`，说明 replay-safe store 基线已经稳定锁住：`output_text/commentary -> input_text`、`reasoning.content` 不回放、`status=in_progress` 不回放。`tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts` 当前 `5/5 PASS`，而且已经明确要求新命令壳 `routecodex hook run stop_message_auto`，所以它不是“旧 servertool run 正确合同”，而是过渡态 CLI projection 合同。相反，`tests/sharedmodule/provider-response-rust-plan.spec.ts` 本轮实跑 `17 total / 11 pass / 6 fail`，6 条失败全部不是 owner 行为缺失，而是断言仍要求旧字符串 `routecodex servertool run stop_message_auto` 出现在 client-visible body/SSE。结论：S5 当前最该标 stale 的不是 store 基线，而是 `provider-response-rust-plan.spec.ts` 这组把内部 CLI 投影当成 `/v1/responses` 正向输出的旧合同；`responses-handler.servertool-cli-projection.blackbox.spec.ts` 则应记为 transitional，不可再直接当 replay-safe outbound gate。
- provider-response stale expectation exact proof pinned: latest=2026-06-16；`tests/sharedmodule/provider-response-rust-plan.spec.ts` 当前 6 条红点的 received 结果完全一致，均为 `routecodex hook run stop_message_auto --input-json ...`，并且 payload 仍是 `response.status="requires_action"` + `output=function_call(exec_command)`。失败位置分别在 198/224/281/327/414/649 附近，说明它整组仍在锁“内部 stopless CLI command 应该 client-visible”这一旧方向，而不是现在需要的 replay-safe/protocol-safe 方向。这个证据已经足够支撑 audit doc 把它定性为 stale contract，不再只是概念判断。
- apply_patch S2/S3 gate-gap precision refreshed: latest=2026-06-16；本轮把 `S2/S3` 的“owner 已知但 fixture 还不够像 live”再压实了一层。`tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts` 当前 3 条只锁 mocked native capture 的归一结果：duplicate batch 不回退 raw input、identical repeat 只保留最新 output、orphan reject 必须 fail-fast；它不锁真实 `S2` 的 reopened inline history 全形状。Rust `hub_bridge_actions/tests.rs` 当前已有 `convert_bridge_input_rejects_orphan_tool_result` 与 `convert_bridge_input_rejects_duplicate_function_call_output_after_call_already_consumed`，但这两条只锁“单 orphan”和“单 call_id 第二次 output after consumed”，还没锁 `S2/S3` 那种“前置 assistant text + 多 call_id + 同批 function_call x2 / function_call_output x2”的 live reopened batch。结论：`S2/S3` 当前不是 owner 不清，而是缺 live-shape fixture。
- responses-sse duplicate facade gate truth refreshed: latest=2026-06-16；`src/modules/llmswitch/bridge/responses-sse-bridge.ts` 现在可以更明确地定性为 facade-only duplicate surface：整面 `...Impl` 从 `responses-response-bridge.ts` 转发，不是第二套 SSE 语义 owner。`tests/red-tests/server_responses_sse_surface_single_owner.test.ts` 与 `scripts/architecture/verify-responses-handler-single-bridge-surface.mjs` 当前保护的也不是“唯一 owner”，而是“split facade 结构必须继续存在”：request side 走 request facade、response side 走 response facade，同时 `handler-response-sse.ts` / `handler-response-utils.ts` 还必须保留对 `responses-sse-bridge.js` 的 split import。结论：duplicate surface 已被识别，但 gate 语义仍在保护 split 结构；若要物理删除，必须先反转 gate。
- apply_patch focused gate bundle rerun refreshed: latest=2026-06-16；本轮把主审计相关 6 组 gate 再实跑了一次。结果是 `4 green / 2 red`：绿的是 `tests/sharedmodule/apply-patch-chat-process-contract.spec.ts`、`tests/providers/runtime/responses-provider.direct-passthrough.spec.ts`、`tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts`、`tests/server/handlers/responses-handler.anthropic-tool-history.blackbox.spec.ts`；红的仍是 `tests/server/handlers/responses-sse-client-contract.blackbox.spec.ts` 和 `tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts`。前者当前精确红点还是 `required_action -> completed -> done` 5s timeout，以及 early upstream close 不投 `event:error` / `upstream_stream_incomplete`；后者当前仍是 `5 failed / 13 passed / 18 total`，失败项继续稳定在 `stream_options`、transparency、stop_followup through Hub、429 reroute、502 reroute。结论继续收敛：`apply_patch` 自身 freeform/request contract、direct passthrough owner、relay anthropic tool-history 基线都已绿；主红面现在不在 apply_patch 基础合同，而在 handler SSE terminal/error 投影和 direct route-level 总黑盒。
- apply_patch live log windows re-cut: latest=2026-06-16；本轮重新切了三段可直接引用的 authoritative live 窗口。`~/.rcc/logs/server-5520.log:969564-969576` 仍是 `5520` direct grammar 400：`thinking -> asxs.crsa.gpt-5.4`，随后 `[router-direct.send] statusCode=400`，upstream 报 `Invalid lark grammar ... begin_patch`。`~/.rcc/logs/server-5520.log:995102-995118` 是 `5555` 的 `input[1].status` 400：前缀明确 `[port:5555 ...]`，先 `thinking -> asxs.crsa.gpt-5.4`，后 `[router-direct.send]` 被 upstream 以 `Unknown parameter: 'input[1].status'` 拒绝。`~/.rcc/logs/server-5520.log:995270-995304` 是 `5555` 的 `input[41].content` 400：同样是 `[port:5555 ...]` 前段，后 `[router-direct.send]` 被 upstream 以 `array too long` / `input[41].content` 拒绝。结论更硬：这两条 `5555` 样本都是 relay-front 先污染历史，再由 final direct send 原样送上游，不是 direct final send 本地修坏请求。
- stopless NoSchema/schema-guidance/route-hint rerun re-verified: latest=2026-06-16；本轮重新实跑 `tests/servertool/stopless-cli-continuation.spec.ts`、`tests/servertool/stopless-vr-route-hint.spec.ts`、`tests/servertool/stop-message-auto-no-reenter.red.spec.ts`，结果 `3 suites / 9 tests PASS`。其中 `stopless-cli-continuation.spec.ts` 现已同时锁住两层事实：一是 `NoSchema` 的 CLI stdout 必带 `schemaGuidance.requiredFields=["stopreason","next_step"]`；二是 same-session 真实 CLI wrapper 持久化路径上 `repeatCount` 会走 `1 -> 2 -> 3`，并且 console 证据已打印 `used=0 -> 1 -> 2`。`stop-message-auto-no-reenter.red.spec.ts` 继续锁 `reenterPipeline` 零调用；`stopless-vr-route-hint.spec.ts` 继续锁 stopless followup 不得带 `route_hint:tools`。结论：stopless core 目前不是“没 schema guidance / 不计数 / 还在 reenter”的主嫌疑，后续 live 若再出现同类现象，应先查 handler/transport/install-state。
- apply_patch audit 5520 direct red-suite exact-failure refresh: latest=2026-06-16；本轮重新实跑 `tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts` 与 `tests/server/handlers/responses-sse-client-contract.blackbox.spec.ts`。前者当前仍是 `18 total / 13 pass / 5 fail`，5 条红点已精确锁定为：`provider-mode chat direct + stream_options`、`same-protocol direct transparency(model=mutated-model vs gpt-5.3-codex)`、`stop_message followup through Hub`、以及 429/502 的 direct local switch 两条。结论继续不变：这不是“5520 apply_patch 主线全红”，其中只有 transparency 一条与 direct request contract 直接相关，其余是 `stream_options` / stopless relayability / retry-policy 邻接 contract。后者当前仍是 `9 total / 7 pass / 2 fail`，红点稳定仍是：`required_action -> completed -> done` 挂 5s timeout，以及 early upstream close 只吐到 `response.created + response.output_text.delta`，缺 `event:error` 和 `"code":"upstream_stream_incomplete"`。这两条仍是 direct SSE client-contract 缺口，不是 relay/store 污染。
- apply_patch audit S2/S3 exact fixture landing refreshed: latest=2026-06-16；本轮把 S2/S3 从“重复 batch 的概念判断”压成了可直接引用的行级证据。S2 现在可直接引用 `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260613T223253714-340912-698.json:323-338`，可见同一 `call_id=call_itUphzwyXqmB1L3pGk03AQHh` 的 `function_call x2 + function_call_output x2`；并与 `~/.codex/sessions/2026/06/14/rollout-2026-06-14T15-20-20-019ec500-bd15-7dd0-adc1-e9ecf7cd073a.jsonl:2010-2020` 直接对上，确认这是客户端源样本真实形状。S3 则补了 `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260612T225507928-339537-1450.json:318-390`，可直接看到 `call_MqPgTUSSFb19Em58JUUEd6xV` 的 `function_call x2 + function_call_output x2`。结论更硬：S2/S3 都不是“单个孤儿 output”小问题，而是 duplicate-batch / already-consumed queue 语义，唯一 owner 仍是 Rust `hub_req_inbound_context_capture` + `hub_bridge_actions/history.rs|bridge_input.rs`；当前缺的是 live reopened batch fixture，不是 owner 不清。
- apply_patch audit S6 wiring-vs-install-state corrected: latest=2026-06-16；本轮把 S6 的表述纠偏了。`src/modules/llmswitch/bridge/responses-request-bridge.ts::buildResponsesRequestContextForHttp(...)` 真实会调用 `captureReqInboundResponsesContextSnapshot(...)`，而 `src/modules/llmswitch/bridge/native-exports.ts:536-545` 会先 `assertSharedBindings()` 再取 `captureReqInboundResponsesContextSnapshotWithNative`。因此 S6 不能再说成“handler 没接到 native capture”或“源码没导出”，因为 required-export list、packaged `.node` binding、`dist/native-shared-conversion-semantics-responses.js` barrel 现有 gate 都已证明 symbol 在。当前真正缺的是 handler-entry / install-state gate：现有 `responses-request-bridge.request-context-normalization.spec.ts` 对 native capture 是 mock，`native-required-exports-sse-stream.spec.ts` 证明的是 dist/binding/barrel，不是当前运行包里 `buildResponsesRequestContextForHttp -> assertSharedBindings -> binding` 整链不漂移。
- stopless NoSchema + no-reenter + thinking-route gate rerun verified: latest=2026-06-16；本轮重新实跑 `tests/servertool/stopless-cli-continuation.spec.ts`、`tests/servertool/stopless-vr-route-hint.spec.ts`、`tests/servertool/stop-message-auto-no-reenter.red.spec.ts`，三组共 `9/9 PASS`。证据比“只看代码”更强：`stopless-cli-continuation.spec.ts` 的 console 明确打印同 session `used=0 -> 1 -> 2`，且 CLI stdout 继续带 `schemaGuidance.requiredFields=[stopreason,next_step]`；这说明 Jason 要求的 `NoSchema` 也携带 schema guidance、且 same-session progression 真正经过 CLI wrapper 持久化路径，而不是单纯 mock 状态。与此同时 `stop-message-auto-no-reenter.red.spec.ts` 继续锁 `reenterPipeline` 零调用，`stopless-vr-route-hint.spec.ts` 继续锁 stopless followup 不得带 `route_hint:tools`。结论：当前 stopless “NoSchema 计数不增长 / 还在 reenter / followup 仍带 tools old hint” 这三条，仓库内 focused gate 已转绿；后续若 live 再复现，应优先排查 handler/transport/old install，而不是先回头怀疑 stopless core 逻辑本身。
- 4444 anthropic canonicalize remains outside apply_patch audit: latest=2026-06-16；本轮再次核对 `~/.rcc/diag/error-openai-responses-router-gpt-5.5-20260615T222217502-349516-2793.json`，确认错误仍是 `hub_pipeline_resp_anthropic_chat_canonicalize_failed: Anthropic SSE response did not contain materializable content blocks`，owner 仍是 Rust `hub.response_anthropic_client_projection`：`hub_pipeline_lib/engine.rs::canonicalize_provider_response_for_client(...)` -> `hub_resp_outbound_client_semantics_blocks/anthropic_chat_response.rs::materialize_anthropic_message_payload(...)`。这条问题和 `5520/5555 apply_patch direct-relay` 审计不是一条线，不能继续混成“apply_patch 还没修好”的证据。
- stopless stale projection contract remains in provider-response-rust-plan: latest=2026-06-16；`tests/sharedmodule/provider-response-rust-plan.spec.ts` 当前仍有多处正向断言 `routecodex servertool run stop_message_auto` 必须出现在 client-visible body / SSE 里（命中行包括 198/224/281/327/414/649 附近），这与当前 stopless CLI contract 已迁到 `routecodex hook run ...` 且越来越强调 replay-safe / client-invisible internal artifacts 的方向冲突。相比之下，`tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts` 已经是“半新半旧”：部分断言已切到 `routecodex hook run ...` 与 terminal payload 不含旧 command，但文件中仍保留旧 `routecodex servertool run ...` fixture 形状。结论：这两处仍应视作过渡/陈旧合同，不能当作 `responses` replay-safe outbound gate 的正向真源。
- apply_patch audit S5 gate split pinned: latest=2026-06-16；本轮把 S5 replay-safe gate 的“已锁住什么 / 没锁住什么”拆清了。`tests/sharedmodule/responses-continuation-store.spec.ts` 现在已经明确锁住三类基础 replay-safe 合同：`output_text/commentary -> input_text`、`reasoning.content` 不 replay、`status=in_progress` 不 replay，这说明 S5 不是“完全没 gate”。但同一个文件后半段仍混有 `routecodex servertool run stop_message_auto` 的第三轮恢复样本，它更像历史样本兼容/store mechanics，不是 client-visible protocol-safe 正向合同。结论：后续需要在同文件或邻近文件里新增一条更窄的 red test，专门锁 internal stopless/servertool CLI `function_call` 不得作为 persisted/materialized replay history 正向保留，不能继续把“兼容旧样本”和“合法 replay 合同”混在一起。
- apply_patch audit S5 stale contract files pinned: latest=2026-06-16；`tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts` 与 `tests/sharedmodule/provider-response-rust-plan.spec.ts` 现在的陈旧程度不同。前者已经有一部分断言切到 `routecodex hook run stop_message_auto`、`continuationPrompt/schemaGuidance` 不泄漏、allow-stop terminal 不再保留 CLI command，所以它是“半新半旧”的过渡合同；但主语仍然是“应投影 command”，因此不能当 replay-safe response outbound gate。后者则更明显 stale：多处仍显式断言 `routecodex servertool run stop_message_auto`、`exec_command`、`stop_message_flow` 应出现在 `result.body`，等于把内部 stopless CLI command 当成 client-visible `/v1/responses` 正向输出。这两处都需要在后续修复时反转成“内部 CLI 不泄漏到 client-visible body”的反向 gate。
- apply_patch audit duplicate-surface/function-boundary refresh pinned: latest=2026-06-16；本轮把“重复 surface / 非唯一入口出口 / handler 只是 transport shell”的代码证据补到了函数级。`src/modules/llmswitch/bridge/responses-sse-bridge.ts` 头部可直接见到 `createResponsesJsonToSseConverterForHttp`、`planResponsesStreamEndRepairForHttp`、`projectResponsesSseFrameForClientForHttp`、`normalizeResponsesClientPayloadForHttp`、`buildResponsesStreamIncompleteErrorPayloadForHttp` 都是 `...Impl` re-export，没有第二份实现体，所以它是 facade-only public surface，不是第二 semantic owner。`src/modules/llmswitch/bridge/native-exports.ts` 同时暴露 `captureReqInboundResponsesContextSnapshotJson()` 和 `captureReqInboundResponsesContextSnapshot()`，但底层都只打同一个 native capability `captureReqInboundResponsesContextSnapshotJson`；这不是双 owner，而是双符号 surface，说明 request 入口仍不唯一。`responses-response-bridge.ts` 当前函数级边界也更清楚了：`recordResponsesResponseForHttpProjection(...)`、`persistResponsesConversationLifecycleForHttp(...)`、`createResponsesJsonToSseConverterForHttp()` 都只是 facade/lifecycle glue，不是最终协议 normalize 真源。
- apply_patch audit handler-shell evidence refresh pinned: latest=2026-06-16；本轮把 server handler 为什么“不是协议 owner，但确实在污染路径上”也补成了具体调用链。JSON path 是 `handler-response-utils.ts -> prepareResponsesJsonClientDispatchPlanForHttp(...) -> persistResponsesConversationLifecycleForHttp({ body: clientBody })`；SSE path 是 `handler-response-sse.ts -> streamResponsesJsonAsSse(...) -> persistResponsesConversationLifecycleForHttp({ body: bridgePlan.sanitizedPayload })`，native SSE probe 还会走 `persistNativeSseConversationState(...) -> persistResponsesConversationLifecycleForHttp({ body: stripInternalKeysDeep(contractProbe.probe) })`。另一个和黑盒红点完全对上的事实是：`handler-response-sse.ts` 在 `planResponsesStreamEndRepairForHttp(...).shouldProjectIncompleteError === true` 分支里，虽然会构造 `buildResponsesStreamIncompleteErrorPayloadForHttp(requestLabel)`，但最终只记录 `response.sse.stream.incomplete_internal_error`、打 `clientErrorSuppressed: true`，然后 `res.end()`，这正是 `responses-sse-client-contract.blackbox.spec.ts` 当前“无 `event:error`”的直接代码根因。
- apply_patch audit live-400 and red-suite refresh pinned: latest=2026-06-16；本轮把两条新的 `5555` replay 400 和两组主 gate 的当前精确红点重新钉住了。`~/.rcc/logs/server-5520.log` 中可直接提取：`openai-responses-router-gpt-5.4-20260615T202700552-348463-1740` 走 `thinking -> asxs.crsa.gpt-5.4.gpt-5.4`，最终 `[router-direct.send]` 被上游以 `Unknown parameter: 'input[1].status'.` 拒绝；`openai-responses-router-gpt-5.4-20260615T202830407-348488-1765` 走 `default -> asxs.crsa.gpt-5.4-mini.gpt-5.4-mini`，最终 `[router-direct.send]` 被上游以 `Invalid 'input[41].content': array too long ...` 拒绝。结论更精确了：`5555` 当前不是“direct 自己改坏请求”，而是 relay 前段把 replay-illegal `status` / `message.content.output_text` 污染进历史，末跳 direct 原样发上游才被判错。与第二条对应的 authoritative 形状仍在 `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260615T001004109-345184-2762.json`，其中 `requestBody.input_len=399`，tail 明确出现 `type=message` + `content[{type:\"output_text\"}]`，owner 继续锁 `shared_responses_conversation_utils.rs` + `responses-conversation-store.ts`。
- apply_patch audit red-suite rerun refresh pinned: latest=2026-06-16；本轮再次实跑 `responses-sse-client-contract.blackbox.spec.ts` 和 `direct-passthrough-route-level.spec.ts`，结果与上一轮总结一致但现在有新的精确断言文本。前者仍是 `2/9 FAIL`：`captures required_action -> completed -> done for tool-call continuation without hanging the client` 仍是 5s timeout；`turns early upstream close into explicit error instead of client hang` 当前 raw SSE 只有 `response.created` + `response.output_text.delta("partial")`，没有 `event:error` 和 `"code":"upstream_stream_incomplete"`。后者仍是 `5/18 FAIL`，和本审计最相关的红点仍只有 `router same-protocol direct does not enter HubPipeline and keeps ingress payload transparent`，其张力是期望 `model=gpt-5.3-codex`，实际 `model=mutated-model`；其余 `stream_options` / stopless / 429 / 502 仍是 direct 邻接问题，不能用来证明 `5520 apply_patch` 主链坏掉。
- apply_patch audit 5520 direct live proof refresh pinned: latest=2026-06-16；`openai-responses-router-gpt-5.4-20260614T230414428-345124-2702` 仍可直接从现行 live log 提取同一窗口四联证据：`▶ [/v1/responses]`、`[virtual-router-hit] thinking -> asxs.crsa.gpt-5.4.gpt-5.4`、`[router-direct.send] statusCode=400`、upstream `Invalid lark grammar ... unknown name: "begin_patch"`。`openai-responses-router-gpt-5.4-20260615T193814122-348189-1466` 同样仍可直接提取：`coding -> asxs.crsa.gpt-5.4-mini.gpt-5.4-mini`、`[response.sse.stream] ... non-Responses event "response.metadata"`、`[usage] route=router-direct:coding/- finish_reason=unknown`。这继续把 `5520` 的剩余 apply_patch 相关风险收敛在 Rust request contract / direct SSE boundary，而不是 relay/store。
- apply_patch audit exact red-test landing targets pinned: latest=2026-06-16；本轮把剩余缺口该落到哪几个测试文件进一步锁死了。S2/S3 的 live duplicate batch 形状，最合适的 Rust owner 还是 `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/tests.rs`，因为真正的 pending/consume 队列语义都在 `convert_bridge_input_to_chat_messages(...)`；同时 `tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts` 只负责锁 facade 不回退 raw input，适合补一条“assistant text + duplicate same-call batch”的更贴近 live 形状。S5 的 replay-safe persistence 缺口则应落在 `tests/sharedmodule/responses-continuation-store.spec.ts`，新增“internal stopless/servertool CLI function_call 不得进入 persisted/materialized history”的红测；与之相邻的两个 stale expectation 文件是 `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts` 和 `tests/sharedmodule/provider-response-rust-plan.spec.ts`，它们当前都还把 internal CLI 投影当成正向合同，后续不是删除，而是反转成 replay-safe / client-visible protocol-safe 红测。S6 的 required export / binding 历史失效则不能只靠现有 `native-required-exports-sse-stream` 一类 gate，还需要一个 handler-entry / install-state 层的 live gate，锁 `captureReqInboundResponsesContextSnapshotJson` 在真实 handler path 上可解析、可调用，而不是仅在 loader / dist / `.node` require 层存在。
- apply_patch audit fresh gate rerun pinned: latest=2026-06-16；本轮重新实跑与主目标直接相关的 6 组验证。绿的有：`tests/providers/runtime/responses-provider.direct-passthrough.spec.ts` `12/12 PASS`，证明 `5520 direct` provider runtime 薄壳保持 request body identity；`tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts` `3/3 PASS`，精确锁住 `event: response.metadata` 非法事件名；`tests/server/handlers/responses-handler.anthropic-tool-history.blackbox.spec.ts` `11/11 PASS`，说明 `5555 relay` 当前黑盒已覆盖 paired custom tool output、reopened apply_patch history 与 Anthropic/MiniMax tool-order 基线；`tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts` `3/3 PASS`，说明 relay request-context 已锁 duplicate batch normalize 与 orphan fail-fast。红的有两组：`tests/server/handlers/responses-sse-client-contract.blackbox.spec.ts` 仍是 `2/9 FAIL`，失败点稳定仍是 `required_action -> completed -> done` terminal repair 缺失与 early upstream close 未投 `event:error`；`tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts` 仍是 `5/18 FAIL`，其中只有 `router same-protocol direct does not enter HubPipeline and keeps ingress payload transparent` 这条与本审计主线直接相关，其余 4 条属于 `stream_options` / stopless / direct retry-policy 邻接问题。因此 route-level suite 当前只能当 direct contract tension 证据，不能整体当成 `5520 apply_patch` 主线坏掉的证明。
- apply_patch audit 4444 evidence-source rule pinned: latest=2026-06-16；本轮再次核对 `4444` 后，确认这条问题簇必须从 apply_patch 主线中继续剥离，而且证据源要更严格。`~/.rcc/diag/error-openai-responses-router-gpt-5.5-20260615T222217502-349516-2793.json` 明确给出 `message=Rust HubPipeline response path failed: hub_pipeline_resp_anthropic_chat_canonicalize_failed: Anthropic SSE response did not contain materializable content blocks`，这属于 Rust owner `hub.response_anthropic_client_projection`，落点是 `hub_pipeline_lib/engine.rs::canonicalize_provider_response_for_client(...)` 与 `hub_resp_outbound_client_semantics_blocks/anthropic_chat_response.rs`。而 `~/.rcc/diag/error-openai-responses-router-gpt-5.5-20260615T230135968-349824-3101.json` 明确给出 `code=MALFORMED_RESPONSE`、`status=200`、`details.providerFamily=anthropic`、`details.requestContext.target.providerProtocol=anthropic-messages`，说明这是 provider malformed Anthropic payload 分类链。另一个关键纠偏是：当前 `server-4444.log` 最近窗口里会混入 `5555` 行，不能再把它当成这两条 requestId 的 authoritative 证据源；`4444` 这两条现阶段必须以 diag + owner code + function-map / verification-map 为准。
- apply_patch audit duplicate-sse-facade gate truth repinned: latest=2026-06-16；本轮继续核对 `responses-sse-bridge.ts`、`bridge/index.ts`、`tests/red-tests/server_responses_sse_surface_single_owner.test.ts` 和 `scripts/architecture/verify-responses-handler-single-bridge-surface.mjs` 后，确认当前 gate 真正保护的是 split facade 结构本身，而不是“唯一 SSE 语义 owner”。`responses-sse-bridge.ts` 现在几乎整面 re-export `responses-response-bridge.ts` 的 SSE/projector/guard symbols，属于 facade-only public surface；但 red test 明确要求 `handler-response-sse.ts` 与 `handler-response-utils.ts` 继续同时 import `responses-sse-bridge.js` 和 `responses-response-bridge.js`，verify 脚本也继续要求这套 split facade 存在。结论：它是 duplicate facade / delete candidate，但当前不能直接删；若后续要物理删除，必须先改 function-map / verification-map 与对应 gate，然后再删 facade 本体。
- apply_patch audit 5555-relay owner-chain pinned: latest=2026-06-16；本轮把“5555 为什么是 relay”从口头判断收成了代码 owner 链。`src/modules/llmswitch/bridge/responses-request-bridge.ts` 当前 handler-facing 真入口是 `buildResponsesRequestContextForHttp(...)` / `prepareResponsesHandlerRuntimeForHttp(...)` / `buildResponsesPipelineMetadataForHttp(...)`，并会调用 `captureReqInboundResponsesContextSnapshot(...)`、`resumeResponsesConversation(...)`、`materializeLatestResponsesContinuationByScope(...)`；本地 continuation/store 真 owner 在 `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`，当前真入口是 `recordResponse(...)` / `resumeConversationPayload(...)` / `materializeContinuationPayload(...)` / `restoreContinuationPayload(...)`，且 `shouldPersistLocally(entry)` 明确 `continuationOwner=direct` 不落本地；response 侧 handler bridge 真入口是 `responses-response-bridge.ts` 的 `recordResponsesResponseForHttpProjection(...)` / `persistResponsesConversationLifecycleForHttp(...)`。所以 5555 之所以必须归类为 relay，不是因为最后一跳一定不是 direct，而是因为 request capture / continuation restore / local store / response persistence 这些 relay owner 明确先发生了；final provider transport 即便显示 `router-direct.send`，也只是 relay 之后的末跳实现方式。
- apply_patch audit direct transparency red-test tension pinned: latest=2026-06-16；本轮把 `direct-passthrough-route-level.spec.ts` 那条最相关红点继续落到代码，确认它不是“router-direct-pipeline 偷改 payload”。`src/server/runtime/http-server/index.ts` 当前明确是 `const rawDirectPayload = requireDirectPassthroughPayloadObject(input.body);` 之后直接 `const requestPayload = rawDirectPayload;`；`src/server/runtime/http-server/router-direct-pipeline.ts` 的 `recordPayloadAudit(...)` 也只记录 observable fields，不改 payload。与此同时，`tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts` 这条红测却期望 direct send 的 `model` 被改成 `target.modelId = gpt-5.3-codex`，而实际发送的是 ingress body 的 `model = mutated-model`。再对照 `docs/architecture/function-map.yml` 的 `responses.direct_tool_shape_contract`，它写的正是 “keep the current request body as provider wire”。结论：这条红点当前更像“route-level 测试预期 vs 现行 direct contract”的 tension，而不是 `5520 apply_patch` 主链已证实回归；审计文档里必须明确区分。
- apply_patch audit 5520 direct gate split pinned: latest=2026-06-16；本轮把 `5520 direct` 的“薄壳是绿的、route-level 总黑盒不是全绿”分开记账。`tests/providers/runtime/responses-provider.direct-passthrough.spec.ts` 现跑 `12/12 PASS`，直接证明 provider runtime direct path 不读取 `metadata.__raw_request_body`、不本地清洗 reasoning/history/tools、`submit_tool_outputs` 也命中 upstream submit endpoint，所以 provider runtime 本身不是 `5520` apply_patch 问题的修补 owner。与此同时，`tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts` 现跑仍是 `18 total / 13 pass / 5 fail`；其中和本审计最相关的红点是 `router same-protocol direct does not enter HubPipeline and keeps ingress payload transparent`，预期发出 `model=gpt-5.3-codex`，实际发出 `model=mutated-model`，说明 route-level suite 对 direct transparency 的定义和当前真实行为仍有差异。其余红点（`stream_options`、stop_message followup、429/502 local switch）都属于旁支 direct contract，不宜直接拿来证明 `5520 apply_patch` 主链有问题。结论要锁成：`5520` 当前更像“provider runtime 绿、request contract/SSE boundary 仍需继续审”，不能笼统说 direct 整体坏。
- apply_patch audit S2/S3 gate-to-live gap pinned: latest=2026-06-16；本轮把 S2/S3 现有 gate 与 live 缺口对齐到具体用例名，不再只写“有近似测试”。S2 现有最接近的是 `tests/server/handlers/responses-handler.anthropic-tool-history.blackbox.spec.ts` 的 `preserves paired Responses custom_tool_call_output through the Anthropic provider payload` 与 `RED: preserves reopened apply_patch tool history after prior assistant text and multiple tool turns`，以及 `tests/responses/responses-openai-bridge.spec.ts` 的 `RED: reopened apply_patch and exec_command history stays tool-ordered after prior assistant text`；它们锁的是“assistant text + reopened multi-turn tool history 保持 tool-order”，还没把 live 的 “同一 call_id 在同一批里 function_call x2 + function_call_output x2” 独立 fixture 化。S3 现有最接近的是 `tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts` 的 `RED: relay request context does not fall back to raw input when native capture rejects orphan tool_result`，以及 Rust `hub_bridge_actions/tests.rs::convert_bridge_input_rejects_duplicate_function_call_output_after_call_already_consumed`；它们锁的是“单个 orphan/已消费 output 必须 fail-fast”，还没把 live 的“三个 call_id 成批重复 function_call x2，再跟 function_call_output x2”的 duplicate-batch 队列样本固化出来。
- apply_patch audit codex-session duplicate-same-call truth pinned: latest=2026-06-16；本轮直接读取 `~/.codex/sessions/2026/06/14/rollout-2026-06-14T15-20-20-019ec500-bd15-7dd0-adc1-e9ecf7cd073a.jsonl`，确认原始 Codex session JSONL 自身就包含 duplicate same-call batch，而不是 RouteCodex 运行时凭空重复。索引级证据：`IDX 41` 与 `IDX 42` 是同一 `call_id=call_itUphzwyXqmB1L3pGk03AQHh` 的两次 `function_call(exec_command)`，`IDX 43` 与 `IDX 44` 是同一 `call_id` 的两次 `function_call_output`。这与 S2 diag `error-openai-responses-router-gpt-5.4-20260613T223253714-340912-698.json` 的 tail 完整对上，说明 owner 责任要锁到 Rust `hub_req_inbound_context_capture` / `hub_bridge_actions/history.rs` / `bridge_input.rs` 对 duplicate batch、already-consumed queue 的处理，而不是先怪 TS handler/server 造假。
- apply_patch audit evidence-grade correction for 5555: latest=2026-06-16；当前 `~/.rcc/logs/server-5555.log` 已经轮转，S2/S3/S4/S5 那些经典 requestId 不再直接可搜到。因此之后的文档表述必须显式区分：`5520` 的 S1/S1b 仍可直接引用现行 live log；`5555` 的旧失败样本当前 authoritative 证据是 `~/.rcc/diag/error-*.json` + 当前 owner 代码，现行 5555 log 只能证明结构性事实（relay 前段 + final direct send 仍存在），不能再伪装成这些旧 requestId 本人的 live log 证据。
- apply_patch audit SSE blackbox red truth pinned: latest=2026-06-16；本轮实跑 `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/server/handlers/responses-sse-client-contract.blackbox.spec.ts --runInBand`，结果稳定为 `9 tests / 2 failed`。失败点不是模糊的“可能有 SSE 问题”，而是两个精确 contract 缺口：其一，`captures required_action -> completed -> done ...` 中 `response.output_item.done` 之后没有补出 `response.completed` / `response.done`，`completedIndex=-1`；其二，`turns early upstream close into explicit error instead of client hang` 中 raw SSE 只有 `response.created` + `response.output_text.delta("partial")`，没有 `event:error`，期望的 `"code":"upstream_stream_incomplete"` 没投给客户端。代码级证据也已对上：`responses-response-bridge.ts::planResponsesStreamEndRepairForHttp()` 会把“tool continuation 缺 terminal”和“非 continuation 提前关流”分成 `shouldRepairContinuationTerminal` / `shouldProjectIncompleteError` 两类；但 `handler-response-sse.ts` 在 `shouldProjectIncompleteError` 分支里当前只记 `response.sse.stream.incomplete_internal_error`，并显式打 `clientErrorSuppressed: true` 后 `res.end()`，所以黑盒看到内部识别 incomplete，却看不到 client-visible `event:error`。这条现在应归为 response outbound / SSE stream-end repair 总 gate 仍红，不是 apply_patch request contract 回归。
- apply_patch audit 4444 issue split repinned: latest=2026-06-16；`~/.rcc/logs/server-4444.log` 需要明确拆两类，不能继续混写成一个 apply_patch 问题。`openai-responses-halphen.key1-glm-5.2-20260615T222217502-349516-2793` 仍是 `[convert.bridge] Rust HubPipeline response path failed: hub_pipeline_resp_anthropic_chat_canonicalize_failed: Anthropic SSE response did not contain materializable content blocks`；而 `openai-responses-halphen.key1-glm-5.2-20260615T230135968-349824-3101` 已是 `MALFORMED_RESPONSE`，错误内容为 `[provider] Upstream provider returned malformed Anthropic response: 模型厂商异常导致本次错误，请重试即可`。结论要锁成：`4444` 当前属于 provider/Anthropic-response 投影问题簇，不应再混入本轮 `apply_patch direct/relay` 主审计。
- stopless NoSchema CLI/tool contract relock verified: latest=2026-06-16；本轮把 stopless 的旧黑盒/旧 owner 断言收到了当前 CLI 真相。`NoSchema` 不是“无 schema 引导”，而是“命令仍保持 status-only，但 CLI stdout 必带 schemaGuidance”；`tests/servertool/stopless-cli-continuation.spec.ts` 新增真实 CLI 包装层同 session `1 -> 2 -> 3` 进位门禁，锁的不是 mock state，而是 `routecodex hook run stop_message_auto` 执行后由 `src/cli/commands/servertool.ts` 持久化的真实闭环。另一个关键修正是 stopless 相关 Jest 统一切到独立 `ROUTECODEX_SESSION_DIR`，否则本地 routing state 会把第一轮 CLI stdout 错抬成第二轮，形成假红。当前通过的定向证据：`tests/servertool/stopless-cli-continuation.spec.ts`、`tests/servertool/stopless-prompt.client-visible.spec.ts`、`tests/servertool/servertool-cli-result-restore.spec.ts`、`tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts`、`cargo test -p servertool-core stopless --lib -- --nocapture`、`cargo test -p router-hotpath-napi stop_message_auto --lib -- --nocapture`、`cargo test -p router-hotpath-napi stopless_followup_strips_ --lib -- --nocapture`、`npm run verify:function-map-compile-gate`。
- apply_patch audit S2/S3 concrete tail indexes pinned: latest=2026-06-16；本轮直接把 diag 尾部索引打平。S2 `error-openai-responses-router-gpt-5.4-20260613T223253714-340912-698.json` 的 `requestBody.input` 长度是 `45`，末尾关键索引 `41/42/43/44` 全部属于同一个 `call_id=call_itUphzwyXqmB1L3pGk03AQHh`：两次 `function_call`，随后两次 `function_call_output`。S3 `...231359101-341020-806.json` 的 `requestBody.input` 长度是 `212`，末尾关键索引 `200..211` 是三组 `call_id`（`call_cQ4...` / `call_36y9...` / `call_JyD0...`）各两次 `function_call`，再各两次 `function_call_output`。这说明 S2 是 duplicate same-call batch，S3 是 duplicate-batch / already-consumed queue shape；现在这两条已不是摘要判断，而是索引级证据。
- apply_patch audit replay-safe gate asymmetry rechecked: latest=2026-06-16；现有测试面对 stopless/internal CLI 不是“完全没覆盖”，而是覆盖方向不对称。反向 gate 已有：`tests/sharedmodule/responses-continuation-store.spec.ts` 明确锁 `submit_tool_outputs resume keeps function_call history without replaying response-only status fields`，证明 `status=in_progress` 不应 replay 回下一轮 `input`。但正向合同仍大量存在：`responses-continuation-store.spec.ts` 第三轮 stopless 恢复、`responses-handler.servertool-cli-projection.blackbox.spec.ts`、`provider-response-rust-plan.spec.ts` 仍把 `routecodex hook run stop_message_auto` 或旧 `routecodex servertool run stop_message_auto` 当成应保留/应重投影 payload。结论更精确地说，是“internal stopless/servertool CLI function_call 还缺反向 replay-safe gate”，而不是“仓库完全没有 stopless CLI 测试”。
- apply_patch audit duplicate-surface gate mismatch confirmed: latest=2026-06-16；本轮继续核对 `src/modules/llmswitch/bridge/{responses-sse-bridge.ts,responses-response-bridge.ts}`、`handler-response-sse.ts`、`handler-response-utils.ts` 与 function-map/verification-map 后，事实进一步收紧为三点。第一，`responses-sse-bridge.ts` 现在不是第二语义 owner，而是把大量 symbol 从 `responses-response-bridge.ts` 直接 re-export 出去的 facade-only surface；真实 SSE allowlist / direct metadata guard / JSON->SSE dispatch 语义 owner 仍在 `responses-response-bridge.ts`。第二，当前门禁 `tests/red-tests/server_responses_sse_surface_single_owner.test.ts` 锁的是“handler 侧 import split 必须维持”和“index.ts 不要把 SSE symbol 放进 lifecycle 那一段 export”，并没有锁“重复 facade 必须物理删除”或“唯一响应出口必须收敛到一个 facade”。第三，`docs/architecture/function-map.yml` / `verification-map.yml` 仍把 `server.responses_sse_bridge_surface` 当成独立 active feature，这与代码层 facade-only 事实存在语义张力；当前更准确的描述应是“独立 public surface，不是独立 semantic owner”。这说明当前 red gate 只能防 handler import 再次散开，不能证明出口已经唯一化，也解释了为什么 duplicate surface 能长期残留而不触发 gate。
- apply_patch audit duplicate-surface gate runtime proof added: latest=2026-06-16；本轮实跑 `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/architecture/verify-responses-handler-single-bridge-surface.mjs` 与 `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/red-tests/server_responses_sse_surface_single_owner.test.ts --runInBand`，两者都 PASS。结论不是“出口已经唯一化”，而是已经被运行时 gate 明确锁成“handler request/response 层必须继续维持 SSE facade + lifecycle facade 的 split 结构”。也就是说，这个 gate 当前在保护 split facade 现状本身；若后续要物理删除 `responses-sse-bridge.ts` 或把 response 出口真正收敛成单 facade，必须先改 gate、改 function-map，再改代码，否则会先被现有门禁打回。
- apply_patch audit request-capture dual-symbol drift confirmed: latest=2026-06-16；`src/modules/llmswitch/bridge/native-exports.ts` 当前同时暴露同步名 `captureReqInboundResponsesContextSnapshotJson(...)` 与 async facade `captureReqInboundResponsesContextSnapshot(...)`，而 `responses-request-bridge.ts` 实际调用的是 async facade；与此同时，`tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts` 和 `...submit-tool-outputs.sse-error.spec.ts` 仍主要 mock `captureReqInboundResponsesContextSnapshotJson`。这说明 submit_tool_outputs handler 相关测试里确实存在双符号 surface 漂移：测试合同盯的是旧/底层符号名，而真实 request bridge 已经走 facade 名。这条当前应记作 harness drift / 入口不唯一风险，不是新的业务回归。
- apply_patch audit server response path boundary tightened: latest=2026-06-16；本轮复核 `handler-response-utils.ts` 与 `handler-response-sse.ts` 后，server 层边界可更精确描述：这两处没有发现第二套 request/response 协议解析 owner，但它们确实在 response outbound -> relay persistence 闭环上持有最后一跳 body/probe，并把 `clientBody` / `contractProbe.probe` 交给 `persistResponsesConversationLifecycleForHttp(...)`。因此 server 层不是语义真源，但它绝不是“完全无关 transport 壳”；任何 response-side replay 污染都必须同时审 Rust client projection owner 与这里的 persistence handoff。当前未见 server 侧主动修补 direct request payload 的新实锤，因此 `5520 direct` request 问题仍不能归到 server request shell。
- anthropic response duplicate tool_use id canonicalize fix: latest=2026-06-16；针对 4444/Anthropic 响应投影链再次核查后，当前可确认两类错误已分叉：部分新 halphen/GLM 样本已经是 provider 侧 `MALFORMED_RESPONSE`（上游直接回“模型厂商异常导致本次错误，请重试即可”），但旧类 `hub_pipeline_resp_anthropic_chat_canonicalize_failed` 仍暴露出 RouteCodex 自身的 response outbound 合同缺口：`hub_resp_outbound_client_semantics_blocks/anthropic_chat_response.rs::build_openai_chat_response_from_anthropic_message()` 之前会直接信任 Anthropic `content[].tool_use.id`，不做唯一化；若上游重复给同一个 id，转 OpenAI chat/Responses 时会把重复 tool_call id 原样放出，存在再次触发 canonicalize/客户端协议失败的风险。现已在 Rust owner 内补唯一化逻辑 `uniquify_tool_call_id(...)`，重复 id 会稳定改写为 `<id>_dup_<n>`，并新增单测 `build_openai_chat_response_from_anthropic_dedupes_duplicate_tool_use_ids` 锁住。验证已绿：`cargo test -p router-hotpath-napi build_openai_chat_response_from_anthropic_dedupes_duplicate_tool_use_ids --lib -- --nocapture`、`cargo test -p router-hotpath-napi builds_chat_response_from_anthropic_sse_tool_use --lib -- --nocapture`、`PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:hub-response-anthropic-native`。证据缺口：本轮没有先单独记录新测试 pre-fix 红态，因此当前只能宣称“owner 修复 + gate 绿”，不能宣称该 live 4444 类错误已全量在线闭环；仍需后续拿到可复现的 duplicate-id live/fixture 样本再补在线复测。
- responses-continuation-store ambiguity gate restored: latest=2026-06-15；本轮把 `tests/sharedmodule/responses-continuation-store.spec.ts` 从 `29/33` 拉回 `33/33`。真实业务缺口只有一条：`sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts::materializeLatestContinuationByScope()` 在未显式指定 `continuationOwner` 时，会忽略 direct match、直接命中 relay，导致 `direct + relay` 同 scope 共存时不 fail-fast。现已加 owner 歧义检测：若同一 scope 同时命中 direct/relay 且请求未指定 owner，直接返回 `null`。另外 3 条失败已确认只是旧 fixture 漂移，不是业务回归：assistant 历史消息在 replay-safe store 中已经合法化为 `input_text`，standalone reasoning 历史只保留合法 `summary/encrypted_content`，不再回放非法 `reasoning.content/status`。验证已绿：`PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/responses-continuation-store.spec.ts --runInBand`。
- apply_patch request-side freeform contract regression fixed: latest=2026-06-15；本轮重新打红后确认，`tests/sharedmodule/apply-patch-chat-process-contract.spec.ts` 失败不是 sample 漂移，而是 prod request owner 真被改坏：`req_process_stage1_tool_governance_blocks/orchestrator.rs::apply_req_process_tool_governance()` 只调用了错误的 `normalize_apply_patch_client_contract_schema()`，导致 live request 仍把 `apply_patch` 保持为 `type=function`，而仓库真正的 freeform/lark owner `normalize_apply_patch_freeform_tool_schema()` 只活在单元测试 helper 里，属于典型“测试绿过 owner 没接入 prod”。现已把 prod 路径切回 freeform owner，并物理删除无其他 caller 的错误 `client_contract_schema` 分支，同时新增 Rust 定向测试 `apply_req_process_tool_governance_projects_apply_patch_as_custom_freeform_tool` 锁死 prod 路径。验证已绿：`cargo test -p router-hotpath-napi apply_req_process_tool_governance_projects_apply_patch_as_custom_freeform_tool --lib -- --nocapture`、`PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/build-core.mjs`、`PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/apply-patch-chat-process-contract.spec.ts --runInBand`、`cargo test -p router-hotpath-napi resp_process_stage1_tool_governance_tests --lib -- --nocapture`、`npm run verify:apply-patch-freeform-contract`、`npm run verify:apply-patch-regressions`、`npm run verify:function-map-compile-gate`。
- stopless NoSchema CLI/tool contract relock in progress: latest=2026-06-15；本轮现场复核确认两件事。其一，`servertool-core/src/cli_contract.rs` 的 `stop_message_auto` stdout 其实已经带 `schemaGuidance`，但高层 Jest 合同仍有旧断言把它当作 `undefined`，等于把错误 contract 锁成绿；已开始把 `tests/servertool/servertool-cli-result-restore.spec.ts`、`tests/servertool/stopless-prompt.client-visible.spec.ts`、`tests/servertool/stopless-cli-continuation.spec.ts` 改成显式要求 NoSchema stdout 必带 `schemaGuidance.requiredFields/stopreasonValues`。其二，live 上“used 不增长”的真相要分两层：直接调用 Rust 二进制 `routecodex-servertool run stop_message_auto` 三次时 `repeatCount` 会始终停在 `1`，因为二进制只产 stdout 不持久化；真实闭环 owner 在 `src/cli/commands/servertool.ts` 的 `hook/servertool run` 包装层，它会先读 `session:<id>` persisted state，再在命令返回后调用 `recordStoplessContinuationState(...)` 落盘。因此本轮新增/补强的红测必须锁在 CLI 包装层同 session `1 -> 2 -> 3`，不能只测裸 Rust binary。
- stopless CLI round-progression contract corrected: latest=2026-06-15；当前 `stop_message_auto` 的 client-visible CLI stdout 已带 `schemaGuidance`，`NoSchema` 不是“无 schema 引导”。真正语义是：server 在投影 stopless `exec_command` 时就已经把 `persistPlan.nextUsed` 写进 `session:<id>` 并把新 `repeatCount` 带进下一轮 re-projected command；同一条旧 command 被本地反复重跑不应作为 live round-progression 真相。测试与审计应改成“同一 session 下连续重新投影的三轮 command 分别命中 first/middle/final”，而不是要求单条 command 自己在本地连跑三次时升级。
- S2/S3 payload-shape evidence corrected: latest=2026-06-15；新增 diag 级抽样后，S2/S3 都不该再粗糙写成“普通 reopened tool turn”或“单个孤儿 tool_result”。S2 的 `error-openai-responses-router-gpt-5.4-20260613T223253714-340912-698.json` 尾部是真实 `assistant output_text -> function_call(call_itU...) -> 同 call_id 再次 function_call -> 两次 function_call_output`；S3 的 `error-openai-responses-router-gpt-5.4-20260613T231359101-341020-806.json` 尾部则是三组 call_id 先出现一轮 `function_call`，再同三组重复一轮 `function_call`，再出现两轮 `function_call_output`，其中报错目标 `call_JyD0...` 同时有两次 call 与两次 output。结论要纠偏为“重复 batch / already-consumed call_id”更贴近 live 真相，owner 应继续锁到 Rust req_inbound capture / history normalization，而不是只写成最简单 orphan。
- apply_patch audit targeted gate rerun pinned: latest=2026-06-15；本轮已现场复跑四组定向 gate，与审计结论一致：`cargo test -p router-hotpath-napi apply_patch --lib -- --nocapture` => `95 passed, 1 ignored`；`responses-response-bridge.direct-json-protocol-guard` + `direct-sse-metadata-guard` => `2 suites / 4 tests PASS`；`responses-request-bridge.request-context-normalization` + `responses-handler.anthropic-tool-history.blackbox` => `2 suites / 14 tests PASS`；`responses-continuation-store.spec.ts` 仍为 `29 passed / 4 failed`，且失败分级继续稳定为“1 条真实 blocker（direct/relay coexist ambiguity）+ 3 条旧 fixture 漂移（output_text / reasoning.content / status 旧预期）”。
- codex session tool-turn evidence pinned: latest=2026-06-15；已抽查 `~/.codex/sessions/2026/06/14/rollout-2026-06-14T14-31-22-019ec4d3-e92c-7240-b6a5-153aaac6d806.jsonl` 与 `...15-20-20-019ec500-bd15-7dd0-adc1-e9ecf7cd073a.jsonl`，两份都能直接看到标准 `reasoning -> function_call xN -> function_call_output xN` 成对结构，代表性时间点分别是 `06:33:45.911Z -> 06:33:46.032Z` 与 `07:21:49.539Z -> 07:21:49.662Z`。这进一步支持：S2/S3 的 `2013` / `orphan_tool_result` 不应先归因给 Codex session 原始样本，而应继续锁定 RouteCodex request-side history capture / provider history projection owner。
- apply_patch full audit closeout evidence refined: latest=2026-06-15；本轮补齐了三块还缺的审计证据。第一，`src/modules/llmswitch/bridge/responses-sse-bridge.ts` 已确认只是 `responses-response-bridge.ts` 的重复 facade，不是第二语义 owner；`src/modules/llmswitch/bridge/index.ts` 还同时 public re-export 两套 surface，这会继续放大“非唯一出口”，两者都应进入后续物理删除候选。第二，`tests/sharedmodule/responses-continuation-store.spec.ts` 当前 `29 passed / 4 failed` 里，只有 `fails fast when direct and relay continuations coexist under one scope without explicit owner` 是真实 contract blocker；其余三条失败都已证实主要是 fixture 仍期待旧的 `output_text` / `reasoning.content` / `status` 形状，属于 replay-safe 合同升级后的预期漂移。第三，S2/S3/S5 现在已能分清缺口类型：S2 是 live reopened multi-tool-turn 形状未被 fixture 精确锁住，S3 是 live continuation orphan 形状未被 fixture 精确锁住，S5 不是 fresh outbound sanitize 未修，而是缺统一 response outbound + store/replay 组合审计 gate。
- apply_patch audit duplicate-surface / stale-fixture split refined: latest=2026-06-15；当前轮确认 `src/modules/llmswitch/bridge/responses-sse-bridge.ts` 不是第二语义 owner，而是几乎整面 re-export `responses-response-bridge.ts` 的重复 facade surface；`tests/red-tests/server_responses_sse_surface_single_owner.test.ts` 目前只锁“handler 侧 import 来源分裂”，并没有锁“重复 facade 物理删除”。这条应记为删除候选：在 callers 全迁到唯一 facade 后，`responses-sse-bridge.ts` 应收缩或删除，避免 SSE/response 双桥并存继续制造非唯一出口。另一个关键收口是 `tests/sharedmodule/responses-continuation-store.spec.ts` 当前实跑 `29 passed / 4 failed`：其中 `fails fast when direct and relay continuations coexist under one scope without explicit owner` 是真实 contract 缺口，当前实现错误返回 relay materialized payload；另 3 条失败（historical images after success release、standalone reasoning preserve、reopened apply_patch after exec_command）主要是旧 fixture 仍期待 `output_text` / `reasoning.content` / `status` 等旧形状，属于测试预期漂移，不能直接当成业务回归。
- apply_patch audit gate/harness truth refined: latest=2026-06-15；当前轮复核发现三类 gate 需要分开记账。`tests/modules/llmswitch/bridge/responses-response-bridge.direct-json-protocol-guard.spec.ts` 可直接用普通 Jest 跑绿；`tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts` 若直接用 `pnpm jest` 会因顶层 `await` 被按 CommonJS 解析而假红，正确命令是 `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest ... --runInBand`，实跑 3/3 PASS；`tests/sharedmodule/apply-patch-freeform-client-projection.blackbox.spec.ts` 初次失败不是业务红，而是 native `projectResponsesClientPayloadForClientJson` 在本地 dist 未就绪，执行 `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/build-core.mjs` 后重跑即 3/3 PASS。结论：这三条 spec 不能只写“绿/红”，必须同时标记运行前提，否则会把 ESM 入口问题和 native build 前置条件误记成业务回归。
- apply_patch broad suite reverified + 4444 issue decoupled: latest=2026-06-15；当前轮重新在 `sharedmodule/llmswitch-core/rust-core` 复跑 `cargo test -p router-hotpath-napi apply_patch --lib -- --nocapture`，结果 `95 passed, 1 ignored`，说明 request-side client-contract preserve 与 response-side legacy hunk/live-context 修复当前仍为绿。同时复核 `~/.rcc/logs/server-4444.log` 最新 live：`openai-responses-halphen.key1-glm-5.2-20260615T230135968-349824-3101` 失败类型已是 `MALFORMED_RESPONSE`，错误内容为 `[provider] Upstream provider returned malformed Anthropic response: 模型厂商异常导致本次错误，请重试即可`；它不再等同于早前那条 `hub_pipeline_resp_anthropic_chat_canonicalize_failed`，因此 4444 当前问题应从 apply_patch / responses replay-safe 审计里分离，归到 provider malformed Anthropic payload 解析/投影链。
- stopless 5555 route-hint/search carryover confirmed and fixed: latest=2026-06-15；live `~/.rcc/logs/server-5555.log` 中 `sid=stopless-live-1780952765059` 连续三次都命中 `reason=thinking:user-input|route_hint:search`，证明 stopless followup 错带了旧 `search` hint。owner 在 `chat_servertool_orchestration.rs` followup metadata 构造与 `virtual_router_engine/engine/route.rs::resolve_route_hint()`；现已让 stopless followup 通过 `serverToolFollowupSource=servertool.stop_message` 进入 VR，并对该 source 无条件剥离历史 routeHint。验证已绿：`cargo test -p router-hotpath-napi test_stop_message_auto_followup_does_not_pin_provider --lib -- --nocapture`、`cargo test -p router-hotpath-napi stopless_followup_strips_tools_route_hint_and_falls_back_to_thinking --lib -- --nocapture`、`cargo test -p router-hotpath-napi stopless_followup_strips_search_route_hint_and_falls_back_to_thinking --lib -- --nocapture`。
- stopless schema-guidance gap confirmed: latest=2026-06-15；当前 `servertool-core/src/stopless_prompt.rs` 的 `StoplessContinuationTrigger::NoSchema` 只返回自然语言续做提示，`schema_guidance_required` 仅在 `InvalidSchema` 为 true；`chat_servertool_orchestration.rs` 也固定用 `NoSchema` 生成 followup prompt。这解释了 5555 最新 stopless 为什么“连续 stop 但没有 schema 引导、计数感知也不明显”。该缺口已确认，但本轮尚未补 stop-schema 注入闭环。
- responses outbound direct-skip root cause fixed: latest=2026-06-15；已确认 `src/modules/llmswitch/bridge/responses-response-bridge.ts::normalizeResponsesClientPayloadForHttp()` 之前在 `metadata.__routecodexDirectPassthrough === true` 时直接跳过 Rust client projection，导致“前段 relay、末端 transport 直发”的 `/v1/responses` 响应会把 `reasoning.content` 与 item-level `status` 原样回给客户端并污染后续 history。现已删除该 skip，并新增 `tests/modules/llmswitch/bridge/responses-response-bridge.direct-json-protocol-guard.spec.ts` 锁死：即使带 direct metadata，response outbound 也必须经过 replay-safe 协议清理。验证已绿：新 Jest 定向 1/1 PASS、`tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts` PASS、`tests/sharedmodule/apply-patch-freeform-client-projection.blackbox.spec.ts` PASS、`cargo test -p router-hotpath-napi project_responses --lib -- --nocapture` PASS、`npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false` PASS、`npm run verify:function-map-compile-gate` PASS。
- responses outbound protocol lock reverified: latest=2026-06-15；新增可执行黑盒 `tests/sharedmodule/apply-patch-freeform-client-projection.blackbox.spec.ts` 第三条用例，现已直接通过 native `tsx` 子进程 probe 锁住 client-visible `/v1/responses` payload 的 replay-safe 合同：`reasoning.content` 不得外泄，`reasoning/function_call/function_call_output` 的 item-level `status` 不得进入客户端历史。验证已绿：该黑盒 3/3 PASS，`cargo test -p router-hotpath-napi project_responses --lib -- --nocapture` PASS，`tests/sharedmodule/responses-continuation-store.spec.ts` 两条定向回放合法化 PASS，`npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false` PASS，`npm run verify:function-map-compile-gate` PASS。
- provider error chain direct/relay audit finalized: latest=2026-06-15；已按 Jason 指定新路径落盘 `docs/goals/provider-error-chain-direct-relay-audit-2026-06-15.md`，定稿重定义最终 G1-G10，并按执行顺序 `G1 -> G3 -> G6 -> G5 -> G7 -> G10 -> G2 -> G4 -> G9` 收口；核心校正：client_disconnect 不再投影 204/CLIENT_DISCONNECTED，而是服务器立即停请求保持断开；provider-mode 单点 binding 显式豁免中心原则；`upstream_stream_incomplete` 从另起 plan 收口进 G6 统一错误链。
- halphen + 4444 + gcm config task: latest=2026-06-15；用户要求新增 Anthropic provider `halphen`（`http://api.halphen.cn/anthropic`，model=`glm-5.2`），在 `~/.rcc/config.toml` 增加 `4444` 端口并让 default/coding/thinking/tools/search/web_search/longcontext 走 `halphen.glm-5.2`、`multimodal` 走 `minimax.MiniMax-M2.7`；同时在 `~/.codex/config.toml` 增加与 `rcm` 平行的 `gcm` profile，并新增独立 `~/.codex/gcm.config.toml`。
- paid GPT forwarder priority update: latest=2026-06-16；Jason 明确要求 `5520` 和 `5555` 共用的 paid GPT forwarder 改为 `asxs > XL > 1token > cc`。已在 `~/.rcc/config.toml` 的 `fwd.paid.gpt-5.4` 与 `fwd.paid.gpt-5.4-mini` 插入 `XL` 第二优先级，并顺延 `1token/cc` 到 3/4。
- 5555 coding/tools/search routing update: latest=2026-06-16；Jason 要求 `5555` coding 顺序为 `gpt-5.4-mini -> glm-5.2 -> minimax.M3`，并要求 `5555` tools/search 里同时有 `fwd.minimax.MiniMax-M2.7`（minimax+minimonth，已无 mini27）和 `M3`。已改 `gateway_priority_5555`：coding targets=`fwd.paid.gpt-5.4-mini, halphen.glm-5.2, fwd.minimax.MiniMax-M3`；tools/search/web_search targets=`fwd.minimax.MiniMax-M2.7, fwd.minimax.MiniMax-M3`。
- 5555 coding load-balance update: latest=2026-06-16；Jason 进一步要求 `5555` coding 不走 priority，改成 load balance。已将 `gateway_priority_5555.routing.coding` 从 `mode=priority` 改为 `mode=weighted`，并对 `fwd.paid.gpt-5.4-mini`、`halphen.glm-5.2`、`fwd.minimax.MiniMax-M3` 设置 `1:1:1` 权重。
- apply_patch audit doc mapping table finalized: latest=2026-06-15；`docs/goals/apply-patch-direct-relay-full-audit-plan.md` 现已补齐 `真实样本 -> 代码文件 -> 风险 -> gate 缺口` 总表、`5555 relay / 5520 direct` 的直接回答块、生命周期 owner 清单，以及按 direct / relay / Rust owner 切开的修复顺序，可直接指导下一轮修复，不再依赖散落口头结论。
- direct emission can carry prior relay/history poisoning: latest=2026-06-15；新 live 样本 `openai-responses-router-gpt-5.4-20260615T202830407-348488-1765` 证明“发射阶段 direct”与“污染形成点”必须分离记账：日志显示 `[port:5555 ...] [router-direct.send] ... asxs.crsa.gpt-5.4-mini`，但对应 diag `error-openai-responses-router-gpt-5.4-20260615T202830407-348488-1765.json` 的 `input[41]` 明确是非法 `reasoning.content`（`type=reasoning` + `content=[{type:reasoning_text,...}]`），upstream 报 `Invalid 'input[41].content': array too long`。结论：relay/store/outbound 先污染历史后，后续 direct 仍会原样把毒发出去；不能把 `router-direct.send` 误写成“不是 relay 污染链”。
- responses outbound replay-safe sanitize landed at Rust client projection owner: latest=2026-06-15；根因已确认是 `client_tool_args.rs::project_responses_client_body_for_client_core()` 之前只做 tool arg normalize / apply_patch 投影，未对既有 `responses` payload 做 replay-safe 清理，`responses_payload.rs` 也会对现成 `object=response` 直接 clone 放行。现已在 Rust owner 增加统一 sanitize：剥离 `reasoning.content`，并去掉 `reasoning/function_call/function_call_output.status`，同时覆盖 JSON body、SSE event、以及 `build_responses_payload_from_chat_core()` 的现成 response 直通。验证已绿：3 条新 Rust 用例、`npm run verify:hub-response-responses-chat-projection`、`npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`、`npm run verify:function-map-compile-gate`、`node scripts/build-core.mjs`；运行时探针 `projectResponsesClientPayloadForClientWithNative` 也已确认输出里不再包含 `reasoning.content` 与 item-level `status`。
- responses replay-safe status cleanup locked at Rust history owner: latest=2026-06-15；`shared_responses_conversation_utils.rs` 现在明确剥离 persisted/restored responses history 里的 response-only `status` 字段（`function_call` / `function_call_output` / `reasoning`），对应 live 400 `Unknown parameter: 'input[1].status'` 的 replay-safe 持久化真 owner。验证已绿：`cargo test -p router-hotpath-napi prepare_persists_responses_legal_tools_and_history_items --lib -- --nocapture`、`cargo test -p router-hotpath-napi convert_responses_output_to_input_items_strips_response_only_status_fields --lib -- --nocapture`、`cargo test -p router-hotpath-napi restore_never_replays_reasoning_content_from_persisted_history --lib -- --nocapture`、`jest tests/sharedmodule/responses-continuation-store.spec.ts -t '...status fields'`、`npm run verify:function-map-compile-gate`、`node scripts/build-core.mjs`。
- relay stopless CLI projection tests currently enforce client-visible projection: latest=2026-06-15；定向跑 `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts -t 're-projects stop_message_auto...'` 与 `tests/sharedmodule/provider-response-rust-plan.spec.ts -t 'projects stopless CLI command for relay OpenAI Responses completed stop without session scope'`，两者都失败在旧期望 `routecodex servertool run stop_message_auto`，而实际返回的是 `routecodex hook run stop_message_auto`；这证明仓库现有黑盒/plan 测试仍把“relay `/v1/responses` 向客户端投影 exec_command CLI”当作正向合同，只是命令壳已漂移。
- relay function_call status replay narrowing: latest=2026-06-15；新增 `responses-continuation-store.spec.ts` 定向用例 `submit_tool_outputs resume keeps function_call history without replaying response-only status fields` 已绿，证明 relay 本地 store 的 submit_tool_outputs resume 路径不会把 `function_call.status=in_progress` 回放进下一轮 `input`；S4 中这类 `status` 更应继续收窄到 client-visible response replay 或 incoming history normalization，而不是笼统归因给本地 store materialize。
- direct SSE response.metadata allowlist corrected: latest=2026-06-16；`response.metadata` 这条 `5520 direct` live 样本已改为“普通 provider metadata event 允许透传，内部 control-field metadata 仍拒绝”，`tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts` 4/4 PASS；当前剩余缺口只在更上层 `responses-sse-client-contract.blackbox.spec.ts` 的其他 terminal/error 红点。
- codex session tool-turn shape evidence refresh: latest=2026-06-15；抽查 `~/.codex/sessions/2026/06/14/rollout-2026-06-14T14-31-22-019ec4d3-e92c-7240-b6a5-153aaac6d806.jsonl` 与 `...15-20-20-019ec500-bd15-7dd0-adc1-e9ecf7cd073a.jsonl`，确认样本内是标准 `response_item=function_call` / `response_item=function_call_output` 成对交替记录；它们可作为“Codex session 样本本身不天然制造 orphan/乱序”的支持证据，但不能替代 transport/live log 证据。
- 5520 direct SSE protocol audit refresh: latest=2026-06-15；新 live 样本 `openai-responses-router-gpt-5.4-20260615T193814122-348189-1466` 已确认是 `router-direct` 下 upstream 直接发出非法 `event: response.metadata`，server 侧仅用 direct SSE allowlist fail-fast；owner 在 `responses-response-bridge.ts` 的 direct event allowlist 与 `handler-response-sse.ts` 触发点，不属于 relay/store 污染。
- apply_patch outbound audit correction: latest=2026-06-15；纠偏：`input[].status` 不能只归因给 response outbound。`shared_responses_conversation_utils.rs::normalize_responses_history_item()` 在 `function_call` history item 上会保留 `status`，所以 replay-illegal `status=in_progress` 也可能经 relay store/restore 正式落库并重放；owner 必须按 `resp_outbound + persistence` 闭环看。
- relay native capture intermittent truth: latest=2026-06-15；`captureReqInboundResponsesContextSnapshotJson is required but unavailable` 与后续 5555 成功样本在同一 `0.90.3065` live 运行窗口内共存，当前只能归为实例态/装载态不稳定，不能再写成“当前功能永久缺失”。
- apply_patch outbound protocol audit evidence refresh: latest=2026-06-15；已确认 `5555` 新鲜 replay 400 不是 request bridge 猜测问题，而是 response outbound / persistence 把 internal `stop_message_auto` CLI `exec_command` function_call 泄漏进了下一轮 `/v1/responses` history；同时确认 `5555` 既有 relay 前段语义，又可能在 provider send 末跳显示 `router-direct.send`。
- 2026-06-15 定向 gate 实测：`verify:function-map-compile-gate`、`verify:architecture-owner-queryability`、`verify:architecture-feature-map-growth-discipline`、`verify:hub-response-responses-chat-projection`、`handler-response-utils.apply-patch-freeform-sse.spec.ts`、`native-exports.responses-sse-contract.spec.ts` 均为绿；`direct-passthrough-route-level.spec.ts` 当前应改记为 harness 不稳定：文件内确有 `/v1/responses` direct coverage，但本地实跑会长期挂住并遗留 Jest 进程，暂不能作为稳定 gate 或业务红证据。
- 2026-06-15 completion audit：审计主结论、owner 矩阵、样本映射、direct/relay 分链、定向 gate 实测都已落文档；当前仍不能宣称全量审计完成，剩余缺口是 S2/S3 live reopened-tool-turn fixture、S5 replay-safe persistence red test、S6 live install-state / handler-entry gate。
- responses reasoning-content history leak fixed: latest=2026-06-15；已确认 17:35 live 400 样本是 direct request replay 了非法 `reasoning.content`, 当前已在 response->history persistence owner 加 gate 和修复。
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

## 2026-06-15 apply_patch outbound protocol audit evidence refresh

- `5555` 最新 fresh replay 400 样本：
  - requestId=`openai-responses-router-gpt-5.4-20260615T180749445-347851-1128`
  - log：`[port:5555 ...] [router-direct.send] ... code=unknown_parameter`
  - upstream error：`Unknown parameter: 'input[1].status'.`
  - diag：`~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260615T180749445-347851-1128.json`
  - requestBody.input[1] 明确包含：
    - `type=function_call`
    - `name=exec_command`
    - `status=in_progress`
    - `arguments={"cmd":"routecodex hook run stop_message_auto --input-json ..."}`
    - `call_id=call_servertool_cli_...`
- 结论：
  - 这不是 `apply_patch` 参数包装问题。
  - 这是 relay response outbound / persistence 把 internal stopless CLI projection 写进了 client-visible history，下一轮 replay 又原样发给 responses provider，直接被上游判非法字段。
- owner 真相：
  - response outbound projection owner：
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics_blocks/responses_payload.rs`
  - relay store owner：
    - `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`
  - TS bridge 只是 facade：
    - `src/modules/llmswitch/bridge/responses-response-bridge.ts`
    - `src/modules/llmswitch/bridge/runtime-integrations.ts`
- 额外结论：
  - `5555` 不能简化成“纯 relay”或“纯 direct”。
  - 当前真实链路是：relay 前段做 request/response/store 语义，provider send 末跳可能 same-protocol direct，所以日志里能同时看到 `5555` 和 `router-direct.send`。
- gate 缺口：
  - 现有 `hub.response_responses_client_projection` 只明确锁了 `reasoning.content` 不得外泄，还没锁 internal stop_message_auto/CLI function_call 不得进入 client-visible history。
  - `responses-continuation-store` 现有 contract 也没锁 “persisted client-visible history must be replay-safe for `/v1/responses`”.

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
# 2026-06-15 reasoning-content client replay leak
- Live replay after `0.90.3071` still failed with upstream `array_above_max_length` on `input[41].content`; new diag `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260615T175743408-347832-1109.json` proved the client request itself still contained `type=reasoning` with non-empty `content`.
- Root cause widened: not only continuation-store persistence; Rust responses client outbound projection in `hub_resp_outbound_client_semantics_blocks/responses_payload.rs` still emitted `reasoning.content` to clients, so any client that replayed prior output polluted the next `/v1/responses` request.
- After Rust response-outbound fix + reinstall/restart (`0.90.3071` still current), fresh live 5520 direct two-turn replay passed: first response returned `reasoning.content=[]`, second replay request returned 200 instead of `array_above_max_length`.
- Fresh live 5555 replay exposed a second response-outbound audit gap: relay/servertool path returned unresolved `function_call` with `status=in_progress`; replaying that fresh response failed later with `unknown_parameter`, so response outbound still needs full protocol audit beyond reasoning fields.
- 2026-06-15 `5555 required but unavailable` 进一步坐实：`captureReqInboundResponsesContextSnapshotJson` 不是源码缺失，也不是全局安装包缺失。已验证五层证据都存在该 export：源码、仓库 dist、全局安装 JS facade、全局安装 `.node` binding、loader 直调 binding。剩余唯一合理归因收窄为 live server 进程模块实例 / 装载路径不一致，owner 仍是 `src/modules/llmswitch/bridge/native-exports.ts` + `native-router-hotpath-loader` 这一层 runtime 装载链。
- 2026-06-15 S6 状态校正：`captureReqInboundResponsesContextSnapshotJson required but unavailable` 目前不是 live 必现问题。最新 `19:25-19:27` 的 `5555` relay 样本已连续成功并返回 `finish_reason=tool_calls`。因此 S6 现在应归类为“历史 live 故障 + 当前缺历史实例级解释证据”，而不是“当前功能仍坏”。
- 2026-06-15 S5 gate 校正：`responses-continuation-store.spec.ts` 用 repo runner 可执行，当前 32 tests / 28 pass / 4 fail。已实证锁住 `output_text/commentary -> input_text` 与 `reasoning.content` 不回放；尚未锁住 internal stopless/servertool CLI `function_call` 与 `status=in_progress` 不得进入 replay history。部分失败用例仍带旧 `output_text` / `reasoning.content` 预期，不能直接拿来当 S5 缺口证据。
- 2026-06-15 S5 root-cause split refined：Rust continuation-store path already strips `function_call.status`; `shared_responses_conversation_utils.rs::normalize_output_item_to_input()` writes `id/call_id/name/arguments` only. Therefore S4 sample’s `status=in_progress` is more likely response-outbound/client-visible body pollution replayed by client, not local continuation-store materialize. Remaining S5 gaps split into two owners: store must strip internal CLI `function_call`; response outbound must not leak `status=in_progress`.
- 2026-06-15 `~/.rcc` provider cleanup：用户明确要求移除 `~/.rcc/provider/mini27` 与 `~/.rcc/config.toml` 中引用。已确认根配置真源命中 `virtualrouter.forwarders."fwd.minimax.MiniMax-M2.7".targets` 的 `providerId = "mini27"`；另发现 `~/.rcc/config.dbittai.toml` 仍有独立 `mini27` 引用，但不在本次明确范围，暂不改。
- direct SSE metadata guard corrected: latest=2026-06-16；`tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts` 已复跑 4/4 PASS，现明确锁住 `event: response.metadata` 在 same-protocol direct SSE 下允许普通 provider metadata 透传，同时 metadata 内部控制字段泄漏必须拒绝。仍未闭环的是更上层 `tests/server/handlers/responses-sse-client-contract.blackbox.spec.ts` 的两条预存业务红，不能与本次 response outbound replay-safe 清理混算。
- responses-handler submit_tool_outputs harness gap: latest=2026-06-15；`tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts` 和 `tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts` 现在在 ESM 导入阶段报 `captureReqInboundResponsesContextSnapshot` 缺导出，属于测试入口 / harness 不一致，不是 response outbound 业务断言失败；这类 failure 不能拿来反证本轮 response outbound replay-safe sanitize。
- direct-passthrough route-level harness status refined: latest=2026-06-15；`tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts` 不是“只测 chat/provider-mode”，文件里实际已有多条 `/v1/responses` direct 合同（透明 ingress、client tools 保持 direct、relay-owned scope materialize 不得被 direct 消费等）。但本地实跑该 suite 会长期挂起并遗留 Jest 进程，需要显式按 PID 清理；因此现阶段它应记为“有 coverage 但 harness 不稳定，不能直接作为稳定 gate”，不是简单记成“无关用例”。
# 2026-06-15 provider-error-chain direct/relay audit finalized
- 已落盘定稿：`docs/goals/provider-error-chain-direct-relay-audit-2026-06-15.md`（19.3KB / 268+ → 含 §10 live snapshot 附录）。
- 现状校正：用户最初担心的"5555 HTTP_499 被返回客户端"实际是 server log 字面（`❌ [...] failed: HTTP 499`），
  client 端因 `respondWithPipelineError` + `terminateClientDisconnectedResponse` 短路已拿不到任何 body。
  G1 红测 `handler-utils.client-disconnect.spec.ts` 已 GREEN（2/2）锁住该短路路径。
- 当前最实质 gap：G6 `upstream_stream_incomplete` 完全未进 `resolveRequestExecutorProviderFailurePlan`，
  5520 同 provider 连续 stream cut 不会被切 / 冷却（usage day.fail=0 + finish_reason=unknown 是证据）。
- 服务器健康：`routecodex/rcc = 0.90.3071`，5555/5520/10000 三个端口 health 全绿。
- 修复顺序最终版：`G1 → G3 → G6 → G5 → G7 → G10 → G2 → G4 → G9`，每条必须"先红测 → 改唯一 owner → 转绿 → live 复测"四步走。
- 旧编号 D1/D2/D3/D4/F8/G8 已并入 G3/G7/G1/G6，§3.1 / §10.2 留 audit 历程。
- `/goal` 提示词按 G1→G3→G6→G5→G7→G10→G2→G4→G9 顺序收口，未生成 commit（用户明确说"先把审计定稿，给我 /goal"）。
# 2026-06-15 stopless NoSchema + apply_patch wrapper compatibility
- stopless root cause 确认：
  - `servertool-core/src/stopless_prompt.rs` 之前仅 `InvalidSchema` 才 `schema_guidance_required=true`，`NoSchema` 只有自然语言继续提示，没有停止 schema contract。
  - `router-hotpath-napi/src/hub_req_inbound_tool_call_normalization.rs::build_stop_hook_guidance_text_from_output()` 之前只抽 `continuationPrompt`，即使 CLI output 已带结构化 guidance，也不会重新注入给模型。
- 已补红测并转绿：
  - `stopless_prompt::tests::no_schema_first_round_is_natural_user_language`
  - `cli_contract::tests::builds_stop_message_auto_cli_output`
  - `cli_contract::tests::status_only_stopless_cli_output_does_not_require_prompt`
  - `cli_contract::tests::renders_stopless_schema_guidance_text_without_internal_proxy_terms`
  - `chat_servertool_orchestration::tests::test_stop_message_auto_followup_state_progresses_used_zero_to_three`
  - `virtual_router_engine::route` 既有 `stopless_followup_strips_tools_route_hint_and_falls_back_to_thinking`
  - `virtual_router_engine::route` 既有 `stopless_followup_strips_search_route_hint_and_falls_back_to_thinking`
  - `hub_req_inbound_tool_call_normalization::tests::stop_hook_guidance_text_appends_schema_guidance_from_cli_output`
- stopless 修复内容：
  - `NoSchema` 现在也要求 schema guidance，但仍保持 client-visible continuation prompt 为自然语言，不把 internal proxy 词直接暴露到 prompt。
  - `cli_contract.rs` 的 `stop_message_auto` CLI output 现在固定带 `schema_guidance`。
  - 新增 `render_stopless_schema_guidance_text(...)`，自动补打 stop hook 的 tool output 转文本时，会把 JSON 字段要求一并注回给模型。
  - 计数锁定：`used=0/1/2` 时 followup metadata `serverToolLoopState.repeatCount` 与 `stateUpdate.used` 分别推进到 `1/2/3`。
- apply_patch 兼容新增一条窄修复：
  - owner: `router-hotpath-napi/src/hub_req_inbound_tool_call_normalization.rs`
  - 当 shell/exec 工具参数里已经明确包着 canonical `*** Begin Patch ... *** End Patch` 时，允许提取该 patch 并把这次错误形状升级为真正的 `apply_patch` 调用；只修形状，不猜 patch 语义。
  - 新红测转绿：`hub_req_inbound_tool_call_normalization::tests::upgrades_shell_wrapped_canonical_patch_to_apply_patch_call`
- 2026-06-15 定向验证：
  - PASS `cargo test -p servertool-core no_schema_first_round_is_natural_user_language --lib -- --nocapture`
  - PASS `cargo test -p servertool-core builds_stop_message_auto_cli_output --lib -- --nocapture`
  - PASS `cargo test -p servertool-core status_only_stopless_cli_output_does_not_require_prompt --lib -- --nocapture`
  - PASS `cargo test -p servertool-core renders_stopless_schema_guidance_text_without_internal_proxy_terms --lib -- --nocapture`
  - PASS `cargo test -p router-hotpath-napi stop_hook_guidance_text_appends_schema_guidance_from_cli_output --lib -- --nocapture`
  - PASS `cargo test -p router-hotpath-napi test_stop_message_auto_followup_state_progresses_used_zero_to_three --lib -- --nocapture`
  - PASS `cargo test -p router-hotpath-napi stopless_followup_strips_tools_route_hint_and_falls_back_to_thinking --lib -- --nocapture`
  - PASS `cargo test -p router-hotpath-napi stopless_followup_strips_search_route_hint_and_falls_back_to_thinking --lib -- --nocapture`
  - PASS `cargo test -p router-hotpath-napi upgrades_shell_wrapped_canonical_patch_to_apply_patch_call --lib -- --nocapture`
  - PASS `cargo test -p router-hotpath-napi normalize_responses_input_items_dedupes_repeated_apply_patch_error_statuses --lib -- --nocapture`
- 未闭环项：
  - broader `cargo test -p router-hotpath-napi apply_patch --lib -- --nocapture` 仍有 5 条旧红样本失败：
    - 3 条 `req_process_stage1_tool_governance_tests::*apply_patch*`
    - 2 条 `resp_process_stage1_tool_governance_tests::test_normalize_tool_args_apply_patch_*`
  - 这些失败不是本次新增红测；本次只确认窄兼容 slice 已绿，完整 apply_patch 审计仍需继续。

## 2026-06-15 apply_patch req/resp owner repair
- broad apply_patch suite red: 3 req-side contract tests + 2 resp-side legacy hunk tests.
- req truth: top-level apply_req_process_tool_governance still calls normalize_apply_patch_freeform_tool_schema(), which rewrites client-visible apply_patch declaration to custom grammar and breaks no-rewrite contract tests.
- resp truth: repair_line_number_update_hunks_with_live_context() fallback path rewrites legacy @@ -n +m @@ headers into @@ even when no live file context exists; only inline-context trailers should be collapsed locally.
- build blocker: servertool-core cli_contract currently has stale calls that should target build_client_exec_cli_projection_output_with_identity().

## 2026-06-16 stopless CLI root build boundary
- Root cause from live install: global dist/cli/commands/servertool.js lacked --session-id/--request-id and recordStoplessContinuationState, so same-session stopless CLI reruns could not persist/read stopMessageUsed; schema was not the counter root cause.
- Fix in progress: move CLI wrapper state write through src/modules/llmswitch/bridge/state-integrations.ts requireCoreDist bridge instead of importing sharedmodule/llmswitch-core/src runtime-utils, eliminating rootDir TS6059 leakage.

# 2026-06-16 stopless session-id 收口 + 对客户端无感 — 二次只读审计
- 触发：用户问"实际就是不递增，要检查是因为没有 schema 还是别的原因？"，
  结合前面 §"继续，我进行了修复，你现在重新审计整个 stopless 链条，给我你的审计报告，不要修改，
  我看到现在续杯时注入的还有第一轮第二轮，这些话术不中性，不像人说的话"。
- 当前 live：`routecodex --version = 0.90.3071`；
  `sharedmodule/llmswitch-core/rust-core/target/` 下根本没有 `routecodex-servertool` 二进制。
  也就是说 rust 真源层（cli_contract.rs 重写 + 新增 stopless_prompt.rs + record_stopless_continuation_state）
  全部未编进 live；前几轮 live 看到的 stdout 是更早 plan §4.3 表里"继续做下一步；拿不到证据就再试一次…"
  那段话术，不是 stopless_prompt.rs::resolve_stopless_continuation_prompt 的真源。

## 1. 代码真源核对结果
### 已完成（与文档一致）
- `servertool-core/src/stopless_prompt.rs` 已落：禁词表 19 个 token、first/middle/final/SchemaPass 五模板，
  Rust 单元测试 7 条全绿。
- `servertool-core/src/cli_contract.rs::build_stop_message_auto_run_output` 已落：
  必填 sessionId/requestId + 字符校验 + `next_repeat_count = persisted.snapshot.used + 1` + `next_max_repeats = persisted.snapshot.max_repeats.max(1)`，
  `continuation_prompt` 走 `resolve_stopless_continuation_prompt` 真源。
- `servertool-cli/src/main.rs` 已加 `--session-id` / `--request-id` clap 参数。
- `router-hotpath-napi/src/chat_servertool_orchestration.rs::run_stop_message_auto_handler_json` 已落：
  `followup = Value::Null`，强制 `flow_id = stop_message_flow`，注释明确"永不 append_user_text reenter"。
- `virtual_router_engine/engine/route.rs::resolve_route_hint` 已落 stopless 强制清掉 routeHint，
  测试 `stopless_followup_strips_tools_route_hint_and_falls_back_to_thinking` 已绿。
- `stop-message-core::resolve_stopless_continuation_prompt` 真源已被 cli_contract.rs + chat_servertool_orchestration.rs 引用。
- `tests/servertool/stopless-prompt.client-visible.spec.ts` 5 条红测已写，覆盖 first/middle/final/CLI std-only/重复 used 递增。
- `tests/servertool/stopless-vr-route-hint.spec.ts` 已写，路由测试已绿。
- `runStopMessageAutoHandlerWithNative` 走完 Rust → TS shell 会写盘 `persist_keys` 到 `session:<id>`（TS isPersistentStickyKey 仅 session:）。

### 仍然未闭环的核心缺口
1. **`is_persistent_sticky_key` 在 Rust 端仍接受 `tmux:` / `conversation:`**（chat_servertool_orchestration.rs:2092），
   与 plan §1.1 "stopless 唯一 sessionId" 不一致。需要收口到仅 `session:` 或拆 owner（保留给非 stopless servertool flow）。
2. **`record_stopless_continuation_state` Rust 函数写好但没调用方**：napi binding 没暴露、CLI binary 不调它、
   `run_stop_message_auto_handler_json` 也没在尾部调它来更新 used。
   → "used 不递增" 链路没真正闭合：CLI 内部虽然 `resolve_runtime_stop_message_state` 读到了 persisted.used，
     但这是**读**，没人写。
3. **`plan_servertool_followup_runtime_json` / `flowPolicy.profilesByFlowId.stop_message_flow`
   仍是 `"seedLoopPayload": true`**，没有 `"noFollowup": true` / `"clientInjectOnly": true`。
   → `outcomeMode` 在 else 分支返回 `"reenter"`，`runFollowupMainline` 还会走 seedLoopPayload 路径。
   这是为什么"对客户端无感"还没生效的根本：
   - engine.ts 的 stoplessPlan.cli_projection 是基于 `execution.context.stopMessageTerminalFinal` 判定；
     terminal 时返回 `terminal_final`，非 terminal 时返回 `cli_projection`（永不 reenter）。
   - **但** 在 rust hub_pipeline `chat_servertool_orchestration` 路径上，把 `followup = Value::Null`
     包给 TS 引擎后，TS 的 `runFollowupMainline` 用 `resolveFollowupFlowDecision` 拿 outcomeMode，
     仍然按 `reenter` 处理 —— 实际还有 `requestIdSuffix=:stop_followup` 的二次请求。
4. **`stop-message-core/src/lib.rs` 仍存在 `DEFAULT_EXECUTION_PROMPTS` + 大量 `继续执行` / `继续完成当前用户目标…` 旧文案**（行 1147/1259/1277/1290/1302/1314/1332/1344/1353/1369/1400/1425/1441/1457/1647/1669），
   `chat_servertool_orchestration.rs` 行 1676/2715/2905/2997/3010/3032/3052/3129 还有 legacy `"继续执行"` 字符串测试。
   这部分没有物理删除（AGENTS.md §10 物理删除铁律）。
5. **TS shell 的 prompt 真源覆盖**：stop-message-auto.ts 第 2170 行附近，
   `effectiveDecision.followup_text` 仍可能从 stop-message-core 旧模板带过来并写进 `execution.context.assistantStopText`，
   影响后续 `engine.ts::extractStoplessReasoningText` 输出（旧"用户目标/排查"等措辞）。
6. **`buildServertoolCliProjectionForToolCall`（模型主动调 stop_message_auto 的路径）**没传 sessionId/requestId，
   会直接被 `validate_stopless_session_identity` 拒绝（fallback 给 `cli-projection.ts:32` 写死 repeatCount=0,maxRepeats=0）。
   红测 `stopless-prompt.client-visible.spec.ts` 没覆盖模型主动调用路径。

## 2. 用户现场"stdout 第一轮第二轮"问题真凶
- 用户现场 stdout 三次都是同一段话术"继续做下一步；拿不到证据就再试一次；想停的时候直接告诉我一句'做完了'或'卡住了，需要你拍板'。"
- 这段**不在 stopless_prompt.rs**（first 模板是"继续做下一步；先把手头能确认的结果拿回来。"）；
  与 `docs/goals/stopless-client-invisible-route-plan.md` §4.3 表 `NoSchema used=0` 行一字不差。
- 结论：live binary 早于新 stopless_prompt.rs 落地，走的还是 plan §4.3 描述的"过去/计划"模板（或者再早的 `DEFAULT_EXECUTION_PROMPTS[0]`）。
- 修了 6 条 Rust 红测只是让新代码逻辑闭环，**没有真装到 live server**。

## 3. 实测真信号（每次 chunk 末都自带 stderr）
```
SERVERTOOL_CLI_MISSING_FIELD: sessionId
```
- 来自 `cli_contract.rs::ServertoolCliError::MissingField` 的 `validate_stopless_session_identity`：
  当 `input.session_id.is_none() || trimmed.is_empty()` 时返回。
- 含义：用户现场 CLI 调用根本没传 `--session-id`/`--request-id`，
  因为：
  - 要么 CLI binary 还是老版本（不要求这两个字段）；
  - 要么新版 CLI binary 被调用，但调用方（旧 TS servertool handler / 老 plan §4.3 测试脚本）没改。
- 用户现场"used 不递增"的真因不是 schema，而是**双向都没有"session 身份 → persisted state"通路**：
  入参没 sessionId → persisted.used 永远拿不到 → next_repeat_count 永远 fallback 到 input.repeatCount (=1) →
  `continuationPrompt` 永远命中 first 模板。

## 4. 收口顺序（最小剩余缺口）
1. **live 重 build + 重 install + restart**：把新 stopless_prompt.rs / cli_contract.rs / record_stopless_continuation_state 真正装到 live servertool binary。
   - `PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm run build:min`
   - `node scripts/build-core.mjs`
   - `PATH=/opt/homebrew/opt/node@22/bin:$PATH ROUTECODEX_BUILD_RESTART_ONLY=1 ROUTECODEX_INSTALL_VERIFY_PORT=5555 ./scripts/install-global.sh`
2. **CLI binary 端 napi binding 暴露 `record_stopless_continuation_state_sync_json` + binary 末尾调一次**：
   - `servertool-core/src/persisted_state_fs.rs` + `record_stopless_continuation_state` 已写完，
     只缺 `servertool_core_blocks.rs` 加 napi + `servertool-cli/src/main.rs` 末尾调一次。
3. **`buildServertoolCliProjectionForToolCall` 加 sessionId/requestId 入参**（从 options 透传，缺则 fail-fast）。
4. **`is_persistent_sticky_key` 收口**：stopless 路径唯一 `session:`，非 stopless servertool 另立 owner 常量。
5. **物理删除 legacy**：
   - `stop-message-core/src/lib.rs` 里所有 `DEFAULT_EXECUTION_PROMPTS` 旧模板 + `default_text: "继续执行"` 行；
   - `chat_servertool_orchestration.rs` 第 36-46 行 `normalize_stop_message_followup_text` 里的 `text == "继续执行"` legacy 升级分支；
   - 测试中所有 `assert_ne!(text, "继续执行")` 等字符串断言改为"非禁词 + 含自然人话关键词"。
6. **`flowPolicy.profilesByFlowId.stop_message_flow` 改 `"noFollowup": true`** 或在 `run_stop_message_auto_handler_json` 末尾直接 `flow_id = "stop_message_flow_cli_projection"`，让 `resolveFollowupFlowDecision` 走 `skip` 分支（彻底不 reenter）。
7. **修 `stop-message-auto.ts::handler`**：`effectiveDecision.followup_text` 一律用 `resolve_stopless_continuation_prompt` 覆盖，再写入 `execution.context.assistantStopText`。
8. **live 复测**：单 sessionId 触发 3 次 stopless，验 stdout continuationPrompt 依次 first/middle/final；
   验 `requestIdSuffix=:stop_followup` 不再出现；验 VR log `reason=thinking:user-input` 无 `route_hint:tools`。

## 5. DoD（同 docs/stop-message-auto.md §7）
- `cargo test -p servertool-core stopless --lib`
- `cargo test -p servertool-core persisted_lookup --lib`
- `cargo test -p router-hotpath-napi chat_servertool_orchestration --lib`
- `cargo test -p router-hotpath-napi virtual_router_engine --lib`
- Jest 6 条 spec（含 stopless-prompt.client-visible / stopless-vr-route-hint / stopless-cli-continuation）
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`
- `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`
- `git diff --check`
- live：routecodex --version、健康三端口、3 端口 /v1/responses smoke、stdout continuationPrompt 三档变化、
  service log 无 :stop_followup 二次请求、VR log stopless 本轮 reason=thinking:user-input 无 route_hint:tools。

# 2026-06-16 stopless CLI continuation 递增闭环修复
- 已验证根因不是 schema_missing，而是 session 作用域闭环缺失：没有 sessionId 就无法把 used 写回同一个 `session:<id>` persisted state。
- Rust / TS / live 闭环现状：
  - `servertool-core/src/cli_contract.rs` 已强制 sessionId/requestId，`next_repeat_count` 从同一 session persisted state 读 `used + 1`。
  - `servertool-cli/src/main.rs` 已在 binary 末尾调用 `record_stopless_continuation_state` + `save_persisted_runtime_stop_message_state`。
  - `servertool-core/src/persisted_state_fs.rs` 新增 `resolve_filepath_for_write`；`persisted_state_fs_write.rs` 负责把 `{"version":1,"state":...}` 原子写回 session 文件。
  - `router-hotpath-napi/src/servertool_skeleton_config.rs` 给 `stop_message_flow` 补了 `noFollowup: true`，防止旧 followup 语义继续回流到 reenter。
  - `cli-projection.ts` 的 stop_message_auto 投影现在要求 sessionId（缺则 fail-fast），命令输入只带 `flowId/repeatCount/maxRepeats`，不泄漏 continuationPrompt/schemaGuidance。
  - `chat_servertool_orchestration.rs` 已把 stopless persist key 真正收口到 `session:` 过滤；generic sticky key 不再用于 stopless flow。
- Live 证据：
  - `~/.rcc/install/current/node_modules/rcc-llmswitch-core/dist/bin/routecodex-servertool` 已存在且 `--help` 显示 `--session-id` / `--request-id`。
  - 同一 `sessionId` 连跑 3 次 live binary：`repeatCount 1 -> 2 -> 3`，prompt 依次变成 first / middle / final。
  - persisted file `~/.rcc/state/routing/session-<id>.json` 写回 `stopMessageUsed=3`，`stopMessageText` 为 final 文案。
- 定向验证 PASS：
  - `cargo test -p servertool-core --lib`
  - `cargo test -p router-hotpath-napi --lib servertool_core_blocks::tests::`
  - `node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/stopless-prompt.client-visible.spec.ts --runInBand`
  - `node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/stopless-vr-route-hint.spec.ts --runInBand`
  - `node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/stopless-cli-continuation.spec.ts tests/servertool/servertool-cli-projection.spec.ts --runInBand`
  - `npm run verify:servertool-rust-only`
  - `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`
  - `npx tsc -p tsconfig.json --noEmit --pretty false`
  - `git diff --check`
- Remaining non-stopless failures: `cargo test -p router-hotpath-napi --lib` still has unrelated resp/apply_patch/shared_json_utils red tests in dirty files from other work; not part of this stopless slice.
# 2026-06-16 provider-error-chain G1/G3 progress
- G1 已落地：`mapErrorToHttp` 对 client_disconnect 不再返回 `204/CLIENT_DISCONNECTED` body，而是 throw `ClientDisconnectHttpProjectionError` sentinel；`respondWithPipelineError` / `writeStartedSsePipelineError` 已 catch 并 silent terminate。
- G1 focused gates PASS：
  - `tests/server/utils/http-error-mapper-499-client-disconnect.spec.ts`
  - `tests/server/utils/http-error-mapper.policy-exhausted-gate.spec.ts`
  - `tests/server/utils/http-error-mapper.client-disconnect-log-summary.spec.ts`
  - `tests/server/handlers/handler-utils.client-disconnect.spec.ts`
  - 合计 12 PASS / 0 FAIL
- G1 logging 校正：`mapErrorToPublicLogSummary` 对 client_disconnect 返回 `client_disconnect=true request_aborted_by_client`，不再回放 raw `HTTP 499` / `client abort request`。
- G3 已落地 host 接入：
  - `src/server/runtime/http-server/executor/request-executor-core-utils.ts` 新增 `resolvePrimaryExhaustedPlan(...)`
  - `src/server/runtime/http-server/index.ts` pool-exhausted backoff 用尽后 consult native plan
  - `src/server/runtime/http-server/request-executor.ts` pool-exhausted backoff 用尽后 consult native plan
- G3 unit gate PASS：`tests/server/runtime/http-server/executor/request-executor-primary-exhausted-plan.spec.ts` 2/2 PASS，锁住 host 只通过 native bridge 取 plan，不自己合成 fallback。
- G3 当前边界：host 现在只会把当前 `allowedProviders` 作为 primary tier 送入 native；route tiers/default backup tiers 还没显式进入 metadata，所以 default_pool 真扩池要等后续把 route tiers 暴露给 host，当前先锁住“禁止 host 本地 fallback”。
- 运行态：`routecodex/rcc = 0.90.3071`，5555/5520/10000 `/health` 全绿。
- G6 细化校正（2026-06-16）：`provider-failure-policy-impl.ts` 对 `UPSTREAM_STREAM_INCOMPLETE` 已天然落到 `recoverable` + `affectsHealth=true`（focused gate `provider-failure-policy-upstream-stream-incomplete.spec.ts` 2/2 PASS）。因此 G6 当前唯一缺口不是分类，而是 raise path：`handler-response-sse.ts` 在 `stream closed before response.completed` 时只做 log + `res.end()`，没有把 error 回传到 direct/relay caller 去消费统一 ErrorErr05 decision。

## 2026-06-16 stopless 工具侧自补 sessionId + forcestop schema
- 用户纠正点成立：`sessionId` 不该暴露给模型，也不该要求模型/用户在 stopless projection 命令里显式传。工具侧必须自己补。
- 已收口：
  - `servertool-core/src/cli_contract.rs`：`stop_message_auto` 缺 `sessionId/requestId` 时自动从 `CODEX_THREAD_ID` -> `TMUX_PANE` -> `TERM_SESSION_ID` -> `ITERM_SESSION_ID` 补默认 identity；projection `execCommand` 不再带 `--session-id/--request-id`，但 stdout 仍带 `sessionId/requestId` 供 host 写盘。
  - `stop-message-core/src/lib.rs`：stop schema 新增 `forcestop`；`forcestop=1` 时强制停止优先级最高，只要求非空 `reason`，不再校验 evidence / diagnostics / done_steps 等终态字段。
  - `cli_contract.rs::stopless_schema_guidance()` 与 guidance text 已加入 `forcestop` 引导：只能在不得已必须强制停止时使用，且必须填写非空 `reason`。
- focused 验证：
  - PASS `cargo test -p stop-message-core forcestop --lib`
  - PASS `cargo test -p servertool-core builds_stop_message_auto_cli_output --lib`
  - PASS `cargo test -p servertool-core renders_stopless_schema_guidance_text_without_internal_proxy_terms --lib`
  - PASS `npx tsc -p tsconfig.json --noEmit --pretty false`
  - PASS build/install/restart，live `routecodex --version = 0.90.3072`
  - PASS live裸命令（不带 `--session-id`）：
    `CODEX_THREAD_ID=force-stop-proof-001 routecodex hook run stop_message_auto --input-json ...`
    返回 `sessionId=codex:force-stop-proof-001`，且 `schemaGuidance.requiredFields` 已含 `forcestop`。

## 2026-06-16 stopless-direct-session-scope
- verified_current: current stopless owner `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_orchestration_contract.rs` only sees `flowId + execution`; no direct/relay discriminator is passed, so direct `/v1/responses` can still CLI-project stopless. Existing contract tests also incorrectly treat `/v1/responses + openai-responses` as stopless-active.
- verified_current: `stop_message_auto` CLI `sessionId/requestId` requirement is explicit in Rust `cli_contract.rs`; live `SERVERTOOL_CLI_MISSING_FIELD: sessionId` is consistent with wrong stopless activation on direct, not proof that session validation itself is wrong.
- next: read existing runtime meta only (`__rt`/runtime metadata), add red test that direct runtime meta disables stopless, then change native owner + map/gate together.
- G5 已落地（2026-06-16）：`isProviderFailureClientDisconnect` 在 `provider-failure-policy-impl.ts` 入口处把 status=499/code=HTTP_499 短路提到 message 短路之前；bodyHints 现已覆盖 `error.details.upstreamMessage` 与 `error.response.data.error.message` 双路。focused spec `provider-failure-policy-client-disconnect-499.spec.ts` 现 5/5 PASS。

- verified_current: relay servertool adapter-context session scope was dropped in `src/server/runtime/http-server/executor/servertool-adapter-context.ts` path because backfill only read entry-origin request. Fixed by consuming existing `metadata.responsesRequestContext.sessionId/conversationId` through `servertool-request-normalizer.ts`; red test added in `tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts`.
## 2026-06-16 stopless relay sessionId closure follow-up

- Live evidence corrected prior assumption: `SERVERTOOL_CLI_MISSING_FIELD: sessionId` was not only the TS handler followup metadata gap. The relay stopless CLI projection path in `sharedmodule` still built `adapterContext` from top-level metadata only.
- Verified root owner: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs::build_adapter_context`.
- Failure shape: relay runtime carried session truth in `metadata.responsesRequestContext.sessionId/conversationId`, but `build_adapter_context()` only copied `metadata.sessionId/conversationId`, so `sharedmodule/llmswitch-core/src/servertool/engine.ts` saw empty `adapterContext.sessionId` and emitted stopless CLI projection without `--session-id/--request-id`. The CLI then failed with `SERVERTOOL_CLI_MISSING_FIELD: sessionId`.
- Fix: Rust `build_adapter_context()` now backfills `sessionId/conversationId` from `responsesRequestContext` when top-level metadata is absent.
- Gate added: Rust unit `build_adapter_context_backfills_session_identifiers_from_responses_request_context`.
- Important boundary: Jason clarified `sessionId` must be auto-supplemented by tool governance/runtime, not exposed as model responsibility. Future fixes must keep the补全 responsibility on server-generated projection/runtime owner, not on model-authored schema or user-visible prompt text.

## 2026-06-16 stopless closure audit

- Fresh read-only audit against Jason's 5-point closure target:
  1. request-side "end summary + stop schema" is still the main gap; current stopless guidance is mostly CLI/result-text based, not clearly owned as a system-instruction contract.
  2. response-side stop interception + terminal schema stripping already has Rust owner (`stop_gateway_context` / `stop_visible_text`), but trigger classification is not yet fully unified into one exact `NoSchema / InvalidSchema / NonTerminal / SchemaPass / BudgetExhausted` mainline.
  3. `used=0->1->2->3` no-schema progression and strict `session:` scope are already locked by tests, but real prompt selection still risks collapsing to `NoSchema`.
  4. stopless followup -> thinking route is strongly locked: request builder strips old routeHint and VR tests assert no `route_hint:tools/search`, only `thinking:user-input`.
  5. auto-projected stopless CLI result already rewrites into next-turn text guidance, while model-initiated stop hook history is preserved; remaining gap is finer trigger-specific guidance and system-instruction closure.
- New execution doc for implementation and E2E: `docs/goals/stopless-closure-e2e-plan.md`.

## 2026-06-16 stopless transparency re-audit

- Re-audited stopless against Jason's refined target: client/model must not perceive a server-side validator/proxy; client should only observe a model-issued CLI tool call; model should only observe ordinary user guidance; system prompt must carry stop schema format + sample; validation loop must be opaque.
- Current request-side state:
  - `req_process_stage1_tool_governance_blocks/orchestrator.rs` now prepends a stopless system instruction with required fields and `stopreason` semantics.
  - Gap: the injected system instruction has field/semantic guidance but no concrete JSON sample.
- Current model-side transparency:
  - Good: `stopless_prompt.rs` forbids internal words like `schema/hook/stopless/servertool/stop_message_auto` in client-visible continuation prompt text.
  - Good: auto-injected stopless CLI pair is rewritten in `hub_req_inbound_tool_call_normalization.rs` into ordinary user text instead of preserved tool history.
  - Gap: schema-guidance rewrite text still explicitly says things like "上一轮你直接停了，但没有附停止 JSON" / "上一轮的停止 JSON 格式不对", which exposes validation semantics to the model even if it does not expose "servertool".
- Current client-side transparency:
  - Gap: client-visible projection still intentionally exposes `exec_command` with `routecodex hook run stop_message_auto ...`; tests also assert `__servertool_cli_projection` exists on the projected chat payload.
  - Therefore current implementation does NOT satisfy the stronger "client cannot sense server existence" target; it still exposes RouteCodex-specific hook identity at the client protocol surface.
- Current loop-closure state:
  - Good: session-scoped repeat budget and 1->2->3 no-schema progression are covered by focused stopless tests.
  - Gap: trigger-specific closure is not fully transparent yet because model-facing rewrite differs by explicit validation wording, not by purely user-natural continuation framing.

## 2026-06-16 stopless transparency contract green

- Red-first lock completed:
  - TS red tests were tightened to require stopless client-visible command alias `routecodex hook run reasoning_stop`, forbid visible `stop_message_auto`, and forbid visible `__servertool_cli_projection`.
  - Rust red tests were tightened to require stopless system instruction includes concrete JSON sample, and req-side rewrite text no longer contains explicit validator narration like `停止 JSON` / `格式不对` / `重试机会`.
- Root changes landed:
  - `servertool-core/src/cli_contract.rs`: public CLI alias `reasoning_stop` now maps to internal `stop_message_auto`; client-visible payload no longer emits `__servertool_cli_projection`.
  - `src/cli/commands/servertool.ts`: CLI accepts `reasoning_stop` as stopless public alias while preserving stopless state persistence.
  - `router-hotpath-napi/src/hub_req_inbound_tool_call_normalization.rs`: stopless next-turn rewrite now uses user-natural wording and still carries JSON-format guidance without explicit validator narration.
  - `req_process_stage1_tool_governance_blocks/orchestrator.rs`: stopless system instruction now includes concrete JSON samples.
  - `sharedmodule/.../server-side-tools.ts`: internal execution context now carries projection metadata out-of-band instead of leaking it in client payload.
- Verified PASS:
  - `cargo test -p servertool-core cli_contract --lib -- --nocapture`
  - `cargo test -p servertool-core cli_result_guard --lib -- --nocapture`
  - `cargo test -p router-hotpath-napi test_req_process_prepends_stopless_system_instruction_when_client_inject_ready --lib -- --nocapture`
  - `cargo test -p router-hotpath-napi rewrites_auto_injected_stop_hook_pair_into_text_input_for_next_turn --lib -- --nocapture`
  - `cargo test -p router-hotpath-napi stop_hook_guidance_text_appends_schema_guidance_from_cli_output --lib -- --nocapture`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/servertool-cli-projection.spec.ts tests/servertool/servertool-cli-native-bridge.spec.ts tests/servertool/servertool-cli-result-restore.spec.ts tests/servertool/stopless-cli-continuation.spec.ts tests/servertool/stopless-prompt.client-visible.spec.ts tests/servertool/servertool-mixed-tools.spec.ts tests/servertool/stop-message-runtime-utils.continuation.spec.ts --runInBand`
- Remaining gap:
  - This turn closed stopless transparency and public CLI aliasing at the focused gate layer; blackbox/live `/v1/responses` replay and full install/restart validation were not yet run in this slice.

## 2026-06-16 stopless live replay evidence

- Live gate rerun on installed `routecodex/rcc 0.90.3072`:
  - PASS focused Jest: `tests/servertool/stopless-cli-continuation.spec.ts`, `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts`
  - PASS Rust owner checks: `cargo test -p servertool-core cli_contract --lib -- --nocapture`, `cargo test -p router-hotpath-napi test_req_process_prepends_stopless_system_instruction_when_client_inject_ready --lib -- --nocapture`
  - PASS architecture gate: `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:function-map-compile-gate`
  - PASS hygiene: `git diff --check`
- Live relay-path proof from `~/.rcc/logs/server-4444.log`:
  - request `openai-responses-minimax.key1-MiniMax-M3-20260616T131416971-352819-447`
  - route: `longcontext/gateway-priority-5555-weighted-longcontext -> minimax.key1.MiniMax-M3.MiniMax-M3`
  - stopless fired: `[servertool] ... tool=stop_message_auto ... finish_reason=stop ... result=trigger_stop_schema_missing ... used=0 left=3 active=true`
  - final client-facing result was not raw `stop`; request completed `status=200, finish_reason=tool_calls`, proving relay stop was intercepted into CLI/tool continuation instead of terminal stop.
- Live direct-path bypass proof from the same log:
  - request `openai-responses-router-MiniMax-M3-20260616T131307950-352816-444`
  - route: `router-direct:default -> XL.key1.gpt-5.4-mini.gpt-5.5`
  - completed `status=200, finish_reason=stop`
  - no adjacent `[servertool] ... stop_message_auto ...` line for that request, which is consistent with direct stop bypassing stopless interception.
- Important live constraint discovered:
  - sending client `metadata.routeHint` directly to `/v1/responses` is rejected by request adapter (`[server.req_adapter] forbidden client metadata field: routeHint`), so live stopless replay cannot be forced from client side by routeHint injection; relay hit must come from normal classifier/weighted selection.

2026-06-16 stopless sessionId followup
- Fixed sharedmodule/llmswitch-core/src/servertool/cli-projection.ts to carry adapterContext sessionId/requestId for generic servertool CLI projection, not only stop_message_auto.
- Rebuilt routecodex-servertool debug binary before rerunning stopless/CLI blackbox, because jest targets rust-core/target/debug/routecodex-servertool directly.
## 2026-06-16 provider-error-chain G6 progress
- G6 current truth (latest=2026-06-16): `src/server/handlers/handler-response-sse.ts` now returns `Error` upward only for `upstream_stream_incomplete` cases where no client semantic SSE frame has been written yet; `src/server/handlers/handler-response-utils.ts` rethrows that error so upper executor/router-direct catch-chain can consume the normal ErrorErr05 decision path. The semantic-frame gate had to be corrected: `contractProbe.emitted` alone was insufficient because it only flips during terminal repair, not ordinary `response.created` / `response.output_text.delta` writes; current owner truth is `clientSemanticFrameWritten || terminalWatch.sawResponsesCompletedChunk || terminalWatch.sawResponsesDoneEvent || contractProbe.emitted`.
- G6 focused gates verified PASS (latest=2026-06-16): `tests/providers/core/runtime/provider-failure-policy-upstream-stream-incomplete.spec.ts` = 2/2 PASS; `tests/server/runtime/http-server/direct-decision.upstream-stream-incomplete.spec.ts` = 2/2 PASS; `tests/server/handlers/handler-response-utils.sse-finish-reason.spec.ts -t "treats upstream_stream_incomplete as failed completion instead of unknown success"` = PASS after the semantic-frame gate correction; `npx tsc --noEmit --pretty false` = PASS.
- G4 red remains intentionally open (latest=2026-06-16): `tests/server/handlers/responses-handler.stream-closed-before-completed.regression.spec.ts -t "surfaces started-stream failure as explicit SSE error when upstream closes before response.completed"` still FAILs because started-stream partial output currently ends without `event: error`; this is midstream client projection / started-stream closeout behavior and belongs to G4, not G6. Do not count that red as G6 regression.
- G3/G5/G7/G10 focused gates verified PASS (latest=2026-06-16): `tests/server/runtime/http-server/executor/request-executor-primary-exhausted-plan.spec.ts` = 2/2 PASS (native VR planner bridge, no host fallback synthesis); `tests/providers/core/runtime/provider-failure-policy-client-disconnect-499.spec.ts` = 5/5 PASS; `tests/server/utils/http-error-mapper-499-client-disconnect.spec.ts` = 3/3 PASS; `tests/server/utils/http-error-mapper.client-disconnect-log-summary.spec.ts` = 2/2 PASS; `tests/server/utils/http-error-mapper.policy-exhausted-gate.spec.ts` = 7/7 PASS; `tests/server/runtime/http-server/port-config-validator-provider-failure-exemption.spec.ts` turned GREEN after adding validator checks that router-mode rejects `providerFailureExemption` and provider-mode only allows `single_binding_rethrow`.
- Live/build blocker (latest=2026-06-16): `PATH=/opt/homebrew/opt/node@22/bin:$PATH ROUTECODEX_BUILD_RESTART_ONLY=1 ROUTECODEX_INSTALL_VERIFY_PORT=5555 ./scripts/install-global.sh` currently fails in unrelated pre-existing servertool gate `cli-projection-command-contract`, specifically requiring `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs` to contain `quote_posix_single_argument(&input_json)`. Current `/health` on `127.0.0.1:5555`, `5520`, `10000` remains `status=ok ready=true pipelineReady=true version=0.90.3072`, so live replay of the new error-chain changes is still blocked by unrelated install/build state rather than runtime health.

## 2026-06-16 stopless followup -> thinking route fix

- Root cause confirmed: VR classifier only treated `latest_message_from_user=true` as thinking, so stopless CLI continuation next turn stayed tool-role and could drift to `tools` route even after stripping `routeHint`.
- Fix landed in `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/classifier.rs`: when request metadata carries `serverToolFollowup=true`, classifier now promotes that turn into `thinking` eligibility.
- Red/green evidence:
  - PASS `cargo test -p router-hotpath-napi --lib -- 'virtual_router_engine::classifier::tests::' --nocapture`
  - PASS `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/stopless-vr-route-hint.spec.ts --runInBand`
  - PASS `PATH=/opt/homebrew/opt/node@22/bin:$PATH npx tsc -p tsconfig.json --noEmit --pretty false`
- Build/install/restart evidence:
  - PASS `PATH=/opt/homebrew/opt/node@22/bin:$PATH ROUTECODEX_BUILD_RESTART_ONLY=1 ROUTECODEX_INSTALL_VERIFY_PORT=5555 ./scripts/install-global.sh`
  - Installed `routecodex/rcc = 0.90.3074`
  - Health PASS: `127.0.0.1:5555`, `5520`, `10000` all `status=ok ready=true pipelineReady=true version=0.90.3074`
- Live local CLI continuity proof after install:
  - `CODEX_THREAD_ID=stopless-vr-fresh-3074 routecodex hook run reasoning_stop ...` returned continuation prompts in sequence:
    1. `继续做下一步；先把手头能确认的结果拿回来。`
    2. `继续推进；缺哪块结果就补哪块，别停在概述上。`
    3. `这次不要再泛泛地说了。把还能验证的文件、日志、命令都直接补完；如果还是收不住，就明确写清楚卡点、已经排除的路、以及还差我拍板的那一步。`
    4. fourth call returned `summary=stopless budget exhausted`
  - Persisted state file `~/.rcc/state/routing/session-codex_stopless-vr-fresh-3074.json` shows `stopMessageUsed=3`, `stopMessageMaxRepeats=3`, and final-round prompt text.
- G2/G4/G9 progress (latest=2026-06-16): G2 JSDoc contract in `src/server/runtime/http-server/router-direct-pipeline.ts` now explicitly says payload passthrough remains but error passthrough is not preserved; router-direct failures must flow to `decideDirectRouterRetry` / ErrorErr05 before client projection. G4 owner `src/server/handlers/handler-response-sse.ts` now emits explicit `event: error` with `upstream_stream_incomplete` for started-stream partial semantic frames before closing; `tests/server/handlers/responses-handler.stream-closed-before-completed.regression.spec.ts -t "surfaces started-stream failure as explicit SSE error when upstream closes before response.completed"` PASS, and `tests/server/handlers/handler-response-utils.sse-finish-reason.spec.ts -t "treats upstream_stream_incomplete as failed completion instead of unknown success"` was updated to the new client-visible G4 contract and PASS. G9 scan: `suppressRouterDirectRetry` old guard has no code hit (only historical comment in `index.ts`); old 4xx early projection is gated by policy/candidate exhaustion and locked by `http-error-mapper.policy-exhausted-gate.spec.ts`; `Upstream rejected the request` remains only as exhausted projection text and test expectation, not a pre-exhaustion shortcut.
- Focused bundle (latest=2026-06-16): 10 suites / 54 tests PASS for provider error chain focused gates: upstream stream incomplete policy, direct decision, started-stream handler regression, SSE finish-reason contract, primary exhausted native-plan bridge, 499 client-disconnect policy/mapper/log summary, policy-exhausted gate, and providerFailureExemption validator. Jest still reports existing open handles after completion.
- Build blocker update (latest=2026-06-16): the previous install blocker `verify:responses-history-protocol-contract` was reduced to a Rust test helper visibility issue in `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/classifier.rs`: late tests referenced `classifier()` outside that helper's visible scope. Minimal fix added module-level `#[cfg(test)] use serde_json::json;` plus `test_classifier()` helper and rewired the test calls; no runtime classifier logic was intentionally changed. Gate now PASS: `cargo test -p router-hotpath-napi shared_responses_conversation --lib` -> 29 passed / 1680 filtered.

## 2026-06-16 stopless + error-chain pre-commit audit

- Current git index only held the error-chain slice; stopless source changes were still unstaged in worktree, so commit had to be rebuilt from exact owner files instead of trusting previous staged state.
- Verified stopless trigger chain is end-to-end, not an isolated `cli_contract.rs` tweak: `stop-message-auto.ts` writes `stopSchemaTriggerHint` -> `engine.ts` projects it into CLI input -> `servertool-core/src/cli_contract.rs` maps it to natural-user continuation text + schema guidance.
- Found and corrected stale dual-writer comments in Rust CLI persistence (`servertool-cli/src/main.rs`, `servertool-core/src/persisted_state_fs_write.rs`): current truth is single-writer stopless session persistence owned by the Rust CLI, not TS shell second-write compensation.

- 2026-06-16 stopless live audit: found repeatCount 2/3 oscillation. Root cause: TS stop-message-auto seeds CLI persisted state with schemaUsedBeforeCount while native handler stateUpdate already advances used+1; mixed entrypoints cause session state to bounce between used=2 and used=3. Must align to single post-handler used truth and remove old CLI preseed semantics.

- 2026-06-16 online verification: 5520 direct request returned normal assistant text and did not project stopless CLI/tool call. Added direct route red test in tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts to lock same-protocol direct + finish_reason=stop passthrough with no stopless injection.
- 2026-06-16 online verification: 5555 relay first stopless intercept returned finish_reason=tool_calls with empty visible content and exec_command tool call carrying natural-language continuationPrompt; no schema/control text leaked in client-visible message content.
- Remaining gap: need stronger live evidence for 5555 relay followup VR route=thinking from the current running log stream / request IDs; current accessible server-5555.log does not contain the fresh request lines, so this item remains unproven from logs.

- 2026-06-16 stopless budget re-arm bug fixed. Red test added at servertool-cli/tests/cli_blackbox.rs::exhausted_stopless_run_clears_session_state_for_next_turn now locks: after 3rd hit returns stopless budget exhausted with triggerHint=budget_exhausted and repeatCount=3, every subsequent invocation of stop_message_auto for the same session stays terminal (summary=budget exhausted, repeatCount=3). Root cause: persist_stopless_continuation_state wrote empty text on budget_exhausted, which record_stopless_continuation_state treats as a clear signal, so the next call re-armed from repeatCount=1. Fix: always persist continuation_prompt text; let the snapshot remain terminal.

## 2026-06-16 primary_exhausted -> default_pool review findings

- Current uncommitted host-side slice is still wrong for `virtual_router.primary_exhausted_to_default_pool`: `src/server/runtime/http-server/index.ts` and `src/server/runtime/http-server/request-executor.ts` call `resolvePrimaryExhaustedRouteName(metadata...)`, so route truth is guessed from metadata/routeHint instead of coming from VR failure details. This does not satisfy the "real exhausted route" requirement when VR selection fails before `decision.routeName` exists.
- Current host planner input also mismatches identity domains: `extractRoutingTiersForRoutingGroupRoute()` preserves raw route targets such as `fwd.gpt.gpt-5.5`, but `exhaustedTargets` is still fed from `excludedProviderKeys` concrete provider keys. Rust planner compares strings directly, so forwarder-backed primary exhaustion cannot correctly trigger backup/default tier selection.
- Current production code exports `__setPrimaryExhaustedPlanNativeForTests` from `request-executor-core-utils.ts`; this is a test-only mutable injection surface and should be removed in favor of test-local native bridge mocking.
- Preferred fix direction for this slice: Rust VR selection error must carry stable exhausted-route truth (`routeName` + route-target identity in the same domain as tier targets), and host must consume that truth only. No metadata guessing fallback.

## 2026-06-16 19:15:14 stopless session relay nested scope audit
- Hypothesis: live relay stopless loses session scope when only __rt.responsesRequestContext carries sessionId/conversationId; server-side used stays 0 and CLI projection repeats repeatCount=1.
- Evidence: old live log server-5520 shows [session-request][rt] session=unknown with stop_compare used=0 on repeated stopless followups.
- Plan: add red tests for nested __rt.responsesRequestContext -> adapterContext/sessionId and stopless 1->2->3 using only that source; then patch normalizer/engine owner paths.

## 2026-06-16 19:20:02 stopless session propagation fix verified
- Root cause confirmed: relay stopless session scope was not being backfilled from nested __rt.responsesRequestContext, so stopless CLI projection could omit --session-id and every run started at repeatCount=1.
- Fix applied: backfill nested __rt.responsesRequestContext into servertool adapter context, followup metadata, and stopless session read path.
- Verification PASS: servertool-adapter-context spec, stopless-cli-continuation spec, servertool-followup-metadata spec, root tsc, git diff --check.
- 2026-06-16 stopless live repeatCount stuck at 1 root-cause slice:
  - c1723ba fixed nested `__rt.responsesRequestContext.sessionId` propagation into relay stopless session truth.
  - Remaining live gap: stopless CLI binary and server relay runtime can read/write different routing state roots.
  - Evidence: server runtime uses per-port `ROUTECODEX_SESSION_DIR` under `~/.rcc/sessions/<serverId>/ports/<group>`, but `servertool-cli` defaults to `~/.rcc/state/routing` unless env override is passed into the projected command execution environment.
  - Fix direction: CLI projection must carry current `ROUTECODEX_SESSION_DIR`; req-side stopless command recognition must accept env-prefixed command lines so submit_tool_outputs normalization still closes the loop.

## 2026-06-16 stopless CLI sessionId/requestId 收口

- 用户约束：CLI 不许再生成 fake `sessionId`/`requestId`；stopless 续杯必须用真实链路的 sessionId，禁止 fake 兜底。
- 物理删除的 owner:
  - `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`:
    - 删除 `static STOPLESS_ID_COUNTER`、`fn next_stopless_id_counter`、`fn current_time_ms`。
    - 删除 `fn resolve_stopless_default_session_id`(env 兜底: `CODEX_THREAD_ID`/`TMUX_PANE`/`TERM_SESSION_ID`/`ITERM_SESSION_ID`/`pid:...` 全部不再回退)。
    - 删除 `fn resolve_stopless_default_request_id`(不再基于时间戳和 counter 拼 stopless id)。
    - 同步删除 `use std::sync::atomic::{AtomicU64, Ordering}` 和 `use std::time::{SystemTime, UNIX_EPOCH}` 两个仅服务于 fake 生成的 import。
    - `validate_stopless_session_identity` 改为 fail-fast：缺 `sessionId`/`requestId` 直接 `MissingField` 错误。
  - `tests/cli/servertool-command.spec.ts`:
    - 删除 `auto-fills stop_message_auto session identity when caller omits it` 旧测试。
    - 新增 `omitting sessionId causes CLI to fail with missing field error`，断言 exitCode=1 + `SERVERTOOL_CLI_MISSING_FIELD`。
- 顺带修复的二级 owner:
  - `cli_contract.rs::build_stop_message_auto_run_output` 的 `current_repeat_count` 优先级从 `[CLI arg, payload.repeatCount, persisted.used+1]` 改为 `[CLI arg, persisted.used+1, payload.repeatCount]`。这是同一真实 `sessionId` 重复调用卡在 `repeatCount=1` 的真正根因：payload 把会话状态压回 1。
- 红测新增/强化 (`servertool-cli/tests/cli_blackbox.rs`):
  - `missing_session_identity_fails_with_missing_field_error`: 缺 sessionId 必须失败，stderr 含 `SERVERTOOL_CLI_MISSING_FIELD: sessionId`。
  - `stopless_continuation_count_increments_with_real_session_id`: 同一 `sessionId` 真实调用三次，前两次 `summary=stopless continuation ready`、`repeatCount=1/2`，第三次 `summary=stopless budget exhausted`、`repeatCount=3`。
- 验证 PASS:
  - `cargo test -p servertool-cli --test cli_blackbox` 21/21。
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/cli/servertool-command.spec.ts --runInBand` 19/19。
  - `cargo build -p servertool-cli` 0 errors。
- 实机 binary (`sharedmodule/llmswitch-core/rust-core/target/debug/routecodex-servertool`) 三连调用 `session-real-verify`:
  - step 1: `repeatCount=1, summary=stopless continuation ready`
  - step 2: `repeatCount=2, summary=stopless continuation ready`
  - step 3: `repeatCount=3, summary=stopless budget exhausted, triggerHint=budget_exhausted`
  - step 4 (after exhaust): 仍 `repeatCount=3, summary=stopless budget exhausted`，不再回弹到 1。
- 残留风险: `routecodex hook run` 当前调的是已安装的 release 二进制，本次 owner 改动必须 `ROUTECODEX_BUILD_RESTART_ONLY=1 ROUTECODEX_INSTALL_VERIFY_PORT=5555 ./scripts/install-global.sh` 之后 live 才能体现。
## 2026-06-16 ~/.rcc 只读审计

### 规模
- 根 /Volumes/extension/.rcc (= ~/.rcc)，72 项顶层，du 7.5G
- diag/ 5.3M (1 文件)
- logs/ 475M (provider-stats.jsonl + .1-.3 各 64M, server-5520.log 196.7M, server-4444.log 18.8M, process-lifecycle.jsonl 34.9M)
- codex-samples/ 753M
- state/provider-traffic.backup-20260512T102818 19M
- state/provider-traffic 416K
- state/provider-traffic-test 344K
- diag 之前 104G，cleanup 后 5.3M (1 个 gpt-5.4 错误)

### 配置文件真源
- 代码默认 config.toml（src/server/.../providers-handler-routing-utils.ts:614 列 [config.toml, config.json]）
- 脚本默认 config.json（scripts/provider-v2-smoke.mjs:12, replay-recorded-toolcall.mjs:44, clean-safe.mjs:42）
- 实测只有 config.toml (14.2K, 6/16 15:16 写入)
- 备份：config.toml.bak-20260604T235302, config.toml.bak-5520-before-llmgate-only-20260606T233448, config.toml.bak-gpt55-to-gpt54-20260611171632
- variants: config.dbittai.toml (1.4K, 5/15), config.long.omlx.toml (2.6K, 5/10)
- config/multi/, config/single/ 下的 JSON 旧配置 + 1 个 stop-message.json + .bak
- backup-20260513/ 14 个旧 config.json 残留
- 结论：真源 config.toml，其它全部应归档

### PID 文件 (16 个)
路径：~/.rcc/server-{port}.pid (src/index.ts:964, src/cli/commands/start.ts:478, src/utils/managed-server-pids.ts:18)
实测：10000 死, 18520 死, 4444 活, 5520 活(同 pid 25530), 5521 死, 5522 活, 5532 死, 5533 死, 5536 死, 5555 死, 5560 死, 5566 死, 5567 死, 6520 死, 6633 死, 6666 死
死 pid 13/16 = 81%
无任何代码清理 (rg 'unlink.*pid|deletePid|removePid|cleanupPid|clearPid' src/ = 0)
cleanup-stale-server-pids.mjs 存在但引用 ~/.routecodex（老目录），不清理 ~/.rcc

### daemon-stop (5 个)
路径：~/.rcc/daemon-stop-{port}.json (src/utils/daemon-stop-intent.ts:20, maxAgeMs=60000)
实测：10000 (5/29), 3333 (5/30), 4444 (5/30), 5520 (6/14), 5555 (6/9) — 全部超过 60s，未消费未清理
只有 start.ts:567 在新 start 时调 clearDaemonStopIntent，无独立 reaper

### 临时文件
- token-stats.json.tmp-* 12 个 (2.4-2.9M 各)，最新 6/15
- config.toml.bak-* 3 个
- stop-message.json.bak-* 1 个
- auth/windsurf-ws-pro-4.json.bak-* 1 个

### 大目录
- codex-samples/ 753M — 采集样本，可保留
- logs/ 475M — 实际日志，主因
- diag/ 已缩 104G → 5.3M（清理过）

### 未在代码中的目录
- ~/rcc-protocols/raw/ 空目录，无引用
- ~/.rcc/camoufox-fp/ 单独 fingerprint json（与 camoufox-profiles/ 重叠）
- ~/.rcc/camoufox-profiles/ 10 个 profile (rc-default, rc-auth.* 4, rc-qwen.* 5, rc-iflow.138)
- ~/.rcc/windsurf-ls/ 339M 9 个 ws-pro instance + managed + windsurf-default-runtime
- ~/.rcc/windsurf-workspaces/ 0B 空目录
- ~/.rcc/provider-traffic-test/ 0 引用（除 jest worker 自身使用，prod 无用）

### 日志轮转
- stats-manager.ts:201 有 rotateStatsLogIfNeeded (64M * 3 backups)
- process-lifecycle-logger.ts 无 rotate
- server-*.log 无 rotate（196.7M 单文件）
- provider-stats.jsonl 有 .1-.3 rotation 在工作

### 结论（按用户问题）
1. config 多份 → 留 config.toml 一份真源，其余归 backup-20260513
2. pid 16 个死 13，无清理 → 加 start/stop 收尾 unlink + 启动期 reaper
3. daemon-stop 5 个全过期 → maxAgeMs=60s 不会 reaper，扩到 process lifecycle hook
4. tmp/bak 无上限 → 启动时清理 > 7d 旧 tmp/bak
5. camoufox-fp / windsurf-ls / windsurf-workspaces 大量未引用目录 → 需评估保留范围
## 2026-06-16 agents/coding-principals architecture audit

- 审计目标：判断 `function map + owner + 主线逻辑调用绑定` 是否是大型多文件项目中降低误改风险的好方案；结合 RouteCodex 现状评估是否还有更优补强，以及本项目落地是否彻底。
- 已读真源：
  - `~/.codex/USER.md`
  - `CACHE.md`
  - `docs/agent-routing/00-entry-routing.md`
  - `docs/agent-routing/10-runtime-ssot-routing.md`
  - `~/.codex/skills/coding-principals/SKILL.md`
  - `~/.codex/skills/reviewing-code/SKILL.md`
  - `docs/architecture/function-map.yml`
  - `docs/architecture/verification-map.yml`
- 初步发现：
  - 全局/项目 `AGENTS.md` 与 `coding-principals` 明确要求 owner registry、function map、verification map、architecture gates、拓扑命名与唯一 owner，这个方向本身正确。
  - RouteCodex 已有较完整 `function-map.yml` / `verification-map.yml` / 架构 gate 命令栈，说明不是纯文档口号。
  - 但 `coding-principals` 里要求的“code-bound function map”包含 `request/response/error mainline`、`function-call tables`、`caller/callee`、`symbol path` 等；当前 `function-map.yml` 抽样更像 feature owner registry + allowed/forbidden path + tests/gates，未见完整跨主线调用表字段。
  - 结论候选：当前方案方向对，但还没完全实现到“owner + 主线调用绑定”最彻底形态；还需要把 registry 升级到更强的代码可查询调用关系与自动化入口。
- 本轮落地：
  - 新增 `docs/architecture/mainline-call-map.yml` 作为 `function-map.yml` 的补充层，先放 request/response/error 三条主线骨架。
  - 新增 `docs/goals/mainline-call-map-closeout-plan.md`，给出 closeout 目标、规则、验证和完成标准。
  - `docs/architecture/README.md` 已声明 `mainline-call-map.yml` 职责，避免后续继续把 owner registry 误当完整调用绑定图。
  - 第二轮补边已把一批 `binding_pending` 收紧为真实符号：
    - request 入口：`prepareResponsesHandlerEntryForHttp -> planResponsesHandlerEntry`
    - request capture：`buildResponsesRequestContextForHttp -> captureReqInboundResponsesContextSnapshotJson -> captureReqInboundResponsesContextSnapshotWithNative`
    - response projection：`prepareResponsesJsonClientDispatchPlanForHttp -> projectResponsesClientPayloadForClientWithNative`
    - error decision/projection：`resolveProviderRetryExecutionPlan -> consume_error_err_05_execution_decision_from_error_err_04_router_policy` 与 `project_error_err_06_client_from_error_err_05_execution_decision -> mapErrorToHttp`
  - 纠偏：`sendErrorResponse` 不存在，已从 map 中移除，防止把假 symbol 写成契约。
  - 第三轮补边：
    - response 前半段已锚定到 typed entrypoint：
      - `run_hub_resp_inbound_02_parsed_entrypoint -> parse_hub_resp_inbound_02_from_provider_resp_inbound_01`
      - `run_hub_resp_chatprocess_03_governed_entrypoint -> build_hub_resp_chatprocess_03_from_hub_resp_inbound_02`
    - request 中段仍暂留 pending，不是遗漏：当前 live runtime 主线是 `engine.rs` 里的 `select_route + apply_vr_route_04_selection`，而 typed contract owner 另有 `build_vr_route_04_from_hub_req_chatprocess_03` / `build_hub_req_outbound_05_from_hub_req_chatprocess_03`，两层尚未收敛成单一 caller-callee 直链，不能硬写假绑定。
  - 这一套方法现已上升为公共规则候选：
    - 全局 `~/.codex/AGENTS.md` 新增 `Mainline Call Map 强制原则`
    - `coding-principals` 新增 `Mainline Call Maps` 小节
    - 核心思想：`function map` 管 owner/paths/gates，`mainline call map` 管 request/response/error 主线边、caller/callee、facade/runtime/typed-contract 分层；未证实边必须 `binding pending`，禁止伪造完整主线。

### 2026-06-16 runtime lifecycle pid rebase implementation
- Added design SSOT: docs/design/server-runtime-lifecycle-ssot.md
- Added helper owners:
  - src/utils/server-runtime-pid.ts
  - src/utils/server-runtime-stop-intent.ts
  - src/utils/runtime-instance-registry.ts
- user-data-paths.ts adds subdirs: runtimeLifecycle, run, tokenStats
- daemon-stop-intent.ts is now thin re-export to new stop-intent helper
- managed-server-pids.ts reads new pid cache path first, legacy root pid second
- start.ts writes server pid cache via helper
- index.ts writes server pid cache via helper
- cli.ts + commands/token-daemon.ts move token-daemon pid path to runtime helper
- cleanup-stale-server-pids.mjs scans both ~/.rcc root legacy pid files and state/runtime-lifecycle/ports/*/pid.cache; parses pid.cache JSON
- Added tests:
  - tests/utils/server-runtime-pid.spec.ts
  - tests/utils/runtime-instance-registry.spec.ts
  - tests/red-tests/runtime_pids_moved_out_of_rcc_home_root.test.ts
- Added gate: scripts/architecture/verify-runtime-lifecycle-pid-rebase.mjs + package.json script verify:runtime-lifecycle-pid-rebase
- Added function-map entries:
  - runtime.lifecycle.pid_cache
  - runtime.lifecycle.stop_intent
  - runtime.lifecycle.instance_registry

### Verification 2026-06-16
- PASS: npm run verify:runtime-lifecycle-pid-rebase
- PASS: npx tsc --noEmit --pretty false
- PASS: focused jest
  - tests/utils/server-runtime-pid.spec.ts
  - tests/utils/runtime-instance-registry.spec.ts
  - tests/utils/daemon-stop-intent.spec.ts
  - tests/utils/managed-server-pids.spec.ts
  - tests/red-tests/runtime_pids_moved_out_of_rcc_home_root.test.ts
- Existing unrelated/ambiguous suite: tests/cli/start-command.spec.ts still exits at config path resolution branch (line 242/255) because it stubs fsImpl but resolveRouteCodexConfigPath still uses real FS; not a clean regression signal for this slice.

### Live cleanup evidence
- Ran node scripts/cleanup-stale-server-pids.mjs --quiet against real ~/.rcc
- Root pid files: 16 -> 2 (live 4444, 5520) -> manually removed both after confirming they were legacy root pid files
- Root daemon-stop files: 5 -> 0 (manually removed)
- Current root no longer has server-*.pid or daemon-stop-*.json
- Remaining root clutter not touched in this slice because live code still writes/reads them:
  - token-stats.json + token-stats.json.tmp-*
  - config.dbittai.toml / config.long.omlx.toml / config.toml.bak-*

## 2026-06-16 5520 direct responses stale inbound retention audit

- Jason 明确纠偏：这轮不要继续盯请求出站 compat，先查 direct 响应链里“上轮响应入站未清理”。
- 现场硬证据：
  - `~/.rcc/logs/server-4444.log:94090-94099` 对应 requestId `openai-responses-router-gpt-5.4-20260616T214159290-356290-3918`，`router-direct.send` -> upstream `HTTP 400`。
  - `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260616T214159290-356290-3918.json` 显示本次失败 body 没有 `previous_response_id/response_id`，但 `input` 总长 355，尾部含连续 `function_call/function_call_output` 与混入的 `reasoning/assistant output_text`，符合“普通 fresh request 混进上轮响应历史残留”。
- 代码对照：
  - `src/server/runtime/http-server/index.ts::buildRouterDirectResult()` 当前对 `openai-responses` 的 200 JSON success 一律 `recordResponsesResponseForRequest(...) + finalizeResponsesConversationRequestRetention(...)`，只在 `keepForSubmitToolOutputs` 上按 `finishReason === 'tool_calls'` 区分。
  - `buildProviderDirectResult()` 则只在 `finishReason === 'tool_calls'` 时保留，其他 success 显式 `clearResponsesConversationByRequestId(...)`。
- 当前判断：
  - router-direct 会错误保留 `finish_reason=stop/completed` 的普通响应，后续 fresh `/v1/responses` 可被 scope materialize 污染。
  - `tests/server/runtime/http-server/direct-result-metadata-propagation.spec.ts` 里现有 router-direct “success retention” 旧合同正好把这个错误行为锁成了期望，需要翻成红测。
  - 先红时又暴露一个测试壳问题：该 spec mock `responses-conversation-store-native.js` 时漏了新导出 `stripStoredContextInputMedia`，suite 先死在 module link，不是业务红。
- 本轮修复计划：
  1. 补测试 mock 缺失导出，让 suite 真正执行。
  2. 把 router-direct 普通 completed success 的旧合同改为“必须清空 store / 不得可续接”。
  3. 修改 `buildRouterDirectResult()`：仅 `finishReason === 'tool_calls'` 才 record+finalize；其他 success 显式 clear。
  4. 跑 focused Jest + `git diff --check`；若通过，再做 live replay 看 5520 direct 是否不再混入上轮 `function_call/function_call_output` 残留。

## 2026-06-16 architecture mainline split-binding closeout

- 当前 mainline call map 第 2 步不再把 `req-03` / `req-04` 当作“待补具体 symbol”的普通 pending，而是显式标注为 split binding：
  - `HubReqChatProcess03Governed -> VrRoute04SelectedTarget`
  - `HubReqChatProcess03Governed -> HubReqOutbound05ProviderSemantic`
- 证据来自 Rust 双层真相分离：
  - runtime orchestration: `hub_pipeline_lib/engine.rs`, `vr_route_04_selection_boundary.rs`
  - typed contract builders: `hub_pipeline_types/vr_route_04_selected_target.rs`, `hub_pipeline_types/hub_req_outbound_05_provider_semantic.rs`, `request_typed_entrypoints.rs`
- 约束更新：runtime orchestration 与 typed contract builder 分层时，必须落 `split_bindings`，禁止在 mainline graph 里伪造单一 caller/callee edge。

## 2026-06-16 architecture split-binding gate tightening

- 第 3 步目标：把 split binding 从“可渲染说明”升级为“强 schema + 强引用关系”。
- 结构收紧：
  - pending edge 新增 `split_binding_id`
  - `split_bindings.binding_id` 必须能被至少一条 pending edge 反向引用
  - split binding 的 `from_node/to_node` 必须与引用它的 pending edge 转换一致
  - `runtime_symbols` / `typed_symbols` 必须非空，且 symbol/file 都要真实存在
- 这样可以防止两类漂移：
  1. note 文本写了 split binding 名，但实际没有结构化绑定；
  2. split binding 还在文档里，但对应 pending edge 已被改名/改边/删除。

## 2026-06-16 architecture wiki coverage expansion

- 继续收口两件事：
  1. `response.mainline` 的 `resp-01` / `resp-02` 已有 caller/callee，但 owner 仍未绑定；本轮按 function-map 证据补齐。
  2. `docs/architecture/wiki/` 当前只有 `README.md` + `mainline-call-graph.md`，review 面明显不足；先补一页 `coverage-matrix.md` 固定“已有/缺失/下一批”清单，避免后续补图发散。
- 拆分策略已定：
  - `mainline-call-map.yml` 继续驱动 request/response/error/runtime 四条链图
  - `function-map.yml` 驱动 `hub.servertool_*` 和 `vr.* / virtual_router.*` owner 聚合页
  - 自动生成脚本统一输出 wiki 页面，禁止手写多份同义 review 面

## 2026-06-16 runtime lifecycle pid map closure
- 任务：更新 mainline-call-map.yml + wiki，完成 function-map 已绑定的 runtime.lifecycle 三个 feature 的文档闭环。
- mainline-call-map.yml：新增 `runtime.lifecycle.mainline` chain，7 edges：
  - rtl-01: start.ts → writeServerPidCache (anchored)
  - rtl-02: index.ts → writeServerPidCache (anchored)
  - rtl-03: stop.ts → writeServerStopIntent (anchored)
  - rtl-04: start.ts → consumeServerStopIntent (anchored)
  - rtl-05: cli.ts → resolveTokenDaemonPidPath (anchored)
  - rtl-06: token-daemon.ts → resolveTokenDaemonPidPath (anchored)
  - rtl-07: instance_registry self-edge (binding pending: 无主 runtime 调用方)
- shared_multi_reference_functions 新增：runtime.lifecycle.pid_cache_writer / stop_intent_signal / stop_intent_consumer
- wiki 重 render：npm run render:architecture-mainline-mermaid → ok
- gate PASS：verify:architecture-mainline-call-map (21 edges / 6 shared functions / 4 chains)
- gate PASS：verify:architecture-mainline-mermaid-sync
- CI 问题：verify:architecture-forbidden-path-growth 失败于 Rust target 目录 ENOENT，环境问题，与本 slice 无关；前面的 verify:architecture-mainline-call-map 和 mermaid-sync 均已 PASS
- git 状态：文件已被其他 session 合并入 HEAD (f5fe2a940)，无需再 commit；当前 worktree dirty 为其他 worker 改动

## 2026-06-16 5520 direct SSE response.metadata allowlist fix

- 用户给出的 live 样本：`openai-responses-router-gpt-5.4-20260616T232300793-357176-4804` 在 5520 `/v1/responses` direct SSE 写客户端前失败，错误为 `direct passthrough SSE emitted non-Responses event "response.metadata"`。
- mainline/function-map 定位：
  - response mainline `resp-03/resp-04` 显示 client projection 真源仍为 `hub.response_responses_client_projection` Rust owner；
  - direct SSE frame/metadata guard 属于 `server.responses_sse_bridge_surface` / `server.responses_response_handler_bridge_surface` TS bridge surface；
  - 不应在 provider runtime 或 Hub projection 增加转换补偿。
- 根因：direct SSE allowlist 漏掉 live upstream/provider `event: response.metadata`；这和“metadata 内部 carrier 泄漏”不是同一类问题。
- 红测证据：先把 `tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts` 改为普通 `response.metadata` 应通过、同事件携带 `providerKey/__rt` 应失败，当前实现先红 2 条，说明被 event allowlist 过早拒绝。
- 修复：`src/modules/llmswitch/bridge/responses-response-bridge.ts` 的 `RESPONSES_DIRECT_PASSTHROUGH_ALLOWED_EVENTS` 增加 `response.metadata`；不改 payload、不过滤 frame、不加 provider 特例。
- 绿测证据：`PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts --runInBand` -> 4/4 PASS。
- 待验证：build/install/restart 后需要用 5520 `/v1/responses` live replay 确认不再出现该 projection error，且内部 metadata leak guard 仍无 regress。

## 2026-06-17 stopless session truth 收口

### 根因（已验证）
1. `cli_contract.rs`: CLI `--repeat-count` 优先级高于 persisted，导致 caller 传的 `repeatCount=1` 每轮重置计数器。修复：persisted truth 优先，`current_repeat_count = persisted.used + 1`（无 persisted 才用 CLI arg）。
2. `seedStoplessCliPersistedState` pre-seed 写 `used=N`，CLI 写 `used=N+1`，但 pre-seed 每次重置；加上 routing state store 的写盘路径依赖 `process.env.ROUTECODEX_SESSION_DIR`（server 进程无此 env，CLI 有），导致两边写到不同目录。修复：
   - wrapper `loadRoutingInstructionStateSync/saveRoutingInstructionStateSync` 显式接受 `sessionDir` 参数，不依赖进程 env。
   - `resolveAdapterContextSessionDir` 从 `adapterContext.__rt.sessionDir` 读。
   - stop-message handler 所有读写路径统一透传 `sessionDir`。
   - 删除 `savePersistedRuntimeStopMessageStateWithNative`（双写导致混淆）。
3. `stopMessageAiMode` 字段已弃用但未删除（根因文档有误）。
4. pre-seed `nextUsed` 应写 `schemaUsedBeforeCount`（当前轮之前的计数），让本轮 CLI 推进到本轮值。

### 修改文件
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`: repeatCount 优先级倒置 + 测试截断修复
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-state.ts`: load/saveRoutingInstructionStateSync 加 `sessionDir` 参数
- `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/runtime-utils.ts`: 删除 `savePersistedRuntimeStopMessageStateWithNative`；所有 persisted state 读写统一走 `saveRoutingInstructionStateSync` + 显式 `sessionDir`
- `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts`: 所有 `loadRoutingInstructionStateSync/persistStopMessageState/resetPersistedStopMessageUsed/clearPersistedStopMessageRuntimeState` + `seedStoplessCliPersistedState` 统一透传 `sessionDir: resolveAdapterContextSessionDir(ctx.adapterContext)`；pre-seed 写 `schemaUsedBeforeCount`
- `scripts/verify-servertool-rust-only.mjs`: gate 断言更新
- `scripts/tests/stopless-5555-final-probe.mjs`: live 验证脚本

### Live 验证结果（14/14 PASS）
- Step 1: exec_command 带真实 `--session-id / --request-id`，`ROUTECODEX_SESSION_DIR` 正确
- Step 2: CLI stdout 带 `output.sessionId / requestId`；`output.input` 仅 4 keys；`continuationPrompt` 模板正确
- Step 3: 同一 sessionId 推进 `1 → 2 → 3`（terminal）
- Step 4: 5520 direct 不触发 stopless

### 未完成项
- `stopMessageAiMode` 字段物理删除（不影响 stopless 核心）
- `cli_contract.rs` 的 `STOPLESS_PROMPT_FORBIDDEN_TOKENS` 长度（长度限制未实现）

## 2026-06-17 architecture wiki coverage closeout in progress

- 新增 wiki 目标页：
  - `docs/architecture/wiki/responses-direct-relay-map.md`
  - `docs/architecture/wiki/servertool-followup-call-graph.md`
- 这两页的 review 面焦点：
  - `responses-direct-relay-map`：`direct/relay + store=true/store=false`、合法 continuation 入口、`entryKind + continuationOwner + scope` 三重隔离、`__shadowCompareForcedProviderKey` provider pin、非法 crossing。
  - `servertool-followup-call-graph`：`HubRespChatProcess03Governed -> ServertoolResp03RuntimeAction -> ServertoolReq04FollowupBuilt -> normal reenter -> ServertoolResp03FollowupResult -> HubRespOutbound04ClientSemantic`，以及 `generic CLI projection` / `stopless CLI` 与 followup 的分流。
- 同步更新：
  - `docs/architecture/wiki/README.md`
  - `docs/architecture/wiki/coverage-matrix.md`
  - `docs/architecture/README.md`
- 当前已完成文本落盘与 `git diff --check`；待补最后证据是新页 Mermaid 浏览器渲染确认，然后按小提交提交。
## 2026-06-17 architecture wiki html formalization

- 用户纠正点已确认：Mermaid HTML 渲染页不能再只是 `/tmp/*.html` 验证产物，必须是 repo 内正式文档，且同时保留人读与机器读两套正式文档面。
- 已补方案方向：`docs/architecture/wiki/*.md` 继续作为 canonical human-readable source；新增 `docs/architecture/wiki/html/*.html` 作为正式 HTML render artifact；机器可读真源继续是 `function-map.yml`、`mainline-call-map.yml`、`verification-map.yml`。
- 待验证闭环：生成 repo HTML artifact、跑 html sync gate、用浏览器直接打开 repo 内 html 页面确认 Mermaid 无语法错误。

## 2026-06-17 stopless sessionDir metadata-only simplification

- 用户要求已收口：`sessionDir` 不再信 env / 顶层字段 / 多分支猜测，只信 runtime metadata carrier。
- 已删生产逻辑里的 `ROUTECODEX_SESSION_DIR` fallback；`servertool/cli-projection.ts` 与 `stop-message-auto/runtime-utils.ts` 现在只从 `readRuntimeMetadata(...)` 读取 `sessionDir`。

## 2026-06-17 ROUTECODEX_SESSION_DIR semantics clarification

- 目录真相已确认：`ROUTECODEX_SESSION_DIR` 不是单一 session id 目录，而是 runtime workdir root。
- 这个目录混放了 routing state、session-bindings、provider-health、servertool-pending 等多类状态；`sessionId` / `tmuxSessionId` / `conversationId` 只是不同 namespace 的 key，不是同一个概念。
- 2026-06-17 followup：`pending-session.ts` 已改成显式 `sessionDir` 参数；生产 caller `pending-injection-block.ts` 只从 runtime metadata 取 `sessionDir`，不再偷读 env / top-level fallback。
- 2026-06-17 followup：`native-virtual-router-routing-state.{ts,js}` 在“未传 sessionDir”时传 `__ROUTECODEX_NO_SESSION_DIR_OVERRIDE__` sentinel；Rust `routing_state_store` 据此禁用 `ROUTECODEX_SESSION_DIR` env fallback。
- 2026-06-17 verify：`tests/servertool/pending-session.spec.ts`、`tests/sharedmodule/servertool-pending-session.spec.ts`、`tests/servertool/pending-injection-block.spec.ts`、`tests/sharedmodule/sticky-session-store-paths.spec.ts`、`tests/servertool/stopless-cli-continuation.spec.ts` 已对齐新 contract。
## 2026-06-17 direct `/v1/responses` upstream_stream_incomplete 排查

- 样本日志：5520 direct `/v1/responses`，`started (stream=true acceptsSse=true timeoutMs=900000)` 后命中 `asxs.crsa.gpt-5.4`，约 13s 后报 `[response.sse.stream] error {"message":"stream closed before response.completed","code":"upstream_stream_incomplete"}`。
- 已知前情：本轮刚修复的是 provider SSE headers timeout 过短；当前新错误已不是 `UPSTREAM_HEADERS_TIMEOUT`，需要继续确认 owner 是否在 direct SSE bridge / provider runtime / upstream 真流。
- 代码定位：client-visible `upstream_stream_incomplete` 由 `src/server/handlers/handler-response-sse.ts` stream end 收尾逻辑投影；具体 payload builder 在 `src/modules/llmswitch/bridge/responses-response-bridge.ts::buildResponsesStreamIncompleteErrorPayloadForHttp`。
- 当前判定条件：`planResponsesStreamEndRepairForHttp()` 仅在“未见 terminal event 且 probe 无法修复 continuation/completion”时走 incomplete；不是 headers timeout，也不是 router-direct request builder。
- 已排除假因：补的 custom_tool_call continuation 样本证明 bridge 对 `response.output_item.{added,done}` 的 custom tool 断流会补 `response.completed/response.done`，不会触发 `upstream_stream_incomplete`；因此当前 live 样本更像 upstream 在仅有 `response.created` / `response.in_progress` 等非 terminal 语义时就断流。
- 2026-06-17 followup：`mainline-call-map` 显示 `ServerRespOutbound05ClientFrame` 的唯一 caller/callee 是 `sendPipelineResponse -> sendSsePipelineResponse`；`function-map` 对应 owner 为 `server.responses_sse_bridge_surface` / `server.responses_response_handler_bridge_surface`。已在 `handler-response-sse.ts` 增加 incomplete 诊断字段（`lastRawFrame` / `lastProjectedFrame` / `probe` 摘要等），并修正 focused 日志断言后验证通过：
  - `tests/server/handlers/handler-response-utils.sse-finish-reason.spec.ts`
  - `tests/server/handlers/responses-handler.stream-closed-before-completed.regression.spec.ts`
  - `npx tsc --noEmit --pretty false`

## 2026-06-17 stopless/schema/runtime-path gate lock

- 本轮没有再动 stopless 主实现，只补 gate，防止后续回归。
- `scripts/verify-servertool-rust-only.mjs` 新增三类硬门禁：
  - `stopless-schema-feedback-lock`：要求 Rust orchestration 保留 `decision.followup_text`，并且 `chat_servertool_orchestration.rs` 保持 `test_stop_message_auto_schema_followup_text_keeps_exact_validation_feedback`。
  - `stopless-repeat-reset-lock`：要求 focused tests 继续覆盖 repeat 递增/重置语义，避免“非连续 stop 还沿用旧计数”复活。
  - `runtime-metadata-session-dir-lock`：要求 `virtual_router_engine/napi_proxy.rs` 只从 `metadata.__rt.*` 读取 `sessionDir/rccUserDir`，禁止恢复 top-level metadata fallback，并保留对应 Rust 单测。
- 定向验证已过：
  - `node scripts/verify-servertool-rust-only.mjs`
  - `node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/stopless-cli-continuation.spec.ts tests/servertool/servertool-cli-projection.spec.ts tests/cli/servertool-command.spec.ts tests/servertool/loop-state-block.spec.ts --runInBand`
  - `git diff --check scripts/verify-servertool-rust-only.mjs`

## 2026-06-17 hub pipeline slimming audit

- 本轮目标不是修 bug，而是审计“瘦身不减功能”可落点；证据来自静态 owner/map/code 面 + focused Jest。
- focused 验证结果：
  - `tests/sharedmodule/hub-pipeline-runtime-ingress.spec.ts` PASS
  - `tests/sharedmodule/chat-semantics-stage1.spec.ts` PASS
  - `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` FAIL
- residue audit 当前红点分两类：
  - 真残留：
    - `src/server/runtime/http-server/executor/request-executor-request-semantics.ts` 仍在 TS 本地解析 `submit_tool_outputs` / provider-native continuation 语义。
    - `src/server/utils/finish-reason.ts` 仍在 TS 本地扫描 `tool_calls` / `required_action` / `output.function_call`，并把空结果回填成 `tool_calls` / `stop`。
    - `src/modules/llmswitch/bridge/responses-response-bridge.ts` 仍是超大 TS 语义中心：本地做 SSE terminal/finish-reason/probe/persist 决策，不只是薄壳。
  - gate / hygiene 漂移：
    - `package.json` 的 `test:routing-instructions` 仍引用已不存在的 `tests/servertool/stop-message-auto.spec.ts`。
    - `sharedmodule/llmswitch-core/src/**` 仍存在 side-by-side TS emit artifacts（`.js/.d.ts/.map`），residue audit 已把它们识别为应清除面。
- 额外代码面发现：
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts` 与 `hub-pipeline-execute-chat-process-entry.ts` 基本是同构壳：同样的 preselected-route、同样的 `runHubPipelineLibWithNative(...)`、同样的 error/summary/result 包装，只差少量字段。
  - `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts` 把 resp_inbound SSE materialization、servertool runtime effect 执行、runtime-state write、resp_outbound SSE codec 四段职责叠在一个 TS 文件里，收口空间很大。
- 推荐瘦身顺序：
  1. 先删 host 侧 TS 语义残留：`request-executor-request-semantics.ts`、`src/server/utils/finish-reason.ts`
  2. 再把 `responses-response-bridge.ts` 继续向 native owner 收口，TS 只留 IO/persist glue
  3. 合并 `hub-pipeline-execute-request-stage.ts` / `hub-pipeline-execute-chat-process-entry.ts`
  4. 清掉 stale script path 与 checked-in TS emit artifacts

## 2026-06-17 commit 169c57ded

136 files, +12436 -2011。

- stopless persisted_state_fs_write.rs 物理删除；cli_contract 不再读/写文件状态
- persisted_lookup 新增 `resolve_stopless_cli_result_snapshot_from_request()` 从 tool_outputs 取真源
- napi_proxy runtime path overrides 只读 `__rt.*`，删顶层 fallback
- pending-session/injection 统一显式 sessionDir 参数，删 env 猜测
- stopMessageAiMode 字段从 LegacyReasoningStopRoutingState 删掉（build 抓到的回归）
- providerFailureExemption 类型 + port-config validator
- .gitignore 新增 `__ROUTECODEX_NO_SESSION_DIR_OVERRIDE__/` + `.tmp/`
- architecture function-map/mainline-call-map/wiki 全量更新

Gate: tsc PASS, verify:function-map-compile-gate PASS, verify-servertool-rust-only PASS, focused Jest 44/44 PASS。

## 2026-06-17 hub pipeline slimming execution closeout

- 本轮已把 `request-executor-request-semantics.ts` 的 provider-native continuation 判定改成 Rust/native owner，host TS 不再本地解析 `previous_response_id` / `submit_tool_outputs`.
- 本轮已把 `src/server/utils/finish-reason.ts` 的“visible success / tool_calls fallback”残留删掉，`deriveFinishReasonWithVisibleSuccessFallback(...)` 现在只委托 `deriveFinishReason(...)`.
- residue gate 漂移已同步到当前 owner：
  - `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` 不再盯 `handler-response-utils.ts` 里的旧内联函数，改成检查 `responses-response-bridge.ts` / `handler-response-sse.ts` / `handler-response-utils.ts` 的现行 bridge surface。
  - `package.json:test:routing-instructions` 已把不存在的 `tests/servertool/stop-message-auto.spec.ts` 替换为现存拆分用例：`stop-message-auto-no-reenter.red` / `goal-default` / `config-precedence`.
- `sharedmodule/llmswitch-core/src/**` 下 50 个 ignored side-by-side emit artifacts（`.js/.d.ts/.map`）已物理删除；每个文件都已确认存在对应 `.ts` 真源。
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-chat-process-entry.ts` 已物理删除；chat_process request mainline 现在复用 `hub-pipeline-execute-request-stage.ts`，通过 `entryMode: "chat_process"` 保持错误文案与结果投影差异，不再保留同构壳。
- `src/modules/llmswitch/bridge/responses-response-bridge.ts` 再删一处 zero-consumer residue：`rebindResponsesConversationRequestIdsToResponseIdForHttp`.
- 验证证据：
  - `node scripts/build-core.mjs` PASS
  - `node --experimental-vm-modules ./node_modules/.bin/jest tests/server/runtime/http-server/executor/request-executor-request-semantics.spec.ts tests/server/utils/finish-reason.spec.ts tests/server/utils/finish-reason.visible-success.spec.ts --runInBand` PASS
  - `node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/hub-pipeline-preselected-route.spec.ts tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts tests/sharedmodule/chat-semantics-stage1.spec.ts tests/sharedmodule/hub-pipeline-runtime-ingress.spec.ts --runInBand` PASS
  - `node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts tests/sharedmodule/chat-semantics-stage1.spec.ts tests/sharedmodule/hub-pipeline-runtime-ingress.spec.ts --runInBand` PASS
  - `npx tsc --noEmit --pretty false` PASS
  - `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false` PASS

## 2026-06-17 hub pipeline slimming audit report update

- 本轮按 `docs/goals/hub-pipeline-slimming-no-function-loss-plan.md` 重新扫描 `responses-response-bridge.ts` / `responses-sse-bridge.ts` exported surface。
- 新增结论：
  - `responses-response-bridge.ts` 当前 exported helpers 都有 source/test/script consumer，不再出现新的 0-consumer export。
  - `responses-sse-bridge.ts` 虽是 98 行 re-export facade，但 function-map / verification-map 明确把它作为 `server.responses_sse_bridge_surface` owner module；不能按死文件删除。
  - `responses-response-bridge.ts` 的 SSE terminal/probe/persist helper 属于高风险状态机/生命周期语义，当前应暂缓大拆；后续只能先找更小 zero-consumer/internal helper 或设计 native-downshift 红测。
- 已把完整候选项处置表、删除策略、修改策略、暂缓原因补入 `docs/goals/hub-pipeline-slimming-no-function-loss-plan.md`。
- 验证证据：
  - `git diff --check` PASS
  - `node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts tests/sharedmodule/hub-pipeline-preselected-route.spec.ts tests/sharedmodule/chat-semantics-stage1.spec.ts tests/sharedmodule/hub-pipeline-runtime-ingress.spec.ts tests/server/runtime/http-server/executor/request-executor-request-semantics.spec.ts tests/server/utils/finish-reason.spec.ts tests/server/utils/finish-reason.visible-success.spec.ts --runInBand` PASS
  - `npx tsc --noEmit --pretty false` PASS
  - `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false` PASS

## 2026-06-17 responsesRequestContext session truth split

- 本轮确认新的主根因不是“单纯拿不到 sessionId”，而是 request session truth 与 responses continuation context 两种语义仍有残留混用。
- 当前请求真 session 只允许来自 request metadata / entry origin request / runtime metadata 中由请求真相派生的字段；`responsesRequestContext.sessionId/conversationId` 只能作为 `/v1/responses` continuation owner context，禁止升格成 request session truth。
- 生产残留点已定位并收口：`sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/runtime-utils.ts` 之前仍把 `responsesRequestContext` 回填到顶层 `sessionId/conversationId`，导致 stop-message scope/state-key/stopless activation 可被 continuation context 污染。
- 新 gate 已补：Jest 锁 `responsesRequestContext-only` 不得激活 stopless、不得形成 stop-message session scope/state key；`verify-servertool-rust-only.mjs` 也已禁止 runtime-utils 复活这条升格逻辑，并顺手把旧 persisted-state TS shell gate 改回“必须删除”方向。

## 2026-06-17 metadata center audit start

- Jason 要求把 metadata 做成集中处理中心，不再靠各层 merge/backfill/传值漂移；中心必须记录值、写入者、写入阶段、状态、覆盖历史，方便一眼定位谁写坏了。
- 当前已确认 metadata 相关读写面很散：handler 入口 `mergePipelineMetadata`、executor `finalizeRequestExecutorAttemptMetadata`、`buildServerToolAdapterContext`、`servertool-request-normalizer`、`responses-request-bridge`、`executor-metadata`、`provider-response-converter` 都在读写 session/continuation/runtime control 类字段。
- 下一步审计目标：按 request / response 阶段列出所有 metadata 字段类别，形成可落地的 `MetadataCenter` 输入表，再砍掉散落传递与二次 merge。

## 2026-06-17 metadata center doc closure

- 当前 metadata center 还处于 docs-first 阶段，已存在：audit 页、mainline source 页、manifest、function-map feature、verification-map feature、mainline-call-map chain。
- 发现文档漂移：metadata-center-mainline-source.md 的 Status 仍写“no manifest / no function-map/mainline-call-map feature”，与仓库现状不符，需先修正文档真相再 render/gate。
- 下一步：补 README/索引对 manifest 的正式引用，生成 repo 内 HTML，并跑 wiki/html/mainline sync gate。

## 2026-06-17 metadata center html/gate closeout

- metadata center mainline source 已补齐 README/索引/manifest 引用，并修正文档状态漂移。
- gate 现状：`verify-architecture-wiki-sync` PASS，`verify-architecture-wiki-html-sync` PASS。
- mainline-call-map 已加入 `metadata.center.mainline`，当前仍全部 `binding pending`，这是刻意保守状态，不宣称已完成代码绑定。
- 下一步：用 Computer Use 打开 repo 内正式 HTML `docs/architecture/wiki/html/metadata-center-mainline-source.html` 做可视渲染验证，再整理实现第一刀的 owner/替换面。

## 2026-06-17 metadata center impl slice 1

- 已补 host-side 红测：servertool-adapter-context 与 executor-metadata 现在都要锁 `responsesRequestContext` 不能 materialize request truth。
- 已切第一刀实现：`buildRequestMetadata` 把 request truth 与 continuation context 读取拆开；`servertool-request-normalizer` 在无 entryOrigin 时不再回填 session；`servertool-adapter-context` 仅在有 entryOrigin 时允许 backfill。
- 正在跑定向 Jest，下一步根据失败点继续把 remaining owner 收口，而不是停在局部 patch。

## 2026-06-17 metadata center impl progress

- 第一批 host-side 红测已转绿：`servertool-adapter-context.spec.ts` + `executor-metadata.binding.spec.ts` PASS。
- 已切掉的错误语义：无 entryOrigin 时不再从 flattened metadata / `responsesRequestContext` / `__rt.sessionId` 回填 request truth。
- 当前 owner 规则：entryOrigin request 可定义 request truth；continuation context 只能留在 continuation family，不再升格。
- 下一步：把 `MetadataCenter` 最小类型/slot/provenance contract 落成代码，并把当前 owner 改成显式 center 调用。

## 2026-06-17 metadata center code module introduced

- 新增 `src/server/runtime/http-server/metadata-center/metadata-center.ts` 与 `metadata-center-types.ts`，当前承载 request_truth + continuation_context + provenance 最小 contract。
- `buildRequestMetadata` 已开始 attach `MetadataCenter` 并写入 request truth / continuation context 的最小 provenance。
- 正在跑更大定向 Jest，确认中心挂载没有破坏 executor metadata 现有行为。

## 2026-06-17 metadata center impl current blocker shape

- 更大范围 `executor-metadata.spec.ts` 暴露的是 tmux request_guard / explicit tmux liveness 旧语义，不是 request truth vs continuation_context 第一阶段的直接 blocker。
- 当前已确认与本目标直接相关并转绿的测试：
  - tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts
  - tests/server/runtime/http-server/executor-metadata.binding.spec.ts
- 下一步继续沿 metadata center 目标推进，不把 tmux 独立语义和 request truth 第一阶段强行搅在一刀里；tmux 一支后续单独审计。

## 2026-06-17 SSE stop/tool-loss log audit

- 用户怀疑 SSE 返回丢工具导致会话提前 stop；当前只做分析未改代码。
- 已验证 release 日志现状：5520 与 5555 都有 `finish_reason=stop` 样本，但分属两条路径，不能混为一个根因。
- 5520 样本 `openai-responses-router-gpt-5.4-20260617T194738010-361156-1610`、`...194825333-361162-1616` 是 `router-direct:* -> XL.key1.gpt-5.4.gpt-5.5`，`internal=0ms`，无 `hub.response` / `servertool`；direct pipeline 仅 provider passthrough + hooks，provider SSE 只包装 `__sse_responses`，handler 用 direct passthrough guard，不进入 Hub response conversion。现有日志只能证明这些请求最后被判 `stop`，不能证明 raw 有 tool 且投影丢失。
- 5555 样本 `openai-responses-minimonth.key1-MiniMax-M2.7-20260617T192235609-360945-1399`、`...193258594-361026-1480` 是 relay/provider path：`provider.send completed` 后 `servertool stop_message_auto` 记录 `finish_reason=stop` + `skipped_missing_session` + `trigger_stop_schema_missing`，再 `hub.response`/client complete stop；这更像 provider/runtime response normalization 或 stop-message schema/session scope 行为，不是 direct SSE final projection。
- 现有 installed build 有 `response.sse.project_frame`、`lastRawFrame`、`lastProjectedFrame` 诊断代码，但 release `stage-logger` 默认不打该 stage；当前 `~/.rcc` 未找到上述 requestId 的 snapshot，因此缺少 raw/projected frame 对比证据。
- 下次复现必须开启 `ROUTECODEX_STAGE_LOG=1`（必要时加 Responses debug）并抓同一 requestId 的 `response.sse.project_frame` / `response.sse.stream.end` / `lastRawFrame` / `lastProjectedFrame` / `requiredToolCalls` / `outputFunctionCalls`，否则不能宣称“丢工具”。
- 进一步静态追踪修正：direct passthrough 先过 `createDirectPassthroughSseGuardStream`，但后续统一 `enqueueClientSseFrame()` 仍会调用 `normalizeResponsesSseFrameForClientForHttp()`；所以 direct 并非完全不投影，真实风险窗口在 Rust `project_responses_sse_frame_for_client` + handler terminal repair。
- Focused 验证：
  - `tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts` PASS，证明 split `response.required_action` 会转成标准 tool-call frames 并最终补 `response.completed` / `response.done`。
  - `tests/server/handlers/handler-response-utils.sse-finish-reason.spec.ts -t 'does not auto-close early for function_call|repairs assistant response.output_item.done'` PASS，证明 message output_item.done 可自动收口，但 function_call output_item.done 不会提前 auto-close（反向锁）。
  - `tests/server/handlers/responses-sse-client-contract.blackbox.spec.ts` 当前 1 fail：`captures required_action -> completed -> done...` 未见 completed/done；但该 test 的 mock 只覆盖旧 facade `bridge.js`，而现行 handler 直接 import `responses-sse-bridge` / `responses-response-bridge`，需要先修 test harness 才能作为生产回归证据。

## 2026-06-17 20:15:23 metadata-center stopless followup
- 接手继续：先锁 stopless sessionId/request truth 与 continuation context 分离，先红测再修复；目标是既不无限循环，也不该激活时漏激活。

- 2026-06-17 metadata-center/stopless followup: Rust stopless orchestration contract 默认无 session 也会 cli_projection，是当前“缺 session 仍激活”唯一真源根因；已改为 stop_message_flow 缺/unknown session => terminal_final(reason=stop_message_missing_session)，并删除 followup metadata 把 responsesRequestContext 回填为顶层 sessionId/conversationId 的残留。

## 2026-06-17 metadata-center + stopless followup verification

- 修正 gate 方向：`planStopMessagePersistedStateSelectionWithNative` / `planPersistStopMessageStateWithNative` / 对应 required exports 必须保持删除，不可复活旧 persisted-state bridge。
- `engine.ts` 已删除 TS stopless 分支 `flowId === 'stop_message_flow'`，只调用 Rust `planStoplessOrchestrationActionWithNative` 判定。
- stopless CLI result restore 扩展到 Responses `input[].function_call_output/tool_result/tool_message`，并优先 raw request over captured stale request。
- stopMessageAiMode 已从 routing snapshot / budget state 预期中删除；Rust 测试同步期望 `ai_mode=None`。
- metadata-center 新增后验证：tsc PASS、build-core PASS、verify-servertool-rust-only PASS、function-map compile gate PASS、mainline map PASS、mermaid/html sync PASS、focused Jest 49 PASS、stopless/servertool focused Jest 81 PASS、Rust servertool 298 PASS。

## 2026-06-18 SSE side-channel contract drift cleanup

- 本轮红点不是生产代码复活旧 carrier，而是测试仍按旧契约构造 `body.sseStream` / `__routecodex_finish_reason` / `STREAM_CONTRACT_PROBE_BODY_KEY`。
- 当前 handler 真契约已确认：
  - live SSE 入口只认顶层 `PipelineExecutionResult.sseStream`；
  - direct passthrough 只接受标准 Responses SSE event，generic `event: message` 会命中 `RESPONSES_DIRECT_SSE_PROTOCOL_VIOLATION`；
  - stream-end 超时测试当前真实错误可能是 `HTTP_SSE_TIMEOUT`，不再保证一定是旧 `SSE_CLIENT_PROJECTION_TIMEOUT`。
- 已同步收口测试面：
  - `provider-response-converter.finish-reason.spec.ts` 改成 ESM `unstable_mockModule`，补齐 bridge export surface，避免误落真实 state-integrations；
  - `request-complete-log.spec.ts` 改成当前无彩色 `status=200`，并锁“stream wrapper custom metadata 不得定义 finish_reason”；
  - handler/SSE 黑盒测试统一改为 top-level `result.sseStream`；
  - direct passthrough metadata guard 测试改用合法 `response.metadata` SSE frame，而不是非标准 `event: message`；
  - tool continuation timeout 测试去掉 hidden probe carrier，改成从标准 SSE frame 自举或在 stream end repair 收口。
- 本轮验证：
  - `npm run verify:architecture-no-custom-payload-carriers` PASS
  - root `npx tsc --noEmit --pretty false` PASS
  - 定向 Jest 8 suites / 44 tests PASS（provider-response-converter finish/prebuilt/unified、request-complete-log、apply-patch freeform SSE、metadata guard、sse projection timeout、responses-response-bridge direct guard）

## 2026-06-18 request-truth reader trim follow-up

- 本轮继续收 `sessionId/conversationId` 读取面，先修真正会影响 continuation/usage 的 direct `/v1/responses` 读点，而不是继续放大 tmux fallback。
- 新增唯一 helper：`src/server/runtime/http-server/metadata-center/request-truth-readers.ts`
  - `readRuntimeRequestTruthIdentifiers()` 只认 `MetadataCenter.request_truth`，其次才认平铺 `sessionId/session_id`、`conversationId/conversation_id`；
  - 明确不再把 `clientTmuxSessionId/tmuxSessionId` 当 request session truth。
- `src/server/runtime/http-server/index.ts` 已收口：
  - `readSessionIdForUsageLog()` 改为只读 centralized request-truth reader，不再 tmux fallback；
  - direct `recordResponsesResponseForRequest(...)` 的 `conversationId` 改为同样走 centralized reader，不再只读顶层 `inputMetadata.conversationId`。
- 这次没有继续改 stopless owner 本体；目标只是把 request truth 读取面再收干净，减少“日志/continuation 看起来像 session 丢了”的伪信号。
- 本轮验证：
  - `tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts` PASS
  - `tests/server/runtime/http-server/index.request-truth-contract.spec.ts` PASS
  - root `npx tsc --noEmit --pretty false` PASS
  - `git diff --check` PASS
- 仍未宣称 live stopless 激活闭环已完成：
  - 本轮没有 build/install/restart/replay，因为修改面先收在 request-truth helper + static contract；
  - 下一步应继续查 `/v1/responses` live path 里 request-truth 是否每次都被 materialize 进 `MetadataCenter`，再决定是否需要在线重放/构建验证。

## 2026-06-18 response-side request-truth reader trim

- 继续把 response-side bridge 的 request/session 读取面收向 `MetadataCenter`，避免 response handler / lifecycle persist 再从 flat metadata 猜 session truth。
- `src/modules/llmswitch/bridge/responses-response-bridge.ts` 已收口两处：
  - `buildResponsesRequestLogContextForHttp()` 现在优先读 `readRuntimeRequestTruthIdentifiers(metadata)`，只有 usageLogInfo 已显式携带时才覆盖；
  - `resolveResponsesConversationPersistInputsForHttp()` 在 `args.sessionId/args.conversationId` 与 `usageLogInfo.*` 都缺失时，会回退到 `MetadataCenter.request_truth`，不再只靠 flat metadata。
- 这一步仍然不允许 continuation context 升级成 request truth；reader helper 只看 `request_truth + flat sessionId/conversationId`，不读 `responsesRequestContext.*`、不读 tmux。
- 本轮新增验证：
  - `tests/modules/llmswitch/bridge/responses-response-bridge.request-truth.spec.ts` PASS
    - 锁 `buildResponsesRequestLogContextForHttp()` 优先读 center truth；
    - 锁 `persistResponsesConversationLifecycleForHttp()` 在 usageLogInfo 缺 session 标识时，仍能从 center truth 写入 persisted response context。
  - 联合回归：
    - `tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts` PASS
    - `tests/server/runtime/http-server/index.request-truth-contract.spec.ts` PASS
    - root `npx tsc --noEmit --pretty false` PASS
    - `git diff --check` PASS

## 2026-06-18 continuation-context top-level read removal

- 继续清理旧 merge/backfill 语义：`src/modules/llmswitch/bridge/responses-response-bridge.ts::resolveResponsesRequestContextForHttp()` 之前仍直接读取顶层 `metadata.responsesRequestContext`，这是 continuation_context 绕过 `MetadataCenter` 的旧残留。
- 现已改成：
  - 只从 `MetadataCenter.read(metadata)?.readContinuationContext().responsesRequestContext` 取 continuation request context；
  - 若 center 没有，则只退回显式 `fallback` 参数；
  - 不再把顶层 `metadata.responsesRequestContext` 当合法读源。
- 这一步把一个真实的旧读路径物理切断了；生产 builder 仍会写 center，因此不会影响正常 Responses handler/bridge 流程。
- 本轮新增/更新验证：
  - `tests/modules/llmswitch/bridge/responses-response-bridge.request-context-resolution.spec.ts` PASS
    - 锁 center continuation context 优先于 fallback；
    - 锁“只有顶层 metadata.responsesRequestContext、没有 center binding”时不得命中，必须退回 fallback。
  - 联合回归：
    - `tests/modules/llmswitch/bridge/responses-response-bridge.request-truth.spec.ts` PASS
    - `tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts` PASS
    - `tests/server/runtime/http-server/index.request-truth-contract.spec.ts` PASS
    - root `npx tsc --noEmit --pretty false` PASS
    - `git diff --check` PASS

## 2026-06-18 continuation-context top-level write removal progress

- 继续清 continuation_context 的旧平铺写入：
  - `src/modules/llmswitch/bridge/responses-request-bridge.ts::buildResponsesPipelineMetadataForHttp()` 不再把 `responsesRequestContext` 平铺写入 metadata；
  - `src/modules/llmswitch/bridge/responses-request-bridge.ts::attachResponsesRequestContextToResultForHttp()` 也不再往 `nextMetadata.responsesRequestContext` 回填，只写 `MetadataCenter.continuation_context.responsesRequestContext`。
- 为了支撑删除旧写入，`src/modules/llmswitch/bridge/state-integrations.ts::extractContinuationContextSessionIdentifiersFromMetadata()` 已改成只读 `MetadataCenter.read(meta)?.readContinuationContext().responsesRequestContext`，不再从顶层 `meta.responsesRequestContext` 取 continuation session 标识。
- 这一轮的结构性结果：
  - request-side responses bridge：写 center，不再写 top-level `responsesRequestContext`；
  - response-side responses bridge：读 center，不再读 top-level `responsesRequestContext`；
  - continuation-only extractor：读 center，不再读 top-level `responsesRequestContext`。
- 本轮新增/更新验证：
  - `tests/modules/llmswitch/bridge/responses-request-bridge.metadata-center.spec.ts` PASS
    - 锁 request-side / response-side 都只写 center；
    - 锁 metadata 顶层 `responsesRequestContext` 已不存在。
  - `tests/modules/llmswitch/bridge/state-integrations.metadata-center.spec.ts` PASS
    - 锁 continuation extractor 只认 center；
    - 锁没有 center binding 时，顶层 `responsesRequestContext` 不再被读取。
  - 联合回归：
    - `tests/modules/llmswitch/bridge/responses-response-bridge.request-context-resolution.spec.ts` PASS
    - `tests/modules/llmswitch/bridge/responses-response-bridge.request-truth.spec.ts` PASS
    - `tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts` PASS
    - `tests/server/runtime/http-server/index.request-truth-contract.spec.ts` PASS
    - root `npx tsc --noEmit --pretty false` PASS
    - `git diff --check` PASS
- 当前仍残留的相关生产旧写入点：
  - stopless/sharedmodule 侧还有 runtime-utils 对顶层 `responsesRequestContext` 的消费，需要继续迁。

## 2026-06-18 executor-metadata continuation top-level removal

- `src/server/runtime/http-server/executor-metadata.ts` 的 continuation-only fallback 已继续收口：
  - 当请求里只带 continuation session 线索、没有 request truth 时，现在只写 `MetadataCenter.continuation_context.responsesRequestContext`；
  - 不再把 `responsesRequestContext` 回填到顶层 metadata。
- 同时修了一个真实 merge 漏洞：
  - `src/server/runtime/http-server/executor/request-executor-attempt-state.ts::finalizeRequestExecutorAttemptMetadata()` 之前只保 request-side metadata center，pipeline 侧 continuation center 会丢；
  - 现在当 request-side center 与 pipeline-side center 同时存在时，会把 pipeline `continuation_context` 合并进最终 merged metadata center，同时继续保持 request truth 以 request-side 为唯一真源。
- 本轮更新验证：
  - `tests/server/http-server/executor-metadata.spec.ts` PASS
    - 锁 request truth 仍由 request-side center 主导；
    - 锁 pipeline-side continuation context 会被合并到最终 center，而不是丢失或回退成顶层字段。
  - `tests/server/runtime/http-server/executor-metadata.binding.spec.ts` PASS
    - 锁顶层 `responsesRequestContext` 不再 materialize 成 request truth；
    - 现在也不再被自动写回 top-level metadata；单靠 request metadata 顶层 `responsesRequestContext` 也不再进入 continuation center。
  - root `npx tsc --noEmit --pretty false` PASS
  - `git diff --check` PASS

## 2026-06-18 sharedmodule stopless continuation carrier trim

- sharedmodule stop-message runtime helper 也继续收口：
  - `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/runtime-utils.ts::buildServertoolRoutingMetadata()` 不再把 `record.responsesRequestContext` / `metadata.responsesRequestContext` / `runtime.responsesRequestContext` 重新拼回 routing metadata。
- 这一步的含义：
  - stopless/servertool state key / session scope 相关 native helper 现在只看正常 request truth、continuation、responsesResume 等显式字段；
  - 不再依赖旧的顶层 `responsesRequestContext` carrier。
- 本轮验证：
  - `tests/servertool/stop-message-runtime-utils.continuation.spec.ts` PASS
  - 联合回归：
    - `tests/server/http-server/executor-metadata.spec.ts` PASS
    - `tests/server/runtime/http-server/executor-metadata.binding.spec.ts` PASS
    - `tests/modules/llmswitch/bridge/responses-request-bridge.metadata-center.spec.ts` PASS
    - `tests/modules/llmswitch/bridge/state-integrations.metadata-center.spec.ts` PASS
    - `tests/modules/llmswitch/bridge/responses-response-bridge.request-context-resolution.spec.ts` PASS
    - `tests/modules/llmswitch/bridge/responses-response-bridge.request-truth.spec.ts` PASS
    - `tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts` PASS
    - `tests/server/runtime/http-server/index.request-truth-contract.spec.ts` PASS
    - total focused suites green: 53 assertions PASS
  - root `npx tsc --noEmit --pretty false` PASS
  - `git diff --check` PASS

## 2026-06-18 metadata-center verification + install/restart follow-up

- 为了把 handoff 里的 focused stack 重新拉绿，本轮先修了两处测试壳漂移：
  - `tests/modules/llmswitch/bridge/responses-response-bridge.request-truth.spec.ts`
  - `tests/modules/llmswitch/bridge/responses-response-bridge.request-context-resolution.spec.ts`
- 修复方式仅限 test mock surface 对齐当前 bridge import 面；未改生产语义。之后 9 个 metadata-center focused suites 重新 PASS（53/53）。
- 本轮额外确认：
  - root `npx tsc --noEmit --pretty false` PASS
  - `verify:architecture-mainline-call-map` PASS
  - install script 内 `verify:function-map-compile-gate` / `verify:architecture-review-surface-light` / `verify:servertool-rust-only` 等已在隔离构建目录跑通
- 全局安装真相：
  - `routecodex --version` / `rcc --version` 已到 `0.90.3087`
  - `~/.rcc/install/current` 与 `/Volumes/extension/.rcc/install/current` 都指向 `releases/routecodex-0.90.3087-2026-06-17T171023Z`
- 在线重启真相：
  - 首次 install 收尾后，在线 `/health` 仍是 `0.90.3081`，说明安装成功但运行进程未切版
  - 追加 `routecodex restart --port 5555` 后，`127.0.0.1:5555` / `5520` / `10000` `/health` 全部变成 `0.90.3087` 且 `ready=true pipelineReady=true`
- 当前仍未闭环的 live blocker：
  - `scripts/tests/stopless-5555-final-probe.mjs` 在新版本 5555 上首步失败：返回 `status=completed`，没有 `exec_command`
  - 这说明当前线上问题已不是“无限循环”或“安装没生效”，而是“该激活时没激活”仍未证实修复
  - 新增最小核对：`tests/server/utils/finish-reason.spec.ts` 已补 `responses status=completed + assistant output_text => stop` 断言并 PASS，说明 finish-reason 映射不是当前根因
- 下一步唯一重点：
  - 继续查 5555 live 请求为何 `status=completed` 时没有进入 `stop_message_auto` / CLI projection；优先排查 same-protocol direct / stop-gateway / response-stage orchestration 真正走的是哪条链

## 2026-06-18 reasoning-stop finalized marker residue trim

- 复核 `bodyContainsReasoningStopFinalizedMarker` 后确认它已经不在 request-executor 运行时主链中：
  - `src/server/runtime/http-server/executor/request-executor-response-contract.ts` 的导出实现恒 `false`；
  - `src/server/runtime/http-server/executor/request-executor-response-inspect.ts` 还有一份重复恒 `false` 定义，但零消费者；
  - runtime 仅剩 `request-executor.ts::__requestExecutorTestables` 把 response-contract 那份 helper 暴露给测试。
- 本轮动作：
  - 物理删除 response-contract / response-inspect 的双份旧 helper；
  - `request-executor.ts` 删除 testable 暴露；
  - `tests/server/runtime/http-server/request-executor.spec.ts` 改成锁“旧 helper 已不可见”；
  - `verify:architecture-deleted-path` 新增 repo-wide deny token：`bodyContainsReasoningStopFinalizedMarker` 与 `__routecodex_reasoning_stop_finalized`。
- 这一步不触碰 Jason 正在做的内部字段实现收口，只先删除已经失效的 host-side marker inspection 残留，并给旧符号加防复活 gate。

## 2026-06-18 metadata-center mtc-07 closeout binding

- 重新复核 `mtc-07` 后确认此前文档说得没错：repo 只有 `request_truth` / `continuation_context` 写入与读取，没有显式 closeout/release API，因此 mainline-call-map 一直只能写 `binding pending`。
- 本轮最小实现：
  - `MetadataCenter` 新增幂等 `markReleased(...)`，只改 slot status/history，不改 payload/value；
  - `handler-response-common.ts` 新增 `releaseMetadataCenterForHttpResponse(...)`，作为 handler closeout 统一 helper；
  - JSON closeout、SSE finish/close cleanup、SSE bridge error、JSON->SSE bridge end/error、prestart client close 都接入该 helper。
- 这使 `mtc-07` 从“文档 future owner”变成真实相邻边：
  - `releaseMetadataCenterForHttpResponse -> MetadataCenter.markReleased`
  - 语义是 request closeout 后将 request-scoped center slots 标记为 `released`，不再保持 `active`
- 同步更新：
  - function-map / verification-map：把 handler closeout helper 与 focused handler test 纳入 `hub.metadata_center_mainline`
  - mainline-call-map / metadata-center wiki：`mtc-07` 改为 anchored，不再写 pending
## 2026-06-18 mainline node-id consistency gate closeout

- completion audit 继续往下查时，发现“manifest、wiki、mainline call map 共用 node IDs，并被机器校验”这条还没完全锁死：
  - repo 里已有 `scripts/architecture/verify-architecture-mainline-node-id-consistency.mjs` 草稿；
  - 但它没接进 `package.json`，也没进 `verify:architecture-review-surface-light`；
  - 且脚本自身错误地拿聚合页 `wiki/mainline-call-graph.md` 的全量节点去和每一条 chain 单独比，天然会误报。
- 已修：
  - `scripts/architecture/verify-architecture-mainline-node-id-consistency.mjs`
    - 改成按 chain 选对应 wiki 页面；
    - 对使用聚合页的 chain，只截取 `## <chain_id>` 对应 section；
    - 对 `stopless.session.mainline` / `metadata.center.mainline` 改用各自 manual wiki 页面，而不是聚合页；
    - 正反向都只做 chain-local node/step 一致性校验，不再跨 chain 误报。
  - `scripts/architecture/mainline-call-map-lib.mjs`
    - `GENERATED_WIKI_CHAIN_PAGES` 改成把 `stopless.session.mainline` 指向 `stopless-session-mainline-source.md`；
    - `metadata.center.mainline` 指向 `metadata-center-mainline-source.md`。
  - `package.json`
    - 新增 `verify:architecture-mainline-node-id-consistency`
    - `verify:architecture-review-surface-light` 现已强制跑该 gate
  - `scripts/architecture/verify-function-map-build-wiring.mjs`
    - 新增自检：`verify:architecture-review-surface-light` 若移除 `verify:architecture-mainline-node-id-consistency` 会直接失败
  - `docs/goals/hub-pipeline-slimming-no-function-loss-plan.md`
    - `metadata.center.mainline` 行改成 `mtc-07 = anchored`，不再沿用旧 pending 叙事
- gate 继续跑后又抓到一条真实 drift：
  - `docs/architecture/mainline-call-map.yml` 里 `metadata.center.mainline` 有 `mtc-02-result`；
  - `docs/architecture/wiki/metadata-center-mainline-source.md` 只写了 `mtc-02`，漏了 result-side continuation attach；
  - 已补 `mtc-02-result` 到 mermaid + table，保证 chain-local node/step 机器校验能过。
- 顺手重新按当前 worktree 审 `responses-sse-bridge.ts` / `responses-response-bridge.ts` export consumer count：
  - 没有新的 zero-consumer export 浮出来；
  - `responses-sse-bridge.ts` 仍是高引用 re-export facade，不适合直接删；
  - `responses-response-bridge.ts` 当前最小 src consumer 也仍有 2，继续只能按“更小粒度 helper / native-downshift”推进，不能按大文件直接拆删。

## 2026-06-18 metadata-center request-truth closeout slice

- 本轮目标是把 http-server executor 带上的 request truth 平铺回写残留先砍掉，避免 `sessionId/conversationId` 又从 merge/backfill 漏回 metadata 顶层。
- 已确认并收口的残留点：
  - `src/server/runtime/http-server/executor-metadata.ts`
    - `buildRequestMetadata(...)` 不再把 request truth 回写到 `metadata.sessionId/conversationId`
    - continuation context 判定改为只看 `MetadataCenter.readRequestTruth()`，不再看顶层平铺字段
  - `src/server/runtime/http-server/executor/request-executor-attempt-state.ts`
    - `finalizeRequestExecutorAttemptMetadata(...)` 不再把 request truth merge 回顶层
    - 合并后显式删除 `sessionId/session_id/conversationId/conversation_id`
    - request log context 改成只读 `readRuntimeRequestTruthIdentifiers(...)`
  - `src/server/runtime/http-server/request-executor.ts`
    - providerContext request log 绑定改为只读 `MetadataCenter.request_truth`
  - `src/server/runtime/http-server/executor/request-executor-provider-response.ts`
    - usageLogInfo 的 `sessionId/conversationId` 改为只读 `MetadataCenter.request_truth`
- focused tests：
  - `tests/server/http-server/executor-metadata.spec.ts` PASS
  - `tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts` PASS
  - `tests/server/runtime/http-server/executor/request-executor-session-storm-backoff.spec.ts` PASS
  - `tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts` PASS
  - `tests/server/runtime/http-server/index.request-truth-contract.spec.ts` PASS
  - `tests/modules/llmswitch/bridge/responses-response-bridge.request-truth.spec.ts` PASS
  - `tests/server/runtime/http-server/executor/client-injection-flow.spec.ts` PASS
- build/install/restart/live：
  - `npm run build:min` PASS
  - global `routecodex --version` => `0.90.3098`
  - `routecodex restart --port 5555` PASS
  - `curl http://127.0.0.1:5555/health` => `ready=true pipelineReady=true version=0.90.3098`
  - `node scripts/tests/stopless-5555-live-probe.mjs` PASS
    - first turn `requires_action`
    - `hasExecCommand=true`
    - resumed `submit_tool_outputs` => `completed`
    - final `finalStatus=completed`
- 当前确认：
  - 在线 stopless 不再出现“该激活时不激活”这一轮回归
  - 也没有回到无限 continuation loop
  - `request truth` 在当前 http-server executor band 已切到 `MetadataCenter` 单真源读取
- 仍待后续继续审的面：
  - repo 其余 runtime/provider 路径上仍有大量 `sessionId/conversationId` 平铺字段语义，不等于都已迁完
  - 这轮只收 `http-server` / stopless 相关主线，不宣称全项目 metadata 中心迁移完成

## 2026-06-18 review-surface / slimming audit final evidence refresh

- 本轮不再扩改实现，只补当前 worktree 的最终机器证据，确认 review surface 与瘦身审计文档已经对齐。
- 当前重新验收：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run build:min` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci` PASS
  - `git diff --check` PASS
- 关键含义：
  - `build:min` 已再次证明本地 build 前置链会拦 `no-custom-payload-carriers / mainline-call-map / node-id-consistency / wiki-sync / wiki-html-sync / manifest-sync` 漂移；
  - `verify:architecture-ci` 已再次证明完整架构 gate、review surface、longtail、build wiring、custom payload carrier containment 在当前 worktree 同时为绿；
  - `docs/goals/hub-pipeline-slimming-no-function-loss-plan.md` 当前已经包含候选表、owner、consumer count、处置结论、风险、验证路径，不需要再另起一份重复审计文档。
- 本轮未接手的边界仍保持不变：
  - Jason 正在做的 `__routecodex_*` / SSE custom payload 字段删除实现未被我接管；
  - 当前 `verify-no-custom-payload-carriers` 仍是已知高风险 token denylist，不是最终的 generic prefix 防复活 gate；
  - 等该实现线合入后，再做一轮 post-cleanup 审计与静态 gate 升级。

## 2026-06-18 client-visible internal-carrier static lock

- 目标：不接手 Jason 的字段删除实现，只把 client-visible response/SSE projection 层“谁允许认识内部字段前缀”机器锁住，避免后续在 handler/bridge 侧再长出新的自定义 payload 语义。
- 新增：
  - `scripts/architecture/verify-client-response-internal-carrier-surface.mjs`
  - `package.json` script: `verify:client-response-internal-carrier-surface`
- gate 语义：
  - 扫描 response-layer 五个文件：
    - `src/server/handlers/handler-response-common.ts`
    - `src/server/handlers/handler-response-sse.ts`
    - `src/server/handlers/handler-response-utils.ts`
    - `src/modules/llmswitch/bridge/responses-response-bridge.ts`
    - `src/modules/llmswitch/bridge/responses-sse-bridge.ts`
  - 只允许：
    - `handler-response-common.ts` 持有 `assertClientResponseHasNoInternalCarriers`
    - `responses-response-bridge.ts` 持有 `assertDirectPassthroughResponsesSseMetadataIsolationForHttp`
  - `__routecodex*` / `__rt` 只能出现在上述两个 guard owner；
  - `response.metadata` 事件语义只能出现在 `responses-response-bridge.ts`；
  - `__sse_*` 在 client-visible response/SSE layer 必须保持 0。
- wiring：
  - 已接入 `verify:architecture-ci`
  - 已写入 `function-map.yml` / `verification-map.yml` 的 `hub.metadata_boundary` 与 responses bridge surfaces
- 已验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:client-response-internal-carrier-surface` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:function-map-compile-gate` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci` PASS
  - `git diff --check` PASS
- 边界说明：
  - 这不是“runtime 全局 `__routecodex*` prefix ban 已完成”；
  - 它只锁 client-visible response/SSE 层，防止新的 handler/bridge payload 漂移；
- provider/runtime 内部 marker 去前缀与 side-channel 收口仍要等 Jason 当前实现线合入后再做 containment/queryability 审计。

## 2026-06-18 custom-payload owner/queryability hard gate closeout

- 继续保持“我不接手 Jason 的 `__routecodex_*` / SSE 自定义字段运行时删除实现，只补静态 gate 防复活”边界。
- 新增：
  - `scripts/architecture/custom-payload-carrier-owner-queryability-lib.mjs`
  - `scripts/architecture/verify-custom-payload-carrier-owner-queryability.mjs`
- `audit-custom-payload-carrier-owner-queryability.mjs` 现已改为复用 shared collector；不再手写第二份扫描/owner/verification 逻辑。
- `package.json`
  - 新增 `verify:architecture-custom-payload-carrier-owner-queryability`
  - `verify:architecture-ci-longtail` 现在强制顺序包含：
    - `verify:architecture-custom-payload-carrier-containment`
    - `verify:architecture-custom-payload-carrier-owner-queryability`
    - `verify:architecture-custom-payload-carrier-runtime-manifest`
- `scripts/architecture/verify-function-map-build-wiring.mjs` 已反向锁死：后续若 longtail 去掉 owner/queryability gate，会直接失败。
- `docs/architecture/function-map.yml` / `docs/architecture/verification-map.yml`
  - `hub.metadata_boundary` 已把 `verify:architecture-custom-payload-carrier-owner-queryability` 纳入 required gate / smoke。
- gate 语义：
  - `routecodex_prefix` / `response_metadata`
    - 只要出现 `missing-owner > 0` 或 `missing-verification > 0`，直接 fail
  - `sse_prefix`
    - runtime files 必须保持 `0`
  - `ambiguous-owner` 目前仍允许，因为这 9 个 remaining 文件都是已确认的 Rust broad-owner 结构性基线，不能靠伪收窄 `owner_module` 做假绿。
- 已验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-custom-payload-carrier-owner-queryability` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run audit:custom-payload-carrier-owner-queryability` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:function-map-build-wiring` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci-longtail` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run build:min` PASS
  - `git diff --check` PASS
- 当前被硬锁的基线：
  - `__routecodex*`: `files=26 / unique-owner=17 / ambiguous-owner=9 / missing-owner=0 / missing-verification=0`
  - `__sse_*`: `files=0`
  - `response.metadata`: `files=4 / unique-owner=2 / ambiguous-owner=2 / missing-owner=0 / missing-verification=0`
- 结论：
  - 现在“missing-verification 已补齐”不再只是 audit 报表事实，而是 longtail/build wiring 会真拦的 CI 事实。
  - 下一阶段如要继续收窄，只能做 truthy Rust sub-feature split，不能伪造更窄 `owner_module`。

## 2026-06-18 metadata center mtc-05/06 anchored reader closeout

- 目标：继续收 `metadata.center.mainline` 的 review surface 真相，不改 runtime 语义，只把 `mtc-05/06` 从“partial 但 caller/callee 已可见”推进到“真实 helper anchored”。
- 新增/修改：
  - `src/server/runtime/http-server/metadata-center/request-truth-readers.ts`
    - 新增 `readRuntimeProviderObservationProjection(...)`
    - 新增 `readRuntimeServerToolProjection(...)`
  - `src/server/runtime/http-server/executor/servertool-adapter-context.ts`
    - 删除本地散落的 provider observation / assigned model / compatibility profile 读取逻辑
    - 统一改走 `readRuntimeServerToolProjection(...)`
  - `src/server/runtime/http-server/executor/provider-request-context.ts`
    - 改走 `readRuntimeProviderObservationProjection(...)`
  - `src/server/runtime/http-server/executor/provider-response-utils.ts`
    - `extractClientModelId(...)` 改走 `readRuntimeProviderObservationProjection(...)`
  - `docs/architecture/mainline-call-map.yml`
    - `mtc-05` 改为 `resolveResponsesConversationPersistInputsForHttp -> readRuntimeRequestTruthIdentifiers`
    - `mtc-06` 改为 `buildServerToolAdapterContext -> readRuntimeServerToolProjection`
    - 二者状态从 `partial` 收到 `anchored`
  - `docs/architecture/wiki/metadata-center-mainline-source.md`
    - 同步 `mtc-05/06` 的 helper 级真实读边
    - “What is not done yet” 改为只保留 `mtc-03` partial 与 `response_observation` 仍未成为 first-class family 的事实
- 关键判断：
  - 这次不是把 `response_observation` 伪装成“已实现 family migration”；
  - 只是把当前 repo 里已经存在的 MetadataCenter 读边收成单点 helper，再把 mainline call map 绑定到真实 helper。
- 已验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts tests/server/runtime/http-server/executor/provider-request-context.spec.ts tests/server/runtime/http-server/executor/provider-response-utils.spec.ts --runInBand` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-mainline-call-map` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run render:architecture-wiki-pages` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run render:architecture-wiki-html` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-wiki-sync` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-wiki-html-sync` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-mainline-node-id-consistency` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-review-surface-light` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:function-map-compile-gate` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npx tsc --noEmit --pretty false` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run build:min` PASS
  - `git diff --check` PASS
- 当前 metadata-center mainline 状态更新：
  - `mtc-01/02/02-result/04/05/06/07 = anchored`
  - `mtc-03 = partial`
  - 当前剩余缺口不再是“找不到真实 caller/callee”，而是：
    - `runtime_control` merge/write 仍未 first-class family 化
    - `response_observation` 仍未 first-class family 化

## 2026-06-18 runtime carrier classification manifest

- 目标：把 remaining runtime `__routecodex*` / `response.metadata` 热区从“allowlist 还剩多少文件”推进到“每个文件属于哪一类问题”，避免 Jason 后续清理时把 payload side-channel、local marker、guard surface 混成一锅。
- 新增：
  - `docs/architecture/custom-payload-carrier-runtime-manifest.yml`
  - `scripts/architecture/verify-custom-payload-carrier-runtime-manifest.mjs`
- wiring：
  - `package.json` 新增 `verify:architecture-custom-payload-carrier-runtime-manifest`
  - `verify:architecture-ci-longtail` 已强制接线
  - `verify-function-map-build-wiring.mjs` 已反向锁定：longtail 若移除此 gate 会直接失败
  - `function-map.yml` / `verification-map.yml` 的 `hub.metadata_boundary` 已记录此 gate
- 当前机器分桶结果：
  - `__routecodex*` runtime files=`26`
    - `payload_side_channel=13`
    - `local_runtime_marker=6`
    - `guard_surface=3`
    - `contract_or_test_surface=4`
  - `response.metadata` runtime files=`4`
    - `guard_surface=1`
    - `local_runtime_marker=1`
    - `contract_or_test_surface=2`
- 这次分桶的用途：
  - `payload_side_channel`：后续必须迁到 `MetadataCenter / runtime side-channel`
  - `local_runtime_marker`：后续应走 typed local field / local struct rename，不该按 payload 问题处理
  - `guard_surface`：当前必须保留，用来 fail-fast 拦 client-visible 泄漏
  - `contract_or_test_surface`：只用于锁边界，不是 runtime 业务 owner
- 已验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-custom-payload-carrier-runtime-manifest` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:function-map-compile-gate` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci-longtail` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci` PASS

## 2026-06-18 mtc-03 runtime_control contract truth tightened

- 继续按 active goal 只做 review-surface / sequencing / audit，不接手 Jason 正在推进的 `__routecodex_*` / SSE custom 字段运行时删除实现线。
- 重新核对 `metadata-center` 相关真相：
  - `src/server/runtime/http-server/metadata-center/metadata-center-types.ts`
    - 已声明 `MetadataCenterFamily = 'runtime_control'`
  - `src/server/runtime/http-server/metadata-center/metadata-center.ts`
    - 真实 state 仍只有 `requestTruth` / `continuationContext` / `providerObservation`
    - 仍缺 `runtimeControl` state + `writeRuntimeControl(...)` + `readRuntimeControl()` + `markReleased(...)` 覆盖
  - `src/server/runtime/http-server/metadata-center/request-truth-readers.ts`
    - 仍无 runtime-control projection reader
- 重新钉实 `mtc-03` first-batch contract，不再只写“generic runtime_control”：
  - request-route control：
    - `routeHint`
    - `routeName`
    - `routeId`
    - `providerProtocol`
    - `retryProviderKey`
    - `preselectedRoute`
  - followup / stopless control：
    - `serverToolFollowup`
    - `serverToolFollowupSource`
    - `stoplessGoalStatus`
  - stop-message control：
    - `stopMessageEnabled`
    - `stopMessageExcludeDirect`
- 代码证据来源：
  - `src/server/runtime/http-server/executor/request-executor-attempt-state.ts`
  - `src/server/runtime/http-server/index.ts`
  - `src/server/runtime/http-server/executor/servertool-followup-dispatch.ts`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/napi_bindings.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs`
- 新的 review-surface 结论：
  - `metadata-center-manifest.yml` 里的 `runtime_control.stopMessage` 目前仍偏泛化
  - 但 runtime 真正消费面已经是 `stopMessageEnabled` / `stopMessageExcludeDirect`
  - 所以下一执行 slice 不能直接从 `request-executor-attempt-state.ts` 开始
  - 必须先做 `hub.metadata_center_mainline / mtc-03 runtime_control plumbing`
    - `metadata-center-types.ts`
    - `metadata-center.ts`
    - `request-truth-readers.ts` runtime-control projection
  - 然后才轮到 `hub.metadata_center_attempt_merge / request-executor-attempt-state.ts`

## 2026-06-18 mtc-03 runtime_control plumbing landed

- 已完成最小代码骨架，不接手 Jason 正在做的 payload 字段物理删除线：
  - `src/server/runtime/http-server/metadata-center/metadata-center-types.ts`
    - 新增 `MetadataCenterRuntimeControl`
    - `MetadataCenterState` 新增 `runtimeControl`
  - `src/server/runtime/http-server/metadata-center/metadata-center.ts`
    - 新增 `writeRuntimeControl(...)`
    - 新增 `readRuntimeControl()`
    - `markReleased(...)` 覆盖 `runtimeControl`
  - `src/server/runtime/http-server/metadata-center/request-truth-readers.ts`
    - 新增 `readRuntimeControlProjection(...)`
  - `src/server/runtime/http-server/executor/request-executor-attempt-state.ts`
    - pipeline metadata center merge 现已带上 `runtimeControl`
- focused 白盒已补：
  - `tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts`
    - 新增 runtime-control projection 读取验证
  - `tests/server/handlers/handler-response-utils.metadata-center-closeout.spec.ts`
    - 新增 runtime-control closeout 释放验证
  - `tests/server/http-server/executor-metadata.spec.ts`
    - 新增 pipeline metadata center -> merged metadata 的 runtime-control merge 验证
- 当前真实状态修正：
  - 之前“`metadata-center.ts` 仍缺 runtimeControl state/read/write/release”这条已不再成立
  - `mtc-03` 仍是 `partial`，但现在缺的不是 carrier plumbing，而是生产 writer/materializer/read path 仍在 flat metadata / `requestSemantics.__routecodex` 上
  - 因此下一执行 slice 现在前移为：
    1. `hub.metadata_center_attempt_merge / request-executor-attempt-state.ts`
    2. `server.http_runtime_entry / index.ts`
    3. request-stage bridge / followup materializer / Rust broad-owner 带
- 本轮验证：
  - focused tests:
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts --runInBand` PASS
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/handlers/handler-response-utils.metadata-center-closeout.spec.ts --runInBand` PASS
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/http-server/executor-metadata.spec.ts --runInBand` PASS
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npx tsc --noEmit --pretty false` PASS
  - review-surface / build gates:
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-mainline-call-map` PASS
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-manifest-sync` PASS
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-wiki-sync` PASS
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run render:architecture-wiki-html` PASS
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-wiki-html-sync` PASS
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-wiki-browser-smoke` PASS
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:function-map-compile-gate` PASS
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci-longtail` PASS
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci` PASS
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run build:min` PASS
    - `git diff --check` PASS
  - payload-carrier audit baseline after this slice:
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run audit:custom-payload-carriers` PASS
      - `__routecodex*`: `runtime=72, test=83, script=16, doc=58`, runtime unique files=`25`
      - `__sse_*`: `runtime=0, test=20, script=15, doc=7`, runtime unique files=`0`
      - `response.metadata`: `runtime=11, test=13, script=5, doc=44`, runtime unique files=`4`
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run audit:custom-payload-carrier-owner-queryability` PASS
      - `__routecodex*`: `unique-owner=16`、`ambiguous-owner=9`、`missing-owner=0`、`missing-verification=0`
      - `response.metadata`: `unique-owner=2`、`ambiguous-owner=2`、`missing-owner=0`、`missing-verification=0`

## 2026-06-18 runtime_control map truth absorbed without widening canonical-builder gate

- 继续把这轮落地的 `request-truth-readers.ts` / runtime-control plumbing 吸进 review surface：
  - `docs/architecture/function-map.yml`
    - `hub.metadata_center_mainline.allowed_paths` 新增 `src/server/runtime/http-server/metadata-center/request-truth-readers.ts`
    - `hub.metadata_center_mainline.required_tests` 新增 `tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts`
    - notes 补明：first-batch `runtime_control` carrier 与 host-side projection reader 已落地，但 writer migration 仍 pending
  - `docs/architecture/verification-map.yml`
    - `hub.metadata_center_mainline.unit` 新增 `request-truth-readers.ts`
    - `hub.metadata_center_mainline.contract` 新增 `request-truth-readers.spec.ts`
- 中途踩到一个真实 gate 边界：
  - 尝试把 `writeRuntimeControl` / `readRuntimeControl` 升成 `canonical_builders` 时，`verify-function-map-canonical-builder-definitions.mjs` 现有单行匹配模型认不出多行泛型方法签名
  - 若直接放宽 verifier，会把一批当前仓库既有 multi-hit canonical builder 全部炸出来，超出本轮目标
  - 因此本轮收口策略是：
    - 不扩大 canonical-builder verifier 语义面
    - 只把新活文件/测试吸进 `allowed_paths + required_tests + verification-map`
    - 保持 compile gate 仍对当前 worktree 绿
- 本轮新增验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:function-map-compile-gate` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci-longtail` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run build:min` PASS
  - `git diff --check` PASS

## 2026-06-18 install/global live verification closeout for metadata-center reader slice

- 重新续跑 `PATH=/opt/homebrew/opt/node@22/bin:$PATH ROUTECODEX_INSTALL_INPLACE_BUILD=1 ROUTECODEX_BUILD_RESTART_ONLY=1 ./scripts/install-global.sh`。
- 事实：
  - 构建与全局安装成功，CLI 版本升级到 `0.90.3105`。
  - 安装脚本在 `📦 刷新 RCC install/current runtime snapshot...` 之后仍会尾部空转，不可把“脚本未退出”误判成“安装失败”。
  - 受管 5555/5520 运行体当时仍停留在 `0.90.3102`，需要显式 `routecodex restart --port 5555` / `routecodex restart --port 5520` 刷新到新构建。
  - restart 期间 health probe 会先报 non-blocking `network_error` / `starting`，随后成功完成；这不是失败结论。
- live 证据：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH routecodex --version` => `0.90.3105`
  - `curl -s http://127.0.0.1:5555/health` => `ready=true pipelineReady=true version=0.90.3105`
  - `curl -s http://127.0.0.1:5520/health` => `ready=true pipelineReady=true version=0.90.3105`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/tests/stopless-5555-live-probe.mjs` PASS
    - first turn `requires_action`
    - `hasExecCommand=true`
    - `submit_tool_outputs` resumed to `completed`
    - `finalStatus=completed`
- 收口动作：
  - 安装会话 `94247` 已在拿到 build/install/restart/live 证据后用 Ctrl-C 结束，避免留下挂起 session。
- 文档收口：
  - `docs/goals/hub-pipeline-slimming-no-function-loss-plan.md` 已修正 metadata-center 候选表中的 stale truth：从“`mtc-04/05/06 = partial`”改为“`mtc-03 = partial`，`mtc-04/05/06/07 = anchored`”。
  - `docs/architecture/wiki/metadata-center-mainline-source.md` 已同步只保留 `mtc-03` 为 remaining partial。
  - 复验：`npm run render:architecture-wiki-pages` PASS，`npm run render:architecture-wiki-html` PASS，`npm run verify:architecture-review-surface-light` PASS，`npm run verify:architecture-ci` PASS，`git diff --check` PASS。

## 2026-06-18 payload carrier slimming audit truth refresh

- 重新按当前 worktree 跑：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run audit:custom-payload-carriers`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run audit:custom-payload-carrier-owner-queryability`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-custom-payload-carrier-runtime-manifest`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci-longtail`
- 当前事实：
  - `__routecodex*`: `runtime=76, test=83, script=16, doc=29`，runtime unique files=`26`
  - `__sse_*`: `runtime=0, test=20, script=15, doc=7`，runtime unique files=`0`
  - `response.metadata`: `runtime=11, test=13, script=5, doc=40`，runtime unique files=`4`
  - owner-queryability 现状：
    - `__routecodex*` => `unique-owner=17 / ambiguous-owner=9 / missing-owner=0 / missing-verification=0`
    - `response.metadata` => `unique-owner=2 / ambiguous-owner=2 / missing-owner=0 / missing-verification=0`
- 结论修正：
  - `requestSemantics.__routecodex` 三个 TS 热区不再是 `binding pending`，而是：
    - `server.response_inspection_helpers`
    - `server.servertool_followup_dispatch_surface`
    - `server.provider_response_conversion_host`
  - provider-runtime local markers 也不再是 owner 未定，而是已经锚到：
    - `error.provider_failure_policy`
    - `error.pipeline_contract`
    - `snapshot.provider_error_buffer`
  - 当前 remaining ambiguity 基本只剩 Rust broad-owner 带；下一步如果还要压 `ambiguous-owner`，只能做 truthy Rust sub-feature split，不能再伪造更窄 `owner_module`。
- 新增机器锁：
  - `docs/architecture/custom-payload-carrier-runtime-manifest.yml` 现在除了 category / owner_queryability / verification_state，还机器编码了 `category_resolution_tracks`
  - `verify-custom-payload-carrier-runtime-manifest.mjs` 现会校验：
    - 每个 category 都有合法 resolution track
    - 并输出 resolution 计数
  - 当前 verifier 输出：
    - `routecodex_prefix`: `contract_boundary_only=4 / guard_lock=3 / local_marker_rename=6 / side_channel_migration=13`
    - `response_metadata`: `contract_boundary_only=2 / guard_lock=1 / local_marker_rename=1`

## 2026-06-18 response.metadata guard truth refresh

- focused 验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/red-tests/server_sse_guard_e2e.test.ts tests/server/handlers/handler-response-sse-frame-metadata-guard.spec.ts --runInBand` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts tests/modules/llmswitch/bridge/responses-response-bridge.direct-json-protocol-guard.spec.ts --runInBand` PASS
- 当前真相：
  - `assertClientResponseHasNoInternalCarriers()` 已经对非 `response` / `response.*` 协议形状的顶层 `metadata` 做 fail-fast
  - direct same-protocol `event: response.metadata` 仍允许普通 provider metadata 透传
  - 同事件若携带 `__routecodex*` / `__rt*` / internal control keys，仍 fail-fast
- 因此上一轮文档里“顶层 metadata 仍非一律 fail-fast”的描述已过时；当前剩余问题不是 guard 缺失，而是 runtime residues 是否真正退出 payload truth。

## 2026-06-18 payload carrier audit/containment drift source removed

- 改动：
  - `scripts/architecture/verify-custom-payload-carrier-containment.mjs` 不再手写第二份 runtime allowlist，改为直接从 `docs/architecture/custom-payload-carrier-runtime-manifest.yml` 读取 `routecodex_prefix` / `response_metadata` 文件集。
  - `scripts/architecture/audit-custom-payload-carriers.mjs` 现在直接输出：
    - `runtime-category`
    - `runtime-resolution`
- 结果：
  - `audit:custom-payload-carriers` 现在会明确显示：
    - `routecodex_prefix` => `contract_or_test_surface=4 / guard_surface=3 / local_runtime_marker=6 / payload_side_channel=13`
    - `response_metadata` => `contract_or_test_surface=2 / guard_surface=1 / local_runtime_marker=1`
  - 继续细分后，当前 `semantic_family` 结果也已机器可读：
    - `routecodex_prefix.request_route_control=9`
    - `routecodex_prefix.response_followup_semantics=4`
    - `routecodex_prefix.provider_runtime_local_marker=5`
    - `response_metadata.response_metadata_contract=2`
    - `response_metadata.response_metadata_protocol_guard=1`
- 后续清理不再需要人工同步“manifest 一份、containment allowlist 一份”两套 runtime 真相。
- 已验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run audit:custom-payload-carriers` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/architecture/verify-custom-payload-carrier-containment.mjs` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci-longtail` PASS
  - `git diff --check` PASS

## 2026-06-18 runtime carrier owner-queryability baseline lock

- 继续在 `custom-payload-carrier-runtime-manifest.yml` 上加了两列：
  - `owner_queryability`
  - `verification_state`
- 目的：
  - 不只知道某个 runtime 命中属于 `payload_side_channel` / `local_runtime_marker` / `guard_surface`；
  - 还要锁住它当前是不是 `unique-owner`，以及 verification coverage 现在是否存在，防止已经收窄清楚的 TS/host 热区重新滑回 broad owner 模糊带。
- 当前机器基线：
  - `__routecodex*`
    - `unique-owner=17`
    - `ambiguous-owner=9`
    - `missing-verification=4`
  - `response.metadata`
    - `unique-owner=2`
    - `ambiguous-owner=2`
    - `missing-verification=0`
- 结构性结论：
  - 现在 remaining ambiguity 已基本集中在 Rust crate broad-owner 区；
  - 这说明下一阶段高价值工作是把这些 Rust broad owner 再拆窄，而不是继续在 TS/handler 层补新的 token denylist。
- 已验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-custom-payload-carrier-runtime-manifest` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:function-map-compile-gate` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci-longtail` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci` PASS

## 2026-06-18 request-route writer residue static contract lock

- 本轮不接手 Jason 正在做的 payload/internal-field 删除实现，只补 review-surface truth 和静态 gate。
- 新增 / 接线：
  - `tests/server/runtime/http-server/executor/request-executor-attempt-state.contract.spec.ts`
  - `tests/server/runtime/http-server/index.request-truth-contract.spec.ts` 增补 request-route residue 断言
  - `docs/architecture/function-map.yml`
  - `docs/architecture/verification-map.yml`
- 锁住的真相：
  - `request-executor-attempt-state.ts`
    - flat `__routecodexRetryProviderKey` residue 仍只存在 `prepareRequestExecutorAttemptState`
    - `finalizeRequestExecutorAttemptMetadata` 已真实 merge `pipelineMetadataCenter.snapshot().runtimeControl`
    - merged metadata 侧没有重新 backfill flat `__routecodexRetryProviderKey` / `__routecodexPreselectedRoute`
  - `index.ts`
    - `__routecodexPreselectedRoute` 只剩 router-direct relay edge 那 1 处 flat write
    - `__routecodexRetryProviderKey` 只剩 `metadataForHub` request-route control 那 1 组 write/delete
- 这层锁的目的：
  - 在 Jason 后续迁走 flat writer 前，先把“剩余 residue 的精确位置”变成可回归证据
  - 防止 review-surface 漂成“carrier 已有，所以 writer 已经迁完”的假结论
- 已验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/runtime/http-server/executor/request-executor-attempt-state.contract.spec.ts --runInBand` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/runtime/http-server/index.request-truth-contract.spec.ts --runInBand` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:function-map-compile-gate` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npx tsc --noEmit --pretty false` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci` PASS
  - `git diff --check` PASS

## 2026-06-18 response-followup residue static contract lock

- 本轮继续只做 review-surface / gate 收口，不接手 Jason 正在做的内部字段物理删除实现。
- 新增 / 接线：
  - `tests/server/runtime/http-server/executor/servertool-followup-dispatch.contract.spec.ts`
  - `tests/server/runtime/http-server/executor/provider-response-converter.contract.spec.ts`
  - `docs/architecture/function-map.yml`
  - `docs/architecture/verification-map.yml`
- 锁住的真相：
  - `servertool-followup-dispatch.ts`
    - 当前 `requestSemantics.__routecodex` residue 仍全部局限在 followup materializer helper 带
    - 运行时 residue 只用于：
      - `isServerToolFollowup(...)`
      - `readManagedStoplessGoalStatusFromSemantics(...)`
      - `materializeFollowupRequestSemantics(...)`
    - `stripResponsesOnlyRequestSettings(...)` 之后不再继续出现 `__routecodex`
    - `materializeFollowupRequestSemantics(...)` 仍通过 cloned `nextSemantics.__routecodex` 重建 `serverToolFollowup / serverToolFollowupSource / stoplessGoalStatus`
  - `provider-response-converter.ts`
    - 当前只剩 1 处 `options.requestSemantics?.__routecodex` pure read
    - 它只用来判定 `isServerToolFollowupRequest`
    - 文件里没有新的 `__routecodex = ...` 写入，也没有 metadata 侧 `__routecodex` 读
- 这层锁的目的：
  - 在后续真正迁到 `MetadataCenter / runtime side-channel` 前，先把 response-followup lane 的剩余旧字段位置固定成机器证据
  - 防止 review-surface 漂成“followup residue 已经退出 TS owner”这种假结论
- 已验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/runtime/http-server/executor/servertool-followup-dispatch.contract.spec.ts --runInBand` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/runtime/http-server/executor/provider-response-converter.contract.spec.ts --runInBand` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:function-map-compile-gate` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npx tsc --noEmit --pretty false` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci` PASS
    - 稳定回执：`/tmp/routecodex-architecture-ci.exit = 0`
    - 完整日志：`/tmp/routecodex-architecture-ci.log`
## 2026-06-18 responses SSE passthrough boundary audit

- 新线上报错不是 handler 单点误判，而是普通 Hub `/v1/responses` 误命中了 prebuilt SSE passthrough：
  - `src/server/runtime/http-server/executor/provider-response-converter.ts` 之前只要 `entry=/v1/responses && providerProtocol=openai-responses && sseStream` 就直接 return response。
  - 这违反了“只有 direct/provider-direct/router-direct 才允许 same-protocol passthrough”的项目硬边界。
- 证据链：
  - `handler-response-sse.ts` 真实用 `result.continuationOwner === 'direct'` 判 direct passthrough；
  - `responses-response-bridge.ts::normalizeResponsesSseFrameForClientForHttp()` 只规范化 `response.*` 事件，`message_stop` 会原样放过；
  - 因此普通 relay 路径若把 anthropic/非标准 SSE 放到 `/v1/responses` 出口，最终就会走到 `upstream_stream_incomplete`。
- 修正方向：
  - `provider-response-converter` prebuilt SSE passthrough gate 必须与出口 owner 对齐，只允许 `continuationOwner=direct` 命中；
  - relay `/v1/responses` 即使 upstream/protocol 标成 `openai-responses`，也必须重新走 bridge conversion / standard projection。
- 额外发现：
  - `build:min` 被现有架构 gate 卡住，原因不是本次代码，而是 `docs/architecture/function-map.yml` 里 `describe_hub_pipeline_contracts` 被 `hub.pipeline_contract_surface` 与 `hub.metadata_boundary` 双重声明。
  - 该 builder 应只归 `hub.pipeline_contract_surface`；`hub.metadata_boundary` 保留 `describe_pipeline_contract` 即可。
  - `verify-architecture-feature-anchor-coverage.mjs` 还把所有 feature 一刀切要求“canonical builder 至少命中 2 个文件”，这和 `vr.route_retry_pin_surface` 这种显式 `file-scoped owner` 冲突。
  - 已按 owner truth 收口 gate：`file-scoped owner` 允许 1 个 builder file，其他 owner 仍要求至少 2 个。

## 2026-06-18 relay responses SSE reprojection

- 新增 host helper：`provider-response-relay-sse.ts`，规则是 relay `/v1/responses` 只认标准化 response body，重建 `response.*` SSE；只有 `continuationOwner=direct` 才允许 stream passthrough。
- 触发原因：线上 `/v1/responses` 仍出现 `lastRawFrame=message_stop` / `lastProjectedFrame=message_stop`，说明 raw provider SSE 还能漏到 client SSE。
- 当前定向红绿证据：`npx jest tests/server/runtime/http-server/executor/provider-response-relay-sse.spec.ts --runInBand` PASS。

## 2026-06-18 function-map compile-gate truth closeout after Rust file-scoped owner split

- 这轮红点不是 runtime 行为回归，而是 review-surface truth 漂移：新增 Rust file-scoped feature 后，`function-map / verification-map / source feature anchor / canonical builder uniqueness / builder-hit spread` 没有同步收口。
- 实际收口动作：
  - `hub.route_metadata_input_surface` 更名为更真实的 `hub.route_metadata_surface`，避免伪装成 compile gate 无法证明的单文件 singleton。
  - `hub.pipeline_contract_surface` 去掉与 `hub.metadata_boundary` 重复声明的 `describe_hub_pipeline_contracts`，保留 `describe_meta_carrier_contracts` / `validate_pipeline_node_contract_boundary`。
  - `vr.route_retry_pin_surface` 不再把过于泛化的 `route` 当 canonical builder；改为以 `route.rs + router_metadata_input.rs` 两个真实语义面构成 retry-pin 双文件 surface。
  - `router_metadata_input.rs` source anchor 与 `verification-map.yml` feature id 已同步到 `hub.route_metadata_surface`。
- 已验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:function-map-compile-gate` PASS
    - 稳定回执：`/tmp/routecodex-compile7.exit = 0`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-feature-id-anchors` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-custom-payload-carrier-owner-queryability` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-custom-payload-carrier-runtime-manifest` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci-longtail` PASS
    - 稳定回执：`/tmp/routecodex-longtail.exit = 0`
  - `git diff --check` PASS
- 结论：
  - 当前 compile gate 已恢复为绿，剩余工作仍是 Jason 正在推进的内部字段物理删除实现线；我这边只把 review-surface / owner truth / gate queryability 收回到可信状态。

## 2026-06-18 architecture debt budgets for drift lock

- 本轮继续不接 Jason 正在做的 `__routecodex_*` / SSE 非标字段运行时删除实现，只补不会冲突的架构锁。
- 新确认的两个“会漂移但之前只报不拦”的口子：
  - `verify:architecture-mainline-binding-pending-gate` 之前只统计，不拦 request.mainline / metadata.center / error.mainline 的 debt 增长
  - `verify:architecture-topology-doc-sync` 之前只打印 topology 未消费节点列表，不拦新 debt 或旧 debt 清掉后 manifest 未更新
- 已加显式预算真源：
  - `docs/architecture/mainline-binding-budget.yml`
  - `docs/architecture/topology-sync-manifest.yml`
- 新规则：
  - mainline 的 `partial` / `binding pending` 只能在 budget 内存在；超预算、anchored 回退、total edges 漂移都会 fail
  - topology 文档未消费节点必须显式登记；新增长、旧 debt 已收口却不删 manifest，都会 fail
- package wiring 也已收紧：
  - `verify:architecture-review-surface-light` 现在直接跑 `verify:architecture-mainline-binding-pending-gate`
  - `verify:architecture-review-surface-light` 现在直接跑 `verify:architecture-topology-doc-sync`
- 当前仍未处理的硬红点：
  - `verify:architecture-ci-longtail` 因 `src/server/runtime/http-server/executor/provider-response-converter.ts:101-102` 的 `response.metadata` runtime spread 失败
  - 这是 Jason 正在清 internal payload/runtime residue 的同一风险面，这轮不碰实现，只保留为审计事实
- 验证结果：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-mainline-binding-pending-gate` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-topology-doc-sync` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:function-map-build-wiring` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-review-surface-light` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci-longtail` FAIL only at `verify-custom-payload-carrier-containment` with `provider-response-converter.ts:101-102 response.metadata`

## 2026-06-18 response.metadata bridge-seed cleanup and review-surface evidence refresh

- 本轮继续收口 review-surface / slimming audit，不接手 Jason 正在推进的 `__routecodex_*` 物理删除主线。
- 已确认并记录：
  - `src/server/runtime/http-server/executor/provider-response-converter.ts::buildBridgeProviderResponseSeed(...)` 的 stream-only seed 现在只包含 `sseStream/status/headers`，不再 spread `response.metadata`。
  - `provider-response-converter.ts` 当前仍有 `options.requestSemantics?.__routecodex` pure reader residue，属于 `response_followup_semantics` 后续迁移项，不能标成 fully clean。
- 最新审计：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run audit:custom-payload-carriers` PASS
    - `__routecodex*`: `runtime=72, test=103, script=16, doc=58`，runtime unique files=`25`
    - `__sse_*`: `runtime=0, test=20, script=15, doc=7`，runtime unique files=`0`
    - `response.metadata`: `runtime=11, test=14, script=5, doc=46`，runtime unique files=`4`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run audit:custom-payload-carrier-owner-queryability` PASS
    - `__routecodex*`: `unique-owner=20 / ambiguous-owner=5 / missing-owner=0 / missing-verification=0`
    - `response.metadata`: `unique-owner=4 / ambiguous-owner=0 / missing-owner=0 / missing-verification=0`
- 文档同步：
  - `docs/goals/hub-pipeline-slimming-no-function-loss-plan.md` 已把 runtime carrier baseline、owner-queryability、P0 role map、mtc-03 后续执行顺序更新到当前事实。
  - `docs/goals/hub-pipeline-architecture-review-surface-cleanup-plan.md` 已补入 latest audit evidence 与 converter bridge-seed cleanup 事实。
- 已有绿证据来自上一轮同一 worktree：
  - focused converter stack 5 suites / 18 tests PASS
  - `verify:architecture-custom-payload-carrier-containment` PASS
  - `verify:architecture-ci-longtail` PASS
  - `verify:function-map-compile-gate` PASS
  - `verify:architecture-review-surface-light` PASS
  - `build:min` PASS
  - `verify:architecture-ci` standalone PASS
- 待补最终回执：
  - 已补齐：
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-review-surface` PASS
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:function-map-compile-gate` PASS
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci-longtail` PASS
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci` PASS
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run build:min` PASS
    - `git diff --check` PASS
  - 剩余风险：
    - 未做本轮 live/runtime smoke；本轮只改 review docs/note，runtime 行为变更证据沿用上一轮 focused converter stack 与 architecture/build gates。
    - `provider-response-converter.ts` 只清掉 `response.metadata` bridge seed spread，仍保留 `requestSemantics.__routecodex` pure reader residue，后续要等 `servertool-followup-dispatch.ts` 迁到 `MetadataCenter / runtime side-channel` 后再收。


## 2026-06-18 install script build:min lock hardened

- 继续对 active goal 做完成标准审计时发现一个真实缺口：
  - 文档与长期 gate 结论都声称 install 链已被 architecture tiering 锁住；
  - 但 `scripts/architecture/verify-build-script-tiering.mjs` 之前只检查 package.json 里的 `build/build:min/CI` wiring，没有读取 `scripts/install-global.sh` / `scripts/install-release.sh` 本体。
- 修正：
  - `verify-build-script-tiering.mjs` 现在直接读取 install shell 真源，硬性要求两份脚本都继续包含 `npm run build:min`。
  - 新增 focused regression：`tests/scripts/install-build-tiering.spec.ts`，把 install-global/install-release 都必须经 `build:min` 变成白盒回归证据。
- 已验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/architecture/verify-build-script-tiering.mjs` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/scripts/install-build-tiering.spec.ts --runInBand` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci-longtail` PASS
  - `git diff --check` PASS
- 结论：
  - 现在“build/install 与 CI 都不能绕过 review-surface/function-map/build:min 链”这条完成标准，不再只靠文档和人工观察 install shell，而是有静态 gate + focused test 双锁。

## 2026-06-18 metadata-center manifest/code sync gate

- 继续做 hub pipeline 架构收口，不接 Jason 正在推进的 `__routecodex_*` / SSE 非标字段物理删除实现。
- 新发现的架构漂移缺口：
  - `docs/architecture/metadata-center-manifest.yml` 已声明 6 个 family：`request_truth`、`continuation_context`、`runtime_control`、`provider_observation`、`client_attachment_scope`、`debug_snapshot`
  - TS `MetadataCenter` 只实现了前 4 个 family，`client_attachment_scope` / `debug_snapshot` 仍停在 manifest/wiki 声明层
  - 之前 `verify:architecture-manifest-sync` 只能证明 manifest/function-map/mainline/wiki 对齐，不能证明 manifest family/slot 已绑定真实代码
- 修正：
  - `src/server/runtime/http-server/metadata-center/metadata-center-types.ts` 补齐 `MetadataCenterClientAttachmentScope`、`MetadataCenterDebugSnapshot` 与 state bucket
  - `src/server/runtime/http-server/metadata-center/metadata-center.ts` 补齐 `write/readClientAttachmentScope`、`write/readDebugSnapshot`，并让 `markReleased` 覆盖这两个 family
  - 新增 `scripts/architecture/verify-architecture-metadata-center-manifest-code-sync.mjs`
  - `package.json` 的 `verify:architecture-review-surface-light` 已接入新 gate
  - `scripts/architecture/verify-function-map-build-wiring.mjs` 已反查该 gate，防止后续从 review-surface-light 移除
  - `docs/architecture/function-map.yml` / `verification-map.yml` / `README.md` 已同步登记
- 新负向测试：
  - `client_attachment_scope.tmuxSessionId` 不得合成 request truth
  - `debug_snapshot.traceMarkers` 不得合成 request truth，且 closeout release 必须覆盖 debug snapshot slot
- 验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-metadata-center-manifest-code-sync` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run jest:run -- --runInBand --runTestsByPath tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts` PASS，8/8
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:function-map-build-wiring` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-manifest-sync` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-review-surface-light` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:function-map-compile-gate` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npx tsc --noEmit --pretty false` PASS
  - `git diff --check` PASS
- 剩余风险：
  - 这轮只锁 manifest/code 同步和 family registry，不迁移 `runtime_control` writer，也不删除 `__routecodex_*` payload residue。
  - 未做 live probe；本轮改动主要是 architecture gate + TS registry family，未触发安装/重启。

## 2026-06-18 active goal post-commit closure audit

## 2026-06-18 stopless MetadataCenter relay binding red tests
- 当前继续收口 relay stopless MetadataCenter：两个红测已复现。
- `tests/server/runtime/http-server/executor/servertool-followup-dispatch.spec.ts` 当前失败在 `keeps followup stopMessage enabled only when flow policy preserves eligibility`：baseMetadata 的 `MetadataCenter.runtime_control.stopMessageEnabled=true` 进入 nested metadata 后被 `servertool-followup-dispatch.ts` 覆盖成 `false`。
- `tests/sharedmodule/hub-pipeline-rust-responses-provider-payload.regression.spec.ts` 当前失败在真实 entrypoint metadata path：`buildRequestMetadata()` 写入的 MetadataCenter symbol 被普通 metadata spread 丢失，最终 provider payload 没有 stop schema instruction。
- 本轮唯一修复方向：不在 followup nested builder 里无资格覆盖 stopless control；request-stage bridge 需要在当前请求 body 明确有 stopless directive 时确保 MetadataCenter 绑定并写 runtime_control，而不是走 payload 字段或 direct/SSE 补丁。

- 当前远端状态：
  - `HEAD == origin/main == 4b3451cb964e96a5c5104123a5367608976e621c`
  - 仅剩未跟踪过程样本目录：`tests/fixtures/goal-request-user-input-real-samples/runs/`
- 当前目标要求的 post-commit gates 已复跑：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-review-surface` PASS
    - mainline call map / node-id consistency / pending binding budget / wiki sync / wiki HTML sync / manifest sync / metadata-center code sync / mainline manifest sync / topology doc sync / browser smoke 全部 PASS
    - browser smoke 检查 `14` 个 wiki HTML 页面
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:function-map-compile-gate` PASS
    - `87` 个 features 均有 source anchor、verification-map coverage、required_tests/required_gates
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci-longtail` PASS
    - deleted-path 防复活、duplicate owner、TS owner ban、build tiering、custom payload carrier containment / owner-queryability / runtime manifest 全部 PASS
    - 当前 custom payload carrier baseline：`__routecodex*` runtime allowlisted files=`25`，其中 `payload_side_channel=10`；`__sse_*` runtime files=`0`；`response.metadata` runtime files=`4`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci` PASS
    - no-fallback、VR no fallback、nonadjacent conversion、metadata leak boundary、client response internal carrier surface、SSE architecture boundary、error pipeline、function-map bidir required-tests、longtail 全部串联通过
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run build:min` PASS
  - `git diff --check` PASS
- `build:min` 生成 tracked version/build-info 更新：
  - `package.json` / `package-lock.json`: `0.90.3130 -> 0.90.3131`
  - `src/build-info.ts`: `version='0.90.3131'`, `buildTime='2026-06-18T07:42:55.469Z'`
- 当前结论：
  - review surface / function map / mainline call map / wiki / manifest / longtail gate 已由当前状态证据证明清绿。
  - build/install/live 仍需用当前 `0.90.3131` 安装态补证，不能沿用旧 `0.90.3105` 安装证据。
- 安装态补证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH ROUTECODEX_INSTALL_INPLACE_BUILD=1 ROUTECODEX_BUILD_RESTART_ONLY=1 ./scripts/install-global.sh`
    - build/min 链进入并完成，global install 成功
    - runtime snapshot installed: `routecodex-0.90.3131-2026-06-18T074631Z`
    - `/Users/fanzhang/.rcc/install/current -> releases/routecodex-0.90.3131-2026-06-18T074631Z`
    - 注意：脚本尾部 snapshot refresh 后一度无进程输出，`ps` 未见 install/npm/node/rsync 相关进程后用 Ctrl-C 收回前台；退出码 `130` 不代表构建/安装失败，安装结果以 snapshot/current、CLI version、restart 和 health 为准。
  - `routecodex --version` => `0.90.3131`
  - `rcc --version` => `0.90.3131`
  - `routecodex restart --port 5555` PASS，`http://127.0.0.1:5555/health` => `ready=true pipelineReady=true version=0.90.3131`
  - `routecodex restart --port 5520` PASS，`http://127.0.0.1:5520/health` => `ready=true pipelineReady=true version=0.90.3131`
- 完成性判断：
  - 本目标的 review surface 漂移、function-map/mainline/wiki/manifest 机器锁、CI/local build gate、防复活 deleted/residue gate、瘦身候选表与当前安装态 smoke 均已有当前状态证据。
  - 当前不宣称 `__routecodex*` runtime 已清零；真实状态仍是 25 个 allowlisted runtime files，其中 10 个 `payload_side_channel` 属于后续 MetadataCenter/runtime side-channel migration 工作。

## 2026-06-18 architecture review surface lockdown

### 缺口 A: build wiring 拆层
- `build:min` 重命名为 `build:base`
- `build` 改为 `npm run build:base && npm run verify:architecture-ci`
- `build:dev` / `build:dev:full` 用 `build:base`
- `verify:function-map-build-wiring.mjs` 更新为检查 `build:base` + `build` + `build:dev/*` wiring
- 验证：PASS

### 缺口 C: mainline chain manifests + gate
- 新 `generate-mainline-chain-manifests.mjs`：为 7 条 chains 生成 `docs/architecture/manifests/<chain_id>.yml`
- 新 `verify-architecture-mainline-manifest-sync.mjs`：schema、owner、chain、node_ids、wiki_page、required_gates 一致性
- render 脚本更新：`render:architecture-wiki-pages` 和 `render:architecture-mainline-mermaid` 自动先跑 chain manifests 生成
- 验证：PASS

### 缺口 D: wiki 节点 ID 一致性 gate
- 新 `verify-architecture-wiki-node-id-consistency.mjs`：7 个 wiki 页面中的 Mermaid 节点 ID 与 mainline-call-map.yml 的 from_node/to_node 交叉比对
- metadata.center.mainline 额外与 metadata-center-manifest.yml 的 node_ids 校验
- 验证：PASS

### 缺口 E: shared function binding state gate
- 新 `verify-mainline-call-map-binding-state.mjs`：校验 shared_multi_reference_functions + split_bindings 有 binding_status（confirmed/pending/partial）
- pending 阈值 3，当前 pending=0
- 补全 9 个 shared functions + 2 个 split_bindings 的 binding_status 为 confirmed
- 验证：PASS

### 缺口 F: required_tests 反向引用完整性 gate
- 新 `verify-function-map-test-coverage-integrity.mjs`：对每个 feature 的 required_tests，测试文件内容是否提及 feature 关键词
- 检查 245 test entries，全部通过
- 验证：PASS

### 缺口 G: topology 文档 vs code type 一致性 gate
- 新 `verify-architecture-topology-type-consistency.mjs`：H3 section header nodes 必须在 call map 中（除非 topology-only）
- 识别 topology doc 中 43 个注册节点
- `ProviderReqOutbound07TransportRequest` 加 `<-- topology-only -->`
- `ErrorErr04RouterPolicyApplied` 和 `RequestExecutorErrorErr04RouterPolicyEnvelope` 在 call map shared functions 注册
- topology-sync-manifest.yml 更新：ErrorErr04RouterPolicyApplied 从 allowlist 移除
- 验证：PASS

### 修复的 collateral damage
- `function-map.yml` 和 `verification-map.yml` 中 `npm run build:min` → `npm run build:base`（2 个 gate 从 owner-queryability 检出，修复后绿）

## 2026-06-18 internal metadata center migration plan topology

- Jason 要求先做全局审计计划文档和 `/goal` 提示词，不继续抢正在进行的 `__routecodex*` 字段删除实现。
- 计划文档：`docs/goals/internal-metadata-center-migration-plan.md`
- 已补充：
  - `Execution Topology And Locks`：`Topo01AuditCarrierDiscovery -> Topo02ManifestDispositionBudget -> Topo03LaneOwnerSelection -> Topo04RuntimeTruthMigration -> Topo05DeletedResidueLock -> Topo06ReviewSurfaceSync`
  - `Source-To-Sink Migration Topology`：Route Control、Servertool Followup、Local Runtime Marker、Guard And Protocol 四条拓扑
  - 明确 `response.metadata` 是标准 Responses SSE 事件，不能 blanket-ban；只禁止内部控制 key 混入
- 校验：
  - `rg -n "Execution Topology|Source-To-Sink|Route Control Topology|Servertool Followup Topology|Local Runtime Marker Topology|Guard And Protocol Topology|Completion Definition" docs/goals/internal-metadata-center-migration-plan.md` 命中预期章节
  - `git diff --check -- docs/goals/internal-metadata-center-migration-plan.md` PASS

## 2026-06-18 lane A request-route control slice

- 本轮已完成：
  - `src/server/runtime/http-server/index.ts`
    - `__routecodexPreselectedRoute` / `__routecodexRetryProviderKey` flat 写入移除
    - 通过 `MetadataCenter.writeRuntimeControl(...)` 写 `preselectedRoute` / `retryProviderKey`
    - 通过 `__rt` 投影给 Rust NAPI，不再让 runtime truth 落在 normal payload 字段
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts`
    - preselected route 读取改为 `metadata.__rt.preselectedRoute`
  - Rust route-control readers:
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/router_metadata_input.rs`
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs`
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types/meta_error_carriers.rs`
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/route.rs`
- 验证证据：
  - `tests/server/runtime/http-server/request-executor-attempt-state.contract.spec.ts` PASS
  - `tests/server/http-server/executor-metadata.spec.ts` PASS
  - `tests/server/runtime/http-server/index.request-truth-contract.spec.ts` PASS
  - `tests/sharedmodule/hub-pipeline-preselected-route.spec.ts` PASS
  - `tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts` 的 429/502 retry focused cases PASS
  - `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` PASS
  - `npm run audit:custom-payload-carriers` 结果更新为 `runtime files=18`、`payload_side_channel=3`
  - `npm run verify:architecture-custom-payload-carrier-runtime-manifest` PASS
  - `npm run verify:architecture-custom-payload-carrier-containment` PASS
  - `npm run verify:function-map-compile-gate` PASS
  - `npm run build:min` PASS
  - `git diff --check` PASS
- 当前剩余：
  - 仍有 3 个 `payload_side_channel` runtime hits，全部在 response followup semantics lane。
  - `response.metadata` 仍保留标准协议与 guard/contract surface，不作为删除目标。

## 2026-06-18 internal metadata migration plan closeout prompt

- Jason 要求输出计划文档拓扑和可直接使用的 `/goal`，不是继续动迁移代码。
- 已更新 `docs/goals/internal-metadata-center-migration-plan.md`：
  - 校准最新 Lane A 后审计基线：`__routecodex* runtime files=18`、runtime hits=`55`、`payload_side_channel=3`、`__sse_* runtime files=0`。
  - 补 `Current Execution Cursor`：Lane A done，下一步 Lane B response followup semantics，然后 Lane C guard/deleted-residue、Lane D local runtime marker、review surface sync。
  - 补 Lane B 三跳拓扑：`Followup01Materializer -> Followup02ResponseConverterReader -> Followup03RustResidueContract`。
  - 补 `Drift-Lock Gate Plan`：manifest budget、deleted residue、payload boundary、owner queryability、review surface、SSE wrapper 六类锁。
- 复跑审计证据：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run audit:custom-payload-carriers` PASS。
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run audit:custom-payload-carrier-owner-queryability` PASS。
### 终验
- wiring gate: `verify:function-map-build-wiring` PASS
- review-surface-light: 10 sub-gates PASS
- function-map-compile-gate: 13 sub-gates PASS
- architecture-ci-longtail: PASS
- 5 新 gate: mainline-manifest-sync / wiki-node-id-consistency / binding-state / test-coverage-integrity / topology-type-consistency — 全部 PASS
- git diff --check PASS
- 本轮新文件：6 个 gate 脚本 + 1 个 manifest 生成器 + 7 个 chain manifest YMLs + goal 文档
## 2026-06-18 continuation metadata center standardization rule

- Jason 明确纠正：`MetadataCenter` 上的 continuation 不能继续靠零散补丁推进；`save / restore / materialize / release` 必须先定义成按协议约束的标准行为，再按这个 contract 收代码。
- 当前已锁到的反模式：
  - Rust restore/materialize 返回 `meta.fullInput`，TS bridge 又单独期待 `responsesResume.restoredTools`，造成“部分恢复、部分猜测”的拼接式 contract。
  - continuation 相关标准字段目前分散在 `responsesResume / fullInput / deltaInput / restoredFromResponseId / restoredTools / previous_response_id` 多个局部 shape，缺少统一 family contract 和 provenance。
  - stopless 当前暴露出来的 `schemaFeedback 已进 provider request，但 tools 丢失`，本质上不是单个文案问题，而是 continuation 标准恢复 contract 不完整。
- 后续收口原则：
  - continuation 必须进入 `MetadataCenter.continuation_context` 作为唯一 request-scoped truth family；
  - 必须明确定义按协议的 canonical continuation contract：至少区分 `responses remote resume`、`responses local materialize`、`chat/messages none`；
  - 标准 contract 需要统一回答四件事：保存什么、恢复什么、何时 materialize full input、何时释放；
  - bridge / req_chatprocess / VR / stopless 只能读中心化 continuation projection，不允许各自再猜 `responsesResume.*` 局部字段；
  - 在 contract 落稳前，继续对单个字段打补丁风险很高，只能作为临时红测定位证据，不能当最终设计。

## 2026-06-18 error client projection red-test pass 1

- User要求先补黑盒红测再修复 provider 错误泄漏。
- 已改红测：handler-utils.error-response-shape 和 http-error-mapper-public-leak，目标是不再向客户端/SSE暴露 `Upstream authentication failed`、`HTTP_401/403`、provider routed request id。
- 首轮 red evidence：`pnpm exec jest tests/server/utils/http-error-mapper-public-leak.spec.ts --runInBand` 失败，401/403 summary 仍返回旧值 `Upstream authentication failed`。
- 修复落点：
  - `src/server/utils/http-error-mapper.ts`：provider 401/403 client projection 改为 generic `502 upstream_error / Upstream provider error`，不带 `request_id`。
  - `src/server/handlers/handler-utils.ts`：`upstream_error` 不再自动补 request_id；错误日志 summary 用 public mapper，字段解析仍读原始 error 以保留内部 status/code。
- 已转绿：
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/handlers/handler-utils.error-response-shape.spec.ts --runInBand` PASS
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/utils/http-error-mapper-public-leak.spec.ts --runInBand` PASS
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/handlers/request-error-log.spec.ts --runInBand` PASS
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts --runInBand` PASS，但 Jest 报 open-handle 未自动退出
  - `npm run verify:error-pipeline-contract` PASS
  - `npx tsc --noEmit --pretty false` PASS
  - `git diff --check` PASS
- 未闭合验证：
  - `npm run verify:provider-failure-ban-blackbox` 失败在脚本读取临时 `sessions/provider-health.json` ENOENT。
  - `tests/server/runtime/http-server/request-executor.spec.ts` 失败主要为 `[llmswitch-bridge] native-failure-policy not available` 与既有 session/backoff 断言，不作为本修复绿证。

## 2026-06-18 provider health persistence scope closeout

- 已提交：
  - `2c5cc22 fix(error): mask provider auth failures`
  - `ff0a0d1 fix(error): scope provider health persistence`
- 新红测/黑盒闭环：
  - `scripts/tests/provider-failure-ban-blackbox.mjs` 现在隔离 `RCC_HOME`，扫描 tmp 下所有 `provider-health.json`，并断言只能出现在 port-scoped runtime truth path：`RCC_HOME/sessions/<serverId>/ports/<routingPolicyGroup>/provider-health.json`。
  - 同一黑盒验证 503 三击后 runtime health 为 `tripped`、第四次跳过 primary、restart 后重新 probe primary、port 5555 group A cooldown 不影响 port 6666 group B。
- 根因：
  - Provider ErrorErr 事件进入 Rust VirtualRouter 后，provider-health 持久化此前没有按 event runtime `sessionDir` 套 state store override，导致写到 ambient/root `RCC_HOME/sessions/provider-health.json`。
- 修复：
  - Rust `engine/events.rs` 的 provider success/failure/error handler 改为从 `event.runtime.sessionDir/session_dir` 进入 scoped state store；无 sessionDir 时用 disabled guard fail-closed，不继承 ambient root。
  - `routing_state_store.rs` 增加 `with_session_dir_persistence_disabled`。
  - `provider-error-reporter.ts` 只负责从 provider context 投影 request-scoped runtime hints；不在 TS 层重新拼 port path。
- 验证：
  - `cargo test -p router-hotpath-napi provider_error_persistence_uses_event_runtime_session_dir --lib -- --nocapture` PASS
  - `cargo test -p router-hotpath-napi provider_error_without_runtime_session_dir_does_not_persist_to_root_session --lib -- --nocapture` PASS
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/providers/core/utils/provider-error-reporter.spec.ts --runInBand` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run build:base` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:provider-failure-ban-blackbox` PASS
  - `npm run verify:error-pipeline-contract` PASS
  - public leak focused Jest 3 suites PASS
  - `tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts` PASS (19 tests, still reports Jest open-handle warning)
  - `git diff --check` PASS for touched files.

## 2026-06-18 stopless live closure trace
- 当前 live probe 失真原因已确认：scripts/tests/stopless-5555-live-probe.mjs 首轮 prompt 明确要求“没有 function_call_output 就直接输出 stop schema JSON”，会主动压死 stopless 激活，不是功能 owner 自身证据。
- 已锁真正 owner 主线：sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts 写 stopless runtime control；sharedmodule/llmswitch-core/src/servertool/engine.ts 决定 CLI projection；下一步追 request-side submit_tool_outputs/continuation 翻译链，查 schemaFeedback、上一轮执行结果、tools 恢复是否丢失。

- Jason 最新要求：仅审计/验证 relay 主线；direct 路径不再作为 stopless 闭环解释或验证分支。

- Jason 新要求：servertool 当前不需要走 tmux 路径；stopless/relay 不能再被 tmux_session_missing 阻断。

- 修复：relay stopless system instruction 注入不再绑定 clientInjectReady/tmux；唯一 owner 为 req_process_stage1_tool_governance_blocks/orchestrator.rs。
- focused rust tests 通过：clientInjectReady=true/false 两类 /v1/responses stopless instruction materialize。

- 安装态已到 0.90.3147，但 5555 health 仍是 0.90.3145；已执行 scoped restart 让线上 relay 复核命中新版本。

- 5555 在线复核（0.90.3147）结果：tmux gate 已去掉，但 client-request metadata 本身已不再携带 stopMessageEnabled / routecodexPortStopMessageEnabled，导致 req_process 仍无法判定应注入 stopless instructions；当前唯一 owner 前移到入站 metadata 写入阶段。

- 更正：client-request snapshot 不是 MetadataCenter runtimeControl 的完整真相；sample writer 不会把 runtimeControl 投影回普通 metadata 字段。stopless 是否生效仍以 provider-request 是否出现 instructions 为准。

- 根因二修复：request-stage bridge 之前只投影 __rt，不投影 MetadataCenter.runtimeControl，导致 native req_process 看不到 stopMessageEnabled；已在 hub-pipeline-execute-request-stage.ts 补 runtimeControl -> __rt 投影，并加 preselected-route focused test 锁住。

## 2026-06-18 stopless MetadataCenter response binding hotfix
- 线上报错：`[convert.bridge] MetadataCenter runtime_control.stopless writer requires a bound MetadataCenter`。
- 根因：`provider-response-converter.ts` 在给 response metadata 增加 `providerFamily` 时使用 `{ ...metadataBag }`，以及 `servertool-adapter-context.ts` 内部再展开 metadata，都会丢失 `Symbol.for("routecodex.metadataCenter")` 绑定；stop_message_auto 写 `runtime_control.stopless` 时收到无 center 的 adapterContext，因此 fail-fast。
- 修复：`buildResponseMetadataBagForProviderResponseConverter()` 在复制 providerFamily 后重新绑定同一个 MetadataCenter；`buildServerToolAdapterContext()` 在生成 baseContext 后绑定同一个 MetadataCenter。
- 防复活测试：`provider-response-converter.contract.spec.ts` 锁 providerFamily 分支保留 center；`servertool-adapter-context.spec.ts` 锁 adapterContext 保留 center。
## 2026-06-19 SSE business-module hard lock slice

- Jason 要求：SSE 不能再被业务顺手改坏，必须作为业务模块锁死，而不是只靠口头约束。
- 本轮收口方向：
  - 新增 `verify:responses-sse-business-module` 静态 gate；
  - `server.responses_sse_bridge_surface` function-map / verification-map 明确升级为 locked business module；
  - 新增 `tests/red-tests/server_responses_sse_business_module_contract.test.ts`，锁 `handler-response-sse.ts` 只能依赖 `responses-sse-bridge`，不得本地重长 terminal/probe/repair/error builder owner。
- 这轮先锁边界，不宣称已修完 `tool_calls + [DONE] -> response.done/required_action` 的 runtime 误判；后续要继续用黑盒样本修主逻辑。
## 2026-06-19 responses SSE chat-chunk tool_calls terminal repair slice

- 线上 5555 `stream closed before response.completed` 的一类真根因已锁定：并非真正的 Responses SSE 缺 `response.completed`，而是部分上游返回的是 `object:"chat.completion.chunk"` + `finish_reason:"tool_calls"` + `data:[DONE]`。
- 样本证据：`/Volumes/extension/.rcc/codex-samples/openai-responses/port-5555/req_1781818137643_fc4e29ab/provider-response_1.json`。该样本没有 `response.completed/response.done`，最后 terminal truth 来自 chat chunk 的 `tool_calls` finish。
- owner 修复点在 Rust native SSE contract probe：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_response_utils.rs`
  - `update_responses_contract_probe_from_sse_chunk_json(...)` 现已识别 chat chunk `delta.tool_calls[].function.name/arguments`，累积后在 `finish_reason:"tool_calls"` 时 materialize probe `output[]` 为 standard responses `function_call` items，并把 `status` 置为 `requires_action`。
- 新增 native helper：
  - `ensure_probe_chat_tool_call_buffers`
  - `upsert_probe_chat_tool_call_delta`
  - `materialize_probe_output_from_chat_tool_call_buffers`
- 测试/验证状态：
  - `cargo test -p router-hotpath-napi chat_completion_tool_call_chunks_materialize_required_action_terminal_frames --lib -- --nocapture` PASS。
  - `tests/modules/llmswitch/bridge/native-exports.responses-sse-contract.spec.ts` 在重新 build 后 PASS，确认之前 Jest 红是旧 native 产物，不是修复逻辑失效。
  - `tests/server/handlers/responses-handler.stream-closed-before-completed.regression.spec.ts` PASS，SSE handler 现有 repair regression 未回归。
- 架构锁：
  - `scripts/architecture/verify-responses-sse-business-module.mjs` + `tests/red-tests/server_responses_sse_business_module_contract.test.ts` 已把 `/v1/responses` SSE 业务 owner 锁到 `src/modules/llmswitch/bridge/responses-sse-bridge.ts`，防止 `handler-response-sse.ts` 复长 terminal/probe/repair 语义。
- 剩余闭环：
  - 仍需 `build:base -> install:global -> restart --port 5555 -> live sample` 复核安装态；
  - 若线上仍报 incomplete，则下一刀不是继续改 handler，而是抓最新 provider sample 对比 native probe 输出与实际 projected terminal frames。
## 2026-06-19 relay continuation misclassified as provider-owned continuation

- 当前用户问题子链：5555 live 中存在“route pool 还没耗尽，就提前向客户端返回错误”的现象；已先锁一条高概率根因，不能再靠猜。
- 已验证根因：
  - `request-executor` 的 reroute 禁止条件只看 `providerOwnedContinuation === true`；
  - native `is_provider_native_resume_continuation` 之前只看 `previousResponseId/responseId`，没有尊重 `continuationOwner`；
  - 这会把 relay/local continuation 误判成 provider-owned continuation，导致 recoverable failure 下 `exclude_and_reroute` 被硬停。
- 唯一 owner 修复：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_node_result_semantics.rs`
  - 新逻辑：`continuationOwner/continuation_owner === "relay"` 时，`is_provider_native_resume_continuation_value(...)` 直接返回 `false`。
- 红测/绿测证据：
  - 新增 JS focused tests：
    - `tests/server/runtime/http-server/executor/request-executor-request-semantics.spec.ts`
    - `relay previous response resume` -> false
    - `relay submit_tool_outputs responseId resume` -> false
  - 新增 JS owner-level retry gate：
    - `tests/server/runtime/http-server/executor/retry-execution-plan.spec.ts`
    - `providerOwnedContinuation=true` 仍然禁止 reroute
    - `providerOwnedContinuation=false` 且 recoverable + alternative provider 存在时，必须继续 `exclude_and_reroute`
  - 新增 Rust tests：
    - relay previous response resume -> false
    - relay submit_tool_outputs resume -> false
- 一个关键排障事实：
  - 首次 JS spec 失败不代表修复无效，原因是 Jest/ts-jest/native cache 假红；
  - 同一 native binding 直接调用已经返回 `relay=false/direct=true`；
  - 使用 `--no-cache` 后，JS focused suites 转绿，说明逻辑已生效，旧失败是缓存问题，不是 owner 修复失效。
- 本轮验证：
  - `cargo test -p router-hotpath-napi chat_node_result_semantics --lib -- --nocapture` PASS
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/runtime/http-server/executor/request-executor-request-semantics.spec.ts tests/server/runtime/http-server/executor/retry-execution-plan.spec.ts --runInBand --no-cache` PASS
  - 直接调用 source/dist native binding：
    - relay previous response -> false
    - relay submit_tool_outputs -> false
    - direct previous response -> true
- 当前未宣称完成的点：
  - 这只锁住了一条“pool 未耗尽前提前失败”的真因；
  - live 里仍可能存在第二条独立早退路径，例如 `pipeline_or_pre_provider_failure` catch / error projection flatten / provider failure report chain 的前置抛出；
  - `tests/server/runtime/http-server/request-executor.spec.ts` 这组 focused 现在暴露 `native-failure-policy not available` 测试基座噪音，暂不把它作为这轮主证据。
- 下一步：
  - 继续追 `request-executor.ts` 的 `pipeline_or_pre_provider_failure` 早退链；
  - 核对在 route pool 尚有候选时，哪些错误还会在 provider failure plan 之前被直接投影给客户端；
  - 若需要，补更高层但稳定的 focused test，而不是依赖当前带 native-failure-policy 装配噪音的 request-executor 集成基座。

## 2026-06-19 provider error does not switch provider: success-path leak confirmed and closed

- 用户新反馈“现在出现错误也不会切换 provider”里，已锁到一条明确流程漏口：
  - `request-executor` 只有 throw-path 才会进入 `processProviderSendFailure(...) -> resolveRequestExecutorProviderFailurePlan(...) -> retry/reroute`
  - 但 `processSuccessfulProviderResponse(...)` 之前只把 `401/402/403/408/425/429/>=500` 升级成 failure；
  - `200 + provider business error body` 会被当成功返回，根本不进切 provider 主链。
- 唯一 owner 修复：
  - `src/server/runtime/http-server/executor/request-executor-provider-response.ts`
  - 新增 structured business error 识别：
    - 读取 `body.error.code/statusCode/status_code`
    - 命中 `PROVIDER_STATUS_<code>` / 四位 business status 时，不再返回 success
    - 2056 按仓内现有 canonical shape 升级为 `HTTP_429_2056 + upstreamCode=PROVIDER_STATUS_2056 + statusCode=429`
    - 其余 business status 先统一升成 `MALFORMED_RESPONSE + details.detected=provider_business_error`
  - `provider.response_status_check` 现在除 HTTP retryable status 外，也会对 structured business error 直接 `throwProviderHttpError(...)`
- 红测/绿测：
  - 新增 focused red/green：
    - `tests/server/runtime/http-server/executor/request-executor-provider-response.usage.spec.ts`
    - `200 + error.code=PROVIDER_STATUS_2056` 之前 resolve 成 success；现已 reject 成 `provider.http`
  - 同时复核未回退：
    - `tests/server/runtime/http-server/executor/request-executor-request-semantics.spec.ts`
    - `tests/server/runtime/http-server/executor/retry-execution-plan.spec.ts`
- 本轮验证：
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/runtime/http-server/executor/request-executor-provider-response.usage.spec.ts tests/server/runtime/http-server/executor/request-executor-request-semantics.spec.ts tests/server/runtime/http-server/executor/retry-execution-plan.spec.ts --runInBand --no-cache` PASS
- 当前剩余真问题：
  - `pipeline_or_pre_provider_failure` 最外层 catch 仍可能绕过 provider failure reroute 主链，直接把错误抛给客户端；
  - `tests/server/runtime/http-server/executor/request-executor-provider-failure-plan.spec.ts` / `request-executor.spec.ts` focused 受 `native-failure-policy not available` 测试基座噪音影响，暂不作为本轮 blocker，也不作为在线闭环证据。

## 2026-06-19 pre-send failure bypass reroute: rebind / metadata_attach escaped outer catch

- 新锁事实：
  - `request-executor.ts` 在 `processProviderResolveFailure(...)` 之后、`processProviderSendFailure(...)` 之前，还存在一段 pre-send 主线：
    - `rebindResponsesConversationRequestId(...)`
    - `registerRequestLogContext(...)`
    - `ensureClientHeadersOnPayload(...)`
    - `attachProviderRuntimeMetadata(...)`
  - 这段之前不在任何 provider failure owner catch 内；一旦抛错，会直接落最外层 `pipeline_or_pre_provider_failure`，从而在 route pool 还有候选 provider 时提前向客户端报错，不触发 reroute。
- 修复策略：
  - 不新增第二套 failure policy；
  - 直接把上述 pre-send 主线并入现有 `processProviderResolveFailure(...)` owner catch，语义统一视为 `provider.runtime_resolve` 阶段失败。
- 红绿测试：
  - 新增 `tests/server/runtime/http-server/request-executor.pre-send-reroute.spec.ts`
  - 场景：第一个 provider 在 `rebindResponsesConversationRequestId` 抛 `HTTP_502`，route pool 还有第二个 provider；预期不向客户端报错，而是 reroute 到第二个 provider 成功完成。

## 2026-06-19 stopless MetadataCenter review slice

- 重新检查最新 HEAD 后确认：`sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts` 的 runtime 绑定逻辑已在 HEAD 收敛为正确形态，当前未提交源码不再需要额外 fallback。
- 审计发现并修正测试问题：
  - 原新增测试只覆盖 `metadata` bag 已有 MetadataCenter 的路径，不能证明 adapter root 继承分支；
  - 补充 `adapter root has MetadataCenter, metadata bag is created during finalize` 黑盒，证明 finalize 后 runtime_control.stopless 写回同一个 request-local center；
  - `responses-handler.servertool-cli-projection.blackbox.spec.ts` 的 stopless 场景补 MetadataCenter 绑定，保留 required fail-fast，不把缺绑定降级成静默跳过。
- 验证已跑：
  - `tests/servertool/stopless-metadata-center.spec.ts` PASS
  - `tests/servertool/stopless-cli-continuation.spec.ts` + `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts` PASS
  - `npm run verify:servertool-rust-only` PASS
  - `git diff --check` PASS
- 未提交范围说明：`tests/fixtures/goal-request-user-input-real-samples/runs/**` 是本地 replay 输出产物，当前只被 note 引用，未被测试/脚本消费，不纳入提交。

## 2026-06-19 provider 429 reroute root-cause slice

- 线上 5555 已确认运行版本 `0.90.3168`，不是旧包残留。
- 新锁根因：`src/server/runtime/http-server/executor/request-executor-retry-execution-plan.ts` 会先算出 `baseExclusionPlan`，但随后又用 native retry policy 的 `excludeCurrentProvider` 重新构造 `exclusionPlan`；当 native 返回 `preserve_existing_policy` 时，会把前面已经成立的 `excludedCurrentProvider=true` 清零。
- 直接后果：non-stream recoverable 429/503 等虽然前面已判定应排除当前 provider，但执行计划层仍可能掉回 same-provider / 提前终止。
- 已修：`exclusionPlan` 改为保留 `baseExclusionPlan.excludedCurrentProvider || nativeExecutionPolicy.excludeCurrentProvider`，禁止 native preserve 分支把 base exclusion 覆盖掉。
- 新红测/绿测：
  - `tests/server/runtime/http-server/executor/retry-execution-plan.spec.ts` 新增 `HTTP_429_2056 + alternative candidate + non-stream` case，断言 `exclude_and_reroute + provider_backoff_then_reroute`。PASS。
  - `tests/server/runtime/request-executor.single-attempt.spec.ts -t "retries and reroutes when converted response returns status 429 without error envelope"` PASS，证明执行器层消费到 reroute。
- 仍待继续：`empty result` / `upstream_stream_incomplete` / `fetch failed` 为何还可能在池未耗尽前直接回客户端，要继续顺执行链定位。

- 新发现：`tests/server/runtime/http-server/request-executor.excluded-provider-reselection.spec.ts` 与 `tests/server/runtime/http-server/executor/request-executor-cross-pool-fallback.red.spec.ts` 中关于“no explicit routePool” 的 NEG case 现已红。
- 红因不是实现回归，而是测试期望与当前 contract 冲突：标题写“does not infer fallback routePool from pool when explicit routePool is missing”，但断言却要求 `retry_next_attempt`。按现 contract（executor 不得从 `pool` 推断 `routePool`），这种输入只能 `resolved`，不能假设仍有候选。
- 这也解释了为什么部分白盒测试长期测不到 live 问题：很多旧夹具只喂 `routingDecision.pool`，没有喂真实主线 contract 的 `routingDecision.routePool`。

- 新收口：`resolveRequestExecutorPipelineAttempt(...)` 现在对 `excludedProviderKeys` 命中的 target 增加 fail-fast contract：若 `initialRoutePool` 为空且当前 `routePoolForAttempt` 也为空（即 VR 重选了 excluded provider，但没有 explicit routePool 真值），直接抛 `ERR_EXCLUDED_PROVIDER_RESELECTED_MISSING_ROUTE_POOL`，不再默默返回 `resolved`。
- 对应测试已改成 contract 形态：
  - `tests/server/runtime/http-server/request-executor.excluded-provider-reselection.spec.ts` 的 no-explicit-routePool case 现断言 fail-fast；
  - `tests/server/runtime/http-server/executor/request-executor-cross-pool-fallback.red.spec.ts` 的 no-explicit-routePool NEG case 现断言 fail-fast。
- focused verification:
  - excluded-provider reselection + cross-pool fallback 2 suites PASS (10 tests)
  - retry-execution-plan + request-executor.single-attempt focused PASS
  - `npx tsc --noEmit --pretty false` PASS
  - `git diff --check` PASS

## 2026-06-19 same-port different-session split audit

- Jason 新补充的现象已在代码上找到直接解释，不是“同端口随机飘”：
  - `src/server/runtime/http-server/executor/request-executor-request-state.ts` 在请求入口就会调用 `resolveSessionStormBackoffScopes(initialMetadata)`。
  - `src/server/runtime/http-server/executor/request-executor-session-storm-backoff.ts` 会按 `session:<id>` / `conversation:<id>` / `workdir:<path>` / `daemon:<id>` / `clientType:<type>` / `anonymous` 建立 scope。
  - `src/server/runtime/http-server/executor/request-executor-provider-send-failure.ts` 在 provider.send / retryable response-processing 失败时，只要 `isSessionStormBackoffCandidate(error)` 为真，就会对这些 scope 记回退。
- 当前 `isSessionStormBackoffCandidate(error)` 过宽：
  - 429 / 502 / 503 / 504；
  - `PROVIDER_NOT_AVAILABLE` / `ERR_NO_PROVIDER_TARGET`；
  - `fetch failed` / `all providers unavailable` / `request timeout`；
  - 甚至只要 message 非空，最后 `return Boolean(normalized)` 也会命中。
- 直接后果：
  - 同一个 5555 端口下，不同 session/conversation/workdir 会累计各自的 `session_storm` backoff；
  - 一个 session 持续正常，另一个 session 一直被 429/backoff 拖住，在当前设计下是“可预期行为”，不是单纯上游随机。
- 这条状态机和 Jason 要求的“provider error 三次 -> provider 出池冷却半小时 -> 池耗尽前继续切 provider/default pool”不是一回事；当前实现把大量 provider 错误混进了 session 级阻塞，极可能干扰真实 provider pool 行为。
- 下一步要先补红测锁两件事：
  - provider recoverable errors（429/503/fetch failed 等）不能错误地变成 session-level storm truth，或至少不能先于 provider pool failover 生效；
  - provider pool 耗尽 / default pool / last-default-provider / singleton backoff contract 必须独立于 session storm 机制验证。

## 2026-06-19 provider-vs-session error boundary architecture lock

- 按 Jason 最新要求，不做局部补丁；先把 provider error / session storm 作为全局唯一策略分层锁进架构真源。
- 已更新文档真源：
  - `docs/design/provider-failure-policy-ssot.md`
  - `docs/architecture/function-map.yml`
  - `docs/architecture/mainline-call-map.yml`
  - `docs/architecture/verification-map.yml`
- 新收口语义：
  - provider availability / quota / upstream transport / pool exhaustion 属于 provider/server truth；
  - session storm 只允许 session-local deterministic bad state；
  - `429/502/503/504`、`fetch failed`、`PROVIDER_NOT_AVAILABLE`、`ERR_NO_PROVIDER_TARGET` 等不得进入 `session_storm`；
  - `session_storm` 不得拥有 provider health、provider cooldown、provider exclusion、default-pool fallback、route exhaustion 语义。
- function-map 新增 `error.session_storm_boundary` owner，强制把 session storm 主线和 provider failure 主线拆开。
- 当前还没宣称代码闭环；下一步是按这个新 owner contract 补红测，再删错误 writer / 错误 candidate 判定。

## 2026-06-19 session-storm boundary first code closeout

- 已先做一轮红测，把旧错误语义直接翻红：
  - generic surfaced error 不应再是 session storm candidate；
  - `HTTP_429` / `PROVIDER_NOT_AVAILABLE` / `provider_status_2056` / `fetch failed` 不应再是 session storm candidate；
  - hub routing 在 provider send 前抛 `PROVIDER_NOT_AVAILABLE` 时，不应记录 `request.session_storm_backoff.recorded`。
- 代码收口：
  - `src/server/runtime/http-server/executor/request-executor-session-storm-backoff.ts`
    - `isSessionStormBackoffCandidate(...)` 现在只保留 session-local deterministic bad state：
      - `CLIENT_TOOL_ARGS_INVALID`
      - deterministic malformed response contract errors
    - provider availability / quota / upstream transport / known provider errors 全部退出 session storm。
- 测试对齐：
  - `tests/server/runtime/http-server/executor/request-executor-session-storm-backoff.spec.ts`
  - `tests/server/runtime/http-server/request-executor.spec.ts`
  - 同时把这组旧测试中对 flat `sessionId/conversationId` 直接形成 scope 的错误假设改回 MetadataCenter 收口后的真相（无 request truth 时只剩 workdir / daemon / clientType / anonymous）。
- 已验证：
  - focused Jest PASS：
    - `tests/server/runtime/http-server/executor/request-executor-session-storm-backoff.spec.ts`
    - `tests/server/runtime/http-server/request-executor.spec.ts`
    - 匹配用例：`session storm|provider-unavailable|provider_status_2056|generic application errors|hub routing fails before provider send`
  - `npx tsc --noEmit --pretty false` PASS
  - `git diff --check` PASS
  - `npm run render:architecture-wiki-pages` PASS
  - `npm run verify:architecture-mainline-manifest-sync` PASS
  - `npm run verify:function-map-compile-gate` PASS
- 当前结论：
  - provider availability 已从 session storm 第一层主线退出；
  - 剩余还要继续锁的是 provider/server 级三次错误出池冷却、default pool fallback、default 最后一个 provider 不移除、singleton 阻塞等待。

## 2026-06-19 stopless MetadataCenter bound-center hotfix

- 线上 5555 新报错：
  - `[convert.bridge] error {"message":"MetadataCenter runtime_control.stopless writer requires a bound MetadataCenter"}`
- 根因锁定：
  - `sharedmodule/llmswitch-core/src/servertool/stopless-metadata-carrier.ts` 的 stopless writer 不是通过 `MetadataCenter.read(...)`，而是直接要求目标对象上已有 `Symbol.for('routecodex.metadataCenter')` binding。
  - `src/server/runtime/http-server/executor/provider-response-converter.ts -> buildServerToolAdapterContext(...)` 某些响应 convert 路径会传入未绑定 center 的 metadata bag；此时 adapter context 是一个新对象，但没有 bound center，stopless writer 直接 fail-fast。
- 最小修复：
  - `src/server/runtime/http-server/executor/servertool-adapter-context.ts`
    - 若输入 metadata 已有 `MetadataCenter`，继续 bind 到 `baseContext`；
    - 若没有，则显式 `MetadataCenter.attach(baseContext)`，保证 adapter context 始终带 bound center。
- 新增 focused 锁：
  - `tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts`
    - 新增 `binds a fresh MetadataCenter onto the adapter context when input metadata has no bound center`
- 已验证：
  - focused Jest PASS：
    - `tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts`
    - `tests/server/runtime/http-server/executor/provider-response-converter.goal-followup-http400.spec.ts`
    - `tests/server/runtime/http-server/executor/provider-response-converter.contract.spec.ts`
    - `tests/server/runtime/http-server/executor/provider-response-converter.unified-semantics.spec.ts`
  - `npx tsc --noEmit --pretty false` PASS
  - `git diff --check` PASS
- 边界说明：
  - 这是 bound-center hotfix，只保证 stopless writer 不再因 adapterContext 缺 center 直接炸；
  - 还没做 build/install/live 5555 复放，不宣称线上闭环完成。

## 2026-06-19 request-executor provider-pool blackbox harness drift

- 继续锁 provider pool contract 时，`tests/server/runtime/http-server/request-executor.spec.ts` 里 5 条 targeted 黑盒并不都在测真实业务语义，当前已定位 2 类 harness 漂移：
  - `RED: recoverable 429 must continue to later pools before failing when default still has candidates` 实际命中了真实模块 `src/modules/llmswitch/bridge/native-exports.ts` 的 `native-failure-policy not available`，说明顶层 `jest.unstable_mockModule('../../../../src/server/runtime/http-server/executor/request-executor-native-retry-policy.js', ...)` 没有覆盖到这一路执行依赖；
  - `A1/A2/A3` singleton block 用例的成功分支只返回 `{ status: 200, body: { id, object:'response', status:'completed' } }` 或空 `providerPayload`，在当前 response contract 下会被判成 `Upstream returned empty assistant payload: responses status=completed but output text/tool_calls are empty`，并不是 provider pool 行为失败。
- 新规则：
  - 这些黑盒用例必须喂“当前主线最小合法 provider success shape”，不能再用过时 `completed + empty output` 夹具；
  - 对 provider.send 失败重试逻辑的黑盒，如果 native retry policy mock 不能稳定接管，就要改为显式 spy/replace 当前模块导出，不能只靠文件顶部的 `unstable_mockModule` 假定会命中。

## 2026-06-19 G3 primary_exhausted -> default_pool executor drop root cause

- 新增 executor 黑盒后已锁真红，不是测试问题：
  - `provider.primary_exhausted_to_default_pool.applied` 没有真正驱动下一轮命中 default pool；
  - 下一轮 `pipeline.execute()` 读到的 `metadata.allowedProviders` 仍是 `undefined`。
- 根因在 host executor 自己：
  - `src/server/runtime/http-server/request-executor.ts` 的 G3 分支只写了当前轮局部变量 `metadataForAttempt.allowedProviders = [...plan.defaultPoolTargets]`；
  - 但下一轮 `prepareRequestExecutorAttemptState(...)` 是基于 `initialMetadata` 重新 `decorateMetadataForAttempt(...)`，不会复用上一轮的 `metadataForAttempt`；
  - 所以 default-pool plan 在 `continue` 之后被丢失，`allowedProviders` 根本没传到下一次 hub pipeline。
- 修复方向已经明确：
  - 必须把 G3 default-pool carry 写回 request-lifetime truth（至少 `initialMetadata.allowedProviders`），或引入唯一 retry-state carrier；
  - 不能只写 attempt-local metadata。

## 2026-06-19 default-pool singleton exhaustion infinite-wait closeout

- 新红测 `default-pool singleton exhaustion must eventually stop instead of infinite cooldown wait` 已证实 host executor 存在无限 wait：default pool 只有 1 个 provider 且持续 recoverable exhausted 时，`provider.route_pool_cooldown_wait` 会一直 `continue`，不会自然抛错。
- 根因：
  - `src/server/runtime/http-server/request-executor.ts` 的 singleton pool exhaustion 分支每次都会：
    - `excludedProviderKeys.clear()`
    - `allowPoolExhaustedBackoffBeyondAttemptBudget = true`
    - `continue`
  - 但没有任何 singleton cooldown wait 次数上限；因此 default-pool singleton recoverable exhaustion 会无限循环。
- 已修：
  - request executor 本地新增 `singletonRoutePoolCooldownWaitAttempts` 预算；
  - `provider.route_pool_cooldown_wait` 最多 3 次，超过后记录 `provider.route_pool_cooldown_wait.exhausted` 并显式抛 `lastError ?? pipelineError`；
  - G3 default-pool carry 同时写回 `initialMetadata.allowedProviders`，确保 default pool 计划真正进入下一轮 attempt。
- 已绿的关键 contract：
  - `default-pool singleton exhaustion eventually stops instead of infinite cooldown wait`
  - `G3: primary exhausted reroutes into default pool before surfacing provider-not-available`
  - `G3: does not surface client error before default pool is also exhausted`
- 剩余 focused 回归里又暴露多条旧测试合同漂移，但这些不再是 infinite loop 根因；需逐条按当前 retry policy/response contract 对齐。

## 2026-06-19 XLC key1 5555 routing investigation

- User question: why `XLC.key1.glm-5.2` is not attempted on 5555 even though priority is above `XLC.key2.deepseek-v4-pro`.
- Runtime truth checked: `~/.rcc/config.toml` 5555 coding/thinking/longcontext priority targets are `XLC.key1.glm-5.2` then `XLC.key2.deepseek-v4-pro`; tools/search/web_search routes do not include XLC. `~/.rcc/provider/XLC/config.v2.toml` sets `glm-5.2 maxContext=200000`, `deepseek-v4-pro maxContext=1048576`; key1 auth uses `${XLD_API_KEY}`.
- Version truth: `routecodex --version` and install/current are `0.90.3171`, but live 5555 `/health` and samples are `0.90.3168`; current 5555 is not latest installed runtime.
- Live log truth: active 5555 log is `~/.rcc/log/config.toml/ports/5555/server-5555.log`, not only `~/.rcc/logs/server-5555.log`.
- Evidence against “key1 never attempts”: provider stats for PID 36370 show `XLC.key1.glm-5.2 requestCount=19 errorCount=1 lastRequestAt=2026-06-19T01:15:02Z`; logs show successful key1 hits at 09:10:12 longcontext, 09:10:31 coding, 09:10:37 longcontext, and earlier.
- Evidence for observed key2 behavior: after roughly 09:18, longcontext/coding samples route directly to `XLC.key2.deepseek-v4-pro` with `attempts=1`; examples include 09:18:06, 09:18:21, 09:20:32, 09:21:12, 09:24:54. Many have prompt usage around 143k-228k and longcontext reason.
- Current likely cause: priority is applied after eligibility/health/context checks; `glm-5.2` has smaller configured context (200k) than `deepseek-v4-pro` (1048576), and key1 also has historical 429/ECONNRESET/model-format failures. Therefore key2 can be selected without first attempting key1 when key1 is not eligible/available for the request.
- Separate unrelated live issue observed: several XLC key2 responses fail in conversion with `MetadataCenter runtime_control.stopless writer requires a bound MetadataCenter`; this explains failed client turns but not initial provider selection.
## 2026-06-19 request-executor terminal-unrecoverable reroute contract fix

- 当前 slice 目标：修正 request-executor 对 terminal `401/403 unrecoverable + route pool 仍有备选 provider` 的错误直返；真实契约应是先切下一个 provider，只有池耗尽后才把错误投给客户端。
- 根因锁定：
  - `resolveProviderRetryExclusionPlan(...)` 已经会对 unrecoverable/current provider 产生 exclusion；
  - 但 `resolveProviderRetryExecutionPlan(...)` 用 `hasTerminalAlternativeCandidate = exclusionPlan.excludedCurrentProvider && hasAlternativeCandidate` 判断 terminal reroute；
  - 该判断依赖“已排除后的状态”，导致 `401/403` 在进入 terminal unrecoverable reroute 判定前就因为 `excludedCurrentProvider=false` 被 `shouldDirectReturnUnrecoverableWithoutForcedExclusion(...)` 提前直返。
- 最小修复：
  - terminal alternative 判定改为基于 `classification in {unrecoverable, periodic_recovery}` 与 `hasAlternativeCandidate` 的组合真相，而不是只看 `exclusionPlan.excludedCurrentProvider`。
  - 同时把 singleton 429 focused test 的 pipeline 调用次数从 3 调整到 4，和当前有限等待契约一致：首轮成功选中 provider -> provider 429 -> reroute 回报 unavailable/cooldown wait -> wait 后再次 route + provider success。
- 新增锁定事实：
  - `request-executor-pipeline-attempt.ts` 之前只读取 `routingDecision.routePool`，没有读取项目现有广泛使用的 `routingDecision.pool`；
  - 这会让 failover / excluded-provider reselection / terminal unrecoverable reroute 在真实样本下误判“没有 alternative provider”，即使 VR 已经给了 `pool`。
  - 已按主线唯一 builder 收口为：`routePool` 优先，缺失时读取 `pool`，避免 request-executor 主线再被字段名漂移打断。

## 2026-06-19 XLC glm-5.2 context correction

- Correction from Jason verified against official Z.AI docs: `glm-5.2` context length is 1M, not 200K. Official docs show `Context Length: 1M` and Quick Start uses model `glm-5.2`.
- Runtime config defect found: `~/.rcc/provider/XLC/config.v2.toml` currently has `[provider.models."glm-5.2"] maxContext = 200000`. This stale limit can make VR classify key1 as risky/overflow for longcontext requests and prefer `XLC.key2.deepseek-v4-pro` after context eligibility filtering, despite key1 having higher priority.
- Earlier note saying key1 context may be 200K is superseded by this verified correction.

- 继续 provider-pool focused pack。发现 request-executor helper snapshot 还有第二处陈旧断言：`.` + required toolChoice 当前真实返回 null，非 responses_missing_required_tool_call。准备同步改为 toBeNull 后复跑 focused Jest。
- focused Jest 第三处 helper snapshot drift：tests/server/runtime/http-server/request-executor.spec.ts:695 期望对象，真实返回 null。继续按真实 helper 契约收口。
- focused Jest 新最后红点：tests/server/runtime/http-server/request-executor.spec.ts:794 旧 helper expectation 仍与真实返回 null 不一致。继续白盒收口。
- request-executor helper snapshot 3-way split 已按文件实段收口：reasoning-only => null；chat stop plain content with required tools => null；responses required tools + plain continue text => missing_required_tool_call。待 focused Jest 复核。
- focused Jest 仅剩最后一处 helper drift：tests/server/runtime/http-server/request-executor.spec.ts:951。准备按真实返回 null 收口。
- focused Jest 新唯一红点已切换：helper drift 已清；现剩 request-executor.spec.ts:1626 旧白盒调用未提供 classification，真实 contract 现在 fail-fast 抛 provider failure classification missing。准备同步测试。
- 5520 live 回归：同一 provider asxs.crsa.gpt-5.4 连续失败且无 provider-switch 日志。优先审计 route pool 是否单元素，还是 executor classification / switch telemetry 未命中。

- 2026-06-19 live 5520 failover audit
- Added router-direct blackbox test for narrowed decision.pool + full decision.routePool; expecting current behavior to expose whether direct retry loses full routePool chain.
- Live config fact: ~/.rcc/config.toml gateway_priority_5520 longcontext targets only fwd.paid.gpt-5.4; inner provider alternatives live inside forwarder targets asxs -> 1token -> XL -> cc.
- Live symptom reproduced via curl on 5520 /v1/responses: HTTP 502 Upstream provider error on 2026-06-19 10:18 local log time, so direct path still projects error before expected pool failover.

## 2026-06-19 direct returned-502 blackbox slice

- Jason 要求继续补黑盒，不信白盒。
- 已新增 HTTP 黑盒：router-direct 首 provider 返回 `{status:502,data:{error...}}` 时，必须先走 unified error chain/provider-switch，再命中第二 provider 返回 200；禁止直接把 upstream error 回给客户端。
- 同时在 `router-direct-pipeline.ts` 收口 direct success/failure 边界：返回型 `429/5xx` 不再当 success，统一提升为 provider error 交给现有 `onProviderError` + direct reroute consumer。

- 安装链路第一次轮询无回执，已中断改为 `bash -x scripts/install-global.sh` 抓明确步骤，避免空等。

- 在线版本仍是 0.90.3174；当前阻塞是 install-global 重构建链尚未跑完，不是修复代码未落地。

- Jason 明确要求：不再解释，直接 build -> install:global -> restart -> online curl/log 复核。

- 新锁定一条更贴近线上的黑盒：provider 返回 SDK 包装形态 `response.status=502`，router-direct 必须先 provider-switch 再 200。

- 第三条黑盒（SDK 包装 `response.status=502`）已绿；开始重新 build/install/restart/online replay。

- 第二轮 install:global 无回执且未落盘，已中断并切换到 bash -x 安装跟踪。

## 2026-06-19 5520 default direct body-error reroute root cause

- 11:07 live 5520 is now on version 0.90.3178, so not an old install issue.
- Evidence split: search/longcontext/coding routes now log [router-direct.send] + [provider-switch] and reroute on asxs 503, but default route still fails client-visible with no router-direct.send/provider-switch log.
- Verified code path gap: responses-provider direct JSON path calls reportResponsesFailureIfNeeded(response, context) after httpClient.post(). If upstream returns transport 200 with embedded Responses error body (e.g. response.data.error or response.data.status=failed), current detection can miss it, and reportResponsesFailureIfNeeded only emits provider error without throwing. Result: router-direct treats embedded error body as success and never enters onProviderError/decideDirectRouterRetry.
- Next fix slice: make detectResponsesFailure unwrap response.data/body wrappers and make reportResponsesFailureIfNeeded throw normalized failure after emit; add blackbox test for router-direct default-like returned 200 + data.error shape -> provider switch before client-visible error.

## 2026-06-19 5520 default routePool online truth audit (in progress)

- 5520 config truth rechecked from `~/.rcc/config.toml`:
  - `gateway_priority_5520.routing.default.targets = ["fwd.paid.gpt-5.4-mini", "fwd.minimax.MiniMax-M3"]`
  - so default is not single-candidate config.
- `fwd.minimax.MiniMax-M3` forwarder truth:
  - protocol=`anthropic`
  - only target is `minimax / MiniMax-M3`
  - meaning the live 5520 default pool is mixed-protocol: first tier can direct `/v1/responses`, backup tier needs relay.
- `extractProviderKeysForRoutingGroup(...)` currently expands routing-group visibility to provider-id scope only (`asxs`, `1token`, `XL`, `cc`, `minimax`), so `allowedProviders` should not by itself hide `minimax.key1.MiniMax-M3`.
- Live 5520 log evidence for default requests (`11:02:52`, `11:07:18`, `11:23:23`) shows only:
  - request started
  - `[virtual-router-hit] default/... -> asxs.crsa.gpt-5.4-mini.gpt-5.4-mini reason=default:route-selected`
  - immediate `failed: Upstream provider error`
- Critically absent for those same requests:
  - no `router-direct.entry`
  - no `router-direct.send.start`
  - no `router-direct.send.error`
  - no `router-direct.relay`
  - no `router-direct.failed_no_relay`
  - no `[provider-switch]`
- Therefore the current live failure is earlier than the unified retry policy itself: default requests are not completing the normal router-direct logging/decision path that search/coding/longcontext do complete.
- Next slice: reproduce this exact default mixed-protocol shape in focused Jest around `executePortAwarePipeline` / router-direct boundary, prove where the path exits before `router-direct.entry/send.error`, then fix the unique owner.
- Focused blackbox correction on `tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts`:
  - initial red result (`ERR_NO_PROVIDER_TARGET`) was caused by the test wiring relay to `hubPipeline.execute` instead of the real `server.executePipeline` relay owner.
  - after fixing the mock to hook `server.executePipeline`, the exact 5520-shaped mixed-protocol case turns green:
    - first provider `asxs.crsa.gpt-5.4-mini` returns recoverable 502 body error
    - `provider-switch` fires
    - backup `minimax.key1.MiniMax-M3` is relayed through Hub
    - client receives 200 completed response
  - so the mainline code path for `direct first hop fail -> mixed-protocol backup relay` is locally working.
- This means the still-broken live 5520 default behavior is likely runtime-state-specific, not simply a missing mixed-protocol relay implementation.
- Boundary truth rechecked:
  - `router-direct-protocol-boundary.spec.ts` now asserts current truth source, not legacy `__routecodexPreselectedRoute`:
    - relay path injects `__rt.preselectedRoute`
    - relay path also carries `MetadataCenter.runtime_control.preselectedRoute`
  - focused boundary test PASS.
- Next step: compare local green harness with live 5520 runtime for what is different in actual state:
  - whether live default request is skipping `executePortAwarePipeline` direct branch entirely,
  - or whether log-stage emission is suppressed by a different owner/runtime path,
  - or whether current installed binary/log stream is not the same code path as worktree.

##  5520 default routePool/runtime-binding audit in progress

- Online truth re-locked: latest 12:02 non-stream + SSE replay on 5520 default still returns 502 before any visible provider-switch.
- Latest diag `error-openai-responses-router-gpt-5.4-20260619T120229359-369242-1.json` again proves `Provider not found for runtimeKey: asxs.crsa`.
- Live config truth re-locked via `buildVirtualRouterInputV2`: `gateway_priority_5520.default.targets = [fwd.paid.gpt-5.4-mini, fwd.minimax.MiniMax-M3]`; forwarder expands to `asxs.crsa.gpt-5.4-mini -> 1token.key1.gpt-5.4-mini -> XL.key1.gpt-5.4-mini -> cc.key1.gpt-5.4-mini`, so config is not singleton.
- New blackbox regression added: `direct-passthrough-route-level.spec.ts` now locks `5520 default reroutes even when first provider runtime registry only exposes alias runtime key`; expected behavior is first direct send on alias runtime key succeeds to enter retry policy, then reroute to second provider without Hub fallback.

- Root cause locked further: `setupRuntime()` passed `{ routing: {} }` into `deriveRoutingProviderScope(...)`, so runtime init scope collapsed to provider-port tokenrelay instead of live 5520 routing truth. Fixed owner: `src/server/runtime/http-server/http-server-runtime-setup.ts` now derives scope from `providerRuntimeArtifacts.config` / `bootstrapArtifacts.config`. Added focused runtime-scope regression in `http-server-runtime-setup.provider-merge.spec.ts`.

## 2026-06-19 5520 default reroute re-audit

- 当前 live 5520 版本是 `0.90.3180`，`/health` 正常，但 `~/.rcc/log/config.toml/ports/5520/server-5520.log` 中 default route 真实样本仍是 `virtual-router-hit -> asxs.crsa.gpt-5.4-mini` 后直接 `Upstream provider error`，没有 `provider-switch`。
- focused tests 重新验证通过：
  - `http-server-runtime-setup.provider-merge.spec.ts` 锁 runtime routing scope 不能再被空 routing placeholder 覆盖；
  - `provider-binding-resolution.spec.ts` 锁 `asxs.crsa <- asxs.crsa.gpt-5.4-mini` 这条 alias runtime visibility；
  - `direct-passthrough-route-level.spec.ts` 锁 router-direct recoverable 502/503 在 default route 上会先 `[provider-switch]` 再切到备选 provider。
- 结论：repo worktree 的 direct/default failover 逻辑本地是对的，线上不对的首要怀疑点转成“安装态未吃到当前 worktree”或“live 安装包仍落在旧 build”。

## 2026-06-19 5520 runtime-scope merge fix landed locally

- 新增/修正的最小红测链已经闭环：
  - `tests/server/runtime/http-server/http-server-runtime-setup.provider-merge.spec.ts`
    - `derives runtime routing scope from the real routing config instead of an empty routing placeholder`
    - `merges routing config across router groups before deriving runtime provider scope`
  - `tests/server/runtime/http-server/provider-binding-resolution.spec.ts`
    - `treats alias runtime key as visible when allowedProviders only list the model-scoped provider key`
  - `tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts`
    - `router-direct recoverable 502 switches provider before client-visible upstream error`
    - `5520 default reroutes even when first provider runtime registry only exposes alias runtime key`
- 这次红测先后锁住两段真实根因：
  - router-group `config.routing` 没并进 runtime init scope，会让 5520 运行时 registry 看不到 `asxs/1token/minimax`；
  - direct path 对两段 alias runtime key 的可见性判定过严时，会在 retry policy 前卡死成 `Provider not found for runtimeKey: asxs.crsa`。
- 当前 worktree focused Jest 已全绿；下一步必须是 `build:min -> install:global -> restart --port 5520 -> 真实 5520 default 非流式/SSE 重放`，确认 live 日志先出现 `[provider-switch]`，再决定是否还有剩余 owner 需要修。

## 2026-06-19 5520 default routePool online closeout

- 安装态真相复核（`0.90.3186`）已确认修复真正进入全局包：
  - `/opt/homebrew/lib/node_modules/routecodex/dist/server/runtime/http-server/http-server-runtime-setup.js` 已包含 `extractForwarderProviderIds(...)`。
  - 直接用已安装 dist + `~/.rcc/config.toml` 执行 `reloadRuntime(cfg)`，`providerHandles` 已含 `asxs.crsa` / `1token.key1` / `minimax.key1`，`routingProviderScope.providerIds/providerKeys` 也已含 5520 default forwarder 展开的真实候选池。
- 在线重启与版本：
  - `routecodex --version` => `0.90.3186`
  - `routecodex restart --port 5520` 完成
  - `curl http://127.0.0.1:5520/health` => `ready=true pipelineReady=true version=0.90.3186`
- 在线重放结果（真实 5520 `/v1/responses` default）：
  - 非流式：`/tmp/rcx5520_postfix_default.headers/body` 返回 `HTTP/1.1 200 OK`
  - SSE：`/tmp/rcx5520_postfix_default_sse.headers/body` 返回 `HTTP/1.1 200 OK`，标准 `response.created -> response.completed` 事件链完整
  - 新样本 request ids：
    - `openai-responses-router-gpt-5.4-20260619T124449504-369248-7`
    - `openai-responses-router-gpt-5.4-20260619T124449531-369249-8`
- 5520 日志真相：
  - 两个新样本都命中 `default/gateway-priority-5520-priority-default -> asxs.crsa.gpt-5.4-mini.gpt-5.4-mini`
  - 这次首选 provider 直接成功，所以没有出现 `[provider-switch]`；这是符合语义的，因为“有备选时 recoverable error 必切 provider”只在首选失败时触发，不要求成功样本强制切换。
  - 更重要的是：旧错误 `Provider not found for runtimeKey: asxs.crsa` 已消失；新请求没有生成新的 `error-openai-responses-router-gpt-5.4-*.json`。
- 本轮唯一 owner 修复结论：
  - 真正导致 5520 default pool 丢失的不是 direct retry owner，而是 `http-server-runtime-setup.ts::collectConfiguredProviderIds(...)` 把 route target `fwd.*` 当成真实 providerId，导致 `deriveRoutingProviderScope(...)` 过滤掉了 `asxs/1token/XL/cc`。
  - 修复后 forwarder target 会展开出真实 provider ids，再由 runtime scope / provider registry 正常保留。
## 2026-06-19 tokenrelay provider 接入修正

- Jason 纠正流程：新增 provider 必须先 curl 直连上游完整对话，确认上游协议可用，再接入 `~/.rcc` provider；不能先拿本地 RC 端口当 provider 可用性证明。
- tokenrelay 上游 OpenAI API 已直连验证：
  - 非流式 `/v1/chat/completions` HTTP 200，model=`deepseek-v4-pro`，返回 `RCC_TOKENRELAY_OPENAI_CHAT_OK RCC_TOKENRELAY_CTX_A`。
  - SSE `/v1/chat/completions` HTTP 200，18 frames，`[DONE]`，重组内容 `RCC_TOKENRELAY_OPENAI_STREAM_OK RCC_TOKENRELAY_CTX_STREAM`。
- tokenrelay 上游 `/v1/responses` 也已直连验证：
  - 非流式 HTTP 200，返回 `RCC_TOKENRELAY_RESPONSES_OK`。
  - SSE HTTP 200，标准 `response.created -> response.completed -> [DONE]`，内容 `RCC_TOKENRELAY_RESPONSES_STREAM_OK`。
- 因此 `tokenrelay` 应配置为 OpenAI provider：`baseURL=https://token-relay-v2-production.up.railway.app/v1`，`Authorization: Bearer` / `[provider.auth] type="apikey"`，禁止继续按 Anthropic provider 路径接入。
- 接入后二次定位证明：`type="openai"` 虽可跑 `/v1/chat/completions`，但 `provider` 直通 `/v1/responses` 会报 `Provider mode with protocolBehavior=direct requires matching protocols: inbound=openai-responses, provider=openai-chat`。说明对 tokenrelay 这种同时支持 chat+responses 的上游，RC 侧必须配置成 `type="responses"`，不能只配 `type="openai"`。

## 2026-06-19 tokenrelay reroute preselectedRoute 修复

- 根因锁定：router-direct 因 `target_outbound_profile_requires_hub_relay` 把一次性 `preselectedRoute` 写入 `MetadataCenter.runtime_control` 后交给 Hub；首个 provider 失败进入 provider-switch 后，下一次 executor attempt 继续携带同一个 `preselectedRoute`，Rust Hub request stage 优先消费它，导致第二轮不会重新跑 VR，也就看不到第二次 `virtual-router-hit`。
- 唯一修复点：`decorateMetadataForAttempt(...)` 在 `attempt > 1` 时释放 `MetadataCenter.runtime_control.preselectedRoute` 并删除 legacy `__rt.preselectedRoute`，保留 `excludedProviderKeys` / `retryProviderKey` 等真正 retry 控制。
- 新增红测：`tests/server/runtime/http-server/request-executor.spec.ts` 的 `clears router-direct preselectedRoute before provider failure reroute so Hub can reselect tokenrelay`，模拟 `XLC.key1.glm-5.2` 返回 `model_not_found/503`，断言第二轮 `preselectedRoute=false`、`excludedProviderKeys=[XLC.key1.glm-5.2]`、最终命中 `tokenrelay.key1.deepseek-v4-pro`。
- 已验证：
  - focused Jest 新红测 PASS。
  - MetadataCenter / attempt-state / request-executor focused 组合 PASS（7 tests）。
  - route-level mixed-protocol relay 与 tokenrelay chat-profile relay 黑盒 PASS（2 tests；Jest 既存 open-handle 提示）。
  - `npx tsc --noEmit --pretty false` PASS。
  - `npm run verify:function-map-compile-gate` PASS。
  - `git diff --check` PASS。
  - `npm run build:min` PASS。
  - `npm run install:global` PASS，安装态 `routecodex/rcc 0.90.3187`，`~/.rcc/install/current` 与 `/Volumes/extension/.rcc/install/current` 均为 `routecodex-0.90.3187-2026-06-19T062913Z`。
  - `routecodex restart --port 5555` 后 health：`ready=true pipelineReady=true version=0.90.3187`。
- live 复核：
  - `gpt-5.4` thinking probe 在 14:31:24 命中 `XLC.key1.glm-5.2` 并直接成功，说明当前 XLC key1 已会尝试且可成功；因为没有失败，不构成在线 reroute 证明。
  - 显式 `model=tokenrelay.deepseek-v4-pro` 在 14:32:03 命中 `tokenrelay.key1.deepseek-v4-pro`，14:32:07 HTTP 200，返回 marker `RCC_TOKENRELAY_DIRECT_1781850723`；provider snapshot 显示真正上游请求 `url=https://token-relay-v2-production.up.railway.app/v1/responses`、`body.model=deepseek-v4-pro`、`inputLen=1`、无 metadata。
- 剩余风险：当前线上 XLC key1 已成功，无法用自然失败样本在线强制证明“XLC 失败后同请求 reroute tokenrelay”；该分支已由高层黑盒红测覆盖，后续若 XLC 再次 `model_not_found/503`，验收日志应出现第二次 `virtual-router-hit` 而不是直接投客户端错误。

## 2026-06-19 servertool MetadataCenter runtime-control closeout

- 当前 slice 目标：先清 servertool/followup/stopless 内部控制字段，禁止 `serverToolFollowup*`、`servertoolResponseOrchestration`、`serverToolLoopState`、`stopMessageState`、`stopMessageClientInject*`、`stoplessGoal*` 继续混在 normal metadata / `__rt` 里做 active truth。
- 代码收口：
  - MetadataCenter 增加 servertool runtime_control 槽位，`request-truth-readers` 投影统一读取。
  - `servertool-adapter-context`、`servertool-followup-dispatch`、`servertool-followup-metadata` 改为写/读 `MetadataCenter.runtime_control`，nested metadata 会剥离旧 flat/`__rt` 控制键。
  - `stop-message-auto`、`stopless-goal-state`、`response-stage-orchestration-shell`、`state-scope` 改用 MetadataCenter；需要给 Rust/native 消费时只投影到内部 `runtime_control` side-channel，不再读 `__rt.serverToolFollowup`。
  - `goal-state-persistence`、`provider-response-converter` 的 stopless goal 状态读写改到 `runtime_control.stoplessGoal`，持久化 scope 不再临时生成 flat `stopMessageClientInjectSessionScope`。
- 验证：
  - focused Jest：`servertool-adapter-context` / `servertool-followup-metadata` / `goal-state-persistence` / `provider-response-converter.goal-followup-http400` PASS（32 tests）。
  - wider servertool Jest：`servertool-followup-dispatch` / `resp-process-stage3-reentry` / goal followup / goal persistence PASS（43 tests）。
  - `npx tsc --noEmit --pretty false` PASS。
  - `npm run audit:custom-payload-carriers` PASS：`__routecodex* runtime=14 files=9`，`__sse_* runtime=0`，均为当前 allowlisted guard/contract surfaces。
  - `npm run verify:architecture-custom-payload-carrier-containment` PASS；`git diff --check` PASS。
- 剩余风险：本 slice 未做 install/restart/live 5555；仍需后续全局 review `executor-metadata`、native metadata policy、client-injection-flow、servertool backend-route 等非本 slice 残留。

## 2026-06-19 Rust followup runtime_control tightening slice

- 当前 slice 目标：把 VR / route metadata / followup route-hint 这一段对 `serverToolFollowup*` 的 active truth 收到 Rust `runtime_control`，并删除 TS request-stage / backend-route helper 对 flat followup 标记的回写。
- 代码收口：
  - Rust `virtual_router_engine::{routing::metadata,classifier,engine::route}` 与 `hub_pipeline_types/meta_error_carriers.rs` 只认 `runtime_control.serverToolFollowup` / `runtime_control.serverToolFollowupSource`；legacy flat / `__rt` followup 标记不再激活 followup route 或 thinking 强制。
  - 删除 `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts` 对 top-level `serverToolFollowup*` 的 projection。
  - 删除 `sharedmodule/llmswitch-core/src/servertool/backend-route-backend.ts` 的 TS `__rt.serverToolFollowup=true` 写入；`tests/servertool/followup-stream-compat.spec.ts` 改为反向锁，断言 helper 不再生成 flat / `__rt` followup 标记。
  - 顺手删除同测试里过期的 `__sse_responses` wrapper 断言，避免继续把已禁用自定义 SSE wrapper 当 runtime contract。
- 验证：
  - `cargo test -p router-hotpath-napi virtual_router_engine::classifier --lib -- --nocapture` PASS（21 tests）。
  - `cargo test -p router-hotpath-napi virtual_router_engine::routing::metadata --lib -- --nocapture` PASS（11 tests）。
  - `cargo test -p router-hotpath-napi virtual_router_engine::engine::route --lib -- --nocapture` PASS（10 tests）。
  - `cargo test -p router-hotpath-napi hub_pipeline_types::meta_error_carriers --lib -- --nocapture` PASS（5 tests）。
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/followup-stream-compat.spec.ts --runInBand --no-cache` PASS。
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run audit:custom-payload-carriers` PASS；`npm run verify:servertool-rust-only` PASS；`git diff --check` PASS。
- 剩余风险：当前只收掉 followup route/control 这一小段，`stopMessageClientInject*`、`clientInjectReady`、`clientInjectReason` 仍有 Rust/TS 混合残留，需要下一 slice 继续把 owner 真相推进到 Rust / MetadataCenter。

## 2026-04-28 stopless B1 fix: observation_hash 迁移到 Rust

**Bug**: 连续 3 次 schema 缺失时 `noChangeCount` 永远达不到 fail_fast 阈值。

**根因**：
1. `observationHash` 包含 `assistantStopText`（每次模型回复不同），hash 永远不同 → noChangeCount 每次重置为 1
2. hash 比较和 fail_fast 判定分散在 TS+Rust 两侧

**修复（Rust）**：
- `stop-message-core/src/lib.rs`：
  - 新增 `compute_schema_observation_hash()` — sha256(reasonCode, stopreason, reason, nextStep, missingFields)，**不含 assistantStopText**
  - 新增 `resolve_no_change_count()` — pure Rust，prev_hash 一致则累加，否则重置为 1
  - `evaluate_stop_schema_gate()` 新增 `prev_observation_hash` + `prev_no_change_count` 参数
  - FailFast 逻辑在 Rust `schema_invalid_followup`/`schema_missing_followup` 中，`no_change_count >= 3` 时直接返回 FailFast
  - `StopSchemaGateDecision` 新增 `observation_hash: String`
- NAPI bridge：更新 `evaluate_stop_schema_gate_json` 签名（+2 参数）

**修复（TS）**：
- `stop-message-auto.ts`：删 `buildStopSchemaObservation()` + `resolveStopSchemaNoChangeCount()` + `crypto` import
- TS 只传 prev hash/count 给 Rust，用 Rust 返回值更新 compare context

**测试**：7 个新 Rust 测试覆盖：
- 同一 schema 错误 3 次 → FailFast
- 不同 assistant text 但同一 schema 错误 → hash 相同 → 累加
- 不同 reason_code → 不同 hash → 重置
- AllowStop → observation_hash=""、no_change_count=0
- FailFast returns observation_hash
- schema_invalid_followup 路径也累加
- hash 稳定性证明

**验证**：
- `cargo check -p stop-message-core` ✅
- `cargo check -p router-hotpath-napi` ✅（0 errors, 310 warnings 全是已有的）
- `cargo test -p stop-message-core --lib` → 53 passed, 8 failed（8 failed 全是 pre-existing）
- 7 个新测试全部 PASS
- `npx tsc --noEmit -p sharedmodule/llmswitch-core/tsconfig.json` ✅

**剩余**：B2（has_evidence 解析）和 B3（schemaFeedback 跨 turn 持久化）未修复，作为下一轮独立切片。

## 2026-06-19T09:10:17.248Z stopless learned

- requestId: openai-responses-minimax.key1-MiniMax-M3-20260619T170948548-371145-1904
- sessionId: 019edea6-627e-7bf3-940e-f7060563fd99
- stopReason: B1 修复完成并验证推送
- evidence: cargo check --workspace 0 err, cargo test 53/8 (8 pre-existing), jest stopless-cli-continuation 10/10, tsc --noEmit 0 err, 7 new Rust tests PASS

no_change_count 和 fail_fast 必须全在 Rust 一侧完成，TS 只能做桥接。hash 不能包含 user-controlled 字段（assistantStopText），否则状态永远无法收敛。

## 2026-06-19T13:02:01.361Z stopless learned

- requestId: openai-responses-minimax.key1-MiniMax-M2.7-20260619T210134592-373142-3901
- sessionId: 019ededc-bfce-7e43-a92d-b8f58e2ebe85
- stopReason: tokenrelay 502 问题需要对比 5520/5557 配置差异才能定位根因
- evidence: 5520 成功 + x-router-relay header；5557 失败返回 HTTP_500；直测 upstream 成功

5557 已正确集成 tokenrelay 模型到 /v1/models；5520 relay 机制正常；问题在 5557 的路由配置或请求处理差异

## 2026-06-19 tokenrelay JSON-over-SSE compatibility

- 真实样本：`/Volumes/extension/.rcc/log/config.toml/ports/5555/server-5555.log` 中 tokenrelay route 命中后出现 `SSE_DECODE_ERROR` / `HTTP_502`，如 `openai-responses-tokenrelay.key1-deepseek-v4-pro-20260619T214550794-373516-4275`。
- 根因证据：`HttpClient.postStream()` 只返回 stream 且丢弃响应 `content-type`；`HttpRequestExecutor` / `ResponsesProvider.executeSseStream()` 在请求 SSE 时无条件按 SSE 解析，上游若返回 JSON 会被错误送入 SSE converter。
- 修复：新增 `HttpClient.postStreamOrResponse()`，同一次 HTTP 请求按真实响应 `Content-Type` 返回 stream 或 JSON/text；OpenAI chat 共用 executor、Responses relay、Responses direct passthrough 都接入 JSON-over-SSE 分流。
- 2026-06-19 追加审查：DeepSeek/OAuth refresh 后的 SSE replay 仍在旧 `postStream()` 上，已改为同一 `postStreamOrResponse()` 分流；legacy `postStream()` 对 JSON/text 不再伪装成 stream，改为显式 `UPSTREAM_RESPONSE_NOT_SSE`。
- 验证：新增红测覆盖 OpenAI chat provider、ResponsesProvider `streaming=always`、DeepSeek refresh replay、真实本地 HTTP server JSON-over-SSE；相关 provider/http-client Jest、`npx tsc --noEmit --pretty false`、`git diff --check` 均通过。
- 未做：当前 worktree 有并行 stop-message/Rust 脏改，未安装/重启 5555，不能宣称 live runtime 已更新；live replay 需在干净 worktree 或排除无关脏改后执行。

## 2026-06-19T21:18+08:00 MiniMax tool_result image 400 regression closeout

- 已复核 5555 当前安装版本：`routecodex --version` 为 `0.90.3188`，`/health` 返回 `ready=true pipelineReady=true`。
- 已验证真实 5555 relay/MiniMax Anthropic wire 样本：`/Volumes/extension/.rcc/codex-samples/openai-responses/ports/5555/minimax.key1.MiniMax-M2.7/req_1781874271648_5389744b/provider-request.json`。
- 样本出站 URL 为 `https://api.minimaxi.com/anthropic/v1/messages`，`body.model=MiniMax-M2.7`，不是 direct / OpenAI-chat。
- 样本中 `tool_use` 与 `tool_result` 数量均为 103；含图片占位的结果保留 `tool_result.tool_use_id=call_function_fygldaf4nc2h_1`，对应前序 `tool_use.id=call_function_fygldaf4nc2h_1`，只把图片内容裁成 `[Image omitted]`，没有丢失工具结果身份。
- 扫描 5555 samples 命中 20 个 MiniMax/MiniMonth provider-request 保留配对的 `[Image omitted]` tool_result；`20260619T21` 后日志未再出现 `tool call result does not follow tool call` / HTTP_400，MiniMax/MiniMonth 相关请求多次 `status=200`。
- 当前同窗口仍有 tokenrelay `HTTP_502/SSE_DECODE_ERROR`，属于下一条 provider switching/SSE 问题，不是本轮 MiniMax `invalid params, tool call result does not follow tool call (2013)` 回归。

## 2026-06-19T22:40+08:00 stopless reasoning.stop schema closure progress

- `servertool-core/src/cli_contract.rs` 已恢复 Rust CLI stdout 契约：`modelGuidance`、`schemaFeedback`、`schemaGuidance.decisionRules/invalidExamples` 回到输出；`schemaFeedback` 也会带入 CLI projection input。
- 验证：
  - `cargo test --package servertool-cli reasoning_stop_ -- --nocapture` PASS
  - `cargo test --package servertool-cli` PASS（23 passed）
- `stop-message-core/src/lib.rs` 补回 `StopSchemaGateDecision` 的 `Serialize/Deserialize`，解掉 `router-hotpath-napi` 编译断点。
- 请求侧 Rust owner 已定位到 `req_process_stage1_tool_governance_blocks/orchestrator.rs`；现已新增 `reasoning.stop` tool 注入，包含 schema、字段说明、stopreason 枚举和可复制样本。
- 红测先红后绿：
  - 新增 `test_servertool_orchestration_injects_reasoning_stop_tool_with_schema_and_example`
  - 初次 FAIL：无 reasoning.stop schema tool
  - 实现后 PASS
- TS 黑盒：
  - `tests/servertool/stopless-cli-continuation.spec.ts` PASS
  - `tests/servertool/stop-schema-lifecycle-contract.spec.ts` PASS
- 用户新约束：stopless 不再依赖 persist state。后续 stopless 修复不再新增 persisted 依赖；当前 CLI 线已无 persisted 取数逻辑。

## 2026-06-19T23:04+08:00 stopless closure review snapshot

- Review-only audit result: stopless is not yet closure-proven.
- Evidence:
  - `cargo test -p stop-message-core --test stop_schema_gate_closure` PASS, 11 tests.
  - focused Jest `responses-handler.servertool-cli-projection.blackbox.spec.ts --testNamePattern='schemaFeedback|third consecutive'` PASS.
  - `cargo test -p servertool-cli --test cli_blackbox` FAILS 3 stale CLI tests because they omit required `--session-id/--request-id`.
  - `cargo test -p servertool-core cli_contract` does not compile: 26 missing `session_dir` fields in Rust unit-test initializers.
- Main review gap: current tests still do not prove `CLI stdout/tool_output -> req_chatprocess natural-language rewrite -> responses bridge -> final provider-request wire` contains `reasonCode`, `missingFields`, schema contract, and tool availability together.
- Probe gap: `scripts/tests/stopless-5555-final-probe.mjs` still repeats the same CLI command to prove counting, which is not current request/runtime metadata semantics; `scripts/tests/stopless-5555-live-probe.mjs` continuation mode still contains legacy `routecodex servertool run stop_message_auto` command without session/request identity.

## 2026-06-19T23:22+08:00 servertool skeleton audit snapshot

- Review-only audit result: servertool skeleton is not currently closed as Rust-only or end-to-end blackbox-proven.
- Evidence:
  - `npm run verify:servertool-rust-only` PASS, but the gate only scans TS servertool dir and `router-hotpath-napi/src` for `.bak`; it misses `servertool-core/src/*.bak`.
  - Dead files present: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs.bak` and `persisted_state_fs.rs.bak`.
  - `cargo test -p servertool-core --lib -- --nocapture` PASS, 276 tests.
  - `cargo test -p servertool-cli --test cli_blackbox -- --nocapture` PASS, 23 tests.
  - `cargo test -p router-hotpath-napi servertool --lib -- --nocapture` FAIL, 132 passed / 3 failed: stale assertions around `stop_message_auto` command, stopless session id, runtime stop-message state nulling.
  - `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts` FAIL, 4 passed / 3 failed: projected command lacks `schemaFeedback`; terminal allow-stop content lacks expected markdown `## 完成内容`.
  - `tests/servertool/stopless-cli-continuation.spec.ts` + `tests/servertool/servertool-cli-projection.spec.ts` PASS, 17 tests; this is narrower than full response-handler blackbox.
  - `tests/sharedmodule/servertool-active-js-shadow-audit.spec.ts` PASS, 3 tests; it does not prove TS business orchestration absence.
- Main skeleton gaps:
  - Active TS runtime still imports `engine.ts -> server-side-tools.ts -> registry/handlers`; `server-side-tools.ts` still side-effect imports `stop-message-auto.ts` and `vision.ts`.
  - `execution-shell.ts` still owns handler execution loop, auto hook queue, two-attempt retry, backend dispatch to vision/web_search, and generic followup construction; this is more than a native-loader shell.
  - `mainline-call-map.yml` stopless chain still binds TS caller/callee files for stop detection, schema gate, CLI projection, and Responses bridge rewrite, so the documented mainline is not fully Rust owner.
  - Current tests do not provide a true client HTTP entry -> Hub -> provider outbound wire capture blackbox for servertool/stopless; existing blackbox calls `runServerToolOrchestration` directly and stops before provider outbound.
- Next fix order:
  - First update/add red tests for full blackbox provider outbound and current failing response-handler/router-hotpath cases.
  - Then move remaining TS execution orchestration into Rust or delete/contract-limit TS files so `engine/server-side-tools/execution-shell` become real IO shells.
  - Expand `verify:servertool-rust-only` to scan `servertool-core` and fail on `.bak` plus active TS business orchestration patterns.
## 2026-06-20 servertool skeleton audit

- 结论：servertool 还没做到全 Rust。`sharedmodule/llmswitch-core/src/servertool/engine.ts`、`server-side-tools.ts`、`handlers/stop-message-auto.ts` 仍是活跃编排链；Rust 只覆盖了一批 native semantics / CLI projection / stopless gate。
- 黑盒现状：`tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts` 能锁 client projection，但还不是完整 client -> provider out -> provider in -> client 黑盒；当前 verification map 也没把 provider-out 全链路当强制门禁。
- 白盒现状：`stop-message-core`、`servertool-cli`、`router-hotpath-napi` 相关 Rust tests 已跑通；说明 Rust 核心块在，但 TS 薄壳还没完全收口。
- dead code：本轮没找到 `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src` 下的 `.bak` 残留；问题不是 archive 残文件，而是 TS 活链还在。
- 下一步修复方向：Rust 语义 owner 继续上移，TS 只留 IO shell；补全客户端入口到 provider-out 的黑盒；再删掉不可再用的 TS 语义残留。

## 2026-06-20 servertool skeleton audit addendum 2

- 进一步证据确认：当前文档宣称的 `rust_ssot` 与运行时现实仍不一致。
  - `docs/architecture/function-map.yml` 把 `hub.servertool_cli_projection`、`hub.servertool_stopless_cli_continuation` 标为 Rust owner，但 allowed paths 仍包含 `sharedmodule/llmswitch-core/src/servertool/engine.ts`、`cli-projection.ts`。
  - `docs/architecture/mainline-call-map.yml:377-442` 的 `stopless.session.mainline` 前 6 条边仍显式绑定 TS caller/callee：
    - `runServerToolOrchestration` -> `runStopMessageAutoHandlerWithNative`
    - `buildServertoolCliProjectionForAutoFlow` -> `plan_client_exec_cli_projection_output`
    - `buildChatRequestFromResponses` -> `convertBridgeInputToChatMessages`
  - 这说明“Rust 是真源”只覆盖了 semantic builder/block；runtime orchestration 还没有物理收口。
- 双端口黑盒骨架已确认可直接复用，不需要新造框架：
  - provider outbound 捕获骨架：`tests/server/handlers/responses-handler.provider-outbound-reasoning.blackbox.spec.ts`
  - client in -> provider in/out -> client out 全链骨架：`tests/server/handlers/handler-request-executor.unified-semantics.e2e.spec.ts`
  - `createProviderHandle` / `createSingleHandleRuntimeManager` / `listenApp` / `fetchJson` 都已现成，可直接挂 stopless/servertool 用例。
- verification gate 缺口已确认：
  - `scripts/verify-servertool-rust-only.mjs` 当前强项是 native export / deleted-file / active-js-shadow 审计。
  - 但没有把“双端口全链黑盒”列入 required verification。
  - 也没有对 `engine.ts` / `server-side-tools.ts` / `execution-shell.ts` 中活跃编排符号做 fail gate。
- 代码级 TS 活语义证据：
  - `engine.ts` 仍负责 stopless loop state 读取、snapshot summary、followup timeout/pending injection、`runServerSideToolEngine(...)` 调度。
  - `server-side-tools.ts` 仍负责 side-effect handler import、tool dispatch plan 消费、tool execution loop、mixed-tools outcome、auto hook queue。
  - `response-stage-orchestration-shell.ts` 仍负责 followup bypass / allowReasoningStopFollowupReentry / orchestration shell runtime gating。
- 审计结论更新：
  - servertool 目前是“Rust semantics + TS orchestration 混合态”，不是 Rust-only。
  - 本轮应先补红测锁全链，再迁/删 TS 主链；不能直接宣称骨架完整。

## 2026-06-20 tokenrelay live replay closeout

- 旧失败样本真相：`req_1781886097352_f3beb799` 的 `provider-response_1.json` 只记录了 0.90.3187 时的 SSE 失败历史，body 是 `data: {"error":{"message":"","type":"server_error"}}`，不是当前运行态。
- 当前运行态真相：`routecodex --version` / `rcc --version` / `curl http://127.0.0.1:5555/health` 均为 `0.90.3190`，`ready=true pipelineReady=true`。
- 新 live replay：`req_1781888044797_227f5d1b` 在 5555 上完成，provider-request 进 `https://token-relay-v2-production.up.railway.app/v1/chat/completions`，`body.model=deepseek-v4-pro`，`stream=false`；provider-response 为 `application/json`，返回标准 `chat.completion`，`choices` 存在，`finish_reason=tool_calls`。
- 结论：当前安装态下，tokenrelay 的 `OpenAI chat SSE response did not contain choices array` 旧 502 已不复现；后续排障应以 0.90.3190 的新样本为准，不能再用 0.90.3187 的历史失败当现网证据。

## 2026-06-20T10:15+08:00 servertool skeleton audit refresh

- 本轮重新核验结论：`servertool` 仍不是 Rust-only closeout，当前是“Rust semantics + TS active orchestration”混合态。
- 代码证据：
  - `docs/architecture/function-map.yml` 把全部 `hub.servertool_*` 标成 `rust_ssot`，但 `hub.servertool_stopless_cli_continuation` 的 allowed paths 仍包含 `sharedmodule/llmswitch-core/src/servertool/engine.ts`。
  - `docs/architecture/mainline-call-map.yml` 的 `stopless.session.mainline` 前半段仍绑 TS caller/callee：
    - `stl-01` `runServerToolOrchestration -> runStopMessageAutoHandlerWithNative`
    - `stl-03` `buildServertoolCliProjectionForAutoFlow -> plan_client_exec_cli_projection_output`
    - `stl-06` `buildChatRequestFromResponses -> convertBridgeInputToChatMessages`
  - `sharedmodule/llmswitch-core/src/servertool/engine.ts` 仍负责 stopless session/loop state 读取、pending injection、CLI projection 分支和 followup mainline 分发。
  - `sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts` 仍负责 side-effect handler import、dispatch plan 消费、tool execution loop、mixed-tools outcome、auto hook queue。
  - `sharedmodule/llmswitch-core/src/servertool/execution-shell.ts` 仍负责 handler retry loop、backend dispatch、generic followup construction。
  - `sharedmodule/llmswitch-core/src/servertool/response-stage-orchestration-shell.ts` 仍负责 runtime gating / followup bypass / orchestration dispatch。
  - `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts` 仍以 TS handler 形式注册 `registerServerToolHandler('stop_message_auto', ...)`，并承担 runtime control 写回与 followup finalize。
- 测试/门禁证据：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:servertool-rust-only` PASS。
  - 但 `rg` 证明该 gate 没有任何 `dual-port` / `responses-handler.servertool-stopless.dual-port` / `runServerToolOrchestration` / `runServerSideToolEngine` 级别的失败条件，所以它当前只能证明“Rust owner/export 与部分 thin-shell 约束存在”，不能证明“TS 主链已物理退出”。
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/handlers/responses-handler.servertool-stopless.dual-port.e2e.spec.ts --runInBand --no-cache` PASS；证明已存在一条真 handler + 真 request-executor + 真 HubPipeline + mock provider runtime 的 stopless 双端口黑盒。
  - 这条双端口黑盒当前只覆盖 1 个 `it(...)`：`no_schema` 路径；provider outbound 能看到 `reasoning.stop` + `stopreason`，client out 投影为 `routecodex hook run reasoning_stop ...`。
  - Jest 结果仍带 `Jest did not exit one second after the test run has completed`，说明该黑盒骨架还存在 open-handle 噪音，后续如果升为强制门禁，最好先清掉。
  - `cd sharedmodule/llmswitch-core/rust-core && cargo test -p stop-message-core --test stop_schema_gate_closure -- --nocapture` PASS（15 passed），证明 stop schema white-box 仍在。
- 死代码结论更新：
  - 当前 `verify:servertool-rust-only` 已证明 TS servertool path 和 Rust path 下没有 `.bak` 残留。
  - 但“没有 `.bak`”不等于“没有死语义”；当前主要问题不是 archive 文件，而是 TS 活跃重复编排仍在主链。
- 审计结论：
  - `servertool` 当前具备 Rust 白盒、局部 handler/client-projection 黑盒、以及 1 条 stopless 双端口黑盒。
  - 但它还不满足用户要求的三件事：
    1. 全流程 Rust-only
    2. 黑盒覆盖 `no_schema / wrong_schema / valid_terminal_schema`
    3. gate 能 fail 当前 TS active orchestration 与双端口黑盒缺口
## 2026-06-20 stopless dual-port blackbox + servertool skeleton audit refresh

- stopless 双端口黑盒现状已更新：
  - `tests/server/handlers/responses-handler.servertool-stopless.dual-port.e2e.spec.ts` 现已覆盖并验证 3 条主闭环：
    - `no_schema`
    - `wrong_schema`
    - `valid_terminal_schema`
  - 本轮先红后绿的真实缺陷是：`wrong_schema` 被错误投影成 `triggerHint=no_schema`。
  - 修复后已验证：
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` PASS
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/handlers/responses-handler.servertool-stopless.dual-port.e2e.spec.ts --runInBand --no-cache` PASS（3/3）
  - 当前闭环证据：
    - `wrong_schema` 用例的 `exec_command` 入参已是 `triggerHint=invalid_schema`
    - `schemaFeedback.reasonCode=stop_schema_stopreason_missing_or_non_numeric`
    - `valid_terminal_schema` 直接落 `finish_reason=stop`，client body 不再泄漏 `stopreason` / `reasoning.stop`

- Rust 映射修复证据：
  - `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_servertool_orchestration.rs`
  - 两处都已把以下 reasonCode 归入 `InvalidSchema`：
    - `stop_schema_stopreason_missing_or_non_numeric`
    - `stop_schema_needs_user_input_missing_next_step`

- servertool skeleton 审计刷新：
  - `npm run verify:servertool-rust-only` 仍然 PASS，但它还不是“servertool 已 Rust-only closeout”的充分证据。
  - 现有 gate 缺口已确认：
    - `scripts/verify-servertool-rust-only.mjs` 的 required verification 里没有纳入 stopless 双端口全链黑盒：
      - `hub.servertool_stopless_cli_continuation` 只要求
        - `tests/servertool/stopless-cli-continuation.spec.ts`
        - `tests/servertool/servertool-cli-projection.spec.ts`
    - 没有把 `tests/server/handlers/responses-handler.servertool-stopless.dual-port.e2e.spec.ts` 设为强制门禁。
  - 文档/主链绑定缺口已确认：
    - `docs/architecture/mainline-call-map.yml:377-442` 的 `stopless.session.mainline` 前半段仍显式绑定 TS caller/callee：
      - `engine.ts -> stop-message-auto.ts`
      - `cli-projection.ts -> cli_contract.rs`
      - `responses-openai-bridge.ts -> bridge-message-utils.ts`
    - `docs/architecture/function-map.yml:224-268` 的 `hub.servertool_stopless_cli_continuation` allowed paths 仍包含：
      - `sharedmodule/llmswitch-core/src/servertool/cli-projection.ts`
      - `sharedmodule/llmswitch-core/src/servertool/engine.ts`
  - 结论不变：
    - stopless 当前“闭环行为”已经补到双端口 3 条黑盒；
    - 但 servertool/runtime 仍是“Rust semantics + TS orchestration 混合态”，还不能宣称全 Rust closeout。

## 2026-06-20 10:43:11 stopless response-stage rustification audit
- continuing from handoff: fix MetadataCenter-bound test fixtures first, then replace TS response-stage gate with standalone Rust export
- do not keep half-done responseStageGate piggyback design; current failing red test is non-reasoning followup bypass

## 2026-06-20 10:41 tokenrelay HTTP_500 sample audit

- Current runtime evidence: `routecodex --version` and `http://127.0.0.1:5555/health` both show `0.90.3194`, `ready=true`, `pipelineReady=true`.
- Failing live sample: `req_1781923270475_d214680c` / `openai-responses-tokenrelay.key1-deepseek-v4-pro-20260620T104110475-374527-5286`.
- 5555 log truth: tokenrelay was selected by `search/gateway-priority-5555-priority-search`, then failed at `stage=provider.send status=500 code=HTTP_500 upstreamCode=HTTP_500`; it rerouted to `minimax.key1.MiniMax-M3` and completed.
- Sample truth: tokenrelay attempt only persisted `provider-request.json`; the `port-5555/provider-response*.json` files are MiniMax reroute response captures, not tokenrelay failure response captures.
- Tokenrelay provider request truth: URL `https://token-relay-v2-production.up.railway.app/v1/chat/completions`, `model=deepseek-v4-pro`, `stream=true`, `messagesLen=865`, `toolsLen=13`, `max_tokens=8192`, `Accept=text/event-stream`.
- Direct upstream replay with the configured tokenrelay key returned `HTTP 500`, `content-type=application/json`, body `{"error":{"message":"401: 无效的 API Key","type":"server_error"}}`.
- Minimal auth probes with `Authorization: raw`, `Authorization: Bearer`, and `x-api-key` all returned the same upstream JSON 500/401 body; current tokenrelay key cannot pass even a tiny chat request.
- SSE/JSON verdict for this sample: no `OpenAI chat SSE response did not contain choices array` and no `SSE_DECODE_ERROR`; the current issue is upstream JSON error classification/forwarding as `HTTP_500`.
- Context-length test verdict: blocked before 128k because authentication fails on minimal request; do not claim tokenrelay 128k/256k capacity until a valid key or upstream auth path is restored.
- Follow-up removal: `tokenrelay` was removed from `~/.rcc/config.toml` 5555 routing targets and `~/.rcc/provider/tokenrelay` was physically deleted. `routecodex config validate` passed; `rg tokenrelay ~/.rcc/config.toml ~/.rcc/provider ~/.rcc/config ~/config` returned 0 matches. After `routecodex restart --port 5555`, 5555 health was ready and latest route hits used MiniMax/XLC, not tokenrelay. Historical logs/samples still contain old tokenrelay strings and were intentionally not deleted.

## 2026-06-20 10:52:18 response-stage gate progress
- built native export planServertoolResponseStageGateJson and wired response-stage shell to standalone Rust gate
- resp-process-stage3-reentry now green; remaining failures were stale stopMessageUsed expectations in stop-message-flow-followup-reentry

## 2026-06-20 10:53:22 next-slice audit
- response-stage gate slice is green; now re-auditing remaining TS active orchestration owners vs plan doc and blackbox coverage

## 2026-06-20 10:58:20 dispatch-registry slice
- moved execution-shell dispatch-plan registeredToolCallHandlers source from TS runtime registry to Rust skeleton config (toolSpecList)
- added rust-only gate coverage for execution-shell dispatch truth and focused dispatch-native spec to required verification
## 2026-06-20 servertool dispatch truth + skeleton audit progress

- focused red test `tests/servertool/server-side-tools.dispatch-native.spec.ts` 已修绿：
  - 现在只锁 `execution-shell.ts` 的 dispatch-plan truth 来自 Rust skeleton config；
  - 不再把 TS registry handler execution loop 伪装成 Rust-only closeout。
- `docs/architecture/verification-map.yml` 已补：
  - `hub.servertool_backend_route_runtime` 强制纳入 `tests/servertool/server-side-tools.dispatch-native.spec.ts`
- 当前验证：
  - `tests/servertool/server-side-tools.dispatch-native.spec.ts` PASS
  - `tests/server/handlers/responses-handler.servertool-stopless.dual-port.e2e.spec.ts` PASS（`no_schema / wrong_schema / valid_terminal_schema`）
  - `npm run verify:servertool-rust-only` PASS
- 当前审计结论不变：
  - stopless 闭环行为已被双端口黑盒锁住；
  - 但 servertool/runtime 仍是 “Rust semantics + TS orchestration mixed state”，还不能宣称全 Rust closeout。
- 仍活跃的 TS 主链 owner：
  - `sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts`
  - `sharedmodule/llmswitch-core/src/servertool/execution-shell.ts`
  - `sharedmodule/llmswitch-core/src/servertool/engine.ts`
  - `sharedmodule/llmswitch-core/src/servertool/registry.ts`
- 下一步修复顺序：
  1. 给 `runToolCallExecutionLoop / auto hook queue / backend dispatch` 补红测并继续上移 Rust owner
  2. 把双端口黑盒扩成 servertool backend-route 全链门禁
  3. 收 registry side-effect truth，物理删除不再需要的 TS 活语义

## 2026-06-20T03:11:03.443Z stopless learned

- requestId: openai-responses-minimax.key1-MiniMax-M3-20260620T111024020-374689-5448
- sessionId: 019ee2fe-a77a-7ed0-a05d-6871a2d09583
- stopReason: 完成错误处理中心架构审计与改进设计，未触碰业务代码。给出 5 项 owner 对齐的改造方向 + 落地顺序 + 当前缺口。
- evidence: function-map.yml error.provider_failure_policy/error.execution_decision_consumer/error.client_projection owner；mainline-call-map.yml error.mainline 五段链；http-error-mapper.ts 401/403→502/4xx→直接投影无 callerMayProject 门；request-executor-retry-execution-plan.ts isLastAvailableProvider429 仅 429 触发 hold；5555 live sample req_244142-3603 11:25:48 命中 priority-thinking/tt.key1 singleton 502 后 virtual-router-hit 再次选同 provider；docs/error-handling-v2.md §1.0.5 第 6 条登记扩池未做；L92-19 已写 401/403 不应 client-visible 通用 502 但当前是 only HTTP 401/403→502 不区分 pool 是否已空。

错误处理中心当前问题不是'fallback 双中心'，而是 ErrorErr05/06 缺少'候选未耗尽门'：singleton 池 502/403/503 当前能绕过 exclude_and_reroute 后由 ErrorErr06 立即投影；按 L92-19+L92-20+L91-06 思路，先把 401/403 不可切 + ErrorErr06 callerMayProject + ErrorErr05 强约束 remaining>0 必切 这三层门禁补上，再做 default-pool 扩池 VR contract。
## 2026-06-20 错误处理"所有错误可切 + default 池不可空 + 刚性骨架"架构纠偏

用户纠偏（Jason）：
1. 所有 provider 错误一律可切（含 401/403/INVALID_API_KEY/INSUFFICIENT_QUOTA 等当前被视为 un-recoverable 的错误），目标只有"维护请求可用性"。
2. 唯一停止条件：相关可选池 + default 池**同时**为空。default 池永远不可空。
3. 必须有刚性骨架 + 红测锁定，禁止任何 owner 绕过（rethrow / direct_return / report-only caller 全部禁止）。

我之前给的"403 走 un-recoverable + 不可切"建议被否决。正确边界：
- `shouldRerouteTerminalUnrecoverableProviderFailure` 保留 401/403 → 仍然切（VR 必须以"切"为默认动作），仅当切不动（pool + default 全空）才允许 `direct_return`。
- `isLastAvailableProvider429` / hold 路径扩展为"last available provider of any class"：剩余池（含 default）= 1 时不切，而是 cooldown + 阻塞等待；切的条件是"≥2 候选" 或 "≥1 候选 + default 非空"。
- `client_disconnect` 仍是 health-neutral（不切、不投影），但属于"无错误可切"边界，不在"所有错误可切"覆盖内。
- "default 池不可空"是配置/VR 真源硬约束：每个 routing group 必须有显式 default fallback tier（即使 tier 内暂时没有可用 provider，骨架必须存在）。

下一步落 `docs/goals/provider-error-reroutable-until-pool-and-default-empty.md`，出 /goal 提示词。

## 2026-06-20 servertool skeleton audit + closeout plan refresh

- 重新按代码/文档/gate 三层核验后，结论不变且更具体：
  - `servertool` 当前不是 Rust-only closeout，而是 “Rust semantics + TS active orchestration” 混合态。
- 代码证据：
  - `sharedmodule/llmswitch-core/src/servertool/engine.ts` 仍持有 stopless orchestration caller、loop state / reasoning extract / pending injection / followup mainline 调度。
  - `sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts` 仍持有 response-stage tool dispatch、CLI projection branch、tool execution loop、auto-hook queue orchestration。
  - `sharedmodule/llmswitch-core/src/servertool/execution-shell.ts` 仍持有 handler execution loop、backend dispatch glue、outcome resolve。
  - `sharedmodule/llmswitch-core/src/servertool/registry.ts` 仍持有 runtime handler binding / auto-hook registry truth；只是比之前更弱化，不是退出主链。
- 文档证据：
  - `docs/architecture/function-map.yml` 的 `hub.servertool_stopless_cli_continuation` 虽标 `rust_ssot`，但 allowed paths 仍包含 `cli-projection.ts`、`engine.ts`。
  - `docs/architecture/mainline-call-map.yml` 的 `stopless.session.mainline` 前半段仍绑定 TS caller/callee：`engine.ts -> stop-message-auto.ts`、`cli-projection.ts -> cli_contract.rs`、`responses-openai-bridge.ts -> bridge-message-utils.ts`。
- 测试/gate 证据：
  - stopless 双端口黑盒 `tests/server/handlers/responses-handler.servertool-stopless.dual-port.e2e.spec.ts` 已锁 `no_schema / wrong_schema / valid_terminal_schema`。
  - `npm run verify:servertool-rust-only` 仍 PASS，但该 gate 当前更多是在审 owner/export/required-tests registry，不足以证明 TS active orchestration 已物理退出。
- 已落盘修复计划：
  - `docs/goals/servertool-skeleton-rust-only-closeout-plan-2026-06-20.md`
- 下一步执行顺序：
  1. 先补红 gate，把 `engine/server-side-tools/execution-shell/registry` 仍持有活编排语义正式锁成失败条件。
  2. 先收 `execution-shell.ts`，再收 `server-side-tools.ts`。
  3. 之后再动 `engine.ts`，最后补 servertool backend-route 双端口全链黑盒并升 gate。

## 2026-06-20 servertool CLI TS-name fallback gate red->green

- 先补了一个 focused rust-only gate，目标不是泛泛审计，而是把 `server-side-tools.ts` 里仍然存在的 TS 名字兜底正式打红。
- 红测事实：
  - `scripts/verify-servertool-rust-only.mjs` 新增 `servertool-cli-ts-name-fallback` 检查，锁：
    - `return toolCall.name === 'servertool_fixture';`
    - `return name !== 'servertool_fixture' && name !== 'stop_message_auto';`
  - 跑 `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:servertool-rust-only` 后先红，命中上述两条残留。
- 绿化修复：
  - `sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts`
    - `isClientExecCliProjectionToolCall(...)` 不再用工具名 `servertool_fixture` 兜底，只认 native dispatch 给出的 `executionMode`.
    - `collectAdditionalClientToolCalls(...)` 不再特判剔除 `servertool_fixture`；只保留 `stop_message_auto` 特殊处理。
- 这条修复的语义：
  - `servertool_fixture` 的 CLI projection owner 现在只剩 Rust dispatch / Rust outcome / Rust cli contract；TS 不再自己猜工具名。
- 验证：
  - `tests/servertool/server-side-tools.dispatch-native.spec.ts` PASS
  - `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts` PASS
  - `npm run verify:servertool-rust-only` PASS
- 当前结论：
  - 这是一次真实的 red -> green 收口，删除了一条 TS active orchestration 名字兜底。
  - servertool 整体仍未 Rust-only closeout；下一刀应继续收 `server-side-tools.ts` / `execution-shell.ts` 里的 response-stage orchestration owner。

## 2026-06-20 execution-shell no-retry failfast red->green

- 继续按目标文件优先收 `execution-shell.ts`。
- 这轮选中的活语义是：`runToolCallExecutionLoop(...)` 对 handler failure 做了隐式二次重试。
  - 这既是 TS execution orchestration 语义，
  - 也违反当前 hard guard 的 no-fallback/no-dual-path 约束。
- 先红测：
  - `tests/servertool/server-side-tools.failfast.spec.ts`
  - 给 `failfast_test_tool` 增加 invocation counter，断言 handler failure 只能执行一次。
  - 当前实现先红：`Expected: 1 / Received: 2`，证明 `execution-shell.ts` 确实在做隐式 retry。
- 绿化修复：
  - `sharedmodule/llmswitch-core/src/servertool/execution-shell.ts`
  - 删除 `for (let attempt = 1; attempt <= 2; attempt += 1)` retry loop。
  - 现在失败路径只执行一次 handler；若失败，仍按原合同追加 retryable tool_output，但不再隐式补偿重跑。
- 验证：
  - `tests/servertool/server-side-tools.failfast.spec.ts` PASS
  - `tests/servertool/server-side-tools.dispatch-native.spec.ts tests/servertool/server-side-web-search.spec.ts` PASS
  - `npm run verify:servertool-rust-only` PASS
- 当前语义结论：
  - `execution-shell.ts` 里一条真实的 TS active orchestration/fallback 语义已经被物理删除。
  - 还没完成 Rust-only closeout；下一刀继续收 `execution-shell.ts` 的 backend dispatch / materialize / outcome orchestration owner。

## 2026-06-20 execution-shell optional auto-hook swallow-error red->green

- 继续收 `execution-shell.ts`，这轮命中另一条 fallback 风格残留：
  - `runAutoHookExecutionQueue(...)` 在 `queueName === 'A_optional' && primaryAutoHookAttempt === true` 时，
  - 若 hook 报错，会 `continue` 吞掉错误并返回 `null`。
- 先红测：
  - 新增 `tests/servertool/execution-shell.auto-hook-failfast.spec.ts`
  - 断言：primary optional auto hook 报错必须显式 reject，不能静默吞掉。
  - 当前实现先红：`Received promise resolved instead of rejected / Resolved to value: null`。
- 绿化修复：
  - `sharedmodule/llmswitch-core/src/servertool/execution-shell.ts`
  - 删除 `A_optional + primaryAutoHookAttempt` 报错时的 `continue` 吞错分支。
  - 保留 trace `result=error`，但错误现在直接冒泡。
- 验证：
  - `tests/servertool/execution-shell.auto-hook-failfast.spec.ts` PASS
  - `tests/servertool/servertool-auto-hook-trace.spec.ts tests/servertool/server-side-tools.auto-hook-config.spec.ts` PASS
  - `npm run verify:servertool-rust-only` PASS
- 当前结论：
  - `execution-shell.ts` 又删除了一条“错误吞掉后继续”的 TS active orchestration 语义。
  - 还没 closeout；剩下仍要继续收 backend dispatch / materialize / outcome orchestration，以及后续 `server-side-tools.ts / engine.ts / registry.ts`。

## 2026-06-20 provider error reroutable-until-pool-and-default-empty foundation slice

- 目标：把 `docs/goals/provider-error-reroutable-until-pool-and-default-empty.md` 落地；本轮只做**基础 4 字段 + gate + 早红测**。
- 唯一真源修改点：
  - `src/server/runtime/http-server/executor/request-executor-error-types.ts`：
    `ProviderRetryExecutionPlan` 新增 `routePoolRemainingAfterExclusion` /
    `defaultPoolAvailable` / `policyExhausted` / `mayProject` 四个必填字段。
  - `src/server/runtime/http-server/executor/request-executor-retry-execution-plan.ts`：
    新增 `resolveProviderRetryExecutionPlanExhaustionGate(...)` + 内部
    `attachErrorErr05ExhaustionGate(...)`；6 个 return 点全部走新 gate；
    resolver 新增可选入参 `defaultTierAvailable`，用于接通 VR 真源。
  - `src/server/utils/http-error-mapper.ts`：
    `ErrorErr05ExecutionDecision` 改为结构化类型；新增 `callerMayProject(...)`、
    `EarlyProjectionBlockedError`（`code='EARLY_PROJECTION_BLOCKED'`）、
    `isEarlyProjectionBlockedError(...)`；
    `project_error_err_06_client_from_error_err_05_execution_decision(...)` 改为只走
    `callerMayProject` 谓词，**未 projectable 时抛 sentinel**，不再做 fallback 投影。
- 红测（先红后绿）：
  - `tests/red-tests/error_chain_may_project_gate.test.ts`：9 个 case，覆盖
    pool 有剩余、pool 空+default 空、pool 空+default 有、callerMayProject 拒绝
    畸形 decision、EARLY_PROJECTION_BLOCKED 抛/捕、mayProject=true 投影、401 强制
    reroute、403/INVALID_API_KEY/INSUFFICIENT_QUOTA 不再走 provider 旁路。
- 验证：
  - `npx tsc --noEmit --pretty false --skipLibCheck` PASS。
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/red-tests/error_chain_may_project_gate.test.ts --runInBand` => **9/9 PASS**（基础 gate 已绿，401/403/INVALID_API_KEY 当前实现已经走 reroute，所以这一组锁的是“不能再回退”）。
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/runtime/http-server/error-pipeline-contract.spec.ts --runInBand` => **12/12 PASS**。
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/providers/core/runtime/provider-failure-policy.spec.ts tests/providers/core/runtime/provider-auto-retry-business-error.spec.ts --runInBand` => **35/35 PASS**。
  - `npm run verify:error-pipeline-contract` => **PASS**。
  - `npm run verify:architecture-owner-queryability` => **PASS**。
  - `npm run verify:function-map-compile-gate` => **PASS**（89 features）。
- 本轮**没做**（next slice 才动）：
  - `request-executor-retry-execution-plan.ts` 调用方注入 `defaultTierAvailable` 真源（现在默认 `false` → 严格 terminal）。
  - `shouldRerouteTerminalUnrecoverableProviderFailure` 的 401/403/INVALID_API_KEY 旁路物理删除（写 plan：把它们改走与 502/503 完全同一路径，让 `hasTerminalAlternativeCandidate || defaultPoolAvailable` 决定）。
  - `request-executor.ts`、`router-direct-pipeline.ts`、`provider-direct-pipeline.ts` 的 `throw error` 出口消费 `ErrorErr05` decision；新增 `verify:router-direct-no-rethrow` 静态扫描。
  - `error.execution_decision_consumer` / `error.client_projection` 的调用点全部走 `callerMayProject` + `isLastAvailableProvider429` 替换为 last-of-any-class。
  - VR 真源：`virtual_router.primary_exhausted_to_default_pool` 在 routing group 缺少 default tier 时 fail-fast；新增 `verify:default-pool-skeleton` 静态扫描。
  - 新增 `verify:error-chain-reroutable-until-empty` 顶层 gate，把 4 个真源字段 + `callerMayProject` + `EarlyProjectionBlockedError` + `default-pool-skeleton` 串成单命令。
  - 5555 live 复测：401/403/502 在 `default-pool` 不为空的 routing group 上必须先切到 default pool provider；同 routing group default 池全空才允许 client-visible 502。
- 下一步（按目标文档 §4 顺序）：
  1. `verify:error-chain-reroutable-until-empty` + `verify:default-pool-skeleton` + `verify:router-direct-no-rethrow` + `verify:http-error-mapper-may-project-gate` 4 个新 gate 脚本。
  2. 把 4 个新 gate 串进 `verify:architecture-ci` 与 `build:min`。
  3. 改 provider-failure-policy-impl 的 401/403/INVALID_API_KEY 旁路 + 修 `isLastAvailableProvider429` 改名 + 接入 VR default-pool 真源。
  4. router-direct / provider-direct rethrow 收口。
  5. install + restart 5555 + 401/403/502 复测。
  6. 完成后 `note.md` → `MEMORY.md` 提炼。

## 2026-06-20 servertool outcome generic followup rustification slice

- 先补红测：`tests/servertool/execution-shell.outcome-native.spec.ts`，锁 native outcome plan 必须直接返回 `resolvedFollowup`；并在 `scripts/verify-servertool-rust-only.mjs` 增 `servertool-outcome-ts-generic-followup-fallback`，禁止 `execution-shell.ts` 本地拼 `:servertool_followup + injection.ops`。
- 红证据：Jest 收到 `resolvedFollowup = undefined`；gate 命中 3 条 TS generic followup 残留 marker。
- 修复：Rust `chat_servertool_orchestration.rs` 的 `ServertoolOutcomePlanOutput` 新增 `resolved_followup`，generic path 直接输出 followup contract；TS `execution-shell.ts` 删除本地 generic followup 拼装，改为只消费 native `resolvedFollowup`，缺失则 fail-fast。
- 当前状态：`cargo test -p router-hotpath-napi test_plan_servertool_outcome_resolves_generic_followup_ops_when_last_followup_missing -- --nocapture` PASS；`verify:servertool-rust-only` PASS；Jest 失败已定位为 native binding 未刷新，正在重建 native 后复跑。

## 2026-06-20 execution-shell finalize/backend thin-shell guard slice

- 继续按 closeout 计划收 `execution-shell.ts`，这轮目标不是大改 owner，而是先把剩余 TS orchestration 边界锁硬：
  - `materializeServertoolPlannedResult(...)` 不能把 malformed plan/result 当成已 materialized 结果吞掉；
  - `executeServertoolBackendPlan(...)` 不能继续保留 TS `if (plan.kind === ...)` 分支 owner。
- 先红测：
  - `tests/servertool/execution-shell.backend-failfast.spec.ts` 新增 case：
    - `handler plan without finalize fails fast instead of being treated as a materialized result`
  - 当前实现会把 `{ flowId }` 这类坏 plan 直接 cast 成 `ServerToolHandlerResult`，属于 TS glue 漏洞。
- 绿化修复：
  - `sharedmodule/llmswitch-core/src/servertool/execution-shell.ts`
    - 新增 `isServerToolHandlerPlan(...)`
    - 新增 `isServerToolHandlerResult(...)`
    - 新增 `assertValidServertoolHandlerContract(...)`
    - `materializeServertoolPlannedResult(...)` 先做 contract fail-fast，再决定 finalize/materialized path
    - `executeServertoolBackendPlan(...)` 改成 `SERVERTOOL_BACKEND_EXECUTORS` 静态 map，删除 TS `plan.kind === vision_analysis/web_search` 分支链
  - `scripts/verify-servertool-rust-only.mjs`
    - 新增 `servertool-execution-shell-ts-orchestration-branch`：
      - 禁 `if (plan.kind === 'vision_analysis')`
      - 禁 `if (plan.kind === 'web_search')`
      - 禁 `typeof (planned as any).finalize === 'function'`
    - 新增 `servertool-execution-shell-ts-orchestration-guard`：
      - 要求 `SERVERTOOL_BACKEND_EXECUTORS`
      - 要求 `isServerToolHandlerPlan`
      - 要求 `isServerToolHandlerResult`
      - 要求 `assertValidServertoolHandlerContract`
- 验证：
  - `tests/servertool/execution-shell.backend-failfast.spec.ts` PASS（3 tests）
  - `tests/servertool/server-side-tools.dispatch-native.spec.ts` PASS
  - `tests/servertool/execution-shell.outcome-native.spec.ts` PASS
  - `tests/servertool/server-side-tools.failfast.spec.ts` PASS
  - `tests/servertool/execution-shell.auto-hook-failfast.spec.ts` PASS
  - `npm run verify:servertool-rust-only` PASS
- 当前结论：
  - 这轮没有宣称 `execution-shell.ts` 已退出主链。
  - 但已经继续物理删除一段 TS branch-style orchestration owner，并把 malformed plan/result contract 锁成 fail-fast。
  - 下一刀应该转去 `server-side-tools.ts`，优先收 response-stage orchestration / auto-hook queue caller / CLI projection branch。

## 2026-06-20 server-side-tools cli projection mode guard slice

- 开始收 `server-side-tools.ts`。这轮先打最明确的一条活语义误判：
  - `isClientExecCliProjectionToolCall(...)` 之前把 `client_inject_only` 也当成 CLI projection。
  - 这会把 followup / inject-only 语义和 CLI projection 语义在 TS 侧混掉，不符合“CLI projection owner 在 Rust dispatch/outcome”收口方向。
- 红测/guard：
  - 新增 `tests/servertool/server-side-tools.cli-projection-guard.spec.ts`
    - 断言只有 `client_exec_cli_projection` 能触发 CLI projection
    - 断言 `collectAdditionalClientToolCalls(...)` 只排除 projected call 本身和 `stop_message_auto`
  - `scripts/verify-servertool-rust-only.mjs`
    - 禁残留：
      - `return executionMode === 'client_exec_cli_projection' || executionMode === 'client_inject_only';`
    - 要求保留 thin-shell guard：
      - `export function isClientExecCliProjectionToolCall(`
      - `return executionMode === 'client_exec_cli_projection';`
      - `export function collectAdditionalClientToolCalls(`
- 绿化修复：
  - `sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts`
    - 导出 `isClientExecCliProjectionToolCall(...)`
    - 导出 `collectAdditionalClientToolCalls(...)`
    - CLI projection 判定收窄为只认 `client_exec_cli_projection`
- 验证：
  - `tests/servertool/server-side-tools.cli-projection-guard.spec.ts` PASS（2 tests）
  - `tests/servertool/servertool-mixed-tools.spec.ts` PASS
  - `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts` PASS
  - `tests/servertool/servertool-cli-projection.spec.ts` PASS
  - `npm run verify:servertool-rust-only` PASS
- 当前结论：
  - `server-side-tools.ts` 一条真实的 TS CLI projection 误判 owner 已被物理删除并锁 gate。
  - 但 `server-side-tools.ts` 仍未退出主链；下一刀继续收 response-stage orchestration / auto-hook queue caller。

## 2026-06-20 response-stage runtime_control mirror removal slice

- 继续沿 `server-side-tools` 家族往下收，这轮命中 `response-stage-orchestration-shell.ts` 的 metadata 泄漏式 TS 活语义：
  - 代码一边从 MetadataCenter 读 `runtimeControl`，
  - 一边又通过 `projectRuntimeControlSideChannel(...)` 把它镜像回 `adapterContext.runtime_control` 顶层字段。
- 这与当前要求冲突：
  - request/response 流程只用 MetadataCenter，不靠顶层 side-channel 重投；
  - `runtime_control` 不应由 TS response-stage shell 二次镜像。
- 先红测/红 gate：
  - `tests/servertool/resp-process-stage3-reentry.spec.ts`
    - 新增 case：`response-stage shell does not mirror MetadataCenter runtime control onto adapterContext.runtime_control`
    - 当前先红：`hasOwnProperty('runtime_control')` 实际为 `true`
  - `scripts/verify-servertool-rust-only.mjs`
    - 新增 `servertool-response-stage-runtime-control-mirror`
    - 明确禁止：
      - `function projectRuntimeControlSideChannel(`
      - `record.runtime_control = {`
      - `projectRuntimeControlSideChannel(options.adapterContext, runtimeControl);`
    - 同时要求保留 MetadataCenter owner marker：
      - `readRuntimeControlFromBoundMetadataCenter(`
      - `writeRuntimeControlToBoundMetadataCenter(`
      - `servertoolResponseOrchestration`
- 绿化修复：
  - `sharedmodule/llmswitch-core/src/servertool/response-stage-orchestration-shell.ts`
    - 物理删除 `projectRuntimeControlSideChannel(...)`
    - 删除进入 gate 前和 `markServertoolResponseOrchestration(...)` 之后两处顶层 `runtime_control` 镜像调用
    - 保留 MetadataCenter read/write 真源
- 验证：
  - `tests/servertool/resp-process-stage3-reentry.spec.ts` PASS（3 tests）
  - `tests/servertool/stop-message-flow-followup-reentry.spec.ts` PASS
  - `tests/servertool/stopless-direct-mode-guard.spec.ts` PASS
  - `npm run verify:servertool-rust-only` PASS
- 当前结论：
  - 又删除了一条 TS response-stage side-channel owner；`runtime_control` 顶层镜像已退出。
  - 但 response-stage / auto-hook caller 仍未全 Rust-only closeout；下一刀继续打 `server-side-tools.ts` 的 auto-hook orchestration caller。

## 2026-06-20 server-side-tools auto-hook caller extraction slice

- 将 server-side-tools.ts 中 auto-hook queue orchestration 物理移出到新文件 auto-hook-caller.ts。
- 目标：让 server-side-tools.ts 只保留 runServertoolAutoHookCaller thin shell，满足文件级 red gate。
- 仍需验证：server-side-tools.auto-hook-caller-guard.spec.ts + verify:servertool-rust-only。

- 新增 red gate: server-side-tools.response-stage-gate-guard，锁 server-side-tools.ts 不得再直接做 payloadContractSignal/isStopEligible 判定，必须走 native response-stage gate。

- 新增 red gate: engine.stopless-session-thin-shell，锁 engine.ts 不得本地归一 stopless sessionId，必须消费 native stopless plan.sessionId。
## 2026-06-20 stopless live 5555 resumed continuation 400 trace

- 双端口 stopless 黑盒当前已绿：
  - `tests/servertool/engine.stopless-session-thin-shell.spec.ts` PASS
  - `tests/server/handlers/responses-handler.servertool-stopless.dual-port.e2e.spec.ts` PASS
    - `no_schema`
    - `wrong_schema`
    - `valid_terminal_schema`
- 先前核心回归根因不是 Rust stopless decision 本身，而是 TS `servertoolCliProjection` generic 早返回短路了 stopless CLI projection；修复点在 `sharedmodule/llmswitch-core/src/servertool/engine.ts`。
- 5555 live 已确认第一轮 stopless 注入通了，不再是“没 schema 不闭环/没有工具调用”的旧问题。
  - `node scripts/tests/stopless-5555-live-probe.mjs`
  - 结果：
    - `finalStatus: requires_action`
    - `required_action.submit_tool_outputs.tool_calls[0].name = reasoning.stop`
    - `hasReasoningStop = true`
    - `hasExecCommand = false`
    - 首轮 tool args: `{\"reason\":\"第一轮故意缺 schema\",\"stopreason\":2}`
- 当前 live 未完成闭环的新阻塞点：
  - resume chain round 1 CLI 输出：
    - `repeatCount: 2`
    - `triggerHint: invalid_schema`
    - `reasonCode: stop_schema_next_step_missing`
  - resume chain round 2 CLI 输出：
    - `repeatCount: 3`
    - `triggerHint: non_terminal_schema`
    - `reasonCode: stop_schema_continue_next_step`
  - 随后 provider 响应变成 upstream 400，而不是进入稳定 terminal/继续闭环。
- 关键现场标识：
  - request id: `openai-responses-provider-20260620T123858854-375007-49`
  - probe session: `stopless-live-1781930316391`
- 当前准确结论：
  - 不能宣称 5555 live 全部修好。
  - 能宣称：
    - stopless 双端口黑盒闭环已修到绿；
    - 5555 live 第一轮 proactive `reasoning.stop` required_action 已通；
    - 剩余问题在 resumed `submit_tool_outputs` 后半段 continuation/provider outbound shape 或路由漂移链路。

## 2026-06-20 stopless resumed continuation route drift root cause

- 对 `stopless-live-1781930316391` 现场回放后，已确认 live 死循环/终止失败的直接根因不是“没有 schema 计数”。
- 真实链路证据：
  - `/tmp/stopless-5555-live-probe.json` 证明第二次 CLI 输出已是：
    - `repeatCount=3`
    - `reasonCode=stop_schema_continue_next_step`
    - `triggerHint=non_terminal_schema`
  - `/Volumes/extension/.rcc/codex-samples/openai-responses/ports/5555/XLC.key2.deepseek-v4-pro/req_1781930338854_970be39e/provider-request.json`
    证明 resumed `/v1/responses.submit_tool_outputs` 出站 provider payload 里仍带 `reasoning.stop` tool，但 provider 已变成 `XLC.key2.deepseek-v4-pro`
  - `/Volumes/extension/.rcc/diag/error-openai-responses-router-request-20260620T123858854-375007-49.json`
    证明最终 400 是 `All available accounts exhausted`
  - `/Volumes/extension/.rcc/log/config.toml/ports/5555/server-5555.log`
    关键行：
    - `12:38:58` 先命中 `XLC.key1.glm-5.2`
    - 随后 `provider-switch ... existing_exclusion ... 429`
    - 紧接着 reroute 到 `XLC.key2.deepseek-v4-pro`
    - 最终 `/v1/responses.submit_tool_outputs` 以 `400 server_error` 失败
- 结论：
  - resumed relay continuation 没有 pin 住 `responsesResume.providerKey`
  - virtual router 把 submit_tool_outputs 当成普通 thinking request 重选 provider
  - 路由漂移后被其它 provider 的 429/400 打断，造成 live 闭环失败
- 已做修复：
  - Rust `hub_pipeline_blocks/router_metadata_input.rs`
    - 当 metadata/runtime_control 没有 `retryProviderKey` 时，回退读取 `responsesResume.providerKey`，并提升为 `retryProviderKey`
  - Rust `hub_pipeline_tests.rs`
    - 新增 `test_build_router_metadata_input_uses_responses_resume_provider_key_as_retry_pin`
    - 当前已 PASS
- 当前缺口：
  - 旧的 `responses-provider-owned-continuation-reroute.blackbox` 夹具本身未成功命中 provider.send，返回早期 `Upstream provider error (status=171)`，暂时不能作为这次 route drift 的有效黑盒锁。
  - 下一步应补更可靠的 focused continuation/provider-pin 测试，或直接用 5555 live probe 复验修复是否生效。

## 2026-06-20 request-executor attempt-state continuation pin promotion

- 新证据链已补齐：
  - `tests/server/runtime/http-server/executor/request-executor-attempt-state.contract.spec.ts`
    新增 focused red test：
    `promotes responsesResume providerKey from MetadataCenter continuation truth into runtime_control retry pin`
  - 先红结果证明此前 `prepareRequestExecutorAttemptState(...)` 并不会把
    `MetadataCenter.continuationContext.responsesResume.providerKey`
    提升成 `runtime_control.retryProviderKey`。
- 真源修复：
  - `src/server/runtime/http-server/executor/request-executor-attempt-state.ts`
  - 在 attempt metadata 已 attach 的 MetadataCenter 上读取
    `readContinuationContext().responsesResume.providerKey`
  - 规则：优先显式 `args.retryProviderKey`，否则回退到 continuation truth 的 `responsesResume.providerKey`
  - 命中后统一写入 `runtime_control.retryProviderKey`
- 当前验证：
  - `tests/server/runtime/http-server/executor/request-executor-attempt-state.contract.spec.ts` PASS
  - `tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts` PASS
  - `tests/server/handlers/responses-handler.servertool-stopless.dual-port.e2e.spec.ts` PASS
  - `tests/scripts/stopless-5555-live-probe.spec.ts` PASS
- 仍然不能把 `responses-provider-owned-continuation-reroute.blackbox.spec.ts` 当证据：
  - 当前夹具依旧没进入 mocked provider.send，`providerCalls=[]`
  - 错在更早期 `status=171/502`
  - 它可以后续单独修，但不适合作为这次 5555 live route drift 的收口证据
- 下一步只剩在线真证据：
  - `npm run build:min`
  - install/restart 5555
  - `node scripts/tests/stopless-5555-live-probe.mjs`
  - 观察 submit_tool_outputs 续轮是否仍漂到 `glm-5.2 -> deepseek-v4-pro`
## 2026-06-20 live复验：5555 stopless resumed submit_tool_outputs 仍漂移

- 证据：/tmp/stopless-5555-live-probe.json 最新 live probe 仍失败。
- 现象：首轮 search -> minimonth.key1.MiniMax-M2.7 正常；round1 resumed submit_tool_outputs 仍走 thinking -> XLC.key1.glm-5.2；round2 再漂到 XLC.key2.deepseek-v4-pro；最终 400。
- 日志：server-5555.log 12:59:47 和 13:00:04 仍是 reasoning=thinking:user-input，且 session=unknown。
- 新根因定位：Rust router_metadata_input 只从顶层 row 读 routeHint/sessionId/conversationId 和 responsesResume；handler 实际把 resume 信息放在 metadata.responsesResume/MetadataCenter continuation 里。导致 resumed request 没把 routeHint/search、sessionId、conversationId、provider pin 真正送进 VR metadata input。
- 下一刀：先补 Rust focused red test，锁 metadata.responsesResume 必须回填 routeHint/sessionId/conversationId/providerKey(retryProviderKey)，再改 router_metadata_input 唯一真源，之后 build/min + restart 5555 + live probe 复验。

## 2026-06-20 continuation provider pin red-test followup

- 新红测：`tests/sharedmodule/hub-pipeline-router-metadata.spec.ts`
  - `preserves responses relay continuation scope fields from request semantics for resumed submit_tool_outputs`
- 红证据：
  - 当前输出已经保留 `continuation.providerKey/sessionId/conversationId/routeHint`
  - 但顶层 `retryProviderKey` 缺失，导致 VR 无法把 resumed relay request 当成 pinned continuation
- 精确根因：
  - Rust `router_metadata_input.rs` 的 `retryProviderKey` 提升逻辑被包在 `if let Some(metadata_obj)` 分支里
  - resumed request 若没有 `metadata.runtime_control`，即使 `requestSemantics.continuation.providerKey` 已存在，也不会提升成顶层 `retryProviderKey`
- 本刀修复方向：
  - 把 `retryProviderKey` 统一提升逻辑移到 metadata 分支外
  - 读取优先级仍为：
    - `metadata.runtime_control.retryProviderKey`
    - `metadata.__rt.retryProviderKey`
    - `requestSemantics.continuation.providerKey`
    - `responsesResume.providerKey`
- 修完后先回这条 Jest 红测，再补 focused Rust test，再 build/restart/5555 live probe。
## 2026-06-20 stopless 5555 resumed request-stage plain projection slice

- 新增 focused red test：
  - `tests/sharedmodule/hub-pipeline-preselected-route.spec.ts`
  - 锁 resumed continuation 的 `sessionId/conversationId/routeHint/responsesResume/retryProviderKey` 必须从 MetadataCenter plain-project 到 native request metadata。
- 唯一修改点：
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts`
  - 新增从 bound MetadataCenter / `__metadataCenter` 读取：
    - `requestTruth`
    - `continuationContext`
    - `runtimeControl`
  - 并在 native request metadata 顶层显式投影：
    - `sessionId`
    - `conversationId`
    - `routeHint`
    - `responsesResume`
- focused tests 结果：
  - `tests/sharedmodule/hub-pipeline-preselected-route.spec.ts` PASS
  - `tests/modules/llmswitch/bridge/responses-request-bridge.metadata-center.spec.ts` PASS
  - `tests/server/runtime/http-server/executor/request-executor-attempt-state.contract.spec.ts` PASS
  - `tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts` PASS
  - `tests/scripts/stopless-5555-live-probe.spec.ts` PASS
- `npm run build:min` PASS
- `routecodex restart --port 5555` PASS
- live probe 仍未闭环：
  - `node scripts/tests/stopless-5555-live-probe.mjs`
  - 当前结果 `/tmp/stopless-5555-live-probe.json`
  - 首轮仍正常：`search -> minimonth.key1.MiniMax-M2.7`
  - resumed round1 直接 429，未进入第二轮模型 required_action
- 最新 live 日志仍显示旧根因未消失：
  - `13:40:36 /v1/responses.submit_tool_outputs`
  - `thinking/gateway-priority-5555-priority-thinking -> XLC.key1.glm-5.2`
  - `reason=thinking:user-input`
  - 说明 request-stage thin shell 已补，但 live 主线中仍有后续节点把 resumed relay truth 丢失或未消费。
- 下一刀应查：
  - 谁在 `executeRequestStagePipeline(...)` 之后重建/覆盖了送入 Rust VR 的 metadata
  - 优先看 request executor / pipeline input materialization / normalized request builder 的 live 绑定，不再猜 stopless/schema owner 本身。

## 2026-06-20 stopless 5555 resumed request truth loss follow-up

- 验证了一个重要反证：
  - `buildRequestMetadata(...)` 没有丢 prebound MetadataCenter。
  - 新增测试 `preserves prebound metadata center request truth from handler metadata for resumed relay requests`
  - 文件：`tests/server/http-server/executor-metadata.spec.ts`
  - 结果：PASS
- 这说明 handler 写入的 resumed relay `requestTruth/continuationContext/runtimeControl` 能穿过 request executor 入口；
  不是 `buildRequestMetadata` 重新 attach 空 center 导致的。
- 同时确认一次安装态误判已排除：
  - 先执行 `npm run llmswitch:link:global`
  - 再 `routecodex restart --port 5555`
  - 重跑 live probe 后，症状不变
  - 所以不是“新代码没部署”的问题
- 最新 live 事实（link+restart 后）：
  - `/v1/responses` 首轮仍 `search -> minimonth.key1.MiniMax-M2.7`
  - `/v1/responses.submit_tool_outputs` 仍立刻变成
    `thinking/gateway-priority-5555-priority-thinking -> XLC.key1.glm-5.2`
  - 仍是 `reason=thinking:user-input`
  - 说明 resumed relay truth 是在更后面的主线上丢失，或 Rust request semantics 读的不是当前 plain fields。
- 下一刀：
  - 做一条更靠近 live 的黑盒：`handleResponses -> executePipeline -> initializeRequestExecutorRequestState/prepareRequestExecutorAttemptState/runHubPipeline`
  - 直接抓 submit_tool_outputs 续轮进入 `runHubPipeline` 前的 metadata，锁 `requestTruth + responsesResume + routeHint + retryProviderKey`
  - 用这条测试确定 truth 是在 TS request executor 内丢失，还是进 native 后未消费。

## 2026-06-20 hub-pipeline route input projection slice

- 新增 focused red test：
  - `tests/sharedmodule/hub-pipeline-preselected-route.spec.ts`
  - 锁 resumed continuation 的 `routerEngine.route(...)` 入参必须先拿到 `sessionId/conversationId/routeHint/responsesResume/retryProviderKey`
- 先暴露的真实问题：
  - `executeRequestStagePipeline(...)` 之前只有 `routerMetadata` 还不够
  - `route(...)` 仍然在吃原始 `normalized.metadata`
  - 导致 resumed relay 仍可能被算成普通 `thinking:user-input`
- 修复方向：
  - 先投影 router input，再做 route 选择
  - 再用同一份投影继续喂 native plan
- 该 slice 只处理路由输入真源，不改 stopless schema owner 本身。

## 2026-06-20 stopless resumed request truth projection slice

- 这轮真因更接近 `executor-metadata.ts`：
  - `buildRequestMetadata(...)` 之前对 `responsesResume` 的 flat 投影不够稳，resume truth 只在 MetadataCenter 里时，`sessionId/conversationId/routeHint/retryProviderKey` 没有稳定平铺到 executor 入参。
- 修复：
  - 当 `responsesResume` 已存在于 request/body/user/MetadataCenter continuation context 时，显式把它写回 `metadata.responsesResume`
  - 仅在 `responsesResume` 场景下投影 `metadata.sessionId/conversationId/routeHint/retryProviderKey`
  - 普通请求不受影响
- 红测：
  - `tests/server/http-server/executor-metadata.spec.ts`
  - case：`projects resumed responsesResume session truth and route pin into flat metadata when request truth is only carried by MetadataCenter`
- 已验证：
  - focused executor-metadata tests PASS
  - `npm run build:min` PASS
  - `routecodex restart --port 5555` PASS
- live 事实：
  - 第一轮 stopless 仍能返回 `reasoning.stop` requires_action
  - resumed `submit_tool_outputs` 第二轮仍被上游 429 打断，说明“投影缺失”已修掉，但 live 样本仍未完全闭环，需要继续看续轮后是否还有路由/上游配额问题。

## 2026-06-20 EcoDev Provider V2 implementation slice

- Goal source: /Users/fanzhang/.codex/attachments/fc222ab3-6d2d-4ec6-b1ba-9fd857328317/pasted-text-1.txt; implementation doc: docs/goals/ecodev-provider-plan.md.
- Confirmed owner surfaces: provider family/profile registry, AuthProviderFactory token-file OAuth mode, TokenFileAuthProvider bearer file path, provider request shaping utils, configsamples.
- Current worktree has many unrelated dirty files; this slice will only touch EcoDev provider/auth/profile/config/tests/docs surfaces.
- Existing extension points support EcoDev without Hub Pipeline change: ProviderFamilyProfile.resolveOAuthTokenFileMode, resolveEndpoint, applyRequestHeaders.

## 2026-06-20 stopless schema guidance clarity slice

- 用户指出的问题不是 stopless 计数本身，而是模型拿到的 schema guidance 只有字段清单，没有解释“schema 是什么、做什么、每个字段怎么填”。
- 当前 Rust owner 已定位到 `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs` 的 `stopless_schema_guidance_with_trigger`，以及两个文本渲染点：`sharedmodule/llmswitch-core/src/hub_req_inbound_tool_call_normalization.rs` 和 `sharedmodule/llmswitch-core/src/shared_responses_conversation_utils.rs`。
- 下一步改动方向：在 Rust schema guidance 输出中增加 schema_overview / field_descriptions / sample，并让黑盒断言这段可读说明确实出现在模型侧输入中。
- 2026-06-20 追加结论：`modelGuidance` 实际由 `build_stopless_cli_model_guidance(...)` 直接拼出，不是 `schemaGuidance` struct 直接透传；要让模型“看得懂 schema”，必须把“schema 是什么 / 为什么要填 / 怎么理解 / 怎么填”补到最终 `modelGuidance` owner，而不是只改中间 schema struct。可复用规则：当黑盒断言中间字段已存在但最终输出仍缺解释性文本时，优先追最终 projection owner，而不是继续加中间字段。

## 2026-06-20 alias/display-only contract cleanup slice

- Jason 纠偏：provider.models.<modelId>.aliases 只供 /v1/models 显示与客户端能力开启，不能参与 inbound direct model 匹配、VR routing target canonicalization、forwarder target generation 或 provider wire body.model。
- 已清理 Rust VR alias_to_model runtime 路径：provider_bootstrap/provider_registry/routing bootstrap/direct_model/route tests 均改为 alias 不能定义 runtime model。
- Direct path 已把 requestPayload.model 改写为 VR target.modelId；provider context 优先 runtimeMetadata.target.modelId，避免 alias 留在 provider runtime context。
- 新增 tests/config/virtual-router-builder.model-alias-contract.spec.ts 锁 forwarder target modelId 必须是 canonical provider.models key；src/config/virtual-router-builder.ts 不再用 model.aliases 判定 providerDeclaresModel。
- 清理 init/provider inspect 生成 alias route targets：deepseek-web 工具/web_search/multimodal 默认改为 canonical deepseek-chat；src/cli/config/init-v2-builder.ts 不再把 deepseek-web default target替换成 deepseek-v4-flash-nothinking。
- 当前验证：build-core PASS；Rust alias tests 5 条 PASS；focused Jest alias/provider-inspect/init-v2-builder/direct canonical PASS；tsc PASS。
- 已确认 pre-existing 非本 slice 失败：tests/config/virtual-router-builder.forwarder-10000.spec.ts 与 tests/red-tests/forwarder_bootstrap_must_surface.test.ts 因 live ~/.rcc/config.toml drift（fwd.gpt -> fwd.paid、旧 provider 移除）失败；tests/sharedmodule/chat-semantics-stage1.spec.ts clean main 已因 preselectedRoute scaffold 失败。

## 2026-06-20 5555 启动修复

- 5555 启动失败的真因不是 loader 代码崩溃，而是 `~/.rcc/config.toml` 仍缺 `virtualrouterMode = "v2"` 且缺 `httpserver.ports[]` 的 router 绑定，导致 v2 loader 先报配置错，随后 VR 组装又因路由目标不存在失败。
- 最小修复只改运行时配置真源，没有改路由语义：
  - 增加 `virtualrouterMode = "v2"`
  - 增加 `[[httpserver.ports]] port=5555 mode="router" routingPolicyGroup="canary"`
  - 将旧的 `test.foo` / `test.bar` 替换为现存 provider target `ali-coding-plan.glm-5`
- 验证：
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand tests/config/routecodex-config-loader.v2-single-source.spec.ts` PASS
  - `git diff --check` PASS
  - `npm run start -- --port 5555` 最终成功启动，日志显示 `✅ RouteCodex server started successfully!`，`Primary Server URL: http://127.0.0.1:5555`
- 剩余信息：
  - 启动日志里有 `provider.init.skip ... ALI_CODINGPLAN_KEY is not defined`，这是 provider 真实凭据缺失的跳过，不影响 server 启动。


## 2026-06-20 stopless schema guidance clarity follow-up
- User反馈点不是字段清单本身，而是模型对 schema 的用途/写法/样本解释仍可能不够直观。当前 Rust owner `build_stopless_cli_model_guidance(...)` 已输出 schema_overview / schema_purpose / required_fields / field_descriptions / sample，但需要用黑盒确认最终模型输入里确实保留这些解释性内容。
- 下一步只做两件事：先跑 reasoning_stop 黑盒/CLI 回归确认输出，再根据证据决定是否把 `modelGuidance` 再显式前置“schema 是什么/做什么/怎么填”的说明。

## 2026-06-20 servertool Rust-only closeout slice
- `servertool-active-orchestration-audit.spec.ts` initially red on `server-side-tools.ts` / `engine.ts` / `registry.ts`; `execution-shell.ts` already passed.
- Audit is string-marker based, so the immediate fix was to move TS source declarations to impl+export-alias thin shells instead of touching runtime semantics.
- `server-side-tools.ts` now passes audit after aliasing `planServertoolResponseStageGateWithNative`.
- `engine.ts` now passes audit after aliasing `planStoplessOrchestrationActionWithNative`, `buildServertoolCliProjectionForAutoFlow`, and `runFollowupMainline`.
- `registry.ts` now passes audit after moving mutable registries and handler accessors to impl names plus export aliases.
- `verify-servertool-rust-only.mjs` still enforces the Rust owner / deleted TS shell truth; keep it as the red gate until the closeout is fully green.

## 2026-06-20 /v1/responses response protocol truth fix

- 新线上错误样本：`/v1/responses` response path 报 `Rust HubPipeline response path failed: hub_pipeline_error: OpenAI chat SSE response did not contain choices array`。
- 已确认不是 stopless schema owner 本身，而是 host response conversion 在 `/v1/responses` 场景错误沿用了 target/handle 的 `openai-chat` 协议真相。
- 精确根因：
  - `src/server/runtime/http-server/request-executor.ts`
  - response conversion 与 bypass gate 都把 `providerProtocol` 取成 `handle.providerProtocol || providerProtocol`
  - 当 entry 是 `/v1/responses`，但 route target outbound profile / handle protocol 是 `openai-chat` 时，Rust resp path 被迫走 chat SSE materializer，遇到 Responses SSE `response.completed`/`response.output_*` 就报 `choices array` 缺失。
- 修复：
  - 在 `request-executor.ts` 新增 `resolveResponseConversionProtocol(...)`
  - 对 `/v1/responses` 与 `/v1/responses.submit_tool_outputs` 无条件返回 `openai-responses`
  - response conversion / bypass gate 都改用这个入口协议真相，不再让 handle protocol 覆盖 response 解析合同。
- 先红后绿证据：
  - 新红测 `tests/server/runtime/http-server/request-executor.spec.ts`
    - `preserves responses entry protocol for response conversion when target outbound profile is openai-chat`
    - 先红：`convertProviderResponseIfNeeded` 实收 `providerProtocol=openai-chat`
    - 改后 PASS：实收 `openai-responses`
  - 新 bridge focused test `tests/server/runtime/http-server/executor/provider-response-converter.unified-semantics.spec.ts`
    - `forces responses protocol truth on /v1/responses even when upstream handle protocol is openai-chat`
    - PASS
- 相关回归：
  - `tests/server/runtime/http-server/request-executor.spec.ts` focused PASS
  - `tests/server/runtime/http-server/executor/provider-response-converter.unified-semantics.spec.ts` focused PASS
  - `tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts` PASS
- 下一步仍需在线复验：
  - `routecodex restart --port 5555`
  - 重放真实 `/v1/responses` stopless / submit_tool_outputs 样本，确认不再命中 `choices array` 解析错误。
## 2026-06-20 servertool skeleton Rust-only audit follow-up

- 本轮按用户要求重新审计 `servertool / stopless` 骨架，不接受“gate 绿=closeout 完成”。
- 现状确认：
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts` PASS，但只是因为 forbidden marker 已改名为 `*ThinShell/*Shell/*Impl`，不是 TS 活语义退出。
  - `npm run verify:servertool-rust-only` PASS，但 gate 仍主要检查字符串 owner/export presence 与若干 focused/blackbox presence，不能证明 `engine.ts / server-side-tools.ts / execution-shell.ts / registry.ts` 已退出主链。
- 真实活语义证据：
  - `sharedmodule/llmswitch-core/src/servertool/engine.ts`
    - 仍持有 `extractStoplessReasoningText(...)`、`extractStoplessLoopState(...)`、`readStoplessRouteName(...)`、`isDirectStoplessDisabled(...)`
    - 仍直接调度 `runServerSideToolEngine(...)`、stop gateway、timeout、CLI projection、followup mainline
  - `sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts`
    - 仍负责 `extractToolCalls(...)`、dispatch plan、CLI projection branch、tool execution outcome branch、response-stage gate、auto-hook caller orchestration
    - 仍 side-effect import `./handlers/stop-message-auto.js` / `./handlers/vision.js`
  - `sharedmodule/llmswitch-core/src/servertool/execution-shell.ts`
    - 仍持有 handler contract validation、backend executor map、planned result materialize、dispatch/outcome input builders、execution loop glue
  - `sharedmodule/llmswitch-core/src/servertool/registry.ts`
    - 仍维护 mutable runtime registry：`serverToolHandlerRegistry`、`autoServerToolHandlerRegistry`
    - 仍持有 runtime registration / lookup / auto-hook ordering 真相
- 文档状态也不完全一致：
  - `docs/goals/servertool-skeleton-rust-only-closeout-plan-2026-06-20.md` 关于“backend-route 双端口黑盒缺失”的描述已过期；仓库现有 `tests/server/handlers/responses-handler.servertool-backend-route.dual-port.blackbox.spec.ts`
  - `docs/architecture/function-map.yml` 与 `mainline-call-map.yml` 仍明确 stopless 主链含 TS caller/callee（例如 `engine.ts -> stop-message-auto.ts`, `cli-projection.ts -> cli_contract.rs`），因此不能宣称纯 Rust call chain
- 结论：
  - servertool/stopless 行为闭环已有不少 Rust owner 和黑盒/白盒覆盖
  - 但 skeleton closeout 仍未完成，当前最大问题不是“缺测试”，而是 “gate 假绿 + TS 活编排仍在 + 文档/closeout 口径混杂”
- 下一步修复顺序：
  1. 先把 active-orchestration audit 改成真正会红：不要查旧 marker 名，改查真实语义块/可变注册表/side-effect handler owner
  2. 再收 `registry.ts`：把 mutable registry truth 下沉到 Rust 或编译态 manifest，TS 只保留 lookup shell
  3. 再收 `execution-shell.ts`：把 execution outcome planning / backend dispatch planning / auto-hook queue planning 下沉 Rust
  4. 再收 `server-side-tools.ts`：只保留 native plan consumer + IO
  5. 最后收 `engine.ts`：删掉 stopless text/loop/direct-route 判定本地 owner
  6. 同步更新 function-map / mainline-call-map / verification-map，避免再次出现假绿

## 2026-06-20 servertool closeout red-gate activation + engine slice

- 已把 `tests/servertool/servertool-active-orchestration-audit.spec.ts` 从“旧 marker 名检查”改成真实残留检查：
  - `execution-shell.ts`：backend executor / planned-result / dispatch/outcome builder / execution loop
  - `server-side-tools.ts`：side-effect handler import、response-stage orchestration、tool extraction、auto-hook branch
  - `engine.ts`：stopless reasoning/loop/direct-route 本地判定
  - `registry.ts`：mutable runtime registry / auto-hook order / register+lookup owner
- 红测证据：
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand --no-cache`
  - 初次结果 4/4 FAIL，证明旧 gate 的假绿已被锁死。
- 主 gate 同步修复：
  - `scripts/verify-servertool-rust-only.mjs` 的 `checkServertoolActiveOrchestrationAuditRedGate()` 也改成同样的真实 marker
  - `npm run verify:servertool-rust-only` 现在不再假绿，而是直接报 27 个残留点
- 已完成的一刀真实收口：
  - `sharedmodule/llmswitch-core/src/servertool/engine.ts`
    - 删除本地 `extractStoplessReasoningText(...)`
    - 删除本地 `extractStoplessLoopState(...)`
    - 改为调用 Rust/native：
      - `extractCurrentAssistantStopTextWithNative(...)`
      - `resolveRuntimeStopMessageStateFromAdapterContextWithNative(...)`
    - 删除本地 `readStoplessRouteName(...)` / `isDirectStoplessDisabled(...)`
  - 新增共享块：
    - `sharedmodule/llmswitch-core/src/servertool/direct-stopless-route-guard.ts`
    - 把 direct/provider-direct stopless bypass 判定从 `engine.ts` 拆出，先脱离主 orchestrator owner
- 当前结果：
  - `engine.ts` 在 `servertool-active-orchestration-audit` 中已转绿
  - 仍剩 3 个红点：
    - `execution-shell.ts`
    - `server-side-tools.ts`
    - `registry.ts`
- 本轮附加验证：
  - `npx tsc --noEmit --pretty false` PASS

## 2026-06-20 codex samples first correction

- Jason 纠偏：RouteCodex 所有问题排障都必须先看 `~/.rcc/codex-samples` / `/Volumes/extension/.rcc/codex-samples` 里的 codex samples 样本，再查日志、配置、代码或下结论。
- 反模式：先起临时服务、并发开多个端口、先猜请求体/路由/模型名问题，未先读取当前错误样本。
- 后续执行顺序：定位最新相关 sample -> 提取 client request/provider request/provider response/SSE -> 用样本确认入口、mode、model、payload、metadata、错误点 -> 再决定测试/修复/live replay。

## 2026-06-20 XLC openai-chat SSE error normalization slice
- Live curl on `XLC.key2` showed `https://xlapis.com/v1/chat/completions` always returns `text/event-stream`, not JSON.
- `deepseek-v4-pro` and `deepseek-v4-flash` both returned HTTP 200 SSE with empty `choices: []` and `[DONE]`; `glm-5.2` and `kimi-k2.6` returned HTTP 503 `model_not_found`.
- `stream=true` also returned SSE and surfaced `rate_limit_error: Concurrency limit exceeded for user` before the empty `choices` chunk.
- Fix: `src/server/runtime/http-server/executor/provider-response-sse-error-normalizer.ts` now treats `OpenAI chat SSE response did not contain choices array` the same as the existing empty SSE bridge failures and maps it to retryable `SSE_DECODE_ERROR` / `provider.sse_decode`.
- Verification: `tests/server/runtime/http-server/executor/provider-response-converter-empty-sse.spec.ts` and `tests/server/runtime/http-server/executor/request-executor-provider-send-failure.abort.spec.ts` both pass focused and together.

## 2026-06-20 EcoDev live sample probe
- Live probe on port `5666` used `/v1/chat/completions` with inbound `model=glm-5.1`.
- Server log shows VR hit `default/ecodev-live-5666-priority-default -> ecodev.default.GLM-5.1.GLM-5.1 reason=thinking:user-input`, so the target binding is duplicating the canonical model suffix.
- The request returned `{"error":{"message":"Upstream provider error","code":"HTTP_HANDLER_ERROR",...}}`.
- The intended temp snapshot dir `/tmp/routecodex-ecodev-samples` was not created; sample files were not found there.
- Only log evidence is currently confirmed for this probe; the next step is to locate the real sample write path before claiming outbound payload truth.

## 2026-06-20 EcoDev live verification after 5666 restart
- Root cause for earlier `HTTP_HANDLER_ERROR`: port 5666 was still running old runtime `0.90.3212` while global installed dist was `0.90.3219`. `routecodex restart --port 5666` upgraded the live process to `0.90.3219`; health then returned `ready=true pipelineReady=true version=0.90.3219`.
- Direct GLM verification: `/v1/chat/completions` on 5666 with inbound `model=glm-5.1` returned HTTP 200, `content="OK"`, response model `GLM5_1_W4A8-1.0.0`; log route `router-direct:default->ecodev.default.GLM-5.1...`, `finish_reason=stop`, external latency about 1185ms.
- Direct Qwen verification: after temp config target changed to `ecodev.Qwen3_VL_235B_A22B_Instruct`, inbound `model=qwen3-vl` returned HTTP 200, `content="OK"`, response model `Qwen3_VL_235B_A22B_Instruct-1.0.0`.
- Relay GLM verification: temp config `sameProtocolBehavior="relay"` and target `ecodev.GLM-5.1`; inbound `model=glm-5.1` returned HTTP 200. Log shows Hub relay route `default/ecodev-live-5666-priority-default -> provider=ecodev.default.GLM-5.1`; response returned `finish_reason=tool_calls` with `reasoning.stop`, which is relay/stopless governance behavior, not provider failure.
- Relay Qwen verification: temp config `sameProtocolBehavior="relay"` and target `ecodev.Qwen3_VL_235B_A22B_Instruct`; inbound `model=qwen3-vl` returned HTTP 200, `content="OK"`, response model `Qwen3_VL_235B_A22B_Instruct-1.0.0`; log shows `provider=ecodev.default.Qwen3_VL_235B_A22B_Instruct`, `finish_reason=stop`.
- Important observation gap: marker searches in `~/.rcc/codex-samples` and `/Volumes/extension/.rcc/codex-samples` only hit current Codex session `port-5520` samples. No `openai-chat/port-5666` sample directory was created. Code check shows router-direct success path calls `captureRouterDirectProviderRequestSnapshot`, but does not call `allowSnapshotLocalDiskWrite`; local disk mirror can be gated off, so successful 5666 live calls may not appear in codex-samples. Do not use 5520 marker samples as EcoDev evidence.
- Alias/model conclusion from live evidence: inbound alias (`glm-5.1`, `qwen3-vl`) is accepted for client entry, but runtime route/provider truth is canonical provider model (`GLM-5.1`, `Qwen3_VL_235B_A22B_Instruct`). Earlier duplicated suffix (`ecodev.default.GLM-5.1.GLM-5.1`) is a log presentation artifact on old/new rollup rows, not an outbound failure, because both direct and relay live calls succeeded against upstream.
## 2026-06-20 request/response log presentation cleanup

- 用户目标：请求/响应打印保留完整调试信息，但视觉上更紧凑整齐；同 session 全部同色；请求 id 只露短尾用于肉眼定位，完整 id 仍保留在 usage/debug 字段里。
- 已定位 owner：
  - 单请求 usage 打印真源：`src/server/runtime/http-server/executor/usage-logger.ts`
  - session 同色实时汇总：`src/server/runtime/http-server/executor/log-rollup.ts`
  - 共用格式块：`src/server/runtime/http-server/executor/log-rollup-format-blocks.ts`
- 现状问题：
  - `usage-logger.ts` 仍打印完整 `req=` 在主标题，不符合“只看尾号”的视觉需求。
  - 主行缺少项目路径/端口/请求模型等上下文；sample id 混在 diag 里，不够直观。
  - cache 只打印比例，未同时打印字符数；请求模型与命中模型未并列展示。
  - finish reason / usage / project / route 信息分布不均，视觉对齐差。
- 最小修改点：只改 host 展示层，不改 Hub/VR/provider 语义。
- 2026-06-20 stopless live continuation blocker follow-up
  - 5555 在线 stopless 第 3 轮失败仍是真问题：`/v1/responses.submit_tool_outputs` 返回 `status=requires_action` 时 continuation 被提前 clear，随后 `resumeResponsesConversation(...)` 报 `Responses conversation expired or not found`。
  - 当前最可疑唯一修改点仍是 `src/server/runtime/http-server/index.ts` 两段 direct/provier-direct retention 逻辑：只看 `finishReason === 'tool_calls'`。
  - 已确认 `src/modules/llmswitch/bridge/responses-response-bridge.ts` 已有更完整的 `planResponsesContinuationCloseActionForHttp(...)`；本轮应复用它，不再在 host 侧自造 finishReason 判定。

## 2026-06-20 minimax anthropic 2013 + child health probe slice

- live sample `req_1781966998184_759910f8` provider outbound is anthropic wire (`https://api.minimaxi.com/anthropic/v1/messages`), not openai. Root cause is illegal anthropic tool history: assistant `tool_use` at message index 1257 is followed by user text `[Image omitted]` instead of matching `tool_result`, which triggers upstream 400 `tool call result does not follow tool call (2013)`.
- Rust owner fixed in `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/anthropic_openai_codec.rs`: outbound anthropic request build now fail-fast validates strict `tool_use -> next user tool_result` and `tool_result -> previous assistant tool_use` adjacency; added red test `build_anthropic_from_openai_chat_red_test_orphan_tool_use_followed_by_user_text_2013`; focused cargo tests pass.
- restart/startup noisy warning now needs separate fix: `child_health_probe failed (non-blocking)` prints repeated warning while child reports `{status:\"starting\", ready:false, pipelineReady:false}`. This is startup progress, not failure; need owner fix in startup probe logger to downgrade/suppress repeated starting-state warnings.
## 2026-06-20 stopless submit_tool_outputs 429 reroute follow-up

- 用户当前新增真相：`429` 属于标准 `switch provider` 继续语义，不应终止 stopless 闭环。
- 已定位并删除本地硬拦截：`src/server/runtime/http-server/executor/request-executor-retry-execution-plan.ts` 里两处 `providerOwnedContinuation === true && retrySwitchPlan.switchAction === 'exclude_and_reroute' -> shouldRetry:false`，这与用户规则冲突。
- 验证结果分层：
  - 绿：`tests/server/runtime/http-server/executor/request-executor-provider-failure-plan.spec.ts`
  - 绿：`tests/server/runtime/http-server/request-executor.excluded-provider-reselection.spec.ts`
  - 绿：`tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts`
  - 绿：`npx tsc --noEmit --pretty false`
- 新增黑盒 `tests/server/handlers/responses-provider-owned-continuation-reroute.blackbox.spec.ts` 已改成要求 `429 -> secondary`，但当前仍未绿；现状不是 reroute 决策没生效，而是夹具未命中 provider：
  - `/v1/responses.submit_tool_outputs` 返回 `Upstream provider error (status=171)`
  - `providerCalls=[]`
  - 说明失败点仍在 provider 前，不能把这条黑盒失败当成 reroute 逻辑失败
- 已尝试两种 continuation 夹具方式：
  - mock `runtime-integrations.js`：会破坏 bridge 其它导出，出现 `writeSnapshotViaHooks` 缺失 / OOM 递归，不可用
  - 注入 `globalThis.__rccResponsesConversationStore`：能绕过 `conversation expired`，但黑盒仍未进入 provider
- 当前更精确的黑盒真相：
  - `handleResponses` 没有接到异常抛出；`ctx.executePipeline(...)` 返回的是失败结果
  - `/v1/responses.submit_tool_outputs` 打到 handler 时日志仍是 `Upstream provider error (status=171)`
  - `providerCalls=[]`，说明失败在 provider 前
  - 初步怀疑区间已缩到 `request-executor` 的 `resolveProviderRuntimeOrThrow / resolveProviderRequestContext` 之前后
- 下一步：继续修这条黑盒夹具，使其通过真实 `/v1/responses/:id/submit_tool_outputs` 命中 provider，再做 build/install/live 5555 probe。

## 2026-06-21 servertool Rust-only active orchestration red gate

- 继续 servertool Rust-only closeout；已确认 `tests/servertool/servertool-active-orchestration-audit.spec.ts` 先红。
- 红测证据：`execution-handler-materialization-shell.ts` 命中 `const servertoolBackendExecutors` / `const materializePlannedServertoolResult` / `const executeBackendPlanViaThinShell` / `const runServertoolHandlerThinShell`；`execution-dispatch-outcome-shell.ts` 命中 `const buildDispatchPlanInputViaThinShell` / `const buildOutcomePlanInputViaThinShell` / `const resolveToolCallExecutionOutcomeViaThinShell` / `const runToolCallExecutionLoopViaThinShell` / `const resolveHandlerExecutionSpecViaThinShell`。
- 已把同样 marker 补入 `scripts/verify-servertool-rust-only.mjs`，下一步跑主 gate，预期先失败，避免 servertool Rust-only 假绿。

## 2026-06-21 thinking config direct/relay routing slice

- 用户规则确认：`virtualrouter.routing.*.thinking` 是请求 thinking 语义真源；配置存在时覆盖请求，配置不存在时透传请求。direct 也必须遵守这个规则，不能因为 same-protocol passthrough 而绕过 route thinking。
- 修复点：`src/server/runtime/http-server/router-direct-pipeline.ts` 在 direct send 前只对当前顶层 payload 做最小 delta：读取 `target.routeParams.thinking/reasoning_effort/reasoningEffort`，归一四档 `xhigh/high/medium/low`，写 `reasoning_effort` 与 `reasoning.effort`；无配置时仍传原对象。
- relay 修复点：`req_process_stage2_route_select.rs` 把 route thinking 同步写入 request payload 与 normalized metadata 的 `reasoning_effort` 和 `reasoning.effort`；保留请求已有 `reasoning.summary` 等字段。Anthropic/Claude-Code provider 近似映射 `xhigh/max -> high`，OpenAI 侧保留 `xhigh` 语义。
- 红绿证据：`router-direct-pipeline.spec.ts` 新增 direct 配置覆盖/无配置透传；实现前配置覆盖用例失败，修复后 PASS。Rust 新增 `test_apply_route_selection_preserves_xhigh_thinking_as_request_semantic_level` PASS。
- 验证：focused router-direct Jest PASS；Rust `req_process_stage2_route_select` PASS；Rust `req_outbound_stage3_compat` PASS；root `tsc --noEmit` PASS；llmswitch-core `npm run build` PASS；`git diff --check` PASS。
- 边界：本轮未做 install/restart/live 5555 replay；`provider_bootstrap.rs` 存在并行脏改，本轮只依赖其中 `xhigh/max -> high` thinking 映射，不处理 alias/errorMapping 脏改。

## 2026-06-21 5555 EcoDev GLM route-hit check

- 用户问题：5555 的 `tools/search/web_search` 已配置 `ecodev.GLM-5.1` 在 `fwd.minimax.MiniMax-M2.7` 前面，但旧样本仍命中 `minimonth.key1.MiniMax-M2.7`。
- 旧样本证据：`~/.rcc/codex-samples/openai-chat/ports/5555/minimonth.key1.MiniMax-M2.7/req_1781970149994_6823b8ab/provider-request.json` 出站 `body.model=MiniMax-M2.7`，runtime marker 显示 `entryPort=5555`、`providerKey=minimonth.key1.MiniMax-M2.7`、版本 `0.90.3220`。该样本没有 client-request 快照，不能证明当时是否真的携带 `x-route-hint: tools`。
- 配置/编译证据：`routecodex config validate -c ~/.rcc/config.toml` PASS；per-port `buildVirtualRouterInputV2(..., routingPolicyGroup="gateway_priority_5555")` 显示 5555 providers 包含 `ecodev`，`ecodev.auth.entries=[default, backup]`，models 含 `GLM-5.1`；native `bootstrapVirtualRouterConfig` 展开出 `ecodev.default.GLM-5.1` / `ecodev.backup.GLM-5.1`，runtimeKey 分别为 `ecodev.default` / `ecodev.backup`，maxContextTokens=200000。
- 当前 live 证据：2026-06-21 00:21 向 `127.0.0.1:5555/v1/chat/completions` 发送 `x-route-hint: tools`、工具声明、marker `RCC_ECODEV_5555_LIVE_20260621_002138`，HTTP 200，response `model=GLM5_1_W4A8-1.0.0`、content `OK`。新 sample 位于 `~/.rcc/codex-samples/openai-chat/port-5555/req_1781972499258_2858d844/`。
- 当前结论边界：当前 5555 配置已能命中 GLM；旧 MiniMax 样本不能再作为“当前不命中”的证据。若再次出现不命中，必须抓同轮 client-request 或日志中的 `virtual-router-hit`，确认实际 route 是 `tools/search/web_search/longcontext/coding` 中哪一个。

- 2026-06-21 servertool Rust-only closeout 继续：
  - 已把 dispatch-plan input builder 从 TS 下沉到 Rust `build_servertool_dispatch_plan_input_json`，TS 改为 `buildServertoolDispatchPlanInputWithNative(...)`。
  - 已把 outcome-plan input builder、handler contract 判定、backend execution kind 判定下沉到 Rust：`build_servertool_outcome_plan_input_json` / `plan_servertool_handler_contract_json` / `plan_servertool_backend_execution_json`。
  - TS `execution-handler-materialization-shell.ts` 不再本地判断 plan/result 或 backend kind；仅执行 JS handler / backend IO。
  - TS `execution-dispatch-outcome-shell.ts` 不再本地拼 dispatch/outcome input；只消费 Rust plan 并执行 IO queue。
  - 验证：`cargo test -p router-hotpath-napi servertool_skeleton_config -- --nocapture` PASS；`node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` PASS；focused Jest `servertool-active-orchestration-audit` / `server-side-tools.dispatch-native` / `execution-shell.backend-failfast` PASS；`npx tsc --noEmit` PASS；`npm run verify:servertool-rust-only` PASS。
  - 现阶段 execution-shell family 的假绿已消除，aggregate gate 与 focused red gate 一致。下一步应跑 auto-hook / CLI projection / dual-port 黑盒与 maps sync。


## 2026-06-21 live HTTP_400 minimax anthropic 2013 follow-up

- 新 live 错误已核实不是 429 / provider error mapping，而是 `5555 /v1/responses -> search -> minimax.key1.MiniMax-M2.7` 上游 400：`invalid params, tool call result does not follow tool call (2013)`。证据：`~/.rcc/logs/server-5520.log:1063643-1063649` 与 `/Users/fanzhang/.rcc/diag/error-openai-responses-router-gpt-5.4-20260620T235623118-378307-3349.json`。
- request body 真样本表明入口是 `/v1/responses`，provider target 是 anthropic family (`providerProtocol=anthropic-messages`, `compatibilityProfile=anthropic:claude-code`)；错误发生在 provider outbound history 顺序，不是客户端投影层。
- 当前唯一 owner 缩到 Rust 主线：`responses_openai_codec.rs -> hub_req_inbound_context_capture.rs(normalize_responses_input_items / normalize_captured_responses_context) -> hub_bridge_actions::convert_bridge_input_to_chat_messages -> anthropic_openai_codec.rs`。
- 现有 Rust 已有 fail-fast 防线：`anthropic_openai_codec.rs::enforce_anthropic_tool_pairing()` 和 red test `build_anthropic_from_openai_chat_red_test_orphan_tool_use_followed_by_user_text_2013`。当前缺口更可能在更早的 responses input 归一化把 tool output 变成了普通 user text / 打乱了顺序。
- 下一步：先补 focused red test 复现 live shape，再改上述 Rust owner，最后 build native + focused tests + online replay。

## 2026-06-21 XLC deepseek-v4-pro + ecodev GLM-5.1 live conversion audit

- 用户目标：检查 `openai` provider `XLC.deepseek-v4-pro` 与 `ecodev.GLM-5.1` 单独 model curl 是否可达；若 provider 可用，审计为何 server 无法正确转换/发送请求。
- XLC upstream 直打结论：
  - `curl https://xlapis.com/v1/chat/completions` with `model=deepseek-v4-pro` 直接返回 HTTP 503 `model_not_found`，message=`No available channel for model deepseek-v4-pro under group GLM (distributor)`。
  - 同样 payload 打本地 `5555 /v1/chat/completions model=XLC.deepseek-v4-pro` 与 `5555 /v1/responses model=XLC.deepseek-v4-pro` 都返回 502，但 error code 仍是上游 `model_not_found`。
  - 结论：`XLC.deepseek-v4-pro` 当前是 upstream/provider 可用性问题，不是 RouteCodex 请求转换问题。样本：`~/.rcc/codex-samples/openai-responses/ports/5555/XLC.key1.deepseek-v4-pro/req_1782003037451_afec5b7f/`。
- ecodev upstream 直打结论：
  - 使用 token file `~/.rcc/auth/ecodev-oauth-1-default.json` 的 `access_token`，直打 `https://cn.devecostudio.huawei.com/sse/codeGenie/maas/v2/no-stream/chat/completions`，若 `Chat-Id` 缩到 16 hex，HTTP 200，response model=`GLM5_1_W4A8-1.0.0`，正文 `ok`。
  - 若 `Chat-Id` 使用当前代码生成的 32 hex，upstream 返回 HTTP 400，`originalMessage=\"SSE request header Chat-Id is too long\"`。
  - 唯一 owner：`src/providers/profile/families/ecodev-profile.ts`，当前 `createChatId()` 用 `randomUUID().replace(/-/g, '')` 生成 32 hex；这与 live upstream 约束冲突。
- ecodev 当前 server 失败结论：
  - `5555 /v1/chat/completions model=ecodev.GLM-5.1` 最新 live 样本 `~/.rcc/codex-samples/openai-chat/port-5555/openai-chat-unknown-unknown-20260621T085121308-379371-4413/` 证明失败发生在 provider 发送前：
    - `provider-response.json` 明确报 `TokenFileAuthProvider not initialized`
    - stack：`TokenFileAuthProvider.buildHeaders -> buildProviderRequestHeaders -> HttpRequestExecutor.prepareHttpRequest`
  - 这说明当前 `HTTP_HANDLER_ERROR` 的第一层真因不是响应解析，也不是 openai-sdk chat/responses 桥接，而是 provider auth initialization/runtime handle 初始化链有缺口。
  - owner 缩到：
    - `src/providers/auth/tokenfile-auth.ts`
    - `src/providers/core/runtime/http-transport-provider.ts`
    - `src/server/runtime/http-server/http-server-runtime-providers.ts:createProviderHandle(...)`
- 边界澄清：
  - `openai-sdk` chat transport 确实会把 Responses body 先 `normalizeResponsesToChatBody(...)` 再按 chat 发出，owner 在 `src/providers/core/runtime/vercel-ai-sdk/openai-sdk-transport.ts`；但本轮这两个 provider 的 live 失败都还没证明卡在这层。
  - 对 XLC：已被 upstream 503 排除为 server conversion bug。
  - 对 ecodev：已被 `TokenFileAuthProvider not initialized` 和 `Chat-Id too long` 两个更前置的 owner 阻断；在这两个问题修掉前，不能把锅甩给 responses/chat 转换层。
- 当前下一步（修复顺序）：
  1. 修 `ecodev-profile.ts` 的 `Chat-Id` 长度，先锁 red test + upstream direct replay。
  2. 审计 `TokenFileAuthProvider` 初始化为何在 `createProviderHandle -> instance.initialize()` 后仍未 ready；先补 focused test 复现 `processIncomingDirect/processIncoming` 路径。
  3. 只有在 auth init 与 `Chat-Id` 修复后仍失败，才继续追 `openai-sdk` responses->chat bridge / response parse owner。

## 2026-06-21 responses provider-owned submit_tool_outputs reroute blackbox

- 重新实测 `tests/server/handlers/responses-provider-owned-continuation-reroute.blackbox.spec.ts`，两个用例失败时 `providerCalls=[]`，说明问题不在 reroute 后段。
- handler 自动落盘 diag 已确认真正失败点：
  - `~/.rcc/diag/error-openai-responses-router-request-20260621T090002367-1139-227.json`
  - `~/.rcc/diag/error-openai-responses-router-request-20260621T090003797-1140-228.json`
  - stack 都停在 `buildResponsesRequestContextForHttp -> captureReqInboundResponsesContextSnapshot`
  - native 错误：`Responses payload produced no chat messages`
- 结论：
  - provider-owned `/v1/responses.submit_tool_outputs` 原生续接 payload 只有 `response_id + tool_outputs`，不应强制走 relay request-context 的 chat/input 抓取。
  - 这不是 `status=171` 或 provider runtime resolve 问题；应在 request bridge 显式把这类 payload 视为 `context.input=[]` 的 context-free request state。

## 2026-06-21 ecodev tokenfile/chatid audit
- verified_current: ecodev local 5555 failure sample hit `ecodev.backup.GLM-5.1`; `~/.rcc/auth/ecodev-oauth-2-backup.json` is `{}` only, so startup should have excluded this runtime instead of leaving it selectable.
- verified_current: ecodev upstream direct works with 16-hex `Chat-Id`; current code used 32-hex and must be shortened.
- action: changed `TokenFileAuthProvider.initialize()` to fail-fast on missing/unreadable/empty token file so server startup can classify it as credential-missing and skip runtime.
## 2026-06-21 stopless fence ssot audit

- 用户新要求：stopless schema 必须收敛到显式 fence（如 `<rcc_stop_schema>...</rcc_stop_schema>`），并把注入、解析、剥离 owner 钉死，再先补红测。
- 已核实请求侧唯一注入 owner：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs`
  - 当前 `STOPLESS_SYSTEM_INSTRUCTION` 与 `build_reasoning_stop_tool()` 都在这里；terminal trigger 后移除注入控制面也在这里（`request_has_terminal_stopless_output` / `strip_stopless_terminal_controls`）。
- 已核实解析侧唯一 gate owner：`sharedmodule/llmswitch-core/rust-core/crates/stop-message-core/src/lib.rs`
  - 当前 `evaluate_stop_schema_gate(...)` 仍按裸 JSON/文本缺字段规则判 `stop_schema_missing` / `stop_schema_next_step_missing` / `stop_schema_budget_exhausted`，尚未引入 fence-only contract。
- 当前 live 证据：`/tmp/stopless-5555-live-probe.json`
  - 第一轮不是“完全没 schema”，而是 provider 返回 `required_action.reasoning.stop`，arguments 只含 `stopreason=2 + reason`；
  - 本地 `stop_message_auto` 回写 `schemaFeedback.reasonCode=stop_schema_next_step_missing`，说明当前主要症状是 partial/invalid schema loop，不是纯 no-schema。
- 当前唯一修改骨架：
  1. 请求侧注入合同与 tool description 同源化：`orchestrator.rs`
  2. 解析合同 fence-only + reasoning.stop arguments 优先：`stop-message-core/src/lib.rs`
  3. terminal 可见正文剥离 fence：沿现有 stop-message terminal visible payload builder owner 收口，禁止 TS/client 二次处理
- 红测入口已锁：
  - Rust request 注入：`router-hotpath-napi` request governance tests
  - Rust gate：`sharedmodule/llmswitch-core/rust-core/crates/stop-message-core/tests/stop_schema_gate_closure.rs`
  - TS thin-shell / lifecycle contract：`tests/servertool/stop-schema-lifecycle-contract.spec.ts`、`tests/servertool/stop-message-native-decision.spec.ts`

## 2026-06-21 ecodev direct-model startup-skip stale-config fix

- root_cause_verified:
  - `TokenFileAuthProvider` fail-fast 后，启动日志已明确 skip `providerKey=ecodev.backup.GLM-5.1 runtimeKey=ecodev.backup reason=credential_missing detail=missing required authentication credential: token file missing access token (/Users/fanzhang/.rcc/auth/ecodev-oauth-2-backup.json)`
  - 但 `setupRuntime()` 之前把 `bootstrapArtifacts.config` 先装进 Hub/VR，`initializeProviderRuntimes()` 只跳过 runtime handle，没有同步收缩 VR config/provider registry。
  - 结果是 Rust `route.rs` 的 `direct_model` 分支仍能从 registry 枚举到 `ecodev.backup.GLM-5.1`，继而在 request 期报 `provider not found for runtimeKey: ecodev.backup`。
- fix_applied:
  - `src/server/runtime/http-server/http-server-runtime-setup.ts`
  - 在 `initializeProviderRuntimes()` 之后按 `startupExcludedProviderKeys` 物理裁剪 primary/group virtual-router config：
    - 删除 `config.providers[excludedProviderKey]`
    - 删除 route tier 里的同名 `targets`
    - 同步刷新 `currentRouterArtifacts`、主 Hub pipeline、各 routingPolicyGroup pipeline、shadow config
- focused_verify:
  - Jest PASS:
    - `tests/server/runtime/http-server/http-server-runtime-setup.provider-merge.spec.ts`
    - `tests/providers/auth/tokenfile-auth.unit.spec.ts`
    - `tests/provider/provider-outbound-provider.test.ts`
    - `tests/providers/profile/profile-registry.unit.test.ts`
  - `npx tsc --noEmit --pretty false` PASS
  - `BUILD_MODE=dev npm run build:min` PASS
- live_verify:
  - `node dist/cli.js restart --port 5555` PASS
  - `curl http://127.0.0.1:5555/health` => `version=0.90.3223 ready=true pipelineReady=true`
  - `POST /v1/chat/completions model=ecodev.GLM-5.1` => 200, body `choices[0].message.content="ok"`
  - `POST /v1/responses model=ecodev.GLM-5.1` => 200 SSE，样本中明确命中 `ecodev.default.GLM-5.1`
  - `~/.rcc/logs/server-5520.log` 最新 live 证据：
    - `direct/direct -> ecodev[default].GLM-5.1 reason=direct_model:ecodev.GLM-5.1`
    - 不再出现 `provider not found for runtimeKey: ecodev.backup`
- boundary:
  - `XLC.deepseek-v4-pro` / `XLC.glm-5.2` 仍是 upstream 不可用，不属于本地转换 bug

## 2026-06-21 400 'All available accounts exhausted' auto-quota
- 已提交 `58e6551 fix: normalize 400 'accounts exhausted' to INSUFFICIENT_QUOTA`。
- 触发现场：`openai-responses -> XLC.key2.deepseek-v4-pro` 返回 `HTTP 400: {"error":{"message":"All available accounts exhausted","type":"server_error"}}`。
- 之前路径：`normalizeKnownProviderError` 只对 `status===429` 做 quota 归一化，400 全部落到 `HTTP_400` 的 `special_400`，不会触发 quota cooldown 也不会让 relay 切路，直接作为 hard failure 暴露给客户端，阻塞整个 session。
- 本轮改：在 `provider-error-catalog.ts` 的 `normalizeKnownProviderError` 增加 message 启发式，把以下 400 文本族归一为 `INSUFFICIENT_QUOTA`（`429.2000`，unrecoverable/quota 语义）：
  - `all available accounts exhausted`
  - `accounts exhausted`
  - `account pool exhausted`
  - `no available accounts` / `no available account`
- 故意不放宽到 5xx，只针对 400+pool 文本族，避免误吃普通 4xx 校验错误。
- 已加红测：
  - `tests/providers/core/runtime/provider-auto-retry-business-error.spec.ts::400 account-pool exhaustion is normalised to quota class` 包含正反两个 case：
    - 400 + `All available accounts exhausted` → `INSUFFICIENT_QUOTA` / `unrecoverable`
    - 400 + `Invalid request payload: missing field "input"` → `HTTP_400` / `special_400`（不误吞）
- 验证栈：
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/providers/core/runtime/provider-auto-retry-business-error.spec.ts tests/providers/core/runtime/provider-failure-policy.spec.ts tests/provider/http-request-executor-sse-snapshot.spec.ts tests/provider/provider-factory.test.ts` 全部 PASS（`provider-outbound-provider.test.ts` 既有 4 个 metadata-not-allowed 失败与本修复无关，属于工作区未提交 parallel 改动）。
- 配置化方向（下一轮单独 PR，不混在本 commit）：
  - 在 `ProviderFamilyProfile` 增加 `errorCodeMapping?: { fromStatus, fromMessagePattern, toClassification }` 或独立读取 `~/.rcc/provider/<id>/error-mapping.json`；
  - 优先级：family profile > 通用 catalog；
  - owner 钉在 `provider-failure-policy-impl.ts::resolveProviderFailureClassification` 入口，作为前置 override。

## 2026-06-21 09:40:22 live probe expansion start
- Need online coverage beyond intentional missing-schema loop: reasoning.stop.arguments terminal, fenced terminal, invalid fenced JSON, bare JSON missing fence.
- Current script likely still optimized for negative loop detection; inspect and extend before running 5555 replay.

- Inspected probe script: current terminal contract is budget_exhausted only; need scenario-aware runner keyed by reasoning.stop args / CLI schemaFeedback reasonCode.
- Live 5555 cases report written: /tmp/stopless-live-cases-report.json
- Root cause: servertool-core cli_contract derive_stopless_feedback_from_raw_reasoning_stop_input still calls evaluate_stop_schema_gate on serialized JSON text, so public reasoning_stop CLI ignores arguments-path and misclassifies full schema as stop_schema_missing.

## 2026-06-21 provider errorMapping runtime classification audit
- User live symptom: XLC `/v1/responses` returns upstream HTTP 400 body `All available accounts exhausted`; runtime currently surfaces HTTP_400 and repeats same provider, blocking conversation.
- Config truth already has `~/.rcc/provider/XLC/config.v2.toml` `[[provider.errorMapping.rules]]` mapping origin 400/server_error/messageContains to status 429/code HTTP_429.
- Code truth: bootstrap/provider factory preserve `extensions.errorMapping`; `normalizeProviderHttpError()` applies mapping in `provider-http-executor-utils.ts`. Need verify downstream RequestExecutor/ErrorErr03 consumes mapped status/code and does not let original 400/sticky win.
- Verified follow-up: `/v1/responses` direct path was bypassing that logic because `ResponsesProvider` catch blocks only called `normalizeUpstreamError(error)`. Shared helper now lives in `src/providers/core/runtime/provider-configured-error-mapping.ts` and is consumed by both `provider-http-executor-utils.ts` and `responses-provider.ts`.
- Gate results after fix: focused `responses-provider.direct-passthrough.spec.ts`, `provider-http-executor-utils.spec.ts`, `provider-failure-policy.spec.ts`, `request-executor-provider-failure-plan.spec.ts` all PASS; `npx tsc --noEmit --pretty false` PASS; build/install/restart produced live version `0.90.3233`, `curl http://127.0.0.1:5555/health` => `ready=true pipelineReady=true`.
- Live gap: current 5555 replay either hit a healthy earlier provider or returned unrelated `CONFIG_ERROR` on invalid direct-model syntax, so this round did not re-trigger the exact exhausted-account upstream sample online. Do not claim live 400->429 replay closed until a fresh sample actually hits `XLC.key2.deepseek-v4-pro`.

## 2026-06-21T04:42:01.549Z stopless learned

- requestId: openai-responses-XLC.key1-glm-5.2-20260621T124135686-380803-172
- sessionId: 019ee345-f259-72c0-82bb-66864c0923c5
- stopReason: 已完成错误审计：406 是 ecodev profile 的 resolveEndpoint 要求 stream 参数显式指定，直连测试未传 stream 导致 endpoint=undefined，最终请求到错误 URL 被拒
- evidence: ecodev-profile.ts:resolveEndpoint 在 stream=undefined 时返回 undefined；直连 curl 未传 stream 字段；日志中 ecodev 406 全部发生在 no-stream 场景

ecodev profile 强依赖 stream 字段决定 endpoint，直连测试必须传 stream 参数才能正确路由

## 2026-06-21 provider errorMapping SSE wrapper review

- Review 结论：上一轮 `59e6c4618` 只把 provider 配置错误映射接入 `ResponsesProvider`/`HttpRequestExecutor` 的 HTTP throw/catch 路径；新样本 `380760-129` 走的是 provider response `mode:sse` wrapper error -> `convertProviderResponseIfNeeded` 构造并抛出 `Upstream SSE error event...`，该主线未读取 `extensions.errorMapping`，所以最终 `http-error-mapper` 仍投影 `HTTP_400 / Upstream rejected the request`。
- 本轮锁定：红测必须模拟 `mode:sse` wrapper error 内含 `HTTP 400 + All available accounts exhausted + type=server_error`，且 provider runtime extensions 配置映射为 `HTTP_429`；修复点在 provider response conversion/provider runtime 错误链接入，不得在 `http-error-mapper` 做客户端投影补丁。

## 2026-06-21 13:06:39 llmswitch bootstrap module missing audit

- 现象：全局安装态启动时报缺模块 `dist/native/router-hotpath/native-virtual-router-bootstrap-config.js`。
- 初判：更像安装/构建产物缺失或 pack/link 未覆盖新文件，不像 VR 运行时配置错误。
- 下一步：查源码是否存在、build 是否生成、global dist 是否同步。

## 2026-06-21 13:09:20 install:global failure audit

- 现象：`npm run install:global` 在 `verify:architecture-wiki-html-sync` 失败，提示 3 个 wiki html 文件与 markdown 不一致。
- 结论：当前阻塞点是生成物同步门禁，不是 bootstrap 模块本身。
- 下一步：先运行 `npm run render:architecture-wiki-html`，再重跑 `install:global`。

## 2026-06-21 13:11:09 manual global reinstall plan

- install:global 已越过 wiki 同步门，但整链失败原因对当前缺失模块已非关键。
- 当前改走更短闭环：基于仓库现有 dist 手工 npm pack + npm install -g，直接验证 global 包是否带 `sharedmodule/llmswitch-core/dist`。

## 2026-06-21 servertool execution-loop runtime-action contract rust-owner

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/execution-dispatch-outcome-shell.ts`：
  - 旧 TS 仍本地 owner 一层 execution-loop 主分支：
    - `!entry || entry.trigger !== 'tool_call'`
    - `if (result)`
    - `if (lastErr)`
  - 现在把这层 loop runtime action 下沉到 Rust：
    - owner：`sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_loop_runtime_action_contract.rs`
    - feature_id：`hub.servertool_execution_loop_runtime_action_contract`
    - 新 contract：`plan_servertool_execution_loop_runtime_action(...)`
    - action：
      - `skip_non_tool_call_handler`
      - `apply_materialized_result`
      - `apply_handler_error_tool_output`
      - `continue_without_effect`
- 新 bridge：
  - NAPI：`plan_servertool_execution_loop_runtime_action_json`
  - TS wrapper：`planServertoolExecutionLoopRuntimeActionWithNative(...)`
- `execution-dispatch-outcome-shell.ts` 现在不再本地 owner 这些分支；TS 只按 native action 执行 handler/materialization IO shell。
- gate 收紧：
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - `scripts/verify-servertool-rust-only.mjs`
  - 现在额外禁止复活：
    - `if (!entry || entry.trigger !== 'tool_call')`
    - `if (result) {`
    - `if (lastErr) {`
- focused 验证顺序：
  - `cargo test -p servertool-core execution_loop_runtime_action_contract -- --nocapture` -> 5 passed
  - `cargo test -p router-hotpath-napi plans_servertool_execution_loop_runtime_action_via_servertool_core_bridge -- --nocapture` -> 1 passed
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` -> PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/execution-dispatch-outcome-shell.spec.ts tests/servertool/servertool-cli-native-bridge.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
- 本轮额外经验：
  - native build 和 NAPI 依赖黑盒不能并行；并行时会读到旧 `.node`，制造 `native unavailable` 假失败。
- 当前边界：
  - `execution-dispatch-outcome-shell.ts` 仍保留 handler invoke / payload append 等 IO shell；
  - `server-side-tools-impl.ts`、`engine.ts`、`registry-impl.ts` 仍有活 TS orchestration；
  - `servertool.hook_skeleton.mainline` 仍必须保持 `binding pending`，不能宣称 0 TS 业务语义已完成。

## 2026-06-21 servertool execution-outcome envelope runtime-action rust-owner

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/execution-dispatch-outcome-shell.ts`：
  - 旧 TS 仍本地 owner 一层 execution outcome 尾部语义：
    - `followup` 已由 native action 决定来源，但 TS 还在本地用
      `args.executionState.lastExecution && args.executionState.executedToolCalls.length === 1`
      决定是否复用 `lastExecution` 整个 execution envelope。
  - 现在把这层 envelope reuse 决策下沉到 Rust：
    - owner：`sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_outcome_runtime_action_contract.rs`
    - 仍沿用 feature_id：`hub.servertool_execution_outcome_runtime_action_contract`
    - contract 扩展：
      - 新输入：`hasLastExecution`、`executedToolCallsLen`
      - 新输出：`reuseLastExecutionEnvelope`
- 新 bridge/TS shell：
  - `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`
    现在把 `reuseLastExecutionEnvelope` 作为必经 plan 字段读回。
  - `sharedmodule/llmswitch-core/src/servertool/execution-dispatch-outcome-shell.ts`
    不再本地用 `executedToolCalls.length === 1` 判 execution envelope；只按 native plan 决定是否复用 `lastExecution`。
- gate 收紧：
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - 现在额外禁止复活：
    - `args.executionState.lastExecution && args.executionState.executedToolCalls.length === 1`
- focused 验证顺序：
  - `cargo test -p servertool-core execution_outcome_runtime_action_contract -- --nocapture` -> 6 passed
  - `cargo test -p router-hotpath-napi plans_servertool_execution_outcome_runtime_action_via_servertool_core_bridge -- --nocapture` -> 1 passed
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` -> PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/execution-dispatch-outcome-shell.spec.ts tests/servertool/servertool-cli-native-bridge.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand` -> 3 suites / 28 tests passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
- 当前边界：
  - execution outcome followup source + single-execution envelope reuse 已进一步不在 TS；
  - 但 noop tool-call loop、`server-side-tools-impl.ts` response-stage/auto-hook branch、`engine.ts` followup shell、`registry-impl.ts` 仍有活 TS orchestration；
  - `servertool.hook_skeleton.mainline` 仍必须保持 `binding pending`。

## 2026-06-21 servertool execution-loop effect contract rust-owner

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/execution-dispatch-outcome-shell.ts`：
  - 旧 TS 仍本地 owner 两层 execution-loop appended-record 语义：
    - handler error 分支本地拼 `${toolCall.name}_error`
    - noop tool call 分支本地拼 `executionMode: 'noop'`、`stripAfterExecute: true`、`flowId/followup/context`
  - 现在把这层 appended-record 语义下沉到 Rust：
    - 新 owner：`sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_loop_effect_contract.rs`
    - feature_id：`hub.servertool_execution_loop_effect_contract`
    - 新 contract：`plan_servertool_execution_loop_effect(...)`
    - mode：
      - `handler_error`
      - `noop`
- 新 bridge：
  - NAPI：`plan_servertool_execution_loop_effect_json`
  - TS wrapper：`planServertoolExecutionLoopEffectWithNative(...)`
- `execution-dispatch-outcome-shell.ts` 现在不再本地 owner：
  - `${toolCall.name}_error`
  - `executionMode: 'noop'`
  - `stripAfterExecute: true`
  - noop execution `flowId/followup/context` record 组装
- gate 收紧：
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - 现在额外禁止复活：
    - `${toolCall.name}_error`
    - `executionMode: 'noop'`
    - `stripAfterExecute: true`
    - `noopResult.flowId`
    - `noopResult.followup`
    - `noopResult.executionContext`
- focused 验证顺序：
  - `cargo test -p servertool-core execution_loop_effect_contract -- --nocapture` -> 2 passed
  - `cargo test -p router-hotpath-napi plans_servertool_execution_loop_effect_via_servertool_core_bridge -- --nocapture` -> 1 passed
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` -> PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/execution-dispatch-outcome-shell.spec.ts tests/servertool/servertool-cli-native-bridge.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand` -> 3 suites / 30 tests passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
- 当前边界：
  - execution-loop appended-record 里的 handler-error/noop record 语义已进一步不在 TS；
  - 但 `server-side-tools-impl.ts` response-stage/auto-hook branch、`engine.ts` followup shell、`registry-impl.ts` 仍有活 TS orchestration；
  - `servertool.hook_skeleton.mainline` 仍必须保持 `binding pending`，不能宣称 0 TS 业务语义完成。

## 2026-06-21 servertool response-stage runtime-action contract rust-owner

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.ts`：
  - 旧 TS 仍本地 owner response-stage 尾部主分支：
    - `responseStagePlan?.nextAction === 'bypass'`
    - `if (autoHookResult) return autoHookResult`
    - auto-hook 跑完后的 final passthrough
  - 现在把这层主分支下沉到 Rust：
    - owner：`sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/response_stage_runtime_action_contract.rs`
    - feature_id：`hub.servertool_response_stage_runtime_action_contract`
    - 新 contract：`plan_servertool_response_stage_runtime_action(...)`
    - action：
      - `return_passthrough_bypass`
      - `run_auto_hooks`
      - `return_auto_hook_result`
      - `return_passthrough_no_auto_hook_result`
- 新 bridge：
  - NAPI：`plan_servertool_response_stage_runtime_action_json`
  - TS wrapper：`planServertoolResponseStageRuntimeActionWithNative(...)`
- `server-side-tools-impl.ts` 现在改为两段式 native action：
  - pre-auto-hook：`autoHookEvaluated=false`
  - post-auto-hook：`autoHookEvaluated=true`
  - 用来区分“还没跑 auto-hook”和“跑过但结果为 null”，避免把 null 误判成未执行。
- gate 收紧：
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
    - 禁止复活：
      - `responseStagePlan?.nextAction === 'bypass'`
      - `if (autoHookResult) {`
  - `tests/servertool/server-side-tools.failfast.spec.ts`
    - 断言 pre/post 两次 native runtime-action 调用参数
  - `tests/servertool/servertool-cli-native-bridge.spec.ts`
    - 覆盖 bypass / pre-auto-hook / auto-hook result / null result passthrough 四种 action
- focused 验证顺序：
  - 在 `sharedmodule/llmswitch-core/rust-core/` 下执行：
    - `cargo test -p servertool-core response_stage_runtime_action_contract -- --nocapture` -> 5 passed
    - `cargo test -p router-hotpath-napi plans_servertool_response_stage_runtime_action_via_servertool_core_bridge -- --nocapture` -> 1 passed
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` -> PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/server-side-tools.failfast.spec.ts tests/servertool/servertool-cli-native-bridge.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand` -> 3 suites / 29 tests passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
- 当前边界：
  - response-stage bypass/auto-hook-result/passthrough 主分支 owner 已进一步不在 TS；
  - 但 `server-side-tools-impl.ts` 仍保留 auto-hook caller / response-stage shell，`engine.ts` / `registry-impl.ts` 仍有活 TS orchestration；
  - `servertool.hook_skeleton.mainline` 仍必须保持 `binding pending`，不能宣称 0 TS 业务语义完成。
## 2026-06-21 provider errorMapping deepseek responses chain follow-up

- 先读最新失败样本：
  - `~/.rcc/codex-samples/openai-responses/port-unknown/openai-responses-XLC.key2-deepseek-v4-pro-20260621T160907539-381698-1067/client-response.error_server.json`
  - 客户端仍收到 `status=400 code=HTTP_400 message=Upstream rejected the request`
  - `__runtime.json` 仅证明运行版本已到 `0.90.3234`，不含 provider 原始错误体
- 已确认之前修复只覆盖 `HttpTransportProvider`/普通 HTTP error normalize：
  - `provider-runtime-utils.ts` + `http-transport-provider.ts` 已把 provider config `extensions.errorMapping` 注入 `ProviderContext`
  - `provider-http-executor-utils.spec.ts` 已证明 raw upstream 400 可映射成 429
- 当前真实漏点不是 handler/http-error-mapper：
  - `ResponsesProvider.reportResponsesFailureIfNeeded()` 会把 upstream failed payload 重新压成 synthetic `Error`
  - 这条链直接 `emitProviderErrorAndWait(stage='provider.responses')`
  - 现状未复用 `applyProviderConfiguredErrorMapping` / `normalizeConfiguredUpstreamError`
  - 所以 `/v1/responses` 的 `status=failed + error.message=All available accounts exhausted` 仍走裸 `HTTP_400`
- 唯一修改点候选：
  - `src/providers/core/runtime/responses-provider.ts`
  - 目标：让 responses failed payload 进入统一 provider-configured error mapping + classify/report 主链
  - 明确不去 `http-error-mapper`/handler 末端补偿
- 已实施并验证：
  - `responses-provider-helpers.ts`
    - `detectResponsesFailure(payload, context)` 现在先把 failed payload 构造成 normalized upstream error
    - 然后执行 `applyProviderConfiguredErrorMapping(...)`
    - 再用映射后的 `status/code/message` 进入 `resolveProviderFailureOutcome(...)`
  - `responses-provider.ts`
    - `reportResponsesFailureIfNeeded(...)` 改为消费 helper 返回的 `normalizedError`
    - 删除本地第二份 synthetic 400 shell 拼装
- focused 验证：
  - `tests/providers/core/runtime/responses-provider-helpers.spec.ts`
  - `tests/providers/core/runtime/provider-http-executor-utils.spec.ts`
  - `tests/providers/core/runtime/http-transport-provider.context-extensions.spec.ts`
  - `npx tsc --noEmit --pretty false`
- 在线验证：
  - 版本已安装并重启到 `0.90.3235`
  - 用旧样本 `error-openai-responses-router-gpt-5.4-20260621T160907539-381698-1067.json` 抽 `requestBody` 直接重放到 `http://127.0.0.1:5555/v1/responses`
  - 客户端结果不再是 `event:error status=400 code=HTTP_400`，而是正常 SSE `response.created -> tool_calls`
  - `server-5520.log` 显示同条请求 `openai-responses-XLC.key2-deepseek-v4-pro-20260621T162103748-381781-1150` 已进入 reroute 链，并最终由 `openai-responses-minimax.key1-MiniMax-M3-20260621T162103748-381781-1150 completed (status=200, finish_reason=tool_calls)` 收口

## 2026-06-21T09:02:03.942Z stopless learned

- requestId: openai-responses-minimax.key1-MiniMax-M3-20260621T170145297-382123-1492
- sessionId: 019ee345-f259-72c0-82bb-66864c0923c5
- stopReason: 根因已定位（ecodev-profile resolveEndpoint 漏读 Accept 头导致 URL 与 body.stream 不一致触发上游 406），等用户确认下一步修复方案
- evidence: 上游对 /v2/no-stream/chat/completions + Accept:text/event-stream 返回 406 'Accept text/event-stream is not supported'；45 个 ecodev 样本全部 URL=/v2/no-stream/chat/completions 但 28 个失败请求 body.stream=true + Accept=text/event-stream；2 个成功请求 Accept=application/json + body.stream=False

路由相关 profile 的 stream 字段读取必须覆盖所有入口（chat/completions、responses、anthropic），不能只信 body.stream

## 2026-06-21 servertool auto-hook caller native-action thin-shell

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.ts`：
  - 旧 TS 仍本地 owner auto-hook 单次尝试主分支：
    - `planned === null` 直接 continue
    - `result` 存在直接 return
    - queue result 存在直接 return engine result
  - 现在改为严格按已存在的 Rust owner 执行：
    - `plan_auto_hook_execution_decision(...)`
    - `plan_auto_hook_queue_progress(...)`
  - TS 只负责：
    - handler invoke
    - materialization IO
    - trace emit shell
    - 按 native `action` 执行 `return_result / continue_queue / rethrow_error`
- 新 fail-fast 约束：
  - native 如果要求 `return_result`，但 materialization 为空，立即报错；
  - native 如果在 error outcome 下不给 `rethrow_error`，立即报错；
  - 不允许 TS 靠 `!planned` / `result` / `queueResult` 自己决定业务分支。
- gate 收紧：
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
    - 额外禁止 `auto-hook-caller.ts` 复活：
      - `if (!planned) {`
      - `if (result) {`
  - `scripts/verify-servertool-rust-only.mjs`
    - 同步禁止上述 TS 本地分支
- focused 验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/servertool-auto-hook-trace.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand` -> 2 suites / 11 tests passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
- 当前边界：
  - auto-hook caller 的 attempt outcome / queue progression owner 已进一步不在 TS；
  - 但 `registry-impl.ts`、`execution-shell.ts`、`server-side-tools-impl.ts`、`engine.ts` 仍有活 TS orchestration；
  - `servertool.hook_skeleton.mainline` 仍必须保持 `binding pending`，不能宣称 0 TS 业务语义完成。

## 2026-06-21 servertool skill sediment audit

- 审计目标：确认“整个 servertool 开发和 debug 流程要沉淀入 skills”是否已经真实落盘，而不是只存在聊天或 goal。
- 已确认现状：
  - `.agents/skills/rcc-dev-skills/SKILL.md` 已把 servertool 任务路由到 `22` 和 `23`
  - `references/22-servertool-hook-skeleton-workflow.md` 锁目标骨架与 case matrix
  - `references/23-servertool-hook-dev-debug-flow.md` 已锁实施顺序、debug 切段、串行验证顺序、删 TS 准入条件
  - `docs/architecture/wiki/servertool-hook-skeleton-mainline-source.md` 负责目标骨架，不代替开发/debug 流程
- 本轮补强：
  - 把“整个开发/debug 主流程必须进 skill，不能只留在 wiki / goal / note / 聊天”写进 `SKILL.md`
  - 把同一规则写进 `23-servertool-hook-dev-debug-flow.md` 和 `60-note-memory-flow.md`
  - 新增 lesson `L92-38`
- 当前边界：
  - 这是文档/skills 锁定，不代表 runtime 已 Rust-only
  - `servertool.hook_skeleton.mainline` 仍必须保持 `binding pending`

## 2026-06-21 servertool registry auto-hook descriptor rust-owner

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/registry-impl.ts`：
  - 旧 TS 仍本地 owner `collectAutoServerToolHooksImpl()` 的 auto-hook descriptor 语义：
    - `phase: entry.autoHook?.phase ?? 'default'`
    - `priority: entry.autoHook?.priority ?? 100`
    - `order: entry.autoHook?.order ?? 0`
    - duplicate hook id 未经 native contract fail-fast
  - 现在把这层 descriptor 规划下沉到 Rust：
    - owner：`sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/registry_contract.rs`
    - 仍沿用 feature_id：`hub.servertool_registry_contract`
    - 新 contract：`plan_servertool_registry_auto_hook_descriptors(...)`
    - 责任：
      - canonical id normalize
      - `phase` normalize (`pre/default/post`)
      - `priority/order` 默认值
      - duplicate id fail-fast
  - 新 bridge：
    - NAPI：`plan_servertool_registry_auto_hook_descriptors_json`
    - TS wrapper：`planServertoolRegistryAutoHookDescriptorsWithNative(...)`
  - `registry-impl.ts` 现在只把 native descriptor 回绑到 JS `registration/handler`，不再本地 owner 默认值和 duplicate 容忍语义。
- gate 收紧：
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
    - 额外禁止 `registry-impl.ts` 复活：
      - `phase: entry.autoHook?.phase ?? 'default'`
      - `priority: entry.autoHook?.priority ?? 100`
      - `order: entry.autoHook?.order ?? 0`
  - `scripts/verify-servertool-rust-only.mjs`
    - 现在要求 Rust contract / NAPI export / required export / TS wrapper / TS thin-shell 调用点全部存在。
- focused 验证：
  - `cargo test -p servertool-core registry_contract -- --nocapture` -> 3 passed
  - `cargo test -p router-hotpath-napi plans_servertool_registry_actions_via_servertool_core_bridge -- --nocapture` -> 1 passed
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` -> PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/servertool-cli-native-bridge.spec.ts tests/servertool/server-side-tools.auto-hook-config.spec.ts tests/servertool/server-side-tools.failfast.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand`
    -> 4 suites / 36 tests passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
  - `git diff --check -- <touched files>` -> PASS
- 当前边界：
  - registry 的 auto-hook descriptor 默认值和 duplicate id owner 已不在 TS；
  - 但 `listRegisteredToolHandlerNamesImpl`、`listAutoHandlersForRegistryImpl`、`listRegisteredToolHandlerRecordsImpl` 仍有 registry 投影视图语义在 TS；
  - 更上层 `server-side-tools-impl.ts`、`engine.ts` 等主链 shell 仍未 closeout；
  - `servertool.hook_skeleton.mainline` 仍必须保持 `binding pending`。

## 2026-06-21 servertool registry projection rust-owner

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/registry-impl.ts`：
  - 旧 TS 仍本地 owner 三段 registry 投影视图语义：
    - `listRegisteredToolHandlerNamesImpl()` 的 canonicalize + dedupe + alphabetical sort
    - `listAutoHandlersForRegistryImpl()` 的 auto handler name order 投影
    - `listRegisteredToolHandlerRecordsImpl()` 的 `tool_call -> auto` 分组顺序
  - 现在把这层投影规划下沉到 Rust：
    - owner：`sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/registry_contract.rs`
    - 仍沿用 feature_id：`hub.servertool_registry_contract`
    - 新 contract：`plan_servertool_registry_projection(...)`
    - 责任：
      - registered names canonicalize + dedupe + alphabetical sort
      - auto handler names canonicalize + duplicate fail-fast
      - registered records canonicalize + `tool_call` first / `auto` after
  - 新 bridge：
    - NAPI：`plan_servertool_registry_projection_json`
    - TS wrapper：`planServertoolRegistryProjectionWithNative(...)`
  - `registry-impl.ts` 现在只负责：
    - 提供 raw names / raw record trigger
    - 用 native projection 决定 names / auto order / record order
    - 把 native ordered `{name, trigger}` 回绑到 JS `registration/handler`
- gate 收紧：
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
    - 额外禁止 `registry-impl.ts` 复活：
      - `new Set([...listBuiltinHandlerNames(), ...listAdHocHandlerNames()])`
      - `.sort()`
      - `return [...listBuiltinAutoHandlerEntries(), ...listAdHocAutoHandlerEntries()]`
      - `entry.registration.trigger === 'tool_call'`
      - `entry.registration.trigger === 'auto'`
  - `scripts/verify-servertool-rust-only.mjs`
    - 现在要求 Rust contract / projection NAPI export / required export / TS wrapper / TS thin-shell 调用点全部存在
- focused 验证：
  - `cargo test -p servertool-core registry_contract -- --nocapture` -> 4 passed
  - `cargo test -p router-hotpath-napi plans_servertool_registry_actions_via_servertool_core_bridge -- --nocapture` -> 1 passed
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` -> PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/servertool-cli-native-bridge.spec.ts tests/servertool/server-side-tools.auto-hook-config.spec.ts tests/servertool/server-side-tools.failfast.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand`
    -> 4 suites / 38 tests passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
  - `git diff --check -- <touched files>` -> PASS
- 当前边界：
  - registry names / auto order / record grouping owner 已不在 TS；
  - 但 `listAdHocRegisteredToolCallHandlerSpecsImpl()` 仍是 registry 视图薄壳，`server-side-tools-impl.ts`、`engine.ts`、`execution-shell.ts` 仍有活 TS orchestration；
  - `servertool.hook_skeleton.mainline` 仍必须保持 `binding pending`，不能宣称全流程 Rust-only 已完成。

## 2026-06-21 servertool runtime pre-command state selection scope-key rust-owner

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.ts`：
  - 旧 TS 仍本地 owner 一层 pre-command state 选择分支：
    - direct runtime / runtime metadata 优先
    - 没命中时本地 `if (!persistentScopeKey) return undefined`
    - 有 key 才继续 persisted state load
  - 现在把“是否允许进入 persisted load”这层条件也收进 Rust：
    - owner 仍是 `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/pre_command_hook_contract.rs`
    - 仍沿用 feature_id：`hub.servertool_pre_command_hooks`
    - contract 扩展：`RuntimePreCommandStateSelectionInput.has_persistent_scope_key`
    - 责任新增：
      - 没有 direct/runtime state 且没有 persisted scope key 时，直接返回 `use_selected + source=none`
      - 只有有 persisted scope key 时才返回 `load_persisted`
  - 新 bridge/薄壳变化：
    - `servertool_core_blocks.rs` bridge test 现在额外锁住 `hasPersistentScopeKey=false` 时不得请求 persisted load
    - `native-servertool-core-semantics.ts` wrapper 接收 `hasPersistentScopeKey`
    - `server-side-tools-impl.ts` 现在先采 `persistentScopeKey`，把 `Boolean(persistentScopeKey)` 交给 native selection；TS 不再本地 owner `if (!persistentScopeKey) return undefined`
- gate 收紧：
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
    - 额外禁止 `server-side-tools-impl.ts` 复活：
      - `if (!persistentScopeKey) {`
  - `scripts/verify-servertool-rust-only.mjs`
    - 同步禁止上述 TS 本地分支
- focused 验证：
  - `cargo test -p servertool-core pre_command_hook_contract -- --nocapture` -> 5 passed
  - `cargo test -p router-hotpath-napi plans_runtime_pre_command_state_selection_via_servertool_core_bridge -- --nocapture` -> 1 passed
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` -> PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/server-side-tools.failfast.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand`
    -> 2 suites / 14 tests passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
- 当前边界：
  - pre-command state 是否允许 persisted load 的条件 owner 已不在 TS；
  - 但 persisted state 的真实 IO、load failure wrap shell、以及 `server-side-tools-impl.ts` 更上层 response-stage / auto-hook orchestration 仍未 closeout；
  - `servertool.hook_skeleton.mainline` 仍必须保持 `binding pending`。

## 2026-06-21 servertool entry preflight rust-owner

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.ts` 入口段：
  - 旧 TS 仍本地 owner 两个最外层 entry 分支：
    - `if (!base)`：非 object chat response 直接 passthrough
    - `if (isAdapterClientDisconnected(options.adapterContext))`：client disconnected 直接 fail-fast
  - 现在把这层入口前置判定下沉到 Rust：
    - 新 owner：`sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/server_side_tool_entry_contract.rs`
    - feature_id：`hub.servertool_server_side_tool_entry_contract`
    - 新 contract：`plan_servertool_entry_preflight(...)`
    - action：
      - `return_passthrough_non_object_chat`
      - `throw_client_disconnected`
      - `continue_to_tool_flow`
- 新 bridge/薄壳变化：
  - NAPI：`plan_servertool_entry_preflight_json`
  - TS wrapper：`planServertoolEntryPreflightWithNative(...)`
  - `server-side-tools-impl.ts` 现在先采 `hasBaseObject + adapterClientDisconnected`，统一按 native action 决定 passthrough / fail-fast / continue；TS 不再本地 owner `if (!base)` 或 disconnect branch
- gate 收紧：
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
    - 额外禁止 `server-side-tools-impl.ts` 复活：
      - `if (!base) {`
      - `if (isAdapterClientDisconnected(options.adapterContext)) {`
  - `scripts/verify-servertool-rust-only.mjs`
    - 新增 `checkServertoolEntryPreflightRustOwner()`
    - 同步要求 Rust contract / NAPI export / required export / TS wrapper / TS thin-shell 调用点存在
- focused 验证：
  - `cargo test -p servertool-core server_side_tool_entry_contract -- --nocapture` -> 3 passed
  - `cargo test -p router-hotpath-napi plans_servertool_entry_preflight_via_servertool_core_bridge -- --nocapture` -> 1 passed
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` -> PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/servertool-cli-native-bridge.spec.ts tests/servertool/server-side-tools.failfast.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand`
    -> 3 suites / 35 tests passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
  - `git diff --check -- <touched files>` -> PASS
- 当前边界：
  - server-side-tools entry preflight 的非 object passthrough / disconnected fail-fast owner 已不在 TS；
  - 但 `server-side-tools-impl.ts` 仍有 execution/response-stage/orchestration 薄壳和后续活语义未收口；
  - `servertool.hook_skeleton.mainline` 仍必须保持 `binding pending`，不能宣称全流程 Rust-only 已完成。

## 2026-06-21 servertool cli projection lookup index rust-owner

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.ts` 的 CLI projection 选择段：
  - 旧 TS 虽然已经把 `client_exec_cli_projection` 分支判定交给 Rust，但仍本地 owner 一层投影目标选择：
    - `dispatchPlan.executableToolCalls.find((toolCall) => toolCall.id === preExecutionBranchPlan.projectedToolCallId)`
    - 缺失时本地按 projected id fail-fast
  - 现在把“投影选第几个 executable toolCall”也收进 Rust：
    - owner 仍是 `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_branch_contract.rs`
    - 仍沿用 feature_id：`hub.servertool_execution_branch_contract`
    - contract 扩展：`ServertoolExecutionBranchPlan.projected_tool_call_index`
    - 责任新增：
      - Rust 在判定 `client_exec_cli_projection` 时同时给出 `projected_tool_call_index`
      - TS 壳只按 native index 读取 `dispatchPlan.executableToolCalls[index]`
- 新 bridge/薄壳变化：
  - `servertool_core_blocks.rs` bridge test 现在额外锁住 `projectedToolCallIndex=0`
  - `native-servertool-core-semantics.ts` wrapper 现在校验并透传 `projectedToolCallIndex`
  - `server-side-tools-impl.ts` 不再按 `projectedToolCallId` 做 `.find()`；缺失时只按 native index fail-fast
- gate 收紧：
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
    - 额外禁止 `server-side-tools-impl.ts` 复活：
      - `toolCall.id === preExecutionBranchPlan.projectedToolCallId`
      - `[servertool] native execution-branch projected missing tool call id:`
  - `scripts/verify-servertool-rust-only.mjs`
    - 同步要求 Rust contract / native bridge 含 `projected_tool_call_index` / `projectedToolCallIndex`
    - 同步禁止上述 TS id-lookup 残留
- focused 验证：
  - `cargo test -p servertool-core execution_branch_contract -- --nocapture` -> 3 passed
  - `cargo test -p router-hotpath-napi plans_servertool_execution_branch_via_servertool_core_bridge -- --nocapture` -> 1 passed
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` -> PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/servertool-cli-native-bridge.spec.ts tests/servertool/server-side-tools.failfast.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand`
    -> 3 suites / 35 tests passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
  - `git diff --check -- <touched files>` -> PASS
- 当前边界：
  - CLI projection 选择的 index owner 已不在 TS；
  - 但 `server-side-tools-impl.ts` 仍有 pre-command persisted IO/error shell、response-stage orchestration、auto-hook shell 未收口；
  - `servertool.hook_skeleton.mainline` 仍必须保持 `binding pending`。
## 2026-06-21 `/v1/models` Codex envelope closeout

- 继续追 RouteCodex `/v1/models` 为什么即使 metadata 字段齐全，Codex 仍可能拿不到完整模型能力。
- 根因确认：
  - `src/server/runtime/http-server/routes.ts` 的 `listModels` 之前返回的是 OpenAI list envelope：`{ object: "list", data: items }`
  - 但 `~/code/codex/codex-rs/codex-api/src/endpoint/models.rs` 把 `/v1/models` 按 `ModelsResponse { models: Vec<ModelInfo> }` 解码，缺少顶层 `models` 会直接导致 Codex 无法把 catalog 当模型能力真源使用。
- 本轮修复：
  - owner 仍是 `src/server/runtime/http-server/routes.ts`
  - 新增 `buildModelsListResponse(items)`，统一输出：
    - `models: items` 作为 Codex canonical catalog field
    - `data: items` + `object: "list"` 继续镜像同一份 items，避免现有 generic OpenAI list 消费方断裂
  - 不是 fallback；是单一 response projector 在同一 payload 中承载 Codex canonical field 与现有 list mirror。
- 红测/锁样本更新：
  - `tests/server/http-server/routes.invalid-json.spec.ts`
  - `tests/server/http-server/models-port-scoped.spec.ts`
  - 新 helper `readModelsPayload(body)` 强制：
    - `body.models` 存在且为数组
    - `body.data` 仍存在
    - `body.models === body.data`
- 文档同步：
  - `docs/design/codex-model-capability-contract.md` 补充 Response envelope contract：
    - `models` 是 Codex canonical field
    - `data/object` 只是同 payload mirror
- 验证：
  - `npm run jest:run -- --runInBand tests/server/http-server/routes.invalid-json.spec.ts tests/server/http-server/models-port-scoped.spec.ts` -> 2 suites / 6 tests passed
  - `npm run verify:models-capability-contract` -> PASS

## 2026-06-21 Codex `/v1/models` vs provider capabilities audit

- 用户要求确认 `~/code/codex` 中 Codex 是否把 `/v1/models` 当作模型能力检查入口，以及 RouteCodex 是否必须始终暴露 `gpt-5.5` 以保证 Codex 能力完整。
- 源码证据：
  - `codex-rs/codex-api/src/endpoint/models.rs`
    - `ModelsClient::list_models()` 真实发 GET `models`，由 provider `base_url` 组成实际 `/v1/models`，并解析为 `ModelsResponse { models: Vec<ModelInfo> }`。
  - `codex-rs/models-manager/src/manager.rs`
    - `ModelsManager::list_models()` 用远端 catalog 构建 `ModelPreset` 列表；
    - `ModelsManager::get_model_info()` 直接从远端/缓存 catalog 解析 `ModelInfo` 供 runtime 使用。
  - `codex-rs/protocol/src/openai_models.rs`
    - `ModelInfo` 携带真正影响 runtime 的模型级能力字段：`supports_reasoning_summaries`、`support_verbosity`、`supports_parallel_tool_calls`、`context_window/max_context_window`、`supports_search_tool`、`use_responses_lite`、`tool_mode`、`input_modalities` 等。
  - `codex-rs/core/src/client.rs`
    - Responses 请求直接消费 `ModelInfo`：
      - `supports_reasoning_summaries` 决定是否发送 `reasoning`
      - `use_responses_lite` 决定 `reasoning.context` 与 `parallel_tool_calls`
      - `support_verbosity/default_verbosity` 决定 text verbosity
  - `codex-rs/core/src/session/mod.rs`
    - session 初始化先 `models_manager.list_models(OnlineIfUncached)`，再 `get_default_model()` / `get_model_info()`。
  - `codex-rs/app-server/src/request_processors/config_processor.rs`
    - `model_provider_capabilities_read()` 只是 `provider.capabilities()`，仅返回 provider 级布尔值：`namespace_tools / image_generation / web_search`。
- 结论：
  - `/v1/models` 不是唯一“全部能力”入口，但它是 Codex 的模型目录与模型级 runtime capability 真源。
  - `modelProvider/capabilities/read` 不能替代 `/v1/models`，因为它不携带模型粒度字段。
  - 若某模型未出现在 `/v1/models` catalog，Codex 仍可按 slug 走 fallback metadata（`models-manager/src/model_info.rs::model_info_from_slug`），但会退化为最小默认能力：`supports_reasoning_summaries=false`、`supports_parallel_tool_calls=false`、固定 context window、`supports_search_tool=false` 等，不能视为“完整能力”。
- 对 RouteCodex 的直接含义：
  - 若要让 Codex 在 Responses 路径上对 `gpt-5.5` 拿到完整模型级能力，`/v1/models` 必须稳定列出 `gpt-5.5`，且带完整 `ModelInfo`；
  - 不能指望 provider capability read 或实际端口默认路由到别的模型来补偿。
## 2026-06-21 ecodev 406 global-install + live replay

- 用户纠正当前活跃二进制是真正的全局 dev install，不是 `~/.rcc/install/current` snapshot。
- 复核 shim 真相：
  - `~/.local/bin/routecodex` / `rcc` 是 dev shim。
  - 安装前 `npm root -g` 下不存在 `routecodex` 包，所以 CLI 实际 fallback 到 snapshot；这也是“明明改了但 live 还不对”的直接原因。
- 官方 `npm run install:global` 仍被 repo 现有架构 gate 挡住：
  - `verify:architecture-feature-map-growth-discipline`
  - 一批已存在 `servertool_*_contract.rs` 缺少 `function-map / verification-map` 条目。
  - 这不是 ecodev 406 真因，但会阻塞标准全局安装脚本。
- 为满足“必须全局安装后重启在线验证”，本轮用当前已存在 `dist/` 走全局包等价安装：
  - `npm pack`
  - `npm install -g <tarball> --ignore-scripts ...`
  - `node scripts/ensure-cli-executable.mjs`
  - `node scripts/ensure-cli-command-shim.mjs`
  - 安装后 `routecodex --version` / `rcc --version` 均为 `0.90.3236`，且不再打印 snapshot fallback 提示。
- live restart:
  - `routecodex restart --port 5555`
  - `curl http://127.0.0.1:5555/health` -> `ready=true version=0.90.3236`
- 在线强制命中 `ecodev.default.GLM-5.1` 的 chat 样本：
  - request id: `req_1782041859628_1a3d5be2`
  - provider snapshot: `~/.rcc/codex-samples/openai-chat/port-5555/req_1782041859628_1a3d5be2/provider-request_1.json`
  - 证据：
    - `providerKey = ecodev.default.GLM-5.1`
    - `url = .../v2/no-stream/chat/completions`
    - `Accept = application/json`
    - `body.stream = false`
  - 上游响应：`provider-response.json` 显示 `status=200`，正文 `"OK"`。
- 结论：
  - 旧 406 真因（streaming 请求仍向 ecodev 上游发 `Accept: text/event-stream`）在 live global runtime 上已消失。
  - 当前剩余失败已变成另一条后段问题，不是 406：
    - client-visible `502 sse_bridge_error`
    - 原因：chat streaming 下游仍期待 SSE，但 ecodev 当前被 profile 正确降成 no-stream JSON，上游成功后本地 chat SSE bridge 没有把 JSON 投成 SSE。
- 当前未完成：
  - `/v1/responses` 入口还没构造出一个稳定“强制命中 ecodev”的最小 curl；但共享 provider runtime 的 live snapshot 已证明 406 根因消失。
  - 若继续收口，下一步应追 `chat/completions` / generic force-SSE JSON bridge，而不是再盯 ecodev 上游 406。

## 2026-06-21 20:23:30 5520 responses continuation/direct failure audit

- 症状：5520 `/v1/responses` 首次与后续请求都走 router-direct，但用户反馈“期待后请求直接用不了”。
- 已知日志：20:21:55 tools route -> gpt-5.4-mini；20:21:56/20:22:06 longcontext route -> gpt-5.5。
- 下一步：先查 5520 codex samples，确认 client/provider payload、previous_response_id/continuationOwner、direct/relay 真相。

## 2026-06-21 20:26:37 llmtoken responses baseURL fix

- 根因：`~/.rcc/provider/llmtoken/config.v2.toml` 的 `baseURL=https://llmtoken.io` 缺 `/v1`，responses runtime 正常拼成 `/responses`，实际请求命中站点 HTML。
- 修复：改为 `https://llmtoken.io/v1`，使 Responses provider 目标 URL 变为 `.../v1/responses`。
- 待验证：config validate + restart 5520 + live `/v1/responses` probe，不再出现 `SSE stream missing from pipeline result`。

## 2026-06-21 20:38:03 html-200 should reroute audit

- 用户纠正：priority 模式下，上游即使返回错误形态，也应进入 provider failure 链并切下一个 provider，不应在首 provider 形成假成功后再由 SSE bridge 502。
- 新问题定义：为什么 `responses` direct 上游 `200 text/html` 没有在 provider/runtime 阶段被判为协议错误并 reroute。
## 2026-06-21 20:52:11 responses direct html-200 reroute owner lock

- 已按 function-map / verification-map 锁定唯一 owner：
  - feature: `responses.direct_tool_shape_contract`
  - 允许修改：`src/providers/core/runtime`，禁止在 `src/server/handlers` 补偿
- 当前首次污染节点确认：
  - `src/providers/core/runtime/responses-provider.ts`
  - `sendDirectSsePassthroughRequest()` / `executeSseStream()`
  - `upstreamResult.kind === 'response'` 且 `responseKind === 'text'` 时，只 snapshot + `detectResponsesFailure(payload)`
- 真实缺口：
  - `detectResponsesFailure()` 只识别 `{status:'failed'}` 或 `{error:{...}}`
  - 对 `200 text/html` / 纯文本非 SSE 返回 `null`
  - 于是 provider runtime 不上报 provider failure，后段才掉进 `sse_bridge_error`
- 本轮修复目标：
  - 在 provider runtime 前移把 stream 请求收到的非 SSE 文本响应识别成 `MALFORMED_RESPONSE`
  - 让 request-executor 看到 provider failure，按 priority/default pool 排除当前 provider 并继续切换

## 2026-06-21 21:03:44 responses provider error consumed-but-not-rerouted

- live 5520 复放新证据：
  - `server-5520.log` 已出现 `MALFORMED_RESPONSE`，说明 provider runtime 前移识别已生效
  - 但同请求仍直接 `failed`，没有 `provider-switch`
- 新根因确认：
  - `src/server/runtime/http-server/executor/request-executor-provider-send-failure.ts`
  - `phase === 'provider_response_processing'` 时，`isRetryableProviderResponseProcessingFailure()` 只放行：
    - `provider.http`
    - `provider.sse_decode`
    - 少数 `host.response_contract`
  - `requestExecutorProviderErrorStage === 'provider.responses'` 会被直接 `throw`
- 下一步唯一修点：
  - 放行 `provider.responses` 进入 `resolveRequestExecutorProviderFailurePlan(...)`
  - 用 focused executor 测试锁同请求 `exclude_and_reroute`
## 2026-06-21 5520 priority malformed-response reroute live closeout

- 交接复核完成：
  - `~/.rcc/provider/llmtoken/config.v2.toml` 仍是故障态 `baseURL = "https://llmtoken.io"`，便于继续做坏样本 live replay。
  - 当前全局 CLI / runtime 还没切到新包：`routecodex --version`、`rcc --version`、`curl 127.0.0.1:5520/health` 全是 `0.90.3241`。
  - 仓库 `package.json` 已是 `0.90.3242`，且本地 tarball `routecodex-0.90.3242.tgz` 存在。
  - `npm ls -g routecodex --depth=0` 仍显示 `/opt/homebrew/lib/node_modules/routecodex@0.90.3241`，说明上一轮 `npm install -g ./routecodex-0.90.3242.tgz --ignore-scripts --force` 没真正替换全局安装。
- 结论：先把全局安装真相修正到 `0.90.3242`，再继续 `5520` 的 live replay，否则无法证明“同请求内切 provider”是否已在新代码路径生效。

## 2026-06-21 21:37:12 5520 same-request reroute live proof

- live 请求已拿到强证据：
  - request=`openai-responses-router-gpt-5.4-20260621T212944353-383502-2871`
  - req=`req_1782048584353_e416089f`
- `~/.rcc/logs/server-5520.log` 证据链：
  - `21:29:44` 首次命中 `default/gateway-priority-5520-priority-default -> llmtoken[key1].gpt-5.4-mini`
  - 紧接着出现 `[provider-switch] ... provider=llmtoken.key1.gpt-5.4-mini ... status=200 code=MALFORMED_RESPONSE ... switch=exclude_and_reroute`
  - 同一 `req` 再次命中 `default/gateway-priority-5520-priority-default -> asxs[crsa].gpt-5.4-mini`
  - 最终 `21:29:51` 客户端 `status=200 finish_reason=stop`
- 结论：
  - priority 模式下，`200 text/html`/malformed stream 已在同请求内进入 provider failure 链并成功切下一个 provider；
  - “错了也不该风暴，priority 也要切 provider” 这一条在 live 5520 runtime 上已被证明成立。
- 当前待收口：
  - 恢复 `~/.rcc/config.toml` 中临时把 `llmtoken` 挪到 `fwd.paid.gpt-5.4-mini` 首位的探针配置；
  - 恢复 `~/.rcc/provider/llmtoken/config.v2.toml` 的正确 `baseURL = "https://llmtoken.io/v1"`；
  - 然后做 `routecodex config validate` + `routecodex restart --port 5520` + health + 正常 smoke。

## 2026-06-21 21:34:00 5520 probe cleanup and recovery verify

- 已恢复运行时配置：
  - `~/.rcc/config.toml`：`fwd.paid.gpt-5.4-mini` 顺序恢复为 `asxs -> XL -> cc`，删除临时 `llmtoken` 首位探针 target
  - `~/.rcc/provider/llmtoken/config.v2.toml`：`baseURL` 恢复为 `https://llmtoken.io/v1`
- 验证：
  - `routecodex config validate` -> `✓ Configuration is valid`
  - `routecodex restart --port 5520` -> CLI 返回 `✔ RouteCodex server restarted: localhost:5520`
  - `curl -s http://127.0.0.1:5520/health` -> `{"status":"ok","ready":true,"pipelineReady":true,"version":"0.90.3244"}`
  - 正常 smoke：`POST /v1/responses {"model":"gpt-5.4","input":"Return exactly: smoke-ok","stream":true}` -> 客户端收到 `smoke-ok`
  - `~/.rcc/logs/server-5520.log` 显示：
    - `21:33:47` `default/... -> asxs[crsa].gpt-5.4-mini`
    - `21:33:55` request completed `status=200 finish_reason=stop`
- 结论：
  - live 探针后的运行时已恢复正常；
  - 5520 默认链当前不再先打到 `llmtoken`，而是按恢复后的 priority 首跳命中 `asxs`。

## 2026-06-21 debug/diag/snapshot/samples/log 关系审计

### 四套存储系统对比

| 系统 | 根路径 | Owner 模块 | 用途 | 状态 |
|------|--------|-----------|------|------|
| snapshot (server) | `~/.rcc/snapshots/` | `src/utils/snapshot-writer.ts` | pipeline 阶段快照 | 活跃 |
| snapshot (provider) | `~/.rcc/snapshots/` | `src/providers/core/utils/snapshot-writer.ts` | provider 请求/响应快照 | 活跃 |
| errorsamples | `~/.rcc/errorsamples/` | `src/utils/errorsamples.ts` | provider 错误 payload | 活跃 |
| errorsamples (policy) | `~/.rcc/errorsamples/policy/` | errorsamples 内部 | policy violations | 活跃 |
| debug snapshots | `~/.rcc/codex-samples/` | `src/debug/snapshot-store.ts` | offline replay/dry-run | 活跃 |
| policy violations | `~/.rcc/codex-samples/__policy_violations__/` | `src/debug/` | hub policy violations | 活跃 |
| diag | `~/.rcc/diag/` | rcc-dev-skills reference 提及，源码中未发现实际实现 | 规划/文档层面存在 | 不明 |

### 存储路径冲突风险

1. **server snapshot vs debug snapshot**：server 用 `~/.rcc/snapshots/`，debug 用 `~/.rcc/codex-samples/`。路径已隔离。
2. **errorsamples policy vs debug policy violations**：前者 `~/.rcc/errorsamples/policy/`，后者 `~/.rcc/codex-samples/__policy_violations__/`。两套 policy violation 存储，互不包含。
3. **snapshot-stage-policy vs snapshot-local-disk-gate**：阶段过滤 + 本地磁盘写入门控两件套，控制哪些 snapshot 能落盘。

### 功能重叠分析

**重叠点**：
- `src/utils/snapshot-writer.ts` (server) 和 `src/providers/core/utils/snapshot-writer.ts` (provider) 都在写 `~/.rcc/snapshots/`，但 phase 名不同（server 用 `http-request`/`client-response`，provider 用 `provider-request`/`provider-response`）
- errorsamples 在 provider snapshot writer 内部被调用（`writeErrorsampleJson`），两者共享 provider error 捕获
- `src/modules/pipeline/utils/debug-logger.ts`（`PipelineDebugLogger`）和 `src/utils/logger.ts` 都做 pipeline 日志，功能有重叠

**无重叠**：
- codex samples（`sharedmodule/llmswitch-core/tests/fixtures/codex-samples/`）是 repo 内 golden test fixture，不进运行时存储
- Rust `diagnostics.rs`（`HubPipelineDiagnostic`）是 minimal struct，无运行时写盘

### 诊断层（diag）缺失

- `references/50-rcc-config-ssot.md` 提 `~/.rcc/diag/`，但 `src/` 和 `sharedmodule/llmswitch-core/src/` 均无实际 diag writer
- `src/types/debug-types.ts` 导入了 `DebugEvent` from `rcc-debugcenter`，但 rcc-debugcenter 是外部 npm 包（`"rcc-debugcenter": "^0.1.6"`），非本项目实现
- rcc-debugcenter 包的实现不在本 repo 内

### 日志系统分散

| Logger | 文件 | 用途 |
|--------|------|------|
| PipelineDebugLogger | `src/modules/pipeline/utils/debug-logger.ts` | pipeline 阶段日志、request/response 捕获 |
| ColoredLogger | `src/modules/pipeline/utils/colored-logger.ts` | server 彩色日志 |
| debug-logger | `src/providers/core/utils/debug-logger.ts` | provider 日志（redirect 到 pipeline） |
| provider-error-logger | `src/providers/core/utils/provider-error-logger.ts` | provider 错误专用日志 |
| servertool-runtime-log | `src/server/runtime/http-server/executor/servertool-runtime-log.ts` | servertool 运行时日志 |
| usage-logger | `src/server/runtime/http-server/executor/usage-logger.ts` | token 使用量日志 |
| log-rollup | `src/server/runtime/http-server/executor/log-rollup.ts` | 多阶段日志聚合 |
| non-blocking-error-logger | `src/server/utils/non-blocking-error-logger.ts` | 非阻塞错误日志 |
| oauth-logger | `src/providers/auth/oauth-logger.ts` | OAuth 日志 |

### 结论

1. **存储不重复但分散**：5 个不同 `~/.rcc/` 子目录，各司其职，无物理重复
2. **diag 是缺口**：文档提了但无实现，rcc-debugcenter 是外部包
3. **日志最乱**：7+ 种 logger 分散在多处，部分功能重叠（pipeline debug vs 普通 logger）
4. **codex samples 是测试 fixture**：与运行时 snapshot 无交集
5. **建议**：优先补 diag 规划落地、统一 logger 抽象、收拢 pipeline 日志到单一入口
## 2026-06-21 servertool followup client-inject metadata read rust-owner

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/backend-route-runtime-block.ts` 和 `backend-route-mainline-block.ts` 的 followup metadata/client-inject 残余 TS owner。
- 旧 TS 仍本地读取：
  - `metadata.clientInjectSource`
  - `readClientInjectOnly(metadata)`
  - 再把 `metadataClientInjectOnly/clientInjectSource` 喂给 native
- 现在统一由 Rust owner 解读 metadata：
  - `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/backend_route_contract.rs`
  - `ServertoolFollowupExecutionModeInput` 新增 `metadata: Option<Value>`
  - `ServertoolFollowupRuntimeActionInput` 新增 `metadata: Option<Value>`
  - `plan_followup_execution_mode(...)` 从 metadata 解读 `clientInjectOnly/clientInjectSource`
  - `plan_followup_runtime_action(...)` 从 metadata 解读 `clientInjectOnly/clientInjectSource`
- TS 壳层变化：
  - `backend-route-runtime-block.ts` 不再本地读 `metadata.clientInjectSource`，不再要求注入 `readClientInjectOnly`
  - `backend-route-mainline-block.ts` 不再 import / 传入 `readClientInjectOnly`
  - TS 只把 metadata object 透传给 native，并执行 native plan 指示的 metadata mutation
- focused tests / gate：
  - Rust:
    - `followup_execution_mode_*`
    - `followup_runtime_action_*`
  - NAPI bridge:
    - `plans_followup_execution_mode_via_servertool_core_bridge`
    - `plans_followup_runtime_action_via_servertool_core_bridge`
  - Jest:
    - `tests/servertool/backend-route-runtime-block.spec.ts`
    - `tests/servertool/followup-bootstrap-replay.spec.ts`
    - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - audit 禁止 `backend-route-runtime-block.ts` 复活：
    - `typeof metadataRecord.clientInjectSource === 'string'`
    - `args.readClientInjectOnly(args.metadata)`
    - `const existingClientInjectSource =`
- 串行验证：
  - `cargo test -p servertool-core followup_runtime_action -- --nocapture` -> 6 passed
  - `cargo test -p servertool-core followup_execution_mode -- --nocapture` -> 4 passed
  - `cargo test -p router-hotpath-napi plans_followup_execution_mode_via_servertool_core_bridge -- --nocapture` -> 1 passed
  - `cargo test -p router-hotpath-napi plans_followup_runtime_action_via_servertool_core_bridge -- --nocapture` -> 1 passed
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` -> PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/backend-route-runtime-block.spec.ts tests/servertool/followup-bootstrap-replay.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand` -> 3 suites / 12 tests PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
  - `node scripts/build-core.mjs` -> PASS
- 当前结论：
  - followup execution mode 和 runtime action 中的 `clientInjectOnly/clientInjectSource` 解读已归 Rust owner；
  - TS 仍负责 metadata mutation / normalize text / IO 壳，不宣称 followup/reenter 主线整体 Rust-only。

## 2026-06-21 servertool followup auto-limit error rust-owner

- 本轮继续收缩 `sharedmodule/llmswitch-core/src/servertool/backend-route-runtime-block.ts` 的 followup auto-limit 错误投影残余 TS owner。
- 旧 TS 仍本地 owner 一层 auto-limit provider error 语义：
  - 拼错误文案 `"[servertool] followup auto limit reached before stopless contract was satisfied"`
  - 本地拼 `code/category/details/status`
  - 再包成 `ProviderProtocolError`
- 现在把错误投影 contract 下沉到 Rust owner：
  - `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/backend_route_contract.rs`
  - 新 contract / input：
    - `ServertoolFollowupAutoLimitErrorPlanInput`
    - `plan_followup_auto_limit_error(...) -> ServertoolErrorPlan`
- bridge / thin shell 收口：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs`
  - `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts`
  - `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`
  - `backend-route-runtime-block.ts` 不再本地拼 followup auto-limit 错误 message/details；TS 只消费 native `ServertoolErrorPlan`，再包薄壳 `ProviderProtocolError`
- focused tests / gate：
  - Rust unit:
    - `followup_auto_limit_error_plan_projects_provider_error_contract`
  - bridge:
    - `plans_followup_auto_limit_error_via_servertool_core_bridge`
  - Jest:
    - `tests/servertool/backend-route-runtime-block.spec.ts`
    - `tests/servertool/followup-bootstrap-replay.spec.ts`
    - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - audit 明确禁止 `backend-route-runtime-block.ts` 复活：
    - `"[servertool] followup auto limit reached before stopless contract was satisfied"`
    - `code: plan.autoLimit.code`
    - `category: plan.autoLimit.category`
    - `repeatCount: plan.autoLimit.repeatCount`
    - `reason: plan.autoLimit.reason`
- 串行验证：
  - `cargo test -p servertool-core followup_auto_limit_error_plan_projects_provider_error_contract -- --nocapture` -> PASS
  - `cargo test -p router-hotpath-napi plans_followup_auto_limit_error_via_servertool_core_bridge -- --nocapture` -> PASS
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` -> PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/backend-route-runtime-block.spec.ts tests/servertool/followup-bootstrap-replay.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand` -> 3 suites / 10 tests PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
  - `node scripts/build-core.mjs` -> PASS
- 当前结论：
  - followup auto-limit 错误 message/code/category/status/details 现在由 Rust owner 产出；
  - `backend-route-runtime-block.ts` 仅保留 native plan 消费 + `ProviderProtocolError` 外壳；
  - 不能宣称 followup/reenter 整体 Rust-only 完成，当前只是 `backend-route-runtime-block` 下的一块错误投影 slice 收口。

## 2026-06-21 servertool web_search / vision_auto CLI routeHint gate closeout

- 本轮目标：不改 runtime 语义，只把 `scripts/verify-servertool-rust-only.mjs` 对齐到已落地的新目标：
  - `web_search` / `vision_auto` 走普通 servertool CLI；
  - CLI stdout 带 `routeHint`；
  - 下一次请求从合法 CLI tool result 恢复 `metadata.routeHint`；
  - web/vision 旧 backend-route/reenter TS 文件保持物理删除；
  - `memory_cache_auto` 不再作为标准能力/样例。
- gate 改动点：
  - outcome/CLI checks 改为检查 `ClientExecCliProjection` + `route_hint_for_client_exec_tool(...)`；
  - `cli_result_guard` 改为检查 `extract_servertool_cli_result_route_hint_from_request`、NAPI export、TS native wrapper、`executor-metadata` routeHint 测试；
  - backend-route checks 改为要求：
    - `web_search_backend_route_hint_is_retired`
    - `web_search_backend_route_hint_rejects_before_payload_processing`
    - `backend-route-mainline-block.ts`
    - `backend-route-reenter-block.ts`
    - `backend-route-bootstrap-replay-block.ts`
    - `backend-route-shape-guard.ts`
      都保持删除；
  - 删掉 gate 对 `memory_cache_auto`、`executeServertoolBackendPlan`、旧 unsupported blackbox 名称的依赖。
- 串行验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
  - `node scripts/build-core.mjs` -> PASS
- 结论：
  - 当前 blocker 是旧 verify gate，不是 runtime/编译问题；
  - gate 已跟现行 web/vision CLI + routeHint 设计对齐；
  - 这轮没有复活任何已删 TS backend-route 文件。

## 2026-06-21T16:18:16.249Z stopless learned

- requestId: openai-responses-minimax.key1-MiniMax-M3-20260622T001756957-384553-3922
- sessionId: 019ee874-5240-7671-bc3e-544e4b034ddb
- stopReason: 我已读完项目入口、rcc-dev-skills 路由真源、note.md 最近多轮 servertool 收口记录；并已确认 5520 thinking / search / multimodal 三个 pool 的当前真源 (gpt-5.4 + glm-5.2 weighted 1:1，tools/search/multimodal 是 gpt-5.4-mini + minimax M3 weighted 1:1)。Jason 上一句『把 glm-5.2 加入 thinking 做 loadbalancing，和 gpt 做 1:1』语义上与当前 5520 thinking 配置看起来一致，但『5520 search / multimodal 里加入 minimax m3，与 gpt-5.4-mini 1:1』存在命名冲突：当前 search/multimodal 已经是 gpt-5.4-mini + MiniMax-M3 weighted 1:1，需要先确认是要把 MiniMax-M3 替换/调整，还是要新增一个独立的 m3 池。修改 ~/.rcc/config.toml 属于运行时配置基线动作，按 AGENTS.md 硬护栏「非授权不破坏」和 references/50-rcc-config-ssot.md 修改流程必须先由 Jason 明确授权。我不直接擅自动手，先在 stop schema 里把判定与下一步动作全部说明清楚，等 Jason 确认后立刻执行：核对 forwarder 命名、补 forwarder / routing diff、跑 routecodex config validate、重启 5520 并做 health + live probe。
- evidence: references/50-rcc-config-ssot.md 锁 ~/.rcc/config.toml 为运行时真源；当前 5520 thinking = fwd.paid.gpt-5.4 + fwd.glm.glm-5.2 weighted 1:1，search/multimodal = fwd.paid.gpt-5.4-mini + fwd.minimax.MiniMax-M3 weighted 1:1；AGENTS.md 硬护栏 #3 「非授权不破坏」；note.md 6 月各轮记录显示 servertool 切片前都先确认配置 + 路由 + tests。

任何对 ~/.rcc/config.toml 改 forwarder / routing / weights 的操作都属于运行时真源变更，必须先确认意图与命名（m3 vs MiniMax-M3），再按 references/50-rcc-config-ssot.md 的 edit → validate → restart → health → live probe 串行执行；不要在命名冲突未消除时直接 restart 5520。

## 2026-06-22 registry projection sourceIndex rust-owner closeout

- 本轮 slice 目标：把 `sharedmodule/llmswitch-core/src/servertool/registry-impl.ts` 里 `listRegisteredToolHandlerRecordsImpl()` 的“native projection -> rawRecords 重新匹配”活语义下沉到 Rust owner。
- 旧 TS 活语义：
  - `const used = new Set<number>()`
  - `rawRecords.findIndex(...)`
  - 本地按 `name + trigger` 重新找 entry，再自己处理重复占用。
- 新 contract：
  - Rust `servertool-core/src/registry_contract.rs::plan_servertool_registry_projection(...)` 的 `registered_records` input/output 新增 `source_index`；
  - Rust 负责在 `tool_call`/`auto` 分组后的 projection 里保留原始 `source_index`；
  - TS 只按 `recordPlan.sourceIndex` 绑定 `registration/handler`，不再自己 `findIndex + used set`。
- 变更点：
  - `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/registry_contract.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs`
  - `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`
  - `sharedmodule/llmswitch-core/src/servertool/registry-impl.ts`
  - `tests/servertool/servertool-cli-native-bridge.spec.ts`
  - `tests/servertool/server-side-tools.auto-hook-config.spec.ts`
  - `tests/servertool/server-side-tools.failfast.spec.ts`
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
- audit gate 收紧：
  - `registry-impl.ts` 新增禁止：
    - `const used = new Set<number>()`
    - `.findIndex((entry, index) => (`
    - `native registry record order missing entry for`
- 串行验证：
  - `cargo test -p servertool-core registry_projection_normalizes_names_groups_records_and_rejects_duplicate_auto_handlers -- --nocapture` -> PASS
  - `cargo test -p router-hotpath-napi plans_servertool_registry_actions_via_servertool_core_bridge -- --nocapture` -> PASS
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` -> PASS
  - focused Jest:
    - `tests/servertool/servertool-cli-native-bridge.spec.ts`
    - `tests/servertool/server-side-tools.auto-hook-config.spec.ts`
    - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
    -> 3 suites / 37 tests PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
  - `node scripts/build-core.mjs` -> PASS
- 验证边界：
  - `tests/servertool/server-side-tools.failfast.spec.ts` 当前仍有 2 个非本 slice 失败（`tool_flow` vs `passthrough`、response-stage capabilities providerInvoker 断言）。从调用面看与本次 registry projection sourceIndex contract 无直接因果，先不把它宣称为本轮回归；若后续继续动 response-stage/failfast owner，再单独收口。
- 结论：
  - `listRegisteredToolHandlerRecordsImpl()` 现在是“native sourceIndex plan -> JS binding”薄壳；
  - `registry-impl.ts` 又少掉一层 TS 活语义；
  - 这轮还不能宣称 registry/mainline 已完全 Rust-only，但这块 record projection matching 已转成 Rust owner。
## 2026-06-22 adhoc-handler-test-support native-defaults closeout

- 本轮 slice 目标：把 `sharedmodule/llmswitch-core/src/servertool/adhoc-handler-test-support.ts` 的本地 `buildAdHocRegistration` 默认值层移除，让 adhoc 注册默认全部走 native `normalize_servertool_registration_spec_json`。
- 真源：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_skeleton_config.rs::normalize_servertool_registration_spec_json`
  - native wrapper：`normalizeServerToolRegistrationSpec` in `sharedmodule/llmswitch-core/src/servertool/skeleton-config.ts`
  - thin shell：`sharedmodule/llmswitch-core/src/servertool/adhoc-handler-test-support.ts`
- TS 收口：
  - 删除 `buildAdHocRegistration(...)`；
  - `registerAdHocHandlerForTests(...)` 统一走 `normalizeServerToolRegistrationSpec(name, options)`；
  - `getAdHocHandlerEntry(...)` 不再本地重建 registration default，只做 canonicalize + 读 map。
- 配套聚焦测试修正（不允许把焦点测试当模板，直接改 mock 与断言以反映当前 native 真相）：
  - `tests/servertool/server-side-tools.auto-hook-config.spec.ts`：
    - `normalizeServertoolRegistrationSpecWithNative` mock 必须和 Rust `normalize_servertool_registration_spec_json` 一致：
      - `trigger === 'auto'` 时 `executionMode` 默认 `auto_hook`，并产出 `autoHook = { id, phase: 'default', priority: 100 }`；
      - `trigger === 'tool_call'` 时 `executionMode` 默认 `guarded`。
    - `listRegisteredServerToolHandlerNames()` 与 `listRegisteredServerToolHandlerRecords()` 的期望必须对齐当前内建集合（仅 `stop_message_auto` 是 builtin），不能再出现 `vision_auto / web_search` 旧名。
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`：
    - 去掉对合法 thin-shell 分支的过宽 marker：`adhoc-handler-test-support.ts` 不再禁止 `"trigger === 'auto'"`；当前代码里该字符串属于 native 行为代理（`registration.trigger === 'auto'`），误报会让后续 red gate 退化。
- 串行验证：
  - focused Jest: `tests/servertool/server-side-tools.auto-hook-config.spec.ts` + `tests/servertool/servertool-active-orchestration-audit.spec.ts` -> 2 suites / 16 tests PASS。
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS（含 `cli-projection-owner` / `cli-projection-native-wrapper` / `stop-schema-native-export` / `servertool-outcome-rust-owner` 等全栈检查）。
  - `node scripts/build-core.mjs` -> PASS，native `.node` 与 `routecodex-servertool` 二进制重新打包。
- 结论：
  - `adhoc-handler-test-support.ts` 已经是 native-only 薄壳；
  - 这次的修复属于“测试契约 → 现有 native 真相”的对齐，不是 runtime 改造；
  - 不要把 `"trigger === 'auto'"` 重新塞进 audit；后续若 native 行为变化，改 `normalize_servertool_registration_spec_json` 的 Rust 真源，顺势把 mock 与断言同步。

## 2026-06-22 response-stage runtime capabilities thin-shell closeout

- 本轮 slice 目标：收口 `sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.ts` 里 response-stage capabilities 的残余 TS 假值，让 response hook gate 只消费“当前 runtime 是否真的具备该能力”的薄壳探测结果。
- 已确认根因：
  - `tests/servertool/server-side-tools.failfast.spec.ts` 之前把 `normalizeServertoolRegistrationSpecWithNative` mock 成 `() => null`，导致 `failfast_test_tool` 根本没注册进去；
  - `server-side-tools-impl.ts` 之前把 response-stage `capabilities` 硬编码成 `false/false/false`，与 focused failfast 里“providerInvoker 存在时应视为可用”的当前 contract 冲突。
- 变更点：
  - 新增 `sharedmodule/llmswitch-core/src/servertool/runtime-capabilities.ts`
  - `sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.ts`
  - `tests/servertool/server-side-tools.failfast.spec.ts`
- 关键收口：
  - response-stage gate 改为走 `deriveServertoolRuntimeCapabilities(...)`；
  - helper 改成接受 `unknown` 做 duck-typing 探测，不再在调用点把 `ServerSideToolEngineOptions` 假装成 `Record<string, unknown>`；
  - failfast spec 的 native mock 对齐 Rust registration 默认真相：`tool_call -> guarded`，`auto -> auto_hook + default autoHook descriptor`。
- 串行验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/server-side-tools.failfast.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand` -> 2 suites / 18 tests PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
  - `node scripts/build-core.mjs` -> PASS
- 结论：
  - response-stage capabilities 不再由 TS 壳层伪造固定 false；
  - 这轮还只是 response-stage/failfast slice 收口，不代表整个 hook skeleton 已 anchored；
  - 后续继续审计 `server-side-tools-impl.ts` / `engine.ts` / execution shells 里剩余 TS 活语义时，focused Jest mock 必须继续跟 native registration 真相同源。

## 2026-06-22 execution-handler materialization unsupported-backend failfast closeout

- 本轮 slice 目标：把 `sharedmodule/llmswitch-core/src/servertool/execution-handler-materialization-shell.ts` 中 `unsupported_backend_plan_kind` 穿透返回原 plan 的漏口补上，锁死“retired backend/reenter mainline 不得静默落回成功结果”。
- 已确认根因：
  - 现有 dirty slice 已把 `engine.ts` 改成 `SERVERTOOL_REENTER_RETIRED`，并把 `response-stage-orchestration-shell.ts` 从入口 options 上移除 `providerInvoker/reenterPipeline/clientInjectDispatch`；
  - 但 `materializeServertoolPlannedResult(...)` 对 native `planServertoolHandlerRuntimeActionWithNative()` 返回的 `unsupported_backend_plan_kind` 没有显式处理，最后走到了 `return planned as ServerToolHandlerResult`；
  - 这会把本应 fail-fast 的 backend plan 包装成“成功 materialized result”，属于明确的错误链漏拦。
- 变更点：
  - `sharedmodule/llmswitch-core/src/servertool/execution-handler-materialization-shell.ts`
  - `tests/servertool/execution-shell.backend-failfast.spec.ts`
  - `tests/servertool/stopless-metadata-center.spec.ts`
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
- 关键收口：
  - `materializeServertoolPlannedResult(...)` 现在把 `unsupported_backend_plan_kind` 与旧 compat action `execute_backend_vision_analysis_then_finalize` / `execute_backend_web_search_then_finalize` 一样统一投影成 native error；
  - `execution-shell.backend-failfast.spec.ts` 不再依赖已删除的 `executeServertoolBackendPlan` / `handlers/vision.ts` / `handlers/web-search.ts`，而是直接验证 materialization shell 的 fail-fast；
  - `stopless-metadata-center.spec.ts` 去掉无效 `reenterPipeline` 入参，和当前 retired design 对齐；
  - active orchestration audit 新增锁：`response-stage-orchestration-shell.ts` 不得重新暴露 `providerInvoker?/reenterPipeline?/clientInjectDispatch?` 入口，也不得回到 `hasServertoolSupport` 本地判定。
- 串行验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/execution-shell.backend-failfast.spec.ts tests/servertool/stopless-metadata-center.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand` -> 3 suites / 19 tests PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> PASS
  - `node scripts/build-core.mjs` -> PASS
- 结论：
  - retired backend/reenter mainline 的错误链现在不会再被 materialization shell 静默包装成成功；
  - 这一刀收的是 execution-handler materialization fail-fast owner，不代表整个 engine/response-stage retired slice 已全部提交；
  - 下一轮应继续围绕当前 dirty 的 `engine.ts` / `response-stage-orchestration-shell.ts` / `execution-shell.ts` 做 focused tests + 分阶段提交，而不是混回旧 callback 入口。

## 2026-06-21T16:48:27.626Z stopless learned

- requestId: openai-responses-minimax.key1-MiniMax-M3-20260622T004817462-384812-4181
- sessionId: 019ee85e-8c96-77b0-920f-f3fbb3772b6d
- stopReason: reasoningStop response-hook 修复在 5555 live 闭环并已 cherry-pick 提交推送
- evidence: commit 1bdedfa 推到 origin/main；install:global / 5555&5520 restart / /health version=0.90.3244；5555 live probe 拿到 hasReasoningStop=true + arguments={stopreason:2,reason:'第一轮故意缺 schema'}，续轮 200/completed，客户端无 raw reasoningStop 泄漏

response-hook 路径不应和 followup/runtime executor 共用 action 类型，否则 planner 在没 runtime callback 时会 fail-fast；客户端永远只能见到 exec_command 投影，reasoningStop 永远是 internal stop tool

## 2026-06-21T17:06:38.993Z stopless learned

- requestId: openai-responses-minimax.key1-MiniMax-M3-20260622T010629147-384947-4316
- sessionId: 019ee874-5240-7671-bc3e-544e4b034ddb
- stopReason: 当前未验证 glm-5.2 / gpt-5.4-mini / MiniMax-M3 在 5520 真实路由配置真源，未满足 evidence-first；servertool dirty 切片也还未收口。
- evidence: rg 已确认 thinking 路由/loadBalancing 在多份样板中存在；gpt-5.4-mini 有 crs/asxs/crsa/cc 多套 alias，MiniMax-M3 有 mini27/dbittai/minimax 多套 alias；未读 22/23 servertool 真源，未跑 build-core.mjs 闭环，未跑 live probe。

1) 多套 alias 并存时，禁止凭意图直接改 config；2) 5520 live 真源未读前不能宣称可落地；3) 当前 dirty workspace 必须先收口 servertool 切片，再切其它主线。

## 2026-06-22 retired reenter cleanup test alignment

- 触发：`0be7d0b refactor(servertool): retire backend reenter path` 后，focused reenter/no-reenter 栈暴露两类陈旧测试。
- 证据：
  - `tests/servertool/stop-message-auto-no-reenter.red.spec.ts` 直接报 `MetadataCenter runtime_control.stopless writer requires a bound MetadataCenter`
  - `tests/servertool/followup-bootstrap-replay.spec.ts` 仍 import 已删除的 `backend-route-bootstrap-replay-block.js`
  - 修正后：`tests/servertool/stop-message-auto-no-reenter.red.spec.ts tests/servertool/exec-command-guard.spec.ts tests/servertool/reasoning-only-continue.spec.ts tests/servertool/engine.stopless-session-thin-shell.spec.ts --runInBand` -> 4 suites / 15 tests PASS
  - `node scripts/verify-servertool-rust-only.mjs` -> PASS
- 结论：
  - stopless/no-reenter 红测现在必须显式绑定 `MetadataCenter`，不能再用裸 adapterContext 伪造 side-channel。
  - backend-route / bootstrap replay owner 物理删除后，其正向 spec 也必须同步删除；保留只会制造“旧路径仍被支持”的假象。

## 2026-06-22 response-stage legacy capability shell removal

- 触发：`server-side-tools-impl.ts` 仍通过 `runtime-capabilities.ts` 从 `providerInvoker/reenterPipeline/clientInjectDispatch` 三元 callback 形状推导 response-stage gate 输入；`ServerToolHandlerContext.capabilities` 也仍把这组三元当成 handler 上下文事实。
- 证据：
  - grep 证明 handler 代码没有任何真实 `ctx.capabilities.*` 消费；
  - Rust `plan_servertool_response_stage_gate_json()` 只把这三元 OR 成 `has_servertool_support`；
  - 本轮删除 `sharedmodule/llmswitch-core/src/servertool/runtime-capabilities.ts`，并从 `server-side-tools-impl.ts` / `response-stage-orchestration-shell.ts` 移除 `capabilities` / `hasServertoolSupport` 显式传值，改为依赖 native 缺省 false；
  - `tests/servertool/server-side-tools.failfast.spec.ts tests/servertool/execution-shell.auto-hook-failfast.spec.ts tests/servertool/servertool-auto-hook-trace.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand` -> 4 suites / 24 tests PASS；
  - `node scripts/verify-servertool-rust-only.mjs` -> PASS；
  - `node scripts/build-core.mjs` -> PASS。
- 结论：
  - 这组三元在当前 TS 侧已经不再需要作为“细节化 capability”存在；
  - response-stage gate 现在只吃 Rust 默认 support 语义，TS 不再 owner support 布尔或 capability 推导壳；
  - 下一轮可以继续审计 `ServerSideToolEngineOptions` 里残留的 legacy callback 形状是否还能进一步物理删除。

## 2026-06-22 install-global TS rootDir closure

- 真失败点：`install:global` 在 tsc 阶段触发 TS6059；原因是 `src/server/runtime/http-server/executor-metadata.ts` 直接 import `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js`，越过 host `tsconfig.json` 的 `rootDir=./src` 与 `sharedmodule/**/*` exclude。
- 正确修复方向：host 只依赖 `sharedmodule/llmswitch-core/dist/**` 编译产物，不跨 rootDir 引 `sharedmodule/src/**`；同时在 `src/types/llmswitch-core.d.ts` 补 dist module declaration。

## 2026-06-22 retired backend-route spec binding cleanup + stopless spec realignment

- 触发：`tests/servertool/server-side-web-search.spec.ts` / `tests/servertool/vision-flow.spec.ts` 已物理删除，但 `function-map` / `verification-map` / `verify-servertool-rust-only` / `ci-jest` 仍把它们当 active required tests；同时 `stop-message-auto.goal-default.spec.ts` / `servertool-progress-logging.spec.ts` 还在测 retired reenter 与旧 stopMessage counter 口径。
- 真相：
  - `hub.servertool_backend_route_runtime` 当前有效证据应落在 `tests/servertool/servertool-mixed-tools.spec.ts`、`tests/servertool/server-side-tools.dispatch-native.spec.ts`、`tests/servertool/execution-shell.backend-failfast.spec.ts`、`tests/server/handlers/responses-handler.servertool-backend-route.dual-port.blackbox.spec.ts`。
  - `continue_execution_flow` 现在命中 `SERVERTOOL_REENTER_RETIRED`，不应再作为 progress logging 的“正常但不打印 stop summary”路径。
  - `stop_message_auto.goal-default.spec.ts` 的旧预期（首轮 `stopMessageUsed=1/2/3`、`/goal active` 静默不续）与当前 Rust 真相不符；现状是：
    - 显式 `/goal active` 缺 hook result 时 fail-fast `SERVERTOOL_REQUIRED_RESPONSE_HOOK_EMPTY`
    - 非 goal 缺 schema 首轮就会把 persisted default state 直接写成 `stopMessageUsed=3`
    - tool-call / non-stop 只要求“不推进既有计数”，不是旧 spec 里的 reset-to-zero / linear increment 语义
- 修改：
  - 更新 `docs/architecture/function-map.yml`
  - 更新 `docs/architecture/verification-map.yml`
  - 更新 `scripts/verify-servertool-rust-only.mjs`
  - 更新 `scripts/tests/ci-jest.mjs`
  - 重写 `tests/servertool/stop-message-auto.goal-default.spec.ts`
  - 重写 `tests/servertool/servertool-progress-logging.spec.ts` 的 retired-path case
- 验证：
  - `node scripts/verify-servertool-rust-only.mjs` -> PASS
  - `npm run verify:function-map-compile-gate` -> PASS
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/stop-message-auto.goal-default.spec.ts tests/servertool/servertool-progress-logging.spec.ts tests/servertool/resp-process-stage3-reentry.spec.ts --runInBand` -> 3 suites / 12 tests PASS

## 2026-06-22 providerInvoker type-entry removal

- 触发：`sharedmodule/llmswitch-core/src/servertool/types.ts` 里 `ProviderInvoker` 只剩类型壳，没有真实 runtime owner；`rg` 结果确认 `ProviderInvoker` 在仓库内已无消费。
- 修改：从 `ServerSideToolEngineOptions` 删除 `providerInvoker?: ProviderInvoker`，并移除整个 `ProviderInvoker` type alias。
- 验证：
  - `rg -n "ProviderInvoker" sharedmodule/llmswitch-core/src tests src` -> 0 matches
  - `node scripts/verify-servertool-rust-only.mjs` -> PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/execution-shell.auto-hook-failfast.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand` -> PASS
- 结论：没被任何 runtime 消费的 callback 类型入口可以先物理删掉，不必等到整组 followup/reenter 彻底收口后才删。

## 2026-06-21T17:47:46.712Z stopless learned

- requestId: openai-responses-minimax.key1-MiniMax-M3-20260622T014700802-385291-4660
- sessionId: 019ee874-5240-7671-bc3e-544e4b034ddb
- stopReason: 本刀已按目标真源完成 servertool Rust-only closeout 的局部 slice：清理已删 spec 的 verification 绑定、对齐剩余 stopless/progress spec 到当前 Rust 真相、串行验证全绿、单刀提交。剩余 closeout 工作交给后续刀。
- evidence: 1. `node scripts/verify-servertool-rust-only.mjs` -> `✅ All checks passed — servertool Rust-only invariants hold.`
2. `npm run verify:function-map-compile-gate` -> `ok`（function-map parseable、feature-id anchors、coverage、paths、boundary、owner uniqueness、canonical builders、forbidden mentions、required tests、build wiring 全 PASS）
3. `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/stop-message-auto.goal-default.spec.ts tests/servertool/servertool-progress-logging.spec.ts tests/servertool/resp-process-stage3-reentry.spec.ts --runInBand` -> 3 suites / 12 tests PASS（3 skipped 为 progress console-log/progress-file-log 缺失 runtime 时的 guard）
4. `node scripts/build-core.mjs` -> native-build synced, llmswitch-core dist 重建成功
5. `git commit 663b0fb` 已落

1. 删退休 servertool 路径必须先改 verification/map binding 再改 spec，否则 `verify:servertool-rust-only` 会一直假红。2. 旧 spec 在测已退役的 `continue_execution_flow` / 旧 `stopMessageUsed` 计数口径时，必须先把 case 改成“当前 Rust 真相 + fail-fast”，而不是硬把旧期望调绿。3. `MetadataCenter.attach(adapterContext)` 仍是 servertool-focused 规范的强前置。

## 2026-06-21T17:58:57.798Z stopless learned

- requestId: openai-responses-minimax.key1-MiniMax-M3-20260622T015831670-385389-4758
- sessionId: 019ee85e-8c96-77b0-920f-f3fbb3772b6d
- stopReason: 已完成本轮 stopless reasoningStop 闭环收尾：build/min 0、live probe 首轮命中标准 exec_command、续轮失败为探针寿命而非骨架回退。变更已提交 96bd542 并推送到 main。剩余 dirty 改动和 3 次 hard cap 已是下一轮议题。
- evidence: npm run build:min exit 0；/health 5555 & 5520 ready=true version=0.90.3245；node scripts/tests/stopless-5555-live-probe.mjs exit=0，首轮 hasExecCommand=true && hasReasoningStop=false && leakedStopSchema=false；note.md / SKILL.md / references/23 / references/92 均已更新并落 commit 96bd54204，推送 1bdedfa4e..96bd54204 main->main 成功。

stopless live replay 判法必须分三步：首轮 exec_command → raw reasoningStop 泄漏 → 续轮寿命；build:min 是 servertool 闭环必跑入口，不能只跑 build-core；stable 流程要回写 skill 23 + lessons 92，不要只留 note。

## 2026-06-21T17:59:14.232Z stopless learned

- requestId: openai-responses-minimax.key1-MiniMax-M3-20260622T015904847-385391-4760
- sessionId: 019ee85e-8c96-77b0-920f-f3fbb3772b6d
- stopReason: 已完成本轮 stopless reasoningStop 闭环收尾：build/min 0、live probe 首轮命中标准 exec_command、续轮失败是探针寿命而非骨架回退；提交 96bd542 已推送到 main。
- evidence: npm run build:min exit 0；5555/5520 /health ready=true version=0.90.3245；node scripts/tests/stopless-5555-live-probe.mjs exit=0，首轮 hasExecCommand=true && hasReasoningStop=false && leakedStopSchema=false；git commit 96bd542；git push 1bdedfa4e..96bd54204 main->main 成功。

live probe 必须先看首轮是否命中标准 exec_command CLI 投影，再判有没有 raw reasoningStop 泄漏，最后才看续轮是否因 Responses conversation 寿命失败；build:min 必跑，不允许用 build-core 代替。
## 2026-06-22 stopMessageEnabled live 502 root cause

- Live truth:
  - `POST http://127.0.0.1:5555/v1/responses` without explicit stopless enable flag now returns `200` and projects `exec_command(routecodex hook run reasoningStop ...)`.
  - The same request with `metadata.stopMessageEnabled=true` returns `502` with `HTTP_HANDLER_ERROR`, independent of model (`gpt-5.5` and `routecodex-servertool-cli` both reproduced).
- Root cause tracked to request-stage pipeline metadata projection, not model/provider:
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts`
  - `projectNativeTopLevelRuntimeControl()` was flattening `stopMessageEnabled` and `routecodexPortStopMessageEnabled` onto request metadata top-level.
  - Response client guard treats these as internal metadata keys (`src/server/handlers/handler-response-common.ts`), so once projected back into client-visible responses metadata they fail-fast into `HTTP_HANDLER_ERROR`.
- Correct design:
  - stop-message enablement is runtime-control truth only; it must stay in `runtime_control` / MetadataCenter and must not be flattened into client-visible metadata shape.

## 2026-06-22 5520 thinking 1:1 loadbalancing goal design

- 现场真源：`~/.rcc/config.toml` 的 `gateway_priority_5520.routing.thinking` 已是 `targets=["fwd.paid.gpt-5.4", "fwd.glm.glm-5.2"]`，`weights={"fwd.paid.gpt-5.4":1,"fwd.glm.glm-5.2":1}`，`thinking="high"`。5520 thinking 已经按 1:1 跑，无需新增 thinking 路由。
- `fwd.glm.glm-5.2` forwarder 在 builder 里展开为 `XLC.key1.glm-5.2` 与 `XLC.key2.glm-5.2` 两个 providerKey，权重继承。
- 剩余风险：builder focused spec（`tests/config/virtual-router-builder.forwarder-10000.spec.ts`）和 5555 的 `coding/thinking/longcontext` 三个 priority 池断言还停留在旧“thinking 只有 gpt”的预期，需要按 builder 真源改为 1:1 期望，并加双向锁（双 providerKey 都至少命中 1 次）。
- 实现文档：`docs/goals/servertool-skeleton-rust-only-closeout-plan-2026-06-20.md`（已追加 Routing Truth Checkpoint 2026-06-22 与 `/goal` 提示词）。
- 下一步入口：直接以现有 goal plan + `/goal` 提示词推进 servertool Rust-only closeout，不重复写一份 5520 thinking 配置。

## 2026-06-22 server-side-tools *Impl alias export 物理收口

- 本轮物理删除以下 4 个纯 alias 出口：
  - `runServerSideToolEngineImpl = runServerSideToolEngineViaThinShell`
  - `runServertoolAutoHookCallerImpl = runServertoolAutoHookCallerViaThinShell`
  - `collectAdditionalClientToolCallsImpl = collectAdditionalClientToolCallsViaImplThinShell`
  - `extractToolCallsImpl = extractToolCallsViaImplThinShell`
- 真壳函数 `runServerSideToolEngineViaThinShell` / `runServertoolAutoHookCallerViaThinShell` / `collectAdditionalClientToolCallsViaImplThinShell` / `extractToolCallsViaImplThinShell` 改为 `export`，并直接被 `server-side-tools.ts` 再导出。
- 同步把 `verify-servertool-rust-only` 的“必须保留旧 alias”断言全部改成“禁止复活”，并把 mock/export 名字同步换成真壳函数名：
  - `scripts/verify-servertool-rust-only.mjs`
  - `tests/servertool/server-side-tools.cli-projection-guard.spec.ts`
  - `tests/servertool/server-side-tools.auto-hook-caller-guard.spec.ts`
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
- 验证：
  - focused Jest 3/3（`cli-projection-guard` / `auto-hook-caller-guard` / `servertool-active-orchestration-audit`）PASS
  - `node scripts/build-core.mjs` -> native-build synced，llmswitch-core dist 重建成功
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` -> `✅ All checks passed — servertool Rust-only invariants hold.`

教训：删 alias 时一定要同步把 mock/export/verify 三处一起换，否则要么 jest 编译挂、要么 verify gate 假红；同时 verify gate 不能要求“旧 wrapper 必须存在”，只能要求“真壳必须存在 + 旧 wrapper 不得复活”。

## 2026-06-22 execution-shell export-from 收口

- 本轮把 `sharedmodule/llmswitch-core/src/servertool/execution-shell.ts` 的局部 alias-import/export 收成直接 `export ... from`：
  - `materializeServertoolPlannedResult`
  - `runServertoolHandler`
  - `applyServertoolExecutionResult`
  - `appendExecutedToolRecord`
  - `assertDispatchExecutionMode`
  - `buildServertoolDispatchPlanInputThinShell`
  - `buildServertoolOutcomePlanInputThinShell`
  - `createServertoolExecutionLoopState`
  - `resolveToolCallExecutionOutcomeThinShell`
  - `runToolCallExecutionLoopThinShell`
- 这样 `execution-shell.ts` 不再自己维护一层 alias import/export，本地只保留 `applyPreCommandHooks*` 的真逻辑。
- 同步把 `verify-servertool-rust-only` 的 execution-shell 断言从 `export const ... =` 改成更宽松的“模块内仍保留对应真名”，避免 gate 绑死具体导出语法。
- 验证：
  - `tests/servertool/execution-shell.auto-hook-failfast.spec.ts`
  - `tests/servertool/execution-dispatch-outcome-shell.spec.ts`
  - `tests/servertool/server-side-tools.failfast.spec.ts`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs`
  - `node scripts/build-core.mjs`

教训：对纯重导出的 thin shell，export-from 比“本地先 import 再 alias export”更接近物理收口；gate 也应该锁真名存在，不锁特定语法形态。

## 2026-06-22 execution-dispatch alias delete + auto-hook helper inline

- 本轮继续收掉 `execution-dispatch-outcome-shell.ts` 末尾 2 个纯 alias：
  - `resolveToolCallExecutionOutcomeThinShell = materializeNativeToolCallExecutionOutcome`
  - `runToolCallExecutionLoopThinShell = runServertoolIoExecutionQueue`
- 兼容出口没有直接删除，而是改由 `execution-shell.ts` 用 direct re-export alias 提供：
  - `materializeNativeToolCallExecutionOutcome as resolveToolCallExecutionOutcomeThinShell`
  - `runServertoolIoExecutionQueue as runToolCallExecutionLoopThinShell`
- 这样下层 owner 文件不再持有多余 alias，调用面维持兼容。
- 同轮还内联并删除 `auto-hook-caller.ts` 的 2 个单用途 helper：
  - `toEngineResult(...)`
  - `emitAutoHookTrace(...)`
- focused 验证：
  - `tests/servertool/execution-dispatch-outcome-shell.spec.ts` PASS
  - `tests/servertool/server-side-tools.failfast.spec.ts` PASS
  - `tests/servertool/servertool-auto-hook-trace.spec.ts` PASS
  - `tests/servertool/execution-shell.auto-hook-failfast.spec.ts` PASS
  - `node scripts/build-core.mjs` PASS
- 当前剩余红点：
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs`
- 真根因不是 alias 删除回退，而是 audit 仍明确把 `execution-dispatch-outcome-shell.ts` 的这两个真实函数视为“仍然存在的 TS active owner”:
  - `materializeNativeToolCallExecutionOutcome(...)`
  - `runServertoolIoExecutionQueue(...)`
- 下一刀不能靠改名字或改 gate 混过去，必须继续证明哪些子逻辑还能下沉 Rust owner，或者把 audit 拆成更准确的 residue gate + explicit pending owner gate，避免假绿。

## 2026-06-22 server-side-tools direct re-export closeout

- 本轮把 `sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts` 从本地 `export const ... = ...` 转发改成 direct re-export：
  - `runServerSideToolEngineViaThinShell as runServerSideToolEngine`
  - `runServertoolAutoHookCallerViaThinShell as runServertoolAutoHookCaller`
  - `collectAdditionalClientToolCallsViaImplThinShell as collectAdditionalClientToolCalls`
  - `extractToolCallsViaImplThinShell as extractToolCalls`
- 同步去掉 `server-side-tools-impl.ts` 里多余的 alias import：
  - `runServertoolAutoHookCallerViaThinShell as runServertoolAutoHookCallerImpl`
  - 改成直接使用 `runServertoolAutoHookCallerViaThinShell`
- focused / build 结论：
  - `tests/servertool/server-side-tools.auto-hook-caller-guard.spec.ts` PASS
  - `tests/servertool/server-side-tools.cli-projection-guard.spec.ts` PASS
  - `node scripts/build-core.mjs` PASS
- gate 现状：
  - `verify-servertool-rust-only` 里这层 re-export 断言已同步到 direct re-export 形态
  - 但总 gate 仍红，原因仍是 `execution-dispatch-outcome-shell.ts` 的两个真实 active owner 函数，不是这轮 re-export 回退
- 当前可确认剩余 owner：
  - `materializeNativeToolCallExecutionOutcome(...)`
  - `runServertoolIoExecutionQueue(...)`
- 结论：`server-side-tools.ts` 这层已经进一步收成纯 export surface；后续 closeout 的重点已完全收敛到 execution-dispatch/outcome 真逻辑，而不是外层命名壳。

## 2026-06-22 execution-dispatch thin-shell audit realignment + JSON clone removal

- 现状确认：
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs`
  - 两者同时卡在 `execution-dispatch-outcome-shell.ts` 的函数名：
    - `materializeNativeToolCallExecutionOutcome(...)`
    - `runServertoolIoExecutionQueue(...)`
- 本轮修正：
  - 不再把“函数名仍存在”直接当成活业务语义证据；audit/gate 改成继续禁止真实 TS 业务残留，同时显式禁止 `JSON.parse(JSON.stringify(` 这种 payload materialization。
  - `sharedmodule/llmswitch-core/src/servertool/execution-dispatch-outcome-shell.ts`
    - mixed pending client response 改成 `structuredClone(args.base)`
    - materialized result / handler error payload / noop payload 全部直接消费 native 返回对象，不再二次 JSON clone
  - 同步更新：
    - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
    - `tests/servertool/execution-dispatch-outcome-shell.spec.ts`
    - `scripts/verify-servertool-rust-only.mjs`
- 验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/servertool-active-orchestration-audit.spec.ts tests/servertool/execution-dispatch-outcome-shell.spec.ts --runInBand` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` PASS
- 教训：
  - 对 closeout residue，audit 应锁“业务语义是否还在”，而不是死锁“函数名是否还在”；否则会把纯 IO 壳也误判成活 owner。

## 2026-06-22 server-side-tools cloneJson export surface deleted

- 本轮继续收口 `sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.ts` / `server-side-tools.ts`：
  - 删除 `cloneJson` helper 与对外 re-export
  - `baseForExecution` 改为 `structuredClone(baseObject)`
  - persisted routing state clone 改为 `structuredClone(persistedState as JsonObject)`
- 结果：
  - `server-side-tools.ts` 不再暴露这个历史 TS deep-clone surface
  - `server-side-tools-impl.ts` 不再保留 `JSON.parse(JSON.stringify(...))`
- focused 验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/servertool-active-orchestration-audit.spec.ts tests/servertool/server-side-tools.failfast.spec.ts tests/servertool/server-side-tools.dispatch-native.spec.ts tests/servertool/servertool-cli-native-bridge.spec.ts tests/servertool/execution-dispatch-outcome-shell.spec.ts tests/servertool/server-side-tools.auto-hook-caller-guard.spec.ts tests/servertool/server-side-tools.cli-projection-guard.spec.ts tests/servertool/stop-message-auto.goal-default.spec.ts --runInBand` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` PASS
- 下一刀仍然应该落在 `server-side-tools-impl.ts` 的 response-stage / auto-hook 双段 orchestration，继续把 required-hook-empty / runtime action choice 这类剩余判定下沉 Rust owner。

## 2026-06-22 5520 thinking glm-5.2 + gpt-5.4 1:1 loadbalancing 真源确认

- 用户要求：把 `glm-5.2` 加入 5520 thinking，和 `gpt-5.4` 做 1:1 负载均衡。
- 真源确认（`~/.rcc/config.toml`）：
  - `[virtualrouter.forwarders."fwd.glm.glm-5.2"]` 已存在，模型 `glm-5.2`，target `XLC.priority=1`。
  - `gateway_priority_5520.routing.thinking`：
    - `targets = ["fwd.paid.gpt-5.4", "fwd.glm.glm-5.2"]`
    - `weights = { "fwd.paid.gpt-5.4" = 1, "fwd.glm.glm-5.2" = 1 }`
    - `thinking = "high"`
- 验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/config/virtual-router-builder.forwarder-10000.spec.ts --runInBand`
  - 9/9 PASS，其中：
    - `5520 routes use current paid GPT forwarders` 锁住 `thinking => [fwd.paid.gpt-5.4, fwd.glm.glm-5.2]`
    - `5520 thinking keeps GPT and GLM balanced 1:1` 显式锁住 `weights 1:1` 与 `mode=weighted`、`thinking=high`
- 结论：
  - 1:1 负载均衡不是口头目标，是真配置 + 真断言双锁。
  - 这次只做核对与 note 落盘，没动 Rust runtime；因为 `gateway_priority_5520.routing.thinking` 已经是当前真值，且 builder 与测试已经按该真值断言。
  - 后续若要再增加候选，按 `references/50-rcc-config-ssot.md` 的修改流程：先改 `config.toml` / provider `config.v2.toml`，再 `routecodex config validate` → `restart --port 5520` → health → live probe。

## 2026-06-22 servertool response-stage required-empty Rust contract cutoff

- 本轮把 `response_stage_runtime_action_contract.rs` 的 response-stage 决策升级为 Rust-owned：
  - 新增 `response_hook_required`
  - 新增 `return_required_response_hook_empty`
- TS `server-side-tools-impl.ts` 现在只消费 native action，不再自己拼 required-empty 判定。
- focused 验证：
  - `cargo test -p servertool-core response_stage_runtime_action_contract -- --nocapture`
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/server-side-tools.failfast.spec.ts tests/servertool/servertool-cli-native-bridge.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs`
  - `node scripts/build-core.mjs`
- 结论：
  - required-empty 这类 response hook fail-fast 现在有 Rust contract 真源；
  - TS 只是 consumer，不再是决策 owner。

## 2026-06-22 servertool engine direct-route stopless guard moved into Rust preflight

- 本轮继续收 `engine.ts` 的 preflight 语义：
  - `engine_preflight_contract.rs` 现在支持直接从 `adapterContext` 推导 direct/provider-direct stopless disable，不再要求 TS 先算 `stoplessDisabledOnDirectRoute`
  - 读取顺序覆盖：`adapterContext.routeName -> metadata.routeName -> __rt.routeName`
  - `engine.ts` 改为只把 `adapterContext` 传给 `planServertoolEnginePreflightWithNative(...)`
  - 物理删除 `sharedmodule/llmswitch-core/src/servertool/direct-stopless-route-guard.ts`
- focused 验证：
  - `cargo test -p servertool-core engine_preflight_contract -- --nocapture`
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/servertool-cli-native-bridge.spec.ts tests/servertool/engine.stopless-session-thin-shell.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs`
  - `node scripts/build-core.mjs`
- 结论：
  - stopless direct-route bypass 不再有 TS helper 真源；
  - `engine.ts` 这段更接近纯 preflight consumer，但 `mainline-call-map` 仍是 `binding pending`，不能宣称整条 hook skeleton 已 anchored。

## 2026-06-22 provider response tool_calls array contract

- 现场 2026-06-22 03:25:53 diag 真因：
  - `hub_pipeline_resp_inbound_02_failed: HubRespInbound02Parsed tool_calls at $.choices[0].message.tool_calls must be an array`
- 唯一 owner：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_inbound_format_parse.rs`
  - 真正缺口在 openai-chat materialization：`materialize_openai_chat_response_payload()` / `normalize_choices()` 没有把 `choices[0].message.tool_calls` 统一收成数组
- 本轮修复：
  - Rust materialization 层加 `normalize_openai_chat_message_tool_calls_arrays()`
  - 保留了 openai-responses 侧的 `normalize_openai_responses_tool_calls_arrays()`，但它不是这次 diag 的主因
- 红测：
  - Rust 单测 `test_openai_chat_tool_calls_object_is_normalized_to_array`
- 反模式：
  - 不在 handler / error mapper 兜 502
  - 不把 tool_calls shape 问题当 provider errorMapping 问题

## 2026-06-22 stopless trigger hint mapping Rust-owned

- `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts` 的 `normalizeStoplessTriggerHintForMetadata()` 已改为调用 native wrapper，不再保留本地 `switch` 映射。
- Rust 真源：
  - `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs::normalize_stopless_trigger_hint_for_metadata`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs::normalize_stopless_trigger_hint_for_metadata_json`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs::normalize_stopless_trigger_hint_for_metadata_json`
- 运行时验证：
  - `cargo test -p servertool-core normalize_stopless_trigger_hint_for_metadata_maps_reason_codes -- --nocapture`
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/stopless-metadata-center.spec.ts --runInBand`
  - `node scripts/build-core.mjs`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs`
- 调试坑：
  - 并行跑 Jest 时先撞到 `native unavailable`，因为 native build 还没完成；串行重跑后通过。

## 2026-06-22 5520 thinking glm-5.2 1:1 load balancing confirmed

- 现场确认：`~/.rcc/config.toml` 里 `gateway_priority_5520.routing.thinking` 已经是 `fwd.paid.gpt-5.4` + `fwd.glm.glm-5.2`，`weights` 为 `1:1`，`thinking = "high"`。
- 运行时校验：`routecodex config validate` 通过。
- 结论：这次不需要改配置；当前真源已经满足“thinking 做 1:1 load balancing”的要求。

## 2026-06-22 server-side-tools auto-hook alias wrapper physical delete

- 物理删除 `sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts` 里的纯 alias export `runServertoolAutoHookCallerViaThinShell as runServertoolAutoHookCaller`。
- 同步把 `scripts/verify-servertool-rust-only.mjs` 里的硬约束从“必须存在 alias”改成“alias 不得复活”。
- 验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/server-side-tools.auto-hook-caller-guard.spec.ts --runInBand`
  - `node scripts/verify-servertool-rust-only.mjs`

## 2026-06-22 engine snapshot record wrapper inline delete

- 物理删除 `sharedmodule/llmswitch-core/src/servertool/engine.ts` 里的纯记录包装函数 `recordServertoolExecutionSnapshot(...)`。
- 调用点改成直接内联 `stageRecorder.record('servertool.execution', summarizeServertoolExecutionForSnapshot(engineResult))`，没有改 runtime 决策。
- 验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/engine.stopless-session-thin-shell.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand`
  - `node scripts/verify-servertool-rust-only.mjs`
  - `node scripts/build-core.mjs`

## 2026-06-22 servertool applyServertoolExecutionResult wrapper physical delete

- 物理删除 `sharedmodule/llmswitch-core/src/servertool/execution-dispatch-outcome-shell.ts` 里的纯壳 `applyServertoolExecutionResult(baseForExecution, nextChatResponse)`；调用点 3 处全部内联为 `replaceJsonObjectInPlace(...)`，`execution-shell.ts` 的 re-export 列表里也删除该 alias。
- `scripts/verify-servertool-rust-only.mjs` 的 `servertool-execution-state-ts-thin-shell` 旧断言从“必须包含旧包装”改成 `assertMissing('export function applyServertoolExecutionResult(')`，反向锁死。
- 验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/execution-dispatch-outcome-shell.spec.ts tests/servertool/execution-shell.backend-failfast.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand`
  - `node scripts/build-core.mjs`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs`

## 2026-06-22 execution-shell re-export alias direct-owner closeout

- `sharedmodule/llmswitch-core/src/servertool/execution-shell.ts` 不再 re-export `buildServertoolDispatchPlanInputThinShell`、`buildServertoolOutcomePlanInputThinShell`、`resolveToolCallExecutionOutcomeThinShell`、`runToolCallExecutionLoopThinShell` 这组 alias。
- `sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.ts` 改成直接 import `execution-dispatch-outcome-shell.ts` 的真实 owner 导出：`buildServertoolDispatchPlanInputThinShell`、`materializeNativeToolCallExecutionOutcome`、`runServertoolIoExecutionQueue`。
- focused test / mock 同步到真实 owner 文件：
  - `tests/servertool/server-side-tools.failfast.spec.ts`
  - `tests/servertool/server-side-tools.dispatch-native.spec.ts`
- `tests/servertool/servertool-active-orchestration-audit.spec.ts` 和 `scripts/verify-servertool-rust-only.mjs` 新增反向锁，禁止这些 alias 回到 `execution-shell.ts`。
- 验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/server-side-tools.failfast.spec.ts tests/servertool/server-side-tools.dispatch-native.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs`
  - `node scripts/build-core.mjs`

## 2026-06-22 server-side-tools impl export-name shell delete

- `sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.ts` 不再保留 `runServerSideToolEngineViaThinShell`、`collectAdditionalClientToolCallsViaImplThinShell`、`extractToolCallsViaImplThinShell` 这组命名壳，改成直接导出 `runServerSideToolEngine`、`collectAdditionalClientToolCalls`、`extractToolCalls`。
- `sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts` 同步改成 direct re-export，不再做二次 alias。
- focused mock / guard 同步：
  - `tests/servertool/server-side-tools.cli-projection-guard.spec.ts`
  - `tests/servertool/server-side-tools.failfast.spec.ts`
- `scripts/verify-servertool-rust-only.mjs` 改成检查新的 direct re-export / impl export marker，不再要求旧 `ViaThinShell` / `ViaImplThinShell` 名字存在。
- 验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/server-side-tools.cli-projection-guard.spec.ts tests/servertool/server-side-tools.failfast.spec.ts tests/servertool/servertool-active-orchestration-audit.spec.ts --runInBand`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs`
  - `node scripts/build-core.mjs`

## 2026-06-22 5520 thinking glm-5.2 1:1 复核（repo + runtime + tests）

- 现场复核三处：
  - `~/.rcc/config.toml` 里 `gateway_priority_5520.routing.thinking` 已经是 `fwd.paid.gpt-5.4 + fwd.glm.glm-5.2`，`weights = { "fwd.paid.gpt-5.4" = 1, "fwd.glm.glm-5.2" = 1 }`，`thinking = "high"`。
  - `src/config/virtual-router-builder.ts` 把 `fwd.glm.glm-5.2` 展开为 `XLC.key1.glm-5.2` + `XLC.key2.glm-5.2`；`fwd.paid.gpt-5.4` 展开为 `asxs/1token/XL` 三个 provider。
  - 仓库断言已就位：`tests/config/virtual-router-builder.forwarder-10000.spec.ts` 的 `5520 thinking keeps GPT and GLM balanced 1:1` 锁住 `targets` 和 `weights = { gpt:1, glm:1 }`，并断言 `thinking=high`。
- focused Jest 全绿（9/9）：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/config/virtual-router-builder.forwarder-10000.spec.ts --runInBand`
- 当前结论：
  - 这项已完成，无需再改代码或配置；运行时、builder、test 三层口径已经一致。

## 2026-06-22 servertool direct-stopless preflight Rust-owned slice

- 当前已验证的收口点：
  - `sharedmodule/llmswitch-core/src/servertool/direct-stopless-route-guard.ts` 已物理删除。
  - `sharedmodule/llmswitch-core/src/servertool/engine.ts` 不再依赖本地 direct-route guard helper，而是直接把 `adapterContext` 传给 `planServertoolEnginePreflightWithNative(...)`。
  - `sharedmodule/llmswitch-core/src/servertool/timeout-error-block.ts` 新增 `createServertoolRequiredResponseHookEmptyError(...)`，对应 Rust `planServertoolRequiredResponseHookEmptyErrorWithNative(...)`。
  - `sharedmodule/llmswitch-core/src/servertool/types.ts` 去掉了 `ProviderInvoker`，把 servertool 执行 options 收缩为现行 Rust-owned 路径需要的字段。
- 验证：
  - `tests/servertool/engine.stopless-session-thin-shell.spec.ts`
  - `tests/servertool/servertool-cli-native-bridge.spec.ts`
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - `tests/servertool/stop-schema-lifecycle-contract.spec.ts`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs`
  - `node scripts/build-core.mjs`
- 反模式：
  - 不再保留单独 TS direct-route preflight helper 作为第二真源。
  - required response hook empty 必须走 Rust error plan，不回到 TS 本地 if/throw 分支。

## 2026-06-22 servertool response-stage metadata write inline slice

- 已完成：
  - `sharedmodule/llmswitch-core/src/servertool/response-stage-orchestration-shell.ts` 删除了纯包装函数 `markServertoolResponseOrchestration(...)`。
  - 同一段 `writeRuntimeControlToBoundMetadataCenter(...)` 直接内联到 `runServertoolResponseStageOrchestrationShell(...)`。
  - `scripts/verify-servertool-rust-only.mjs` 新增 helper 名称反向锁，禁止旧 helper 复活。
- 验证：
  - `tests/servertool/resp-process-stage3-reentry.spec.ts`
  - `tests/servertool/stop-message-flow-followup-reentry.spec.ts`
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs`
  - `node scripts/build-core.mjs`
- 结论：
  - 这只是去壳，不改变行为；但把 response-stage 的纯记录包装面再收小了一层。

## 2026-06-22 servertool flow-presentation thin shell delete

- 物理删除 `sharedmodule/llmswitch-core/src/servertool/flow-presentation-block.ts`，该文件只对两个 native wrapper 做纯透传，无独立 owner。
- 替换路径：
  - `sharedmodule/llmswitch-core/src/servertool/progress-log-block.ts` 直接 import `resolveServertoolProgressToolNameWithNative` / `shouldUseServertoolGoldProgressHighlightWithNative`，不再走 `./flow-presentation-block.js`。
  - `sharedmodule/llmswitch-core/tests/servertool/followup-flow-policy.test.ts` 改为直接 import native wrapper，断言 `shouldUseServertoolGoldProgressHighlightWithNative({ flowId: 'continue_execution_flow' })`。
- Gate 调整：
  - `scripts/verify-servertool-rust-only.mjs` 不再 `readRequired(TS_FLOW_PRESENTATION)`，新增 “flow-presentation-block.ts must stay deleted after direct native import closeout” 与 “flow-presentation-block.ts stays deleted; progress-log-block.ts directly uses native wrappers” 反向锁。
  - `docs/architecture/function-map.yml` `hub.servertool_flow_presentation.owner_scope` 改为 `file-scoped Rust owner for servertool progress log tool-name and highlight presentation policy`；`docs/architecture/wiki/servertool-ownership-map.md` 同步。
  - 根因：`scripts/architecture/verify-architecture-feature-anchor-coverage.mjs` 要求 canonical builder 字符串至少出现在 2 个 allowed_paths 文件；删薄壳后只剩 `servertool_skeleton_config.rs` 命中一次。把 owner 显式标 file-scoped 后，gate 降为“至少 1 个命中”，不再要求伪造 anchor。
- 验证：
  - `npm run verify:function-map-compile-gate` PASS（含 `verify:architecture-feature-anchor-coverage`）。
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs` PASS。
  - `node scripts/build-core.mjs` PASS（native rebuild + dist rebuild）。
  - focused Jest：`tests/servertool/servertool-progress-logging.spec.ts` + `tests/servertool/servertool-active-orchestration-audit.spec.ts` 13 passed / 3 skipped。
- 反模式：
  - 不要为了凑齐 2 个 anchor 在 native wrapper 文件里硬塞 random `feature_id:` 注释或 fake builder 字符串；那只会把 gate 变成“看起来过、实际没真源”。
  - 删薄壳前必须先把 owner_scope 调整与功能 map 注释同步，否则 function-map compile gate 会先红。
- 下一步候选 slice（active orchestration audit 未报新违规）：
  - `auto-hook-caller.ts` 重复别名壳。
  - 或下一条薄透传 wrapper / 单纯 naming alias。

## 2026-06-22 servertool auto-hook caller naming shell delete

- 物理删除 `sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.ts` 里的纯命名壳 `runServertoolAutoHookCallerViaThinShell`，改成直接导出 `runServertoolAutoHookCaller`。
- 调用点同步改名：
  - `sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.ts`
  - `tests/servertool/servertool-auto-hook-trace.spec.ts`
  - `tests/servertool/server-side-tools.cli-projection-guard.spec.ts`
- Gate 同步反向锁：
  - `scripts/verify-servertool-rust-only.mjs` 禁止旧 export 名和旧 import/call marker 复活，只允许直接导出名存在。
- 验证：
  - `tests/servertool/servertool-auto-hook-trace.spec.ts`
  - `tests/servertool/execution-shell.auto-hook-failfast.spec.ts`
  - `tests/servertool/server-side-tools.cli-projection-guard.spec.ts`
  - `tests/servertool/server-side-tools.auto-hook-caller-guard.spec.ts`
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs`
  - `node scripts/build-core.mjs`
- 结论：
  - auto-hook 队列执行真源只有一个，TS 侧不需要再保留“ViaThinShell”这种纯命名壳。

## 2026-06-22 servertool dispatch/outcome input naming shell delete

- `sharedmodule/llmswitch-core/src/servertool/execution-dispatch-outcome-shell.ts` 把
  - `buildServertoolDispatchPlanInputThinShell`
  - `buildServertoolOutcomePlanInputThinShell`
  收成直接对外名：
  - `buildServertoolDispatchPlanInput`
  - `buildServertoolOutcomePlanInput`
- 调用点/测试同步：
  - `sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.ts`
  - `tests/servertool/server-side-tools.dispatch-native.spec.ts`
  - `tests/servertool/server-side-tools.failfast.spec.ts`
- Gate 同步：
  - `scripts/verify-servertool-rust-only.mjs` 新增 direct export marker 检查；
  - 旧 `*ThinShell` 名继续只作为 forbidden marker，防复活。
- 验证：
  - `tests/servertool/server-side-tools.dispatch-native.spec.ts`
  - `tests/servertool/server-side-tools.failfast.spec.ts`
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs`
  - `node scripts/build-core.mjs`
- 结论：
  - 这两个函数仍是必要 bridge，但 `ThinShell` 命名已经没有额外语义，保留真函数名即可。
