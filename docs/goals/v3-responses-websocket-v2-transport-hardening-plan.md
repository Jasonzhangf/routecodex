# V3 Responses WebSocket v2 Transport Hardening Plan

## 1. 目标与验收标准

在现有增量 WebSocket v2 transport 上补齐资源生命周期与错误矩阵，证明连接复用、提前 drop、
client disconnect、provider/protocol error、并发请求均 fail-closed 且不污染下一轮 continuation。

验收标准：

- 同一 provider/model/auth/url session 同时只允许一个 in-flight response。
- 完整 terminal drain 后连接可复用；提前 drop/error/disconnect 后连接必须丢弃。
- ping/pong、text/binary、split UTF-8、malformed JSON、missing type、failed/incomplete/error 全覆盖。
- SSE 首帧不等待 terminal，无 Vec/collect/full materialization。
- 错误进入 typed Provider error -> Error01-06；无 HTTP retry/fallback。

## 2. 范围与边界

In scope：

- `routecodex-v3-provider-responses` WebSocket transport/resource lifecycle。
- controlled WebSocket tests、source verifier/mutation fixtures。
- provider transport resource/map/gate 补充。

Out of scope：

- Hub continuation save/restore、Anthropic/OpenAI Chat runtime。
- provider endpoint 猜测、live config、credential、install/restart。
- Server-owned socket state或第二 SSE parser。

## 3. 设计原则

- Provider Runtime 是 socket/session 唯一 owner。
- 单 connection guard 覆盖一次 response 生命周期。
- terminal drain 才允许复用；其他退出均物理丢弃连接。
- transport 只做 event/framing/cancellation，不判断 tool/servertool/continuation 业务语义。
- fail-fast、无 fallback、无重试补偿。

## 4. 技术方案与文件清单

- `v3/crates/routecodex-v3-provider-responses/src/transport.rs`：最小资源状态机。
- `v3/crates/routecodex-v3-provider-responses/tests/responses_websocket_v2.rs`：controlled matrix。
- 必要时在 provider crate 内新增单一 transport-state 模块；不得把逻辑移到 Server/Runtime。
- `scripts/architecture/verify-v3-responses-direct-remote-continuation.mjs` 与 red fixtures：
  锁 no materialization/no fallback/owner。
- V3 resource/function/verification map 只绑定 Provider transport feature。

## 5. 风险与规避

- async stream drop 无法 await close：Drop 必须同步移除 connection owner，底层 socket 随即释放。
- env 测试串台：每个测试使用独立 auth env handle，禁止依赖执行顺序。
- lock 跨 await：Owned guard 只属于单 response stream；测试证明并发严格串行且无死锁。
- terminal 后未拉取 DONE：视为未完整 drain，连接不得复用。

## 6. 测试计划

- terminal 完整 drain 后同连接两轮复用。
- delta 后提前 drop，下一轮建立新连接且不读到旧 terminal。
- cancellation before connect/send/read；均 client_disconnect。
- provider error/failed/incomplete/malformed/missing type/close before terminal。
- ping/pong、text/binary、split UTF-8。
- concurrent creates 串行；第二请求不能与第一响应事件交叉。
- source/mutation gate：Vec accumulation、collect、HTTP retry、fallback、Server socket owner 必红。
- fmt/clippy/provider package/full V3 workspace/architecture review。

## 7. 实施步骤

1. 刷新协作 view 并 claim `feature_id:v3.responses_websocket_v2_transport_hardening`。
2. 查 Provider transport resource/owner/maps 和现有 tests。
3. 先补状态机 test design 与 failing controlled cases。
4. 仅在 Provider owner 修资源生命周期。
5. 补 verifier/mutation、maps/gates/docs。
6. 跑 focused/full/architecture review，定向 stage/commit与 evidence。

## 8. 完成定义

- WebSocket v2 资源生命周期正反矩阵全绿。
- 无 materialization/fallback/跨 owner socket state。
- provider package、V3 workspace、architecture gates 全绿。
- live/provider endpoint 仍明确不在本任务完成声明内。
