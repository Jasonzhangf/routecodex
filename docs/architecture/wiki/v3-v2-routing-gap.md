# V3 vs V2 Routing Gap

## Scope

Document the semantic gaps that still exist between V3 (current production target) and V2
(retired virtual router semantics that some configs and mental models still carry), with
special focus on `web_search` because that is the most common source of confusion.

## V2 vs V3 Independence

- V2 (`sharedmodule/llmswitch-core/rust-core/crates/route-classifier-core/`) and V3
  (`v3/crates/routecodex-v3-route-classifier/`) are independent Rust owners.
  Each one carries its own `extract_active_turn_signals`, `classify_tool_call`,
  `classify_shell_command`, `classify_route`, and `has_web_search_intent`. V2 is
  a characterization baseline only; V3 edits do not import or call V2.
- Route priority is fixed in both: `multimodal > thinking > coding > longcontext > search > tools > background > default`
  (`route.rs::ROUTE_PRIORITY`).
- V2's `build_route_queue(requested_route, candidates, ...)` and V3's
  `resolve_route_pool_plan` must remain visually identical. Drift between them is the
  acceptance signal for a V3 routing regression.
- The V2 owner is documented at
  `docs/architecture/wiki/virtual-router-ownership-map.md`. The V3 owner is documented
  separately in the V3 function map and the new `feature_id:v3.route_classifier_local_owner`
  claim.

## Gaps Still Worth Calling Out

### 1. `web_search` is a target capability, not a route

| Aspect | V2 (legacy) | V3 (current) |
| --- | --- | --- |
| Route name | `web_search` could appear as a route bucket in older route configs | Never a `routeName`; emitted only in `RouteClassification::required_capabilities` |
| Why it triggers | Function name keyword + declared `tools=[web_search]` + `web_search_force` config | `has_web_search_intent` on the newest user message OR `last_assistant_tool_category == "websearch"` (from the same active turn) |
| Effect on pool | Could select a separate `web_search` route pool as primary | Forces `required_capabilities = ["web_search"]` on Target; VR primary route stays `thinking` or `tools` |
| `webSearch.force` config | Honored | Honored (see `engine/core.rs::web_search_force`), but still a capability, never a route reason |
| Declared `type: web_search` / `web_search_preview` in `tools` | Often counted as route signal | Zero signal (`route-classifier-core/src/tools.rs::WEB_TOOL_KEYWORDS` is used only on tool-call names, not declarations) |
| Codex declared `web_search` tool | Made every request look like a web search request | Filtered out; only fresh explicit user intent matters (`docs/goals/v3-web-search-current-turn-routing-test-design.md`) |

Live evidence: 5555 sample `653120-7637` had only a `web_search` tool declaration but
text `检查为何现在 github 非常慢？`; V2 would have routed to a `web_search` pool, V3 correctly
keeps the route as `thinking`.

### 2. Historical user text is not a route signal anymore

| Aspect | V2 (legacy) | V3 (current) |
| --- | --- | --- |
| Old user `messages[0].content` | Could bias route selection in old scripts | Ignored unless it is the *newest* user carrier inside the active turn (`active_turn.rs::extract_message_signals`) |
| Declared tool inventory | Could push the request to `coding`/`search`/`tools` | Never; only actual tool calls inside the active turn count |
| `reasoning` field on the request body | Could override route to `thinking` | Not a route signal; routing ignores it (see `v3-v2-route-classifier-parity-test-design.md` bullet 4) |
| Longcontext threshold | Hard-coded `180000` in some V2 callers | Per-server-group `routing.longcontext.match.min_input_tokens` (was lost during the V2→V3 config compile, now restored) |

### 3. Route queue contract is shared but the "append default" invariant is now explicit

- V2 built the queue implicitly inside `build_route_queue`: `requested_route` first, then
  `candidates`, then `default` if missing.
- V3 makes the contract explicit in `route.rs::classify_route` and
  `vr-virtual-router::resolve_route_pool_plan`: the primary tier is the highest-priority
  matched candidate; if it is not `longcontext` and the threshold was crossed, `longcontext`
  is inserted; `default` is always appended last.
