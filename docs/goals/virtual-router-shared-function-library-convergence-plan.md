# Virtual Router Shared Function Library Convergence Plan

## Target And Acceptance

Target: converge duplicated pure helper logic inside Rust Virtual Router into narrow shared helper owners without changing routing semantics, provider availability policy, default-pool floor behavior, provider payloads, client payloads, or TS runtime ownership.

Acceptance:
- Each migrated helper has one owner, one allowed call surface, and a gate or red fixture that blocks local clone revival.
- VR route selection, forwarder runtime, route availability floor, diagnostics, and host effects remain Rust-owned according to `docs/architecture/function-map.yml`.
- No provider-specific branch, fallback, payload repair, or tool-governance behavior is introduced into VR helper libraries.
- Bool/number/provider-key/forwarder helpers are only shared when their current per-caller semantics are proven equivalent by tests.
- Each runtime-affecting slice runs focused Rust/JS tests, architecture gates, `build:base`, and live/dry-run checks only when behavior changes.

## Scope

In scope:
- Rust VR pure helper duplication in `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/**`.
- Existing Rust shared helper candidates such as `shared_json_utils.rs`, `virtual_router_engine/routing/utils.rs`, and `virtual_router_engine/routing/key_utils.rs`.
- Function-map, verification-map, architecture gate, red fixture, and goal-plan updates needed to lock each slice.

Out of scope:
- Any TS-side route policy, provider runtime behavior, request/response payload conversion, or handler/executor fallback.
- Hub Pipeline shared-helper work already covered by existing Hub Pipeline plans.
- Forwarder/default-floor behavior changes without a prior red test proving the current issue.
- Broad utility dumps that hide feature ownership.

## Current Evidence

Owner truth:
- `vr.route_selection`, `vr.metadata_center_surface`, `vr.route_retry_pin_surface`, `vr.route_host_effects`, `vr.route_availability_floor`, `vr.provider_forwarder_runtime`, and `vr.online_diagnostics` are active Rust owners in `docs/architecture/function-map.yml`.
- Route availability floor owner and mainline are documented in `docs/architecture/wiki/virtual-router-route-availability-mainline-source.md`.
- `docs/architecture/wiki/virtual-router-ownership-map.md` is the review surface for VR owner boundaries.

Detected duplication candidates:
- Trimmed string / ordered unique string helpers:
  - `virtual_router_engine/bootstrap.rs`: `read_non_empty_string`, `push_unique`
  - `virtual_router_engine/provider_bootstrap.rs`: `push_unique_string`
  - `virtual_router_engine/routing/error_err05_availability.rs`: `normalize_string_list`, `trim_nonempty`
  - `virtual_router_engine/runtime_config_materialization.rs`: `collect_routing_tier_targets`, `push_unique_routing_target`
  - `virtual_router_engine/engine/selection.rs`: `dedupe_candidate_order`
  - `virtual_router_engine/routing/metadata.rs`: `extract_excluded_provider_keys`
- Tool detection constants:
  - `virtual_router_engine/features/tools.rs` already has `WRITE_TOOL_EXACT`, `WRITE_TOOL_KEYWORDS`, and `WEB_TOOL_KEYWORDS`, but local arrays are recreated in `detect_coding_tool` / `detect_web_tool`.
- Provider-key parsing:
  - `virtual_router_engine/routing/key_utils.rs` has basic segment extraction.
  - `provider_bootstrap.rs`, `engine/route.rs`, `routing/direct_model.rs`, `runtime_config_materialization.rs`, `instructions/state.rs`, and provider runtime ingress have local split rules with different semantics.
- Forwarder/default-floor expansion:
  - `ForwarderRegistry::expand_target_keys`, `engine/selection.rs` default-floor target expansion, and `engine/status.rs` diagnostic expansion overlap but do not have identical outputs.
- Bool/number parsing:
  - `routing/utils.rs`, `config_bootstrap.rs`, and `provider_bootstrap.rs` each have bool/number parsers with intentionally different coercion behavior.

## Design Principles

1. Shared helper only when semantics are identical.
2. Shared helper names must encode behavior, not caller convenience.
3. Stage owners keep decisions; helper libraries keep pure mechanics.
4. Route availability and forwarder helpers must preserve the default-pool last-provider floor.
5. No fallback, no dual-path compatibility, no silent normalization of invalid runtime truth.
6. Every deletion of a local helper must be locked by a deny gate or focused red fixture.
7. Multi-worker edits must use `.agent-collab` semantic claims and avoid active dirty paths.

