# V3 Recent Unmerged Main Integration Plan

## Objective

Close the 2026-08-17 through 2026-08-19 V3 integration window against `main` without importing V4, persistent cooldown, duplicate owners, or transport-layer compensation. Every accepted semantic change must land through its registered V3 owner, pass mapped gates, be installed and exercised online, receive DSH Review PASS, and then be committed and pushed.

## Baseline and isolation

- Main baseline: `4891e44f8c7f673f49d37da9dfde2bae5389740b`.
- Integration worktree: `playground/v3-recent-unmerged-main-closeout-20260819T082250Z`.
- Integration branch: `codex/v3-recent-unmerged-main-closeout-20260819`.
- Active feature-owner worktrees are not edited or merged before a verified handoff.
- V4 paths and AppSDK checkpoint material are outside this closeout.

## Candidate decisions

| Candidate | Decision | Reason / integration rule |
| --- | --- | --- |
| `62054c8b70ee43d3d42752fbb82a1084ef853b38` | required semantic integration | Preserve the Anthropic wire capability rule: request `thinking` is enabled only when both request reasoning and selected model/provider capability allow it. Integrate through the current Anthropic codec/provider-compat owner with positive and negative characterization tests; do not blindly cherry-pick over the active protocol-matrix owner. |
| `dd2ba34520f18f04e3db60380b2fec9094a729e7` | required input, incomplete as delivered | Reuse its typed provider-health mutation boundary and Error05 projection design. Complete the remaining web_search error-chain binding, active map status, gates, and dead-helper removal in the owning worktree. |
| `b68ba123630cf0959aee9a3d04a7933fd3e0b2fc` | reject pending a new retention contract | The patch changes the active per-endpoint/port retention owner into one repository-global cap. That conflicts with the current resource contract (`at most 200 request directories per port`) and the existing startup/listener API. Do not silently change diagnostic retention semantics during this closeout. |
| `f2367c8a71d946a4a26f2a7180ac33d5a212d47f` | defer from bulk integration | Direct response hooks touch runtime topology and overlap later main changes. Accept only an independently mapped, tested owner handoff; do not import its historical file-size threshold changes or broad rewrites. |
| `3dee62dec32184c46b448b06aa10184ee9ca9808` | defer | WebUI observability is a separate feature, not required to close the two mandatory runtime defects. It needs its own registry/verification and live security review. |
| `cb729efa19da0ca7403913b9748ae552fb88a3d0` | required semantic integration | Port the missing V2 root `secretFile` discovery through the config owner, but keep fail-fast parsing, provider-scoped aliases, source exclusivity, and secret-handle-only runtime projection. Positive/negative config tests replace blind cherry-pick. |
| `ed5557552ff1e0b0d5b526f813e957893e34e0a9` | reject as conflicting contract | Current Target10 truth explicitly says `max_context_tokens` is catalog metadata and cannot synthesize a priority override. The candidate makes it a pre-availability filter and conflicts with `v3-target-priority-context-heuristic-test-design.md`; do not silently change routing policy in this closeout. |
| `f0561f843d977b91d0fc896859649c41c91c770c` | reject bulk commit; port verified slices only | The commit mixes generated review surfaces, file-size policy edits, and provider-compat/error changes. Only missing current-owner error isolation may be ported with fresh tests. |
| `d2af29298c43d0912315b645bad3f660a8258efa` | reject as superseded contract | Its 1s → 3s → 5s assertion conflicts with the active provider-action contract, which requires the second pre-success failure to enter Sustained 5s. The focused candidate test was run against current main and failed exactly at that semantic mismatch. |
| `b7220d0b38292df97a45a393240a6fb3c5dcf8f6` | reject bulk commit | Mixed checkpoint includes AppSDK material and persistent cooldown work outside scope. Extract no semantics unless separately justified by another accepted candidate. |
| `ae900a71fb1dc167049d56b1277844bc96562603` | already covered | Patch-equivalent in current main. |
| `5c00406116dc78a43437b36f905a78db181c9259` | already covered | Patch-equivalent in current main. |
| `b06c0aa49c4e02624a993b1faafd685d4f88468e`, `1407526762a58ea5cb0298426268b07f952a0775`, `9ca21e8188503015deb5a2236252baf5a34ec8c1`, `0c56000cc37a411f481d4f1a408e39a5ff7aca2d`, `7f3eabab9d7e40dcfa66f1042f5ba42d82cec0d8` | superseded / covered semantically | Do not re-merge historical implementations; verify current owner behavior instead. |
| `8f0c71ad0b9bd144efac67e62ac159e4ecba9427` | reject | Persistent global cooldown contradicts the current process-local provider health truth and restart-clears-cooldown contract. |

## Architecture repairs

1. Provider health mutation: runtime holds a typed handle; only `routecodex-v3-provider-responses` mutates `v3.provider.health_state`.
2. Error topology: web_search, Direct, and Relay provider failures all traverse typed Error01 through Error06. No private Relay `.await?` escape and no local HTTP projection.
3. Registry truth: implemented edges are `active`/`anchored`; unavailable edges remain explicit design or pending and cannot be reported live. Wiki/manifest/maps share symbols and node IDs.
4. File topology: split oversized `shared.rs`, `validate.rs`, and `hub_v1/common.rs` by existing module owners; do not raise thresholds. For `shared.rs`, move its existing response-id policy helpers to `shared/response_id_policy.rs` behind the unchanged `crate::shared::*` facade; this changes no mainline edge, resource relation, or payload contract.
5. Session admission: map/manifest symbols must resolve to actual source symbols and adjacent edges.
6. Module boundary gate: every V3 Rust/Cargo source file belongs to exactly one crate module; every real local Cargo dependency and Rust cross-crate import must match the module registry, while symbol-level calls remain bound by `v3-mainline-call-map.yml`. Missing/duplicate owners, undeclared edges, and fictitious edges are red fixtures.
7. Duplicate owner removal: physically remove `provider_failure_routing_helpers.rs` after proving no live reference and add a red fixture preventing revival.

## Required evidence order

1. Read resource/function/mainline/module/verification maps for each touched module and record owner/allowed/forbidden edges.
2. Capture focused red evidence before each runtime or gate repair.
3. Make the smallest owner-local change and turn focused tests green, including positive and negative cases.
4. Run architecture gates, workspace fmt/clippy/build, and mapped tests.
5. Merge verified feature handoffs into this clean integration worktree; review the combined diff for V4, payload-control leakage, fallback, transport compensation, and duplicate owners.
6. Apply the exact verified change set to main without overwriting unrelated dirty files; rerun affected gates on main.
7. Install the V3 global build, record source/build hashes, run one aggregate `routecodex restart -c /Volumes/extension/.rcc/config.v3.toml`, and verify every configured listener health endpoint.
8. Replay online Anthropic thinking, web_search failure/Error05/provider-health, JSON/SSE parity, continuation, and relevant old samples.
9. Run DSH Review with `opencode-go/deepseek-v4-flash`. A FAIL must be fixed and re-reviewed; Codex Review is allowed only on structured DSH unavailability.
10. Commit only the verified V3 closeout paths, push, verify remote HEAD equals local HEAD, then release claims and remove only clean, fully merged worktrees.

## Completion contract

Completion requires all mandatory candidates and architecture repairs above, green verification and online evidence, DSH PASS, a precise pushed commit, remote/local HEAD equality, and no unresolved V3 P0/P1 finding. Any missing item remains explicit and prevents completion.
