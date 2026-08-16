# V3 Resp03 Tool Governance Gap Closeout Plan

## Status

- Date: 2026-07-23
- Scope: implementation gap audit and closeout plan for the current V3 Req04 / Resp03 tool-governance small skeleton.
- Runtime scope: no runtime edit, no install, no restart, no live replay in the audit slice.

## Target architecture

Canonical review surface:

- `docs/architecture/wiki/v3-req04-tool-governance-review.md`
- `docs/architecture/wiki/html/v3-req04-tool-governance-review.html`
- `docs/architecture/v3-architecture-audit-locks.yml`
- `docs/architecture/wiki/v3-mainline-skeleton-sop.md`

### Request target

Request lifecycle starts at client SSE entry and stays separate from response governance:

```text
Client SSE Request Start
  -> Server SSE Frame Accepted
  -> Request Normalization
  -> Tool Output Pair Normalization
  -> Continuation Owner Check
  -> Continuation Restore at Req04
  -> Merge Current Tool Surfaces
  -> Preserve Client Tool Feedback
  -> Inject Current Internal Tools
  -> Emit Req04 Governed Request
```

Hard rules:

- Preserve client tool feedback, including parse-error / unknown-tool / unsupported feedback.
- Preserve Codex `additional_tools` surface; do not flatten or delete it for convenience.
- Do not invent request-side cleanup / provenance / artifact-removal paths.
- Provider-bound malformed fields are fixed in ReqOutbound/provider codec, not by deleting transcript truth in Req04.

### Response target

Response lifecycle starts at provider raw response and must be governed before Resp04:

```text
Provider Response Raw
  -> Provider Response Compat
  -> RespInbound Normalization
  -> Resp03 Text Harvest First
  -> Resp03 Complete / Repair Tool Frames
       - may correct finish_reason, e.g. stop -> tool_call
  -> Inspect finish_reason
     -> if finish_reason=tool_call:
          Tool-call Servertool Hook
          -> if servertool intercepted:
               Update Runtime Control Side-Channel
          -> if not intercepted:
               Ordinary Tool Governance
               -> Update Runtime Control Side-Channel
     -> if finish_reason=stop:
          Stop Servertool Hook
          -> Update Runtime Control Side-Channel
     -> if other:
          Emit Resp03 Governed Semantic
  -> Emit Resp03 Governed Semantic
  -> Resp04 Continuation Save
  -> RespOutbound Client Semantic
  -> JSON to SSE Client Frame
```

Hard rules:

- Provider response compat precedes RespInbound normalization.
- Text harvest and tool-frame repair precede finish_reason branch decision.
- Tool-call servertool hook and stop servertool hook are distinct nodes.
- Ordinary tool governance runs only after tool-call servertool pass-through.
- Resp04 is the Chat Process endpoint for continuation save only; no response semantic repair.
- RespOutbound / JSON-to-SSE only project/frame; no governance or continuation save.

## Evidence

Audit commands run in current worktree:

```bash
mempalace search --wing routecodex --results 5 "V3 Resp03 Req04 stopless servertool tool governance continuation"
npm run verify:architecture-wiki-html-sync
npm run verify:v3-architecture-docs
npm run verify:v3-relay-tool-servertool-multiturn-parity-closeout
npm run test:v3-relay-tool-servertool-multiturn-parity-closeout-red-fixtures
git diff --check
```

Observed verification status:

- `verify:architecture-wiki-html-sync`: PASS
- `verify:v3-architecture-docs`: PASS
- `verify:v3-relay-tool-servertool-multiturn-parity-closeout`: PASS
- `test:v3-relay-tool-servertool-multiturn-parity-closeout-red-fixtures`: PASS, 23 forbidden mutations rejected
- `git diff --check`: PASS

These gates prove the current docs and coarse gates are internally synced, but they do not prove the response small skeleton implementation is aligned. The gaps below are implementation and gate coverage gaps found by source audit.

## Implementation gaps

### GAP-RSP-01: Resp03 ordering runs stopless before text harvest / tool repair

Target:

- Resp03 must run text harvest first.
- Then complete/repair tool frames and correct finish_reason.
- Then inspect finish_reason and branch into tool_call/stop governance.

Current evidence:

- `v3/crates/routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs::govern_v3_hub_relay_response`
- Current order:
  1. `apply_v3_stopless_response_hook_at_resp03(input, profile)`
  2. `harvest_v3_think_blocks_at_resp03(stopless_outcome.input)`
  3. `project_v3_apply_patch_freeform_calls_at_resp03(input)`
  4. `build_v3_resp03_protocol_governance(&input)`

Risk:

- A provider response with `finish_reason=stop` plus repairable/harvestable tool call content can be intercepted as a natural stop before Resp03 sees the corrected tool-call semantic.
- This directly violates the target order: text/tool repair must happen before stopless / finish_reason decisions.

Owner:

- `v3/crates/routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs`

### GAP-RSP-02: stop hook and tool_call servertool hook are merged

Target:

- `finish_reason=tool_call` uses a Tool-call Servertool Hook.
- `finish_reason=stop` uses a separate Stop Servertool Hook.

Current evidence:

- `servertool_hooks.rs::apply_v3_stopless_response_hook_at_resp03` handles both:
  - `first_reasoning_stop_tool_call_arguments(object.get("output"))`
  - natural stop via `response_has_stopless_stop_trigger(...)` and `response_is_completed_responses_object_without_finish_reason(...)`
- `resp_chat_process_03_governed.rs::govern_v3_hub_relay_response` later sets `servertool_action` by scanning `governance.tool_calls` for names in `profile.servertool_names`.
- No distinct source symbols currently represent:
  - `apply_v3_tool_call_servertool_hook_at_resp03`
  - `apply_v3_stop_servertool_hook_at_resp03`
  - corrected `finish_reason` branch dispatcher.

Risk:

- The hook semantics are not tied to a corrected finish_reason.
- Natural stop and reasoningStop tool-call handling can share an owner path even when the target architecture requires separate nodes.

Owner:

- Rust Resp03 response governance owner:
  - `resp_chat_process_03_governed.rs`
  - `servertool_hooks.rs`

### GAP-RSP-03: finish_reason/status repair currently lives partly in Resp04

Target:

- Tool-frame completion/repair and finish_reason correction are Resp03 responsibilities.
- Resp04 only saves/commits already governed continuation truth.

Current evidence:

- `v3/crates/routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs::canonicalize_v3_hub_resp04_finalized_payload`
- For non-terminal tool calls, Resp04 mutates:
  - `status` to `requires_action`
  - `finish_reason` / `finishReason` / `stop_reason` / `stopReason` to `tool_calls`

Risk:

- Resp03 branch selection cannot rely on final corrected finish_reason if correction happens later in Resp04.
- Resp04 becomes a semantic repair owner, violating the Chat Process endpoint contract.

Owner:

- Move semantic correction to Resp03 governed output.
- Keep Resp04 limited to save/release of already governed canonical truth.

### GAP-RSP-04: ordinary tool governance can run before tool-call servertool pass-through

Target:

- In the tool_call branch, servertool interception runs first.
- Ordinary tool governance (`exec_command`, `apply_patch`, client tools) runs only after servertool pass-through.

Current evidence:

- `resp_chat_process_03_governed.rs::govern_v3_hub_relay_response` runs `project_v3_apply_patch_freeform_calls_at_resp03(input)` before `servertool_action` classification.
- `build_v3_resp03_protocol_governance(&input)` classifies all tool calls before the later `servertool_action` scan.
- The current `servertool_action` value is a post-classification flag, not a branch gate that prevents ordinary governance for intercepted servertool calls.

Risk:

- Ordinary tool projection/governance can mutate or classify a tool call before servertool has the first interception opportunity.
- This violates the target response branch ordering.

Owner:

- `resp_chat_process_03_governed.rs` should orchestrate branch order explicitly.

### GAP-RSP-05: provider compat already harvests some text tool calls, but the small skeleton does not bind this ownership clearly

Target:

- Provider Response Compat may handle provider-specific shape compatibility.
- Resp03 owns response governance: text harvest, tool-frame completion/repair, finish_reason split, servertool/ordinary governance.

Current evidence:

- `v3/crates/routecodex-v3-runtime/src/hub_v1/provider_resp_compat_02_provider_compat.rs::apply_v3_provider_resp_compat` calls `provider_compat_core::run_resp_inbound_stage3_compat`.
- `sharedmodule/llmswitch-core/rust-core/crates/provider-compat-core/src/lib.rs::run_resp_inbound_stage3_compat` applies:
  - MiniMax `harvest_text_tool_calls(...)`
  - GLM `apply_glm_response_compat(...)`
- These compat paths can insert tool calls and set `finish_reason` to `tool_calls`.

Risk:

- Some tool-frame/finish_reason repair currently happens before Resp03 under provider compat.
- This can be valid only if it is strictly provider-specific response shape compatibility. The current small skeleton and gates do not distinguish provider-specific compat from provider-neutral Resp03 governance strongly enough.

Owner:

- Architecture maps/verifiers must make the boundary explicit.
- Runtime should keep provider-specific compat in `ProviderRespCompat02`; provider-neutral tool governance and branch decisions stay in Resp03.

### GAP-RSP-06: OpenAI Chat -> Responses projection is hidden between normalize and govern

Target:

- Response chain is raw -> compat -> RespInbound -> Resp03.
- If a provider protocol has to be projected into Responses shape for `/v1/responses`, the map must declare which adjacent node owns it.

Current evidence:

- `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs::run_json_response_hooks`
- Current sequence:
  - `hooks.normalize(resp01)`
  - if provider protocol is OpenAIChat, call `build_v3_responses_provider_response_from_openai_chat_payload(...)`
  - mutate `resp02.provider_payload` and switch provider protocol to `Responses`
  - `hooks.govern(resp02, ...)`
- `build_v3_responses_provider_response_from_openai_chat_payload(...)` sets `status` to `requires_action` when it sees tool calls or `finish_reason=tool_calls`.

Risk:

- This is a semantic projection between RespInbound and Resp03 that is not explicitly named in the small skeleton as a compat/inbound-internal subnode.
- If it is considered tool-frame repair, it is in the wrong owner; if it is considered protocol projection, the map must declare it clearly.

Owner:

- `responses_relay_runtime.rs` for protocol projection wiring.
- Architecture maps/manifests for explicit edge ownership.

### GAP-GATE-01: current gates are too coarse to lock the new small response skeleton

Target:

- Gates must reject:
  - finish_reason split before text harvest/tool repair
  - merged stop/tool_call servertool hook
  - ordinary tool governance before tool-call servertool pass-through
  - Resp04 semantic repair
  - RespOutbound/JSON-to-SSE doing governance

Current evidence:

- `scripts/architecture/verify-v3-relay-tool-servertool-multiturn-parity.mjs` currently requires broad markers such as:
  - `project_v3_apply_patch_freeform_calls_at_resp03`
  - `servertool_action`
  - `canonicalize_v3_hub_resp04_finalized_payload`
- `scripts/tests/v3-relay-tool-servertool-multiturn-parity-red-fixtures.mjs` currently has a fixture named `Resp04 non-terminal tool-call canonicalization removed`, which protects a function that the new target wants removed or demoted from semantic repair ownership.
- `scripts/architecture/v3-req04-tool-governance-review-lib.mjs` has the correct human response nodes, but the checklist/red-fixture rows are not yet source-symbol/order locked for all new response target nodes.
- `docs/architecture/v3-mainline-call-map.yml` binds the response chain coarsely at `V3HubRespInbound02Normalized -> V3HubRespChatProcess03Governed -> V3HubRespContinuation04Committed`, without internal Resp03 small-skeleton edges.

Risk:

- Current verification can pass while runtime still violates the target order.
- A future worker may keep Resp04 semantic repair because an existing red fixture treats it as required.

Owner:

- Architecture maps and verifiers:
  - `docs/architecture/v3-mainline-call-map.yml`
  - `docs/architecture/v3-function-map.yml`
  - `docs/architecture/v3-verification-map.yml`
  - `scripts/architecture/v3-req04-tool-governance-review-lib.mjs`
  - `scripts/architecture/verify-v3-relay-tool-servertool-multiturn-parity.mjs`
  - `scripts/tests/v3-relay-tool-servertool-multiturn-parity-red-fixtures.mjs`

### GAP-REQ-01: request skeleton is accepted, but the small-skeleton feature is not fully map-bound

Target:

- The small skeleton should be queryable as a feature/owner/gate target, not only as an HTML review surface.

Current evidence:

- `docs/architecture/wiki/v3-req04-tool-governance-review.md` and generated HTML exist.
- Direct lookup for `v3_req04_tool_governance` / `req04-tool-governance` in `v3-function-map.yml`, `v3-mainline-call-map.yml`, and `v3-verification-map.yml` has no feature binding.

Risk:

- Debug can start from the HTML page, but owner/gate lookup cannot reliably start from a stable feature_id for this small skeleton.

Owner:

- Architecture registry/gates only. No runtime change required for this gap.

## Required red tests / gates before implementation

Add failing tests before runtime changes:

1. A provider response with `finish_reason=stop` plus repairable text/tool-call content must be repaired to tool_call path before stopless natural-stop hook can run.
2. A source/order gate must fail if `apply_v3_stopless_response_hook_at_resp03` runs before text harvest and tool-frame repair.
3. A gate/test must fail if stop hook and tool_call servertool hook are represented by one merged response hook.
4. A gate/test must fail if ordinary `apply_patch` / client tool governance runs before tool-call servertool pass-through.
5. A gate/test must fail if Resp04 mutates `finish_reason`, `status`, tool frames, history, or guidance as semantic repair.
6. A gate/test must fail if RespOutbound or JSON-to-SSE introduces response governance.
7. A map/verifier fixture must bind the small skeleton feature_id to function map, mainline call map, verification map, and generated HTML.

## Implementation rules

- Modify Rust owner only for runtime semantics:
  - `v3/crates/routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs`
  - `v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs`
  - `v3/crates/routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs`
- Do not patch SSE/server handler/RespOutbound/provider transport to fix governance semantics.
- Keep provider-specific response shape compatibility in `ProviderRespCompat02`; keep provider-neutral governance in Resp03.
- Keep request side free of unproven cleanup/provenance/artifact-removal paths.
- Do not delete or hide non-RouteCodex tool calls/outputs; client error feedback is model-correction truth.
- No fallback, no silent cleanup, no second governance owner.

## Verification plan

Minimum source gates:

```bash
cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-runtime --test hub_relay_response_semantics -- --nocapture
cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-runtime --test hub_relay_tool_servertool_multiturn_parity -- --nocapture
npm run verify:v3-relay-tool-servertool-multiturn-parity-closeout
npm run test:v3-relay-tool-servertool-multiturn-parity-closeout-red-fixtures
npm run verify:v3-normalization-payload-logic-boundary
npm run verify:v3-architecture-docs
npm run verify:architecture-wiki-html-sync
npm run verify:architecture-wiki-sync
node scripts/architecture/verify-architecture-wiki-browser-smoke.mjs
git diff --check
```

Runtime/live closeout is required only if the implementation is promoted as installed V3 behavior:

```bash
npm run install:global
routecodex restart --port 5555
curl -sS http://127.0.0.1:5555/health
```

Then replay the old failing sample through the same `/v1/responses` entry and verify provider send/client SSE evidence. Do not use `start`.

## Definition of done

- Red tests first prove the current gaps.
- Runtime changes make those tests green through the Rust owner path.
- Maps/wiki/verifiers lock the small skeleton order and owner boundaries.
- Resp03 owns text harvest, tool-frame repair, finish_reason branch, servertool hooks, and ordinary tool governance.
- Resp04 no longer owns semantic repair; it saves/releases continuation only.
- RespOutbound and JSON-to-SSE remain projection/framing only.
- If no install/restart/live replay was run, completion report must say source gates only and must not claim live closeout.
