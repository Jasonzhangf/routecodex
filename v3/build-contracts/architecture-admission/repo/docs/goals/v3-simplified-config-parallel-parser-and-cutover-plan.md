# V3 simplified `config.toml` parallel parser and cutover plan

Status: Phase 4 source/build/install and initial live replay passed; the required fresh AGY Review is pending because an external restart left the managed V3 instance `NotRunning`. Phase 5 retirement has not started.

## 1. Objective

Build a new Rust module that parses a minimal user-facing `config.toml`, projects it into the existing `V3Config02AuthoringParsed` contract, and then reuses the one existing Config compiler through `V3Config05ManifestPublished`.

The current `config.v3.toml` parser, CLI path, WebUI path, and live runtime remain unchanged until the new module works independently and the old/new runtime-effective manifests pass differential verification. Only then wire `config.toml`; only after installed/live verification and AGY Review PASS may the old implementation be physically retired.

The user-facing file contains routing choices only:

- select existing `provider/model` entries from the provider directory;
- order candidates by visible tiers;
- optionally assign weights among candidates in the same tier.

Provider authentication, endpoint, model capability, and compatibility facts remain in `provider/<provider-id>/config.v2.toml`. Route matching, listener topology, feature defaults, error policy, debug policy, execution details, and other product-controlled values belong to the compiled `internal.toml` layer, not the user file.

## 2. Acceptance criteria

1. `config.toml` is parsed by a new parallel Rust module; the existing `config.v3.toml` parser is not modified into a format switch.
2. Both inputs converge before the existing unique schema/compiler boundary and produce the same runtime-effective `V3Config05ManifestPublished` semantics.
3. The new module is fully testable through an explicit API before CLI, WebUI, default-path, lifecycle, or runtime wiring changes.
4. The migrated `config.toml`, derived from the currently active `~/.rcc/config.v3.toml`, passes standalone parsing, provider-reference validation, compilation, normalized differential comparison, and controlled provider-request dry-run.
5. Different valid syntactic inputs—omitted equal weights versus explicit equal weights, reordered TOML tables, compact versus expanded candidate objects—produce the same normalized manifest. Invalid or ambiguous inputs fail before manifest publication.
6. `rccv3 init` creates the smallest valid `config.toml` by selecting existing provider-directory models; it does not ask users to reproduce provider auth, capabilities, endpoints, internal policies, or server execution fields.
7. Routes WebUI edits ordered tiers and optional same-tier weights through provider-directory choices, exposes honest loading/empty/error/dirty/valid/saved states, and works by keyboard and at desktop/mobile widths.
8. The live cutover uses the globally installed binary, one aggregate `routecodex restart`, all configured listener health checks, and real old-sample replays. No stop/start sequence is allowed.
9. AGY Review returns PASS after all source, installed, and live gates.
10. Only after items 1–9 pass, `config.toml` becomes the sole default user config and the old parser/schema/CLI/WebUI/tests/docs are physically removed. No compatibility fallback, dual-source precedence, filename sniffing, or silent parse retry remains.

## 3. Scope and boundaries

### In scope

- New minimal `config.toml` schema and parallel parser/projector.
- Internal defaults needed to remove non-routing fields from the user file.
- Provider-directory reference validation.
- Current `config.v3.toml` to `config.toml` semantic migration.
- Old/new normalized-manifest differential harness.
- CLI initialization and explicit config checking.
- Routes WebUI/API simplification.
- Default filename/lifecycle wiring after standalone gates.
- Installed/live cutover and final physical retirement.
- Resource, function, mainline, module, verification, wiki, and CI/build gate lockstep.

### Out of scope

- Provider protocol, auth, capability, health, or error-mapping redesign.
- Virtual Router selection algorithm changes.
- Request/response payload changes.
- New runtime fallback or compatibility layer.
- Provider-specific branches in Hub Pipeline or Virtual Router.
- UI visual redesign unrelated to the routing task.
- A second config compiler, Manifest type, routing engine, or provider directory.

