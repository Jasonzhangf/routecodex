# V3 Responses Inbound WebSocket Proxy Plan

## 1. 目标与验收标准

目标：补齐 client-facing `/v1/responses` WebSocket inbound proxy owner，使 Codex/OpenAI Responses WebSocket mode 能从客户端连入 RouteCodex，并进入既有 V3 Runtime/Provider path。

验收标准：

- Server 拥有且只拥有客户端 WebSocket upgrade/framing shell。
- provider/upstream WebSocket state 仍由 `v3.responses_websocket_v2_transport_hardening` owner 负责。
- 受控 WebSocket client -> RouteCodex Server -> loopback provider 的 JSON/SSE/tool/error/disconnect/cancel matrix 通过。
- 无 HTTP fallback、无 Server-owned continuation/history/tool repair、无完整事件 materialization。

## 2. 范围与边界

In scope：

- 新 feature：`v3.responses_inbound_websocket_proxy`。
- `/v1/responses` WebSocket handshake、header/subprotocol/auth/request-id scope。
- client event `response.create` 进入既有 V3 Responses Runtime semantics。
- inbound WebSocket frame -> Runtime request -> Provider transport -> client event/SSE projection 的受控闭环。
- Error01-06、disconnect/cancel、malformed client event、side-channel isolation。

Out of scope：

- Provider/upstream WebSocket lifecycle、connection reuse、OpenAI-Beta upstream header；这些已由 `v3.responses_websocket_v2_transport_hardening` 负责。
- HTTP fallback/retry、provider reselection、第二 Runtime kernel、Relay/local materialization。
- `~/.rcc`、live 5555、global install/restart、credential/config mutation。

## 3. 设计原则

- inbound socket 是 Server transport shell，不是 Runtime/provider state owner。
- Responses continuation save/restore 仍只允许在 Chat Process 合法点；Server/SSE/handler 不做语义恢复。
- client protocol 数据走数据面；RouteCodex 控制信号走 side-channel，不混入 normal payload。
- 错误显式暴露；不把 WebSocket 失败降级为 HTTP。

## 4. 技术方案与文件清单

必须先查：

- `docs/goals/v3-responses-websocket-v2-transport-hardening-plan.md`
- `docs/goals/v3-responses-direct-remote-continuation-integration-plan.md`
- `docs/design/v3-hub-relay-fixed-pipeline-contract.md`
- V3 function/mainline/verification/resource maps
- `docs/architecture/wiki/v3-responses-direct-mainline.md`

候选实现面：

- `v3/crates/routecodex-v3-server/src` WebSocket upgrade/framing shell
- `v3/crates/routecodex-v3-runtime/src` existing Responses runtime entry only through allowed API
- loopback provider harness/tests under `v3/crates/**/tests`
- `scripts/architecture/verify-v3-responses-inbound-websocket-proxy.mjs`
- `scripts/tests/v3-responses-inbound-websocket-proxy-red-fixtures.mjs`
- V3 maps/manifest/wiki/review surface

## 5. 风险与规避

- 风险：Server 长出 provider socket/cache state。规避：source gate 禁止 Server 写 provider connection resource。
- 风险：失败后 HTTP fallback。规避：red fixture 禁止 HTTP retry/fallback branch。
- 风险：Server 修 continuation/history/tool。规避：immutable interval source gate。
- 风险：全量收集 WebSocket/SSE 事件。规避：streaming first-frame-before-terminal test 和 materialization gate。

## 6. 测试计划

- 红测：当前无 inbound proxy WebSocket `/v1/responses` owner。
- handshake：`OpenAI-Beta: responses_websockets=2026-02-06` 等 client handshake 口径按 Codex 真实行为验证。
- 正向：JSON terminal、SSE/event streaming、tool/function continuation。
- 反向：malformed client event、provider error、disconnect、cancel、scope mismatch。
- Source gates：Server socket state 不得成为 provider state；禁止 HTTP fallback/retry；禁止 full Vec collect/materialization。
- V3 module/Rust-only/resource/architecture/fmt/clippy/workspace/diff gates。

## 7. 实施步骤

1. 刷新 `.agent-collab`，claim `feature_id:v3.responses_inbound_websocket_proxy`。
2. 建 map/mainline/resource/verification skeleton；绑定 inbound server owner 和 provider transport forbidden edge。
3. 写红测证明当前 inbound owner 缺失。
4. 实现 Server WebSocket upgrade/framing shell。
5. 接入 existing Responses Runtime entry；禁止新 kernel。
6. 接入 loopback provider controlled matrix。
7. 补 source/mutation gates、wiki/manifest、architecture review。

## 8. 完成定义

- Controlled inbound WebSocket `/v1/responses` path 可用，并进入唯一 V3 Runtime/Provider owner。
- Provider WebSocket transport owner 保持独立。
- 无 live/global/restart/production claim。
