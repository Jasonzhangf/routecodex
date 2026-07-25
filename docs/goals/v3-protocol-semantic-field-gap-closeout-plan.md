# V3 protocol semantic field gap closeout plan

## Goal

Close the non-covered rows in the V3 protocol semantic field matrix so the Chat
Process audit superset is not only documented, but implemented and verified
through the correct V3 protocol codec owners.

Canonical audit sources:
- Machine matrix: `docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml`
- Text truth: `docs/architecture/reviews/v3-protocol-semantic-matrix-review.md`
- Review HTML: `docs/architecture/wiki/html/v3-protocol-semantic-field-matrix.html`
- Gate: `npm run verify:v3-protocol-conversion-field-parity`

## Acceptance criteria

1. Every `current_impl` status in the field matrix is either:
   - `covered`,
   - `covered_but_target_dependent`,
   - `edge_only`,
   - or an explicitly unsupported/lossy status with fail-fast behavior and red tests.
2. `extension_declared`, `semantic_declared`, `source_inventory_only`,
   `shape_branch_gap`, `codec_shape_only`, and unclosed `partial` rows are
   reduced by real owner implementation, not by relabeling.
3. Every runtime-supported semantic has a positive and negative test in the owning
   codec/runtime path.
4. Unsupported target-protocol semantics fail fast or remain explicit
   unsupported/lossy audit rows; they are not silently dropped, copied into raw
   payload blobs, or moved into MetadataCenter.
5. Final closeout includes source gates, architecture gates, global install,
   managed restart, and same-entry live replay evidence before claiming runtime
   completion.

## Scope

In scope:
- V3 Rust protocol codec/runtime owners under
  `v3/crates/routecodex-v3-runtime/src/hub_v1/`.
- Field-matrix YAML, text truth review, generated HTML review surface.
- Function map, mainline call map, verification map, resource map updates.
- Focused Rust parity tests and red fixtures.
- Live closeout only after source gates pass.

Out of scope:
- V2 `sharedmodule` changes.
- TS runtime semantic code.
- Server handler, SSE transport, provider transport, continuation store, or
  MetadataCenter repair owners.
- Provider credential/config mutation unless a separate config goal explicitly
  authorizes it.
- Fallback, silent drop, raw-payload dump, or post-error display workaround.

## Current gap audit

| Gap id | Count | Closeout requirement |
| --- | ---: | --- |
| `gap.runtime_extension_declared` | 217 | Implement declared extension semantics in adjacent codec owners or mark explicit unsupported/lossy with fail-fast tests. |
| `gap.semantic_declared_runtime_closeout` | 50 | Implement manually declared native/extension semantics in adjacent codec owners or mark explicit unsupported/lossy with fail-fast tests. |
| `gap.partial_cross_protocol_semantics` | 108 | Complete both request and response transforms for the affected semantic family. |
| `gap.source_inventory_only` | 0 | Keep this at zero; new source fields must receive manual semantic owner/classification before runtime edits. |
| `gap.shape_branch_transform` | 18 | `shape_branch_cases` are now documented/gated for the content/media/file rows; next closeout must add the named Rust positive/negative tests and adjacent codec implementation before changing any status. |
| `gap.gemini_codec_shape_only` | 14 | Expand Gemini deep semantics or mark unsupported/lossy explicitly. |
| `gap.client_metadata.target_dependent` | 1 | Keep current target-dependent provider-wire behavior gated; no runtime action unless target protocol changes. |
| `gap.edge_only_transport_state` | 3 | Keep as edge-only transport state; no business runtime closeout. |

Progress evidence:
- Gemini inlineData/fileData shape branch source verification is closed in the Gemini codec characterization owner:
  `collect_v3_gemini_request_shape_branch_semantics` plus the nine named Rust tests prove
  inline bytes, MIME type, file URI, file id, file data, and image URL remain distinct.
  The six matrix rows still remain `shape_branch_gap` until all protocol branches for
  those rows have equivalent owner tests and implementation evidence.
