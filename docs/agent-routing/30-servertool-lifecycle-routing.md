# Servertool 生命周期路由（stopless / followup）

## 索引概要
- L1-L7 `scope`：覆盖范围。
- L9-L17 `stopless-lifecycle`：stopless 生命周期。
- L19-L24 `followup-boundary`：followup 边界。
- L26-L31 `removed-features`：已移除功能禁区。
- L33-L38 `authoritative-docs`：权威文档。

## 覆盖范围
适用于：servertool stopless 自动续轮、stop followup 重建、CLI projection 迁移、tmux 注入边界。

## 前置查询（必须）

servertool / stopless / followup / schema gate 改动前，先查：

1. `docs/agent-routing/05-foundation-contract.md`
2. `docs/architecture/function-map.yml`
3. `docs/architecture/mainline-call-map.yml`
4. `docs/architecture/verification-map.yml`
5. 对应 `mainline source` 与 `wiki` review surface

如果 1-2 次查询内找不到唯一 owner / 唯一主线边，先补 map/contract，再动实现。

## 当前迁移方向（2026-06-15）
1. 新 servertool 改造方向以 `docs/design/servertool-cli-projection-migration.md` 为准。
2. 被迁移的 servertool 一律投影成客户端可见的 `exec_command` CLI 调用，不再走私有 server-side followup/reenter。
3. 有输入的普通 servertool 可执行 `routecodex servertool run <toolName> --input-json <json>` 后通过正常 `submit_tool_outputs` 回传；V3 stopless 的 `reasoningStop` 是例外：它必须是 no-input no-op `routecodex hook run reasoningStop`。
4. V3 stopless 的权威 SOP 是 `.agents/skills/rcc-dev-skills/references/95-v3-stopless-sop.md`：CLI 只闭合客户端工具轮，状态机归 `MetadataCenter.runtime_control.stopless` / StoplessCenter；managed relay 的完整当前轮 stopless guideline 必须同时出现在 provider-facing system prompt 与 Req04 ordinary user continuation，但对模型必须透明，不得提 no-op/CLI/client bridge；内部 `reasoningStop` tool schema 必须保留完成/阻塞/继续状态契约；direct/provider-direct 不得注入。
5. `apply_patch` 不属于 servertool CLI migration；保持原生/freeform 客户端工具链。

## stopless 生命周期
1. 当前 stopless 默认开启，默认次数 3。每个受管 provider request 注入完整 system stop schema；旧默认 `继续执行` 只允许作为无 trigger/feedback 的 legacy explicit continuation 输入，不得作为 no_schema/invalid fallback。
2. `/goal active` 时收到 `finish_reason=stop`：不自动续轮。
3. `/goal non-active` 时收到 missing/invalid-schema `finish_reason=stop`：默认预算 3 表示连续第 1、2、3 次都投影客户端 no-input CLI；第 4 次才 guard 放行。下一轮 provider 收到由 StoplessCenter 状态机选择的完整非持久、模型透明 continuation guideline（基于恢复上下文继续推理、按需调用工具、完成/阻塞需证据；不得提 no-op/CLI/client bridge），并继续收到完整 system stop guideline/tool schema。
4. 非 `/goal` 时使用同一 missing/invalid-schema 处理合同，不另建提示或计数语义。
5. stopless 激活时校验当前 assistant stop schema：字段不是全局必填，而是关系必填；`stopreason` 是唯一无条件必填字段，必须是数字 `0=finished/1=blocked/2=continue_needed`。
6. `stopreason=0` 是完成停止条件；必须 `has_evidence=1` 且 `evidence` 非空，证据内容只检查存在性，不判断真假。诊断字段按真实情况填写，不是全局必填。
7. `stopreason=1` 是阻塞停止条件；必须 `reason` 非空、`has_evidence=1` 且 `evidence` 非空。`blocked + needs_user_input=true` 仍必须满足 blocked evidence，并把 summary/evidence 与要用户决策的问题返回给用户，以 `finish_reason=stop` 停止等待。
8. `stopreason=2` / need_continue 是继续条件；控制结论写入 StoplessCenter 状态机，下一轮续跑文本由 Req04 根据状态机生成，不通过 CLI 输入/输出传递。
9. budget 真源是 StoplessCenter 状态机字段，不是 `serverToolLoopState.repeatCount` 或 CLI stdout。当前 Rust 应满足 no schema / invalid schema 连续第 1、2、3 次拦截并投影 no-input CLI；第 4 次才达到 guard 后不再拦截当前 `finish_reason=stop` 响应，也不投影 CLI 或合成 terminal/diagnostic 文本。非 stop 响应、工具调用、正常进展、真实 user turn、session/scope change 必须 reset budget。
10. stopless 不得走 server-side `reenterPipeline`。非 terminal stop_message_flow 只能向客户端投影 CLI；下一轮由 ReqChatProcess 把自动 CLI call/result 转成普通 user prompt。
11. `reasoningStop` 有双面合同：managed relay provider request 必须注入 model-visible/internal `reasoningStop` tool schema，并把 auto/missing/none tool choice 提升为 required/any 工具决策，避免模型合法忽略 schema 后连续自然 stop；client-visible continuation 仍只能是公共 CLI alias `exec_command(routecodex hook run reasoningStop ...)`。raw internal `reasoningStop` tool call/history 不得泄漏给客户端；direct/provider-direct 不得注入或激发。
12. 任何 stopless 系统提示词若要求主模型做 summary、最终总结、停止说明、完成/阻塞汇报，必须同时要求输出 stop schema JSON；禁止只要求 summary 而不带 schema。旧 AI followup 分支已删除，禁止恢复。
13. 注入失败必须清理状态，防止循环。
14. `verify:stopless-contract-blackbox` 必须检查 dry-run 返回的最终 `providerRequest.body`：完整 system schema、`reasoningStop` tool exactly once、原普通工具保留、状态机生成的 ordinary user prompt、无 stopless shell/CLI/control artifact、且 `stoppedBeforeProviderSend=true`。