- V3 also rejects ambiguous pool matches with `AmbiguousPoolMatches` instead of silently
  picking one (`v3-virtual-router/src/lib.rs::resolve_route_pool_plan`).

### 4. Multimodal signal narrowed to one typed carrier

- V2 historically scanned the payload for image shapes (`image_url`, `input_image`,
  inline data, placeholders) in some legacy scripts.
- V3 reads only `metadata.hasImageAttachment` (request-scoped typed carrier) and never
  inspects payload shapes. See
  `docs/architecture/manifests/vr.route_classifier.mainline.yml` for the V3 edge contract.

### 5. `routeHint` / `webSearch.force` semantics

- V2 sometimes read `routeHint` as a sticky override; V3 reads `routeHint` from
  `MetaRoute03RouteCarrier` (`engine/route.rs::resolve_route_hint`) and **discards it** for
  stopless followups (`serverToolFollowup && source == servertool.stop_message`).
- `webSearch.force` is still config-level (`engine/core.rs::web_search_force`); it only
  forces the `web_search` capability, never the route reason.

### 6. Token estimation

- V2 used tiktoken in TypeScript.
- V3 uses tiktoken-rs (`router-hotpath-napi/src/virtual_router_engine/features.rs::estimate_request_tokens`).
- The estimator must ignore `estimatedInputTokens` / `estimatedTokens` metadata hints; only
  Rust-derived tokens count, otherwise V3 silently agrees with a client-injected
  over-estimate and forces `longcontext` (`vr.route_token_estimation` notes).

## Authoritative Locations

| Concern | File | Owner feature |
| --- | --- | --- |
| Classifier (V2/V3 shared) | `sharedmodule/llmswitch-core/rust-core/crates/route-classifier-core/src/{active_turn,route,tools,shell}.rs` | `vr.route_classifier` |
| V2 selection wrapper | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/{classifier,features,engine/route,engine/selection}.rs` | `vr.route_selection` |
| V3 selection wrapper | `v3/crates/routecodex-v3-virtual-router/src/lib.rs` | `vr.route_selection` (V3 path) |
| Target capability filter for `web_search` | `v3/crates/routecodex-v3-target/src/lib.rs` | `vr.route_selection` (Target filter) |
| V2 config compatibility | `v3/crates/routecodex-v3-config/src/v2_compat.rs` | `v3.v2_config_toml_compat_5555` |
| Parity test design | `docs/goals/v3-v2-route-classifier-parity-test-design.md` | `vr.route_classifier` |
| Web-search current-turn design | `docs/goals/v3-web-search-current-turn-routing-test-design.md` | `vr.route_classifier` |

## Verification

- `npm run test:route-classifier-semantics` is the single semantic gate.
- `npm run verify:route-classifier-core-file-size` + `route-classifier-core-file-size-red-fixtures`
  enforce file size discipline on the shared classifier crate.
- `v3-virtual-router/src/tests` covers `web_search_capability_does_not_override_route_pool_reason`
  and the multimodal / longcontext matrix.
- Live 5555 + 5520 replay of `653120-7637` and `662023-8758` shows the V3 route reason and
  pool reason; both must be a normal route (`thinking` or `coding`) when the active turn has
  no real web-search call.

## Boundaries

- Do not reintroduce `web_search` as a route name; it stays a Target capability.
- Do not re-introduce payload image scanning for `multimodal`; metadata is the only source.
- Do not allow `routeHint` to leak into stopless followup semantics.
- Do not override `longcontext` with a hard-coded threshold; it must follow
  `routing.longcontext.match.min_input_tokens` (or V2's
  `virtualrouter.classifier.longContextThresholdTokens` after `v2_compat`).
- Do not re-introduce TS-side classification or selection; both routes are Rust-only and
  gated by `verify:vr-no-ts-runtime` and `verify:llmswitch-rustification-audit`.