- Gemini `toolConfig.functionCallingConfig` source verification is closed for mode and allowed-name semantics in the Gemini codec characterization owner:
  `collect_v3_gemini_request_tool_config_semantics` plus focused Rust tests prove
  `mode` maps to Chat tool-choice policy, `allowedFunctionNames` maps to the protocol-neutral
  `request.tool_choice.allowed_function_names` extension, and neither collapses into tool
  declarations or `parallel_tool_calls`. Remaining Gemini deep semantics stay open.
- Gemini `generationConfig` scalar source verification is closed for V2-backed sampling/max-token/stop/logprob/seed semantics in the Gemini codec characterization owner:
  `collect_v3_gemini_request_generation_config_scalar_semantics` plus focused Rust tests prove
  `temperature` maps to `request.temperature`, `topP` maps to `request.top_p`, `topK` maps to the
  `request.top_k` extension, `maxOutputTokens` maps to `request.max_completion_tokens`,
  `stopSequences` maps to native `request.stop`, `frequencyPenalty` maps to `request.frequency_penalty`,
  `presencePenalty` maps to `request.presence_penalty`, `responseLogprobs` maps to `request.logprobs`,
  `logprobs` maps to `request.top_logprobs`, and `seed` maps to `request.seed`, without collapsing
  top_p/top_k, max tokens/reasoning budget, stop/finish reason, penalties, logprob flag/count, or seed.
  Remaining Gemini deep semantics stay open.

## 2026-07-25 long-tail meaningfulness re-audit

After Jason's correction, V2 long-tail behavior is a required baseline for V3
inbound/outbound audits. After the multi-protocol semantic mapping was realigned
around OpenAI Chat native fields plus registered protocol-neutral extensions,
the remaining long-tail is still not a useful single blanket implementation
objective.

Decision:
- Keep the long-tail matrix as an audit / backlog truth surface.
- Do not run a broad "close every long-tail field" goal.
- Promote V2-supported or current-client long-tail field families when they have
  compatibility value, an adjacent Rust codec owner, and a red/green test plan.
- `edge_only` transport state remains edge-only; it is not business runtime
  work.
- Unsupported or target-incompatible semantics may remain explicit
  unsupported/lossy rows with fail-fast red tests; they must not be silently
  copied into raw payload blobs, MetadataCenter, server handlers, SSE transport,
  provider transport, or fallback paths.

Meaningful next slices are field-family slices, not whole-protocol sweeps:
- media/file shape branches where URL / file id / inline bytes / MIME can be
  collapsed incorrectly;
- tool-choice / parallelism / allowed-name semantics where provider policy can
  invert or split;
- token, logprob, sampling, seed, stop, and max-token pairs that directly change
  provider request behavior;
- reasoning/thinking request policy versus response-visible reasoning content;
- prompt cache / storage / continuation knobs only when a current client or live
  sample uses them.

Low-value long-tail rows should stay declared or unsupported until a real sample
or product requirement justifies them. Examples: provider decoration fields,
rare response annotations, audio/modalities branches without an exposed entry
path, or protocol-only metadata that has no target-compatible slot.

Current Responses provider-standard instruction truth remains: provider-visible
`instructions` / Stopless guidance is preserved by lifting into a system
`input_text` item and removing top-level `instructions`; tests must not expect
top-level `instructions` on the Responses provider-standard wire.

## Owner mapping

| Semantic family | Owner files |
| --- | --- |
| Responses request -> OpenAI Chat provider semantic | `responses_openai_codec.rs`, `request_outbound_format.rs` |
| OpenAI Chat provider response -> Responses semantic | `responses_relay_runtime.rs` |
| Anthropic request -> Responses provider semantic | `anthropic_codec.rs` |
| Responses provider response -> Anthropic client projection | `anthropic_relay_runtime_codec.rs` |
| OpenAI Chat same protocol | `openai_chat_codec.rs`, `openai_chat_relay_runtime.rs` |
| Gemini same protocol / semantic expansion | `gemini_codec.rs`, `gemini_relay_runtime.rs` |

