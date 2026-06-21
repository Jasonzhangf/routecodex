# 2026-06-21 review findings: virtual-router model validation + stop schema legacy compatibility

> Review-only artifact. No source code is changed by this commit.
> Findings below were re-verified against the current working tree.

## Finding 1: virtual_router undeclared-provider model hard-validate

- Severity: high
- Owner: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine`
- Repro (current working tree): `tests/sharedmodule/virtual-router-routing-model-validation.spec.ts`
- Red evidence: `bootstrapVirtualRouterConfig routing model validation › does not throw when provider has no models registry (backward compatible)` returns `Route "default" references unknown model "gpt-any" for provider "openai"`.
- Root cause (verified):
  - `virtual_router_engine/routing/bootstrap.rs::expand_routing_table_impl` calls `resolve_canonical_model_id(...)` unconditionally on `model_info`, then on `declared=false` falls into the “unknown model” branch.
  - `virtual_router_engine/provider_bootstrap.rs::build_provider_profiles` has the same unconditional resolve path; this is what JS loader actually hits via `bootstrapVirtualRouterConfigJson`.
  - Entry `bootstrap_virtual_router_config_json` in `virtual_router_engine/bootstrap.rs` chains both paths, so any undeclared provider config fails.
- Probe evidence:
  - Direct call `bootstrapVirtualRouterProvidersJson({openai: {type:"openai", auth:{...}}})` returns `modelIndex.openai = {declared:false, models:[]}` — confirms providers-side canonicalization is no longer the failing call.
  - `bootstrapVirtualRouterConfigJson(...)` for the same provider plus `routing.default=[openai.gpt-any]` raises the unknown-model error before JS-side retry, so the failing call is in routing/profile stage inside `bootstrap_virtual_router_config_json`, not in TS bridge code.
- Suggested minimal fix (not applied here):
  - In both `expand_routing_table_impl` and `build_provider_profiles`, gate the canonical resolve + member-existence checks behind `if model_info.declared`. Otherwise keep `parsed.model_id.clone()`.
  - Add Rust regression tests covering:
    - `bootstrap_virtual_router_routing_json` with `declared=false` returning the original model id verbatim.
    - `bootstrap_virtual_router_provider_profiles_json` for the same scenario producing `modelId == original`.
    - `bootstrap_virtual_router_config_json` end-to-end alias/profiles alignment.
- Out of scope for this review:
  - `alias_to_model` field removal in `routing/bootstrap.rs::ModelIndexEntry` and `hitLog` config addition in `bootstrap.rs` are concurrent uncommitted edits by another worker; they were not changed by this review slice.
  - JS-side native loader dual-binding behavior: this review slice verified the JS binding hash matches the freshly-built `target/release/router_hotpath_napi.node` and that the providers bootstrap call already reflects the fix, so the residual JS failure points to a separate native binding delivery chain that should be audited in its own slice.

## Finding 2: stop schema legacy compatibility removed

- Severity: high
- Owner: `sharedmodule/llmswitch-core/rust-core/crates/{servertool-core,stop-message-core}`
- Repro (current working tree):
  - `tests/servertool/stop-message-sample-replay.spec.ts` → `expect(tools.length).toBe(1)` receives `13`.
  - `tests/servertool/stopmessage-anthropic-stop-sequence.spec.ts` → `result.mode === 'passthrough'`, expected `'tool_flow'`.
  - `tests/servertool/stopmessage-compaction-false-positive.spec.ts` → `result.mode === 'passthrough'`, expected `'tool_flow'`.
- Root cause (verified):
  - `servertool-core/src/stop_visible_text.rs::strip_stop_schema_control_blocks` (line 105) only removes `<rcc_stop_schema>...</rcc_stop_schema>` fences plus `停止原因:` lines. The legacy bare-JSON and legacy-fenced-JSON cleanup branches have been deleted, so old-format stop schemas leak into visible assistant text and inflate `tools.length`.
  - `stop-message-core/src/lib.rs::parse_stop_schema` (line 1188) only accepts `reasoning.stop.arguments` JSON or `<rcc_stop_schema>` fenced JSON. Bare JSON / legacy fenced JSON fall through to `Missing` / `InvalidJson`, which is the common ancestor of the anthropic stop_sequence and compaction-marker regressions.
- Suggested minimal fix (not applied here):
  - Restore the legacy bare-JSON object extraction branch in `strip_stop_schema_control_blocks`, guarded by either an env opt-in or a string-shape detector (`starts_with('{')` and ends with `}`).
  - Extend `parse_stop_schema` to recognize legacy fence shapes (` ```json ` blocks containing stop-schema fields, and the bare-JSON object shape) before declaring `Missing` / `InvalidJson`.
  - Keep `<rcc_stop_schema>` as the canonical SSOT output by writing it as the unique emit shape from stopless injection, while preserving the readers for legacy inputs so existing install base does not silently lose stopless closure.
- Out of scope for this review:
  - Tool list trimming and `client projection` contracts: only stop-message projection was probed; the projection chain into `tools` should be re-audited once legacy inputs are re-recognized.

## Finding 3: token-daemon noRefresh auto-suspend

- Severity: medium
- Owner: `src/token-daemon/token-daemon.ts` and `src/token-daemon/server-utils.ts`
- Repro (current working tree): `tests/token-daemon/token-daemon.auto-refresh-noninteractive.spec.ts`
- Red evidence: `does not persist noRefresh for qwen without stable api_key but still auto-suspends on permanent refresh failures` — `expect(tokenAfter.noRefresh).toBeUndefined()` receives `true` and `expect(mtimeAfter).toBe(mtimeBefore)` fails because the file was rewritten by `maybeMarkTokenFileNoRefresh`.
- Root cause (verified, partial):
  - `token-daemon.ts::trySilentRefresh` writes `noRefresh: true` to the token file on `isPermanentAuthFailure`. The test contract requires the file to be untouched and the suspension to live only in `history-store` so daemon runs do not propagate the poison token across processes.
  - `classifyRefreshFailure` and `autoSuspended` history path in `token-types.ts` already provide the right surface; the missing piece is a code path that records suspension without rewriting the token file.
- Suggested minimal fix (not applied here):
  - Replace `maybeMarkTokenFileNoRefresh(...)` with `historyStore.markAutoSuspended(token, ...)` for the qwen-without-stable-api-key branch (and probably all branches where the refresh is oauth-only).
  - Keep `maybeMarkTokenFileNoRefresh` for the rare case where the token file is the only persistence layer and the daemon has no history store, but make it opt-in via `token.forceNoRefreshOnPermanentFailure`.
  - Add reverse regression test: `history.tokens[key]?.autoSuspended === true`, `token file mtime unchanged`, `token file noRefresh field absent`.

## Findings explicitly excluded

- Relay submit_tool_outputs reroute / continuation owner isolation: already landed in commit `cceda6c`.
- Ecodev multi-account + auto refresh audit, stopless 5555 live rerun evidence: written by another worker into `note.md`; this review slice intentionally does not own those entries.
