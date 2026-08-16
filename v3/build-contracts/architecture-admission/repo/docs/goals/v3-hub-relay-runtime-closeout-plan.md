# V3 Hub Relay Runtime Closeout Plan

## 1. 目标与验收标准

目标：把已完成的 V3 Hub Relay request/response/resource/copy-probe slices 收口成一个 controlled Relay Runtime E2E，覆盖 JSON/SSE、local continuation E2E、servertool runtime hook roundtrip 和 one-response-exit。

验收标准：

- 受控 Relay E2E 经过固定 Hub v1 topology：Req01-Req09 + Resp01-Resp06。
- local continuation save/restore 只发生在合法 Resp04/next Req04 边界。
- servertool hook 只在 Chat Process hook profile 执行，不出现第二 response exit。
- copy-budget probes 继续证明无 full request/response/SSE materialization。
- P6 deletion/live cutover/install/restart 保持 pending，除非后续另获授权。

## 2. 范围与边界

In scope：

- 新 integration feature：`v3.hub_relay_runtime_closeout`。
- 整合已有 Relay slices：
  - `v3.hub_relay_request_semantics`
  - `v3.hub_relay_response_semantics`
  - `v3.hub_relay_runtime_resources_hooks`
  - `v3.hub_relay_payload_copy_runtime_probes`
  - `v3.hub_relay_gate_review_surface`
- Controlled upstream JSON/SSE replay、local continuation two-turn、servertool roundtrip、Error01-06、side-channel isolation。
- maps/manifest/wiki/gates/evidence closeout。

Out of scope：

- Gemini/OpenAI Chat/Responses WebSocket provider owner 重写。
- V2/P6 deletion、live 5555、`~/.rcc`、global install/restart、production replacement。
- 动态 hook、第二 Runtime kernel、第二 response exit、fallback。

## 3. 设计原则

- Hub v1 Relay 使用固定节点，不新增/重排/复用节点编号。
- continuation immutable interval 最高优先级；save 后到 restore 前不得语义转换。
- servertool 只是 Chat Process hook profile，不拥有专用响应出口。
- Relay closeout 是整合/验证，不重写已完成 slices 的唯一 owner。
- 先 controlled runtime，再谈 live/cutover/deletion。

## 4. 技术方案与文件清单

必须先查：

- `docs/goals/v3-hub-relay-four-worker-implementation-plan.md`
- `docs/design/v3-hub-relay-fixed-pipeline-contract.md`
- `docs/goals/v3-hub-relay-payload-copy-runtime-probes-test-design.md`
- `docs/goals/v3-anthropic-relay-runtime-integration-plan.md`
- `docs/goals/v3-anthropic-relay-local-continuation-integration-plan.md`
- V3 function/mainline/verification/resource maps
- Relay wiki/manifest

候选实现面：

- `v3/crates/routecodex-v3-runtime/src/hub_v1*`
- `v3/crates/routecodex-v3-runtime/src/local_continuation.rs`
- controlled replay harness/tests under `v3/crates/**/tests`
- `scripts/architecture/verify-v3-hub-relay-runtime-closeout.mjs`
- `scripts/tests/v3-hub-relay-runtime-closeout-red-fixtures.mjs`
- V3 maps/manifest/wiki/review surface

## 5. 风险与规避

- 风险：整合 worker 抢占单 slice owner。规避：只做 closeout edge/harness/gate；源码变更先查 claim 和 owner。
- 风险：servertool 生成第二出口。规避：one-response-exit blackbox + source gate。
- 风险：continuation 被 handler/SSE/store transport 修补。规避：immutable interval red fixtures。
- 风险：为了通过 E2E full materialize。规避：copy-budget probes 必须一起跑。

## 6. 测试计划

- controlled Relay JSON/SSE E2E with node trace Req01-Req09 + Resp01-Resp06。
- local continuation two-turn E2E。
- servertool roundtrip E2E。
- provider error through Error01-06。
- side-channel isolation。
- payload-copy probes：request/response/SSE/continuation/servertool 不 full materialize。
- 红测：non-adjacent shortcut、continuation save after Resp04、second response exit、dynamic hook、P6 extension。
- V3 architecture/resource/module/Rust-only/static-hook/fmt/clippy/workspace/diff gates。

## 7. 实施步骤

1. 刷新 `.agent-collab`，claim `feature_id:v3.hub_relay_runtime_closeout`；遇到 active/stale claim 先核 heartbeat/evidence。
2. 用 maps/wiki/manifest 锁当前 slices 状态和唯一 owner。
3. 写 closeout red fixtures，证明 E2E/hook/continuation/one-exit 尚未闭合。
4. 接 controlled JSON/SSE E2E。
5. 接 local continuation E2E。
6. 接 servertool hook roundtrip。
7. 跑 copy-budget probes 与 architecture review。
8. 同步 maps/manifest/wiki/evidence。

## 8. 完成定义

- Controlled Relay Runtime E2E 证明 usable local continuation、servertool runtime hook、one-response-exit。
- 已完成 slices 仍保持唯一 owner，没有 fallback/第二 lifecycle/第二 response exit。
- P6 deletion、live cutover、global install/restart 仍显式 pending，等待 Jason 另行授权。

## 9. Source cutover addendum（2026-07-16）

Responses `/v1/responses` V2 default projection now binds to the Responses Relay runtime owner:
`execute_v3_responses_relay_runtime_with_default_transport` at
`v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs`.

Source/controlled scope:

- controlled Runtime JSON/SSE enters fixed Req01-Req09 and Resp01-Resp06 topology;
- Server `/v1/responses` Relay JSON/SSE tests prove no Direct/P6 node reentry;
- provider-request dry-run proves no upstream send and returns a redacted final provider request;
- P6 deletion, credentials, and full production replacement remain pending.

Live addendum: after global install of rccv3 0.90.3935 and managed start of
/Volumes/extension/.rcc/config.5555.v2.toml, V3 5555 POST `/v1/responses` Relay JSON/SSE returned
HTTP 200 with exact provider markers, complete Req01-Req09/Resp01-Resp06 trace, and no Direct/P6
markers. Evidence:
.agent-collab/runs/20260716T110035Z-Macstudio.local-31201-f5633c/logs/live-provider-matrix-20260716T114218Z/summary.json.
