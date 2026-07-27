# V3 Target priority/context heuristic regression design

## Contract

- Owner feature: `v3.virtual_router_target_interpreter`.
- Owner function: `V3TargetInterpreter::select_available` in `v3/crates/routecodex-v3-target/src/lib.rs`.
- Route order from `V3Router07OpaqueTargetHitOnce -> V3Target09CandidateSetExpanded` is the selection truth among compatible candidates.
- Only genuine `web_search/search` and `multimodal/vision` model capability checks may filter an incompatible target. `max_context_tokens` is catalog metadata and must not silently reorder an explicitly configured priority pool at Target10.
- After capability validation, Provider availability/health and request-local provider-failure exclusion are the switch inputs at this edge. No fallback or provider-specific branch is allowed.

## Lifecycle test

1. Build a priority pool with `short` first and `long` second; both candidates satisfy the request capability contract.
2. Give the first target a context declaration whose old 90% heuristic is crossed.
3. Positive: with both providers available, Target10 must select the configured first target and report no synthetic `context_near_limit` unavailability.
4. Negative: once the first target is explicitly request-locally excluded after provider failure, Target10 must select the second target.

## White-box impact

- Delete the `context_safe_available` / `context_near_limit` preselection branch and its dead threshold helpers.
- Preserve genuine search/vision capability validation, health availability, direct pin semantics, default-floor semantics, candidate order, and request-local failure exclusion.

## Module/project black-box impact

- Reproduce the 5555 `longcontext` shape where `cc-sol.gpt-5.6-sol` is priority 1, declares the needed capabilities, has `max_context_tokens=200000`, and input usage exceeds the old 180000 heuristic threshold.
- After installation/restart, an in-band real request must hit `cc-sol` first. If `cc-sol` returns a provider error, the existing error chain must switch to the next configured compatible candidate.

## Required evidence

- Red: focused Target test fails before implementation because old code selects `long`.
- Green: focused Target tests plus package tests pass.
- Architecture gates mapped to `v3.virtual_router_target_interpreter` pass or baseline failures are identified with unrelated file evidence.
- Online: 5555 health plus old-request-shape dry-run proves first hit is `cc-sol`, not GLM; a safe real in-band request proves provider send.

## Known boundary

- Upstream may reject a truly oversized payload. That remains a provider error and enters the existing Error01→06/reselection chain; Target does not invent a second routing policy from a 90% estimate.
