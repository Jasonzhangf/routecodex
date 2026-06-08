# Stopless Full Delivery Plan

## 1. 目标

交付可提交、可上线验证、可回归的 stopless 完整功能，覆盖以下闭环：

1. stop schema 不再以原始 JSON 直接泄漏到用户可见内容。
2. `stop_message_auto` 在 `/v1/responses` 与 `/v1/responses.submit_tool_outputs` 恢复轮次中都能正确重复触发。
3. 停止判定只由唯一 stopless gate 负责，不允许多处早退、重复判定、历史恢复分叉。
4. 预算、重置、allow-stop、budget-exhausted、missing-schema、invalid-schema 的语义在线上 5555 端口可复现验证。
5. 最终产物是可 review、可 commit、可 push 的完整 stopless 提交，不是局部 patch。

## 2. 验收标准

必须同时满足：

1. 代码 owner 收敛到唯一正确点，错误早退路径被物理删除。
2. 定向测试全绿，且覆盖 stopless 停止设定全部关键分支。
3. `routecodex restart --port 5555` 后完成真实 live probe，不以单测替代。
4. 每个 live probe 有 request id / response id / log / sample 文件证据。
5. 最终 commit 只包含 stopless 相关必要改动、测试、文档、记忆更新。

## 3. 范围

### In Scope

1. stopless gate / schema gate / repeat budget / reset semantics。
2. `stop_message_auto` CLI projection 与 submit_tool_outputs 恢复链路。
3. 用户可见 summary / reasoning / text 槽位的 stop schema 泄漏治理。
4. 5555 live validation 脚本、样本、日志证据。
5. stopless 相关文档、note、MEMORY、commit closeout。

### Out of Scope

1. `vision_auto` / `web_search` 的独立后端 reenter 语义。
2. 非 stopless 的 provider cooldown / direct relay / multimodal 路由问题。
3. 与 stopless 无关的 Responses/Provider runtime 脏改动。

## 4. 设计原则

1. 唯一路径：`HubRespChatProcess03Governed -> stop-message-core -> stop_message_auto CLI projection -> client exec_command -> submit_tool_outputs -> normal request chain -> stop-message-core`。
2. 唯一判定：停止条件只由 Rust stop schema gate 决定；TS 只做薄壳与用户可见投影，不再新增第二套停止语义。
3. 唯一可见出口：stopless 只投影 `exec_command`，不恢复内部 servertool identity，不走 followup/reenter 私有链路。
4. 无 fallback：判定错就 fail-fast；不允许 schema sanitizer、provider 特例、临时旁路。
5. 线上优先：没有 5555 live 证据，不宣称 stopless 完成交付。

## 5. 风险点

1. 恢复轮次仍存在隐藏早退：source 可能不止一处 `submit_tool_outputs` short-circuit。
2. 用户可见 schema 泄漏不只在 `output_text`，还可能出现在 `reasoning_text`、`reasoning.summary[*]`、chat completion text。
3. 单测与全局安装运行版本可能不一致，必须 rebuild + sync + restart 验证。
4. 停止预算状态可能被旧 session/requestId 污染，live probe 必须使用新 request scope。

## 6. 测试设计总览

测试分四层，缺一不可：

1. Rust owner 单元层：锁 stop gate、预算、reset、resume 资格。
2. TS/Native 定向层：锁 CLI projection、visible summary、request restore。
3. HTTP 黑盒层：锁 `/v1/responses` 与 `/v1/responses.submit_tool_outputs` 整体契约。
4. 5555 live 层：锁真实运行版本、真实 provider、真实日志样本。

## 7. 详细测试矩阵

### 7.1 Rust stop gate 单元测试

目标：证明停止设定的唯一 owner 正确。

建议文件：

- `sharedmodule/llmswitch-core/rust-core/crates/stop-message-core/src/lib.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/stop-message-core/tests/*`

用例：

1. `goal active` 跳过 stopless gate。
2. `plan mode` 跳过 stopless gate。
3. 非 stop 响应 reset 连续预算。
4. 工具调用响应 reset 连续预算。
5. 缺 schema 不消耗 budget，继续 followup。
6. schema 存在但 `stopreason` 非数字，消耗 budget。
7. `stopreason=0` 且 `reason` 非空，`allow_stop`。
8. `stopreason=1` 且 `reason` 非空，`allow_stop`。
9. `stopreason=2` 且 `next_step` 非空，继续执行并消耗 budget。
10. `stopreason=2` 缺 `next_step`，继续执行并消耗 budget。
11. 连续 3 次 provided-schema invalid/continue 后 budget exhausted。
12. 连续 10 次 missing-schema 后 budget exhausted。
13. `submit_tool_outputs resume` 仍然 eligible，不允许无条件 skip。
14. `allow_stop` / 非 stop / 工具响应之后，下一次 stop 从 `used=0` 重新计数。

