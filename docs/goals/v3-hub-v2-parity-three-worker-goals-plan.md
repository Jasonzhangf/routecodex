# V3 Hub V2 Parity Three-Worker Goals Plan

## 目标与验收标准

把 V3 Hub Pipeline 的 request / response / capability 三个工作面并行收口到 V2 语义：

1. inbound/outbound/compat 只做本阶段拥有的协议归一、协议投影和 provider-private 兼容。
2. 所有工具治理、工具结果配对、servertool/apply_patch/continuation restore/save 只在 Chat Process 节点完成。
3. `tool_search` 作为 Codex 工具发现/调用能力在 relay 中被保留，不被拒绝、不被隐藏、不被转换为 shell/script/`exec_command`。
4. `/v1/models` 对 Codex 暴露的模型能力来自 `~/code/codex` 的真实 `ModelInfo` 消费逻辑和 provider/route 实际配置；`remote-continuation` 是 GPT-family + Responses 协议的派生能力，不再需要显式配置开关。
5. V3 保留现有骨架，Rust-only，节点单文件，共享语义下沉 shared lib，禁止孤立生命周期和重复实现。

完成声明必须同时有 source gates、architecture gates、以及 5555 旧错误样本或同入口真实样本 replay 证据。

## 范围与边界

### In scope

- V3 Runtime `hub_v1` request chain node split and V2 request parity.
- V3 Runtime response chain / compat scope narrowing and V2 response parity.
- V3 Server `/v1/models` Codex capability projection and final source/live integration gates.
- Docs/maps/manifests/verifiers that lock the above boundaries.

### Out of scope

- Direct passthrough conversion or direct-specific tool/history repair.
- Relay extra state machine for `tool_search`; continuation lifecycle remains Chat Process save/restore only.
- Provider config mutation, credential mutation, global install/restart/live replay before source gates pass.
- Provider-specific quirks in Hub Pipeline / Virtual Router / Server/SSE transport.
- Fallback, silent drop, sanitizer-as-fix, request/response payload semantic clipping.

## 设计原则

- 纯 Rust；TS 只能是已存在薄壳/IO，不新增语义。
- 单节点单文件；`hub_v1.rs` 最终只做 module wiring / public API shell。
- 每个节点只消费相邻节点类型，只产出相邻节点类型。
- 工具声明注入/裁剪、工具 call/result 配对、非法 tool 顺序判定、servertool/apply_patch 语义、continuation restore/save 只在 `ReqChatProcess04` / `RespChatProcess03`。
- Compat 只在 provider 边界做标准 provider 协议与 provider 私有字段/quirk 的 profile-gated 微调。
- `tool_search` 不等于 provider-native web search，也不等于 shell script；不能经任何层转换成 `exec_command` 或文本脚本。
- `/v1/models` 是 Codex 能力真源展示面；provider 级 capability read 不能替代模型级 `ModelInfo` 字段。

## 三 worker 分工

### Worker A：request path + node skeleton

目标：把 V3 request 链按 V2 移植到节点文件，并让 `tool_search` 请求声明/工具结果只在 Chat Process 处理。

主要路径：

- `v3/crates/routecodex-v3-runtime/src/hub_v1.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/common.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/side_channel.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/req_inbound_01_client_raw.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/req_inbound_02_normalized.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/req_continuation_03_classified.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/req_chat_process_04_governed.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/req_execution_05_planned.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/req_target_06_resolved.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/req_outbound_07_provider_semantic.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/provider_req_outbound_08_wire_payload.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/provider_req_outbound_09_transport_request.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs`

