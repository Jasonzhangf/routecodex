# V3 Skeleton / Edge / Control Architecture Audit

Date: 2026-07-17

Scope: audit-only review for RouteCodex V3. No runtime behavior, live config, credential, global install, restart, or provider traffic was changed.

Plan: `docs/goals/v3-skeleton-edge-control-architecture-audit-plan.md`

## Audit Question

Verify whether the current V3 architecture has fully landed the requested contract:

- big skeleton / small skeleton split;
- end-to-end data plane and control plane separation;
- Metadata Center or V3-equivalent dedicated control-center surface;
- traceable writes and mutations;
- module call chains locked by explicit adjacent edges.

## Initial Evidence Snapshot

Initial audit map counts from `docs/architecture/*.yml` before the F1 fix:

- `docs/architecture/v3-resource-operation-map.yml`: 69 resources.
- `docs/architecture/v3-function-map.yml`: 28 function-map feature rows.
- `docs/architecture/v3-verification-map.yml`: 34 verification feature rows.
- `docs/architecture/v3-mainline-call-map.yml`: 30 chains and 178 edges.
- All 178 edges have `resource_flow`.
- All 69 resources participate in at least one edge `resource_flow`.
- All function-map feature rows have verification-map rows.

Required gates run on current worktree:

- `npm run verify:v3-resource-map`: PASS.
- `npm run verify:v3-module-boundaries`: PASS.
- `npm run verify:v3-rust-only`: PASS.
- `npm run verify:v3-resource-relation-edge-lock`: PASS, `69 resources bound through 178 edge resource_flow payloads`.
- `npm run verify:v3-architecture-docs`: PASS, `docs: 25`, `resources: 69`, `edges: 178`.

Important limitation: these gates prove resource-node and edge-resource-flow closure, but they do not prove that every mainline chain/edge owner is queryable through the V3 function map.

Current map counts after the F1 fix:

- `docs/architecture/v3-resource-operation-map.yml`: 69 resources.
- `docs/architecture/v3-function-map.yml`: 34 function-map feature rows.
- `docs/architecture/v3-verification-map.yml`: 35 verification feature rows.
- `docs/architecture/v3-mainline-call-map.yml`: 30 chains and 178 edges.
- `npm run verify:v3-resource-relation-edge-lock` now checks both resource-flow closure and mainline owner queryability.

## Clean Surfaces

### C1. Resource Relation Edge Lock Is Largely Landed

Evidence:

- `docs/architecture/v3-verification-map.yml` declares `v3.resource_relation_edge_lock` with the contract that resources are nodes, callable paths are scalar `from_node -> to_node` edges, and all relationships must live under edge `resource_flow`.
- `docs/architecture/v3-mainline-call-map.yml` currently contains 178 parsed edges, each with `resource_flow`.
- `npm run verify:v3-resource-relation-edge-lock` passes and reports all 69 resources bound through 178 edge payloads.

Conclusion:

- The resource-vs-edge distinction is machine locked for the current V3 map surface.
- This supports the requested "resource is not call edge" rule.

Residual gap:

- The initial audit found that the same gate did not require every `chain.owner_feature_id` / `edge.owner_feature_id` to resolve in `docs/architecture/v3-function-map.yml`; this is now resolved by the F1 fix evidence below.

### C2. Data / Control Separation Has Strong Existing Surfaces

Evidence:

- `docs/architecture/v3-resource-operation-map.yml` marks control resources such as `v3.route.selection_plan`, `v3.route.opaque_target`, `v3.target.candidate_set`, `v3.target.concrete_provider`, `v3.hub.entry_protocol`, `v3.hub.continuation_ownership`, `v3.hub.execution_plan`, `v3.hub.resolved_target`, and `v3.hub.provider_protocol` as `side_channel` or control resources with `may_enter_provider_body: false` and `may_enter_client_body: false`.
- `v3/crates/routecodex-v3-runtime/src/hub_v1.rs` rejects leaked side-channel keys in provider responses through `find_v3_hub_side_channel_key`, currently covering `routecodex_internal`, `metadata_center`, `debug_snapshot`, `provider_protocol`, `resource_handle`, and `continuation_owner`.
- `docs/architecture/v3-verification-map.yml` has V3 relay/runtime required tests that reject `metadata_center` / debug / resource / continuation leakage before provider send or client success projection.