验收断言：

1. 每个分支都返回稳定 action：`skip` / `continue` / `allow_stop` / `budget_exhausted`。
2. repeat counter 与 reset 原因必须明确可断言。

### 7.2 CLI projection 与可见输出测试

目标：证明 stopless 触发后，用户看到的是 markdown/summary，而不是 schema JSON。

建议文件：

- `tests/servertool/stop-message-auto.spec.ts`
- `tests/servertool/stop-message-native-decision.spec.ts`
- `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts`

用例：

1. stopless 触发时返回 `exec_command`，命令为 `routecodex servertool run stop_message_auto --input-json ...`。
2. `continuationPrompt` 包含目标、已完成、状态、下一步、证据、根因、已排除因素、排查顺序、learned 九项核对。
3. 被拦截 stop 文本映射到 `reasoning.summary` 或等价用户可见 summary。
4. `content` / `text` / `output_text` 中不包含 stop schema JSON。
5. `reasoning_text` / `reasoning_content` / `reasoning.summary[*].text` 中不包含 stop schema JSON。
6. 若 schema 文本不存在，仅展示正文内容，不显示空 summary 字段。
7. `allow_stop` 最终 summary 允许保留人类可读结论，但不暴露 schema 控制字段。
8. CLI result 恢复后不恢复内部 `stop_message_auto` tool identity。

验收断言：

1. 用户可见字段只剩正文/summary markdown。
2. CLI input 与 visible summary 各自职责清晰，不互相污染。

### 7.3 HTTP 黑盒测试

目标：证明 request/response 整链 stopless 契约成立，不被早退短路。

建议文件：

- `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts`

用例：

1. 第一轮 `/v1/responses` 命中 stopless，返回 `requires_action` + `exec_command`。
2. 客户端执行 CLI 后，用 `/v1/responses/{id}/submit_tool_outputs` 恢复。
3. 恢复轮次若再次 `finish_reason=stop` 且 `stopreason=2`，必须再次 stopless，不得直接 completed。
4. 恢复轮次若 `stopreason=0|1` 且合法，必须 allow-stop，并输出清洗后的最终 summary。
5. 恢复轮次若 budget exhausted，必须返回最终 stop summary，而不是无限继续。
6. 黑盒中禁止出现 “历史有 stop_message_auto CLI result -> 整轮 passthrough”。
7. 任意非 stop 正常响应后，下一轮再次 stop 时 repeatCount 必须重置。

验收断言：

1. `result.executed` 在应触发 stopless 时为 `true`。
2. `result.finalChatResponse` 符合 Responses 顶层契约。
3. 恢复轮次出现新的 stopless trace/log，而不是完全静默。

### 7.4 5555 live 验证矩阵

目标：把“测试通过”提升为“真实运行版本通过”。

前置：

1. `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs`
2. `cd sharedmodule/llmswitch-core && npm run build -- --pretty false`
3. 如运行版本是全局安装，确认必要 dist/native 已同步到全局安装目录。
4. `routecodex restart --port 5555`
5. `curl http://127.0.0.1:5555/health`

固定 live probe 模型：

1. 优先使用已验证能命中 stopless 的 cross-protocol / relay 路径，例如 `mini27.MiniMax-M2.7`。
2. 避免 same-protocol direct 路径，因为该路径按设计不激活 stopless。

必跑 live case：

1. 首轮 stopless 触发
   - 发送 `/v1/responses`
   - 断言 `status=requires_action`
   - 断言 tool name 为 `exec_command`
   - 记录 request id / response id / sample 路径 / 日志行
2. 恢复轮次再次 continue
   - 执行 `routecodex servertool run stop_message_auto --input-json ...`
   - 发送 `/v1/responses/{id}/submit_tool_outputs`
   - 断言若模型再次返回 `stopreason=2`，响应继续为 `requires_action`，而不是 `completed`
   - 断言日志出现新的 `stop_message_auto stage=entry/summary`
3. 恢复轮次 allow-stop
   - 构造 stop schema `stopreason=0` 或 `1`
   - 断言返回 completed
   - 断言最终用户可见内容为 markdown/summary，不含 schema JSON
4. budget exhausted
   - 连续制造 3 次 provided-schema invalid/continue stop
   - 断言第 4 次不再继续投影 `exec_command`
   - 断言最终 summary 明确说明停止