## Implementation sequence

1. Refresh `.agent-collab`, claim `feature_id:v3.protocol_conversion_field_parity`,
   and confirm no active conflicting runtime claim owns the same codec files.
2. Re-run the audit counters from the YAML; pick one field family, not the entire
   matrix at once.
3. For that family, update the matrix first:
   - exact OpenAI Chat native field or protocol-neutral extension field;
   - semantic meaning and transform rule;
   - for shape branches, `shape_branch_cases.positive[]` and
     `shape_branch_cases.negative[]` with source condition, target semantic,
     owner file, and required test symbol;
   - owner file and gap status;
   - unsupported/lossy rule if runtime support is intentionally blocked.
4. Add red tests before implementation:
   - positive transform for every supported request/response direction;
   - negative fail-fast for malformed or unsupported target-protocol shape;
   - red fixture preventing collapse of distinct semantics.
5. Implement only the adjacent Rust codec/runtime owner.
6. Rebuild HTML and run the focused gates.
7. After all selected fields are source-green, run architecture gates.
8. For runtime completion, run global install, `routecodex restart --port <locator>`,
   health/version checks, and same-entry live replay.
9. Update matrix statuses only after the corresponding evidence exists.

## Verification matrix

Source/document gates:
```sh
npm run render:v3-protocol-semantic-field-matrix
npm run verify:v3-protocol-conversion-field-parity
npm run test:v3-protocol-conversion-field-parity-red-fixtures
npm run verify:v3-architecture-docs
npm run verify:v3-module-boundaries
npm run verify:v3-rust-only
npm run verify:function-map-compile-gate
git diff --check
```

Runtime/source tests when Rust is touched:
```sh
npm run test:v3-protocol-conversion-field-parity
cargo fmt --manifest-path v3/Cargo.toml --all -- --check
```

Live closeout after source gates:
```sh
npm run install:global
routecodex restart --port <locator-port>
curl -s http://127.0.0.1:<member-port>/health
```

Then replay at least one same-entry real sample for each converted protocol
family and capture the provider request/client projection evidence.

## Completion definition

The gap closeout is complete only when:
- The field matrix, text truth, and generated HTML agree.
- The verifier rejects stale truth text, stale status counts, missing gap audit,
  field collapse, MetadataCenter/raw-payload ownership, and unsupported silent
  drops.
- All runtime-supported rows have owner tests and no longer use open gap status.
- Live replay proves the supported conversions do not lose or duplicate semantic
  fields.

This plan is the implementation document for the follow-up `/goal` prompt; the follow-up task should execute this plan directly and must not generate another prompt for the same objective.

## Follow-up `/goal` prompt

```text
/goal
目标：按 docs/goals/v3-protocol-semantic-field-gap-closeout-plan.md 关闭 V3 协议语义字段矩阵中未覆盖的 runtime gap，让 Chat Process 的 OpenAI Chat native + protocol-neutral extension 语义超集从审计真相推进到源码、测试和 live 证据闭环。

说明：本任务不需要再写新的提示词，直接按实现文档执行。

实现文档：
docs/goals/v3-protocol-semantic-field-gap-closeout-plan.md

执行规范：
- 先 diagnosis contract，再按 gap bucket 一次只处理一个字段族；不要整矩阵扫改。
- 只改相邻 V3 Rust codec/runtime owner；禁止 MetadataCenter/raw payload/SSE/server/provider transport 做业务语义 owner。
- OpenAI Chat 原生字段名必须保持原名；扩展字段只能用 protocol-neutral request.* / response.* / edge.*。
- 禁止 fallback、静默 drop、状态重标冒充 runtime closeout；不改配置、不重启、不全局安装，直到 source gates 全绿且进入 live closeout。

验证：
- 每个字段族先红测/失败样本，再 owner 实现，再跑 focused Rust tests。
- 必跑 docs/gate：render, verify:v3-protocol-conversion-field-parity, red fixtures, architecture docs/module/rust/function-map gates, cargo fmt, git diff --check。
- runtime 完成声明前必须全局安装、routecodex restart --port <locator-port>、health/version、同入口真实样本 replay。

完成标准：
- matrix/text truth/generated HTML/gate 全一致。
- extension_declared、semantic_declared、shape_branch_gap、codec_shape_only、partial 只能因真实 owner 测试和实现减少。
- 每个支持语义都有正/反向测试和 live 证据；不支持语义显式 fail-fast/lossy 并有红测锁定。
```

