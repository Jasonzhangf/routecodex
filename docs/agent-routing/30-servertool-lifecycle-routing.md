# Servertool 生命周期路由（stopless / followup）

## 索引概要
- L1-L7 `scope`：覆盖范围。
- L9-L17 `stopless-lifecycle`：stopless 生命周期。
- L19-L24 `followup-boundary`：followup 边界。
- L26-L31 `removed-features`：已移除功能禁区。
- L33-L38 `authoritative-docs`：权威文档。

## 覆盖范围
适用于：servertool stopless 自动续轮、stop followup 重建、CLI projection 迁移、tmux 注入边界。

## 当前迁移方向（2026-06-15）
1. 新 servertool 改造方向以 `docs/design/servertool-cli-projection-migration.md` 为准。
2. 被迁移的 servertool 一律投影成客户端可见的 `exec_command` CLI 调用，不再走私有 server-side followup/reenter。
3. 客户端执行 `routecodex servertool run <toolName> --input-json <json>` 后，通过正常 `submit_tool_outputs` 回传；RouteCodex 按普通 exec_command 工具结果进入正常请求链。
4. stop summary / hook explanation 必须映射到 reasoning；stopless CLI command 只承载 status-only 输入，schema guidance 只允许出现在 CLI stdout。
5. `apply_patch` 不属于 servertool CLI migration；保持原生/freeform 客户端工具链。

## stopless 生命周期
1. 当前 stopless 默认开启，默认注入三轮递进六项排查检查提示：目标、过程、证据、问题原因、已排除因素、排查顺序；默认次数 3；旧默认 `继续执行` 只作为 legacy exact-match 输入并在 Rust 中升级。
2. `/goal active` 时收到 `finish_reason=stop`：不自动续轮。
3. `/goal non-active` 时收到 `finish_reason=stop`：自动注入六项排查检查提示；任一项无证据必须调用工具，已完成/阻塞必须给证据。
4. 非 `/goal` 时收到 `finish_reason=stop`：自动注入六项排查检查提示；任一项无证据必须调用工具，已完成/阻塞必须给证据。
5. stopless 激活时校验当前 assistant stop schema：`stopreason` 数字 `0=finished/1=blocked/2=continue_needed`、`has_evidence` 数字 `0/1`；文本字段只判空，默认要求包含 `reason`、`evidence`、`issue_cause`、`excluded_factors`、`diagnostic_order`、`next_step`、`learned`。
6. `stopreason=0|1` 且 `reason` 非空才允许 stop，并把 reason 加到 stop summary 开头；否则按缺失字段生成 followup。
7. `stopreason!=0|1` 且 `next_step` 非空时不允许 stop，followup 要求执行下一步；缺 next_step 时要求继续目标或补完整 schema。
8. budget 真源是 stop schema state 的 `stopMessageUsed`，不是 `serverToolLoopState.repeatCount`。当前 Rust 真相是 provided schema 与 missing schema 都按连续 3 次 stop 收敛；非 stop 响应、工具调用或正常进展必须 reset budget。旧的“missing schema 不计数 / 10 次 missing”文档视为过期。
9. stopless 不得走 `reenterPipeline` 普通 user 注入。非 terminal stop_message_flow 只能投影 CLI，并由 CLI stdout 提供 continuation prompt + schema guidance 闭环。
10. stopless 的前置注入和拦截补打一律是同一个停止 hook 语义：模型若要停止，必须主动调用该 hook 并附 stop schema；若模型直接 stop 未调用，系统只能补打一轮同一 hook，并在结果中再次要求模型下一轮自己调用。
11. 任何 stopless 系统提示词若要求主模型做 summary、最终总结、停止说明、完成/阻塞汇报，必须同时要求输出 stop schema JSON；禁止只要求 summary 而不带 schema。旧 AI followup 分支已删除，禁止恢复。
12. 注入失败必须清理状态，防止循环。

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