5. missing-schema budget
   - 连续制造缺 schema 的 stop
   - 断言前 9 次仍继续，第 10 次预算耗尽
6. reset 语义
   - 先触发 stopless 1 次
   - 再让模型产生一次非 stop 或工具调用
   - 再次 stop 时断言 `repeatCount` 从 0 开始

live 证据要求：

1. 每个 case 记录 request id、response id、tool_call_id。
2. 保存 `~/.rcc/codex-samples/**/client-request*`、`provider-request*`、`client-response*`。
3. 保存 `~/.rcc/logs/server-5555.log` 对应时间段日志。
4. 若失败，附首个错误出现的契约节点，不得只写“没效果”。

### 7.5 停止设定专项测试矩阵

目标：把“什么时候继续、什么时候允许停、什么时候预算耗尽、什么时候 reset”全部锁成唯一可回归真相。

#### A. 触发前置矩阵

1. `goal.status=active` + `finish_reason=stop`
   - 预期：`skip`
   - 验证：不投影 `exec_command`，不增加 stop budget。
2. 非 active `/goal` + `finish_reason=stop`
   - 预期：`continue`
   - 验证：投影 `exec_command`，`repeatCount=0/maxRepeats=3`。
3. 非 `/goal` + `finish_reason=stop`
   - 预期：`continue`
   - 验证：投影 `exec_command`，进入 stop schema 校验。
4. `finish_reason!=stop`
   - 预期：`skip_and_reset`
   - 验证：stop budget 清零，后续 stop 从头计数。
5. assistant 输出真实工具调用
   - 预期：`skip_and_reset`
   - 验证：不允许把工具调用误判成 stopless。

#### B. Schema 完整性矩阵

1. 完整 schema：`stopreason=0` + `reason` 非空
   - 预期：`allow_stop`
   - 验证：completed，summary 为人类可读 markdown，不泄漏控制字段。
2. 完整 schema：`stopreason=1` + `reason` 非空
   - 预期：`allow_stop`
   - 验证：completed，保留阻塞原因与证据摘要。
3. 完整 schema：`stopreason=2` + `next_step` 非空
   - 预期：`continue`
   - 验证：requires_action，再次投影 `exec_command`。
4. 缺 `stopreason`
   - 预期：`continue_missing_schema`
   - 验证：不计 invalid budget，走 missing-schema 计数。
5. `stopreason` 非数字或越界
   - 预期：`continue_invalid_schema`
   - 验证：计入 provided-schema invalid budget。
6. `stopreason=0|1` 但 `reason` 为空
   - 预期：`continue_invalid_schema`
   - 验证：禁止 allow-stop。
7. `stopreason=2` 但 `next_step` 为空
   - 预期：`continue_invalid_schema`
   - 验证：要求继续目标或补完整 schema。
8. `has_evidence=0` 且 claim 为完成/阻塞
   - 预期：`continue_invalid_schema`
   - 验证：不能无证据停。
9. 文本字段只有 schema 无正文
   - 预期：`continue_or_allow_stop` 取决于 schema，但用户可见区不展示裸 schema。
   - 验证：`content/text/output_text/reasoning.summary` 不含 schema JSON。

#### C. 预算矩阵

1. 连续 1 次 `stopreason=2`
   - 预期：`continue`，`repeatCount=1`
2. 连续 2 次 `stopreason=2`
   - 预期：`continue`，`repeatCount=2`
3. 连续 3 次 `stopreason=2`
   - 预期：`continue`，`repeatCount=3`
4. 第 4 次 `stopreason=2`
   - 预期：`budget_exhausted`
   - 验证：不再投影新 `exec_command`，输出最终停止说明。
5. 连续 missing-schema 第 1-9 次
   - 预期：`continue`
   - 验证：仍允许继续，不误算到 provided-schema budget。
6. 第 10 次 missing-schema
   - 预期：`budget_exhausted`
7. 连续 invalid-schema 第 1-3 次
   - 预期：`continue`
8. 第 4 次 invalid-schema
   - 预期：`budget_exhausted`

#### D. Reset 矩阵

1. `continue` 之后收到一次非 stop 正常正文
   - 预期：reset
   - 验证：下次 stop 的 `repeatCount=0`。
2. `continue` 之后收到一次真实工具调用
   - 预期：reset
   - 验证：下次 stop 不继承旧 repeatCount。
3. `allow_stop` 完成后新请求再 stop
   - 预期：reset
   - 验证：新轮 stop 从头计数。