Conclusion:

- The core architecture already expresses control-plane resources as typed side channels rather than normal payload fields.
- Hub relay response normalization has a concrete source-level guard against side-channel leakage into response payloads.

Residual gap:

- V3 does not yet expose one queryable "control-center registry" view that maps all side-channel/control slots to writer feature, writer symbol, request/execution scope, and required gate; see F3.

### C3. Big Skeleton / Small Skeleton Split Is Present In The Mainline Map

Evidence:

- Big skeleton chains are represented as top-level mainlines, for example:
  - `v3.server.managed_lifecycle`;
  - `v3.config.compile`;
  - `v3.entry_protocol_endpoint_binding.mainline`;
  - `v3.responses_direct.required_mainline`;
  - `v3.hub_pipeline.v1.request`;
  - `v3.debug_error_foundation.mainline`.
- Small skeleton and concrete surfaces hang from these chains through adjacent edges, for example provider wire/transport under `v3-rd-10` through `v3-rd-12`, and debug/error side-channel edges under `v3-de-*`.

Conclusion:

- The intended skeleton shape is visible and mostly inspectable in current maps.

Residual gap:

- The initial audit found several skeleton owner IDs in those chains were not function-map queryable; this weakened traceability and "owner first" routing. F1 below records the fix evidence.

## Findings

### F1. High: Mainline Chain/Edge Owners Are Not Fully Queryable Through Function Map

Type: traceability / edge owner queryability gap.

Evidence:

- Current `docs/architecture/v3-mainline-call-map.yml` uses owner IDs that do not exist in `docs/architecture/v3-function-map.yml`.
- Missing from function map:
  - `v3.config_interpreter_contract`
  - `v3.debug_error_foundation`
  - `v3.foundation_p0_p2`
  - `v3.responses_direct_mvp_architecture`
  - `v3.responses_provider_runtime`
  - `v3.virtual_router_target_interpreter`
- `v3.config_interpreter_contract` is also missing from `docs/architecture/v3-verification-map.yml`.
- The other five are present in verification-map only, not function-map.
- Existing required gates still pass:
  - `verify:v3-resource-relation-edge-lock`: PASS.
  - `verify:v3-architecture-docs`: PASS.

Affected skeletons:

- Big skeleton:
  - `v3.config.compile`
  - `v3.server.startup`
  - `v3.debug_error_foundation.mainline`
  - `v3.responses_direct.required_mainline`
- Small skeleton:
  - Virtual Router target interpreter edges `v3-rd-01`, `v3-rd-02`, `v3-rd-06`, `v3-rd-07`, `v3-rd-08`.
  - Responses provider runtime edges `v3-rd-10`, `v3-rd-11`, `v3-rd-12`.

Risk:

- A worker can locate a mainline edge but cannot reliably route owner, allowed paths, forbidden paths, and required gates through the owner registry.
- This violates the requested "所有写入和修改都需要可以追踪请求" and "模块调用链条必须用 edge 锁定" requirements at the owner-query layer, even though the edge shape itself is locked.

Minimal fix direction:

- Either add function-map rows for the missing owner IDs, or migrate mainline chain/edge `owner_feature_id` values to existing function-map feature IDs.
- Add a verifier/red fixture requiring every `chains[].owner_feature_id` and every `chains[].edges[].owner_feature_id` in `docs/architecture/v3-mainline-call-map.yml` to exist in `docs/architecture/v3-function-map.yml`.
- Require the same owner IDs to have a verification-map row unless the edge is explicitly marked as a manifest-only generated binding with a documented exception.

Required gates:

- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-owner-queryability`
- `npm run verify:v3-resource-relation-edge-lock`
- `npm run verify:v3-architecture-docs`
- New red fixture for missing mainline chain owner and missing edge owner.

Fix evidence (2026-07-17):

- Added V3 function-map owner rows for:
  - `v3.config_interpreter_contract`
  - `v3.debug_error_foundation`
  - `v3.foundation_p0_p2`
  - `v3.responses_direct_mvp_architecture`
  - `v3.responses_provider_runtime`
  - `v3.virtual_router_target_interpreter`
- Added the missing `v3.config_interpreter_contract` verification-map row.
- Extended `scripts/architecture/verify-v3-resource-relation-edge-lock.mjs` so every `chains[].owner_feature_id` and `chains[].edges[].owner_feature_id` must resolve through both V3 function map and V3 verification map.
- Extended `scripts/tests/v3-resource-relation-edge-lock-red-fixtures.mjs` with red fixtures for:
  - missing chain owner in V3 function map;
  - missing edge owner in V3 function map;
  - missing mainline owner in V3 verification map.
- Current owner-query check reports no missing V3 mainline owners in function map or verification map.
- F1 is fixed by map/gate evidence only. F2/F3/F4 remain separate findings and are not claimed as complete.

Follow-up goal:

```text
/goal
目标：锁定 V3 mainline chain/edge owner queryability，确保每个 chain/edge owner_feature_id 都能在 V3 function map 和 verification map 中反查。

