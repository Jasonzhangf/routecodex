# Conversation Cache

## 2026-06-01 Metadata 隔离目标收口
- 本地提交，未 push：`971d7c3e5`、`710acff93`、`62f11f32f`、`2e693ad81`、`8a281d619`、`89dd96d6b`、`d3a28ea78`。
- 已落规则：`docs/goals/metadata-request-isolation-plan.md`、`AGENTS.md`、`.agents/skills/rcc-dev-skills/SKILL.md`。
- 已修：Anthropic/OpenAI SDK/Rust outbound/Responses direct/Windsurf/remote image/usage aggregator/mock provider/shadow compare metadata 泄露与 masking。
- 红线：`tests/red-tests/no_provider_body_metadata_control.test.ts` 禁止 provider runtime/SDK/Rust outbound 消费 body/rawBody/payload.metadata.context 控制语义。
- 验证绿：metadata Jest 集合 9 suites / 59 tests；Rust `cargo test -p router-hotpath-napi hub_req_outbound_format_build --lib` 13/13。
- 剩余非目标命中：guardian daemon 自身 metadata；bridge-actions 内部 state metadata；stop-message runtime internal metadata.context；validator 文本。无 provider wire body / SDK options / client response body metadata 注入残留。