## 2026-07-25 No-Invented-Field / Compatible Projection Repair Plan

### Goal
Repair V3 protocol semantic normalization so Chat Process canonical fields preserve all inbound semantics, outbound provider/client payloads obey target protocol specs, compatible projections are attempted before cleanup, and the canonical Chat semantic space has no invented provider-shaped hierarchy or duplicate semantic ownership.

### Acceptance Criteria
- Inbound normalization preserves every source protocol semantic as an OpenAI Chat native field or registered protocol-neutral extension; no source field is silently dropped.
- Outbound projection emits only legal target protocol fields and applies mapping in this order: exact semantic mapping, compatible target-valid projection, last-resort unsupported/drop decision.
- No canonical field path copies provider-specific nested shape unless it is native OpenAI Chat; all extensions are registered, protocol-neutral, same-stratum, and uniquely owned.
- No semantic duplication: the same exact source field maps to one semantic owner unless it is explicitly marked as a parent shape object with child branch cases and no direct runtime owner.
- No stratum shift without a declared compatible projection rule: request config does not become response content, response content does not become metadata, usage stays usage, tool child fields stay tool fields.
- Reasoning/thinking without a structured target slot is compatibly projected through target-valid text/instruction content with a standard marker before cleanup/drop is considered.

### In Scope
- Matrix/gate hardening for semantic uniqueness, extension registry, no invented hierarchy, no stratum shift, compatible projection marker contract.
- Runtime fixes in V3 Rust protocol owners only, especially:
  - `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs`
  - `v3/crates/routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs`
  - `v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs`
  - `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs`
  - `v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs`
- Protocol matrix docs / generated HTML / red fixtures / test design updates.

### Out of Scope
- Provider config, global install, restart, production traffic changes, and V2 routing behavior.
- `/Users/fanzhang/github/rules` edits.
- Broad node topology refactor or unrelated lifecycle/server restart work.
- Any fallback/degrade path that hides unsupported semantics.

### Design Principles
- OpenAI Chat is the base protocol skeleton; OpenAI Chat native fields keep exact native names.
- Extensions are only for semantics absent from OpenAI Chat, and must be top-level/protocol-neutral at the same semantic stratum.
- Parent shape objects are inventory-only unless child branches are explicitly mapped; runtime cannot use raw subtree presence as semantic ownership.
- Container rows cannot own child source fields that component rows already own.
- Compatible projection is deterministic and target-spec-valid, not fallback. It must be red/green tested and visibly marked when semantic class changes for target display.

### Technical Plan
1. Add a canonical extension registry to `docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml` with allowed extension ids, field paths, strata, owners, source fields, target projection rules, and forbidden provider-shaped names.
2. Refactor matrix rows to remove duplicate semantic ownership:
   - Collapse `content.text_string` and `content.text_part` into one visible-text semantic with shape variants.
   - Split tool-call tuple rows from child component ownership; tuple/container rows reference child owners but do not own the same source fields.
   - Split usage into prompt/input, completion/output, total, cache, reasoning/thought, tool prompt components; aggregate container rows do not directly own duplicate source fields.
   - Replace provider-shaped canonical extensions such as `request.text.format` / `request.top_k` / nested `request.reasoning.*` with registered flat protocol-neutral extension names where needed.
