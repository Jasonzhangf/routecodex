# Hub Pipeline Passthrough Mode 移除：证据与计划

## 1. 目标与验收标准

目标：移除 Hub Pipeline 内部的 `processMode='passthrough'` 执行模式，使 Hub Pipeline 永远执行唯一 `chat` 语义路径；同协议直连只允许存在于 server/router direct 层，不再由 Hub Pipeline 内部通过 passthrough 跳过语义处理、工具治理或 outbound hooks。

验收标准：
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/` 不再存在以 `activeProcessMode === 'passthrough'` 分叉的执行路径。
- Hub Pipeline request stage 不再跳过 semantic gate、tool governance、request hooks、outbound semantic map。
- `processMode` 类型收敛为 `chat`，或仅保留输入兼容校验后强制归一为 `chat`。
- 原 passthrough 专用 audit/build/skip 函数被物理删除，相关 native required exports 一并清理。
- server/router direct 仍由 `src/server/runtime/http-server/router-direct-pipeline.ts` 管理，不搬进 Hub Pipeline。

## 2. 当前存活证据

审计时间：2026-05-30。

搜索证据：
- 命令：`rg -n "passthrough" sharedmodule/llmswitch-core/src/conversion/hub/pipeline/ --g "*.ts" | grep -v "\.d\.ts\|__tests__\|\.test\." | grep -v "responses_passthrough\|passthrough_remote_direct\|metadata-passthrough\|passthrough: false" | wc -l`
- 结果：`94`
- 结论：Hub Pipeline 内部仍有大量 passthrough mode 代码，不是只剩类型残留。

关键代码证据：
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-chat-process-request-utils.ts:25` 定义 `resolveActiveProcessModeAndAudit()`，返回 `activeProcessMode: "chat" | "passthrough"`。
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-chat-process-request-utils.ts:34` 调用 `resolveActiveProcessModeWithNative()`，可在 Hub Pipeline 内部决定启用 passthrough。
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-chat-process-request-utils.ts:39` 会把 `normalized.processMode` 改写成 `activeProcessMode`。
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-chat-process-request-utils.ts:41` 当 `activeProcessMode === "passthrough"` 时构建 `passthroughAudit`。
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage-inbound.ts:154` 当 `activeProcessMode !== "passthrough"` 才执行 mappable semantics gate；passthrough 会绕过该 gate。
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage-inbound.ts:164` 当 `activeProcessMode === "passthrough"` 时跳过 `runReqProcessStage1ToolGovernance()`。
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-governance-blocks.ts:28` 当 `activeProcessMode === "passthrough"` 时返回 `undefined`，直接跳过 governance。
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage-provider-payload.ts:164` 当 `activeProcessMode === "passthrough"` 时直接 `jsonClone(rawRequest)` 生成 `providerPayload`，跳过 outbound hooks/semantic mapper 主链。
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-route-and-outbound.ts:102` 当 passthrough 且 entry/outbound 协议不一致时抛错，说明 passthrough 是实际路由执行分支。
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics-passthrough.ts:115` 定义 `resolveActiveProcessModeWithNative()`。
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts:302` 仍要求 `resolveActiveProcessModeJson` native export。

边界证据：
- `src/server/runtime/http-server/router-direct-pipeline.ts` 是 server/router 层 same-protocol direct bypass；它不是 Hub Pipeline passthrough。
- `src/providers/core/runtime/responses-provider.ts` 的 SSE passthrough 是 provider runtime 传输级直传；不是 Hub Pipeline `processMode='passthrough'`。
- 已删除的 `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/route-aware-responses-continuation.ts` 曾含 `passthrough_remote_direct` responses continuation 解析模式；该模式不属于 Hub Pipeline processMode passthrough。当前 continuation 真源在 Rust `hub_pipeline_blocks/responses_resume.rs` / `shared_responses_conversation_utils.rs`。

## 3. 问题判断

Hub Pipeline 目前存在两套同协议直传语义：
- server/router direct：server 层根据 port `sameProtocolBehavior='direct'` 直连 provider。
- Hub Pipeline passthrough：Hub Pipeline 内部通过 `processMode='passthrough'` 跳过 semantic/gov/outbound hooks，并 raw payload 透传。

这违反当前单一路径要求：模型覆盖、baseUrl 覆盖、thinking 覆盖、响应模型反向覆盖、usage 提取等语义应在请求/响应 hooks 或 provider runtime 唯一路径执行，不能被 Hub Pipeline 内部 passthrough 绕过。