说明：本任务不需要再写新的提示词，直接修 map/gate/red fixture。

实现文档：
docs/architecture/reviews/v3-skeleton-edge-control-architecture-audit-2026-07-17.md

执行规范：
- 不改 runtime 行为、不做 install/restart/live config。
- 只修 owner registry、verification map、mainline owner 引用或对应 gate。
- 禁止伪造 source symbol；找不到真实 owner 时标 binding pending 并写迁移计划。

验证：
- npm run verify:function-map-compile-gate
- npm run verify:architecture-owner-queryability
- npm run verify:v3-resource-relation-edge-lock
- npm run verify:v3-architecture-docs
- 新增 mainline owner queryability red fixture
- git diff --check

完成标准：
- 所有 V3 mainline chain/edge owner_feature_id 都能从 function map 反查 owner、allowed paths、forbidden paths、required gates。
- 缺 owner 的 red fixture 先红后绿。
```

### F2. Medium: Edge Lock Gate Does Not Enforce Source Symbol Queryability Strongly Enough

Type: gate coverage gap.

Evidence:

- Current source spot-check of mainline caller/callee anchors found the expected map shape, but symbol existence is not part of the required gate evidence from `verify:v3-resource-relation-edge-lock`.
- One special case exists: `v3-entry-bind-01` uses a manifest path as callee symbol/file. That can be valid as a manifest-edge exception, but it needs an explicit machine-readable exception instead of relying on manual interpretation.
- Existing `verify:v3-resource-relation-edge-lock` focuses on resource relation shape and resource coverage, not owner/source-anchor existence.

Affected skeletons:

- All chains in `docs/architecture/v3-mainline-call-map.yml`, with direct impact on lifecycle, config, entry binding, direct responses, Hub, debug/error, and relay/protocol characterization surfaces.

Risk:

- An edge can remain structurally valid while its source anchor or owner query is stale.
- That weakens "修改有迹可循" because caller/callee cannot be mechanically verified back to current source.

Minimal fix direction:

- Extend architecture docs or edge-lock verifier to validate caller/callee source anchors for source-file edges.
- Add an explicit `binding_kind: manifest_edge` or equivalent exception contract for manifest/document-only edges.
- Fail on missing source symbol text unless the edge has a declared exception with canonical manifest path.

Required gates:

- `npm run verify:v3-resource-relation-edge-lock`
- `npm run verify:v3-architecture-docs`
- New red fixture for missing source symbol and undeclared manifest-edge exception.

Follow-up goal:

```text
/goal
目标：给 V3 mainline call map 增加 source-anchor queryability gate，确保每条非 manifest edge 的 caller/callee 都能反查当前源码。

说明：本任务不需要再写新的提示词，直接补 verifier 和 red fixture。

实现文档：
docs/architecture/reviews/v3-skeleton-edge-control-architecture-audit-2026-07-17.md

执行规范：
- 不改 runtime 行为。
- manifest/document edge 必须显式声明 exception；普通 source edge 必须验证 caller_file/callee_file 和 caller_symbol/callee_symbol。
- 禁止用 grep 命中路径名替代 symbol anchor 证据。

验证：
- npm run verify:v3-resource-relation-edge-lock
- npm run verify:v3-architecture-docs
- 新增 source-anchor red fixture
- git diff --check