3. Harden `scripts/architecture/verify-v3-protocol-conversion-field-parity.mjs` and red fixtures to fail on:
   - unregistered canonical extension fields;
   - provider-shaped invented hierarchy;
   - duplicate exact source-field owners;
   - request/response/content/tool/usage stratum shifts without a compatible projection contract;
   - reasoning summary/context/display/type/budget/effort collapses;
   - Responses `instructions` demotion on Responses target;
   - logprobs/top_logprobs and Gemini responseLogprobs/logprobs pair violations;
   - missing Anthropic inverse `disable_parallel_tool_use` mapping.
4. Fix runtime owners after red gates are proven:
   - Stop mapping Responses `reasoning.summary/context/mode` to Chat `reasoning_effort` or Anthropic synthetic `thinking.budget_tokens`.
   - Preserve Anthropic inbound `thinking` without inventing `reasoning.effort=medium`.
   - Preserve Responses provider-visible instructions by the provider-standard
     system `input_text` lift; do not expect top-level `instructions` on the
     Responses provider-standard wire.
   - Map Chat `max_completion_tokens` to Responses `max_output_tokens`; do not emit non-spec `max_tokens` to Responses wire.
   - Implement logprob enable/count pair constraints for Chat and Gemini target wire.
   - Implement Anthropic `tool_choice.disable_parallel_tool_use` inverse mapping without emitting top-level `parallel_tool_calls` to Anthropic wire.
   - Add response extension preservation for Chat/Anthropic/Gemini long-tail response fields, then compatible text/metadata projection where target spec permits.
5. Render docs and update maps where source/test owner changes require it.

### Test Plan
- Red-first gates:
  - `npm run test:v3-protocol-conversion-field-parity-red-fixtures`
  - New/updated fixture cases for duplicate source ownership, invented canonical hierarchy, stratum shift, reasoning compatible projection, logprob pairs, Anthropic inverse parallelism, Responses instructions preservation.
- Matrix/doc gates:
  - `npm run render:v3-protocol-semantic-field-matrix`
  - `npm run verify:v3-protocol-conversion-field-parity`
  - `npm run verify:v3-architecture-docs`
- Focused runtime tests:
  - `npm run test:v3-protocol-conversion-field-parity`
  - `npm run test:v3-gemini-codec-characterization`
  - `npm run test:v3-anthropic-codec-characterization`
  - targeted Rust tests covering Responses/OpenAI Chat/Anthropic/Gemini request and response projection.
- Required hygiene:
  - `cargo fmt --manifest-path v3/Cargo.toml --all -- --check`
  - `git diff --check`

### Implementation Order
1. Diagnosis contract: lock unique owner graph and allowed paths from matrix/function map/mainline/verification map.
2. Gate-first: add failing fixtures for the new invariants before changing runtime behavior.
3. Matrix registry: introduce extension registry and remove duplicate/provider-shaped canonical field ownership.
4. Runtime request repairs: reasoning, instructions, max tokens, logprobs, Anthropic inverse parallelism.
5. Runtime response repairs: preserve long-tail response fields and define compatible target projections.
6. Render/sync docs and maps.
7. Run full verification stack and write closeout evidence.

### Risks and Mitigations
- Risk: compatible projection markers could become another invented semantic. Mitigation: keep markers outbound-only, target-valid, documented, and never used as inbound canonical truth.
- Risk: removing duplicate rows could hide source fields. Mitigation: gate source inventory coverage before and after row refactor.
- Risk: provider-specific extension names reappear. Mitigation: extension registry denylist and red fixtures.
- Risk: broad runtime changes touch unrelated server/config flow. Mitigation: keep allowed paths to V3 protocol owners and docs/gates only.

### Definition of Done
- All new red fixtures fail before fixes and pass after fixes.
- Matrix has registered extensions only, no duplicate exact source-field semantic owners, and no provider-shaped canonical hierarchy.
- Runtime request/response projections obey exact -> compatible -> last-resort decision order.
- Required gates pass and closeout evidence names the repaired files, tests, and remaining unsupported decision list.
