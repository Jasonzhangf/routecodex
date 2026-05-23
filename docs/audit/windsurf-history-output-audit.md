# Windsurf Provider 历史记录与工具输出审计

日期：2026-05-23
范围：RouteCodex `src/providers/core/runtime/windsurf-chat-provider.ts` 对比只读参考 `/Volumes/extension/code/WindsurfAPI`。
约束：本审计未修改 `/Volumes/extension/code/WindsurfAPI`。

## 1. 审计目标

用户现场反馈：

1. 工具执行可用，但看起来有截断输出。
2. 历史记录有丢失，执行会循环。
3. 需要对齐 WindsurfAPI 的历史记录部分，输出审计报告，不修改 WindsurfAPI。

本报告只做证据对齐与差异定位；不把当前 RouteCodex 的实现状态重新定义为完成。

## 2. 参考实现事实：WindsurfAPI

参考文件：`/Volumes/extension/code/WindsurfAPI/src/client.js`。

### 2.1 历史投影方式

`cascadeChat()` 在新 cascade 发送时，把 OpenAI 风格 `messages` 投影为单个 Cascade 文本：

- `system` 消息先合并为 `sysText`，并通过 `compactSystemPromptForCascade()` 中和高风险身份措辞。
- `convo = messages.filter(role === 'user' || role === 'assistant')`。
- 多轮时，从倒数第二轮向前回放历史，格式为：
  - user → `<human>... </human>`
  - assistant → `<assistant>... </assistant>`
- 最新一轮单独作为 `<human>latest</human>`。
- 如果超出历史预算，会加入：`<truncation_note>... Do NOT ask the user to repeat their task ...</truncation_note>`。

关键点：WindsurfAPI 并不把 OpenAI `tool` role 原样塞进普通历史；工具语义通过专门归一化/桥接处理。

### 2.2 历史预算与截断策略

参考文件：`/Volumes/extension/code/WindsurfAPI/src/client.js`。

- 默认历史预算来自 `CASCADE_MAX_HISTORY_BYTES`，默认 `600_000` bytes。
- 截断只发生在历史回放层，不应裁剪真实工具输出语义。
- 截断时必须显式告知模型历史被截断，并要求继续而不是向用户要重复上下文。

这说明“看起来有截断输出”需要区分两类：

- 合法历史预算截断：有 truncation note，且保留最新任务/工具结果。
- 非法工具结果截断：工具输出本体被裁剪后仍当完整结果传给模型，会导致模型误判或重复调用。

### 2.3 工具结果与循环防护

参考测试：

- `/Volumes/extension/code/WindsurfAPI/test/tool-emulation.test.js`
- `/Volumes/extension/code/WindsurfAPI/test/cascade-native-bridge.test.js`
- `/Volumes/extension/code/WindsurfAPI/test/cascade-timeout-invalidation.test.js`

已验证的关键规则：

1. 工具 preamble 只注入最新真实用户消息，不注入 synthetic `tool_result` 消息。
2. 历史中 assistant tool_calls 需按目标模型方言序列化；不能丢失 tool call 语义。
3. 对 native tool bridge，已执行工具结果通过 native additional steps 表达，让 Cascade 从“工具已完成”状态继续推理。
4. upstream timeout / context deadline 后，旧 cascade entry 必须判死，避免下一轮复用半坏 trajectory。否则模型只看到最后 tool_result，丢失原始任务并循环。

## 3. RouteCodex 当前实现事实

主文件：`src/providers/core/runtime/windsurf-chat-provider.ts`。

### 3.1 历史投影入口

RouteCodex 当前入口：

- `parseCascadeSemanticRoundtripSync()`：把 OpenAI/Responses 历史转为 `WindsurfSemanticTurn[]`。
- `buildCascadePromptText()`：把 semantic history 投影为 Cascade 文本。
- `buildCascadeAdditionalStepsFromSemanticConversation()`：把等价 native 工具历史转为 Cascade `additionalSteps`。
- `buildWindsurfRccToolResultContext()`：把非等价 RCC 工具结果转为 `<|RCC|tool_result ...>` 上下文。