完成标准：
- 普通 V3 mainline edge source anchor 缺失会红测失败。
- manifest edge 例外可查询、可审计、不可默默绕过。
```

### F3. Medium: V3 Control Center Exists As Typed Side-Channel Mesh, But Lacks A Single Queryable Control-Center Registry

Type: control-center review-surface gap.

Evidence:

- V3 control resources are present in the resource map and mainline edge `resource_flow` as side-channel reads/writes.
- Examples:
  - route/target control: `v3.route.selection_plan`, `v3.route.opaque_target`, `v3.target.candidate_set`, `v3.target.concrete_provider`;
  - Hub control: `v3.hub.entry_protocol`, `v3.hub.continuation_ownership`, `v3.hub.execution_plan`, `v3.hub.resolved_target`, `v3.hub.provider_protocol`;
  - debug/error control: `v3.debug.trace_context`, `v3.debug.raw_capture`, `v3.debug.event_ledger`, `v3.error.*`;
  - lifecycle control: `v3.lifecycle.operation_lock`, `v3.lifecycle.pid_cache`, `v3.lifecycle.control_channel`.
- No V3-specific `MetadataCenter` or equivalent control-center registry file was found that lists all control slots with family, slot/resource, writer symbol, stage, write policy, owner feature, request/execution scope, downstream consumer, and required gate.
- MemoryPalace prior lesson for MetadataCenter migration requires a manifest/code-sync gate for every MetadataCenter write with family, slot, owning feature, writer symbol, stage, write policy, and verification mapping.

Affected skeletons:

- Big skeleton: runtime, config, lifecycle, Hub, VR/target, debug/error.
- Small skeleton: continuation, provider transport, route selection, provider health/availability.

Risk:

- Current V3 can be audited by combining resource map + mainline edges, but there is no single "control center" view for Jason's requested Metadata Center requirement.
- Side-channel writes are traceable in pieces, but not yet through one dedicated control-center contract.

Minimal fix direction:

- Add a V3 control-center review surface, for example:
  - `docs/architecture/v3-control-center-registry.yml`, or
  - a `control_center` section in `docs/architecture/v3-resource-operation-map.yml` plus a verifier.
- The registry should map each control/side-channel resource to:
  - owner feature;
  - writer symbol;
  - node/edge stage;
  - request/execution scope identity;
  - allowed downstream readers;
  - payload-leak policy;
  - required verification gate.
- Add a gate that fails if a `resource_kind: side_channel` / `control_contract` / error/debug/lifecycle control resource has no control-center row or if a control write lacks a mainline `resource_flow.side_channel_writes` edge.

Required gates:

- `npm run verify:v3-resource-map`
- `npm run verify:v3-resource-relation-edge-lock`
- New `verify:v3-control-center-registry`
- New control-center red fixture for undeclared side-channel write and missing writer symbol.

Follow-up goal:

```text
/goal
目标：建立 V3 control-center registry，把 Metadata Center 等价控制中心从分散 side-channel map 收口成一个可查询、可 gate 的控制面真源。

说明：本任务不需要再写新的提示词，直接补 registry、verifier、red fixture；不改 runtime 行为。

实现文档：
docs/architecture/reviews/v3-skeleton-edge-control-architecture-audit-2026-07-17.md

执行规范：
- 控制中心只登记 RouteCodex 内部控制信号；客户端 headers/body metadata/client_metadata/x-* 仍是透明协议输入，不能搬成隐藏控制真相。
- 每个 control/side-channel write 必须绑定 owner feature、writer symbol、node/edge、scope identity、downstream reader 和 required gate。
- provider/client normal payload 不得携带 control-center 字段。

验证：
- npm run verify:v3-resource-map
- npm run verify:v3-resource-relation-edge-lock
- 新增 verify:v3-control-center-registry
- 新增 control-center red fixture
- git diff --check

