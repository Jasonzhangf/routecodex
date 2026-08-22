# V3 SSE 协议硬编码审计

日期：2026-08-21

范围：`v3/crates/routecodex-v3-runtime/src` 的 SSE transport、provider SSE inbound、direct SSE pre-commit、direct Resp14 outcome、Responses relay provider event codec，以及 Chat/Anthropic semantic projection。

## 审计结论

发现两处会影响生产协议选择的硬编码，均位于 direct SSE provider response owner：

1. `shared.rs::direct_sse_frame_provider_failure_source`
   - 原问题：函数已经接收 `provider_protocol`，但 classifier 仍固定使用 `Responses`。
   - 影响：OpenAI Chat 或 Anthropic provider 的首帧可能被错误送进 Responses classifier，在客户端首字节提交前产生 `provider_response_sse_event_invalid`。
   - 修复：改为消费 VR `V3Execution11ProtocolDecision` 传入的 provider protocol。

2. `kernel/direct_sse_provider_outcome.rs::V3DirectSseProviderOutcome::observe_frame`
   - 原问题：Resp14 收口观察器固定使用 `Responses` classifier。
   - 影响：首帧 guard 即使使用了正确协议，后续帧仍可能被第二次按 Responses 解析，造成同一请求前后协议不一致。
   - 修复：outcome 携带 typed `provider_protocol`，所有帧使用该值分类；terminal 缺失错误也按协议生成，不再固定写 `response.completed`。

## 已确认不是问题的硬编码

- `provider_sse_json_codec.rs` 中的 Responses/Anthropic/OpenAI Chat protocol 参数均位于 `#[cfg(test)]` characterization tests，生产调用点使用动态 `provider_protocol`。
- `direct_response_thinking_compat.rs` 是明确的 Responses thinking-tag hook owner；它只在 `ThinkingTags` compat block 且 provider protocol 为 Responses 时启用，不能泛化为通用 SSE parser。
- Responses relay 的 `provider_stream_materialization.rs` 已按 provider protocol 分派 Responses、OpenAI Chat、Anthropic codec；relay 不把 provider SSE 直接投影给客户端。
- `direct_sse_consumers.rs::V3ProviderSseErrorConsumer` 已消费 typed provider protocol，不重新推断协议。

## 仍需由 gate 锁住的规则

以下规则应持续作为架构 gate，而不是靠 code review 记忆：

- 生产代码调用 provider SSE semantic classifier 时，禁止传入固定协议枚举；协议必须来自 `V3Execution11ProtocolDecision` / MetadataCenter typed carrier，或来自同一 provider response inbound typed context。
- generic direct SSE helper 必须显式携带 `provider_protocol`；禁止无协议参数的通用 SSE helper 在生产路径中出现。
- provider terminal 规则必须由协议 codec 定义；禁止在 shared SSE transport、HTTP handler 或 client projector 中写死 `response.completed`、`message_stop`、`finish_reason`。
- relay provider SSE 必须先进入 provider-specific RespInbound codec，再进入 Hub semantic response 和 client RespOutbound；禁止 provider raw SSE 直接进入 client frame。
- `execution_mode` 只能由 VR 命中的 typed decision 决定；响应阶段不得基于 provider response shape 二次选择 direct/relay。

## 验证证据

- `cargo test --locked -p routecodex-v3-runtime --lib direct_sse_guard_uses_provider_protocol_for_openai_chat_first_frame -- --nocapture`：通过。
- `cargo test --locked -p routecodex-v3-runtime --lib direct_sse_guard_rejects_typed_responses_shape_before_client_commit -- --nocapture`：通过。
- `npm --prefix v3 run install`：isolation gate、distribution gate、release build 全部通过。
- 安装后 `routecodex restart -c /Volumes/extension/.rcc/config.v3.toml`：running。
- 10000、7777、4444 `/health`：全部 `status=ok`，build version `0.90.4574`。

## 证据缺口

旧样本中 `cc-sol` 失败尝试的完整 raw SSE 没有落盘，只有最终切换后的 provider response snapshot。因此代码级审计和在线 binary 一致性已验证，但仍需要下一次带完整 provider-response capture 的 cc-sol 重放，验证原始失败帧不会再次被 direct/relay 错配。