## followup 边界
0. CLI projection 已迁移的 servertool 不得再进入 followup；stopless 也属于 CLI projection，旧 followup 规则只适用于尚未迁移的 legacy servertool flow。
1. followup 只能基于 origin snapshot 重建。
2. 不得从当前污染 payload 猜测补偿。
3. 不得绕过 Hub Pipeline req/resp process 的 Rust 工具治理。
4. servertool 只代客户端执行本地工具；除“工具执行发生在服务端”外，followup 请求和响应必须与普通请求完全同链路。
5. 响应方向固定为模型/provider 端进入 `RespInbound`，经 `HubRespChatProcess03Governed`，再从 Hub 出到客户端出口 `HubRespOutbound04ClientSemantic` / `ServerRespOutbound05ClientFrame`；`Inbound/Outbound` 以 Hub 为参照。
6. servertool 执行后的 payload 若仍处于 `HubRespChatProcess03Governed`，只能通过相邻 builder `buildHubRespOutbound04FromHubRespChatProcess03` 进入 `HubRespOutbound04ClientSemantic`；禁止 servertool 专用响应出口、手工 Responses 包装、或绕过正常响应口。Chat 入口最终必须是 Chat Completion shape，Responses 入口最终必须是 Responses shape。
7. 失败必须 fail-fast，禁止吞异常或降级。
8. same-protocol direct / provider-direct 端口不得因 `serverToolFollowup` 或 `:stop_followup` 改道 relay；direct 响应不进入 Hub response chat-process，因此 stopless/servertool 不激活。
9. direct passthrough 的 provider raw SSE 不进入 server response projection restore/guard；只能透传 provider wire frame + hooks，禁止把 provider 协议字段误判成内部 carrier。
10. followup / stopless 的运行时 metadata 只能走 side-channel carrier；Responses bridge / relay SSE / client JSON 不得把内部 `metadata`、`__rt`、`metaCarrier` 等字段投到 client body。

## 已移除功能禁区
- clock / reminder / 定时回查功能已移除，禁止重新接入。
- heartbeat / DELIVERY 巡检功能已移除，禁止重新接入。
- 新需求不得通过 TS 或 servertool 旁路恢复上述功能。

## 权威文档
- `docs/design/servertool-cli-projection-migration.md`
- `docs/stop-message-auto.md`
- `docs/design/servertool-stopmessage-lifecycle.md`
- `docs/design/servertool-followup-rebuild-from-origin.md`
- `docs/design/rcc-unified-fence-marker-spec.md`
- `docs/design/servertool-rust-only-architecture.md`
- `docs/routing-instructions.md`