4. `budget_exhausted` 后新 request scope 再 stop
   - 预期：reset
   - 验证：旧 exhausted 状态不跨 request/session 污染。
5. `submit_tool_outputs` resume 同 request scope 再 stop
   - 预期：不 reset
   - 验证：正确继承同闭环 repeatCount。

#### E. 恢复链路矩阵

1. 第一轮 `/v1/responses` stopless 触发
   - 预期：`requires_action`
   - 验证：返回 `exec_command routecodex servertool run stop_message_auto --input-json ...`。
2. `submit_tool_outputs` 回链后再次 `stopreason=2`
   - 预期：再次 `requires_action`
   - 验证：`repeatCount` 递增，不直接 completed。
3. `submit_tool_outputs` 回链后 `stopreason=0|1`
   - 预期：`completed`
   - 验证：最终 summary 已转 markdown，不暴露 schema。
4. `submit_tool_outputs` 当前请求只带 prior `exec_command/function_call_output` 历史
   - 预期：仍可恢复 stopless runtime state
   - 验证：不会因为少当前轮 runtime snapshot 而早退。

#### F. 用户可见输出矩阵

1. 原始 assistant stop 文本含 schema JSON
   - 预期：用户只看到 markdown summary
   - 验证：schema 字段只存在 CLI input，不存在 client visible text。
2. 原始 assistant stop 文本含自然语言正文 + schema
   - 预期：只保留自然语言正文/summary
3. 原始 assistant stop 文本只有 schema、无正文
   - 预期：不显示空内容字段；必要时只显示系统生成 summary
4. 最终 allow-stop 输出
   - 预期：保留结论、证据、下一步建议的自然语言，不泄漏 `stopreason/has_evidence` 等控制键。

#### G. 线上闭环矩阵

1. 5555 首轮 stopless
   - 证据：`request_id`、`response_id`、`requires_action`、`exec_command`。
2. 5555 恢复轮次 continue
   - 证据：第二次 `requires_action`、`repeatCount=2`、新日志行。
3. 5555 恢复轮次 allow-stop
   - 证据：`completed` + 无 schema 泄漏。
4. 5555 budget exhausted
   - 证据：达到阈值后不再投影 `exec_command`。
5. 5555 reset
   - 证据：插入一次非 stop/工具调用后，后续 stop 从 `repeatCount=0` 重算。

## 8. 实施步骤

1. 审核 stopless 唯一 owner 链，找出恢复轮次与 visible summary 的唯一错误点。
2. 物理删除错误早退/重复判定实现，不保留“兼容旧逻辑”。
3. 先补红测，再修 owner，再补 live probe 脚本。
4. 跑 Rust/TS/blackbox 定向测试。
5. rebuild、sync、`routecodex restart --port 5555`。
6. 按 5555 live 验证矩阵逐项跑，失败就回到唯一 owner 修正。
7. live 全绿后更新 `note.md` 与 `MEMORY.md`。
8. review diff，只保留 stopless 必要改动。
9. commit、push，并在提交说明中写清 live evidence。

## 9. 必跑命令清单

1. `cargo test -p stop-message-core -- --nocapture`
2. `npm run jest:run -- --runTestsByPath tests/servertool/stop-message-native-decision.spec.ts tests/servertool/stop-message-auto.spec.ts tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts --runInBand --forceExit`
3. `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs`
4. `cd sharedmodule/llmswitch-core && npm run build -- --pretty false`
5. `routecodex restart --port 5555`
6. `curl http://127.0.0.1:5555/health`
7. 自定义 live probe 脚本：首轮 `/v1/responses` + 本地执行 CLI + `submit_tool_outputs`

## 10. 完成定义（DoD）

以下全部满足才算 stopless 可提交：

1. source 中不存在已知错误的 stopless 早退 owner。
2. stop schema 不再出现在任何用户可见 summary/text/reasoning 槽位。
3. submit_tool_outputs 恢复轮次可再次 stopless，而不是一轮后停掉。
4. 预算、allow-stop、missing-schema、invalid-schema、reset 在测试与 live 行为一致。
5. 5555 live 矩阵关键用例有真实证据。
6. `note.md` 记录排障线索，`MEMORY.md` 只记录已线上验证结论。
7. 完成 review、commit、push。

## 11. 失败判定

任一条件成立即视为未完成：

1. 只跑单测，没有 5555 live 证据。
2. 恢复轮次仍然 `completed` 且没有再次 stopless。
3. 用户可见输出还出现 schema JSON。
4. 通过 fallback/sanitizer/provider 特例掩盖问题。
5. commit 中混入 stopless 无关脏改动却未说明。