## 4. 范围与边界

In scope：
- 移除 Hub Pipeline `processMode='passthrough'` 执行分支。
- 收敛 Hub Pipeline 类型、metadata 归一、native bridge wrapper、builder、tests。
- 删除 passthrough 专用 audit/governance skip/native wrapper 文件与 exports。
- 添加/更新测试证明 Hub Pipeline 不再 raw passthrough。

Out of scope：
- 不删除 server/router direct pipeline。
- 不删除 provider runtime SSE passthrough。
- 不删除 responses continuation 的 `passthrough_remote_direct`，除非后续另有证据证明其属于同一错误语义。
- 不改 Virtual Router provider selection、health、quota 语义。

## 5. 移除计划

### Phase 1：锁定测试与证据
- 新增/更新 Hub Pipeline 定向测试：输入 metadata/processMode/message 触发 passthrough 时，最终仍走 chat path。
- 覆盖语义：semantic gate 不被跳过；tool governance 不被跳过；providerPayload 来自 outbound hooks，不是 raw request clone。
- 增加 grep 级守卫：Hub Pipeline processMode passthrough 分支不得复活。

### Phase 2：收敛入口
- 修改 `hub-pipeline-chat-process-request-utils.ts`：删除 `resolveActiveProcessModeAndAudit()` 的 passthrough 决策，返回固定 `chat` 或改为 `resolveActiveProcessMode()` 固定 chat。
- 移除 `normalized.processMode = activeProcessMode` 的 passthrough 改写能力。
- 修改 normalize request 相关 blocks：metadata 中 `processMode='passthrough'` 不再产生 passthrough，必须归一为 `chat` 或 fail-fast 报错。

### Phase 3：删除执行分支
- 删除 inbound semantic gate 的 passthrough bypass。
- 删除 governance passthrough skip branch。
- 删除 provider payload raw clone passthrough branch。
- 删除 route/outbound 的 passthrough protocol-matching branch。
- 删除 passthrough audit 在 provider payload/result metadata 中的传递。

### Phase 4：删除死代码与 native exports
- 删除 `native-hub-pipeline-orchestration-semantics-passthrough.ts` 中仅服务 processMode passthrough 的函数。
- 删除 `resolveActiveProcessModeJson`、`buildPassthroughAuditJson`、`annotatePassthroughGovernanceSkipJson`、`attachPassthroughProviderInputAuditJson` 等 native required exports。
- 删除 `hub-pipeline-provider-payload-passthrough-blocks.ts` 等只服务该模式的文件。
- 更新 TS/Rust/NAPI binding 相关 tests 与 snapshots。

### Phase 5：验证与落盘
- 跑 Hub Pipeline 定向测试。
- 跑 router-direct/provider-direct 相关测试，确保 server 层 direct 不受影响。
- 跑 build/min 或项目规定最小构建验证。
- 更新 `note.md`、必要时把已验证结论提炼到 `MEMORY.md`。

## 6. 风险与规避

- 风险：旧配置/metadata 仍传 `processMode='passthrough'`。处理：fail-fast 或强制归一为 chat，禁止隐式双路径。
- 风险：servertool 曾依赖 passthrough skip。处理：测试证明 governance 始终执行；如有冲突，修 servertool 真源，不恢复 passthrough。
- 风险：router-direct 与 Hub Pipeline passthrough 混淆。处理：保留 `src/server/runtime/http-server/router-direct-pipeline.ts`，只删 Hub Pipeline 内部 processMode 分支。
- 风险：native required export 未同步导致启动失败。处理：同步删除 TS wrapper、required export 列表、Rust/NAPI export、测试。

## 7. 验证矩阵

- Static grep：`sharedmodule/llmswitch-core/src/conversion/hub/pipeline/` 不再存在 `activeProcessMode === "passthrough"` / raw clone provider payload branch。
- Unit：Hub Pipeline request stage 对 passthrough 触发输入仍执行 semantic gate/tool governance/outbound mapper。
- Unit：router-direct same-protocol direct 仍可用且不依赖 Hub Pipeline passthrough。
- Build：TypeScript build/min 通过。
- Optional live：同协议 router direct 请求用 server 层 direct，relay 请求用 Hub Pipeline chat path。

## 8. 完成定义

- Hub Pipeline 只有 chat 主路径。
- passthrough mode 不再能跳过 request hooks、semantic gate、tool governance、outbound mapper。
- 旧 passthrough 专用代码物理删除，不留未调用死代码。
- 证据、测试、构建结果落盘并回报。