完成标准：
- V3 control writes 可通过一个 registry 反查 owner、stage、writer、scope、edge、resource、gate。
- 未登记控制写入和 payload control leakage 都会红测失败。
```

### F4. Medium: Continuation Scope Transparency Needs A Follow-Up Owner Decision

Type: data/control boundary ambiguity in current dirty source.

Evidence:

- `v3/crates/routecodex-v3-server/src/lib.rs` currently resolves Responses continuation scope from transparent headers, `x-codex-turn-metadata`, and body paths.
- Body paths include direct `client_metadata.*` / `clientMetadata.*`, which matches the current transparency memory.
- Body paths also include plain `metadata.session_id`, `metadata.sessionId`, `metadata.thread_id`, `metadata.conversation_id`, and nested `metadata.client_metadata.*`.
- `payload_needs_continuation_scope` currently checks `previous_response_id` and `function_call_output`, but not `tools`.
- Current `v3/crates/routecodex-v3-server/src/lib.rs` is dirty in the worktree; this audit did not modify it and does not claim runtime correctness.

Affected skeletons:

- Big skeleton: server HTTP boundary and Hub continuation lifecycle.
- Small skeleton: Responses Relay local continuation scope.

Risk:

- If plain `metadata.*` is treated as transparent client protocol data, this may be acceptable, but it must be documented and gated.
- If plain `metadata.*` is considered ambiguous or reserved for provider/client payload semantics, reading it as continuation scope may look like control truth derived from a general payload field.
- Omitting `tools` from continuation-scope requirement may allow a tool-capable request to use request-local synthetic scope when the policy requires client-provided scope for continuation-producing turns.

Minimal fix direction:

- Decide and document whether plain body `metadata.*` is valid transparent client scope input or only `client_metadata.*` / `x-codex-turn-metadata` should be accepted.
- Lock the decision with server tests for:
  - no invented session/thread ID when continuation can be created or consumed;
  - accepted transparent scope paths;
  - rejected ambiguous control-center leakage paths;
  - `tools`-creating continuation path if the policy requires client scope there.

Required gates:

- `npm run test:v3-hub-relay-runtime-closeout`
- `npm run test:v3-relay-tool-servertool-multiturn-parity-closeout`
- `npm run verify:v3-architecture-docs`
- `npm run verify:v3-resource-map`
- New focused server continuation-scope red fixture.

Follow-up goal:

```text
/goal
目标：锁定 V3 Responses continuation scope transparency 规则，明确 body metadata/client_metadata/x-codex-turn-metadata 哪些是合法透明协议输入，并用测试禁止伪造 session/thread。

说明：本任务不需要再写新的提示词；先定合同和红测，再改唯一 owner。不要清理 provider payload，不做 runtime fallback。

实现文档：
docs/architecture/reviews/v3-skeleton-edge-control-architecture-audit-2026-07-17.md

执行规范：
- V3 透明服务器不得自己添加协议可见 header、sessionId、threadId 或 continuation identity。
- 客户端协议字段是数据面；Metadata Center/control center 只承载 RouteCodex 内部控制信号。
- continuation save/restore 仍归 Hub/Chat Process owner，server boundary 只做透明 scope 读取和 fail-fast。

验证：
- 先写 focused red fixture 覆盖 accepted/rejected scope paths、no invented scope、previous_response_id/function_call_output/tools continuation-producing paths。
- npm run test:v3-hub-relay-runtime-closeout
- npm run test:v3-relay-tool-servertool-multiturn-parity-closeout
- npm run verify:v3-architecture-docs
- npm run verify:v3-resource-map
- git diff --check

完成标准：
- 当前允许的 continuation scope 输入路径被文档和测试锁定。
- 无 client scope 的 continuation-producing request 明确失败，不使用 request_id 伪造会话。
```

## Missing Edge / Gate Summary

Missing edge evidence:

- No resource is currently missing an edge `resource_flow`.
- No edge is currently missing `resource_flow`.

Missing gate evidence:

- Gate missing for mainline chain/edge owner IDs resolving through `v3-function-map.yml`.
- Gate missing for source symbol anchoring on all non-manifest mainline edges.
- Gate missing for a single V3 control-center registry that covers every side-channel/control write.
- Gate missing for the current continuation-scope transparency decision.

## Architecture Review

Result:

- The V3 architecture is partially locked and better than convention-only: resource nodes, adjacent edge `resource_flow`, Rust-only/module boundaries, and side-channel leak checks are present and passing.
- It is not yet fully complete for Jason's audit bar because owner queryability and control-center registry are not fully machine locked.

No runtime claim:

- This audit did not replay live requests, install, restart, mutate config, or verify provider behavior.
- This audit must not be used as proof that V3 runtime behavior is fixed.

Recommended priority:

1. Fix F1 first. Without owner-queryable mainline edges, follow-up implementation work cannot reliably route to the unique owner.
2. Fix F2 next to make the edge map source-bound instead of map-only.
3. Fix F3 to give Jason the dedicated Metadata Center / control-center review surface.
4. Fix F4 after owner decision, because it touches runtime/server behavior and needs red/green tests.