## 4. Architecture and ownership

### 4.1 Required topology

```text
Development-only explicit paths

config.v3.toml
  -> existing V3 parser
  -> V3Config02AuthoringParsed
  -> existing validate / resource-registry / publish chain
  -> V3Config05ManifestPublished

config.toml
  -> new V3 user-config parser/projector
  -> V3Config02AuthoringParsed
  -> the same existing validate / resource-registry / publish chain
  -> V3Config05ManifestPublished
```

After cutover:

```text
config.toml
  -> new V3 user-config parser/projector
  -> V3Config02AuthoringParsed
  -> V3Config03SchemaValidated
  -> V3Config04ResourceRegistryBuilt
  -> V3Config05ManifestPublished
  -> runtime consumers
```

Hard constraints:

- The new module owns only `config.toml` syntax and projection into `V3Config02AuthoringParsed`.
- Existing `validate_v3_config_03_schema_from_v3_config_02`, `build_v3_config_04_resource_registry_from_v3_config_03`, and `publish_v3_config_05_manifest_from_v3_config_04` remain the unique compiler chain.
- Runtime consumes only `V3Config05ManifestPublished`; it may not inspect filenames, authoring TOML, provider directories, or parser variants.
- During parallel development, format selection is explicit in tests/commands. Do not auto-read both files, sniff format, retry another parser, or define precedence.
- Config control data never enters request/response normal payload or protocol metadata.

### 4.2 Owner bindings that must be completed before implementation

Current maps anchor `v3.config_interpreter_contract` and the `V3Config01–05` chain. The module registry and verification map also declare `v3.config_management`, but the resource/function/mainline bindings do not yet fully describe a minimal user-config parser lifecycle. Before product code:

1. Add explicit resources for the new file source and parsed routing-selection authoring.
2. Add a `v3.user_config.compile` mainline ending at the existing `V3Config02AuthoringParsed` node—never at a second Manifest compiler.
3. Bind the new parser/projector symbols and exact paths in the function map.
4. Update `v3.config_management` module ownership/allowed edges for the new source file and CLI/Admin calls.
5. Add positive, negative, differential, no-fallback, and runtime-does-not-read-authoring gates to the verification map and CI/build entry.
6. Mark all new entries `active` only after sources and gates exist; do not use `design` entries as implementation truth.

Canonical maps:

- `docs/architecture/v3-resource-operation-map.yml`
- `docs/architecture/v3-function-map.yml`
- `docs/architecture/v3-mainline-call-map.yml`
- `docs/architecture/repository-filesystem-module-registry.yml`
- `docs/architecture/v3-verification-map.yml`

### 4.3 Concrete source ownership

Use the smallest owner-compatible implementation:

- New parser/projector module: `v3/crates/routecodex-v3-config/src/user_config.rs`.
- Existing compiler owner: `v3/crates/routecodex-v3-config/src/lib.rs`, `types.rs`, `validate.rs`, `defaults.rs`, `store.rs`.
- Product-controlled defaults: `v3/crates/routecodex-v3-config/src/internal.toml` and its typed reader in `internal.rs`.
- Provider facts: `provider/<provider-id>/config.v2.toml`, consumed through the existing provider-directory owner.
- CLI initialization: `v3/crates/routecodex-v3-cli/src/init.rs` and the narrow command/path wiring in `main.rs`.
- Route editing/view model: `v3/crates/routecodex-v3-config-mgmt/src/route.rs` and `store.rs`.
- Admin API: `v3/crates/routecodex-v3-admin/src/api/routes.rs`.
- Routes UI: `v3/admin-webui/routes.html` and incumbent `v3/admin-webui/styles.css` only; do not introduce a second frontend stack or component system.

If the module registry does not permit one of these paths, correct the map/ownership contract before editing. Do not route around the owner.

