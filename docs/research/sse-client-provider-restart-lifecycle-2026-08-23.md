# SSE 客户端连接 / Provider 解耦排查（2026-08-23）

## 当前现象

1. SSE 挂死：客户端连接仍保持，但 provider 首帧或后续帧不返回时，连接可能只持续发送 keepalive；尚未证明同一客户端 SSE 生命周期内完成 provider 切换并得到最终终态。
2. SSE 异常中断：provider 错误、provider stream drop、server restart 或 body drop 可能让客户端只看到 EOF/断线；尚未证明客户端能收到稳定的错误终态，也尚未证明重启后能接回原请求。

## 用户要求的生命周期合同

- 客户端 SSE 是 Proxy-owned connection；Direct 也必须有中继，不能把 provider socket 暴露成客户端连接。
- provider 首帧无响应、后续无响应、provider 错误、provider 切换均不能直接结束客户端连接；必须在同一 client request 生命周期内由 Runtime 完成显式切换或显式终态。
- server restart 不能留下客户端永久等待；等待中的 provider 必须有可验证的终态策略。若设计为重连/接续，必须有 typed request identity、provider attempt identity 和可恢复状态；不能靠原始 payload 或 metadata 猜测恢复。

## 已确认的代码事实

### 已存在能力

- Server SSE 有 initial/periodic keepalive：`v3/crates/routecodex-v3-server/src/frame_builders.rs:v3_io_sse_body`。
- Relay 有 provider 首帧守卫与 30 秒帧间空闲守卫：`v3/crates/routecodex-v3-runtime/src/hub_v1/relay_runtime_core.rs:guard_relay_sse_first_frame`、`guard_v3_provider_sse_idle`。
- Direct 有首个 semantic event timeout 和 subsequent frame timeout：`v3/crates/routecodex-v3-runtime/src/shared.rs:guard_initial_direct_sse_provider_failure_with_timeout`、`observed_sse_client_stream_with_protocol`。
- Server body drop 已有 terminal observation / client disconnect 分流测试；client disconnect 是 health-neutral，不应被当成 provider failure。

### 当前结构性缺口

- Keepalive 只证明客户端连接仍有字节流量，不证明 provider attempt 已被切换，也不证明客户端最终会收到终态。
- Direct 当前存在“完整收集 provider attempt 后再交给 client stream”的路径：`shared.rs` 中 `execute_v3_responses_direct...` 相关 client stream 会先 `collect`，再构造客户端 stream。该路径与“客户端连接由 proxy 独立管理”目标冲突，且可能造成无界等待/无界缓冲风险。
- 现有 SSE transport 只负责 framing/backpressure/closeout；provider event、terminal、切换策略必须仍由对应 Runtime/codec/error owner 负责，不能把语义补丁放到 SSE 或 handler。
- 当前审计事件已确认：Relay 存在完整流无界 buffer 风险；restart handoff 不能重新挂接 provider transport state。证据见 `.agent-collab/runs/20260823T072934Z-Macstudio-19272-v3dirtyreview/events.jsonl`。
- 当前架构文档定义了 aggregate restart，但没有找到“in-flight client SSE 在 restart 前后如何终态化或接续”的完整合同。仅有 `/health` 不能证明该合同成立。

## 暂不能下的结论

- 不能把两个问题归因到单一 SSE codec bug。
- 不能把 keepalive 视为解决 provider 解耦。
- 不能把 body EOF 直接归因 provider；需要同一 requestId 的 client frame、provider-bound request、provider raw stream、Runtime Error01/05/06 和 restart lifecycle 证据。
- 当前没有进行 live restart 或 provider 配置变更；未形成线上闭环证据。

## 下一步验证门

1. 对同一 requestId 做 A/B/C：provider 最小直连、完整 provider-bound request 直连、同入口真实客户端 SSE；记录首帧、每帧间隔、terminal、EOF、Error01/05/06。
2. 分 Direct / Relay 重放三类 provider：首帧挂起、首帧后挂起、provider 中途失败；验证 provider 切换是否保持同一 client SSE，且不把控制状态写入 payload。
3. 做受控 aggregate restart replay：请求已建立且等待 provider、请求已收到部分 SSE、请求刚完成三种时机；验证客户端得到显式终态或合同化接续，不允许永久 keepalive。
4. 只在上述证据锁定首次偏离节点后，回唯一 owner 设计 red test；当前禁止在 SSE handler、outbound 或 client projection 层补偿。

## 初步设计边界（非实现方案）

```text
Client SSE connection (Server-owned)
  -> typed client request lifecycle / broker
  -> Runtime provider-attempt loop (Direct or Relay)
  -> provider transport
  -> protocol codec / Resp Chat Process
  -> typed terminal or typed retry/switch decision
  -> client SSE projection
```

- provider attempt 必须是可释放、可超时、可观测的子生命周期；client connection 不能直接持有 provider stream。
- provider retry/switch 只能在 Runtime/Error chain 做；client-facing SSE 只传输 keepalive、正常事件和已确认的终态。
- restart 若不支持 transport reattach，必须在 restart boundary 对所有 in-flight client SSE 产生明确 typed terminal；若支持 reattach，必须另有持久化的 lifecycle locator 和严格 scope/owner 校验，不能借 metadata 或历史 payload 恢复。