当前结构已经在方向上接近 WindsurfAPI：普通文本历史走 `<human>/<assistant>`，native 工具结果走 additional steps，非等价工具走 RCC result context。

### 3.2 与 WindsurfAPI 已对齐的点

1. 多轮普通文本历史使用 `<human>` / `<assistant>` 包裹。
2. 有历史预算与 `<truncation_note>`。
3. native tool 的 tool_call-only assistant / tool result 不应污染普通文本历史；已有测试覆盖：`native cascade history must strip assistant tool-call-only and tool result turns like WindsurfAPI native bridge`。
4. submit continuation 仅有 `function_call + function_call_output` 时，最新 Cascade 文本应使用工具结果，不应回到原始 user prompt；已有测试覆盖：`native submit continuation with only function_call + function_call_output must send tool result as latest cascade text, not empty prompt`。

## 4. 发现的问题与风险

### P0：timeout 过短会制造“历史丢失/循环”的假象

已现场验证：30s timeout 会在正常边界附近触发 `WINDSURF_FETCH_TIMEOUT`。WindsurfAPI 参考默认 `CASCADE_MAX_WAIT_MS = 600_000`，且对 tool-active 有更长等待窗口。

RouteCodex 已发现硬编码 30s：

- `fetchWithTimeout(..., 30000)` 用于 Windsurf PostAuth。
- `grpcUnaryLocal(..., timeout = 30_000)` 用于 local LS gRPC，包括 trajectory polling。

已修正为 5 分钟默认并可配置：

- `WINDSURF_CASCADE_TIMEOUT_MS = 300_000`
- `ROUTECODEX_WINDSURF_CASCADE_TIMEOUT_MS`
- `RCC_WINDSURF_CASCADE_TIMEOUT_MS`

风险解释：timeout 不是单纯等待问题。若 Cascade/trajectory 在工具结果提交后超时，下一轮可能看到半坏 trajectory 或不完整 tool result，表现为“模型丢历史、重复调用工具”。WindsurfAPI 专门有 `cascade-timeout-invalidation.test.js` 防这个问题。

### P1：RouteCodex 需要审计 timeout 后 cascade entry 判死/重放逻辑

WindsurfAPI 的规则：当出现 `context deadline exceeded` / `context cancellation while reading body` / `Client.Timeout` 时，必须标记 `reuseEntryDead = true`，避免复用半坏 cascade。

RouteCodex 当前 Windsurf provider 不完全复用 WindsurfAPI 的 conversation pool 模式，但仍有本地 warmup/session/cascade 生命周期和 trajectory polling。需要确认：

- `WINDSURF_FETCH_TIMEOUT` 出现在 `pollCascadeTrajectorySteps()` 后，是否会清理或重建对应 cascade 状态。
- submit continuation 后如果 trajectory 只包含 completed native result 而无 final assistant text，是否会继续等待而不是返回空/旧 tool call。

现有 RouteCodex 测试名显示已经关注过类似场景，例如：

- `pollCascadeTrajectorySteps must not finalize empty assistant while only completed native result steps are visible`
- `pollCascadeTrajectorySteps must keep polling when completed native result is visible but final assistant text is empty`
- `pollCascadeTrajectorySteps must return final text even when current trajectory has only completed native result step`

但在线现象仍出现过重复 tool call，因此需要用最新 5min timeout 重新做在线验证，而不能只靠旧单测结论。

### P1：非等价 RCC 工具结果必须进入专用 result context，不能被普通历史预算吞掉

RouteCodex 对非等价工具的设计是：