## 5. Minimal user schema

The schema exposes route group, pool, ordered tiers, provider/model reference, and optional same-tier weight—nothing else.

```toml
version = 3

[route_groups.routecodex_v3_4444.default]
tiers = [
  [
    { use = "cc-sol/gpt-5.6-sol", weight = 70 },
    { use = "opencode-go/deepseek-v4-flash", weight = 30 },
  ],
  [
    { use = "minimax_anthropic/MiniMax-M3" },
  ],
]

[route_groups.routecodex_v3_4444.search]
tiers = [
  [{ use = "minimax_anthropic/MiniMax-M3" }],
  [{ use = "cc-sol/gpt-5.6-sol" }],
]
```

Semantics:

- Outer array order is priority: first tier is attempted before the second. Users never type numeric priority.
- Members in one inner array share a tier and use weighted selection.
- A single member needs no weight.
- If every member in a multi-member tier omits weight, the compiler assigns equal normalized weight.
- Explicit weights must be positive integers; zero, negative, mixed omitted/explicit weights, overflow, duplicates in one tier, empty tiers, and empty pools fail-fast.
- `use` is exactly `<provider-id>/<model-id>`. The referenced enabled provider and model must exist in the provider directory before `V3Config02AuthoringParsed` is emitted.
- A route group must be declared by the internal topology. An unknown group or pool fails; users cannot create server topology or routing-match semantics from this file.
- A declared group must have a non-empty `default` pool. Functional pools omitted by the user inherit the internal declaration’s default route during authoring projection. This is deterministic compile-time materialization, not runtime fallback.
- Matching rules, route policies, selection strategy implementation, listener/server fields, Hub skeleton, features, errors, debug, admin, and execution settings are rejected as unknown user fields.
- Parser structs use `deny_unknown_fields`; bad input is reported with a field path and no file is written or manifest published.

The projector assigns deterministic internal numeric priorities from tier order solely to satisfy the existing authoring contract. Those numbers are not user-visible and have no independent semantic owner.

## 6. Current `config.v3.toml` migration contract

Baseline evidence from the current `~/.rcc/config.v3.toml` audit:

- 373 lines;
- 23 pools and 74 target references;
- 9 unique provider/model pairs;
- two enabled routing listeners, 4444 and 7777, plus Admin 8777;
- `anthropic_v3_10000` is not referenced by any server;
- priority values are inconsistent across pools, but current V3 Target source selects the maximum numeric priority; migration must preserve that compiled behavior rather than infer intent from comments.

Migration rules:

1. Parse the old file with the existing parser/compiler as the baseline; never infer semantics from comments.
2. Move product-controlled sections—`pipelines`, `features`, `error`, server/listener topology, pool matching, route policies, execution, debug, and Admin declarations—to typed internal defaults where they are still required.
3. Keep provider/model capabilities, auth, endpoints, and compatibility in provider-directory files.
4. Convert only reachable route group/pool target choices into `config.toml`.
5. Preserve actual current selection semantics: sort old targets by descending numeric priority; equal values become one tier; retain weights only within that tier. Do not silently reinterpret a comment that contradicts runtime behavior.
6. Emit a migration audit table containing old group/pool, old priority/weight, resulting tier/member order, and provider-directory resolution.
7. Treat `anthropic_v3_10000` as dead authoring only after proving no server/internal topology references it. Exclude it from the minimal file and assert its absence cannot change any enabled listener’s compiled runtime projection.
8. Normalize only non-semantic differences for comparison: TOML order, source path/hash, generated internal priority integers, and unreachable declarations proven dead. Every enabled-server routing choice, pool match outcome, provider/model candidate order, weight, feature, error, pipeline, execution, and Admin/runtime declaration must match.
9. Any unexplained differential blocks wiring. Do not patch the comparator to ignore it.

The migration is not allowed to “correct” the current route order implicitly. If Jason wants a new order after the parity baseline is green, make that a separate explicit `config.toml` edit and validate it as a behavior change.