## Execution Plan

### Slice 1: VR String/List Pure Helpers

Goal: introduce a small Rust helper owner for ordered trim/non-empty/dedupe mechanics and migrate exact local clones.

Candidate owner:
- Prefer `virtual_router_engine/routing/utils.rs` when helper is VR-only.
- Use `shared_json_utils.rs` only when the helper is clearly cross-module and not tied to route semantics.

Candidate helpers:
- `trim_nonempty_str(value: &str) -> Option<String>`
- `push_unique_trimmed(out: &mut Vec<String>, seen: &mut HashSet<String>, value: &str)`
- `normalize_unique_trimmed_strings<I>(values: I) -> Vec<String>`

Initial migration candidates:
- `bootstrap.rs` `read_non_empty_string` / `push_unique`
- `routing/error_err05_availability.rs` `trim_nonempty` / `normalize_string_list`
- `provider_bootstrap.rs` `push_unique_string`
- `metadata.rs` `extract_excluded_provider_keys`

Defer until tested:
- `engine/selection.rs` `dedupe_candidate_order`, because it currently preserves original untrimmed candidate strings when non-empty.
- `runtime_config_materialization.rs` `pick_string`-based target handling, because it mixes JSON field priority with dedupe mechanics.

Gate:
- Add a VR shared string helper verifier that fails on new local clone names/patterns in monitored VR files.
- Add red fixtures proving clone revival is rejected.