- unsupported tools 进入 `windsurf_unsupported_text_tools`。
- prompt 中注入 RCC tool contract。
- assistant 输出 `<|RCC|tool_calls>...`。
- `harvestWindsurfRccToolCalls()` 收割成 OpenAI tool_calls。
- submit 后 `buildWindsurfRccToolResultContext()` 把 `<|RCC|tool_result id="...">` 注入下一轮。

风险点：`buildCascadePromptText()` 的 `prefixParts` 包含 `rccResults`，并把 `prefixParts` 长度计入历史预算，但如果 tool result 很大，可能挤掉历史回放。WindsurfAPI 的原则是“最新任务和最新工具结果必须保留”。RouteCodex 需要在线验证大一点的 RCC tool output 是否仍能让模型看见结果，而不是重复同一 RCC invocation。

### P2：普通 assistant 历史可能不能表达 tool_calls 语义，只能靠 additionalSteps/RCC context

WindsurfAPI 普通 `<assistant>` 历史来自 `contentToString(m.content)`，工具语义另走 bridge。RouteCodex 也类似，测试要求 native tool_call-only 和 tool result 不进入普通 assistant 文本。

这意味着若某个工具调用没有被成功分类为 native additionalSteps 或 RCC tool_result，它就会从普通历史里“消失”。这正是“历史丢失导致循环”的高风险路径。

需要重点检查：

- `apply_patch`、`update_plan` 等非等价工具是否稳定留在 RCC text path。
- `shell_command` 等等价工具是否稳定进入 native additionalSteps。
- 混合 native + RCC 的同一轮，两个结果是否都保留在各自路径中。

## 5. 与当前在线证据的关联

已完成在线证据：

- Windsurf 请求能发到 provider / LS / Cascade，且能返回 200。
- `shell_command` 等价 native tool：fresh 0.90.2255 首轮返回 `requires_action`，submit 后返回 final `NATIVE_DONE`。

仍未完成在线证据：

- 非等价工具（例如 `apply_patch`）走 RCC 文本请求与收割方式的完整在线验证。
- 大输出/长输出工具结果是否会被错误截断并导致重复调用。
- timeout 后是否存在半坏 cascade 复用。

## 6. 建议的下一步验证矩阵

### 6.1 RCC 非等价工具闭环

目标工具：`apply_patch` 或最小自定义 unsupported tool。

验收证据：

1. `/v1/responses` 首轮返回 `status=requires_action`。
2. tool call name 是非等价工具名，例如 `apply_patch`，且 request log 证明它不是 native mapped tool。
3. submit 工具输出后，下一轮不重复同一 tool call。
4. final response 引用工具输出并完成。
5. log 中能看到 RCC harvest 或 response 中由文本收割出的 tool_call。

### 6.2 工具输出不截断验证

构造工具输出包含：

- 头部 marker：`BEGIN_Rcc_Long_Output`
- 中段 marker：`MIDDLE_Rcc_Long_Output`
- 尾部 marker：`END_Rcc_Long_Output`

验收：submit 后 final answer 必须同时提到三段 marker。若只提到头/中，不提尾，即证明输出被截断或历史投影丢尾。

### 6.3 timeout 后状态验证

用 5min timeout 后复查：

- 日志中的 `grpc.write timeout` 应从 `30000` 变为 `300000`。
- 若仍出现 `WINDSURF_FETCH_TIMEOUT`，检查对应 request 是否复用旧 cascade、是否存在只带 tool_result 无原始任务的下一轮。

## 7. 结论

1. 30s timeout 与 WindsurfAPI 的等待模型不一致，已确认是高风险根因之一；应使用 5 分钟以上 timeout。
2. RouteCodex 架构方向与 WindsurfAPI 基本一致：普通历史文本、native additionalSteps、RCC tool_result 三路分离。
3. 当前最大未闭合风险不是“是否能执行工具”，而是“所有工具结果是否都进入正确历史通道，并在 submit 后阻止重复调用”。
4. 完成目标前，必须补上 RCC 非等价工具在线闭环和长输出 marker 验证。