## 7. Test design and verification matrix

### 7.1 Parser/projector unit tests

Positive:

- minimal single group/default/single candidate;
- multiple ordered tiers;
- equal same-tier weights omitted;
- explicit same-tier weights;
- TOML table/key order changes;
- compact and expanded candidate syntax if both are deliberately supported;
- provider/model IDs containing allowed punctuation;
- omitted functional pools deterministically inherit compiled default;
- all current reachable pools/projected targets from `config.v3.toml`.

Negative:

- unknown top-level/internal field;
- missing or empty default pool;
- empty tier or member;
- malformed `use` reference;
- missing, disabled, or unknown provider/model;
- duplicate member in a tier;
- zero/negative/overflow weight;
- mixed explicit and omitted weight in one tier;
- unknown group/pool not declared by internal topology;
- user attempts to specify priority, match, server, error, feature, auth, endpoint, debug, or execution fields;
- invalid input publishes no manifest and writes no file.

### 7.2 Differential tests

Compile the old current fixture and migrated new fixture independently, then compare a typed normalized runtime-effective manifest:

- enabled listeners and endpoint bindings;
- route-group/pool availability;
- pool matching and policy outcomes;
- tier/candidate order and weights;
- provider/model resolution;
- internal feature/error/pipeline/execution declarations;
- Admin declaration;
- provider-request dry-run target and final `providerRequest` for representative default, compact, search, tools, thinking, coding, multimodal, and long-context inputs.

Add mutation tests proving the differential fails when a tier is reversed, a candidate/weight is changed, an internal default is missing, or a provider reference resolves differently.

### 7.3 Store and CLI tests

- `config check -c <explicit config.toml>` uses only the new parser.
- `config check -c <explicit config.v3.toml>` uses only the old parser during the standalone phase.
- No parser retry occurs after syntax/schema failure.
- `rccv3 init` scans existing enabled provider/model entries and writes a minimal `config.toml` atomically.
- Interactive and non-interactive init produce the same semantic output.
- Existing destination refuses overwrite without explicit `--force`.
- Validation occurs before atomic commit; invalid selections leave the file untouched.
- Init does not duplicate provider auth/capability/endpoint authoring.

### 7.4 WebUI/API tests

- Routes page calls `load()` on startup and renders the route tree.
- No duplicate element IDs; one visible primary save action.
- Cooldown/health tables are absent from Routes and remain owned by observability/provider-health surfaces.
- Provider/model picker is populated from the provider directory and cannot submit a stale/disabled reference.
- Tier move, same-tier add/remove, and weight edit round-trip through the new `config.toml` store without exposing numeric priority.
- Loading, empty, permission, error, dirty, validating, valid, saving, and saved states are honest and layout-stable.
- Keyboard navigation, visible focus, labels, validation announcements, contrast, zoom/reflow, narrow/mobile width, and reduced motion meet WCAG 2.1 AA.
- Browser verification covers desktop and mobile widths plus slow/error states.

### 7.5 Architecture and release gates

- Resource/function/mainline/module/verification map gates and their red fixtures.
- Runtime-source scan proving runtime consumes `V3Config05ManifestPublished` only.
- No-fallback scan proving no dual read, precedence, format sniff, retry parser, or silent strip.
- Focused config/config-mgmt/admin/CLI tests.
- Full V3 workspace test/build using the canonical V3 Cargo test wrapper.
- `git diff --check` and actual-diff module-boundary self-review.
- Globally installed binary path/hash/version equality.
- Explicit `config.toml` config check and provider-request dry-run.
- One aggregate `routecodex restart -c <config.toml>` during controlled pre-cutover validation; all configured listener `/health` checks.
- Same-entry real old-sample replay for every enabled entry protocol and representative route pool.
- After default-path cutover, one no-argument `routecodex restart` must resolve only `config.toml`; verify all listeners again.
- AGY Review after all prior gates; any code/config/test change after PASS invalidates the PASS and requires affected verification plus a new review.

