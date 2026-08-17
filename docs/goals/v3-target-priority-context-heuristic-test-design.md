# V3 Target priority/context heuristic regression design

## Contract

- Owner feature: `v3.virtual_router_target_interpreter`.
- Owner function: `V3TargetInterpreter::select_available` in `v3/crates/routecodex-v3-target/src/lib.rs`.
- Route order from `V3Router07OpaqueTargetHitOnce -> V3Target09CandidateSetExpanded` is the selection truth among compatible candidates.
- Only genuine `web_search/search` and `multimodal/vision` model capability checks may produce capability mismatch. Separately, Target10 must skip ordinary candidates whose `max_context_tokens` is below `request_input_tokens` before availability/transport; explicit direct pins and the default-pool floor remain last-resort eligible with a typed overflow reason.
- After context and capability admission, Provider availability/health and request-local provider-failure exclusion are the switch inputs at this edge. No provider-specific branch is allowed.

## Lifecycle test

1. Build a priority pool with `short` first and `long` second; both candidates satisfy the request capability contract.
2. Give the first target a context declaration smaller than the request and the second target a sufficient context window.
3. Positive: when the request is within `short`'s window, Target10 selects the configured first target without an overflow reason.
4. Negative: when the request exceeds `short`'s window, Target10 skips `short`, records `context_window_exceeded`, and selects `long`; request-local provider failure still switches to the next candidate.

## White-box impact

- Keep context admission in the Target10 owner; do not create a separate route-priority heuristic or payload cleanup path.
- Preserve genuine search/vision capability validation, health availability, direct pin semantics, default-floor semantics, candidate order among eligible candidates, and request-local failure exclusion.

## Module/project black-box impact

- Reproduce the 5555 `longcontext` shape where `cc-sol.gpt-5.6-sol` is priority 1, declares the needed capabilities, has `max_context_tokens=200000`, and input usage exceeds the old 180000 heuristic threshold.
- After installation/restart, an in-band real request must hit `cc-sol` first. If `cc-sol` returns a provider error, the existing error chain must switch to the next configured compatible candidate.

## Required evidence

- Red: focused Target test fails before implementation because old code keeps the over-limit `short` candidate selected and emits no `context_window_exceeded` evidence.
- Green: focused Target tests plus package tests pass.
- Architecture gates mapped to `v3.virtual_router_target_interpreter` pass or baseline failures are identified with unrelated file evidence.
- Online: 5555 health plus old-request-shape dry-run proves first hit is `cc-sol`, not GLM; a safe real in-band request proves provider send.

## Known boundary

- Upstream may reject a truly oversized payload. That remains a provider error and enters the existing Error01→06/reselection chain; Target does not invent a second routing policy from a 90% estimate.
