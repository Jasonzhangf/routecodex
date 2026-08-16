# V3 Anthropic Relay Local Continuation Integration Plan

## 1. 目标与验收标准

将现有 V3 local continuation contract/store 接入 Anthropic Relay 的唯一 Chat Process 生命周期：
只在 response Chat Process 出口保存，只在下一轮 request Chat Process 入口恢复。

验收标准：

- `Resp04 save -> immutable interval -> next Req04 restore` 唯一合法路径 anchored。
- entry endpoint/protocol + relay owner + session/conversation + port/group 全量隔离。
- pending tool_use/tool_result/thinking 顺序完整保留，terminal 不保存、不复活。
- JSON/SSE 两轮 controlled replay 通过；普通 Responses Direct/OpenAI Chat 无法命中。
- bridge/Server/store transport 不做 history repair、context rebuild 或 required_action 推断。

## 2. 范围与边界

In scope：

- Anthropic Relay local continuation save/restore wiring。
- local store lifecycle、expiry/release、positive/negative state matrix。
- controlled two-turn JSON/SSE/error/isolation tests。
- feature/resource/mainline/verification map、manifest/wiki/gates。

Out of scope：

- remote/provider-owned continuation 与 WebSocket transport。
- OpenAI Chat Runtime integration。
- servertool/stopless followup 执行。
- live config/install/restart/provider replay。

## 3. 设计原则

- continuation 语义只在 Chat Process owner；immutable interval 内只传输、scope 校验、释放。
- Rust-only typed store，deny unknown fields，禁止 payload/debug/metadata 第二真源。
- relay/local owner 与 direct/remote owner 类型不可接。
- 正反状态测试覆盖 success/failure/non-terminal/already-terminal。
- 无 fallback、无跨协议恢复、无 session-only 命中。

## 4. 技术方案与文件清单

主要 owner：

- `v3/crates/routecodex-v3-runtime/src/local_continuation.rs`：仅扩展确有必要的 typed API。
- `v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs`：相邻 Req/Resp
  Chat Process wiring。
- `v3/crates/routecodex-v3-runtime/tests/`、`v3/crates/routecodex-v3-server/tests/`：
  controlled two-turn tests。
- V3 maps、manifest、wiki、verifier/red fixtures。

Server 只能提供请求 scope 并调用 Runtime；不得持有 store、拼 history 或解释 tool_use。

## 5. 风险与规避

- 与 OpenAI Chat worker 冲突：仅修改 Anthropic runtime/local continuation 文件；禁止改
  OpenAI Chat codec/runtime 文件。
- immutable interval 越界：source gate 扫 handler/SSE/outbound/store transport 的 rebuild/repair。
- terminal 错存：成对测试 pending、terminal success/failure、already-terminal。
- scope 串台：协议、owner、endpoint、session、conversation、port、group 各自负测。

## 6. 测试计划

- 红测：Anthropic Relay 两轮仍无 Resp04/Req04 local binding。
- JSON/SSE：首轮 tool_use -> save；次轮 tool_result -> restore -> terminal release。
- Negative：direct owner、OpenAI Chat/Responses entry、scope mismatch、expiry、missing/duplicate、
  terminal failure、already-terminal。
- Payload isolation：provider/client payload 不含 store key、owner、debug、metadata control。
- Gate：local store focused、Relay integration、mutation、module/Rust-only/fmt/clippy/workspace、
  architecture review/browser。

## 7. 实施步骤

1. 刷新协作 view 并 claim `feature_id:v3.anthropic_relay_local_continuation_integration`。
2. 查 local continuation contract、Anthropic Relay mainline/maps/wiki。
3. 写 test design 与 failing two-turn controlled replay。
4. 在 Resp04/Req04 唯一 owner 接 save/restore/release。
5. 绿化状态/scope/payload 正反矩阵。
6. 同步 maps/manifest/wiki/gates，跑全栈 architecture review。
7. 定向 stage/commit并写 evidence。

## 8. 完成定义

- Anthropic Relay local continuation 两轮 JSON/SSE controlled 闭环。
- immutable interval 无语义写入，direct/relay/协议/scope 不串台。
- maps/gates/docs 全绿；不宣称 live/production。