## 8. CLI initialization UX

`rccv3 init` becomes routing initialization, not provider creation:

1. Discover enabled provider/model entries from the provider directory.
2. If exactly one usable entry exists, preselect it and show the generated default route for confirmation or non-interactive output.
3. If multiple exist, present a searchable numbered list and choose the first default-tier member; adding backups is optional.
4. Write only `version` and the smallest required default route section.
5. Validate against the same new parser/projector/compiler before atomic commit.
6. If no usable provider/model exists, fail with an explicit instruction to configure the provider pool first; do not create guessed provider settings or fallback targets.

CLI output should state the file written, selected default route, validation result, and next command. Advanced/internal fields must not appear in prompts.

## 9. Routes WebUI UX contract

Surface: Routes · Mode: operate.

Primary task: choose providers/models, order fallback tiers, and set optional same-tier traffic weights.

Use the incumbent static HTML/CSS/JS and Admin API owners. During implementation, follow `frontend-ui-reference`:

- inspect the existing product tokens/components first;
- use shadcn form/select/card semantics as accessibility/structure reference, adapted to the incumbent stack without adding React, Tailwind, Radix, Motion, or a second icon set;
- use one ordered pool card pattern: “Tier 1 / Tier 2” with drag-free keyboard-accessible up/down controls;
- show weights only when a tier has multiple members; explain that omitted weights are equal;
- keep internal numeric priority, match rules, server execution, and health/cooldown controls out of the surface;
- preserve stable geometry and visible state feedback; avoid decoration-only motion and `transition: all`;
- record the selected source URL/pattern, integration owner, states, dependency/license check, and browser evidence in the implementation evidence.

Mandatory current defects to close:

- startup currently does not invoke the defined `load()` route-tree loader;
- `id="save-btn"` is duplicated;
- Cooldown pool currently dominates the Routes page and belongs to observability/provider health.

## 10. Ordered implementation phases

### Phase 0 — contract and test design

1. Refresh `.agent-collab`, resolve or hand off the stale `feature_id:v3.config_management` claim, create a fresh run/semantic claim, and use one declared clean worktree.
2. Read current maps and bind every planned file/edge/resource.
3. Add the new user-config resources/mainline/function/module/verification contracts and test design.
4. Add red fixtures proving missing source bindings, second Manifest compiler, runtime authoring-file reads, fallback parser behavior, and user exposure of internal fields are rejected.

Exit: maps/gates identify one parser/projector owner and the existing unique compiler; red fixtures fail for the intended reasons.

### Phase 1 — standalone new module

1. Add `user_config.rs` typed schema, strict parser, provider reference validator, weight normalization, and deterministic projector.
2. Extend typed `internal.toml` declarations only for values removed from the user surface.
3. Keep the new module reachable only through an explicit standalone API/test harness.
4. Add positive/negative unit tests and mutation tests.

Exit: the new module independently produces `V3Config02AuthoringParsed` and the existing compiler publishes a valid Manifest; no CLI/WebUI/runtime/default-path code changed.

### Phase 2 — real config migration and differential proof

1. Capture the current `~/.rcc/config.v3.toml` baseline with the existing parser and config check.
2. Create `~/.rcc/config.toml` from its reachable routing selections without changing the active runtime source.
3. Produce the migration audit table and resolve every provider/model reference.
4. Run strict runtime-effective Manifest differential and representative provider-request dry-runs.
5. Test alternate valid `config.toml` forms that must converge to the same output and invalid forms that must fail.

Exit: `config.toml` is standalone-valid and differential-green; live runtime still uses the old path.

### Phase 3 — CLI and WebUI wiring

