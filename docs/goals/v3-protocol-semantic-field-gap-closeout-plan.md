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
| `gap.runtime_extension_declared` | 214 | Implement declared extension semantics in adjacent codec owners or mark explicit unsupported/lossy with fail-fast tests. |
| `gap.semantic_declared_runtime_closeout` | 50 | Implement manually declared native/extension semantics in adjacent codec owners or mark explicit unsupported/lossy with fail-fast tests. |
| `gap.partial_cross_protocol_semantics` | 103 | Complete both request and response transforms for the affected semantic family. |
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
- Gemini `generationConfig` scalar source verification is closed for sampling/logprob/seed semantics in the Gemini codec characterization owner:
  `collect_v3_gemini_request_generation_config_scalar_semantics` plus focused Rust tests prove
  `frequencyPenalty` maps to `request.frequency_penalty`, `presencePenalty` maps to `request.presence_penalty`,
  `responseLogprobs` maps to `request.logprobs`, `logprobs` maps to `request.top_logprobs`, and `seed` maps to
  `request.seed`, without collapsing penalties, logprob flag/count, or seed. Remaining Gemini deep semantics stay open.

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
