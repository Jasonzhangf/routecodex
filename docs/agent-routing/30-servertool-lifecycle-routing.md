# Servertool 生命周期路由（stopless / followup）

## 索引概要
- L1-L7 `scope`：覆盖范围。
- L9-L17 `stopless-lifecycle`：stopless 生命周期。
- L19-L24 `followup-boundary`：followup 边界。
- L26-L31 `removed-features`：已移除功能禁区。
- L33-L38 `authoritative-docs`：权威文档。

## 覆盖范围
适用于：servertool stopless 自动续轮、stop followup 重建、tmux 注入边界。

## stopless 生命周期
1. 当前 stopless 默认开启，默认注入三轮递进六项排查检查提示：目标、过程、证据、问题原因、已排除因素、排查顺序；默认次数 3；旧默认 `继续执行` 只作为 legacy exact-match 输入并在 Rust 中升级。
2. `/goal active` 时收到 `finish_reason=stop`：不自动续轮。
3. `/goal non-active` 时收到 `finish_reason=stop`：自动注入六项排查检查提示；任一项无证据必须调用工具，已完成/阻塞必须给证据。
4. 非 `/goal` 时收到 `finish_reason=stop`：自动注入六项排查检查提示；任一项无证据必须调用工具，已完成/阻塞必须给证据。
5. stopless 激活时校验当前 assistant stop schema：`stopreason` 数字 `0=finished/1=blocked/2=continue_needed`、`has_evidence` 数字 `0/1`；文本字段只判空，默认要求包含 `reason`、`evidence`、`issue_cause`、`excluded_factors`、`diagnostic_order`、`next_step`、`learned`。
6. `stopreason=0|1` 且 `reason` 非空才允许 stop，并把 reason 加到 stop summary 开头；否则按缺失字段生成 followup。
7. `stopreason!=0|1` 且 `next_step` 非空时不允许 stop，followup 要求执行下一步；缺 next_step 时要求继续目标或补完整 schema。
8. budget 只统计连续带 schema 的无效 stop；缺 schema 不计数，非 stop 响应、工具调用或正常进展必须 reset budget。预算真源是 stop schema state 的 `stopMessageUsed`，不是 `serverToolLoopState.repeatCount`。
9. 任何系统提示词/ai-followup 若要求主模型做 summary、最终总结、停止说明、完成/阻塞汇报，必须同时要求输出 stop schema JSON；禁止只要求 summary 而不带 schema。
10. 注入失败必须清理状态，防止循环。

## followup 边界
1. followup 只能基于 origin snapshot 重建。
2. 不得从当前污染 payload 猜测补偿。
3. 不得绕过 Hub Pipeline req/resp process 的 Rust 工具治理。
4. servertool 只代客户端执行本地工具；除“工具执行发生在服务端”外，followup 请求和响应必须与普通请求完全同链路。
5. 响应方向固定为模型/provider 进入 `RespInbound`，经 `HubRespChatProcess03Governed`，再到客户端出口 `HubRespOutbound04ClientSemantic` / `ServerRespOutbound05ClientFrame`。
6. servertool 执行后的 payload 若仍处于 `HubRespChatProcess03Governed`，只能通过相邻 builder `buildHubRespOutbound04FromHubRespChatProcess03` 进入 `HubRespOutbound04ClientSemantic`；禁止 servertool 专用响应出口、手工 Responses 包装、或绕过正常响应口。
7. 失败必须 fail-fast，禁止吞异常或降级。

## 已移除功能禁区
- clock / reminder / 定时回查功能已移除，禁止重新接入。
- heartbeat / DELIVERY 巡检功能已移除，禁止重新接入。
- 新需求不得通过 TS 或 servertool 旁路恢复上述功能。

## 权威文档
- `docs/stop-message-auto.md`
- `docs/design/servertool-stopmessage-lifecycle.md`
- `docs/design/servertool-followup-rebuild-from-origin.md`
- `docs/design/rcc-unified-fence-marker-spec.md`
- `docs/design/servertool-rust-only-architecture.md`
- `docs/routing-instructions.md`