1. Wire explicit `config.toml` check/init/store commands to the new module.
2. Change Routes API/view model to ordered tiers without user-visible numeric priority.
3. Update Routes UI per the UX contract and verify in a real browser.
4. Keep live lifecycle/default resolver on `config.v3.toml` until all CLI/Admin/WebUI tests pass.

Exit: CLI and WebUI can initialize, read, validate, edit, and atomically save `config.toml`; old live runtime remains unchanged.

### Phase 4 — controlled integration and cutover

1. Complete actual-diff module-boundary review, focused tests, workspace build, and install the exact candidate globally.
2. Validate explicit `config.toml`, run controlled dry-runs, then use one aggregate `routecodex restart -c <config.toml>`.
3. Verify every configured listener health and replay real old samples through all enabled entry protocols/pools.
4. Wire the default resolver/lifecycle to `config.toml` only and remove any transitional explicit-format dispatch from the production path.
5. Run one no-argument aggregate `routecodex restart`; verify the resolved canonical source identity is `config.toml`, all listeners are healthy, and the same live replays pass.
6. Run AGY Review.

Exit: installed/live runtime uses only `config.toml`; AGY Review PASS; no old-path dependency is observed.

### Phase 5 — physical retirement

After Phase 4 only:

1. Remove the old `config.v3.toml` parser/schema/default path and old config-management route view assumptions.
2. Remove old CLI/WebUI/API compatibility branches, obsolete tests/fixtures/docs, and stale generated map/wiki declarations.
3. Remove the old live `config.v3.toml` only after confirming `config.toml` is active, backed up, and semantically verified.
4. Add zero-reference gates for the old filename/parser/types and a red fixture that attempts to restore dual-read fallback.
5. Re-run build/install, no-argument aggregate restart, all-listener health, real old-sample replay, and AGY Review because retirement changes code/config after the previous PASS.

Exit: one user file, one parser/projector, one existing Manifest compiler, one runtime manifest path; old implementation is physically absent.

## 11. Risks and controls

| Risk | Control |
| --- | --- |
| Current comments disagree with numeric priority | Baseline from compiled behavior; migration audit exposes contradiction; no silent correction |
| Second compiler/semantic owner appears | New module must stop at `V3Config02AuthoringParsed`; static gate rejects a second validate/registry/publish chain |
| Runtime starts reading both files | Explicit standalone APIs before wiring; post-cutover default resolves only `config.toml`; dual-read red fixture |
| Internal defaults hide a behavior change | Typed normalized Manifest differential includes all enabled-server internal declarations |
| Invalid provider/model survives to runtime | Resolve against enabled provider directory before authoring output; fail-fast |
| “Default inheritance” becomes runtime fallback | Materialize deterministically during authoring projection; runtime sees explicit compiled pools only |
| WebUI recreates routing semantics | UI edits the same typed tier model; compiler remains unique semantic owner |
| UI becomes a disconnected redesign | Reuse incumbent HTML/CSS/API; reference patterns only for task structure/accessibility; no new frontend stack |
| Old implementation removed too early | Retirement is gated behind standalone, differential, wiring, installed/live, and AGY PASS evidence |
| Other dirty work is overwritten | Fresh semantic claim/worktree, narrow `apply_patch` hunks, exact change-set review; no reset/checkout/stash |

## 12. Definition of done

- Minimal `config.toml` contains only route group/pool provider-model tiers and optional same-tier weights.
- Provider and internal facts each remain in their unique owners.
- New parser/projector is independently proven before wiring.
- Current live config is migrated with an auditable actual-semantics mapping.
- Alternate valid inputs converge; invalid/ambiguous inputs fail before publication.
- CLI init and Routes WebUI make the common path short, comprehensible, accessible, and verifiably usable.
- Existing compiler/runtime routing semantics are not duplicated or patched downstream.
- Global install, aggregate restart, all listener health, and real old-sample replay pass on `config.toml`.
- AGY Review passes after the final code/config state.
- `config.v3.toml` and its implementation surface are physically retired with zero references and no fallback.