关键 V2 真源：

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_tool_call_normalization.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance*`

### Worker B：response path + provider compat scope

目标：把 response 链和 provider compat 放回相邻节点，删除/修正导致 `tool_search` 被 compat 拒绝或被脚本化的错误层逻辑。

主要路径：

- `v3/crates/routecodex-v3-runtime/src/hub_v1/provider_compat_shared.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/provider_resp_inbound_01_raw.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/provider_resp_compat_02_provider_compat.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/resp_inbound_02_normalized.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/resp_outbound_05_client_semantic.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/server_resp_outbound_06_client_frame.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/provider-compat-core/`

关键 V2 真源：

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_chatprocess_03_governance_boundary.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks/*`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/*`

### Worker C：Codex capability projection + integration/live closeout

目标：按 `~/code/codex` 真实消费逻辑修正 `/v1/models` 能力投影，协调 A/B 合并后跑 source/architecture gates 和 5555 旧样本 replay。

主要路径：

- `~/code/codex` 的 model/provider capability 消费代码，只读审计。
- `v3/crates/routecodex-v3-server/src/lib.rs`
- `v3/crates/routecodex-v3-server/tests/multi_listener_server.rs`
- `docs/design/codex-model-capability-contract.md`
- `docs/goals/v3-models-capability-catalog-test-design.md`
- `docs/goals/codex-capability-tool-filter-audit-plan.md`
- `docs/architecture/v3-function-map.yml`
- `docs/architecture/v3-mainline-call-map.yml`
- `docs/architecture/v3-verification-map.yml`
- `docs/architecture/v3-resource-operation-map.yml`
- `docs/architecture/manifests/v3.live_provider_compat.parity.yml`

## 风险与规避

| 风险 | 规避 |
| --- | --- |
| A/B 同时编辑 `hub_v1.rs` 冲突 | A 拿 skeleton wiring 主权；B 先在 response/compat node files 和 tests 落地，必要 wiring 通过 handoff 交给 A/集成者 |
| compat 扩大 scope 成工具治理 | B 的红测必须证明 compat 不处理 tool governance、不拒绝 `tool_search`、不做 script/exec 转换 |
| `/v1/models` 被 provider 级 capability read 代替 | C 必须用 `~/code/codex` 源码定位 `ModelInfo` 字段消费，并用 server tests/verifier 锁模型级字段 |
| 只跑单测不 replay 旧样本 | C 只有在 A/B source gates 过后才能 install/restart/live replay，完成声明必须带 5555 sample/live evidence |
| fallback/静默裁剪 | 三个 worker 都必须有负向 gate 或 source scan，错误显式暴露 |

## 验证矩阵

### Worker A gates

- `CARGO_NET_OFFLINE=true cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-runtime --test hub_relay_request_semantics -- --nocapture`
- `CARGO_NET_OFFLINE=true cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-runtime --test hub_relay_tool_servertool_multiturn_parity -- --nocapture`
- `npm run verify:v3-normalization-payload-logic-boundary`
- `npm run verify:v3-module-boundaries`
- `npm run verify:v3-rust-only`
- touched-file `rustfmt --check`
- touched-file `git diff --check`

### Worker B gates

- `CARGO_NET_OFFLINE=true cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-runtime --test hub_relay_response_semantics -- --nocapture`
- `CARGO_NET_OFFLINE=true cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-runtime provider_req_compat_loads_selected_target_profile -- --nocapture`
- `npm run test:v3-provider-compat-profile-loading`
- `npm run verify:v3-provider-compat-profile-loading`
- `npm run verify:v3-normalization-payload-logic-boundary`
- `npm run verify:v3-module-boundaries`
- `npm run verify:v3-rust-only`
- touched-file `rustfmt --check`
- touched-file `git diff --check`

### Worker C / integration gates

- `npm run verify:models-capability-contract`
- `CARGO_NET_OFFLINE=true cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-server --test multi_listener_server p6_models_endpoint -- --nocapture`
- `npm run verify:v3-architecture-docs`
- `npm run verify:v3-resource-map`
- `npm run verify:v3-module-boundaries`
- `npm run verify:v3-rust-only`
- `npm run verify:v3-live-provider-compat-parity`
- `npm run test:v3-live-provider-compat-parity-red-fixtures`
- `cargo fmt --manifest-path v3/Cargo.toml --all --check`
- `git diff --check`
- source gates 通过后：global install / managed restart / 5555 failing sample or same-entry live replay。

## 实施步骤

1. 三个 worker 各自刷新 `.agent-collab`，创建 run，按 semantic claim 占用自己的工作面。
2. A 先锁 `hub_v1.rs` skeleton wiring 和 request node split，B 避免抢同一 wiring；B 可并行写 response/compat nodes/tests。
3. C 只读审计 `~/code/codex` 并修 `/v1/models`/docs/gates；不提前 live replay。
4. A/B 各自红测先行，按 V2 真源移植，禁止发明新语义。
5. A/B source gates 过后，C 做集成 gates。
6. C 在 source/architecture gates 通过后执行 install/restart/live replay，验证 5555 不再出现 `unsupported Responses tool type ... tool_search`，且 `tool_search` 不变 shell/script/exec。
7. 最终更新 `note.md` / `MEMORY.md` / local skill 中可复用规则，再汇报。

## 完成定义

- `tool_search` request/response/tool-result roundtrip 在 relay 中保持工具语义，不被 compat 拒绝或脚本化。
- Direct 仍是 passthrough，没有新增 direct 修补/转换。
- Inbound/outbound/compat 没有 generic tool governance。
- Chat Process 是工具生命周期唯一 owner。
- `/v1/models` 给 Codex 暴露 `gpt-5.5` 等模型的真实能力字段；GPT-family + Responses 自动声明 remote continuation。
- 所有必跑 source/architecture gates 过；5555 旧样本或同入口真实样本 replay 过。
