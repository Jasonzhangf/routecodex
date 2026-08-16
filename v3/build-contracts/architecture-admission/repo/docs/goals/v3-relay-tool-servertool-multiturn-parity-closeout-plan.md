# V3 Relay Tool and Servertool Multiturn Parity Closeout Plan

## 1. 目标与验收标准

目标：补齐 V3 Relay 在真实多轮工具、servertool、history 和附件治理上的 V2 功能等价验证面，证明已实现的 Hub v1 Relay 主流水线不仅能 controlled closeout，还能承载协议级工具生命周期。

验收标准：

- Anthropic Messages、OpenAI Chat、Gemini、Responses entry 均通过同一 Hub v1 Relay Chat Process 工具治理路径。
- 普通 tool/function call、tool result、servertool hook profile、apply_patch/MCP/native tool 语义均只在 Rust Chat Process owner 内治理。
- 多轮工具上下文只在合法 continuation save/restore 边界保存和恢复；server/handler/outbound/SSE 不补 history。
- 图片/附件类工具历史在发送后按配置替换为占位或释放附件资源，不把历史大附件重复送入 provider payload。
- JSON/SSE 正向与错误路径均只有一个 response exit；provider/client normal payload 不泄漏 RouteCodex control/debug/metadata。

## 2. 范围与边界

In scope：

- 新 feature：v3.relay_tool_servertool_multiturn_parity_closeout。
- V3 Relay 协议工具矩阵：Anthropic、OpenAI Chat、Gemini、Responses 的工具声明、调用、结果、finish/stop reason、stream delta 和 terminal ordering。
- servertool request/response hook profile 的真实多轮闭环。
- apply_patch、MCP/native、custom tool、function tool、图片/附件占位清理的 Relay history governance。
- Error01-06、side-channel isolation、one-response-exit、copy-budget 和 no-materialization gates。

Out of scope：

- Provider transport socket/cache lifecycle；它归 provider runtime owner。
- Responses client-facing inbound WebSocket proxy；它归 v3.responses_inbound_websocket_proxy。
- Direct remote continuation exact provider pin；它归 v3.responses_direct_remote_continuation_integration。
- live config、provider credential、global install/restart、P6 deletion、production cutover。

## 3. 设计原则

- Hub/Chat Process 是工具治理唯一 owner；Server、SSE、handler、provider runtime 不修 tool/history。
- servertool 是 Chat Process hook profile，不拥有专用响应出口或第二生命周期。
- continuation immutable interval 优先级最高；save 后到下一轮 restore 前不得语义转换。
- 附件清理只改变历史资源引用形态，不裁剪真实当前请求语义。
- no fallback：工具不兼容、tool result 顺序错误、附件资源缺失必须显式失败。

## 4. 技术方案与文件清单

必须先查：

- docs/architecture/wiki/v3-hub-relay-fixed-pipeline.md
- docs/goals/v3-hub-relay-runtime-closeout-plan.md
- docs/design/v3-hub-relay-fixed-pipeline-contract.md
- .agents/skills/rcc-dev-skills/references/22-servertool-hook-skeleton-workflow.md
- .agents/skills/rcc-dev-skills/references/23-servertool-hook-dev-debug-flow.md
- .agents/skills/rcc-dev-skills/references/25-protocol-sse-continuation-boundary.md
- V3 resource/function/mainline/verification maps

候选实现面：

- v3/crates/routecodex-v3-runtime/src/hub_v1*
- v3/crates/routecodex-v3-runtime/src/local_continuation.rs
- v3/crates/routecodex-v3-runtime/tests/*tool*
- v3/crates/routecodex-v3-server/tests/*
- protocol codec owner files under v3/crates/routecodex-v3-runtime/src/hub_v1
- scripts/architecture/verify-v3-relay-tool-servertool-multiturn-parity.mjs
- scripts/tests/v3-relay-tool-servertool-multiturn-parity-red-fixtures.mjs
- V3 maps/manifest/wiki/review surface

## 5. 风险与规避

- 风险：为了过多轮工具测试在 Server/handler 补 history。规避：source gate 禁止 handler/outbound/transport tool repair。
- 风险：servertool 创建第二 response exit。规避：one-response-exit blackbox 与 red fixture。
- 风险：附件清理裁剪当前请求语义。规避：当前 turn payload equivalence test 与历史附件 placeholder test 成对。
- 风险：协议工具差异写进 Hub provider-specific 分支。规避：codec/provider owner 限界与 Hub provider-string gate。
- 风险：SSE 被 full materialize 才能检查工具顺序。规避：first-frame-before-terminal 与 copy-budget gates。

## 6. 测试计划

- 红测：当前缺少跨协议真实工具/servertool多轮 parity matrix 或附件历史占位 gate。
- 正向：普通 tool/function call、custom tool、servertool、apply_patch/MCP/native、图片/附件工具历史占位。
- 反向：orphan tool result、call_id 缺失、跨协议 tool result 顺序错误、servertool hook failure、附件资源缺失、metadata leak。
- JSON/SSE：任意 chunk boundary、delta ordering、terminal tool ordering、DONE/finish reason parity。
- Copy-budget：请求、响应、SSE、continuation、附件历史治理不得全量 materialize。
- Gates：focused Rust tests、controlled replay、mutation/source gates、architecture/resource/module/Rust-only/static-hook/fmt/clippy/workspace/diff gates。

## 7. 实施步骤

1. 刷新 .agent-collab，claim feature_id:v3.relay_tool_servertool_multiturn_parity_closeout。
2. 查 MemoryPalace、resource/function/mainline/verification maps，确认唯一 owner 和禁止路径。
3. 建立协议 × 工具类型 × transport intent × continuation state 的测试矩阵。
4. 写 red fixtures，证明缺少真实多轮工具/servertool/附件历史治理覆盖。
5. 只在 Rust Hub Chat Process/codec owner 内补缺口。
6. 绿化正反 controlled matrix、source gates 和 copy-budget gates。
7. 同步 maps/manifest/wiki/evidence 并做 architecture review。

## 8. 完成定义

- V3 Relay 工具/servertool 多轮 controlled parity matrix 通过。
- 工具治理、servertool hook、附件历史占位和 continuation 均保持唯一 Rust owner。
- 无 Server/handler/provider runtime history repair、无 fallback、无第二 response exit、无 payload/control 泄漏。