Verification:
- Focused cargo tests for touched Rust modules.
- `npm run verify:vr-no-ts-runtime`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:llmswitch-rustification-audit`
- `npm run build:base`
- `git diff --check`

### Slice 2: VR Tool Detection Constants

Goal: remove local duplicate arrays in tool detection while preserving classification behavior.

Candidate changes:
- Replace local `write_keywords` with `WRITE_TOOL_KEYWORDS`.
- Replace local `write_exact` with `WRITE_TOOL_EXACT`.
- Replace local web keyword array with `WEB_TOOL_KEYWORDS`.

Do not merge yet:
- `features.rs::read_tool_name` and `features/tools.rs::extract_tool_name`, because one returns lowercase `Option<String>` and the other returns raw `String`.

Gate:
- Add or extend a red fixture that fails if `detect_coding_tool` / `detect_web_tool` recreate monitored constant arrays locally.

Verification:
- Focused Rust tests covering coding/web/tool classification.
- Same architecture and build gates as Slice 1.

### Slice 3: Typed Provider-Key Parsers

Goal: centralize provider-key parsing only after each key shape is named and tested.

Required parser variants:
- `parse_provider_alias_model_key`: requires `provider.alias.model`, preserves dots inside model.
- `parse_provider_alias_key`: requires `provider.alias`, optional model depending on caller.
- `parse_provider_model_key`: requires `provider.model`, used for direct model routing.
- `parse_provider_id_prefix`: returns provider id only for config materialization.

Required tests:
- valid `provider.alias.model`
- model ids containing dots
- missing provider
- missing alias
- missing model where model is required
- `provider.model` direct-routing shape must not be parsed as alias/model by mistake
- provider id prefix extraction must not imply a full target key is valid

Gate:
- Add deny patterns for ad hoc `split('.')` parsing in monitored VR files, with allowed exceptions only for parser implementation and tests.

Verification:
- Focused Rust parser tests.
- Route retry pin tests.
- Direct model routing tests.
- Provider bootstrap/config materialization tests.
- Architecture gates and build gates.

### Slice 4: Forwarder Expansion / Diagnostics Shared Block

Goal: share forwarder expansion mechanics only after route selection and diagnostics outputs are proven separately.

Required boundary:
- Selection returns ordered real provider keys for execution.
- Diagnostics returns status objects and explanations.
- Default-floor expansion ignores request exclusions only where the route availability contract permits it.

Required red tests before refactor:
- Forwarder collapse is not terminal while default pool has an available last provider.
- Disabled forwarder target is filtered from selection.
- Diagnostics still reports unavailable/disabled forwarder details.
- Selection does not consume diagnostic-only status shape.

Potential owner:
- `virtual_router_engine/forwarder.rs` for forwarder entry expansion mechanics.
- Keep default-floor final decision in `engine/selection.rs` / `routing/error_err05_availability.rs`.

Verification:
- `npm run verify:vr-forwarder-runtime`
- `npm run verify:vr-route-availability-default-floor`
- route availability red tests
- online diagnostics tests
- architecture gates and build gates.

## Explicit Non-Moves

- Do not merge bool parsers until caller semantics are split and named. Current parsers differ on `yes/no/on/off`, numeric `1/0`, and string false handling.
- Do not merge number parsers unless floor/truncate/finite/positive behavior is identical.
- Do not use shared helpers to hide provider-specific exceptions.
- Do not move default-floor terminal policy into diagnostics, TS executor, provider runtime, or route host effects.

## File Plan

Likely touched files by slice:
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/routing/utils.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/bootstrap.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/provider_bootstrap.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/routing/error_err05_availability.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/routing/metadata.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/features/tools.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/routing/key_utils.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/forwarder.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/selection.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/status.rs`
- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`
- `docs/architecture/wiki/virtual-router-ownership-map.md`
- `package.json`
- new `scripts/architecture/verify-vr-*-shared-helpers.mjs`
- new `scripts/tests/vr-*-shared-helpers-red-fixtures.mjs`

Implementation must narrow this list per slice and claim only the current semantic owner.

## Risk And Mitigation

- Risk: helper abstraction becomes a dumping ground.
  - Mitigation: one helper family per slice; feature map names the owner; gate blocks unrelated additions.
- Risk: equivalent-looking parsers have different semantics.
  - Mitigation: add tests before consolidation; keep non-equivalent helpers local with comments naming why.
- Risk: route availability changes while "just refactoring".
  - Mitigation: route availability/default-floor gates are mandatory for forwarder and selection-adjacent slices.
- Risk: multi-worker dirty paths collide.
  - Mitigation: inspect `.agent-collab/claims/*/owner.json` before writing; claim a narrow semantic id; avoid active broad source claims.
- Risk: docs/gates claim completion without runtime proof.
  - Mitigation: report source/gate closeout only unless behavior-changing slices are built, installed when required, and replayed through the relevant live/dry-run entry.

## Verification Matrix

Always:
- `git diff --check`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:vr-no-ts-runtime`
- `npm run verify:llmswitch-rustification-audit`
- `npm run build:base`

String/list slice:
- focused cargo tests for `routing::utils`, `bootstrap`, `provider_bootstrap`, and `error_err05_availability`
- new shared-helper deny gate and red fixtures

Tool constants slice:
- focused cargo tests for `virtual_router_engine::features::tools`
- deny gate for local duplicate arrays

Provider-key parser slice:
- focused cargo parser tests
- route retry pin / direct model routing / provider bootstrap tests
- deny gate for ad hoc monitored `split('.')` parsing

Forwarder/default-floor slice:
- `npm run verify:vr-forwarder-runtime`
- `npm run verify:vr-route-availability-default-floor`
- route availability red tests
- online diagnostics tests

Live validation:
- Required only when a slice changes route behavior, availability decision, forwarder selection, or diagnostics surface.
- Use global installed `routecodex` and live VR status/dry-run per project rules.

## Implementation Order

1. Recheck `.agent-collab` claims and claim one narrow semantic id.
2. Add function-map / verification-map entry for the slice if no suitable owner exists.
3. Add failing deny gate or red fixture for the duplicated local implementation.
4. Add exact shared helper with focused Rust unit tests.
5. Migrate only exact-equivalent local clones.
6. Physically delete old helper definitions.
7. Run focused tests, architecture gates, build, and behavior/live validation if applicable.
8. Update wiki/manifest if map changes require regeneration.
9. Record evidence in `.agent-collab` and project notes/memory only after verification.

## Definition Of Done

- The chosen slice has no duplicate local helper left in monitored files.
- The owner, allowed paths, required tests, and required gates are queryable.
- Red fixtures prove duplicate helper revival fails.
- Focused tests and architecture gates pass.
- No fallback, no TS semantic expansion, no provider/client payload change.
- Remaining non-moved helpers are explicitly listed with semantic reason.
